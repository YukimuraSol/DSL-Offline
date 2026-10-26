import { describe, expect, it } from 'vitest'
import {
  buildInstallResult,
  guardPackStart,
  runSerialInstall,
  type InstallableItem,
} from '../electron/pack-orchestration'
import type { PackProgressEvent } from '../src/types'

function item(packageName: string, install?: () => Promise<void>, offline = false): InstallableItem {
  return { packageName, install: install ?? (async () => undefined), offline }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('runSerialInstall 串行执行', () => {
  it('严格按数组顺序执行，installed 返回全部成功项', async () => {
    const order: string[] = []
    const items = [
      item('pkg-a', async () => { order.push('pkg-a') }),
      item('pkg-b', async () => { order.push('pkg-b') }),
      item('pkg-c', async () => { order.push('pkg-c') }),
    ]
    const result = await runSerialInstall(items, {})
    expect(order).toEqual(['pkg-a', 'pkg-b', 'pkg-c'])
    expect(result).toEqual({ installed: ['pkg-a', 'pkg-b', 'pkg-c'], failures: [] })
  })

  it('无并发：前一项完成才启动后一项', async () => {
    let active = 0
    let maxActive = 0
    const items = [0, 1, 2, 3, 4].map(index => item(`pkg-${index}`, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
    }))
    await runSerialInstall(items, {})
    expect(maxActive).toBe(1)
  })

  it('第 2 项失败时第 1、3 项仍安装，failures 含第 2 项', async () => {
    const installed: string[] = []
    const items = [
      item('pkg-a', async () => { installed.push('pkg-a') }),
      item('pkg-b', async () => { throw new Error('网络超时') }),
      item('pkg-c', async () => { installed.push('pkg-c') }),
    ]
    const result = await runSerialInstall(items, {})
    expect(installed).toEqual(['pkg-a', 'pkg-c'])
    expect(result.installed).toEqual(['pkg-a', 'pkg-c'])
    expect(result.failures).toEqual([{ packageName: 'pkg-b', reason: '网络超时' }])
  })

  it('emit 顺序：每项先 item-start 后 item-done，失败带 reason', async () => {
    const events: PackProgressEvent[] = []
    const items = [
      { packageName: 'pkg-a', offline: true, install: async () => undefined },
      { packageName: 'pkg-b', offline: false, install: async () => { throw new Error('boom') } },
    ]
    await runSerialInstall(items, { emitEvent: event => events.push(event) })
    expect(events).toEqual([
      { kind: 'item-start', packageName: 'pkg-a', offline: true },
      { kind: 'item-done', packageName: 'pkg-a', ok: true },
      { kind: 'item-start', packageName: 'pkg-b', offline: false },
      { kind: 'item-done', packageName: 'pkg-b', ok: false, reason: 'boom' },
    ])
  })
})

describe('runSerialInstall 取消语义', () => {
  it('shouldCancel 在完成 N 项后置真 → 后续不再调用', async () => {
    let remaining = 2 // 前 2 项运行后置真
    const installed: string[] = []
    const items = ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d'].map(name => item(name, async () => {
      installed.push(name)
      remaining -= 1
    }))
    const result = await runSerialInstall(items, { shouldCancel: () => remaining <= 0 })
    expect(installed).toEqual(['pkg-a', 'pkg-b'])
    expect(result.installed).toEqual(['pkg-a', 'pkg-b'])
  })

  it('取消不中断进行中的单项，仅在项之间生效', async () => {
    const installed: string[] = []
    let cancel = false
    const items = [
      item('pkg-a', async () => { installed.push('pkg-a') }),
      item('pkg-b', async () => {
        installed.push('pkg-b-start')
        cancel = true // 单项执行期间置真，不应打断它
        await delay(10)
        installed.push('pkg-b-end')
      }),
      item('pkg-c', async () => { installed.push('pkg-c') }),
    ]
    const result = await runSerialInstall(items, { shouldCancel: () => cancel })
    expect(installed).toEqual(['pkg-a', 'pkg-b-start', 'pkg-b-end'])
    expect(result.installed).toEqual(['pkg-a', 'pkg-b'])
  })

  it('shouldCancel 初始即为真 → 一个都不装', async () => {
    const installed: string[] = []
    const result = await runSerialInstall(
      [item('pkg-a', async () => { installed.push('pkg-a') })],
      { shouldCancel: () => true },
    )
    expect(installed).toEqual([])
    expect(result.installed).toEqual([])
  })
})

describe('buildInstallResult 状态三分支', () => {
  it('无失败 → complete', () => {
    expect(buildInstallResult('pack-x', ['a', 'b'], [])).toEqual({
      id: 'pack-x',
      installed: ['a', 'b'],
      failures: [],
      state: 'complete',
    })
  })

  it('有失败且至少 1 项成功 → partial', () => {
    const result = buildInstallResult('pack-x', ['a'], [{ packageName: 'b', reason: 'boom' }])
    expect(result.state).toBe('partial')
  })

  it('全部失败（或全未执行）→ failed', () => {
    const result = buildInstallResult('pack-x', [], [{ packageName: 'a', reason: 'boom' }])
    expect(result.state).toBe('failed')
  })
})

describe('guardPackStart 互斥守卫', () => {
  const idle = {
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    isPackBusy: () => false,
  }

  it('全部放行返回 null', () => {
    expect(guardPackStart(idle)).toBeNull()
  })

  it('DSH 运行时正在运行', () => {
    expect(guardPackStart({ ...idle, isRuntimeRunning: () => true })).toBe('DSH 运行时正在运行')
  })

  it('安装器忙', () => {
    expect(guardPackStart({ ...idle, isInstallerBusy: () => true })).toBe('安装器忙')
  })

  it('整合包操作进行中', () => {
    expect(guardPackStart({ ...idle, isPackBusy: () => true })).toBe('整合包操作进行中')
  })

  it('多重互斥时按优先级返回（运行时 > 安装器 > 整合包）', () => {
    expect(guardPackStart({
      isRuntimeRunning: () => true,
      isInstallerBusy: () => true,
      isPackBusy: () => true,
    })).toBe('DSH 运行时正在运行')
    expect(guardPackStart({
      isRuntimeRunning: () => false,
      isInstallerBusy: () => true,
      isPackBusy: () => true,
    })).toBe('安装器忙')
  })
})
