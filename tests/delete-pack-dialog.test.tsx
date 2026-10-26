// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DeletePackDialog } from '../src/components/dialogs/DeletePackDialog'

/**
 * 「删除整合包」确认窗（1.0.22）：
 *   1) 标题与两句书面正文照定稿，实例 id 出现在第一句；
 *   2) 实例在跑时正文多一行「删除前会先停止它」，没在跑就不出现；
 *   3) 点取消只关窗、绝不发删除请求；点删除才调用 onConfirm；
 *   4) onConfirm 返回 false（主进程没删成）时弹窗留在原地，不能假装成功关掉。
 */

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

const containers: Array<{ root: Root; node: HTMLElement }> = []

async function render(dialogProps: {
  packId?: string
  running?: boolean
  busy?: boolean
  result?: boolean
} = {}) {
  const onConfirm = vi.fn(async () => dialogProps.result ?? true)
  const onClose = vi.fn()
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  containers.push({ root, node })
  await act(async () => {
    root.render(
      <DeletePackDialog
        packId={dialogProps.packId ?? 'pack-20261025'}
        running={dialogProps.running ?? false}
        busy={dialogProps.busy ?? false}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )
  })
  return { node, onConfirm, onClose }
}

function button(node: HTMLElement, text: string): HTMLButtonElement {
  return [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
}

beforeAll(() => { window.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  for (const { root, node } of containers.splice(0)) {
    act(() => root.unmount())
    node.remove()
  }
})

describe('删除整合包确认窗', () => {
  it('标题、两句书面正文与目标实例 id 照定稿', async () => {
    const { node } = await render()

    expect(node.querySelector('h2')?.textContent).toBe('删除整合包')
    // 头部是红底垃圾桶图标块（不是灰的通用图标）。
    expect(node.querySelector('.delete-icon svg')).not.toBeNull()
    const lines = [...node.querySelectorAll('.delete-line')].map(item => item.textContent)
    expect(lines[0]).toBe('将删除 pack-20261025。')
    expect(lines[1]).toBe('该实例包含的插件、技能、预设、会话记录、凭据与附件将一并移除，此操作不可撤销。')
    // 底部两个按钮：取消 + 红底删除。
    expect(button(node, '取消')).toBeTruthy()
    const danger = button(node, '删除')
    expect(danger.className).toContain('danger-solid')
  })

  it('实例运行中才多一行「删除前会先停止它」', async () => {
    const stopped = await render({ running: false })
    expect(stopped.node.querySelector('.delete-running')).toBeNull()

    const running = await render({ running: true })
    expect(running.node.querySelector('.delete-running')?.textContent).toBe('该实例正在运行，删除前会先停止它。')
  })

  it('点取消只关窗，不发删除请求', async () => {
    const { node, onConfirm, onClose } = await render()
    await act(async () => { button(node, '取消').click() })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点删除才发请求，成功后自己关掉', async () => {
    const { node, onConfirm, onClose } = await render()
    await act(async () => { button(node, '删除').click() })

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onConfirm 返回 false（没删成）时不关窗', async () => {
    const { node, onConfirm, onClose } = await render({ result: false })
    await act(async () => { button(node, '删除').click() })

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    // 按钮回到可点状态，用户可以重试或取消。
    expect(button(node, '删除').disabled).toBe(false)
  })
})
