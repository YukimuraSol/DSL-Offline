import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { readPackRegistry, upsertPackRecord, type PackRecord } from './pack-registry'

/**
 * 修 2：给没有独立家目录的旧整合包补一个。
 *
 * 1.0.9 之前的旧包（台式那个 `web`）在 packs.json 里没有 homePath，所有实例共用一个
 * 共享家目录；describe() 只能跳过它 —— 永远没有绿边，也拿不到自己的端口。
 * 这里在启动时一次性把那个共享家目录搬进 <packsRoot>/<包id>，写回 homePath，
 * 之后 describe() 自然看得见它，端口走实例表里的唯一分配。
 *
 * 归属判定（这是最容易搬错人的地方）：
 *  - 共享家目录必须传**存下来的**全局家目录（settings.readStored().dshHome）。
 *    不能传 settings.read().dshHome：激活包有自己的家目录时，那个值指向**激活包的私有目录**，
 *    搬给别的包等于把它整个环境送人。
 *  - 安全网：共享家目录如果正好是某个已登记整合包的 homePath，一个都不搬。
 *  - 激活包自己缺 homePath → 共享目录就是它在用，归它（1.0.9 的老行为）。
 *  - 激活包已有独立家目录 → 共享目录空出来了，但只有「**恰好一条**缺 homePath」才敢认定是它的
 *    （台式真实形态就是这种：激活的是 pack-bili-min，缺家的是 web）。
 *  - 多于一条缺 homePath → 一条都不搬，只记日志（共享目录只能给一个包，先到先得会分错）。
 *
 * 其余安全边界：
 *  - 目标目录已经有内容 → 直接认领，不再搬（幂等：上次搬成功但写表失败时不会重复搬运）。
 *  - 同盘整目录改名优先；跨盘退回复制，先复制到 <目标>.migrating 再改名，
 *    半截副本不会被当成完好的家目录；**原目录保留不删**（宁可多占一份磁盘，也不冒丢数据的险）。
 *  - 任何异常都只记日志、绝不抛出：搬不动不能把启动器搞崩。
 */

export interface PackHomeMigrationInput {
  registryPath: string
  /** 整合包根目录：旧包的新家就是 <packsRoot>/<包id>。 */
  packsRoot: string
  /**
   * 旧包共用的那个家目录 —— 必须来自 settings.readStored().dshHome（存下来的全局值）。
   * 用 settings.read() 的派生值会指向激活包的私有家目录，属于搬错人。
   */
  sharedHome: string
  /** settings 里存的激活包 id。 */
  activePackId: string | null
  log?: (message: string) => void
}

export interface PackHomeMigrationResult {
  moved: Array<{ packId: string; homePath: string; via: 'rename' | 'copy' | 'adopt' }>
  skipped: Array<{ packId: string; reason: string }>
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function directoryHasEntries(target: string): Promise<boolean> {
  try {
    return (await readdir(target)).length > 0
  } catch {
    return false
  }
}

/** Windows 路径不分大小写（与 settings.ts 里的 samePath 同口径）。 */
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function adoptLegacyPackHomes(input: PackHomeMigrationInput): Promise<PackHomeMigrationResult> {
  const result: PackHomeMigrationResult = { moved: [], skipped: [] }
  const log = input.log ?? (() => undefined)
  let legacy: PackRecord[] = []
  // 一条都不搬的统一出口：把原因写给每一条缺家目录的记录，再落一行日志。
  const skipAll = (reason: string): void => {
    for (const record of legacy) result.skipped.push({ packId: record.id, reason })
    log(`跳过旧包家目录补齐：${reason}。`)
  }
  try {
    const records = await readPackRegistry(input.registryPath)
    legacy = records.filter(record => !record.homePath)
    if (legacy.length === 0) return result
    const active = records.find(record => record.id === input.activePackId) ?? null
    if (!active) {
      skipAll('没有激活的整合包，判断不出共享家目录属于谁')
      return result
    }
    // 安全网：共享家目录正好是某个已登记整合包的私有目录时，谁都不能给。
    const owner = records.find(record => record.homePath && samePath(record.homePath, input.sharedHome))
    if (owner) {
      skipAll(`共享家目录 ${input.sharedHome} 就是已登记整合包「${owner.name}」的私有家目录`)
      return result
    }
    let target: PackRecord
    if (!active.homePath) {
      // 老行为：共享目录本来就是激活包在用，归它。
      target = active
    } else if (legacy.length === 1) {
      // 激活包已经独立，共享目录空出来了，且只有一条旧包 —— 归它。
      target = legacy[0]!
    } else {
      skipAll(`有 ${legacy.length} 个整合包缺家目录，共享目录只能给其中一个，先不动`)
      return result
    }
    for (const record of legacy) {
      if (record.id === target.id) continue
      result.skipped.push({ packId: record.id, reason: '共享家目录只能给一个整合包' })
    }
    if (!await pathExists(input.sharedHome)) {
      result.skipped.push({ packId: target.id, reason: '共享家目录不存在' })
      log(`跳过旧包家目录补齐：${input.sharedHome} 不存在。`)
      return result
    }
    const targetPath = path.join(input.packsRoot, target.id)
    if (samePath(targetPath, input.sharedHome)) {
      result.skipped.push({ packId: target.id, reason: '目标目录就是共享家目录' })
      return result
    }
    if (await directoryHasEntries(targetPath)) {
      // 目标已经有内容：当作「上次搬成功、写表没成功」，直接认领，不重复搬。
      try {
        await upsertPackRecord(input.registryPath, { ...target, homePath: targetPath, updatedAt: new Date().toISOString() })
        result.moved.push({ packId: target.id, homePath: targetPath, via: 'adopt' })
        log(`旧包「${target.name}」的目标目录已有内容，直接认领为家目录：${targetPath}。`)
      } catch (error) {
        result.skipped.push({ packId: target.id, reason: '目标目录存在但写表失败' })
        log(`旧包「${target.name}」认领失败：${reasonText(error)}`)
      }
      return result
    }
    const staging = `${targetPath}.migrating`
    try {
      await mkdir(path.dirname(targetPath), { recursive: true })
      await rm(staging, { recursive: true, force: true })
      let via: 'rename' | 'copy' = 'rename'
      try {
        // 同盘：整个目录一次改名到临时位置，最快，也不留第二份。
        await rename(input.sharedHome, staging)
      } catch {
        via = 'copy'
        // 跨盘 rename 会失败（EXDEV/EPERM）：先完整复制到临时目录，再改名成正式目录。
        await cp(input.sharedHome, staging, { recursive: true })
      }
      await rm(targetPath, { recursive: true, force: true })
      await rename(staging, targetPath)
      await upsertPackRecord(input.registryPath, { ...target, homePath: targetPath, updatedAt: new Date().toISOString() })
      result.moved.push({ packId: target.id, homePath: targetPath, via })
      log(`旧包「${target.name}」已获得独立家目录：${targetPath}（${via === 'rename' ? '同盘改名' : '跨盘复制，原目录保留'}）。`)
    } catch (error) {
      result.skipped.push({ packId: target.id, reason: reasonText(error) })
      log(`旧包「${target.name}」家目录补齐失败，继续共用旧目录：${reasonText(error)}`)
    }
  } catch (error) {
    log(`旧包家目录补齐整体失败，本次启动不动任何目录：${reasonText(error)}`)
  }
  return result
}

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
