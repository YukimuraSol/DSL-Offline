import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { downloadGitHubArchive, githubArchiveUrl } from './github-archive'
import { isSafeRepositoryName } from './profile'

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_FILES = 12_000
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024

export interface AiRepositorySource {
  taskRoot: string
  repositoryPath: string
  /** 已预取的 git 子模块（独立 GitHub 仓库）。 */
  submodules: SubmoduleInfo[]
  /** 无法预取的子模块（非 GitHub / 下载失败），附原因。 */
  skippedSubmodules: { path: string; reason: string }[]
}

export interface SubmoduleInfo {
  /** 子模块在 meta-repo 内的相对路径，如 injector。 */
  path: string
  /** 子模块的 GitHub 仓库全名（owner/repo）。 */
  repository: string
  /** 预取的 revision：gitlink 精确 commit；解析失败时为回退分支名。 */
  revision: string
}

/** 主仓库与所有子模块共享的解压预算（跨压缩包累计）。 */
interface UnpackBudget {
  files: number
  bytes: number
}

function safeRevision(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

function safeArchivePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
  return normalized
}

async function readArchiveResponse(
  response: Response,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`下载 AI 研究仓库失败（HTTP ${response.status}）。`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error('仓库压缩包过大，已停止 AI 研究。')
  }
  const total = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    received += chunk.value.byteLength
    if (received > MAX_ARCHIVE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('仓库压缩包过大，已停止 AI 研究。')
    }
    chunks.push(Buffer.from(chunk.value))
    onProgress?.(received, total)
  }
  return Buffer.concat(chunks, received)
}

// ---------------------------------------------------------------------------
// .gitmodules 解析（git config INI 子集）
// ---------------------------------------------------------------------------

export interface GitSubmoduleDecl {
  name: string
  path: string
  url: string
  branch?: string
}

/**
 * 解析 .gitmodules：取 `[submodule "name"]` 段内的 path / url / branch。
 * 忽略注释与其它段；缺 path 或 url 的声明丢弃（submodules 用 gitlink 管理，
 * 缺 url 无法下载，缺 path 无法落盘）。
 */
export function parseGitModules(content: string): GitSubmoduleDecl[] {
  const submodules: GitSubmoduleDecl[] = []
  let current: GitSubmoduleDecl | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = /^\[submodule\s+"([^"]+)"\]$/i.exec(line)
    if (sectionMatch) {
      current = { name: sectionMatch[1], path: '', url: '' }
      submodules.push(current)
      continue
    }
    if (line.startsWith('[')) {
      current = null
      continue
    }
    if (!current) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex < 0) continue
    const key = line.slice(0, eqIndex).trim().toLowerCase()
    const value = line.slice(eqIndex + 1).trim()
    if (key === 'path' && !current.path) current.path = value
    else if (key === 'url' && !current.url) current.url = value
    else if (key === 'branch') current.branch = value
  }
  return submodules.filter(submodule => Boolean(submodule.path && submodule.url))
}

const GITHUB_SUBMODULE_URL_PATTERNS = [
  /^(?:git\+https?:\/\/|https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)$/,
]

/**
 * 从子模块 URL 推导 GitHub 仓库全名（owner/repo）。只接受 github.com 托管；
 * 非 GitHub 主机、多余路径段或非法仓库名返回 null（调用方跳过该子模块）。
 */
export function submoduleFullName(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  for (const pattern of GITHUB_SUBMODULE_URL_PATTERNS) {
    const match = pattern.exec(trimmed)
    if (!match) continue
    const fullName = `${match[1]}/${match[2]}`
    if (isSafeRepositoryName(fullName)) return fullName
  }
  return null
}

// ---------------------------------------------------------------------------
// gitlink 精确 commit 解析（best-effort）
// ---------------------------------------------------------------------------

const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}

interface GitTreeResponse {
  truncated?: boolean
  tree?: Array<{ path?: string; type?: string; sha?: string }>
}

function githubTreeUrl(repository: string): string {
  const [owner, name] = repository.split('/')
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/HEAD?recursive=1`
}

/**
 * 最佳努力解析 meta-repo 顶层 gitlink（子模块）的精确 commit。GitHub archive
 * 快照不含 .git，gitlink 的 SHA 只存在于 git trees API：`type: "commit"` 条目
 * 即子模块，sha 为父仓库钉住的 commit。失败或树被截断返回 null，调用方回退到
 * 子模块默认分支。
 */
export async function resolveSubmodulePins(repository: string, fetchImpl: typeof fetch): Promise<Map<string, string> | null> {
  try {
    const response = await fetchImpl(githubTreeUrl(repository), { headers: GITHUB_API_HEADERS })
    if (!response.ok) return null
    const body = await response.json() as GitTreeResponse
    if (body.truncated) return null
    const pins = new Map<string, string>()
    for (const entry of body.tree ?? []) {
      if (entry.type === 'commit' && entry.path && entry.sha && /^[a-f0-9]{40}$/i.test(entry.sha)) {
        pins.set(entry.path, entry.sha)
      }
    }
    return pins.size > 0 ? pins : null
  } catch {
    return null
  }
}

/**
 * 下载单个子模块压缩包。优先精确 commit（codeload 直接支持 40 位 SHA）；
 * 无 pin 时依次尝试 main / master 分支。所有候选都失败才抛错。
 */
async function readSubmoduleArchive(
  repository: string,
  revisions: string[],
  onProgress?: (received: number, total: number | null) => void,
  fetchImpl?: typeof fetch,
): Promise<Buffer> {
  let lastError: unknown = new Error('子模块下载失败。')
  for (const revision of revisions) {
    try {
      if (fetchImpl) {
        const response = await fetchImpl(githubArchiveUrl(repository, revision), {
          headers: { 'User-Agent': 'DSH-Launcher' },
        })
        return await readArchiveResponse(response, onProgress)
      }
      return await downloadGitHubArchive(repository, revision, MAX_ARCHIVE_BYTES, onProgress)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('子模块下载失败。')
}

// ---------------------------------------------------------------------------
// 安全解压
// ---------------------------------------------------------------------------

/**
 * 把单个压缩包安全解压到 destinationRoot。要求压缩包是单一根目录结构
 * （GitHub codeload 快照形式），根目录被剥离，内容写入 destinationRoot。
 * budget 在多次解压间共享，累计限制文件数与解压体积。
 */
async function unpackArchive(
  archiveBuffer: Buffer,
  destinationRoot: string,
  budget: UnpackBudget,
): Promise<number> {
  const entries = new AdmZip(archiveBuffer).getEntries()
  if (entries.length === 0) throw new Error('AI 研究仓库压缩包为空。')
  let archiveRoot: string | null = null
  let copiedFiles = 0
  const resolvedRoot = path.resolve(destinationRoot)
  for (const entry of entries) {
    const archivePath = safeArchivePath(entry.entryName)
    if (!archivePath) throw new Error('AI 研究仓库压缩包包含不安全路径。')
    const root = archivePath.split('/')[0]
    if (!archiveRoot) archiveRoot = root
    if (root !== archiveRoot) throw new Error('AI 研究仓库压缩包结构无效。')
    if (entry.isDirectory) continue

    const relativePath = archivePath.slice(root.length + 1)
    if (!relativePath) continue
    const safeRelative = safeArchivePath(relativePath)
    if (!safeRelative) throw new Error('AI 研究仓库包含不安全路径。')
    if (budget.files + 1 > MAX_FILES) throw new Error('仓库文件数量超过安全限制，已停止 AI 研究。')
    const declaredBytes = Number(entry.header.size) || 0
    if (budget.bytes + declaredBytes > MAX_UNPACKED_BYTES) {
      throw new Error('仓库解压体积超过安全限制，已停止 AI 研究。')
    }
    const data = entry.getData()
    if (budget.bytes + data.byteLength > MAX_UNPACKED_BYTES) {
      throw new Error('仓库解压体积超过安全限制，已停止 AI 研究。')
    }
    const outputPath = path.join(destinationRoot, ...safeRelative.split('/'))
    const resolvedOutput = path.resolve(outputPath)
    if (!resolvedOutput.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error('AI 研究仓库文件超出了允许范围。')
    }
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, data)
    budget.files += 1
    budget.bytes += data.byteLength
    copiedFiles += 1
  }
  if (!archiveRoot || copiedFiles === 0) throw new Error('AI 研究仓库压缩包为空。')
  return copiedFiles
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * Download and safely unpack a public GitHub repository into a temporary
 * directory inside DSH_HOME. The AI reads this local copy, so repository
 * inspection does not depend on its shell/network channel.
 *
 * 聚合仓库（git submodules）：GitHub archive 快照不含 .git、子模块目录为空。
 * 这里解析 .gitmodules，把每个 GitHub 托管的子模块内容也预取到对应子目录
 * （精确 commit 优先，回退默认分支），让 AI 能研究到真正的可安装组件。
 */
export async function prepareAiRepositorySource(
  sourceRoot: string,
  repository: string,
  revision: string,
  onProgress?: (received: number, total: number | null) => void,
  fetchImpl?: typeof fetch,
  onLog?: (text: string) => void,
): Promise<AiRepositorySource> {
  if (!isSafeRepositoryName(repository) || !safeRevision(revision)) {
    throw new Error('AI 研究仓库或分支名称无效。')
  }
  await mkdir(sourceRoot, { recursive: true })
  const taskRoot = await mkdtemp(path.join(sourceRoot, 'session-'))
  const repositoryPath = path.join(taskRoot, 'repository')
  try {
    const budget: UnpackBudget = { files: 0, bytes: 0 }
    const mainArchive = fetchImpl
      ? await readArchiveResponse(await fetchImpl(githubArchiveUrl(repository, revision), {
        headers: { 'User-Agent': 'DSH-Launcher' },
      }), onProgress)
      : await downloadGitHubArchive(repository, revision, MAX_ARCHIVE_BYTES, onProgress)
    await unpackArchive(mainArchive, repositoryPath, budget)

    const submodules: SubmoduleInfo[] = []
    const skippedSubmodules: { path: string; reason: string }[] = []
    const gitmodulesPath = path.join(repositoryPath, '.gitmodules')
    if (existsSync(gitmodulesPath)) {
      const declarations = parseGitModules(await readFile(gitmodulesPath, 'utf8'))
      if (declarations.length > 0) {
        onLog?.(`检测到 ${declarations.length} 个 git 子模块，正在预取…`)
        const pins = fetchImpl ? await resolveSubmodulePins(repository, fetchImpl) : null
        const seen = new Set<string>()
        for (const declaration of declarations) {
          const submodulePath = safeArchivePath(declaration.path)
          if (!submodulePath || submodulePath === '.' || submodulePath === '..' || seen.has(submodulePath)) {
            skippedSubmodules.push({ path: declaration.path, reason: '子模块路径无效或重复' })
            continue
          }
          seen.add(submodulePath)
          const submoduleRepository = submoduleFullName(declaration.url)
          if (!submoduleRepository) {
            skippedSubmodules.push({ path: submodulePath, reason: '非 GitHub 子模块，未预取' })
            continue
          }
          const pinned = pins?.get(submodulePath)
          const revisions = pinned ? [pinned] : ['main', 'master']
          try {
            const submoduleArchive = await readSubmoduleArchive(submoduleRepository, revisions, undefined, fetchImpl)
            await unpackArchive(submoduleArchive, path.join(repositoryPath, ...submodulePath.split('/')), budget)
            const resolvedRevision = pinned ?? revisions[0]
            submodules.push({ path: submodulePath, repository: submoduleRepository, revision: resolvedRevision })
            onLog?.(`已预取子模块 ${submodulePath} ← ${submoduleRepository}（${resolvedRevision.slice(0, 12)}）`)
          } catch (error) {
            const message = error instanceof Error ? error.message : '未知错误'
            skippedSubmodules.push({ path: submodulePath, reason: `预取失败：${message}` })
            onLog?.(`跳过子模块 ${submodulePath}：${message}`)
          }
        }
      }
    }
    return { taskRoot, repositoryPath, submodules, skippedSubmodules }
  } catch (error) {
    await rm(taskRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
