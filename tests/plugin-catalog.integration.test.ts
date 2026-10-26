import { expect, it } from 'vitest'
import { analyzeRepository } from '../electron/plugin-catalog'

const integrationTest = process.env.DSH_TEST_GITHUB_CATALOG === '1' ? it : it.skip

integrationTest('classifies representative live dsh-plugin repositories', async () => {
  const tui = await analyzeRepository('ccch1mneyyy/dsh-TUI', 'main', 'web')
  const skin = await analyzeRepository('Small-tailqwq/dsh-deep-whale', 'main', 'web')
  const desktop = await analyzeRepository('anywhere-labs/deepseek-harness-desktop', 'master', 'web')
  const dynamic = await analyzeRepository('mervyn-teo/dsh-plugin-qr-connect', 'main', 'web')

  expect(tui.targets[0]).toMatchObject({ packageName: '@deepseek-harness-tui/dsh-tui', source: 'npm', profileName: 'cc-tui' })
  expect(skin.targets[0]).toMatchObject({
    packageName: '@dsh-external/dsh-client-ui-skin-maid-atelier',
    source: 'archive-subdirectory',
    subdirectory: 'maid-atelier',
  })
  expect(['ready', 'choice']).toContain(desktop.installability)
  expect(desktop.targets.some(target => target.packageName === 'dsh-plugin-desktop')).toBe(true)
  expect(['dynamic', 'ready', 'choice']).toContain(dynamic.installability)
}, 60_000)
