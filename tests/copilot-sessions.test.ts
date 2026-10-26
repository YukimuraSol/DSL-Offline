import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCopilotSessionManager } from '../electron/copilot-sessions'
import type { AiSession, AppSettings } from '../src/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-copilot-'))
  roots.push(root)
  const settings: AppSettings = {
    dshInstallPath: path.join(root, 'runtime'),
    dshHome: path.join(root, 'dsh-home'),
    profileName: 'web',
    workspace: root,
    launchExecutable: 'dsh',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: false,
    aiDeveloperMode: false,
    aiPrompt: '',
  }
  const filePath = path.join(root, 'sessions.json')
  const manager = createCopilotSessionManager({
    filePath,
    runtimeRoot: path.join(root, 'acp'),
    snapshotRoot: path.join(root, 'snapshots'),
    readSettings: async () => settings,
    readApiKey: async () => 'sk-test',
    prepareNodeRuntime: async () => { throw new Error('not used') },
    preparePnpmRuntime: async () => { throw new Error('not used') },
    emitEvent: () => undefined,
    emitOutput: () => undefined,
    mutationBlockReason: () => null,
  })
  return { root, filePath, manager }
}

describe('Copilot session persistence', () => {
  it('creates and restores multiple local sessions', async () => {
    const { filePath, manager } = await fixture()
    const first = await manager.create({ title: '分析插件' })
    const second = await manager.create({ title: '检查运行时' })
    expect((await manager.list()).map(item => item.id)).toEqual([second.id, first.id])

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as unknown[]
    expect(persisted).toHaveLength(2)
  })

  it('marks unfinished sessions interrupted after restart', async () => {
    const { filePath, manager } = await fixture()
    const timestamp = new Date().toISOString()
    const session: AiSession = {
      id: 'unfinished', kind: 'chat', title: '未完成分析', subject: null, phase: 'running',
      createdAt: timestamp, updatedAt: timestamp,
      queue: { position: null, total: 0, running: true, mutating: false },
      messageCount: 0, pendingApproval: null, hasSnapshot: false, messages: [],
    }
    await writeFile(filePath, JSON.stringify([{ session }]), 'utf8')
    expect((await manager.list())[0].phase).toBe('interrupted')
  })

  it('deletes a settled session from the persistent index', async () => {
    const { manager } = await fixture()
    const session = await manager.create({ title: '临时会话' })
    await manager.remove(session.id)
    expect(await manager.list()).toEqual([])
  })

  it('send 携带 model 时把模型绑定并持久化到会话', async () => {
    const { filePath, manager } = await fixture()
    const session = await manager.create({ title: '模型测试' })
    await manager.send(session.id, '你好', 'ali|deepseek-v4-flash-0731')

    const updated = (await manager.list()).find(item => item.id === session.id)!
    expect(updated.model).toBe('ali|deepseek-v4-flash-0731')

    // 等后台分析收尾（fixture 的运行时准备会立即失败），再核对落盘内容。
    await new Promise(resolve => setTimeout(resolve, 30))
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ session: AiSession }>
    expect(persisted.find(item => item.session.id === session.id)?.session.model).toBe('ali|deepseek-v4-flash-0731')
  })

  it('setModel 绑定会话模型并支持清空回自动选择', async () => {
    const { manager } = await fixture()
    const session = await manager.create({ title: '模型测试' })
    const bound = await manager.setModel(session.id, 'ali|deepseek-v4-flash-0731')
    expect(bound.model).toBe('ali|deepseek-v4-flash-0731')
    expect((await manager.list()).find(item => item.id === session.id)?.model).toBe('ali|deepseek-v4-flash-0731')

    const cleared = await manager.setModel(session.id, null)
    expect(cleared.model).toBeNull()
    expect((await manager.list()).find(item => item.id === session.id)?.model).toBeNull()
  })

  it('setModel 拒绝不含 provider|model 分隔符的模型键', async () => {
    const { manager } = await fixture()
    const session = await manager.create({ title: '模型测试' })
    await expect(manager.setModel(session.id, 'nonsense')).rejects.toThrow('模型配置无效')
  })

  it('serializes legacy mutation tasks in FIFO order', async () => {
    const { manager } = await fixture()
    const first = await manager.beginLegacy('plugin-adaptation', '适配 A', 'plugin-a')
    const second = await manager.beginLegacy('runtime-repair', '修复 B', 'web')
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const firstRun = manager.runLegacy(first.id, async () => {
      order.push('first-start')
      markFirstStarted()
      await firstGate
      order.push('first-end')
    })
    const secondRun = manager.runLegacy(second.id, async () => {
      order.push('second-start')
      order.push('second-end')
    })
    await firstStarted
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([firstRun, secondRun])
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  })
})
