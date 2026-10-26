import { describe, expect, it } from 'vitest'
import { analyzeSkillRepository } from '../electron/skill-catalog'

function mockFetch(repository: string, files: Record<string, string>, oversized: string[] = []): typeof fetch {
  const commit = 'a'.repeat(40)
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    if (parsed.hostname === 'api.github.com' && parsed.pathname.includes(`/repos/${repository}/commits/`)) {
      return new Response(JSON.stringify({ sha: commit }), { status: 200 })
    }
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith(`/repos/${repository}/git/trees/${commit}`)) {
      return new Response(JSON.stringify({
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          type: 'blob',
          size: oversized.includes(path) ? 3 * 1024 * 1024 : Buffer.byteLength(content),
        })),
      }), { status: 200 })
    }
    if (parsed.hostname === 'raw.githubusercontent.com') {
      const path = decodeURIComponent(parsed.pathname.split('/').slice(4).join('/'))
      if (files[path] === undefined) return new Response('', { status: 404 })
      const content = files[path]
      return new Response(content, { status: 200, headers: { 'content-length': String(Buffer.byteLength(content)) } })
    }
    throw new Error(`未模拟的请求：${url}`)
  }) as typeof fetch
}

describe('GitHub skill analysis', () => {
  it('finds multiple valid skill bundles and ignores ordinary markdown', async () => {
    const repository = 'demo/skill-pack'
    const analysis = await analyzeSkillRepository(repository, 'main', mockFetch(repository, {
      'README.md': '# Readme',
      'academic/SKILL.md': '---\nname: academic\ndescription: Academic workflow.\n---\nBody',
      'skills/release/SKILL.md': '---\nname: release-check\ndescription: Release workflow.\n---\nBody',
    }))

    expect(analysis.installability).toBe('choice')
    expect(analysis.targets.map(target => target.name)).toEqual(['academic', 'release-check'])
    expect(analysis.targets.every(target => target.format === 'bundle')).toBe(true)
    expect(analysis.targets.every(target => target.revision === 'main')).toBe(true)
  })

  it('marks a topic repository without valid frontmatter as invalid', async () => {
    const repository = 'demo/not-a-skill'
    const analysis = await analyzeSkillRepository(repository, 'main', mockFetch(repository, {
      'README.md': '# Index',
      'SKILL.md': '# Missing frontmatter',
    }))

    expect(analysis.installability).toBe('invalid')
    expect(analysis.targets).toEqual([])
  })

  it('supports a flat markdown skill in the repository root', async () => {
    const repository = 'demo/flat-skill'
    const analysis = await analyzeSkillRepository(repository, 'feature/skills', mockFetch(repository, {
      'quick-review.md': '---\nname: quick-review\ndescription: Review a change.\nuser-invocable: false\n---\nBody',
    }))

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets[0]).toMatchObject({
      name: 'quick-review',
      format: 'flat',
      sourcePath: 'quick-review.md',
      revision: 'feature/skills',
      userInvocable: false,
    })
  })

  it('skips oversized candidate documents without downloading the full repository', async () => {
    const analysis = await analyzeSkillRepository(
      'demo/too-large',
      'main',
      mockFetch('demo/too-large', { 'SKILL.md': 'too large' }, ['SKILL.md']),
    )
    expect(analysis.installability).toBe('invalid')
    expect(analysis.targets).toEqual([])
  })

  it('stops clearly when GitHub truncates the directory tree', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha: 'b'.repeat(40) }))
      return new Response(JSON.stringify({ truncated: true, tree: [] }))
    }) as typeof fetch
    await expect(analyzeSkillRepository('demo/truncated', 'main', fetchImpl)).rejects.toThrow('目录过大')
  })
})
