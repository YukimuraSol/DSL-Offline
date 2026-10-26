import { app, BrowserWindow, net, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppSettings, InstanceSnapshot, OfficialPackRelease, OfficialPackStatus, PackInstallResult, PortOwner, RuntimeOutput, WindowMode } from '../src/types'
import { ACP_RUNTIME_DIRNAME, CREDENTIALS_LOCK_DIRNAME, createAiInstaller, healCredentialsLock, type AiInstaller } from './ai-install'
import { createApplicationAddonManager, type ApplicationAddonManager } from './application-addons'
import { applyWindowMode, createMainWindow, createRendererChannel } from './app-window'
import { createCatalogSyncService, type CatalogSyncService } from './catalog-sync'
import { createCopilotSessionManager, type CopilotSessionManager } from './copilot-sessions'
import { createDshMarketService, type DshMarketService } from './dsh-market'
import { createDesktopPluginsService, type DesktopPluginsService } from './desktop-plugins'
import { runCommand } from './command'
import { readDeepSeekApiKey } from './credentials'
import { resolveAgentApiForModel, resolveCopilotAgentApi } from './copilot-api'
import { findInstalledDsh } from './dsh-install'
import { compareVersions } from './dsh-release'
import { buildPluginCommandArgs, createInstaller, syncProfilePnpmConfig, validateLocalPluginDirectory, type Installer } from './installer'
import { registerIpcHandlers } from './ipc'
import { createLauncherUpdater, type LauncherUpdater } from './launcher-update'
import { createGitHubAuthService, type GitHubAuthService } from './github-auth'
import { buildNetworkEnvironment, npmRegistryCandidates, refreshWindowsSystemProxy } from './proxy'
import {
  ensureNodeRuntime,
  ensurePnpmRuntime,
  findSystemNodeRuntime,
  resolveNodeExecutable,
  type NodeRuntime,
  type NodeRuntimeProgress,
  type PnpmRuntime,
} from './node-runtime'
import { createProxyAwareFetch } from './network'
import { packUsesOfficeCliSkills, resolveOfficeCliExecutable } from './officecli-tool'
import { ensureOfficialPackVersion, listOfficialPackVersions, type OfficialPackListDeps } from './official-pack'
import { createPackManager, type InstallInstaller, type PackInstallTarget, type PackManager } from './pack'
import { workbenchRootDir } from './workbench-ipc'
import { migrateToPackHomesV2 } from './pack-migration'
import { EXPORT_USAGE, VERIFY_USAGE, parseExportArgs, runCli } from './pack-verify'
import { EXPORT_PACK_USAGE, parseExportPackArgs, runExportPack, summaryLine, type ExportPackResult } from './pack-export-cli'
import { profileFromCommandLine, processCommandLine } from './instance-probe'
import { readPackRegistry } from './pack-registry'
import { parseWorkbenchArgs, runWorkbench, WORKBENCH_USAGE } from './workbench'
import { createPluginTrialManager, type PluginTrialManager } from './plugin-trial'
import { readPluginReceipts, recordPluginInstall } from './plugin-receipts'
import { approveAllIgnoredBuilds } from './plugin-install'
import { configureProcessTracker, shutdownTrackedProcesses, withExecutableDirectoryOnPath } from './process'
import { createProcessSupervisor, type ProcessSupervisor } from './process-supervisor'
import { readProfile, reorderPlugins, togglePlugin } from './profile'
import { createRecommendedWebUiService, type RecommendedWebUiService } from './recommended-web-ui'
import { consolidatePluginPool, createProfileService, ensureProfileWorkspaceConfig, migrateLegacyPacks, type ProfileService } from './profile-service'
import { installPresetFromDirectory } from './preset-install'
import { installSkillFromDirectory } from './skill-install'
import { createRendererEvents } from './renderer-events'
import { createInstanceManager, type InstanceManager } from './instances'
import { adoptLegacyPackHomes } from './pack-home-migration'
import { createRuntimeController } from './runtime'
import { createRuntimeVersionService, ensureDshVersionInstalled, findManagedDshVersions, type RuntimeVersionService } from './runtime-versions'
import { seedBundledKernels } from './kernel-seed'
import { createSettingsStore, defaultSettings, defaultLauncherPacksRoot, isSameOrInsidePath, packsRootHasPacks, packsRootInsideInstall, decidePacksRootMigration, type SettingsStore } from './settings'
import { isLauncherOwnedHome, type HomeScope } from './home-scope'
import { createTray, type TrayController } from './tray'
import { recoverLegacyCredentials } from './dsh-credentials-compat'

/**
 * 应用入口与装配根。
 * 这里只负责「谁依赖谁」，具体行为都在各自的模块里。
 */

/**
 * 开发态数据隔离（npm run dev）：
 *
 * 打包态的 userData 是 %APPDATA%\dsh-launcher，dev 不换名字就是同一个目录。
 * 那意味着 dev 直接读到用户 settings.json 里的 packsRoot
 *（D:\DSH Pack Launcher\dsh-packs，真实实例全在里面），还会和正在运行的安装版
 * 抢单实例锁：抢不到就 app.quit()，而 vite-plugin-electron 挂了子进程的 exit
 * 监听（startup() 里的 process.electronApp.on('exit', process.exit)），
 * 于是整个 vite dev 一起退出——表现就是「构建成功、后台作业 completed、却没窗口」。
 * 换一个自己的沙箱目录，两边彻底断开。
 */
if (!app.isPackaged) {
  const devUserData = path.join(app.getPath('appData'), `${app.getName()}-dev`)
  // setPath 要求目录已存在，否则直接抛错。
  mkdirSync(devUserData, { recursive: true })
  app.setPath('userData', devUserData)
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
// 窗口图标与托盘图标共用同一资源；dev 取 public/，打包取 dist/。
const launcherIconPath = path.join(moduleDirectory, app.isPackaged ? '../dist/launcher-icon.png' : '../public/launcher-icon.png')

/**
 * 随包运行时的根目录（Node 与 pnpm）。当前**只有开发态生效**：
 * electron-builder 的 extraResources 会无条件剥掉 node_modules，而 npm 就住在
 * `vendor/node/node_modules/npm` 里，所以打包态的 `resources/node` 就算存在也不完整
 * （见 `usableRuntime()` 的 npm 存在性守卫与 scripts/fetch-node-runtime.mts 顶部说明）。
 * 发布版真正带出去的是下面那份归档（zip 内部是 node_modules，打包器不再剥）。
 * 目录不存在时 ensureNodeRuntime / ensurePnpmRuntime 自己会退回托管路径，这里不做存在性判断。
 */
const bundledNodeRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'node')
  : path.resolve(moduleDirectory, '../vendor/node')

const bundledPnpmRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'pnpm')
  : path.resolve(moduleDirectory, '../vendor/pnpm')

/**
 * 随安装包下发的 Node 运行时归档（scripts/build-node-archive.mts 产出
 * `runtime/node-runtime-<版本>-win-<架构>.zip`，打包态的 to 是 extraResources 的
 * 'node-archive'）。目标机没有合格 Node 时才解压到 userData，有就不动它。
 */
const bundledNodeArchiveRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'node-archive')
  : path.resolve(moduleDirectory, '../runtime')

/**
 * 随包下发的 DSH 内核（scripts/bundle-kernel.mts 产出的 runtime/kernels/<ver>/）。
 * 打包态的 to 是 extraResources 的 'kernels'，与 vendor/node 的约定一致。
 */
const bundledKernelsRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'kernels')
  : path.resolve(moduleDirectory, '../runtime/kernels')

let mainWindow: BrowserWindow | null = null
let processSupervisor: ProcessSupervisor | null = null
let quitCleanupStarted = false
let allowFinalQuit = false
// 关闭按钮只隐藏到托盘；before-quit 置位后放行真正的关闭。
let isQuitting = false
let tray: TrayController | null = null
let backgroundNoticeShown = false

const getWindow = (): BrowserWindow | null => mainWindow
const events = createRendererEvents(createRendererChannel(getWindow))

/**
 * 托盘提示与窗口标题共用的那一份状态：实例在不在跑、跑在哪个端口。
 * 数据来自主进程常驻的 3s 探测缓存（emitInstances 一变更就调一次），不另外查任何东西。
 */
function syncShellStatus(instances: InstanceSnapshot[]): void {
  const running = instances.filter(instance => instance.running)
  const summary = running.length === 0
    ? '没有实例在运行'
    : `${running.length} 个实例运行中（${running.map(instance => instance.webPort ?? '-').join(' / ')}）`
  tray?.setSummary(summary)
  const window = getWindow()
  if (window && !window.isDestroyed()) window.setTitle(`DSH 旋律启动器：序曲 · ${summary}`)
}

interface Services {
  settings: SettingsStore
  pluginReceiptsPath: string
  /** 并发实例管理器（对外仍是 RuntimeController 的那五个方法）。 */
  runtime: InstanceManager
  installer: Installer
  pluginTrial: PluginTrialManager
  aiInstaller: AiInstaller
  copilot: CopilotSessionManager
  packManager: PackManager
  launcherUpdater: LauncherUpdater
  githubAuth: GitHubAuthService
  applicationAddons: ApplicationAddonManager
  catalogSync: CatalogSyncService
  dshMarket: DshMarketService
  desktopPlugins: DesktopPluginsService
  recommendedWebUi: RecommendedWebUiService
  runtimeVersions: RuntimeVersionService
  profiles: ProfileService
  profilePoolReady: Promise<void>
  /** 手动恢复官方整合包（整合包页按钮）；失败抛错给渲染层。 */
  restoreOfficialPack: () => Promise<PackInstallResult>
  /** 列出 Release 上所有官方整合包版本（按版本降序）。 */
  listOfficialPackVersions: () => Promise<OfficialPackRelease[]>
  /** 官方整合包状态；`force` = 强制重新查 GitHub，否则用启动核对的缓存。 */
  readOfficialPackStatus: (force?: boolean) => Promise<OfficialPackStatus>
  /** 下载并导入指定版本的官方整合包；失败抛错给渲染层。 */
  installOfficialPackVersion: (version: string) => Promise<PackInstallResult>
}

// app.getPath 依赖 app 就绪，因此服务在 whenReady 之后才装配。
let services: Services | null = null

/**
 * 端口冲突的应答闸门（缺陷 7）。
 *
 * 启动流程在等用户点按钮，而 IPC 是另一条事件；这里用一次性 Promise 桥接：
 * 只有当前那次询问的 resolve 会被调用，过期的应答（用户连点、窗口已换）
 * 一律丢弃，免得把下一次启动的询问提前答掉。
 */
const pendingPortConflicts = new Map<string, (accepted: boolean) => void>()

/**
 * 并发后两个实例可能同时问，所以应答按 packId 配对；
 * 渲染层没带 packId（旧界面）时只在唯一一次询问在等的情况下才认。
 */
function answerPortConflict(accepted: boolean, packId?: string | null): void {
  const key = packId && pendingPortConflicts.has(packId)
    ? packId
    : (pendingPortConflicts.size === 1 ? [...pendingPortConflicts.keys()][0] : null)
  if (!key) {
    for (const resolve of pendingPortConflicts.values()) resolve(false)
    pendingPortConflicts.clear()
    return
  }
  const resolve = pendingPortConflicts.get(key)
  pendingPortConflicts.delete(key)
  resolve?.(accepted)
}

/**
 * 给占用者补一个「疑似所属整合包」：命令行里带 `--profile <x>` 就是最硬的线索
 * （台式实测 `dsh.cmd --profile pack-bili-min --no-open --port 3080`）。
 * 查不到就留空——弹窗照样能问，绝不因为解析失败而不弹。
 */
async function annotateOwners(owners: PortOwner[]): Promise<PortOwner[]> {
  if (owners.length === 0) return owners
  let records: Array<{ id: string; name: string }> = []
  try {
    records = await readPackRegistry(path.join(app.getPath('userData'), 'packs.json'))
  } catch {
    records = []
  }
  return Promise.all(owners.map(async owner => {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return owner
    const commandLine = await processCommandLine(owner.pid)
    const profile = commandLine ? profileFromCommandLine(commandLine) : null
    if (!profile) return owner
    return { ...owner, packName: records.find(record => record.id === profile)?.name ?? profile }
  }))
}

/** 问渲染层要不要结束占用端口的进程；窗口不在（托盘启动）就当拒绝，绝不擅自结束。 */
function askPortConflict(packId: string, owners: PortOwner[], port: number): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false)
  pendingPortConflicts.get(packId)?.(false)
  return new Promise<boolean>(resolve => {
    pendingPortConflicts.set(packId, resolve)
    // 弹窗文案要能指认「是谁占着」：PID + 端口已经有了，这里补疑似整合包。
    void annotateOwners(owners).then(
      enriched => events.portConflict({ port, owners: enriched, packId }),
      () => events.portConflict({ port, owners, packId }),
    )
  })
}

/**
 * 启动器自己的安装目录（打包态 = exe 所在目录）。
 * 用户选了安装盘，数据就该跟着走；开发态没有安装位置，返回 undefined 走 %LOCALAPPDATA% 老路。
 */
function launcherInstallLocation(): string | undefined {
  if (!app.isPackaged) return undefined
  return path.dirname(app.getPath('exe'))
}

/**
 * 新的默认整合包根目录（不含设置里的自定义值）。
 *
 * 实现在 settings.ts 的 defaultLauncherPacksRoot 里：defaultSettings 和启动序列
 * 必须算同一个默认值，两处各抄一份迟早会漂移（第八项）。
 */
function defaultPacksRoot(userData: string): string {
  return defaultLauncherPacksRoot(userData)
}

/**
 * 缺省整合包根目录：跟着启动器走（<安装目录>\dsh-packs，在安装目录**内部**），
 * 没有安装位置（开发态）才退回 %LOCALAPPDATA%\dsh-launcher\dsh-packs。
 */
function nextPacksRoot(userData: string): string {
  const installLocation = launcherInstallLocation()
  return installLocation ? packsRootInsideInstall(installLocation) : defaultPacksRoot(userData)
}

/**
 * 1.0.3 之前的旧默认位置：安装目录的**兄弟**目录 <安装目录的父目录>\dsh-packs。
 *
 * 只用于 resolvePacksRoot 的兼容回落：老版本把包放在安装目录隔壁，
 * 新位置还没有包时必须继续认老位置，不能让人升级后看不见自己的包。
 */
function legacyPacksRootBesideInstall(): string | null {
  const installLocation = launcherInstallLocation()
  return installLocation ? path.join(path.dirname(installLocation), 'dsh-packs') : null
}

/**
 * 升级兼容：新位置还没有、老位置已经有了，就继续用老的
 * （老位置指 %LOCALAPPDATA%\dsh-launcher\dsh-packs，更早的是 userData\dsh-packs）。
 * 升级后不能让人看不见自己的包。
 */
function resolvePacksRoot(userData: string): string {
  const next = nextPacksRoot(userData)
  if (existsSync(next)) return next
  const besideInstall = legacyPacksRootBesideInstall()
  for (const legacy of [defaultPacksRoot(userData), path.join(userData, 'dsh-packs'), besideInstall]) {
    if (legacy && legacy !== next && existsSync(legacy)) return legacy
  }
  return next
}

/** 读 settings.json 里存着的 packsRoot（没配过/文件坏了返回 null）。 */
async function storedPacksRoot(userData: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) as { packsRoot?: unknown }
    if (typeof raw.packsRoot === 'string' && path.isAbsolute(raw.packsRoot)) return raw.packsRoot
  } catch {
    // 没配过或文件坏了：走默认解析。
  }
  return null
}

/**
 * 旧默认位置列表：stored 命中其中之一，才说明它是历史默认值而不是用户自己选的目录。
 * 与 resolvePacksRoot 的兼容回落共用同一份来源，免得两处各写一套旧路径。
 *
 * 三个候选必须和 resolvePacksRoot 的回落列表一字不差，否则会出现
 * 「启动时认老位置、迁移却把 stored 改走」的自相矛盾。
 */
function legacyPacksRootDefaults(userData: string): string[] {
  return [
    defaultPacksRoot(userData),
    path.join(userData, 'dsh-packs'),
    legacyPacksRootBesideInstall(),
  ].filter((candidate): candidate is string => !!candidate)
}

/**
 * 一次性迁移：stored 还停在某个旧默认位置（%LOCALAPPDATA%\dsh-launcher\dsh-packs、<userData>\dsh-packs、
 * 或更早的安装目录兄弟目录 <安装目录父目录>\dsh-packs）、新默认位置（<安装目录>\dsh-packs）又变了、
 * 且三个旧位置里都没有真实整合包 —— 就把 settings 里的 packsRoot 改到新位置。
 *
 * 背景：装到 D 盘的用户 settings.json 里写死了 C 盘旧默认值，mergeStoredSettings 的 stored 优先
 * 会让「新默认跟安装盘走」对他完全不生效，于是目录还在 C 盘。这里做一次性修正。
 *
 * 幂等靠判定条件本身：改写成功后 stored 就是新位置，下次启动条件 2 不成立。
 * 失败只记日志、继续用旧值，绝不阻塞启动。
 */
async function migrateStoredPacksRoot(userData: string): Promise<void> {
  if (!app.isPackaged) return
  const installLocation = launcherInstallLocation()
  if (!installLocation) return
  const stored = await storedPacksRoot(userData)
  if (!stored) return
  const legacyCandidates = legacyPacksRootDefaults(userData)
  // 三个旧位置任意一个有真包都不许迁：只查 stored 一个的话，包在兄弟目录
  // （<安装目录父目录>\dsh-packs）的老用户会被改成新位置，启动后看不见自己的包。
  const legacyHasPacks = (await Promise.all(legacyCandidates.map(root => packsRootHasPacks(root)))).some(Boolean)
  const plan = decidePacksRootMigration({
    stored,
    legacyCandidates,
    next: packsRootInsideInstall(installLocation),
    legacyHasPacks,
  })
  if (!plan.migrate) return
  try {
    const store = createSettingsStore({
      filePath: path.join(userData, 'settings.json'),
      createDefaults: () => defaultSettings({
        dshHomeFromEnvironment: process.env.DSH_HOME,
        homeDirectory: os.homedir(),
        documentsDirectory: app.getPath('documents'),
        systemNpx: findSystemNodeRuntime()?.npx,
        dshInstallPath: path.join(userData, 'dsh-runtime'),
        installLocation,
        packsRoot: plan.target,
        userDataPath: userData,
      }),
      detectInstalledDsh: current => findInstalledDsh({
        managedRoot: current.dshInstallPath,
        configuredExecutable: current.launchExecutable,
      }),
    })
    const current = await store.readStored()
    await store.save({ ...current, packsRoot: plan.target })
    console.log(`[packsRoot] 整合包目录已迁移：${stored} → ${plan.target}（原值是旧默认位置且旧目录里没有整合包，新默认位置跟随安装目录）。`)
  } catch (error) {
    console.error(`[packsRoot] 整合包目录迁移失败，继续使用旧位置 ${stored}。`, error)
  }
}

/**
 * 启动时定下真正的 packsRoot：用户在设置里指定过就用他的值，
 * 否则按「新默认 → 旧位置兼容」解析。
 * pack.ts 只在建服务时求值一次，所以运行中改目录要重启启动器才生效。
 */
async function startupPacksRoot(userData: string): Promise<string> {
  const stored = await storedPacksRoot(userData)
  if (stored) return stored
  return resolvePacksRoot(userData)
}

function createServices(initialPacksRoot: string): Services {
  const userData = app.getPath('userData')
  const managedDshRoot = path.join(userData, 'dsh-runtime')
  const managedNodeRoot = path.join(userData, 'node-runtime')
  const managedPnpmRoot = path.join(userData, 'pnpm-runtime')
  const pluginSourceRoot = path.join(userData, 'plugin-sources')
  const pluginReceiptsPath = path.join(userData, 'plugin-installs.json')
  const presetReceiptsPath = path.join(userData, 'preset-installs.json')
  const skillReceiptsPath = path.join(userData, 'skill-installs.json')
  const skillSourceRoot = path.join(userData, 'skill-sources')
  const applicationRoot = path.join(userData, 'application-addons')
  const packsJsonPath = path.join(userData, 'packs.json')
  // 整合包根目录由启动前的 startupPacksRoot() 定下（设置里的自定义值优先，
  // 否则跟着安装盘走：<安装目录父级>\dsh-packs，旧位置已有包时继续用旧位置）。
  const packsRoot = initialPacksRoot
  // 机器级外部工具（officecli 等）的托管根目录：跨整合包共享，不随快照进包。
  const officeCliToolsRoot = path.join(userData, 'dsh-tools')
  const proxyAwareFetch = createProxyAwareFetch((input, init) => net.fetch(input, init))
  const githubAuth = createGitHubAuthService({
    filePath: path.join(userData, 'github-auth.bin'),
    clientId: process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID,
    fetchImpl: proxyAwareFetch,
    cipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    },
  })
  const catalogSync = createCatalogSyncService({
    fetchImpl: githubAuth.fetch,
    getAuthStatus: () => githubAuth.getStatus(),
    pendingDir: path.join(userData, 'catalog', 'pending'),
    onFlush: result => events.output('plugin', result.submitted > 0 ? 'success' : 'error', result.message),
  })

  let settings: SettingsStore

  /**
   * 准备 Node.js 运行环境，并把下载进度写进日志。
   * 进度每跨越 10% 记一条，避免刷屏。
   */
  const prepareNodeRuntime = (
    source: RuntimeOutput['channel'],
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<NodeRuntime> => {
    let lastBucket = -1
    return settings.read().then(currentSettings => ensureNodeRuntime(managedNodeRoot, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, currentSettings.nodeVersion, (level, text) => events.output(source, level, text), {
      bundledRoot: bundledNodeRoot,
      archiveRoot: bundledNodeArchiveRoot,
      // 归档里同时带着 pnpm：解 Node 时顺手铺开，首启就不用再联网装一次。
      pnpmRuntimeRoot: managedPnpmRoot,
    }))
  }

  const preparePnpmRuntime = (
    source: RuntimeOutput['channel'],
    nodeRuntime: NodeRuntime,
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<PnpmRuntime> => {
    let lastBucket = -1
    // 镜像候选来自用户设置；只有没命中随包/已装、真要联网装 pnpm 时才会用到它。
    return settings.read().then(currentSettings => ensurePnpmRuntime(managedPnpmRoot, nodeRuntime, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, (level, text) => events.output(source, level, text), {
      bundledRoot: bundledPnpmRoot,
      registryCandidates: npmRegistryCandidates(buildNetworkEnvironment(currentSettings).npmRegistry),
    }))
  }

  /**
   * 启动前准备 officecli：包里有 officecli 技能才动；下载进度既写日志
   * （runtime 通道，由控制器输出）也进整合包活动横幅（packActivity，5% 分桶节流），
   * 结束（成功或失败）清空横幅。永不抛异常。
   */
  const prepareOfficeCliTool = async (
    current: AppSettings,
    onProgress: (received: number, total: number | null) => void,
  ): Promise<string | null> => {
    let bannerShown = false
    let lastPercent = -1
    try {
      if (!(await packUsesOfficeCliSkills(current.dshHome))) return null
      return await resolveOfficeCliExecutable(current.dshHome, officeCliToolsRoot, {
        mirror: current.network?.githubMirror,
        fetchImpl: proxyAwareFetch,
        onProgress: (received, total) => {
          onProgress(received, total)
          const percent = total && total > 0 ? Math.floor((received / total) * 100) : -1
          if (percent !== lastPercent) {
            lastPercent = percent
            bannerShown = true
            events.packProgress({ kind: 'status', message: `正在准备 Office 工具（首次约 33MB）${percent >= 0 ? `：${percent}%` : ''}…` })
          }
        },
      })
    } catch {
      return null
    } finally {
      if (bannerShown) events.packProgress({ kind: 'status', message: '' })
    }
  }

  settings = createSettingsStore({
    filePath: path.join(userData, 'settings.json'),
    createDefaults: () => defaultSettings({
      // 开发态不认继承来的 DSH_HOME：从 DSH 内核或终端里起 npm run dev 时，
      // 这份环境变量指着用户的真实实例（实测 = D:\DSH Pack Launcher\dsh-packs\dsh-origin-3080），
      // 缺省家目录会直接落在真实目录里。打包态维持原行为。
      dshHomeFromEnvironment: app.isPackaged ? process.env.DSH_HOME : undefined,
      homeDirectory: os.homedir(),
      documentsDirectory: app.getPath('documents'),
      systemNpx: findSystemNodeRuntime()?.npx,
      dshInstallPath: managedDshRoot,
      // 缺省整合包根目录跟安装盘走：与 startupPacksRoot 的 nextPacksRoot 同一实现。
      installLocation: launcherInstallLocation(),
      packsRoot,
      // 认领边界（缺陷 1）：缺省家目录必须落在启动器私有目录里。
      // 双击启动的进程环境没有 DSH_HOME，缺省指向 ~/.dsh 等于首启就改写用户真实环境。
      userDataPath: userData,
    }),
    detectInstalledDsh: (settings: AppSettings) => findInstalledDsh({
      managedRoot: settings.dshInstallPath,
      configuredExecutable: settings.launchExecutable,
    }),
    // 整合包真隔离的咽喉点：read() 返回的 dshHome 即激活包的私有家目录（缺省 = 默认家目录）。
    resolvePackHome: async current => {
      if (!current.activePackId) return null
      const records = await readPackRegistry(packsJsonPath)
      return records.find(record => record.id === current.activePackId)?.homePath ?? null
    },
  })

  let applicationAddons: ApplicationAddonManager
  let installer: Installer
  // 并发关键：不再是一个全局 RuntimeController，而是「每包一个控制器 + 按包设置覆盖层」。
  // 家目录 / profile / 端口 / 内核 / bili 状态目录都由 instances.ts 按 packId 算，
  // 生命周期逻辑仍复用 createRuntimeController，一行没改。
  const runtime: InstanceManager = createInstanceManager({
    tablePath: path.join(userData, 'instances.json'),
    instanceRoot: packId => path.join(userData, 'instances', packId),
    registryPath: packsJsonPath,
    readSettings: () => settings.read(),
    emitOutput: (_packId, level, text) => events.output('runtime', level, text),
    emitState: state => events.runtimeState(state),
    // 托盘与窗口标题读的是同一份状态快照（3s 探测出来的），界面里那份也是它。
    emitInstances: instances => {
      events.instancesChanged(instances)
      syncShellStatus(instances)
    },
    resolvePortConflict: (packId, owners, port) => askPortConflict(packId, owners, port),
    // 实例起来之后才切「当前整合包」指针：packs:activate 在任一实例运行时被锁（全局包写守卫），
    // 而实例层的家目录/端口/内核都按 packId 现算，所以这里只写指针，不重启任何东西。
    activatePack: async packId => {
      const base = await settings.readStored()
      await settings.save({ ...base, activePackId: packId, profileName: packId })
    },
    createController: deps => createRuntimeController({
      readSettings: deps.readSettings,
      prepareNodeRuntime: () => prepareNodeRuntime('runtime'),
      fallbackWorkspace: () => app.getPath('documents'),
      emitOutput: deps.emitOutput,
      emitState: deps.emitState,
      extraEnvironment: deps.extraEnvironment,
      // 启动后自动开浏览器只是副动作：失败时首页还有「打开网页 / 复制链接」这条路，
      // 但绝不能把 rejection 静默吞掉（日志里留一行，别让进程扛一个 unhandled rejection）。
      openExternal: url => {
        void shell.openExternal(url).catch(error => {
          events.output('runtime', 'error', `打不开浏览器：${error instanceof Error ? error.message : String(error)}`)
        })
      },
      resolveApplicationLaunchPlan: () => applicationAddons.launchPlan(),
      legacyCredentialsBackupRoot: path.join(userData, 'dsh-credentials-compat'),
      // 非法凭据引用名的原始备份。目录必须独立于上面那个：开机时的旧格式恢复会把
      // dsh-credentials-compat 里的记录逐条覆盖回目标文件，混在一起会把改名结果冲掉。
      credentialsRefRepairRoot: path.join(userData, 'dsh-credentials-ref-repair'),
      packageStoreRoot: path.join(userData, 'plugin-store'),
      prepareOfficeCliTool,
      // 缺陷 2：随包内核在 whenReady 里才释放，设置里那一次绑定可能早于它，
      // 所以拉起进程前必须再探一次；探不到就显式报「没有可用内核」，不退 npx。
      detectInstalledDsh: current => findInstalledDsh({
        managedRoot: current.dshInstallPath,
        configuredExecutable: current.launchExecutable,
      }),
      // 端口被占时先看占位者是不是我们自己的实例，是就自愈，不必每次都弹窗。
      trackedPids: deps.trackedPids,
      resolvePortConflict: deps.resolvePortConflict,
      // 解耦：实例输出落在自己包里的 logs\，进程不登记给监督器，启动器退出照常运行。
      detachedLogDir: deps.detachedLogDir,
    }),
  })
  // 修 2：旧包（packs.json 里没有 homePath 的那些）在启动时补一个独立家目录。
  // 后端搬迁可能是跨盘复制（几个 GB），所以**不阻塞窗口**：describe() 每轮探测都重读注册表，
  // 搬完的下一轮（≤3s）界面就有那一行了。失败只记日志，绝不挡启动。
  void (async () => {
    try {
      // 必须用 readStored() 的 dshHome：read() 返回的是派生值，激活包有自己的家目录时
      // 它指向那个包的私有目录，拿它去补 web 等于把 pack-bili-min 的环境整个搬走。
      const stored = await settings.readStored()
      const migrated = await adoptLegacyPackHomes({
        registryPath: packsJsonPath,
        packsRoot,
        sharedHome: stored.dshHome,
        activePackId: stored.activePackId ?? null,
        log: message => console.log(`[pack-home] ${message}`),
      })
      if (migrated.moved.length > 0) void runtime.refreshSnapshots().catch(() => undefined)
    } catch (error) {
      console.error('[pack-home] 旧包家目录补齐失败，继续共用旧目录。', error)
    }
  })()
  const profileService = createProfileService({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    packBodiesRoot: () => settings.read().then(value => path.join(value.dshHome, '.dsh-launcher-pack-bodies')),
    isRuntimeRunning: () => runtime.isRunning(),
    fillMissingDependencies: async (profileName, missing) => {
      const current = await settings.read()
      const receipts = await readPluginReceipts(pluginReceiptsPath)
      const pluginStoreRoot = path.join(userData, 'plugin-store')
      const profileRoot = path.join(current.dshHome, 'profiles')
      const targetProfileDir = path.join(profileRoot, profileName)
      // A link-only repair must never auto-install DSH peer packages from npm.
      // Normalize legacy/imported Profiles before invoking pnpm so unpublished
      // preview peers remain supplied by the selected DSH runtime.
      await ensureProfileWorkspaceConfig(targetProfileDir)

      // Legacy/imported Profiles can contain only `*` dependency ranges even
      // though another Profile already has the exact local source. Reuse that
      // source before asking pnpm for offline registry metadata; this preserves
      // one physical plugin body while keeping each Profile's link layer and
      // activation order independent.
      const sourceSpecs = new Map<string, string>()
      const siblingEntries = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
      for (const sibling of siblingEntries) {
        if (!sibling.isDirectory() || sibling.name === profileName) continue
        const siblingManifestPath = path.join(profileRoot, sibling.name, 'package.json')
        let siblingManifest: { dependencies?: Record<string, unknown> } | null = null
        try {
          siblingManifest = JSON.parse(await readFile(siblingManifestPath, 'utf8')) as { dependencies?: Record<string, unknown> }
        } catch {
          continue
        }
        for (const packageName of missing) {
          if (sourceSpecs.has(packageName)) continue
          const candidate = siblingManifest.dependencies?.[packageName]
          if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.trim() === '*') continue
          if (candidate.startsWith('file:')) {
            const rawPath = candidate.slice('file:'.length)
            const sourcePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(siblingManifestPath), rawPath)
            try {
              const sourceManifest = JSON.parse(await readFile(path.join(sourcePath, 'package.json'), 'utf8')) as { version?: unknown }
              const version = typeof sourceManifest.version === 'string' && sourceManifest.version.trim()
                ? sourceManifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
                : 'local'
              const sharedSource = path.join(current.dshHome, '.dsh-launcher-plugin-bodies', ...packageName.split('/'), version)
              if (path.resolve(sourcePath) !== path.resolve(sharedSource)) {
                await mkdir(path.dirname(sharedSource), { recursive: true })
                try {
                  await readFile(path.join(sharedSource, 'package.json'), 'utf8')
                } catch {
                  await cp(sourcePath, sharedSource, { recursive: true })
                }
              }
              sourceSpecs.set(packageName, `file:${sharedSource}`)
            } catch {
              // Stale file references are not reusable sources.
            }
          } else if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.trim())) {
            sourceSpecs.set(packageName, candidate.trim())
          }
        }
      }

      if (sourceSpecs.size > 0) {
        const targetManifestPath = path.join(targetProfileDir, 'package.json')
        try {
          const targetManifest = JSON.parse(await readFile(targetManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
          const dependencies = { ...(targetManifest.dependencies ?? {}) }
          const repaired: string[] = []
          for (const packageName of missing) {
            const currentSpec = dependencies[packageName]
            const sourceSpec = sourceSpecs.get(packageName)
            if (!sourceSpec || (currentSpec && currentSpec !== '*' && !/[<>=*^~]/.test(currentSpec))) continue
            dependencies[packageName] = sourceSpec
            repaired.push(`${packageName} → ${sourceSpec}`)
          }
          if (repaired.length > 0) {
            await writeFile(targetManifestPath, `${JSON.stringify({ ...targetManifest, dependencies }, null, 2)}\n`, 'utf8')
            events.output('plugin', 'info', `已从其他整合包复用 ${repaired.length} 个插件来源：${repaired.join('、')}`)
          }
        } catch {
          // The subsequent pnpm command reports a precise manifest error.
        }
      }

      let offlineNode: NodeRuntime | null = null
      let offlinePnpm: PnpmRuntime | null = null
      let offlineInstallAttempted = false
      for (const packageName of missing) {
        const receipt = receipts.find(item => item.packId === profileName && item.packageName === packageName)
        if (!receipt) {
          // A cloned/imported Profile may have no launcher receipt while its
          // exact package is already present in the shared pnpm store. Try an
          // offline link-only install before asking the user to source it.
          if (!offlineInstallAttempted) {
            offlineInstallAttempted = true
            offlineNode ??= await prepareNodeRuntime('plugin')
            offlinePnpm ??= await preparePnpmRuntime('plugin', offlineNode)
            await syncProfilePnpmConfig(targetProfileDir, buildNetworkEnvironment(current).npmRegistry, pluginStoreRoot)
            const result = await runCommand(offlinePnpm.executable, ['install', '--dir', targetProfileDir, '--offline', '--no-frozen-lockfile', '--config.auto-install-peers=false', '--store-dir', pluginStoreRoot], {
              cwd: targetProfileDir,
              env: withExecutableDirectoryOnPath(offlinePnpm.executable, withExecutableDirectoryOnPath(offlineNode.node, {
                ...process.env,
                DSH_HOME: current.dshHome,
                npm_config_store_dir: pluginStoreRoot,
                NPM_CONFIG_STORE_DIR: pluginStoreRoot,
                pnpm_config_store_dir: pluginStoreRoot,
                PNPM_CONFIG_STORE_DIR: pluginStoreRoot,
                CI: 'true',
              })),
              onOutput: (text, level) => events.output('plugin', level, text),
            })
            if (result.exitCode !== 0) throw new Error(`插件「${packageName}」无法从共享插件池补齐，请检查来源记录。`)
          }
          continue
        }
        const repository = receipt.repository.match(/^(?:https?:\/\/github\.com\/|github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1]
        if (receipt.source === 'npm') {
          await installer.installNpmPackage({ packageName, version: receipt.version ?? undefined }, profileName)
        } else if (repository) {
          await installer.installPluginTarget({
            repository,
            defaultBranch: receipt.defaultBranch ?? 'main',
            targetId: receipt.targetId ?? `${packageName}:.`,
            ...(receipt.commit ? { commit: receipt.commit } : {}),
          }, profileName)
        } else {
          throw new Error(`插件「${packageName}」的来源记录无效，无法自动补齐。`)
        }
      }
      // Keep the selected DSH home/profile invariant explicit for future
      // installers that consult settings while repairing links.
      if (current.dshHome !== (await settings.read()).dshHome) throw new Error('DSH_HOME 在补齐依赖期间发生变化。')
    },
  })

  /** 整合包导入期间补装 DSH 运行时：把安装进度接力到整合包页的进度条（见上面的 emitProgress）。 */
  let relayDshProgressToPack = false

  const runtimeVersions = createRuntimeVersionService({
    dshRoot: managedDshRoot,
    nodeRoot: managedNodeRoot,
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    isRuntimeRunning: () => runtime.isRunning(),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => {
      events.installProgress(progress)
      // 整合包导入过程中会先补装缺失的 DSH 运行时（约 100MB），那段时间整合包页只有一条死进度条；
      // 把这一段并进 packProgress，用户在包页也能看到「正在准备 DSH x.y.z · 45%」。
      if (relayDshProgressToPack && progress.kind === 'dsh') {
        events.packProgress({ kind: 'stage', label: progress.message, percent: progress.percent })
      }
    },
    githubFetch: githubAuth.fetch,
    // 装一个 DSH 版本只下载版本本体；整合包仅由「新建 / 导入」产生。
  })

  applicationAddons = createApplicationAddonManager({
    registryPath: path.join(userData, 'application-addons.json'),
    installRoot: applicationRoot,
    readSettings: () => settings.read(),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning(),
    githubFetch: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
  })

  installer = createInstaller({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    pluginSourceRoot,
    pluginReceiptsPath,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    presetReceiptsPath,
    skillReceiptsPath,
    skillSourceRoot,
    skillMarketCachePath: path.join(userData, 'skill-market-cache.json'),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning(),
    githubFetch: githubAuth.fetch,
  })

  // 官方推荐整合包（DSH Web UI 全家桶）：用 installer 装 latest，
  // 避免依赖市场目录与 git 子路径回退。
  const recommendedWebUi = createRecommendedWebUiService({
    readSettings: () => settings.read(),
    installer,
  })

  // This service deliberately does not use the unified resource-market
  // analyzers or installers. It mirrors dsh-market's curated registry and
  // package command rules behind a separate API surface.
  const dshMarket = createDshMarketService({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: node => preparePnpmRuntime('plugin', node),
    fetchImpl: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    cachePath: path.join(userData, 'dsh-market-cache.json'),
    emitProgress: progress => events.dshMarketProgress(progress),
    emitOutput: (level, text) => events.output('plugin', level, text),
  })

  // 官方桌面端的插件管理：独立一条链路，走它自带的 dsh 命令，不碰 installer/dsh-market
  // 那套（那些会往 profile 里写 store-dir 与我们的收据）。家目录用未派生的 readStored，
  // 因为桌面端永远住在默认家目录，不跟着激活包漂移。
  const desktopPlugins = createDesktopPluginsService({
    readStoredSettings: () => settings.readStored(),
    emitOutput: (level, text) => events.output('plugin', level, text),
    journalRoot: path.join(userData, 'desktop-mirror-backups'),
  })

  const pluginTrial = createPluginTrialManager({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('plugin', nodeRuntime),
    trialRoot: path.join(userData, 'plugin-trials'),
    resultsPath: path.join(userData, 'plugin-trial-results.json'),
    emitOutput: (level, text) => events.output('test', level, text),
    emitResult: result => events.pluginTrial(result),
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    // 试运行端口要绕开每个包自己登记的那一格，否则会抢走别的包「留着自己用」的端口。
    reservedPorts: () => runtime.assignedPorts(),
  })

  let packManager: PackManager | null = null
  const copilot = createCopilotSessionManager({
    filePath: path.join(userData, 'copilot-sessions.json'),
    runtimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    readSettings: () => settings.read(),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    resolveAgentApi: dshHome => resolveCopilotAgentApi(dshHome),
    resolveAgentApiForModel: (dshHome, provider, model) => resolveAgentApiForModel(dshHome, provider, model),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    emitEvent: event => events.aiSessionEvent(event),
    emitOutput: (level, text) => events.output('ai', level, text),
    mutationBlockReason: () => {
      if (runtime.isRunning()) return '请先停止 DSH 运行时'
      if (installer.isBusy()) return '资源安装正在进行'
      if (pluginTrial.isBusy()) return '插件试运行正在进行'
      if (applicationAddons.isBusy()) return '应用加载项操作正在进行'
      if (dshMarket.isBusy()) return 'DSH Market 操作正在进行'
      if (desktopPlugins.isBusy()) return '官方桌面端插件操作正在进行'
      if (packManager?.isBusy()) return '整合包操作正在进行'
      return null
    },
  })

  const aiInstaller = createAiInstaller({
    readSettings: () => settings.read(),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    acpRuntimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    emitOutput: (level, text) => events.output('ai', level, text),
    emitEvent: event => {
      events.aiInstallEvent(event)
      void copilot.updateLegacy(event)
    },
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    analyzePlugin: (repository, defaultBranch) => installer.analyzePlugin(repository, defaultBranch),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    githubFetch: githubAuth.fetch,
  })

  /**
   * 整合包离线导入（zip 内的 plugin-bodies）用 `file:` specifier 安装。
   * 真实 installer 的 installPluginTarget 只接受 GitHub 仓库分析，无法直接
   * 安装本地目录，因此这里在组装层用 DSH CLI 插件命令补上最小通路。
   */
  async function installPackLocalDirectory(target: PackInstallTarget): Promise<void> {
    const originalDirectory = validateLocalPluginDirectory(target.localDirectory)
    // Windows 下 pnpm 的 `file:` spec 无法解析含空格/非 ASCII 的路径（spec 会在空格处被
    // 截断，pnpm 报 ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER）。用户主目录常含空格
    // （如 C:\Users\Miyazawa i\…），因此先把本体复制到盘根的无空格 staging 目录再安装；
    // pnpm 会把内容硬链接进其 store，staging 装完即删，不影响已安装插件。
    const needsStaging = process.platform === 'win32' && /[\s\u00A0]/.test(originalDirectory)
    const installDirectory = needsStaging ? await stageBodyForPnpm(originalDirectory) : originalDirectory
    const current = await settings.read()
    const nodeRuntime = await prepareNodeRuntime('plugin')
    const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
    const executable = resolveNodeExecutable(current.launchExecutable, nodeRuntime)
    const commandArgs = buildPluginCommandArgs(current, executable, ['add', `file:${installDirectory.replace(/\\/g, '/')}`], target.profileName)
    const environment = withExecutableDirectoryOnPath(
      pnpmRuntime.executable,
      withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        DSH_HOME: current.dshHome,
        // CI 模式让 pnpm 用 append-only reporter：无 TTY 时也实时输出解析/下载进度行，
        // 否则导入对话框的日志区在拉取依赖的几分钟里看起来像卡死。
        CI: 'true',
        npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
        NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
        pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
        PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
        FORCE_COLOR: '0',
      }),
    )
    const onOutput = (text: string, level: string) => events.output('plugin', level as 'error' | 'info' | 'success', text)
    // pnpm 的输出走插件日志通道，导入对话框看不到；这里把关键进度行节流转发进
    // packProgress 流，让对话框日志区在拉取依赖的几分钟里持续有新内容。
    let lastRelayAt = 0
    const relayToDialog = (line: string) => {
      const now = Date.now()
      if (now - lastRelayAt < 4000) return
      lastRelayAt = now
      const trimmed = line.trim().slice(0, 160)
      if (trimmed) events.packProgress({ kind: 'status', message: trimmed })
    }
    const onInstallOutput = (text: string, level: string) => {
      onOutput(text, level)
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('Progress:') || line.includes('Done in') || line.includes('ERR_PNPM')) relayToDialog(line)
      }
    }
    const runAdd = () => runCommand(executable, commandArgs, {
      cwd: current.workspace,
      env: environment,
      onOutput: onInstallOutput,
    })
    try {
      events.packProgress({ kind: 'status', message: '离线本体安装：该包未内置依赖，正在联网拉取（约几分钟）。用新版启动器重新导出，即可把依赖打进包内实现免联网安装。' })
      let result = await runAdd()
      // pnpm 默认拒绝依赖里的构建脚本（cloudflared/node-pty 等）并以非零码退出。
      // 与官方安装链路一致：批准被忽略的构建后自动重试一次。
      if (result.exitCode !== 0 && result.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
        const workspacePath = path.join(current.dshHome, 'profiles', target.profileName, 'pnpm-workspace.yaml')
        const approved = await approveAllIgnoredBuilds(workspacePath, result.output)
        if (approved.length > 0) {
          onOutput(`已允许 ${approved.length} 个被忽略的构建脚本，正在自动重试。`, 'info')
          result = await runAdd()
        }
      }
      if (result.exitCode !== 0) throw new Error(`插件安装失败（代码 ${result.exitCode}），请查看运行日志。`)
    } finally {
      // staging 目录用完即删（成功或失败都清），避免在盘根留垃圾。
      if (installDirectory !== originalDirectory) {
        await rm(installDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    let version: string | null = null
    try {
      const packageManifest = JSON.parse(await readFile(path.join(originalDirectory, 'package.json'), 'utf8')) as { version?: unknown }
      version = typeof packageManifest.version === 'string' ? packageManifest.version : null
    } catch {
      // 版本读取失败可忽略，receipt 的 version 允许为 null。
    }
    await recordPluginInstall(pluginReceiptsPath, {
      repository: `file:${originalDirectory}`,
      packageName: target.packageName,
      packId: target.profileName,
      source: 'local-directory',
      subdirectory: null,
      version,
      commit: '',
      installedAt: new Date().toISOString(),
    })
  }

  /** 在系统盘根的无空格目录下建唯一 staging 目录，把离线本体复制进去，返回其路径。 */
  async function stageBodyForPnpm(sourceDirectory: string): Promise<string> {
    const systemRoot = path.parse(process.env.windir ?? 'C:\\Windows').root || 'C:\\'
    const stagingRoot = path.join(systemRoot, 'dsh-import-bodies')
    await mkdir(stagingRoot, { recursive: true })
    const destination = await mkdtemp(path.join(stagingRoot, 'body-'))
    await cp(sourceDirectory, destination, { recursive: true })
    return destination
  }

  const packInstaller: InstallInstaller = {
    async installPluginTarget(target) {
      if (target.source === 'local-directory') {
        await installPackLocalDirectory(target)
        return
      }
      if (!target.repository) throw new Error('缺少来源仓库，无法安装。')
      // 真实 installer 按 analysis.targets 的 id 定位，id 形如 `<packageName>:<subdir|.>`。
      const targetId = target.subdirectory ? `${target.packageName}:${target.subdirectory}` : `${target.packageName}:.`
      const request: {
        repository: string
        defaultBranch: string
        targetId: string
        commit?: string
        version?: string
      } = { repository: target.repository, defaultBranch: 'main', targetId }
      // 转发整合包声明的 pin：github 用固定 commit，npm 用固定 version（0.0.0 是占位符，不转发）。
      if (target.source === 'github' && target.commit) request.commit = target.commit
      if (target.source === 'npm' && target.version && target.version !== '0.0.0') request.version = target.version
      await installer.installPluginTarget(request, target.profileName)
    },
    installNpmPackage: (request, profileOverride) => installer.installNpmPackage(request, profileOverride),
    remove: (packageName, profileName) => installer.remove(packageName, profileName),
    readProfile: (dshHome, profileName) => readProfile(dshHome, profileName, pluginReceiptsPath),
    togglePlugin: (dshHome, profileName, packageName, enabled) => togglePlugin(dshHome, profileName, packageName, enabled, pluginReceiptsPath),
    reorderPlugins: (dshHome, profileName, packageNames) => reorderPlugins(dshHome, profileName, packageNames, pluginReceiptsPath),
    // raw 整合包导入的技能：从本地 staging 目录全局安装（bundle 目录或 flat 单文件）。
    installSkillLocal: (dshHome, skill) => installSkillFromDirectory(dshHome, skill.name, skill.format, skill.sourceDir),
    installSkill: request => installer.installSkill(request),
    installSkillPinned: request => installer.installSkillPinned(request),
    toggleSkill: (name, enabled) => installer.toggleSkill(name, enabled),
    installPreset: request => installer.installPreset(request),
    installPresetLocal: (dshHome, preset) => installPresetFromDirectory(dshHome, preset.name, preset.sourceDir),
    togglePreset: (name, enabled) => installer.togglePreset(name, enabled),
  }

  packManager = createPackManager({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    registryPath: packsJsonPath,
    manifestRoot: path.join(userData, 'pack-manifests'),
    snapshotRoot: path.join(userData, 'pack-snapshots'),
    pluginReceiptsPath,
    presetReceiptsPath,
    skillReceiptsPath,
    installer: packInstaller,
    applicationAddons,
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitEvent: event => events.packProgress(event),
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    // 删除只看「这一个包自己是否在跑」：InstanceManager 按 packId 有控制器与端口探测；
    // 真在跑就先停（stopPack 等停止完成），再删家目录。
    isPackRunning: packId => runtime.isPackRunning(packId),
    stopPack: async packId => { await runtime.stopPack(packId) },
    unifiedProfiles: true,
    packsRoot,
    readStoredSettings: () => settings.readStored(),
    ensureDshVersionInstalled: async version => {
      const current = await settings.read()
      const installed = await findManagedDshVersions(current.dshInstallPath)
      if (installed.some(item => item.version === version)) return
      // 导入过程中补装运行时：先给一条明确的阶段提示，再把安装进度接力到整合包页。
      events.packProgress({ kind: 'stage', label: `正在准备 DSH ${version}（本机未安装，需要先下载运行时）`, percent: null })
      relayDshProgressToPack = true
      try {
        await ensureDshVersionInstalled(installed, next => runtimeVersions.installDsh(next), version)
      } catch (error) {
        // 补装失败就根本不会走到导入，也就没有后续事件来收掉上面那条阶段横幅；自己收口。
        events.packProgress({ kind: 'status', message: '' })
        throw error
      } finally {
        relayDshProgressToPack = false
      }
    },
    selectDshVersion: async version => {
      await runtimeVersions.selectDsh(version)
    },
    getNodeExecutable: async () => {
      try {
        return (await prepareNodeRuntime('plugin')).node
      } catch {
        return null
      }
    },
    offlinePackInstall: async ({ tarballDir, profileDir, onOutput }) => {
      const current = await settings.read()
      const nodeRuntime = await prepareNodeRuntime('plugin')
      const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
      const environment = withExecutableDirectoryOnPath(
        pnpmRuntime.executable,
        withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          DSH_HOME: current.dshHome,
          npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
          NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
          pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
          PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
          CI: 'true',
          FORCE_COLOR: '0',
        }),
      )
      const entries = (await readdir(tarballDir)).filter(file => file.endsWith('.tgz')).sort()
      if (entries.length === 0) throw new Error('离线包内没有依赖 tarball。')
      for (let index = 0; index < entries.length; index += 40) {
        const batch = entries.slice(index, index + 40).map(file => path.join(tarballDir, file).replace(/\\/g, '/'))
        const result = await runCommand(pnpmRuntime.executable, ['store', 'add', ...batch], {
          cwd: profileDir,
          env: environment,
          onOutput: (text, level) => onOutput(text),
        })
        if (result.exitCode !== 0) throw new Error(`离线依赖入库失败（代码 ${result.exitCode}）`)
      }
      // prefer-offline：store 里有的直接用，个别缺失的包联网补齐（比 --offline 全有全无更稳）。
      const install = await runCommand(pnpmRuntime.executable, ['install', '--prefer-offline'], {
        cwd: profileDir,
        env: environment,
        onOutput: (text, level) => onOutput(text),
      })
      if (install.exitCode !== 0) throw new Error(`离线安装失败（代码 ${install.exitCode}）`)
    },
    // 第六项守卫：删包 / 回滚只许动启动器自己管的家目录与 Profile；
    // 外部家目录（例如 ~/.dsh）明确拒绝，接管只登记不搬。
    homeScope: { userData, packsRoot, managedDshRoot },
  })

  /**
   * 官方默认整合包：列版本 / 读状态 / 按版本下载导入共用一份状态缓存
   * （启动核对也写它，渲染层随后读到的就是同一结果）。
   * 进度走 packProgress status 事件（整合包页横幅），导入成功广播 done 让渲染层刷新列表。
   */
  let officialStatusCache: OfficialPackStatus | null = null
  /** 进行中的核对：启动核对与渲染层同时要状态时合流成一次 GitHub 查询。 */
  let officialCheckInFlight: Promise<OfficialPackStatus> | null = null

  const officialListDeps = async (): Promise<OfficialPackListDeps> => {
    const current = await settings.read()
    return { fetchImpl: proxyAwareFetch, mirror: current.network?.githubMirror }
  }

  const readInstalledOfficialVersions = async (): Promise<string[]> => {
    const records = await readPackRegistry(packsJsonPath)
    const versions = new Set<string>()
    for (const record of records) {
      const version = record.officialVersion?.trim()
      if (version) versions.add(version)
    }
    // 版本号降序：第一项即本机最新的官方包。
    return [...versions].sort((left, right) => compareVersions(right, left))
  }

  const resolveOfficialPackStatus = async (force: boolean): Promise<OfficialPackStatus> => {
    if (!force && officialStatusCache) return officialStatusCache
    if (officialCheckInFlight) return officialCheckInFlight
    officialCheckInFlight = (async () => {
      const installedVersions = await readInstalledOfficialVersions()
      try {
        const releases = await listOfficialPackVersions(await officialListDeps())
        const recommended = releases[0]?.version ?? null
        const newestInstalled = installedVersions[0] ?? null
        officialStatusCache = {
          recommended,
          installedVersions,
          updateAvailable: Boolean(recommended && newestInstalled && compareVersions(newestInstalled, recommended) > 0),
          error: null,
          checkedAt: new Date().toISOString(),
        }
      } catch (error) {
        officialStatusCache = {
          recommended: null,
          installedVersions,
          updateAvailable: false,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        }
      }
      return officialStatusCache
    })()
    try {
      return await officialCheckInFlight
    } finally {
      officialCheckInFlight = null
    }
  }

  /**
   * 下载并导入指定版本的官方整合包；`version` 缺省时用推荐版本（Release 里最新）。
   * `announce` = 用户主动触发：失败要抛错给界面；否则只记日志，不打扰启动。
   */
  const runOfficialPack = async (announce: boolean, version?: string): Promise<PackInstallResult | null> => {
    let target = version?.trim() ?? ''
    if (!target) {
      const status = await resolveOfficialPackStatus(true)
      if (!status.recommended) {
        if (announce) throw new Error(status.error ?? '没有可用的官方整合包版本。')
        if (status.error) events.output('plugin', 'error', `官方整合包版本核对失败：${status.error}`)
        return null
      }
      target = status.recommended
    }

    // 下载进度：250ms 节流（进度条够顺滑又不刷爆 IPC），速度用指数滑动平均抹平抖动，
    // 换源时速度重新起算（source 变了就丢弃旧速度，否则镜像的快速率会被直连的慢速率拖着）。
    let lastProgressAt = 0
    let lastReceived = 0
    let lastReceivedAt = Date.now()
    let smoothedSpeed = 0
    let lastSource = ''
    let announcedDownloadDone = false
    const outcome = await ensureOfficialPackVersion({
      registryPath: packsJsonPath,
      importPack: (filePath, items, options) => packManager!.importPack(filePath, items, options),
      fetchImpl: proxyAwareFetch,
      mirror: (await settings.read()).network?.githubMirror,
      downloadDir: path.join(userData, 'pack-snapshots'),
      onProgress: ({ received, total, source }) => {
        const now = Date.now()
        const finished = total != null && total > 0 && received >= total
        if (source !== lastSource) {
          lastSource = source
          smoothedSpeed = 0
          lastReceived = received
          lastReceivedAt = now
        }
        const elapsed = (now - lastReceivedAt) / 1000
        if (elapsed >= 0.5) {
          const instant = (received - lastReceived) / elapsed
          smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.6 + instant * 0.4 : instant
          lastReceived = received
          lastReceivedAt = now
        }
        if (now - lastProgressAt < 250 && !finished) return
        lastProgressAt = now
        events.packProgress({
          kind: 'download',
          label: `官方整合包 ${target}`,
          received,
          total: total && total > 0 ? total : null,
          speed: smoothedSpeed > 0 ? smoothedSpeed : null,
          source,
        })
        // 下载完成到真正导入完成之间还有写盘、解压、补装 DSH 运行时，几十秒到几分钟；
        // 这里立刻交棒给阶段提示，别让进度条停在 100% 一动不动。
        if (finished && !announcedDownloadDone) {
          announcedDownloadDone = true
          events.packProgress({ kind: 'stage', label: '下载完成，正在写入并解压整合包…', percent: null })
        }
      },
    }, target).catch((error: unknown) => {
      // 下载或导入中途失败时，后面的收口语句根本走不到，下载条/阶段横幅会一直挂在界面上。
      events.packProgress({ kind: 'status', message: '' })
      throw error
    })
    events.packProgress({ kind: 'status', message: '' })
    if (outcome.outcome === 'imported' && outcome.result) {
      officialStatusCache = null
      if (outcome.source) events.output('plugin', 'info', `官方整合包 ${target} 已下载（来源：${outcome.source}）。`)
      events.packProgress({ kind: 'done', result: outcome.result })
      return outcome.result
    }
    if (announce) {
      if (outcome.outcome === 'present') throw new Error(`官方整合包 ${target} 已存在。`)
      throw new Error(outcome.message ?? `官方整合包 ${target} 获取失败。`)
    }
    if (outcome.outcome === 'failed') {
      events.output('plugin', 'error', `官方整合包自动获取失败：${outcome.message ?? '未知原因'}`)
    }
    return null
  }

  const restoreOfficialPack = async (): Promise<PackInstallResult> => {
    const result = await runOfficialPack(true)
    if (!result) throw new Error('官方整合包获取失败。')
    return result
  }

  const installOfficialPackVersion = async (version: string): Promise<PackInstallResult> => {
    const result = await runOfficialPack(true, version)
    if (!result) throw new Error(`官方整合包 ${version} 获取失败。`)
    return result
  }

  const launcherUpdater = createLauncherUpdater({
    getVersion: () => app.getVersion(),
    userDataPath: userData,
    githubFetch: githubAuth.fetch,
    emitProgress: progress => events.launcherUpdateProgress(progress),
  })

  // 启动自愈：上次 AI 会话若在凭据锁期间崩溃（进程被杀、finally 未跑），
  // .credentials.yaml 会滞留在锁目录，这里把它还原回 dshHome。
  void settings
    .read()
    .then(current => healCredentialsLock(current.dshHome, path.join(userData, CREDENTIALS_LOCK_DIRNAME)))
    .catch(() => { /* 设置未就绪可忽略，锁会在下次 AI 会话前置处理 */ })

  const profilePoolReady = migrateLegacyPacks({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    isRuntimeRunning: () => runtime.isRunning(),
  }).then(async () => {
    const current = await settings.read()
    // 认领边界（缺陷 1）：启动序列只碰启动器自己管的家目录。
    // dshHome 指到外部（例如用户手动把 ~/.dsh 设成家目录）时，
    // consolidatePluginPool 会改写那边的 profiles/*/pnpm-workspace.yaml 与
    // package.json 的 dsh.profile.bundles —— 首启绝不许这么干。
    // 手动接管仍然可用：接管后 dshHome 落在整合包根目录里，走的就是下面这条正常路径。
    if (!isLauncherOwnedHome(current.dshHome, { userData, packsRoot, managedDshRoot })) {
      console.log(`[home-scope] 跳过启动期插件池归并：${current.dshHome} 不在启动器管理的目录内（只读不改动）。`)
      return
    }
    const result = await consolidatePluginPool(current.dshHome)
    if (result.dependencies > 0) events.output('plugin', 'info', `已将 ${result.dependencies} 个整合包插件依赖归并到共享插件池。`)
  }).then(async () => {
    await migrateToPackHomesV2({
      registryPath: packsJsonPath,
      readStoredSettings: () => settings.readStored(),
      saveSettings: next => settings.save(next),
      isRuntimeRunning: () => runtime.isRunning(),
    })
  }).catch(error => events.output('plugin', 'error', `旧整合包/插件池迁移失败：${error instanceof Error ? error.message : String(error)}`))

  return { settings, pluginReceiptsPath, runtime, installer, launcherUpdater, pluginTrial, aiInstaller, copilot, packManager: packManager!, githubAuth, applicationAddons, catalogSync, dshMarket, desktopPlugins, recommendedWebUi, runtimeVersions, profiles: profileService, profilePoolReady, restoreOfficialPack, listOfficialPackVersions: async () => listOfficialPackVersions(await officialListDeps()), readOfficialPackStatus: force => resolveOfficialPackStatus(force === true), installOfficialPackVersion }
}

function openMainWindow(): void {
  // 已有存活的主窗口就聚焦它，绝不再建第二个：旧台式实测出现过两个一模一样的
  // app 页 target（内容一致、互相抢焦点），从这里加一道最便宜的防御。
  const existing = getWindow()
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  const window = createMainWindow({
    preloadPath: path.join(moduleDirectory, 'preload.mjs'),
    iconPath: launcherIconPath,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    indexPath: path.join(moduleDirectory, '../dist/index.html'),
    onClosed: () => { mainWindow = null },
  })
  // 点 X 或 Alt+F4 只隐藏到托盘继续后台运行；托盘菜单「退出」经 app.quit()
  // 触发 before-quit 置位 isQuitting 后，这里才放行关闭。
  window.on('close', event => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
    if (!backgroundNoticeShown) {
      backgroundNoticeShown = true
      tray?.notifyBackground()
    }
  })
  mainWindow = window
}

/** 从托盘或第二实例唤起主窗口；窗口不存在时重建。 */
function showMainWindow(): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    openMainWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  // 无边框透明窗口从后台唤起时常抢不到焦点，短暂置顶可确保激活。
  window.setAlwaysOnTop(true, 'screen-saver')
  window.show()
  window.focus()
  window.setAlwaysOnTop(false, 'screen-saver')
}

/**
 * 命令行入口：启动器自己就是自检 / 导出入口，不再依赖 scripts/ 下那份 vite-node 脚本
 * （scripts/ 不进安装包，对面机器上根本没有）。
 *
 * 必须排在单实例锁之前：第二个实例会在 `app.quit()` 那一步直接退出，命令根本跑不起来。
 * 退出走 `app.exit()`：before-quit 里有一整套异步清理 + preventDefault，会把这个进程卡住。
 */
async function runCommandLine(command: 'verify' | 'export', argv: string[]): Promise<void> {
  const write = (text: string): void => { if (text) process.stdout.write(text + '\n') }
  const warn = (text: string): void => { if (text) process.stderr.write(text + '\n') }
  let exitCode = 2
  try {
    if (command === 'verify') {
      const run = await runCli(argv)
      write(run.stdout)
      warn(run.stderr)
      exitCode = run.exitCode
    } else {
      const parsed = parseExportArgs(argv)
      if (!parsed.ok) {
        warn(`${parsed.message}\n${EXPORT_USAGE}`)
      } else {
        // 命令行没人能点「同意」，所以只用 createServices 这一层：它不建窗口、不建托盘，
        // 只把 packManager 装起来——导出本身仍然是那一份实现，与界面上点导出走同一条路。
        await migrateStoredPacksRoot(app.getPath('userData'))
        services = createServices(await startupPacksRoot(app.getPath('userData')))
        // 目标目录由命令行给：它可能还不存在（界面上那条路有 showSaveDialog 兜着，命令行没有），
        // 先建出来，否则 writeSnapshotZip 会以 ENOENT 收场。
        await mkdir(path.dirname(parsed.targetZip), { recursive: true })
        write(`正在导出整合包「${parsed.packId}」…`)
        const result = await services.packManager.exportPack(parsed.packId, {}, parsed.targetZip)
        write(`导出完成：${result.zipPath}`)
        write(`再看一眼有没有对不上号的地方："${process.execPath}" --verify "${result.zipPath}"`)
        exitCode = 0
      }
    }
  } catch (error) {
    warn(`${command === 'verify' ? '自检' : '导出'}没跑起来：${error instanceof Error ? error.message : String(error)}`)
    exitCode = 2
  }
  app.exit(exitCode)
}

/**
 * 命令行入口（--export-pack <packId> [输出目录]）：用启动器自己的装配引擎导出离线包，产出 zip。
 * 与 --verify/--export 一样排在单实例锁之前——第二个实例会在 app.quit() 那一步直接退出。
 * 逻辑全在 pack-export-cli.ts 的 runExportPack 里（那边可被单测直接调），这里只解析参数、打输出、定退出码。
 * 退出码：0 成功 / 1 导出失败 / 2 参数错或包级校验没过。
 */
async function runExportPackCommand(argv: string[]): Promise<void> {
  const write = (text: string): void => { if (text) process.stdout.write(text + '\n') }
  const warn = (text: string): void => { if (text) process.stderr.write(text + '\n') }
  const parsed = parseExportPackArgs(argv)
  if (!parsed.ok) {
    warn(`${parsed.message}\n${EXPORT_PACK_USAGE}`)
    app.exit(2)
    return
  }
  const userData = app.getPath('userData')
  let result: ExportPackResult
  try {
    // 与 --export 同一条路：老用户 settings 里写死的旧默认 packsRoot 先迁一次再取。
    await migrateStoredPacksRoot(userData)
    // 包级校验的 warnings 走 stderr；stdout 只留进度行与最后一行 JSON 摘要。
    result = await runExportPack({
      packId: parsed.packId,
      packsRoot: await startupPacksRoot(userData),
      fallbackOutputRoot: userData,
      registryPath: path.join(userData, 'packs.json'),
      ...(parsed.outputDir ? { outputDir: parsed.outputDir } : {}),
      onProgress: event => write(`[${event.stage}] ${event.message}`),
    })
  } catch (error) {
    warn(`导出没跑起来：${error instanceof Error ? error.message : String(error)}`)
    app.exit(1)
    return
  }
  for (const warning of result.warnings) warn(`! ${warning}`)
  if (result.summary) write(summaryLine(result.summary))
  if (result.error) warn(result.error)
  app.exit(result.exitCode)
}

/**
 * 装配工作台入口（--workbench）：无窗口跑插件装配闭环，写完 status/events/verdict 就退出。
 * 与 --verify/--export 一样排在单实例锁之前——第二个实例会在 app.quit() 那一步直接退出。
 * 退出走 app.exit()：before-quit 里有一整套异步清理 + preventDefault，会把这个进程卡住。
 */
async function runWorkbenchCommand(argv: string[]): Promise<void> {
  const write = (text: string): void => { if (text) process.stdout.write(text + '\n') }
  const warn = (text: string): void => { if (text) process.stderr.write(text + '\n') }
  const parsed = parseWorkbenchArgs(argv)
  if (!parsed.ok) {
    warn(`${parsed.message}\n${WORKBENCH_USAGE}`)
    app.exit(2)
    return
  }
  const userData = app.getPath('userData')
  let sourceHome = parsed.value.sourceHome
  if (!sourceHome) {
    try {
      sourceHome = await resolveWorkbenchSourceHome(userData)
    } catch (error) {
      warn(`${error instanceof Error ? error.message : String(error)}\n${WORKBENCH_USAGE}`)
      app.exit(2)
      return
    }
  }
  const result = await runWorkbench({
    packDir: parsed.value.packDir,
    sourceHome,
    plugin: parsed.value.plugin,
    profileId: parsed.value.profileId,
    runRoot: parsed.value.runRoot ?? workbenchRootDir(userData),
    nodeExecutable: parsed.value.nodeExecutable,
    timeoutMs: parsed.value.timeoutMs ?? undefined,
    onOutput: write,
  })
  if (result.runDir) write(`运行目录：${result.runDir}`)
  app.exit(result.exitCode)
}

/** --home 缺省值：packs.json 里当前激活的整合包；只有一个带 homePath 的包时就用它。 */
async function resolveWorkbenchSourceHome(userData: string): Promise<string> {
  const records = await readPackRegistry(path.join(userData, 'packs.json'))
  let activePackId: string | null = null
  try {
    const raw = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) as { activePackId?: unknown }
    activePackId = typeof raw.activePackId === 'string' ? raw.activePackId : null
  } catch {
    activePackId = null
  }
  const homes = records.filter(record => typeof record.homePath === 'string' && record.homePath.length > 0)
  const picked = homes.find(record => record.id === activePackId) ?? (homes.length === 1 ? homes[0] : null)
  if (!picked?.homePath) throw new Error('找不到源实例家目录：用 --home <实例家目录> 指定（启动器里没有激活的整合包）。')
  return picked.homePath
}

const workbenchStart = process.argv.findIndex(item => item === '--workbench')
const commandStart = process.argv.findIndex(item => item === '--verify' || item === '--export')
// --export-pack 与 --export 是两个不同的开关（前缀相同，不能只用 startsWith 判）：先单独揪出来，
// 免得 --export 那一条把它当自己的参数。分派同样在单实例锁之前。
const exportPackStart = process.argv.findIndex(item => item === '--export-pack')
if (workbenchStart >= 0) {
  const rest = process.argv.slice(workbenchStart + 1)
  app.whenReady().then(() => runWorkbenchCommand(rest)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(2)
  })
} else if (exportPackStart >= 0) {
  const rest = process.argv.slice(exportPackStart + 1)
  app.whenReady().then(() => runExportPackCommand(rest)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(2)
  })
} else if (commandStart >= 0) {
  const command = process.argv[commandStart] === '--verify' ? 'verify' : 'export'
  const rest = process.argv.slice(commandStart + 1)
  app.whenReady().then(() => runCommandLine(command, rest)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(2)
  })
} else {
  // 第二个实例直接退出，由已运行实例通过 second-instance 唤起前台窗口。
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => showMainWindow())
  }
}

if (workbenchStart < 0 && commandStart < 0 && exportPackStart < 0) app.whenReady().then(async () => {
  // 系统代理先探起来（异步，与下面的启动步骤并行）：之后所有子进程都只读缓存，
  // 不必再在事件循环上同步查注册表。等完再建服务，确保第一次装包/启动就带上代理。
  const systemProxyProbe = refreshWindowsSystemProxy()
  await recoverLegacyCredentials(path.join(app.getPath('userData'), 'dsh-credentials-compat')).catch(error => {
    console.error('[credentials] 旧版 DSH 凭据恢复失败。', error)
  })
  await systemProxyProbe
  try {
    processSupervisor = await createProcessSupervisor({
      root: path.join(app.getPath('userData'), 'process-supervisor'),
      onError: message => console.error(`[process-supervisor] ${message}`),
    })
    configureProcessTracker(processSupervisor)
  } catch (error) {
    console.error('[process-supervisor] 启动失败，退出时只能执行普通清理。', error)
  }
  // 一次性迁移：装到别的盘、settings.json 里还写死旧默认位置的老用户，先把 packsRoot 改到新位置，
  // 再让 startupPacksRoot 读到迁移后的值。失败只记日志，继续用旧值，不挡启动。
  await migrateStoredPacksRoot(app.getPath('userData'))
  // 整合包根目录要在这里（服务装配之前）就定下来：pack.ts 只在建服务时读一次。
  services = createServices(await startupPacksRoot(app.getPath('userData')))
  registerIpcHandlers({
    ...services,
    workbenchRoot: workbenchRootDir(app.getPath('userData')),
    skillsShIndexPath: path.join(app.getPath('userData'), 'skills-sh-index.json'),
    newsCachePath: path.join(app.getPath('userData'), 'juya-news-cache.json'),
    getWindow,
    setWindowMode: (mode: WindowMode) => applyWindowMode(mainWindow, mode),
    answerPortConflict,
  })
  // 随包内核释放：必须早于一切「读 DSH 版本/启动实例」的动作，否则首启还会去下载。
  // 目标已完整就不动；不完整（上次首启被中断留下半截）则整棵重拷，让它自愈。
  // 失败只记日志，不挡启动。
  try {
    const seeded = await seedBundledKernels({
      kernelsRoot: bundledKernelsRoot,
      dshInstallPath: (await services.settings.read()).dshInstallPath,
      homeScope: {
        userData: app.getPath('userData'),
        packsRoot: await startupPacksRoot(app.getPath('userData')),
        managedDshRoot: path.join(app.getPath('userData'), 'dsh-runtime'),
      },
    })
    if (seeded.seeded.length > 0) {
      const done = seeded.seeded.filter(item => item.state === 'seeded').map(item => item.version)
      if (done.length > 0) console.log(`[kernel] 已释放随包内核：${done.join(', ')}`)
    }
  } catch (error) {
    console.error('[kernel] 释放随包内核失败。', error)
  }
  await services.profilePoolReady
  openMainWindow()
  // 首启不下载也不导入任何官方整合包：全新安装的实例列表必须是 0 条。
  tray = createTray({ iconPath: launcherIconPath, showMainWindow })
  // 托盘一建出来就把当前实例状态写上去（冷启动时可能已经有实例在自己跑）。
  syncShellStatus(services.runtime.list())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function waitForIdle(check: () => boolean): Promise<void> {
  if (!check()) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!check()) {
        clearInterval(timer)
        resolve()
      }
    }, 100)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function shutdownLauncherProcesses(): Promise<void> {
  const current = services
  // 先让监督器对仍在运行的根进程做快照；若 DSH 派生了脱离父进程树的服务，
  // 必须在正常停止根进程前收集它们，否则关闭后无法再定位微信机器人 PID。
  const supervisorShutdown = processSupervisor?.shutdown().catch(error => {
    console.error('[process-supervisor] 清理子进程失败。', error)
  }) ?? Promise.resolve()
  const gracefulTasks: Promise<unknown>[] = []
  // 解耦（2026-10-23）：退出**不再**停实例。实例是独立进程组、输出写自己的日志文件、
  // 也不登记给监督器，启动器退出它们照常运行；退出只清瞬时子进程（装包/解压/更新器）。
  if (current?.pluginTrial.isBusy()) gracefulTasks.push(current.pluginTrial.cancel())
  if (current?.aiInstaller.isBusy()) gracefulTasks.push(current.aiInstaller.cancel())
  if (current?.copilot.isBusy()) gracefulTasks.push(current.copilot.shutdown())
  if (current?.packManager.isBusy()) gracefulTasks.push(waitForIdle(() => current.packManager.isBusy()))
  if (current?.installer.isBusy()) gracefulTasks.push(waitForIdle(() => current.installer.isBusy()))
  if (current?.applicationAddons.isBusy()) gracefulTasks.push(waitForIdle(() => current.applicationAddons.isBusy()))

  const graceful = Promise.allSettled(gracefulTasks)
  await Promise.race([Promise.all([graceful, supervisorShutdown]), delay(2_000)])
  await supervisorShutdown
  // 监督器处理完整树后，主进程再用本地句柄兜底，覆盖通信丢失或快速关闭。
  await shutdownTrackedProcesses().catch(error => {
    console.error('[process-tracker] 清理子进程失败。', error)
  })
  configureProcessTracker(null)
  await Promise.race([graceful, delay(800)])

  if (current) {
    try {
      const settings = await current.settings.read()
      await healCredentialsLock(
        settings.dshHome,
        path.join(app.getPath('userData'), CREDENTIALS_LOCK_DIRNAME),
      )
    } catch (error) {
      console.error('[shutdown] AI 凭据文件还原失败。', error)
    }
  }
}

// 无论是正常关闭还是安装过程中退出，所有由启动器登记的进程树都必须一起结束。
app.on('before-quit', event => {
  if (allowFinalQuit) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  // 放行窗口 close：清理完成后窗口随退出流程正常关闭。
  isQuitting = true
  void shutdownLauncherProcesses().finally(() => {
    allowFinalQuit = true
    app.quit()
  })
})

// will-quit 在 before-quit 清理完成后触发，此时移除托盘图标。
app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})
