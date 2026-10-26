import { describe, expect, it } from 'vitest'
import { analyzeCatalogWithProgress, classifyCatalogRepository, mergeMetaRepositoryAnalysis } from '../electron/catalog-analysis'
import type { ApplicationRepositoryAnalysis, CatalogAnalysisProgress, RepositoryAnalysis, SkillRepositoryAnalysis } from '../src/types'

function plugin(installability: RepositoryAnalysis['installability']): RepositoryAnalysis {
  return {
    repository: 'demo/resource',
    defaultBranch: 'main',
    installability,
    summary: `plugin ${installability}`,
    targets: ['ready', 'choice'].includes(installability) ? [{
      id: '@demo/plugin:.',
      packageName: '@demo/plugin',
      version: '1.0.0',
      source: 'npm',
      profileName: 'web',
      platform: 'web',
      subdirectory: null,
      commit: 'a'.repeat(40),
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
    }] : [],
  }
}

function skill(installability: SkillRepositoryAnalysis['installability']): SkillRepositoryAnalysis {
  return {
    repository: 'demo/resource',
    defaultBranch: 'main',
    installability,
    summary: `skill ${installability}`,
    targets: installability === 'invalid' ? [] : [{
      id: 'demo-skill:SKILL.md',
      name: 'demo-skill',
      description: 'Demo skill.',
      sourcePath: 'SKILL.md',
      format: 'bundle',
      revision: 'main',
      modelInvocable: true,
      userInvocable: true,
    }],
  }
}

function application(installability: ApplicationRepositoryAnalysis['installability']): ApplicationRepositoryAnalysis {
  return {
    repository: 'demo/resource',
    defaultBranch: 'main',
    installability,
    summary: `application ${installability}`,
    targets: installability === 'invalid' ? [] : [{
      id: 'demo-app:.',
      addonId: 'demo-app',
      name: 'Demo App',
      description: 'Demo application.',
      provider: 'npm',
      packageName: 'demo-app',
      version: '1.0.0',
      binName: 'demo-app',
      launchMode: 'standalone',
      launchArgs: [],
      platforms: ['win32', 'darwin', 'linux'],
      supported: installability !== 'unsupported',
      verified: true,
      provides: [],
    }],
  }
}

const fulfilled = <T>(value: T): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value })
const rejected = (message: string): PromiseRejectedResult => ({ status: 'rejected', reason: new Error(message) })
const classify = (
  repository: string,
  pluginResult: PromiseSettledResult<RepositoryAnalysis>,
  skillResult: PromiseSettledResult<SkillRepositoryAnalysis>,
  applicationResult: PromiseSettledResult<ApplicationRepositoryAnalysis> = fulfilled(application('invalid')),
) => classifyCatalogRepository(repository, 'main', pluginResult, skillResult, applicationResult)

describe('catalog repository classification', () => {
  it('classifies plugin-only and skill-only repositories', () => {
    expect(classify('demo/plugin', fulfilled(plugin('ready')), fulfilled(skill('invalid'))).kind).toBe('plugin')
    expect(classify('demo/skill', fulfilled(plugin('invalid')), fulfilled(skill('ready'))).kind).toBe('skill')
  })

  it('keeps both component groups for a hybrid repository', () => {
    const result = classify('demo/hybrid', fulfilled(plugin('ready')), fulfilled(skill('choice')))
    expect(result.kind).toBe('hybrid')
    expect(result.pluginAnalysis?.targets).toHaveLength(1)
    expect(result.skillAnalysis?.targets).toHaveLength(1)
  })

  it('recognizes a dynamic session plugin but leaves it without install targets', () => {
    const result = classify('demo/dynamic', fulfilled(plugin('dynamic')), fulfilled(skill('invalid')))
    expect(result.kind).toBe('plugin')
    expect(result.pluginAnalysis?.installability).toBe('dynamic')
    expect(result.pluginAnalysis?.targets).toEqual([])
  })

  it('does not classify an ordinary application as a plugin', () => {
    const result = classify('demo/application', fulfilled(plugin('application')), fulfilled(skill('invalid')))
    expect(result.kind).toBe('invalid')
  })

  it('marks a fully checked repository without components as invalid', () => {
    const result = classify('demo/invalid', fulfilled(plugin('invalid')), fulfilled(skill('invalid')))
    expect(result.kind).toBe('invalid')
    expect(result.warnings).toEqual([])
  })

  it('keeps a valid type and warning when the other detector fails', () => {
    const result = classify('demo/partial', fulfilled(plugin('ready')), rejected('archive unavailable'))
    expect(result.kind).toBe('plugin')
    expect(result.warnings[0]).toMatch(/Skill 检测失败.*archive unavailable/)
  })

  it('does not report invalid when an unfinished detector could change the result', () => {
    expect(() => classify(
      'demo/unfinished',
      fulfilled(plugin('invalid')),
      rejected('network'),
    )).toThrow(/检测未完成/)
    expect(() => classify(
      'demo/failed',
      rejected('api'),
      rejected('archive'),
    )).toThrow(/检测未完成/)
  })

  it('always recognizes the official DSH repository without detector output', () => {
    const result = classifyCatalogRepository(
      'deepseek-ai/deepseek-harness',
      'master',
      rejected('skipped'),
      rejected('skipped'),
      rejected('skipped'),
    )
    expect(result.kind).toBe('dsh')
    expect(result.warnings).toEqual([])
  })

  it('classifies application-only, unsupported, and application hybrid repositories', () => {
    const standalone = classify('demo/app', fulfilled(plugin('invalid')), fulfilled(skill('invalid')), fulfilled(application('ready')))
    expect(standalone.kind).toBe('application')
    expect(standalone.componentKinds).toEqual(['application'])

    const unsupported = classify('demo/unsupported', fulfilled(plugin('invalid')), fulfilled(skill('invalid')), fulfilled(application('unsupported')))
    expect(unsupported.kind).toBe('application')

    const hybrid = classify('demo/app-plugin', fulfilled(plugin('ready')), fulfilled(skill('invalid')), fulfilled(application('ready')))
    expect(hybrid.kind).toBe('hybrid')
    expect(hybrid.componentKinds).toEqual(['plugin', 'application'])
  })

  it('lets a same-package replacement application own its bundled Plugin', () => {
    const pluginAnalysis = plugin('ready')
    pluginAnalysis.targets[0] = { ...pluginAnalysis.targets[0], packageName: 'demo-app' }
    const applicationAnalysis = application('ready')
    applicationAnalysis.targets[0] = { ...applicationAnalysis.targets[0], launchMode: 'runtime-replacement' }
    const result = classify(
      'demo/replacement',
      fulfilled(pluginAnalysis),
      fulfilled(skill('invalid')),
      fulfilled(applicationAnalysis),
    )

    expect(result.kind).toBe('application')
    expect(result.componentKinds).toEqual(['application'])
    expect(result.pluginAnalysis?.installability).toBe('application')
    expect(result.pluginAnalysis?.targets).toEqual([])
  })

  it('keeps a same-package companion application as a true hybrid', () => {
    const pluginAnalysis = plugin('ready')
    pluginAnalysis.targets[0] = { ...pluginAnalysis.targets[0], packageName: 'demo-app' }
    const applicationAnalysis = application('ready')
    applicationAnalysis.targets[0] = { ...applicationAnalysis.targets[0], launchMode: 'after-runtime' }
    const result = classify(
      'demo/companion',
      fulfilled(pluginAnalysis),
      fulfilled(skill('invalid')),
      fulfilled(applicationAnalysis),
    )

    expect(result.kind).toBe('hybrid')
    expect(result.componentKinds).toEqual(['plugin', 'application'])
  })

  it('keeps a root application when a meta-repository adds Skills from submodules', () => {
    const root = classify(
      'demo/application-meta',
      fulfilled(plugin('application')),
      fulfilled(skill('invalid')),
      fulfilled(application('ready')),
    )
    const meta = {
      ...classify(
        'demo/application-meta',
        fulfilled(plugin('invalid')),
        fulfilled(skill('choice')),
        fulfilled(application('invalid')),
      ),
      summary: '聚合仓库（meta-repo）：检测到子模块 Skill。',
    }

    const merged = mergeMetaRepositoryAnalysis(root, meta)

    expect(merged.kind).toBe('hybrid')
    expect(merged.componentKinds).toEqual(['skill', 'application'])
    expect(merged.applicationAnalysis?.targets[0]?.packageName).toBe('demo-app')
    expect(merged.skillAnalysis?.targets).toHaveLength(1)
    expect(merged.summary).toContain('1 个应用加载项')
    expect(merged.summary).toContain('1 个 Skill')
  })
})

describe('catalog analysis progress', () => {
  it('reports the three parallel checks and the final classification step', async () => {
    const events: CatalogAnalysisProgress[] = []
    const result = await analyzeCatalogWithProgress('demo/progress', 'main', {
      plugin: async () => plugin('ready'),
      skill: async () => skill('invalid'),
      application: async () => application('invalid'),
    }, progress => events.push(progress))

    expect(result.kind).toBe('plugin')
    expect(events[0]).toMatchObject({
      phase: 'preparing',
      completed: 0,
      checks: { plugin: 'pending', skill: 'pending', application: 'pending' },
    })
    expect(events[1]).toMatchObject({
      phase: 'checking',
      completed: 0,
      checks: { plugin: 'running', skill: 'running', application: 'running' },
    })
    expect(events.some(event => event.phase === 'classifying' && event.completed === 3)).toBe(true)
    expect(events.at(-1)).toMatchObject({
      phase: 'complete',
      completed: 3,
      checks: { plugin: 'complete', skill: 'complete', application: 'complete' },
    })
  })

  it('shows a failed detector while retaining a valid result from the others', async () => {
    const events: CatalogAnalysisProgress[] = []
    const result = await analyzeCatalogWithProgress('demo/partial-progress', 'main', {
      plugin: async () => plugin('ready'),
      skill: async () => { throw new Error('network unavailable') },
      application: async () => application('invalid'),
    }, progress => events.push(progress))

    expect(result.kind).toBe('plugin')
    expect(result.warnings).toHaveLength(1)
    expect(events.some(event => event.checks.skill === 'failed' && event.completed > 0)).toBe(true)
    expect(events.at(-1)?.phase).toBe('complete')
  })
})
