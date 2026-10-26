import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * 实例日志落盘。
 *
 * 解耦之后启动器不再持有实例的 stdout/stderr 管道，也不再继承文件句柄：
 * 重定向由 cmd 自己做（>> / 2>>），启动器退出不影响实例写盘，外部也能在
 * 实例运行期间直接读这两个文件（继承句柄会把文件占住）。
 * 位置固定：<整合包家目录>\\logs\\launcher.out.log 与 launcher.err.log。
 */

/** 单份日志的轮转阈值：超过就把旧文件改名成 .1，只留一份。 */
export const LOG_ROTATE_BYTES = 8 * 1024 * 1024
/** 一次轮询最多读这么多，避免刚起来时一口气把几 MB 全塞进 UI。 */
const TAIL_CHUNK_BYTES = 256 * 1024

export interface InstanceLogFiles {
  directory: string
  out: string
  err: string
}

export function instanceLogFiles(homePath: string): InstanceLogFiles {
  const directory = path.join(homePath, 'logs')
  return {
    directory,
    out: path.join(directory, 'launcher.out.log'),
    err: path.join(directory, 'launcher.err.log'),
  }
}

/** 超过 limit 就把旧文件改名成 .1（覆盖上一份 .1）。失败不抛：日志写不进去不该挡启动。 */
export function rotateLogIfNeeded(file: string, limit = LOG_ROTATE_BYTES): void {
  try {
    if (!existsSync(file) || statSync(file).size < limit) return
    rmSync(`${file}.1`, { force: true })
    renameSync(file, `${file}.1`)
  } catch {
    // 轮转失败就是这一份继续变大，比把实例拦在启动门槛外好。
  }
}

/**
 * 往日志里追加一行启动器自己的话（启动头、退出脚注）。
 * DSH web 稳态不往 stdout 写东西，这两行是这份文件里唯一必然出现的内容，
 * 也是判断「这行之前是上一轮」的依据。失败不抛。
 */
export function appendLogLine(file: string, text: string): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, text, 'utf8')
  } catch {
    // 日志写不进去不该影响启动或退出。
  }
}

export interface LogTail {
  stop(): void
}

/**
 * 轮询读取文件追加的内容。启动器不再持有管道，但「输出」面板与地址识别还要用日志，
 * 所以统一改成 tail 这个文件。轮询而不是 fs.watch：Windows 上 watch 对「另一个进程追加」
 * 的事件不总可靠，400ms 一轮的读取代价可以忽略。
 */
export function tailLogFile(file: string, onText: (text: string) => void, intervalMs = 400): LogTail {
  let offset = 0
  try {
    offset = existsSync(file) ? statSync(file).size : 0
  } catch {
    offset = 0
  }
  const timer = setInterval(() => {
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      return
    }
    // 被轮转或清空：从头再读，别把新内容当旧内容跳过。
    if (size < offset) offset = 0
    if (size === offset) return
    const length = Math.min(size - offset, TAIL_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    let fd = -1
    try {
      fd = openSync(file, 'r')
      const read = readSync(fd, buffer, 0, length, offset)
      if (read > 0) {
        offset += read
        onText(buffer.subarray(0, read).toString('utf8'))
      }
    } catch {
      // 读不到就等下一轮。
    } finally {
      if (fd >= 0) closeSync(fd)
    }
  }, intervalMs)
  timer.unref?.()
  return { stop() { clearInterval(timer) } }
}

/** 读日志末尾的一小段：启动器冷启动时靠它把「在跑的实例」的 Web 地址找回来。 */
export function readLogTail(file: string, bytes = 64 * 1024): string {
  let fd = -1
  try {
    const size = statSync(file).size
    const length = Math.min(size, bytes)
    if (length <= 0) return ''
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, size - length)
    return read > 0 ? buffer.subarray(0, read).toString('utf8') : ''
  } catch {
    return ''
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}
