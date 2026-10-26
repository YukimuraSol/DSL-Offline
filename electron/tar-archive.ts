// npm 兼容的 tar.gz 归档：ustar 头 + gzip。
//
// 为什么自己写：离线导出要 `vendor/<name>-<version>.tgz`，而 npm pack 会按 package.json 的
// `files` 裁剪——实测 dsh-colombia-skin 的 files 只列 3 个文件，本体却有 107 MB 资源，
// 走 npm pack 打出来的包必然缺料。这里按磁盘上的真实内容打包（脏目录剔除在调用方做）。
//
// 仓库原本只有 zip-writer（自写 zip），tgz 没有现成的；不引第三方 tar 依赖，也不调用
// 系统 tar.exe（Windows 上并不保证存在、且不吃我们自己的剔除规则）。

import { gunzipSync, gzipSync } from 'node:zlib'

export interface TarEntry {
  /** 归档内路径，正斜杠，不含前导 ./ */
  path: string
  type: 'file' | 'directory'
  data?: Buffer
  /** 八进制权限位，默认文件 0644、目录 0755 */
  mode?: number
  /** 默认 0：固定时间戳让同一份内容打出同一份 tgz（便于复验） */
  mtime?: number
}

export interface TarReadEntry {
  path: string
  type: 'file' | 'directory'
  size: number
  data: Buffer
}

const BLOCK = 512

/** 八进制数字段：长度 length 的字段写 length-1 位八进制 + NUL。 */
function padOctal(value: number, length: number): Buffer {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0')
  return Buffer.from(`${text}\0`, 'ascii')
}

/**
 * ustar 的 name 只有 100 字节、prefix 只有 155 字节。短路径直接放 name；
 * 长了就从右往左切一刀，让后半截进 name、前半截进 prefix。
 */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' }
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== '/') continue
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      return { name, prefix }
    }
  }
  throw new Error(`归档路径超过 ustar 上限（name 100 / prefix 155 字节）：${path}`)
}

function buildHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK)
  const { name, prefix } = splitName(entry.path)
  header.write(name, 0, 100, 'utf8')
  padOctal(entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644), 8).copy(header, 100)
  padOctal(0, 8).copy(header, 108) // uid：不带机主身份
  padOctal(0, 8).copy(header, 116) // gid
  padOctal(size, 12).copy(header, 124)
  padOctal(entry.mtime ?? 0, 12).copy(header, 136)
  // 校验和字段先填 8 个空格，算完再写回（ustar 规定的算法）。
  header.fill(0x20, 148, 156)
  header.write(entry.type === 'directory' ? '5' : '0', 156, 1, 'ascii')
  header.write('ustar', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'ascii')
  header.write('root', 297, 32, 'ascii')
  padOctal(0, 8).copy(header, 329) // devmajor
  padOctal(0, 8).copy(header, 337) // devminor
  header.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

function padToBlock(buffer: Buffer): Buffer {
  const remainder = buffer.length % BLOCK
  if (remainder === 0) return buffer
  return Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder)])
}

/** 打包成 gzip 压缩的 tar；输入顺序即归档顺序。 */
export function writeTarGz(entries: TarEntry[], level = 6): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.type === 'file' ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0)
    chunks.push(buildHeader(entry, data.length))
    if (data.length > 0) chunks.push(padToBlock(data))
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(chunks), { level })
}

/** 读回 tar.gz。只认本模块写出的那几种头（ustar 文件/目录，附带兼容 GNU 长名与 pax 跳过）。 */
export function readTarGz(archive: Buffer): TarReadEntry[] {
  const buffer = gunzipSync(archive)
  const entries: TarReadEntry[] = []
  let offset = 0
  let pendingLongName = ''
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (header.every(byte => byte === 0)) break
    const verifySum = parseTarNumber(header, 148, 8)
    let computed = 0
    for (let index = 0; index < header.length; index += 1) {
      computed += index >= 148 && index < 156 ? 0x20 : header[index]
    }
    if (verifySum !== computed) {
      throw new Error(`tar 头校验和不符（偏移 ${offset - BLOCK}）：${verifySum} != ${computed}`)
    }
    const name = readTarText(header, 0, 100)
    const prefix = readTarText(header, 345, 155)
    const size = parseTarNumber(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const dataEnd = offset + size
    if (dataEnd > buffer.length) throw new Error('tar 归档被截断')
    if (typeflag === 'L') {
      pendingLongName = buffer.subarray(offset, dataEnd).toString('utf8').replace(/\0+$/, '')
      offset = dataEnd + ((BLOCK - (dataEnd % BLOCK)) % BLOCK)
      continue
    }
    // pax（x/g）只用来携带扩展属性，本模块不写；跳过数据体。
    if (typeflag === 'x' || typeflag === 'g') {
      offset = dataEnd + ((BLOCK - (dataEnd % BLOCK)) % BLOCK)
      continue
    }
    const path = pendingLongName || (prefix ? `${prefix}/${name}` : name)
    pendingLongName = ''
    const data = buffer.subarray(offset, dataEnd)
    offset = dataEnd + ((BLOCK - (dataEnd % BLOCK)) % BLOCK)
    if (typeflag === '5') {
      entries.push({ path: path.replace(/\/+$/, ''), type: 'directory', size: 0, data: Buffer.alloc(0) })
      continue
    }
    entries.push({ path, type: 'file', size, data: Buffer.from(data) })
  }
  return entries
}

function readTarText(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function parseTarNumber(header: Buffer, start: number, length: number): number {
  const text = readTarText(header, start, length).trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}
