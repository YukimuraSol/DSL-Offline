/**
 * 随安装包下发的 Node 运行时归档：`node-runtime-<版本>-win-<架构>.zip`。
 *
 * 为什么不直接把 vendor/node 塞进 extraResources：electron-builder 的 extraResources
 * 会**无条件剥掉 node_modules 目录**（见 scripts/fetch-node-runtime.mts 顶部实测），
 * 而 npm 就住在 node/node_modules/npm 里。剥掉之后随包的 Node 认得 node.exe 却不认得
 * npm，等于白带 100MB。打成归档就绕开了打包器的目录规则——解包由启动器自己在首启时做
 * （ensureNodeRuntime 的「归档」档）。
 *
 * 归档内部固定两个顶层目录，解包时按名字取：
 *   node/  官方发行包的内容（node.exe、npm.cmd、node_modules/npm…）
 *   pnpm/  托管 pnpm 根的内容（node_modules/pnpm、node_modules/.bin/pnpm.cmd）
 *
 * 文件名里的版本与架构是解压前唯一的可信标识：不比对的话，arm64 机器会拿到一份
 * x64 的 node.exe，症状是「Node 明明在，一跑就崩」。所以 find 只认完全匹配的那一个。
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeZipArchive, type ZipEntryInput } from './zip-writer'

export const BUNDLED_NODE_ARCHIVE_PREFIX = 'node-runtime-'

export type NodeArchiveArchitecture = 'x64' | 'arm64'

/** Node 官方只发这两种 Windows 包；其它架构按 x64 处理（与 node-runtime 的 nodeArchiveName 一致）。 */
export function archiveArchitecture(architecture: string = process.arch): NodeArchiveArchitecture {
  return architecture === 'arm64' ? 'arm64' : 'x64'
}

/** 版本容错：'24.19.0' 与 'v24.19.0' 指同一份归档。 */
function normalizeVersion(version: string): string {
  const trimmed = version.trim()
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

export function bundledNodeArchiveName(version: string, architecture: string = process.arch): string {
  return `${BUNDLED_NODE_ARCHIVE_PREFIX}${normalizeVersion(version)}-win-${archiveArchitecture(architecture)}.zip`
}

export interface BundledNodeArchive {
  path: string
  name: string
  size: number
  version: string
  architecture: NodeArchiveArchitecture
}

export interface BundledNodeArchiveLookup {
  /** 版本与架构都对得上的那份；没有就是 null。 */
  archive: BundledNodeArchive | null
  /** 因为版本或架构不符被跳过的文件名（拿来写日志，说明「为什么没解压」）。 */
  skipped: string[]
}

export function parseBundledNodeArchiveName(name: string): { version: string; architecture: NodeArchiveArchitecture } | null {
  const match = /^node-runtime-(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-(x64|arm64)\.zip$/i.exec(path.basename(name))
  if (!match) return null
  return {
    version: normalizeVersion(match[1]!),
    architecture: match[2]!.toLowerCase() === 'arm64' ? 'arm64' : 'x64',
  }
}

/**
 * 在归档目录里找当前构造对得上的那一份。
 * 目录不存在（开发态没跑过 scripts/build-node-archive.mts、或打包没带上）返回 null，
 * 让调用方安静地回落到联网下载——缺归档不是错误。
 */
export async function findBundledNodeArchive(
  root: string | null | undefined,
  version: string,
  architecture: string = process.arch,
): Promise<BundledNodeArchiveLookup> {
  if (!root) return { archive: null, skipped: [] }
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
      .map(entry => entry.name)
      .sort()
  } catch {
    return { archive: null, skipped: [] }
  }
  const wantedVersion = normalizeVersion(version)
  const wantedArchitecture = archiveArchitecture(architecture)
  const skipped: string[] = []
  for (const name of names) {
    const parsed = parseBundledNodeArchiveName(name)
    if (!parsed) continue
    if (parsed.version !== wantedVersion || parsed.architecture !== wantedArchitecture) {
      skipped.push(name)
      continue
    }
    const filePath = path.join(root, name)
    const info = await stat(filePath).catch(() => null)
    if (!info || info.size === 0) {
      skipped.push(name)
      continue
    }
    return {
      archive: { path: filePath, name, size: info.size, version: parsed.version, architecture: parsed.architecture },
      skipped,
    }
  }
  return { archive: null, skipped }
}

/** 归档内的顶层目录名；解包时按这个取。 */
export const NODE_ARCHIVE_NODE_DIRECTORY = 'node'
export const NODE_ARCHIVE_PNPM_DIRECTORY = 'pnpm'

/** 递归收集一棵树的文件条目（zip 里必须用正斜杠；符号链接不跟随也不写入）。 */
async function collectDirectoryEntries(root: string, prefix: string, level: number): Promise<ZipEntryInput[]> {
  const entries: ZipEntryInput[] = []
  const stack: string[] = ['']
  while (stack.length > 0) {
    const relative = stack.pop()!
    const absolute = relative ? path.join(root, relative) : root
    const items = await readdir(absolute, { withFileTypes: true })
    for (const item of items) {
      const childRelative = relative ? path.join(relative, item.name) : item.name
      if (item.isDirectory()) {
        stack.push(childRelative)
        continue
      }
      // 解出来的运行时里 srv 之类的特殊文件没有意义，跟随链接还可能把归档撑成无限大。
      if (!item.isFile()) continue
      entries.push({
        name: `${prefix}/${childRelative.split(path.sep).join('/')}`,
        source: path.join(root, childRelative),
        level,
      })
    }
  }
  return entries
}

export interface WriteNodeRuntimeArchiveOptions {
  /** 产物路径（调用方自己保证先写 .partial 再改名）。 */
  outputPath: string
  /** vendor/node：官方发行包内容。 */
  nodeRoot: string
  /** vendor/pnpm：托管 pnpm 根的内容。 */
  pnpmRoot: string
  /** deflate 档位；node_modules 基本是文本，6 与 9 的体积差不到 1%，但 9 慢一倍。 */
  level?: number
  onBytes?: (bytes: number) => void
}

/** 打包期用：把 vendor/node 与 vendor/pnpm 写成一个归档。 */
export async function writeNodeRuntimeArchive(options: WriteNodeRuntimeArchiveOptions): Promise<{ entries: number; sourceBytes: number; archiveBytes: number }> {
  const level = options.level ?? 6
  const nodeEntries = await collectDirectoryEntries(options.nodeRoot, NODE_ARCHIVE_NODE_DIRECTORY, level)
  const pnpmEntries = await collectDirectoryEntries(options.pnpmRoot, NODE_ARCHIVE_PNPM_DIRECTORY, level)
  if (nodeEntries.length === 0) throw new Error(`归档源目录是空的：${options.nodeRoot}`)
  if (pnpmEntries.length === 0) throw new Error(`归档源目录是空的：${options.pnpmRoot}`)
  await mkdir(path.dirname(options.outputPath), { recursive: true })
  // node.exe 有 90MB，排在最后让前面的小文件先落盘（写入器按顺序处理，大文件会独占一段）。
  const entries = [...nodeEntries, ...pnpmEntries].sort((left, right) => {
    if (left.name === 'node/node.exe') return 1
    if (right.name === 'node/node.exe') return -1
    return left.name.localeCompare(right.name, 'en')
  })
  return writeZipArchive(options.outputPath, entries, { onBytes: options.onBytes })
}
