import { parseGitHubImportUrl } from '../src/lib/github-import'
import type {
  CatalogImportResult,
  CatalogRepositoryAnalysis,
  CatalogRepositoryResult,
} from '../src/types'
import { isDshRepository } from './dsh-install'
import { mapCatalogRepository, type GitHubRepositoryItem } from './discovery'
import { isSafeRepositoryName } from './profile'

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}

/** 尽力获取仓库元数据；任何失败（限流/私有/网络）都返回 null，不阻断导入。 */
export async function fetchGitHubRepository(
  fullName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRepositoryItem | null> {
  const [owner, repo] = fullName.split('/')
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: GITHUB_HEADERS },
    )
    if (!response.ok) return null
    return await response.json() as GitHubRepositoryItem
  } catch {
    return null
  }
}

/** FNV-1a 哈希取负：无元数据时生成稳定、不撞 GitHub 正数 id 的 React key。 */
export function syntheticImportId(fullName: string): number {
  let hash = 2166136261
  for (let i = 0; i < fullName.length; i += 1) {
    hash ^= fullName.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return -(hash >>> 0)
}

export function buildImportedRepository(
  item: GitHubRepositoryItem | null,
  fullName: string,
  branch: string,
): CatalogRepositoryResult {
  if (item) {
    const row = mapCatalogRepository(item, [])
    if (branch !== row.defaultBranch) row.defaultBranch = branch
    return row
  }
  const [owner, repo] = fullName.split('/')
  return {
    id: syntheticImportId(fullName),
    fullName,
    name: repo,
    owner,
    description: '通过 GitHub 链接导入的仓库，检测前暂未获取到描述。',
    url: `https://github.com/${fullName}`,
    stars: 0,
    language: null,
    updatedAt: new Date().toISOString(),
    topics: [],
    defaultBranch: branch,
    kind: isDshRepository(fullName) ? 'dsh' : 'repository',
    candidateTypes: [],
  }
}

/** 解析 → 取元数据 → 定分支 → 建行 → 调分析。分析器由调用方注入，便于单测。 */
export async function importCatalogFromUrl(
  url: string,
  analyze: (fullName: string, branch: string, repositoryUpdatedAt?: string) => Promise<CatalogRepositoryAnalysis>,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogImportResult> {
  const parsed = parseGitHubImportUrl(url)
  if (!isSafeRepositoryName(parsed.fullName)) throw new Error('GitHub 仓库名称无效。')
  const item = await fetchGitHubRepository(parsed.fullName, fetchImpl)
  const branch = parsed.defaultBranch ?? item?.default_branch ?? 'main'
  const repository = buildImportedRepository(item, parsed.fullName, branch)
  const analysis = await analyze(parsed.fullName, branch, item ? repository.updatedAt : undefined)
  return { repository, analysis }
}
