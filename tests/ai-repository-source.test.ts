import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { parseGitModules, prepareAiRepositorySource, submoduleFullName } from '../electron/ai-repository-source'

function archive(entries: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content))
  return zip.toBuffer()
}

function archiveFetch(buffer: Buffer): typeof fetch {
  const body = Uint8Array.from(buffer).buffer
  return async () => new Response(body, {
    status: 200,
    headers: { 'content-length': String(buffer.length) },
  })
}

describe('prepareAiRepositorySource', () => {
  it('安全解压仓库到独立临时目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-ai-source-test-'))
    try {
      const buffer = archive({
        'repo-main/README.md': '# demo',
        'repo-main/src/index.ts': 'export const ok = true\n',
      })
      const progress: number[] = []
      const source = await prepareAiRepositorySource(
        root,
        'demo/repo',
        'main',
        received => progress.push(received),
        archiveFetch(buffer),
      )
      expect(source.taskRoot.startsWith(root)).toBe(true)
      expect(await readFile(path.join(source.repositoryPath, 'README.md'), 'utf8')).toBe('# demo')
      expect(await readFile(path.join(source.repositoryPath, 'src', 'index.ts'), 'utf8')).toContain('ok = true')
      expect(progress.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝会逃出仓库根目录的压缩包路径并清理临时目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-ai-source-unsafe-'))
    try {
      const buffer = archive({
        'repo-main/README.md': '# demo',
        'repo-main/../escape.txt': 'escape',
      })
      await expect(prepareAiRepositorySource(
        root,
        'demo/repo',
        'main',
        undefined,
        archiveFetch(buffer),
      )).rejects.toThrow(/不安全路径|结构无效/)
      expect(existsSync(path.join(root, 'escape.txt'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// .gitmodules 解析
// ---------------------------------------------------------------------------

describe('parseGitModules', () => {
  it('解析 path/url/branch，忽略注释与其它段', () => {
    const content = [
      '# 这是注释',
      '[submodule "injector"]',
      '\tpath = injector',
      '\turl = https://github.com/a/dsh-super-injector.git',
      '\tbranch = v0.3.3',
      '',
      '[submodule "preset"]',
      '  path = preset',
      '  url = git@github.com:b/dsh-router-standard.git',
      '',
      '[some "other"]',
      '\tkey = value',
    ].join('\n')
    expect(parseGitModules(content)).toEqual([
      { name: 'injector', path: 'injector', url: 'https://github.com/a/dsh-super-injector.git', branch: 'v0.3.3' },
      { name: 'preset', path: 'preset', url: 'git@github.com:b/dsh-router-standard.git' },
    ])
  })

  it('丢弃缺 path 或 url 的声明', () => {
    expect(parseGitModules('[submodule "x"]\n\turl = https://github.com/a/b.git\n')).toEqual([])
    expect(parseGitModules('[submodule "y"]\n\tpath = y\n')).toEqual([])
  })

  it('CRLF 换行也能解析', () => {
    expect(parseGitModules('[submodule "z"]\r\n\tpath = z\r\n\turl = https://github.com/a/z.git\r\n'))
      .toEqual([{ name: 'z', path: 'z', url: 'https://github.com/a/z.git' }])
  })
})

describe('submoduleFullName', () => {
  it('识别各类 GitHub URL', () => {
    expect(submoduleFullName('https://github.com/a/b')).toBe('a/b')
    expect(submoduleFullName('https://github.com/a/b.git')).toBe('a/b')
    expect(submoduleFullName('git@github.com:a/b.git')).toBe('a/b')
    expect(submoduleFullName('ssh://git@github.com/a/b.git')).toBe('a/b')
    expect(submoduleFullName('git+https://github.com/a/b.git')).toBe('a/b')
    expect(submoduleFullName('github:a/b')).toBe('a/b')
  })

  it('拒绝非 GitHub / 畸形 URL', () => {
    expect(submoduleFullName('https://gitlab.com/a/b.git')).toBeNull()
    expect(submoduleFullName('git@gitlab.com:a/b.git')).toBeNull()
    expect(submoduleFullName('https://github.com/a')).toBeNull()
    expect(submoduleFullName('https://github.com/a/b/c')).toBeNull()
    expect(submoduleFullName('https://example.com/a/b')).toBeNull()
    expect(submoduleFullName('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// meta-repo：git 子模块预取
// ---------------------------------------------------------------------------

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function bufferResponse(buffer: Buffer): Response {
  return new Response(Uint8Array.from(buffer).buffer, {
    status: 200,
    headers: { 'content-length': String(buffer.length) },
  })
}

/** 按 URL 子串路由的 fetch mock；每个 URL 由工厂生成全新 Response（body 不可复用）。 */
function routingFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input)
    for (const [marker, factory] of Object.entries(routes)) {
      if (url.includes(marker)) return factory()
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}

describe('prepareAiRepositorySource 预取 git 子模块', () => {
  it('meta-repo：把 .gitmodules 声明的 GitHub 子模块内容解压到对应子目录（用 gitlink 精确 commit）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-ai-source-meta-'))
    try {
      const mainBuffer = archive({
        'repo-meta/.gitmodules': [
          '[submodule "injector"]',
          '\tpath = injector',
          '\turl = https://github.com/yjh051108/dsh-super-injector.git',
          '[submodule "mode-boost"]',
          '\tpath = mode-boost',
          '\turl = git@github.com:yjh051108/dsh-mode-boost.git',
        ].join('\n'),
        'repo-meta/README.md': '# routing suite',
      })
      const injectorBuffer = archive({
        'dsh-super-injector-main/package.json': '{"name":"dsh-super-injector"}',
        'dsh-super-injector-main/src/index.ts': 'export const inject = true\n',
      })
      const modeBoostBuffer = archive({
        'dsh-mode-boost-main/package.json': '{"name":"dsh-mode-boost"}',
      })
      const injectorSha = 'c'.repeat(40)
      const modeBoostSha = 'd'.repeat(40)
      const fetchImpl = routingFetch({
        'dsh-routing-suite/zip': () => bufferResponse(mainBuffer),
        'git/trees': () => jsonResponse({
          truncated: false,
          tree: [
            { path: '.gitmodules', type: 'blob', sha: 'a'.repeat(40) },
            { path: 'injector', type: 'commit', sha: injectorSha },
            { path: 'mode-boost', type: 'commit', sha: modeBoostSha },
          ],
        }),
        'dsh-super-injector/zip': () => bufferResponse(injectorBuffer),
        'dsh-mode-boost/zip': () => bufferResponse(modeBoostBuffer),
      })
      const logs: string[] = []
      const source = await prepareAiRepositorySource(
        root,
        'yjh051108/dsh-routing-suite',
        'main',
        undefined,
        fetchImpl,
        text => logs.push(text),
      )

      expect(await readFile(path.join(source.repositoryPath, 'README.md'), 'utf8')).toContain('routing suite')
      // 子模块内容预取到对应子目录
      expect(await readFile(path.join(source.repositoryPath, 'injector', 'package.json'), 'utf8')).toContain('dsh-super-injector')
      expect(await readFile(path.join(source.repositoryPath, 'injector', 'src', 'index.ts'), 'utf8')).toContain('inject')
      expect(await readFile(path.join(source.repositoryPath, 'mode-boost', 'package.json'), 'utf8')).toContain('dsh-mode-boost')
      expect(source.submodules).toEqual([
        { path: 'injector', repository: 'yjh051108/dsh-super-injector', revision: injectorSha },
        { path: 'mode-boost', repository: 'yjh051108/dsh-mode-boost', revision: modeBoostSha },
      ])
      expect(source.skippedSubmodules).toEqual([])
      expect(logs.some(text => text.includes('子模块'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('meta-repo：非 GitHub 子模块跳过并在 skippedSubmodules 记录原因', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-ai-source-skip-'))
    try {
      const mainBuffer = archive({
        'repo-meta/.gitmodules': [
          '[submodule "ext"]',
          '\tpath = ext',
          '\turl = https://gitlab.com/group/lib.git',
          '[submodule "ok"]',
          '\tpath = ok',
          '\turl = https://github.com/acme/ok-plugin.git',
        ].join('\n'),
        'repo-meta/README.md': '# meta',
      })
      const okBuffer = archive({ 'ok-plugin-main/package.json': '{"name":"ok-plugin"}' })
      const fetchImpl = routingFetch({
        'repo-meta/zip': () => bufferResponse(mainBuffer),
        'git/trees': () => jsonResponse({ truncated: false, tree: [] }),
        'ok-plugin/zip': () => bufferResponse(okBuffer),
      })

      const source = await prepareAiRepositorySource(root, 'acme/repo-meta', 'main', undefined, fetchImpl)

      expect(source.submodules).toEqual([{ path: 'ok', repository: 'acme/ok-plugin', revision: 'main' }])
      expect(source.skippedSubmodules).toEqual([{ path: 'ext', reason: '非 GitHub 子模块，未预取' }])
      // 非 GitHub 子模块未下载内容
      expect(existsSync(path.join(source.repositoryPath, 'ext'))).toBe(false)
      expect(await readFile(path.join(source.repositoryPath, 'ok', 'package.json'), 'utf8')).toContain('ok-plugin')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('meta-repo：子模块下载失败时跳过并记录原因，不阻断整体', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-ai-source-fail-'))
    try {
      const mainBuffer = archive({
        'repo-meta/.gitmodules': '[submodule "missing"]\n\tpath = missing\n\turl = https://github.com/acme/missing.git\n',
        'repo-meta/README.md': '# meta',
      })
      const fetchImpl = routingFetch({
        'repo-meta/zip': () => bufferResponse(mainBuffer),
        // 无 missing/zip 路由 → readSubmoduleArchive 对每个候选 revision 都失败
        'git/trees': () => jsonResponse({
          truncated: false,
          tree: [{ path: 'missing', type: 'commit', sha: 'e'.repeat(40) }],
        }),
      })

      const source = await prepareAiRepositorySource(root, 'acme/repo-meta', 'main', undefined, fetchImpl)

      expect(source.submodules).toEqual([])
      expect(source.skippedSubmodules).toEqual([expect.objectContaining({ path: 'missing' })])
      expect(source.skippedSubmodules[0].reason).toMatch(/预取失败/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
