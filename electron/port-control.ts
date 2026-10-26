import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 端口占用治理：查谁占着、按 PID 结束、以及「要不要问用户」。
 *
 * 背景：DSH 的 Web 端口被占时，启动器原来会**静默**往后找下一个可用端口，
 * 界面不说、用户不知道，浏览器标签里那个「旧的」实例还开着，于是两台 DSH 抢同一份家目录。
 * 现在改成：查清占用者 → 全是自己 track 的子进程就直接清（自愈）→ 否则交给人决定。
 *
 * 铁律：只按 PID 结束（taskkill /pid <pid> /t /f），**绝不按映像名批量杀**——
 * 那样会顺手杀掉用户自己开着的同名进程。PID 一律先做整数校验再进命令行。
 */

export interface PortOwner {
  pid: number
  /** 进程名；取不到时是 '<未知>'。查不到不等于没占用。 */
  name: string
  /** 可执行文件完整路径；取不到就是 null。 */
  path: string | null
  /** 命令行 --profile 推出的「疑似所属整合包」名；由 main.ts 在弹窗前补上。 */
  packName?: string | null
}

/** 注入点：测试里替换掉真跑 netstat/taskkill 的实现。 */
export interface PortControlDeps {
  run?: (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>
  platform?: NodeJS.Platform
}

const execFileAsync = promisify(execFile)

async function runFile(file: string, args: string[]): Promise<{ stdout: string; stderr?: string }> {
  const result = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** 进程名/路径查询的 PowerShell 脚本：只查这一个 PID，不枚举全表。 */
function processDetailCommand(pid: number): string {
  return `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -Property ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`
}

interface NetstatRow {
  localPort: number
  pid: number
}

/**
 * 从 netstat 输出里挑出「本地端口 = port 且处于 LISTENING」的行。
 *
 * 输出是定长列拼接，各语言版本对齐方式不同，所以不按列切片——按空白切词，
 * 认最后一个 token 是 PID、倒数第二个是状态、第一个是 TCP。
 */
export function parseNetstatListeners(output: string, port: number): number[] {
  const pids = new Set<number>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    if (tokens.length < 5) continue
    if (tokens[0].toUpperCase() !== 'TCP') continue
    const status = tokens[tokens.length - 2]?.toUpperCase()
    if (status !== 'LISTENING') continue
    const local = tokens[1]
    if (!local) continue
    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const localPort = Number.parseInt(local.slice(colon + 1), 10)
    if (localPort !== port) continue
    const pid = Number.parseInt(tokens[tokens.length - 1], 10)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids].sort((left, right) => left - right)
}

/**
 * 谁占着这个端口。
 *
 * 关键约定：**查不到进程详情时仍然返回一条记录**（name '<未知>'），
 * 把「查询失败」和「没人占用」区分开——前者绝不能当成空闲放行。
 */
export async function findPortOwners(port: number, deps: PortControlDeps = {}): Promise<PortOwner[]> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
  const run = deps.run ?? runFile
  let output = ''
  try {
    const result = await run('netstat.exe', ['-ano', '-p', 'TCP'])
    output = result.stdout
  } catch {
    // netstat 都跑不起来：此时无法证明端口空闲，交给上层按「占用」处理。
    return [{ pid: -1, name: '<未知>', path: null }]
  }
  const pids = parseNetstatListeners(output, port)
  const owners: PortOwner[] = []
  for (const pid of pids) {
    let name = '<未知>'
    let executable: string | null = null
    try {
      const detail = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', processDetailCommand(pid),
      ])
      const text = detail.stdout.trim()
      if (text) {
        const parsed = JSON.parse(text) as { Name?: unknown; ExecutablePath?: unknown }
        if (typeof parsed.Name === 'string' && parsed.Name.trim()) name = parsed.Name.trim()
        if (typeof parsed.ExecutablePath === 'string' && parsed.ExecutablePath.trim()) executable = parsed.ExecutablePath.trim()
      }
    } catch {
      // 权限不足（系统进程）等情况：名字留 '<未知>'，PID 仍然是可信的。
    }
    owners.push({ pid, name, path: executable })
  }
  return owners
}

export interface ReleasePortResult {
  killed: number[]
  failed: Array<{ pid: number; reason: string }>
}

/** 按 PID 结束进程树。每个 PID 单独 try/catch：一个失败不影响其余。 */
export async function releasePort(port: number, owners: PortOwner[], deps: PortControlDeps = {}): Promise<ReleasePortResult> {
  const run = deps.run ?? runFile
  const killed: number[] = []
  const failed: Array<{ pid: number; reason: string }> = []
  for (const owner of owners) {
    const pid = owner.pid
    // PID 必须来自可信来源（netstat 或调用方给的列表），但仍然要挡住越界与负数。
    if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
      failed.push({ pid, reason: '进程号无效' })
      continue
    }
    try {
      // 只用 /pid：按映像名（/im）批量杀会波及用户自己的同名进程。
      await run('taskkill.exe', ['/pid', String(pid), '/t', '/f'])
      killed.push(pid)
    } catch (error) {
      failed.push({ pid, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (killed.length > 0) {
    // 给系统一点回收监听套接字的时间，避免紧接着的 bind 仍然 EADDRINUSE。
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return { killed, failed }
}

/**
 * 这个端口冲突该不该直接清：占用者**全部**是启动器自己 track 的子进程才算自愈，
 * 只要混进一个陌生进程就得问用户（宁可多问一句，也不替用户杀别人的进程）。
 */
export function decidePortConflict(owners: PortOwner[], trackedPids: Iterable<number>): 'self-heal' | 'ask' {
  const tracked = new Set<number>()
  for (const pid of trackedPids) tracked.add(pid)
  if (owners.length === 0) return 'ask'
  if (tracked.size === 0) return 'ask'
  return owners.every(owner => tracked.has(owner.pid)) ? 'self-heal' : 'ask'
}
