/**
 * 离线整合包 .zip：解到系统临时目录 → 定位包目录 → 交给现有离线导入流程。
 *
 * 这里只做「解压 + 定位」，一行装配逻辑都不重复：解出来的目录与用户手动解压得到的文件夹
 * 完全同构，electron/pack-offline-import.ts 因此不需要知道输入曾经是一个压缩包。
 *
 * 四条硬约束：
 *   1) 条目名**先校验再落盘**：绝对路径 / 盘符 / UNC / 任何 `..` 段一律拒绝（zip-slip）；
 *      落盘前再按 resolve 后的路径复核一次，双保险。
 *   2) 包目录必须能被唯一确定：根上有 manifest.json 就是根；否则只认带 manifest.json 的
 *      那**一个**顶层文件夹，一个都没有或多于一个都报错——宁可让人重新打包，也不猜。
 *   3) 临时目录用完即删，失败路径同样删（本模块自己兜底，调用方另有 finally）。
 *   4) 全程离线：不 spawn 进程、不发网络请求。
 */
import AdmZip from 'adm-zip'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OFFLINE_MANIFEST_FILENAME } from './pack-offline-export'

/** 临时解压目录前缀：测试按它清场，日志里也一眼认得出是谁留下的。 */
export const ZIP_TEMP_PREFIX = 'dsh-pack-zip-'
/**
 * 解压体积上限。真实整合包 250MB 上下、最大的内核 tgz 一百多 MB，16GB 足够宽松；
 * 它的唯一职责是挡住 zip bomb 把磁盘写满。
 */
export const MAX_EXTRACTED_BYTES = 16 * 1024 * 1024 * 1024

export type OfflineZipErrorCode =
  /** 打不开 / 条目读不出来 / 解压体积超限。 */
  | 'zip-unreadable'
  /** 条目是绝对路径或带 ..（zip-slip）。 */
  | 'zip-unsafe-entry'
  /** 压缩包里找不到 manifest.json。 */
  | 'zip-manifest-missing'
  /** 顶层有多个带 manifest.json 的文件夹，判不出该装哪个。 */
  | 'zip-manifest-ambiguous'

/** 带错误码的解包失败：码表与 src/lib/pack-import.ts 的 BLOCKED_REASON 一一对应。 */
export class OfflineZipError extends Error {
  readonly code: OfflineZipErrorCode
  constructor(code: OfflineZipErrorCode, message: string) {
    super(message)
    this.name = 'OfflineZipError'
    this.code = code
  }
}

/**
 * 条目名不安全时返回原因（null = 安全）。
 * 反斜杠先归一成斜杠再判：Windows 打包工具写出来的条目常见 `dir\..\evil`。
 */
export function unsafeZipEntry(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return '绝对路径'
  if (normalized.split('/').includes('..')) return '上级目录'
  return null
}

async function hasManifest(dir: string): Promise<boolean> {
  return stat(path.join(dir, OFFLINE_MANIFEST_FILENAME)).then(info => info.isFile(), () => false)
}

/**
 * 在解压结果里定位包目录（含 manifest.json 的那一层）。
 * folderName 只在「manifest 就在根上」时为 null：这时包标识只能退回压缩包自己的文件名。
 */
export async function locateOfflinePackDir(root: string): Promise<{ packDir: string; folderName: string | null }> {
  if (await hasManifest(root)) return { packDir: root, folderName: null }
  const entries = await readdir(root, { withFileTypes: true })
  const candidates: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && await hasManifest(path.join(root, entry.name))) candidates.push(entry.name)
  }
  if (candidates.length === 0) {
    throw new OfflineZipError('zip-manifest-missing', `压缩包里没有 ${OFFLINE_MANIFEST_FILENAME}`)
  }
  if (candidates.length > 1) {
    throw new OfflineZipError('zip-manifest-ambiguous', '压缩包顶层有多个整合包目录：' + candidates.join('、'))
  }
  return { packDir: path.join(root, candidates[0]), folderName: candidates[0] }
}

export interface ExtractedOfflinePack {
  /** 解压出来的临时目录；packDir 要么是它本身，要么是它的一个子目录。 */
  workDir: string
  /** 交给 importOfflinePack 的包目录。 */
  packDir: string
  /** 包目录名；manifest 在压缩包根部时退回压缩包文件名（去掉 .zip）。 */
  folderName: string
  /** 删临时目录；幂等，失败只吞掉（清理不该掩盖真正的原因）。 */
  dispose(): Promise<void>
}

/**
 * 把 .zip 解到临时目录并定位出包目录。失败时临时目录已经删干净，异常原样抛出。
 * options.tempRoot 只给测试用（便于断言「一个文件都没留下」），生产走 os.tmpdir()。
 */
export async function extractOfflinePackZip(
  zipPath: string,
  options: { tempRoot?: string } = {},
): Promise<ExtractedOfflinePack> {
  const info = await stat(zipPath).catch(() => null)
  if (!info?.isFile()) throw new OfflineZipError('zip-unreadable', '整合包压缩包的路径不是一个文件')
  const workDir = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), ZIP_TEMP_PREFIX))
  const dispose = async (): Promise<void> => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
  try {
    let archive: AdmZip
    try {
      archive = new AdmZip(zipPath)
    } catch (error) {
      throw new OfflineZipError('zip-unreadable', '压缩包打不开：' + (error instanceof Error ? error.message : String(error)))
    }
    let extractedBytes = 0
    for (const entry of archive.getEntries()) {
      const unsafe = unsafeZipEntry(entry.entryName)
      if (unsafe) throw new OfflineZipError('zip-unsafe-entry', `压缩包条目用了${unsafe}：${entry.entryName}`)
      const relative = entry.entryName.replace(/\\/g, '/')
      const target = path.resolve(workDir, relative)
      // 规则已经挡过 .. 与绝对路径，这里再按真实落盘路径复核一次：规则将来放宽也不会漏。
      if (target !== workDir && !target.startsWith(workDir + path.sep)) {
        throw new OfflineZipError('zip-unsafe-entry', `压缩包条目越出临时目录：${entry.entryName}`)
      }
      // 目录条目（含 adm-zip 里以 / 结尾的零字节条目）只建目录：显式建出来，
      // 空的 extras/ 才不会在解包后消失（它是「三件」之一，预检会查）。
      if (entry.isDirectory || relative.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      let data: Buffer
      try {
        data = entry.getData()
      } catch (error) {
        throw new OfflineZipError('zip-unreadable', `压缩包条目读不出来：${entry.entryName}（${error instanceof Error ? error.message : String(error)}）`)
      }
      extractedBytes += data.byteLength
      if (extractedBytes > MAX_EXTRACTED_BYTES) throw new OfflineZipError('zip-unreadable', '解压后的体积超过安全上限')
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
    }
    const located = await locateOfflinePackDir(workDir)
    const folderName = located.folderName ?? path.basename(zipPath, path.extname(zipPath))
    return { workDir, packDir: located.packDir, folderName, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
