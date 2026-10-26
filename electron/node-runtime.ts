import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findBundledNodeArchive, type BundledNodeArchive } from './node-archive'
import { formatCommandLine, spawnCommand, trackSpawnedProcess, withExecutableDirectoryOnPath } from './process'
import { npmRegistryCandidates } from './proxy'

export const NODE_RUNTIME_VERSION = 'v24.19.0'
export const PNPM_VERSION = '11.21.0'

/**
 * 允许启动器使用的最低 Node 版本。
 *
 * 取证（2026-09-22，registry 实测）：pnpm@11.21.0 的 `engines.node` 是 `>=22.13`，
 * 这是硬约束——低于它 pnpm 直接以退出码 1 结束，用户看到的就是「DSH 安装失败（代码 1）」。
 * DSH 本体包（@deepseek-ai/dsh@0.1.5-rc.2）与核心组合层（dsh-base / cordis / dsh-acp-app）
 * 都没有声明 `engines`，所以门槛只由 pnpm 决定。升级 PNPM_VERSION 时必须重新核对该值。
 */
export const MIN_NODE_VERSION = '22.13.0'

/** 探测本机 node 的超时：拿不到版本就当不达标，不能因此卡住启动。 */
const NODE_VERSION_PROBE_TIMEOUT_MS = 3_000

/** Node 官方发行包根目录，也是 SHASUMS256.txt 的唯一权威来源。 */
export const NODE_DIST_OFFICIAL_BASE = 'https://nodejs.org/dist'
/**
 * 大陆可用的发行包镜像。顺序按 2026-09-22 本机实测（各取同一段 4MB）：
 * huaweicloud 6.3MB/s、npmmirror 4.4MB/s、nodejs.org 1.7MB/s——两处镜像都比直连官方快 2.5 倍以上。
 * npmmirror 放前面是为了和设置里默认的 npm 镜像保持一致（huaweicloud 紧随其后，第一个源挂了才轮到它）。
 */
const NODE_DIST_MIRROR_BASES: readonly string[] = [
  'https://registry.npmmirror.com/-/binary/node',
  'https://mirrors.huaweicloud.com/nodejs',
]

/** 35MB 的包走 nodejs.org 直连在大陆常慢到超时，所以下载源把镜像排在前面。 */
export function nodeArchiveBaseUrls(version: string = NODE_RUNTIME_VERSION): string[] {
  const normalized = normalizeNodeVersion(version)
  return [...NODE_DIST_MIRROR_BASES, NODE_DIST_OFFICIAL_BASE].map(base => `${base}/${normalized}`)
}

/**
 * 校验清单的源却要把官方放最前：镜像的 SHASUMS256.txt 和它自己的 zip 出自同一台机器，
 * 拿它校验同源下载下来的文件等于没校验。只有官方清单取不到时才退到镜像——那种情况
 * 至少还拦得住"传到一半断了"，并且在日志里说明信任级别降了。
 * （2026-09-22 实测三处的 SHASUMS256.txt 逐字节相同，所以退回镜像不是因为镜像会滞后。）
 */
export function nodeChecksumBaseUrls(version: string = NODE_RUNTIME_VERSION): string[] {
  const normalized = normalizeNodeVersion(version)
  return [`${NODE_DIST_OFFICIAL_BASE}/${normalized}`, ...NODE_DIST_MIRROR_BASES.map(base => `${base}/${normalized}`)]
}

/** 读一次 SHASUMS256.txt 的超时：宁可换下一个源，也不能让「准备运行环境」卡死在这一步。 */
const NODE_CHECKSUM_TIMEOUT_MS = 8_000

/** 从 URL 里取个短名字放进日志和进度文案，失败也不该因此让下载报错。 */
function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface NodeRuntime {
  root: string
  node: string
  npm: string
  npx: string
  managed: boolean
  /**
   * 这份 Node 从哪来——失败提示要告诉用户该去关哪个开关，光有 managed 分不出
   * 「随包自带」和「下载来的托管版本」。旧数据可能没有，读时用 unknown 兜底。
   */
  origin?: 'bundled' | 'managed' | 'system'
}

export interface PnpmRuntime {
  root: string
  executable: string
}

export interface NodeRuntimeProgress {
  percent: number
  message: string
  downloadedBytes?: number
  totalBytes?: number
}

type ProgressListener = (progress: NodeRuntimeProgress) => void
type OutputListener = (level: 'info' | 'error', text: string) => void

/** 同一版本只允许一个下载任务；不同版本可以并行准备。 */
const installationPromises = new Map<string, Promise<NodeRuntime>>()
let pnpmInstallationPromise: Promise<PnpmRuntime> | null = null

/**
 * 可执行文件相对于 root 的两种摆放方式。
 *
 * - `bin-directory`：root 本身就是存放可执行文件的目录，例如 PATH 里的 `/usr/bin`。
 * - `distribution-root`：root 是官方发行包解压后的根目录，例如 `node-v24.19.0-linux-x64/`。
 *
 * Windows 上两者一致（zip 与 PATH 目录都是三个文件平铺）；
 * POSIX 上发行包把可执行文件放在 `bin/` 子目录里，差一层。
 */
type RuntimeLayout = 'bin-directory' | 'distribution-root'

export function runtimePaths(root: string, managed: boolean, layout: RuntimeLayout): NodeRuntime {
  if (process.platform === 'win32') {
    return {
      root,
      node: path.join(root, 'node.exe'),
      npm: path.join(root, 'npm.cmd'),
      npx: path.join(root, 'npx.cmd'),
      managed,
    }
  }
  const binary = layout === 'distribution-root' ? path.join(root, 'bin') : root
  return {
    root,
    node: path.join(binary, 'node'),
    npm: path.join(binary, 'npm'),
    npx: path.join(binary, 'npx'),
    managed,
  }
}

function isCompleteRuntime(runtime: NodeRuntime): boolean {
  return existsSync(runtime.node) && existsSync(runtime.npm) && existsSync(runtime.npx)
}

export function pnpmExecutable(runtimeRoot: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, 'node_modules', '.bin', 'pnpm.cmd')
    : path.join(runtimeRoot, 'node_modules', '.bin', 'pnpm')
}

function isCompletePnpmRuntime(runtime: PnpmRuntime): boolean {
  return existsSync(runtime.executable)
}

async function hasRequiredPnpmVersion(runtime: PnpmRuntime): Promise<boolean> {
  if (!isCompletePnpmRuntime(runtime)) return false
  try {
    const manifestPath = path.join(runtime.root, 'node_modules', 'pnpm', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
    return manifest.version === PNPM_VERSION
  } catch {
    return false
  }
}

/** PATH 上结构完整的本机 Node 候选（按 PATH 顺序，Program Files 视为最前）。 */
export function systemNodeCandidates(environment: NodeJS.ProcessEnv = process.env): NodeRuntime[] {
  const entries = (environment.PATH ?? environment.Path ?? environment.path ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  if (process.platform === 'win32') {
    entries.unshift(path.join(environment.ProgramFiles ?? 'C:\\Program Files', 'nodejs'))
  }
  const candidates: NodeRuntime[] = []
  for (const entry of entries) {
    // PATH 里的每一项本身就是可执行文件所在的目录。
    const runtime = runtimePaths(entry.replace(/^"|"$/g, ''), false, 'bin-directory')
    if (isCompleteRuntime(runtime)) candidates.push({ ...runtime, origin: 'system' })
  }
  return candidates
}

export function findSystemNodeRuntime(environment: NodeJS.ProcessEnv = process.env): NodeRuntime | null {
  return systemNodeCandidates(environment)[0] ?? null
}

/**
 * 比较 Node 版本号（`22.13`、`v22.13.0`、`24.0.0-rc.1` 都收）。
 * 缺省的段按 0 补：门槛写成 `22.13` 也能正确判定。
 */
export function nodeVersionAtLeast(version: string, minimum: string = MIN_NODE_VERSION): boolean {
  const parse = (value: string): { parts: number[]; prerelease: boolean } | null => {
    if (typeof value !== 'string') return null
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?/.exec(value.trim())
    if (!match) return null
    return {
      parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
      prerelease: value.includes('-'),
    }
  }
  const floor = parse(minimum)
  // 门槛本身写错时不该把用户全挡在外面。
  if (!floor) return true
  const actual = parse(version)
  if (!actual) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual.parts[index] !== floor.parts[index]) return actual.parts[index]! > floor.parts[index]!
  }
  // 同版本号时预发布版算低于正式版。
  return !actual.prerelease || floor.prerelease
}

const versionProbeCache = new Map<string, Promise<string | null>>()

/** 探一个 node 可执行文件的真实版本；超时或异常一律 null（视为不达标）。 */
export function probeNodeVersion(nodeExecutable: string): Promise<string | null> {
  const key = path.resolve(nodeExecutable)
  const cached = versionProbeCache.get(key)
  if (cached) return cached
  const probe = new Promise<string | null>(resolve => {
    execFile(
      key,
      ['-p', 'process.versions.node'],
      { timeout: NODE_VERSION_PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const text = stdout.trim().replace(/^v/, '')
        resolve(/^\d+\.\d+\.\d+/.test(text) ? text : null)
      },
    )
  })
  versionProbeCache.set(key, probe)
  return probe
}

/** 版本达标的本机 Node。不达标的候选（含探不到版本的）一律不采用。 */
export async function findQualifiedSystemNodeRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  minimum: string = MIN_NODE_VERSION,
  probe: (nodeExecutable: string) => Promise<string | null> = probeNodeVersion,
): Promise<NodeRuntime | null> {
  for (const candidate of systemNodeCandidates(environment)) {
    const version = await probe(candidate.node)
    if (version && nodeVersionAtLeast(version, minimum)) return candidate
  }
  return null
}

export function normalizeNodeVersion(version: string): string {
  const normalized = version.trim()
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

export function managedNodeVersionRoot(runtimeRoot: string, version: string): string {
  return path.join(runtimeRoot, 'versions', normalizeNodeVersion(version))
}

export function nodeArchiveName(versionOrArchitecture = NODE_RUNTIME_VERSION, architecture = process.arch): string {
  // 保留旧的 nodeArchiveName('x64') 调用约定，同时支持 nodeArchiveName('v22.14.0', 'x64')。
  const isArchitecture = versionOrArchitecture === 'x64' || versionOrArchitecture === 'arm64'
  const version = isArchitecture ? NODE_RUNTIME_VERSION : versionOrArchitecture
  const selectedArchitecture = isArchitecture ? versionOrArchitecture : architecture
  const archiveArchitecture = selectedArchitecture === 'arm64' ? 'arm64' : 'x64'
  return `node-${normalizeNodeVersion(version)}-win-${archiveArchitecture}.zip`
}

export function parseNodeArchiveChecksum(checksums: string, archiveName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (match?.[2] === archiveName) return match[1].toLowerCase()
  }
  return null
}

function versionFromNodeDirectory(directory: string): string | null {
  const match = directory.match(/^node-(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-(?:x64|arm64)$/i)
  return match ? normalizeNodeVersion(match[1]) : null
}

export interface ManagedNodeVersion {
  version: string
  runtime: NodeRuntime
  root: string
  source: 'launcher' | 'legacy'
}

export async function findManagedNodeRuntimes(runtimeRoot: string): Promise<ManagedNodeVersion[]> {
  if (!existsSync(runtimeRoot)) return []
  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  const roots: Array<{ root: string; source: 'launcher' | 'legacy' }> = []
  const versionsRoot = path.join(runtimeRoot, 'versions')
  const versionEntries = await readdir(versionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of versionEntries) {
    if (entry.isDirectory()) roots.push({ root: path.join(versionsRoot, entry.name), source: 'launcher' })
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('node-v')) roots.push({ root: path.join(runtimeRoot, entry.name), source: 'legacy' })
  }
  const found: ManagedNodeVersion[] = []
  for (const item of roots) {
    const runtime = runtimePaths(item.root, true, 'distribution-root')
    const version = item.source === 'launcher'
      ? (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i.test(path.basename(item.root)) ? normalizeNodeVersion(path.basename(item.root)) : null)
      : versionFromNodeDirectory(path.basename(item.root))
    if (version && isCompleteRuntime(runtime)) found.push({ version, runtime, root: item.root, source: item.source })
  }
  return found.sort((left, right) => right.version.localeCompare(left.version, 'en'))
}

export async function findManagedNodeRuntime(runtimeRoot: string, requestedVersion?: string | null): Promise<NodeRuntime | null> {
  const runtimes = await findManagedNodeRuntimes(runtimeRoot)
  if (requestedVersion) {
    const normalized = normalizeNodeVersion(requestedVersion)
    return runtimes.find(item => item.version === normalized)?.runtime ?? null
  }
  return runtimes[0]?.runtime ?? null
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadFile(url: string, target: string, onProgress: (ratio: number, downloadedBytes: number, totalBytes: number | null) => void): Promise<void> {
  const existingSize = existsSync(target) ? (await stat(target)).size : 0
  const response = await fetch(url, {
    redirect: 'follow',
    headers: existingSize > 0 ? { Range: `bytes=${existingSize}-` } : undefined,
  })
  if (response.status === 416 && existingSize > 0) {
    onProgress(1, existingSize, existingSize)
    return
  }
  if (!response.ok || !response.body) throw new Error(`下载 Node.js 运行环境失败（HTTP ${response.status}）。`)
  const resumed = response.status === 206 && existingSize > 0
  const contentLength = Number(response.headers.get('content-length'))
  const contentRange = response.headers.get('content-range')
  const rangeTotal = contentRange ? Number(contentRange.split('/').at(-1)) : Number.NaN
  const total = Number.isFinite(rangeTotal) ? rangeTotal : (resumed ? existingSize : 0) + contentLength
  const file = await open(target, resumed ? 'a' : 'w')
  let received = resumed ? existingSize : 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await file.write(chunk)
      received += chunk.byteLength
      onProgress(
        Number.isFinite(total) && total > 0 ? Math.min(received / total, 1) : 0,
        received,
        Number.isFinite(total) && total > 0 ? total : null,
      )
    }
  } finally {
    await file.close()
  }
}

/**
 * 逐个源试读 SHASUMS256.txt，返回第一个能解析出当前安装包的 SHA256。
 * 全部读不到才报错——绝不能"没有校验信息就照样装"。
 */
async function readNodeArchiveChecksum(
  archiveName: string,
  bases: string[],
  onOutput?: OutputListener,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const failures: string[] = []
  const officialHost = urlHost(NODE_DIST_OFFICIAL_BASE)
  for (const base of bases) {
    const host = urlHost(base)
    const url = `${base}/SHASUMS256.txt`
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(NODE_CHECKSUM_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const checksum = parseNodeArchiveChecksum(await response.text(), archiveName)
      if (!checksum) throw new Error('清单里没有当前 Windows 安装包')
      if (host !== officialHost) {
        onOutput?.('info', `官方校验清单不可用，改用镜像 ${host} 的清单（只能保证传输完整，不能保证来源可信）。`)
      }
      return checksum
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${host}：${reason}`)
      onOutput?.('error', `读取 ${url} 失败：${reason}`)
    }
  }
  throw new Error(`读取 Node.js 校验信息失败（${failures.join('；')}）。`)
}

/** 记下 zip 是哪个源写的：换源时必须先把上一个源的残留删掉，见 downloadVerifiedNodeArchive。 */
async function ensureArchiveBelongsToSource(archivePath: string, markerPath: string, base: string): Promise<void> {
  const previous = await readFile(markerPath, 'utf8').catch(() => null)
  if (previous?.trim() === base) return
  await rm(archivePath, { force: true })
  await writeFile(markerPath, base, 'utf8')
}

/**
 * 按候选源下载发行包，直到某个源的产物能通过 expectedChecksum。
 *
 * 两条规则：
 * - **绝不跨源续传**。downloadFile 支持 Range 续传，但把 A 源的半截和 B 源的偏移量拼起来
 *   必然过不了 SHA256，而报错长得像"下载损坏"，很难查。所以换源前靠 `.source` 旁记文件
 *   判断残留属于谁，不属于当前源就先删。
 * - 校验只认内容：本地已有的包只要 SHA256 对得上就直接用，不管它是哪年哪个源下的。
 */
export async function downloadVerifiedNodeArchive(options: {
  archivePath: string
  markerPath: string
  bases: string[]
  archiveName: string
  expectedChecksum: string
  onProgress?: (ratio: number, downloadedBytes: number, totalBytes: number | null, source: string) => void
  onOutput?: OutputListener
  download?: typeof downloadFile
  checksumOf?: (filePath: string) => Promise<string>
}): Promise<void> {
  const { archivePath, markerPath, bases, archiveName, expectedChecksum } = options
  const checksumOf = options.checksumOf ?? sha256
  const download = options.download ?? downloadFile
  if (existsSync(archivePath) && await checksumOf(archivePath) === expectedChecksum) return

  const failures: string[] = []
  for (const base of bases) {
    const source = urlHost(base)
    await ensureArchiveBelongsToSource(archivePath, markerPath, base)
    try {
      await download(`${base}/${archiveName}`, archivePath, (ratio, downloadedBytes, totalBytes) => {
        options.onProgress?.(ratio, downloadedBytes, totalBytes, source)
      })
      if (await checksumOf(archivePath) === expectedChecksum) return
      failures.push(`${source}：安装包校验不匹配`)
      options.onOutput?.('error', `从 ${source} 下载的 Node.js 安装包校验不匹配，换下一个源。`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${source}：${reason}`)
      options.onOutput?.('error', `从 ${source} 下载失败：${reason}`)
    }
  }
  await rm(archivePath, { force: true })
  throw new Error(`下载 Node.js 运行环境失败（已试 ${failures.join('；')}）。`)
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

/**
 * 解压一律用 Windows 自带 bsdtar 的绝对路径。裸 `tar.exe` 会先命中 Git Bash / MSYS
 * 的 /usr/bin/tar，它读不懂 `C:\…`（报 "Cannot connect to C: resolve failed"），
 * 从 MSYS 终端里启动启动器的人就会卡在「准备 Node 运行环境」这一步。
 */
function systemTarExecutable(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.join(windowsRoot, 'System32', 'tar.exe')
}

export async function installManagedNodeRuntime(
  runtimeRoot: string,
  version = NODE_RUNTIME_VERSION,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
): Promise<NodeRuntime> {
  if (process.platform !== 'win32') {
    throw new Error('未检测到 Node.js。自动准备运行环境目前仅支持 Windows。')
  }

  const normalizedVersion = normalizeNodeVersion(version)
  const archiveName = nodeArchiveName(normalizedVersion)
  const extractedName = archiveName.slice(0, -4)
  const finalRoot = managedNodeVersionRoot(runtimeRoot, normalizedVersion)
  const existing = runtimePaths(finalRoot, true, 'distribution-root')
  if (isCompleteRuntime(existing)) return existing

  const nonce = `${process.pid}-${Date.now()}`
  const archivePath = path.join(runtimeRoot, archiveName)
  const archiveSourceMarker = `${archivePath}.source`
  const stagingRoot = path.join(runtimeRoot, `.node-runtime-${nonce}`)
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(path.dirname(finalRoot), { recursive: true })
  await mkdir(stagingRoot, { recursive: true })

  try {
    onProgress?.({ percent: 3, message: '正在读取 Node.js 校验信息' })
    const expectedChecksum = await readNodeArchiveChecksum(archiveName, nodeChecksumBaseUrls(normalizedVersion), onOutput)

    let lastTick = ''
    await downloadVerifiedNodeArchive({
      archivePath,
      markerPath: archiveSourceMarker,
      bases: nodeArchiveBaseUrls(normalizedVersion),
      archiveName,
      expectedChecksum,
      onOutput,
      onProgress: (ratio, downloadedBytes, totalBytes, source) => {
        const percent = 8 + Math.round(ratio * 67)
        // 换源时百分比可能原地不动甚至倒退，那也要发出去——否则用户看到的是一条
        // 停住的进度条，而实际正在从第二个源重下。
        if (`${source}:${percent}` !== lastTick) {
          lastTick = `${source}:${percent}`
          onProgress?.({ percent, message: `正在下载 Node.js ${normalizedVersion}（${source}）`, downloadedBytes, totalBytes: totalBytes ?? undefined })
        }
      },
    })
    onProgress?.({ percent: 78, message: '正在校验 Node.js 安装包' })

    onProgress?.({ percent: 84, message: '正在解压 Node.js 运行环境' })
    const tarExecutable = systemTarExecutable()
    const extractor = trackSpawnedProcess(spawn(tarExecutable, ['-xf', archivePath, '-C', stagingRoot], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    onOutput?.('info', `命令：${formatCommandLine(tarExecutable, ['-xf', archivePath, '-C', stagingRoot])}\n工作目录：${runtimeRoot}`)
    let extractionError = ''
    extractor.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
    extractor.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      extractionError += text
      onOutput?.('error', text)
    })
    const exitCode = await waitForExit(extractor)
    onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
    if (exitCode !== 0) throw new Error(`解压 Node.js 运行环境失败：${extractionError.trim() || `代码 ${exitCode}`}`)

    const stagedRoot = path.join(stagingRoot, extractedName)
    const stagedRuntime = runtimePaths(stagedRoot, true, 'distribution-root')
    if (!isCompleteRuntime(stagedRuntime)) throw new Error('Node.js 运行环境解压后文件不完整。')
    await rm(finalRoot, { recursive: true, force: true })
    await rename(stagedRoot, finalRoot)
    const installed = runtimePaths(finalRoot, true, 'distribution-root')
    await rm(archivePath, { force: true })
    await rm(archiveSourceMarker, { force: true })
    onProgress?.({ percent: 100, message: `Node.js ${normalizedVersion} 已就绪` })
    return installed
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface NodeRuntimeSelection {
  /** 开发态的随包目录 vendor/node（打包态没有，见 main.ts 的说明）。 */
  bundledRoot?: string | null
  /** 安装包内的归档目录：打包态 `<resourcesPath>/node-archive`，开发态 `runtime/`。 */
  archiveRoot?: string | null
  /** 从归档补齐时顺带铺开的托管 pnpm 根，省掉首启那一次联网装 pnpm。 */
  pnpmRuntimeRoot?: string | null
  /** 覆盖 PATH 来源，供测试注入。 */
  environment?: NodeJS.ProcessEnv
  /** 覆盖版本探测，供测试固定结果；默认走真实 probeNodeVersion。 */
  probeVersion?: (nodeExecutable: string) => Promise<string | null>
  /** 覆盖最后一档的联网安装，供测试注入（否则每条用例都要真下 35MB）。 */
  installRuntime?: (
    runtimeRoot: string,
    version: string,
    onProgress?: ProgressListener,
    onOutput?: OutputListener,
  ) => Promise<NodeRuntime>
}

/** 随包/托管目录在 POSIX 下把可执行文件放在 bin/，Windows 下平铺（runtimePaths 会忽略）。 */
const DISTRIBUTION_LAYOUT: RuntimeLayout = 'distribution-root'

/** 日志前缀固定，装机后从日志里就能看出这一轮走的是哪条路。 */
const NODE_RUNTIME_LOG_PREFIX = '[node-runtime]'

function logStep(onOutput: OutputListener | undefined, text: string): void {
  onOutput?.('info', `${NODE_RUNTIME_LOG_PREFIX} ${text}`)
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 结构完整且版本达标的现成 runtime 才敢直接用（随包内容可能与常量漂移）。 */
async function usableRuntime(
  runtime: NodeRuntime,
  probe: (nodeExecutable: string) => Promise<string | null>,
): Promise<boolean> {
  if (!isCompleteRuntime(runtime)) return false
  /**
   * npm 必须按文件确认，不能只看 npm.cmd 在不在：少一个 npm 的「完整」Node 会让后面
   * 装 pnpm 那步直接失败。归档里那份是完整的，但如果解包被打断（磁盘满、杀软隔离），
   * 留下的半成品就是这种形状，所以这道检查对归档来源同样有意义。
   */
  if (!existsSync(path.join(runtime.root, 'node_modules', 'npm', 'package.json'))) return false
  const version = await probe(runtime.node)
  return version !== null && nodeVersionAtLeast(version)
}

/**
 * 从安装包内的归档解出 Node 运行时。原子性靠「先解到 versions/.node-archive-<nonce>，
 * 校验通过再 rename 到 versions/<版本>」：
 *
 * - 解包失败、文件不全、node 探不到达标版本 → 整块 staging 删掉，绝不留下半个运行时；
 * - rename 是同一卷上的原子改名，不存在「装了一半」这种可见中间态；
 * - 目标目录已存在时先删掉（理论上前面几档都排除了，这里是防重入）。
 */
async function extractBundledNodeArchive(options: {
  archive: BundledNodeArchive
  runtimeRoot: string
  pnpmRoot?: string | null
  probe: (nodeExecutable: string) => Promise<string | null>
  onOutput?: OutputListener
}): Promise<NodeRuntime> {
  if (process.platform !== 'win32') throw new Error('随包 Node 归档目前只支持 Windows 布局。')
  const { onOutput } = options
  const version = NODE_RUNTIME_VERSION
  const finalRoot = managedNodeVersionRoot(options.runtimeRoot, version)
  const versionsRoot = path.dirname(finalRoot)
  const stagingRoot = path.join(versionsRoot, `.node-archive-${process.pid}-${Date.now()}`)
  await mkdir(stagingRoot, { recursive: true })
  try {
    const tarExecutable = systemTarExecutable()
    const extractor = trackSpawnedProcess(spawn(tarExecutable, ['-xf', options.archive.path, '-C', stagingRoot], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    onOutput?.('info', `命令：${formatCommandLine(tarExecutable, ['-xf', options.archive.path, '-C', stagingRoot])}\n工作目录：${stagingRoot}`)
    let extractionError = ''
    extractor.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
    extractor.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      extractionError += text
      onOutput?.('error', text)
    })
    const exitCode = await waitForExit(extractor)
    onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
    if (exitCode !== 0) throw new Error(`解压归档失败：${extractionError.trim() || `代码 ${exitCode}`}`)

    const stagedNodeRoot = path.join(stagingRoot, 'node')
    const stagedRuntime = runtimePaths(stagedNodeRoot, true, DISTRIBUTION_LAYOUT)
    if (!isCompleteRuntime(stagedRuntime)) throw new Error('归档里的 node/ 不完整（缺 node.exe、npm.cmd 或 npx.cmd）。')
    if (!existsSync(path.join(stagedNodeRoot, 'node_modules', 'npm', 'package.json'))) {
      throw new Error('归档里的 node/ 缺 node_modules/npm。')
    }
    // 版本必须真跑一次：文件名不可信，而且 x64/arm64 拿错就是这里露馅。
    const probed = await options.probe(stagedRuntime.node)
    if (!probed || !nodeVersionAtLeast(probed)) {
      throw new Error(`归档里的 node 探不到可用版本（${probed ?? '无输出'}）。`)
    }

    await rm(finalRoot, { recursive: true, force: true })
    await rename(stagedNodeRoot, finalRoot)
    logStep(options.onOutput, `已解出 node/${path.basename(finalRoot)}（node ${probed}，含 npm）`)

    // pnpm 顺带铺开：装不上不算这一步失败，只是后面要联网装一次。
    await adoptPnpmFromStaging(path.join(stagingRoot, 'pnpm'), options.pnpmRoot, options.onOutput).catch(error => {
      logStep(options.onOutput, `随包 pnpm 铺开失败（不影响 Node）：${error instanceof Error ? error.message : String(error)}`)
    })

    return runtimePaths(finalRoot, true, DISTRIBUTION_LAYOUT)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 归档里的 pnpm/ 就是托管 pnpm 根的内容（node_modules/pnpm + node_modules/.bin/pnpm.cmd）。
 * 版本必须与 PNPM_VERSION 一致才铺——否则 ensurePnpmRuntime 会认为「已装」而永远不会
 * 换成当前版本，插件就装在旧 pnpm 上。
 */
async function adoptPnpmFromStaging(
  stagedPnpmRoot: string,
  pnpmRoot: string | null | undefined,
  onOutput?: OutputListener,
): Promise<void> {
  if (!pnpmRoot) return
  const target = { root: pnpmRoot, executable: pnpmExecutable(pnpmRoot) }
  if (await hasRequiredPnpmVersion(target)) return
  const stagedModules = path.join(stagedPnpmRoot, 'node_modules')
  const manifestPath = path.join(stagedModules, 'pnpm', 'package.json')
  if (!existsSync(manifestPath) || !existsSync(pnpmExecutable(stagedPnpmRoot))) {
    logStep(onOutput, '归档里没有可用的 pnpm，跳过')
    return
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
  if (manifest.version !== PNPM_VERSION) {
    logStep(onOutput, `归档里的 pnpm 是 ${String(manifest.version)}，与 PNPM_VERSION=${PNPM_VERSION} 不一致，跳过`)
    return
  }
  await mkdir(pnpmRoot, { recursive: true })
  await rm(path.join(pnpmRoot, 'node_modules'), { recursive: true, force: true })
  await rename(stagedModules, path.join(pnpmRoot, 'node_modules'))
  logStep(onOutput, `已铺开随包 pnpm ${PNPM_VERSION}`)
}

/**
 * 挑一个可用的 Node 运行环境。「有就不补」是这一步的全部要求，所以顺序必须严格：
 *
 *   1. 显式钉版本 → 用该版本的托管安装（开发者钉住版本排查问题，别替他换）；
 *   2. 本机 Node 达标 → **直接用，什么都不做**（不解压、不下载）；
 *   3. userData 里已有**完整**托管运行时（含 node_modules/npm）→ 直接复用，不解压；
 *   4. 安装包内归档存在且版本/架构匹配 → 解压补齐；
 *   5. 才回落到联网下载。
 *
 * 第 2 步的门控是「探版本」而不是「看文件在不在」：旧实现只看 PATH 上有没有三个文件，
 * 本机装着老 Node 的用户因此撞上「DSH 安装失败（代码 1）」（pnpm 11 要求 node>=22.13），
 * 而**没装 Node 的人反而正常**。
 *
 * 归档（第 4 步）失败一律不报错：那是「本来就不该指望的便宜路」，出问题就退回第 5 步，
 * 与没有归档时的行为完全一致。
 */
export async function ensureNodeRuntime(
  runtimeRoot: string,
  onProgress?: ProgressListener,
  requestedVersion?: string | null,
  onOutput?: OutputListener,
  selection: NodeRuntimeSelection = {},
): Promise<NodeRuntime> {
  const probe = selection.probeVersion ?? probeNodeVersion
  const install = selection.installRuntime ?? installManagedNodeRuntime

  if (requestedVersion) {
    const pinned = await findManagedNodeRuntime(runtimeRoot, requestedVersion)
    if (pinned) {
      logStep(onOutput, `manifest=managed 钉版本 ${requestedVersion}（${pinned.root}）`)
      return { ...pinned, origin: 'managed' }
    }
  } else {
    const system = await findQualifiedSystemNodeRuntime(selection.environment ?? process.env, MIN_NODE_VERSION, probe)
    if (system) {
      logStep(onOutput, `manifest=system 本机 Node 达标（${system.root}），不做任何补齐`)
      return system
    }

    // 已经落地过的托管运行时（可能是历史版本）只要完整且达标就别再解一份。
    const managedAny = await findManagedNodeRuntime(runtimeRoot)
    if (managedAny && await usableRuntime(managedAny, probe)) {
      logStep(onOutput, `manifest=managed-existing 复用已有托管运行时（${managedAny.root}），不解压`)
      return { ...managedAny, origin: 'managed' }
    }

    // 开发态：vendor/node 就在仓库里，直接指过去比解一份到 userData 划算。
    // 打包态这里是 resources/node，extraResources 剥掉 node_modules 后 usableRuntime 会拒掉。
    if (selection.bundledRoot) {
      const bundled = runtimePaths(selection.bundledRoot, true, DISTRIBUTION_LAYOUT)
      if (await usableRuntime(bundled, probe)) {
        logStep(onOutput, `manifest=bundled 开发态随包目录（${bundled.root}）`)
        return { ...bundled, origin: 'bundled' }
      }
    }

    // 第 4 档：安装包内归档。
    const fromArchive = await installFromBundledArchive(runtimeRoot, probe, onProgress, onOutput, selection)
    if (fromArchive) return { ...fromArchive, origin: 'bundled' }
  }

  logStep(onOutput, `manifest=download 联网准备 Node ${normalizeNodeVersion(requestedVersion ?? NODE_RUNTIME_VERSION)}`)
  const version = normalizeNodeVersion(requestedVersion ?? NODE_RUNTIME_VERSION)
  const key = `${path.resolve(runtimeRoot)}:${version}`.toLowerCase()
  const existing = installationPromises.get(key)
  if (existing) return existing
  const installation = install(runtimeRoot, version, onProgress, onOutput)
    .then(runtime => ({ ...runtime, origin: 'managed' as const }))
    .finally(() => {
      installationPromises.delete(key)
    })
  installationPromises.set(key, installation)
  return installation
}

/** 第 4 档的壳：把「找不到归档」「解压失败」都收敛成 null，调用方只管回落到下载。 */
async function installFromBundledArchive(
  runtimeRoot: string,
  probe: (nodeExecutable: string) => Promise<string | null>,
  onProgress: ProgressListener | undefined,
  onOutput: OutputListener | undefined,
  selection: NodeRuntimeSelection,
): Promise<NodeRuntime | null> {
  const lookup = await findBundledNodeArchive(selection.archiveRoot, NODE_RUNTIME_VERSION)
  if (!lookup.archive) {
    if (selection.archiveRoot && lookup.skipped.length > 0) {
      logStep(onOutput, `归档与当前版本/架构不匹配，不解压：${lookup.skipped.join('、')}`)
    }
    return null
  }
  const archive = lookup.archive
  const startedAt = Date.now()
  onProgress?.({ percent: 84, message: `正在从安装包归档补齐 Node.js ${archive.version}` })
  logStep(onOutput, `manifest=bundled-archive 解压 ${archive.name}（${megabytes(archive.size)}）→ ${managedNodeVersionRoot(runtimeRoot, archive.version)}`)
  try {
    const runtime = await extractBundledNodeArchive({
      archive,
      runtimeRoot,
      pnpmRoot: selection.pnpmRuntimeRoot,
      probe,
      onOutput,
    })
    const elapsed = Date.now() - startedAt
    logStep(onOutput, `归档补齐完成：${archive.name}（${megabytes(archive.size)}）耗时 ${elapsed}ms`)
    onProgress?.({ percent: 100, message: `Node.js ${archive.version} 已就绪（随安装包归档）` })
    return runtime
  } catch (error) {
    // 归档坏了不该让用户看到「安装失败」——他本来就没指望这份归档，回落到联网下载。
    logStep(onOutput, `归档不可用，回落到联网下载：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * `npm install pnpm@<PNPM_VERSION>` 的参数。
 *
 * registry 必须显式指定：不指定时 npm 用用户全局 `.npmrc`，没有就走官方源，
 * 大陆环境于是卡在 registry.npmjs.org 上——和「装好启动器却装不上插件」是同一类反馈。
 * `--fetch-timeout` 默认 5 分钟，坏源上等于永久卡住；压到 30 秒，让候选链来得及换源。
 */
export function managedPnpmInstallArgs(runtimeRoot: string, registry: string): string[] {
  return [
    'install',
    '--prefix', runtimeRoot,
    '--registry', registry,
    '--save-exact',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--fetch-timeout=30000',
    '--fetch-retry-maxtimeout=30000',
    '--loglevel=verbose',
    `pnpm@${PNPM_VERSION}`,
  ]
}

async function runNpmPnpmInstall(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  registry: string,
  onOutput?: OutputListener,
): Promise<{ exitCode: number; diagnostics: string }> {
  const args = managedPnpmInstallArgs(runtimeRoot, registry)
  onOutput?.('info', `命令：${formatCommandLine(nodeRuntime.npm, args)}\n工作目录：${runtimeRoot}`)
  const child = spawnCommand(nodeRuntime.npm, args, {
    cwd: runtimeRoot,
    env: withExecutableDirectoryOnPath(nodeRuntime.node, {
      ...process.env,
      FORCE_COLOR: '0',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    }),
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8')
    diagnostics = `${diagnostics}${text}`.slice(-8_000)
    onOutput?.('error', text)
  })
  const exitCode = await waitForExit(child)
  onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
  return { exitCode, diagnostics }
}

async function installManagedPnpmRuntime(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
  registryCandidates: string[] = npmRegistryCandidates(),
): Promise<PnpmRuntime> {
  const runtime = { root: runtimeRoot, executable: pnpmExecutable(runtimeRoot) }
  if (await hasRequiredPnpmVersion(runtime)) return runtime

  await mkdir(runtimeRoot, { recursive: true })
  let lastExitCode = 1
  let lastDiagnostics = ''
  for (const [index, registry] of registryCandidates.entries()) {
    const host = urlHost(registry)
    onProgress?.({ percent: 10, message: index === 0 ? '正在准备 pnpm 插件运行环境' : `正在换源准备 pnpm 插件运行环境（${host}）` })
    let attempt: { exitCode: number; diagnostics: string }
    try {
      attempt = await runNpmPnpmInstall(runtimeRoot, nodeRuntime, registry, onOutput)
    } catch (error) {
      // npm 本身没跑起来（被杀软拦、路径不存在）也算这个源的一次失败，继续往后试并留在汇总信息里。
      const reason = error instanceof Error ? error.message : String(error)
      onOutput?.('error', `从 ${host} 安装 pnpm 时命令没跑起来：${reason}`)
      attempt = { exitCode: 1, diagnostics: reason }
    }
    lastExitCode = attempt.exitCode
    lastDiagnostics = attempt.diagnostics
    // 装没装上以 pnpm 的 package.json 为准，不以 npm 退出码为准：npm 会因无关告警退非 0，
    // 也会退 0 却没把包放对地方（prefix 目录里已有别的依赖时）。
    if (await hasRequiredPnpmVersion(runtime)) {
      onProgress?.({ percent: 100, message: `pnpm ${PNPM_VERSION} 已就绪` })
      return runtime
    }
    onOutput?.('error', `从 ${host} 安装 pnpm ${PNPM_VERSION} 未成功${index + 1 < registryCandidates.length ? '，换下一个源。' : '。'}`)
  }
  throw new Error(`pnpm 插件运行环境准备失败（已试 ${registryCandidates.map(urlHost).join(' → ')}）${lastDiagnostics ? `：${lastDiagnostics.trim()}` : `（代码 ${lastExitCode}）`}`)
}

export interface PnpmRuntimeSelection {
  /** 随包 pnpm 的根目录（内含 `node_modules/pnpm` 与 `node_modules/.bin/pnpm.cmd`）。 */
  bundledRoot?: string | null
  /** npm registry 候选链；缺省时用「npmmirror → 官方源」，调用方有用户设置时应把自己的镜像放第一位。 */
  registryCandidates?: string[]
}

export async function ensurePnpmRuntime(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
  selection: PnpmRuntimeSelection = {},
): Promise<PnpmRuntime> {
  // 随包 pnpm 优先：命中就不碰 npm、不联网。判版本靠读 package.json，不 spawn pnpm。
  if (selection.bundledRoot) {
    const bundled = { root: selection.bundledRoot, executable: pnpmExecutable(selection.bundledRoot) }
    if (await hasRequiredPnpmVersion(bundled)) return bundled
  }
  const existing = { root: runtimeRoot, executable: pnpmExecutable(runtimeRoot) }
  if (await hasRequiredPnpmVersion(existing)) return existing
  if (!pnpmInstallationPromise) {
    pnpmInstallationPromise = installManagedPnpmRuntime(runtimeRoot, nodeRuntime, onProgress, onOutput, selection.registryCandidates).finally(() => {
      pnpmInstallationPromise = null
    })
  }
  return pnpmInstallationPromise
}

export function resolveNodeExecutable(executable: string, runtime: NodeRuntime): string {
  const name = path.basename(executable).toLowerCase()
  if (name === 'node' || name === 'node.exe') return runtime.node
  if (name === 'npm' || name === 'npm.cmd') return runtime.npm
  if (name === 'npx' || name === 'npx.cmd') return runtime.npx
  return executable
}

export function requiresNodeRuntime(executable: string, args: string[]): boolean {
  const name = path.basename(executable).toLowerCase()
  return ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'dsh', 'dsh.cmd'].includes(name)
    || args.includes('@deepseek-ai/dsh')
    || executable.toLowerCase().includes('dsh-runtime')
}
