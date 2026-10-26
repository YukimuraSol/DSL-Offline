/**
 * 整合包（Pack）编排层 —— 纯逻辑 + DI，不依赖 electron。
 *
 * 功能定位：串行批量安装执行器 + 结果汇总 + 启动前置守卫。对齐「每包 = 独立
 * profile、单项失败继续」的语义：DSH profile 切换、插件安装细节由调用方
 * （pack.ts / installer.ts）注入为每个 InstallableItem 的 `install` 闭包；
 * 整合包本身只是一份清单，资源安装目标由调用方绑定到共享 Profile。
 *
 * 约定：
 *   - runSerialInstall 严格按数组顺序串行 await 每项；取消只在「项与项之间」
 *     生效，绝不中断进行中的单项。
 *   - 单项抛错 → 记入 failures，继续后续项（失败不阻断整个包）。
 *   - guardPackStart 是纯函数守卫，返回拒绝原因字符串，可启动返回 null，不抛错。
 */

import type { PackInstallResult, PackProgressEvent } from '../src/types'

/** 一个可安装单元：安装动作已注入为闭包。offline 表示插件本体在 zip 内（离线装）。 */
export type InstallableItem = {
  packageName: string
  install: () => Promise<void>
  offline?: boolean
}

export type SerialInstallHooks = {
  emitEvent?: (event: PackProgressEvent) => void
  shouldCancel?: () => boolean
}

export type SerialInstallResult = {
  installed: string[]
  failures: { packageName: string; reason: string }[]
}

function asReason(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '未知错误'
}

/**
 * 串行批量安装：严格按 items 数组顺序逐项 await。
 * - 每项开始前 emit `item-start`（含 offline 标记），结束后 emit `item-done`。
 * - `shouldCancel()` 只在「项之间」检查：返回 true 则不再启动后续项，
 *   已在进行的单项照常跑完（不中断）。
 * - 单项抛错 → 记入 failures（reason 取 Error.message），继续后续项。
 * 返回成功与失败的汇总，不抛错。
 */
export async function runSerialInstall(
  items: InstallableItem[],
  hooks: SerialInstallHooks = {},
): Promise<SerialInstallResult> {
  const emitEvent = hooks.emitEvent
  const shouldCancel = hooks.shouldCancel ?? (() => false)
  const installed: string[] = []
  const failures: { packageName: string; reason: string }[] = []

  for (const item of items) {
    // 取消只在项之间生效：上一项（若有）已完成，这里才响应取消。
    if (shouldCancel()) break

    const offline = item.offline === true
    emitEvent?.({ kind: 'item-start', packageName: item.packageName, offline })
    try {
      await item.install()
      installed.push(item.packageName)
      emitEvent?.({ kind: 'item-done', packageName: item.packageName, ok: true })
    } catch (error) {
      const reason = asReason(error)
      failures.push({ packageName: item.packageName, reason })
      emitEvent?.({ kind: 'item-done', packageName: item.packageName, ok: false, reason })
    }
  }

  return { installed, failures }
}

/**
 * 汇总为渲染层 `PackInstallResult`。state 三分支：
 *   - 无失败 → complete
 *   - 有失败但至少 1 项成功 → partial
 *   - 全部失败（或全未执行）→ failed
 */
export function buildInstallResult(
  id: string,
  installed: string[],
  failures: { packageName: string; reason: string }[],
): PackInstallResult {
  const state = failures.length === 0 ? 'complete' : (installed.length >= 1 ? 'partial' : 'failed')
  return { id, installed, failures, state }
}

export type GuardPackStartOptions = {
  isRuntimeRunning: () => boolean
  isInstallerBusy: () => boolean
  isPackBusy: () => boolean
}

/**
 * 整合包操作启动前的互斥守卫（纯逻辑，不抛）。按优先级返回首个拒绝原因：
 *   1) DSH 运行时正在运行；
 *   2) 普通安装器忙；
 *   3) 已有整合包操作进行中。
 * 全部放行则返回 null。
 */
export function guardPackStart(options: GuardPackStartOptions): string | null {
  if (options.isRuntimeRunning()) return 'DSH 运行时正在运行'
  if (options.isInstallerBusy()) return '安装器忙'
  if (options.isPackBusy()) return '整合包操作进行中'
  return null
}
