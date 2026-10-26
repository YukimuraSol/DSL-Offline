import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PROFILE_NAME, DSH_PACKAGE_NAME } from '../src/constants'
import type { AppSettings, DshInstallationStatus, NetworkSettings, UiTheme } from '../src/types'
import { managedDshExecutable } from './dsh-install'
import { isSafeProfileName } from './profile'

/**
 * 启动器设置的唯一权威来源：默认值、校验、持久化与内存缓存。
 * 不直接依赖 electron —— 路径与 DSH 检测都由调用方注入，因此可以完整单测。
 */

export interface DefaultSettingsInput {
  /** 环境变量 DSH_HOME，缺省时回落到用户主目录下的 .dsh。 */
  dshHomeFromEnvironment?: string
  homeDirectory: string
  documentsDirectory: string
  /** 系统 npx 的绝对路径；未检测到时使用平台默认名。 */
  systemNpx?: string
  /** 启动器自己管理的 DSH 安装根目录。 */
  dshInstallPath?: string
  /**
   * 启动器自身的安装目录（打包态 = exe 所在目录）。
   * 给了就让缺省整合包根目录落在它内部（<安装目录>\dsh-packs），
   * 用户装到 D 盘时数据就落在 D 盘，且随安装目录一起搬。
   */
  installLocation?: string
  /** 整合包根目录；由主进程按安装位置/旧目录兼容规则算好再传进来。 */
  packsRoot?: string
  /**
   * 启动器私有根目录（Electron 的 userData）。
   * 传了就把 dshHome / dshInstallPath 的缺省值放在它下面，**不再指向用户主目录**：
   * 首启双击启动的进程环境里没有 DSH_HOME，指向 ~/.dsh 等于默认去改写用户的真实环境。
   */
  userDataPath?: string
  platform?: NodeJS.Platform
}

/**
 * 整合包根目录：<安装目录>\dsh-packs —— 落在安装目录**内部**。
 *
 * 用户原话「不能直接和安装目录里面指定一个相对位置吗」：装到 D:\DSH Pack Launcher\ 时
 * 整合包就在 D:\DSH Pack Launcher\dsh-packs\，用户搬走/备份整个安装目录 = 连包一起搬，
 * 不会再出现「启动器在一个目录、几十 GB 的包在隔壁另一个目录」的割裂感。
 *
 * 代价与对策（卸载不能连包一起删）：安装包是 Inno Setup（scripts/build-installer.mjs
 * 编译 build/installer.iss），不是 electron-builder 的 NSIS，所以 nsis.include /
 * customRemoveFiles 那套钩子在这里根本不参与编译。保护写在 installer.iss 里：
 * [UninstallDelete] 只有一条 Type: dirifempty; Name: "{app}"，绝不出现
 * Type: filesandordirs; Name: "{app}"；卸载器只按卸载日志删 [Files] 装进去的文件，
 * dsh-packs 是启动器运行时才创建的、日志里没有，所以原样保留。
 * [Code] 的 CurUninstallStepChanged 只在交互式卸载时弹提示，不删不移。
 * 见 build/installer.iss 的 [UninstallDelete] 与 [Code] 段。
 */
export function packsRootInsideInstall(installLocation: string): string {
  return path.join(installLocation, 'dsh-packs')
}

/**
 * 整合包的缺省根目录（没有安装位置时的回落）：%LOCALAPPDATA%\<userData 目录名>\dsh-packs。
 *
 * 主进程的 resolvePacksRoot 也走这一个实现（外加旧位置兼容），
 * 免得 defaultSettings 与启动序列各算一套默认值、改一处漏一处。
 */
export function defaultLauncherPacksRoot(userDataPath: string): string {
  const fromEnvironment = process.env.LOCALAPPDATA
  const parent = path.dirname(userDataPath)
  const base = fromEnvironment && path.isAbsolute(fromEnvironment)
    ? fromEnvironment
    : path.basename(parent).toLowerCase() === 'roaming'
      ? path.join(path.dirname(parent), 'Local')
      : parent
  return path.join(base, path.basename(userDataPath), 'dsh-packs')
}

/** 按注入的平台拼路径，让同一份输入在不同平台上可以完整单测。 */
function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts)
}

export function defaultSettings(input: DefaultSettingsInput): AppSettings {
  const platform = input.platform ?? process.platform
  // 缺省「家」：有 userData 就落启动器私有目录，没有（纯函数单测/未注入）才退回旧的主目录行为。
  const privateRoot = input.userDataPath
  // 有安装位置就以它为准（与启动序列的 resolvePacksRoot 同一优先级）。
  const installLocation = input.installLocation && path.isAbsolute(input.installLocation)
    ? input.installLocation
    : undefined
  return {
    dshInstallPath: input.dshInstallPath
      ?? (privateRoot
        ? joinForPlatform(platform, privateRoot, 'dsh-runtime')
        : joinForPlatform(platform, input.homeDirectory, '.dsh-runtime')),
    dshHome: input.dshHomeFromEnvironment
      || (privateRoot
        ? joinForPlatform(platform, privateRoot, 'dsh-home')
        : joinForPlatform(platform, input.homeDirectory, '.dsh')),
    dshVersion: null,
    nodeVersion: null,
    profileName: DEFAULT_PROFILE_NAME,
    activePackId: null,
    packsV2Migrated: false,
    packsRoot: input.packsRoot
      ?? (installLocation
        ? packsRootInsideInstall(installLocation)
        : privateRoot
          ? defaultLauncherPacksRoot(privateRoot)
          : joinForPlatform(platform, input.homeDirectory, '.dsh-packs')),
    workspace: input.documentsDirectory,
    launchExecutable: input.systemNpx ?? (platform === 'win32' ? 'npx.cmd' : 'npx'),
    launchArgs: ['--yes', DSH_PACKAGE_NAME, 'web'],
    webPort: 3080,
    openAfterLaunch: true,
    uiTheme: 'deepseek',
    aiDeveloperMode: false,
    aiPrompt: '',
    recommendedWebUiPrompted: false,
  }
}

const UI_THEMES = new Set<UiTheme>(['deepseek', 'night'])

function validUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && UI_THEMES.has(value as UiTheme)
}

function validWebPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
}

function validRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string'
    && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim())
}

/** 网络镜像/代理偏好：任一项非空才保留；丢空项以避免存一堆空字符串。 */
function validNetworkSettings(value: unknown): NetworkSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const network = value as Record<string, unknown>
  const text = (field: string): string | undefined =>
    typeof network[field] === 'string' && (network[field] as string).trim() !== ''
      ? (network[field] as string).trim()
      : undefined
  const npmRegistry = text('npmRegistry')
  const proxy = text('proxy')
  const githubMirror = text('githubMirror')
  return npmRegistry || proxy || githubMirror ? { npmRegistry, proxy, githubMirror } : undefined
}

/** 兼容曾经直接写在启动参数里的 --port。 */
export function webPortFromLaunchArgs(args: unknown): number | null {
  if (!Array.isArray(args)) return null
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--port') {
      const parsed = Number(args[index + 1])
      return validWebPort(parsed) ? parsed : null
    }
    if (typeof value === 'string' && value.startsWith('--port=')) {
      const parsed = Number(value.slice('--port='.length))
      return validWebPort(parsed) ? parsed : null
    }
  }
  return null
}

/** 忽略平台差异的路径比较：Windows 下不区分大小写。 */
export function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

/** child 是否等于 parent 或落在 parent 里（Windows 不区分大小写；边界按分隔符判，<a>evil 不算在 <a> 内）。 */
export function isSameOrInsidePath(child: string, parent: string): boolean {
  const fold = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const probe = fold(child)
  const base = fold(parent)
  return probe === base || probe.startsWith(base + path.sep)
}

/**
 * 一次性迁移的判定输入（纯数据，不读盘）。
 */
export interface PacksRootMigrationInput {
  /** settings.json 里存着的 packsRoot。 */
  stored: string
  /** 历史默认位置候选：stored 命中其中之一才说明「这不是用户自己选的」。 */
  legacyCandidates: readonly string[]
  /** 按当前安装位置算出来的新默认位置（<安装目录>\dsh-packs）。 */
  next: string
  /** 旧位置里是否已经有真实整合包。 */
  legacyHasPacks: boolean
}

export interface PacksRootMigrationPlan {
  /** 要不要改写 settings.json 里的 packsRoot。 */
  migrate: boolean
  /** 迁移目标；migrate 为 false 时原样返回 stored，调用方继续用旧值。 */
  target: string
}

/**
 * 一次性迁移判定：stored 还停在旧默认位置、新默认位置又变了，就把 packsRoot 改到新位置。
 *
 * 三条否决线（任何一条成立都不迁移）：
 * 1. stored 不是历史默认值之一 —— 用户自己选过目录，或者上一次已经迁移过了
 *    （迁移后 stored 就是新位置，条件 2 不再成立，所以幂等，不需要「已迁移」标记字段）；
 * 2. 新旧位置其实是同一个目录；
 * 3. 旧位置里已经有真实整合包 —— 有包绝不动，否则用户升级后突然看不见自己的包。
 *
 * 纯函数：路径比较走 samePath（Windows 不分大小写），不碰 electron、不读盘，四条分支直接单测。
 * ponytail: 迁移只改 settings 里那一行，不搬文件 —— 旧位置为空才走到这里，没有东西可搬。
 */
export function decidePacksRootMigration(input: PacksRootMigrationInput): PacksRootMigrationPlan {
  const stays: PacksRootMigrationPlan = { migrate: false, target: input.stored }
  if (!input.stored || !input.next) return stays
  if (!input.legacyCandidates.some(legacy => samePath(legacy, input.stored))) return stays
  if (samePath(input.next, input.stored)) return stays
  if (input.legacyHasPacks) return stays
  return { migrate: true, target: input.next }
}

/**
 * 旧位置里有没有**真实**整合包：一个直接子目录，且它底下有 profiles/<合法 profileId>。
 *
 * 口径与 pack.ts 的 autoAdoptPacksRootDirs 一致 —— 那里也只认带 profiles/<id> 的目录。
 * 目录不存在、空的、只有 .deleting-* 残留或空壳都算「没有包」，可以安全迁移；
 * 有任何真包就返回 true，绝不迁移（用户不能升级后突然看不见自己的包）。
 */
export async function packsRootHasPacks(packsRoot: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(packsRoot)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || !isSafeProfileName(entry)) continue
    try {
      const profiles = await readdir(path.join(packsRoot, entry, 'profiles'))
      if (profiles.some(profile => isSafeProfileName(profile))) return true
    } catch {
      // 不是整合包目录，跳过。
    }
  }
  return false
}

/** 校验并归一化一份来自渲染层的设置。任何一项不合法都直接抛错。 */
export function validateSettings(input: AppSettings): AppSettings {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效。')
  if (!isSafeProfileName(input.profileName)) throw new Error('整合包名称只能包含字母、数字、点、横线或下划线。')
  if (!path.isAbsolute(input.dshInstallPath) || !path.isAbsolute(input.dshHome) || !path.isAbsolute(input.workspace)) {
    throw new Error('目录必须使用完整路径。')
  }
  if (typeof input.packsRoot !== 'string' || !path.isAbsolute(input.packsRoot)) {
    throw new Error('整合包目录必须使用完整路径。')
  }
  const resolvedInstallPath = path.resolve(input.dshInstallPath)
  if (resolvedInstallPath === path.parse(resolvedInstallPath).root) throw new Error('DSH 本体不能直接安装到磁盘根目录。')
  if (samePath(input.dshInstallPath, input.dshHome)) throw new Error('DSH 本体安装目录不能与 DSH_HOME 相同。')
  // 互相包含同样危险：removePack 删整合包目录时会顺着父级把内核一起带走，反之亦然。
  if (isSameOrInsidePath(input.packsRoot, resolvedInstallPath) || isSameOrInsidePath(resolvedInstallPath, input.packsRoot)) {
    throw new Error('整合包目录与 DSH 本体安装目录不能互相包含。')
  }
  if (!input.launchExecutable.trim()) throw new Error('启动命令不能为空。')
  if (!Array.isArray(input.launchArgs) || input.launchArgs.some(value => typeof value !== 'string')) throw new Error('启动参数格式无效。')
  if (!validWebPort(input.webPort)) throw new Error('Web 端口必须是 1 到 65535 之间的整数。')
  return {
    dshInstallPath: input.dshInstallPath,
    dshHome: input.dshHome,
    dshVersion: input.dshVersion == null ? null : validRuntimeVersion(input.dshVersion) ? input.dshVersion.trim() : null,
    nodeVersion: input.nodeVersion == null ? null : validRuntimeVersion(input.nodeVersion) ? input.nodeVersion.trim() : null,
    profileName: input.profileName,
    // 整合包是真隔离环境的唯一实体：activePackId 与 profileName 同步指向当前激活包 id。
    activePackId: typeof input.activePackId === 'string' && input.activePackId ? input.activePackId : null,
    packsV2Migrated: Boolean(input.packsV2Migrated),
    packsRoot: path.resolve(input.packsRoot),
    workspace: input.workspace,
    launchExecutable: input.launchExecutable.trim(),
    launchArgs: input.launchArgs,
    webPort: input.webPort,
    openAfterLaunch: Boolean(input.openAfterLaunch),
    uiTheme: validUiTheme(input.uiTheme) ? input.uiTheme : 'deepseek',
    aiDeveloperMode: Boolean(input.aiDeveloperMode),
    aiPrompt: typeof input.aiPrompt === 'string' ? input.aiPrompt.slice(0, 20_000) : '',
    network: validNetworkSettings(input.network),
    recommendedWebUiPrompted: Boolean(input.recommendedWebUiPrompted),
  }
}

/** 把磁盘上的设置合并到默认值上，丢弃结构不对的字段。 */
export function mergeStoredSettings(defaults: AppSettings, stored: Partial<AppSettings> | null): AppSettings {
  if (!stored || typeof stored !== 'object') return defaults
  const storedPort = validWebPort(stored.webPort)
    ? stored.webPort
    : webPortFromLaunchArgs(stored.launchArgs) ?? defaults.webPort
  return {
    ...defaults,
    ...stored,
    dshVersion: stored.dshVersion == null ? null : validRuntimeVersion(stored.dshVersion) ? stored.dshVersion.trim() : null,
    nodeVersion: stored.nodeVersion == null ? null : validRuntimeVersion(stored.nodeVersion) ? stored.nodeVersion.trim() : null,
    activePackId: typeof stored.activePackId === 'string' && stored.activePackId ? stored.activePackId : null,
    packsV2Migrated: Boolean(stored.packsV2Migrated),
    dshInstallPath: typeof stored.dshInstallPath === 'string' && path.isAbsolute(stored.dshInstallPath)
      ? stored.dshInstallPath
      : defaults.dshInstallPath,
    packsRoot: typeof stored.packsRoot === 'string' && path.isAbsolute(stored.packsRoot)
      ? stored.packsRoot
      : defaults.packsRoot,
    launchArgs: Array.isArray(stored.launchArgs)
      ? stored.launchArgs.filter(value => typeof value === 'string')
      : defaults.launchArgs,
    webPort: storedPort,
    uiTheme: validUiTheme(stored.uiTheme) ? stored.uiTheme : defaults.uiTheme ?? 'deepseek',
    aiDeveloperMode: Boolean(stored.aiDeveloperMode),
    aiPrompt: typeof stored.aiPrompt === 'string' ? stored.aiPrompt.slice(0, 20_000) : '',
    network: validNetworkSettings(stored.network) ?? defaults.network,
    recommendedWebUiPrompted: Boolean(stored.recommendedWebUiPrompted),
  }
}

/**
 * 只读 settings.json 里的内核目录，不建 store、不探测。
 *
 * 启动顺序需要用：随包内核必须**先**释放进内核目录，之后才能建 SettingsStore —— 否则
 * 第一次读设置就会立刻探测 DSH，而那一刻内核还在拷（首启几百 MB、几分钟），只能探到
 * PATH 上的系统 dsh；这个结果会被 adoptDetectedDsh 采纳并写进 settings.json，
 * launchExecutable 从此钉死在系统 dsh 上，usesOnDemandDsh 也不再成立，没人会把它收回来。
 */
export async function readStoredDshInstallPath(filePath: string, fallback: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { dshInstallPath?: unknown }
    if (typeof raw.dshInstallPath === 'string' && path.isAbsolute(raw.dshInstallPath)) return raw.dshInstallPath
  } catch {
    // 首次启动还没有 settings.json：落回缺省位置。
  }
  return fallback
}

/**
 * 判断当前配置是否走「用 npx 临时拉取 DSH」的方式。
 * 是的话说明还没绑定到某个具体安装，可以在检测到本地 DSH 后自动切换过去。
 */
export function usesOnDemandDsh(settings: AppSettings): boolean {
  const executable = path.basename(settings.launchExecutable).toLowerCase()
  return (executable === 'npx' || executable === 'npx.cmd') && settings.launchArgs.includes(DSH_PACKAGE_NAME)
}

/** 已检测到本地 DSH 时，把按需拉取的配置切换为直接调用它。 */
export function adoptDetectedDsh(settings: AppSettings, detected: DshInstallationStatus): AppSettings {
  if (!usesOnDemandDsh(settings) || !detected.installed || !detected.executable) return settings
  return { ...settings, launchExecutable: detected.executable, launchArgs: ['web'] }
}

export interface SettingsStore {
  read(): Promise<AppSettings>
  /** 未派生的存储态：settings.json 里真实的默认家目录（不含激活包的私有目录）。 */
  readStored(): Promise<AppSettings>
  save(input: AppSettings): Promise<AppSettings>
}

export interface SettingsStoreOptions {
  filePath: string
  createDefaults: () => AppSettings
  /** 首次读取时用于把按需拉取的配置绑定到已安装的 DSH。 */
  detectInstalledDsh: (settings: AppSettings) => Promise<DshInstallationStatus>
  /**
   * 整合包真隔离的咽喉点：按激活包（activePackId）派生其私有 DSH 家目录。
   * 返回 null 表示用存储的默认家目录。派生值只存在于内存返回值里，绝不写回 settings.json。
   */
  resolvePackHome?: (settings: AppSettings) => Promise<string | null>
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  /** 未派生的存储态（settings.json 的形状）。 */
  let stored: AppSettings | null = null
  /** 对外返回值 = stored + 激活包派生的 dshHome。 */
  let cache: AppSettings | null = null

  async function derive(base: AppSettings): Promise<AppSettings> {
    if (!options.resolvePackHome || !base.activePackId) return base
    const home = await options.resolvePackHome(base)
    return home ? { ...base, dshHome: home } : base
  }

  async function ensureLoaded(): Promise<{ stored: AppSettings; derived: AppSettings }> {
    if (stored && cache) return { stored, derived: cache }
    const defaults = options.createDefaults()
    let parsed: Partial<AppSettings> | null = null
    try {
      parsed = JSON.parse(await readFile(options.filePath, 'utf8')) as Partial<AppSettings>
    } catch {
      parsed = null
    }
    let base = mergeStoredSettings(defaults, parsed)
    if (usesOnDemandDsh(base)) {
      base = adoptDetectedDsh(base, await options.detectInstalledDsh(base))
    }
    stored = base
    cache = await derive(base)
    return { stored: base, derived: cache }
  }

  return {
    async readStored(): Promise<AppSettings> {
      return (await ensureLoaded()).stored
    },

    async read(): Promise<AppSettings> {
      return (await ensureLoaded()).derived
    },

    async save(input: AppSettings): Promise<AppSettings> {
      const current = stored ?? input
      let next = validateSettings(input)
      // 剥离派生值：调用方常把 read() 的返回值整包传回来，其中 dshHome 可能已是激活包的私有目录；
      // 未改动的派生值一律还原为存储的默认家目录，防止包目录被写死进 settings.json。
      if (current.activePackId && cache && !samePath(next.dshHome, current.dshHome) && samePath(next.dshHome, cache.dshHome)) {
        next = { ...next, dshHome: current.dshHome }
      }
      // 用户改动了 DSH 本体安装目录，而启动命令仍指向旧目录里的可执行文件时，跟随切过去。
      const installPathChanged = !samePath(current.dshInstallPath, next.dshInstallPath)
      const usedPreviousManagedExecutable = samePath(next.launchExecutable, managedDshExecutable(current.dshInstallPath))
      if (installPathChanged && usedPreviousManagedExecutable) {
        next = { ...next, launchExecutable: managedDshExecutable(next.dshInstallPath), launchArgs: ['web'] }
      }
      await mkdir(path.dirname(options.filePath), { recursive: true })
      await writeFile(options.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      stored = next
      cache = await derive(next)
      return cache
    },
  }
}
