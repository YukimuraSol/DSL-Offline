/**
 * 「导入整合包」的主进程侧。
 *
 * 分层：真正干活的仍是 electron/pack-offline-import.ts（预检 / 骨架 / 装插件 / 附件 / 自验 / 报告），
 * 这里一行装配逻辑都不重复，只做界面做不到的四件事：
 *
 *   1) **给新实例准备内核树**。核心要求目标家目录里已经有 <home>/profiles/node_modules，
 *      而新包的家目录是空的；这里用 junction 指向本机一份同版本的内核（与装配工作台同一个手法），
 *      只读共享，删包时删的是自己那份家目录，别人的内核不动。
 *   2) **把阶段码推给界面**。核心的 message 里带着插件个数、installOrder、绝对路径，
 *      一律不许出这个文件：界面上只看到「检查整合包 / 准备实例 / 装配插件 / …」。
 *   3) **装完登记成整合包**（只写 packs.json），否则列表里看不到它。
 *   4) **失败/取消时只删本次自己新建的家目录**（里面是半成品，没有用户数据），别人的一个字节不碰。
 *
 * 全程离线：不 spawn 子进程、不发网络请求，所以没有窗口可弹。若将来真在这里加了子进程，
 * 必须带 windowsHide: true —— 任何情况下都不许弹黑框。
 *
 * 导入**永远新建实例**（界面不再提供「装配到某个现有实例」）：只写自己新建的家目录，
 * 从别人家目录里读到的内核树是只读共享的，所以在跑的实例不受影响，不需要先报「先停止」。
 *
 * 本文件故意不 import Electron：这样 vitest / 纯 Node 脚本可以直接驱动它（实测就是这么做）。
 * 弹目录框与 webContents.send 都在 electron/ipc.ts 里接。
 */

import { mkdir, readFile, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { blockedReason, failureReason, folderNameIssue, IMPORT_STAGE_TEXT, instanceNameIssue, packDirName } from '../src/lib/pack-import'
import type { AppSettings, PackImportOutcome, PackImportProgress, PackImportRequest, PackImportStage } from '../src/types'
import { adoptPackFromFolder } from './pack-adopt'
import { packProfileName } from './pack-manifest'
import { kernelIsComplete } from './kernel-seed'
import { integrityOf, readOfflineManifest, type OfflineManifest, type OfflineManifestKernel } from './pack-offline-export'
import { extractOfflinePackZip, MAX_EXTRACTED_BYTES, OfflineZipError, unsafeZipEntry, ZIP_TEMP_PREFIX } from './pack-offline-zip'
import { readTarGz } from './tar-archive'
import { importOfflinePack, OfflineImportBlockedError, type OfflineImportReport } from './pack-offline-import'
import { readPackRegistry, type PackRecord } from './pack-registry'
import { dshVersionRoot } from './runtime-versions'

/** 主进程里要交给它的一切（都是回调，方便测试直接喂）。 */
export interface OfflinePackImportDeps {
  /** 读 settings：要 packsRoot（新家目录落在它下面）与 dshInstallPath（找版本库里的内核）。 */
  readSettings: () => Promise<AppSettings>
  /** packs.json 的绝对路径：用来查现有实例，也用来登记新包。 */
  registryPath: string
  /** 阶段推给界面（ipc.ts 里接成 webContents.send(IPC_EVENTS.packOfflineProgress)）。 */
  emitProgress: (progress: PackImportProgress) => void
  /** 只进日志。给用户看的是返回值里的 reason，那里不带路径。 */
  log?: (message: string) => void
  /** 解压临时目录的根；只给测试用（便于断言一个文件都没留下），生产走 os.tmpdir()。 */
  tempRoot?: string
}

export interface OfflinePackImport {
  /** 开始装配。永不抛错：失败也是返回值。 */
  start(request: PackImportRequest): Promise<PackImportOutcome>
  /** 尽力取消：主进程在下一个阶段边界停下。 */
  cancel(): Promise<void>
}

/** 内部短路：带着一句已经翻好的人话退出，外层 catch 原样交回渲染层。 */
class ImportStop extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'ImportStop'
    this.reason = reason
  }
}

/** 本次要装配的包目录：可能是用户选的文件夹，也可能是压缩包解出来的临时目录。 */
interface PreparedPackFolder {
  packDir: string
  /** 包标识从它派生（压缩包取里面的顶层文件夹名，根上就是 manifest 时取压缩包文件名）。 */
  folderName: string
  dispose: () => Promise<void>
}

/**
 * 输入可以是「已解压的包目录」，也可以是 .zip。压缩包先解到临时目录，
 * 之后与文件夹走同一条流水线（预检 / 骨架 / 装插件 / 附件 / 自验 / 报告）。
 */
async function preparePackFolder(source: string, tempRoot?: string): Promise<PreparedPackFolder> {
  const info = await stat(source).catch(() => null)
  if (info?.isDirectory()) return { packDir: source, folderName: packDirName(source), dispose: async () => undefined }
  if (!info) throw new ImportStop('选中的整合包已经不在了，可能被移走或改名了。')
  if (!info.isFile() || !/\.zip$/i.test(source)) throw new ImportStop('只能选 .zip 压缩包，或者已经解压的整合包文件夹。')
  const extracted = await extractOfflinePackZip(source, { tempRoot })
  return { packDir: extracted.packDir, folderName: extracted.folderName, dispose: extracted.dispose }
}

/** 家目录里内核树自报的版本（<profiles/node_modules>/@deepseek-ai/dsh/package.json）。 */
async function kernelVersionOf(modulesDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(modulesDir, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version : null
  } catch {
    return null
  }
}


/**
 * 解随包内核时的 staging 目录名。落在**整合包根目录**下（与家目录同盘），
 * 复用 pack-offline-zip 的 ZIP_TEMP_PREFIX，残留一眼就能认出来，失败一律删掉。
 */
const KERNEL_STAGING_PREFIX = ZIP_TEMP_PREFIX + 'kernel-'

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/** 内核的启动外壳：kernelIsComplete 认的就是这一个文件（再配上 @deepseek-ai/dsh 的 package.json）。 */
function kernelShellName(): string {
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

/** 目标盘的可用字节；拿不到（古老的 fs / 权限怪）就返回 null，退回「写的时候撞 ENOSPC 再说」。 */
async function freeBytesOf(directory: string): Promise<number | null> {
  try {
    const stats = await statfs(directory)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

/**
 * 包自带内核（manifest.kernel）时的落地：把包里那份 tgz 解到**同盘** staging 目录并验成可用内核，
 * 返回 staging 路径，由调用方原子 rename 成 <家目录>/profiles/node_modules。
 *
 * 为什么要 staging + rename：解 6 万个文件要几十秒，中途断电/被关掉会留下半截目录，
 * 那半截一旦被判成「已安装」，启动器就再也不补了（kernel-seed 的注释里记过这个坑）。
 *
 * ponytail: 整份 tgz 读进内存再 gunzip（本机内核 tgz 约 200 MB / 解开约 714 MB，峰值约 1.6 GB）。
 * 上限：内核再大就要改成流式 gunzip + tar 逐条写。升级路径：别整块 Buffer，边解边写盘。
 */
async function unpackBundledKernel(options: {
  packDir: string
  record: OfflineManifestKernel
  /** staging 落在这里（导入时的整合包根目录）：与家目录同盘，rename 才是原子的。 */
  packsRoot: string
  /** 解包循环里的取消点：这么久不响应，用户会以为卡死了。 */
  isCancelled: () => boolean
  /** 真要开始解了才回调：本机已有完整内核时不该在界面上闪一下「解出内核」。 */
  onExtract?: () => void
  log: (message: string) => void
}): Promise<string> {
  const { packDir, record, packsRoot, log } = options

  const archivePath = path.join(packDir, ...record.tgz.split('/'))
  let archive: Buffer
  try {
    archive = await readFile(archivePath)
  } catch {
    throw new ImportStop('整合包登记了内核，但包里找不到那个内核文件。这个包不完整，重新拷一份再试。')
  }
  // 校验和与 vendor tgz 同一算法：包在拷贝/压缩中途坏掉，现在就该拦住，别写出一棵坏内核。
  if (archive.length !== record.bytes || integrityOf(archive) !== record.integrity) {
    throw new ImportStop('整合包里的内核文件损坏了（大小或校验和与清单不符），重新拷一份整包再试。')
  }

  await mkdir(packsRoot, { recursive: true })
  // 空间预检：整棵内核要真落盘，不够就现在说，不要写一半再炸。
  const needed = Math.ceil((record.extractedBytes ?? record.bytes) * 1.05) + 16 * 1024 * 1024
  const free = await freeBytesOf(packsRoot)
  if (free !== null && free < needed) {
    throw new ImportStop(`磁盘空间不够：解出内核要约 ${megabytes(needed)}，目标盘只剩 ${megabytes(free)}。腾出空间再导入。`)
  }

  const staging = path.join(packsRoot, KERNEL_STAGING_PREFIX + normalizeVersion(record.version) + '-' + Math.random().toString(36).slice(2))
  let written = 0
  try {
    options.onExtract?.()
    await mkdir(staging, { recursive: true })
    const entries = readTarGz(archive)
    let lastDirectory = ''
    for (const [index, entry] of entries.entries()) {
      // 每 512 个文件看一次取消：解 6 万个文件要几十秒，不能让人只能干等。
      if (index > 0 && index % 512 === 0 && options.isCancelled()) throw new ImportStop('你取消了这次导入。')
      // 归档来自别人给的包：绝对路径与 .. 一律拒绝，落盘前再按 resolve 后的路径复核一次。
      const unsafe = unsafeZipEntry(entry.path)
      if (unsafe) throw new Error(`内核归档里有${unsafe}条目：${entry.path}`)
      const destination = path.resolve(staging, entry.path)
      if (destination !== staging && !destination.startsWith(staging + path.sep)) {
        throw new Error('内核归档条目越出解包目录：' + entry.path)
      }
      if (entry.type === 'directory') {
        await mkdir(destination, { recursive: true })
        continue
      }
      const directory = path.dirname(destination)
      if (directory !== lastDirectory) {
        await mkdir(directory, { recursive: true })
        lastDirectory = directory
      }
      await writeFile(destination, entry.data)
      written += entry.data.length
      // 与解 zip 同一个上限：别人给的包不能把盘写满。
      if (written > MAX_EXTRACTED_BYTES) throw new Error('内核解开后超过 ' + Math.round(MAX_EXTRACTED_BYTES / 1024 / 1024 / 1024) + ' GB 上限')
    }
    // 解完必须真能当内核用（kernelIsComplete）：缺启动外壳或 @deepseek-ai/dsh 的包清单就如实报错，不假装装好了。
    if (!(await kernelIsComplete(staging))) {
      throw new ImportStop('整合包里的内核装不成可用内核：解出来缺 node_modules/.bin/' + kernelShellName()
        + ' 或 @deepseek-ai/dsh 的 package.json。这个包要重新导出。')
    }
    log(`[pack-import] 随包内核 ${record.version} 已解出（${megabytes(written)}），待搬进新实例：${staging}`)
    return staging
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof ImportStop) throw error
    // ENOSPC 的文案要具体：只说「装配中途停下来了」等于没帮上忙。
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSPC') {
      throw new ImportStop('磁盘空间不够，内核没解出来。腾出空间再导入。')
    }
    log(`[pack-import] 解随包内核失败（${record.tgz} → ${staging}）：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    throw new ImportStop('解出内核时出错了，包里的内核没法装到本机。具体原因记在日志里。')
  }
}

export function createOfflinePackImport(deps: OfflinePackImportDeps): OfflinePackImport {
  let running = false
  /** 取消是协作式的：核心没有中断信号，只能在下个阶段边界抛出去。 */
  let cancelRequested = false

  const log = (message: string): void => deps.log?.(message)

  /**
   * 找一份「版本对得上」的内核树给新家目录用。
   * 版本库优先（它本来就是给多个实例共用的），没有再退到已登记实例自己的那份——
   * 本机常见情形是版本库被清过、内核只长在各个实例的家目录里。
   */
  async function resolveKernelModules(settings: AppSettings, version: string, records: PackRecord[]): Promise<string | null> {
    const candidates: string[] = []
    if (settings.dshInstallPath) candidates.push(path.join(dshVersionRoot(settings.dshInstallPath, version), 'node_modules'))
    for (const record of records) {
      if (typeof record.homePath !== 'string' || !path.isAbsolute(record.homePath)) continue
      candidates.push(path.join(record.homePath, 'profiles', 'node_modules'))
    }
    for (const candidate of candidates) {
      if (await kernelVersionOf(candidate) === version) return candidate
    }
    return null
  }

  return {
    async start(request) {
      if (running) return { ok: false, reason: '已经有一个整合包在装配了，等它结束。' }
      // 入参仍叫 packDir（渲染层沿用原字段），但允许是文件夹或 .zip；两种都由 preparePackFolder 归一成目录。
      const source = typeof request?.packDir === 'string' ? request.packDir.trim() : ''
      if (!source || !path.isAbsolute(source)) return { ok: false, reason: '整合包的位置没有选对，重新选一次。' }
      running = true
      cancelRequested = false
      /** 本次新建的家目录；只有它允许被清理。 */
      let createdHome: string | null = null
      /** 包里内核解出来的 staging；还没搬进家目录之前，失败要连它一起删。 */
      let kernelStaging: string | null = null
      /** 阶段去重：核心的 install 阶段会连推几十条，界面只需要「变了」的那几条。 */
      let lastStage: PackImportStage | null = null
      const pushStage = (stage: string): void => {
        const normalized = (stage in IMPORT_STAGE_TEXT ? stage : 'install') as PackImportStage
        if (normalized === lastStage) return
        lastStage = normalized
        deps.emitProgress({ stage: normalized })
      }
      const discardCreatedHome = async (): Promise<void> => {
        if (!createdHome) return
        const home = createdHome
        createdHome = null
        await rm(home, { recursive: true, force: true }).catch(error => {
          log(`[pack-import] 清理半成品失败（${home}）：${error instanceof Error ? error.message : String(error)}`)
        })
      }

      let home: string | null = null
      /** 压缩包解出来的临时目录：成功、失败、取消都要删，所以在 finally 里收。 */
      let prepared: PreparedPackFolder | null = null
      try {
        prepared = await preparePackFolder(source, deps.tempRoot)
        const packDir = prepared.packDir
        const settings = await deps.readSettings()
        const records = await readPackRegistry(deps.registryPath)

        // 清单先读一次：内核要按它要求的版本去挑。读不了就按预检那套码给一句话。
        let manifest: OfflineManifest
        try {
          manifest = await readOfflineManifest(packDir)
        } catch (error) {
          throw new ImportStop(blockedReason((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'manifest-missing' : 'manifest-invalid'))
        }

        // 文件夹名 → 包标识（= 磁盘目录名 = Profile 名）。界面已经先挡过一次，这里是最终判定。
        // 标识取文件夹名而不是实例名：文件夹名是 ASCII 标识（用户可以在界面上改），实例名允许中文，
        // 拿中文名去派生标识只会得到 pack------。
        // 界面上那格「文件夹名」可编辑，传了就以它为准；没传（老调用方 / 直接选文件夹）才用解包查到的那一个。
        const requestedFolderName = typeof request?.folderName === 'string' ? request.folderName.trim() : ''
        const folderName = requestedFolderName || prepared.folderName
        if (!folderName) throw new ImportStop('整合包的文件夹名读不出来，换一个目录再试。')
        const folderIssue = folderNameIssue(folderName, records.map(item => item.id))
        if (folderIssue) throw new ImportStop(folderIssue)
        const packId = packProfileName(folderName)

        // 实例名只是列表里给人看的名字：默认跟着文件夹名，允许中文。
        const displayName = typeof request?.name === 'string' && request.name.trim() !== '' ? request.name.trim() : folderName
        const nameIssue = instanceNameIssue(displayName, records.map(item => item.name))
        if (nameIssue) throw new ImportStop(nameIssue)

        const packsRoot = (settings.packsRoot ?? '').trim()
        if (!packsRoot || !path.isAbsolute(packsRoot)) throw new ImportStop('还没有设置整合包目录，先去设置里指定一个。')

        // 内核从哪来：
        //   1) 本机已经有这个版本（版本库或别的实例家目录里）→ 照旧 junction 过去，省 700 MB 磁盘；
        //   2) 本机没有、包里自带（新包）→ 解到同盘 staging，一会儿整棵搬进新实例自己的
        //      profiles/node_modules，换台机器不用先装内核；
        //   3) 都没有 → 老包的老话术，让人先去装这个版本。
        let kernelModules = await resolveKernelModules(settings, manifest.dshVersion, records)
        if (!kernelModules) {
          if (!manifest.kernel) throw new ImportStop(`本机没有 DSH ${manifest.dshVersion}，先在启动页装好这个版本再导入。`)
          if (normalizeVersion(manifest.kernel.version) !== normalizeVersion(manifest.dshVersion)) {
            throw new ImportStop('整合包登记的内核版本和它要求的 DSH 版本对不上，这个包有问题，重新导出一次。')
          }
          kernelStaging = await unpackBundledKernel({
            packDir,
            record: manifest.kernel,
            packsRoot,
            isCancelled: () => cancelRequested,
            onExtract: () => pushStage('kernel'),
            log,
          })
        } else {
          log(`[pack-import] 用本机现成的内核 ${manifest.dshVersion}：${kernelModules}`)
        }

        home = path.join(packsRoot, packId)
        await mkdir(path.join(home, 'profiles'), { recursive: true })
        createdHome = home
        if (kernelStaging) {
          // 包里那份是一棵内核树（node_modules/…）：把内层整棵搬进来（同盘 rename，原子），
          // 这个实例从此自带内核，不再依赖本机版本库。
          const staging = kernelStaging
          kernelStaging = null
          const target = path.join(home, 'profiles', 'node_modules')
          await rename(path.join(staging, 'node_modules'), target)
          await rm(staging, { recursive: true, force: true }).catch(() => undefined)
          kernelModules = target
          log(`[pack-import] 随包内核已落进新实例：${target}`)
        } else if (kernelModules) {
          // 内核树只读共享：junction 让新实例「用得上」本机这份内核，但删包时删的是自己那份。
          await symlink(kernelModules, path.join(home, 'profiles', 'node_modules'), 'junction')
        } else {
          // 走不到：上面「本机没有 + 包里也没有」已经 throws 过了。留个兜底，别让类型收窄骗人。
          throw new ImportStop('内核没准备好，这次导入先停下。')
        }

        const report: OfflineImportReport = await importOfflinePack({
          packDir,
          home,
          id: packId,
          onProgress: event => {
            // 阶段边界就是取消点：抛出去让核心停在两次写盘之间（它没有中断信号）。
            if (cancelRequested) throw new ImportStop('你取消了这次导入。')
            pushStage(event.stage)
          },
        })
        // 走到这里实例已经完整：后面就算登记失败也不能把它删掉。
        createdHome = null
        log(`[pack-import] 装配完成：${report.profileDir}（插件 ${report.counts.plugins} / junction ${report.counts.junctions} / ${report.durationMs}ms）`)
        if (report.warnings.length > 0) log(`[pack-import] 警告：${report.warnings.join('；')}`)

        // 登记：只写 packs.json，不动磁盘。失败也不影响结果——家目录已经在整合包根目录下，
        // 列表刷新时的自动收编会把它捡起来，只是名字会退回目录名。
        try {
          await adoptPackFromFolder({ registryPath: deps.registryPath, homePath: home, name: displayName })
        } catch (error) {
          log(`[pack-import] 登记失败，等列表自动收编：${error instanceof Error ? error.message : String(error)}`)
        }
        pushStage('done')
        return { ok: true, packId, packName: displayName }
      } catch (error) {
        await discardCreatedHome()
        if (kernelStaging) {
          await rm(kernelStaging, { recursive: true, force: true }).catch(() => undefined)
          kernelStaging = null
        }
        if (error instanceof ImportStop) return { ok: false, reason: error.reason }
        // 压缩包自身的失败（打不开 / 路径穿越 / 找不到或分不清 manifest）也翻成人话。
        if (error instanceof OfflineZipError) return { ok: false, reason: blockedReason(error.code) }
        if (error instanceof OfflineImportBlockedError) {
          const code = error.issues[0]?.code ?? ''
          // 原始 message 里有绝对路径与插件名，只进日志。
          log(`[pack-import] 预检阻塞（${source} → ${home ?? '(未定)'}）：${error.message}`)
          return { ok: false, reason: blockedReason(code) }
        }
        log(`[pack-import] 装配失败（${source} → ${home ?? '(未定)'}）：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        return { ok: false, reason: failureReason(error) }
      } finally {
        await prepared?.dispose()
        running = false
        cancelRequested = false
      }
    },

    async cancel() {
      if (!running) return
      cancelRequested = true
      log('[pack-import] 收到取消请求，会在下一个阶段边界停下。')
    },
  }
}
