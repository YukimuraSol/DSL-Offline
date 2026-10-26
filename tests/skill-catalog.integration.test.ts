import { expect, it } from 'vitest'
import { analyzeSkillRepository } from '../electron/skill-catalog'

const integrationTest = process.env.DSH_TEST_GITHUB_SKILLS === '1' ? it : it.skip

integrationTest('classifies representative live dsh-skill repositories', async () => {
  const academic = await analyzeSkillRepository('TohsakaRIN521/dsh-academic-skill', 'main')
  const multimodal = await analyzeSkillRepository('v587d/dsh-multimodal-skill', 'main')
  const market = await analyzeSkillRepository('2BingLing/dsh-market', 'master')

  expect(academic.installability).toBe('choice')
  expect(academic.targets.map(target => target.name)).toEqual(expect.arrayContaining([
    'academic-paper-completion',
    'skill-optimizer',
  ]))
  expect(multimodal.installability).toBe('ready')
  expect(multimodal.targets[0]?.sourcePath).toBe('SKILL.md')
  expect(market.installability).toBe('invalid')
}, 60_000)
