import { describe, expect, it, vi } from 'vitest'
import { analyzeCatalogPageInParallel } from '../src/lib/catalog-batch'
import type { CatalogRepositoryAnalysis, CatalogRepositoryResult } from '../src/types'

function repository(name: string, id: number): CatalogRepositoryResult {
  return {
    id,
    fullName: `demo/${name}`,
    name,
    owner: 'demo',
    description: name,
    url: `https://github.com/demo/${name}`,
    stars: 0,
    language: 'TypeScript',
    updatedAt: '2026-08-17T00:00:00.000Z',
    topics: ['dsh-plugin'],
    defaultBranch: 'main',
    kind: 'repository',
    candidateTypes: ['plugin'],
  }
}

function analysis(repo: CatalogRepositoryResult): CatalogRepositoryAnalysis {
  return {
    repository: repo.fullName,
    defaultBranch: repo.defaultBranch,
    kind: 'invalid',
    componentKinds: [],
    summary: 'invalid',
    pluginAnalysis: null,
    skillAnalysis: null,
    applicationAnalysis: null,
    presetAnalysis: null,
    warnings: [],
  }
}

describe('analyzeCatalogPageInParallel', () => {
  it('starts the whole page before any repository finishes', async () => {
    const repositories = [repository('one', 1), repository('two', 2), repository('three', 3)]
    const resolvers = new Map<string, (value: CatalogRepositoryAnalysis) => void>()
    const started: string[] = []
    const settled: Array<{ repository: string; completed: number }> = []
    const analyze = vi.fn((repo: CatalogRepositoryResult) => {
      started.push(repo.fullName)
      return new Promise<CatalogRepositoryAnalysis>(resolve => resolvers.set(repo.fullName, resolve))
    })

    const pending = analyzeCatalogPageInParallel(repositories, analyze, (outcome, completed) => {
      settled.push({ repository: outcome.repository.fullName, completed })
    })

    expect(started).toEqual(['demo/one', 'demo/two', 'demo/three'])
    expect(settled).toEqual([])

    resolvers.get('demo/two')?.(analysis(repositories[1]))
    await Promise.resolve()
    resolvers.get('demo/one')?.(analysis(repositories[0]))
    await Promise.resolve()
    resolvers.get('demo/three')?.(analysis(repositories[2]))

    await expect(pending).resolves.toHaveLength(3)
    expect(settled).toEqual([
      { repository: 'demo/two', completed: 1 },
      { repository: 'demo/one', completed: 2 },
      { repository: 'demo/three', completed: 3 },
    ])
  })

  it('reports a failed repository without cancelling the rest', async () => {
    const repositories = [repository('ok', 1), repository('failed', 2)]
    const settled: string[] = []
    const outcomes = await analyzeCatalogPageInParallel(
      repositories,
      async repo => {
        if (repo.name === 'failed') throw new Error('rate limited')
        return analysis(repo)
      },
      outcome => settled.push(`${outcome.repository.name}:${outcome.status}`),
    )

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(settled).toContain('ok:fulfilled')
    expect(settled).toContain('failed:rejected')
  })
})
