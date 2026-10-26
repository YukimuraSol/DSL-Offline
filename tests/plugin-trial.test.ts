import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildTrialLaunch, buildTrialManifest, createPluginTrialManager } from '../electron/plugin-trial'
import type { NodeRuntime, PnpmRuntime } from '../electron/node-runtime'
import type { AppSettings, PluginTrialResult } from '../src/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function runtime(root: string): NodeRuntime {
  return {
    root,
    node: path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
}

describe('插件隔离试运行', () => {
  it('生成只包含 Web 核心与当前插件的 Profile 清单', () => {
    expect(buildTrialManifest('demo-plugin', 'demo-plugin@1.2.3')).toEqual({
      name: 'dsh-plugin-trial',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base', 'demo-plugin'] } },
      dependencies: { 'demo-plugin': 'demo-plugin@1.2.3' },
    })
  })

  it('直接调用已绑定的 dsh，并对其他命令回落到托管 npx', () => {
    const nodeRuntime = runtime(path.join('C:', 'managed-node'))
    const settings: AppSettings = {
      dshInstallPath: path.join('C:', 'dsh-runtime'),
      dshHome: path.join('C:', 'Users', 'tester', '.dsh'),
      profileName: 'web',
      workspace: path.join('C:', 'workspace'),
      launchExecutable: path.join('C:', 'dsh-runtime', 'dsh.cmd'),
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
    }
    expect(buildTrialLaunch(settings, nodeRuntime, 'trial', 3180)).toEqual({
      executable: settings.launchExecutable,
      args: ['--profile', 'trial', '--port', '3180'],
    })
    expect(buildTrialLaunch({ ...settings, launchExecutable: 'node', launchArgs: ['./custom.js'] }, nodeRuntime, 'trial', 3181)).toEqual({
      executable: nodeRuntime.npx,
      args: ['--yes', '@deepseek-ai/dsh', '--profile', 'trial', '--port', '3181'],
    })
  })

  it('链接已安装插件、推送运行状态并持久化终态', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-trial-test-'))
    temporaryDirectories.push(root)
    const dshHome = path.join(root, 'dsh-home')
    const sourceProfile = path.join(dshHome, 'profiles', 'web')
    const sourcePackage = path.join(sourceProfile, 'node_modules', 'demo-plugin')
    await mkdir(sourcePackage, { recursive: true })
    await writeFile(path.join(sourcePackage, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
    await writeFile(path.join(sourceProfile, 'package.json'), JSON.stringify({
      dependencies: { 'demo-plugin': 'demo-plugin@1.0.0' },
    }))

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'dsh-runtime'),
      dshHome,
      profileName: 'web',
      workspace: root,
      launchExecutable: path.join(root, 'dsh-runtime', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
    }
    const nodeRuntime = runtime(path.join(root, 'node-runtime'))
    const pnpmRuntime: PnpmRuntime = { root: path.join(root, 'pnpm-runtime'), executable: path.join(root, 'pnpm') }
    const events: PluginTrialResult[] = []
    const fakeChild = {} as ChildProcessWithoutNullStreams
    let inspectedManifest: unknown
    let linkedPackage = ''
    const manager = createPluginTrialManager({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => nodeRuntime,
      preparePnpmRuntime: async () => pnpmRuntime,
      trialRoot: path.join(root, 'trials'),
      resultsPath: path.join(root, 'trial-results.json'),
      emitOutput: () => undefined,
      emitResult: result => events.push(result),
      isRuntimeRunning: () => false,
      isInstallerBusy: () => false,
      findPort: async () => 3180,
      spawnProcess: () => fakeChild,
      observeProcess: async (_child, _port, _timeout, _output) => {
        const running = events.at(-1)!
        const sessionDirectories = await readdir(path.join(root, 'trials'))
        const trialHome = path.join(root, 'trials', sessionDirectories[0], 'dsh-home')
        inspectedManifest = JSON.parse(await readFile(path.join(trialHome, 'profiles', 'trial', 'package.json'), 'utf8'))
        linkedPackage = await realpath(path.join(trialHome, 'profiles', 'trial', 'node_modules', 'demo-plugin'))
        expect(running.phase).toBe('running')
        return { passed: true, message: '通过', output: 'listening', url: 'http://127.0.0.1:3180/' }
      },
      killProcess: async () => undefined,
    })

    const result = await manager.trial('demo-plugin')
    expect(result.phase).toBe('passed')
    expect(events.map(event => event.phase)).toEqual(['running', 'passed'])
    expect(inspectedManifest).toEqual(buildTrialManifest('demo-plugin', 'demo-plugin@1.0.0'))
    expect(linkedPackage).toBe(await realpath(sourcePackage))
    await expect(manager.list()).resolves.toEqual([result])
    const stored = JSON.parse(await readFile(path.join(root, 'trial-results.json'), 'utf8')) as { results: PluginTrialResult[] }
    expect(stored.results[0].packageName).toBe('demo-plugin')
  })
})
