/**
 * 首页「当前内核」状态条的唯一口径。
 *
 * 缺陷 4：没有激活包时不能从实例快照反推「随整合包」。实例列表里会留着历史快照
 * （每个包自己的 kernelVersion），拿它标 pack 就会出现「还没有整合包…但下面是 DSH x · 随整合包」
 * 这种自相矛盾的显示。没有激活包 = 没有包内内核，只能报启动器 / 系统安装的那份。
 */
import type { DshInstallationStatus, InstanceSnapshot } from '../types'

export interface EffectiveKernel {
  version: string | null
  origin: 'pack' | 'launcher' | 'system' | null
}

export function effectiveKernelOf(input: {
  /** 已解析出来的激活包 id（settings.activePackId，或按 profileName 对上的那个）；没有 = null。 */
  activePackId: string | null
  instances: readonly InstanceSnapshot[]
  dshInstallation: DshInstallationStatus
}): EffectiveKernel {
  // 只有激活包**自己**的实例快照才代表「正在跑的内核」。
  const snapshot = input.activePackId
    ? input.instances.find(item => item.packId === input.activePackId)
    : undefined
  if (snapshot?.kernelVersion) return { version: snapshot.kernelVersion, origin: 'pack' }
  if (input.dshInstallation.installed && input.dshInstallation.version) {
    return {
      version: input.dshInstallation.version,
      origin: input.dshInstallation.source === 'system' ? 'system' : 'launcher',
    }
  }
  return { version: null, origin: null }
}
