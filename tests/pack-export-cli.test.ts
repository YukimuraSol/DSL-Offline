/**
 * `--export-pack`：启动器自己（不是 scripts/）用装配引擎导出离线包的命令。
 *
 * 只测核心函数 runExportPack —— 不起真实启动器。钉死四件事：
 *   1. 缺省输出目录与 ipc.ts 的导出目录同一算法（<packsRoot 的父目录>\dsh-exports）；
 *   2. zip 顶层是一个同名文件夹，解压即得可用包目录（manifest.json + vendor/ + extras/）；
 *   3. stdout 最后一行那份 JSON 摘要字段齐全、数字与包里的实物对得上；
 *   4. 失败（实例不存在 / 没有活跃插件）退出码 1，且不在 dsh-exports 留半个包、不留临时目录。
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { parseExportPackArgs, runExportPack, summaryLine } from '../electron/pack-export-cli'

const PACK_ID = 'demo-pack'
const PLUGIN_NAMES = ['plugin-one', 'plugin-two']
const ATTACHMENT_TEXT = 'hello attachment\n'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-export-pack-cli-'))
  temporaryDirectories.push(root)
  return root
}

interface Fixture {
  root: string
  /** settings.packsRoot 的位置：实例 = <packsRoot>\<packId>。 */
  packsRoot: string
  home: string
  profileDir: string
  /** 临时包落点，用来断言「跑完不留临时目录」。 */
  stagingRoot: string
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function makeJunction(target: string, linkPath: string): Promise<void> {
  await mkdir(path.dirname(linkPath), { recursive: true })
  await symlink(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 假实例：<packsRoot>/<id>/profiles/<id>，两个插件各自一个 body + junction 门控，外加附件。 */
async function buildFixture(options: { plugins?: boolean } = {}): Promise<Fixture> {
  const root = await temporaryRoot()
  const packsRoot = path.join(root, 'packs')
  const home = path.join(packsRoot, PACK_ID)
  const profileDir = path.join(home, 'profiles', PACK_ID)
  const bodiesDir = path.join(profileDir, '.dsh-launcher-plugin-bodies')
  const nodeModulesDir = path.join(profileDir, 'node_modules')

  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'profile.yaml'), `name: ${PACK_ID}\ndshVersion: 0.2.1-rc.2\n`, 'utf8')
  await writeJson(path.join(profileDir, 'package.json'), { name: PACK_ID, dependencies: {} })

  if (options.plugins !== false) {
    for (const name of PLUGIN_NAMES) {
      await writeJson(path.join(bodiesDir, name, 'package.json'), {
        name,
        version: '1.0.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { client: { platform: 'web' } },
      })
      await mkdir(path.join(bodiesDir, name, 'lib'), { recursive: true })
      await writeFile(path.join(bodiesDir, name, 'lib', 'index.js'), `export default '${name}'\n`, 'utf8')
      await makeJunction(path.join(bodiesDir, name), path.join(nodeModulesDir, name))
    }
  } else {
    await mkdir(nodeModulesDir, { recursive: true })
  }

  // 附件 = <家目录>/extras：原样整目录复制。
  await mkdir(path.join(home, 'extras', 'docs'), { recursive: true })
  await writeFile(path.join(home, 'extras', 'docs', 'readme.txt'), ATTACHMENT_TEXT, 'utf8')

  return { root, packsRoot, home, profileDir, stagingRoot: path.join(root, 'staging') }
}

function request(fixture: Fixture, packId = PACK_ID) {
  return { packId, packsRoot: fixture.packsRoot, fallbackOutputRoot: path.join(fixture.root, 'userdata'), stagingRoot: fixture.stagingRoot }
}

/**
 * 复刻 main.ts 的 --export-pack 分派（electron/main.ts:1415-1434）：
 * 参数不合法就打 message + usage、退出 2，**不调 runExportPack**；合法才带着 outputDir 往下走。
 * 参数容错那几条要断言「退出码 + 报错文案 + 文件系统没被动过」，走一遍分派才断言得到。
 */
async function dispatchLikeMain(argv: string[], fixture: Fixture): Promise<{ exitCode: number; error: string | null }> {
  const parsed = parseExportPackArgs(argv)
  if (!parsed.ok) return { exitCode: 2, error: parsed.message }
  const result = await runExportPack({
    ...request(fixture),
    ...(parsed.outputDir ? { outputDir: parsed.outputDir } : {}),
  })
  return { exitCode: result.exitCode, error: result.error }
}

describe('--export-pack：导出 → 校验 → 压 zip', () => {
  it('缺省落在 packsRoot 旁边的 dsh-exports，zip 顶层是一个同名文件夹', async () => {
    const fixture = await buildFixture()
    const result = await runExportPack(request(fixture))

    expect(result.exitCode).toBe(0)
    expect(result.error).toBeNull()

    const zipPath = path.join(fixture.root, 'dsh-exports', PACK_ID + '.zip')
    expect(result.summary?.zip).toBe(zipPath)
    await expect(lstat(zipPath)).resolves.toBeTruthy()

    const archive = new AdmZip(zipPath)
    const entries = archive.getEntries().map(entry => entry.entryName)
    // 解压后的顶层**只有一个**文件夹：条目一律以 <packId>/ 开头。
    expect(new Set(entries.map(name => name.split('/')[0]))).toEqual(new Set([PACK_ID]))
    expect(entries).toContain(`${PACK_ID}/manifest.json`)
    expect(entries).toContain(`${PACK_ID}/vendor/`)
    expect(entries).toContain(`${PACK_ID}/extras/`)

    // 真的能解出来用：manifest 能读、tgz 数量与插件数一致、附件还在。
    const extracted = path.join(fixture.root, 'extracted')
    archive.extractAllTo(extracted, true)
    const packDir = path.join(extracted, PACK_ID)
    const manifest = JSON.parse(await readFile(path.join(packDir, 'manifest.json'), 'utf8')) as { plugins: Array<{ name: string }> }
    expect(manifest.plugins.map(plugin => plugin.name).sort()).toEqual([...PLUGIN_NAMES].sort())

    const vendor = (await readdir(path.join(packDir, 'vendor'))).sort()
    expect(vendor).toEqual(['plugin-one-1.0.0.tgz', 'plugin-two-1.0.0.tgz'])
    expect(vendor).toHaveLength(manifest.plugins.length)
    expect(await readFile(path.join(packDir, 'extras', 'docs', 'readme.txt'), 'utf8')).toBe(ATTACHMENT_TEXT)

    // 中间目录建在临时根里，跑完必须删干净：只留 zip。
    expect(await readdir(fixture.stagingRoot)).toEqual([])
  })

  it('JSON 摘要字段齐全，数字与 zip 里的实物对得上', async () => {
    const fixture = await buildFixture()
    const result = await runExportPack(request(fixture))
    expect(result.summary).not.toBeNull()

    const summary = JSON.parse(summaryLine(result.summary!)) as {
      zip: string
      plugins: number
      vendorFiles: number
      vendorBytes: number
      extras: { files: number; bytes: number; dirs: number }
    }
    // 字段就是命令契约里那五个，不多不少（agent 按名取）。
    expect(Object.keys(summary).sort()).toEqual(['extras', 'plugins', 'vendorBytes', 'vendorFiles', 'zip'])
    expect(Object.keys(summary.extras).sort()).toEqual(['bytes', 'dirs', 'files'])

    expect(summary.zip).toBe(path.join(fixture.root, 'dsh-exports', PACK_ID + '.zip'))
    expect(summary.plugins).toBe(PLUGIN_NAMES.length)
    expect(summary.vendorFiles).toBe(PLUGIN_NAMES.length)
    expect(summary.extras).toEqual({ files: 1, bytes: Buffer.byteLength(ATTACHMENT_TEXT), dirs: 1 })

    // vendorBytes 与 zip 里 tgz 的真实字节数一致（不是随手抄的估计值）。
    const archive = new AdmZip(summary.zip)
    const tgzBytes = archive.getEntries()
      .filter(entry => /^[^/]+\/vendor\/.+\.tgz$/.test(entry.entryName))
      .reduce((total, entry) => total + entry.header.size, 0)
    expect(summary.vendorBytes).toBe(tgzBytes)
    expect(summary.vendorBytes).toBeGreaterThan(0)
  })

  it('packId 不存在：退出码 1，且不留下 zip', async () => {
    const fixture = await buildFixture()
    const result = await runExportPack(request(fixture, 'no-such-pack'))

    expect(result.exitCode).toBe(1)
    expect(result.summary).toBeNull()
    expect(result.error).toContain('找不到整合包实例')
    await expect(lstat(path.join(fixture.root, 'dsh-exports', 'no-such-pack.zip'))).rejects.toThrow()
    // 连临时目录都不该建出来（没走到导出那一步）。
    await expect(lstat(fixture.stagingRoot)).rejects.toThrow()
  })

  it('实例一个活跃插件都没有：退出码 1，临时目录与 zip 都不留', async () => {
    const fixture = await buildFixture({ plugins: false })
    const result = await runExportPack(request(fixture))

    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('没有找到任何活跃插件')
    await expect(lstat(path.join(fixture.root, 'dsh-exports', PACK_ID + '.zip'))).rejects.toThrow()
    expect(await readdir(fixture.stagingRoot)).toEqual([])
  })
})

describe('--export-pack 参数容错', () => {
  it('带路径分隔符或非法字符的 id 直接拒绝', () => {
    expect(parseExportPackArgs(['..\\evil']).ok).toBe(false)
    expect(parseExportPackArgs(['a/b']).ok).toBe(false)
    expect(parseExportPackArgs(['a b']).ok).toBe(false)
    expect(parseExportPackArgs([]).ok).toBe(false)
    expect(parseExportPackArgs([PACK_ID, 'out', 'extra']).ok).toBe(false)
    expect(parseExportPackArgs(['--json']).ok).toBe(false)
  })

  it('输出目录可选；不给就是 undefined（走缺省算法）', () => {
    expect(parseExportPackArgs([PACK_ID])).toEqual({ ok: true, packId: PACK_ID })
    expect(parseExportPackArgs([PACK_ID, 'D:\\out'])).toEqual({ ok: true, packId: PACK_ID, outputDir: 'D:\\out' })
  })

  // 这两条是行为性缺陷的回归：原实现 parseExportPackArgs 第一步就 filter 掉以 - 开头的参数，
  // 并且把 ''/纯空白当成「给错了」而不是「没给」。复原时漏了，缺陷就回来了。
  it('--json 当第二个参数：退出 2、报不认识的参数，且当前目录不会长出 --json 文件夹', async () => {
    const fixture = await buildFixture()
    // 「当前目录」指到空临时目录：path.resolve('--json') 会落在那儿，不在仓库根里留垃圾。
    const sandbox = await temporaryRoot()
    const restore = process.cwd()
    process.chdir(sandbox)
    try {
      const result = await dispatchLikeMain([PACK_ID, '--json'], fixture)

      expect(result.exitCode).toBe(2)
      expect(result.error).toBe('不认识的参数：--json')

      // 真的查文件系统：缺陷版会在这里建出 --json/ 并往里面写 zip。
      const wouldBeOutputDir = path.resolve('--json')
      expect(wouldBeOutputDir.startsWith(sandbox)).toBe(true)
      await expect(lstat(wouldBeOutputDir)).rejects.toThrow()
      expect(await readdir(sandbox)).toEqual([])
      // 缺省目录也不许被顺手写出来（压根没走到导出）。
      await expect(lstat(path.join(fixture.root, 'dsh-exports', PACK_ID + '.zip'))).rejects.toThrow()
    } finally {
      process.chdir(restore)
    }
  })

  it('输出目录给空字符串：退出 2、报输出目录为空，不静默回落缺省目录', async () => {
    const fixture = await buildFixture()
    const result = await dispatchLikeMain([PACK_ID, ''], fixture)

    expect(result.exitCode).toBe(2)
    expect(result.error).toBe('输出目录给的是空字符串。')
    // 纯空白同样算「给错了」（原文 !rawOutputDir.trim()）。
    expect(parseExportPackArgs([PACK_ID, '   '])).toEqual({ ok: false, message: '输出目录给的是空字符串。' })
    // 没导出：缺省 dsh-exports 下不该冒出 zip。
    await expect(lstat(path.join(fixture.root, 'dsh-exports', PACK_ID + '.zip'))).rejects.toThrow()
  })
})
