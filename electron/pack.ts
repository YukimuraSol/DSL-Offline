// 整合包（Pack）管理的组装层。
//
// 职责：把底层模块（manifest / zip / export / registry / orchestration /
// installer 适配器）编排成渲染层可用的 PackManager。本模块不直接依赖
// Electron —— 对话框与「写用户选择的文件」由 ipc 层负责；DSH 插件的安装 /
// 卸载 / profile 读取全部委托给注入的 installer 适配器（main.ts 组装真实
// Installer，测试注入 stub）。

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppSettings,
  ApplicationInstallRequest,
  InstalledApplicationAddon,
  InstalledPreset,
  InstalledSkill,
  PackAnalysis,
  PackAnalysisItem,
  PackImportOptions,
  PackInstallResult,
  PackManifest,
  PackInstalledApplication,
  PackInstalledPlugin,
  PackInstalledPreset,
  PackInstalledSkill,
  PackPluginEntry,
  PackProgressEvent,
  PackStatus,
  PluginInstallTarget,
  PresetInstallRequest,
  PresetInstallResult,
  ProfileState,
  SessionImportPreview,
  SessionImportResult,
  SessionImportUndoResult,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInstallTarget,
} from '../src/types'
import { assertMeaningfulPackName, assertPackDshVersion, isValidPackDshVersion, manifestNameFromPackId, normalizePackDshVersion, packProfileName, parsePackManifest } from './pack-manifest'
import { extractOfflineSupportFromPath, extractPackBodiesFromPath, extractPresetBodiesFromPath, findManifestInArchiveFromPath, inspectPackZipFromPath } from './pack-zip'
import { validateFullArchive } from './profile-repository-import'
import { cleanPackNameHint, extractRawPluginBodiesFromPath, extractRawPresetSourcesFromPath, extractRawSkillSourcesFromPath, scanRawPackZipFromPath, type ExtractByteBudget } from './pack-scan'
import { SNAPSHOT_BODIES_DIR, SNAPSHOT_ZIP_LIMITS, describeSnapshotZip, extractSnapshot, planSnapshot, writeSnapshotZip, type SnapshotPrivacyCategory, type SnapshotPrivacyInclude } from './pack-snapshot'
import {
  SESSION_SKIP_LABELS,
  applySessionTransfer,
  findDanglingReferences,
  planSessionTransfer,
  undoSessionTransfer,
  writeTransferManifest,
  type SessionTransferPlan,
  type TransferManifest,
} from './session-transfer'
import { isDshVersionOlderThan } from '../src/lib/dsh-version'
import { parseDocument } from 'yaml'
import {
  readPackRegistry,
  removePackRecord,
  toPackStatus,
  upsertPackRecord,
  writePackRegistry,
  type PackRecord,
} from './pack-registry'
import {
  buildInstallResult,
  guardPackStart,
  runSerialInstall,
  type InstallableItem,
} from './pack-orchestration'
import { readPluginReceipts, removePluginReceipt, type PluginInstallReceipt } from './plugin-receipts'
import { readPresetReceipts } from './preset-receipts'
import { readInstalledPresets } from './preset-install'
import { readSkillReceipts } from './skill-receipts'
import { readInstalledSkills } from './skill-format'
import { createProfileSnapshot, restoreProfileSnapshot, type ProfileSnapshot } from './ai-install'
import { isDesktopHomeProfile, isSafePackageName, isSafeProfileName, reorderPlugins } from './profile'
import { samePath } from './settings'
import { assertLauncherOwnedHome, type HomeScope } from './home-scope'
import { resolveProfileName } from './instances'
import { DEFAULT_PROFILE_NAME } from '../src/constants'
import { ensureProfileCoreBundles, profileManifestName, readProfileMetadata, writeProfileMetadata } from './profile-service'
import { readPackManifest, removePackManifest, writePackManifest } from './pack-manifest-store'
import { adoptPackFromFolder as adoptHomeAsPack, inspectAdoptableHome, readProfilePlugins } from './pack-adopt'
import { KERNEL_SCOPES } from './pack-verify'

/** 扩展 PluginInstallTarget：携带 GitHub 仓库名，供 github / npm 源重建安装目标。 */
export type PackInstallTarget = PluginInstallTarget & { repository?: string; defaultBranch?: string; targetId?: string; allowBuilds?: string[]; denyBuilds?: string[] }

/** pack 管理器依赖的最小 installer 面（main.ts 组装真实 Installer，测试注入 stub）。 */
export interface InstallInstaller {
  installPluginTarget(target: PackInstallTarget, profileOverride?: string): Promise<unknown>
  installNpmPackage?(request: { packageName: string; version?: string; repository?: string; approvedBuildKeys?: string[]; deniedBuildKeys?: string[] }, profileOverride?: string): Promise<unknown>
  /** raw 整合包导入的技能：从本地源目录/单文件全局安装到 dshHome/skills。 */
  installSkillLocal(dshHome: string, skill: { name: string; format: 'bundle' | 'flat'; sourceDir: string }): Promise<unknown>
  /** 从仓库安装一个 Skill（标准清单导入用）。 */
  installSkill(request: SkillInstallRequest): Promise<SkillInstallResult>
  /** 按固定 pin 安装一个 Skill（标准清单导入用，不重新分析 HEAD）。 */
  installSkillPinned(request: { repository: string; target: SkillInstallTarget }): Promise<InstalledSkill>
  /** 启用或停用一个本地 Skill。 */
  toggleSkill(name: string, enabled: boolean): Promise<InstalledSkill[]>
  /** 安装一个 Agent 预设（全局安装到 DSH 预设目录）。 */
  installPreset(request: PresetInstallRequest): Promise<PresetInstallResult>
  /** 从本地 staging 目录安装 Agent 预设（raw 整合包导入用）。 */
  installPresetLocal(dshHome: string, preset: { name: string; sourceDir: string }): Promise<unknown>
  /** 启用或停用一个本地 Agent 预设。 */
  togglePreset(name: string, enabled: boolean): Promise<InstalledPreset[]>
  remove(packageName: string, profileName?: string): Promise<unknown>
  readProfile(dshHome: string, profileName: string): Promise<ProfileState>
  togglePlugin(dshHome: string, profileName: string, packageName: string, enabled: boolean): Promise<ProfileState>
  reorderPlugins?(dshHome: string, profileName: string, packageNames: string[]): Promise<ProfileState>
}

export interface PackManagerOptions {
  readSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  /** packs.json 注册表路径。 */
  registryPath: string
  /** 本地整合包清单目录；每个包一个 YAML，不创建 DSH Profile。 */
  manifestRoot?: string
  /** 快照落盘目录（对齐 ai-install）。 */
  snapshotRoot: string
  /** 会话记录跨包搬运的撤销清单目录；缺省 packs.json 同级的 pack-session-imports/。 */
  sessionImportsRoot?: string
  /** 插件安装凭据文件路径。 */
  pluginReceiptsPath: string
  /** Agent 预设安装凭据文件路径。 */
  presetReceiptsPath: string
  /** Skill 安装凭据文件路径。 */
  skillReceiptsPath: string
  /** Application Addon 管理器（用于读取/安装/卸载应用加载项）。 */
  applicationAddons: {
    list(): Promise<InstalledApplicationAddon[]>
    install(request: ApplicationInstallRequest): Promise<unknown>
    uninstall(id: string): Promise<InstalledApplicationAddon[]>
    toggle?(id: string, enabled: boolean): Promise<InstalledApplicationAddon[]>
  }
  installer: InstallInstaller
  emitOutput?: (level: 'info' | 'error' | 'success', text: string) => void
  emitEvent: (event: PackProgressEvent) => void
  isRuntimeRunning: () => boolean
  isInstallerBusy: () => boolean
  /**
   * 某个整合包此刻是否**真的在运行**（按实例判断，不是「它是当前选中的包」）。
   * 不传 = 一律当作没在跑：单测与旧调用方没有运行态，删除不该被一个不存在的实例拦住。
   */
  isPackRunning?: (packId: string) => boolean
  /** 删除一个正在运行的包前，先把它停掉并等停止完成；不传则会明确报错让调用方自己先停。 */
  stopPack?: (packId: string) => Promise<void>
  /** 覆盖 DSH_HOME；缺省从 settings 读取。 */
  dshHome?: string
  /** 新运行态：把每个整合包 id materialize 为 Profile。 */
  unifiedProfiles?: boolean
  /** 新整合包私有 DSH 家目录的根（真隔离载体）；缺省 packs.json 同级的 dsh-packs/。 */
  packsRoot?: string
  /** 读未派生的存储态（settings.json 里的默认家目录）。 */
  readStoredSettings?: () => Promise<AppSettings>
  /** 确保某 DSH 版本已安装（缺失时补装）；激活/新建包时绑定版本用。 */
  ensureDshVersionInstalled?: (version: string) => Promise<void>
  /** 把启动可执行文件切到某个已安装的托管 DSH 版本。 */
  selectDshVersion?: (version: string) => Promise<void>
  /** 包创建（新建/导入）后回调（刷新列表等）。 */
  onPackCreated?: (packId: string) => void
  /** 解析启动器 node 可执行文件路径（导出依赖 tarball 用）；不可用返回 null。 */
  getNodeExecutable?: () => Promise<string | null>
  /** 全离线导入：把 zip 内依赖 tarball 灌入 pnpm store，再对 profile 离线 install。失败抛错（调用方回退在线）。 */
  offlinePackInstall?: (params: { tarballDir: string; profileDir: string; onOutput: (line: string) => void }) => Promise<void>
  /**
   * 内置目录的归属边界（删包/回滚前的前置守卫）。
   * 缺省按 packs.json 所在目录（= userData）与 packsRoot 推断，单测不需要额外传。
   */
  homeScope?: HomeScope
}

export interface PackManager {
  listPacks(): Promise<PackStatus[]>
  isBusy(): boolean
  analyzeImport(filePath: string): Promise<PackAnalysis>
  importPack(filePath: string, items?: string[], options?: PackImportOptions): Promise<PackInstallResult>
  exportPack(packId: string, include?: SnapshotPrivacyInclude, targetZipPath?: string): Promise<{ zipPath: string; fileName: string }>
  /** 预览把源包的会话记录搬进目标包会做什么（只读）。 */
  previewSessionImport(sourcePackId: string, targetPackId: string): Promise<SessionImportPreview>
  /** 执行会话记录搬运：只新增不覆盖，返回结果与撤销凭据。 */
  importSessionHistory(sourcePackId: string, targetPackId: string): Promise<SessionImportResult>
  /** 按 undoId 撤销一次搬运；被 DSH 追加过的文件不会被删。 */
  undoSessionImport(undoId: string): Promise<SessionImportUndoResult>
  activatePack(packId: string): Promise<AppSettings>
  removePack(packId: string): Promise<{ removed: number }>
  renamePack(packId: string, name: string): Promise<PackStatus>
  /**
   * 新建空白整合包：私有家目录 + 选定 DSH 版本，不自动激活。
   * `folderName` 是磁盘上的文件夹名（= 包标识 = Profile 名），省略时按显示名派生。
   */
  createBlankPack(request: { name: string; dshVersion: string | null; folderName?: string | null }): Promise<PackStatus>
  /** 收编一个已存在的 DSH 家目录为整合包：只登记 homePath，不拷贝、不移动。 */
  adoptPackFromFolder(homePath: string, name?: string): Promise<PackStatus>
  /**
   * 升版副本：把这个包整份复制成一个新整合包，新包认另一个 DSH 版本，旧包原样留着。
   * 复制走快照管线（含隐私，因为这是同一台机器上自己的东西），于是 profiles/<旧id>
   * 改名、符号链接重建、包外本体相对化这些细节与"导入别人给的包"完全一致。
   * 见 docs/adr/0002：故意不做原地升级，也不做兼容性预检。
   */
  createVersionClone(packId: string, request: { dshVersion: string; name?: string }): Promise<PackStatus>
  /** 整合包私有目录占用字节数（删除确认框展示）。 */
  packDiskUsage(packId: string): Promise<number>
  /** 取（必要时创建）整合包的附件目录 <家目录>/extras/ 并返回绝对路径；调用方负责打开它。 */
  openPackExtras(packId: string): Promise<string>
  /**
   * 导出前几件里的「附件」：<家目录>/extras 是否存在、顶层几条。
   * 只读 —— 不存在也不替用户建，界面要靠这个「不存在」说缺件。
   * 计数口径与列表行的 extrasCount 一致：readdir 顶层条目数，子目录算 1 条。
   */
  packExtras(packId: string): Promise<{ exists: boolean; count: number }>
  rollback(): Promise<{ restored: number; profileName: string }>
  hasSnapshot(): Promise<boolean>
  addPackPlugin(packId: string, packageName: string): Promise<PackStatus>
  addPackPreset(packId: string, presetName: string): Promise<PackStatus>
  addPackSkill(packId: string, skillName: string): Promise<PackStatus>
  addPackApplication(packId: string, addonId: string): Promise<PackStatus>
  togglePackItem(packId: string, packageName: string, enabled: boolean): Promise<PackStatus>
  togglePackPreset(packId: string, presetName: string, enabled: boolean): Promise<PackStatus>
  togglePackSkill(packId: string, skillName: string, enabled: boolean): Promise<PackStatus>
  togglePackApplication(packId: string, addonId: string, enabled: boolean): Promise<PackStatus>
  removePackItem(packId: string, packageName: string): Promise<PackStatus>
  removePackPreset(packId: string, presetName: string): Promise<PackStatus>
  removePackSkill(packId: string, skillName: string): Promise<PackStatus>
  removePackApplication(packId: string, addonId: string): Promise<PackStatus>
}

/**
 * 含隐私导出包里的警告文件。**文件名用 ASCII**：压缩包里的非 ASCII 文件名在部分解压
 * 工具下会乱码，那时警告反而看不见。内容给人读，用中文。
 */
export const PRIVACY_WARNING_FILENAME = '_PRIVATE-DO-NOT-SHARE.txt'

/**
 * 改新包 profile.yaml 里的 dshVersion：升版副本的全部意义就在这一行。
 * 注册表记录同样带版本，激活时以记录为准，这里是让包内自述与之一致。
 */
async function setProfileDshVersion(home: string, packId: string, version: string): Promise<void> {
  const target = path.join(home, 'profiles', packId, 'profile.yaml')
  const text = await readFile(target, 'utf8').catch(() => null)
  if (text === null) return
  const next = /^dshVersion:.*$/m.test(text)
    ? text.replace(/^dshVersion:.*$/m, `dshVersion: ${version}`)
    : `dshVersion: ${version}\n${text}`
  await writeFile(target, next, 'utf8')
}

/**
 * DSH 的数据格式只往上升：跑过一次新 DSH，包里的会话记录就被就地写成新格式，而旧 DSH 里没有
 * 反向的迁移边——轻则记录整批看不见，重则在 Web 服务绑定端口之前就退出。所以凡"把 A 版包的
 * 数据交给更旧的 B 版去跑"的操作都要当场拦下，而不是等启动失败再让启动器背锅。
 * 任一侧没有版本标注（raw 包 / 旧记录）就不拦：猜出来的拒绝比读不到的元数据更伤人。
 */
function downgradeRejection(sourceVersion: string | null | undefined, targetVersion: string | null | undefined): string | null {
  if (!isDshVersionOlderThan(targetVersion, sourceVersion)) return null
  return `DSH ${targetVersion} 比这份数据现在的版本（${sourceVersion}）更旧：新版跑过一次之后，聊天记录等数据就被写成旧版读不懂的格式，切回去会看不见记录甚至起不来。要用 ${targetVersion} 请新建一个空整合包；也可以往 ${sourceVersion} 或更高的版本复制。`
}

function privacyWarningText(packName: string, categories: SnapshotPrivacyCategory[]): string {
  const lines = ['这个整合包里带的是私人的东西，不是可以分享的内容。', '']
  if (categories.includes('credentials')) lines.push('- API 密钥：拿到这个包的人可以直接用它花你的额度。')
  if (categories.includes('sessions')) lines.push('- 会话记录：包含对话内容、会话里收发过的文件，以及你电脑上的文件夹路径。')
  lines.push('', '要分享整合包，请回到启动器用默认方式（不勾选任何隐私项）重新导出一份。', `导出时间：${new Date().toISOString()}`)
  return `${lines.join('\n')}\n`.replace(/^/, `包名：${packName}\n`)
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '未知错误'
}

/** 打包百分比：字节计数可能因节流略微超过总量，夹在 0-100 之间。 */
function packPercent(written: number, total: number): number | null {
  if (!(total > 0)) return null
  return Math.max(0, Math.min(100, Math.round((written / total) * 100)))
}

/** 创建/导出整合包时解析当前启动器实际使用的 DSH 精确版本。 */
async function resolvePackDshVersion(settings: AppSettings, requested?: string): Promise<string> {
  const candidates = [requested, settings.dshVersion]
  for (const candidate of candidates) {
    if (isValidPackDshVersion(candidate)) return normalizePackDshVersion(candidate)
  }

  // 兼容旧设置：版本目录名本身包含精确版本。
  const versionMatch = settings.launchExecutable.match(/[\\/]versions[\\/]([^\\/]+)[\\/]/i)
  if (versionMatch?.[1] && isValidPackDshVersion(versionMatch[1])) return normalizePackDshVersion(versionMatch[1])

  // 再从当前 dsh 包的 package.json 读取，避免把范围表达式写入整合包。
  const executable = path.resolve(settings.launchExecutable)
  const runtimeRoot = path.dirname(path.dirname(path.dirname(executable)))
  try {
    const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    if (isValidPackDshVersion(manifest.version)) return normalizePackDshVersion(manifest.version)
  } catch {
    // 下面统一给出缺少精确版本的提示。
  }
  throw new Error('当前 DSH 没有可记录的精确版本，请先在“运行环境”中选择或安装一个 DSH 版本。')
}

function assertSafePackId(packId: string): void {
  if (typeof packId !== 'string' || !isSafeProfileName(packId)) throw new Error('整合包标识无效。')
}

/**
 * 原子删除目录：先 rename 到同级 `.deleting-<时间戳>` 回收站名，再 rm。
 * rename 失败（目录被占用——DSH 进程还活着，哪怕启动器热重启后已不认识它）
 * 时抛错且**原目录分毫未动**，杜绝「记录还在、内容已被删了一半」的毁包状态；
 * rename 成功但 rm 失败（回收站内仍有锁文件）时原目录已离开原位，删除照常成立，
 * 残留回收站交给 listPacks 的启动清扫兜底。
 */
async function removeDirectoryAtomically(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) return
  const trash = `${dirPath}.deleting-${Date.now()}`
  try {
    await rename(dirPath, trash)
  } catch (error) {
    throw new Error(`无法删除：包内文件正被占用（DSH 可能仍在后台运行）。${asErrorMessage(error)}`)
  }
  await rm(trash, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * 启动 DSH 前的守卫：零包状态（用户删光了整合包）没有可运行的环境，
 * 明确报错引导去「整合包」页新建或导入，而不是拿默认家目录静默启动。
 */
export function assertActivePackForStart(settings: AppSettings): void {
  if (!settings.activePackId) throw new Error('还没有整合包：先到「整合包」页新建或导入一个，再启动。')
}

export function createPackManager(options: PackManagerOptions): PackManager {
  let active = false
  let snapshot: ProfileSnapshot | null = null
  /** 兼容旧快照字段；共享 Profile 模式下始终为 false。 */
  let profileWasNew = false
  /** 本次导入是否新建了私有家目录（回滚时整家删除；覆盖导入则只还原文件）。 */
  let provisionedNewHome = false
  const manifestRoot = options.manifestRoot ?? path.join(path.dirname(options.registryPath), 'pack-manifests')
  const baselinePath = path.join(manifestRoot, 'default-state.json')

  async function ensureUnifiedProfile(dshHome: string, profileName: string, sourceProfileName: string, metadata: { description?: string; dshVersion?: string | null; source?: 'zip' | 'yaml' | 'local' | 'github' }): Promise<void> {
    const target = path.join(dshHome, 'profiles', profileName)
    if (!existsSync(target)) await mkdir(target, { recursive: true })
    const source = path.join(dshHome, 'profiles', sourceProfileName)
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const sourceFile = path.join(source, file)
      const targetFile = path.join(target, file)
      if (!existsSync(targetFile) && existsSync(sourceFile)) await cp(sourceFile, targetFile)
    }
    if (!existsSync(path.join(target, 'package.json'))) {
      await writeFile(path.join(target, 'package.json'), `${JSON.stringify({ name: profileManifestName(profileName), private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`, 'utf8')
    }
    await ensureProfileCoreBundles(target)
    await writeProfileMetadata(dshHome, profileName, {
      description: metadata.description ?? '',
      dshVersion: metadata.dshVersion ?? null,
      source: metadata.source === 'github' ? { kind: 'github', repository: '' } : metadata.source === 'zip' || metadata.source === 'yaml' ? { kind: 'import', format: metadata.source } : { kind: 'local' },
    })
  }

  type BaselineState = {
    profileName: string
    activeBundles: string[]
    enabledPlugins: string[]
    skills: string[]
    presets: string[]
    applications: string[]
  }

  const getDshHome = async (): Promise<string> => options.dshHome || (await options.readSettings()).dshHome
  const packsRoot = options.packsRoot ?? path.join(path.dirname(options.registryPath), 'dsh-packs')
  // 归属边界：只有这些目录之内的「家目录」才允许被整棵删除 / 覆盖写。
  const homeScope: HomeScope = options.homeScope ?? {
    userData: path.dirname(options.registryPath),
    packsRoot,
    managedDshRoot: path.join(path.dirname(options.registryPath), 'dsh-runtime'),
  }
  const sessionImportsRoot = options.sessionImportsRoot ?? path.join(path.dirname(options.registryPath), 'pack-session-imports')

  /** 存储的默认家目录（无私有目录的包共用；不受激活包派生影响）。 */
  async function defaultHome(): Promise<string> {
    if (options.dshHome) return options.dshHome
    const stored = options.readStoredSettings ? await options.readStoredSettings() : await options.readSettings()
    return stored.dshHome
  }

  /** 某包真正存放 Profile/技能/预设的根目录：私有目录优先，缺省落回默认家目录。 */
  async function homeOfRecord(record: Pick<PackRecord, 'homePath'>): Promise<string> {
    return record.homePath ?? await defaultHome()
  }

  /** 递归统计目录占用字节（条目数封顶，异常目录不失控）。 */
  async function directorySize(root: string, budget: { entries: number } = { entries: 400_000 }): Promise<number> {
    if (budget.entries-- <= 0) return 0
    let total = 0
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (budget.entries-- <= 0) break
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) total += await directorySize(full, budget)
      else {
        try {
          total += (await stat(full)).size
        } catch { /* 竞态删除，忽略 */ }
      }
    }
    return total
  }

  /** 新包骨架：私有家目录 + profiles/<id>（核心 bundle + 元数据）。 */
  async function seedPackHome(home: string, packId: string, meta: { description?: string; dshVersion?: string | null }): Promise<void> {
    await mkdir(path.join(home, 'profiles'), { recursive: true })
    await ensureUnifiedProfile(home, packId, packId, { description: meta.description ?? '', dshVersion: meta.dshVersion ?? null, source: 'local' })
  }

  async function resolveImportedProfileId(
    baseId: string,
    dshHome: string,
    records: PackRecord[],
    importOptions?: PackImportOptions,
  ): Promise<string> {
    const occupied = (candidate: string) => records.some(record => record.id === candidate)
      || existsSync(path.join(dshHome, 'profiles', candidate))
    if (importOptions?.overwrite) {
      if (!occupied(baseId)) throw new Error(`无法覆盖不存在的整合包「${baseId}」。`)
      return baseId
    }
    if (!occupied(baseId)) return baseId
    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${baseId}-${index}`
      if (isSafeProfileName(candidate) && !occupied(candidate)) return candidate
    }
    throw new Error(`整合包「${baseId}」已存在，无法生成新的导入名称。`)
  }

  /**
   * 导入前置供给（真隔离的关键一步）：先把新包写进注册表（带私有家目录）并**立即激活**——
   * 派生后的 dshHome 即指向新包目录，后续所有安装动作（npm add、技能/预设落盘、快照）
   * 自然写进新包，整条既有安装管线零改动。覆盖导入时沿用既有记录的 homePath。
   */
  /**
   * 同名导入冲突时 resolveImportedProfileId 会给 id 追加 -N 后缀，显示名跟着变成「原名 (N)」，
   * 避免列表里出现两个一模一样的名字。
   *
   * 必须显式传「加后缀前的基础 id」，不能拿显示名反推 id：中文显示名经 packProfileName 会被换成
   * 一串 `-`，而快照导入的 id 来自 zip 内的 profileId，两者本来就对不上——官方默认整合包（中文名）
   * 重复下载正是这种情形，反推会算不出后缀、列表里出现两个同名包。
   */
  function importPackDisplayName(packId: string, baseId: string, baseName: string): string {
    if (packId === baseId) return baseName
    const prefix = `${baseId}-`
    if (!packId.startsWith(prefix)) return baseName
    const suffix = packId.slice(prefix.length)
    return /^\d+$/.test(suffix) ? `${baseName} (${suffix})` : baseName
  }

  async function provisionPackHome(params: {
    packId: string
    existing: PackRecord[]
    meta: { name: string; description: string; version: string; dshVersion?: string | null; source: PackRecord['source'] }
  }): Promise<string> {
    const prior = params.existing.find(record => record.id === params.packId)
    provisionedNewHome = !prior?.homePath
    const homePath = prior?.homePath ?? path.join(packsRoot, params.packId)
    if (params.meta.dshVersion && options.ensureDshVersionInstalled) {
      await options.ensureDshVersionInstalled(params.meta.dshVersion)
      const before = await options.readSettings()
      if (before.dshVersion !== params.meta.dshVersion && options.selectDshVersion) {
        try {
          await options.selectDshVersion(params.meta.dshVersion)
        } catch (error) {
          log('error', `切换 DSH ${params.meta.dshVersion} 失败，导入继续使用当前版本：${asErrorMessage(error)}`)
        }
      }
    }
    await seedPackHome(homePath, params.packId, { description: params.meta.description, dshVersion: params.meta.dshVersion })
    const now = new Date().toISOString()
    await upsertPackRecord(options.registryPath, {
      id: params.packId,
      name: params.meta.name,
      description: params.meta.description,
      version: params.meta.version,
      ...(params.meta.dshVersion ? { dshVersion: params.meta.dshVersion } : {}),
      homePath,
      source: params.meta.source,
      installedAt: prior?.installedAt ?? now,
      updatedAt: now,
      state: 'partial',
      plugins: prior?.plugins ?? [],
      ...(prior?.skills ? { skills: prior.skills } : {}),
      ...(prior?.presets ? { presets: prior.presets } : {}),
      ...(prior?.applications ? { applications: prior.applications } : {}),
    })
    const settings = options.readStoredSettings ? await options.readStoredSettings() : await options.readSettings()
    await options.saveSettings({
      ...settings,
      activePackId: params.packId,
      profileName: params.packId,
      ...(params.meta.dshVersion ? { dshVersion: params.meta.dshVersion } : {}),
    })
    return homePath
  }

  /** 离线导入的插件本体缓存，不与 DSH Profile 绑定。 */
  function packBodiesDir(dshHome: string, packId: string): string {
    // 离线本体缓存属于启动器，不属于任何 DSH Profile；清单仍是整合包的唯一配置。
    return path.join(dshHome, '.dsh-launcher-pack-bodies', packId)
  }

  /**
   * Imported plugin bodies are immutable package content. Keep one physical
   * copy per package/version and let each Profile retain only its own pnpm
   * link layer and activation order.
   */
  async function sharedPluginBodyDir(dshHome: string, packageName: string, sourceDir: string): Promise<string> {
    if (!options.unifiedProfiles) return sourceDir
    let version = 'local'
    try {
      const manifest = JSON.parse(await readFile(path.join(sourceDir, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        version = manifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
      }
    } catch {
      // The installer will report a precise invalid-body error below.
    }
    const destination = path.join(dshHome, '.dsh-launcher-plugin-bodies', ...packageName.split('/'), version)
    if (!existsSync(destination)) {
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(sourceDir, destination, { recursive: true })
    }
    return destination
  }

  async function readBaseline(): Promise<BaselineState | null> {
    try {
      return JSON.parse(await readFile(baselinePath, 'utf8')) as BaselineState
    } catch {
      return null
    }
  }

  async function saveBaseline(state: BaselineState): Promise<void> {
    await mkdir(manifestRoot, { recursive: true })
    await writeFile(baselinePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  async function clearBaseline(): Promise<void> {
    await rm(baselinePath, { force: true }).catch(() => undefined)
  }

  async function currentBaseline(settings: AppSettings): Promise<BaselineState> {
    const dshHome = await getDshHome()
    const profile = await options.installer.readProfile(dshHome, settings.profileName)
    const skills = (await readSkillReceipts(options.skillReceiptsPath)).map(item => item.name)
    const presets = (await readPresetReceipts(options.presetReceiptsPath)).map(item => item.name)
    const applications = (await options.applicationAddons.list()).filter(item => item.enabled).map(item => item.id)
    return {
      profileName: settings.profileName,
      activeBundles: profile.activeBundles,
      enabledPlugins: profile.plugins.filter(item => item.enabled).map(item => item.packageName),
      skills,
      presets,
      applications,
    }
  }

  async function applyPluginSet(profileName: string, desired: PackInstalledPlugin[], order: string[]): Promise<ProfileState> {
    const dshHome = await getDshHome()
    let profile = await options.installer.readProfile(dshHome, profileName)
    const desiredSet = new Set(desired.filter(item => item.enabled).map(item => item.packageName))
    for (const plugin of profile.plugins) {
      if (plugin.builtin) continue
      const shouldEnable = desiredSet.has(plugin.packageName)
      if (plugin.enabled !== shouldEnable) {
        profile = await options.installer.togglePlugin(dshHome, profileName, plugin.packageName, shouldEnable)
      }
    }
    // 安装器可能在读取 profile 后补齐依赖，再读一次后只把清单中的插件排在前面，核心/依赖保持现有相对顺序。
    profile = await options.installer.readProfile(dshHome, profileName)
    const core = profile.activeBundles.filter(name => profile.plugins.find(item => item.packageName === name)?.builtin)
    const requested = order.filter(name => profile.activeBundles.includes(name) && !core.includes(name))
    const remaining = profile.activeBundles.filter(name => !core.includes(name) && !requested.includes(name))
    const nextOrder = [...core, ...requested, ...remaining]
    if (nextOrder.length === profile.activeBundles.length && nextOrder.some((name, index) => name !== profile.activeBundles[index])) {
      profile = await reorderSharedProfile(profileName, nextOrder)
    }
    return profile
  }

  async function reorderSharedProfile(profileName: string, packageNames: string[]): Promise<ProfileState> {
    const dshHome = await getDshHome()
    const current = await options.installer.readProfile(dshHome, profileName)
    if (packageNames.length !== current.activeBundles.length) return current
    return options.installer.reorderPlugins
      ? options.installer.reorderPlugins(dshHome, profileName, packageNames)
      : reorderPlugins(dshHome, profileName, packageNames)
  }

  async function restoreBaseline(settings: AppSettings): Promise<void> {
    const baseline = await readBaseline()
    if (!baseline) {
      await options.saveSettings({ ...settings, activePackId: null })
      return
    }
    const dshHome = await getDshHome()
    let profile = await options.installer.readProfile(dshHome, baseline.profileName)
    const enabled = new Set(baseline.enabledPlugins)
    for (const plugin of profile.plugins) {
      if (plugin.builtin) continue
      const shouldEnable = enabled.has(plugin.packageName)
      if (plugin.enabled !== shouldEnable) profile = await options.installer.togglePlugin(dshHome, baseline.profileName, plugin.packageName, shouldEnable)
    }
    profile = await options.installer.readProfile(dshHome, baseline.profileName)
    const order = baseline.activeBundles.filter(name => profile.activeBundles.includes(name))
    const remaining = profile.activeBundles.filter(name => !order.includes(name))
    const fullOrder = [...order, ...remaining]
    if (fullOrder.length === profile.activeBundles.length && fullOrder.some((name, index) => name !== profile.activeBundles[index])) {
      await reorderSharedProfile(baseline.profileName, fullOrder)
    }
    await clearBaseline()
    await options.saveSettings({ ...settings, activePackId: null })
  }

  async function reapplyCurrentSelection(settings: AppSettings, fallback: ProfileState): Promise<void> {
    if (settings.activePackId) {
      const activeRecord = await findRecord(settings.activePackId).catch(() => null)
      if (activeRecord) {
        await applyPluginSet(settings.profileName, activeRecord.plugins, activeRecord.plugins.map(item => item.packageName))
        return
      }
    }
    const desired = fallback.plugins
      .filter(item => !item.builtin)
      .map(item => ({ packageName: item.packageName, enabled: item.enabled }))
    await applyPluginSet(settings.profileName, desired, fallback.activeBundles)
  }

  async function writeRecordManifest(record: PackRecord, sourceManifest?: PackManifest): Promise<void> {
    const existing = sourceManifest ?? await readPackManifest(manifestRoot, record.id)
    const existingPlugins = new Map((existing?.plugins ?? []).map(item => [item.packageName, item]))
    const dshVersion = isValidPackDshVersion(record.dshVersion)
      ? normalizePackDshVersion(record.dshVersion)
      : isValidPackDshVersion(existing?.dshVersion)
        ? normalizePackDshVersion(existing.dshVersion)
        : undefined
    const plugins: PackPluginEntry[] = record.plugins.map(item => ({
      ...existingPlugins.get(item.packageName),
      packageName: item.packageName,
      enabled: item.enabled,
    }))
    await writePackManifest(manifestRoot, record.id, {
      name: record.name,
      description: record.description || `DSH 整合包：${record.name}`,
      version: record.version,
      ...(dshVersion ? { dshVersion } : {}),
      plugins,
      ...(record.presets?.length ? { presets: record.presets.map(item => ({ name: item.name })) } : {}),
      ...(record.skills?.length ? { skills: record.skills.map(item => ({ name: item.name, format: item.format })) } : {}),
    })
  }

  /** 新任务开始：占住互斥位、丢弃上一个任务的快照与「是否新建 profile」标记。 */
  function beginTask(): void {
    active = true
    snapshot = null
    profileWasNew = false
    provisionedNewHome = false
  }

  const log = (level: 'info' | 'error' | 'success', text: string): void => {
    options.emitOutput?.(level, text)
  }

  /** manifest 插件条目 → 可安装 target。source 非 npm 且无 repository 时无法联网安装，返回 null。 */
  function manifestEntryToTarget(entry: PackPluginEntry | undefined, profileName: string): PackInstallTarget | null {
    if (!entry || !isSafePackageName(entry.packageName)) return null
    const source: 'npm' | 'github' = entry.source === 'npm' ? 'npm' : 'github'
    const target: PackInstallTarget = {
      id: entry.targetId ?? entry.packageName,
      packageName: entry.packageName,
      version: entry.version ?? null,
      source,
      profileName,
      platform: 'unknown',
      subdirectory: entry.subdirectory ?? null,
      commit: entry.commit ?? '',
      defaultBranch: entry.defaultBranch,
      targetId: entry.targetId,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
      allowBuilds: entry.allowBuilds,
      denyBuilds: entry.denyBuilds,
    }
    if (source === 'github') {
      if (!entry.repository) return null
      target.repository = entry.repository
    }
    return target
  }

  async function installManifestPlugin(target: PackInstallTarget): Promise<void> {
    if (target.source === 'local-directory') {
      await options.installer.installPluginTarget(target, target.profileName)
      return
    }
    if (target.source === 'npm' && options.installer.installNpmPackage) {
      await options.installer.installNpmPackage({
        packageName: target.packageName,
        version: target.version ?? undefined,
        repository: target.repository,
        approvedBuildKeys: target.allowBuilds,
        deniedBuildKeys: target.denyBuilds,
      }, target.profileName)
      return
    }
    if (!options.unifiedProfiles) {
      await options.installer.installPluginTarget(target)
      return
    }
    await options.installer.installPluginTarget({
      repository: target.repository ?? `npm:${target.packageName}`,
      defaultBranch: target.defaultBranch ?? 'main',
      targetId: target.targetId ?? target.id,
      commit: target.commit || undefined,
      version: target.version ?? undefined,
    } as PackInstallTarget, target.profileName)
  }

  function guarded(): string | null {
    return guardPackStart({
      isRuntimeRunning: options.isRuntimeRunning,
      isInstallerBusy: options.isInstallerBusy,
      isPackBusy: () => active,
    })
  }

  /**
   * 「只动单个包自己的家目录」类操作专用守卫：只查安装器忙与包操作互斥，不查运行时。
   * 新包落在 packsRoot/<id>，写的是自己的目录，改不到正在运行的那个实例；
   * 切换实例只改 settings 里的 activePackId/profileName，也不碰任何进程；
   * 删除只删 packId 那一个家目录（它自己在跑的话由调用方先停，见 removePack）。
   * 谁在跑跟这些操作无关：每个实例有独立家目录与独立进程，首页只是观察点。
   * 真会改到别的东西的操作（装卸载插件、还原快照、导入会话）继续用 guarded()。
   */
  function guardedNewHome(): string | null {
    return guardPackStart({
      isRuntimeRunning: () => false,
      isInstallerBusy: options.isInstallerBusy,
      isPackBusy: () => active,
    })
  }

  /** 激活包的公共核心：补骨架 → 确保版本 → 以未派生存储态为底写指针三件套。 */
  async function activatePackRecord(record: PackRecord): Promise<AppSettings> {
    const packId = record.id
    const home = await homeOfRecord(record)
    // 「包 id」与「profiles/ 下的目录名」是两个概念（阶段 1 二者仍相等）：写指针时以家目录里
    // 真实存在的那层为准（resolveProfileName 认 profiles/<包 id>，老包只有 profiles/web 时认它，
    // 都没有才回落包 id）。硬写 packId 会让老包被补出一个空壳 profile 然后切过去。
    const profileName = resolveProfileName(home, packId)
    // 私有家目录缺骨架时（旧记录/手工清理过）补齐，保证切过去即可读写。
    if (!existsSync(path.join(home, 'profiles', profileName))) {
      await seedPackHome(home, packId, { description: record.description, dshVersion: record.dshVersion })
    }
    if (record.dshVersion && options.ensureDshVersionInstalled) {
      await options.ensureDshVersionInstalled(record.dshVersion)
    }
    // 以「未派生的存储态」为底，绝不把旧包的派生家目录写回 settings.json。
    const settings = options.readStoredSettings ? await options.readStoredSettings() : await options.readSettings()
    let base = settings
    if (record.dshVersion && record.dshVersion !== settings.dshVersion && options.selectDshVersion) {
      await options.selectDshVersion(record.dshVersion)
      const after = await options.readSettings()
      base = { ...settings, dshVersion: after.dshVersion, launchExecutable: after.launchExecutable, launchArgs: after.launchArgs }
    }
    return options.saveSettings({ ...base, activePackId: packId, profileName })
  }

  async function findRecord(packId: string): Promise<PackRecord> {
    assertSafePackId(packId)
    const records = await readPackRegistry(options.registryPath)
    const record = records.find(item => item.id === packId)
    if (record) return record
    if (options.unifiedProfiles) {
      const dshHome = await getDshHome()
      const profile = await options.installer.readProfile(dshHome, packId)
      if (profile.initialized) {
        const metadata = await readProfileMetadata(dshHome, packId)
        return {
          id: packId,
          name: metadata.name,
          description: metadata.description,
          version: '1.0.0',
          ...(metadata.dshVersion ? { dshVersion: metadata.dshVersion } : {}),
          source: metadata.source?.kind === 'import' && metadata.source.format === 'zip' ? 'zip' : metadata.source?.kind === 'import' && metadata.source.format === 'yaml' ? 'manifest' : 'created',
          installedAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          state: 'complete',
          plugins: profile.plugins.filter(plugin => !plugin.builtin).map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled, version: plugin.version })),
        }
      }
    }
    throw new Error('整合包不存在。')
  }

  /**
   * 「这个包是不是当前选中的」只看 activePackId：包身份只有它一个真相。
   * profileName 是插件看到的 profile 目录名（阶段 2 起恒为 web），拿它比会把所有包都算成一个。
   */
  function isSelectedProfile(settings: AppSettings, packId: string): boolean {
    return settings.activePackId === packId
  }

  function selectedPackKey(settings: AppSettings): string | null | undefined {
    return settings.activePackId
  }

  /**
   * 组一份搬运预览：确认屏与执行结果共用同一次计算，
   * 免得"预览说有 12 条、实际搬了 10 条"这种两边各算各的口径差。
   */
  async function buildSessionImportPreview(sourcePackId: string, targetPackId: string): Promise<{ plan: SessionTransferPlan; preview: SessionImportPreview }> {
    if (sourcePackId === targetPackId) throw new Error('源包和目标包是同一个，没有可搬的记录。')
    const source = await findRecord(sourcePackId)
    const target = await findRecord(targetPackId)
    const rejection = downgradeRejection(source.dshVersion, target.dshVersion)
    if (rejection) throw new Error(rejection)
    const sourceHome = await homeOfRecord(source)
    const targetHome = await homeOfRecord(target)
    if (!existsSync(sourceHome)) throw new Error(`整合包「${source.name}」的家目录不存在。`)
    const plan = await planSessionTransfer(sourceHome, targetHome)
    return {
      plan,
      preview: {
        sourcePackId: source.id,
        targetPackId: target.id,
        sourceName: source.name,
        targetName: target.name,
        importableCount: plan.importableCount,
        importableBytes: plan.importableBytes,
        extraBytes: plan.extraBytes,
        skipped: plan.skipped.map(item => ({ reason: item.reason, count: item.count, label: SESSION_SKIP_LABELS[item.reason] })),
        formatUnverified: plan.formatUnverified,
        dangling: await findDanglingReferences(plan, targetHome),
      },
    }
  }

  function toInstalledPlugins(installed: string[]): PackInstalledPlugin[] {
    return installed.map(packageName => ({ packageName, enabled: true }))
  }

  /**
   * 三个列表用的计数：附件条目数 + 插件三档（本地Link / 安全外联 / 需转移）。
   * 只读家目录顶层、一个 package.json 与 node_modules 下各包自己的 package.json，
   * 不做整树遍历，也不写入注册表。
   *
   * 三档描述的是「这台机器上这个包已经装成什么样」，不是导出后会怎样
   * （导出时所有东西都会进包，所以不评价导出后）。
   * - extrasCount：`<家目录>/extras/` 顶层条目数（子目录算 1 条）。
   * - vaultCount（本地Link，绿）：依赖 spec 指向本地目录——`link:`、包内
   *   `file:./.dsh-launcher-plugin-bodies/…`、或绝对路径 `file:`/`link:`。
   *   本机能跑就行，导出时才搬进包。
   * - remoteCount（安全外联，蓝）：依赖 spec 是版本号，且 node_modules 里实际装的
   *   版本与声明对得上。pnpm 不会冲掉它，换机也能从 registry 重装。
   * - moveCount（需转移，红）：node_modules 里有目录、但既不在 profile 的 dependencies
   *   里，也不在任何活跃插件本体（profile 里 `file:`/`link:` 指向的那个目录）声明的
   *   依赖里——这样的包 pnpm 下次动依赖时会当垃圾清掉。
   *   「声明了但目录不在」不算这一档（那是缺件问题，不并进来）。
   */
  async function probePackCounters(home: string, packId: string): Promise<{ extrasCount: number; vaultCount: number; remoteCount: number; moveCount: number }> {
    const [extrasCount, tiers] = await Promise.all([
      readdir(path.join(home, 'extras')).then(entries => entries.length).catch(() => 0),
      probeDependencyTiers(path.join(home, 'profiles', packId)),
    ])
    return { extrasCount, ...tiers }
  }

  /**
   * 把一个 profile 的依赖分成三档。读不到 package.json（包还没装出 profile）
   * 时三档都是 0：没有声明就无从判断「装成什么样」，不猜。
   */
  async function probeDependencyTiers(profileDir: string): Promise<{ vaultCount: number; remoteCount: number; moveCount: number }> {
    const zero = { vaultCount: 0, remoteCount: 0, moveCount: 0 }
    let declared: Record<string, unknown>
    try {
      const parsed = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
      const dependencies = parsed?.dependencies
      if (!dependencies || typeof dependencies !== 'object') return zero
      declared = dependencies
    } catch {
      return zero
    }

    const nodeModules = path.join(profileDir, 'node_modules')
    const installedVersion = async (packageName: string): Promise<string | null> => {
      const text = await readFile(path.join(nodeModules, packageName, 'package.json'), 'utf8').catch(() => null)
      if (text === null) return null
      const version = (JSON.parse(text) as { version?: unknown })?.version
      return typeof version === 'string' ? version : null
    }

    let vaultCount = 0
    let remoteCount = 0
    const declaredNames = new Set<string>()
    for (const [packageName, spec] of Object.entries(declared)) {
      if (typeof spec !== 'string') continue
      declaredNames.add(packageName)
      // 本地实体：包内 bodies（已搬进包）、link: 指向本地目录、绝对 file:/link:（包外目录）。
      if (spec.startsWith(`file:./${SNAPSHOT_BODIES_DIR}/`) || spec.startsWith('file:') || spec.startsWith('link:')) {
        vaultCount += 1
        continue
      }
      // 版本号外联：实际装的版本与声明对得上才算（读不到 package.json 就不算）。
      const version = await installedVersion(packageName)
      if (version && declaredVersionMatches(version, spec)) remoteCount += 1
    }

    // 需转移：目录在，profile 与活跃插件本体都没声明。
    const strays = await listInstalledPackageNames(nodeModules)
    const reachableNames = await collectActiveBodyDependencies(profileDir, declared)
    const moveCount = strays.filter(packageName => !declaredNames.has(packageName) && !reachableNames.has(packageName)).length
    return { vaultCount, remoteCount, moveCount }
  }

  /**
   * 活跃插件本体声明的依赖名。
   *
   * profile 的 dependencies 里 `file:`/`link:` 的 spec 指向插件本体目录，pnpm 会读它的
   * manifest 建图：本体声明的东西也在同一张图里，下次动依赖不会被冲掉。不收进来，
   * 「需转移」就会把插件的传递依赖（3080 上的 js-yaml、zod）当成没人要的散件——红标说
   * 错话比不显示更糟。
   *
   * 只跟着 profile 的声明走，所以退役插件（`.bak-`/`.retired-`/`.removed-`）的本体读不到：
   * profile 不引用它们，它们遗留的目录仍然算需转移。
   *
   * ponytail: 只看一层，不递归读插件依赖的依赖——深层被提升到顶层的包会漏判成需转移。
   * 真需要精确时应改成按需触发（点开某一个包时再建全图），而不是每次列表刷新都建全图。
   * 读不到某个本体（目录不在、package.json 坏了）一律按「没有声明」跳过：列表页不许
   * 因为一个坏目录变空。
   */
  async function collectActiveBodyDependencies(profileDir: string, declared: Record<string, unknown>): Promise<Set<string>> {
    const bodyDirs = new Set<string>()
    for (const spec of Object.values(declared)) {
      if (typeof spec !== 'string') continue
      // `file:` 与 `link:` 都是 5 个字符的前缀；后面的路径相对 profile 目录解析（也接受绝对路径）。
      if (!spec.startsWith('file:') && !spec.startsWith('link:')) continue
      bodyDirs.add(path.resolve(profileDir, spec.slice(5)))
    }
    const reachable = new Set<string>()
    await Promise.all([...bodyDirs].map(async bodyDir => {
      const text = await readFile(path.join(bodyDir, 'package.json'), 'utf8').catch(() => null)
      if (text === null) return
      let manifest: Record<string, unknown> | null
      try {
        manifest = JSON.parse(text) as Record<string, unknown> | null
      } catch {
        return
      }
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const section = manifest?.[field]
        if (!section || typeof section !== 'object') continue
        for (const packageName of Object.keys(section as Record<string, unknown>)) reachable.add(packageName)
      }
    }))
    return reachable
  }

  /**
   * node_modules 顶层的包名（pnpm 下这些是软链，dirent 不是 directory，
   * 所以 dir 与 symlink 都收；`.bin`/`.pnpm` 这类点开头的一律跳过）。
   * 作用域包 `@scope/name` 展开到二级，不能把 `@scope` 目录本身当包。
   *
   * 内核 scope（KERNEL_SCOPES，即 `@deepseek-ai`）整段跳过：按 DSH 约定内核包由
   * runtime 自带、只写在 dsh.profile.bundles 里，不进 dependencies。不排除的话，
   * 「需转移」会把这些内核包当散件算进 moveCount，与自检第 2 条（pack-verify.ts）
   * 的结论对不上——两边共用 KERNEL_SCOPES 保持同源。
   */
  async function listInstalledPackageNames(nodeModules: string): Promise<string[]> {
    const entries = await readdir(nodeModules, { withFileTypes: true }).catch(() => [])
    const names: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!entry.name.startsWith('@')) {
        names.push(entry.name)
        continue
      }
      // 内核 scope 整个目录跳过：省一次 readdir，也让「不展开 = 不算包」一眼可见。
      if (KERNEL_SCOPES.includes(entry.name)) continue
      const scoped = await readdir(path.join(nodeModules, entry.name), { withFileTypes: true }).catch(() => [])
      for (const child of scoped) {
        if (child.isDirectory() || child.isSymbolicLink()) names.push(`${entry.name}/${child.name}`)
      }
    }
    return names
  }

  /**
   * 声明 spec 与实际装的版本是否对得上。宽容优先：徽章是计数，不是 lockfile 校验。
   *
   * ponytail: 近似实现——按点分段比较，只处理 `^`（major 相同；0.x 收紧到 minor）、
   * `~`（major+minor 相同）、`>=`/`>`/`<=`/`<`（区间写法一律放过）、裸版本（声明几段比几段）。
   * 不处理 `||`、`1.x` 通配、预发布标签（-rc.1）的排序。
   * 升级路径：仓库里已装 semver 时换成 semver.satisfies(installed, spec)，删掉本函数。
   */
  function declaredVersionMatches(installed: string, spec: string): boolean {
    const raw = spec.trim()
    const wanted = raw.replace(/^[\^~><=v\s]+/, '').trim()
    if (!wanted || wanted === '*' || wanted === 'latest') return true
    const have = installed.trim().replace(/^v/, '')
    if (have === wanted) return true
    const h = have.split(/[.+-]/)
    const w = wanted.split(/[.+-]/)
    if (raw.startsWith('~')) return h[0] === w[0] && h[1] === w[1]
    if (raw.startsWith('^')) return h[0] === w[0] && (w[0] !== '0' || h[1] === w[1])
    if (/^[<>]/.test(raw)) return true
    return w.every((part, index) => h[index] === part)
  }

  /**
   * 实时探测包家目录里的资源计数。注册表记录只在包级写操作（add/toggle/remove）
   * 时维护，市场/npm 安装、技能与预设安装只写家目录不写记录——列表计数必须
   * 以家目录为准，否则装完插件/技能后行上永远是 0。探测失败回落记录数组。
   */
  async function probePackResources(record: PackRecord): Promise<Pick<PackStatus, 'plugins' | 'skills' | 'presets' | 'extrasCount' | 'vaultCount' | 'remoteCount' | 'moveCount'>> {
    const fallback = {
      plugins: record.plugins.map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled, version: plugin.version })),
      ...(record.skills ? { skills: record.skills.map(skill => ({ ...skill })) } : {}),
      ...(record.presets ? { presets: record.presets.map(preset => ({ ...preset })) } : {}),
      extrasCount: 0,
      vaultCount: 0,
      remoteCount: 0,
      moveCount: 0,
    }
    try {
      const home = await homeOfRecord(record)
      const [profile, skills, presets, counters] = await Promise.all([
        // profile 目录名不等于包 id（老包/阶段 2 是 profiles/web）：拿 id 直接读会读到
        // initialized:false 的空 profile，再被下面的 if(profile) 用空数组覆盖记录里的插件。
        options.installer.readProfile(home, resolveProfileName(home, record.id)).catch(() => null),
        readInstalledSkills(home).catch(() => null),
        readInstalledPresets(home).catch(() => null),
        probePackCounters(home, record.id),
      ])
      fallback.extrasCount = counters.extrasCount
      fallback.vaultCount = counters.vaultCount
      fallback.remoteCount = counters.remoteCount
      fallback.moveCount = counters.moveCount
      if (profile) {
        fallback.plugins = profile.plugins
          .filter(plugin => !plugin.builtin)
          .map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled, version: plugin.version }))
      }
      if (skills) {
        fallback.skills = skills.map(skill => ({ name: skill.name, format: skill.format, enabled: skill.enabled, description: skill.description }))
      }
      if (presets) {
        fallback.presets = presets.map(preset => ({ name: preset.name, enabled: preset.enabled }))
      }
    } catch {
      // 家目录不可读（如迁移中的半成品包）时用记录数组兜底。
    }
    return fallback
  }

  /**
   * 自动收编：扫一遍 packsRoot 的直接子目录，把「结构是 DSH 家目录但注册表里没有」的登记进来。
   *
   * 用户把目录摆到启动器管的位置，就等于「配置好了」——不该再点一个按钮去收编。
   * 三条硬约束：
   *   1. 判定复用 inspectAdoptableHome（profiles/<id>/package.json 为证、跳过 node_modules
   *      与官方桌面端 profile），不在这里另写一套规则。
   *   2. 只新增不覆盖：同一个家目录（按路径比）已有记录时跳过，用户手工改过的 name 不能被
   *      列表刷新打回；包 id 已被别的家目录占用时也跳过，绝不顶掉既有记录。
   *   3. 全程兜底：这是列表页，任何一个目录读失败都只能跳过它，绝不许让 listPacks 抛错。
   *
   * ponytail: 只看一层，不递归；也不处理「目录还在拷」的中间态——收到一条半成品记录，
   * 下一次列表刷新探不到资源就回落记录数组，等拷完 profile 出现后重扫也不会重复收编。
   */
  async function autoAdoptPacksRootDirs(records: PackRecord[]): Promise<void> {
    const entries = await readdir(packsRoot, { withFileTypes: true }).catch(() => [])
    // 去重按家目录路径：包 id 是外层目录名，和注册表里已有的 id 不保证一一对应
    // （阶段 2 起 profiles/ 下所有包都叫 web，只有目录名还分得清是哪个包）。
    const knownHomes = records.map(record => record.homePath).filter((home): home is string => Boolean(home))
    const knownIds = new Set(records.map(record => record.id))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // 回收站目录（上一轮删包留下的 .deleting-*）不算包；它由启动清扫异步删。
      if (entry.name.includes('.deleting-')) continue
      if (!isSafeProfileName(entry.name) || isDesktopHomeProfile(entry.name)) continue
      try {
        const homePath = path.join(packsRoot, entry.name)
        if (knownHomes.some(home => samePath(home, homePath))) continue
        const info = await inspectAdoptableHome(homePath)
        // 包里那个 profile 目录名不合规或目录不在，登记出来就是个点开就崩的空壳 —— 跳过。
        if (!isSafeProfileName(info.profileId)) continue
        if (!existsSync(path.join(homePath, 'profiles', info.profileId))) continue
        // 包 id = 外层目录名（阶段 1 起就按这个认）。里面那个 profile 目录名只用来读插件清单，
        // 不再兼任包 id：阶段 2 起所有包都只有 profiles/web，用它当 id 会把整排目录收编成同一个。
        const id = entry.name
        if (knownIds.has(id)) continue
        const times = await stat(homePath).catch(() => null)
        const fallbackTime = new Date().toISOString()
        const born = times?.birthtime && times.birthtime.getTime() > 0 ? times.birthtime.toISOString() : null
        const created = born ?? times?.mtime.toISOString() ?? fallbackTime
        const record: PackRecord = {
          id,
          name: info.name || entry.name,
          description: '',
          version: '1.0.0',
          ...(info.dshVersion ? { dshVersion: info.dshVersion } : {}),
          homePath,
          source: 'created',
          installedAt: created,
          updatedAt: created,
          state: 'complete',
          plugins: await readProfilePlugins(homePath, info.profileId).catch(() => []),
        }
        await upsertPackRecord(options.registryPath, record)
        records.push(record)
        knownIds.add(record.id)
        knownHomes.push(homePath)
        await writeRecordManifest(record).catch(() => undefined)
        options.onPackCreated?.(record.id)
      } catch {
        // 单个目录坏了就跳过它：列表页不许因为一个陌生文件夹整页变空。
      }
    }
  }

  return {
    async listPacks() {
      const settings = await options.readSettings()
      // 启动清扫：回收上次删除中断（回收站目录被锁文件卡住 rm）留下的 `.deleting-*`，尽力而为不阻塞。
      void (async () => {
        for (const entry of await readdir(packsRoot, { withFileTypes: true }).catch(() => [])) {
          if (entry.isDirectory() && entry.name.includes('.deleting-')) {
            await rm(path.join(packsRoot, entry.name), { recursive: true, force: true }).catch(() => undefined)
          }
        }
      })()
      const registered = await readPackRegistry(options.registryPath)
      // 悬空记录（家目录被手删/搬走的旧包）不能留在列表里：它点开就报错，
      // 还会挡住「导入同名文件夹」。没有 homePath 的记录按默认家目录算 —— 旧台式
      // 就是这么坏掉的（默认家目录 = DSH_HOME 指着的 dsh-packs\<id>，目录被删）。
      // 只摘记录、顺手写回 packs.json；目录本来就不存在，这里绝不删任何真实家目录。
      const sharedHome = await defaultHome()
      const records = registered.filter(record => existsSync(record.homePath ?? sharedHome))
      if (records.length !== registered.length) {
        const removed = registered.filter(record => !records.includes(record))
        console.log(`[packs] 清掉 ${removed.length} 条家目录不存在的悬空记录：${removed.map(record => record.id).join('、')}`)
        await writePackRegistry(options.registryPath, records).catch(error => {
          console.log(`[packs] 回写 packs.json 失败（下次启动会再清一遍）：${error instanceof Error ? error.message : String(error)}`)
        })
      }
      await autoAdoptPacksRootDirs(records).catch(() => undefined)
      await Promise.all(records.map(record => writeRecordManifest(record).catch(() => undefined)))
      const statuses = await Promise.all(records.map(async record => {
        const status = toPackStatus(record, settings.activePackId)
        return { ...status, ...(await probePackResources(record)) }
      }))
      return statuses.sort((a, b) => a.installedAt.localeCompare(b.installedAt))
    },

    isBusy: () => active,

    async analyzeImport(filePath) {
      if (/\.ya?ml$/i.test(filePath)) {
        const manifest = parsePackManifest(await readFile(filePath, 'utf8'), { requireDshVersion: true })
        return {
          id: packProfileName(manifest.name),
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          dshVersion: manifest.dshVersion ?? null,
          source: 'manifest' as const,
          items: manifest.plugins.map(entry => ({ packageName: entry.packageName, available: Boolean(entry.repository || entry.source === 'npm'), offline: false, enabled: entry.enabled !== false })),
        }
      }
      const manifestText = await findManifestInArchiveFromPath(filePath)
      if (!manifestText) {
        // 快照包：家目录镜像（含 node_modules），整包导入，不做逐项重装。
        const snapshotInfo = await describeSnapshotZip(filePath)
        if (snapshotInfo) {
          const nameHint = cleanPackNameHint(path.basename(filePath)) ?? snapshotInfo.profileId ?? ''
          const sizeMb = Math.round(snapshotInfo.unpackedBytes / (1024 * 1024))
          return {
            id: nameHint ? packProfileName(nameHint) : '',
            name: nameHint,
            description: `快照整合包：${snapshotInfo.fileCount} 个文件，解压约 ${sizeMb}MB。`,
            version: '1.0.0',
            dshVersion: snapshotInfo.dshVersion,
            source: 'snapshot' as const,
            items: snapshotInfo.pluginNames.map(packageName => ({ packageName, available: true, offline: true })),
          }
        }
        // 非标准包：扫描包内的标准插件目录与技能，合成为我们格式的整合包。
        const scan = await scanRawPackZipFromPath(filePath)
        const nameHint = cleanPackNameHint(path.basename(filePath)) ?? cleanPackNameHint(scan.topName ?? '') ?? ''
        const items: PackAnalysisItem[] = []
        for (const plugin of scan.plugins) {
          items.push({ packageName: plugin.packageName, available: true, offline: true })
        }
        for (const skill of scan.skills) {
          items.push({ packageName: skill.name, available: true, offline: true, kind: 'skill' })
        }
        for (const preset of scan.presets) {
          items.push({ packageName: preset.name, available: true, offline: true, kind: 'preset' })
        }
        for (const skippedItem of scan.skipped) {
          items.push({ packageName: skippedItem.entryPrefix, available: false, offline: false, reason: skippedItem.reason })
        }
        return {
          id: nameHint ? packProfileName(nameHint) : '',
          name: nameHint,
          description: `非标准整合包：扫描到 ${scan.plugins.length} 个插件、${scan.skills.length} 个技能${scan.presets.length > 0 ? `、${scan.presets.length} 个预设` : ''}。`,
          version: '1.0.0',
          dshVersion: null,
          source: 'raw',
          items,
        }
      }
      const inspection = await inspectPackZipFromPath(filePath)
      const manifest = inspection.manifest
      assertPackDshVersion(manifest)
      const packId = packProfileName(manifest.name)

      const items: PackAnalysisItem[] = []
      if (inspection.hasBodies) {
        // 有 plugin-bodies：按 body 包名逐项列出（全部可离线安装）。
        for (const packageName of inspection.bodyPackageNames) {
          items.push(isSafePackageName(packageName)
            ? { packageName, available: true, offline: true, enabled: manifest.plugins.find(entry => entry.packageName === packageName)?.enabled !== false }
            : { packageName, available: false, offline: false, reason: '插件名称非法。' })
        }
      } else {
        // manifest-only：按 manifest.plugins 逐项列出；缺 repository 且非 npm 源标不可用。
        for (const entry of manifest.plugins) {
          if (!isSafePackageName(entry.packageName)) {
            items.push({ packageName: entry.packageName, available: false, offline: false, reason: '插件名称非法。' })
            continue
          }
          const available = entry.source === 'npm' || Boolean(entry.repository)
          items.push(available
            ? { packageName: entry.packageName, available: true, offline: false, enabled: entry.enabled !== false }
            : { packageName: entry.packageName, available: false, offline: false, reason: '缺少来源仓库，无法联网安装' })
        }
      }
      for (const preset of manifest.presets ?? []) {
        const offline = inspection.presetBodyNames.includes(preset.name)
        const available = offline || Boolean(preset.repository && preset.sourcePath && preset.revision)
        items.push({
          packageName: preset.name,
          available,
          offline,
          kind: 'preset',
          reason: available ? undefined : '缺少仓库/来源路径/版本，无法联网安装',
        })
      }
      for (const skill of manifest.skills ?? []) {
        const available = Boolean(skill.repository && skill.sourcePath && skill.revision)
        items.push({
          packageName: skill.name,
          available,
          offline: false,
          kind: 'skill',
          reason: available ? undefined : '缺少仓库/来源路径/版本，无法联网安装',
        })
      }
      for (const application of manifest.applications ?? []) {
        items.push({
          packageName: application.id,
          available: true,
          offline: false,
          kind: 'application',
        })
      }
      return {
        id: packId,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        dshVersion: manifest.dshVersion ?? null,
        source: inspection.hasBodies ? 'zip' : 'manifest',
        items,
      }
    },

    async importPack(filePath, items, importOptions) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      profileWasNew = false
      let skillStaging: string | null = null
      let presetStaging: string | null = null
      let presetBodiesDir: string | null = null
      try {
        // 本地 YAML 是轻量清单格式：只安装清单引用的插件到共享 Profile，不创建包目录。
        if (/\.ya?ml$/i.test(filePath)) {
          const manifest = parsePackManifest(await readFile(filePath, 'utf8'), { requireDshVersion: true })
          const existing = await readPackRegistry(options.registryPath)
          const currentHome = await getDshHome()
          const baseId = packProfileName(importOptions?.name ?? manifest.name)
          const packId = await resolveImportedProfileId(
            baseId,
            currentHome,
            existing,
            importOptions,
          )
          const settings = await options.readSettings()
          const profileName = options.unifiedProfiles ? packId : settings.profileName
          let dshHome = currentHome
          if (options.unifiedProfiles) {
            dshHome = await provisionPackHome({
              packId,
              existing,
              meta: { name: importPackDisplayName(packId, baseId, importOptions?.name ?? manifest.name), description: manifest.description, version: manifest.version, dshVersion: manifest.dshVersion, source: 'manifest' },
            })
            await ensureUnifiedProfile(dshHome, profileName, settings.profileName, { description: manifest.description, dshVersion: manifest.dshVersion, source: 'yaml' })
          }
          const profileBeforeInstall = await options.installer.readProfile(dshHome, profileName)
          if (importOptions?.overwrite && options.unifiedProfiles) {
            snapshot = await createProfileSnapshot(dshHome, profileName, options.snapshotRoot)
            options.emitEvent({ kind: 'snapshot' })
          }
          const requested = items && items.length > 0 ? new Set(items) : null
          const selected = manifest.plugins.filter(entry => !requested || requested.has(entry.packageName))
          const installables: InstallableItem[] = selected.map(entry => {
            const localBody = importOptions?.localPluginBodies?.[entry.packageName]
            const target = localBody
              ? { id: entry.packageName, packageName: entry.packageName, version: entry.version ?? null, source: 'local-directory' as const, profileName, platform: 'unknown' as const, subdirectory: null, commit: '', requiresBuild: false, buildScripts: [], nodeRange: null, localDirectory: localBody }
              : manifestEntryToTarget(entry, profileName)
            return {
              packageName: entry.packageName,
              offline: false,
              install: async () => {
                if (!target) throw new Error('清单中缺少该插件的来源，无法联网安装')
                await installManifestPlugin(target)
              },
            }
          })
          options.emitEvent({ kind: 'status', message: `正在导入整合包清单「${manifest.name}」…` })
          const { installed, failures } = await runSerialInstall(installables, { emitEvent: options.emitEvent })
          if (!options.unifiedProfiles) await reapplyCurrentSelection(settings, profileBeforeInstall)
          const installedPluginNames = selected
            .filter(entry => installed.includes(entry.packageName))
            .map(entry => entry.packageName)
          if (options.unifiedProfiles) {
            // Installation appends bundles to a cloned Profile. Restore the
            // imported manifest order explicitly after all installs finish.
            await applyPluginSet(
              profileName,
              selected
                .filter(entry => installedPluginNames.includes(entry.packageName))
                .map(entry => ({ packageName: entry.packageName, enabled: entry.enabled !== false })),
              installedPluginNames,
            )
          }
          const result = buildInstallResult(packId, installed, failures)
          const record: PackRecord = {
            id: packId,
            name: importPackDisplayName(packId, baseId, importOptions?.name ?? manifest.name),
            description: manifest.description,
            version: manifest.version,
            dshVersion: manifest.dshVersion,
            ...(options.unifiedProfiles ? { homePath: dshHome } : {}),
            source: 'manifest',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: result.state,
            plugins: installedPluginNames.map(packageName => ({ packageName, enabled: manifest.plugins.find(entry => entry.packageName === packageName)?.enabled !== false })),
            failures: result.failures.length > 0 ? result.failures : undefined,
          }
          await upsertPackRecord(options.registryPath, record)
          await writeRecordManifest(record, manifest)
          options.emitEvent({ kind: 'done', result })
          return result
        }
        // 不再整体读入内存：先探测清单，再按分支用文件路径流式解析。
        // 文件被并发删除/移动时（通过 IPC stat 门禁后）这里会抛错，
        // 也能走 catch → finally 复位 active，避免整合包子系统永久卡在「进行中」。
        const manifestText = await findManifestInArchiveFromPath(filePath)
        if (!manifestText) {
          // ---- 快照分支：家目录镜像 + node_modules 随包，解开即用。----
          const snapshotInfo = await describeSnapshotZip(filePath)
          if (snapshotInfo) {
            const snapshotSettings = await options.readSettings()
            const snapshotExisting = await readPackRegistry(options.registryPath)
            const snapshotHome = await getDshHome()
            const packName = (importOptions?.name ?? '').trim() || snapshotInfo.profileId || cleanPackNameHint(path.basename(filePath)) || ''
            if (!packName) throw new Error('无法确定整合包名称，请在预览中手动命名。')
            // 快照包优先沿用源包 id（分享/回导时环境路径不漂移），重名时自动加后缀。
            const idBase = snapshotInfo.profileId && isSafeProfileName(snapshotInfo.profileId)
              ? snapshotInfo.profileId
              : assertMeaningfulPackName(packName)
            const packId = await resolveImportedProfileId(idBase, snapshotHome, snapshotExisting, importOptions)
            const dshVersion = snapshotInfo.dshVersion ?? await resolvePackDshVersion(snapshotSettings)
            const displayName = importPackDisplayName(packId, idBase, packName)
            const homePath = path.join(packsRoot, packId)
            await mkdir(homePath, { recursive: true })
            try {
              if (dshVersion && options.ensureDshVersionInstalled) {
                await options.ensureDshVersionInstalled(dshVersion)
                const before = await options.readSettings()
                if (before.dshVersion !== dshVersion && options.selectDshVersion) {
                  try {
                    await options.selectDshVersion(dshVersion)
                  } catch (error) {
                    log('error', `切换 DSH ${dshVersion} 失败，导入继续使用当前版本：${asErrorMessage(error)}`)
                  }
                }
              }
              const startedAt = new Date().toISOString()
              const stored = options.readStoredSettings ? await options.readStoredSettings() : snapshotSettings
              await upsertPackRecord(options.registryPath, {
                id: packId,
                name: displayName,
                description: snapshotInfo.description ?? '',
                version: '1.0.0',
                ...(dshVersion ? { dshVersion } : {}),
                homePath,
                source: 'snapshot',
                installedAt: startedAt,
                updatedAt: startedAt,
                state: 'partial',
                plugins: [],
              })
              await options.saveSettings({
                ...stored,
                activePackId: packId,
                profileName: packId,
                ...(dshVersion ? { dshVersion } : {}),
              })
              options.emitEvent({ kind: 'status', message: `正在解压快照包「${displayName}」…` })
              const extracted = await extractSnapshot(filePath, homePath, {
                newId: packId,
                onProgress: (done, total) => {
                  if (done % 200 === 0 || done === total) {
                    options.emitEvent({ kind: 'extract', done, total })
                  }
                },
              })
              if (extracted.longPaths.length > 0) {
                log('error', `有 ${extracted.longPaths.length} 个文件因路径过长被跳过（如 ${extracted.longPaths[0]}）。把整合包名字改短一点再导入可以避免。`)
              }
              const profile = await options.installer.readProfile(homePath, resolveProfileName(homePath, packId))
              const plugins = profile.plugins
                .filter(plugin => !plugin.builtin)
                .map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled !== false }))
              const finishedAt = new Date().toISOString()
              const record: PackRecord = {
                id: packId,
                name: displayName,
                description: snapshotInfo.description ?? '',
                version: '1.0.0',
                ...(dshVersion ? { dshVersion } : {}),
                homePath,
                source: 'snapshot',
                installedAt: startedAt,
                updatedAt: finishedAt,
                state: 'complete',
                plugins,
              }
              await upsertPackRecord(options.registryPath, record)
              await writeRecordManifest(record, {
                name: displayName,
                description: record.description,
                version: record.version,
                ...(dshVersion ? { dshVersion } : {}),
                plugins: plugins.map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled })),
              })
              const result = { id: packId, installed: plugins.map(plugin => plugin.packageName), failures: [], state: 'complete' as const }
              options.emitEvent({ kind: 'done', result })
              return result
            } catch (error) {
              // 解压失败：清掉半成品家目录与记录，别在列表里留个坏包。
              await rm(homePath, { recursive: true, force: true }).catch(() => undefined)
              await removePackRecord(options.registryPath, packId).catch(() => undefined)
              throw error
            }
          }
          // ---- raw 分支：扫描非标准包内的插件与技能，离线安装，注册为我们格式的整合包。----
          const scan = await scanRawPackZipFromPath(filePath)
          if (scan.plugins.length === 0 && scan.skills.length === 0 && scan.presets.length === 0) {
            throw new Error('未在压缩包内发现可安装的插件、技能或预设。')
          }
          const nameHint = cleanPackNameHint(path.basename(filePath)) ?? cleanPackNameHint(scan.topName ?? '') ?? ''
          const packName = (importOptions?.name ?? '').trim() || nameHint
          if (!packName) throw new Error('无法确定整合包名称，请在预览中手动命名。')
          const existing = await readPackRegistry(options.registryPath)
          const currentHome = await getDshHome()
          const baseId = assertMeaningfulPackName(packName)
          const packId = await resolveImportedProfileId(baseId, currentHome, existing, importOptions)
          const settings = await options.readSettings()
          const dshVersion = await resolvePackDshVersion(settings)
          const profileName = options.unifiedProfiles ? packId : settings.profileName
          let dshHome = currentHome
          if (options.unifiedProfiles) {
            dshHome = await provisionPackHome({
              packId,
              existing,
              meta: { name: importPackDisplayName(packId, baseId, packName), description: `非标准整合包：${packName}`, version: '1.0.0', dshVersion, source: 'raw' },
            })
            await ensureUnifiedProfile(dshHome, profileName, settings.profileName, { description: `非标准整合包：${packName}`, dshVersion, source: 'zip' })
          }
          const profileBeforeInstall = await options.installer.readProfile(dshHome, profileName)
          // items 缺省 = 全装；插件名、技能名、预设名各自独立过滤（理论上可能撞名）。
          const wantedPlugins = scan.plugins.filter(plugin => !items || items.includes(plugin.packageName))
          const wantedSkills = scan.skills.filter(skill => !items || items.includes(skill.name))
          const wantedPresets = scan.presets.filter(preset => !items || items.includes(preset.name))

          options.emitEvent({ kind: 'status', message: `正在扫描并导入非标准整合包「${packName}」…` })
          snapshot = await createProfileSnapshot(dshHome, profileName, options.snapshotRoot)
          options.emitEvent({ kind: 'snapshot' })

          const installables: InstallableItem[] = []

          // 插件与技能共用同一解压字节预算：2 GiB 上限按一次导入的累计解出字节封顶，
          // 防止被拆成多个候选各自「达标」而整体绕过（zip-bomb）。
          const extractBudget: ExtractByteBudget = { extracted: 0 }

          // 插件本体解到启动器的共享缓存（file: 引用不悬空，不创建整合包 Profile）。
          if (wantedPlugins.length > 0) {
            const bodiesDir = packBodiesDir(dshHome, packId)
            await rm(bodiesDir, { recursive: true, force: true }).catch(() => undefined)
            const bodies = await extractRawPluginBodiesFromPath(filePath, wantedPlugins, bodiesDir, undefined, extractBudget)
            for (const plugin of wantedPlugins) {
              const bodyDir = bodies.get(plugin.packageName)
              if (!bodyDir) {
                installables.push({ packageName: plugin.packageName, offline: true, install: async () => { throw new Error('插件本体解出失败。') } })
                continue
              }
              const sharedBodyDir = await sharedPluginBodyDir(dshHome, plugin.packageName, bodyDir)
              const target: PackInstallTarget = {
                id: plugin.packageName,
                packageName: plugin.packageName,
                version: plugin.version ?? null,
                source: 'local-directory',
                profileName,
                platform: 'unknown',
                subdirectory: null,
                commit: '',
                requiresBuild: false,
                buildScripts: [],
                nodeRange: null,
                localDirectory: sharedBodyDir,
              }
              installables.push({ packageName: plugin.packageName, offline: true, install: async () => { await installManifestPlugin(target) } })
            }
          }

          // 技能解到 dshHome 内 staging（与 skills/ 同卷），逐项全局安装。
          if (wantedSkills.length > 0) {
            skillStaging = await mkdtemp(path.join(dshHome, '.pack-raw-staging-'))
            const sources = await extractRawSkillSourcesFromPath(filePath, wantedSkills, skillStaging, undefined, extractBudget)
            for (const skill of wantedSkills) {
              const sourceDir = sources.get(skill.name)
              if (!sourceDir) {
                installables.push({ packageName: skill.name, offline: true, install: async () => { throw new Error('技能来源解出失败。') } })
                continue
              }
              const skillInstall = { name: skill.name, format: skill.format, sourceDir }
              installables.push({ packageName: skill.name, offline: true, install: async () => { await options.installer.installSkillLocal(dshHome, skillInstall) } })
            }
          }

          // 预设解到 dshHome 内 staging，再逐项全局安装到 .agent-presets。
          if (wantedPresets.length > 0) {
            presetStaging = await mkdtemp(path.join(dshHome, '.pack-raw-preset-staging-'))
            const sources = await extractRawPresetSourcesFromPath(filePath, wantedPresets, presetStaging, undefined, extractBudget)
            for (const preset of wantedPresets) {
              const sourceDir = sources.get(preset.name)
              if (!sourceDir) {
                installables.push({ packageName: preset.name, offline: true, install: async () => { throw new Error('预设来源解出失败。') } })
                continue
              }
              installables.push({ packageName: preset.name, offline: true, install: async () => { await options.installer.installPresetLocal(dshHome, { name: preset.name, sourceDir }) } })
            }
          }

          const { installed, failures } = await runSerialInstall(installables, { emitEvent: options.emitEvent })
          if (!options.unifiedProfiles) await reapplyCurrentSelection(settings, profileBeforeInstall)
          const result = buildInstallResult(packId, installed, failures)

          const installedPluginNames = wantedPlugins
            .filter(plugin => installed.includes(plugin.packageName))
            .map(plugin => plugin.packageName)
          const installedSkills: PackInstalledSkill[] = wantedSkills
            .filter(skill => installed.includes(skill.name))
            .map(skill => ({ name: skill.name, format: skill.format, enabled: true }))
          const installedPresets: PackInstalledPreset[] = wantedPresets
            .filter(preset => installed.includes(preset.name))
            .map(preset => ({ name: preset.name, enabled: true }))

          if (options.unifiedProfiles) {
            await applyPluginSet(
              profileName,
              installedPluginNames.map(packageName => ({ packageName, enabled: true })),
              installedPluginNames,
            )
          }

          const record: PackRecord = {
            id: packId,
            name: importPackDisplayName(packId, baseId, packName),
            description: `非标准整合包：扫描到 ${scan.plugins.length} 个插件、${scan.skills.length} 个技能${scan.presets.length > 0 ? `、${scan.presets.length} 个预设` : ''}。`,
            version: '1.0.0',
            dshVersion,
            ...(options.unifiedProfiles ? { homePath: dshHome } : {}),
            source: 'raw',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: result.state,
            plugins: toInstalledPlugins(installedPluginNames),
            skills: installedSkills,
            ...(installedPresets.length > 0 ? { presets: installedPresets } : {}),
            failures: result.failures.length > 0 ? result.failures : undefined,
          }
          await upsertPackRecord(options.registryPath, record)
          await writeRecordManifest(record)
          log('success', `非标准整合包「${packName}」已导入：${installed.length} 项。`)
          options.emitEvent({ kind: 'done', result })
          return result
        }

        const inspection = await inspectPackZipFromPath(filePath)
        const manifest = inspection.manifest
        assertPackDshVersion(manifest)
        if (importOptions?.mode === 'full') {
          // Full repository imports are intentionally strict: the archive is
          // the author's source of truth and must never silently fall back to
          // a newer npm/GitHub copy when a body is missing.
          await validateFullArchive(filePath, manifest)
        }
        const existing = await readPackRegistry(options.registryPath)
        const currentHome = await getDshHome()
        const baseId = packProfileName(manifest.name)
        const packId = await resolveImportedProfileId(baseId, currentHome, existing, importOptions)
        const settings = await options.readSettings()
        const profileName = options.unifiedProfiles ? packId : settings.profileName
        let dshHome = currentHome
        if (options.unifiedProfiles) {
          dshHome = await provisionPackHome({
            packId,
            existing,
            meta: { name: importPackDisplayName(packId, baseId, manifest.name), description: manifest.description, version: manifest.version, dshVersion: manifest.dshVersion, source: inspection.hasBodies ? 'zip' : 'manifest' },
          })
          await ensureUnifiedProfile(dshHome, profileName, settings.profileName, { description: manifest.description, dshVersion: manifest.dshVersion, source: 'zip' })
        }
        const profileBeforeInstall = await options.installer.readProfile(dshHome, profileName)

        // 决定要安装的包名集合：显式 items 优先，否则有 body 按 body，否则按 manifest。
        // 插件 / 技能 / 预设 / 应用是独立资源，分开处理。
        const requested = items && items.length > 0 ? items : undefined
        const manifestEntries = new Map(manifest.plugins.map(entry => [entry.packageName, entry]))
        const presetEntries = new Map((manifest.presets ?? []).map(entry => [entry.name, entry]))
        const skillEntries = new Map((manifest.skills ?? []).map(entry => [entry.name, entry]))
        const applicationEntries = new Map((manifest.applications ?? []).map(entry => [entry.id, entry]))
        const presetNames = new Set(presetEntries.keys())
        const skillNames = new Set(skillEntries.keys())
        const applicationIds = new Set(applicationEntries.keys())

        const requestedItems = requested ?? []
        const requestedSet = requested ? new Set(requestedItems) : null
        const wantedPlugins = requestedSet
          ? requestedItems.filter(name => !presetNames.has(name) && !skillNames.has(name) && !applicationIds.has(name))
          : inspection.hasBodies
            // Archive entry enumeration is not guaranteed to match the
            // manifest. Use the manifest as the source of display/load order.
            ? manifest.plugins.map(entry => entry.packageName).filter(name => inspection.bodyPackageNames.includes(name))
            : manifest.plugins.map(entry => entry.packageName)
        const wantedPresets = requestedSet
          ? requestedItems.filter(name => presetNames.has(name))
          : [...presetNames]
        const wantedSkills = requestedSet
          ? requestedItems.filter(name => skillNames.has(name))
          : [...skillNames]
        const wantedApplications = requestedSet
          ? requestedItems.filter(name => applicationIds.has(name))
          : [...applicationIds]

        const installables: InstallableItem[] = []

        options.emitEvent({ kind: 'status', message: `正在导入整合包「${manifest.name}」…` })
        snapshot = await createProfileSnapshot(dshHome, profileName, options.snapshotRoot)
        options.emitEvent({ kind: 'snapshot' })

        if (inspection.hasBodies) {
          // 本体解到启动器共享缓存：DSH 通过 file: 引用它，任务结束后不得删除。
          const bodiesDir = packBodiesDir(dshHome, packId)
          await rm(bodiesDir, { recursive: true, force: true }).catch(() => undefined)
          const knownNames = new Set(manifest.plugins.map(entry => entry.packageName))
          const bodies = await extractPackBodiesFromPath(filePath, bodiesDir, undefined, knownNames)
          for (const packageName of wantedPlugins) {
            if (!isSafePackageName(packageName)) {
              installables.push({ packageName, install: async () => { throw new Error('插件名称非法。') } })
              continue
            }
            const bodyDir = bodies.get(packageName)
            if (bodyDir) {
              if (importOptions?.mode === 'full') {
                let bodyManifest: { name?: unknown; version?: unknown }
                try {
                  bodyManifest = JSON.parse(await readFile(path.join(bodyDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
                } catch {
                  throw new Error(`完整安装插件本体缺少 package.json：${packageName}`)
                }
                if (bodyManifest.name !== packageName) throw new Error(`完整安装插件包名不一致：清单 ${packageName}，本体 ${String(bodyManifest.name ?? '未知')}`)
                const expectedVersion = manifestEntries.get(packageName)?.version
                if (expectedVersion && bodyManifest.version !== expectedVersion) {
                  throw new Error(`完整安装插件版本不一致：${packageName} 要求 ${expectedVersion}，本体 ${String(bodyManifest.version ?? '未知')}`)
                }
              }
              const sharedBodyDir = await sharedPluginBodyDir(dshHome, packageName, bodyDir)
              const target: PackInstallTarget = {
                id: packageName,
                packageName,
                version: null,
                source: 'local-directory',
                profileName,
                platform: 'unknown',
                subdirectory: null,
                commit: '',
                requiresBuild: false,
                buildScripts: [],
                nodeRange: null,
                localDirectory: sharedBodyDir,
              }
              installables.push({ packageName, offline: true, install: async () => { await installManifestPlugin(target) } })
            } else if (importOptions?.mode === 'full') {
              installables.push({ packageName, offline: true, install: async () => { throw new Error(`完整安装缺少插件本体：${packageName}`) } })
            } else {
              const target = manifestEntryToTarget(manifestEntries.get(packageName), profileName)
              if (target) {
                installables.push({ packageName, offline: false, install: async () => { await installManifestPlugin(target) } })
              } else {
                installables.push({ packageName, offline: false, install: async () => { throw new Error('清单中缺少该插件的来源，无法联网安装') } })
              }
            }
          }
        } else {
          for (const packageName of wantedPlugins) {
            if (!isSafePackageName(packageName)) {
              installables.push({ packageName, install: async () => { throw new Error('插件名称非法。') } })
              continue
            }
            const target = manifestEntryToTarget(manifestEntries.get(packageName), profileName)
            if (target) {
              installables.push({ packageName, offline: false, install: async () => { await installManifestPlugin(target) } })
            } else {
              installables.push({ packageName, offline: false, install: async () => { throw new Error('清单中缺少该插件的来源，无法联网安装') } })
            }
          }
        }

        // Agent 预设：优先用包内 preset-bodies 离线安装，否则按清单 pin 联网安装。
        presetBodiesDir = path.join(dshHome, '.pack-preset-bodies', packId)
        await rm(presetBodiesDir, { recursive: true, force: true }).catch(() => undefined)
        const presetBodies = await extractPresetBodiesFromPath(filePath, presetBodiesDir)
        for (const presetName of wantedPresets) {
          const preset = presetEntries.get(presetName)!
          const bodyDir = presetBodies.get(presetName)
          if (bodyDir) {
            installables.push({
              packageName: presetName,
              offline: true,
              install: async () => { await options.installer.installPresetLocal(dshHome, { name: presetName, sourceDir: bodyDir }) },
            })
            continue
          }
          if (!preset.repository || !preset.sourcePath || !preset.revision) {
            installables.push({ packageName: presetName, install: async () => { throw new Error('清单中缺少该预设的来源信息') } })
            continue
          }
          installables.push({
            packageName: presetName,
            offline: false,
            install: async () => {
              await options.installer.installPreset({
                repository: preset.repository!,
                targetId: presetName,
                name: presetName,
                sourcePath: preset.sourcePath!,
                revision: preset.revision!,
              })
            },
          })
        }

        // Skill：按清单里的 pin 信息直接安装，不重新分析 HEAD。
        for (const skillName of wantedSkills) {
          const skill = skillEntries.get(skillName)!
          if (!skill.repository || !skill.sourcePath || !skill.revision) {
            installables.push({ packageName: skillName, install: async () => { throw new Error('清单中缺少该 Skill 的来源信息') } })
            continue
          }
          installables.push({
            packageName: skillName,
            offline: false,
            install: async () => {
              await options.installer.installSkillPinned({
                repository: skill.repository!,
                target: {
                  id: `${skillName}:${skill.sourcePath}`,
                  name: skillName,
                  description: '',
                  sourcePath: skill.sourcePath!,
                  format: skill.format,
                  revision: skill.revision!,
                  modelInvocable: false,
                  userInvocable: false,
                },
              })
            },
          })
        }

        // Application Addon：按仓库重新分析安装（暂不支持离线本体）。
        for (const addonId of wantedApplications) {
          const application = applicationEntries.get(addonId)!
          installables.push({
            packageName: addonId,
            offline: false,
            install: async () => {
              await options.applicationAddons.install({
                repository: application.repository,
                defaultBranch: 'main',
                targetId: application.id,
              })
            },
          })
        }

        // 全离线快装：zip 携带依赖 tarball + lockfile 时，灌 store 后一次性离线安装
        // 全部插件，不再逐个走在线解析；任何一步失败自动回退常规逐项安装。
        if (wantedPlugins.length > 0 && options.offlinePackInstall) {
          const offlineWork = path.join(dshHome, '.pack-offline-import', packId)
          try {
            await rm(offlineWork, { recursive: true, force: true }).catch(() => undefined)
            const offline = await extractOfflineSupportFromPath(filePath, offlineWork)
            // 从 lockfile 读出每个插件本体的期望绝对路径（安装时的 file: 目录），
            // 把 zip 内本体原样复制过去——lockfile 一字不改，install --offline 即可命中。
            const expectedBodyDirs = new Map<string, string>()
            if (offline) {
              const lockDoc = parseDocument(offline.lockfileText).toJS() as {
                importers?: Record<string, { dependencies?: Record<string, { specifier?: string }> }>
              } | null
              const importerDeps = lockDoc?.importers?.['.']?.dependencies ?? {}
              for (const packageName of wantedPlugins) {
                const specifier = importerDeps[packageName]?.specifier ?? ''
                if (!specifier.startsWith('file:')) continue
                const expected = specifier.slice('file:'.length)
                // 只接受绝对路径；相对路径无法可靠还原，回退在线安装。
                if (!/^[A-Za-z]:[/\\]/.test(expected) && !expected.startsWith('/')) continue
                expectedBodyDirs.set(packageName, path.normalize(expected))
              }
            }
            if (offline && expectedBodyDirs.size === wantedPlugins.length) {
              options.emitEvent({ kind: 'status', message: `检测到离线依赖包（${offline.tarballCount} 个），免联网直装中…` })
              // 1) 本体解到临时目录，再复制到 lockfile 期望的绝对路径（已存在则复用）。
              const offlineBodies = await extractPackBodiesFromPath(
                filePath,
                path.join(offlineWork, 'bodies'),
                undefined,
                new Set(manifest.plugins.map(entry => entry.packageName)),
              )
              const finalDirs = new Map<string, string>()
              for (const packageName of wantedPlugins) {
                const bodyDir = offlineBodies.get(packageName)
                const expectedDir = expectedBodyDirs.get(packageName)
                if (!bodyDir || !expectedDir) throw new Error(`离线包缺少插件本体：${packageName}`)
                if (!existsSync(expectedDir)) {
                  await mkdir(path.dirname(expectedDir), { recursive: true })
                  await cp(bodyDir, expectedDir, { recursive: true })
                }
                finalDirs.set(packageName, expectedDir)
              }
              // 2) lockfile 原样落到 profile。
              const profileDir = path.join(dshHome, 'profiles', profileName)
              await writeFile(path.join(profileDir, 'pnpm-lock.yaml'), offline.lockfileText, 'utf8')
              // 3) package.json 写入依赖与 bundles（等价 DSH CLI add 后的 reconcile 结果）。
              const profileManifestPath = path.join(profileDir, 'package.json')
              const pkgJson = JSON.parse(await readFile(profileManifestPath, 'utf8')) as {
                dependencies?: Record<string, string>
                dsh?: { profile?: { bundles?: string[] } }
              }
              const dependencies = pkgJson.dependencies && typeof pkgJson.dependencies === 'object' && !Array.isArray(pkgJson.dependencies)
                ? pkgJson.dependencies
                : {}
              const templateBundles = pkgJson.dsh?.profile?.bundles ?? []
              const bundles = new Set<string>(templateBundles)
              for (const packageName of finalDirs.keys()) {
                dependencies[packageName] = `file:${(finalDirs.get(packageName) ?? '').replace(/\\/g, '/')}`
                bundles.add(packageName)
              }
              pkgJson.dependencies = dependencies
              pkgJson.dsh = { ...pkgJson.dsh, profile: { ...pkgJson.dsh?.profile, bundles: [...bundles] } }
              await writeFile(profileManifestPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8')
              // 4) 灌 store + 离线 install。
              await options.offlinePackInstall({
                tarballDir: offline.tarballDir,
                profileDir,
                onOutput: line => {
                  const trimmed = line.trim()
                  if (trimmed) options.emitEvent({ kind: 'status', message: trimmed.slice(0, 160) })
                },
              })
              // 5) 这些插件已就位，常规逐项安装改为直通完成。
              for (const item of installables) {
                if (finalDirs.has(item.packageName)) item.install = async () => {}
              }
              options.emitEvent({ kind: 'status', message: `离线直装完成：${finalDirs.size} 个插件未联网安装。` })
            }
          } catch (error) {
            log('info', `离线快装失败，回退在线安装：${asErrorMessage(error)}`)
            options.emitEvent({ kind: 'status', message: '离线快装不可用，回退在线安装。' })
          } finally {
            await rm(offlineWork, { recursive: true, force: true }).catch(() => undefined)
          }
        }
        const { installed, failures } = await runSerialInstall(installables, { emitEvent: options.emitEvent })
        if (!options.unifiedProfiles) await reapplyCurrentSelection(settings, profileBeforeInstall)
        const result = buildInstallResult(packId, installed, failures)

        // Keep the record and Profile order aligned with the manifest even if
        // skills, presets, or archive entries complete in another order.
        const installedPluginNames = wantedPlugins.filter(name => installed.includes(name))
        const installedPresetNames = installed.filter(name => presetNames.has(name))
        const installedSkillNames = installed.filter(name => skillNames.has(name))
        const installedApplicationIds = installed.filter(name => applicationIds.has(name))
        const record: PackRecord = {
          id: packId,
          name: importPackDisplayName(packId, baseId, manifest.name),
          description: manifest.description,
          version: manifest.version,
          dshVersion: manifest.dshVersion,
          ...(options.unifiedProfiles ? { homePath: dshHome } : {}),
          source: inspection.hasBodies ? 'zip' : 'manifest',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state: result.state,
          plugins: installedPluginNames.map(packageName => ({
            packageName,
            enabled: manifestEntries.get(packageName)?.enabled !== false,
          })),
          ...(installedPresetNames.length > 0 ? { presets: installedPresetNames.map(name => ({ name, enabled: true })) } : {}),
          ...(installedSkillNames.length > 0 ? { skills: installedSkillNames.map(name => ({ name, format: skillEntries.get(name)?.format ?? 'bundle', enabled: true })) } : {}),
          ...(installedApplicationIds.length > 0 ? { applications: installedApplicationIds.map(id => ({ id, name: applicationEntries.get(id)?.name ?? id, enabled: true })) } : {}),
          failures: result.failures.length > 0 ? result.failures : undefined,
        }
        if (options.unifiedProfiles) {
          await applyPluginSet(
            profileName,
            installedPluginNames.map(packageName => ({
              packageName,
              enabled: manifestEntries.get(packageName)?.enabled !== false,
            })),
            installedPluginNames,
          )
        }
        await upsertPackRecord(options.registryPath, record)
        await writeRecordManifest(record, manifest)
        const extraParts: string[] = []
        if (installedPresetNames.length > 0) extraParts.push(`${installedPresetNames.length} 个预设`)
        if (installedSkillNames.length > 0) extraParts.push(`${installedSkillNames.length} 个技能`)
        if (installedApplicationIds.length > 0) extraParts.push(`${installedApplicationIds.length} 个应用`)
        log('success', `整合包「${manifest.name}」已导入：${installedPluginNames.length} 个插件${extraParts.length > 0 ? `、${extraParts.join('、')}` : ''}。`)
        options.emitEvent({ kind: 'done', result })
        return result
      } catch (error) {
        const message = asErrorMessage(error)
        options.emitEvent({ kind: 'error', message })
        throw error
      } finally {
        if (skillStaging) await rm(skillStaging, { recursive: true, force: true }).catch(() => undefined)
        if (presetStaging) await rm(presetStaging, { recursive: true, force: true }).catch(() => undefined)
        if (presetBodiesDir) await rm(presetBodiesDir, { recursive: true, force: true }).catch(() => undefined)
        active = false
      }
    },

    async exportPack(packId, include: SnapshotPrivacyInclude = {}, targetZipPath?: string) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      active = true
      let exportDir: string | null = null
      try {
        const record = await findRecord(packId)
        const dshHome = await homeOfRecord(record)
        if (!existsSync(dshHome)) throw new Error(`整合包「${packId}」的家目录不存在：${dshHome}`)
        options.emitEvent({ kind: 'status', message: '正在扫描整合包目录…' })
        // 快照式导出：家目录镜像（默认剔除个人数据、file: 依赖相对化），没有清单。
        const plan = await planSnapshot(dshHome, { packId, include })
        if (plan.entries.length === 0) throw new Error(`整合包「${packId}」没有可导出的内容。`)
        const privacy = plan.privacy ?? []
        if (privacy.length > 0) {
          // 三个月后拿到这个 zip 的人（可能就是机主自己）不会记得勾过什么，
          // 所以警告跟着包走，而不是只留在导出那一刻的弹窗里。
          const warning = Buffer.from(privacyWarningText(record.name, privacy), 'utf8')
          plan.entries.push({ rel: PRIVACY_WARNING_FILENAME, data: warning })
          plan.totalBytes += warning.length
        }
        // 体积不设闸：包多大都照导（撞上磁盘或 OS 的错就让底层报）。只保留条目数上限——
        // 几十万个小文件会把 zip 中央目录撑成没人受得了的样子，那是结构性错误，不是"大"。
        if (plan.entries.length > SNAPSHOT_ZIP_LIMITS.maxFiles) {
          throw new Error(`整合包「${packId}」有 ${plan.entries.length} 个文件，超过 ${SNAPSHOT_ZIP_LIMITS.maxFiles} 条上限：先把 extras/ 里零碎的文件打包成整份再导出。`)
        }
        for (const warning of plan.warnings) log('info', warning)
        if (plan.longPaths.length > 0) {
          log('info', `有 ${plan.longPaths.length} 个路径较长（如 ${plan.longPaths[0]}），导入到更深的目录时可能失败。`)
        }
        let zipPath = targetZipPath
        if (!zipPath) {
          const exportRoot = path.join(options.snapshotRoot, 'exports')
          await mkdir(exportRoot, { recursive: true })
          exportDir = await mkdtemp(path.join(exportRoot, 'pack-'))
          zipPath = path.join(exportDir, `${packId}.zip`)
        }
        const sizeMb = Math.round(plan.totalBytes / (1024 * 1024))
        // 打包是有字节进度的：走 stage 事件报百分比，界面才能画确定态进度条
        // （status 进度的百分比恒为空，会被渲染成一直转圈的不确定态）。
        options.emitEvent({ kind: 'stage', label: `正在打包 ${plan.entries.length} 个文件（约 ${sizeMb}MB）…`, percent: 0 })
        await writeSnapshotZip(plan, zipPath, {
          onProgress: (written, total) => {
            const toMb = (value: number): number => Math.round(value / (1024 * 1024))
            options.emitEvent({ kind: 'stage', label: `打包中：${toMb(written)}/${toMb(total)}MB`, percent: packPercent(written, total) })
          },
        })
        return { zipPath, fileName: path.basename(zipPath) }
      } catch (error) {
        if (exportDir) await rm(exportDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      } finally {
        active = false
        // 导出只发阶段事件、从不发 done/error：必须在这里自己收口，否则界面横幅
        // 会一直停在最后一句「打包中…」，看起来像还在导（文件其实早写完了）。
        options.emitEvent({ kind: 'status', message: '' })
      }
    },

    async createVersionClone(packId, request) {
      const reason = guardedNewHome()
      if (reason) throw new Error(reason)
      // 与导出同类：只占用 active 标记，不进 beginTask 的回滚台账（那套是给插件安装用的）。
      active = true
      const version = request.dshVersion.trim()
      const scratchZip = path.join(options.snapshotRoot, `clone-${packId}-${Date.now()}.zip`)
      let createdHome: string | null = null
      try {
        if (!version) throw new Error('要先选好新版本。')
        const source = await findRecord(packId)
        const sourceRejection = downgradeRejection(source.dshVersion, version)
        if (sourceRejection) throw new Error(sourceRejection)
        const sourceHome = await homeOfRecord(source)
        if (!existsSync(sourceHome)) throw new Error(`整合包「${source.name}」的家目录不存在：${sourceHome}`)
        const name = (request.name ?? '').trim() || `${source.name} · DSH ${version}`
        const baseId = packProfileName(name)
        const existing = await readPackRegistry(options.registryPath)
        let newId = baseId
        for (let suffix = 2; existing.some(record => record.id === newId); suffix += 1) {
          if (suffix > 999) throw new Error('同名整合包过多，请换一个名字。')
          newId = `${baseId}-${suffix}`
        }
        const homePath = path.join(packsRoot, newId)

        // 先把目标版本装好：下载/校验失败时旧包与磁盘上的新目录都还没动，失败面最小。
        options.emitEvent({ kind: 'stage', label: `正在准备 DSH ${version}`, percent: null })
        if (options.ensureDshVersionInstalled) await options.ensureDshVersionInstalled(version)

        options.emitEvent({ kind: 'stage', label: '正在复制整合包内容…', percent: 0 })
        const plan = await planSnapshot(sourceHome, { packId, include: { credentials: true, sessions: true } })
        await mkdir(path.dirname(scratchZip), { recursive: true })
        await writeSnapshotZip(plan, scratchZip, {
          onProgress: (written, total) => options.emitEvent({ kind: 'stage', label: '正在复制整合包内容…', percent: packPercent(written, total) }),
        })
        await extractSnapshot(scratchZip, homePath, { newId })
        createdHome = homePath
        await setProfileDshVersion(homePath, newId, version)

        const now = new Date().toISOString()
        const record: PackRecord = {
          id: newId,
          name,
          description: source.description,
          version: '1.0.0',
          dshVersion: version,
          homePath,
          source: 'created',
          installedAt: now,
          updatedAt: now,
          state: 'complete',
          plugins: source.plugins.map(plugin => ({ ...plugin })),
        }
        await upsertPackRecord(options.registryPath, record)
        await writeRecordManifest(record).catch(() => undefined)
        options.onPackCreated?.(newId)
        log('success', `已复制出「${name}」（DSH ${version}）。原来的「${source.name}」没有改动。`)
        return toPackStatus(record, (await options.readSettings()).activePackId)
      } catch (error) {
        // 复制失败不留半个包：目录删掉、注册表里也不会有它，旧包毫发无损。
        if (createdHome) await rm(createdHome, { recursive: true, force: true }).catch(() => undefined)
        throw error
      } finally {
        await rm(scratchZip, { force: true }).catch(() => undefined)
        active = false
        options.emitEvent({ kind: 'status', message: '' })
      }
    },

    async previewSessionImport(sourcePackId, targetPackId) {
      return (await buildSessionImportPreview(sourcePackId, targetPackId)).preview
    },

    async importSessionHistory(sourcePackId, targetPackId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      active = true
      // 清单先建好：中途失败也要能撤销已复制出去的那部分，不然留下没有退路的半成品。
      const manifest: TransferManifest = { version: 1, targetHome: '', createdAt: new Date().toISOString(), files: [] }
      const undoId = `${Date.now()}`
      let manifestWritten = false
      try {
        const { plan, preview } = await buildSessionImportPreview(sourcePackId, targetPackId)
        manifest.targetHome = plan.targetHome
        if (plan.importableCount === 0) {
          return { ...preview, copiedFiles: 0, copiedBytes: 0, undoId: '' }
        }
        const totalBytes = plan.importableBytes + plan.extraBytes
        options.emitEvent({
          kind: 'stage',
          label: `正在复制 ${plan.importableCount} 条会话记录（约 ${Math.round(totalBytes / (1024 * 1024))}MB）…`,
          percent: 0,
        })
        await applySessionTransfer(plan, {
          manifest,
          onProgress: progress => options.emitEvent({
            kind: 'stage',
            label: `已复制 ${progress.files} 个文件（${Math.round(progress.bytes / (1024 * 1024))}MB）`,
            percent: packPercent(progress.bytes, totalBytes),
          }),
        })
        const manifestPath = path.join(sessionImportsRoot, `${targetPackId}-${undoId}.json`)
        await writeTransferManifest(manifestPath, manifest)
        manifestWritten = true
        log('success', `已把「${preview.sourceName}」的 ${plan.importableCount} 条会话记录复制进「${preview.targetName}」。`)
        if (preview.dangling.presets.length + preview.dangling.plugins.length > 0) {
          log('info', `这些名字在「${preview.targetName}」里没有：${[...preview.dangling.presets, ...preview.dangling.plugins].join('、')}；相关记录能看，但可能发不出新消息。`)
        }
        return {
          ...preview,
          copiedFiles: manifest.files.length,
          copiedBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
          undoId: manifest.files.length > 0 ? undoId : '',
        }
      } catch (error) {
        // 失败也留清单：撤销靠它把已经拷过去的文件收回去。
        if (manifest.files.length > 0 && !manifestWritten) {
          await writeTransferManifest(path.join(sessionImportsRoot, `${targetPackId}-${undoId}.json`), manifest).catch(() => undefined)
        }
        throw error
      } finally {
        active = false
        // 与导出同一条规矩：只发 stage 不收口，界面横幅会永远停在「已复制 N 个文件」。
        options.emitEvent({ kind: 'status', message: '' })
      }
    },

    async undoSessionImport(undoId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      active = true
      try {
        if (!/^\d+$/.test(undoId)) throw new Error('撤销凭据无效。')
        const files = await readdir(sessionImportsRoot).catch(() => [] as string[])
        // 清单文件名是 <目标包 id>-<undoId>.json；undoId 已限定为数字，不会拼出越界路径。
        const matches = files.filter(name => name.endsWith(`-${undoId}.json`))
        if (matches.length !== 1) throw new Error('找不到这次导入的记录，无法撤销。')
        const manifestPath = path.join(sessionImportsRoot, matches[0]!)
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TransferManifest
        const result = await undoSessionTransfer(manifest)
        // 全删干净了才丢清单；有文件被 DSH 追加过就留着，让用户能看到还剩多少。
        if (result.kept === 0 && !result.error) await rm(manifestPath, { force: true })
        return result
      } finally {
        active = false
      }
    },

    async activatePack(packId) {
      // 切换实例只写指针（activatePackRecord 只改 settings 的 activePackId/profileName），
      // 不碰正在跑的那些进程 —— 别的实例在跑不该拦住「把首页指向另一个实例」。
      const reason = guardedNewHome()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        return await activatePackRecord(await findRecord(packId))
      } finally {
        active = false
      }
    },

    async adoptPackFromFolder(homePath, name) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        const { record } = await adoptHomeAsPack({ registryPath: options.registryPath, homePath, name })
        options.onPackCreated?.(record.id)
        return toPackStatus(record, (await options.readSettings()).activePackId)
      } finally {
        active = false
      }
    },

    async removePack(packId) {
      const settings = await options.readSettings()
      // 只用 activePackId：profileName 阶段 2 起恒为 web，拿它判「删的是激活包」会恒真。
      const wasActive = settings.activePackId === packId
      // 阻塞条件只有一条：**这个包自己**此刻在真的运行。它是当前选中的包、别的实例在跑，
      // 都不该拦住删除（每个包一个家目录一个进程）。在跑的包先停下来再删，不让用户自己去按停止。
      const running = options.isPackRunning?.(packId) === true
      const reason = guardedNewHome()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        const record = await findRecord(packId)
        if (running) {
          if (!options.stopPack) throw new Error('该实例正在运行：请先停止它，再删除整合包。')
          await options.stopPack(packId)
        }
        const stored = options.readStoredSettings ? await options.readStoredSettings() : settings
        if (record.homePath && !samePath(record.homePath, stored.dshHome)) {
          // 私有家目录：整个环境连会话、登录、插件一并删除（共享的 DSH 版本二进制不动）。
          // 但只许删启动器自己的地盘：手动接管进来的外部家目录（例如 ~/.dsh）一律拒绝。
          assertLauncherOwnedHome(record.homePath, homeScope, `删除整合包「${packId}」的家目录`)
          await removeDirectoryAtomically(record.homePath)
        } else {
          const home = stored.dshHome
          assertLauncherOwnedHome(home, homeScope, `删除整合包「${packId}」的 Profile`)
          await removeDirectoryAtomically(path.join(home, 'profiles', packId))
          await rm(packBodiesDir(home, packId), { recursive: true, force: true }).catch(() => undefined)
        }
        const profileReceipts = (await readPluginReceipts(options.pluginReceiptsPath)).filter(item => item.packId === packId)
        for (const receipt of profileReceipts) {
          await removePluginReceipt(options.pluginReceiptsPath, packId, receipt.packageName)
        }
        await removePackRecord(options.registryPath, packId)
        await removePackManifest(manifestRoot, packId)
        let nextSettings = stored
        if (wasActive) {
          // 删掉了激活包：落到剩余里最近的包；一个不剩就置空指针进入零包引导态
          // （界面引导新建/导入，启动守卫拦住无包启动），不再自动新建兜底包。
          const remaining = await readPackRegistry(options.registryPath)
          const successor = remaining.find(record2 => record2.id === DEFAULT_PROFILE_NAME) ?? remaining[remaining.length - 1] ?? null
          nextSettings = successor
            ? {
                ...nextSettings,
                activePackId: successor.id,
                // profile 名照家里真实存在的那层写，不拿包 id 硬拼（见 activatePackRecord）。
                profileName: resolveProfileName(await homeOfRecord(successor), successor.id),
                ...(successor.dshVersion ? { dshVersion: successor.dshVersion } : {}),
              }
            : { ...nextSettings, activePackId: null }
        }
        await options.saveSettings(nextSettings)
        return {
          removed: record.plugins.length
            + (record.presets?.length ?? 0)
            + (record.skills?.length ?? 0)
            + (record.applications?.length ?? 0),
        }
      } finally {
        active = false
      }
    },

    async renamePack(packId, name) {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('整合包名称不能为空。')
      const record = await findRecord(packId)
      const next: PackRecord = { ...record, name: trimmed, updatedAt: new Date().toISOString() }
      await upsertPackRecord(options.registryPath, next)
      return toPackStatus(next, (await options.readSettings()).activePackId)
    },

    async createBlankPack(request) {
      const reason = guardedNewHome()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        const name = request.name.trim()
        // 文件夹名由调用方给（界面上的「文件夹名称」）：它直接就是磁盘目录名与 Profile 名，
        // 不再走 pack- 前缀派生 —— 否则用户的 pack-20261025 会变成 pack-pack-20261025。
        const folderName = (request.folderName ?? '').trim()
        if (folderName && !isSafeProfileName(folderName)) throw new Error('文件夹名称只能包含字母、数字、点、横线或下划线。')
        const baseId = folderName || packProfileName(name)
        const existing = await readPackRegistry(options.registryPath)
        let packId = baseId
        let suffix = 1
        while (existing.some(record => record.id === packId)) {
          suffix += 1
          if (suffix > 999) throw new Error('同名整合包过多，请换一个名字。')
          packId = `${baseId}-${suffix}`
        }
        if (request.dshVersion && options.ensureDshVersionInstalled) {
          await options.ensureDshVersionInstalled(request.dshVersion)
        }
        const homePath = path.join(packsRoot, packId)
        await seedPackHome(homePath, packId, { dshVersion: request.dshVersion })
        const now = new Date().toISOString()
        const record: PackRecord = {
          id: packId,
          name,
          description: '',
          version: '1.0.0',
          ...(request.dshVersion ? { dshVersion: request.dshVersion } : {}),
          homePath,
          source: 'created',
          installedAt: now,
          updatedAt: now,
          state: 'complete',
          plugins: [],
        }
        await upsertPackRecord(options.registryPath, record)
        await writeRecordManifest(record).catch(() => undefined)
        options.onPackCreated?.(packId)
        let activeSettings = await options.readSettings()
        if (!activeSettings.activePackId) {
          // 零包状态下新建：直接成为当前包（空态引导「新建整合包」的落点）。
          activeSettings = await activatePackRecord(record)
        }
        return toPackStatus(record, activeSettings.activePackId)
      } finally {
        active = false
      }
    },

    async packDiskUsage(packId) {
      const record = await findRecord(packId)
      return directorySize(await homeOfRecord(record))
    },

    async openPackExtras(packId) {
      const record = await findRecord(packId)
      const target = path.join(await homeOfRecord(record), 'extras')
      await mkdir(target, { recursive: true })
      return target
    },

    async packExtras(packId) {
      const record = await findRecord(packId)
      const target = path.join(await homeOfRecord(record), 'extras')
      const info = await stat(target).catch(() => null)
      if (!info || !info.isDirectory()) return { exists: false, count: 0 }
      const entries = await readdir(target).catch(() => [])
      return { exists: true, count: entries.length }
    },

    async rollback() {
      const reason = guarded()
      if (reason) throw new Error(reason)
      if (!snapshot) throw new Error('没有可用快照，无法还原。')
      active = true
      try {
        const result = await restoreProfileSnapshot(snapshot)
        const newPrivateHome = options.unifiedProfiles && provisionedNewHome
          && snapshot.dshHome.startsWith(packsRoot + path.sep)
        if (newPrivateHome) {
          // 本次导入新建的私有家目录：整家删除 + 注销记录，环境当作从未存在。
          assertLauncherOwnedHome(snapshot.dshHome, homeScope, '回滚并删除新建的家目录')
          await rm(snapshot.dshHome, { recursive: true, force: true }).catch(() => undefined)
          await removePackRecord(options.registryPath, snapshot.profileName).catch(() => undefined)
          await removePackManifest(manifestRoot, snapshot.profileName).catch(() => undefined)
        } else if (profileWasNew && snapshot.profileName !== (await options.readSettings()).profileName) {
          // 共享 Profile 模式下回滚只恢复清单文件，绝不删除当前 Profile 目录。
          assertLauncherOwnedHome(snapshot.dshHome, homeScope, '回滚并删除新建的 Profile')
          await rm(path.join(snapshot.dshHome, 'profiles', snapshot.profileName), { recursive: true, force: true }).catch(() => undefined)
          await removePackRecord(options.registryPath, snapshot.profileName).catch(() => undefined)
        }
        const stored = options.readStoredSettings ? await options.readStoredSettings() : await options.readSettings()
        // 指针回退：激活包被回滚删除时，落回默认包 web（若注册表里存在），否则清空。
        const records = await readPackRegistry(options.registryPath)
        const fallback = (stored.activePackId ? records.find(record => record.id === stored.activePackId) : null)
          ?? records.find(record => record.id === DEFAULT_PROFILE_NAME)
          ?? null
        await options.saveSettings({
          ...stored,
          activePackId: fallback?.id ?? null,
          // 同上：profile 名走解析入口，阶段 1 回落到包 id（原值），阶段 2 起就是 web。
          profileName: fallback ? resolveProfileName(await homeOfRecord(fallback), fallback.id) : stored.profileName,
        })
        options.emitEvent({ kind: 'status', message: `已还原快照 ${snapshot.id}` })
        return { restored: result.restored, profileName: snapshot.profileName }
      } finally {
        active = false
        snapshot = null
        profileWasNew = false
        // 「已还原快照」只是完成文案，没有 done/error 收尾，横幅会一直挂着转圈。
        options.emitEvent({ kind: 'status', message: '' })
      }
    },

    hasSnapshot: async () => snapshot !== null,

    async addPackPlugin(packId, packageName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      profileWasNew = false
      try {
        assertSafePackId(packId)
        if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')

        const settings = await options.readSettings()
        const dshHome = await getDshHome()
        const currentProfile = await options.installer.readProfile(dshHome, settings.profileName)
        const installedPlugin = currentProfile.plugins.find(item => item.packageName === packageName)
        if (!installedPlugin || installedPlugin.builtin) throw new Error('当前整合包中找不到可打包的非内置插件。')
        options.emitEvent({ kind: 'status', message: `正在向整合包添加插件 ${packageName}…` })
        const record = await findRecord(packId)
        const plugins = [...record.plugins.filter(item => item.packageName !== packageName), { packageName, enabled: true }]
        const updated: PackRecord = { ...record, plugins, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await applyPluginSet(settings.profileName, updated.plugins, updated.plugins.map(item => item.packageName))
        return toPackStatus(updated, selectedPackKey(settings))
      } catch (error) {
        options.emitEvent({ kind: 'error', message: asErrorMessage(error) })
        throw error
      } finally {
        active = false
        // 成功路径只发过「正在向整合包添加插件…」，没有收尾事件，同样要自己收口。
        options.emitEvent({ kind: 'status', message: '' })
      }
    },

    async addPackPreset(packId, presetName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) throw new Error('预设名称无效。')
        const settings = await options.readSettings()
        const dshHome = await getDshHome()
        if (!existsSync(path.join(dshHome, '.agent-presets', presetName))) throw new Error('当前环境找不到已安装的该预设。')
        const record = await findRecord(packId)
        if (record.presets?.some(item => item.name === presetName)) {
          return toPackStatus(record, selectedPackKey(settings))
        }
        const presets = [...(record.presets ?? []), { name: presetName, enabled: true }]
        const updated: PackRecord = { ...record, presets, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async addPackSkill(packId, skillName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) throw new Error('Skill 名称无效。')
        const settings = await options.readSettings()
        const receipts = await readSkillReceipts(options.skillReceiptsPath)
        const receipt = receipts.find(item => item.name === skillName)
        if (!receipt) throw new Error('当前环境找不到该 Skill 的来源记录。')
        const record = await findRecord(packId)
        if (record.skills?.some(item => item.name === skillName)) {
          return toPackStatus(record, selectedPackKey(settings))
        }
        const skills = [...(record.skills ?? []), { name: skillName, format: receipt.format, enabled: true }]
        const updated: PackRecord = { ...record, skills, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackSkill(packId, skillName, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) throw new Error('Skill 名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const skills = (record.skills ?? []).map(item => item.name === skillName ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, skills, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.toggleSkill(skillName, Boolean(enabled))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackSkill(packId, skillName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) throw new Error('Skill 名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const skills = (record.skills ?? []).filter(item => item.name !== skillName)
        const updated: PackRecord = { ...record, skills: skills.length > 0 ? skills : undefined, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.toggleSkill(skillName, false)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async addPackApplication(packId, addonId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        const settings = await options.readSettings()
        const addons = await options.applicationAddons.list()
        const addon = addons.find(item => item.id === addonId)
        if (!addon) throw new Error('当前环境找不到已安装的应用加载项。')
        const record = await findRecord(packId)
        if (record.applications?.some(item => item.id === addonId)) {
          return toPackStatus(record, selectedPackKey(settings))
        }
        const applications = [...(record.applications ?? []), { id: addonId, name: addon.name, enabled: true }]
        const updated: PackRecord = { ...record, applications, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackApplication(packId, addonId, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        const settings = await options.readSettings()
        if (isSelectedProfile(settings, packId) && options.applicationAddons.toggle) {
          await options.applicationAddons.toggle(addonId, Boolean(enabled))
        }
        const record = await findRecord(packId)
        const applications = (record.applications ?? []).map(item => item.id === addonId ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, applications, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackApplication(packId, addonId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const applications = (record.applications ?? []).filter(item => item.id !== addonId)
        const updated: PackRecord = { ...record, applications: applications.length > 0 ? applications : undefined, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId) && options.applicationAddons.toggle) await options.applicationAddons.toggle(addonId, false)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackPreset(packId, presetName, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) throw new Error('预设名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const presets = (record.presets ?? []).map(item => item.name === presetName ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, presets, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.togglePreset(presetName, Boolean(enabled))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackPreset(packId, presetName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) throw new Error('预设名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const presets = (record.presets ?? []).filter(item => item.name !== presetName)
        const updated: PackRecord = { ...record, presets: presets.length > 0 ? presets : undefined, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.togglePreset(presetName, false)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackItem(packId, packageName, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const plugins = record.plugins.map(item => item.packageName === packageName ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, plugins, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await applyPluginSet(settings.profileName, updated.plugins, updated.plugins.map(item => item.packageName))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackItem(packId, packageName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const plugins = record.plugins.filter(item => item.packageName !== packageName)
        const updated: PackRecord = { ...record, plugins, updatedAt: new Date().toISOString() }
        if (options.unifiedProfiles && isSelectedProfile(settings, packId)) {
          await options.installer.remove(packageName, settings.profileName)
        }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await applyPluginSet(settings.profileName, updated.plugins, updated.plugins.map(item => item.packageName))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },
  }
}
