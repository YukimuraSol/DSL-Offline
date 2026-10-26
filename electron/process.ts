import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import path from 'node:path'

export interface SpawnedProcessTracker {
  track(child: ChildProcess): void
}

/** 将命令参数格式化为可读、可复制的日志文本；不记录环境变量中的密钥。 */
export function formatCommandLine(executable: string, args: string[]): string {
  const quote = (value: string): string => {
    if (value.length === 0) return '""'
    if (!/[\s"&|<>^()%!]/.test(value)) return value
    return `"${value.replace(/"/g, '""')}"`
  }
  return [executable, ...args].map(quote).join(' ')
}

let processTracker: SpawnedProcessTracker | null = null
const localProcesses = new Set<ChildProcess>()

export function configureProcessTracker(tracker: SpawnedProcessTracker | null): void {
  processTracker = tracker
}

export function trackSpawnedProcess<T extends ChildProcess>(child: T): T {
  localProcesses.add(child)
  const forget = () => localProcesses.delete(child)
  child.once('exit', forget)
  child.once('error', forget)
  processTracker?.track(child)
  return child
}

/** 终止整个子进程树（Windows 用 taskkill /T /F，其他平台 SIGTERM）。 */
export async function killChildProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        killer.kill()
        resolve()
      }, 5_000)
      const finish = () => {
        clearTimeout(timeout)
        resolve()
      }
      killer.once('error', finish)
      killer.once('exit', finish)
    })
  } else {
    child.kill('SIGTERM')
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => resolve()
    child.once('exit', finish)
    child.once('error', finish)
  })
}

/**
 * 结束启动器自己创建的进程。监督器通常会先完成同样的工作；这里保留
 * 主进程中的句柄作为兜底，覆盖监督器启动较晚、通信丢失或窗口快速关闭的情况。
 */
export async function shutdownTrackedProcesses(): Promise<void> {
  const processes = [...localProcesses]
  await Promise.allSettled(processes.map(async child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      await waitForExit(killer)
      return
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // 子进程可能已经在监督器中被结束。
    }
    await waitForExit(child)
  }))
}

interface SpawnCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

function quoteWindowsBatchToken(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('命令参数不能包含换行或空字符。')
  return `"${value.replace(/"/g, '""')}"`
}

export function buildWindowsBatchCommand(executable: string, args: string[]): string {
  return `"${[executable, ...args].map(quoteWindowsBatchToken).join(' ')}"`
}

export function withExecutableDirectoryOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(executable)) return environment
  const executableDirectory = path.dirname(executable)
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const currentPath = environment[pathKey] ?? ''
  const alreadyIncluded = currentPath
    .split(path.delimiter)
    .some(entry => entry.toLowerCase() === executableDirectory.toLowerCase())
  if (alreadyIncluded) return environment
  return {
    ...environment,
    [pathKey]: currentPath ? `${executableDirectory}${path.delimiter}${currentPath}` : executableDirectory,
  }
}

/**
 * 实例启动命令 + 文件重定向，整段交给 cmd /c。
 * 返回值带**外层引号**：cmd /s 会剥掉最外那一对，剩下的
 * `"exe" "arg" >> "out" 2>> "err"` 才是真正执行的命令行。
 *
 * 为什么让 shell 做重定向、而不是把启动器打开的文件句柄继承给实例：
 * 继承句柄会让日志文件在实例运行期间被占住（外部以 FileShare.Read 打开会报
 * 「文件正由另一进程使用」）；cmd 追加写打开的文件允许别人同时读。
 */
export function buildWindowsRedirectedCommand(
  executable: string,
  args: string[],
  outLog: string,
  errLog: string,
): string {
  const command = [executable, ...args].map(quoteWindowsBatchToken).join(' ')
  return `"${command} >> ${quoteWindowsBatchToken(outLog)} 2>> ${quoteWindowsBatchToken(errLog)}"`
}

export interface DetachedLogSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** 实例 stdout / stderr 的追加写目标；重定向由 shell 完成，启动器不持有任何日志句柄。 */
  outLog: string
  errLog: string
}

/**
 * 起一个**不归启动器管**的实例子进程：
 * - 输出由 cmd 自己用 >> 重定向到日志文件，没有任何管道、启动器也不留句柄 ——
 *   启动器退出后实例照写，外部在实例运行期间能直接读这两个文件；
 * - 不登记给进程监督器：监督器那份 PID 清单里没有它，退出清理不会碰它；
 * - unref：父进程的事件循环不再等它，启动器关窗口能立刻退。
 *
 * **不加 detached:true**：Windows 的 DETACHED_PROCESS 会让 cmd 的子进程丢掉被重定向的
 * 句柄（cmd 自己的 echo 进得去，真正的实例输出全丢），实测在 detached 下日志只剩启动头。
 * 解耦靠的是「不登记、不杀」，不是这个 flag：非 detached 的子进程在启动器退出后照旧存活
 * （父进程退出不会带走子进程，实测 14s 持续写盘）。
 *
 * 瞬时子进程（装包/解压/更新器）仍然走 spawnCommand，照旧被 track 与清理。
 */
export function spawnDetachedLogged(
  executable: string,
  args: string[],
  options: DetachedLogSpawnOptions,
): ChildProcess {
  const environment = withExecutableDirectoryOnPath(executable, options.env)
  if (process.platform !== 'win32') {
    // 非 Windows 没有 cmd 重定向这条路，退回自持句柄（实例自己写，启动器退出也不受影响）。
    const outFd = openSync(options.outLog, 'a')
    const errFd = openSync(options.errLog, 'a')
    try {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: environment,
        detached: true,
        stdio: ['ignore', outFd, errFd],
      })
      child.unref()
      return child
    } finally {
      closeSync(outFd)
      closeSync(errFd)
    }
  }
  const child = spawn(environment.ComSpec || process.env.ComSpec || 'cmd.exe', [
    '/d', '/s', '/v:off', '/c',
    buildWindowsRedirectedCommand(executable, args, options.outLog, options.errLog),
  ], {
    cwd: options.cwd,
    env: environment,
    // windowsHide → CREATE_NO_WINDOW：cmd 和实例都不弹窗，启动器是 GUI 进程没有控制台可继承。
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: 'ignore',
  })
  // 不 unref 的话父进程的事件循环会等这个子进程退出；启动器关窗口就退不掉了。
  child.unref()
  return child
}

export function spawnCommand(
  executable: string,
  args: string[],
  options: SpawnCommandOptions,
): ChildProcessWithoutNullStreams {
  const environment = withExecutableDirectoryOnPath(executable, options.env)
  const isWindowsBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
  if (isWindowsBatch) {
    const commandInterpreter = environment.ComSpec || process.env.ComSpec || 'cmd.exe'
    return trackSpawnedProcess(spawn(commandInterpreter, [
      '/d',
      '/s',
      '/v:off',
      '/c',
      buildWindowsBatchCommand(executable, args),
    ], {
      ...options,
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
  }

  return trackSpawnedProcess(spawn(executable, args, {
    ...options,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }))
}
