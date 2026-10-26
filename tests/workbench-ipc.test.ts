import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkbenchStatus, workbenchRootDir } from '../electron/workbench-ipc'

/**
 * status.json 的读取是「不许伪造进度」这条规则的落点：读不到就必须是 null，
 * 绝不拿默认值把界面填满。这里钉住三件事——按最新运行目录取、空目录是 null、
 * 半截 JSON 不能把界面糊成假进度。
 */

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-workbench-status-'))
  roots.push(root)
  return root
}

async function writeStatus(root: string, run: string, payload: unknown): Promise<void> {
  const dir = path.join(root, run)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'status.json'), JSON.stringify(payload), 'utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('读装配进度', () => {
  it('运行根目录不存在 / 里面没有运行目录时给 null（空闲态）', async () => {
    const root = await makeRoot()
    expect(await readWorkbenchStatus(root)).toBeNull()
    expect(await readWorkbenchStatus(path.join(root, 'nope'))).toBeNull()
    await mkdir(path.join(root, 'workbench-20261024-120000'), { recursive: true })
    expect(await readWorkbenchStatus(root)).toBeNull()
  })

  it('取最新那次运行（目录名带时间戳，新的优先）', async () => {
    const root = await makeRoot()
    await writeStatus(root, 'workbench-20261024-120000', { phase: 'done', kernel: { version: '0.9.1', state: 'ok' }, passed: ['old'], current: null, startedAt: null, reason: null })
    await writeStatus(root, 'workbench-20261024-130000', { phase: 'install', kernel: { version: '0.9.2', state: 'ok' }, passed: ['a'], current: 'b', startedAt: '2026-10-24T13:00:00.000Z', reason: null })

    const status = await readWorkbenchStatus(root)
    expect(status?.phase).toBe('install')
    expect(status?.kernel).toEqual({ version: '0.9.2', state: 'ok' })
    expect(status?.passed).toEqual(['a'])
    expect(status?.current).toBe('b')
  })

  it('最新那份写坏了就退到上一次，而不是报一个编出来的进度', async () => {
    const root = await makeRoot()
    await writeStatus(root, 'workbench-20261024-120000', { phase: 'done', kernel: { version: null, state: 'missing' }, passed: [], current: null, startedAt: null, reason: null })
    const broken = path.join(root, 'workbench-20261024-130000')
    await mkdir(broken, { recursive: true })
    await writeFile(path.join(broken, 'status.json'), '{"phase":"inst', 'utf8')

    const status = await readWorkbenchStatus(root)
    expect(status?.phase).toBe('done')
    expect(status?.kernel.state).toBe('missing')
  })

  it('形状不对的字段一律按「没有」处理', async () => {
    const root = await makeRoot()
    await writeStatus(root, 'workbench-20261024-120000', { phase: 7, kernel: 'nope', passed: ['ok', 3, null], current: 5 })
    const status = await readWorkbenchStatus(root)
    expect(status).toEqual({
      phase: '',
      kernel: { version: null, state: '' },
      passed: ['ok'],
      current: null,
      startedAt: null,
      reason: null,
    })
  })
})

it('运行根目录固定在 userData/workbench', () => {
  expect(workbenchRootDir('C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher')).toBe(
    path.join('C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher', 'workbench'),
  )
})
