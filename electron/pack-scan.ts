// 非标准整合包 zip 的扫描纯函数域：从没有 dsh-pack.yaml 的 zip 里识别标准插件目录与技能，
// 并把选中的项解出到 workDir。不依赖 Electron，仅 adm-zip + node:fs + yauzl。
//
// 判定依据（对齐既有语义）：
//  - 插件 = 目录内含 package.json（排除含 node_modules 的整棵子树与常见干扰目录；
//    git 仓库形式的插件正常识别，.git 内部由 blocklist 排除）；
//    离线安装后的 bundle 兼容性由 DSH CLI 运行时仲裁（installPackLocalDirectory 只查 exit code）。
//  - 技能 = 目录内含 SKILL.md / flat .md 且 parseSkillDocument 通过（复用 skill-catalog 判定）。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { isSafePackageName } from './profile'
import { parseSkillDocument } from './skill-format'
import { likelyFlatSkill } from './skill-catalog'
import {
  assertInside,
  openZipPathFromFile,
  safeArchivePath,
  type OpenZipPath,
  type ZipPathEntry,
} from './pack-zip'

/** 宽松扫描限额：容纳真实整合包（1.2 GiB / 27.5 万条目）。 */
export const MAX_RAW_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 // 4 GiB
export const MAX_RAW_FILES = 1_000_000
/** 实际解出字节上限（只计候选子树，不按全部条目声明体积预拒）。 */
export const MAX_RAW_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

const MAX_PACKAGE_JSON_BYTES = 256 * 1024
const MAX_SKILL_DOCUMENT_BYTES = 2 * 1024 * 1024

/** 目录 basename blocklist：几乎不可能是插件包的目录，其下 package.json 一律不视为插件。 */
const PLUGIN_IGNORE_DIR_NAMES = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', 'coverage',
  'test', 'tests', 'example', 'examples', 'docs', 'doc', 'assets',
])

export interface RawScanPlugin {
  kind: 'plugin'
  packageName: string
  version?: string
  /** zip 内（post-strip）该插件 package.json 所在目录，如 "dsh-routing-suite/injector"。 */
  entryPrefix: string
}

export interface RawScanSkill {
  kind: 'skill'
  name: string
  format: 'bundle' | 'flat'
  /** bundle：SKILL.md 所在目录；flat：单 .md 文件路径（均为 post-strip 相对路径）。 */
  entryPrefix: string
}

export interface RawScanPreset {
  kind: 'preset'
  name: string
  /** 含 preset.yml 的目录（post-strip 相对路径）。 */
  entryPrefix: string
}

export interface RawScanResult {
  kind: 'raw'
  /** 整体包裹层目录名（剥离后），无则 null。 */
  topName: string | null
  plugins: RawScanPlugin[]
  skills: RawScanSkill[]
  presets: RawScanPreset[]
  skipped: { entryPrefix: string; reason: string }[]
}

export interface RawScanLimits {
  maxArchiveBytes: number
  maxFiles: number
  maxExtractedBytes: number
}

export const DEFAULT_RAW_SCAN_LIMITS: RawScanLimits = {
  maxArchiveBytes: MAX_RAW_ARCHIVE_BYTES,
  maxFiles: MAX_RAW_FILES,
  maxExtractedBytes: MAX_RAW_EXTRACT_BYTES,
}

/** 从文件名/顶层目录名清洗出 ASCII 包名 hint；无字母或全为符号时返回 null（UI 让用户起名）。 */
export function cleanPackNameHint(rawName: string): string | null {
  const cleaned = rawName
    .replace(/\.zip$/i, '')
    .replace(/[^a-z0-9._ -]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (!/[a-zA-Z]/.test(cleaned)) return null // 纯数字/符号不当作有意义包名
  return cleaned
}

interface RawArchive {
  entries: AdmZip.IZipEntry[]
  /** entryName（已安全归一化）→ entry 的映射，避免逐条线性查找。 */
  byRel: Map<string, AdmZip.IZipEntry>
  stripRoot: string | null
}

/** 宽松 open：仅 zip-slip 全量校验 + 条目数上限，不做解压体积预拒。 */
function openRawArchive(buffer: Uint8Array, limits: RawScanLimits): RawArchive {
  if (buffer.byteLength > limits.maxArchiveBytes) throw new Error('整合包压缩包过大。')
  // 已是 Buffer 时直接持引用（零拷贝）：pack.ts 传回 readFile 的原 Buffer，大包省一份内存。
  const archive = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
  const entries = archive.getEntries()
  if (entries.length === 0) throw new Error('整合包压缩包为空。')
  if (entries.length > limits.maxFiles) throw new Error('整合包文件数量超过安全限制。')
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!safeArchivePath(entry.entryName)) throw new Error('整合包包含不安全路径。')
  }
  // 检测整体套一层顶层目录（复用 pack-zip 的判定逻辑）。
  const firstSegments = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    firstSegments.add(safe.split('/')[0])
  }
  let stripRoot: string | null = null
  if (firstSegments.size === 1) {
    const only = [...firstSegments][0]
    if (only !== 'dsh-pack.yaml' && !only.startsWith('plugin-bodies/')) stripRoot = only
  }
  // 建立 rel → entry 映射（post-strip 归一化路径）。
  const byRel = new Map<string, AdmZip.IZipEntry>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    const rel = stripRoot && safe.startsWith(`${stripRoot}/`) ? safe.slice(stripRoot.length + 1) : safe
    if (rel && !byRel.has(rel)) byRel.set(rel, entry)
  }
  return { entries, byRel, stripRoot }
}

/** 该目录或任一祖先目录是否为「直接含 node_modules」的剪除根，或命中 blocklist。 */
function isExcludedTree(dir: string, pruneRoots: ReadonlySet<string>): boolean {
  if (!dir) return false
  let current = dir
  while (current) {
    if (pruneRoots.has(current)) return true
    const base = current.split('/').pop() ?? ''
    if (PLUGIN_IGNORE_DIR_NAMES.has(base)) return true
    const slash = current.lastIndexOf('/')
    current = slash > 0 ? current.slice(0, slash) : ''
  }
  return false
}

/**
 * 扫描非标准 zip：识别插件目录（package.json）与技能（SKILL.md / flat）。
 * 排除含 node_modules/.git 的整棵子树（如 DSH 应用分发包 harness-backend/）。
 */
export function scanRawPackZip(buffer: Uint8Array, limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS): RawScanResult {
  const archive = openRawArchive(buffer, limits)
  return scanRawArchive(archive, limits)
}

function scanRawArchive(archive: RawArchive, limits: RawScanLimits): RawScanResult {
  // 第一遍：计算「直接含 node_modules」的剪除根。
  // 注意：.git 不作为剪除信号——git 仓库 / submodule 是真实插件的主流分发形式
  // （真实包内 dsh-anchored-standard、dsh-routing-suite 均含 .git），整棵剪除会误杀；
  // .git 内部文件由 isExcludedTree 的目录名 blocklist 单独排除。
  const pruneRoots = new Set<string>()
  for (const rel of archive.byRel.keys()) {
    const segments = rel.split('/')
    for (let i = 0; i + 1 < segments.length; i += 1) {
      if (segments[i + 1] === 'node_modules') {
        pruneRoots.add(segments.slice(0, i + 1).join('/'))
      }
    }
  }

  const plugins: RawScanPlugin[] = []
  const pluginSeen = new Set<string>()
  const skillSeen = new Map<string, RawScanSkill>()
  const presetSeen = new Map<string, RawScanPreset>()
  const skipped: RawScanResult['skipped'] = []

  // ---- 技能候选（bundle：SKILL.md；flat：likelyFlatSkill）----
  for (const rel of archive.byRel.keys()) {
    if (/^SKILL\.md$/i.test(rel) || /\/SKILL\.md$/i.test(rel)) {
      const dir = rel.slice(0, rel.lastIndexOf('/'))
      if (isExcludedTree(dir, pruneRoots)) continue
      const entry = archive.byRel.get(rel)
      if ((Number(entry?.header.size) || 0) > MAX_SKILL_DOCUMENT_BYTES) continue
      const data = entry!.getData()
      if (data.byteLength > MAX_SKILL_DOCUMENT_BYTES) continue // header 声明的 size 可伪造，按实际字节再拒一次
      const parsed = parseSkillDocument(data.toString('utf8'))
      if (!parsed) continue
      upsertSkill(skillSeen, { kind: 'skill', name: parsed.name, format: 'bundle', entryPrefix: dir })
      continue
    }
    if (likelyFlatSkill(rel)) {
      if (isExcludedTree(rel, pruneRoots)) continue
      const entry = archive.byRel.get(rel)
      if ((Number(entry?.header.size) || 0) > MAX_SKILL_DOCUMENT_BYTES) continue
      const data = entry!.getData()
      if (data.byteLength > MAX_SKILL_DOCUMENT_BYTES) continue
      const parsed = parseSkillDocument(data.toString('utf8'))
      if (!parsed) continue
      upsertSkill(skillSeen, { kind: 'skill', name: parsed.name, format: 'flat', entryPrefix: rel })
    }
  }

  // ---- Agent 预设候选：目录内含 preset.yml ----
  for (const rel of archive.byRel.keys()) {
    if (!/(^|\/)preset\.yml$/i.test(rel)) continue
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    if (!dir || isExcludedTree(dir, pruneRoots)) continue
    const name = dir.split('/').pop() ?? ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue
    if (presetSeen.has(name)) continue
    presetSeen.set(name, { kind: 'preset', name, entryPrefix: dir })
  }

  // ---- 插件候选（含 root 级插件与 suite 内多插件）----
  for (const rel of archive.byRel.keys()) {
    const base = rel.split('/').pop() ?? ''
    if (base !== 'package.json') continue
    const dir = rel.slice(0, rel.length - 'package.json'.length).replace(/\/$/, '')
    if (isExcludedTree(dir, pruneRoots)) continue
    const entry = archive.byRel.get(rel)
    if ((Number(entry?.header.size) || 0) > MAX_PACKAGE_JSON_BYTES) continue
    let manifest: { name?: unknown; version?: unknown }
    try {
      // 剥 UTF-8 BOM：真实插件包（如 dsh-routing-suite/preset）可能带 BOM，JSON.parse 会抛错。
      const raw = entry!.getData().toString('utf8')
      if (raw.length > MAX_PACKAGE_JSON_BYTES) {
        skipped.push({ entryPrefix: dir || '.', reason: 'package.json 实际体积超限' })
        continue
      }
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      manifest = JSON.parse(text) as { name?: unknown; version?: unknown }
    } catch {
      skipped.push({ entryPrefix: dir || '.', reason: 'package.json 无法解析' })
      continue
    }
    let packageName = typeof manifest.name === 'string' && isSafePackageName(manifest.name) ? manifest.name : ''
    if (!packageName) {
      // 回退：目录名（顶层目录 basename，或 suite 子目录名）。
      const baseDir = dir.split('/').pop() ?? ''
      if (baseDir && isSafePackageName(baseDir)) packageName = baseDir
    }
    if (!packageName) {
      skipped.push({ entryPrefix: dir || '.', reason: '包名缺失或非法' })
      continue
    }
    if (packageName.startsWith('__') && packageName.endsWith('__')) {
      skipped.push({ entryPrefix: dir || '.', reason: '模板包不可安装' })
      continue
    }
    if (pluginSeen.has(packageName)) continue
    pluginSeen.add(packageName)
    const plugin: RawScanPlugin = { kind: 'plugin', packageName, entryPrefix: dir }
    if (typeof manifest.version === 'string') plugin.version = manifest.version
    plugins.push(plugin)
  }

  // 根级插件（entryPrefix=''）只在它是唯一候选时合法：整个压缩包（或剥掉包裹层后）即该插件的本体。
  // 只要存在同级插件/技能/预设候选，根级 package.json 的「本体」就会吞掉同压缩包的其它组件，明确拒绝。
  const rootPlugins = plugins.filter(plugin => plugin.entryPrefix === '')
  if (rootPlugins.length > 0 && (plugins.length > rootPlugins.length || skillSeen.size > 0 || presetSeen.size > 0)) {
    for (const plugin of rootPlugins) {
      skipped.push({ entryPrefix: '.', reason: '根目录 package.json 会吞并同压缩包其它组件，不视为插件目录' })
    }
    plugins.splice(0, plugins.length, ...plugins.filter(plugin => plugin.entryPrefix !== ''))
  }

  const sortedPlugins = plugins.sort((a, b) => a.entryPrefix.localeCompare(b.entryPrefix))
  const sortedSkills = [...skillSeen.values()].sort((a, b) => a.entryPrefix.localeCompare(b.entryPrefix))
  const sortedPresets = [...presetSeen.values()].sort((a, b) => a.entryPrefix.localeCompare(b.entryPrefix))
  return {
    kind: 'raw',
    topName: archive.stripRoot,
    plugins: sortedPlugins,
    skills: sortedSkills,
    presets: sortedPresets,
    skipped,
  }
}

function upsertSkill(seen: Map<string, RawScanSkill>, candidate: RawScanSkill): void {
  const existing = seen.get(candidate.name)
  if (!existing) {
    seen.set(candidate.name, candidate)
    return
  }
  // 同名去重：路径浅优先，其次 bundle 优先于 flat（对齐 skill-catalog 的 preferTarget）。
  const leftDepth = existing.entryPrefix.split('/').length
  const rightDepth = candidate.entryPrefix.split('/').length
  if (rightDepth < leftDepth) seen.set(candidate.name, candidate)
  else if (rightDepth === leftDepth && candidate.format === 'bundle' && existing.format !== 'bundle') {
    seen.set(candidate.name, candidate)
  }
}

/** 共享解压字节计数器：跨候选/跨函数累计，防止 2 GiB 上限被拆成多个候选各自达标而绕过（zip-bomb）。 */
export interface ExtractByteBudget {
  extracted: number
}

/** 解出某个目录前缀下的全部普通文件到 destination（zip-slip + 实际字节上限，写入共享预算）。 */
async function extractUnderPrefix(
  archive: RawArchive,
  prefix: string,
  destination: string,
  limits: RawScanLimits,
  budget: ExtractByteBudget,
): Promise<number> {
  const resolved = path.resolve(destination)
  let extractedBytes = 0
  for (const [rel, entry] of archive.byRel) {
    // prefix='' 只出现在「整个压缩包即唯一插件」的合法情形，此时取全部条目。
    const relPrefix = prefix ? `${prefix}/` : ''
    if (!rel.startsWith(relPrefix)) continue
    const childRel = rel.slice(relPrefix.length)
    if (!childRel) continue
    const target = path.join(resolved, ...childRel.split('/'))
    assertInside(resolved, target)
    const data = entry.getData()
    extractedBytes += data.byteLength
    budget.extracted += data.byteLength
    if (budget.extracted > limits.maxExtractedBytes) throw new Error('整合包解压体积超过安全限制。')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
  }
  return extractedBytes
}

/**
 * 把选中的插件目录整棵解到 workDir/<packageName>（scoped 拆两级），返回 包名→目录。
 * 只解候选子树，不触碰 zip 其余内容（真实包 3.7 GiB 解压体积里只有候选部分真正落盘）。
 */
export async function extractRawPluginBodies(
  buffer: Uint8Array,
  plugins: RawScanPlugin[],
  workDir: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
  budget?: ExtractByteBudget,
): Promise<Map<string, string>> {
  const archive = openRawArchive(buffer, limits)
  const resolvedWorkDir = path.resolve(workDir)
  await mkdir(resolvedWorkDir, { recursive: true })
  // 未显式传入预算时，本次调用内仍共享同一预算（跨插件累计）；跨调用累计由 pack.ts 传入同一对象。
  const sharedBudget = budget ?? { extracted: 0 }
  const result = new Map<string, string>()
  for (const plugin of plugins) {
    const packageDirectory = path.join(resolvedWorkDir, ...plugin.packageName.split('/'))
    assertInside(resolvedWorkDir, packageDirectory)
    await extractUnderPrefix(archive, plugin.entryPrefix, packageDirectory, limits, sharedBudget)
    result.set(plugin.packageName, packageDirectory)
  }
  return result
}

/**
 * 解出选中技能到 workDir：bundle 整目录到 <name>/，flat 单文件到 <name>.md。
 * 返回 技能名→源目录（bundle）或单文件路径（flat）。
 */
export async function extractRawSkillSources(
  buffer: Uint8Array,
  skills: RawScanSkill[],
  workDir: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
  budget?: ExtractByteBudget,
): Promise<Map<string, string>> {
  const archive = openRawArchive(buffer, limits)
  const resolvedWorkDir = path.resolve(workDir)
  await mkdir(resolvedWorkDir, { recursive: true })
  // 与 extractRawPluginBodies 共用同一预算时（pack.ts 传入），插件 + 技能的累计解压字节统一封顶。
  const sharedBudget = budget ?? { extracted: 0 }
  const result = new Map<string, string>()
  for (const skill of skills) {
    if (skill.format === 'flat') {
      const target = path.join(resolvedWorkDir, `${skill.name}.md`)
      assertInside(resolvedWorkDir, target)
      const entry = archive.byRel.get(skill.entryPrefix)
      if (!entry) throw new Error(`技能来源缺失：${skill.entryPrefix}`)
      const data = entry.getData()
      sharedBudget.extracted += data.byteLength
      if (sharedBudget.extracted > limits.maxExtractedBytes) throw new Error('整合包解压体积超过安全限制。')
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
      result.set(skill.name, target)
    } else {
      const target = path.join(resolvedWorkDir, skill.name)
      assertInside(resolvedWorkDir, target)
      await extractUnderPrefix(archive, skill.entryPrefix, target, limits, sharedBudget)
      result.set(skill.name, target)
    }
  }
  return result
}

// ===========================================================================
// 流式路径 API（大整合包）
// ===========================================================================

export interface RawZipPath {
  handle: OpenZipPath
  byRel: Map<string, ZipPathEntry>
  stripRoot: string | null
}

/** 打开 raw 整合包的文件路径版本（不整包读入内存）。 */
export async function openRawZipFromPath(
  filePath: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
): Promise<RawZipPath> {
  const handle = await openZipPathFromFile(filePath, limits)
  try {
    const byRel = new Map<string, ZipPathEntry>()
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) continue
      const rel = handle.stripRoot && safe.startsWith(`${handle.stripRoot}/`) ? safe.slice(handle.stripRoot.length + 1) : safe
      if (rel && !byRel.has(rel)) byRel.set(rel, entry)
    }
    return { handle, byRel, stripRoot: handle.stripRoot }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** 文件路径版 scanRawPackZip。 */
export async function scanRawPackZipFromPath(
  filePath: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
): Promise<RawScanResult> {
  const archive = await openRawZipFromPath(filePath, limits)
  try {
    return await scanRawArchivePath(archive, limits)
  } finally {
    await archive.handle.close()
  }
}

async function scanRawArchivePath(archive: RawZipPath, limits: RawScanLimits): Promise<RawScanResult> {
  const pruneRoots = new Set<string>()
  for (const rel of archive.byRel.keys()) {
    const segments = rel.split('/')
    for (let i = 0; i + 1 < segments.length; i += 1) {
      if (segments[i + 1] === 'node_modules') {
        pruneRoots.add(segments.slice(0, i + 1).join('/'))
      }
    }
  }

  const plugins: RawScanPlugin[] = []
  const pluginSeen = new Set<string>()
  const skillSeen = new Map<string, RawScanSkill>()
  const presetSeen = new Map<string, RawScanPreset>()
  const skipped: RawScanResult['skipped'] = []

  for (const rel of archive.byRel.keys()) {
    if (/^SKILL\.md$/i.test(rel) || /\/SKILL\.md$/i.test(rel)) {
      const dir = rel.slice(0, rel.lastIndexOf('/'))
      if (isExcludedTree(dir, pruneRoots)) continue
      const entry = archive.byRel.get(rel)
      if ((Number(entry?.declaredSize) || 0) > MAX_SKILL_DOCUMENT_BYTES) continue
      let data: Buffer
      try {
        data = await archive.handle.readEntryData(entry!, MAX_SKILL_DOCUMENT_BYTES)
      } catch {
        continue
      }
      if (data.byteLength > MAX_SKILL_DOCUMENT_BYTES) continue
      const parsed = parseSkillDocument(data.toString('utf8'))
      if (!parsed) continue
      upsertSkill(skillSeen, { kind: 'skill', name: parsed.name, format: 'bundle', entryPrefix: dir })
      continue
    }
    if (likelyFlatSkill(rel)) {
      if (isExcludedTree(rel, pruneRoots)) continue
      const entry = archive.byRel.get(rel)
      if ((Number(entry?.declaredSize) || 0) > MAX_SKILL_DOCUMENT_BYTES) continue
      let data: Buffer
      try {
        data = await archive.handle.readEntryData(entry!, MAX_SKILL_DOCUMENT_BYTES)
      } catch {
        continue
      }
      if (data.byteLength > MAX_SKILL_DOCUMENT_BYTES) continue
      const parsed = parseSkillDocument(data.toString('utf8'))
      if (!parsed) continue
      upsertSkill(skillSeen, { kind: 'skill', name: parsed.name, format: 'flat', entryPrefix: rel })
    }
  }

  // ---- Agent 预设候选：目录内含 preset.yml ----
  for (const rel of archive.byRel.keys()) {
    if (!/(^|\/)preset\.yml$/i.test(rel)) continue
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    if (!dir || isExcludedTree(dir, pruneRoots)) continue
    const name = dir.split('/').pop() ?? ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue
    if (presetSeen.has(name)) continue
    presetSeen.set(name, { kind: 'preset', name, entryPrefix: dir })
  }

  for (const rel of archive.byRel.keys()) {
    const base = rel.split('/').pop() ?? ''
    if (base !== 'package.json') continue
    const dir = rel.slice(0, rel.length - 'package.json'.length).replace(/\/$/, '')
    if (isExcludedTree(dir, pruneRoots)) continue
    const entry = archive.byRel.get(rel)
    if ((Number(entry?.declaredSize) || 0) > MAX_PACKAGE_JSON_BYTES) continue
    let manifest: { name?: unknown; version?: unknown }
    try {
      const data = await archive.handle.readEntryData(entry!, MAX_PACKAGE_JSON_BYTES)
      if (data.byteLength > MAX_PACKAGE_JSON_BYTES) {
        skipped.push({ entryPrefix: dir || '.', reason: 'package.json 实际体积超限' })
        continue
      }
      const raw = data.toString('utf8')
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      manifest = JSON.parse(text) as { name?: unknown; version?: unknown }
    } catch {
      skipped.push({ entryPrefix: dir || '.', reason: 'package.json 无法解析' })
      continue
    }
    let packageName = typeof manifest.name === 'string' && isSafePackageName(manifest.name) ? manifest.name : ''
    if (!packageName) {
      const baseDir = dir.split('/').pop() ?? ''
      if (baseDir && isSafePackageName(baseDir)) packageName = baseDir
    }
    if (!packageName) {
      skipped.push({ entryPrefix: dir || '.', reason: '包名缺失或非法' })
      continue
    }
    if (packageName.startsWith('__') && packageName.endsWith('__')) {
      skipped.push({ entryPrefix: dir || '.', reason: '模板包不可安装' })
      continue
    }
    if (pluginSeen.has(packageName)) continue
    pluginSeen.add(packageName)
    const plugin: RawScanPlugin = { kind: 'plugin', packageName, entryPrefix: dir }
    if (typeof manifest.version === 'string') plugin.version = manifest.version
    plugins.push(plugin)
  }

  const rootPlugins = plugins.filter(plugin => plugin.entryPrefix === '')
  if (rootPlugins.length > 0 && (plugins.length > rootPlugins.length || skillSeen.size > 0 || presetSeen.size > 0)) {
    for (const plugin of rootPlugins) {
      skipped.push({ entryPrefix: '.', reason: '根目录 package.json 会吞并同压缩包其它组件，不视为插件目录' })
    }
    plugins.splice(0, plugins.length, ...plugins.filter(plugin => plugin.entryPrefix !== ''))
  }

  const sortedPlugins = plugins.sort((a, b) => a.entryPrefix.localeCompare(b.entryPrefix))
  const sortedSkills = [...skillSeen.values()].sort((a, b) => a.entryPrefix.localeCompare(b.entryPrefix))
  const sortedPresets = [...presetSeen.values()].sort((a, b) => a.entryPrefix.localeCompare(b.entryPrefix))
  return {
    kind: 'raw',
    topName: archive.stripRoot,
    plugins: sortedPlugins,
    skills: sortedSkills,
    presets: sortedPresets,
    skipped,
  }
}

async function extractUnderPrefixPath(
  archive: RawZipPath,
  prefix: string,
  destination: string,
  limits: RawScanLimits,
  budget: ExtractByteBudget,
): Promise<number> {
  const resolved = path.resolve(destination)
  let extractedBytes = 0
  for (const [rel, entry] of archive.byRel) {
    const relPrefix = prefix ? `${prefix}/` : ''
    if (!rel.startsWith(relPrefix)) continue
    const childRel = rel.slice(relPrefix.length)
    if (!childRel) continue
    const target = path.join(resolved, ...childRel.split('/'))
    assertInside(resolved, target)
    const written = await archive.handle.writeEntryToFile(entry, target, {
      budget,
      maxTotalBytes: limits.maxExtractedBytes,
    })
    extractedBytes += written
  }
  return extractedBytes
}

/** 文件路径版 extractRawPluginBodies。 */
export async function extractRawPluginBodiesFromPath(
  filePath: string,
  plugins: RawScanPlugin[],
  workDir: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
  budget?: ExtractByteBudget,
): Promise<Map<string, string>> {
  const archive = await openRawZipFromPath(filePath, limits)
  try {
    const resolvedWorkDir = path.resolve(workDir)
    await mkdir(resolvedWorkDir, { recursive: true })
    const sharedBudget = budget ?? { extracted: 0 }
    const result = new Map<string, string>()
    for (const plugin of plugins) {
      const packageDirectory = path.join(resolvedWorkDir, ...plugin.packageName.split('/'))
      assertInside(resolvedWorkDir, packageDirectory)
      await extractUnderPrefixPath(archive, plugin.entryPrefix, packageDirectory, limits, sharedBudget)
      result.set(plugin.packageName, packageDirectory)
    }
    return result
  } finally {
    await archive.handle.close()
  }
}

/** 文件路径版 extractRawSkillSources。 */
export async function extractRawSkillSourcesFromPath(
  filePath: string,
  skills: RawScanSkill[],
  workDir: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
  budget?: ExtractByteBudget,
): Promise<Map<string, string>> {
  const archive = await openRawZipFromPath(filePath, limits)
  try {
    const resolvedWorkDir = path.resolve(workDir)
    await mkdir(resolvedWorkDir, { recursive: true })
    const sharedBudget = budget ?? { extracted: 0 }
    const result = new Map<string, string>()
    for (const skill of skills) {
      if (skill.format === 'flat') {
        const target = path.join(resolvedWorkDir, `${skill.name}.md`)
        assertInside(resolvedWorkDir, target)
        const entry = archive.byRel.get(skill.entryPrefix)
        if (!entry) throw new Error(`技能来源缺失：${skill.entryPrefix}`)
        await archive.handle.writeEntryToFile(entry, target, {
          budget: sharedBudget,
          maxTotalBytes: limits.maxExtractedBytes,
        })
        result.set(skill.name, target)
      } else {
        const target = path.join(resolvedWorkDir, skill.name)
        assertInside(resolvedWorkDir, target)
        await extractUnderPrefixPath(archive, skill.entryPrefix, target, limits, sharedBudget)
        result.set(skill.name, target)
      }
    }
    return result
  } finally {
    await archive.handle.close()
  }
}

/** 文件路径版提取 raw 包中的 Agent 预设目录：解到 workDir/<name>。 */
export async function extractRawPresetSourcesFromPath(
  filePath: string,
  presets: RawScanPreset[],
  workDir: string,
  limits: RawScanLimits = DEFAULT_RAW_SCAN_LIMITS,
  budget?: ExtractByteBudget,
): Promise<Map<string, string>> {
  const archive = await openRawZipFromPath(filePath, limits)
  try {
    const resolvedWorkDir = path.resolve(workDir)
    await mkdir(resolvedWorkDir, { recursive: true })
    const sharedBudget = budget ?? { extracted: 0 }
    const result = new Map<string, string>()
    for (const preset of presets) {
      const target = path.join(resolvedWorkDir, preset.name)
      assertInside(resolvedWorkDir, target)
      await extractUnderPrefixPath(archive, preset.entryPrefix, target, limits, sharedBudget)
      result.set(preset.name, target)
    }
    return result
  } finally {
    await archive.handle.close()
  }
}
