/**
 * 「整合包自带内核」的导入端：目标机没有这个版本的内核时，把包里的内核解出来落成新实例自己的
 * <home>/profiles/node_modules（真实目录，不是 junction），换台机器不用先装内核。
 *
 * 钉死这几件事（都是验收项）：
 *   - 解出来的目录必须过 kernelIsComplete，并成为实例自己的内核（不再依赖本机版本库）；
 *   - 本机已有完整内核时照旧 junction 过去（省 700 MB），不推进「解出内核」阶段；
 *   - 包里那份内核不完整/坏掉/空间不够：如实报错，staging 删干净，不留半截目录；
 *   - 老包（没有 manifest.kernel）照旧走原路：本机没内核就报原来那句话。
 *
 * 端到端只用小内核跑：真实 700 MB 的往返另有一次（见台账），单测不碰真实目录。
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { kernelIsComplete } from '../electron/kernel-seed'
import { createOfflineManifest, integrityOf, packKernelTgz, writeOfflineManifest, type OfflineManifestKernel } from '../electron/pack-offline-export'
import { createOfflinePackImport, ensureJunction, type JunctionLinkIo } from '../electron/pack-offline-import-ipc'
import { readPackRegistry } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'
import { writeTarGz, type TarEntry } from '../electron/tar-archive'
import type { AppSettings } from '../src/types'

const KERNEL_VERSION = '0.2.1-rc.2'
const PACK_FOLDER = 'dsh-kernel-pack'
/** 解包 staging 的前缀（与 pack-offline-import-ipc.ts 的 KERNEL_STAGING_PREFIX 一致）。 */
const STAGING_PREFIX = 'dsh-pack-zip-kernel-'
const temporaryDirectories: string[] = []

afterEach(async () => {
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

/**
 * 造一棵内核树（<home>/profiles/node_modules 或 <dshInstallPath>/versions/<ver>/node_modules 的形状）：
 * .bin/dsh.cmd + @deepseek-ai/dsh（带一个第三方依赖）。
 */
async function makeKernelModules(
  modules: string,
  options: { shell?: boolean; manifest?: boolean } = {},
): Promise<void> {
  await mkdir(modules, { recursive: true })
  if (options.shell !== false) {
    await mkdir(path.join(modules, '.bin'), { recursive: true })
    await writeFile(path.join(modules, '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '// stub\n', 'utf8')
  }
  if (options.manifest !== false) {
    await writeJson(path.join(modules, '@deepseek-ai', 'dsh', 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: KERNEL_VERSION,
      dependencies: { 'kernel-dep': '^2.0.0' },
    })
    await writeFile(path.join(modules, '@deepseek-ai', 'dsh', 'bin.js'), 'console.log(1)\n', 'utf8')
  }
  await writeJson(path.join(modules, 'kernel-dep', 'package.json'), { name: 'kernel-dep', version: '2.0.0' })
  await writeFile(path.join(modules, 'kernel-dep', 'index.js'), 'module.exports = 2\n', 'utf8')
}

interface PackOptions {
  /** 给内核源目录（= 会随包带走）：不给就是老包（manifest 里没有 kernel 段）。 */
  kernelSourceDir?: string
  /** 写完清单后把内核文件删掉（模拟包不完整）。 */
  dropKernelFile?: boolean
  /** 写完清单后改坏内核文件的一个字节（模拟传输损坏）。 */
  corruptKernelFile?: boolean
  /** 覆盖 extractedBytes（喂一个不可能装得下的体积，验空间预检）。 */
  extractedBytes?: number
}

/** 造一个最小可导入的包：manifest.json + vendor/*.tgz + extras/（+ 可选 kernel/）。 */
async function makePack(root: string, options: PackOptions = {}): Promise<{ packDir: string; kernelFile: string | null }> {
  const packDir = path.join(root, PACK_FOLDER)
  const vendorDir = path.join(packDir, 'vendor')
  const tgzName = 'dsh-test-plugin-1.0.0.tgz'
  const entries: TarEntry[] = [
    { path: 'package', type: 'directory' },
    {
      path: 'package/package.json',
      type: 'file',
      data: Buffer.from(JSON.stringify({ name: 'dsh-test-plugin', version: '1.0.0', main: 'lib/index.js', dsh: { client: { platform: 'web' } } }), 'utf8'),
    },
    { path: 'package/lib', type: 'directory' },
    { path: 'package/lib/index.js', type: 'file', data: Buffer.from('export default {}\n', 'utf8') },
  ]
  await mkdir(vendorDir, { recursive: true })
  const tgzPath = path.join(vendorDir, tgzName)
  await writeFile(tgzPath, writeTarGz(entries))

  let kernel: OfflineManifestKernel | undefined
  let kernelFile: string | null = null
  if (options.kernelSourceDir) {
    kernel = await packKernelTgz(options.kernelSourceDir, packDir, KERNEL_VERSION)
    kernelFile = path.join(packDir, ...kernel.tgz.split('/'))
    if (options.extractedBytes !== undefined) kernel = { ...kernel, extractedBytes: options.extractedBytes }
  }

  const manifest = createOfflineManifest({
    dshVersion: KERNEL_VERSION,
    platform: 'win32-x64',
    plugins: [{
      name: 'dsh-test-plugin',
      version: '1.0.0',
      integrity: integrityOf(await readFile(tgzPath)),
      tgz: 'vendor/' + tgzName,
      entry: 'lib/index.js',
      hasBundle: false,
      hasClient: true,
      deps: [],
      enabled: true,
    }],
    extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
    ...(kernel ? { kernel } : {}),
  })
  await writeOfflineManifest(packDir, manifest)
  await mkdir(path.join(packDir, 'extras'), { recursive: true })

  if (kernelFile && options.dropKernelFile) await rm(kernelFile, { force: true })
  if (kernelFile && options.corruptKernelFile) {
    const bytes = await readFile(kernelFile)
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff
    await writeFile(kernelFile, bytes)
  }
  return { packDir, kernelFile }
}

interface TestEnv {
  root: string
  packsRoot: string
  registryPath: string
  /** 本机运行时目录（内核版本库）：故意留空 = 这台机器没装内核。 */
  installRoot: string
  settings: AppSettings
}

async function makeEnv(options: { preinstalledKernel?: boolean } = {}): Promise<TestEnv> {
  const root = await temporaryRoot('dsh-pack-offline-kernel-')
  const packsRoot = path.join(root, 'dsh-packs')
  const installRoot = path.join(root, 'dsh-runtime')
  await mkdir(packsRoot, { recursive: true })
  await mkdir(installRoot, { recursive: true })
  if (options.preinstalledKernel) {
    await makeKernelModules(path.join(installRoot, 'versions', KERNEL_VERSION, 'node_modules'))
  }
  const settings: AppSettings = {
    ...defaultSettings({ homeDirectory: root, documentsDirectory: root }),
    packsRoot,
    dshInstallPath: installRoot,
  }
  return { root, packsRoot, registryPath: path.join(root, 'packs.json'), installRoot, settings }
}

function makeImporter(env: TestEnv, stages: string[] = [], logs: string[] = [], junctionIo?: Partial<JunctionLinkIo>) {
  return createOfflinePackImport({
    readSettings: async () => env.settings,
    registryPath: env.registryPath,
    emitProgress: progress => { stages.push(progress.stage) },
    log: message => { logs.push(message) },
    // 与 ipc.ts 同一条契约的测试替身：把指针真的写到 env.settings 上（不在这里判「有没有激活包」，
    // 那个判断在导入模块里；替身再判一次会把那边的 bug 掩掉）。
    activatePack: async packId => {
      env.settings.activePackId = packId
      env.settings.profileName = packId
    },
    ...(junctionIo ? { junctionIo } : {}),
  })
}

/** packs.json 里那一条记录的家目录。 */
function homeOf(env: TestEnv): string {
  return path.join(env.packsRoot, 'pack-' + PACK_FOLDER)
}

/** 解包 staging 的残留（成功失败都必须为空）。 */
async function leftoverStaging(packsRoot: string): Promise<string[]> {
  const entries = await readdir(packsRoot).catch(() => [] as string[])
  return entries.filter(name => name.startsWith(STAGING_PREFIX))
}

describe('导入端：包里自带内核', () => {
  it('本机没有这个版本：把包里内核解成新实例自己的 profiles/node_modules，装完能用', async () => {
    const env = await makeEnv()
    const kernelSource = path.join(env.root, 'kernel-source')
    await makeKernelModules(kernelSource)
    const { packDir } = await makePack(env.root, { kernelSourceDir: kernelSource })
    const stages: string[] = []

    const outcome = await makeImporter(env, stages).start({ packDir, name: '自带内核' })

    expect(outcome).toEqual({ ok: true, packId: 'pack-' + PACK_FOLDER, packName: '自带内核' })
    const installed = path.join(homeOf(env), 'profiles', 'node_modules')
    // 真实目录，不是指向版本库的 junction：这个实例从此自带内核。
    expect((await lstat(installed)).isSymbolicLink()).toBe(false)
    expect((await stat(installed)).isDirectory()).toBe(true)
    // 解出来的树必须过 kernelIsComplete 那一套判定（<home>/profiles 是含 node_modules 的那一层）。
    expect(await kernelIsComplete(path.join(homeOf(env), 'profiles'))).toBe(true)
    // 第三方依赖也跟来了（只带 @deepseek-ai/* 会在别人机器上 import 断）。
    expect((await stat(path.join(installed, 'kernel-dep', 'index.js'))).isFile()).toBe(true)
    // 版本库没被塞进一份副本：包里那份只落在实例自己身上（versions/ 连建都没建）。
    expect(await lstat(path.join(env.installRoot, 'versions')).catch(() => null)).toBeNull()

    expect(stages).toContain('kernel')
    expect(stages[stages.length - 1]).toBe('done')
    expect(await leftoverStaging(env.packsRoot)).toEqual([])
  })

  it('本机已经有完整内核：照旧 junction，不推进「解出内核」阶段，原内核一个字节不动', async () => {
    const env = await makeEnv({ preinstalledKernel: true })
    const shared = path.join(env.installRoot, 'versions', KERNEL_VERSION, 'node_modules')
    await writeFile(path.join(shared, 'MARKER.txt'), 'keep\n', 'utf8')
    const kernelSource = path.join(env.root, 'kernel-source')
    await makeKernelModules(kernelSource)
    const { packDir } = await makePack(env.root, { kernelSourceDir: kernelSource })
    const stages: string[] = []
    const logs: string[] = []

    const outcome = await makeImporter(env, stages, logs).start({ packDir, name: '已有内核' })

    expect(outcome.ok).toBe(true)
    expect(stages).not.toContain('kernel')
    expect((await lstat(path.join(homeOf(env), 'profiles', 'node_modules'))).isSymbolicLink()).toBe(true)
    expect(await readFile(path.join(shared, 'MARKER.txt'), 'utf8')).toBe('keep\n')
    expect(logs.some(line => line.includes('用本机现成的内核'))).toBe(true)
  })

  it('包里的内核缺启动外壳：如实报错，不留半截目录，也不建实例', async () => {
    const env = await makeEnv()
    const kernelSource = path.join(env.root, 'kernel-source-broken')
    await makeKernelModules(kernelSource, { shell: false })
    const { packDir } = await makePack(env.root, { kernelSourceDir: kernelSource })

    const outcome = await makeImporter(env).start({ packDir, name: '坏内核' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false ? outcome.reason : '').toContain('装不成可用内核')
    expect(outcome.ok === false ? outcome.reason : '').toContain('node_modules/.bin')
    expect(await readdir(env.packsRoot).catch(() => [] as string[])).toEqual([])
    expect(await readdir(env.registryPath ? path.dirname(env.registryPath) : env.root)).toBeDefined()
  })

  it('包里的内核文件损坏（sha512 不符）：明确报错，一个字节都不解', async () => {
    const env = await makeEnv()
    const kernelSource = path.join(env.root, 'kernel-source-corrupt')
    await makeKernelModules(kernelSource)
    const { packDir } = await makePack(env.root, { kernelSourceDir: kernelSource, corruptKernelFile: true })

    const outcome = await makeImporter(env).start({ packDir, name: '损坏内核' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false ? outcome.reason : '').toContain('内核文件损坏')
    expect(await readdir(env.packsRoot).catch(() => [] as string[])).toEqual([])
  })

  it('包登记了内核但包里没有那个文件：明确报错「包不完整」', async () => {
    const env = await makeEnv()
    const kernelSource = path.join(env.root, 'kernel-source-dropped')
    await makeKernelModules(kernelSource)
    const { packDir } = await makePack(env.root, { kernelSourceDir: kernelSource, dropKernelFile: true })

    const outcome = await makeImporter(env).start({ packDir, name: '缺内核文件' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false ? outcome.reason : '').toContain('找不到那个内核文件')
    expect(await readdir(env.packsRoot).catch(() => [] as string[])).toEqual([])
  })

  it('磁盘空间不够（清单声明的解包体积过大）：解包前就给出明确提示', async () => {
    const env = await makeEnv()
    const kernelSource = path.join(env.root, 'kernel-source-huge')
    await makeKernelModules(kernelSource)
    const { packDir } = await makePack(env.root, {
      kernelSourceDir: kernelSource,
      // 10 TB：任何一台机器都装不下，专门验空间预检这条分支。
      extractedBytes: 10 * 1024 * 1024 * 1024 * 1024,
    })

    const outcome = await makeImporter(env).start({ packDir, name: '空间不够' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false ? outcome.reason : '').toContain('磁盘空间不够')
    expect(await leftoverStaging(env.packsRoot)).toEqual([])
    expect(await readdir(env.packsRoot).catch(() => [] as string[])).toEqual([])
  })

  it('老包（没有 kernel 段）+ 本机没内核：报原来的那句话，行为不变', async () => {
    const env = await makeEnv()
    const { packDir } = await makePack(env.root)

    const outcome = await makeImporter(env).start({ packDir, name: '老包' })

    expect(outcome).toEqual({ ok: false, reason: '本机没有 DSH ' + KERNEL_VERSION + '，先在启动页装好这个版本再导入。' })
    expect(await readdir(env.packsRoot)).toEqual([])
  })

  it('老包（没有 kernel 段）+ 本机已装好内核：照旧能装（向后兼容）', async () => {
    const env = await makeEnv({ preinstalledKernel: true })
    const { packDir } = await makePack(env.root)
    const stages: string[] = []

    const outcome = await makeImporter(env, stages).start({ packDir, name: '老包兼容' })

    expect(outcome.ok).toBe(true)
    expect(stages).not.toContain('kernel')
    expect((await stat(path.join(homeOf(env), 'profiles'))).isDirectory()).toBe(true)
    const records = await readPackRegistry(env.registryPath)
    expect(records.map(record => record.id)).toEqual(['pack-' + PACK_FOLDER])
  })

  it('包登记的内核版本与 dshVersion 对不上：拒绝导入，不写磁盘', async () => {
    const env = await makeEnv()
    const kernelSource = path.join(env.root, 'kernel-source-mismatch')
    await makeKernelModules(kernelSource)
    const { packDir } = await makePack(env.root, { kernelSourceDir: kernelSource })
    // 直接改清单里的内核版本，模拟导出的包自己前后矛盾。
    const manifestPath = path.join(packDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { kernel: { version: string } }
    manifest.kernel.version = '0.2.0-rc.2'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const outcome = await makeImporter(env).start({ packDir, name: '版本对不上' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false ? outcome.reason : '').toContain('内核版本和它要求的 DSH 版本对不上')
    expect(await readdir(env.packsRoot).catch(() => [] as string[])).toEqual([])
  })
})
// ===========================================================================
// 缺陷 1：junction 必须先铺内容、后建链接，建完立刻穿透校验
// ===========================================================================

describe('导入端：junction 建完穿透校验（缺陷 1）', () => {
  it('目标已经落盘时建 junction：立刻能穿透读到目标里的 package.json', async context => {
    // 契约：链接不是「重解析点结构对」就算好，必须**从链接读得到东西**。
    // 真机现场是相反顺序（先建链接、后铺内容）留下的坏链接：结构完全正常，18 条穿透读全失败
    // （ERROR_CANT_RESOLVE_FILENAME），而同位置新建一条立刻能读。
    const root = await temporaryRoot('dsh-junction-')
    const target = path.join(root, 'plugin-bodies', 'dsh-test-plugin')
    const link = path.join(root, 'profiles', 'pack-x', 'node_modules', 'dsh-test-plugin')
    await writeJson(path.join(target, 'package.json'), { name: 'dsh-test-plugin', version: '1.0.0' })
    await writeFile(path.join(target, 'index.js'), 'export default {}\n', 'utf8')

    let outcome: { ok: boolean; rebuilt: boolean }
    try {
      outcome = await ensureJunction({ targetPath: target, linkPath: link })
    } catch {
      // junction 只支持本地 NTFS；没有建链接权限的机器跳过并说明，不假装通过。
      context.skip()
      return
    }
    expect(outcome.ok).toBe(true)
    // 穿透校验：从链接读到的必须是本体里的东西。
    expect(JSON.parse(await readFile(path.join(link, 'package.json'), 'utf8')).name).toBe('dsh-test-plugin')
    expect(await readdir(link)).toContain('index.js')
    // 链接本身确实是重解析点，不是被悄悄拷成真实目录。
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('建完校验失败：删掉重建一次；第二次仍不通返回失败，不抛错也不连坐导入', async () => {
    let creates = 0
    let removes = 0
    const outcome = await ensureJunction({
      targetPath: 'D:\\fake-target',
      linkPath: 'D:\\fake-link',
      io: {
        readable: async () => false,
        remove: async () => { removes += 1 },
        create: async () => { creates += 1 },
      },
    })
    expect(outcome).toEqual({ ok: false, rebuilt: true })
    expect([removes, creates]).toEqual([1, 1])

    // 第一次就读得通：一次都不重建（不要为了「保险」每次都删一遍链接）。
    creates = 0
    removes = 0
    const healthy = await ensureJunction({
      targetPath: 'x',
      linkPath: 'y',
      io: { readable: async () => true, remove: async () => { removes += 1 }, create: async () => { creates += 1 } },
    })
    expect(healthy).toEqual({ ok: true, rebuilt: false })
    expect([removes, creates]).toEqual([0, 0])
  })

  it('链接重建一次仍读不通：记日志并写进 import-report.json，导入照样完成', async () => {
    const env = await makeEnv({ preinstalledKernel: true })
    const { packDir } = await makePack(env.root)
    const logs: string[] = []
    // 真机现场注入：链接建得出来、结构正常，但穿透读一律失败。整条链路必须走完，只留 warning。
    const outcome = await makeImporter(env, [], logs, { readable: async () => false })
      .start({ packDir, name: '读不通' })

    expect(outcome.ok).toBe(true)
    expect(logs.some(line => line.includes('穿透读不通'))).toBe(true)
    const reportPath = path.join(homeOf(env), 'profiles', 'pack-' + PACK_FOLDER, 'import-report.json')
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { warnings: string[] }
    // 必须是**这条插件**的链接留了痕：内核链接的警告不能顺手替它通过。
    expect(report.warnings.some(line => line.includes('dsh-test-plugin') && line.includes('穿透读不通'))).toBe(true)
  })
})

// ===========================================================================
// 缺陷 3：导入成功后首页要能选中新包（只在本机还没有激活包时切指针）
// ===========================================================================

describe('导入端：导入成功后自动选中新包（缺陷 3）', () => {
  it('原本没有激活包 → activePackId 指向新包；原本已有激活包 → 保持不变', async () => {
    // 场景 A：全新机器（还没有任何激活包）——导入完首页必须是这个包，而不是空状态。
    const fresh = await makeEnv({ preinstalledKernel: true })
    const freshPack = await makePack(fresh.root)
    fresh.settings.activePackId = null
    fresh.settings.profileName = 'web'
    const first = await makeImporter(fresh).start({ packDir: freshPack.packDir, name: '第一个包' })
    expect(first.ok).toBe(true)
    expect(fresh.settings.activePackId).toBe('pack-' + PACK_FOLDER)
    expect(fresh.settings.profileName).toBe('pack-' + PACK_FOLDER)

    // 场景 B：机器上已有激活包——新导入绝不能被顶掉。
    const occupied = await makeEnv({ preinstalledKernel: true })
    const occupiedPack = await makePack(occupied.root)
    occupied.settings.activePackId = 'pack-somebody-else'
    occupied.settings.profileName = 'pack-somebody-else'
    const second = await makeImporter(occupied).start({ packDir: occupiedPack.packDir, name: '第二个包' })
    expect(second.ok).toBe(true)
    expect(occupied.settings.activePackId).toBe('pack-somebody-else')
    expect(occupied.settings.profileName).toBe('pack-somebody-else')
  })
})

