// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CreatePackDialog, defaultPackFolderName, latestSeriesVersion } from '../src/components/dialogs/CreatePackDialog'

/**
 * 「新建整合包」弹窗的四条硬规则（稿 lch-create）：
 *   1) 两个输入框的 placeholder 就是定稿那两句；
 *   2) 文件夹名留空 → pack-YYYYMMDD（本地时区今天）；
 *   3) 整合包名留空 → 跟随文件夹名，输入文件夹时同步；
 *   4) 整合包名被手改过一次，就再也不跟着文件夹走。
 * 另外钉住核心的选择：固定 0.2.1 系列里已装的最新一个，一个都没有时创建置灰并给提示。
 */

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

const containers: Array<{ root: Root; node: HTMLElement }> = []

interface Created {
  name: string
  dshVersion: string
  folderName: string
}

async function render(dialogProps: {
  installedDshVersions?: string[]
  busy?: boolean
} = {}): Promise<{ node: HTMLElement; created: Created[] }> {
  const created: Created[] = []
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  containers.push({ root, node })
  await act(async () => {
    root.render(
      <CreatePackDialog
        installedDshVersions={dialogProps.installedDshVersions ?? ['0.2.0-rc.2', '0.2.1-rc.2']}
        busy={dialogProps.busy ?? false}
        onCreate={async request => { created.push(request); return true }}
        onClose={() => undefined}
      />,
    )
  })
  return { node, created }
}

/** 受控 input 必须走原生 setter + input 事件，直接改 value React 收不到。 */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    if (setter) setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function inputs(node: HTMLElement): { folder: HTMLInputElement; name: HTMLInputElement } {
  const [folder, name] = [...node.querySelectorAll<HTMLInputElement>('.create-input')]
  return { folder: folder!, name: name! }
}

function createButton(node: HTMLElement): HTMLButtonElement {
  const buttons = [...node.querySelectorAll<HTMLButtonElement>('.create-actions button')]
  return buttons.find(button => button.textContent === '创建')!
}

beforeAll(() => { window.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  for (const { root, node } of containers.splice(0)) {
    act(() => root.unmount())
    node.remove()
  }
})

describe('新建整合包弹窗', () => {
  it('两个 placeholder 与标题照定稿，核心写着已安装的 0.2.1-rc.2', async () => {
    const { node } = await render()
    const { folder, name } = inputs(node)

    expect(node.querySelector('h2')?.textContent).toBe('新建整合包')
    expect(folder.placeholder).toBe('留空自动使用时间戳')
    expect(name.placeholder).toBe('留空则跟随文件夹名称')
    expect(node.querySelector('.create-core-value')?.textContent).toBe('0.2.1-rc.2')
    expect(node.querySelector('.create-core-state')?.textContent).toBe('已安装')
  })

  it('两个都留空时，文件夹名用 pack-<今天>，整合包名跟着它', async () => {
    const { node, created } = await render()
    await act(async () => { createButton(node).click() })

    const expected = defaultPackFolderName()
    expect(expected).toMatch(/^pack-\d{8}$/)
    expect(created).toHaveLength(1)
    expect(created[0]).toEqual({ name: expected, folderName: expected, dshVersion: '0.2.1-rc.2' })
  })

  it('整合包名称跟随文件夹名称输入', async () => {
    const { node } = await render()
    const { folder, name } = inputs(node)

    await type(folder, 'team-a')
    expect(name.value).toBe('team-a')

    await type(folder, 'team-b')
    expect(name.value).toBe('team-b')
  })

  it('整合包名称手改过之后不再跟随', async () => {
    const { node, created } = await render()
    const { folder, name } = inputs(node)

    await type(folder, 'team-a')
    await type(name, '我的实例')
    await type(folder, 'team-c')

    // 手改过就不再同步（留空也不回落）
    expect(name.value).toBe('我的实例')

    await act(async () => { createButton(node).click() })
    expect(created[0]).toEqual({ name: '我的实例', folderName: 'team-c', dshVersion: '0.2.1-rc.2' })
  })

  it('文件名有非法字符时创建置灰并给提示', async () => {
    const { node } = await render()
    const { folder } = inputs(node)

    await type(folder, '中文名字')
    expect(createButton(node).disabled).toBe(true)
    expect(node.querySelector('.create-hint')?.textContent).toContain('只能用')

    await type(folder, 'ok-Name_1')
    expect(createButton(node).disabled).toBe(false)
    expect(node.querySelector('.create-hint')).toBeNull()
  })

  it('本机没有 0.2.1 内核时创建置灰并说明原因，不静默失败', async () => {
    const { node } = await render({ installedDshVersions: ['0.2.0-rc.2', '0.2.2-rc.1'] })

    expect(createButton(node).disabled).toBe(true)
    expect(node.querySelector('.create-core-value')?.textContent).toBe('未找到')
    expect(node.querySelector('.create-core-state')).toBeNull()
    expect(node.querySelector('.create-hint')?.textContent).toContain('0.2.1')
  })

  it('latestSeriesVersion 只认 0.2.1 系列，取最新一个', () => {
    expect(latestSeriesVersion(['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2'])).toBe('0.2.1-rc.2')
    expect(latestSeriesVersion(['0.2.1-rc.2', '0.2.1'])).toBe('0.2.1')
    expect(latestSeriesVersion(['0.2.10', '0.2.1-rc.2'])).toBe('0.2.1-rc.2')
    expect(latestSeriesVersion(['0.2.0-rc.2'])).toBeNull()
    expect(latestSeriesVersion([])).toBeNull()
  })
})
