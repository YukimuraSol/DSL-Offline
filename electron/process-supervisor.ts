import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SUPERVISOR_FILENAME = 'process-supervisor-v1.mjs'
const READY_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 15_000

// 独立监督进程只依赖 Node 内置模块。父进程崩溃或被强制关闭时 stdin 会收到 EOF，
// 它仍能在 Electron 之外结束已经登记的整棵子进程树。
const SUPERVISOR_SOURCE = String.raw`import { spawn } from 'node:child_process'

const tracked = new Set()
let input = ''
let stopping = false

function waitForExit(child) {
  return new Promise(resolve => {
    child.once('error', () => resolve())
    child.once('exit', () => resolve())
  })
}

async function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    // 某些 DSH 通道会把机器人进程脱离父进程树。先从 WMI 快照递归收集
    // 后代并反向结束，再用 taskkill 做一次兜底，避免微信服务遗留在后台。
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$root = ' + String(pid),
      '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
      '$ids = @($root)',
      '$todo = @($root)',
      'while ($todo.Count -gt 0) {',
      '  $parent = $todo[0]',
      '  if ($todo.Count -gt 1) { $todo = @($todo[1..($todo.Count - 1)]) } else { $todo = @() }',
      '  foreach ($child in @($rows | Where-Object { $_.ParentProcessId -eq $parent } | Select-Object -ExpandProperty ProcessId)) {',
      '    if ($ids -notcontains $child) { $ids += $child; $todo += $child }',
      '  }',
      '}',
      '[Array]::Reverse($ids)',
      'foreach ($id in $ids) { Stop-Process -Id $id -Force }',
    ].join('; ')
    const snapshotKiller = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, stdio: 'ignore' })
    await waitForExit(snapshotKiller)
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    await waitForExit(killer)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

async function cleanup() {
  if (stopping) return
  stopping = true
  const pids = [...tracked]
  tracked.clear()
  await Promise.allSettled(pids.map(killTree))
  process.exit(0)
}

function handle(line) {
  if (!line.trim()) return
  try {
    const message = JSON.parse(line)
    if (message.type === 'track' && Number.isSafeInteger(message.pid) && message.pid > 0) tracked.add(message.pid)
    if (message.type === 'untrack' && Number.isSafeInteger(message.pid)) tracked.delete(message.pid)
    if (message.type === 'shutdown') void cleanup()
  } catch {}
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\n')) >= 0) {
    handle(input.slice(0, newline))
    input = input.slice(newline + 1)
  }
})
process.stdin.once('end', () => void cleanup())
process.stdin.once('error', () => void cleanup())
process.once('SIGTERM', () => void cleanup())
process.once('SIGINT', () => void cleanup())
process.stdout.write('ready\n')
`

export interface ProcessSupervisorOptions {
  root: string
  executable?: string
  onError?: (message: string) => void
}

export interface ProcessSupervisor {
  track(child: ChildProcess): void
  shutdown(): Promise<void>
  isActive(): boolean
}

function waitForSupervisorReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => finish(new Error('进程监督器启动超时。')), READY_TIMEOUT_MS)
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      child.stdout.removeListener('data', onData)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes('ready\n')) finish()
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => finish(new Error(`进程监督器提前退出（代码 ${code ?? '未知'}）。`))
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForSupervisorExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, SHUTDOWN_TIMEOUT_MS)
    const finish = () => {
      clearTimeout(timeout)
      resolve()
    }
    child.once('error', finish)
    child.once('exit', finish)
  })
}

export async function createProcessSupervisor(options: ProcessSupervisorOptions): Promise<ProcessSupervisor> {
  await mkdir(options.root, { recursive: true })
  const workerPath = path.join(options.root, SUPERVISOR_FILENAME)
  await writeFile(workerPath, SUPERVISOR_SOURCE, 'utf8')
  const child = spawn(options.executable ?? process.execPath, [workerPath], {
    cwd: options.root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000) })
  await waitForSupervisorReady(child).catch(error => {
    child.kill('SIGKILL')
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`)
  })

  let active = true
  let shutdownPromise: Promise<void> | null = null
  const send = (message: object) => {
    if (!active || child.stdin.destroyed || !child.stdin.writable) return
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      options.onError?.(`登记子进程失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  child.once('exit', code => {
    const wasActive = active
    active = false
    if (wasActive && !shutdownPromise) {
      options.onError?.(`进程监督器意外退出（代码 ${code ?? '未知'}）。${stderr ? ` ${stderr.trim()}` : ''}`)
    }
  })

  return {
    track(processToTrack) {
      const pid = processToTrack.pid
      if (!pid || !active) return
      send({ type: 'track', pid })
      processToTrack.once('exit', () => send({ type: 'untrack', pid }))
      processToTrack.once('error', () => send({ type: 'untrack', pid }))
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        if (!active) return
        send({ type: 'shutdown' })
        child.stdin.end()
        await waitForSupervisorExit(child)
        active = false
      })()
      return shutdownPromise
    },
    isActive: () => active,
  }
}
