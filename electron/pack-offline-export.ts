// 离线整合包导出（计划第五、四节）：从装好的实例里采「活跃插件名单」，逐个打
// vendor/<name>-<version>.tgz，产出 manifest.json 与 installOrder。
//
// 三条硬约定：
//   1) 活跃名单以「实际存在的门控 + body」为准，不读安装凭据（ai-install 有装插件不写收据的路径）。
//   2) 垃圾段（.bak- / .retired- / .removed-）在任意层级剔除，目录名与文件名同等对待。
//   3) 全程不出网：不调 registry、不调 pnpm，只用 fs + zlib + crypto。
//
// 纯 Node，不依赖 Electron，便于 vitest 直接跑。

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, readlink, lstat, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { kernelIsComplete } from './kernel-seed'
import { KERNEL_SCOPES } from './pack-verify'
import { readTarGz, writeTarGz, type TarEntry, type TarReadEntry } from './tar-archive'

export const OFFLINE_MANIFEST_FILENAME = 'manifest.json'
export const OFFLINE_MANIFEST_FORMAT = 1
export const PLUGIN_BODIES_DIRNAME = '.dsh-launcher-plugin-bodies'
export const OFFLINE_VENDOR_DIRNAME = 'vendor'
/**
 * 随包内核：包根下的 kernel/，里面是 kernel-<version>.tgz。
 * 归档内是 node_modules/… 的形状（不带 package/ 前缀）—— 导入端 staging → rename 一步就能落成
 * <家目录>/profiles/node_modules。
 */
export const OFFLINE_KERNEL_DIRNAME = 'kernel'

/** 三件里的附件：包根下的 extras/（用户自己放的额外东西），原样复制，不打 tgz、不做任何转换。 */
export const OFFLINE_EXTRAS_DIRNAME = 'extras'
/** 对话上传目录：图片/文档私有数据，永远不进包；产物里出现即阻塞。 */
export const OFFLINE_CONVERSATIONS_DIRNAME = 'attachments'

/**
 * 导出目录：与整合包目录并列 —— 锚点是 packsRoot 的父目录，不是 dshInstallPath
 * （后者在 %APPDATA%\dsh-launcher\dsh-runtime，而 dsh-packs 跟安装盘走，两者根本不在同一处）。
 * packsRoot 空着或不是绝对路径时退到 fallbackRoot（打包态传 app.getPath('userData')）：
 * 免得把相对路径的 dsh-exports 建到当前工作目录。
 *
 * 界面（ipc.ts 的 packExportDir / chooseDirectory）与命令行（--export-pack）共用这一份算法。
 */
export function packExportDirFor(packsRoot: string, fallbackRoot: string): string {
  return path.join(packsRoot && path.isAbsolute(packsRoot) ? path.dirname(packsRoot) : fallbackRoot, 'dsh-exports')
}

/** 垃圾段标记：备份 / 退役 / 已移除。目录名同样命中（这是 pack-snapshot 的已知缺陷，不照抄）。 */
const JUNK_SEGMENT_RE = /\.(?:bak|retired|removed)-/i
/** 只认结尾的 .bak；名字中间的 .bak 可能是正经文件名的一部分。 */
const BACKUP_SUFFIX_RE = /\.bak$/i

export function isJunkSegment(name: string): boolean {
  return JUNK_SEGMENT_RE.test(name) || BACKUP_SUFFIX_RE.test(name)
}

export function isJunkPath(relative: string): boolean {
  return relative.split(/[\\/]+/).some(segment => segment.length > 0 && isJunkSegment(segment))
}

// ---------------------------------------------------------------------------
// 活跃名单：门控（node_modules 下的 junction）→ body

export type SkippedGateReason =
  | 'not-a-link'
  | 'outside-bodies'
  | 'junk'
  | 'missing-body'
  | 'missing-package-json'
  | 'name-mismatch'
  | 'invalid-version'

export interface SkippedGate {
  packageName: string
  reason: SkippedGateReason
  detail: string
}

export interface ActivePlugin {
  packageName: string
  gatePath: string
  bodyDir: string
}

interface PluginPackageJson {
  name?: unknown
  version?: unknown
  main?: unknown
  exports?: unknown
  files?: unknown
  engines?: { node?: unknown } | undefined
  dependencies?: Record<string, unknown> | undefined
  /** 平台专属依赖（linux/darwin 的那些没装就是缺失，不算错误）。 */
  optionalDependencies?: Record<string, unknown> | undefined
  peerDependencies?: Record<string, unknown> | undefined
  dsh?: {
    bundle?: { patch?: unknown } | undefined
    client?: unknown
    engines?: { dsh?: unknown } | undefined
  } | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/** node_modules 顶层的条目名（scoped 包展开成两条）。 */
async function listGateNames(nodeModulesDir: string): Promise<string[]> {
  const names: string[] = []
  for (const entry of await readdir(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue
    if (!entry.name.startsWith('@')) {
      names.push(entry.name)
      continue
    }
    const scopeDir = path.join(nodeModulesDir, entry.name)
    for (const child of await readdir(scopeDir, { withFileTypes: true })) {
      names.push(entry.name + '/' + child.name)
    }
  }
  return names
}

function packageSegments(packageName: string): string[] {
  return packageName.split('/')
}

/**
 * 采活跃名单：以「门控 junction 指向本实例 .dsh-launcher-plugin-bodies/ 下真实存在的目录，
 * 且该目录带 package.json」为准。悬空门控、指到包外共享依赖的门控、垃圾门控全部记入 skipped。
 */
export async function collectActivePlugins(
  profileDir: string,
  nodeModulesName = 'node_modules',
): Promise<{ plugins: ActivePlugin[]; skipped: SkippedGate[] }> {
  const nodeModulesDir = path.join(profileDir, nodeModulesName)
  const bodiesDir = path.join(profileDir, PLUGIN_BODIES_DIRNAME)
  const plugins: ActivePlugin[] = []
  const skipped: SkippedGate[] = []
  const skip = (packageName: string, reason: SkippedGateReason, detail: string): void => {
    skipped.push({ packageName, reason, detail })
  }

  for (const packageName of await listGateNames(nodeModulesDir)) {
    const gatePath = path.join(nodeModulesDir, ...packageSegments(packageName))
    const gateStat = await lstat(gatePath).catch(() => null)
    if (!gateStat || !gateStat.isSymbolicLink()) {
      skip(packageName, 'not-a-link', 'node_modules 里不是链接（包外共享依赖或实体目录）')
      continue
    }
    const linkTarget = await readlinkSafe(gatePath)
    if (!linkTarget) {
      skip(packageName, 'not-a-link', '读不出链接目标')
      continue
    }
    const bodyDir = path.resolve(path.dirname(gatePath), linkTarget)
    const relative = path.relative(profileDir, bodyDir)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      skip(packageName, 'outside-bodies', linkTarget)
      continue
    }
    const segments = relative.split(path.sep)
    if (segments[0] !== PLUGIN_BODIES_DIRNAME) {
      skip(packageName, 'outside-bodies', linkTarget)
      continue
    }
    if (segments.some(isJunkSegment)) {
      skip(packageName, 'junk', relative)
      continue
    }
    const bodyStat = await lstat(bodyDir).catch(() => null)
    if (!bodyStat || !bodyStat.isDirectory()) {
      skip(packageName, 'missing-body', bodyDir)
      continue
    }
    const manifest = await readPackageJson(bodyDir)
    if (!manifest) {
      skip(packageName, 'missing-package-json', bodyDir)
      continue
    }
    const declaredName = typeof manifest.name === 'string' ? manifest.name : ''
    const expectedPath = segments.slice(1).join('/')
    if (declaredName !== packageName || expectedPath !== packageName) {
      skip(packageName, 'name-mismatch', 'package.json name=' + (declaredName || '(缺失)') + ' 目录=' + expectedPath)
      continue
    }
    const version = typeof manifest.version === 'string' ? manifest.version : ''
    if (!/^v?\d+\.\d+\.\d+/.test(version)) {
      skip(packageName, 'invalid-version', version || '(缺失)')
      continue
    }
    plugins.push({ packageName, gatePath, bodyDir })
  }

  plugins.sort((left, right) => left.packageName.localeCompare(right.packageName))
  skipped.sort((left, right) => left.packageName.localeCompare(right.packageName))
  return { plugins, skipped }
}

async function readlinkSafe(target: string): Promise<string | null> {
  try {
    return await readlink(target)
  } catch {
    return null
  }
}

async function readPackageJson(directory: string): Promise<PluginPackageJson | null> {
  try {
    return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as PluginPackageJson
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 静态事实

export interface OfflinePluginFacts {
  name: string
  version: string
  /** exports["."]（回落 main），相对插件目录、正斜杠；解析不到时为空串 */
  entry: string
  entryExists: boolean
  hasBundle: boolean
  hasClient: boolean
  bundlePatch: string | null
  /** dsh.engines.dsh 的原始声明，不做范围求值 */
  enginesDsh: string | null
  engineNode: string | null
  deps: string[]
  peerDeps: string[]
  files: string[]
  bodyPath: string
  bytes: number
  fileCount: number
}

function normalizeRelativeSpecifier(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** exports["."] 取 default/import/require，回落 main；都解析不到返回空串。 */
export function resolvePackageEntry(manifest: PluginPackageJson): string {
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string' && value.length > 0) return normalizeRelativeSpecifier(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = pick(item)
        if (candidate) return candidate
      }
      return null
    }
    if (isRecord(value)) {
      for (const key of ['default', 'import', 'require', 'node']) {
        const candidate = pick(value[key])
        if (candidate) return candidate
      }
    }
    return null
  }
  const exported = manifest.exports
  if (typeof exported === 'string') return normalizeRelativeSpecifier(exported)
  if (isRecord(exported)) {
    const root = pick(exported['.'])
    if (root) return root
  }
  if (typeof manifest.main === 'string' && manifest.main.length > 0) return normalizeRelativeSpecifier(manifest.main)
  return ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sortedKeys(value: Record<string, unknown> | undefined): string[] {
  return value ? Object.keys(value).sort() : []
}

/** 只量真正会进包的内容：链接与垃圾段都不算（与 packPluginTgz 的口径一致）。 */
async function measureDirectory(directory: string): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0
  let fileCount = 0
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name)
      if (isJunkSegment(entry.name)) continue
      const info = await lstat(full).catch(() => null)
      if (!info || info.isSymbolicLink()) continue
      if (info.isDirectory()) stack.push(full)
      else if (info.isFile()) {
        bytes += info.size
        fileCount += 1
      }
    }
  }
  return { bytes, fileCount }
}

export async function readPluginFacts(bodyDir: string): Promise<OfflinePluginFacts | null> {
  const manifest = await readPackageJson(bodyDir)
  if (!manifest) return null
  const entry = resolvePackageEntry(manifest)
  const entryExists = entry.length > 0
    ? await lstat(path.join(bodyDir, ...entry.split('/'))).then(info => info.isFile(), () => false)
    : false
  const patch = typeof manifest.dsh?.bundle?.patch === 'string' && manifest.dsh.bundle.patch.length > 0
    ? normalizeRelativeSpecifier(manifest.dsh.bundle.patch)
    : null
  const facts: OfflinePluginFacts = {
    name: typeof manifest.name === 'string' ? manifest.name : '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
    entry,
    entryExists,
    hasBundle: patch !== null,
    hasClient: isRecord(manifest.dsh?.client),
    bundlePatch: patch,
    enginesDsh: typeof manifest.dsh?.engines?.dsh === 'string' ? manifest.dsh.engines.dsh : null,
    engineNode: typeof manifest.engines?.node === 'string' ? manifest.engines.node : null,
    deps: sortedKeys(manifest.dependencies),
    peerDeps: sortedKeys(manifest.peerDependencies),
    files: stringArray(manifest.files),
    bodyPath: bodyDir,
    ...(await measureDirectory(bodyDir)),
  }
  return facts
}

// ---------------------------------------------------------------------------
// 打包：磁盘真实内容 → tgz（剔除垃圾段与 junction）

export interface PackedPluginTgz {
  bytes: number
  fileCount: number
  directoryCount: number
  strippedJunk: number
  strippedLinks: number
}

/**
 * 收集要进 tar 的条目；跳过链接（源机绝对路径，换机必坏）与任何层级的垃圾段。
 * prefix 为空串时不加前缀：随包内核要的正是这种「解出来就是 versions/<ver>/ 形状」的归档。
 */
async function collectTarEntries(rootDir: string, prefix = 'package'): Promise<{
  entries: TarEntry[]
  stats: PackedPluginTgz
}> {
  const entries: TarEntry[] = []
  const stats: PackedPluginTgz = {
    bytes: 0,
    fileCount: 0,
    directoryCount: 0,
    strippedJunk: 0,
    strippedLinks: 0,
  }
  const stack: Array<{ directory: string; relative: string }> = [{ directory: rootDir, relative: '' }]
  while (stack.length > 0) {
    const current = stack.pop() as { directory: string; relative: string }
    for (const entry of await readdir(current.directory, { withFileTypes: true })) {
      const full = path.join(current.directory, entry.name)
      const relative = current.relative ? current.relative + '/' + entry.name : entry.name
      // Dirent 对 Windows junction 不可靠，统一用 lstat 判定。
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        stats.strippedLinks += 1
        continue
      }
      if (isJunkSegment(entry.name)) {
        stats.strippedJunk += 1
        continue
      }
      const archivePath = prefix ? prefix + '/' + relative : relative
      if (info.isDirectory()) {
        stats.directoryCount += 1
        entries.push({ path: archivePath, type: 'directory' })
        stack.push({ directory: full, relative })
        continue
      }
      if (!info.isFile()) continue
      const data = await readFile(full)
      stats.fileCount += 1
      stats.bytes += data.length
      entries.push({ path: archivePath, type: 'file', data })
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { entries, stats }
}

/**
 * 链接依赖：body 里 node_modules/<name> 是指向别处（通常是 <home>/profiles/node_modules）的 junction。
 * 导出时跟随它把实体内容收进该插件 tgz 的 package/node_modules/<name>/ —— npm 的 bundledDependencies 语义。
 * 这样导入端的「插件 body 自带依赖」这一档就能命中，导出/导入两端契约都不用改。
 */
export interface LinkedDependency {
  /** 依赖包名（scoped 时含 /），tgz 里落在 package/node_modules/<name>/ */
  name: string
  /** body 里那个 junction 的绝对路径 */
  linkPath: string
}

export interface CarriedDependency {
  name: string
  files: number
  bytes: number
}

export interface PackPluginResult extends PackedPluginTgz {
  /** 跟随链接收进包的依赖（自己带一份，不做跨插件去重） */
  carriedDeps: CarriedDependency[]
  /** 跟随失败的依赖（悬空 / 目标不是目录 / 没有可打包文件）：仍然要宿主提供 */
  skippedDeps: Array<{ name: string; reason: string }>
}

/**
 * 收集「已经跟随链接解析出来的实体目录」里的条目。
 * 规则与本体一致：垃圾段剔除；链接一律不写进包 —— 有实体就跟随收实体，悬空就跳过并计数。
 * ancestors 只装本次跟随链上的真实目录，用来挡「依赖互相链接」造成的环。
 */
async function collectLinkedEntries(
  rootDir: string,
  prefix: string,
  rootReal: string,
): Promise<{ entries: TarEntry[]; files: number; bytes: number; directories: number; skippedLinks: number }> {
  const entries: TarEntry[] = []
  const totals = { files: 0, bytes: 0, directories: 0, skippedLinks: 0 }

  const walk = async (directory: string, relative: string, ancestors: Set<string>): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isJunkSegment(entry.name)) continue
      const full = path.join(directory, entry.name)
      const childRelative = relative ? relative + '/' + entry.name : entry.name
      // Dirent 对 Windows junction 不可靠，统一用 lstat 判定。
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        const resolved = await realpath(full).catch(() => null)
        const target = resolved ? await lstat(resolved).catch(() => null) : null
        if (!resolved || !target) {
          totals.skippedLinks += 1
          continue
        }
        if (target.isDirectory()) {
          if (ancestors.has(resolved)) {
            totals.skippedLinks += 1
            continue
          }
          entries.push({ path: prefix + '/' + childRelative, type: 'directory' })
          totals.directories += 1
          await walk(resolved, childRelative, new Set([...ancestors, resolved]))
          continue
        }
        if (!target.isFile()) {
          totals.skippedLinks += 1
          continue
        }
        const data = await readFile(resolved)
        entries.push({ path: prefix + '/' + childRelative, type: 'file', data })
        totals.files += 1
        totals.bytes += data.length
        continue
      }
      if (info.isDirectory()) {
        entries.push({ path: prefix + '/' + childRelative, type: 'directory' })
        totals.directories += 1
        await walk(full, childRelative, ancestors)
        continue
      }
      if (!info.isFile()) continue
      const data = await readFile(full)
      entries.push({ path: prefix + '/' + childRelative, type: 'file', data })
      totals.files += 1
      totals.bytes += data.length
    }
  }

  await walk(rootDir, '', new Set([rootReal]))
  return { entries, ...totals }
}

/**
 * 打一个插件本体到 tgz（npm 兼容：归档内统一 package/ 前缀）。
 * 剔除链接与垃圾段；内容按磁盘实况打包，不按 package.json 的 files 裁剪。
 * linkedDeps 里的链接依赖会跟随成实体收进 package/node_modules/<name>/（包自带依赖）。
 * ponytail: 每个插件整包读进内存再压（当前最大 107 MB）；将来若有 1 GB 级插件再改流式。
 */
export async function packPluginTgz(
  bodyDir: string,
  targetFile: string,
  linkedDeps: LinkedDependency[] = [],
): Promise<PackPluginResult> {
  const { entries, stats } = await collectTarEntries(bodyDir)
  const carriedDeps: CarriedDependency[] = []
  const skippedDeps: Array<{ name: string; reason: string }> = []

  for (const dependency of linkedDeps) {
    const resolved = await realpath(dependency.linkPath).catch(() => null)
    const target = resolved ? await lstat(resolved).catch(() => null) : null
    if (!resolved || !target || !target.isDirectory()) {
      skippedDeps.push({
        name: dependency.name,
        reason: resolved ? '链接目标不是目录：' + resolved : '链接悬空（目标不存在）',
      })
      continue
    }
    const collected = await collectLinkedEntries(resolved, 'package/node_modules/' + dependency.name, resolved)
    if (collected.files === 0) {
      skippedDeps.push({ name: dependency.name, reason: '链接目标里没有可打包的文件：' + resolved })
      continue
    }
    entries.push(...collected.entries)
    stats.fileCount += collected.files
    stats.bytes += collected.bytes
    stats.directoryCount += collected.directories
    // 这个链接是「跟随成功」的，不是被剔除的：本体遍历时记的那一笔要退回去，否则统计自相矛盾。
    stats.strippedLinks = Math.max(0, stats.strippedLinks - 1)
    stats.strippedLinks += collected.skippedLinks
    carriedDeps.push({ name: dependency.name, files: collected.files, bytes: collected.bytes })
  }

  if (stats.fileCount === 0) throw new Error('插件本体里没有可打包的文件：' + bodyDir)
  // 拼进来的依赖条目会打乱顺序：重排一次，同一份内容永远得到同一份 tgz。
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  await writeFile(targetFile, writeTarGz(entries))
  return { ...stats, carriedDeps, skippedDeps }
}

/** npm 的文件名规则：@scope/pkg → scope-pkg；vendor 目录里不能再有子目录。 */
export function tgzNameForPackage(packageName: string, version: string): string {
  const flattened = packageName.replace(/^@/, '').replace(/\//g, '-')
  return flattened + '-' + version + '.tgz'
}

export function integrityOf(buffer: Buffer): string {
  return 'sha512-' + createHash('sha512').update(buffer).digest('base64')
}

// ---------------------------------------------------------------------------
// 随包内核：<home>/profiles/node_modules 里挑出内核包 → kernel/kernel-<ver>.tgz
//
// 为什么源是这个家目录自己的内核树、而不是共享的 <dshInstallPath>/versions/<ver>：
// 每个 home 的 profiles/node_modules 是一份**独立**的 npm 扁平树（实测 dsh-origin-3080 是
// 69,608 文件 / 942.6 MB 的真实目录），插件依赖也装在它里面。共享区那份只是新建实例时的源。
// 导出必须按「这个包真正跑着的那棵树」来挑，换台机器才起得来。

/** 内核 tgz 的名字（落在包的 kernel/ 下）。 */
export function kernelTgzName(version: string): string {
  return 'kernel-' + version + '.tgz'
}

/** 一份 home 的内核树：profileDir = <home>/profiles/<id>，内核树是它的兄弟 node_modules。 */
export function kernelModulesDirOf(profileDir: string): string {
  return path.join(path.dirname(path.resolve(profileDir)), 'node_modules')
}

/** 根上的簿记文件：小，带上能看出这棵树是哪次装的。 */
const KERNEL_ROOT_FILES = ['package.json', 'package-lock.json']

function shellName(): string {
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 这个名字是不是内核自己的包（KERNEL_SCOPES：@deepseek-ai 整段）。 */
export function isKernelPackageName(packageName: string): boolean {
  return KERNEL_SCOPES.some(scope => packageName === scope || packageName.startsWith(scope + '/'))
}

/**
 * 从一棵 profiles/node_modules 里挑出「内核自己的包」：
 *   - KERNEL_SCOPES（@deepseek-ai/*）整段都要；
 *   - 顺着它们的 dependencies / optionalDependencies 走一遍，把运行时真用得到的第三方包带上
 *     —— npm 扁平树里那些就在顶层，只带 @deepseek-ai/* 会在别人机器上一 import 就断；
 *   - 没装的（平台专属的 optional 依赖：linux/darwin 的那些）算 missing，跳过，不是错误。
 */
export async function selectKernelPackages(modulesDir: string): Promise<{ packages: string[]; missing: string[] }> {
  const top = new Set(await listGateNames(modulesDir))
  const roots = [...top].filter(isKernelPackageName)
  const seen = new Set<string>()
  const missing = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop() as string
    if (seen.has(name)) continue
    seen.add(name)
    if (!top.has(name)) {
      missing.add(name)
      continue
    }
    const manifest = await readPackageJson(path.join(modulesDir, ...name.split('/')))
    if (!manifest) {
      missing.add(name)
      continue
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) if (!seen.has(dependency)) queue.push(dependency)
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) if (!seen.has(dependency)) queue.push(dependency)
  }
  const packages = [...seen].filter(name => top.has(name)).sort()
  return { packages, missing: [...missing].sort() }
}

type KernelProgress = (event: { stage: string; message: string }) => void

/**
 * 把一棵内核树里挑出来的包打成 kernel/kernel-<ver>.tgz。
 * 归档内不带 package/ 前缀：解出来直接就是 node_modules/ 的形状，导入端 rename 成
 * <home>/profiles/node_modules 就能用。
 *
 * ponytail: 挑中的文件整块读进内存再压（实测 0.2.1-rc.2 的本机内核树 714 MB / 6.6 万文件，
 * 峰值约 1.6 GB）。上限：内核再大就要改成流式 tar+gzip。升级路径：边读边写 gzip。
 */
export async function packKernelTgz(
  modulesDir: string,
  packDir: string,
  version: string,
  onProgress?: KernelProgress,
): Promise<OfflineManifestKernel> {
  const kernelDirname = path.join(packDir, OFFLINE_KERNEL_DIRNAME)
  await mkdir(kernelDirname, { recursive: true })
  const fileName = kernelTgzName(version)

  onProgress?.({ stage: 'kernel', message: '挑内核包：' + modulesDir })
  const selection = await selectKernelPackages(modulesDir)
  if (selection.packages.length === 0 || !selection.packages.some(isKernelPackageName)) {
    throw new Error('这棵内核树里没有内核包（' + KERNEL_SCOPES.join(' / ') + '）：' + modulesDir)
  }

  const entries: TarEntry[] = []
  const totals = { files: 0, bytes: 0 }
  const collect = async (directory: string, prefix: string): Promise<void> => {
    // 目录不存在就跳过：内核树不完整时也要能把「现有这些」打出来，由导入端如实报不合格。
    const collected = await collectTarEntries(directory, prefix).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!collected) return
    entries.push(...collected.entries)
    totals.files += collected.stats.fileCount
    totals.bytes += collected.stats.bytes
  }

  // 归档内一律 node_modules/…：解出来直接就是一棵内核树的形状（<home>/profiles/node_modules）。
  const ARCHIVE_ROOT = 'node_modules'
  // .bin 整段带上：dsh.cmd（或 dsh）就在里面，kernelIsComplete 认的就是它；其余是插件的小 shim。
  await collect(path.join(modulesDir, '.bin'), ARCHIVE_ROOT + '/.bin')
  for (const name of KERNEL_ROOT_FILES) {
    const data = await readFile(path.join(modulesDir, name)).catch(() => null)
    if (!data) continue
    entries.push({ path: name, type: 'file', data })
    totals.files += 1
    totals.bytes += data.length
  }
  for (const packageName of selection.packages) {
    await collect(path.join(modulesDir, ...packageName.split('/')), ARCHIVE_ROOT + '/' + packageName)
  }
  if (totals.files === 0) throw new Error('挑出来的内核包里一个文件都没有：' + modulesDir)

  // 同一份内容永远得到同一份 tgz：collectTarEntries 已按目录排好，这里再全局排一次。
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  // 读完之后先把规模说出来：700 MB 的树压成 tgz 要几十秒，界面不能一直没动静。
  onProgress?.({
    stage: 'kernel',
    message: '压缩内核 ' + version + '：' + selection.packages.length + ' 个包 / '
      + totals.files + ' 个文件 / ' + megabytes(totals.bytes),
  })
  const archive = writeTarGz(entries)
  await writeFile(path.join(kernelDirname, fileName), archive)
  return {
    version,
    tgz: OFFLINE_KERNEL_DIRNAME + '/' + fileName,
    integrity: integrityOf(archive),
    bytes: archive.length,
    files: totals.files,
    extractedBytes: totals.bytes,
  }
}

/** 没打进去的两种原因：都要如实进报告，不许静默跳过。 */
export type KernelPackState = 'packed' | 'missing-source' | 'incomplete-source'

export interface KernelPackResult {
  version: string
  state: KernelPackState
  /** 人话原因；打包成功时是体积摘要 */
  detail: string
  /** 只有 state === 'packed' 才有 */
  kernel?: OfflineManifestKernel
}

/**
 * 从 <home>/profiles/node_modules 取一份随包内核，**只读**。
 * 源不存在或不完整时不抛错（包照旧能导出），但把原因写进返回值，由调用方摆进报告与 warning。
 */
export async function packKernelFromHome(options: {
  profileDir: string
  version: string
  packDir: string
  onProgress?: KernelProgress
}): Promise<KernelPackResult> {
  const { version } = options
  const modulesDir = kernelModulesDirOf(options.profileDir)
  const info = await lstat(modulesDir).catch(() => null)
  if (!info || !info.isDirectory()) {
    return { version, state: 'missing-source', detail: '这个实例没有内核树（' + modulesDir + ' 不存在）' }
  }
  // kernelIsComplete 认的是「含 node_modules 的那一层」：这里就是 <home>/profiles。
  if (!(await kernelIsComplete(path.dirname(modulesDir)))) {
    return {
      version,
      state: 'incomplete-source',
      detail: '这个实例的内核不完整（缺 node_modules/.bin/' + shellName() + ' 或 @deepseek-ai/dsh 的 package.json）：' + modulesDir,
    }
  }
  const kernel = await packKernelTgz(modulesDir, options.packDir, version, options.onProgress)
  return {
    version,
    state: 'packed',
    detail: '内核 ' + version + ' 已打进包（tgz ' + megabytes(kernel.bytes) + ' / ' + kernel.files + ' 个文件，解开 '
      + megabytes(kernel.extractedBytes ?? 0) + '）',
    kernel,
  }
}

// ---------------------------------------------------------------------------
// 名单与拓扑序

export interface OfflineManifestPlugin {
  name: string
  version: string
  integrity: string
  tgz: string
  entry: string
  hasBundle: boolean
  hasClient: boolean
  deps: string[]
  enabled: boolean
}

/** 附件登记：空目录也要留一条（fileCount 0 / bytes 0），不能因为空就整条消失。 */
export interface OfflineExtrasRecord {
  /** 相对包根的路径，固定 'extras' */
  path: string
  fileCount: number
  bytes: number
  directoryCount: number
}

/**
 * 随包内核：包根 kernel/ 里那份 tgz 的登记。
 *
 * 老包（1.0.23 及更早）没有这一段，目标机必须自己先装好 dshVersion 才能导入；
 * 有这一段时导入端会从包里解出来，用户不用自己去装内核。
 */
export interface OfflineManifestKernel {
  /** 这份内核的版本，必须与 manifest.dshVersion 一致（导入端按它落目录）。 */
  version: string
  /** 相对包根的路径，固定 kernel/kernel-<version>.tgz */
  tgz: string
  /** 与 vendor tgz 同一算法：sha512-<base64> */
  integrity: string
  /** tgz 本身的字节数 */
  bytes: number
  /** 归档里的文件个数 */
  files: number
  /** 解出来的字节数（导入端据此预估磁盘需求）；早期没有这一项的包只跳过空间预估。 */
  extractedBytes?: number
}

export interface OfflineManifest {
  /** 包格式版本：清单形状校验用，不属于「三件」 */
  format: number
  /** 核心：内核版本 */
  dshVersion: string
  /** 目标平台：清单形状校验用，不属于「三件」 */
  platform: string
  plugins: OfflineManifestPlugin[]
  /** 附件（extras/）：用户自己放的额外东西，不是对话上传的 attachments/ */
  extras: OfflineExtrasRecord
  /** 随包内核（可选：老包没有这一段，导入端退回「本机得先装好内核」） */
  kernel?: OfflineManifestKernel
  installOrder: string[]
}

/** 同包名两个版本 ⇒ node_modules 只能留一个 ⇒ 直接阻塞（计划 8.11 第 6 类）。 */
export function assertNoDuplicatePackageNames(plugins: Array<{ name: string }>): void {
  const seen = new Map<string, number>()
  for (const plugin of plugins) seen.set(plugin.name, (seen.get(plugin.name) ?? 0) + 1)
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  if (duplicates.length > 0) {
    throw new Error('包名重复，拒绝出包：' + duplicates.sort().join(', '))
  }
}

/**
 * 拓扑序：节点 = 已 vendor 的插件 + 它们 dependencies 里声明的包（peerDependencies 不进图，
 * 宿主给）。边 = 依赖 → 依赖方；同层按名字排序，保证同一份输入得到同一份顺序。
 */
export function buildInstallOrder(plugins: Array<{ name: string; deps: string[] }>): string[] {
  const prerequisites = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  const ensure = (node: string): void => {
    if (!prerequisites.has(node)) prerequisites.set(node, new Set())
    if (!dependents.has(node)) dependents.set(node, new Set())
  }
  for (const plugin of plugins) {
    ensure(plugin.name)
    for (const dependency of plugin.deps) {
      if (dependency === plugin.name) continue
      ensure(dependency)
      ;(prerequisites.get(plugin.name) as Set<string>).add(dependency)
      ;(dependents.get(dependency) as Set<string>).add(plugin.name)
    }
  }
  const remaining = new Map<string, number>()
  for (const [node, deps] of prerequisites) remaining.set(node, deps.size)
  const ready = [...remaining.entries()].filter(([, count]) => count === 0).map(([node]) => node).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const node = ready.shift() as string
    order.push(node)
    for (const dependent of dependents.get(node) ?? new Set<string>()) {
      const next = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, next)
      if (next === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }
  if (order.length !== remaining.size) {
    const cycle = [...remaining.entries()].filter(([, count]) => count > 0).map(([node]) => node).sort()
    throw new Error('依赖存在环，无法定出 installOrder：' + cycle.join(', '))
  }
  return order
}

export function createOfflineManifest(options: {
  dshVersion: string
  platform: string
  plugins: OfflineManifestPlugin[]
  extras: OfflineExtrasRecord
  /** 随包内核：没有这一项 = 老包（目标机得自己装好内核） */
  kernel?: OfflineManifestKernel
}): OfflineManifest {
  assertNoDuplicatePackageNames(options.plugins)
  const plugins = [...options.plugins]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(plugin => ({
      name: plugin.name,
      version: plugin.version,
      integrity: plugin.integrity,
      tgz: plugin.tgz,
      entry: plugin.entry,
      hasBundle: plugin.hasBundle,
      hasClient: plugin.hasClient,
      deps: [...plugin.deps].sort(),
      enabled: plugin.enabled,
    }))
  return {
    format: OFFLINE_MANIFEST_FORMAT,
    dshVersion: options.dshVersion,
    platform: options.platform,
    plugins,
    extras: {
      path: options.extras.path,
      fileCount: options.extras.fileCount,
      bytes: options.extras.bytes,
      directoryCount: options.extras.directoryCount,
    },
    // 只有真带了内核才写这一段：老包没这一段，照旧按「本机得先装好」导入。
    ...(options.kernel ? { kernel: { ...options.kernel } } : {}),
    installOrder: buildInstallOrder(plugins),
  }
}

export function serializeOfflineManifest(manifest: OfflineManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(label + ' 缺失或不是字符串')
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(label + ' 必须是字符串数组')
  }
  return value as string[]
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(label + ' 必须是非负整数')
  }
  return value
}

function parseExtrasRecord(value: unknown): OfflineExtrasRecord {
  if (!isRecord(value)) throw new Error('manifest.extras 缺失（附件必须登记，空目录也要留一条记录）')
  const recordPath = requireString(value.path, 'manifest.extras.path')
  if (recordPath !== OFFLINE_EXTRAS_DIRNAME) {
    throw new Error('manifest.extras.path 必须是 ' + OFFLINE_EXTRAS_DIRNAME + '（不是对话上传的 attachments/）')
  }
  return {
    path: recordPath,
    fileCount: requireCount(value.fileCount, 'manifest.extras.fileCount'),
    bytes: requireCount(value.bytes, 'manifest.extras.bytes'),
    directoryCount: requireCount(value.directoryCount, 'manifest.extras.directoryCount'),
  }
}

/**
 * 随包内核登记的解析。老包没有 manifest.kernel —— 那一段整个缺席，不是错误；
 * 一旦写了，就必须是完整可用的一条（宁可退回「本机得先装好」，也不猜半截）。
 */
function parseKernelRecord(value: unknown): OfflineManifestKernel {
  if (!isRecord(value)) throw new Error('manifest.kernel 必须是对象')
  const version = requireString(value.version, 'manifest.kernel.version')
  if (!KERNEL_VERSION_RE.test(version)) throw new Error('manifest.kernel.version 不是版本号：' + JSON.stringify(version))
  const tgz = requireString(value.tgz, 'manifest.kernel.tgz')
  const kernelPrefix = OFFLINE_KERNEL_DIRNAME + '/'
  if (!tgz.startsWith(kernelPrefix) || tgz.includes('\\') || path.posix.isAbsolute(tgz) || tgz.split('/').includes('..')) {
    throw new Error('manifest.kernel.tgz 必须是 ' + kernelPrefix + ' 下的相对路径')
  }
  const integrity = requireString(value.integrity, 'manifest.kernel.integrity')
  if (!INTEGRITY_RE.test(integrity)) throw new Error('manifest.kernel.integrity 不是 sha512-base64')
  const record: OfflineManifestKernel = {
    version,
    tgz,
    integrity,
    bytes: requireCount(value.bytes, 'manifest.kernel.bytes'),
    files: requireCount(value.files, 'manifest.kernel.files'),
  }
  // 早期没写这一项：不当错误，导入端只跳过空间预估。
  if (value.extractedBytes !== undefined) {
    record.extractedBytes = requireCount(value.extractedBytes, 'manifest.kernel.extractedBytes')
  }
  return record
}

/** 解析 manifest.json；严格校验第四节 schema 的必填字段。 */
export function parseOfflineManifest(text: string): OfflineManifest {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error('manifest.json 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
  }
  if (!isRecord(data)) throw new Error('manifest.json 顶层必须是对象')
  if (data.format !== OFFLINE_MANIFEST_FORMAT) throw new Error('manifest.format 必须是 ' + OFFLINE_MANIFEST_FORMAT)
  const dshVersion = requireString(data.dshVersion, 'manifest.dshVersion')
  const platform = requireString(data.platform, 'manifest.platform')
  if (!Array.isArray(data.plugins)) throw new Error('manifest.plugins 必须是数组')
  const plugins: OfflineManifestPlugin[] = data.plugins.map((item, index) => {
    if (!isRecord(item)) throw new Error('plugins[' + index + '] 必须是对象')
    const integrity = requireString(item.integrity, 'plugins[' + index + '].integrity')
    if (!INTEGRITY_RE.test(integrity)) throw new Error('plugins[' + index + '].integrity 不是 sha512-base64')
    const tgz = requireString(item.tgz, 'plugins[' + index + '].tgz')
    if (tgz.includes('\\') || path.posix.isAbsolute(tgz) || tgz.split('/').includes('..')) {
      throw new Error('plugins[' + index + '].tgz 必须是 vendor 下的相对路径')
    }
    if (typeof item.hasBundle !== 'boolean' || typeof item.hasClient !== 'boolean') {
      throw new Error('plugins[' + index + '] 的 hasBundle/hasClient 必须是布尔值')
    }
    if (typeof item.enabled !== 'boolean') throw new Error('plugins[' + index + '].enabled 必须是布尔值')
    return {
      name: requireString(item.name, 'plugins[' + index + '].name'),
      version: requireString(item.version, 'plugins[' + index + '].version'),
      integrity,
      tgz,
      entry: requireString(item.entry, 'plugins[' + index + '].entry'),
      hasBundle: item.hasBundle,
      hasClient: item.hasClient,
      deps: requireStringArray(item.deps, 'plugins[' + index + '].deps'),
      enabled: item.enabled,
    }
  })
  assertNoDuplicatePackageNames(plugins)
  const extras = parseExtrasRecord(data.extras)
  const installOrder = requireStringArray(data.installOrder, 'manifest.installOrder')
  const kernel = data.kernel === undefined ? undefined : parseKernelRecord(data.kernel)
  return {
    format: OFFLINE_MANIFEST_FORMAT,
    dshVersion,
    platform,
    plugins,
    extras,
    ...(kernel ? { kernel } : {}),
    installOrder,
  }
}

export async function writeOfflineManifest(packDir: string, manifest: OfflineManifest): Promise<string> {
  const target = path.join(packDir, OFFLINE_MANIFEST_FILENAME)
  await writeFile(target, serializeOfflineManifest(manifest), 'utf8')
  return target
}

export async function readOfflineManifest(packDir: string): Promise<OfflineManifest> {
  const target = path.join(packDir, OFFLINE_MANIFEST_FILENAME)
  const text = await readFile(target, 'utf8')
  return parseOfflineManifest(text)
}

// ---------------------------------------------------------------------------
// 包级检查

export interface OfflinePackCheck {
  ok: boolean
  blocking: string[]
  warnings: string[]
  stats: {
    plugins: number
    tgzFiles: number
    vendorBytes: number
    manifestBytes: number
    extrasFiles: number
    extrasBytes: number
    /** 随包内核 tgz 的字节数（老包为 0） */
    kernelBytes: number
    totalBytes: number
  }
}

const KERNEL_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 附件统计：只数普通文件，链接单独计数（链接含源机绝对路径，复制时跳过）。 */
export interface ExtrasStats {
  fileCount: number
  bytes: number
  directoryCount: number
  skippedLinks: number
}

/**
 * 把 <家目录>/extras/ 原样复制到包根（不打 tgz、不压缩、不做任何内容转换）。
 * 源目录不存在也算正常：包根照建一个空 extras/（三件之一，可以空但必须在）。
 * 注意：垃圾段剔除是插件目录的规则，附件里同名的文件可能是用户真实数据，这里一律不动。
 */
export async function copyExtras(sourceDir: string | null, targetDir: string): Promise<ExtrasStats> {
  const stats: ExtrasStats = { fileCount: 0, bytes: 0, directoryCount: 0, skippedLinks: 0 }
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const sourceInfo = sourceDir ? await lstat(sourceDir).catch(() => null) : null
  if (!sourceDir || !sourceInfo || !sourceInfo.isDirectory()) return stats
  const stack: Array<{ source: string; target: string }> = [{ source: sourceDir, target: targetDir }]
  while (stack.length > 0) {
    const current = stack.pop() as { source: string; target: string }
    const entries = await readdir(current.source, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const source = path.join(current.source, entry.name)
      const target = path.join(current.target, entry.name)
      const info = await lstat(source).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        stats.skippedLinks += 1
        continue
      }
      if (info.isDirectory()) {
        await mkdir(target, { recursive: true })
        stats.directoryCount += 1
        stack.push({ source, target })
        continue
      }
      if (!info.isFile()) continue
      // 内核 copy：不把内容读进 Node 内存，也不做任何转换。
      await copyFile(source, target)
      stats.fileCount += 1
      stats.bytes += info.size
    }
  }
  return stats
}

export async function measureExtras(directory: string): Promise<ExtrasStats> {
  const stats: ExtrasStats = { fileCount: 0, bytes: 0, directoryCount: 0, skippedLinks: 0 }
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) stats.skippedLinks += 1
      else if (info.isDirectory()) {
        stats.directoryCount += 1
        stack.push(full)
      } else if (info.isFile()) {
        stats.fileCount += 1
        stats.bytes += info.size
      }
    }
  }
  return stats
}

/**
 * 包级检查（计划第七节的 pack 档）：
 *   三件齐全（核心 / 插件 / 附件）→ 名单完整、vendor 校验和、垃圾目录、包名重复。
 * 阻塞项：三件缺任何一件 / 解析失败 / 包名重复 / 缺 tgz / sha512 不符 / tgz 里混进垃圾 /
 * 名单外多出 tgz / 附件与名单登记不一致 / 名单里出现 http(s) 地址（离线硬约束）。其余记 warning。
 */
export async function verifyOfflinePack(packDir: string): Promise<OfflinePackCheck> {
  const blocking: string[] = []
  const warnings: string[] = []
  const stats = {
    plugins: 0,
    tgzFiles: 0,
    vendorBytes: 0,
    manifestBytes: 0,
    extrasFiles: 0,
    extrasBytes: 0,
    kernelBytes: 0,
    totalBytes: 0,
  }

  const manifestPath = path.join(packDir, OFFLINE_MANIFEST_FILENAME)
  let text: string
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch {
    return { ok: false, blocking: ['缺少核心与插件清单：包根没有 manifest.json（' + manifestPath + '）'], warnings, stats }
  }
  stats.manifestBytes = Buffer.byteLength(text, 'utf8')
  if (/https?:\/\//i.test(text)) blocking.push('manifest.json 里出现 http(s) 地址，违反离线硬约束')

  // 隐私保险：对话上传目录是私有数据，产物里出现就阻塞——不靠注释和自觉，靠这条硬检查防回归。
  const conversations = await lstat(path.join(packDir, OFFLINE_CONVERSATIONS_DIRNAME)).catch(() => null)
  if (conversations) {
    blocking.push('产物里出现了 conversations 上传目录（' + OFFLINE_CONVERSATIONS_DIRNAME + '/），绝不允许进包')
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      blocking: ['manifest.json 不是合法 JSON：' + (error instanceof Error ? error.message : String(error))],
      warnings,
      stats,
    }
  }
  if (!isRecord(raw)) return { ok: false, blocking: ['manifest.json 顶层必须是对象'], warnings, stats }

  // 三件：核心（dshVersion）/ 插件（plugins）/ 附件（extras/）。
  // 先在原始 JSON 上逐件判，缺哪件直接点名；三件齐了再走严格解析与内容校验
  // （format / platform 属于清单形状校验，不算「缺件」）。
  const extrasDir = path.join(packDir, OFFLINE_EXTRAS_DIRNAME)
  const extrasInfo = await lstat(extrasDir).catch(() => null)
  const parts = [
    {
      name: '核心',
      ok: typeof raw.dshVersion === 'string' && KERNEL_VERSION_RE.test(raw.dshVersion),
      detail: 'manifest.dshVersion 缺失或不是版本号，当前 ' + JSON.stringify(raw.dshVersion),
    },
    {
      name: '插件',
      ok: Array.isArray(raw.plugins) && raw.plugins.length > 0,
      detail: 'manifest.plugins 为空（一个插件都没有）',
    },
    {
      name: '附件',
      ok: extrasInfo?.isDirectory() === true,
      detail: '包根没有 ' + OFFLINE_EXTRAS_DIRNAME + '/ 目录（可以为空，但目录必须在）：' + extrasDir,
    },
  ]
  const missingParts = parts.filter(part => !part.ok)
  if (missingParts.length > 0) {
    for (const part of missingParts) blocking.push('缺少' + part.name + '：' + part.detail)
    return { ok: false, blocking, warnings, stats }
  }

  let manifest: OfflineManifest
  try {
    manifest = parseOfflineManifest(text)
  } catch (error) {
    return { ok: false, blocking: [error instanceof Error ? error.message : String(error)], warnings, stats }
  }
  stats.plugins = manifest.plugins.length

  const vendorDir = path.join(packDir, OFFLINE_VENDOR_DIRNAME)
  const vendorInfo = await lstat(vendorDir).catch(() => null)
  if (!vendorInfo || !vendorInfo.isDirectory()) {
    blocking.push('缺少插件：包根没有 ' + OFFLINE_VENDOR_DIRNAME + '/ 目录（tgz 都放这里）')
  }
  const listed = new Set<string>()
  for (const plugin of manifest.plugins) {
    const prefix = OFFLINE_VENDOR_DIRNAME + '/'
    if (!plugin.tgz.startsWith(prefix)) {
      blocking.push(plugin.name + ' 的 tgz 不在 vendor/ 下：' + plugin.tgz)
      continue
    }
    listed.add(plugin.tgz)
    const file = path.join(packDir, ...plugin.tgz.split('/'))
    let archive: Buffer
    try {
      archive = await readFile(file)
    } catch {
      blocking.push(plugin.name + ' 的 tgz 缺失：' + plugin.tgz)
      continue
    }
    if (archive.length === 0) blocking.push(plugin.name + ' 的 tgz 是空文件')
    if (integrityOf(archive) !== plugin.integrity) blocking.push(plugin.name + ' 的 sha512 与名单不符')
    let entries: TarReadEntry[]
    try {
      entries = readTarGz(archive)
    } catch (error) {
      blocking.push(plugin.name + ' 的 tgz 解不开：' + (error instanceof Error ? error.message : String(error)))
      continue
    }
    if (entries.length === 0) blocking.push(plugin.name + ' 的 tgz 里没有任何条目')
    const junky = entries.filter(entry => isJunkPath(entry.path.replace(/^package\//, ''))).map(entry => entry.path)
    if (junky.length > 0) {
      blocking.push(plugin.name + ' 的 tgz 里混进垃圾：' + junky.slice(0, 3).join(', ') + (junky.length > 3 ? ' 等 ' + junky.length + ' 条' : ''))
    }
    if (!entries.some(entry => entry.path === 'package/package.json')) {
      warnings.push(plugin.name + ' 的 tgz 顶层没有 package.json')
    }
  }

  const vendorFiles = await readdir(vendorDir).catch(() => [] as string[])
  for (const file of vendorFiles) {
    stats.tgzFiles += 1
    const relative = OFFLINE_VENDOR_DIRNAME + '/' + file
    if (!listed.has(relative)) blocking.push('vendor 里有名单外的文件：' + relative)
    const info = await lstat(path.join(vendorDir, file)).catch(() => null)
    if (info?.isFile()) stats.vendorBytes += info.size
  }

  // 随包内核：老包没有这一段（照常通过）；有这一段就必须文件在、字节数对、sha512 对。
  if (manifest.kernel) {
    const record = manifest.kernel
    const file = path.join(packDir, ...record.tgz.split('/'))
    let archive: Buffer | null = null
    try {
      archive = await readFile(file)
    } catch {
      blocking.push('随包内核缺失：清单登记了 ' + record.version + ' 的内核（' + record.tgz + '），包里找不到这个文件')
    }
    if (archive) {
      stats.kernelBytes = archive.length
      if (archive.length !== record.bytes) {
        blocking.push('随包内核大小与名单不符：名单记 ' + record.bytes + ' 字节，实际 ' + archive.length + ' 字节（' + record.tgz + '）')
      }
      if (integrityOf(archive) !== record.integrity) {
        blocking.push('随包内核的 sha512 与名单不符（' + record.tgz + '），包可能在拷贝中损坏或被改过')
      }
    }
    if (record.version !== manifest.dshVersion) {
      blocking.push('随包内核版本与清单不一致：manifest.dshVersion=' + manifest.dshVersion
        + '，manifest.kernel.version=' + record.version)
    }
    // kernel/ 里只该有登记的那一个文件：多出来的谁都不会用，只会白白撑大包。
    for (const name of await readdir(path.join(packDir, OFFLINE_KERNEL_DIRNAME)).catch(() => [] as string[])) {
      const relative = OFFLINE_KERNEL_DIRNAME + '/' + name
      if (relative !== record.tgz) warnings.push('kernel/ 里有名单外的文件：' + relative)
    }
  } else {
    // 不拦（老包本来就不带内核），但要让人一眼看见目标机得先自己装好。
    warnings.push('包里没有随包内核（manifest.kernel 缺席）：导入时目标机必须自己先装好 DSH ' + manifest.dshVersion + '。')
  }

  // 附件：三件已齐，核对「名单登记」与磁盘实况一致（空目录 = 0 / 0 也要求一致）。
  const extrasMeasured = await measureExtras(extrasDir)
  stats.extrasFiles = extrasMeasured.fileCount
  stats.extrasBytes = extrasMeasured.bytes
  if (extrasMeasured.skippedLinks > 0) {
    warnings.push('附件里有 ' + extrasMeasured.skippedLinks + ' 个链接（含源机路径，换机可能失效）')
  }
  if (extrasMeasured.fileCount !== manifest.extras.fileCount
    || extrasMeasured.bytes !== manifest.extras.bytes
    || extrasMeasured.directoryCount !== manifest.extras.directoryCount) {
    blocking.push('附件与名单登记不一致：名单记 ' + manifest.extras.fileCount + ' 个文件 / '
      + manifest.extras.bytes + ' 字节 / ' + manifest.extras.directoryCount + ' 个目录，实际 '
      + extrasMeasured.fileCount + ' 个文件 / ' + extrasMeasured.bytes + ' 字节 / '
      + extrasMeasured.directoryCount + ' 个目录')
  }

  // installOrder 里不是随包 tgz 的节点 = 还得由宿主或下一批 vendor 提供的依赖。这里只提示，不拦。
  const vendoredNames = new Set(manifest.plugins.map(plugin => plugin.name))
  const externalNodes = manifest.installOrder.filter(name => !vendoredNames.has(name))
  if (externalNodes.length > 0) {
    warnings.push('installOrder 里有 ' + externalNodes.length + ' 个依赖没有随包 vendor：'
      + externalNodes.slice(0, 6).join(', ') + (externalNodes.length > 6 ? ' 等' : ''))
  }

  const orderSeen = new Set<string>()
  for (const name of manifest.installOrder) {
    if (orderSeen.has(name)) blocking.push('installOrder 里重复出现：' + name)
    orderSeen.add(name)
  }
  for (const plugin of manifest.plugins) {
    if (!orderSeen.has(plugin.name)) blocking.push('installOrder 漏了插件：' + plugin.name)
    const pluginIndex = manifest.installOrder.indexOf(plugin.name)
    for (const dependency of plugin.deps) {
      if (dependency === plugin.name) continue
      const dependencyIndex = manifest.installOrder.indexOf(dependency)
      if (dependencyIndex === -1) {
        // 依赖不在名单里 ⇒ 得靠宿主或下一批 vendor 补齐，先记 warning（计划要求导入端直接拒绝这类）。
        warnings.push(plugin.name + ' 的依赖 ' + dependency + ' 不在 installOrder 里')
        continue
      }
      if (dependencyIndex > pluginIndex) {
        blocking.push('installOrder 顺序错误：' + dependency + ' 应排在 ' + plugin.name + ' 之前')
      }
    }
  }

  stats.totalBytes = stats.vendorBytes + stats.kernelBytes + stats.extrasBytes + stats.manifestBytes
  return { ok: blocking.length === 0, blocking, warnings, stats }
}

// ---------------------------------------------------------------------------
// 导出主流程

export interface ExportOfflinePackOptions {
  profileDir: string
  outputDir: string
  /** 覆盖探测出来的内核版本（默认读 profile.yaml，其次 dsh-base 的 package.json） */
  dshVersion?: string
  /** 覆盖平台串（默认 <process.platform>-<process.arch>） */
  platform?: string
  /** 附件来源目录（默认 <家目录>/extras，其次 <实例>/extras；都没有就产出空 extras/） */
  extrasDir?: string
  onProgress?: (event: { stage: string; message: string }) => void
}

/**
 * 附件（extras/）默认位置：<家目录>/extras 优先，其次实例自己的 extras/。
 * 注意不是 conversations 上传目录 attachments/——那个是私有数据，永远不进包。
 */
export async function resolveExtrasSource(profileDir: string): Promise<string | null> {
  for (const candidate of [
    path.resolve(profileDir, '..', '..', OFFLINE_EXTRAS_DIRNAME),
    path.join(profileDir, OFFLINE_EXTRAS_DIRNAME),
  ]) {
    const info = await lstat(candidate).catch(() => null)
    if (info?.isDirectory()) return candidate
  }
  return null
}

/** 一条依赖边落在哪里：本体自带 / 走 shared tree 的 junction / 构建期内联（源机就解析不到）。 */
export type DependencySource = 'body' | 'linked' | 'bundled'

export interface DependencyEdge {
  plugin: string
  dependency: string
  source: DependencySource
}

/** 依赖名按最严格来源归一：只要有一条边走 junction，就算「要宿主给」。 */
function uniqueDependenciesBySource(edges: DependencyEdge[], source: DependencySource): string[] {
  const sources = new Map<string, Set<DependencySource>>()
  for (const edge of edges) {
    if (!sources.has(edge.dependency)) sources.set(edge.dependency, new Set())
    ;(sources.get(edge.dependency) as Set<DependencySource>).add(edge.source)
  }
  const picked: string[] = []
  for (const [name, seen] of sources) {
    if (source === 'linked' ? seen.has('linked') : !seen.has('linked') && !seen.has('body')) picked.push(name)
  }
  return picked.sort()
}

export interface OfflineExportReport {
  profileDir: string
  outputDir: string
  activePlugins: number
  vendoredPlugins: number
  rawBytes: number
  vendorBytes: number
  strippedJunk: number
  strippedLinks: number
  skippedGates: SkippedGate[]
  /** 静态事实（engines.dsh / files / peerDependencies 等），manifest 保持第四节 schema 不塞私货 */
  facts: OfflinePluginFacts[]
  dependencyEdges: DependencyEdge[]
  /** 走 junction 落到 shared tree、但跟随失败（悬空/复制失败）的依赖：导入端必须有它们（宿主给） */
  linkedDeps: string[]
  /** 已经跟随链接把实体收进插件 tgz 的依赖（bundledDependencies 语义）：导入端从 body 就能解到 */
  carriedDeps: {
    /** 依赖名个数（不同名字），不是「插件 × 依赖」的份数 */
    count: number
    files: number
    bytes: number
    names: string[]
  }
  /** 跟随失败的具体位置：哪个插件、哪个依赖、为什么 */
  skippedCarryDeps: Array<{ plugin: string; name: string; reason: string }>
  /** 源机就解析不到的依赖：构建期已经内联进产物，运行时不需要单独一份 */
  bundledDeps: string[]
  tgz: Array<{ name: string; version: string; tgz: string; bytes: number }>
  /** 附件（extras/）：原样复制的来源、文件数、字节数、目录数 */
  extras: {
    sourceDir: string | null
    fileCount: number
    bytes: number
    directoryCount: number
    skippedLinks: number
  }
  /** 随包内核：打进去了 / 没打进去的原因（没打进去时包照旧可用，只是目标机得自己先装内核） */
  kernel: KernelPackResult
  /** 产物总体积 = vendor + 随包内核 + 附件 + manifest.json */
  totalBytes: number
}

export interface OfflineExportResult {
  manifest: OfflineManifest
  manifestPath: string
  vendorDir: string
  report: OfflineExportReport
  check: OfflinePackCheck
}

/** 探测目标内核版本：profile.yaml 优先，其次 dsh-base 的 package.json。 */
export async function detectDshVersion(profileDir: string): Promise<string | null> {
  const profileYaml = await readFile(path.join(profileDir, 'profile.yaml'), 'utf8').catch(() => null)
  if (profileYaml) {
    const match = /^dshVersion:\s*['"]?([^'"\s#]+)/m.exec(profileYaml)
    if (match?.[1]) return match[1]
  }
  for (const candidate of [
    path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    path.join(profileDir, '..', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
  ]) {
    const text = await readFile(candidate, 'utf8').catch(() => null)
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
    } catch {
      // 坏 JSON 跳过，继续下一个候选。
    }
  }
  return null
}

export function defaultPlatform(): string {
  return process.platform + '-' + process.arch
}

/**
 * 从一个装好的实例导出离线包：vendor/*.tgz + manifest.json。
 * enabled 只表达「门控存在且 body 可用」；分层配置里的 disabled 由工作台/体检判定，这里不求值。
 */
export async function exportOfflinePack(options: ExportOfflinePackOptions): Promise<OfflineExportResult> {
  const profileDir = path.resolve(options.profileDir)
  const outputDir = path.resolve(options.outputDir)
  const vendorDir = path.join(outputDir, OFFLINE_VENDOR_DIRNAME)
  const progress = options.onProgress ?? (() => undefined)

  const profileStat = await lstat(profileDir).catch(() => null)
  if (!profileStat || !profileStat.isDirectory()) {
    throw new Error('实例目录不存在：' + profileDir)
  }

  progress({ stage: 'collect', message: '采集门控与本体' })
  const { plugins, skipped } = await collectActivePlugins(profileDir)
  if (plugins.length === 0) throw new Error('没有找到任何活跃插件（门控 + body）：' + profileDir)
  await mkdir(vendorDir, { recursive: true })

  const manifestPlugins: OfflineManifestPlugin[] = []
  const facts: OfflinePluginFacts[] = []
  const dependencyEdges: DependencyEdge[] = []
  const reportTgz: OfflineExportReport['tgz'] = []
  /** 已跟随链接收进某个插件 tgz 的依赖（每个插件各带一份，不去重）。 */
  const carriedDeps: Array<CarriedDependency & { plugin: string }> = []
  /** 跟随失败、仍要宿主提供的依赖。 */
  const skippedCarryDeps: Array<{ plugin: string; name: string; reason: string }> = []
  let rawBytes = 0
  let vendorBytes = 0
  let strippedJunk = 0
  let strippedLinks = 0

  for (const [index, plugin] of plugins.entries()) {
    const pluginFacts = await readPluginFacts(plugin.bodyDir)
    if (!pluginFacts) throw new Error('读不到 package.json：' + plugin.bodyDir)
    const linkedDeps: LinkedDependency[] = []
    for (const dependency of pluginFacts.deps) {
      const local = path.join(plugin.bodyDir, 'node_modules', ...packageSegments(dependency))
      const info = await lstat(local).catch(() => null)
      const source: DependencySource = !info ? 'bundled' : info.isSymbolicLink() ? 'linked' : 'body'
      dependencyEdges.push({ plugin: plugin.packageName, dependency, source })
      // 只有走 junction 的才跟随；bundled（源机就没有）保持原样，那是目标机内核的职责。
      if (source === 'linked') linkedDeps.push({ name: dependency, linkPath: local })
    }
    progress({
      stage: 'pack',
      message: '[' + (index + 1) + '/' + plugins.length + '] ' + plugin.packageName + '@' + pluginFacts.version,
    })
    const fileName = tgzNameForPackage(plugin.packageName, pluginFacts.version)
    const tgzRelative = OFFLINE_VENDOR_DIRNAME + '/' + fileName
    const target = path.join(vendorDir, fileName)
    const packed = await packPluginTgz(plugin.bodyDir, target, linkedDeps)
    const archive = await readFile(target)
    if (!pluginFacts.entry) {
      throw new Error(plugin.packageName + ' 解析不到入口（exports["."] / main 都为空），拒绝出包')
    }
    rawBytes += packed.bytes
    vendorBytes += archive.length
    strippedJunk += packed.strippedJunk
    strippedLinks += packed.strippedLinks
    for (const carried of packed.carriedDeps) carriedDeps.push({ plugin: plugin.packageName, ...carried })
    for (const skipped of packed.skippedDeps) skippedCarryDeps.push({ plugin: plugin.packageName, ...skipped })
    facts.push(pluginFacts)
    reportTgz.push({ name: plugin.packageName, version: pluginFacts.version, tgz: tgzRelative, bytes: archive.length })
    manifestPlugins.push({
      name: plugin.packageName,
      version: pluginFacts.version,
      integrity: integrityOf(archive),
      tgz: tgzRelative,
      entry: pluginFacts.entry,
      hasBundle: pluginFacts.hasBundle,
      hasClient: pluginFacts.hasClient,
      deps: pluginFacts.deps,
      enabled: true,
    })
  }

  const dshVersion = options.dshVersion ?? (await detectDshVersion(profileDir))
  if (!dshVersion) throw new Error('探测不到内核版本，请用 dshVersion 参数指定')
  const platform = options.platform ?? defaultPlatform()

  // 附件 = <家目录>/extras（用户自己放的额外东西）。不是 conversations 上传目录 attachments/。
  const extrasSource = options.extrasDir ?? (await resolveExtrasSource(profileDir))
  const extrasTarget = path.join(outputDir, OFFLINE_EXTRAS_DIRNAME)
  progress({
    stage: 'extras',
    message: '原样复制附件 extras ' + (extrasSource ?? '(源目录不存在，产出空 ' + OFFLINE_EXTRAS_DIRNAME + '/)'),
  })
  const extrasStats = await copyExtras(extrasSource, extrasTarget)

  // 随包内核：源是这个家目录自己的 profiles/node_modules，只读。没有/不完整都不拦出包，但要在报告里说清。
  const kernel = await packKernelFromHome({
    profileDir,
    version: dshVersion,
    packDir: outputDir,
    onProgress: progress,
  })
  progress(
    kernel.state === 'packed'
      ? { stage: 'kernel', message: kernel.detail }
      : { stage: 'kernel', message: '内核未随包携带：' + kernel.detail },
  )

  const manifest = createOfflineManifest({
    dshVersion,
    platform,
    plugins: manifestPlugins,
    extras: {
      path: OFFLINE_EXTRAS_DIRNAME,
      fileCount: extrasStats.fileCount,
      bytes: extrasStats.bytes,
      directoryCount: extrasStats.directoryCount,
    },
    ...(kernel.kernel ? { kernel: kernel.kernel } : {}),
  })
  progress({ stage: 'manifest', message: '写 manifest.json（' + manifest.plugins.length + ' 个插件，installOrder ' + manifest.installOrder.length + ' 项）' })
  const manifestPath = await writeOfflineManifest(outputDir, manifest)

  progress({ stage: 'check', message: '包级自检' })
  const check = await verifyOfflinePack(outputDir)
  // 「内核没随包」不是阻塞项（老包本来就不带内核），但必须是导出结果能一眼看见的事实。
  if (kernel.state !== 'packed') {
    check.warnings.push('内核未随包携带：' + kernel.detail)
  }
  // 已经跟随收进包的从 linkedDeps 里划走；同一依赖若某个插件跟随失败，保守起见仍留在 linkedDeps。
  const carriedNames = [...new Set(carriedDeps.map(item => item.name))].sort()
  const skippedCarryNames = new Set(skippedCarryDeps.map(item => item.name))
  const stillLinked = uniqueDependenciesBySource(dependencyEdges, 'linked')
    .filter(name => skippedCarryNames.has(name) || !carriedNames.includes(name))
  const report: OfflineExportReport = {
    profileDir,
    outputDir,
    activePlugins: plugins.length,
    vendoredPlugins: manifest.plugins.length,
    rawBytes,
    vendorBytes,
    strippedJunk,
    strippedLinks,
    skippedGates: skipped,
    facts,
    dependencyEdges,
    // 同名依赖可能在一个插件里走 junction、在另一个插件里已内联：按最严格的一档归一，两个列表不重叠。
    // linkedDeps 只留「跟随失败、还得宿主给」的；已经收进包的记在 carriedDeps。
    linkedDeps: stillLinked,
    carriedDeps: {
      count: carriedNames.length,
      files: carriedDeps.reduce((sum, item) => sum + item.files, 0),
      bytes: carriedDeps.reduce((sum, item) => sum + item.bytes, 0),
      names: carriedNames,
    },
    skippedCarryDeps,
    bundledDeps: uniqueDependenciesBySource(dependencyEdges, 'bundled'),
    tgz: reportTgz,
    extras: {
      sourceDir: extrasSource,
      fileCount: extrasStats.fileCount,
      bytes: extrasStats.bytes,
      directoryCount: extrasStats.directoryCount,
      skippedLinks: extrasStats.skippedLinks,
    },
    kernel,
    totalBytes: vendorBytes + (kernel.kernel?.bytes ?? 0) + extrasStats.bytes
      + Buffer.byteLength(serializeOfflineManifest(manifest), 'utf8'),
  }
  return { manifest, manifestPath, vendorDir, report, check }
}
