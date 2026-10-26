// 离线整合包导入（计划第五节的后半）：把已导出的整合包在目标机上装成一个可用实例。
//
// 复用（不重写）：
//   - tar 解包：tar-archive.readTarGz —— 与导出、装配工作台同一个读函数；
//   - 装插件：workbench.installPlugin —— 解 tgz 到 .dsh-launcher-plugin-bodies/<name>、
//     在 profiles/<id>/node_modules 建 junction、写 package.json 的 dependencies/bundles，
//     与启动器装插件的行为逐字一致（junction 只存绝对路径，必须在目标机上新建）；
//   - 空实例骨架：profile-service.createProfile 的那几步（package.json / pnpm-workspace /
//     profile.yaml），不自己发明第三种实例长相。
//
// 硬约定：
//   1) 只写 --home 下 --id 那一个实例目录（外加 <home>/extras 的合并复制）；
//   2) 预检不过就一个字节都不写（先检查，后落盘）；
//   3) 全程离线、无窗口：不 spawn 任何进程，只用 fs + zlib + crypto。
//
// 依赖节点（installOrder 里不是插件的那些）不安装：Node 沿
//   <body>/<plugin>/node_modules → profiles/<id>/node_modules → profiles/node_modules
// 逐级向上找，三处都找不到才算缺；而且只有「插件运行时真的 import/require 它」才算阻塞。
// 仅 package.json 声明、代码里没人用的（codemirror/xterm 这类客户端构建期依赖）只记录。

import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readOfflineManifest, type OfflineManifest, type OfflineManifestPlugin } from './pack-offline-export'
import { ensureProfileCoreBundles, ensureProfileWorkspaceConfig, profileManifestName, writeProfileMetadata } from './profile-service'
import { readTarGz } from './tar-archive'
import { installPlugin, WORKBENCH_BODIES_DIRNAME, type VendorPlugin } from './workbench'

export const IMPORT_REPORT_FILENAME = 'import-report.json'
export const KERNEL_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
/** 单个 JS 文件扫描上限：更大的多半是内联资源，扫它没意义还会拖慢预检。 */
const SCAN_FILE_LIMIT = 16 * 1024 * 1024

export interface OfflineImportOptions {
  /** 整合包目录：manifest.json + vendor/ + extras/。 */
  packDir: string
  /** 目标 DSH 家目录（必须已经装好内核树 profiles/node_modules）。 */
  home: string
  /** 新实例目录名（profiles/<id> 必须不存在）。 */
  id: string
  /** 进度回调；CLI 用它打日志。 */
  onProgress?: (event: { stage: string; message: string }) => void
}

export interface ImportPrecheckIssue {
  code: string
  message: string
}

/** Node 的三个向上查找位置。 */
export type DependencyRoot = 'body' | 'profile' | 'shared'

export interface ImportedDependencyCheck {
  name: string
  orderIndex: number
  /** package.json 里声明它的插件。 */
  declaredBy: string[]
  /** 运行时 JS 里真的 import/require 它的插件（静态扫描）。 */
  requiredBy: string[]
  /** 哪些解析位置命中了（body / profile / shared）。 */
  via: DependencyRoot[]
  /** 需要它（没人 require 时退回声明者）却解不到的插件。 */
  unresolvedFor: string[]
  expectedPath: string
  present: boolean
  /** 真依赖且解不到 → 阻塞导入。 */
  blocking: boolean
}

/** 每个 tgz 在预检时顺手扫出来的静态事实（不落盘）。 */
export interface PackedPluginScan {
  name: string
  /** tgz 内 package/node_modules/ 下自带的包（body 根能解到的）。 */
  nestedModules: string[]
  /** 运行时 JS 里出现过的裸包名。 */
  runtimeImports: string[]
}

export interface ImportPrecheck {
  ok: boolean
  blocking: ImportPrecheckIssue[]
  warnings: string[]
  manifest: OfflineManifest | null
  /** 目标 home 里内核自报的版本（没有内核时为 null）。 */
  kernelVersion: string | null
  /** manifest 引用的 tgz 总字节数（预检时顺手量出来）。 */
  packBytes: number
  dependencies: ImportedDependencyCheck[]
  scans: PackedPluginScan[]
  dependencyRoots: Record<DependencyRoot, number>
}

/** 预检阻塞：一个字节都还没写。CLI 把它映射成退出码 1。 */
export class OfflineImportBlockedError extends Error {
  readonly issues: ImportPrecheckIssue[]

  constructor(issues: ImportPrecheckIssue[]) {
    super(issues.map(issue => issue.message).join('；') || '预检阻塞')
    this.name = 'OfflineImportBlockedError'
    this.issues = issues
  }
}

export interface ImportedPluginRecord {
  name: string
  version: string
  /** 在 manifest.installOrder 里的下标（-1 = 不在清单里、兜底补装）。 */
  orderIndex: number
  bodyDir: string
  junction: string
  hasBundle: boolean
}

export interface ExtrasCopyRecord {
  sourceDir: string
  targetDir: string
  fileCount: number
  bytes: number
  directoryCount: number
  skippedLinks: number
}

export interface ImportVerification {
  ok: boolean
  failures: string[]
  checked: {
    bodies: number
    junctions: number
    dependencyEntries: number
    bundleEntries: number
  }
}

export interface OfflineImportReport {
  format: 1
  packDir: string
  home: string
  id: string
  profileDir: string
  dshVersion: string
  platform: string
  startedAt: string
  finishedAt: string
  durationMs: number
  counts: {
    plugins: number
    pluginFiles: number
    pluginBytes: number
    junctions: number
    dependencies: number
    /** 运行时真的 import/require 的依赖节点数。 */
    dependencyRequired: number
    /** 真依赖里解不到的（有则导入阻塞，正常情况下不会走到这里）。 */
    dependencyRequiredMissing: number
    /** 只是 package.json 声明、代码没人用、三处都解不到的。 */
    dependencyDeclaredOnlyMissing: number
    dependencyPresent: number
    dependencyMissing: number
    extrasFiles: number
    extrasBytes: number
    extrasDirectories: number
    reportFiles: number
  }
  /** 三个解析位置各命中多少个依赖节点（同一节点可能命中多处）。 */
  dependencyRoots: Record<DependencyRoot, number>
  /** 实际处理顺序（manifest.installOrder 原样，含依赖节点）。 */
  installOrder: string[]
  installOrderMatchesManifest: boolean
  plugins: ImportedPluginRecord[]
  dependencies: ImportedDependencyCheck[]
  /** 三处都解不到的依赖（并集）。 */
  missingDependencies: string[]
  /** 真依赖缺失 —— 阻塞类，正常应为空。 */
  missingRequiredDependencies: string[]
  /** 仅声明缺失 —— 只记录，不阻塞。 */
  missingDeclaredOnlyDependencies: string[]
  extras: ExtrasCopyRecord
  verification: ImportVerification
  warnings: string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target)
  } catch {
    return null
  }
}

/** 家目录里的内核树版本：profiles/node_modules/@deepseek-ai/dsh/package.json。 */
async function readKernelVersion(home: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (parsed.name !== KERNEL_PACKAGE) return null
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version : null
  } catch {
    return null
  }
}

function integrityOf(data: Buffer): string {
  return 'sha512-' + createHash('sha512').update(data).digest('base64')
}

function packagePath(root: string, name: string): string {
  return path.join(root, ...name.split('/'))
}

// ---------------------------------------------------------------------------
// 静态扫描：包名来自 require('x') / from 'x' / import 'x' / import('x')

/** 裸模块说明符 → 包名；相对路径、绝对路径、node: 内建一律返回空串。 */
function packageNameOfSpecifier(specifier: string): string {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return ''
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? parts[0] + '/' + parts[1] : ''
  return parts[0] ?? ''
}

const SPECIFIER_RE = /(?:require\s*\(\s*|from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

/**
 * 只扫运行时 JS（.js/.mjs/.cjs）里的静态字符串说明符。
 * ponytail: 动态 require(变量)、模板字符串、以及把运行代码写成 .ts 直跑的情况都扫不到 ——
 * 那会把「真依赖」漏判成「仅声明」，让本可阻塞的缺失被放过（requiredBy 为空不等于没人用）。
 * 升级路径：接真正的模块图遍历（从 main/exports 出发跟相对 import）。
 */
function scanRuntimeImports(files: Array<{ path: string; data: Buffer }>, watched: Set<string>): string[] {
  const found = new Set<string>()
  for (const file of files) {
    if (file.data.length > SCAN_FILE_LIMIT) continue
    const text = file.data.toString('utf8')
    for (const match of text.matchAll(SPECIFIER_RE)) {
      const name = packageNameOfSpecifier(match[1] as string)
      if (name && watched.has(name)) found.add(name)
    }
  }
  return [...found].sort()
}

/** 类型声明（.d.ts/.d.mts）与 TS 源码不参与运行时；但 src/node.js 这种是真入口，所以只按扩展名过滤。 */
function isRuntimeJs(archivePath: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(archivePath)
}

/** 从 tgz 里读出：自带的 node_modules 顶层包名 + 运行时 import 的裸包名。 */
function scanArchive(archive: Buffer, watched: Set<string>): { nested: string[]; imports: string[] } {
  const entries = readTarGz(archive)
  const nested = new Set<string>()
  const files: Array<{ path: string; data: Buffer }> = []
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const relative = entry.path.replace(/^\.?\/+/, '').replace(/^package\/+/, '')
    const nestedMatch = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(relative)
    if (nestedMatch) nested.add(nestedMatch[1] as string)
    if (isRuntimeJs(entry.path)) files.push({ path: relative, data: entry.data })
  }
  return { nested: [...nested].sort(), imports: scanRuntimeImports(files, watched) }
}

// ---------------------------------------------------------------------------
// 预检

/**
 * 预检：缺件就停。这里只读不写——所有阻塞项都必须在第一次写盘之前确定。
 * 三件：manifest.dshVersion / vendor 非空 / extras 目录存在；外加「内核版本匹配」「实例不重名」
 * 「真依赖能不能解到」。
 */
export async function precheckOfflineImport(options: OfflineImportOptions): Promise<ImportPrecheck> {
  const blocking: ImportPrecheckIssue[] = []
  const warnings: string[] = []
  const block = (code: string, message: string): void => { blocking.push({ code, message }) }
  let manifest: OfflineManifest | null = null
  let kernelVersion: string | null = null
  let packBytes = 0

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.id)) {
    block('unsafe-id', '实例 id 不合法（只能字母数字点横线下划线，1~64 位）：' + options.id)
  } else if (options.id === 'node_modules') {
    // profiles/node_modules 是内核树，不是实例目录。
    block('unsafe-id', '「node_modules」是内核树目录，不能当实例 id。')
  }

  const packInfo = await lstatOrNull(options.packDir)
  if (!packInfo || !packInfo.isDirectory()) {
    block('pack-missing', '整合包目录不存在：' + options.packDir)
    return { ok: false, blocking, warnings, manifest: null, kernelVersion: null, packBytes: 0, dependencies: [], scans: [], dependencyRoots: { body: 0, profile: 0, shared: 0 } }
  }

  try {
    manifest = await readOfflineManifest(options.packDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'manifest-missing' : 'manifest-invalid'
    block(code, 'manifest.json 读不了：' + errorText(error))
  }

  // 依赖节点的静态扫描只关心 installOrder 里非插件的那些名字。
  const pluginNames = new Set((manifest?.plugins ?? []).map(plugin => plugin.name))
  const watched = new Set((manifest?.installOrder ?? []).filter(name => !pluginNames.has(name)))
  const scans: PackedPluginScan[] = []

  // 三件之二：vendor 非空，且清单里的每个 tgz 都真的在、校验和也对得上。
  const vendorDir = path.join(options.packDir, 'vendor')
  const vendorInfo = await lstatOrNull(vendorDir)
  if (!vendorInfo || !vendorInfo.isDirectory()) {
    block('vendor-missing', '包里没有 vendor/ 目录：' + vendorDir)
  } else {
    const tgzFiles = (await readdir(vendorDir).catch(() => [] as string[])).filter(name => /\.tgz$/i.test(name))
    if (tgzFiles.length === 0) block('vendor-empty', 'vendor/ 是空的（没有任何 .tgz）')
  }
  if (manifest) {
    for (const plugin of manifest.plugins) {
      const tgzPath = path.resolve(options.packDir, plugin.tgz)
      const root = path.resolve(vendorDir)
      if (tgzPath !== root && !tgzPath.startsWith(root + path.sep)) {
        block('vendor-missing-file', 'manifest 里的 tgz 越出 vendor/：' + plugin.tgz)
        continue
      }
      const info = await lstatOrNull(tgzPath)
      if (!info || !info.isFile()) {
        block('vendor-missing-file', '缺 tgz：' + plugin.name + ' → ' + plugin.tgz)
        continue
      }
      packBytes += info.size
      const data = await readFile(tgzPath)
      // 校验和不对 = 包在传输/拷贝中坏了，装进去只会是坏实例，必须挡在写盘之前。
      if (integrityOf(data) !== plugin.integrity) {
        block('tgz-integrity', 'tgz 校验和不符（文件损坏或被改过）：' + plugin.tgz)
        continue
      }
      try {
        const scan = scanArchive(data, watched)
        scans.push({ name: plugin.name, nestedModules: scan.nested, runtimeImports: scan.imports })
      } catch (error) {
        block('tgz-unreadable', 'tgz 解不开：' + plugin.tgz + '（' + errorText(error) + '）')
      }
    }
  }

  // 三件之三：extras/ 存在（可以是空目录）。
  const extrasInfo = await lstatOrNull(path.join(options.packDir, 'extras'))
  if (!extrasInfo || !extrasInfo.isDirectory()) {
    block('extras-missing', '包里没有 extras/ 目录（空目录也必须留）：' + path.join(options.packDir, 'extras'))
  }

  // 目标机内核：只认这个 home 自己用的内核树。
  // ponytail: 不扫启动器的 <dshInstallPath>/versions/ —— CLI 只拿到 --home，去猜别处会造出
  // 「版本库里有、但这个 home 没接着」的假阳性。上限：home 内核是旧版而版本库里恰有匹配版本时，
  // 这里会报阻塞。升级路径：加 --dsh-install 参数再合并两边。
  const homeInfo = await lstatOrNull(options.home)
  if (!homeInfo || !homeInfo.isDirectory()) {
    block('home-missing', '目标家目录不存在：' + options.home)
  } else {
    kernelVersion = await readKernelVersion(options.home)
    const wanted = manifest?.dshVersion ?? '(manifest 未给出)'
    if (!kernelVersion) {
      block('kernel-missing', '这台机器没有 ' + wanted + ' 版本的内核（' + path.join(options.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh') + ' 不存在）')
    } else if (manifest && kernelVersion !== manifest.dshVersion) {
      block('kernel-version-mismatch', '这台机器没有 ' + manifest.dshVersion + ' 版本的内核（该家目录里是 ' + kernelVersion + '）')
    }
    const shell = path.join(options.home, 'profiles', 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    if (!await lstatOrNull(shell)) warnings.push('内核入口不存在（' + shell + '），实例可能起不来。')
  }

  // 绝不覆盖已存在实例：存在即阻塞，一个字节都不碰。
  const target = path.join(options.home, 'profiles', options.id)
  if (await lstatOrNull(target)) {
    block('instance-exists', '实例「' + options.id + '」已存在，拒绝覆盖：' + target)
  }

  // 依赖节点：按 Node 的三个位置逐个核对。
  const dependencies: ImportedDependencyCheck[] = []
  if (manifest) {
    const scanByName = new Map(scans.map(scan => [scan.name, scan]))
    const profileModules = path.join(options.home, 'profiles', options.id, 'node_modules')
    const sharedModules = path.join(options.home, 'profiles', 'node_modules')
    for (const [orderIndex, name] of manifest.installOrder.entries()) {
      if (pluginNames.has(name)) continue
      const declaredBy = manifest.plugins.filter(plugin => plugin.deps.includes(name)).map(plugin => plugin.name)
      // 扫全量插件：某个插件可能 import 了别的插件声明的包。
      const requiredBy = scans.filter(scan => scan.runtimeImports.includes(name)).map(scan => scan.name)
      const relevant = requiredBy.length > 0 ? requiredBy : declaredBy
      const bodyHit = (plugin: string): boolean => scanByName.get(plugin)?.nestedModules.includes(name) === true
      const profileHit = (await lstatOrNull(packagePath(profileModules, name)))?.isDirectory() === true
      const sharedHit = (await lstatOrNull(packagePath(sharedModules, name)))?.isDirectory() === true
      const via: DependencyRoot[] = []
      if (relevant.some(bodyHit)) via.push('body')
      if (profileHit) via.push('profile')
      if (sharedHit) via.push('shared')
      const unresolvedFor = relevant.filter(plugin => !(bodyHit(plugin) || profileHit || sharedHit))
      const required = requiredBy.length > 0
      dependencies.push({
        name,
        orderIndex,
        declaredBy,
        requiredBy,
        via,
        unresolvedFor,
        expectedPath: packagePath(sharedModules, name),
        present: required ? unresolvedFor.length === 0 : via.length > 0,
        blocking: required && unresolvedFor.length > 0,
      })
    }
    const blockingDeps = dependencies.filter(dependency => dependency.blocking)
    if (blockingDeps.length > 0) {
      block('dependency-missing-required', '真依赖在三个位置都解不到：' + blockingDeps.map(dependency =>
        dependency.name + '（' + dependency.unresolvedFor.join(', ') + '）').join('；'))
    }
  }

  const dependencyRoots: Record<DependencyRoot, number> = { body: 0, profile: 0, shared: 0 }
  for (const dependency of dependencies) for (const root of dependency.via) dependencyRoots[root] += 1

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    manifest,
    kernelVersion,
    packBytes,
    dependencies,
    scans,
    dependencyRoots,
  }
}

// ---------------------------------------------------------------------------
// 骨架 / 附件 / 自验

/** 目标实例骨架里必须存在的目录与清单（与 profile-service.createProfile 一致）。 */
async function createInstanceSkeleton(options: { home: string; id: string; dshVersion: string }): Promise<string> {
  const profileDir = path.join(options.home, 'profiles', options.id)
  // 两个空目录先进基线：它们由「装插件」产生，提前建好就不会在空实例上缺席。
  await mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  await mkdir(path.join(profileDir, WORKBENCH_BODIES_DIRNAME), { recursive: true })
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: profileManifestName(options.id), private: true, dependencies: {}, dsh: { profile: { bundles: [...CORE_BUNDLES] } } }, null, 2) + '\n',
    'utf8',
  )
  // 与启动器的「新建空实例」逐项对齐：workspace 配置、core bundles、profile.yaml 元数据。
  await ensureProfileWorkspaceConfig(profileDir)
  await ensureProfileCoreBundles(profileDir)
  await writeProfileMetadata(options.home, options.id, { dshVersion: options.dshVersion })
  return profileDir
}

/** 附件复制：合并不清空（目标机 extras/ 可能是用户真实数据）。 */
async function copyExtrasInto(sourceDir: string, targetDir: string): Promise<ExtrasCopyRecord> {
  const record: ExtrasCopyRecord = { sourceDir, targetDir, fileCount: 0, bytes: 0, directoryCount: 0, skippedLinks: 0 }
  await mkdir(targetDir, { recursive: true })
  // ponytail: 只做覆盖合并，不检测同名冲突（包里 extras 通常是用户自己放的同一批文件）。
  // 上限：若目标机 extras 里有同名但内容不同的文件，会被包里的静默覆盖。升级路径：先比 sha512 再决定。
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
        // 链接里存的是源机绝对路径，换机必坏；与导出端同一口径：跳过并计数。
        record.skippedLinks += 1
        continue
      }
      if (info.isDirectory()) {
        await mkdir(target, { recursive: true })
        record.directoryCount += 1
        stack.push({ source, target })
        continue
      }
      if (!info.isFile()) continue
      await copyFile(source, target)
      record.fileCount += 1
      record.bytes += info.size
    }
  }
  return record
}

/** 量本体目录：文件数 / 字节数（链接与目录不计数，与导出端口径一致）。 */
async function measureTree(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name)
      const info = await lstat(full).catch(() => null)
      if (!info || info.isSymbolicLink()) continue
      if (info.isDirectory()) stack.push(full)
      else if (info.isFile()) {
        files += 1
        bytes += info.size
      }
    }
  }
  return { files, bytes }
}

/** Windows junction 只存绝对路径；Node 读回来可能带长路径前缀。 */
function stripLongPathPrefix(value: string): string {
  return value.replace(/^\\\\[\\?]\\/, '')
}

/**
 * 自验：重读落盘结果，逐项确认 body 目录、junction、package.json 覆盖。
 * 与导入时的写入顺序无关，只认最终磁盘状态。
 */
export async function verifyImportedInstance(input: {
  profileDir: string
  manifest: OfflineManifest
}): Promise<ImportVerification> {
  const failures: string[] = []
  const checked = { bodies: 0, junctions: 0, dependencyEntries: 0, bundleEntries: 0 }
  const manifestPath = path.join(input.profileDir, 'package.json')
  let dependencies: Record<string, unknown> = {}
  let bundles: unknown[] = []
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown[] } } }
    dependencies = manifest.dependencies ?? {}
    bundles = manifest.dsh?.profile?.bundles ?? []
  } catch (error) {
    failures.push('profile package.json 读不了：' + errorText(error))
  }

  for (const plugin of input.manifest.plugins) {
    // 1) body 目录 + 本体清单
    const bodyDir = packagePath(path.join(input.profileDir, WORKBENCH_BODIES_DIRNAME), plugin.name)
    const bodyInfo = await lstatOrNull(bodyDir)
    if (!bodyInfo || !bodyInfo.isDirectory()) {
      failures.push(plugin.name + '：body 目录不存在 ' + bodyDir)
      continue
    }
    checked.bodies += 1
    try {
      const own = JSON.parse(await readFile(path.join(bodyDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (own.name !== plugin.name) failures.push(plugin.name + '：body 的 package.json name=' + String(own.name))
      if (own.version !== plugin.version) failures.push(plugin.name + '：body 的版本 ' + String(own.version) + ' != manifest 的 ' + plugin.version)
    } catch (error) {
      failures.push(plugin.name + '：body 里没有可读的 package.json（' + errorText(error) + '）')
    }

    // 2) 门控 junction 能解到真实目录
    const junction = packagePath(path.join(input.profileDir, 'node_modules'), plugin.name)
    checked.junctions += 1
    try {
      const linkInfo = await lstat(junction)
      if (!linkInfo.isSymbolicLink()) {
        failures.push(plugin.name + '：node_modules 里不是链接 ' + junction)
      } else {
        const raw = stripLongPathPrefix(await readlink(junction))
        const resolved = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(junction), raw)
        const [realLink, realBody] = await Promise.all([realpath(resolved), realpath(bodyDir)])
        const same = process.platform === 'win32'
          ? realLink.toLowerCase() === realBody.toLowerCase()
          : realLink === realBody
        if (!same) failures.push(plugin.name + '：junction 指向 ' + realLink + '，不是本体 ' + realBody)
        const target = await stat(junction).catch(() => null)
        if (!target || !target.isDirectory()) failures.push(plugin.name + '：junction 解不开（悬空）')
      }
    } catch (error) {
      failures.push(plugin.name + '：读链接失败（' + errorText(error) + '）')
    }

    // 3) package.json 覆盖：dependencies 有条目，hasBundle 的进 bundles
    const spec = dependencies[plugin.name]
    if (spec === undefined) failures.push(plugin.name + '：package.json 的 dependencies 缺条目')
    else {
      checked.dependencyEntries += 1
      const expected = 'file:./' + WORKBENCH_BODIES_DIRNAME + '/' + plugin.name
      if (spec !== expected) failures.push(plugin.name + '：dependencies 条目是 ' + String(spec) + '，期望 ' + expected)
    }
    if (plugin.hasBundle) {
      if (!bundles.includes(plugin.name)) failures.push(plugin.name + '：hasBundle 但 dsh.profile.bundles 里没有它')
      else checked.bundleEntries += 1
    }
  }

  return { ok: failures.length === 0, failures, checked }
}

/** 安装完再按磁盘算一次依赖解析：body 现在真的在盘上，profile 根也有了目录。 */
async function resolveDependenciesOnDisk(input: {
  profileDir: string
  home: string
  dependencies: ImportedDependencyCheck[]
}): Promise<ImportedDependencyCheck[]> {
  const profileModules = path.join(input.profileDir, 'node_modules')
  const sharedModules = path.join(input.home, 'profiles', 'node_modules')
  const resolved: ImportedDependencyCheck[] = []
  for (const dependency of input.dependencies) {
    const relevant = dependency.requiredBy.length > 0 ? dependency.requiredBy : dependency.declaredBy
    const profileHit = (await lstatOrNull(packagePath(profileModules, dependency.name)))?.isDirectory() === true
    const sharedHit = (await lstatOrNull(packagePath(sharedModules, dependency.name)))?.isDirectory() === true
    const hits = new Map<string, DependencyRoot[]>()
    for (const plugin of relevant) {
      const bodyDir = packagePath(path.join(input.profileDir, WORKBENCH_BODIES_DIRNAME), plugin)
      const bodyHit = (await lstatOrNull(packagePath(path.join(bodyDir, 'node_modules'), dependency.name)))?.isDirectory() === true
      const roots: DependencyRoot[] = []
      if (bodyHit) roots.push('body')
      if (profileHit) roots.push('profile')
      if (sharedHit) roots.push('shared')
      hits.set(plugin, roots)
    }
    const via: DependencyRoot[] = []
    for (const roots of hits.values()) for (const root of roots) if (!via.includes(root)) via.push(root)
    const unresolvedFor = relevant.filter(plugin => (hits.get(plugin) ?? []).length === 0)
    const required = dependency.requiredBy.length > 0
    resolved.push({
      ...dependency,
      via,
      unresolvedFor,
      present: required ? unresolvedFor.length === 0 : via.length > 0,
      blocking: required && unresolvedFor.length > 0,
    })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// 导入

/**
 * 导入：预检 → 骨架 → 按 installOrder 装插件并核对依赖 → 复制附件 → 自验 → 报告。
 * 预检阻塞抛 OfflineImportBlockedError（调用方映射退出码 1），其它异常就是运行错误（退出码 2）。
 */
export async function importOfflinePack(options: OfflineImportOptions): Promise<OfflineImportReport> {
  const progress = (stage: string, message: string): void => { options.onProgress?.({ stage, message }) }
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const warnings: string[] = []

  progress('precheck', '预检：manifest / vendor / extras / 内核版本 / 目标实例 / 依赖解析')
  const precheck = await precheckOfflineImport(options)
  if (!precheck.ok) throw new OfflineImportBlockedError(precheck.blocking)
  warnings.push(...precheck.warnings)
  const manifest = precheck.manifest as OfflineManifest

  progress('skeleton', '建实例骨架：' + options.id)
  const profileDir = await createInstanceSkeleton({ home: options.home, id: options.id, dshVersion: manifest.dshVersion })

  const pluginByName = new Map(manifest.plugins.map(plugin => [plugin.name, plugin]))
  const plugins: ImportedPluginRecord[] = []
  const installed = new Set<string>()

  const installOne = async (plugin: OfflineManifestPlugin, orderIndex: number): Promise<void> => {
    if (installed.has(plugin.name)) return
    const tgz = path.resolve(options.packDir, plugin.tgz)
    // 与装配工作台同一个装法：installPlugin 负责解包（含 tar-slip 防护）、junction、清单登记。
    const vendorPlugin: VendorPlugin = {
      name: plugin.name,
      version: plugin.version,
      tgz,
      entry: plugin.entry.length > 0 ? plugin.entry : null,
      hasBundle: plugin.hasBundle,
    }
    await installPlugin(profileDir, vendorPlugin)
    installed.add(plugin.name)
    plugins.push({
      name: plugin.name,
      version: plugin.version,
      orderIndex,
      bodyDir: packagePath(path.join(profileDir, WORKBENCH_BODIES_DIRNAME), plugin.name),
      junction: packagePath(path.join(profileDir, 'node_modules'), plugin.name),
      hasBundle: plugin.hasBundle,
    })
    progress('install', '[' + plugins.length + '/' + manifest.plugins.length + '] ' + plugin.name + '@' + plugin.version)
  }

  progress('install', '按 installOrder 处理 ' + manifest.installOrder.length + ' 项')
  const installOrder: string[] = []
  for (const [orderIndex, name] of manifest.installOrder.entries()) {
    installOrder.push(name)
    const plugin = pluginByName.get(name)
    // 依赖节点不安装：预检已经逐个核对过，结果直接进报告。
    if (plugin) await installOne(plugin, orderIndex)
  }

  // 清单里万一漏了某个插件（不该发生，但不能静默少装）：按名字序补装并留警告。
  const leftover = manifest.plugins.filter(plugin => !installed.has(plugin.name)).sort((left, right) => left.name.localeCompare(right.name))
  if (leftover.length > 0) {
    warnings.push('manifest.installOrder 漏了 ' + leftover.length + ' 个插件，已按名字序补装：' + leftover.map(plugin => plugin.name).join(', '))
    for (const plugin of leftover) {
      installOrder.push(plugin.name)
      await installOne(plugin, -1)
    }
  }
  const installOrderMatchesManifest = installOrder.length === manifest.installOrder.length && installOrder.every((name, index) => name === manifest.installOrder[index])

  progress('extras', '复制附件到 ' + path.join(options.home, 'extras'))
  const extras = await copyExtrasInto(path.join(options.packDir, 'extras'), path.join(options.home, 'extras'))

  progress('verify', '自验：body / junction / package.json / 依赖解析')
  const verification = await verifyImportedInstance({ profileDir, manifest })
  const dependencies = await resolveDependenciesOnDisk({ profileDir, home: options.home, dependencies: precheck.dependencies })
  for (const dependency of dependencies) {
    if (dependency.blocking) verification.failures.push('真依赖解不到：' + dependency.name + '（' + dependency.unresolvedFor.join(', ') + '）')
  }
  if (verification.failures.length > 0) verification.ok = false

  const dependencyRoots: Record<DependencyRoot, number> = { body: 0, profile: 0, shared: 0 }
  for (const dependency of dependencies) for (const root of dependency.via) dependencyRoots[root] += 1
  const missingDependencies = dependencies.filter(dependency => !dependency.present).map(dependency => dependency.name)
  const missingRequiredDependencies = dependencies.filter(dependency => dependency.blocking).map(dependency => dependency.name)
  const missingDeclaredOnlyDependencies = dependencies.filter(dependency => !dependency.present && !dependency.blocking).map(dependency => dependency.name)
  const measured = await measureTree(path.join(profileDir, WORKBENCH_BODIES_DIRNAME))

  const reportPath = path.join(profileDir, IMPORT_REPORT_FILENAME)
  const report: OfflineImportReport = {
    format: 1,
    packDir: options.packDir,
    home: options.home,
    id: options.id,
    profileDir,
    dshVersion: manifest.dshVersion,
    platform: manifest.platform,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    counts: {
      plugins: plugins.length,
      pluginFiles: measured.files,
      pluginBytes: measured.bytes,
      junctions: plugins.length,
      dependencies: dependencies.length,
      dependencyRequired: dependencies.filter(dependency => dependency.requiredBy.length > 0).length,
      dependencyRequiredMissing: missingRequiredDependencies.length,
      dependencyDeclaredOnlyMissing: missingDeclaredOnlyDependencies.length,
      dependencyPresent: dependencies.length - missingDependencies.length,
      dependencyMissing: missingDependencies.length,
      extrasFiles: extras.fileCount,
      extrasBytes: extras.bytes,
      extrasDirectories: extras.directoryCount,
      reportFiles: 4,
    },
    dependencyRoots,
    installOrder,
    installOrderMatchesManifest,
    plugins,
    dependencies,
    missingDependencies,
    missingRequiredDependencies,
    missingDeclaredOnlyDependencies,
    extras,
    verification,
    warnings,
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  progress('done', '导入完成：' + plugins.length + ' 个插件，报告 ' + reportPath)
  return report
}
