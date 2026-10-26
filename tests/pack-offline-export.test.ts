/**
 * 离线导出管线：活跃名单（门控 + body）、静态事实、tgz、installOrder、manifest 往返、包级检查。
 *
 * 两件必须被钉死的事：
 *   - 垃圾目录（.bak- / .retired- / .removed-）按「目录名」剔除，不只是文件名；
 *   - manifest 写出后能被自己读回，且校验和 / 拓扑序经得起复验。
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFLINE_EXTRAS_DIRNAME,
  OFFLINE_KERNEL_DIRNAME,
  createOfflineManifest,
  isKernelPackageName,
  kernelModulesDirOf,
  kernelTgzName,
  packKernelFromHome,
  packKernelTgz,
  selectKernelPackages,
  exportOfflinePack,
  integrityOf,
  isJunkPath,
  isJunkSegment,
  packPluginTgz,
  parseOfflineManifest,
  readOfflineManifest,
  readPluginFacts,
  collectActivePlugins,
  serializeOfflineManifest,
  verifyOfflinePack,
  writeOfflineManifest,
  type OfflineManifestPlugin,
} from '../electron/pack-offline-export'
import { readTarGz, writeTarGz } from '../electron/tar-archive'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-offline-pack-'))
  temporaryDirectories.push(root)
  return root
}

async function makeJunction(target: string, linkPath: string): Promise<void> {
  await mkdir(path.dirname(linkPath), { recursive: true })
  await symlink(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

interface Fixture {
  root: string
  profileDir: string
  bodiesDir: string
  nodeModulesDir: string
}

/**
 * 假实例：两个正常插件（alpha 依赖 beta 与一个外部包）、一个垃圾门控、一个悬空门控、
 * 一个指到包外的门控、一个内核实体目录。alpha 本体里再塞一个垃圾文件、一个垃圾目录、
 * 一个 junction，用来验证 tgz 剔除。
 */
async function buildFixture(): Promise<Fixture> {
  const root = await temporaryRoot()
  const profileDir = path.join(root, 'profiles', 'web')
  const bodiesDir = path.join(profileDir, '.dsh-launcher-plugin-bodies')
  const nodeModulesDir = path.join(profileDir, 'node_modules')

  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'profile.yaml'), 'name: web\ndshVersion: 0.2.1-rc.2\n', 'utf8')

  await writeJson(path.join(bodiesDir, 'alpha', 'package.json'), {
    name: 'alpha',
    version: '1.2.3',
    type: 'module',
    exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' },
    files: ['lib/index.js', 'cordis.patch.yml'],
    engines: { node: '>=20' },
    dependencies: { beta: '^2.0.0', '@deepseek-ai/schemastery': '^3.18.5', 'local-dep': '^1.0.0', 'shared-dep': '^9.0.0', 'inlined-dep': '^1.0.0' },
    peerDependencies: { react: '^18.2.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' }, engines: { dsh: '>=0.2.1-rc.2' } },
  })
  await mkdir(path.join(bodiesDir, 'alpha', 'lib'), { recursive: true })
  await writeFile(path.join(bodiesDir, 'alpha', 'lib', 'index.js'), 'export default 1\n', 'utf8')
  await writeFile(path.join(bodiesDir, 'alpha', 'cordis.patch.yml'), '- id: alpha\n', 'utf8')
  await writeFile(path.join(bodiesDir, 'alpha', 'lib', 'notes.bak-20260101.txt'), 'old\n', 'utf8')
  await mkdir(path.join(bodiesDir, 'alpha', 'lib', 'legacy.retired-20260101'), { recursive: true })
  await writeFile(path.join(bodiesDir, 'alpha', 'lib', 'legacy.retired-20260101', 'old.js'), 'old\n', 'utf8')
  await writeJson(path.join(bodiesDir, 'shared-dep', 'package.json'), { name: 'shared-dep', version: '9.9.9' })
  await writeJson(path.join(bodiesDir, 'alpha', 'node_modules', 'local-dep', 'package.json'), { name: 'local-dep', version: '1.0.0' })
  await makeJunction(path.join(bodiesDir, 'shared-dep'), path.join(bodiesDir, 'alpha', 'node_modules', 'shared-dep'))

  await writeJson(path.join(bodiesDir, 'beta', 'package.json'), {
    name: 'beta',
    version: '2.0.0',
    main: 'index.js',
    type: 'module',
    dsh: { client: { platform: 'web' } },
  })
  await writeFile(path.join(bodiesDir, 'beta', 'index.js'), 'export default 2\n', 'utf8')

  await writeJson(path.join(bodiesDir, 'gamma.bak-20260101', 'package.json'), { name: 'gamma', version: '0.0.1' })
  await writeFile(path.join(bodiesDir, 'gamma.bak-20260101', 'index.js'), 'x\n', 'utf8')

  await makeJunction(path.join(bodiesDir, 'alpha'), path.join(nodeModulesDir, 'alpha'))
  await makeJunction(path.join(bodiesDir, 'beta'), path.join(nodeModulesDir, 'beta'))
  await makeJunction(path.join(bodiesDir, 'gamma.bak-20260101'), path.join(nodeModulesDir, 'gamma.bak-20260101'))
  await makeJunction(path.join(bodiesDir, 'not-there'), path.join(nodeModulesDir, 'dangling'))

  const outside = path.join(root, 'shared', 'outside')
  await writeJson(path.join(outside, 'package.json'), { name: 'outside', version: '3.0.0' })
  await makeJunction(outside, path.join(nodeModulesDir, 'outside'))

  // 附件 = <家目录>/extras：原样复制，不套垃圾剔除规则（同名文件可能是用户真实数据）。
  await mkdir(path.join(root, OFFLINE_EXTRAS_DIRNAME, 'v1'), { recursive: true })
  await writeFile(path.join(root, OFFLINE_EXTRAS_DIRNAME, 'v1', 'doc.txt'), 'hello attachment\n', 'utf8')
  await writeFile(path.join(root, OFFLINE_EXTRAS_DIRNAME, 'v1', 'keep.bak-20260101'), 'user data\n', 'utf8')
  // 对话上传目录：私有数据，导出绝不能带上。
  await mkdir(path.join(root, 'attachments', 'v1'), { recursive: true })
  await writeFile(path.join(root, 'attachments', 'v1', 'private.png'), 'PRIVATE', 'utf8')

  // 内核包在 node_modules 里是实体目录（不是门控），必须被排除。
  await writeJson(path.join(nodeModulesDir, '@deepseek-ai', 'dsh-base', 'package.json'), {
    name: '@deepseek-ai/dsh-base',
    version: '0.2.1-rc.2',
  })

  return { root, profileDir, bodiesDir, nodeModulesDir }
}

describe('垃圾段判定', () => {
  it('目录名与文件名同等对待', () => {
    expect(isJunkSegment('dsh-modes.bak-stage2-20261023')).toBe(true)
    expect(isJunkSegment('dsh-cursor-plan.retired-stage2-20261023')).toBe(true)
    expect(isJunkSegment('eac-design-world.removed-20261022-212832')).toBe(true)
    expect(isJunkSegment('package.json.bak')).toBe(true)
    expect(isJunkSegment('dsh-modes')).toBe(false)
    expect(isJunkSegment('dsh-free-search-0.9.13.tgz')).toBe(false)
    expect(isJunkPath('@scope/pkg/lib/x.bak-1/y.js')).toBe(true)
    expect(isJunkPath('lib/index.js')).toBe(false)
  })
})

describe('活跃名单：门控 + body', () => {
  it('只收真实存在的门控 + 本体，垃圾/悬空/包外门控全部记入 skipped', async () => {
    const { profileDir } = await buildFixture()
    const { plugins, skipped } = await collectActivePlugins(profileDir)
    expect(plugins.map(plugin => plugin.packageName)).toEqual(['alpha', 'beta'])
    const reasons = new Map(skipped.map(item => [item.packageName, item.reason]))
    expect(reasons.get('gamma.bak-20260101')).toBe('junk')
    expect(reasons.get('dangling')).toBe('missing-body')
    expect(reasons.get('outside')).toBe('outside-bodies')
    expect(reasons.get('@deepseek-ai/dsh-base')).toBe('not-a-link')
  })
})

describe('静态事实', () => {
  it('exports["."] 优先，回落 main；bundle/client/engines/deps/files 一处不漏', async () => {
    const { bodiesDir } = await buildFixture()
    const alpha = await readPluginFacts(path.join(bodiesDir, 'alpha'))
    expect(alpha).not.toBeNull()
    expect(alpha?.entry).toBe('lib/index.js')
    expect(alpha?.entryExists).toBe(true)
    expect(alpha?.hasBundle).toBe(true)
    expect(alpha?.hasClient).toBe(true)
    expect(alpha?.bundlePatch).toBe('cordis.patch.yml')
    expect(alpha?.enginesDsh).toBe('>=0.2.1-rc.2')
    expect(alpha?.engineNode).toBe('>=20')
    expect(alpha?.deps).toEqual(['@deepseek-ai/schemastery', 'beta', 'inlined-dep', 'local-dep', 'shared-dep'])
    expect(alpha?.peerDeps).toEqual(['react'])
    expect(alpha?.files).toEqual(['lib/index.js', 'cordis.patch.yml'])

    const beta = await readPluginFacts(path.join(bodiesDir, 'beta'))
    expect(beta?.entry).toBe('index.js')
    expect(beta?.hasBundle).toBe(false)
  })
})

describe('打包 tgz', () => {
  it('包内是 package/ 前缀；垃圾文件、垃圾目录、junction 都不进包', async () => {
    const { root, bodiesDir } = await buildFixture()
    const target = path.join(root, 'alpha.tgz')
    const stats = await packPluginTgz(path.join(bodiesDir, 'alpha'), target)
    const archive = await readFile(target)
    const entries = readTarGz(archive)
    const paths = entries.map(entry => entry.path)

    expect(paths).toContain('package/package.json')
    expect(paths).toContain('package/lib/index.js')
    expect(paths.every(item => item.startsWith('package/'))).toBe(true)
    expect(paths.some(item => item.includes('notes.bak-'))).toBe(false)
    expect(paths.some(item => item.includes('legacy.retired-'))).toBe(false)
    // junction 自身不进包（源机绝对路径）；本体自带的实体依赖要跟着走。
    expect(paths).not.toContain('package/node_modules/shared-dep')
    expect(paths).toContain('package/node_modules/local-dep/package.json')
    expect(stats.strippedJunk).toBe(2)
    expect(stats.strippedLinks).toBe(1)

    // 固定时间戳 → 同一份内容打两次得到同一份 sha512，复验才有意义。
    const again = path.join(root, 'alpha-again.tgz')
    await packPluginTgz(path.join(bodiesDir, 'alpha'), again)
    expect(integrityOf(await readFile(again))).toBe(integrityOf(archive))
  })

  it('链接依赖跟随成实体收进包（bundledDependencies 语义），链接本身绝不写进 tgz', async () => {
    const { root, bodiesDir } = await buildFixture()
    const alphaDir = path.join(bodiesDir, 'alpha')
    const target = path.join(root, 'alpha-carried.tgz')
    const stats = await packPluginTgz(alphaDir, target, [
      { name: 'shared-dep', linkPath: path.join(alphaDir, 'node_modules', 'shared-dep') },
    ])
    const entries = readTarGz(await readFile(target))
    const paths = entries.map(entry => entry.path)

    // 实体的真实文件进包，落在依赖自己的 node_modules 目录下
    expect(paths).toContain('package/node_modules/shared-dep/package.json')
    const manifestEntry = entries.find(entry => entry.path === 'package/node_modules/shared-dep/package.json')
    expect(JSON.parse(manifestEntry?.data.toString('utf8') ?? '{}').name).toBe('shared-dep')
    // 归档只允许 file / directory：符号链接是源机绝对路径，换机必坏
    expect(entries.every(entry => entry.type === 'file' || entry.type === 'directory')).toBe(true)
    expect(stats.carriedDeps.map(item => item.name)).toEqual(['shared-dep'])
    expect(stats.carriedDeps[0]?.files).toBe(1)
    expect(stats.carriedDeps[0]?.bytes).toBeGreaterThan(0)
    expect(stats.skippedDeps).toEqual([])
    // 跟随成功 = 没有「被剔除的链接」
    expect(stats.strippedLinks).toBe(0)

    // 同一份输入打两次仍然字节一致（跟随进来的条目也参与排序）
    const again = path.join(root, 'alpha-carried-again.tgz')
    await packPluginTgz(alphaDir, again, [
      { name: 'shared-dep', linkPath: path.join(alphaDir, 'node_modules', 'shared-dep') },
    ])
    expect(integrityOf(await readFile(again))).toBe(integrityOf(await readFile(target)))
  })

  it('悬空/无效的链接依赖跳过并记进报告，不影响出包', async () => {
    const { root, bodiesDir } = await buildFixture()
    const alphaDir = path.join(bodiesDir, 'alpha')
    const target = path.join(root, 'alpha-dangling.tgz')
    const stats = await packPluginTgz(alphaDir, target, [
      { name: 'ghost', linkPath: path.join(alphaDir, 'node_modules', 'ghost') },
      { name: 'not-a-dir', linkPath: path.join(alphaDir, 'lib', 'index.js') },
    ])
    const paths = readTarGz(await readFile(target)).map(entry => entry.path)
    expect(paths).toContain('package/package.json')
    expect(paths.some(item => item.includes('ghost'))).toBe(false)
    expect(stats.carriedDeps).toEqual([])
    expect(stats.skippedDeps.map(item => item.name).sort()).toEqual(['ghost', 'not-a-dir'])
    expect(stats.skippedDeps.every(item => item.reason.length > 0)).toBe(true)
  })
})

describe('manifest 往返', () => {
  it('写出后能被自己读回，且逐字段一致', async () => {
    const { root } = await buildFixture()
    const packDir = path.join(root, 'pack')
    await mkdir(packDir, { recursive: true })
    const manifest = createOfflineManifest({
      dshVersion: '0.2.1-rc.2',
      platform: 'win32-x64',
      extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
      plugins: [
        {
          name: 'alpha',
          version: '1.2.3',
          integrity: 'sha512-' + Buffer.from('alpha').toString('base64'),
          tgz: 'vendor/alpha-1.2.3.tgz',
          entry: 'lib/index.js',
          hasBundle: true,
          hasClient: true,
          deps: ['@deepseek-ai/schemastery', 'beta', 'inlined-dep', 'local-dep', 'shared-dep'],
          enabled: true,
        },
        {
          name: 'beta',
          version: '2.0.0',
          integrity: 'sha512-' + Buffer.from('beta').toString('base64'),
          tgz: 'vendor/beta-2.0.0.tgz',
          entry: 'index.js',
          hasBundle: false,
          hasClient: true,
          deps: [],
          enabled: true,
        },
      ],
    })
    const pathWritten = await writeOfflineManifest(packDir, manifest)
    const readBack = await readOfflineManifest(packDir)
    expect(readBack).toEqual(manifest)
    expect(parseOfflineManifest(serializeOfflineManifest(manifest))).toEqual(manifest)
    expect(readBack.installOrder).toEqual(['@deepseek-ai/schemastery', 'beta', 'inlined-dep', 'local-dep', 'shared-dep', 'alpha'])
    // 空附件也要留一条登记（0 / 0），不能因为空就整条消失。
    expect(readBack.extras).toEqual({ path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 })
    expect(pathWritten.endsWith('manifest.json')).toBe(true)
  })

  it('包名重复直接拒绝（计划 8.11 第 6 类阻塞项）', () => {
    const duplicate: OfflineManifestPlugin = {
      name: 'alpha',
      version: '1.0.0',
      integrity: 'sha512-' + Buffer.from('x').toString('base64'),
      tgz: 'vendor/alpha-1.0.0.tgz',
      entry: 'index.js',
      hasBundle: false,
      hasClient: false,
      deps: [],
      enabled: true,
    }
    expect(() => createOfflineManifest({
      dshVersion: '0.2.1-rc.2',
      platform: 'win32-x64',
      extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
      plugins: [duplicate, { ...duplicate, version: '1.0.1' }],
    })).toThrow(/包名重复/)
  })

  it('peerDependencies 不进图，dependencies 里的外部包排在依赖方之前', async () => {
    const { bodiesDir } = await buildFixture()
    const facts = await readPluginFacts(path.join(bodiesDir, 'alpha'))
    const order = createOfflineManifest({
      dshVersion: '0.2.1-rc.2',
      platform: 'win32-x64',
      extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
      plugins: [{
        name: 'alpha',
        version: '1.2.3',
        integrity: 'sha512-' + Buffer.from('x').toString('base64'),
        tgz: 'vendor/alpha-1.2.3.tgz',
        entry: 'lib/index.js',
        hasBundle: true,
        hasClient: true,
        deps: facts?.deps ?? [],
        enabled: true,
      }],
    }).installOrder
    expect(order).toEqual(['@deepseek-ai/schemastery', 'beta', 'inlined-dep', 'local-dep', 'shared-dep', 'alpha'])
    expect(order).not.toContain('react')
  })
})

describe('端到端导出 + 包级检查', () => {
  it('导出 vendor + manifest，自检通过；改坏 tgz 后校验和能被抓出来', async () => {
    const { root, profileDir } = await buildFixture()
    const outputDir = path.join(root, 'out')
    const result = await exportOfflinePack({ profileDir, outputDir })

    expect(result.manifest.format).toBe(1)
    expect(result.manifest.dshVersion).toBe('0.2.1-rc.2')
    expect(result.manifest.platform).toBe(process.platform + '-' + process.arch)
    expect(result.manifest.plugins.map(plugin => plugin.name)).toEqual(['alpha', 'beta'])
    expect(result.report.activePlugins).toBe(2)
    // 依赖边分三档：本体自带（已在 tgz 内）/ 走 junction 的 shared tree / 源机就没有（构建期内联）
    // 走 junction 的这轮已经跟随成实体收进 tgz，所以 linkedDeps 空、carriedDeps 记 shared-dep。
    expect(result.report.linkedDeps).toEqual([])
    expect(result.report.carriedDeps.names).toEqual(['shared-dep'])
    expect(result.report.carriedDeps.count).toBe(1)
    expect(result.report.carriedDeps.files).toBeGreaterThan(0)
    expect(result.report.carriedDeps.bytes).toBeGreaterThan(0)
    expect(result.report.skippedCarryDeps).toEqual([])
    expect(result.report.bundledDeps).toEqual(['@deepseek-ai/schemastery', 'beta', 'inlined-dep'])
    expect(result.report.dependencyEdges.filter(edge => edge.source === 'body')).toHaveLength(1)
    expect(result.check.ok).toBe(true)
    expect(result.check.warnings.some(item => item.includes('没有随包 vendor'))).toBe(true)

    // 附件原样复制：垃圾样名字的用户文件也必须保留，不做任何剔除。
    const extrasOut = path.join(outputDir, OFFLINE_EXTRAS_DIRNAME)
    expect(await readFile(path.join(extrasOut, 'v1', 'doc.txt'), 'utf8')).toBe('hello attachment\n')
    expect(await readFile(path.join(extrasOut, 'v1', 'keep.bak-20260101'), 'utf8')).toBe('user data\n')
    expect(result.manifest.extras).toEqual({
      path: OFFLINE_EXTRAS_DIRNAME,
      fileCount: 2,
      bytes: Buffer.byteLength('hello attachment\n') + Buffer.byteLength('user data\n'),
      directoryCount: 1,
    })
    expect(result.report.extras.skippedLinks).toBe(0)
    expect(result.report.totalBytes).toBeGreaterThan(result.report.vendorBytes + result.report.extras.bytes)
    expect(result.check.stats.extrasFiles).toBe(2)
    // 对话上传目录绝不能被带进包。
    await expect(lstat(path.join(outputDir, 'attachments'))).rejects.toThrow()

    const vendorFiles = (await readdir(result.vendorDir)).sort()
    expect(vendorFiles).toEqual(['alpha-1.2.3.tgz', 'beta-2.0.0.tgz'])
    // 垃圾门控的包绝对不在 vendor 里。
    expect(vendorFiles.some(file => file.includes('.bak-'))).toBe(false)

    const recheck = await verifyOfflinePack(outputDir)
    expect(recheck.ok).toBe(true)
    expect(recheck.stats.plugins).toBe(2)

    // 篡改一个字节：sha512 必须对不上。
    const victim = path.join(result.vendorDir, 'alpha-1.2.3.tgz')
    const bytes = await readFile(victim)
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff
    await writeFile(victim, bytes)
    const broken = await verifyOfflinePack(outputDir)
    expect(broken.ok).toBe(false)
    expect(broken.blocking.some(item => item.includes('sha512'))).toBe(true)
  })
})
describe('三件齐全：核心 / 插件 / 附件', () => {
  async function writePack(root: string, manifest: unknown, parts: { extras?: boolean; vendor?: boolean; conversations?: boolean } = {}): Promise<string> {
    const dir = path.join(root, 'pack-' + Math.random().toString(36).slice(2))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    if (parts.vendor !== false) await mkdir(path.join(dir, 'vendor'), { recursive: true })
    if (parts.extras !== false) await mkdir(path.join(dir, OFFLINE_EXTRAS_DIRNAME), { recursive: true })
    if (parts.conversations) await mkdir(path.join(dir, 'attachments'), { recursive: true })
    return dir
  }

  const baseManifest = {
    format: 1,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32-x64',
    plugins: [{
      name: 'alpha',
      version: '1.0.0',
      integrity: 'sha512-' + Buffer.from('alpha').toString('base64'),
      tgz: 'vendor/alpha-1.0.0.tgz',
      entry: 'index.js',
      hasBundle: false,
      hasClient: false,
      deps: [],
      enabled: true,
    }],
    extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
    installOrder: ['alpha'],
  }

  it('空附件目录也留一条登记（0 / 0 / 0 个目录），检查照样通过', async () => {
    const { root, profileDir } = await buildFixture()
    await rm(path.join(root, OFFLINE_EXTRAS_DIRNAME), { recursive: true, force: true })
    await mkdir(path.join(root, OFFLINE_EXTRAS_DIRNAME), { recursive: true })
    const result = await exportOfflinePack({ profileDir, outputDir: path.join(root, 'out-empty') })
    expect(result.manifest.extras).toEqual({ path: OFFLINE_EXTRAS_DIRNAME, fileCount: 0, bytes: 0, directoryCount: 0 })
    expect(await readdir(path.join(root, 'out-empty', OFFLINE_EXTRAS_DIRNAME))).toEqual([])
    expect(result.check.ok).toBe(true)
    expect(result.report.extras.fileCount).toBe(0)
  })

  it('家目录没有 extras/：不报错，产物里建空 extras/ 并登记 0/0', async () => {
    const { root, profileDir } = await buildFixture()
    await rm(path.join(root, OFFLINE_EXTRAS_DIRNAME), { recursive: true, force: true })
    const result = await exportOfflinePack({ profileDir, outputDir: path.join(root, 'out-missing') })
    expect(result.report.extras.sourceDir).toBeNull()
    expect(result.manifest.extras).toEqual({ path: OFFLINE_EXTRAS_DIRNAME, fileCount: 0, bytes: 0, directoryCount: 0 })
    expect(await readdir(path.join(root, 'out-missing', OFFLINE_EXTRAS_DIRNAME))).toEqual([])
    expect(result.check.ok).toBe(true)
  })

  it('包级检查缺哪件就点名哪件：核心 / 插件 / 附件', async () => {
    const { root } = await buildFixture()
    // format / platform 只走清单形状校验，不算「缺件」：缺 platform 的包不该报「缺少槽位」。
    const platformMissing = await writePack(root, { ...baseManifest, platform: undefined })
    const platformCheck = await verifyOfflinePack(platformMissing)
    expect(platformCheck.blocking.some(item => item.includes('槽位'))).toBe(false)
    expect(platformCheck.blocking.some(item => item.includes('platform'))).toBe(true)

    const kernelMissing = await writePack(root, { ...baseManifest, dshVersion: undefined })
    expect((await verifyOfflinePack(kernelMissing)).blocking.some(item => item.startsWith('缺少核心'))).toBe(true)

    const pluginsMissing = await writePack(root, { ...baseManifest, plugins: [] })
    expect((await verifyOfflinePack(pluginsMissing)).blocking.some(item => item.startsWith('缺少插件'))).toBe(true)

    const extrasMissing = await writePack(root, baseManifest, { extras: false })
    const missingCheck = await verifyOfflinePack(extrasMissing)
    expect(missingCheck.ok).toBe(false)
    expect(missingCheck.blocking.some(item => item.startsWith('缺少附件'))).toBe(true)
  })

  it('产物根出现 conversations 上传目录 attachments/：直接阻塞', async () => {
    const { root } = await buildFixture()
    const pack = await writePack(root, baseManifest, { conversations: true })
    const check = await verifyOfflinePack(pack)
    expect(check.ok).toBe(false)
    expect(check.blocking.some(item => item.includes('产物里出现了 conversations 上传目录'))).toBe(true)
  })

  it('附件目录在但名单没登记 / 登记与实况不符，都要阻塞', async () => {
    const { root, profileDir } = await buildFixture()
    const notRegistered = await writePack(root, { ...baseManifest, extras: undefined })
    expect((await verifyOfflinePack(notRegistered)).blocking.some(item => item.includes('extras'))).toBe(true)

    const result = await exportOfflinePack({ profileDir, outputDir: path.join(root, 'out-drift') })
    expect(result.check.ok).toBe(true)
    await writeFile(path.join(root, 'out-drift', OFFLINE_EXTRAS_DIRNAME, 'v1', 'extra.txt'), 'x', 'utf8')
    const drifted = await verifyOfflinePack(path.join(root, 'out-drift'))
    expect(drifted.ok).toBe(false)
    expect(drifted.blocking.some(item => item.includes('附件与名单登记不一致'))).toBe(true)
  })
})

describe('随包内核：导出 / 校验 / 老包兼容', () => {
  const KERNEL_VERSION = '0.2.1-rc.2'

  /**
   * 造一棵 kernelIsComplete 认的内核树（就是 <home>/profiles/node_modules 的形状）：
   * .bin/dsh.cmd + @deepseek-ai/dsh（带一个第三方依赖 + 一个没装的平台 optional 依赖）。
   */
  async function makeKernelModules(
    modules: string,
    version = KERNEL_VERSION,
    options: { shell?: boolean; manifest?: boolean; extraDependency?: boolean } = {},
  ): Promise<void> {
    await mkdir(modules, { recursive: true })
    if (options.shell !== false) {
      await mkdir(path.join(modules, '.bin'), { recursive: true })
      await writeFile(path.join(modules, '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '// stub\n', 'utf8')
    }
    if (options.manifest !== false) {
      await writeJson(path.join(modules, '@deepseek-ai', 'dsh', 'package.json'), {
        name: '@deepseek-ai/dsh',
        version,
        // 内核的第三方依赖：npm 扁平树里在顶层，不跟着带上别人机器就 import 不到。
        dependencies: { 'kernel-dep': '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/dsh-linux-x64': '1.0.0' },
      })
      await writeFile(path.join(modules, '@deepseek-ai', 'dsh', 'bin.js'), 'console.log(1)\n', 'utf8')
    }
    if (options.extraDependency !== false) {
      await writeJson(path.join(modules, 'kernel-dep', 'package.json'), { name: 'kernel-dep', version: '2.0.0' })
      await writeFile(path.join(modules, 'kernel-dep', 'index.js'), 'module.exports = 2\n', 'utf8')
    }
    // 插件自己的依赖：不该被当成内核带进包。
    await writeJson(path.join(modules, 'plugin-only-dep', 'package.json'), { name: 'plugin-only-dep', version: '3.0.0' })
    await writeJson(path.join(modules, 'package.json'), { name: 'kernel-tree', version })
  }

  /** 一个家目录的内核树：profileDir = <home>/profiles/<id>，内核树 = <home>/profiles/node_modules。 */
  async function makeHome(
    profileDir: string,
    options: { shell?: boolean; manifest?: boolean; extraDependency?: boolean } = {},
  ): Promise<string> {
    const modules = kernelModulesDirOf(profileDir)
    await makeKernelModules(modules, KERNEL_VERSION, options)
    return modules
  }

  it('内核包 = @deepseek-ai/* + 它们的依赖闭包；插件自己的依赖不算内核', async () => {
    const { root, profileDir } = await buildFixture()
    const modules = await makeHome(profileDir)

    const selection = await selectKernelPackages(modules)

    expect(selection.packages).toContain('@deepseek-ai/dsh')
    expect(selection.packages).toContain('kernel-dep')
    expect(selection.packages).not.toContain('plugin-only-dep')
    // 平台专属的 optional 依赖没装：算 missing（跳过），不是错误。
    expect(selection.missing).toContain('@deepseek-ai/dsh-linux-x64')
    expect(selection.packages.every(isKernelPackageName) || selection.packages.includes('kernel-dep')).toBe(true)
    expect(selection.packages).toEqual([...selection.packages].sort())
    void root
  })

  it('从 home 的内核树挑包打进 kernel/：manifest 带完整登记，自检通过', async () => {
    const { root, profileDir } = await buildFixture()
    await makeHome(profileDir)
    const outputDir = path.join(root, 'out-kernel')

    const result = await exportOfflinePack({ profileDir, outputDir })

    expect(result.report.kernel.state).toBe('packed')
    expect(result.manifest.kernel).toBeDefined()
    const kernel = result.manifest.kernel!
    expect(kernel.version).toBe(KERNEL_VERSION)
    expect(kernel.tgz).toBe('kernel/' + kernelTgzName(KERNEL_VERSION))
    expect(kernel.files).toBeGreaterThan(0)
    expect(kernel.bytes).toBeGreaterThan(0)
    // integrity 与 vendor 同一算法：拿磁盘上的 tgz 复算必须对得上。
    const onDisk = await readFile(path.join(outputDir, ...kernel.tgz.split('/')))
    expect(onDisk.length).toBe(kernel.bytes)
    expect(integrityOf(onDisk)).toBe(kernel.integrity)
    expect(kernel.extractedBytes).toBeGreaterThan(0)

    // 归档内是 node_modules/… 的形状：解出来 rename 成 <home>/profiles/node_modules 就能用。
    const entries = readTarGz(onDisk).map(entry => entry.path)
    expect(entries).toContain('node_modules/.bin/' + (process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))
    expect(entries).toContain('node_modules/@deepseek-ai/dsh/package.json')
    expect(entries).toContain('node_modules/kernel-dep/index.js')
    expect(entries).toContain('package.json')
    expect(entries).not.toContain('node_modules/plugin-only-dep/package.json')
    expect(entries.some(item => item.startsWith('package/'))).toBe(false)

    expect(result.check.ok).toBe(true)
    expect(result.check.stats.kernelBytes).toBe(kernel.bytes)
    expect(result.check.warnings.some(item => item.includes('内核未随包携带'))).toBe(false)
    expect(result.report.totalBytes).toBeGreaterThanOrEqual(kernel.bytes)
  })

  it('home 里没有内核树：包照旧导出，但 warning 说清「未随包携带」和原因', async () => {
    const { root, profileDir } = await buildFixture()
    const result = await exportOfflinePack({ profileDir, outputDir: path.join(root, 'out-no-kernel') })

    expect(result.manifest.kernel).toBeUndefined()
    expect(result.report.kernel.state).toBe('missing-source')
    expect(result.report.kernel.detail).toContain(kernelModulesDirOf(profileDir))
    expect(result.check.ok).toBe(true)
    expect(result.check.warnings.some(item => item === '内核未随包携带：' + result.report.kernel.detail)).toBe(true)
    // 老包那条通用提示也在（导入时目标机得自己装）。
    expect(result.check.warnings.some(item => item.includes('包里没有随包内核'))).toBe(true)
    expect(await readdir(path.join(root, 'out-no-kernel', OFFLINE_KERNEL_DIRNAME)).catch(() => [] as string[])).toEqual([])
  })

  it('home 的内核树不完整（缺启动外壳）：不静默跳过，报告里点名不完整', async () => {
    const { root, profileDir } = await buildFixture()
    await makeHome(profileDir, { shell: false })

    const result = await exportOfflinePack({ profileDir, outputDir: path.join(root, 'out-broken') })

    expect(result.manifest.kernel).toBeUndefined()
    expect(result.report.kernel.state).toBe('incomplete-source')
    expect(result.report.kernel.detail).toContain('不完整')
    expect(result.check.ok).toBe(true)
    expect(result.check.warnings.some(item => item.includes('内核未随包携带'))).toBe(true)
  })

  it('本机版本库里有内核也不算数：源就是这个 home 自己的内核树', async () => {
    // 事实：每个 home 的 profiles/node_modules 是独立副本，共享区只是新建实例时的源。
    // 这里显式把共享区放一份完整内核，home 里没有 —— 结论仍应是「未随包携带」。
    const { root, profileDir } = await buildFixture()
    const shared = path.join(root, 'dsh-runtime', 'versions', KERNEL_VERSION, 'node_modules')
    await makeKernelModules(shared)

    const result = await exportOfflinePack({ profileDir, outputDir: path.join(root, 'out-shared-only') })

    expect(result.manifest.kernel).toBeUndefined()
    expect(result.report.kernel.state).toBe('missing-source')
    expect(result.check.warnings.some(item => item.includes('内核未随包携带'))).toBe(true)
  })

  it('打内核只读源目录：打完源目录一个文件没变', async () => {
    const { root, profileDir } = await buildFixture()
    const modules = await makeHome(profileDir)
    const before = (await readdir(modules)).sort()

    const packed = await packKernelFromHome({ profileDir, version: KERNEL_VERSION, packDir: path.join(root, 'out-readonly') })

    expect(packed.state).toBe('packed')
    expect((await readdir(modules)).sort()).toEqual(before)
    expect(packed.kernel?.files).toBeGreaterThan(0)
  })

  it('打出来的 tgz 可复现：同一棵内核树打两次得到同一个 sha512', async () => {
    const { root, profileDir } = await buildFixture()
    const modules = await makeHome(profileDir)
    const first = await packKernelTgz(modules, path.join(root, 'pack-a'), KERNEL_VERSION)
    const second = await packKernelTgz(modules, path.join(root, 'pack-b'), KERNEL_VERSION)
    expect(second.integrity).toBe(first.integrity)
    expect(second.bytes).toBe(first.bytes)
    expect(second.files).toBe(first.files)
  })

  it('校验端：内核文件缺失 / 字节数不符 / sha512 不符都要报明确错误', async () => {
    const { root, profileDir } = await buildFixture()
    await makeHome(profileDir)
    const kernelSource = kernelModulesDirOf(profileDir)

    async function buildPack(name: string): Promise<{ packDir: string; kernelFile: string }> {
      const packDir = path.join(root, name)
      const vendorDir = path.join(packDir, 'vendor')
      await mkdir(vendorDir, { recursive: true })
      await mkdir(path.join(packDir, 'extras'), { recursive: true })
      const tgzBytes = writeTarGz([{ path: 'package/package.json', type: 'file', data: Buffer.from('{"name":"alpha"}') }])
      await writeFile(path.join(vendorDir, 'alpha-1.0.0.tgz'), tgzBytes)
      const kernel = await packKernelTgz(kernelSource, packDir, KERNEL_VERSION)
      const manifest = createOfflineManifest({
        dshVersion: KERNEL_VERSION,
        platform: 'win32-x64',
        plugins: [{
          name: 'alpha',
          version: '1.0.0',
          integrity: integrityOf(tgzBytes),
          tgz: 'vendor/alpha-1.0.0.tgz',
          entry: 'index.js',
          hasBundle: false,
          hasClient: false,
          deps: [],
          enabled: true,
        }],
        extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
        kernel,
      })
      await writeOfflineManifest(packDir, manifest)
      return { packDir, kernelFile: path.join(packDir, ...kernel.tgz.split('/')) }
    }

    const healthy = await buildPack('pack-healthy')
    const healthyCheck = await verifyOfflinePack(healthy.packDir)
    expect(healthyCheck.ok).toBe(true)
    expect(healthyCheck.stats.kernelBytes).toBeGreaterThan(0)

    const missing = await buildPack('pack-kernel-missing')
    await rm(missing.kernelFile, { force: true })
    const missingCheck = await verifyOfflinePack(missing.packDir)
    expect(missingCheck.ok).toBe(false)
    expect(missingCheck.blocking.some(item => item.startsWith('随包内核缺失'))).toBe(true)

    const tampered = await buildPack('pack-kernel-tampered')
    const bytes = await readFile(tampered.kernelFile)
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff
    await writeFile(tampered.kernelFile, bytes)
    const tamperedCheck = await verifyOfflinePack(tampered.packDir)
    expect(tamperedCheck.ok).toBe(false)
    expect(tamperedCheck.blocking.some(item => item.includes('随包内核的 sha512'))).toBe(true)
  })

  it('老包（manifest 没有 kernel 字段）照常通过校验，只多一条提示', async () => {
    const { root } = await buildFixture()
    const packDir = path.join(root, 'pack-old')
    await mkdir(path.join(packDir, 'vendor'), { recursive: true })
    await mkdir(path.join(packDir, 'extras'), { recursive: true })
    await writeFile(path.join(packDir, 'vendor', 'alpha-1.0.0.tgz'), writeTarGz([{ path: 'package/package.json', type: 'file', data: Buffer.from('{"name":"alpha"}') }]))
    const manifest = createOfflineManifest({
      dshVersion: KERNEL_VERSION,
      platform: 'win32-x64',
      plugins: [{
        name: 'alpha',
        version: '1.0.0',
        integrity: integrityOf(await readFile(path.join(packDir, 'vendor', 'alpha-1.0.0.tgz'))),
        tgz: 'vendor/alpha-1.0.0.tgz',
        entry: 'index.js',
        hasBundle: false,
        hasClient: false,
        deps: [],
        enabled: true,
      }],
      extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
    })
    await writeOfflineManifest(packDir, manifest)

    expect(await readFile(path.join(packDir, 'manifest.json'), 'utf8')).not.toContain('"kernel"')
    const check = await verifyOfflinePack(packDir)
    expect(check.ok).toBe(true)
    expect(check.stats.kernelBytes).toBe(0)
    expect(check.warnings.some(item => item.includes('包里没有随包内核'))).toBe(true)
  })
})

describe('manifest.kernel 的序列化与解析', () => {
  const plugin: OfflineManifestPlugin = {
    name: 'alpha',
    version: '1.0.0',
    integrity: 'sha512-' + Buffer.from('alpha').toString('base64'),
    tgz: 'vendor/alpha-1.0.0.tgz',
    entry: 'index.js',
    hasBundle: false,
    hasClient: false,
    deps: [],
    enabled: true,
  }
  const extras = { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 }
  const kernel = {
    version: '0.2.1-rc.2',
    tgz: 'kernel/kernel-0.2.1-rc.2.tgz',
    integrity: 'sha512-' + Buffer.from('kernel').toString('base64'),
    bytes: 1024,
    files: 7,
    extractedBytes: 4096,
  }

  it('带 kernel 的清单能原样往返', () => {
    const manifest = createOfflineManifest({ dshVersion: '0.2.1-rc.2', platform: 'win32-x64', plugins: [plugin], extras, kernel })
    const readBack = parseOfflineManifest(serializeOfflineManifest(manifest))
    expect(readBack).toEqual(manifest)
    expect(readBack.kernel).toEqual(kernel)
  })

  it('没有 kernel 的老清单照常解析（向后兼容）', () => {
    const manifest = createOfflineManifest({ dshVersion: '0.2.1-rc.2', platform: 'win32-x64', plugins: [plugin], extras })
    const readBack = parseOfflineManifest(serializeOfflineManifest(manifest))
    expect(readBack.kernel).toBeUndefined()
    expect('kernel' in readBack).toBe(false)
  })

  it('extractedBytes 可缺省（早期包），缺失时不补默认值', () => {
    const manifest = createOfflineManifest({ dshVersion: '0.2.1-rc.2', platform: 'win32-x64', plugins: [plugin], extras })
    const json = JSON.parse(serializeOfflineManifest(manifest)) as Record<string, unknown>
    const { extractedBytes: _ignored, ...kernelWithoutSize } = kernel
    json.kernel = kernelWithoutSize
    const readBack = parseOfflineManifest(JSON.stringify(json))
    expect(readBack.kernel?.extractedBytes).toBeUndefined()
    expect(readBack.kernel?.files).toBe(7)
  })

  it('kernel 字段写坏了就明确报错：路径越界 / integrity 不是 sha512 / 缺 bytes', () => {
    const base = JSON.parse(serializeOfflineManifest(createOfflineManifest({
      dshVersion: '0.2.1-rc.2', platform: 'win32-x64', plugins: [plugin], extras, kernel,
    }))) as Record<string, unknown>

    const outside = structuredClone(base)
    ;(outside.kernel as Record<string, unknown>).tgz = 'vendor/kernel-0.2.1-rc.2.tgz'
    expect(() => parseOfflineManifest(JSON.stringify(outside))).toThrow(/kernel\/ 下的相对路径/)

    const traversal = structuredClone(base)
    ;(traversal.kernel as Record<string, unknown>).tgz = 'kernel/../../evil.tgz'
    expect(() => parseOfflineManifest(JSON.stringify(traversal))).toThrow(/kernel\/ 下的相对路径/)

    const badIntegrity = structuredClone(base)
    ;(badIntegrity.kernel as Record<string, unknown>).integrity = 'md5-abc'
    expect(() => parseOfflineManifest(JSON.stringify(badIntegrity))).toThrow(/integrity 不是 sha512/)

    const noBytes = structuredClone(base)
    delete (noBytes.kernel as Record<string, unknown>).bytes
    expect(() => parseOfflineManifest(JSON.stringify(noBytes))).toThrow(/manifest.kernel.bytes/)

    const badVersion = structuredClone(base)
    ;(badVersion.kernel as Record<string, unknown>).version = 'not-a-version'
    expect(() => parseOfflineManifest(JSON.stringify(badVersion))).toThrow(/kernel.version 不是版本号/)
  })
})
