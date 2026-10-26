import { describe, expect, it, vi } from 'vitest'
import { parseGitHubImportUrl, isSafeGitHubBranch } from '../src/lib/github-import'
import {
  buildImportedRepository,
  fetchGitHubRepository,
  importCatalogFromUrl,
  syntheticImportId,
} from '../electron/github-import'
import type { CatalogRepositoryAnalysis } from '../src/types'
import type { GitHubRepositoryItem } from '../electron/discovery'

const item: GitHubRepositoryItem = {
  id: 42,
  full_name: 'someone/dsh-example',
  name: 'dsh-example',
  owner: { login: 'someone' },
  description: 'An example plugin',
  html_url: 'https://github.com/someone/dsh-example',
  stargazers_count: 12,
  size: 1536,
  language: 'TypeScript',
  updated_at: '2026-08-01T00:00:00Z',
  topics: ['dsh-plugin'],
  default_branch: 'main',
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('parseGitHubImportUrl', () => {
  it('parses https GitHub links, stripping .git and www', () => {
    expect(parseGitHubImportUrl('https://github.com/owner/repo')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('https://github.com/owner/repo.git')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('https://www.github.com/owner/repo')).toEqual({ fullName: 'owner/repo' })
  })

  it('extracts the branch from /tree/ and /blob/ paths and ignores subdirectories', () => {
    expect(parseGitHubImportUrl('https://github.com/owner/repo/tree/main')).toEqual({ fullName: 'owner/repo', defaultBranch: 'main' })
    expect(parseGitHubImportUrl('https://github.com/owner/repo/tree/main/packages/foo')).toEqual({ fullName: 'owner/repo', defaultBranch: 'main' })
    expect(parseGitHubImportUrl('https://github.com/owner/repo/blob/main/README.md')).toEqual({ fullName: 'owner/repo', defaultBranch: 'main' })
  })

  it('takes the first path segment as branch for slash-containing branch names (known heuristic)', () => {
    expect(parseGitHubImportUrl('https://github.com/owner/repo/tree/feature/foo')).toEqual({ fullName: 'owner/repo', defaultBranch: 'feature' })
  })

  it('parses ssh, git+, shortcut and bare forms', () => {
    expect(parseGitHubImportUrl('git@github.com:owner/repo.git')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('git+https://github.com/owner/repo.git')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('github:owner/repo')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('owner/repo')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('github.com/owner/repo')).toEqual({ fullName: 'owner/repo' })
  })

  it('ignores query, fragment, and non-tree/blob trailing paths', () => {
    expect(parseGitHubImportUrl('https://github.com/owner/repo?tab=readme')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('https://github.com/owner/repo#readme')).toEqual({ fullName: 'owner/repo' })
    expect(parseGitHubImportUrl('https://github.com/owner/repo/pulls/3')).toEqual({ fullName: 'owner/repo' })
  })

  it('rejects empty and whitespace-only input', () => {
    expect(() => parseGitHubImportUrl('')).toThrow(/请输入/)
    expect(() => parseGitHubImportUrl('   ')).toThrow(/请输入/)
  })

  it('rejects non-GitHub hosts', () => {
    expect(() => parseGitHubImportUrl('https://gitlab.com/owner/repo')).toThrow(/只支持 GitHub/)
    expect(() => parseGitHubImportUrl('https://example.com/x/y')).toThrow(/只支持 GitHub/)
  })

  it('rejects links without a repository path', () => {
    expect(() => parseGitHubImportUrl('https://github.com/')).toThrow(/缺少仓库名称/)
    expect(() => parseGitHubImportUrl('https://github.com/owner')).toThrow(/缺少仓库名称/)
  })

  it('rejects unparseable or incomplete input', () => {
    expect(() => parseGitHubImportUrl('not a repo')).toThrow(/只支持 GitHub/)
    expect(() => parseGitHubImportUrl('owner')).toThrow(/只支持 GitHub/)
  })
})

describe('isSafeGitHubBranch', () => {
  it('accepts common branch names', () => {
    expect(isSafeGitHubBranch('main')).toBe(true)
    expect(isSafeGitHubBranch('v1.2.3')).toBe(true)
    expect(isSafeGitHubBranch('feature/foo')).toBe(true)
    expect(isSafeGitHubBranch('release-1.0')).toBe(true)
  })

  it('rejects empty, traversal, oversized and unsafe branches', () => {
    expect(isSafeGitHubBranch('')).toBe(false)
    expect(isSafeGitHubBranch('..')).toBe(false)
    expect(isSafeGitHubBranch('..hidden')).toBe(false)
    expect(isSafeGitHubBranch('a'.repeat(200))).toBe(false)
    expect(isSafeGitHubBranch('main@{')).toBe(false)
    expect(isSafeGitHubBranch('main ')).toBe(false)
  })
})

describe('fetchGitHubRepository', () => {
  it('returns the repository item on success', async () => {
    const urlCalls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      urlCalls.push(String(input))
      return jsonResponse(item)
    }) as typeof fetch
    const result = await fetchGitHubRepository('someone/dsh-example', fetchImpl)
    expect(result?.full_name).toBe('someone/dsh-example')
    expect(urlCalls[0]).toMatch(/^https:\/\/api\.github\.com\/repos\/someone\/dsh-example$/)
  })

  it('returns null on any HTTP error', async () => {
    for (const status of [404, 403, 500]) {
      const fetchImpl = (async () => jsonResponse({}, status)) as typeof fetch
      await expect(fetchGitHubRepository('owner/repo', fetchImpl)).resolves.toBeNull()
    }
  })

  it('returns null when the network request throws', async () => {
    const fetchImpl = (async () => { throw new Error('network down') }) as typeof fetch
    await expect(fetchGitHubRepository('owner/repo', fetchImpl)).resolves.toBeNull()
  })
})

describe('buildImportedRepository', () => {
  it('maps real metadata and lets the URL branch win over the metadata default', () => {
    const row = buildImportedRepository(item, 'someone/dsh-example', 'develop')
    expect(row.id).toBe(42)
    expect(row.fullName).toBe('someone/dsh-example')
    expect(row.kind).toBe('repository')
    expect(row.candidateTypes).toEqual([])
    expect(row.defaultBranch).toBe('develop')
  })

  it('builds a minimal synthetic row when metadata is unavailable', () => {
    const row = buildImportedRepository(null, 'someone/dsh-example', 'main')
    expect(row.id).toBeLessThan(0)
    expect(row.fullName).toBe('someone/dsh-example')
    expect(row.name).toBe('dsh-example')
    expect(row.owner).toBe('someone')
    expect(row.defaultBranch).toBe('main')
    expect(row.stars).toBe(0)
    expect(row.kind).toBe('repository')
    expect(row.candidateTypes).toEqual([])
  })

  it('marks the official repository as DSH core even without metadata', () => {
    const row = buildImportedRepository(null, 'deepseek-ai/deepseek-harness', 'master')
    expect(row.kind).toBe('dsh')
  })
})

describe('syntheticImportId', () => {
  it('is negative and deterministic', () => {
    const first = syntheticImportId('someone/dsh-example')
    const second = syntheticImportId('someone/dsh-example')
    expect(first).toBeLessThan(0)
    expect(first).toBe(second)
  })
})

describe('importCatalogFromUrl', () => {
  const analysis: CatalogRepositoryAnalysis = {
    repository: 'someone/dsh-example',
    defaultBranch: 'main',
    kind: 'plugin',
    componentKinds: ['plugin'],
    summary: 'ok',
    pluginAnalysis: null,
    skillAnalysis: null,
    applicationAnalysis: null,
    warnings: [],
  }

  it('prefers the URL branch over metadata', async () => {
    const analyze = vi.fn(async (_fullName: string, _branch: string) => analysis)
    const fetchImpl = (async () => jsonResponse(item)) as typeof fetch
    const result = await importCatalogFromUrl(
      'https://github.com/someone/dsh-example/tree/develop',
      analyze,
      fetchImpl,
    )
    expect(result.repository.defaultBranch).toBe('develop')
    expect(analyze).toHaveBeenCalledWith('someone/dsh-example', 'develop', '2026-08-01T00:00:00Z')
  })

  it('falls back to the metadata default branch when the URL has none', async () => {
    const analyze = vi.fn(async (_fullName: string, _branch: string) => analysis)
    const fetchImpl = (async () => jsonResponse({ ...item, default_branch: 'master' })) as typeof fetch
    const result = await importCatalogFromUrl('https://github.com/someone/dsh-example', analyze, fetchImpl)
    expect(result.repository.defaultBranch).toBe('master')
    expect(analyze).toHaveBeenCalledWith('someone/dsh-example', 'master', '2026-08-01T00:00:00Z')
  })

  it('falls back to main when metadata is unavailable and the URL has no branch', async () => {
    const analyze = vi.fn(async (_fullName: string, _branch: string) => analysis)
    const fetchImpl = (async () => { throw new Error('network down') }) as typeof fetch
    const result = await importCatalogFromUrl('someone/dsh-example', analyze, fetchImpl)
    expect(result.repository.defaultBranch).toBe('main')
    expect(analyze).toHaveBeenCalledWith('someone/dsh-example', 'main', undefined)
  })

  it('returns the analysis from the injected analyzer', async () => {
    const analyze = vi.fn(async (_fullName: string, _branch: string) => analysis)
    const fetchImpl = (async () => jsonResponse(item)) as typeof fetch
    const result = await importCatalogFromUrl('https://github.com/someone/dsh-example', analyze, fetchImpl)
    expect(result.analysis.kind).toBe('plugin')
    expect(result.repository.fullName).toBe('someone/dsh-example')
  })

  it('propagates parse errors', async () => {
    const analyze = vi.fn(async (_fullName: string, _branch: string) => analysis)
    await expect(importCatalogFromUrl('https://gitlab.com/x/y', analyze)).rejects.toThrow(/只支持 GitHub/)
    expect(analyze).not.toHaveBeenCalled()
  })
})
