import { describe, expect, it } from 'vitest'
import type {
  PluginInstallTarget,
  RepositoryAnalysis,
  SkillInstallTarget,
  SkillRepositoryAnalysis,
} from '../src/types'
import { analyzeMetaRepository } from '../electron/meta-repo-catalog'

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
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

function pluginTarget(packageName: string, commit: string): PluginInstallTarget {
  return {
    id: `${packageName}:.`,
    packageName,
    version: '1.0.0',
    source: 'github',
    profileName: 'web',
    platform: 'web',
    subdirectory: null,
    commit,
    requiresBuild: false,
    buildScripts: [],
    nodeRange: null,
  }
}

function skillTarget(name: string, revision: string): SkillInstallTarget {
  return {
    id: `${name}:${name}/SKILL.md`,
    name,
    description: 'description',
    sourcePath: `${name}/SKILL.md`,
    format: 'bundle',
    revision,
    modelInvocable: true,
    userInvocable: true,
  }
}

function pluginAnalysis(targets: PluginInstallTarget[]): RepositoryAnalysis {
  return {
    repository: 'x',
    defaultBranch: 'main',
    installability: targets.length === 0 ? 'invalid' : targets.length === 1 ? 'ready' : 'choice',
    summary: 'plugin',
    targets,
  }
}

function skillAnalysis(targets: SkillInstallTarget[]): SkillRepositoryAnalysis {
  return {
    repository: 'x',
    defaultBranch: 'main',
    installability: targets.length === 0 ? 'invalid' : targets.length === 1 ? 'ready' : 'choice',
    summary: 'skill',
    targets,
  }
}

const routingGitModules = [
  '[submodule "injector"]',
  '\tpath = injector',
  '\turl = https://github.com/yjh051108/dsh-super-injector.git',
  '[submodule "mode-boost"]',
  '\tpath = mode-boost',
  '\turl = git@github.com:yjh051108/dsh-mode-boost.git',
  '[submodule "preset"]',
  '\tpath = preset',
  '\turl = https://github.com/yjh051108/dsh-router-standard.git',
].join('\n')

describe('analyzeMetaRepository', () => {
  it('meta-repo：聚合子模块的 plugin / skill 目标，钉住 gitlink 精确 commit 并打上 sourceRepository', async () => {
    const injectorSha = 'a'.repeat(40)
    const modeBoostSha = 'b'.repeat(40)
    const presetSha = 'c'.repeat(40)
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(routingGitModules, { status: 200 }),
      'git/trees': () => jsonResponse({
        truncated: false,
        tree: [
          { path: 'injector', type: 'commit', sha: injectorSha },
          { path: 'mode-boost', type: 'commit', sha: modeBoostSha },
          { path: 'preset', type: 'commit', sha: presetSha },
        ],
      }),
    })
    const pluginCalls: Array<[string, string]> = []
    const skillCalls: Array<[string, string]> = []

    const analysis = await analyzeMetaRepository(
      'yjh051108/dsh-routing-suite',
      'main',
      async (repo, branch) => {
        pluginCalls.push([repo, branch])
        if (repo === 'yjh051108/dsh-super-injector' || repo === 'yjh051108/dsh-mode-boost') {
          return pluginAnalysis([pluginTarget(repo.split('/')[1], branch)])
        }
        return pluginAnalysis([])
      },
      async (repo, branch) => {
        skillCalls.push([repo, branch])
        if (repo === 'yjh051108/dsh-router-standard') return skillAnalysis([skillTarget('router-standard', branch)])
        return skillAnalysis([])
      },
      fetchImpl,
    )

    expect(analysis).not.toBeNull()
    expect(analysis!.kind).toBe('hybrid')
    // 每个子模块都分别跑 plugin 与 skill 分析，版本用精确 commit。
    expect(pluginCalls).toEqual([
      ['yjh051108/dsh-super-injector', injectorSha],
      ['yjh051108/dsh-mode-boost', modeBoostSha],
      ['yjh051108/dsh-router-standard', presetSha],
    ])
    expect(skillCalls).toEqual([
      ['yjh051108/dsh-super-injector', injectorSha],
      ['yjh051108/dsh-mode-boost', modeBoostSha],
      ['yjh051108/dsh-router-standard', presetSha],
    ])
    const pluginTargets = analysis!.pluginAnalysis!.targets
    expect(pluginTargets.map(target => target.sourceRepository)).toEqual([
      'yjh051108/dsh-super-injector',
      'yjh051108/dsh-mode-boost',
    ])
    expect(pluginTargets.map(target => target.commit)).toEqual([injectorSha, modeBoostSha])
    expect(analysis!.pluginAnalysis!.installability).toBe('choice')
    const skills = analysis!.skillAnalysis!.targets
    expect(skills).toHaveLength(1)
    expect(skills[0].sourceRepository).toBe('yjh051108/dsh-router-standard')
    expect(skills[0].revision).toBe(presetSha)
    expect(analysis!.summary).toContain('injector → yjh051108/dsh-super-injector@')
    expect(analysis!.warnings).toEqual([])
  })

  it('meta-repo：跳过非 GitHub 子模块，仅分析 GitHub 托管的', async () => {
    const gitmodules = [
      '[submodule "ext"]',
      '\tpath = ext',
      '\turl = https://gitlab.com/group/lib.git',
      '[submodule "ok"]',
      '\tpath = ok',
      '\turl = https://github.com/acme/ok-plugin.git',
    ].join('\n')
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(gitmodules, { status: 200 }),
      'git/trees': () => jsonResponse({ truncated: false, tree: [] }),
    })
    const pluginCalls: string[] = []

    const analysis = await analyzeMetaRepository(
      'acme/repo-meta',
      'main',
      async repo => {
        pluginCalls.push(repo)
        return pluginAnalysis([pluginTarget('ok-plugin', 'main')])
      },
      async () => skillAnalysis([]),
      fetchImpl,
    )

    expect(pluginCalls).toEqual(['acme/ok-plugin'])
    expect(analysis).not.toBeNull()
    expect(analysis!.pluginAnalysis!.targets[0].sourceRepository).toBe('acme/ok-plugin')
  })

  it('meta-repo：无 gitlink pin 时回退到 .gitmodules 声明的 branch', async () => {
    const gitmodules = [
      '[submodule "preset"]',
      '\tpath = preset',
      '\turl = https://github.com/yjh051108/dsh-router-standard.git',
      '\tbranch = v0.3.0',
    ].join('\n')
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(gitmodules, { status: 200 }),
      'git/trees': () => jsonResponse({ truncated: false, tree: [] }),
    })
    const pluginCalls: string[] = []

    const analysis = await analyzeMetaRepository(
      'yjh051108/dsh-routing-suite',
      'main',
      async repo => {
        pluginCalls.push(repo)
        return pluginAnalysis([pluginTarget('router-standard', 'v0.3.0')])
      },
      async () => skillAnalysis([]),
      fetchImpl,
    )

    expect(pluginCalls).toEqual(['yjh051108/dsh-router-standard'])
    expect(analysis!.pluginAnalysis!.targets[0].commit).toBe('v0.3.0')
  })

  it('meta-repo：子模块没有任何可安装组件时返回 null', async () => {
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(routingGitModules, { status: 200 }),
      'git/trees': () => jsonResponse({ truncated: false, tree: [] }),
    })

    const analysis = await analyzeMetaRepository(
      'yjh051108/dsh-routing-suite',
      'main',
      async () => pluginAnalysis([]),
      async () => skillAnalysis([]),
      fetchImpl,
    )

    expect(analysis).toBeNull()
  })

  it('没有 .gitmodules（404）时返回 null，不触发任何分析', async () => {
    const calls: string[] = []
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response('Not Found', { status: 404 }),
    })

    const analysis = await analyzeMetaRepository(
      'acme/plain-plugin',
      'main',
      async repo => {
        calls.push(repo)
        return pluginAnalysis([])
      },
      async () => skillAnalysis([]),
      fetchImpl,
    )

    expect(analysis).toBeNull()
    expect(calls).toEqual([])
  })

  it('同名 plugin 目标去重：多个子模块声明同一包名时只保留一个', async () => {
    const gitmodules = [
      '[submodule "a"]',
      '\tpath = a',
      '\turl = https://github.com/acme/a.git',
      '[submodule "b"]',
      '\tpath = b',
      '\turl = https://github.com/acme/b.git',
    ].join('\n')
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(gitmodules, { status: 200 }),
      'git/trees': () => jsonResponse({ truncated: false, tree: [] }),
    })

    const analysis = await analyzeMetaRepository(
      'acme/meta',
      'main',
      async () => pluginAnalysis([pluginTarget('same-plugin', 'main')]),
      async () => skillAnalysis([]),
      fetchImpl,
    )

    expect(analysis!.pluginAnalysis!.targets).toHaveLength(1)
  })

  it('github 源插件子模块：命中官方 Release tgz 时覆盖为 release 源并带 tarballUrl', async () => {
    const injectorSha = 'a'.repeat(40)
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(routingGitModules, { status: 200 }),
      'git/trees': () => jsonResponse({
        truncated: false,
        tree: [
          { path: 'injector', type: 'commit', sha: injectorSha },
          { path: 'mode-boost', type: 'commit', sha: 'b'.repeat(40) },
          { path: 'preset', type: 'commit', sha: 'c'.repeat(40) },
        ],
      }),
      'dsh-super-injector/releases': () => jsonResponse([
        { draft: false, prerelease: false, tag_name: 'v0.3.3', assets: [
          { browser_download_url: 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.3/dsh-super-injector-0.3.3.tgz' },
        ] },
      ]),
      // 其余子模块的 release 查找返回 404（没有可用 Release），保持 github 源。
      'dsh-mode-boost/releases': () => new Response('Not Found', { status: 404 }),
      'dsh-router-standard/releases': () => new Response('Not Found', { status: 404 }),
    })
    const pluginCalls: Array<[string, string]> = []

    const analysis = await analyzeMetaRepository(
      'yjh051108/dsh-routing-suite',
      'main',
      async (repo, branch) => {
        pluginCalls.push([repo, branch])
        return pluginAnalysis([pluginTarget(`@demo/${repo.split('/')[1]}`, branch)])
      },
      async () => skillAnalysis([]),
      fetchImpl,
    )

    const injector = analysis!.pluginAnalysis!.targets.find(target => target.packageName === '@demo/dsh-super-injector')
    expect(injector).toBeDefined()
    expect(injector!.source).toBe('release')
    expect(injector!.tarballUrl).toMatch(/\.tgz$/)
    expect(injector!.version).toBe('0.3.3')
    expect(injector!.sourceRepository).toBe('yjh051108/dsh-super-injector')
    // 没有 Release tgz 的子模块保持 github 源。
    const modeBoost = analysis!.pluginAnalysis!.targets.find(target => target.packageName === '@demo/dsh-mode-boost')
    expect(modeBoost!.source).toBe('github')
    // 任一子模块出现 release 查找（每个 github 源插件都查一次）。
    expect(pluginCalls.length).toBeGreaterThanOrEqual(3)
  })

  it('plugin / skill 都没识别出的子模块：检测 preset/ 变体，预设-only 时 kind 为 preset', async () => {
    const presetSha = 'c'.repeat(40)
    const fetchImpl = routingFetch({
      '.gitmodules': () => new Response(routingGitModules, { status: 200 }),
      // 子模块特定的 git/trees 探测必须在通用路由之前（routingFetch 按插入顺序先命中）。
      'dsh-router-standard/git/trees': () => jsonResponse({
        truncated: false,
        tree: [
          { path: 'preset/router-standard/preset.yml', type: 'blob' },
          { path: 'preset/router-standard/routing/rules.yml', type: 'blob' },
          { path: 'preset/router-spec/preset.yml', type: 'blob' },
          { path: 'README.md', type: 'blob' },
        ],
      }),
      'dsh-super-injector/git/trees': () => jsonResponse({ truncated: false, tree: [] }),
      'dsh-mode-boost/git/trees': () => jsonResponse({ truncated: false, tree: [] }),
      // meta-repo 自身 gitlink pin 的调用（dsh-routing-suite/git/trees），最后兜底。
      'git/trees': () => jsonResponse({
        truncated: false,
        tree: [
          { path: 'injector', type: 'commit', sha: 'a'.repeat(40) },
          { path: 'mode-boost', type: 'commit', sha: 'b'.repeat(40) },
          { path: 'preset', type: 'commit', sha: presetSha },
        ],
      }),
    })

    const analysis = await analyzeMetaRepository(
      'yjh051108/dsh-routing-suite',
      'main',
      async () => pluginAnalysis([]),
      async () => skillAnalysis([]),
      fetchImpl,
    )

    expect(analysis).not.toBeNull()
    expect(analysis!.kind).toBe('preset')
    expect(analysis!.presetAnalysis!.installability).toBe('ready')
    const presetNames = analysis!.presetAnalysis!.targets.map(preset => preset.name).sort()
    expect(presetNames).toEqual(['router-spec', 'router-standard'])
    const first = analysis!.presetAnalysis!.targets[0]
    expect(first.sourceRepository).toBe('yjh051108/dsh-router-standard')
    expect(first.revision).toBe(presetSha)
    expect(first.sourcePath).toMatch(/^preset\/[^/]+$/)
    expect(analysis!.pluginAnalysis!.targets).toHaveLength(0)
    expect(analysis!.skillAnalysis!.targets).toHaveLength(0)
  })
})
