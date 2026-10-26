import { describe, expect, it } from 'vitest'
import { analyzeApplicationRepository } from '../electron/application-catalog'
import { classifyCatalogRepository } from '../electron/catalog-analysis'
import { analyzeRepository } from '../electron/plugin-catalog'
import type { SkillRepositoryAnalysis } from '../src/types'

const runRealCatalogCheck = process.env.DSH_REAL_APPLICATION_CATALOG === '1'

describe.runIf(runRealCatalogCheck)('真实应用加载项仓库检测', () => {
  it('同包替代宿主只暴露应用安装入口', async () => {
    const repository = 'anywhere-labs/deepseek-harness-desktop'
    const [applicationAnalysis, pluginAnalysis] = await Promise.all([
      analyzeApplicationRepository(repository, 'master'),
      analyzeRepository(repository, 'master', 'web'),
    ])
    const target = applicationAnalysis.targets.find(item => item.packageName === 'dsh-plugin-desktop')
    const skillAnalysis: SkillRepositoryAnalysis = {
      repository,
      defaultBranch: 'master',
      installability: 'invalid',
      summary: '没有检测到 Skill。',
      targets: [],
    }
    const catalog = classifyCatalogRepository(
      repository,
      'master',
      { status: 'fulfilled', value: pluginAnalysis },
      { status: 'fulfilled', value: skillAnalysis },
      { status: 'fulfilled', value: applicationAnalysis },
    )

    expect(['ready', 'choice']).toContain(applicationAnalysis.installability)
    expect(target).toMatchObject({
      launchMode: 'runtime-replacement',
      verified: false,
    })
    expect(target?.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(target?.binName).toBeTruthy()
    expect(catalog.kind).toBe('application')
    expect(catalog.componentKinds).toEqual(['application'])
    expect(catalog.pluginAnalysis?.targets).toEqual([])
  }, 30_000)
})
