import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogRepositoryAnalysis } from '../src/types'
import { catalogTagsFromAnalysis, parseCatalogIndex, serializeCatalogIndex } from '../electron/catalog-index'
import { mergeCatalogEntries } from '../electron/catalog-sync'
import { createCatalogSyncService } from '../electron/catalog-sync'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function analysis(repository = 'demo/example', kind: CatalogRepositoryAnalysis['kind'] = 'plugin'): CatalogRepositoryAnalysis {
  return {
    repository,
    defaultBranch: 'main',
    kind,
    componentKinds: kind === 'hybrid' ? ['plugin', 'skill'] : kind === 'dsh' || kind === 'invalid' ? [] : [kind],
    summary: '检测结果',
    pluginAnalysis: null,
    skillAnalysis: null,
    applicationAnalysis: null,
    presetAnalysis: null,
    warnings: [],
  }
}

function indexContent(entries: Array<{ repository: string; tags: string; updated?: string }>): string {
  return serializeCatalogIndex(entries.map(entry => ({
    repository: entry.repository,
    defaultBranch: 'main',
    repositoryUpdatedAt: entry.updated ?? '2026-08-18T00:00:00.000Z',
    tags: entry.tags.split(',') as never[],
  })))
}

describe('共享 XML 索引', () => {
  it('只保存最终标签并按仓库名排序', () => {
    const xml = indexContent([
      { repository: 'zeta/tool', tags: 'runtime' },
      { repository: 'Alpha/plugin', tags: 'plugin,skill' },
    ])
    expect(xml).not.toContain('summary')
    expect(xml.indexOf('Alpha/plugin')).toBeLessThan(xml.indexOf('zeta/tool'))
    expect(parseCatalogIndex(xml)).toEqual([
      expect.objectContaining({ repository: 'Alpha/plugin', tags: ['plugin', 'skill'] }),
      expect.objectContaining({ repository: 'zeta/tool', tags: ['runtime'] }),
    ])
  })

  it('把统一检测结果压缩成安装分类标签', () => {
    expect(catalogTagsFromAnalysis(analysis('demo/p', 'plugin'))).toEqual(['plugin'])
    expect(catalogTagsFromAnalysis(analysis('demo/h', 'hybrid'))).toEqual(['plugin', 'skill'])
    expect(catalogTagsFromAnalysis(analysis('demo/d', 'dsh'))).toEqual(['dsh'])
    expect(catalogTagsFromAnalysis(analysis('demo/i', 'invalid'))).toEqual(['invalid'])
  })
})

describe('GitHub shared catalog XML', () => {
  it('每次检测优先向远端校验，并用 ETag 避免重复下载 XML', async () => {
    const xml = indexContent([{ repository: 'demo/example', tags: 'plugin', updated: '2026-08-18T00:00:00.000Z' }])
    const seenIfNoneMatch: Array<string | null> = []
    let calls = 0
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      seenIfNoneMatch.push(new Headers(init?.headers).get('If-None-Match'))
      if (calls === 1) return new Response(JSON.stringify({ content: Buffer.from(xml).toString('base64'), sha: 'catalog-a' }), { status: 200, headers: { etag: '"catalog-a"' } })
      return new Response(null, { status: 304, headers: { etag: '"catalog-a"' } })
    }) as unknown as typeof fetch
    const analyzeLocal = vi.fn(async (kinds?: string[]) => {
      expect(kinds).toEqual(['plugin'])
      return analysis()
    })
    const service = createCatalogSyncService({
      fetchImpl,
      getAuthStatus: async () => ({ authenticated: false, login: null }),
    })

    await service.resolve('demo/example', 'main', '2026-08-17T00:00:00.000Z', analyzeLocal)
    await service.resolve('demo/example', 'main', '2026-08-17T00:00:00.000Z', analyzeLocal)

    expect(calls).toBe(2)
    expect(seenIfNoneMatch).toEqual([null, '"catalog-a"'])
    expect(analyzeLocal).toHaveBeenCalledTimes(2)
  })

  it('uses a fresh XML tag and passes only the tagged detector kinds', async () => {
    const xml = indexContent([{ repository: 'demo/example', tags: 'plugin', updated: '2026-08-18T00:00:00.000Z' }])
    const fetchImpl = vi.fn(async () => json({ content: Buffer.from(xml).toString('base64') })) as unknown as typeof fetch
    const analyzeLocal = vi.fn(async (kinds?: string[]) => {
      expect(kinds).toEqual(['plugin'])
      return analysis()
    })
    const service = createCatalogSyncService({
      fetchImpl,
      getAuthStatus: async () => ({ authenticated: false, login: null }),
    })
    const result = await service.resolve('demo/example', 'main', '2026-08-17T00:00:00.000Z', analyzeLocal)
    expect(result.sync).toMatchObject({ source: 'github', state: 'remote' })
    expect(analyzeLocal).toHaveBeenCalledOnce()
  })

  it('结构化合并不同用户的结果，后来的同名仓库结果覆盖旧结果', () => {
    const first = parseCatalogIndex(indexContent([
      { repository: 'demo/base', tags: 'plugin' },
      { repository: 'demo/shared', tags: 'plugin', updated: '2026-08-18T00:00:00.000Z' },
    ]))
    const second = parseCatalogIndex(indexContent([
      { repository: 'demo/other', tags: 'skill' },
      { repository: 'demo/shared', tags: 'skill', updated: '2026-08-19T00:00:00.000Z' },
    ]))
    const merged = mergeCatalogEntries(first, second)
    expect(merged.map(entry => entry.repository)).toEqual(['demo/base', 'demo/other', 'demo/shared'])
    expect(merged.find(entry => entry.repository === 'demo/shared')?.tags).toEqual(['skill'])
  })

  it('分支非快进时重新读取并合并主仓库和分支结果', async () => {
    const pendingDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-catalog-publish-'))
    const pending = parseCatalogIndex(indexContent([{ repository: 'demo/local', tags: 'skill' }]))
    await writeFile(path.join(pendingDir, 'index.xml'), serializeCatalogIndex(pending), 'utf8')
    const branchEntries = indexContent([{ repository: 'demo/branch', tags: 'plugin' }])
    const mainEntries = indexContent([{ repository: 'demo/main', tags: 'runtime' }])
    let branchRefReads = 0
    let patchCalls = 0
    let uploadedXml = ''
    let uploadedTreeBody: { tree?: Array<{ path?: string; sha?: string | null }> } | null = null
    const requestLog: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? 'GET'
      requestLog.push(`${method} ${url}`)
      const parsed = new URL(url)
      const pathname = parsed.pathname
      if (method === 'GET' && pathname === '/repos/rirko/dsh-melody-launcher') return json({ default_branch: 'main' })
      if (method === 'GET' && pathname === '/repos/alice/dsh-melody-launcher') return json({ default_branch: 'main', parent: { full_name: 'rirko/dsh-melody-launcher' } })
      if (method === 'GET' && pathname === '/repos/rirko/dsh-melody-launcher/git/ref/heads/main') return json({ object: { sha: 'main-sha' } })
      if (method === 'GET' && pathname === '/repos/alice/dsh-melody-launcher/git/ref/heads/plugin-update') {
        branchRefReads += 1
        return branchRefReads === 1 ? json({ message: 'Not Found' }, 404) : json({ object: { sha: 'branch-sha-2' } })
      }
      if (method === 'POST' && pathname === '/repos/alice/dsh-melody-launcher/git/refs') return json({ object: { sha: 'branch-sha-1' } }, 201)
      if (method === 'GET' && pathname === '/repos/alice/dsh-melody-launcher/contents/catalog/index.xml') {
        return branchRefReads < 2 ? json({ message: 'Not Found' }, 404) : json({ content: Buffer.from(branchEntries).toString('base64') })
      }
      if (method === 'GET' && pathname === '/repos/rirko/dsh-melody-launcher/contents/catalog/index.xml') return json({ content: Buffer.from(mainEntries).toString('base64') })
      if (method === 'GET' && pathname.startsWith('/repos/alice/dsh-melody-launcher/git/commits/')) return json({ tree: { sha: 'tree-sha' } })
      if (method === 'GET' && pathname === '/repos/alice/dsh-melody-launcher/git/trees/tree-sha') return json({ tree: [
        { path: 'catalog/analysis/legacy.json', type: 'blob' },
        { path: 'catalog/analysis/.gitkeep', type: 'blob' },
      ] })
      if (method === 'POST' && pathname === '/repos/alice/dsh-melody-launcher/git/blobs') {
        const body = JSON.parse(String(init?.body)) as { content?: string }
        uploadedXml = Buffer.from(body.content ?? '', 'base64').toString('utf8')
        return json({ sha: 'blob-sha' })
      }
      if (method === 'POST' && pathname === '/repos/alice/dsh-melody-launcher/git/trees') {
        uploadedTreeBody = JSON.parse(String(init?.body)) as typeof uploadedTreeBody
        return json({ sha: 'new-tree-sha' })
      }
      if (method === 'POST' && pathname === '/repos/alice/dsh-melody-launcher/git/commits') return json({ sha: `commit-${patchCalls + 1}` })
      if (method === 'PATCH' && pathname === '/repos/alice/dsh-melody-launcher/git/refs/heads/plugin-update') {
        patchCalls += 1
        return patchCalls === 1 ? json({ message: 'Update is not a fast forward' }, 409) : json({ ok: true })
      }
      if (method === 'GET' && pathname === '/repos/rirko/dsh-melody-launcher/pulls') return json([])
      if (method === 'POST' && pathname === '/repos/rirko/dsh-melody-launcher/pulls') return json({ html_url: 'https://github.com/rirko/dsh-melody-launcher/pull/99' }, 201)
      throw new Error(`未模拟的请求：${method} ${url}`)
    }) as unknown as typeof fetch
    try {
      const service = createCatalogSyncService({
        fetchImpl,
        pendingDir,
        getAuthStatus: async () => ({ authenticated: true, login: 'alice' }),
      })
      const result = await service.flushPending()
      expect(result.submitted).toBe(1)
      expect(result.pullRequestUrl).toContain('/pull/99')
      expect(patchCalls).toBe(2)
      expect(uploadedXml).toContain('demo/main')
      expect(uploadedXml).toContain('demo/branch')
      expect(uploadedXml).toContain('demo/local')
      expect((uploadedTreeBody as { tree?: Array<{ path?: string; sha?: string | null }> } | null)?.tree).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'catalog/index.xml', sha: 'blob-sha' }),
        expect.objectContaining({ path: 'catalog/analysis/legacy.json', sha: null }),
      ]))
      expect(requestLog.filter(entry => entry.includes('/git/ref/heads/plugin-update')).length).toBeGreaterThanOrEqual(2)
      const commitRequest = requestLog.find(entry => entry === 'POST https://api.github.com/repos/alice/dsh-melody-launcher/git/commits')
      expect(commitRequest).toBeDefined()
    } finally {
      await rm(pendingDir, { recursive: true, force: true })
    }
  })

  it('queues many results into one local index file', async () => {
    const pendingDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-catalog-'))
    try {
      const fetchImpl = vi.fn(async () => json({}, 404)) as unknown as typeof fetch
      const service = createCatalogSyncService({
        fetchImpl,
        pendingDir,
        getAuthStatus: async () => ({ authenticated: false, login: null }),
      })
      await service.resolve('zeta/example', 'main', '2026-08-18T00:00:00.000Z', async () => analysis('zeta/example'))
      await service.resolve('Alpha/example', 'main', '2026-08-18T00:00:00.000Z', async () => analysis('Alpha/example'))
      const localXml = await readFile(path.join(pendingDir, 'index.xml'), 'utf8')
      expect(localXml).toContain('<dsh-catalog')
      expect(localXml).not.toContain('pluginAnalysis')
      expect(localXml.indexOf('Alpha/example')).toBeLessThan(localXml.indexOf('zeta/example'))
    } finally {
      await rm(pendingDir, { recursive: true, force: true })
    }
  })
})
