/**
 * `--export-pack <packId> [输出目录]`：用启动器自己的装配引擎导出一个离线整合包。
 *
 * 为什么要有这条命令：装配引擎（pack-offline-export.ts 的 exportOfflinePack / verifyOfflinePack）
 * 以前只有 scripts/export-offline-pack.mts 一个调用方，而 scripts/ **不进安装包** —— 装上启动器
 * 的机器上根本没有新架构导出的入口，用户只能手动搓包。这条命令把同一份实现接到启动器自己身上。
 *
 * 流程：注册表定位实例 → 导出到 os.tmpdir() 的临时目录 → 包级校验 → 压成
 * `<输出目录>\<packId>.zip`（zip 内顶层是 <packId>/，解压即得可用包目录）→ 删临时目录。
 * 导出 / 校验任一失败都不往输出目录写 zip，临时目录由 finally 收掉。
 *
 * 纯 Node，不依赖 Electron（packsRoot / 兜底目录 / 注册表路径都由调用方注入），vitest 直接跑。
 */

import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileName } from './instances'
import { exportOfflinePack, packExportDirFor } from './pack-offline-export'
import { readPackRegistry } from './pack-registry'
import { isSafeProfileName } from './profile'

/**
 * 一次 --export-pack 的入参。全部由调用方注入（纯 Node，不依赖 Electron）。
 */
export interface ExportPackRequest {
  /** 要导出的整合包 id：注册表记录 id，也是家目录名。 */
  packId: string
  /** 整合包目录根（dsh-packs）。 */
  packsRoot: string
  /** 输出目录的兜底锚点（通常是 userData）：packsRoot 不是绝对路径时用它。 */
  fallbackOutputRoot: string
  /** 直接指定输出目录；不给就按 packsRoot 推 dsh-exports。 */
  outputDir?: string
  /** 中间目录的父目录（默认 os.tmpdir()）：导出中途失败不在 dsh-exports 里留半个包。 */
  stagingRoot?: string
  /** 注册表路径：给了就优先按记录里的 homePath 找实例（老数据家目录可能不在 packsRoot 下）。 */
  registryPath?: string
  /** 覆盖探测出来的内核版本。 */
  dshVersion?: string
  /** 覆盖平台串。 */
  platform?: string
  onProgress?: (event: { stage: string; message: string }) => void
}

/** `--export-pack` 的用法自述：与 --verify / --export 同一套（pack-verify.ts 里各有一份）。 */
export const EXPORT_PACK_USAGE = [
  '用法：<启动器> --export-pack <整合包 id> [输出目录]',
  '  整合包 id  → 启动器里已安装整合包的那一行的 id',
  '  输出目录   → 缺省 <dsh-packs 的父目录>\\dsh-exports（不存在会自动建）',
  '产物：<输出目录>\\<整合包 id>.zip，解压即得包目录（manifest.json + vendor\\ + extras\\）',
  'stdout 最后一行是 JSON 摘要：{"zip","plugins","vendorFiles","vendorBytes","extras":{"files","bytes","dirs"}}',
  '退出码：0 成功 / 1 导出失败 / 2 参数错或包级校验没过',
].join('\n')

/**
 * 最后一行的 JSON 摘要（stdout 契约）：字段就这五个，agent 按名取，不许加。
 * 内核体积不进摘要——CLI 摘要的键被测试逐个钉死，内核信息走进度行与 warnings。
 */
export interface ExportPackSummary {
  zip: string
  plugins: number
  vendorFiles: number
  vendorBytes: number
  extras: {
    files: number
    bytes: number
    dirs: number
  }
}

/** 摘要压成一行 JSON（stdout 只留这一行给调用方解析）。 */
export function summaryLine(summary: ExportPackSummary): string {
  return JSON.stringify(summary)
}

/**
 * 解析 --export-pack 后面的参数：<packId> [输出目录]，多一个都不行。
 * 只做形状与安全字符校验，实例在不在由 runExportPack 自己判。
 */
export function parseExportPackArgs(argv: string[]): { ok: true; packId: string; outputDir?: string } | { ok: false; message: string } {
  // 第一步不收任何以 - 开头的参数：argv 从 --export-pack 后面切出来，这里只剩它自己的两个位置参数。
  // 少了这道闸，`--export-pack <id> --json` 会把 --json 当成输出目录，path.resolve 之后在 cwd 里
  // 建出一个叫 --json 的文件夹并正常导出、退出 0 —— --json 恰好是 --verify 的习惯写法，真会踩。
  const unknown = argv.filter(item => item.startsWith('-'))
  if (unknown.length > 0) return { ok: false, message: `不认识的参数：${unknown.join(' ')}` }
  if (argv.length === 0) return { ok: false, message: '缺一个整合包 id。' }
  if (argv.length > 2) return { ok: false, message: `只接受两个参数（整合包 id 和输出目录），多给了：${argv.slice(2).join(' ')}` }
  const [rawPackId, rawOutputDir] = argv
  const packId = rawPackId.trim()
  if (!isSafeProfileName(packId)) {
    return { ok: false, message: `整合包 id 只能包含字母、数字、点、横线或下划线（不能用路径分隔符）：${JSON.stringify(rawPackId)}` }
  }
  // 空字符串 / 纯空白是「给错了」，不是「没给」：原文在这里拒绝，不许静默回落缺省 dsh-exports。
  if (rawOutputDir !== undefined && !rawOutputDir.trim()) return { ok: false, message: '输出目录给的是空字符串。' }
  // 与原实现的一处有意差异：原文直接返回未处理的 rawOutputDir，这里 trim 后再给。
  // 纯空白上面已经拒掉了，trim 只是顺手去掉首尾空格（path.resolve 会把空格当路径的一部分）。
  const outputDir = (rawOutputDir ?? '').trim()
  return outputDir ? { ok: true, packId, outputDir } : { ok: true, packId }
}

export interface ExportPackResult {
  /** 0 成功 / 1 导出失败（实例不存在、没有活跃插件、打包出错）/ 2 参数错或包级校验没过。 */
  exitCode: 0 | 1 | 2
  summary: ExportPackSummary | null
  error: string | null
  warnings: string[]
}

function failure(exitCode: 1 | 2, error: string, warnings: string[] = []): ExportPackResult {
  return { exitCode, summary: null, error, warnings }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 实例家目录：注册表里那条记录的 homePath 优先，否则 `<packsRoot>\<packId>`
 * —— 与 pack.ts 建包时的布局一致，不另拼一套死路径。
 */
async function packHomeFor(packId: string, request: ExportPackRequest): Promise<string> {
  if (request.registryPath) {
    const record = (await readPackRegistry(request.registryPath)).find(item => item.id === packId)
    if (record?.homePath) return path.resolve(record.homePath)
  }
  return path.resolve(request.packsRoot, packId)
}

/**
 * 把临时包目录压成 zip：顶层是**一个**同名文件夹，解压即得可用包目录。
 * 目录条目逐个写进去 —— adm-zip 的 addLocalFolder 只收文件，空的 extras/ 会消失，
 * 而 extras/ 是「三件」之一（可以空，但必须在）。
 */
async function zipPackDirectory(packDir: string, zipRoot: string, zipPath: string): Promise<void> {
  const zip = new AdmZip()
  const stack: Array<{ dir: string; entry: string }> = [{ dir: packDir, entry: zipRoot }]
  while (stack.length > 0) {
    const current = stack.pop() as { dir: string; entry: string }
    zip.addFile(current.entry + '/', Buffer.alloc(0))
    for (const child of await readdir(current.dir, { withFileTypes: true })) {
      const full = path.join(current.dir, child.name)
      if (child.isDirectory()) stack.push({ dir: full, entry: current.entry + '/' + child.name })
      else if (child.isFile()) zip.addLocalFile(full, current.entry)
    }
  }
  try {
    zip.writeZip(zipPath)
  } catch (error) {
    // 写了一半的 zip 不许留在 dsh-exports 里。
    await rm(zipPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * `--export-pack` 的全部逻辑（CLI 分派只负责解析 argv 与 process.exit，方便直接单测）。
 * 返回退出码与摘要；过程信息走 onProgress，不在这里写 stdout。
 */
export async function runExportPack(request: ExportPackRequest): Promise<ExportPackResult> {
  const packId = request.packId.trim()
  if (!isSafeProfileName(packId)) return failure(2, `整合包 id 不合法：${JSON.stringify(request.packId)}`)

  let home: string
  try {
    home = await packHomeFor(packId, request)
  } catch (error) {
    return failure(1, `读整合包注册表失败：${errorText(error)}`)
  }
  // profile 目录名与启动器启动实例时用的是同一个判定（同名优先，其次老包的 web）。
  const profileDir = path.join(home, 'profiles', resolveProfileName(home, packId))
  if (!existsSync(profileDir)) {
    return failure(1, `找不到整合包实例「${packId}」：${profileDir} 不存在（当前整合包目录是 ${request.packsRoot}）`)
  }

  const outputDir = request.outputDir ? path.resolve(request.outputDir) : packExportDirFor(request.packsRoot, request.fallbackOutputRoot)
  const zipPath = path.join(outputDir, packId + '.zip')
  const stagingRoot = request.stagingRoot ?? os.tmpdir()
  let stagingDir: string | null = null
  try {
    await mkdir(outputDir, { recursive: true })
    await mkdir(stagingRoot, { recursive: true })
    // 中间目录建在系统临时目录下：导出中途失败也不会在 dsh-exports 里留半个包。
    stagingDir = await mkdtemp(path.join(stagingRoot, 'dsh-pack-export-'))
    const exported = await exportOfflinePack({
      profileDir,
      outputDir: stagingDir,
      ...(request.dshVersion ? { dshVersion: request.dshVersion } : {}),
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    })
    // exportOfflinePack 在写完 manifest 之后自己跑了一遍 verifyOfflinePack，结论就在 check 里：
    // 同一个函数、同一个目录、同一时刻，不再重复扫一遍 tgz。
    const check = exported.check
    if (!check.ok) return failure(2, '包级校验没过：' + check.blocking.join('；'), check.warnings)

    request.onProgress?.({ stage: 'zip', message: '压成 ' + zipPath })
    await zipPackDirectory(stagingDir, packId, zipPath)
    return {
      exitCode: 0,
      summary: {
        zip: zipPath,
        plugins: check.stats.plugins,
        vendorFiles: check.stats.tgzFiles,
        vendorBytes: check.stats.vendorBytes,
        extras: {
          files: check.stats.extrasFiles,
          bytes: check.stats.extrasBytes,
          dirs: exported.report.extras.directoryCount,
        },
      },
      error: null,
      warnings: check.warnings,
    }
  } catch (error) {
    return failure(1, '导出失败：' + errorText(error))
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
