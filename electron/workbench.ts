// 装配工作台：把离线整合包（vendor/*.tgz + manifest.json）里的插件逐个装进「干净家目录」，
// 启动实例 → 停止 → 卸载 → 再启动，用目录项快照逐项核对「卸载是否对称」，残留逐项回滚。
//
// 为什么要有它：导出的整合包能不能在另一台机器装配起来，光看清单不算数——必须真的装一次、
// 起一次、卸一次，再确认没有这个插件时实例照样起得来，并且卸载把装进去的东西原样还回去。
//
// 硬约定（与启动器其余部分一致）：
//   1) 无窗口：所有子进程 windowsHide:true；不弹任何对话框、不开浏览器。
//   2) 只按 PID 杀进程：taskkill /pid <id> /f。**绝不加 /t**（那会连子孙进程一起带走），
//      也不按映像名杀（会误杀别人的实例）。所以内核必须用 node.exe 直跑，不能经 cmd 外壳——
//      经 cmd 时 PID 是 cmd 的，只杀 cmd 会留下 node 继续占端口（实测过）。
//   3) 不碰用户真实实例：源家目录只读；内核用 junction 指过去；写入全部落在本次运行目录。
//   4) 全程不出网：只解本地 tgz、只起本地进程，不调 pnpm / npm / registry。
//
// 纯 Node（不 import electron），便于 vitest 直接跑；Electron 只负责命令行入口与 path 解析。

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { appendFile, copyFile, lstat, mkdir, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findSystemNodeRuntime } from './node-runtime'
import { readOfflineManifest, type OfflineManifest } from './pack-offline-export'
import { readTarGz } from './tar-archive'
import { findAvailableWebPort, isLoopbackPortAvailable } from './runtime'

/** 噪声目录：实例运行时自己会不断写，不参与「装/卸是否对称」的判定（顶层目录名）。 */
export const WORKBENCH_NOISE_DIRS: readonly string[] = ['logs', 'cache', 'sessions', 'rewind-snapshots']
/** 干净家目录的基础组合：只有 DSH 的 core 两个 bundle，插件一个一个往上装。 */
export const WORKBENCH_CORE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
export const WORKBENCH_BODIES_DIRNAME = '.dsh-launcher-plugin-bodies'
export const WORKBENCH_STATUS_FILENAME = 'status.json'
export const WORKBENCH_EVENTS_FILENAME = 'events.jsonl'
export const WORKBENCH_VERDICT_FILENAME = 'verdict.json'
/** profile 的用户补丁层：个别插件（dsh-free-search）启动时会把自己的条目写进来。 */
export const WORKBENCH_PROFILE_GATE = 'cordis.patch.yml'
/** 独立端口段：装配实例绝不去抢 3080/3500/4000 那些日常实例的端口。 */
export const WORKBENCH_PORT_BASE = 39100
const DEFAULT_TIMEOUT_MS = 120_000
/** 就绪后要求连续稳定这么久才算「起来了」，防刚打印地址就崩。 */
const DEFAULT_STABILITY_MS = 1_500
const OUTPUT_LIMIT = 16_000
/** 启动失败/成功时写进事件里的诊断尾巴。 */
const EVENT_OUTPUT_LIMIT = 2_000
/** 唯一运行目录的重试次数（同一秒内连跑）。 */
const RUN_DIR_ATTEMPTS = 100

/** 契约里的三个文件都从这里取名字，任一改动必须先改契约。 */
export type WorkbenchPhase =
  | 'start'
  | 'blocked'
  | 'prepare'
  | 'boot'
  | 'install'
  | 'uninstall'
  | 'compare'
  | 'restore'
  | 'done'
  | 'failed'

export type WorkbenchEventKind =
  | 'start'
  | 'slot-lock'
  | 'kernel-check'
  | 'snapshot'
  | 'install'
  | 'boot'
  | 'stop'
  | 'uninstall'
  | 'compare'
  | 'verdict'

export interface WorkbenchKernelState {
  version: string | null
  state: 'ok' | 'missing'
}

/** status.json。reason 只在阻塞/失败时非空（UI 直接显示这一行）。 */
export interface WorkbenchStatusFile {
  phase: WorkbenchPhase
  kernel: WorkbenchKernelState
  passed: string[]
  current: string | null
  startedAt: string
  reason: string | null
}

/**
 * 一条装配结论的三档定性：
 *   ok     —— 本体干净、能起、能卸、组合复原；
 *   dirty  —— 本体或 profile 门控留有未撤销的改动（会进包、或污染下一次装配）→ 唯一算不合格的一档；
 *   writes —— 只写了运行期用户数据（home 根下的自有目录 / json），不进包、不影响下一次装配 → 不影响合格。
 * 为什么要分：openai-gateway/、our-free-model/、.dsh-market/ 这类是插件运行时故意落盘的
 * 用户数据，导出只取 .dsh-launcher-plugin-bodies/<name>，它们根本不会进包；把它们算成
 * 「装配不合格」会把真正的还原缺陷淹掉。
 */
export type WorkbenchClass = 'ok' | 'dirty' | 'writes'

/** verdict.json 的一条。reason 是给人看的一句话，必须能指出是哪一步没过。 */
export interface WorkbenchVerdict {
  name: string
  ok: boolean
  /** ok / dirty / writes 三档；ok 与 writes 都不影响「合格」。 */
  class: WorkbenchClass
  reason: string
}

export interface WorkbenchEvent {
  ts: string
  kind: WorkbenchEventKind
  [key: string]: unknown
}

export interface WorkbenchOptions {
  /** 离线整合包目录：vendor/*.tgz（manifest.json 可选，给了就用它的 installOrder）。 */
  packDir: string
  /** 源实例家目录：只读，只取内核树（profiles/node_modules）；里面的用户数据一概不碰。 */
  sourceHome: string
  /** 只装配指定插件；不传 = 全部（按 installOrder / 名字序）。 */
  plugin?: string | null
  /** 源实例里的 profile 目录名；不传就按 profile.yaml 优先挑。 */
  profileId?: string | null
  /** workbench-<时间戳>/ 落在哪个父目录。 */
  runRoot: string
  /** 跑内核用的 node.exe；不传就找系统 Node。 */
  nodeExecutable?: string | null
  /** 单次启动等就绪的上限。 */
  timeoutMs?: number
  stabilityMs?: number
  portBase?: number
  /** 测试注入：把「起一次实例」换掉（默认真的 spawn + 等端口 + taskkill）。 */
  boot?: BootRunner
  /** 测试注入：把「读组合树」换掉（默认 dsh --dump-config）。 */
  compose?: ComposeRunner
  /** 人看的进度行（CLI 直接写 stdout）。 */
  onOutput?: (line: string) => void
}

export interface WorkbenchRunResult {
  /** 0 = 全部合格；1 = 有插件不合格；2 = 装配没起来（槽位占用 / 缺件 / 参数错）。 */
  exitCode: number
  runDir: string | null
  verdicts: WorkbenchVerdict[]
}

// ---------------------------------------------------------------------------
// 快照：目录项级别（名字 + 类型 + 文件大小），不读内容

export interface SnapshotEntry {
  /** 相对家目录的路径，正斜杠。 */
  path: string
  kind: 'file' | 'dir' | 'link'
  /** 只有 file 有意义；extras 比较只靠它，绝不读内容。 */
  size: number
}

function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

function depthOf(relative: string): number {
  return relative.split('/').length
}

/**
 * 快照一个家目录。噪声目录（顶层 logs/cache/sessions/rewind-snapshots）整棵跳过；
 * junction / symlink 只记一条 link，不跟进去（内核树是 942MB 的 junction，跟进去就是灾难）。
 */
export async function snapshotHome(home: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let children: import('node:fs').Dirent[]
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (!prefix && WORKBENCH_NOISE_DIRS.includes(child.name)) continue
      const relative = prefix ? prefix + '/' + child.name : child.name
      const full = path.join(directory, child.name)
      // Dirent 对 Windows junction 不可靠，统一用 lstat 判类型。
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        entries.push({ path: relative, kind: 'link', size: 0 })
        continue
      }
      if (info.isDirectory()) {
        entries.push({ path: relative, kind: 'dir', size: 0 })
        await walk(full, relative)
        continue
      }
      if (info.isFile()) entries.push({ path: relative, kind: 'file', size: info.size })
    }
  }
  await walk(home, '')
  return entries.sort(byPath)
}

export interface HomeDiff {
  /** 卸载后多出来的东西：残留。空目录也算。 */
  added: SnapshotEntry[]
  /** 卸载后少掉的东西：比残留危险，通常是安装器改坏了原有文件。 */
  removed: SnapshotEntry[]
  /** 两边都在、但大小变了（只对 extras 计费，其它文件的内容变化是实例自己的事）。 */
  sizeChanged: SnapshotEntry[]
}

/**
 * 对比快照。
 * 只有 extras/ 下的文件比较大小（用户自己放进去的附件）；其它目录只比「在不在」——
 * cordis.yml / .credentials.yaml / storages 这类文件每次启动都会被实例重写，比大小必然误报。
 * attachments/ 是对话上传的私有数据（本机 920MB）：工作台既不建也不读，压根不出现。
 */
export function compareHome(baseline: SnapshotEntry[], current: SnapshotEntry[]): HomeDiff {
  const before = new Map(baseline.map(entry => [entry.path, entry]))
  const after = new Map(current.map(entry => [entry.path, entry]))
  const added: SnapshotEntry[] = []
  const removed: SnapshotEntry[] = []
  const sizeChanged: SnapshotEntry[] = []
  for (const entry of current) {
    const previous = before.get(entry.path)
    if (!previous) {
      added.push(entry)
      continue
    }
    if (
      entry.path.startsWith('extras/') &&
      entry.kind === 'file' &&
      previous.kind === 'file' &&
      entry.size !== previous.size
    ) {
      sizeChanged.push(entry)
    }
  }
  for (const entry of baseline) if (!after.has(entry.path)) removed.push(entry)
  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    sizeChanged: sizeChanged.sort(byPath),
  }
}

/** 残留判定：多出来的条目 + 少掉的条目 + extras 大小变化。 */
export function residueCount(diff: HomeDiff): number {
  return diff.added.length + diff.removed.length + diff.sizeChanged.length
}

/** 装配场地：这些路径里的东西属于「插件本体 / profile 门控」，未撤销就是 dirty。 */
function isPluginScope(relative: string, profileId: string): boolean {
  const prefix = 'profiles/' + profileId + '/'
  if (!relative.startsWith(prefix)) return false
  const rest = relative.slice(prefix.length)
  return rest === 'package.json'
    || rest === 'profile.yaml'
    // 门控补丁也是 profile 门控的一部分：插件启动时内核会把它的 bundle.patch 合并进去，
    // 卸载没撤掉就是「污染下一次装配」，必须算 dirty 而不是 writes。
    || rest === WORKBENCH_PROFILE_GATE
    || rest.startsWith(WORKBENCH_BODIES_DIRNAME + '/')
    || rest.startsWith('node_modules/')
}

/**
 * 把差异分成两堆：
 *   dirty  —— 插件本体 / profile 门控（node_modules、bodies、package.json、profile.yaml）
 *             还有没撤掉的改动。会进包、会污染下一次装配，只有这堆算不合格。
 *   writes —— 插件运行期写下的用户数据（home 根下的自有目录、json 等）。
 *             导出只取 bodies/<name>，这些不进包，所以不影响合格，报告里列出来就行。
 * 少掉的东西（removed）一律算 dirty：那是安装器把原有文件弄没了，比残留严重。
 * extras 下的文件大小变化算 writes：那是用户自己的附件被动了，值得看一眼但不是装配缺陷。
 */
export function classifyResidue(
  diff: HomeDiff,
  profileId: string,
): { dirty: string[]; writes: string[] } {
  const dirty: string[] = []
  const writes: string[] = []
  for (const entry of diff.added) (isPluginScope(entry.path, profileId) ? dirty : writes).push(entry.path)
  for (const entry of diff.removed) dirty.push('缺:' + entry.path)
  for (const entry of diff.sizeChanged) writes.push(entry.path)
  return { dirty: dirty.sort(), writes: writes.sort() }
}

export interface RestoreOutcome {
  removed: string[]
  restored: string[]
  failed: Array<{ path: string; reason: string }>
}

/**
 * 逐项反向回滚：多出来的删掉（深的先删），少掉的从装配前的基线副本里抄回来。
 * 删除链接/目录时先 lstat：junction 只 unlink 自己，绝不递归进目标（那是源实例的内核树）。
 */
export async function restoreHome(
  home: string,
  diff: HomeDiff,
  options: { backupDir?: string } = {},
): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = { removed: [], restored: [], failed: [] }
  const addedDeepestFirst = [...diff.added].sort((left, right) => depthOf(right.path) - depthOf(left.path))
  for (const entry of addedDeepestFirst) {
    const target = path.join(home, ...entry.path.split('/'))
    try {
      const info = await lstat(target).catch(() => null)
      if (!info) {
        // 父目录已经被删掉了，这一项自然不存在。
        outcome.removed.push(entry.path)
        continue
      }
      if (info.isSymbolicLink() || info.isFile()) await unlink(target)
      else await rm(target, { recursive: true, force: true })
      outcome.removed.push(entry.path)
    } catch (error) {
      outcome.failed.push({ path: entry.path, reason: errorText(error) })
    }
  }
  const removedShallowestFirst = [...diff.removed].sort((left, right) => depthOf(left.path) - depthOf(right.path))
  for (const entry of removedShallowestFirst) {
    const target = path.join(home, ...entry.path.split('/'))
    const backup = options.backupDir ? path.join(options.backupDir, ...entry.path.split('/')) : null
    try {
      if (entry.kind === 'link') {
        // 基线副本不存链接；真的丢了链接只能在报告里说清楚，不能瞎连一个。
        outcome.failed.push({ path: entry.path, reason: '链接无法从基线副本还原' })
        continue
      }
      if (entry.kind === 'dir') {
        await mkdir(target, { recursive: true })
        outcome.restored.push(entry.path)
        continue
      }
      if (!backup) {
        outcome.failed.push({ path: entry.path, reason: '没有基线副本，无法还原文件' })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(backup, target)
      outcome.restored.push(entry.path)
    } catch (error) {
      outcome.failed.push({ path: entry.path, reason: errorText(error) })
    }
  }
  return outcome
}

// ---------------------------------------------------------------------------
// 槽位：全局唯一装配槽（第二个请求直接退出码 2，不排队）

interface SlotHandle {
  ok: true
  release: () => Promise<void>
}
interface SlotBusy {
  ok: false
  message: string
}

/** 超过这么久没释放就按陈旧锁接管：够长到不会打断一次正常装配（单插件约 1 分钟），
 *  又短到不会让一次崩溃锁死这台机器一整天。 */
export const SLOT_STALE_MS = 2 * 60 * 60 * 1000

/**
 * 槽位锁文件放在 runRoot 下：workbench.lock。
 * 用 open(..., 'wx') 做原子抢锁；抢不到就读出持有者 PID 与开始时间：
 *   - PID 已经死了（上次被强杀 / 蓝屏）→ 陈旧锁，直接接管；
 *   - PID 还活着但锁已经超过 SLOT_STALE_MS → 也按陈旧处理（PID 被复用或进程挂死）。
 * 抢占前必须把旧锁文件删掉再重抢，不能只覆盖（两个进程可能同时抢）。
 * ponytail: 没有心跳续期；一个真的跑了 2 小时以上的装配会被后来者抢走。
 * 真需要时改成「持锁进程每 30s 刷 mtime，接管前检查 mtime 而不是 startedAt」。
 */
export async function acquireSlot(runRoot: string): Promise<SlotHandle | SlotBusy> {
  const lockPath = path.join(runRoot, 'workbench.lock')
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(payload, 'utf8')
      } finally {
        await handle.close()
      }
      return {
        ok: true,
        release: async () => {
          const holder = await readSlotHolder(lockPath)
          if (holder?.pid === process.pid) await rm(lockPath, { force: true }).catch(() => undefined)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = await readSlotHolder(lockPath)
      if (holder !== null && !isStaleSlot(holder)) {
        return { ok: false, message: '槽位被占用（PID ' + holder.pid + '，开始于 ' + (holder.startedAt ?? '未知') + '），本次不排队。' }
      }
      // 陈旧锁（持有者已死 / 超时）：删掉再抢一次。
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }
  return { ok: false, message: '槽位被占用（清掉僵尸锁后仍抢不到），本次不排队。' }
}

async function readSlotHolder(lockPath: string): Promise<{ pid: number; startedAt: string | null } | null> {
  const text = await readFile(lockPath, 'utf8').catch(() => null)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown }
    if (typeof parsed.pid !== 'number') return null
    return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null }
  } catch {
    return null
  }
}

export function isStaleSlot(holder: { pid: number; startedAt: string | null }, now = Date.now()): boolean {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return true
  if (!isProcessAlive(holder.pid)) return true
  if (!holder.startedAt) return false
  const startedMs = Date.parse(holder.startedAt)
  return Number.isFinite(startedMs) ? now - startedMs > SLOT_STALE_MS : false
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但不归我们管。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// 内核与插件（前置四件中的两件）

export interface KernelCheck {
  version: string | null
  state: 'ok' | 'missing'
  /** profiles/node_modules（内核树根）。 */
  modules: string
  /** 内核入口脚本（node 直跑用）。 */
  entry: string | null
  /** 跑内核用的 node.exe。 */
  node: string | null
  detail: string
}

/** 检查源实例的内核：profiles/node_modules + @deepseek-ai/dsh/lib/bin.js + 版本号 + 可用的 node。 */
export async function inspectKernel(sourceHome: string, nodeExecutable?: string | null): Promise<KernelCheck> {
  const modules = path.join(sourceHome, 'profiles', 'node_modules')
  const entry = path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const node = nodeExecutable ?? findSystemNodeRuntime()?.node ?? null
  const entryInfo = await lstat(entry).catch(() => null)
  const modulesInfo = await lstat(modules).catch(() => null)
  let version: string | null = null
  try {
    const manifest = JSON.parse(await readFile(path.join(modules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    version = typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    version = null
  }
  if (!modulesInfo || !modulesInfo.isDirectory()) {
    return { version, state: 'missing', modules, entry: null, node, detail: 'profiles/node_modules 不存在（内核树缺失）' }
  }
  if (!entryInfo || !entryInfo.isFile()) {
    return { version, state: 'missing', modules, entry: null, node, detail: '@deepseek-ai/dsh/lib/bin.js 不存在（内核入口缺失）' }
  }
  return {
    version,
    state: 'ok',
    modules,
    entry,
    node,
    detail: '内核可用（' + (version ?? '版本未知') + (node ? '，node=' + node : '，未找到 node') + '）',
  }
}

export interface VendorPlugin {
  name: string
  version: string
  /** tgz 绝对路径。 */
  tgz: string
  /** package.json 的 main（诊断用）。 */
  entry: string | null
  /** 带 dsh.bundle.patch 才进 dsh.profile.bundles；纯 client 插件只建门控。 */
  hasBundle: boolean
}

export interface VendorScan {
  plugins: VendorPlugin[]
  manifest: OfflineManifest | null
  /** 扫描失败的原因（供前置检查报缺件）。 */
  problems: string[]
}

function stripPackagePrefix(archivePath: string): string {
  return archivePath.replace(/^\.?\/+/, '').replace(/^package\/+/, '')
}

/** 读 vendor/*.tgz。每个包只解析包内 package.json，拿到包名/版本/入口/是否带组合补丁。 */
export async function listVendorPlugins(packDir: string): Promise<VendorScan> {
  const problems: string[] = []
  const vendorDir = path.join(packDir, 'vendor')
  const vendorInfo = await lstat(vendorDir).catch(() => null)
  if (!vendorInfo || !vendorInfo.isDirectory()) {
    return { plugins: [], manifest: null, problems: ['vendor/ 目录不存在：' + vendorDir] }
  }
  let manifest: OfflineManifest | null = null
  try {
    manifest = await readOfflineManifest(packDir)
  } catch (error) {
    // manifest 是可选的：没有就从 tgz 自己读包名。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push('manifest.json 读不了：' + errorText(error))
  }
  const plugins: VendorPlugin[] = []
  for (const file of await readdir(vendorDir)) {
    if (!/\.tgz$/i.test(file)) continue
    const tgz = path.join(vendorDir, file)
    try {
      const entries = readTarGz(await readFile(tgz))
      const manifestEntry = entries.find(item => stripPackagePrefix(item.path) === 'package.json' && item.type === 'file')
      if (!manifestEntry) {
        problems.push(file + ' 里没有 package.json')
        continue
      }
      const parsed = JSON.parse(manifestEntry.data.toString('utf8')) as {
        name?: unknown
        version?: unknown
        main?: unknown
        dsh?: { bundle?: unknown }
      }
      if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
        problems.push(file + ' 的 package.json 没有 name')
        continue
      }
      plugins.push({
        name: parsed.name,
        version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
        tgz,
        entry: typeof parsed.main === 'string' ? parsed.main : null,
        hasBundle: typeof parsed.dsh?.bundle === 'object' && parsed.dsh.bundle !== null,
      })
    } catch (error) {
      problems.push(file + ' 解不开：' + errorText(error))
    }
  }
  plugins.sort((left, right) => left.name.localeCompare(right.name))
  return { plugins, manifest, problems }
}

/** 按 manifest.installOrder 排（没有就按名字），再按 --plugin 过滤。 */
export function selectPlugins(scan: VendorScan, wanted?: string | null): VendorPlugin[] {
  const byName = new Map(scan.plugins.map(plugin => [plugin.name, plugin]))
  const ordered: VendorPlugin[] = []
  for (const name of scan.manifest?.installOrder ?? []) {
    const plugin = byName.get(name)
    if (plugin) {
      ordered.push(plugin)
      byName.delete(name)
    }
  }
  ordered.push(...[...byName.values()].sort((left, right) => left.name.localeCompare(right.name)))
  if (!wanted) return ordered
  return ordered.filter(plugin => plugin.name === wanted)
}

// ---------------------------------------------------------------------------
// 干净家目录 + 装/卸

/** 源 profile 目录名：profile.yaml 所在 > 唯一子目录 > 包 id。 */
export async function resolveProfileId(sourceHome: string, packId?: string): Promise<string | null> {
  const profilesDir = path.join(sourceHome, 'profiles')
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => [])
  const candidates = entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
  if (candidates.length === 0) return null
  for (const candidate of candidates) {
    const info = await lstat(path.join(profilesDir, candidate.name, 'profile.yaml')).catch(() => null)
    if (info?.isFile()) return candidate.name
  }
  if (packId && candidates.some(candidate => candidate.name === packId)) return packId
  return candidates.length === 1 ? candidates[0]!.name : null
}

export interface CleanHome {
  home: string
  profileId: string
  profileDir: string
  modules: string
  extras: string
}

/**
 * 建干净家目录：内核树用 junction 指到源实例，profile 只写一份最小清单。
 * 内核必须在第一次快照之前建好——否则它会被当成「装插件装出来的」。
 *
 * 附件：用户说的「附件」是 extras/（自己放的额外东西，通常为空），只建一个空目录。
 * 不是 attachments/——那是对话上传的图片和文档（私有数据，本机 920MB），
 * 工作台既不建也不读，绝不让插件写进用户真实数据。
 * 附件也不参与依赖解析：插件解析走 插件自身 node_modules → profiles/<id>/node_modules
 * → profiles/node_modules → 内核，跟 extras 无关。
 */
export async function buildCleanHome(options: {
  home: string
  sourceHome: string
  profileId: string
  kernelModules: string
}): Promise<CleanHome> {
  const home = options.home
  const profilesDir = path.join(home, 'profiles')
  const profileDir = path.join(profilesDir, options.profileId)
  await mkdir(profileDir, { recursive: true })
  // 这两个目录是「装配场地」的一部分，先建好进基线：它们由第一次装插件才会产生，
  // 不预建的话每卸一个插件都会留下两个空目录，被当成残留（实测就是这么报的）。
  await mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  await mkdir(path.join(profileDir, WORKBENCH_BODIES_DIRNAME), { recursive: true })
  await symlink(options.kernelModules, path.join(profilesDir, 'node_modules'), 'junction')
  const extras = path.join(home, 'extras')
  await mkdir(extras, { recursive: true })
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-' + options.profileId,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WORKBENCH_CORE_BUNDLES] } },
    }, null, 2) + '\n',
    'utf8',
  )
  const sourceVersion = await readFile(path.join(options.sourceHome, 'profiles', options.profileId, 'profile.yaml'), 'utf8')
    .then(text => /^dshVersion:\s*['"]?([^'"\s#]+)/m.exec(text)?.[1] ?? null)
    .catch(() => null)
  await writeFile(
    path.join(profileDir, 'profile.yaml'),
    ['name: workbench-' + options.profileId, 'description: ""', 'dshVersion: ' + (sourceVersion ?? '0.0.0'), 'source: null'].join('\n') + '\n',
    'utf8',
  )
  return { home, profileId: options.profileId, profileDir, modules: options.kernelModules, extras }
}

export interface InstallRecord {
  bodyDir: string
  gatePath: string
  addedBundle: boolean
}

/** 装一个插件：解 tgz 到 .dsh-launcher-plugin-bodies/<name>，建门控 junction，改 profile 清单。 */
export async function installPlugin(profileDir: string, plugin: VendorPlugin): Promise<InstallRecord> {
  const nameParts = plugin.name.split('/')
  const bodyDir = path.join(profileDir, WORKBENCH_BODIES_DIRNAME, ...nameParts)
  await rm(bodyDir, { recursive: true, force: true })
  await mkdir(bodyDir, { recursive: true })
  const archive = readTarGz(await readFile(plugin.tgz))
  const root = path.resolve(bodyDir)
  for (const entry of archive) {
    const relative = stripPackagePrefix(entry.path)
    if (!relative) continue
    const target = path.resolve(path.join(bodyDir, relative))
    // zip-slip / tar-slip：归档里的路径不许跳出本体目录。
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('归档路径越界：' + entry.path)
    }
    if (entry.type === 'directory') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }
  const gatePath = path.join(profileDir, 'node_modules', ...nameParts)
  await mkdir(path.dirname(gatePath), { recursive: true })
  await rm(gatePath, { recursive: true, force: true }).catch(() => undefined)
  await symlink(bodyDir, gatePath, 'junction')
  const addedBundle = await editProfileManifest(profileDir, plugin, 'install')
  return { bodyDir, gatePath, addedBundle }
}

/** 卸一个插件：删门控、删本体、把清单改回原样（空的 scope 目录也一并收掉）。 */
export async function uninstallPlugin(profileDir: string, plugin: VendorPlugin): Promise<void> {
  const nameParts = plugin.name.split('/')
  const gatePath = path.join(profileDir, 'node_modules', ...nameParts)
  const bodyDir = path.join(profileDir, WORKBENCH_BODIES_DIRNAME, ...nameParts)
  await rm(gatePath, { recursive: true, force: true }).catch(() => undefined)
  await rm(bodyDir, { recursive: true, force: true }).catch(() => undefined)
  // scope 目录（@scope/）是安装时顺手建出来的，卸载要一起收掉，否则就是一个空目录残留。
  if (nameParts.length > 1) {
    await removeIfEmpty(path.dirname(gatePath))
    await removeIfEmpty(path.dirname(bodyDir))
  }
  await editProfileManifest(profileDir, plugin, 'uninstall')
}

/**
 * 卸载后把 profile 的用户补丁层（cordis.patch.yml）复原到「装之前」的样子。
 *
 * 为什么必须有这一步：有的插件在启动时把自己的条目写进这个文件（dsh-free-search 就把
 * web-search-free 的 config 写在这里，那是它保存设置的方式）。删本体和门控都带不走它，
 * 结果就是两件坏事：①被算成「卸载残留」；②下一次装配带着一条指向已删除插件的补丁。
 *
 * 干净 home 的基线是已知的，所以按「原来没有就删掉、原来有就写回原文」处理——比逐条
 * parse YAML 再按名字抠掉安全（YAML 里有 !!js 表达式和嵌套 insert，文本匹配很容易切错块）。
 * ponytail: 只在工作台自己的干净 home 里这么做；真实实例里要保留用户其它补丁，
 * 那时得换成「按 id/name 定位条目再删」的 YAML 级编辑。
 */
export async function restoreProfileGate(
  profileDir: string,
  baseline: string | null,
): Promise<'deleted' | 'restored' | 'unchanged'> {
  const gatePath = path.join(profileDir, WORKBENCH_PROFILE_GATE)
  const current = await readFile(gatePath, 'utf8').catch(() => null)
  if (baseline === null) {
    if (current === null) return 'unchanged'
    await rm(gatePath, { force: true })
    return 'deleted'
  }
  if (current === baseline) return 'unchanged'
  await writeFile(gatePath, baseline, 'utf8')
  return 'restored'
}

async function removeIfEmpty(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => null)
  if (entries && entries.length === 0) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

async function editProfileManifest(
  profileDir: string,
  plugin: VendorPlugin,
  action: 'install' | 'uninstall',
): Promise<boolean> {
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProfileManifest
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  let addedBundle = false
  if (action === 'install') {
    dependencies[plugin.name] = 'file:./' + WORKBENCH_BODIES_DIRNAME + '/' + plugin.name
    manifest.dependencies = dependencies
    if (plugin.hasBundle && !bundles.includes(plugin.name)) {
      bundles.push(plugin.name)
      addBundle(manifest, bundles)
      addedBundle = true
    }
  } else {
    delete dependencies[plugin.name]
    manifest.dependencies = dependencies
    addBundle(manifest, bundles.filter(name => name !== plugin.name))
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return addedBundle
}

function addBundle(manifest: ProfileManifest, bundles: string[]): void {
  const profile = manifest.dsh?.profile ?? {}
  profile.bundles = bundles
  manifest.dsh = { ...manifest.dsh, profile }
}

export interface ComposeContext {
  home: string
  profileId: string
  profileDir: string
  workspace: string
  node: string | null
  kernelEntry: string | null
  timeoutMs: number
}

/**
 * 组合树文本：dsh --dump-config 按 package.json 的 dsh.profile.bundles 把每层 bundle
 * 补丁合成出来（插件自己的 patch 也在里面）。只用来做「装前 / 装后 / 卸后」三份文本对比：
 * 装后必须和装前不同（插件真的进了组合），卸后必须回到装前那一份（组合也对称）。
 *
 * 为什么不看 profiles/<id>/cordis.yml：那是个固定模板（内容就是 [] + 注释），
 * 实测从头到尾不变，拿它判断插件有没有加载会永远判「没加载」。
 *
 * 返回 null = 判不了（没有 node / 内核拒绝 / 超时），调用方按「未知」处理，不判失败。
 */
export type ComposeRunner = (context: ComposeContext) => Promise<string | null>

const COMPOSE_TIMEOUT_MS = 60_000

export const dumpComposition: ComposeRunner = async context => {
  if (!context.node || !context.kernelEntry) return null
  const child = spawn(context.node, [context.kernelEntry, '--dump-config', '--profile', context.profileId], {
    cwd: context.workspace,
    env: {
      ...process.env,
      DSH_HOME: context.home,
      DSH_TELEMETRY_DISABLED: '1',
      NO_UPDATE_NOTIFIER: '1',
      FORCE_COLOR: '0',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  child.stderr?.on('data', () => undefined)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // 超时也只按 PID 杀（同样的规矩）。
    if (child.pid) void killByPid(child.pid)
  }, COMPOSE_TIMEOUT_MS)
  timer.unref?.()
  const code = await new Promise<number | null>(resolve => {
    child.once('exit', value => resolve(value))
    child.once('error', () => resolve(null))
  })
  clearTimeout(timer)
  if (timedOut) {
    await waitForExit(child, 5_000)
    return null
  }
  return code === 0 ? text : null
}

// ---------------------------------------------------------------------------
// 起一次实例（默认实现：node 直跑内核 → 等端口 → 按 PID 杀）

export interface BootContext {
  home: string
  profileId: string
  profileDir: string
  node: string | null
  kernelEntry: string | null
  port: number
  workspace: string
  timeoutMs: number
  stabilityMs: number
}

export interface BootResult {
  ok: boolean
  reason: string
  output: string
  pid: number | null
  readyMs: number | null
  portReleased: boolean
}

export type BootRunner = (context: BootContext) => Promise<BootResult>

function waitForExit(child: import('node:child_process').ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(), timeoutMs)
    const finish = (): void => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', finish)
    child.once('error', finish)
  })
}

/** 只按 PID 杀：不加 /t（不许连子孙），不按映像名（不许误杀别人的实例）。 */
async function killByPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已经退出了。
    }
    return
  }
  await new Promise<void>(resolve => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/f'], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      killer.kill()
      resolve()
    }, 10_000)
    const finish = (): void => {
      clearTimeout(timer)
      resolve()
    }
    killer.once('exit', finish)
    killer.once('error', finish)
  })
}

async function portAccepts(port: number, timeoutMs = 350): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (ready: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ready)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPortReleased(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isLoopbackPortAvailable(port)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return isLoopbackPortAvailable(port)
}

/**
 * 默认启动器：node.exe 直跑内核 bin.js。
 * 不经 cmd 外壳是硬要求——经外壳时拿到的 PID 是 cmd 的，taskkill 只杀 cmd，
 * node 继续占着端口（实测：杀完端口还在监听）。
 */
export const bootInstance: BootRunner = async context => {
  if (!context.node) {
    return { ok: false, reason: '找不到可用的 node.exe，无法启动内核', output: '', pid: null, readyMs: null, portReleased: true }
  }
  if (!context.kernelEntry) {
    return { ok: false, reason: '内核入口不存在，无法启动实例', output: '', pid: null, readyMs: null, portReleased: true }
  }
  const args = [context.kernelEntry, '--profile', context.profileId, '--no-open', '--port', String(context.port)]
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: context.home,
    DSH_TELEMETRY_DISABLED: '1',
    NO_UPDATE_NOTIFIER: '1',
    ACP_AUTO_UPDATE: '0',
    FORCE_COLOR: '0',
  }
  let output = ''
  const child = spawn(context.node, args, {
    cwd: context.workspace,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const startedAt = Date.now()
  let exited = false
  let exitCode: number | null = null
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  child.once('exit', code => {
    exited = true
    exitCode = code
  })
  child.once('error', error => {
    exited = true
    output = (output + '\n' + error.message).slice(-OUTPUT_LIMIT)
  })

  let readyMs: number | null = null
  let firstReadyAt: number | null = null
  const deadline = startedAt + context.timeoutMs
  let ok = false
  let reason = ''
  try {
    while (Date.now() < deadline) {
      if (exited) {
        reason = '实例在就绪前退出（代码 ' + (exitCode ?? '未知') + '）'
        break
      }
      const ready = await portAccepts(context.port)
      if (!ready) {
        firstReadyAt = null
      } else if (firstReadyAt === null) {
        firstReadyAt = Date.now()
      } else if (Date.now() - firstReadyAt >= context.stabilityMs) {
        readyMs = firstReadyAt - startedAt
        ok = true
        reason = '端口 ' + context.port + ' 已稳定监听'
        break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!ok && !reason) reason = '等待 ' + Math.round(context.timeoutMs / 1000) + ' 秒仍未就绪'
  } finally {
    const pid = child.pid ?? null
    if (pid) await killByPid(pid)
    await waitForExit(child, 10_000)
    const portReleased = await waitForPortReleased(context.port)
    if (!portReleased) output = (output + '\n[warn] 端口 ' + context.port + ' 在杀进程后仍被占用').slice(-OUTPUT_LIMIT)
    return { ok, reason, output, pid, readyMs, portReleased }
  }
}

// ---------------------------------------------------------------------------
// 命令行参数（纯函数，便于测试）

export interface WorkbenchCliOptions {
  packDir: string
  sourceHome: string | null
  plugin: string | null
  profileId: string | null
  runRoot: string | null
  nodeExecutable: string | null
  timeoutMs: number | null
}

export const WORKBENCH_USAGE = [
  '用法：<启动器> --workbench <离线整合包目录> [--home <实例家目录>] [--plugin <包名>] [--profile <profile 名>] [--out <运行目录父目录>] [--timeout <毫秒>] [--node <node.exe>]',
  '  整合包目录 → 含 vendor/*.tgz（可选 manifest.json）的目录',
  '  --home     → 源实例家目录（只读：内核树 + 附件）；缺省按 packs.json 里当前激活的整合包',
  '  --plugin   → 只装配这一个插件；缺省按 installOrder 全部（本轮只验证单个插件闭环）',
  '  退出码：0 全部合格 / 1 有插件不合格 / 2 装配没起来（槽位占用、缺件、参数错）',
].join('\n')

export function parseWorkbenchArgs(argv: string[]): { ok: true; value: WorkbenchCliOptions } | { ok: false; message: string } {
  const value: WorkbenchCliOptions = {
    packDir: '',
    sourceHome: null,
    plugin: null,
    profileId: null,
    runRoot: null,
    nodeExecutable: null,
    timeoutMs: null,
  }
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    const next = (): string => {
      index += 1
      const raw = argv[index]
      if (raw === undefined) throw new Error('参数 ' + token + ' 缺少取值')
      return raw
    }
    try {
      switch (token) {
        case '--home':
          value.sourceHome = next()
          break
        case '--plugin':
          value.plugin = next()
          break
        case '--profile':
          value.profileId = next()
          break
        case '--out':
          value.runRoot = next()
          break
        case '--node':
          value.nodeExecutable = next()
          break
        case '--timeout': {
          const raw = next()
          const parsed = Number(raw)
          if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, message: '--timeout 需要正整数毫秒：' + raw }
          value.timeoutMs = Math.floor(parsed)
          break
        }
        default:
          if (token.startsWith('-')) return { ok: false, message: '不认识的参数：' + token }
          positional.push(token)
      }
    } catch (error) {
      return { ok: false, message: errorText(error) }
    }
  }
  if (positional.length === 0) return { ok: false, message: '缺一个离线整合包目录参数。' }
  if (positional.length > 1) return { ok: false, message: '只接受一个整合包目录：' + positional.slice(1).join(' ') }
  value.packDir = positional[0]!
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// 主流程

interface RunFiles {
  status: string
  events: string
  verdict: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

async function createRunDirectory(runRoot: string): Promise<string> {
  const base = 'workbench-' + stamp(new Date())
  for (let attempt = 0; attempt < RUN_DIR_ATTEMPTS; attempt += 1) {
    const candidate = path.join(runRoot, attempt === 0 ? base : base + '-' + (attempt + 1))
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('建不出唯一的运行目录：' + runRoot)
}

/** 基线副本：只抄普通文件与目录，跳过链接；超过 4MB 的单文件不抄（附件不该被整份复制）。 */
async function copyForRestore(source: string, target: string): Promise<void> {
  const MAX_FILE_BYTES = 4 * 1024 * 1024
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!prefix && WORKBENCH_NOISE_DIRS.includes(child.name)) continue
      const relative = prefix ? prefix + '/' + child.name : child.name
      const from = path.join(directory, child.name)
      const to = path.join(target, ...relative.split('/'))
      const info = await lstat(from).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await mkdir(to, { recursive: true })
        await walk(from, relative)
        continue
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      await mkdir(path.dirname(to), { recursive: true })
      await copyFile(from, to)
    }
  }
  await mkdir(target, { recursive: true })
  await walk(source, '')
}

export async function runWorkbench(options: WorkbenchOptions): Promise<WorkbenchRunResult> {
  const startedAt = nowIso()
  const runRoot = path.resolve(options.runRoot)
  const sourceHome = path.resolve(options.sourceHome)
  const packDir = path.resolve(options.packDir)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stabilityMs = options.stabilityMs ?? DEFAULT_STABILITY_MS
  const boot = options.boot ?? bootInstance
  const compose = options.compose ?? dumpComposition
  const output = options.onOutput ?? (() => undefined)

  await mkdir(runRoot, { recursive: true })

  // ---- 1) 前置四件之一：槽位（唯一的全局资源，先抢）
  const slot = await acquireSlot(runRoot)
  if (!slot.ok) {
    output(slot.message)
    return { exitCode: 2, runDir: null, verdicts: [] }
  }

  let runDir: string | null = null
  try {
    runDir = await createRunDirectory(runRoot)
    const files: RunFiles = {
      status: path.join(runDir, WORKBENCH_STATUS_FILENAME),
      events: path.join(runDir, WORKBENCH_EVENTS_FILENAME),
      verdict: path.join(runDir, WORKBENCH_VERDICT_FILENAME),
    }
    const status: WorkbenchStatusFile = {
      phase: 'start',
      kernel: { version: null, state: 'missing' },
      passed: [],
      current: null,
      startedAt,
      reason: null,
    }
    const writeStatus = async (): Promise<void> => {
      await writeFile(files.status, JSON.stringify(status, null, 2) + '\n', 'utf8')
    }
    const emit = async (kind: WorkbenchEventKind, fields: Record<string, unknown> = {}): Promise<void> => {
      const event: WorkbenchEvent = { ts: nowIso(), kind, ...fields }
      await appendFile(files.events, JSON.stringify(event) + '\n', 'utf8')
    }
    const setPhase = async (phase: WorkbenchPhase, reason: string | null = null): Promise<void> => {
      status.phase = phase
      status.reason = reason
      await writeStatus()
    }
    const finishBlocked = async (missing: string[], reason: string): Promise<WorkbenchRunResult> => {
      await setPhase('blocked', reason)
      await emit('verdict', { blocked: true, missing, reason })
      await writeFile(files.verdict, '[]\n', 'utf8')
      output(reason)
      return { exitCode: 2, runDir, verdicts: [] }
    }

    await writeStatus()
    await emit('slot-lock', { pid: process.pid, runDir })
    output('装配工作台：' + runDir)

    // ---- 2) 前置检查：槽位 / 内核 / 插件 / 附件文件夹（extras/，缺一件就报清楚，不跑到一半才炸）
    const kernel = await inspectKernel(sourceHome, options.nodeExecutable)
    status.kernel = { version: kernel.version, state: kernel.state }
    const scan = await listVendorPlugins(packDir)
    const wanted = options.plugin ?? null
    const selected = selectPlugins(scan, wanted)
    // 附件 = extras/（用户自己放的额外东西，可以为空）。attachments/ 是对话上传的私有数据，
    // 与装配无关，连存在性都不查——不碰就是不碰。
    const extrasPath = path.join(sourceHome, 'extras')
    const extrasInfo = await lstat(extrasPath).catch(() => null)
    const extrasOk = extrasInfo !== null && extrasInfo.isDirectory()
    const profileId = options.profileId ?? await resolveProfileId(sourceHome, path.basename(sourceHome))
    const checks = {
      slot: { ok: true, detail: '已获得槽位（PID ' + process.pid + '）' },
      kernel: { ok: kernel.state === 'ok', detail: kernel.detail },
      plugin: {
        ok: scan.problems.length === 0 && selected.length > 0,
        detail: selected.length > 0
          ? '找到 ' + selected.length + ' 个插件（vendor 下共 ' + scan.plugins.length + ' 个 tgz）'
          : '插件缺失：' + (scan.problems[0] ?? (wanted ? 'vendor 里没有 ' + wanted : 'vendor/*.tgz 为空')),
      },
      extras: {
        ok: extrasOk,
        detail: extrasOk ? '附件文件夹存在：' + extrasPath + '（可以为空）' : '附件文件夹缺失：' + extrasPath,
      },
      profile: {
        ok: profileId !== null,
        detail: profileId ? 'profile：' + profileId : '源实例下找不到可用的 profile 目录（profiles/<id>/profile.yaml）',
      },
    }
    await emit('start', {
      packDir,
      sourceHome,
      runDir,
      plugin: wanted,
      profileId,
      startedAt,
      details: checks,
    })
    await emit('kernel-check', {
      version: kernel.version,
      state: kernel.state,
      modules: kernel.modules,
      entry: kernel.entry,
      node: kernel.node,
      detail: kernel.detail,
    })
    output('内核：' + kernel.detail)
    const missing = Object.entries(checks).filter(([, value]) => !value.ok).map(([name]) => name)
    if (missing.length > 0) {
      const labels: Record<string, string> = { slot: '槽位', kernel: '内核', plugin: '插件', extras: '附件文件夹', profile: 'profile' }
      const reasons = missing.map(name => (labels[name] ?? name) + '：' + (checks as Record<string, { detail: string }>)[name]!.detail)
      return await finishBlocked(missing, '装配前置检查未通过（缺 ' + missing.length + ' 项）—— ' + reasons.join('；'))
    }
    if (!kernel.node) {
      return await finishBlocked(['node'], '找不到可用的 node.exe：内核起不来。用 --node <node.exe> 指定。')
    }

    // ---- 3) 干净家目录：内核树 junction 先建好（必须在第一次快照之前）
    await setPhase('prepare')
    const home = path.join(runDir, 'home')
    const workspace = path.join(runDir, 'workspace')
    const clean = await buildCleanHome({
      home,
      sourceHome,
      profileId: profileId!,
      kernelModules: kernel.modules,
    })
    await mkdir(workspace, { recursive: true })
    const port = await findAvailableWebPort(options.portBase ?? WORKBENCH_PORT_BASE, 100, isLoopbackPortAvailable)
    if (port === null) {
      return await finishBlocked(['port'], '没有可用端口：从 ' + (options.portBase ?? WORKBENCH_PORT_BASE) + ' 起 100 个都被占用')
    }
    const bootContext = (): BootContext => ({
      home: clean.home,
      profileId: clean.profileId,
      profileDir: clean.profileDir,
      node: kernel.node,
      kernelEntry: kernel.entry,
      port,
      workspace,
      timeoutMs,
      stabilityMs,
    })

    // 预热启动：干净家目录本身必须能起来，否则后面任何判定都不可信。
    // 顺便把「干净启动会写什么」落进基线（.credentials.yaml / storages/workspace.json /
    // profiles/<id>/cordis.yml）——不然每次启动的自身产物都会被当成插件残留。
    await setPhase('boot')
    await emit('boot', { role: 'warmup', port })
    const warmup = await boot(bootContext())
    await emit('stop', {
      role: 'warmup',
      ok: warmup.ok,
      pid: warmup.pid,
      readyMs: warmup.readyMs,
      portReleased: warmup.portReleased,
      reason: warmup.reason,
      output: (warmup.output ?? '').slice(-EVENT_OUTPUT_LIMIT),
    })
    output('预热启动：' + warmup.reason + (warmup.readyMs !== null ? '（' + warmup.readyMs + 'ms）' : ''))
    if (!warmup.ok) {
      return await finishBlocked(['kernel'], '干净家目录都起不来：' + warmup.reason)
    }

    // ---- 4) 第一次快照（目录项级别）+ 还原用的基线副本
    const baseline = await snapshotHome(home)
    const backupDir = path.join(runDir, 'baseline')
    await copyForRestore(home, backupDir)
    const baselineFiles = baseline.filter(entry => entry.kind === 'file').length
    await emit('snapshot', { entries: baseline.length, files: baselineFiles, backupDir, noise: [...WORKBENCH_NOISE_DIRS] })
    output('快照：' + baseline.length + ' 个目录项（' + baselineFiles + ' 个文件）')

    const composeContext = (): ComposeContext => ({
      home: clean.home,
      profileId: clean.profileId,
      profileDir: clean.profileDir,
      workspace,
      node: kernel.node,
      kernelEntry: kernel.entry,
      timeoutMs,
    })
    // 用户补丁层的基线：卸载后要把它复原，否则插件写进来的条目会被当成残留。
    const baselineGate = await readFile(path.join(clean.profileDir, WORKBENCH_PROFILE_GATE), 'utf8').catch(() => null)
    const baselineComposition = await compose(composeContext())
    if (baselineComposition === null) output('组合树：判不了（内核拒绝 --dump-config），本次不做组合对比')

    const verdicts: WorkbenchVerdict[] = []
    const writesByPlugin: Record<string, string[]> = {}
    for (const plugin of selected) {
      status.current = plugin.name
      await setPhase('install')
      output('装配：' + plugin.name + '@' + plugin.version)
      let installedOk = false
      let installedReason = ''
      let compositionChanged: boolean | null = null
      try {
        await installPlugin(clean.profileDir, plugin)
        const installedComposition = await compose(composeContext())
        if (baselineComposition !== null && installedComposition !== null) {
          compositionChanged = installedComposition !== baselineComposition
        }
        await emit('install', {
          name: plugin.name,
          version: plugin.version,
          tgz: plugin.tgz,
          hasBundle: plugin.hasBundle,
          compositionChanged,
        })
        if (plugin.hasBundle && compositionChanged === false) {
          installedReason = '装上了，但组合树没有变化：插件的 bundle 补丁没生效（没被加载）'
        } else {
          await setPhase('boot')
          await emit('boot', { role: 'installed', name: plugin.name, port })
          const withPlugin = await boot(bootContext())
          await emit('stop', {
            role: 'installed',
            name: plugin.name,
            ok: withPlugin.ok,
            pid: withPlugin.pid,
            readyMs: withPlugin.readyMs,
            portReleased: withPlugin.portReleased,
            reason: withPlugin.reason,
            output: (withPlugin.output ?? '').slice(-EVENT_OUTPUT_LIMIT),
          })
          output('装好后启动：' + withPlugin.reason + (withPlugin.readyMs !== null ? '（' + withPlugin.readyMs + 'ms）' : ''))
          if (!withPlugin.ok) installedReason = '装好后起不来：' + withPlugin.reason
          else installedOk = true
        }
      } catch (error) {
        installedReason = '装配失败：' + errorText(error)
        await emit('install', { name: plugin.name, version: plugin.version, tgz: plugin.tgz, hasBundle: plugin.hasBundle, failed: errorText(error) })
      } finally {
        await setPhase('uninstall')
        try {
          await uninstallPlugin(clean.profileDir, plugin)
        } catch (error) {
          installedReason = (installedReason ? installedReason + '；' : '') + '卸载报错：' + errorText(error)
        }
      }
      // 先撤掉插件写进 profile 补丁层的条目，再读组合树——否则这两项都会误判成「没复原」。
      const profileGate = await restoreProfileGate(clean.profileDir, baselineGate)
      const uninstalledComposition = await compose(composeContext())
      let compositionRestored: boolean | null = null
      if (baselineComposition !== null && uninstalledComposition !== null) {
        compositionRestored = uninstalledComposition === baselineComposition
      }
      await emit('uninstall', { name: plugin.name, compositionRestored, profileGate })
      output('拆卸：' + plugin.name)

      // 没有它也得能起：这一步同时验证「卸载没有把内核/清单弄坏」。
      await setPhase('boot')
      await emit('boot', { role: 'uninstalled', name: plugin.name, port })
      const withoutPlugin = await boot(bootContext())
      await emit('stop', {
        role: 'uninstalled',
        name: plugin.name,
        ok: withoutPlugin.ok,
        pid: withoutPlugin.pid,
        readyMs: withoutPlugin.readyMs,
        portReleased: withoutPlugin.portReleased,
        reason: withoutPlugin.reason,
        output: (withoutPlugin.output ?? '').slice(-EVENT_OUTPUT_LIMIT),
      })
      output('卸掉后启动：' + withoutPlugin.reason + (withoutPlugin.readyMs !== null ? '（' + withoutPlugin.readyMs + 'ms）' : ''))

      // ---- 5) 对比 + 逐项反向回滚
      await setPhase('compare')
      const current = await snapshotHome(home)
      const diff = compareHome(baseline, current)
      const restore = await restoreHome(home, diff, { backupDir })
      const afterRestore = await snapshotHome(home)
      const remaining = compareHome(baseline, afterRestore)
      const residue = residueCount(diff)
      const remainingCount = residueCount(remaining)
      const { dirty, writes } = classifyResidue(diff, clean.profileId)
      writesByPlugin[plugin.name] = writes
      await emit('compare', {
        name: plugin.name,
        added: diff.added.map(entry => entry.path),
        removed: diff.removed.map(entry => entry.path),
        sizeChanged: diff.sizeChanged.map(entry => entry.path),
        emptyDirResidue: diff.added.filter(entry => entry.kind === 'dir').map(entry => entry.path),
        dirty,
        writes,
        restored: restore.removed,
        restoredMissing: restore.restored,
        restoreFailed: restore.failed,
        remaining: remaining.added.map(entry => entry.path),
        remainingCount,
      })
      if (residue > 0) output('对比：' + residue + ' 项差异（dirty ' + dirty.length + ' / writes ' + writes.length + '），已回滚，剩余 ' + remainingCount + ' 项')

      // 三档判定：只有 dirty（本体/门控没复原、起不来、回滚失败）算不合格；
      // writes 是插件运行期故意写的用户数据，不进包，只列出。
      const dirtyReasons: string[] = []
      if (!installedOk) dirtyReasons.push(installedReason || '装好后没起来')
      if (!withoutPlugin.ok) dirtyReasons.push('卸掉后起不来：' + withoutPlugin.reason)
      if (compositionRestored === false) dirtyReasons.push('卸载后组合树没复原（清单里还有它的痕迹）')
      if (dirty.length > 0) {
        const sample = dirty.slice(0, 8)
        dirtyReasons.push('本体/门控残留 ' + dirty.length + ' 项（' + sample.join('、') + (dirty.length > sample.length ? '…' : '') + '），已逐项回滚')
      }
      if (remainingCount > 0) dirtyReasons.push('回滚后仍有 ' + remainingCount + ' 项无法还原')
      const ok = dirtyReasons.length === 0
      const cls: WorkbenchClass = ok ? (writes.length > 0 ? 'writes' : 'ok') : 'dirty'
      const verdict: WorkbenchVerdict = {
        name: plugin.name,
        ok,
        class: cls,
        reason: ok
          ? (writes.length > 0
            ? '本体干净、能起、能卸、组合复原；另有 ' + writes.length + ' 项运行期写入（不进包，不算不合格）：' + writes.slice(0, 8).join('、')
            : '装配 → 启动 → 停止 → 卸载 → 再启动 → 快照对比 → 还原，全部通过')
          : dirtyReasons.join('；'),
      }
      verdicts.push(verdict)
      if (ok) status.passed.push(plugin.name)
      await writeStatus()
    }

    await setPhase('done')
    await writeFile(files.verdict, JSON.stringify(verdicts, null, 2) + '\n', 'utf8')
    await emit('verdict', {
      passed: verdicts.filter(item => item.ok).map(item => item.name),
      failed: verdicts.filter(item => !item.ok).map(item => ({ name: item.name, class: item.class, reason: item.reason })),
      writes: Object.entries(writesByPlugin).filter(([, paths]) => paths.length > 0).map(([name, paths]) => ({ name, paths })),
    })
    status.current = null
    await writeStatus()
    for (const verdict of verdicts) output((verdict.ok ? '✓ ' : '✗ ') + verdict.name + '：' + verdict.reason)
    return { exitCode: verdicts.every(item => item.ok) ? 0 : 1, runDir, verdicts }
  } catch (error) {
    // 兜底：任何意外都写进 status.json（phase=failed + reason），退出码 2，绝不静默退出。
    if (runDir) {
      const statusPath = path.join(runDir, WORKBENCH_STATUS_FILENAME)
      const existing = await readFile(statusPath, 'utf8').catch(() => null)
      let parsed: WorkbenchStatusFile = {
        phase: 'failed', kernel: { version: null, state: 'missing' }, passed: [], current: null, startedAt, reason: null,
      }
      if (existing) {
        try {
          parsed = JSON.parse(existing) as WorkbenchStatusFile
        } catch {
          // 保持兜底对象。
        }
      }
      parsed.phase = 'failed'
      parsed.reason = errorText(error)
      await writeFile(statusPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8').catch(() => undefined)
    }
    output('装配工作台失败：' + errorText(error))
    return { exitCode: 2, runDir, verdicts: [] }
  } finally {
    await slot.release()
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
