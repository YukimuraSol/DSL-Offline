import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPluginTrialManager } from '../electron/plugin-trial'
import type { AppSettings } from '../src/types'

const runRealTrial = process.env.DSH_REAL_PLUGIN_TRIAL === '1'

describe.runIf(runRealTrial)('真实 DSH 插件隔离试运行', () => {
  it('不会把启动后才崩溃的 dsh-plugin-desktop 误判为通过', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-real-plugin-trial-'))
    const launcherData = path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-launcher')
    const nodeRoot = path.join('C:', 'Program Files', 'nodejs')
    const settings: AppSettings = {
      dshInstallPath: path.join(launcherData, 'dsh-runtime'),
      dshHome: path.join(os.homedir(), '.dsh'),
      profileName: 'web',
      workspace: path.join('D:', 'Document'),
      launchExecutable: path.join(launcherData, 'dsh-runtime', 'node_modules', '.bin', 'dsh.cmd'),
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
    }
    const manager = createPluginTrialManager({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => ({
        root: nodeRoot,
        node: path.join(nodeRoot, 'node.exe'),
        npm: path.join(nodeRoot, 'npm.cmd'),
        npx: path.join(nodeRoot, 'npx.cmd'),
        managed: false,
      }),
      preparePnpmRuntime: async () => ({
        root: path.join(launcherData, 'pnpm-runtime'),
        executable: path.join(launcherData, 'pnpm-runtime', 'node_modules', '.bin', 'pnpm.cmd'),
      }),
      trialRoot: path.join(temporary, 'trials'),
      resultsPath: path.join(temporary, 'results.json'),
      emitOutput: (_level, text) => process.stdout.write(text),
      emitResult: () => undefined,
      isRuntimeRunning: () => false,
      isInstallerBusy: () => false,
    })
    try {
      const result = await manager.trial('dsh-plugin-desktop', 'web')
      expect(result.phase).toBe('failed')
      expect(result.diagnostics).toContain('desktopRuntime')
    } finally {
      await manager.cancel()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 70_000)
})
