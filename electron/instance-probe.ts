import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { parseNetstatListeners } from './port-control'

/**
 * 「这个整合包实例在不在跑」只认客观事实，不认启动器自己的记账：
 *   1. 该包端口有人在监听（net.createServer().listen 探占用，毫秒级、不建进程）；
 *   2. 占着端口的那个 PID，命令行确实是这个包的 DSH Web（CIM Win32_Process.CommandLine）。
 * 这样手动起的实例、启动器重启前起的实例都能被认出来；PID 复用则被第 2 条挡住。
 */

const execFileAsync = promisify(execFile)

const RUN_OPTIONS = { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }

/** 端口是否已有人监听：EADDRINUSE = 在跑。（返回 true 表示「被占用」） */
export function isPortOccupied(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(true))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(false))
    })
  })
}

/** 谁在监听这个端口（netstat 一步到位）。启动器只在「状态发生变化」时调它。 */
export async function listeningPids(port: number): Promise<number[]> {
  try {
    const result = await execFileAsync('netstat.exe', ['-ano', '-p', 'TCP'], RUN_OPTIONS)
    return parseNetstatListeners(String(result.stdout ?? ''), port)
  } catch {
    return []
  }
}

/** 该 PID 的完整命令行；取不到（权限不足/进程已退）返回 null。 */
export async function processCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
    ], RUN_OPTIONS)
    const text = String(result.stdout ?? '').trim()
    return text || null
  } catch {
    return null
  }
}

function normalize(value: string): string {
  return value.replace(/[\\/]+/g, '/').toLowerCase()
}

function hasPortFlag(commandLine: string, port: number): boolean {
  return new RegExp(`--port[ =]"?${port}(?![0-9])`).test(commandLine)
}

export interface InstanceIdentity {
  port: number
  homePath: string
  kernelPath?: string | null
  /** 这个包的 profile 名；有值时它就是首要身份证据（命令行会带 --profile <名>）。 */
  profileName?: string | null
}

/**
 * 命令行里声明的 profile（`--profile X`）。台式实测写法是 `--profile pack-bili-min`，
 * 也可能被引号包成 `"--profile" "pack-bili-min"`——调用方先把引号压平成空格再传进来。
 */
export function profileFromCommandLine(commandLine: string): string | null {
  const matched = /--profile[=\s"]+([^\s"]+)/i.exec(commandLine)
  return matched?.[1] ?? null
}

/**
 * 判断一条命令行是不是「这个包的 DSH Web」。
 *
 * 首选证据：命令行里的 `--profile <包id>`（实测就是 `dsh.cmd --profile pack-bili-min ...`）。
 * 次要证据：命令行里出现这个包的家目录 / 内核路径（包自带内核时路径就在包里）。
 * 兜底证据：--port <本包端口> + 命令行里认得出 dsh —— 现在端口是唯一分配的，兜底才站得住。
 *
 * 两个坑（台式实测踩到的）：
 *  1. CIM 取回来的命令行是带引号的参数序列，比如 `"--port" "3080"`，
 *     直接找 `--port 3080` 找不到 —— 先把引号当空格压平再比。
 *  2. 0.2.0-rc.2 的 dsh 起 Web 时命令行里没有 "web" 这个词（`bin.js --profile X --port 3080`），
 *     所以不能拿 web 子命令当必要条件。
 */
export function commandLineMatchesInstance(commandLine: string, identity: InstanceIdentity): boolean {
  const raw = commandLine.toLowerCase()
  if (!raw) return false
  const flat = raw.replace(/"/g, ' ').replace(/\s+/g, ' ')
  const normalized = normalize(flat)
  // 首选证据：命令行明说了 profile。说的是别的包，就**不是**这个包——
  // 两个包都声称 3080 时，这一条是唯一能拦住「别的 dsh 也算我的实例」的判断。
  const declaredProfile = profileFromCommandLine(flat)
  if (identity.profileName && declaredProfile) {
    return declaredProfile.toLowerCase() === identity.profileName.toLowerCase()
  }
  if (identity.homePath && normalized.includes(normalize(identity.homePath))) return true
  if (identity.kernelPath && normalized.includes(normalize(identity.kernelPath))) return true
  // 没用 profile 别名起（web 子命令那种）才轮到端口兜底。端口现在是唯一分配的，兜底才站得住。
  const looksLikeDsh = flat.includes('@deepseek-ai') || /(?:^|[\\/\s])dsh(?:\.cmd|\.exe|\.js|\.mjs)?(?:\s|$)/.test(flat)
  return looksLikeDsh && hasPortFlag(flat, identity.port)
}

/** 端口 → 属于这个包的 PID；认不出来返回 null（宁可显示「未启动」，也不认错进程）。 */
export async function resolveInstancePid(identity: InstanceIdentity): Promise<number | null> {
  const pids = await listeningPids(identity.port)
  if (pids.length === 0) return null
  // 通常只有一个监听者；多个时逐个认，认出来第一个就算。
  for (const pid of pids) {
    const commandLine = await processCommandLine(pid)
    if (commandLine && commandLineMatchesInstance(commandLine, identity)) return pid
  }
  return null
}

/** 按 PID 结束整棵进程树（跨进程有效：不依赖启动器持有句柄）。 */
export async function killProcessTreeByPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return false
  try {
    await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], RUN_OPTIONS)
    return true
  } catch {
    return false
  }
}
