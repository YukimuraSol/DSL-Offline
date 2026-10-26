/**
 * 离线整合包导入：预检阻塞、骨架、按 installOrder 装插件、三处依赖解析、附件合并、自验、报告。
 *
 * 三件必须被钉死的事：
 *   - 预检不过时一个字节都不写（尤其不能碰已存在的实例目录）；
 *   - 依赖节点按 Node 的三个位置（body / profile / shared）判，缺的必须出现在报告里；
 *   - 只有「运行时真的 import/require」的缺失才阻塞，仅声明的只记录。
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OfflineImportBlockedError,
  importOfflinePack,
  precheckOfflineImport,
  verifyImportedInstance,
  type OfflineImportReport,
} from '../electron/pack-offline-import'
import {
  createOfflineManifest,
  integrityOf,
  readOfflineManifest,
  tgzNameForPackage,
  writeOfflineManifest,
  type OfflineExtrasRecord,
} from '../electron/pack-offline-export'
import { writeTarGz, type TarEntry } from '../electron/tar-archive'
import { parseImportArguments, runImportCli } from '../scripts/import-offline-pack.mts'

const KERNEL_VERSION = '0.2.1-rc.2'
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(root)
  return root
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 目标机家目录：内核树（版本 + 入口）齐备，这样预检才过得去。 */
async function makeHome(root: string, version = KERNEL_VERSION): Promise<string> {
  const home = path.join(root, 'home')
  const kernel = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.join(kernel, 'lib'), { recursive: true })
  await writeFile(path.join(kernel, 'lib', 'bin.js'), '// stub kernel\n', 'utf8')
  await writeJson(path.join(kernel, 'package.json'), { name: '@deepseek-ai/dsh', version })
  const bin = path.join(home, 'profiles', 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  const shell = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  await writeFile(path.join(bin, shell), '// stub\n', 'utf8')
  return home
}

/** 装一个依赖节点（模拟内核树里已有的包）。 */
async function installSharedDependency(home: string, name: string, version = '1.0.0'): Promise<void> {
  await writeJson(path.join(home, 'profiles', 'node_modules', ...name.split('/'), 'package.json'), { name, version })
}

/** 造一个 npm 风格的插件 tgz；imports 写进 lib/index.js，nested 写成 tgz 内自带的 node_modules。 */
async function writePluginTgz(options: {
  vendorDir: string
  name: string
  version: string
  hasBundle: boolean
  imports?: string[]
  nested?: string[]
}): Promise<{ tgz: string; integrity: string }> {
  const runtime = (options.imports ?? []).map(name => 'const dep = require(' + JSON.stringify(name) + ')\n').join('')
  const entries: TarEntry[] = [
    { path: 'package', type: 'directory' },
    {
      path: 'package/package.json',
      type: 'file',
      data: Buffer.from(JSON.stringify({
        name: options.name,
        version: options.version,
        main: 'lib/index.js',
        ...(options.hasBundle
          ? { dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }
          : { dsh: { client: { platform: 'web' } } }),
      }, null, 2), 'utf8'),
    },
    { path: 'package/lib', type: 'directory' },
    { path: 'package/lib/index.js', type: 'file', data: Buffer.from(runtime || 'export default {}\n', 'utf8') },
    { path: 'package/cordis.patch.yml', type: 'file', data: Buffer.from('- insert: []\n', 'utf8') },
    // 类型声明里出现包名不算运行时依赖：专门塞一条，验证扫描不误报。
    { path: 'package/lib/types/index.d.ts', type: 'file', data: Buffer.from("import type { X } from 'dep-type-only'\n", 'utf8') },
  ]
  for (const name of options.nested ?? []) {
    entries.push({ path: 'package/node_modules/' + name + '/package.json', type: 'file', data: Buffer.from(JSON.stringify({ name, version: '1.0.0' }), 'utf8') })
  }
  const tgz = tgzNameForPackage(options.name, options.version)
  await mkdir(options.vendorDir, { recursive: true })
  const file = path.join(options.vendorDir, tgz)
  await writeFile(file, writeTarGz(entries))
  return { tgz: 'vendor/' + tgz, integrity: integrityOf(await readFile(file)) }
}

interface PackFixture {
  packDir: string
  home: string
  sharedDependencies: string[]
  /** 仅声明、代码没人用、三处都解不到（不阻塞）。 */
  declaredOnlyMissing: string[]
}

/**
 * 一个完整的包：两个插件（zzz-first 依赖 dep-present/dep-declared-only；@test/aaa-second 依赖 zzz-first，
 * 且 dep-in-body 由它自己的 tgz 自带）。名字序与拓扑序故意相反（zzz 先装）。
 */
async function makePack(options: {
  root: string
  extras?: 'empty' | 'with-file'
  kernelVersion?: string
} ): Promise<PackFixture> {
  const packDir = path.join(options.root, 'pack')
  const home = await makeHome(options.root, options.kernelVersion ?? KERNEL_VERSION)
  const vendorDir = path.join(packDir, 'vendor')
  const sharedDependencies = ['dep-present']
  const declaredOnlyMissing = ['dep-declared-only']
  await installSharedDependency(home, 'dep-present')

  const first = await writePluginTgz({
    vendorDir,
    name: 'zzz-first',
    version: '0.1.0',
    hasBundle: false,
    imports: ['dep-present'],
    // 声明了但代码里没人 require：只记录，不阻塞
  })
  const second = await writePluginTgz({
    vendorDir,
    name: '@test/aaa-second',
    version: '0.2.0',
    hasBundle: true,
    imports: ['dep-in-body'],
    nested: ['dep-in-body'],
  })

  let extrasRecord: OfflineExtrasRecord = { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 }
  if (options.extras === 'with-file') {
    const extrasDir = path.join(packDir, 'extras')
    await mkdir(path.join(extrasDir, 'notes'), { recursive: true })
    await writeFile(path.join(extrasDir, 'notes', 'a.txt'), 'hello extras\n', 'utf8')
    extrasRecord = { path: 'extras', fileCount: 1, bytes: 13, directoryCount: 1 }
  } else {
    await mkdir(path.join(packDir, 'extras'), { recursive: true })
  }

  const manifest = createOfflineManifest({
    dshVersion: KERNEL_VERSION,
    platform: 'win32-x64',
    plugins: [
      {
        name: 'zzz-first',
        version: '0.1.0',
        integrity: first.integrity,
        tgz: first.tgz,
        entry: 'lib/index.js',
        hasBundle: false,
        hasClient: true,
        deps: ['dep-present', 'dep-declared-only'],
        enabled: true,
      },
      {
        name: '@test/aaa-second',
        version: '0.2.0',
        integrity: second.integrity,
        tgz: second.tgz,
        entry: 'lib/index.js',
        hasBundle: true,
        hasClient: true,
        deps: ['zzz-first', 'dep-in-body'],
        enabled: true,
      },
    ],
    extras: extrasRecord,
  })
  await writeOfflineManifest(packDir, manifest)
  return { packDir, home, sharedDependencies, declaredOnlyMissing }
}

async function instanceExists(home: string, id: string): Promise<boolean> {
  return lstat(path.join(home, 'profiles', id)).then(() => true, () => false)
}

async function readReport(home: string, id: string): Promise<OfflineImportReport> {
  return JSON.parse(await readFile(path.join(home, 'profiles', id, 'import-report.json'), 'utf8')) as OfflineImportReport
}

describe('离线整合包导入', () => {
  it('全流程：按 installOrder 装插件、建 junction、登记清单、三处解析依赖、空 extras 也建目录', async () => {
    const root = await temporaryRoot('dsh-offline-import-')
    const pack = await makePack({ root })
    const id = 'import-test'
    const report = await importOfflinePack({ packDir: pack.packDir, home: pack.home, id })
    const profileDir = path.join(pack.home, 'profiles', id)

    // 报告本身
    expect(report.verification.ok).toBe(true)
    expect(report.verification.failures).toEqual([])
    expect(report.counts.plugins).toBe(2)
    expect(report.counts.junctions).toBe(2)
    expect(report.installOrderMatchesManifest).toBe(true)
    expect(report.missingDependencies).toEqual(['dep-declared-only'])
    expect(report.missingRequiredDependencies).toEqual([])
    expect(report.missingDeclaredOnlyDependencies).toEqual(['dep-declared-only'])

    // 三处解析：body 命中 dep-in-body，shared 命中 dep-present，profile 里只有插件 junction
    expect(report.dependencyRoots.body).toBe(1)
    expect(report.dependencyRoots.shared).toBe(1)
    expect(report.dependencyRoots.profile).toBe(0)
    const inBody = report.dependencies.find(dependency => dependency.name === 'dep-in-body')
    expect(inBody?.via).toEqual(['body'])
    expect(inBody?.requiredBy).toEqual(['@test/aaa-second'])
    const present = report.dependencies.find(dependency => dependency.name === 'dep-present')
    expect(present?.present).toBe(true)
    expect(present?.requiredBy).toEqual(['zzz-first'])
    // 仅声明的缺失：present=false 但不 blocking
    const declaredOnly = report.dependencies.find(dependency => dependency.name === 'dep-declared-only')
    expect(declaredOnly?.present).toBe(false)
    expect(declaredOnly?.blocking).toBe(false)
    expect(declaredOnly?.requiredBy).toEqual([])
    // .d.ts 里出现的包不算运行时依赖
    expect(report.dependencies.some(dependency => dependency.name === 'dep-type-only')).toBe(false)

    // 顺序：拓扑序（zzz-first 在 @test/aaa-second 之前），不是名字序
    expect(report.plugins.map(plugin => plugin.name)).toEqual(['zzz-first', '@test/aaa-second'])
    const manifestOnDisk = JSON.parse(await readFile(path.join(pack.packDir, 'manifest.json'), 'utf8')) as { installOrder: string[] }
    expect(report.installOrder).toEqual(manifestOnDisk.installOrder)

    // body + junction + 清单
    for (const plugin of report.plugins) {
      const bodyDir = path.join(profileDir, '.dsh-launcher-plugin-bodies', ...plugin.name.split('/'))
      expect((await stat(bodyDir)).isDirectory()).toBe(true)
      const gatePath = path.join(profileDir, 'node_modules', ...plugin.name.split('/'))
      expect((await lstat(gatePath)).isSymbolicLink()).toBe(true)
      expect((await stat(gatePath)).isDirectory()).toBe(true)
    }
    const profileManifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(profileManifest.name).toBe('dsh-profile-' + id)
    expect(Object.keys(profileManifest.dependencies).sort()).toEqual(['@test/aaa-second', 'zzz-first'])
    expect(profileManifest.dependencies['@test/aaa-second']).toBe('file:./.dsh-launcher-plugin-bodies/@test/aaa-second')
    // hasBundle 的进 bundles，纯 client 的不进
    expect(profileManifest.dsh.profile.bundles).toContain('@test/aaa-second')
    expect(profileManifest.dsh.profile.bundles).not.toContain('zzz-first')
    expect(profileManifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-base')

    // 骨架文件
    expect(await readFile(path.join(profileDir, 'profile.yaml'), 'utf8')).toContain('dshVersion: ' + KERNEL_VERSION)
    expect(await readFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')

    // 空 extras：也要建目录
    expect((await stat(path.join(pack.home, 'extras'))).isDirectory()).toBe(true)

    // 报告文件可读回
    const stored = await readReport(pack.home, id)
    expect(stored.format).toBe(1)
    expect(stored.plugins.length).toBe(2)
    expect(stored.counts.pluginFiles).toBeGreaterThan(0)
    expect(stored.counts.dependencyRequired).toBe(2)
  })

  it('真依赖缺失（运行时真的 require）→ 预检阻塞，一个字节都不写', async () => {
    const root = await temporaryRoot('dsh-offline-import-required-')
    const pack = await makePack({ root })
    // 重新打一个包：zzz-first 除了声明还真的 require 一个哪都没有的包
    const brokenTgz = await writePluginTgz({
      vendorDir: path.join(pack.packDir, 'vendor'),
      name: 'broken-plugin',
      version: '1.0.0',
      hasBundle: false,
      imports: ['dep-really-missing'],
    })
    const manifest = await readOfflineManifest(pack.packDir)
    manifest.plugins.push({
      name: 'broken-plugin',
      version: '1.0.0',
      integrity: brokenTgz.integrity,
      tgz: brokenTgz.tgz,
      entry: 'lib/index.js',
      hasBundle: false,
      hasClient: false,
      deps: ['dep-really-missing'],
      enabled: true,
    })
    manifest.installOrder.push('broken-plugin', 'dep-really-missing')
    await writeOfflineManifest(pack.packDir, manifest)

    const precheck = await precheckOfflineImport({ packDir: pack.packDir, home: pack.home, id: 'blocked-required' })
    expect(precheck.ok).toBe(false)
    const issue = precheck.blocking.find(item => item.code === 'dependency-missing-required')
    expect(issue?.message).toContain('dep-really-missing')
    expect(issue?.message).toContain('broken-plugin')

    await expect(importOfflinePack({ packDir: pack.packDir, home: pack.home, id: 'blocked-required' }))
      .rejects.toBeInstanceOf(OfflineImportBlockedError)
    expect(await instanceExists(pack.home, 'blocked-required')).toBe(false)
  })

  it('预检阻塞：缺 manifest.json，一个字节都不写', async () => {
    const root = await temporaryRoot('dsh-offline-import-nomanifest-')
    const home = await makeHome(root)
    const packDir = path.join(root, 'pack')
    await mkdir(path.join(packDir, 'vendor'), { recursive: true })
    await mkdir(path.join(packDir, 'extras'), { recursive: true })

    const precheck = await precheckOfflineImport({ packDir, home, id: 'blocked-1' })
    expect(precheck.ok).toBe(false)
    expect(precheck.blocking.map(issue => issue.code)).toContain('manifest-missing')

    await expect(importOfflinePack({ packDir, home, id: 'blocked-1' })).rejects.toBeInstanceOf(OfflineImportBlockedError)
    expect(await instanceExists(home, 'blocked-1')).toBe(false)
  })

  it('预检阻塞：vendor/ 为空', async () => {
    const root = await temporaryRoot('dsh-offline-import-novendor-')
    const pack = await makePack({ root })
    // 清空 vendor，但保留 manifest（清单仍引用那些 tgz）
    await rm(path.join(pack.packDir, 'vendor'), { recursive: true, force: true })
    await mkdir(path.join(pack.packDir, 'vendor'), { recursive: true })

    const precheck = await precheckOfflineImport({ packDir: pack.packDir, home: pack.home, id: 'blocked-2' })
    const codes = precheck.blocking.map(issue => issue.code)
    expect(precheck.ok).toBe(false)
    expect(codes).toContain('vendor-empty')
    expect(codes).toContain('vendor-missing-file')
    expect(await instanceExists(pack.home, 'blocked-2')).toBe(false)
  })

  it('预检阻塞：目标机内核版本不匹配', async () => {
    const root = await temporaryRoot('dsh-offline-import-version-')
    const pack = await makePack({ root, kernelVersion: '0.2.0-rc.2' })

    const precheck = await precheckOfflineImport({ packDir: pack.packDir, home: pack.home, id: 'blocked-3' })
    expect(precheck.ok).toBe(false)
    const mismatch = precheck.blocking.find(issue => issue.code === 'kernel-version-mismatch')
    expect(mismatch?.message).toContain('这台机器没有 ' + KERNEL_VERSION + ' 版本的内核')
    expect(mismatch?.message).toContain('0.2.0-rc.2')
    expect(await instanceExists(pack.home, 'blocked-3')).toBe(false)
  })

  it('预检阻塞：实例已存在，绝不覆盖', async () => {
    const root = await temporaryRoot('dsh-offline-import-exists-')
    const pack = await makePack({ root })
    const existing = path.join(pack.home, 'profiles', 'taken')
    await mkdir(existing, { recursive: true })
    await writeFile(path.join(existing, 'MARKER.txt'), 'do not touch\n', 'utf8')

    const precheck = await precheckOfflineImport({ packDir: pack.packDir, home: pack.home, id: 'taken' })
    expect(precheck.ok).toBe(false)
    expect(precheck.blocking.some(issue => issue.code === 'instance-exists')).toBe(true)

    await expect(importOfflinePack({ packDir: pack.packDir, home: pack.home, id: 'taken' })).rejects.toBeInstanceOf(OfflineImportBlockedError)
    // 原目录一个文件都不能少
    expect(await readFile(path.join(existing, 'MARKER.txt'), 'utf8')).toBe('do not touch\n')
    expect(await readdir(existing)).toEqual(['MARKER.txt'])
  })

  it('tgz 校验和不符：预检就挡住（包坏了不装半个实例）', async () => {
    const root = await temporaryRoot('dsh-offline-import-corrupt-')
    const pack = await makePack({ root })
    const manifestPath = path.join(pack.packDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { plugins: Array<{ tgz: string }> }
    // 改字节但不改清单里的 integrity
    const tgzPath = path.join(pack.packDir, manifest.plugins[0]!.tgz)
    await writeFile(tgzPath, Buffer.from('not a tgz'))

    const precheck = await precheckOfflineImport({ packDir: pack.packDir, home: pack.home, id: 'blocked-4' })
    expect(precheck.ok).toBe(false)
    expect(precheck.blocking.some(issue => issue.code === 'tgz-integrity')).toBe(true)
    expect(await instanceExists(pack.home, 'blocked-4')).toBe(false)
  })

  it('extras 有文件时复制，且不删目标机 extras 里已有的东西', async () => {
    const root = await temporaryRoot('dsh-offline-import-extras-')
    const pack = await makePack({ root, extras: 'with-file' })
    await mkdir(path.join(pack.home, 'extras'), { recursive: true })
    await writeFile(path.join(pack.home, 'extras', 'keep.txt'), 'user data\n', 'utf8')

    const report = await importOfflinePack({ packDir: pack.packDir, home: pack.home, id: 'with-extras' })
    expect(report.extras.fileCount).toBe(1)
    expect(report.extras.bytes).toBe(13)
    expect(await readFile(path.join(pack.home, 'extras', 'notes', 'a.txt'), 'utf8')).toBe('hello extras\n')
    // 目标机原有文件不被清掉
    expect(await readFile(path.join(pack.home, 'extras', 'keep.txt'), 'utf8')).toBe('user data\n')
  })

  it('自验能发现被破坏的实例（body 被删）', async () => {
    const root = await temporaryRoot('dsh-offline-import-verify-')
    const pack = await makePack({ root })
    const report = await importOfflinePack({ packDir: pack.packDir, home: pack.home, id: 'verify-me' })
    expect(report.verification.ok).toBe(true)
    await rm(path.join(report.profileDir, '.dsh-launcher-plugin-bodies', 'zzz-first'), { recursive: true, force: true })
    const manifest = await readOfflineManifest(pack.packDir)
    const verification = await verifyImportedInstance({ profileDir: report.profileDir, manifest })
    expect(verification.ok).toBe(false)
    expect(verification.failures.some(failure => failure.includes('zzz-first'))).toBe(true)
  })
})

describe('导入 CLI', () => {
  it('参数解析与用法', () => {
    expect(parseImportArguments(['--pack', 'p', '--home', 'h', '--id', 'i'])).toEqual({ pack: 'p', home: 'h', id: 'i' })
    expect(parseImportArguments(['--bogus', 'x'])).toEqual({})
  })

  it('退出码：缺参数 2 / 预检阻塞 1 / 成功 0', async () => {
    const root = await temporaryRoot('dsh-offline-import-cli-')
    const pack = await makePack({ root })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await runImportCli([])).toBe(2)
    // 正常导入 → 0
    expect(await runImportCli(['--pack', pack.packDir, '--home', pack.home, '--id', 'cli-blocked'])).toBe(0)
    // 同名实例再跑一次 → 阻塞 1
    expect(await runImportCli(['--pack', pack.packDir, '--home', pack.home, '--id', 'cli-blocked'])).toBe(1)
    // 不存在的包目录
    expect(await runImportCli(['--pack', path.join(root, 'nope'), '--home', pack.home, '--id', 'cli-missing'])).toBe(1)
  })
})
