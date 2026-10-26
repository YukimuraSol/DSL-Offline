import { describe, expect, it } from 'vitest'
import { effectiveKernelOf } from '../src/lib/kernel-status'
import type { DshInstallationStatus, InstanceSnapshot } from '../src/types'

function snapshot(packId: string, kernelVersion: string | null): InstanceSnapshot {
  return {
    packId,
    name: packId,
    homePath: 'D:\\packs\\' + packId,
    profileName: packId,
    webPort: null,
    kernelPath: 'dsh.cmd',
    kernelVersion,
    kernelSource: kernelVersion ? 'pack' : 'launcher',
    biliRoot: '',
    running: true,
    pid: 1,
    url: null,
    startedAt: null,
  }
}

const launcherDsh: DshInstallationStatus = { installed: true, version: '0.2.1-rc.2', executable: 'dsh.cmd', source: 'launcher' }

describe('effectiveKernelOf（首页内核出处的唯一口径）', () => {
  it('没有激活包时绝不从实例快照反推 pack；有激活包且它自己的快照带内核才报随整合包', () => {
    // 缺陷 4 的真机截图：「还没有整合包…」下面却写「DSH 0.2.1-rc.2 · 随整合包」。
    // 列表里留着历史实例快照（每个包自己的 kernelVersion），它们不代表「当前在跑的内核」。
    const idle = effectiveKernelOf({
      activePackId: null,
      instances: [snapshot('pack-gone', '0.2.0-rc.2')],
      dshInstallation: launcherDsh,
    })
    expect(idle.origin).not.toBe('pack')
    expect(idle).toEqual({ version: '0.2.1-rc.2', origin: 'launcher' })

    // 系统装的 DSH 也一样如实报 system，不冒充整合包。
    const system = effectiveKernelOf({
      activePackId: null,
      instances: [snapshot('pack-gone', '0.2.0-rc.2')],
      dshInstallation: { ...launcherDsh, source: 'system' },
    })
    expect(system.origin).toBe('system')

    // 有激活包、且它**自己**的实例快照带内核：这才是「随整合包」。
    const packed = effectiveKernelOf({
      activePackId: 'pack-live',
      instances: [snapshot('pack-gone', '0.2.0-rc.2'), snapshot('pack-live', '0.3.0-rc.1')],
      dshInstallation: launcherDsh,
    })
    expect(packed).toEqual({ version: '0.3.0-rc.1', origin: 'pack' })

    // 都取不到就是 null / null：界面如实写「版本未知」，不编一个来源。
    expect(effectiveKernelOf({
      activePackId: null,
      instances: [],
      dshInstallation: { installed: false, version: null, executable: null, source: null },
    })).toEqual({ version: null, origin: null })
  })
})
