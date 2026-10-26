import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, InstanceSnapshot, RuntimeOutput, RuntimeState } from '../src/types'
import { readPackRegistry, type PackRecord } from './pack-registry'
import type { PortOwner } from './port-control'
import { instanceLogFiles, readLogTail } from './instance-logs'
import { isPortOccupied, killProcessTreeByPid, resolveInstancePid } from './instance-probe'
import { findAvailableWebPort, isLoopbackPortAvailable, type RuntimeController } from './runtime'

/**
 * bili 侧信道端口相对实例端口的偏移。**不要再用 15807**：它让 3080 落在 18887/18888，
 * 与 3500 那套手工实例（start.cmd 固定 18887/18888）直接撞车，bili 只能漂到 18888，
 * 而这正是它自己的 BILI_CLAUDE_NATIVE_PORT，于是双 spawn 互踩、proxy respawn gave up、
 * 模型请求原样直连上游（未压缩）。20000 起跳把它们挪进无人区：
 * 3080→23080/23081、4000→24000/24001。
 * ponytail: 单一偏移 + 上限 65535 的省事写法；实例端口 >45535 会溢出，改法是改成查空闲端口。
 */
const BILI_PORT_OFFSET = 20000
const PORT_TABLE_VERSION = 1
const FALLBACK_PORT_BASE = 3081
const FALLBACK_PORT_ATTEMPTS = 20

const EMPTY_RUNTIME: RuntimeState = { running: false, pid: null, startedAt: null, url: null, port: null }

/** 一个包启动时真正要用的内核：包内 node_modules 优先，没有才回落启动器全局那份。 */
export interface InstanceKernel {
  executable: string
  version: string | null
  source: 'pack' | 'launcher'
}

/** 造一个实例控制器需要的依赖，由 createInstanceManager 按包绑定，其余依赖由 main 原样转发。 */
/** 启动器常驻探测间隔：3s 一轮，只做「端口有人在听吗」这种毫秒级判断。 */
const PROBE_INTERVAL_MS = 3_000
/** 刚点过启动/停止时的宽限期：端口还没打开/还没释放，别急着翻状态。 */
const PROBE_GRACE_MS = 10_000
/** 端口被占但认不出 PID 时，隔这么久再试一次命令行校验。 */
const PROBE_RETRY_MS = 15_000

export interface InstanceControllerDeps {
  readSettings: () => Promise<AppSettings>
  extraEnvironment: (settings: AppSettings) => NodeJS.ProcessEnv
  /** 解耦模式：实例日志落到这个目录（包家目录）；null = 走原来的管道模式。 */
  detachedLogDir: (settings: AppSettings) => string | null
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  emitState: (state: RuntimeState) => void
  resolvePortConflict: (owners: PortOwner[], port: number) => Promise<boolean>
  trackedPids: () => number[]
}

export interface InstanceManagerOptions {
  /** 每包端口表落盘位置（userData/instances.json），让端口在重启之间保持稳定。 */
  tablePath: string
  /** 每实例私有状态根目录（userData/instances/<packId>），bili 数据落在这里。 */
  instanceRoot: (packId: string) => string
  registryPath: string
  readSettings: () => Promise<AppSettings>
  createController: (deps: InstanceControllerDeps) => RuntimeController
  emitOutput: (packId: string, level: RuntimeOutput['level'], text: string) => void
  emitState: (state: RuntimeState) => void
  emitInstances: (instances: InstanceSnapshot[]) => void
  resolvePortConflict: (packId: string, owners: PortOwner[], port: number) => Promise<boolean>
  /** 把 settings 里的 activePackId/profileName 指向该包（实例启动后调用，无守卫）。 */
  activatePack?: (packId: string) => Promise<void>
}

/**
 * 按包并发的实例管理器。对外仍满足 RuntimeController（ipc 的 runtime:* 通道用的就是它），
 * 额外提供按 packId 的启停与快照；每个包背后是一个独立的 createRuntimeController 实例。
 */
export interface InstanceManager extends RuntimeController {
  list(): InstanceSnapshot[]
  listAsync(): Promise<InstanceSnapshot[]>
  startPack(packId: string): Promise<RuntimeState>
  stopPack(packId: string): Promise<RuntimeState>
  /** 启动某个包之后把「当前整合包」指针切过去（不走 packs:activate 的全局锁）。 */
  markActive(packId: string): Promise<void>
  stopAll(): Promise<void>
  trackedPids(): number[]
  isPackRunning(packId: string): boolean
  refreshSnapshots(): Promise<InstanceSnapshot[]>
  /** 立刻重算一轮（端口探测 + 快照广播），调试与「刷新」用。 */
  probeNow(): Promise<InstanceSnapshot[]>
  /**
   * 改某个包的端口（首页端口卡）。写 instances.json 后广播快照。
   * 端口唯一真相就是这张表：1–65535、不能跟别的包重复、实例在跑时拒绝。
   */
  setPort(packId: string, port: number): Promise<InstanceSnapshot[]>
  /** 所有已分配给整合包的端口（试运行挑端口时用来避开它们）。 */
  assignedPorts(): Promise<number[]>
}

interface PortTableEntry {
  port?: number
  /** 覆盖该包的 bili 状态根目录（回退用：指回改动前的旧目录）。 */
  biliRoot?: string
  /** 上次是谁起的：只是提示，真相以端口探测为准。 */
  pid?: number
  startedAt?: string
}

/** 探测缓存：一个包此刻在不在跑、PID 是谁、Web 地址是什么。 */
interface ProbeState {
  running: boolean
  pid: number | null
  url: string | null
  resolvedAt: number
}

function readVersion(manifestPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function kernelIn(modules: string): InstanceKernel | null {
  const executable = ['dsh.cmd', 'dsh.exe', 'dsh']
    .map(name => path.join(modules, '.bin', name))
    .find(candidate => existsSync(candidate))
  if (!executable) return null
  return { executable, version: readVersion(path.join(modules, '@deepseek-ai', 'dsh', 'package.json')), source: 'pack' }
}

/**
 * 一个包启动时用哪份内核，三级回退（这是「两包跑不同内核版本」的开关）：
 * 1. 包内 profiles\node_modules 自带的整套内核（source='pack'）；
 * 2. 否则用包里声明的 dshVersion 去版本库 <dshInstallPath>\versions\<版本> 精确取；
 * 3. 都没有才回落启动器全局的 launchExecutable。
 */
export function packKernel(
  homePath: string | null,
  fallbackExecutable: string,
  library?: { root?: string | null; version?: string | null },
): InstanceKernel {
  if (homePath) {
    const bundled = kernelIn(path.join(homePath, 'profiles', 'node_modules'))
    if (bundled) return bundled
  }
  const pinned = library?.version
    ? kernelIn(path.join(library.root ?? '', 'versions', library.version, 'node_modules'))
    : null
  if (pinned) return pinned
  return { executable: fallbackExecutable, version: null, source: 'launcher' }
}

/**
 * 包的 profile 目录名：优先同名 profile，其次 web（老包），最后退回包 id。
 *
 * 判据必须是「目录里有 package.json」，不能只看目录存在：启动器写元数据时会顺手
 * mkdir 出同名空壳目录，只看存在就会把空壳当成 profile，启动参数变成
 * `--profile <空壳>`，DSH 认不出（它要求 package.json），进程直接 exit 1。
 */
export function resolveProfileName(homePath: string | null, packId: string): string {
  if (!homePath) return packId
  const profiles = path.join(homePath, 'profiles')
  if (existsSync(path.join(profiles, packId, 'package.json'))) return packId
  if (existsSync(path.join(profiles, 'web', 'package.json'))) return 'web'
  return packId
}

/**
 * 每实例一套 bili 状态目录与环境变量。不注入就会两个实例抢同一个 18788 代理、
 * 共用同一份会话数据（bili 用 homedir() 拼路径，不认 DSH_HOME）。
 */
export function biliEnvironment(root: string, webPort: number): NodeJS.ProcessEnv {
  const config = path.join(root, 'config')
  const zonePort = webPort + BILI_PORT_OFFSET
  return {
    BILI_SESSIONS_DIR: path.join(root, 'sessions'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    BILI_CONFIG_FILE: path.join(config, 'billion-context.json'),
    BILI_ZONE_PORT: String(zonePort),
    BILI_CLAUDE_NATIVE_PORT: String(zonePort + 1),
    ACP_AUTO_UPDATE: '0',
  }
}

/** 包 id 末尾的 4~5 位数字当默认端口（dsh-fallback-4000 → 4000）。 */
function portFromPackId(packId: string): number | null {
  const matched = /(\d{4,5})$/.exec(packId)
  if (!matched) return null
  const port = Number(matched[1])
  return port >= 1 && port <= 65535 ? port : null
}

export function createInstanceManager(options: InstanceManagerOptions): InstanceManager {
  const controllers = new Map<string, RuntimeController>()
  const states = new Map<string, RuntimeState>()
  const ports = new Map<string, number>()
  const biliRoots = new Map<string, string>()
  const table = new Map<string, PortTableEntry>()
  let tableLoading: Promise<void> | null = null
  let snapshots: InstanceSnapshot[] = []
  let activePackId: string | null = null
  // 探测缓存：**不在跑**也缓存（running:false），这样「状态没变」可以一次进程都不建。
  const probes = new Map<string, ProbeState>()
  const graceUntil = new Map<string, number>()
  let probeTimer: NodeJS.Timeout | null = null

  const loadTable = (): Promise<void> => {
    if (!tableLoading) {
      tableLoading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(options.tablePath, 'utf8')) as { packs?: Record<string, PortTableEntry> }
          for (const [packId, entry] of Object.entries(parsed.packs ?? {})) {
            if (entry && typeof entry === 'object') table.set(packId, entry)
          }
        } catch {
          // 首次运行没有表：按 packId/激活包/空闲端口现算，随后写回。
        }
      })()
    }
    return tableLoading
  }

  const saveTable = async (): Promise<void> => {
    try {
      await mkdir(path.dirname(options.tablePath), { recursive: true })
      const packs = Object.fromEntries(table)
      await writeFile(options.tablePath, JSON.stringify({ version: PORT_TABLE_VERSION, packs }, null, 2), 'utf8')
    } catch {
      // 端口表只是让端口在重启后稳定，写不进去不影响本次启动。
    }
  }

  const biliRootFor = (packId: string): string =>
    table.get(packId)?.biliRoot ?? path.join(options.instanceRoot(packId), 'bili')

  /**
   * 把探测结果盖到快照上：running / pid / url 一律以探测为准。
   * 控制器自己的状态只当补充 —— 刚点完启动那几秒端口还没打开，探测缓存里就是它。
   */
  const applyProbes = (): void => {
    for (const entry of snapshots) {
      const probe = probes.get(entry.packId)
      const state = states.get(entry.packId)
      const running = probe?.running ?? state?.running === true
      entry.running = running
      entry.pid = running ? (probe?.pid ?? state?.pid ?? null) : null
      entry.url = running ? (state?.url ?? probe?.url ?? null) : null
      entry.startedAt = state?.startedAt ?? table.get(entry.packId)?.startedAt ?? null
    }
  }

  /**
   * 从实例日志末尾把这次启动的 Web 地址（带 token）捞回来。
   * 解耦后启动器不持有管道，冷启动时首页那个「打开网页」就靠它。
   */
  const urlFromLog = (homePath: string, port: number): string | null => {
    const text = readLogTail(instanceLogFiles(homePath).out)
    if (!text) return null
    const found: string[] = []
    for (const match of text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"'<>]*)?/gi)) {
      try {
        if (new URL(match[0]).port === String(port)) found.push(match[0])
      } catch {
        // 命中的不是合法 URL，跳过继续找。
      }
    }
    return found.at(-1) ?? null
  }

  /**
   * 一轮状态探测。便宜的地方在这里：
   * 常态只跑 isPortOccupied（net.createServer().listen，毫秒级、不建进程）；
   * **只有端口占用与本缓存不一致时**才 netstat 解析 PID + CIM 校验命令行，结果留到下次变化。
   */
  const refreshProbe = async (): Promise<boolean> => {
    let changed = false
    const now = Date.now()
    for (const entry of snapshots) {
      const port = entry.webPort
      if (!port) continue
      const previous = probes.get(entry.packId)
      const occupied = await isPortOccupied(port)
      const knownRunning = previous?.running === true
      if (occupied === knownRunning) {
        // 状态没变。唯一例外：端口占着但上次没认出 PID，隔一会儿再试一次校验。
        if (!occupied || !previous || previous.pid !== null) continue
        if (now - previous.resolvedAt < PROBE_RETRY_MS) continue
      }
      const grace = (graceUntil.get(entry.packId) ?? 0) > now
      if (!occupied) {
        if (grace) continue
        probes.set(entry.packId, { running: false, pid: null, url: null, resolvedAt: now })
        changed = true
        continue
      }
      const pid = await resolveInstancePid({
        port,
        homePath: entry.homePath,
        kernelPath: entry.kernelPath,
        // --profile <包id> 是首要身份证据：同一端口上两个包互相认错就是缺了它。
        profileName: entry.profileName,
      })
      if (pid === null) {
        // 端口被一个认不出归属的进程占着：宽限期内先不动，过了就按「未启动」显示（绝不认错进程）。
        if (grace) continue
        probes.set(entry.packId, { running: false, pid: null, url: null, resolvedAt: now })
        changed = true
        continue
      }
      probes.set(entry.packId, { running: true, pid, url: urlFromLog(entry.homePath, port), resolvedAt: now })
      changed = true
    }
    if (changed) applyProbes()
    return changed
  }

  /** 重算快照 + 探测 + 广播：主进程常驻定时器、冷启动首轮、显式刷新都走它。 */
  const syncAndEmit = async (): Promise<InstanceSnapshot[]> => {
    await describe()
    await refreshProbe()
    applyProbes()
    options.emitInstances(snapshots)
    options.emitState(activeState())
    return snapshots
  }

  /** 别的包已经登记过的端口（端口唯一真相就在这张表里）。 */
  const assignedPortsExcept = (excludePackId?: string): Set<number> => {
    const used = new Set<number>()
    for (const [packId, entry] of table) {
      if (packId === excludePackId) continue
      if (typeof entry.port === 'number') used.add(entry.port)
    }
    for (const [packId, port] of ports) {
      if (packId === excludePackId) continue
      used.add(port)
    }
    return used
  }

  /** 从 preferred 起找一个既没被别的包登记、系统里也没人监听的端口。 */
  const findUniquePort = async (preferred: number, packId: string): Promise<number | null> => {
    const taken = assignedPortsExcept(packId)
    return findAvailableWebPort(preferred, FALLBACK_PORT_ATTEMPTS, async port =>
      !taken.has(port) && isLoopbackPortAvailable(port))
  }

  /**
   * 这个包自己的端口。唯一的真相是 instances.json 里每个包那一格。
   * settings.webPort 只是「新包第一次分配时的种子值」，旧包**绝不**回落到它——
   * 1.0.9 的实例互杀就是两个包各自回落到同一个全局端口、再永久各记一份。
   */
  const resolvePort = async (packId: string, settings: AppSettings): Promise<number> => {
    await loadTable()
    const cached = ports.get(packId)
    if (cached) return cached
    const entry = table.get(packId)
    // 已登记的端口只要没跟别的包撞车就继续用（改端口走 instances:set-port）。
    if (entry?.port && !assignedPortsExcept(packId).has(entry.port)) {
      ports.set(packId, entry.port)
      return entry.port
    }
    // 新包（或登记值撞车）：包 id 尾号 → 启动器种子值 → 兜底段，一路避开别的包的端口。
    const preferred = portFromPackId(packId) ?? (settings.webPort || FALLBACK_PORT_BASE)
    const port = await findUniquePort(preferred, packId)
      ?? await findUniquePort(FALLBACK_PORT_BASE, packId)
    if (!port) throw new Error(`没有可用端口：从 ${preferred} 起找不到既空闲、又没被别的整合包占用的端口`)
    ports.set(packId, port)
    if (entry?.port !== port) {
      table.set(packId, { ...entry, port })
      void saveTable()
    }
    return port
  }

  /** 每包 settings 覆盖层：家目录、profile、内核、端口都按这个包算，其余沿用全局设置。 */
  const settingsFor = async (packId: string): Promise<AppSettings> => {
    const base = await options.readSettings()
    activePackId = base.activePackId ?? null
    let record: PackRecord | undefined
    try {
      record = (await readPackRegistry(options.registryPath)).find(candidate => candidate.id === packId)
    } catch {
      record = undefined
    }
    const homePath = record?.homePath ?? null
    const kernel = packKernel(homePath, base.launchExecutable, { root: base.dshInstallPath, version: record?.dshVersion ?? null })
    const port = await resolvePort(packId, base)
    const biliRoot = biliRootFor(packId)
    biliRoots.set(packId, biliRoot)
    // bili 侧插件不一定替我们建目录，先按 BILI_/XDG_ 变量指向的位置铺好，首启就不会因缺目录炸。
    await Promise.all(['sessions', 'config', 'state', 'cache', 'data']
      .map(dir => mkdir(path.join(biliRoot, dir), { recursive: true }).catch(() => undefined)))
    return {
      ...base,
      dshHome: homePath ?? base.dshHome,
      profileName: resolveProfileName(homePath, packId),
      launchExecutable: kernel.executable,
      launchArgs: ['web'],
      webPort: port,
      dshVersion: kernel.version ?? base.dshVersion,
    }
  }

  /** 占用自己端口的「自己人」：控制器知道的，加上探测认出来的。端口冲突自愈时用。 */
  const trackedPids = (): number[] => {
    const pids = new Set<number>()
    for (const state of states.values()) {
      if (state.running && typeof state.pid === 'number') pids.add(state.pid)
    }
    for (const probe of probes.values()) {
      if (probe.running && typeof probe.pid === 'number') pids.add(probe.pid)
    }
    return [...pids]
  }

  /**
   * 只算**这个包自己**的 PID。传给控制器的必须是这一份而不是上面那份全局名单：
   * 跨包的实例被当成「自己人」时，端口冲突会走 self-heal 直接 taskkill，静默杀掉别的包。
   */
  const trackedPidsFor = (packId: string): number[] => {
    const pids = new Set<number>()
    const state = states.get(packId)
    if (state?.running && typeof state.pid === 'number') pids.add(state.pid)
    const probe = probes.get(packId)
    if (probe?.running && typeof probe.pid === 'number') pids.add(probe.pid)
    return [...pids]
  }

  /** 包 id → 界面上那个名字（报错文案要让人认得出是哪个包）。 */
  const packName = async (packId: string): Promise<string> => {
    try {
      return (await readPackRegistry(options.registryPath)).find(record => record.id === packId)?.name ?? packId
    } catch {
      return packId
    }
  }

  const controllerFor = (packId: string): RuntimeController => {
    const existing = controllers.get(packId)
    if (existing) return existing
    // 解耦后实例的输出落在自己包里：pack home 由 settingsFor 按包算出来，
    // 这里用一个可变格子把它递给创建时就固定下来的 createController 回调。
    const detached = { dir: null as string | null }
    const controller = options.createController({
      readSettings: async () => {
        const resolved = await settingsFor(packId)
        detached.dir = resolved.dshHome
        return resolved
      },
      detachedLogDir: () => detached.dir,
      extraEnvironment: settings => biliEnvironment(biliRoots.get(packId) ?? biliRootFor(packId), settings.webPort),
      emitOutput: (level, text) => options.emitOutput(packId, level, text),
      emitState: next => {
        const previous = states.get(packId)
        states.set(packId, { ...next, packId })
        // 启停的那一下把第一手事实种进探测缓存，界面立刻对；3s 轮询随后用端口 + 命令行核对。
        // 只在 running 翻转时给宽限期，免得每次地址变化都把宽限期续上。
        if (previous?.running !== next.running) {
          // pid 故意留空、resolvedAt 置 0：控制器手里的 pid 是 cmd 外壳，真身是监听端口的 node。
          // 种一个 pid 进去会让轮询以为「已经认过了」，从此不再用 netstat 核对。
          probes.set(packId, { running: next.running, pid: null, url: next.url, resolvedAt: 0 })
          graceUntil.set(packId, Date.now() + PROBE_GRACE_MS)
        }
        applyProbes()
        if (packId === activePackId) options.emitState({ ...next, packId })
        void manager.refreshSnapshots()
      },
      resolvePortConflict: (owners, port) => options.resolvePortConflict(packId, owners, port),
      // 只上报本包的 PID：别的包的实例从此落到 decidePortConflict → 'ask'（弹窗问人）。
      trackedPids: () => trackedPidsFor(packId),
    })
    controllers.set(packId, controller)
    return controller
  }

  const describe = async (): Promise<InstanceSnapshot[]> => {
    let records: PackRecord[] = []
    try {
      records = await readPackRegistry(options.registryPath)
    } catch {
      records = []
    }
    const base = await options.readSettings()
    activePackId = base.activePackId ?? null
    await loadTable()
    const next: InstanceSnapshot[] = []
    for (const record of records) {
      // 没有独立家目录的旧包不是一个可并发实例（它们共用全局家目录）。
      if (!record.homePath) continue
      const homePath = record.homePath
      const kernel = packKernel(homePath, base.launchExecutable, { root: base.dshInstallPath, version: record.dshVersion ?? null })
      const state = states.get(record.id)
      // 端口只认这个包自己的记录，**不再**回落到 settings.webPort：
      // 回落会让每个没登记端口的包都自称同一个全局端口。
      const webPort = ports.get(record.id)
        ?? table.get(record.id)?.port
        ?? portFromPackId(record.id)
      next.push({
        packId: record.id,
        name: record.name,
        homePath,
        profileName: resolveProfileName(homePath, record.id),
        webPort,
        kernelPath: kernel.executable,
        kernelVersion: kernel.version,
        kernelSource: kernel.source,
        biliRoot: biliRootFor(record.id),
        running: state?.running === true,
        pid: state?.pid ?? null,
        url: state?.url ?? null,
        startedAt: state?.startedAt ?? null,
      })
    }
    snapshots = next
    applyProbes()
    return next
  }

  const emitInstances = async (): Promise<InstanceSnapshot[]> => {
    const next = await describe()
    options.emitInstances(next)
    // 激活包换人之后，界面上的「当前实例」快照也要跟着换。
    options.emitState(activeState())
    return next
  }

  /**
   * 「当前实例」的状态：控制器状态与探测结果取并集。
   * 冷启动后控制器是空的（这一版启动器没起过它），但探测能把在跑的实例认出来，
   * 首页的启动/停止按钮就靠这一份，不能只信其中一边。
   */
  const activeState = (): RuntimeState => {
    const packId = activePackId ?? ''
    const base = states.get(packId) ?? { ...EMPTY_RUNTIME, packId }
    const probe = probes.get(packId)
    const snapshot = snapshots.find(entry => entry.packId === packId)
    const running = base.running || probe?.running === true
    return {
      ...base,
      running,
      pid: running ? (probe?.pid ?? base.pid ?? null) : null,
      url: running ? (base.url ?? probe?.url ?? null) : null,
      port: snapshot?.webPort ?? base.port ?? null,
      packId,
    }
  }

  const manager: InstanceManager = {
    state: activeState,
    failure: () => (states.get(activePackId ?? '') ?? EMPTY_RUNTIME).lastFailure ?? null,
    isRunning: () => {
      for (const state of states.values()) if (state.running) return true
      for (const probe of probes.values()) if (probe.running) return true
      return false
    },
    async start() {
      const settings = await options.readSettings()
      const packId = settings.activePackId
      if (!packId) throw new Error('还没有激活的整合包，先在列表里选一个。')
      return manager.startPack(packId)
    },
    async stop() {
      const packId = activePackId ?? (await options.readSettings()).activePackId ?? null
      if (!packId) return { ...EMPTY_RUNTIME }
      return manager.stopPack(packId)
    },
    async startPack(packId) {
      const controller = controllerFor(packId)
      try {
        const started = await controller.start()
        if (started.running) {
          // instances.json 只记「上次是谁起的」当提示，真相仍由端口探测决定。
          table.set(packId, {
            ...table.get(packId),
            port: ports.get(packId) ?? table.get(packId)?.port,
            pid: started.pid ?? undefined,
            startedAt: started.startedAt ?? new Date().toISOString(),
          })
          void saveTable()
        }
        return started
      } finally {
        await emitInstances()
      }
    },
    async stopPack(packId) {
      const controller = controllers.get(packId)
      const state = states.get(packId)
      try {
        // 同一次启动器会话起起来的：句柄还在，走正常停止（会恢复凭据备份等）。
        if (controller && state?.running) return await controller.stop()
        // 启动器重启过 / 实例不是这次起的：没有句柄，按探测到的 PID 结束整棵树。
        const pid = probes.get(packId)?.pid ?? table.get(packId)?.pid ?? null
        const entry = table.get(packId)
        if (entry?.pid !== undefined) {
          entry.pid = undefined
          entry.startedAt = undefined
          void saveTable()
        }
        if (pid) {
          const killed = await killProcessTreeByPid(pid)
          probes.set(packId, { running: false, pid: null, url: null, resolvedAt: Date.now() })
          options.emitOutput(packId, killed ? 'info' : 'error',
            killed ? `已结束实例进程（PID ${pid}）。` : `结束 PID ${pid} 失败：它可能已经退出。`)
        }
        return states.get(packId) ?? { ...EMPTY_RUNTIME, packId }
      } finally {
        await emitInstances()
      }
    },
    async markActive(packId) {
      activePackId = packId
      await options.activatePack?.(packId).catch(() => undefined)
      await emitInstances()
    },
    async stopAll() {
      const running = [...controllers.entries()].filter(([packId]) => states.get(packId)?.running === true)
      await Promise.all(running.map(([, controller]) => controller.stop().catch(() => undefined)))
    },
    /**
     * 首页端口卡：改的是**这个包自己的端口**，写进 instances.json 后再广播快照。
     * 旧实现写全局 settings.webPort，而 resolvePort 优先读表 —— 数字下一次广播就弹回旧值。
     */
    async setPort(packId, port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 之间的整数。')
      await loadTable()
      if (manager.isPackRunning(packId)) {
        throw new Error(`「${await packName(packId)}」正在运行：先停止实例，再改端口。`)
      }
      if (assignedPortsExcept(packId).has(port)) {
        const ownerId = [...table.entries()].find(([id, entry]) => id !== packId && entry.port === port)?.[0]
          ?? [...ports.entries()].find(([id, value]) => id !== packId && value === port)?.[0]
        throw new Error(`端口 ${port} 已被整合包「${ownerId ? await packName(ownerId) : '其它整合包'}」占用，换一个。`)
      }
      ports.set(packId, port)
      table.set(packId, { ...table.get(packId), port })
      await saveTable()
      await emitInstances()
      return snapshots
    },
    async assignedPorts() {
      await loadTable()
      return [...assignedPortsExcept()]
    },
    // 界面拿状态就这一条：读主进程内存里的快照（3s 定时器维护），不在这里跑任何探测。
    list: () => snapshots,
    listAsync: async () => (snapshots.length > 0 ? snapshots : syncAndEmit()),
    trackedPids,
    isPackRunning: packId => probes.get(packId)?.running ?? states.get(packId)?.running === true,
    refreshSnapshots: () => emitInstances(),
    probeNow: () => syncAndEmit(),
  }

  void options.readSettings().then(settings => {
    if (!activePackId) activePackId = settings.activePackId ?? null
  }).catch(() => undefined)

  // 冷启动第一轮：先把已经在自己跑的实例探出来（启动器退出过，它们还在）。
  void syncAndEmit().catch(() => undefined)
  probeTimer = setInterval(() => { void syncAndEmit().catch(() => undefined) }, PROBE_INTERVAL_MS)
  probeTimer.unref?.()

  return manager
}
