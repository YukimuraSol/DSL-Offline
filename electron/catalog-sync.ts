import type { CatalogComponentKind, CatalogRepositoryAnalysis } from '../src/types'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LAUNCHER_REPOSITORY } from '../src/constants'
import {
  CATALOG_INDEX_PATH,
  catalogComponentKindsFromTags,
  catalogTagsFromAnalysis,
  parseCatalogIndex,
  serializeCatalogIndex,
  catalogEntryOrder,
} from './catalog-index'
import type { CatalogIndexEntry, CatalogIndexTag } from '../src/types'

const GITHUB_API_ROOT = 'https://api.github.com'
const CATALOG_BRANCH = 'main'
const CATALOG_DIRECTORY = 'catalog'
const BATCH_BRANCH = 'plugin-update'
const REMOTE_CACHE_MS = 5 * 60_000
const PENDING_FILE = 'index.xml'

interface GitHubRepositoryResponse {
  default_branch?: unknown
  parent?: { full_name?: unknown }
}

interface GitHubRefResponse {
  object?: { sha?: unknown }
}

interface GitHubContentResponse {
  content?: unknown
  sha?: unknown
}

interface GitHubPullRequest {
  html_url?: unknown
}

interface GitHubCommitResponse {
  tree?: { sha?: unknown }
}

interface GitHubBlobResponse {
  sha?: unknown
}

interface GitHubTreeResponse {
  sha?: unknown
}

interface GitHubTreeListResponse {
  tree?: unknown
  truncated?: unknown
}

interface GitHubCommitCreateResponse {
  sha?: unknown
}

export interface CatalogSyncService {
  /** 强制读取最新 main/catalog/index.xml，供界面手动刷新本地标签。 */
  refreshIndex(): Promise<CatalogIndexEntry[]>
  resolve(
    repository: string,
    defaultBranch: string,
    repositoryUpdatedAt: string | undefined,
    analyzeLocal: (componentKinds?: CatalogComponentKind[]) => Promise<CatalogRepositoryAnalysis>,
    onRemoteProgress?: (message: string) => void,
  ): Promise<CatalogRepositoryAnalysis>
  flushPending(): Promise<{ submitted: number; pullRequestUrl?: string; message: string }>
}

/**
 * 按仓库名称合并多个 XML 快照。后面的快照优先覆盖同名仓库，
 * 不同仓库的结果始终保留，供本地待提交、用户分支和主仓库合并使用。
 */
export function mergeCatalogEntries(...snapshots: CatalogIndexEntry[][]): CatalogIndexEntry[] {
  const merged = new Map<string, CatalogIndexEntry>()
  for (const snapshot of snapshots) {
    for (const entry of snapshot) merged.set(entry.repository.toLowerCase(), entry)
  }
  return [...merged.values()].sort(catalogEntryOrder)
}

function apiUrl(value: string): string {
  return `${GITHUB_API_ROOT}${value}`
}

/** 共享检测结果现在统一写入一个 XML 文件。保留导出供测试和迁移代码使用。 */
function repositoryPath(_repository?: string): string {
  return CATALOG_INDEX_PATH
}

function pendingFilePath(pendingDir: string): string {
  return path.join(pendingDir, PENDING_FILE)
}

function decodeContent(content: string): string {
  return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8')
}

function encodeContent(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64')
}

function isFresh(remoteUpdatedAt: string | null, currentUpdatedAt: string | undefined): boolean {
  if (!currentUpdatedAt) return true
  if (!remoteUpdatedAt) return false
  const remote = Date.parse(remoteUpdatedAt)
  const current = Date.parse(currentUpdatedAt)
  if (!Number.isFinite(remote)) return false
  return !Number.isFinite(current) || remote >= current
}

function sameTags(left: CatalogIndexTag[], right: CatalogIndexTag[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

function sameEntry(left: CatalogIndexEntry, right: CatalogIndexEntry): boolean {
  return left.repository.toLowerCase() === right.repository.toLowerCase()
    && left.defaultBranch === right.defaultBranch
    && left.repositoryUpdatedAt === right.repositoryUpdatedAt
    && sameTags(left.tags, right.tags)
}

function entryFromAnalysis(
  repository: string,
  defaultBranch: string,
  repositoryUpdatedAt: string | undefined,
  analysis: CatalogRepositoryAnalysis,
): CatalogIndexEntry {
  return {
    repository,
    defaultBranch,
    repositoryUpdatedAt: repositoryUpdatedAt ?? null,
    tags: catalogTagsFromAnalysis(analysis),
  }
}

function classificationOnlyAnalysis(entry: CatalogIndexEntry): CatalogRepositoryAnalysis {
  const componentKinds = catalogComponentKindsFromTags(entry.tags)
  const kind = entry.tags.includes('dsh')
    ? 'dsh'
    : entry.tags.includes('invalid')
      ? 'invalid'
      : componentKinds.length > 1 ? 'hybrid' : componentKinds[0] ?? 'invalid'
  const labels = entry.tags.map(tag => tag === 'runtime' ? 'Runtime' : tag[0]!.toUpperCase() + tag.slice(1))
  return {
    repository: entry.repository,
    defaultBranch: entry.defaultBranch,
    kind,
    componentKinds,
    summary: `GitHub 共享索引标记为 ${labels.join(' + ')}；当前未能补全安装入口。`,
    pluginAnalysis: null,
    skillAnalysis: null,
    applicationAnalysis: null,
    presetAnalysis: null,
    warnings: [],
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function errorDetail(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message
  }
  return 'GitHub 请求失败。'
}

export function createCatalogSyncService(options: {
  fetchImpl: typeof fetch
  getAuthStatus: () => Promise<{ authenticated: boolean; login: string | null }>
  pendingDir?: string
  onFlush?: (result: { submitted: number; pullRequestUrl?: string; message: string }) => void
}): CatalogSyncService {
  const fetchImpl = options.fetchImpl
  const pendingDir = options.pendingDir ? path.resolve(options.pendingDir) : null
  let pendingFlush: Promise<{ submitted: number; pullRequestUrl?: string; message: string }> | null = null
  let publishQueue: Promise<void> = Promise.resolve()
  let pendingQueue: Promise<void> = Promise.resolve()
  let remoteCache: { expiresAt: number; entries: CatalogIndexEntry[]; etag: string | null; sha: string | null } | null = null
  let remoteRead: Promise<CatalogIndexEntry[]> | null = null

  const enqueuePublish = <T>(task: () => Promise<T>): Promise<T> => {
    const result = publishQueue.then(task, task)
    publishQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const enqueuePending = <T>(task: () => Promise<T>): Promise<T> => {
    const result = pendingQueue.then(task, task)
    pendingQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const request = async (url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> => {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'DSH-Launcher',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers,
      },
    })
    return { response, body: await readResponseJson(response) }
  }

  const readIndexContent = (body: unknown): CatalogIndexEntry[] => {
    const content = body && typeof body === 'object' ? (body as GitHubContentResponse).content : undefined
    if (typeof content !== 'string') throw new Error('共享检测索引内容无效。')
    return parseCatalogIndex(decodeContent(content))
  }

  const readRemoteIndex = async (forceRefresh = false): Promise<CatalogIndexEntry[]> => {
    // 正常检测强制走 GitHub；短期缓存只作为网络失败时的降级结果。
    if (!forceRefresh && remoteCache && remoteCache.expiresAt > Date.now()) return remoteCache.entries
    if (remoteRead) return remoteRead
    remoteRead = (async () => {
      const headers: Record<string, string> = {}
      if (remoteCache?.etag) headers['If-None-Match'] = remoteCache.etag
      const { response, body } = await request(
        apiUrl(`/repos/${LAUNCHER_REPOSITORY}/contents/${CATALOG_INDEX_PATH}?ref=${CATALOG_BRANCH}`),
        { headers },
      )
      if (response.status === 304) {
        if (!remoteCache) throw new Error('GitHub 返回了无法使用的 304 响应。')
        remoteCache = { ...remoteCache, expiresAt: Date.now() + REMOTE_CACHE_MS }
        return remoteCache.entries
      }
      if (response.status === 404) {
        remoteCache = { expiresAt: Date.now() + REMOTE_CACHE_MS, entries: [], etag: response.headers.get('etag'), sha: null }
        return []
      }
      if (!response.ok) throw new Error(`共享检测索引读取失败（HTTP ${response.status}）：${errorDetail(body)}`)
      const entries = readIndexContent(body)
      const rawSha = body && typeof body === 'object' ? (body as GitHubContentResponse).sha : undefined
      remoteCache = {
        expiresAt: Date.now() + REMOTE_CACHE_MS,
        entries,
        etag: response.headers.get('etag'),
        sha: typeof rawSha === 'string' ? rawSha : null,
      }
      return entries
    })()
    try {
      return await remoteRead
    } finally {
      remoteRead = null
    }
  }

  const readPendingNow = async (): Promise<CatalogIndexEntry[]> => {
    if (!pendingDir) return []
    try {
      return parseCatalogIndex(await readFile(pendingFilePath(pendingDir), 'utf8'))
    } catch {
      return []
    }
  }

  const writePendingNow = async (entries: CatalogIndexEntry[]): Promise<void> => {
    if (!pendingDir) return
    if (entries.length === 0) {
      await rm(pendingFilePath(pendingDir), { force: true })
      return
    }
    await mkdir(pendingDir, { recursive: true })
    await writeFile(pendingFilePath(pendingDir), serializeCatalogIndex(entries), 'utf8')
  }

  const queueEntry = (entry: CatalogIndexEntry): Promise<boolean> => enqueuePending(async () => {
    // 每次检测完成时把远端完整索引、已有本地结果和本次结果先合并，
    // 这样本地待提交文件本身就是完整且按仓库名排序的 index.xml。
    const previous = mergeCatalogEntries(remoteCache?.entries ?? [], await readPendingNow())
    const entries = mergeCatalogEntries(previous, [entry])
    if (serializeCatalogIndex(entries) === serializeCatalogIndex(previous)) return false
    await writePendingNow(entries)
    return true
  })

  const removePendingEntries = (submitted: CatalogIndexEntry[]): Promise<void> => enqueuePending(async () => {
    const submittedByRepository = new Map(submitted.map(entry => [entry.repository.toLowerCase(), entry]))
    const entries = (await readPendingNow()).filter(entry => {
      const sent = submittedByRepository.get(entry.repository.toLowerCase())
      return !sent || !sameEntry(entry, sent)
    })
    await writePendingNow(entries)
  })

  const ensureFork = async (login: string): Promise<{ owner: string; name: string; defaultBranch: string }> => {
    const [, upstreamName] = LAUNCHER_REPOSITORY.split('/')
    const forkPath = `/repos/${login}/${upstreamName}`
    let result = await request(apiUrl(forkPath))
    if (result.response.status === 404) {
      result = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}/forks`), { method: 'POST', body: JSON.stringify({}) })
      if (!result.response.ok && result.response.status !== 202) {
        throw new Error(`无法创建 GitHub fork（HTTP ${result.response.status}）：${errorDetail(result.body)}`)
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 350))
        result = await request(apiUrl(forkPath))
        if (result.response.ok) break
      }
    }
    if (!result.response.ok || !result.body || typeof result.body !== 'object') {
      throw new Error(`无法访问 GitHub fork（HTTP ${result.response.status}）。`)
    }
    const body = result.body as GitHubRepositoryResponse
    if (typeof body.parent?.full_name !== 'string'
      || body.parent.full_name.toLowerCase() !== LAUNCHER_REPOSITORY.toLowerCase()) {
      throw new Error(`GitHub 仓库 ${login}/${upstreamName} 不是共享目录仓库的 fork，已停止提交以免覆盖其它项目。`)
    }
    const defaultBranch = typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : CATALOG_BRANCH
    return { owner: login, name: upstreamName!, defaultBranch }
  }

  const publishEntriesAttempt = async (
    entries: CatalogIndexEntry[],
  ): Promise<{ submitted: number; pullRequestUrl?: string; message: string }> => {
    const auth = await options.getAuthStatus()
    if (!auth.authenticated || !auth.login) {
      return { submitted: 0, message: '未登录 GitHub，检测标签暂存在本地待提交索引。' }
    }

    const upstream = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}`))
    if (!upstream.response.ok || !upstream.body || typeof upstream.body !== 'object') {
      throw new Error(`共享检测索引仓库不可用（HTTP ${upstream.response.status}）。`)
    }
    const upstreamBody = upstream.body as GitHubRepositoryResponse
    const upstreamBranch = typeof upstreamBody.default_branch === 'string' && upstreamBody.default_branch
      ? upstreamBody.default_branch
      : CATALOG_BRANCH
    const [upstreamOwner, upstreamName] = LAUNCHER_REPOSITORY.split('/')
    const target = auth.login.toLowerCase() === upstreamOwner?.toLowerCase()
      ? { owner: upstreamOwner!, name: upstreamName!, defaultBranch: upstreamBranch }
      : await ensureFork(auth.login)
    const targetRepository = `${target.owner}/${target.name}`

    const baseRef = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}/git/ref/heads/${encodeURIComponent(upstreamBranch)}`))
    const baseSha = baseRef.body && typeof baseRef.body === 'object' ? (baseRef.body as GitHubRefResponse).object?.sha : undefined
    if (!baseRef.response.ok || typeof baseSha !== 'string' || !baseSha) {
      throw new Error(`共享检测索引基线分支不可用（HTTP ${baseRef.response.status}）。`)
    }

    const refPath = `/repos/${targetRepository}/git/ref/heads/${encodeURIComponent(BATCH_BRANCH)}`
    let ref = await request(apiUrl(refPath))
    if (ref.response.status === 404) {
      ref = await request(apiUrl(`/repos/${targetRepository}/git/refs`), {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${BATCH_BRANCH}`, sha: baseSha }),
      })
    }
    const branchSha = ref.body && typeof ref.body === 'object' ? (ref.body as GitHubRefResponse).object?.sha : undefined
    if ((!ref.response.ok && ref.response.status !== 201) || typeof branchSha !== 'string' || !branchSha) {
      throw new Error(`无法创建共享检测分支（HTTP ${ref.response.status}）：${errorDetail(ref.body)}`)
    }

    const existingResult = await request(apiUrl(`/repos/${targetRepository}/contents/${CATALOG_INDEX_PATH}?ref=${encodeURIComponent(BATCH_BRANCH)}`))
    if (!existingResult.response.ok && existingResult.response.status !== 404) {
      throw new Error(`无法读取共享检测分支索引（HTTP ${existingResult.response.status}）：${errorDetail(existingResult.body)}`)
    }
    const existingEntries = existingResult.response.ok ? readIndexContent(existingResult.body) : []
    const upstreamIndexResult = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}/contents/${CATALOG_INDEX_PATH}?ref=${encodeURIComponent(upstreamBranch)}`))
    if (!upstreamIndexResult.response.ok && upstreamIndexResult.response.status !== 404) {
      throw new Error(`无法读取主仓库共享索引（HTTP ${upstreamIndexResult.response.status}）：${errorDetail(upstreamIndexResult.body)}`)
    }
    const upstreamEntries = upstreamIndexResult.response.ok ? readIndexContent(upstreamIndexResult.body) : []
    // main 上已合并的结果优先于用户旧分支；本次本地检测结果优先级最高。
    const xml = serializeCatalogIndex(mergeCatalogEntries(existingEntries, upstreamEntries, entries))
    if (existingResult.response.ok && xml === serializeCatalogIndex(existingEntries)) {
      return { submitted: 0, message: 'GitHub 共享检测索引已经是最新状态。' }
    }

    // 在生成 Git 对象后再检查一次 main，避免另一位用户刚合并的结果被旧基线覆盖。
    const latestBaseRef = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}/git/ref/heads/${encodeURIComponent(upstreamBranch)}`))
    const latestBaseSha = latestBaseRef.body && typeof latestBaseRef.body === 'object'
      ? (latestBaseRef.body as GitHubRefResponse).object?.sha
      : undefined
    if (!latestBaseRef.response.ok || typeof latestBaseSha !== 'string' || !latestBaseSha) {
      throw new Error(`共享检测索引基线分支不可用（HTTP ${latestBaseRef.response.status}）。`)
    }
    if (latestBaseSha !== baseSha) {
      throw new Error('共享检测索引基线发生变化，需要重新合并后提交。')
    }

    const commitResponse = await request(apiUrl(`/repos/${targetRepository}/git/commits/${encodeURIComponent(branchSha)}`))
    const treeSha = commitResponse.body && typeof commitResponse.body === 'object'
      ? (commitResponse.body as GitHubCommitResponse).tree?.sha
      : undefined
    if (!commitResponse.response.ok || typeof treeSha !== 'string' || !treeSha) {
      throw new Error(`无法读取共享检测分支树（HTTP ${commitResponse.response.status}）。`)
    }

    // 清理旧版本曾经上传到 plugin-update 的逐仓库检测报告，
    // 让共享 PR 的唯一业务文件始终是 catalog/index.xml。
    const branchTree = await request(apiUrl(`/repos/${targetRepository}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`))
    const branchTreeBody = branchTree.body as GitHubTreeListResponse | null
    if (!branchTree.response.ok || !branchTreeBody || branchTreeBody.truncated === true || !Array.isArray(branchTreeBody.tree)) {
      throw new Error(`无法读取共享检测分支文件列表（HTTP ${branchTree.response.status}）。`)
    }
    const reportDeletes = branchTreeBody.tree
      .filter((item): item is { path?: unknown; type?: unknown } => Boolean(item && typeof item === 'object'))
      .map(item => ({ path: item.path, type: item.type }))
      .filter(item => typeof item.path === 'string'
        && item.type === 'blob'
        && /^(?:catalog\/(?:analysis|reports)\/)/i.test(item.path)
        && !/\/\.gitkeep$/i.test(item.path))
      .map(item => ({ path: item.path as string, mode: '100644', type: 'blob', sha: null }))

    const blob = await request(apiUrl(`/repos/${targetRepository}/git/blobs`), {
      method: 'POST',
      body: JSON.stringify({ content: encodeContent(xml), encoding: 'base64' }),
    })
    const blobSha = blob.body && typeof blob.body === 'object' ? (blob.body as GitHubBlobResponse).sha : undefined
    if (!blob.response.ok || typeof blobSha !== 'string' || !blobSha) {
      throw new Error(`共享检测索引上传失败（HTTP ${blob.response.status}）：${errorDetail(blob.body)}`)
    }

    const tree = await request(apiUrl(`/repos/${targetRepository}/git/trees`), {
      method: 'POST',
      body: JSON.stringify({
        base_tree: treeSha,
        tree: [
          { path: CATALOG_INDEX_PATH, mode: '100644', type: 'blob', sha: blobSha },
          ...reportDeletes,
        ],
      }),
    })
    const newTreeSha = tree.body && typeof tree.body === 'object' ? (tree.body as GitHubTreeResponse).sha : undefined
    if (!tree.response.ok || typeof newTreeSha !== 'string' || !newTreeSha) {
      throw new Error(`共享检测索引目录树创建失败（HTTP ${tree.response.status}）：${errorDetail(tree.body)}`)
    }

    const commit = await request(apiUrl(`/repos/${targetRepository}/git/commits`), {
      method: 'POST',
      body: JSON.stringify({
        message: `catalog: update shared index (${entries.length})`,
        tree: newTreeSha,
        parents: [branchSha],
      }),
    })
    const newCommitSha = commit.body && typeof commit.body === 'object' ? (commit.body as GitHubCommitCreateResponse).sha : undefined
    if (!commit.response.ok || typeof newCommitSha !== 'string' || !newCommitSha) {
      throw new Error(`共享检测索引提交创建失败（HTTP ${commit.response.status}）：${errorDetail(commit.body)}`)
    }
    const updateRef = await request(apiUrl(`/repos/${targetRepository}/git/refs/heads/${encodeURIComponent(BATCH_BRANCH)}`), {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    })
    if (!updateRef.response.ok) throw new Error(`共享检测分支更新失败（HTTP ${updateRef.response.status}）：${errorDetail(updateRef.body)}`)

    const pullQuery = new URLSearchParams({ head: `${target.owner}:${BATCH_BRANCH}`, base: upstreamBranch, state: 'open', per_page: '1' })
    const pulls = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}/pulls?${pullQuery.toString()}`))
    if (!pulls.response.ok) throw new Error(`无法查询共享检测 PR（HTTP ${pulls.response.status}）：${errorDetail(pulls.body)}`)
    let pullRequestUrl: string | undefined
    if (Array.isArray(pulls.body) && pulls.body.length > 0) {
      const first = pulls.body[0] as GitHubPullRequest
      if (typeof first.html_url === 'string') pullRequestUrl = first.html_url
    } else {
      const created = await request(apiUrl(`/repos/${LAUNCHER_REPOSITORY}/pulls`), {
        method: 'POST',
        body: JSON.stringify({
          title: `catalog: update shared index (${entries.length})`,
          head: `${target.owner}:${BATCH_BRANCH}`,
          base: upstreamBranch,
          body: `由 DSH Melody Launcher 自动提交的精简检测标签。\n\n- 仓库数量：${entries.length}\n- 提交者：@${auth.login}\n- 文件：${CATALOG_INDEX_PATH}`,
        }),
      })
      if (!created.response.ok) throw new Error(`共享检测 PR 创建失败（HTTP ${created.response.status}）：${errorDetail(created.body)}`)
      const pull = created.body as GitHubPullRequest
      if (typeof pull.html_url === 'string') pullRequestUrl = pull.html_url
    }

    remoteCache = null
    return {
      submitted: entries.length,
      pullRequestUrl,
      message: pullRequestUrl
        ? `已将 ${entries.length} 条检测标签合并进单个 XML，并提交 PR。`
        : `已将 ${entries.length} 条检测标签合并进单个 XML。`,
    }
  }

  // 同一用户的旧 plugin-update 分支可能在另一个客户端刚刚推进。
  // GitHub 会拒绝非快进 PATCH；重新读取分支和 main 后再做一次结构化合并即可保留双方不同仓库的结果。
  const publishEntries = async (
    entries: CatalogIndexEntry[],
  ): Promise<{ submitted: number; pullRequestUrl?: string; message: string }> => {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await publishEntriesAttempt(entries)
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        const retryable = /共享检测分支更新失败（HTTP (409|422)）|共享检测索引基线发生变化/.test(message)
        if (!retryable || attempt >= 2) throw error
        remoteCache = null
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  const syncLocalAnalysis = async (
    entry: CatalogIndexEntry,
    analysis: CatalogRepositoryAnalysis,
  ): Promise<CatalogRepositoryAnalysis> => {
    if (pendingDir) {
      const changed = await queueEntry(entry)
      return {
        ...analysis,
        sync: {
          source: 'local',
          state: 'queued',
          message: changed
            ? '检测标签已写入本地 XML，启动 DSH 时会合并提交。'
            : '检测标签未变化，本地 XML 无需重复写入。',
        },
      }
    }
    const result = await enqueuePublish(() => publishEntries([entry]))
    return {
      ...analysis,
      sync: {
        source: 'local',
        state: result.submitted > 0
          ? 'published'
          : result.message.includes('未登录') ? 'not-authenticated' : 'queued',
        message: result.message,
        pullRequestUrl: result.pullRequestUrl,
      },
    }
  }

  return {
    async refreshIndex() {
      return readRemoteIndex(true)
    },
    async resolve(repository, defaultBranch, repositoryUpdatedAt, analyzeLocal, onRemoteProgress) {
      let remote: CatalogIndexEntry | null = null
      onRemoteProgress?.('正在读取 GitHub 共享标签索引')
      let remoteReadFailed = false
      try {
        remote = (await readRemoteIndex(true)).find(entry => entry.repository.toLowerCase() === repository.toLowerCase()) ?? null
      } catch {
        // 远端暂时不可用时才允许使用过期内存快照，正常路径不会被 5 分钟缓存拦截。
        remoteReadFailed = true
        remote = remoteCache?.entries.find(entry => entry.repository.toLowerCase() === repository.toLowerCase()) ?? null
        onRemoteProgress?.(remote ? 'GitHub 共享索引读取失败，暂时使用本地缓存' : 'GitHub 共享索引读取失败，将执行本地检测')
      }

      const remoteFresh = Boolean(remote
        && !remoteReadFailed
        && remote.defaultBranch === defaultBranch
        && isFresh(remote.repositoryUpdatedAt, repositoryUpdatedAt))
      if (remoteFresh && remote && (remote.tags.includes('invalid') || remote.tags.includes('dsh'))) {
        const analysis = classificationOnlyAnalysis(remote)
        return {
          ...analysis,
          sync: {
            source: 'github',
            state: 'remote',
            message: `已直接使用 GitHub 标签索引（${remote.tags.join(', ')}）。`,
          },
        }
      }
      try {
        const preferredKinds = remoteFresh && remote ? catalogComponentKindsFromTags(remote.tags) : undefined
        const local = await analyzeLocal(preferredKinds)
        const entry = entryFromAnalysis(repository, defaultBranch, repositoryUpdatedAt, local)
        if (remoteFresh && remote && sameTags(remote.tags, entry.tags)) {
          if (pendingDir) await removePendingEntries([entry])
          return {
            ...local,
            sync: {
              source: 'github',
              state: 'remote',
              message: `已使用 GitHub 标签索引（${entry.tags.join(', ')}）并补全安装入口。`,
            },
          }
        }
        return await syncLocalAnalysis(entry, local)
      } catch (error) {
        if (remote) {
          return {
            ...classificationOnlyAnalysis(remote),
            sync: {
              source: 'github',
              state: 'stale-fallback',
              message: '安装入口补全失败，暂时只显示 GitHub 上的类型标签。',
            },
          }
        }
        throw error
      }
    },

    async flushPending() {
      if (pendingFlush) return pendingFlush
      pendingFlush = (async () => {
        const entries = await enqueuePending(() => readPendingNow())
        if (!pendingDir || entries.length === 0) return { submitted: 0, message: '没有新的共享检测标签需要提交。' }
        return enqueuePublish(() => publishEntries(entries))
          .then(async result => {
            if (result.submitted > 0 || result.message.includes('最新')) await removePendingEntries(entries)
            return result
          })
          .catch(error => ({
            submitted: 0,
            message: `共享检测 XML 提交失败，标签仍保存在本地：${error instanceof Error ? error.message : String(error)}`,
          }))
      })()
      try {
        const result = await pendingFlush
        if (result.submitted > 0 || result.message.includes('失败')) options.onFlush?.(result)
        return result
      } finally {
        pendingFlush = null
      }
    },
  }
}

export { CATALOG_BRANCH, CATALOG_DIRECTORY, CATALOG_INDEX_PATH, LAUNCHER_REPOSITORY, repositoryPath }
