/**
 * 「导入整合包」接受 .zip：解到临时目录 → 定位包目录 → 复用离线装配流水线。
 *
 * 钉死四件事：
 *   - 导出端那种「一个顶层文件夹 + manifest.json」能装成完整实例；
 *   - 缺 manifest / 顶层多个包目录 / 条目路径穿越 一律拒绝，且一个字节都不写；
 *   - manifest 就在压缩包根部时也认（包名退回压缩包文件名）；
 *   - 解压用的临时目录成功失败都清干净（含失败路径）。
 */
import AdmZip from 'adm-zip'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOfflineManifest, integrityOf, tgzNameForPackage, writeOfflineManifest } from '../electron/pack-offline-export'
import { createOfflinePackImport } from '../electron/pack-offline-import-ipc'
import { extractOfflinePackZip, unsafeZipEntry, ZIP_TEMP_PREFIX } from '../electron/pack-offline-zip'
import { readPackRegistry } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'
import { writeTarGz, type TarEntry } from '../electron/tar-archive'
import type { AppSettings } from '../src/types'

const KERNEL_VERSION = '0.2.1-rc.2'
const PACK_FOLDER = 'dsh-test-pack'
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

/** 目标机内核树：<installRoot>/versions/<ver>/node_modules（离线导入按这个位置挑内核）。 */
async function makeKernel(installRoot: string): Promise<void> {
  const modules = path.join(installRoot, 'versions', KERNEL_VERSION, 'node_modules')
  await writeJson(path.join(modules, '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: KERNEL_VERSION })
  const bin = path.join(modules, '.bin')
  await mkdir(bin, { recursive: true })
  await writeFile(path.join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '// stub\n', 'utf8')
}

/** 一个最小但完整的离线包目录：manifest.json + vendor/*.tgz + extras/。 */
async function makePackDirectory(root: string): Promise<string> {
  const packDir = path.join(root, PACK_FOLDER)
  const vendorDir = path.join(packDir, 'vendor')
  const tgz = tgzNameForPackage('dsh-test-plugin', '1.0.0')
  const entries: TarEntry[] = [
    { path: 'package', type: 'directory' },
    {
      path: 'package/package.json',
      type: 'file',
      data: Buffer.from(JSON.stringify({
        name: 'dsh-test-plugin',
        version: '1.0.0',
        main: 'lib/index.js',
        dsh: { client: { platform: 'web' } },
      }), 'utf8'),
    },
    { path: 'package/lib', type: 'directory' },
    { path: 'package/lib/index.js', type: 'file', data: Buffer.from('export default {}\n', 'utf8') },
  ]
  await mkdir(vendorDir, { recursive: true })
  const tgzPath = path.join(vendorDir, tgz)
  await writeFile(tgzPath, writeTarGz(entries))
  const manifest = createOfflineManifest({
    dshVersion: KERNEL_VERSION,
    platform: 'win32-x64',
    plugins: [{
      name: 'dsh-test-plugin',
      version: '1.0.0',
      integrity: integrityOf(await readFile(tgzPath)),
      tgz: 'vendor/' + tgz,
      entry: 'lib/index.js',
      hasBundle: false,
      hasClient: true,
      deps: [],
      enabled: true,
    }],
    extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
  })
  await writeOfflineManifest(packDir, manifest)
  await mkdir(path.join(packDir, 'extras'), { recursive: true })
  return packDir
}

/**
 * 把包目录压成 zip：root 非空时整包落在同名顶层文件夹下（导出端就是这种布局），
 * root = null 时 manifest.json 直接在压缩包根上。
 */
async function zipPack(packDir: string, zipPath: string, root: string | null): Promise<void> {
  const zip = new AdmZip()
  if (root) zip.addFile(root + '/', Buffer.alloc(0))
  const stack: Array<{ dir: string; rel: string }> = [{ dir: packDir, rel: root ?? '' }]
  while (stack.length > 0) {
    const current = stack.pop() as { dir: string; rel: string }
    for (const dirent of await readdir(current.dir, { withFileTypes: true })) {
      const full = path.join(current.dir, dirent.name)
      const rel = current.rel ? current.rel + '/' + dirent.name : dirent.name
      if (dirent.isDirectory()) {
        zip.addFile(rel + '/', Buffer.alloc(0))
        stack.push({ dir: full, rel })
      } else if (dirent.isFile()) {
        zip.addFile(rel, await readFile(full))
      }
    }
  }
  zip.writeZip(zipPath)
}

/**
 * 造一个「条目名带 ..」的 zip。adm-zip 的 addFile 会先把名字规范化掉，
 * 所以这里写好一个等长占位名，再把 zip 里两处（本地头 + 中央目录）的字节替换成真的 .. ——
 * 等于模拟一个手工构造的恶意压缩包。
 */
async function plantTraversalEntry(zipPath: string, placeholder: string, evil: string): Promise<void> {
  const from = Buffer.from(placeholder, 'utf8')
  const to = Buffer.from(evil, 'utf8')
  if (from.length !== to.length) throw new Error('占位名与恶意名必须等长，才能原地替换')
  const patched = await readFile(zipPath)
  let hits = 0
  for (let offset = patched.indexOf(from); offset !== -1; offset = patched.indexOf(from, offset + to.length)) {
    to.copy(patched, offset)
    hits += 1
  }
  if (hits === 0) throw new Error('zip 里没找到占位条目名')
  await writeFile(zipPath, patched)
}

interface TestEnv {
  root: string
  packsRoot: string
  registryPath: string
  /** 解压临时目录的根：用它断言「一个解压目录都没留下」。 */
  tempRoot: string
  settings: AppSettings
}

async function makeEnv(): Promise<TestEnv> {
  const root = await temporaryRoot('dsh-pack-offline-zip-')
  const packsRoot = path.join(root, 'dsh-packs')
  const installRoot = path.join(root, 'dsh-runtime')
  const tempRoot = path.join(root, 'zip-temp')
  await mkdir(packsRoot, { recursive: true })
  await mkdir(tempRoot, { recursive: true })
  await makeKernel(installRoot)
  const settings: AppSettings = {
    ...defaultSettings({ homeDirectory: root, documentsDirectory: root }),
    packsRoot,
    dshInstallPath: installRoot,
  }
  return { root, packsRoot, registryPath: path.join(root, 'packs.json'), tempRoot, settings }
}

function makeImporter(env: TestEnv, stages: string[] = []) {
  return createOfflinePackImport({
    readSettings: async () => env.settings,
    registryPath: env.registryPath,
    emitProgress: progress => { stages.push(progress.stage) },
    log: () => undefined,
    tempRoot: env.tempRoot,
  })
}

/** 临时目录里残留的解压目录（正常结束后必须是空的）。 */
async function leftoverZipDirs(tempRoot: string): Promise<string[]> {
  const entries = await readdir(tempRoot).catch(() => [] as string[])
  return entries.filter(name => name.startsWith(ZIP_TEMP_PREFIX))
}

describe('离线整合包导入：.zip', () => {
  it('顶层一个包文件夹：解包后按原流水线装配，装完清掉临时目录', async () => {
    const env = await makeEnv()
    const packDir = await makePackDirectory(env.root)
    const zipPath = path.join(env.root, PACK_FOLDER + '.zip')
    await zipPack(packDir, zipPath, PACK_FOLDER)
    const stages: string[] = []

    const outcome = await makeImporter(env, stages).start({ packDir: zipPath, name: '压缩包测试' })

    expect(outcome).toEqual({ ok: true, packId: 'pack-' + PACK_FOLDER, packName: '压缩包测试' })
    const home = path.join(env.packsRoot, 'pack-' + PACK_FOLDER)
    // 和「选文件夹」完全同构：实例目录、插件 junction、附件目录、导入报告。
    const profileDir = path.join(home, 'profiles', 'pack-' + PACK_FOLDER)
    expect((await stat(path.join(profileDir, 'package.json'))).isFile()).toBe(true)
    expect((await stat(path.join(home, 'extras'))).isDirectory()).toBe(true)
    expect((await stat(path.join(profileDir, 'node_modules', 'dsh-test-plugin'))).isDirectory()).toBe(true)
    // 内核树是只读共享的 junction，不是拷贝（stat 会跟进去，所以这里用 lstat）。
    expect((await lstat(path.join(home, 'profiles', 'node_modules'))).isSymbolicLink()).toBe(true)
    const report = JSON.parse(await readFile(path.join(profileDir, 'import-report.json'), 'utf8')) as { counts: { plugins: number } }
    expect(report.counts.plugins).toBe(1)
    expect(stages).toContain('done')

    const records = await readPackRegistry(env.registryPath)
    expect(records.map(record => record.id)).toEqual(['pack-' + PACK_FOLDER])
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('界面给了文件夹名：按它落盘，不跟着压缩包里的目录名', async () => {
    const env = await makeEnv()
    const packDir = await makePackDirectory(env.root)
    const zipPath = path.join(env.root, PACK_FOLDER + '.zip')
    await zipPack(packDir, zipPath, PACK_FOLDER)

    // 界面上「文件夹名」那格可编辑：传了就以它为准（PackImportRequest.folderName）
    const outcome = await makeImporter(env).start({ packDir: zipPath, name: '改过文件夹名', folderName: 'renamed-pack' })

    expect(outcome).toEqual({ ok: true, packId: 'pack-renamed-pack', packName: '改过文件夹名' })
    const home = path.join(env.packsRoot, 'pack-renamed-pack')
    // 实例落在用户给的文件夹名下（profile 目录同名），压缩包自带的顶层目录名不再决定落盘位置
    expect((await stat(path.join(home, 'profiles', 'pack-renamed-pack', 'package.json'))).isFile()).toBe(true)
    await expect(stat(path.join(env.packsRoot, 'pack-' + PACK_FOLDER))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readPackRegistry(env.registryPath)).map(record => record.id)).toEqual(['pack-renamed-pack'])
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('界面给的文件夹名不合法：主进程按同一口径拒绝，不写家目录', async () => {
    const env = await makeEnv()
    const packDir = await makePackDirectory(env.root)
    const zipPath = path.join(env.root, PACK_FOLDER + '.zip')
    await zipPack(packDir, zipPath, PACK_FOLDER)

    // 渲染层先挡过一次，但主进程不信任它：路径分隔符不许悄悄变成 -
    const outcome = await makeImporter(env).start({ packDir: zipPath, name: '非法名', folderName: 'a/b' })

    expect(outcome).toEqual({ ok: false, reason: '文件夹名只能用字母、数字、点、横线或下划线，并且以字母或数字开头。' })
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('manifest 在压缩包根部：包名退回压缩包文件名，照样能装', async () => {
    const env = await makeEnv()
    const packDir = await makePackDirectory(env.root)
    const zipPath = path.join(env.root, 'root-layout.zip')
    await zipPack(packDir, zipPath, null)

    const outcome = await makeImporter(env).start({ packDir: zipPath, name: '根部清单' })

    expect(outcome).toEqual({ ok: true, packId: 'pack-root-layout', packName: '根部清单' })
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('缺 manifest：报明确原因，一个实例都不建，临时目录已清', async () => {
    const env = await makeEnv()
    const zipPath = path.join(env.root, 'no-manifest.zip')
    const source = path.join(env.root, 'no-manifest-src', PACK_FOLDER)
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'readme.txt'), 'not a pack\n', 'utf8')
    await zipPack(source, zipPath, PACK_FOLDER)

    const outcome = await makeImporter(env).start({ packDir: zipPath, name: '缺清单' })

    expect(outcome).toEqual({ ok: false, reason: '这个压缩包里没有 manifest.json，可能不是整合包。' })
    expect(await readdir(env.packsRoot)).toEqual([])
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('条目里带 ../：拒绝解压，包外不落盘，临时目录已清', async () => {
    const env = await makeEnv()
    const packDir = await makePackDirectory(env.root)
    const zipPath = path.join(env.root, 'zip-slip.zip')
    await zipPack(packDir, zipPath, PACK_FOLDER)
    const zip = new AdmZip(zipPath)
    zip.addFile('ab/evil.txt', Buffer.from('evil\n'))
    zip.writeZip(zipPath)
    // 'ab/evil.txt' 与 '../evil.txt' 等长，替换后条目名叫 ../evil.txt（指向压缩包上一级）。
    await plantTraversalEntry(zipPath, 'ab/evil.txt', '../evil.txt')

    const outcome = await makeImporter(env).start({ packDir: zipPath, name: '路径穿越' })

    expect(outcome).toEqual({ ok: false, reason: '这个压缩包里有不安全的路径，不能导入。' })
    // 解压根目录的上上一级（= 本测试的 root）不许出现 evil.txt。
    await expect(stat(path.join(env.root, 'evil.txt'))).rejects.toThrow()
    expect(await readdir(env.packsRoot)).toEqual([])
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('顶层多个整合包目录：判不出装哪个就报错', async () => {
    const env = await makeEnv()
    const zipPath = path.join(env.root, 'two-packs.zip')
    const zip = new AdmZip()
    zip.addFile('pack-a/manifest.json', Buffer.from('{}', 'utf8'))
    zip.addFile('pack-b/manifest.json', Buffer.from('{}', 'utf8'))
    zip.writeZip(zipPath)

    const outcome = await makeImporter(env).start({ packDir: zipPath, name: '两个包' })

    expect(outcome).toEqual({ ok: false, reason: '压缩包顶层有多个整合包，没法判断要装哪一个。' })
    expect(await leftoverZipDirs(env.tempRoot)).toEqual([])
  })

  it('条目名规则：绝对路径与 .. 一律拒绝，普通相对路径放行', () => {
    expect(unsafeZipEntry('../evil.txt')).toBe('上级目录')
    expect(unsafeZipEntry('pack/../../evil.txt')).toBe('上级目录')
    expect(unsafeZipEntry('pack\\..\\evil.txt')).toBe('上级目录')
    expect(unsafeZipEntry('/etc/passwd')).toBe('绝对路径')
    expect(unsafeZipEntry('C:\\Windows\\evil.dll')).toBe('绝对路径')
    expect(unsafeZipEntry('pack/vendor/a.tgz')).toBeNull()
    expect(unsafeZipEntry('pack/extras/notes/../notes/a.txt')).toBe('上级目录')
  })
})
