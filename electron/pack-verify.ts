import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openZipPathFromFile, safeArchivePath, type OpenZipPath, type ZipPathEntry } from './pack-zip'
import { SNAPSHOT_BODIES_DIR, SNAPSHOT_META_FILENAME, SNAPSHOT_ZIP_LIMITS, type SnapshotMeta } from './pack-snapshot'

/**
 * 整合包（.zip = 家目录快照）只读自检。
 *
 * 不解压到最终位置、不联网、不改任何东西：只用 streaming zip 条目名 + 几个小文本文件判断。
 * 语义（用户定调）：插件放在运行目录里是正常做法，不做道德审判；只在「清单查不到出处的
 * 散件」和「链接指向包外」时报警。
 *
 * 六条：
 * 1. 清单与目录对得上 —— package.json 每条 dependencies 在 node_modules 下有对应目录。
 * 2. 没有对不上号的散件 —— node_modules 顶层（含 scope 下一层）有清单未声明的目录。
 * 3. 链接不指向包外 —— dsh-snapshot.json 里的链接目标必须落在包根内。
 * 4. 插件入口存在 —— dsh.profile.bundles 每个包有 package.json，且 main / dsh.bundle 入口文件在。
 * 5. 内核版本匹配 —— profile.yaml 的 dshVersion 与 runtime/kernels/<ver> 比对。
 * 6. 逐插件依赖与入口 —— 每个启用插件自己的 dependencies / peerDependencies 能按 Node 的
 *    解析顺序（插件自身 node_modules → profiles/<id>/node_modules → profiles/node_modules → 内核）
 *    在包内找到；家目录版额外核对插件源码里写死的 ~/.dsh/<名> 在包里还在不在。
 */

export type PackVerifyStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface PackVerifyCheck {
  /** 1-6，与计划里的编号一致。 */
  id: number
  title: string
  status: PackVerifyStatus
  /** 一行结论（给界面直接渲染）。 */
  detail: string
  /** 逐项明细（最多保留 50 条，避免几千条塞爆 IPC）。 */
  findings: string[]
}

export interface PackVerifyReport {
  ok: boolean
  /** 总判定文案（能启动 / 有 N 处对不上号）。 */
  verdict: string
  /** 包里读到的 DSH 版本（profile.yaml 缺失时为 null）。 */
  dshVersion: string | null
  /** 这次比对用的随包内核（列表，可能为空）。 */
  availableKernels: string[]
  checks: PackVerifyCheck[]
  /** 可复制给 agent 的修复提示词。 */
  prompt: string
}

export interface PackVerifyOptions {
  /** 随包内核根目录；缺省按打包态 resources/kernels、开发态 ../runtime/kernels 推断。 */
  kernelsRoot?: string
  /**
   * quick：只跑 1/2/3（5 分钟轮询用）；full：六条全跑（用户点自检用）。
   */
  mode?: 'full' | 'quick'
  /**
   * 只对 verifyPackHome 生效：指定要看 profiles/<id> 哪一个。
   * 不给就按「有 profile.yaml 的 > 有 package.json 的 > 第一个」挑，与 verifyPackFile 一致。
   * verifyPackFile 不看这个字段。
   */
  profileId?: string
}

const MAX_FINDINGS = 50
/** 只读的几个小文本上限：清单/元数据/包清单，都远小于这个数。 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024
/** node_modules 顶层允许存在的非依赖条目（pnpm 自己的簿记）。 */
const PNPM_BOOKKEEPING = new Set(['.bin', '.pnpm', '.ignored', '.modules.yaml', '.package-map.json', '.pnpm-workspace-state-v1.json'])
/** DSH 内核自带的包：清单里不写依赖也正常。pack.ts 的徽章计数也从这里取，两边同一份口径。 */
export const KERNEL_SCOPES = ['@deepseek-ai']

/**
 * 六条检查的规则表：编号、标题与「这条要看哪一层的东西」。
 * 标题只此一处，两个入口（.zip 文件 / 已装家目录）都从表里取，避免两边文案走散；
 * level 用来说明这条检查的最小载体：
 * - profile：只要 profiles/<id> 里的清单；
 * - home：要看真实的目录/链接（zip 里只能看条目名）；
 * - file：要看本机包外的文件（随包内核）。
 */
export const PACK_CHECKS: readonly { id: number; title: string; level: 'home' | 'profile' | 'file' }[] = [
  { id: 1, title: '清单与目录对得上', level: 'profile' },
  { id: 2, title: '没有对不上号的散件', level: 'home' },
  { id: 3, title: '链接不指向包外', level: 'home' },
  { id: 4, title: '插件入口存在', level: 'profile' },
  { id: 5, title: '内核版本匹配', level: 'file' },
  { id: 6, title: '逐插件依赖与入口', level: 'profile' },
]

/** 规则表里第 id 条的标题；表里没有就退回一个不会让界面空着的串。 */
export function packCheckTitle(id: number): string {
  return PACK_CHECKS.find(check => check.id === id)?.title ?? `检查 ${id}`
}

function defaultKernelsRoot(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) return path.join(resources, 'kernels')
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime/kernels')
}

function relOf(safe: string, stripRoot: string | null): string {
  return stripRoot && safe.startsWith(`${stripRoot}/`) ? safe.slice(stripRoot.length + 1) : safe
}

/** zip 里目录条目可能不存在（很多写法只写文件），所以目录集合从文件路径反推。 */
function directoryIndex(files: string[]): Set<string> {
  const dirs = new Set<string>()
  for (const rel of files) {
    let index = rel.lastIndexOf('/')
    while (index > 0) {
      const dir = rel.slice(0, index)
      if (dirs.has(dir)) break
      dirs.add(dir)
      index = dir.lastIndexOf('/')
    }
  }
  return dirs
}

function packageNameOf(rel: string, prefix: string): string | null {
  if (!rel.startsWith(prefix)) return null
  const rest = rel.slice(prefix.length)
  const segments = rest.split('/')
  if (segments[0] === undefined || segments[0].length === 0) return null
  if (segments[0].startsWith('@')) {
    if (segments.length < 2 || segments[1].length === 0) return null
    return `${segments[0]}/${segments[1]}`
  }
  return segments[0]
}

async function readEntryText(handle: OpenZipPath, entry: ZipPathEntry | undefined): Promise<string | null> {
  if (!entry || entry.isDirectory) return null
  try {
    return (await handle.readEntryData(entry, MAX_TEXT_BYTES)).toString('utf8')
  } catch {
    return null
  }
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readYamlField(text: string | null, field: string): string | null {
  if (!text) return null
  const match = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm').exec(text)
  if (!match?.[1]) return null
  return match[1].trim().replace(/^['"]|['"]$/g, '')
}

/** 从插件 package.json 里取入口候选：main > exports['.'] > dsh.bundle 指向的补丁文件。 */
function entryCandidates(manifest: Record<string, unknown>): string[] {
  const out: string[] = []
  const main = manifest.main
  if (typeof main === 'string' && main.trim()) out.push(main.trim())
  const exportsField = manifest.exports
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const dot = (exportsField as Record<string, unknown>)['.']
    if (typeof dot === 'string') out.push(dot)
    else if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
      for (const key of ['default', 'import', 'require', 'node']) {
        const value = (dot as Record<string, unknown>)[key]
        if (typeof value === 'string' && value.trim()) { out.push(value.trim()); break }
      }
    }
  }
  const dshField = manifest.dsh
  if (dshField && typeof dshField === 'object' && !Array.isArray(dshField)) {
    const bundle = (dshField as Record<string, unknown>).bundle
    if (typeof bundle === 'string') out.push(bundle)
    else if (bundle && typeof bundle === 'object' && !Array.isArray(bundle)) {
      const patch = (bundle as Record<string, unknown>).patch
      if (typeof patch === 'string') out.push(patch)
    }
  }
  return [...new Set(out.map(item => item.replace(/^\.\//, '').replace(/\\/g, '/')))]
}

function normalizeEntryPath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
}

async function listKernels(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * 拼一段可以直接丢给 agent 的修复提示词：只描述挪位置/改清单/重建链接，明确禁止 pnpm install。
 * target='file' 说的是「改完重打包」，target='home' 说的是「就地改这个已安装的目录」。
 */
function buildPrompt(report: Omit<PackVerifyReport, 'prompt'>, packName: string, target: 'file' | 'home' = 'file'): string {
  const lines: string[] = []
  const where = target === 'home' ? '这个整合包（' + packName + '）的家目录' : '这个整合包（' + packName + '）'
  lines.push(`${where}自检没过，请按下面逐条${target === 'home' ? '就地修' : '修'}。**不要跑 \`pnpm install\`**——包里已经带着 node_modules 和插件本体，一跑就被 pnpm 按自己的簿记重排，链接全断。`)
  lines.push('')
  for (const check of report.checks) {
    if (check.status === 'pass' || check.status === 'skip') continue
    lines.push(`### ${check.id}. ${check.title}（${check.status === 'fail' ? '必须修' : '建议修'}）`)
    lines.push(check.detail)
    for (const finding of check.findings) lines.push(`- ${finding}`)
    lines.push('')
    if (check.id === 1) lines.push('改法：把缺的本体目录放进 \`profiles/<包名>/node_modules/<包名>/\`（scoped 包是多一层目录），或者在 \`profiles/<包名>/package.json\` 的 dependencies 里删掉那一行。')
    if (check.id === 2) lines.push('改法：要么在 dependencies 里补声明（指向 \`file:./.dsh-launcher-plugin-bodies/<包名>\`），要么把那个目录挪进 \`.dsh-launcher-plugin-bodies/\` 并从 node_modules 顶层删掉。')
    if (check.id === 3) {
      lines.push(target === 'home'
        ? '改法：把包外那个目录整个拷进 \`profiles/<包名>/.dsh-launcher-plugin-bodies/<包名>\`，删掉 node_modules 下那个 junction，再重建一条指向包内目录的相对链接（\`mklink /J\` 或 \`New-Item -ItemType Junction\`，目标用相对路径）。'
        : '改法：把包外那个目录整个拷进包内（\`profiles/<包名>/.dsh-launcher-plugin-bodies/<包名>\`），然后把 \`dsh-snapshot.json\` 里 links 的目标改成包内相对路径。')
    }
    if (check.id === 4) lines.push(target === 'home'
      ? '改法：确认插件的 package.json 里 \`main\`（或 \`exports["."]\`）指向的文件真的在这个家目录里；少了就补文件，路径错了就改 package.json。'
      : '改法：确认插件的 package.json 里 \`main\`（或 \`exports["."]\`）指向的文件真的在包里；少了就补文件，路径错了就改 package.json。')
    if (check.id === 5) lines.push('改法：把 \`profiles/<包名>/profile.yaml\` 的 \`dshVersion\` 改成本机实际装了（且在随包内核里）的那个版本，或者把对应版本的内核目录补进 \`runtime/kernels/\`。')
    if (check.id === 6) lines.push('改法：缺的那条依赖要么跟插件一起放进 \`profiles/<包名>/node_modules/\`（插件自己的 \`node_modules/\` 也行），要么在插件的 package.json 里从 dependencies / peerDependencies 删掉；插件入口按第 4 条同一处改。')
  }
  lines.push(target === 'home' ? '就地改完这一份目录，再点一次自检；不需要重新打包。' : '修完重新打包，再把 .zip 拖回启动器跑一次自检。')
  return lines.join('\n')
}

/**
 * 只读校验一个整合包 .zip。
 * @param filePath 包文件路径
 * @param packName 界面上的包名（只用于提示词，缺省用文件名）
 */
export async function verifyPackFile(
  filePath: string,
  packName: string = path.basename(filePath),
  options: PackVerifyOptions = {},
): Promise<PackVerifyReport> {
  const mode = options.mode ?? 'full'
  const kernelsRoot = options.kernelsRoot ?? defaultKernelsRoot()
  const availableKernels = await listKernels(kernelsRoot)

  const handle = await openZipPathFromFile(filePath, SNAPSHOT_ZIP_LIMITS)
  try {
    const files: string[] = []
    const byRel = new Map<string, ZipPathEntry>()
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) continue
      const rel = relOf(safe, handle.stripRoot)
      files.push(rel)
      byRel.set(rel, entry)
    }
    const dirs = directoryIndex(files)

    // 定位 profile：优先带 profile.yaml 的，其次带 package.json 的。
    const profileIds = new Set<string>()
    for (const rel of files) {
      const segments = rel.split('/')
      if (segments[0] === 'profiles' && segments.length >= 3 && segments[1] !== 'node_modules') profileIds.add(segments[1]!)
    }
    let profileId: string | null = null
    for (const candidate of profileIds) {
      if (byRel.has(`profiles/${candidate}/profile.yaml`)) { profileId = candidate; break }
    }
    if (!profileId) {
      for (const candidate of profileIds) {
        if (byRel.has(`profiles/${candidate}/package.json`)) { profileId = candidate; break }
      }
    }
    if (!profileId) profileId = profileIds.values().next().value ?? null

    const profileRel = profileId ? `profiles/${profileId}` : null
    const manifest = profileRel ? parseJsonObject(await readEntryText(handle, byRel.get(`${profileRel}/package.json`))) : null
    const profileYaml = profileRel ? await readEntryText(handle, byRel.get(`${profileRel}/profile.yaml`)) : null
    const meta = parseJsonObject(await readEntryText(handle, byRel.get(SNAPSHOT_META_FILENAME))) as SnapshotMeta | null
    const dshVersion = readYamlField(profileYaml, 'dshVersion')
    const declared = new Set<string>()
    const dependencies = manifest?.dependencies
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies as Record<string, unknown>)) declared.add(name)
    }
    const nodeModulesRel = profileRel ? `${profileRel}/node_modules` : null

    const checks: PackVerifyCheck[] = []

    // —— 1. 清单与目录对得上 ——
    const missingBodies: string[] = []
    if (!profileRel || !manifest) {
      checks.push({ id: 1, title: packCheckTitle(1), status: 'fail', detail: '包里找不到 profiles/<包名>/package.json，无法核对清单。', findings: [] })
    } else {
      for (const packageName of declared) {
        if (!dirs.has(`${nodeModulesRel}/${packageName}`)) missingBodies.push(packageName)
      }
      checks.push(missingBodies.length === 0
        ? { id: 1, title: packCheckTitle(1), status: 'pass', detail: `${declared.size} 条依赖都在 node_modules 里。`, findings: [] }
        : { id: 1, title: packCheckTitle(1), status: 'fail', detail: `${missingBodies.length} 条依赖在 node_modules 里找不到目录。`, findings: missingBodies.slice(0, MAX_FINDINGS) })
    }

    // —— 2. 没有对不上号的散件 ——
    const strays: string[] = []
    if (!nodeModulesRel) {
      checks.push({ id: 2, title: packCheckTitle(2), status: 'skip', detail: '包里没有 profile，跳过。', findings: [] })
    } else {
      const prefix = `${nodeModulesRel}/`
      const scopes = new Set<string>()
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue
        const rest = dir.slice(prefix.length)
        if (rest.length === 0 || rest.includes('/')) {
          if (rest.includes('/')) {
            const head = rest.split('/')[0]!
            if (head.startsWith('@')) scopes.add(head)
          }
          continue
        }
        if (rest.startsWith('.')) continue
        // @scope 是分组目录不是包，它下面的包在第二个循环里逐个核对。
        if (rest.startsWith('@')) continue
        if (PNPM_BOOKKEEPING.has(rest)) continue
        if (KERNEL_SCOPES.includes(rest)) continue
        if (!declared.has(rest)) strays.push(rest)
      }
      // scoped 包（node_modules/@scope/pkg）：只有 scope 层才当「顶层包」；
      // node_modules/<包名>/lib 这种是包自己的子目录，不是散件。
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue
        const rest = dir.slice(prefix.length)
        const segments = rest.split('/')
        if (segments.length !== 2 || !segments[0]!.startsWith('@')) continue
        const packageName = `${segments[0]}/${segments[1]}`
        if (KERNEL_SCOPES.includes(segments[0]!)) continue
        if (!declared.has(packageName)) strays.push(packageName)
      }
      void scopes
      const unique = [...new Set(strays)].sort()
      checks.push(unique.length === 0
        ? { id: 2, title: packCheckTitle(2), status: 'pass', detail: 'node_modules 顶层没有清单外的目录。', findings: [] }
        : { id: 2, title: packCheckTitle(2), status: 'warn', detail: `${unique.length} 个目录没在清单里声明（下次动依赖会被 pnpm 当垃圾清掉）。`, findings: unique.slice(0, MAX_FINDINGS) })
    }

    // —— 3. 链接不指向包外 ——
    const links = Array.isArray(meta?.links) ? meta!.links : []
    const escaping: string[] = []
    let brokenLinks = 0
    for (const link of links) {
      if (!link || typeof link.path !== 'string' || typeof link.target !== 'string') { brokenLinks += 1; continue }
      const linkDir = path.posix.dirname(normalizeEntryPath(link.path))
      const resolved = path.posix.normalize(path.posix.join(linkDir, normalizeEntryPath(link.target)))
      if (resolved.startsWith('..') || path.posix.isAbsolute(resolved)) escaping.push(`${link.path} → ${link.target}`)
    }
    if (!meta) {
      checks.push({ id: 3, title: packCheckTitle(3), status: 'skip', detail: `包里没有 ${SNAPSHOT_META_FILENAME}，没有链接清单可核对。`, findings: [] })
    } else if (escaping.length === 0 && brokenLinks === 0) {
      checks.push({ id: 3, title: packCheckTitle(3), status: 'pass', detail: links.length === 0 ? '包里没有需要重建的链接。' : `${links.length} 条链接全部指向包内。`, findings: [] })
    } else {
      checks.push({ id: 3, title: packCheckTitle(3), status: 'fail', detail: `${escaping.length} 条链接指向包外（换机必断）${brokenLinks > 0 ? `，另有 ${brokenLinks} 条格式坏了` : ''}。`, findings: escaping.slice(0, MAX_FINDINGS) })
    }

    if (mode === 'quick') {
      const failedQuick = checks.some(check => check.status === 'fail')
      const report: Omit<PackVerifyReport, 'prompt'> = {
        ok: !failedQuick,
        verdict: failedQuick ? '有对不上号的地方（轻量检查）' : '轻量检查通过',
        dshVersion,
        availableKernels,
        checks,
      }
      return { ...report, prompt: failedQuick ? buildPrompt(report, packName) : '' }
    }

    // —— 4. 插件入口存在 ——
    const bundles: string[] = []
    const dshField = manifest?.dsh
    if (dshField && typeof dshField === 'object' && !Array.isArray(dshField)) {
      const profile = (dshField as Record<string, unknown>).profile
      if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        const list = (profile as Record<string, unknown>).bundles
        if (Array.isArray(list)) for (const item of list) if (typeof item === 'string') bundles.push(item)
      }
    }
    const brokenEntries: string[] = []
    if (!profileRel || !manifest || bundles.length === 0) {
      checks.push({ id: 4, title: packCheckTitle(4), status: 'skip', detail: bundles.length === 0 ? 'package.json 里没有 dsh.profile.bundles，跳过。' : '包里没有 profile 清单，跳过。', findings: [] })
    } else {
      for (const packageName of bundles) {
        const base = `${nodeModulesRel}/${packageName}`
        if (!byRel.has(`${base}/package.json`)) { brokenEntries.push(`${packageName}：node_modules 里没有 package.json`); continue }
        const pluginManifest = parseJsonObject(await readEntryText(handle, byRel.get(`${base}/package.json`)))
        if (!pluginManifest) { brokenEntries.push(`${packageName}：package.json 不是合法 JSON`); continue }
        const candidates = entryCandidates(pluginManifest)
        if (candidates.length === 0) { brokenEntries.push(`${packageName}：package.json 里没有 main / exports / dsh.bundle`); continue }
        const found = candidates.some(candidate => byRel.has(`${base}/${candidate}`) || byRel.has(`${base}/${normalizeEntryPath(candidate)}`))
        if (!found) brokenEntries.push(`${packageName}：入口 ${candidates.join(' / ')} 不在包里`)
      }
      checks.push(brokenEntries.length === 0
        ? { id: 4, title: packCheckTitle(4), status: 'pass', detail: `${bundles.length} 个启用插件都有可用的入口文件。`, findings: [] }
        : { id: 4, title: packCheckTitle(4), status: 'fail', detail: `${brokenEntries.length} 个插件的入口有问题（这类包能起，但插件不生效）。`, findings: brokenEntries.slice(0, MAX_FINDINGS) })
    }

    // —— 5. 内核版本匹配 ——
    if (!dshVersion) {
      checks.push({ id: 5, title: packCheckTitle(5), status: 'warn', detail: '包里没有 profile.yaml 或其中没有 dshVersion，无法判断要用哪个内核。', findings: [] })
    } else if (availableKernels.length === 0) {
      checks.push({ id: 5, title: packCheckTitle(5), status: 'skip', detail: `本机没有随包内核（${kernelsRoot}），无法比对。`, findings: [] })
    } else if (availableKernels.includes(dshVersion)) {
      checks.push({ id: 5, title: packCheckTitle(5), status: 'pass', detail: `包要用 DSH ${dshVersion}，随包内核里有这一份。`, findings: [] })
    } else {
      checks.push({ id: 5, title: packCheckTitle(5), status: 'fail', detail: `包要用 DSH ${dshVersion}，但随包内核只有 ${availableKernels.join(' / ')}。`, findings: [`缺内核：${dshVersion}`] })
    }

    // —— 6. 逐插件依赖与入口 ——
    if (!profileRel || !manifest || bundles.length === 0) {
      checks.push({ id: 6, title: packCheckTitle(6), status: 'skip', detail: bundles.length === 0 ? 'package.json 里没有 dsh.profile.bundles，跳过。' : '包里没有 profile 清单，跳过。', findings: [] })
    } else {
      const pluginProblems: string[] = []
      for (const packageName of bundles) {
        const base = `${nodeModulesRel}/${packageName}`
        // 入口缺失 / 清单读不了由第 4 条报，这里只补「插件自己的依赖」那一半。
        const pluginManifest = parseJsonObject(await readEntryText(handle, byRel.get(`${base}/package.json`)))
        if (!pluginManifest) continue
        for (const [dependency, spec] of pluginDependencies(pluginManifest)) {
          // 内核自带的包（@deepseek-ai/*、node 内置）不该算「包里缺依赖」：包里本来就没有内核目录。
          if (isKernelProvided(dependency)) continue
          // 与 Node 的解析顺序一致：插件自己的 node_modules → profiles/<id>/node_modules → profiles/node_modules。
          const candidates = [
            `${base}/node_modules/${dependency}`,
            `${nodeModulesRel}/${dependency}`,
            path.posix.normalize(`${profileRel}/../node_modules/${dependency}`),
          ]
          if (!candidates.some(candidate => dirs.has(candidate))) {
            pluginProblems.push(`${packageName} 需要 ${dependency}（${spec}），包内解析不到`)
          }
        }
      }
      checks.push(pluginProblems.length === 0
        ? { id: 6, title: packCheckTitle(6), status: 'pass', detail: `${bundles.length} 个启用插件声明的依赖都能在包内解析到。`, findings: [] }
        : { id: 6, title: packCheckTitle(6), status: 'fail', detail: `${pluginProblems.length} 条插件依赖在包内解析不到（这类包能起，但插件加载就报错）。`, findings: pluginProblems.slice(0, MAX_FINDINGS) })
    }

    const failed = checks.filter(check => check.status === 'fail').length
    const warned = checks.filter(check => check.status === 'warn').length
    const report: Omit<PackVerifyReport, 'prompt'> = {
      ok: failed === 0,
      verdict: failed === 0
        ? (warned === 0 ? '可以启动' : `可以启动（${warned} 处建议修）`)
        : `有 ${failed} 处对不上号`,
      dshVersion,
      availableKernels,
      checks,
    }
    return { ...report, prompt: failed + warned > 0 ? buildPrompt(report, packName) : '' }
  } finally {
    await handle.close()
  }
}

/**
 * 只读校验一个**已安装的整合包家目录**（packsRoot/<packId>/ 或收编进来的任意 DSH 家目录）。
 *
 * 与 verifyPackFile 的六条语义一一对应，只是数据源从 zip 中央目录换成真实目录。
 * 真实目录能看到的更多（junction 的真实目标、依赖目录在不在），所以第 2 条从「清单外的散件」
 * 收紧成「本体留在包外的写法」：残留绝对 file: / link: 就是换机会断，直接 fail。
 * 全程只读：不写任何文件、不顺着链接走进目标目录（只看链接本身）。
 *
 * @param homePath 家目录（含 profiles/ 的那一层）
 * @param packName 界面上的包名，只用于修复提示词
 */
export async function verifyPackHome(
  homePath: string,
  packName: string = path.basename(path.resolve(homePath)),
  options: PackVerifyOptions = {},
): Promise<PackVerifyReport> {
  const mode = options.mode ?? 'full'
  const kernelsRoot = options.kernelsRoot ?? defaultKernelsRoot()
  const availableKernels = await listKernels(kernelsRoot)
  const home = path.resolve(homePath)
  // 家目录本身可能就是一条 junction（用户把包放在别的盘上），真路径与字面路径都算「包内」。
  const homeReal = await realpath(home).catch(() => home)
  // Windows 路径不区分大小写，realpath 与用户输入的大小写不一定一致，比较前统一折一下。
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const insideHome = (target: string): boolean => {
    const probe = fold(target)
    for (const root of [homeReal, home]) {
      const base = fold(root)
      if (probe === base || probe.startsWith(base + path.sep)) return true
    }
    return false
  }

  /** 收口：结论文案与 verifyPackFile 用同一套口径，只是提示词按「就地修目录」写。 */
  const finish = (checks: PackVerifyCheck[], dshVersion: string | null): PackVerifyReport => {
    const failed = checks.filter(check => check.status === 'fail').length
    const warned = checks.filter(check => check.status === 'warn').length
    const report: Omit<PackVerifyReport, 'prompt'> = {
      ok: failed === 0,
      verdict: mode === 'quick'
        ? (failed === 0 ? '轻量检查通过' : '有对不上号的地方（轻量检查）')
        : failed === 0
          ? (warned === 0 ? '可以启动' : `可以启动（${warned} 处建议修）`)
          : `有 ${failed} 处对不上号`,
      dshVersion,
      availableKernels,
      checks,
    }
    return { ...report, prompt: failed + warned > 0 ? buildPrompt(report, packName, 'home') : '' }
  }

  if (!(await isDir(home))) {
    const skipped: PackVerifyCheck[] = [2, 3, 4, 5, 6].map(id => ({ id, title: packCheckTitle(id), status: 'skip' as const, detail: '家目录读不到，跳过。', findings: [] }))
    return finish([{ id: 1, title: packCheckTitle(1), status: 'fail', detail: `家目录不存在或不是一个目录：${home}`, findings: [home] }, ...skipped], null)
  }

  const profilesRoot = path.join(home, 'profiles')
  const profileId = await locateProfile(profilesRoot, options.profileId)
  if (!profileId) {
    const skipped: PackVerifyCheck[] = [2, 3, 4, 5, 6].map(id => ({ id, title: packCheckTitle(id), status: 'skip' as const, detail: '家目录里没有 profiles/<包名>/，跳过。', findings: [] }))
    return finish([{ id: 1, title: packCheckTitle(1), status: 'fail', detail: '家目录里没有 profiles/<包名>/ 这一层，无法核对清单。', findings: [] }, ...skipped], null)
  }

  const profileDir = path.join(profilesRoot, profileId)
  const nodeModules = path.join(profileDir, 'node_modules')
  const manifest = await readJsonFile(path.join(profileDir, 'package.json'))
  const profileYaml = await readFile(path.join(profileDir, 'profile.yaml'), 'utf8').catch(() => null)
  const dshVersion = readYamlField(profileYaml, 'dshVersion')
  const manifestName = typeof manifest?.name === 'string' ? manifest.name.trim() : ''
  const dependencies = manifest?.dependencies
  const declared = new Map<string, string>()
  if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
      if (typeof spec === 'string') declared.set(name, spec)
    }
  }
  const entries = await readNodeModules(nodeModules)
  const links = await linkTargets(entries)
  const escaping = [...links].filter(([, target]) => !insideHome(target))
  const checks: PackVerifyCheck[] = []

  // —— 1. 清单与目录对得上：profile 结构在、清单能读、每条依赖的目录真在 ——
  const structure: string[] = []
  const yamlMissing = !(await isFile(path.join(profileDir, 'profile.yaml')))
  if (yamlMissing) structure.push(`缺 profiles/${profileId}/profile.yaml（DSH 启动时读的就是这份）。`)
  if (!manifest) structure.push(`profiles/${profileId}/package.json 读不到或不是合法 JSON（清单是自检与依赖解析的唯一依据）。`)
  const missingBodies = await brokenDependencyDirs(profileDir, nodeModules)
  if (yamlMissing || !manifest || missingBodies.length > 0) {
    structure.push(...missingBodies)
    checks.push({ id: 1, title: packCheckTitle(1), status: 'fail', detail: `profiles/${profileId}/ 的结构或依赖目录对不上号。`, findings: structure.slice(0, MAX_FINDINGS) })
  } else if (manifestName && !profileIdMatches(profileId, manifestName)) {
    checks.push({ id: 1, title: packCheckTitle(1), status: 'warn', detail: `目录名 ${profileId} 与清单里的 name ${manifestName} 对不上（能启动，记一笔）。`, findings: [`目录名 ${profileId} ≠ name ${manifestName}`] })
  } else {
    checks.push({ id: 1, title: packCheckTitle(1), status: 'pass', detail: `${declared.size} 条依赖都在 node_modules 里，profiles/${profileId}/ 结构完整。`, findings: [] })
  }

  // —— 2. 没有对不上号的散件：依赖本体必须能跟着目录一起搬走 ——
  const leaks: string[] = []
  for (const [name, spec] of declared) {
    if (!/^(file|link):/i.test(spec)) continue
    if (/^link:/i.test(spec)) { leaks.push(`${name} → ${spec}（link: 换机必断）`); continue }
    // 绝对路径（C:\… / /home/…）换台机器一定断；相对路径但解析后跑到家目录外面的，一样搬不走。
    const tail = spec.replace(/^file:(\/\/)?/i, '').replace(/\\/g, '/')
    if (/^[A-Za-z]:\//.test(tail) || tail.startsWith('/')) { leaks.push(`${name} → ${spec}`); continue }
    if (!insideHome(dependencyDir(profileDir, nodeModules, name, spec))) leaks.push(`${name} → ${spec}（指向这个家目录外面）`)
  }
  checks.push(leaks.length === 0
    ? { id: 2, title: packCheckTitle(2), status: 'pass', detail: '没有依赖把本体留在包外，能整个目录搬走。', findings: [] }
    : { id: 2, title: packCheckTitle(2), status: 'fail', detail: `${leaks.length} 条依赖把本体留在了这个家目录外面（绝对路径 / link: / 指到外面的相对路径），换机会装不上。`, findings: leaks.slice(0, MAX_FINDINGS) })

  // —— 3. 链接不指向包外：node_modules 顶层的 reparse point 目标必须在 <home> 内 ——
  checks.push(escaping.length === 0
    ? { id: 3, title: packCheckTitle(3), status: 'pass', detail: links.size === 0 ? 'node_modules 顶层没有链接，也就没有指向包外的链接。' : `${links.size} 条链接都指向包内。`, findings: [] }
    : { id: 3, title: packCheckTitle(3), status: 'fail', detail: `${escaping.length} 条链接指向包外（换机必断）。`, findings: escaping.map(([name, target]) => `${name} → ${target}`).slice(0, MAX_FINDINGS) })

  if (mode === 'quick') return finish(checks, dshVersion)

  // —— 4. 插件入口存在：dsh.profile.bundles 每个包有 package.json，入口文件真在 ——
  const bundles: string[] = []
  const dshField = manifest?.dsh
  if (dshField && typeof dshField === 'object' && !Array.isArray(dshField)) {
    const profile = (dshField as Record<string, unknown>).profile
    if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
      const list = (profile as Record<string, unknown>).bundles
      if (Array.isArray(list)) for (const item of list) if (typeof item === 'string') bundles.push(item)
    }
  }
  const brokenEntries: string[] = []
  if (bundles.length === 0) {
    checks.push({ id: 4, title: packCheckTitle(4), status: 'skip', detail: 'package.json 里没有 dsh.profile.bundles，跳过。', findings: [] })
  } else {
    for (const packageName of bundles) {
      const base = path.join(nodeModules, ...packageName.split('/'))
      const pluginManifestPath = path.join(base, 'package.json')
      if (!(await isFile(pluginManifestPath))) { brokenEntries.push(`${packageName}：node_modules 里没有 package.json`); continue }
      const pluginManifest = await readJsonFile(pluginManifestPath)
      if (!pluginManifest) { brokenEntries.push(`${packageName}：package.json 不是合法 JSON`); continue }
      const candidates = entryCandidates(pluginManifest)
      if (candidates.length === 0) { brokenEntries.push(`${packageName}：package.json 里没有 main / exports / dsh.bundle`); continue }
      let found = false
      for (const candidate of candidates) {
        if (await exists(path.join(base, ...normalizeEntryPath(candidate).split('/')))) { found = true; break }
      }
      if (!found) brokenEntries.push(`${packageName}：入口 ${candidates.join(' / ')} 不在这个家目录里`)
    }
    checks.push(brokenEntries.length === 0
      ? { id: 4, title: packCheckTitle(4), status: 'pass', detail: `${bundles.length} 个启用插件都有可用的入口文件。`, findings: [] }
      : { id: 4, title: packCheckTitle(4), status: 'fail', detail: `${brokenEntries.length} 个插件的入口有问题（这类包能起，但插件不生效）。`, findings: brokenEntries.slice(0, MAX_FINDINGS) })
  }

  // —— 5. 内核版本匹配 ——
  if (!dshVersion) {
    checks.push({ id: 5, title: packCheckTitle(5), status: 'warn', detail: '这个家目录的 profile.yaml 里没有 dshVersion，无法判断要用哪个内核。', findings: [] })
  } else if (availableKernels.length === 0) {
    checks.push({ id: 5, title: packCheckTitle(5), status: 'skip', detail: `本机没有随包内核（${kernelsRoot}），无法比对。`, findings: [] })
  } else if (availableKernels.includes(dshVersion)) {
    checks.push({ id: 5, title: packCheckTitle(5), status: 'pass', detail: `这个家目录要用 DSH ${dshVersion}，随包内核里有这一份。`, findings: [] })
  } else {
    checks.push({ id: 5, title: packCheckTitle(5), status: 'fail', detail: `这个家目录要用 DSH ${dshVersion}，但随包内核只有 ${availableKernels.join(' / ')}。`, findings: [`缺内核：${dshVersion}`] })
  }

  // —— 6. 逐插件依赖与入口 ——
  // 入口文件本身由第 4 条查、链接指向由第 3 条查，这里只补它们没覆盖的两半：
  // 插件自己声明的依赖能不能解析到，以及插件源码里写死的 ~/.dsh/<名> 在包里还在不在。
  if (bundles.length === 0) {
    checks.push({ id: 6, title: packCheckTitle(6), status: 'skip', detail: 'package.json 里没有 dsh.profile.bundles，跳过。', findings: [] })
  } else {
    const pluginProblems: string[] = []
    for (const packageName of bundles) {
      const base = path.join(nodeModules, ...packageName.split('/'))
      const pluginManifest = await readJsonFile(path.join(base, 'package.json'))
      if (!pluginManifest) continue
      for (const [dependency, spec] of pluginDependencies(pluginManifest)) {
        // 内核自带的包不该算「包里缺依赖」：包里本来就没有内核目录，它们由启动器带的内核提供。
        if (isKernelProvided(dependency)) continue
        // 与 Node 的解析顺序一致：插件自己的 node_modules → profiles/<id>/node_modules → profiles/node_modules。
        const candidates = [
          path.join(base, 'node_modules', ...dependency.split('/')),
          path.join(nodeModules, ...dependency.split('/')),
          path.join(profilesRoot, 'node_modules', ...dependency.split('/')),
        ]
        if (!candidates.some(candidate => existsSync(candidate))) {
          pluginProblems.push(`${packageName} 需要 ${dependency}（${spec}），包内解析不到`)
        }
      }
      // 插件源码里写到的家目录路径：换台机器这些目录不跟着搬，插件一跑就读不到自己的数据。
      const entryFile = entryCandidates(pluginManifest)
        .map(candidate => path.join(base, ...normalizeEntryPath(candidate).split('/')))
        .find(candidate => existsSync(candidate))
      if (!entryFile) continue
      const source = await readFile(entryFile, 'utf8').catch(() => null)
      if (!source || source.length > MAX_TEXT_BYTES) continue
      for (const name of homePathReferences(source)) {
        if (!(await exists(path.join(home, name)))) {
          pluginProblems.push(`${packageName} 源码里读 ~/.dsh/${name}，包里没有这个目录`)
        }
      }
    }
    checks.push(pluginProblems.length === 0
      ? { id: 6, title: packCheckTitle(6), status: 'pass', detail: `${bundles.length} 个启用插件声明的依赖都能在包内解析到，源码里写到的家目录路径也都在。`, findings: [] }
      : { id: 6, title: packCheckTitle(6), status: 'fail', detail: `${pluginProblems.length} 条插件依赖或家目录路径在包里对不上（这类包能起，但插件加载就报错）。`, findings: pluginProblems.slice(0, MAX_FINDINGS) })
  }

  return finish(checks, dshVersion)
}

/** 家目录的 profiles/ 里挑一个 profile：优先调用方点名的，其次有 profile.yaml 的，再次有 package.json 的。 */
async function locateProfile(profilesRoot: string, preferred: string | undefined): Promise<string | null> {
  if (preferred) return preferred
  let names: string[]
  try {
    names = (await readdir(profilesRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return null
  }
  for (const name of names) if (await isFile(path.join(profilesRoot, name, 'profile.yaml'))) return name
  for (const name of names) if (await isFile(path.join(profilesRoot, name, 'package.json'))) return name
  return names[0] ?? null
}

/**
 * 清单声明的依赖在磁盘上应当长在哪：file:/link: 指向的具体路径，其余就是 node_modules/<包名>。
 * file: 里的反斜杠与 file://C:/ 这种写法都还原成本机路径再比。
 */
function dependencyDir(profileDir: string, nodeModules: string, name: string, spec: string): string {
  const prefix = spec.startsWith('file:') ? 5 : spec.startsWith('link:') ? 5 : 0
  if (prefix === 0) return path.join(nodeModules, ...name.split('/'))
  const tail = spec.slice(prefix).replace(/^\/\//, '/')
  return tail ? path.resolve(profileDir, tail) : path.join(nodeModules, ...name.split('/'))
}

/** 第 1 条里「目录真在」的那一半：返回一堆说清是哪个包、该在哪的明细。 */
async function brokenDependencyDirs(profileDir: string, nodeModules: string): Promise<string[]> {
  const manifest = await readJsonFile(path.join(profileDir, 'package.json'))
  const dependencies = manifest?.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  const broken: string[] = []
  for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof spec !== 'string') continue
    const target = dependencyDir(profileDir, nodeModules, name, spec)
    if (!(await isDir(target))) broken.push(`${name}：${target} 不存在`)
  }
  return broken
}

/** 目录名与清单 name 是否指同一个 profile：DSH 自己用 dsh-profile-<目录名>，手写的也常直接写目录名。 */
function profileIdMatches(profileId: string, manifestName: string): boolean {
  return manifestName === profileId || manifestName === `dsh-profile-${profileId}`
}

/** node_modules 顶层的包（scoped 包拆成 @scope/pkg 两层）；目录与链接都算，链接的真假留给第 3 条判。 */
async function readNodeModules(nodeModules: string): Promise<{ name: string; dir: string }[]> {
  let entries
  try {
    entries = await readdir(nodeModules, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { name: string; dir: string }[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = await readdir(path.join(nodeModules, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (child.name.startsWith('.')) continue
        out.push({ name: `${entry.name}/${child.name}`, dir: path.join(nodeModules, entry.name, child.name) })
      }
      continue
    }
    out.push({ name: entry.name, dir: path.join(nodeModules, entry.name) })
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 顶层链接（junction / symlink / 其它 reparse point）指向哪里。
 * 用 lstat 判类型：readdir 给的 Dirent.isSymbolicLink() 对 Windows junction 也成立；
 * 真正的目标用 realpath 解析（断链会抛，那就退回 readlink 的原文，照样能判包内包外）。
 */
async function linkTargets(entries: { name: string; dir: string }[]): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  for (const entry of entries) {
    const info = await lstat(entry.dir).catch(() => null)
    if (!info?.isSymbolicLink()) continue
    const raw = await readlink(entry.dir).catch(() => null)
    if (!raw) continue
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(entry.dir), raw)
    targets.set(entry.name, await realpath(entry.dir).catch(() => path.resolve(absolute)))
  }
  return targets
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  return parseJsonObject(text)
}

async function statOf(target: string) {
  return stat(target).catch(() => null)
}

async function isFile(target: string): Promise<boolean> {
  return (await statOf(target))?.isFile() === true
}

async function isDir(target: string): Promise<boolean> {
  return (await statOf(target))?.isDirectory() === true
}

async function exists(target: string): Promise<boolean> {
  return (await statOf(target)) !== null
}

/** 插件自己声明的依赖：dependencies + peerDependencies，同名以 dependencies 为准。 */
function pluginDependencies(manifest: Record<string, unknown>): [string, string][] {
  const out = new Map<string, string>()
  for (const field of ['dependencies', 'peerDependencies']) {
    const block = manifest[field]
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue
      if (!out.has(name)) out.set(name, spec)
    }
  }
  return [...out]
}

/** 内核带的东西（@deepseek-ai/* 与 Node 内置模块）不该算「包里缺依赖」：包里本来就没有内核目录。 */
function isKernelProvided(name: string): boolean {
  if (name.startsWith('@deepseek-ai/')) return true
  if (name.startsWith('node:')) return true
  return NODE_BUILTINS.has(name)
}

/** 插件源码里写到的家目录子目录名（~/.dsh/<名> 或 join(home, '<名>') 这类），去重后返回。 */
function homePathReferences(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/[\/\\]\.dsh[\/\\]([A-Za-z0-9._-]+)/g)) {
    const name = match[1]
    if (name && name !== '.' && name !== '..' && name !== 'node_modules') names.add(name)
  }
  return [...names]
}

/** Node 内置模块名（第 6 条判依赖时不算「包里没有」）。 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])
/* ------------------------------------------------------------------ *
 * 命令行入口（--verify / --export）用的东西
 *
 * 启动器自己是唯一一份自检实现：不再另留 scripts/verify-pack.mts
 * （那份用法写死 vite-node，而且 scripts/ 不进安装包，对面机器上根本没有）。
 * ------------------------------------------------------------------ */

/** 命令行自检的目标：家目录，还是导出的 .zip / .dspack。 */
export type VerifyTargetKind = 'home' | 'file'

/** 一条命令跑完的产出：退出码 + 两路输出。 */
export interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
}

/** 参数能解析但跑不动（路径不存在、读不了）时抛这个。 */
export class VerifyCliError extends Error {}

/**
 * 解析 `--verify` 后面的参数：位置参数给一个路径，可带 --json。
 * 纯函数：不碰文件系统，出问题只返回文案，退出码由调用方按 2 处理。
 */
export function parseVerifyArgs(argv: string[]): { ok: true; target: string; json: boolean } | { ok: false; message: string } {
  const positional = argv.filter(item => !item.startsWith('-'))
  const unknown = argv.filter(item => item.startsWith('-') && item !== '--json')
  if (unknown.length > 0) return { ok: false, message: `不认识的参数：${unknown.join(' ')}` }
  if (positional.length === 0) return { ok: false, message: '缺一个路径参数。' }
  if (positional.length > 1) return { ok: false, message: `只接受一个路径，多给了：${positional.slice(1).join(' ')}` }
  return { ok: true, target: positional[0]!, json: argv.includes('--json') }
}

/**
 * 解析 `--export` 后面的参数：整合包 id + 目标 zip 路径。
 * 纯函数，理由同上。
 */
export function parseExportArgs(argv: string[]): { ok: true; packId: string; targetZip: string } | { ok: false; message: string } {
  const positional = argv.filter(item => !item.startsWith('-'))
  const unknown = argv.filter(item => item.startsWith('-'))
  if (unknown.length > 0) return { ok: false, message: `不认识的参数：${unknown.join(' ')}` }
  if (positional.length < 2) return { ok: false, message: '要两个参数：整合包 id 和目标 zip 路径。' }
  if (positional.length > 2) return { ok: false, message: `只接受两个参数，多给了：${positional.slice(2).join(' ')}` }
  const [packId, targetZip] = positional as [string, string]
  if (!packId.trim()) return { ok: false, message: '整合包 id 不能是空的。' }
  if (!/\.zip$/i.test(targetZip)) return { ok: false, message: `目标路径要以 .zip 结尾：${targetZip}` }
  return { ok: true, packId: packId.trim(), targetZip }
}

/** 目标到底是家目录还是压缩包：stat 一下，再看扩展名。 */
export async function targetKindOf(target: string): Promise<VerifyTargetKind> {
  const info = await stat(target).catch(() => null)
  if (!info) throw new VerifyCliError(`找不到这个路径：${target}`)
  if (info.isDirectory()) return 'home'
  if (!info.isFile()) throw new VerifyCliError(`既不是目录也不是整合包文件：${target}`)
  if (!/\.(zip|dspack)$/i.test(target)) throw new VerifyCliError(`这不是整合包 zip：${target}（要么给家目录，要么给 .zip / .dspack）`)
  return 'file'
}

/** 按目标类型分派到两个自检实现。 */
export async function verifyTarget(target: string, options: PackVerifyOptions = {}): Promise<PackVerifyReport> {
  const resolved = path.resolve(target)
  const kind = await targetKindOf(resolved)
  try {
    return kind === 'home' ? await verifyPackHome(resolved, undefined, options) : await verifyPackFile(resolved, undefined, options)
  } catch (error) {
    throw new VerifyCliError(`读不了 ${resolved}：${errorText(error)}`)
  }
}

const LEVEL_TITLES: Record<'home' | 'profile' | 'file', string> = { home: '家目录', profile: '包内清单', file: '本机文件' }
const MARK: Record<PackVerifyStatus, string> = { pass: '✓ 通过', warn: '! 建议修', fail: '✗ 对不上号', skip: '- 跳过' }

/** 人看的报表：按「包内清单 / 家目录 / 本机文件」分组，附内核版本与修法。 */
export function formatReport(report: PackVerifyReport, target: string): string {
  const lines: string[] = []
  lines.push(`自检：${target}`)
  lines.push(`结论：${report.verdict}${report.ok ? '' : '（这些地方不修，换台机器大概率起不来）'}`)
  lines.push('')
  for (const level of ['profile', 'home', 'file'] as const) {
    const group = report.checks.filter(check => (PACK_CHECKS.find(item => item.id === check.id)?.level ?? 'home') === level)
    if (group.length === 0) continue
    lines.push(`【${LEVEL_TITLES[level]}】`)
    for (const check of group) {
      lines.push(`  ${MARK[check.status]}  ${check.id}. ${check.title}`)
      if (check.detail) lines.push(`        ${check.detail}`)
      for (const finding of check.findings.slice(0, 5)) lines.push(`        · ${finding}`)
      if (check.findings.length > 5) lines.push(`        · ……还有 ${check.findings.length - 5} 条`)
    }
    lines.push('')
  }
  lines.push(`内核：${report.dshVersion ? `包要用 DSH ${report.dshVersion}` : '包里没写 dshVersion'}；本机随包内核 ${report.availableKernels.length > 0 ? report.availableKernels.join(' / ') : '（没有）'}`)
  if (report.prompt.trim()) {
    lines.push('')
    lines.push('—— 修法（可以直接把下面这段贴给 AI）——')
    lines.push(report.prompt)
  }
  return lines.join('\n')
}

/**
 * 跑一次 --verify：返回退出码与两路输出，不自己 process.exit。
 * 0 = 全过，1 = 有对不上号的，2 = 自检本身没跑起来（参数错 / 路径读不了）。
 */
export async function runCli(argv: string[], options: PackVerifyOptions = {}): Promise<CliRun> {
  const parsed = parseVerifyArgs(argv)
  if (!parsed.ok) return { exitCode: 2, stdout: '', stderr: `${parsed.message}\n${VERIFY_USAGE}` }
  let report: PackVerifyReport
  try {
    report = await verifyTarget(parsed.target, options)
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `自检没跑起来：${errorText(error)}` }
  }
  const exitCode = report.ok ? 0 : 1
  if (parsed.json) return { exitCode, stdout: JSON.stringify(report), stderr: '' }
  return { exitCode, stdout: formatReport(report, path.resolve(parsed.target)), stderr: '' }
}

/** 启动器自己那一行用法。 */
export const VERIFY_USAGE = [
  '用法：<启动器> --verify <家目录路径 | .zip> [--json]',
  '  目录    → 检查已安装的整合包家目录（就地读，不碰文件）',
  '  .zip    → 检查导出的整合包',
  '  --json  → 只吐 JSON（给 agent 解析）',
  '退出码：0 全过 / 1 有对不上号的 / 2 自检没跑起来',
].join('\n')

export const EXPORT_USAGE = [
  '用法：<启动器> --export <整合包 id> <目标 zip 路径>',
  '  整合包 id  → 启动器里已安装整合包的那一行的 id',
  '  目标 zip   → 要写出的文件（父目录会自动建）',
  '退出码：0 成功 / 1 失败 / 2 参数错',
  '另见：--export-pack <整合包 id> [输出目录] —— 用装配引擎导出离线包（manifest.json + vendor\\ + extras\\）',
].join('\n')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
