import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkbenchStatus } from '../src/types'
import { WORKBENCH_STATUS_FILENAME } from './workbench'

/**
 * 装配工作台的运行根目录（settings 之外的固定位置：userData/workbench）。
 * 每跑一次装配，引擎在它下面开一个 workbench-<时间戳>[-n]/，把 status.json 写进去
 * （见 electron/workbench.ts 的 WorkbenchStatusFile，契约就那一处）。
 *
 * 引擎还没被启动过 = 这个目录不存在 = 正常状态，不是错误：界面据此显示空闲态。
 */
export function workbenchRootDir(userData: string): string {
  return path.join(userData, 'workbench')
}

/**
 * 读最新一次装配的进度：runRoot 下按目录名（时间戳）新的优先，
 * 取第一个能读出并解析成功的 status.json。
 *
 * 一个都没有 / 全都读不了 → null（空闲态）。不抛错：没开始装配和「刚删掉」是同一件事。
 */
export async function readWorkbenchStatus(runRoot: string): Promise<WorkbenchStatus | null> {
  const entries = await readdir(runRoot, { withFileTypes: true }).catch(() => [])
  const runs = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(RUN_DIR_PREFIX))
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const run of runs) {
    const raw = await readFile(path.join(runRoot, run, WORKBENCH_STATUS_FILENAME), 'utf8').catch(() => null)
    if (raw === null) continue
    try {
      return normalize(JSON.parse(raw) as unknown)
    } catch {
      // 引擎正写到一半（半截 JSON）：这一轮跳过，退到上一次运行。
    }
  }
  return null
}

/** createRunDirectory 的命名前缀；只用来认哪个目录是「一次运行」。 */
const RUN_DIR_PREFIX = 'workbench-'

/**
 * 只认形状对的字段，多余的一律丢掉。
 * status.json 是引擎写的，但它跨了一次进程/磁盘边界，按不可信输入处理。
 */
function normalize(input: unknown): WorkbenchStatus | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const kernel = record.kernel && typeof record.kernel === 'object' ? record.kernel as Record<string, unknown> : {}
  return {
    phase: typeof record.phase === 'string' ? record.phase : '',
    kernel: {
      version: typeof kernel.version === 'string' ? kernel.version : null,
      state: typeof kernel.state === 'string' ? kernel.state : '',
    },
    passed: Array.isArray(record.passed) ? record.passed.filter((item): item is string => typeof item === 'string') : [],
    current: typeof record.current === 'string' ? record.current : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
  }
}
