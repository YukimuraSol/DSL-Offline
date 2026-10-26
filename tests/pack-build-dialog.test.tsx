// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PackBuildDialog } from '../src/components/dialogs/PackBuildDialog'
import { SettingsPanels } from '../src/views/SettingsView'
import type { AppSettings, PackExtras, PackStatus, WorkbenchStatus } from '../src/types'

/**
 * 「制作整合包」弹窗的两条硬规则：
 *   1) 读不到 status.json 就是空闲态 —— 界面上不许出现百分比、x/y、插件总数这类编出来的进度。
 *   2) 行内入口把实例 id 带进来就预选它；「当前对话所在实例」的副标题固定是「通用对话」。
 * 顺带钉住导出前四件的缺件提示（复制提示词置灰 + title 说明缺哪一件）。
 */

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

function pack(id: string, overrides: Partial<PackStatus> = {}): PackStatus {
  return {
    id,
    name: id.toUpperCase(),
    description: '',
    version: '1.0.0',
    dshVersion: '0.9.2',
    source: 'created',
    enabled: false,
    state: 'complete',
    plugins: [{ packageName: 'demo-plugin', version: '1.0.0', enabled: true }],
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as PackStatus
}

interface Probe {
  status: WorkbenchStatus | null
  extras: PackExtras
  opened: string[]
}

/**
 * api/client 的 resolveLauncherApi 会把第一个见到的 window.launcher 缓存住（整个渲染层只有一份），
 * 所以探针必须是**同一个对象**，每个用例只改它的字段 —— 换新对象后面的用例会读到上一份。
 */
const currentProbe: Probe = { status: null, extras: { exists: false, count: 0 }, opened: [] }

/** 把 preload 那层换成探针：api/client 的 resolveLauncherApi 只认 window.launcher。 */
function installApi(probe: Probe): void {
  currentProbe.status = probe.status
  currentProbe.extras = probe.extras
  currentProbe.opened = probe.opened
  ;(window as unknown as { launcher: unknown }).launcher = {
    readWorkbenchStatus: async () => currentProbe.status,
    readPackExtras: async () => currentProbe.extras,
    openPackExtras: async (packId: string) => { currentProbe.opened.push(packId) },
  }
}

const containers: Array<{ root: Root; node: HTMLElement }> = []

async function render(probe: Probe, props: Partial<Parameters<typeof PackBuildDialog>[0]> = {}) {
  installApi(probe)
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  containers.push({ root, node })
  await act(async () => {
    root.render(
      <PackBuildDialog
        packs={[pack('pack-a'), pack('pack-b')]}
        activePackId="pack-a"
        preselectedPackId={null}
        runningPackIds={[]}
        runningPorts={{}}
        installedDshVersions={['0.9.2']}
        exportDir="C:\\Users\\demo\\Desktop\\ds-packs"
        launcherExe="C:\\Program Files\\DSH Launcher\\DSH Launcher.exe"
        onClose={() => undefined}
        {...props}
      />,
    )
  })
  return node
}

beforeAll(() => { window.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  for (const { root, node } of containers.splice(0)) {
    act(() => root.unmount())
    node.remove()
  }
})

describe('制作整合包弹窗', () => {
  it('读不到 status.json 时空闲态，且不出现百分比或 x/y', async () => {
    const node = await render({ status: null, extras: { exists: true, count: 3 }, opened: [] })
    const text = node.textContent ?? ''

    expect(text).toContain('制作整合包')
    expect(text).toContain('选择目标实例')
    expect(text).toContain('核心 · 未检测')
    expect(text).toContain('尚未开始装配')
    expect(text).toContain('3 个文件')
    // 没有进度条 = 没有假装在跑
    expect(node.querySelector('.build-bar')).toBeNull()
    expect(text).not.toMatch(/\d+\s*%/)
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/)
  })

  it('有 status.json 时照实渲染核心、不定态进度条与「最后一个正在核验」', async () => {
    const status: WorkbenchStatus = {
      phase: 'install',
      kernel: { version: '0.9.2', state: 'ok' },
      passed: ['alpha-plugin', 'beta-plugin'],
      current: 'gamma-plugin',
      startedAt: '2026-10-24T12:00:00.000Z',
      reason: null,
    }
    const node = await render({ status, extras: { exists: true, count: 0 }, opened: [] })
    const text = node.textContent ?? ''

    expect(text).toContain('核心 0.9.2 · 已就绪')
    expect(text).toContain('装配中')
    expect(text).toContain('没有附件')
    expect(node.querySelector('.build-bar')).not.toBeNull()
    const chips = [...node.querySelectorAll('.build-chip')].map(chip => chip.textContent)
    expect(chips).toEqual(['alpha-plugin', 'beta-plugin', 'gamma-plugin'])
    // 最后一个（正在核验）才是虚线框 + 转圈
    expect(node.querySelectorAll('.build-chip.is-checking')).toHaveLength(1)
    expect(node.querySelector('.build-chip.is-checking')?.textContent).toBe('gamma-plugin')
    expect(text).not.toMatch(/\d+\s*%/)
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/)
  })

  it('行内入口预选该行实例；菜单里有「当前对话所在实例 / 通用对话」并打勾', async () => {
    const node = await render({ status: null, extras: { exists: true, count: 1 }, opened: [] }, { preselectedPackId: 'pack-b' })

    expect(node.querySelector('.build-select-name')?.textContent).toBe('PACK-B')

    const box = node.querySelector<HTMLButtonElement>('.build-select-box')
    expect(box).not.toBeNull()
    await act(async () => { box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { box?.click() })

    const rows = [...node.querySelectorAll('.build-menu-row')]
    const current = rows.find(row => row.textContent?.includes('当前对话所在实例'))
    expect(current?.textContent).toBe('当前对话所在实例通用对话')
    expect(current?.getAttribute('aria-selected')).toBe('false')
    // 预选的那一行打勾
    const selected = rows.find(row => row.getAttribute('aria-selected') === 'true')
    expect(selected?.textContent).toContain('PACK-B')
    expect(selected?.querySelector('.build-menu-check')).not.toBeNull()
  })

  it('包没装完整（state=partial）不算缺件，不拦复制提示词', async () => {
    const node = await render(
      { status: null, extras: { exists: true, count: 4 }, opened: [] },
      { packs: [pack('pack-a', { state: 'partial' })] },
    )
    expect(node.querySelector<HTMLButtonElement>('.build-copy')?.disabled).toBe(false)
    expect(node.querySelector('.build-copy-wrap')?.getAttribute('title')).not.toContain('缺少')
  })

  it('缺核心时 title 说的是「核心」而不是「槽位」', async () => {
    const node = await render(
      { status: null, extras: { exists: true, count: 0 }, opened: [] },
      { packs: [pack('pack-a', { dshVersion: '9.9.9' })] },
    )
    expect(node.querySelector<HTMLButtonElement>('.build-copy')?.disabled).toBe(true)
    expect(node.querySelector('.build-copy-wrap')?.getAttribute('title')).toBe('缺少核心，导出会被拒绝')
    expect(node.textContent ?? '').not.toContain('槽位')
  })

  it('缺件时复制提示词置灰，并把缺哪一件挂在 title 上', async () => {
    const node = await render({ status: null, extras: { exists: false, count: 0 }, opened: [] })
    const text = node.textContent ?? ''

    expect(text).toContain('目录不存在')
    // 目录缺失照样有两个入口：附件那个点下去主进程会按需建目录，导出目录与包无关。
    expect(node.querySelectorAll('.build-attach-btn')).toHaveLength(2)
    const copy = node.querySelector<HTMLButtonElement>('.build-copy')
    expect(copy?.disabled).toBe(true)
    expect(node.querySelector('.build-copy-wrap')?.getAttribute('title')).toBe('缺少附件，导出会被拒绝')
  })

  it('三件齐全时复制提示词可用，附件行「打开」走 IPC', async () => {
    const probe: Probe = { status: null, extras: { exists: true, count: 1 }, opened: [] }
    const node = await render(probe)
    const copy = node.querySelector<HTMLButtonElement>('.build-copy')
    expect(copy?.disabled).toBe(false)

    const open = node.querySelectorAll<HTMLButtonElement>('.build-attach-btn')[0]
    await act(async () => { open?.click() })
    expect(probe.opened).toEqual(['pack-a'])
  })
})

/**
 * 两处入口：标题栏绿色「制作整合包」（不预选，落到当前激活的包）与行内上传图标（预选该行）。
 * 下面这个 Harness 复刻 App.tsx 里那三行装配：onRequestBuild 记下 preselect → 渲染同一个弹窗。
 */
describe('制作整合包的两处入口', () => {
  function Harness() {
    const [target, setTarget] = useState<{ preselect: string | null } | null>(null)
    return (
      <>
        <SettingsPanels
          settings={{ dshHome: 'C:\\Users\\demo\\.dsh' } as unknown as AppSettings}
          tab="packs"
          packs={[pack('pack-a'), pack('pack-b')]}
          activePack={pack('pack-a')}
          runningPackIds={[]}
          runningPorts={{}}
          busy={null}
          onRefresh={noop}
          onImportPack={noop}
          onImportPackPath={noop}
          onRequestCreate={noop}
          onRemovePack={noop}
          onRenamePack={async () => true}
          onTogglePackRuntime={noop}
          onRequestBuild={packId => setTarget({ preselect: packId })}
          onRequestVerify={noop}
          onActivatePack={noop}
          onOpenExtras={noop}
        />
        {target && (
          <PackBuildDialog
            packs={[pack('pack-a'), pack('pack-b')]}
            activePackId="pack-a"
            preselectedPackId={target.preselect}
            runningPackIds={[]}
            runningPorts={{}}
            installedDshVersions={['0.9.2']}
            exportDir=""
            launcherExe=""
            onClose={() => setTarget(null)}
          />
        )}
      </>
    )
  }

  async function renderHarness() {
    installApi({ status: null, extras: { exists: true, count: 0 }, opened: [] })
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    containers.push({ root, node })
    await act(async () => { root.render(<Harness />) })
    return node
  }

  it('标题栏「制作整合包」打开弹窗，默认选中当前激活的包', async () => {
    const node = await renderHarness()
    const header = [...node.querySelectorAll<HTMLButtonElement>('.heading-actions button')]
      .find(button => button.textContent?.includes('制作整合包'))
    expect(header).toBeDefined()

    await act(async () => { header?.click() })

    const dialog = node.querySelector('.build-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('h2')?.textContent).toBe('制作整合包')
    expect(dialog?.querySelector('.build-select-name')?.textContent).toBe('PACK-A')
  })

  it('行内上传图标打开同一个弹窗，并预选该行实例', async () => {
    const node = await renderHarness()
    // 第二行（pack-b）的「制作整合包」图标
    const row = node.querySelectorAll('.pack-row')[1]
    const icon = row?.querySelector<HTMLButtonElement>('.icon-btn[title="制作整合包"]')
    expect(icon).not.toBeNull()

    await act(async () => { icon?.click() })

    const dialog = node.querySelector('.build-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('.build-select-name')?.textContent).toBe('PACK-B')
  })
})

function noop(): void {}

