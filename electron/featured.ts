import type { CatalogRepositoryResult } from '../src/types'
import { syntheticImportId } from './github-import'

/**
 * 市场内置（featured）条目：无需 topic 检索、稳定出现在列表顶部的官方推荐。
 * id 用合成负值，避免与 GitHub 正数 id 冲突（React key 唯一）。
 */
export const FEATURED_REPOSITORIES: CatalogRepositoryResult[] = [
  {
    id: syntheticImportId('yjh051108/dsh-routing-suite'),
    fullName: 'yjh051108/dsh-routing-suite',
    name: 'dsh-routing-suite',
    owner: 'yjh051108',
    description: '内置路由套件：dsh-super-injector、dsh-mode-boost 插件与 dsh-router-standard 预设，一键安装全部组件。',
    url: 'https://github.com/yjh051108/dsh-routing-suite',
    stars: 0,
    language: null,
    updatedAt: '2026-08-01T00:00:00Z',
    topics: ['dsh-plugin', 'dsh-skill'],
    defaultBranch: 'main',
    kind: 'repository',
    candidateTypes: ['plugin', 'skill'],
    featured: true,
  },
]

/** 把内置条目前插到检索结果顶部；与结果里已存在的同名仓库去重。 */
export function prependFeatured(
  repositories: CatalogRepositoryResult[],
  featuredRepositories: CatalogRepositoryResult[] = FEATURED_REPOSITORIES,
): CatalogRepositoryResult[] {
  const existing = new Set(repositories.map(repository => repository.fullName.toLowerCase()))
  return [
    ...featuredRepositories.filter(repository => !existing.has(repository.fullName.toLowerCase())),
    ...repositories,
  ]
}
