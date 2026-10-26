import { describe, expect, it, vi } from 'vitest'
import { createLinkedComponentController, sameRepository } from '../electron/linked-components'
import type { AppSettings, InstalledApplicationAddon, ManagedPlugin, ProfileState } from '../src/types'

const settings: AppSettings = {
  dshInstallPath: 'C:\\dsh-runtime',
  dshHome: 'C:\\Users\\demo\\.dsh',
  profileName: 'web',
  workspace: 'C:\\workspace',
  launchExecutable: 'dsh.cmd',
  launchArgs: ['web'],
  webPort: 3080,
  openAfterLaunch: true,
}

function plugin(enabled = true, repositoryFullName = 'demo/collaboration'): ManagedPlugin {
  return {
    packageName: 'demo-plugin',
    displayName: 'Demo Plugin',
    version: '1.0.0',
    description: 'demo',
    repository: `https://github.com/${repositoryFullName}`,
    repositoryFullName,
    enabled,
    builtin: false,
    locked: false,
    compatible: true,
    order: enabled ? 1 : null,
  }
}

function profile(plugins: ManagedPlugin[]): ProfileState {
  return {
    initialized: true,
    profileDir: 'C:\\Users\\demo\\.dsh\\profiles\\web',
    manifestPath: 'C:\\Users\\demo\\.dsh\\profiles\\web\\package.json',
    plugins,
    activeBundles: plugins.filter(item => item.enabled).map(item => item.packageName),
    dependencyCount: plugins.length,
    disabledCount: plugins.filter(item => !item.enabled).length,
  }
}

function application(enabled = true, repository = 'Demo/Collaboration'): InstalledApplicationAddon {
  return {
    id: 'demo-app',
    name: 'Demo App',
    description: 'demo',
    repository,
    provider: 'npm',
    packageName: 'demo-app',
    version: '1.0.0',
    binName: 'demo-app',
    entryPath: 'C:\\apps\\demo-app\\index.js',
    installPath: 'C:\\apps\\demo-app',
    launchMode: 'after-runtime',
    launchArgs: [],
    enabled,
    verified: true,
    provides: [],
    installedAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }
}

function setup(pluginEnabled = true, applicationEnabled = true, running = false) {
  let currentProfile = profile([plugin(pluginEnabled)])
  let applications = [application(applicationEnabled)]
  const togglePlugin = vi.fn(async (_home: string, _profileName: string, _packageName: string, enabled: boolean) => {
    currentProfile = profile(currentProfile.plugins.map(item => ({
      ...item,
      enabled,
      order: enabled ? 1 : null,
    })))
    return currentProfile
  })
  const toggleApplication = vi.fn(async (_id: string, enabled: boolean) => {
    applications = applications.map(item => ({ ...item, enabled }))
    return applications
  })
  const controller = createLinkedComponentController({
    readSettings: async () => settings,
    readProfile: async () => currentProfile,
    togglePlugin,
    applications: {
      list: async () => applications,
      toggle: toggleApplication,
    },
    isRuntimeRunning: () => running,
  })
  return { controller, togglePlugin, toggleApplication, state: () => ({ currentProfile, applications }) }
}

describe('linked Plugin and application addons', () => {
  it('matches repository names without case sensitivity', () => {
    expect(sameRepository('Demo/Collaboration', 'demo/collaboration')).toBe(true)
    expect(sameRepository('demo/one', 'demo/two')).toBe(false)
  })

  it('keeps both records and disables the application when its Plugin is disabled', async () => {
    const context = setup(true, true)
    const result = await context.controller.togglePlugin('demo-plugin', false)

    expect(result.linked).toBe(true)
    expect(result.profile.plugins[0].enabled).toBe(false)
    expect(result.installedApplications[0].enabled).toBe(false)
    expect(context.togglePlugin).toHaveBeenCalledOnce()
    expect(context.toggleApplication).toHaveBeenCalledWith('demo-app', false)
  })

  it('enables the linked Plugin when the application is enabled', async () => {
    const context = setup(false, false)
    const result = await context.controller.toggleApplication('demo-app', true)

    expect(result.linked).toBe(true)
    expect(result.profile.plugins[0].enabled).toBe(true)
    expect(result.installedApplications[0].enabled).toBe(true)
    expect(context.togglePlugin).toHaveBeenCalledWith(settings.dshHome, 'web', 'demo-plugin', true)
  })

  it('does not partially change linked state while DSH is running', async () => {
    const context = setup(true, true, true)

    await expect(context.controller.togglePlugin('demo-plugin', false)).rejects.toThrow(/请先停止 DSH/)
    expect(context.togglePlugin).not.toHaveBeenCalled()
    expect(context.toggleApplication).not.toHaveBeenCalled()
  })
})
