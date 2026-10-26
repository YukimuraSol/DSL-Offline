import type { AppSettings, InstalledApplicationAddon, LinkedComponentToggleResult, ProfileState } from '../src/types'

interface LinkedApplicationManager {
  list(): Promise<InstalledApplicationAddon[]>
  toggle(id: string, enabled: boolean): Promise<InstalledApplicationAddon[]>
}

export interface LinkedComponentControllerOptions {
  readSettings: () => Promise<AppSettings>
  readProfile: (dshHome: string, profileName: string) => Promise<ProfileState>
  togglePlugin: (
    dshHome: string,
    profileName: string,
    packageName: string,
    enabled: boolean,
  ) => Promise<ProfileState>
  applications: LinkedApplicationManager
  isRuntimeRunning: () => boolean
}

export interface LinkedComponentController {
  togglePlugin(packageName: string, enabled: boolean, profileName?: string): Promise<LinkedComponentToggleResult>
  toggleApplication(id: string, enabled: boolean): Promise<LinkedComponentToggleResult>
}

export function sameRepository(left?: string, right?: string): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase())
}

async function restoreApplications(
  applications: LinkedApplicationManager,
  snapshot: InstalledApplicationAddon[],
): Promise<void> {
  let current = await applications.list()
  const restore = async (enabled: boolean) => {
    for (const original of snapshot.filter(item => item.enabled === enabled)) {
      const installed = current.find(item => item.id === original.id)
      if (installed && installed.enabled !== original.enabled) {
        current = await applications.toggle(original.id, original.enabled)
      }
    }
  }
  // 先关掉本不应激活的项，再恢复原本激活的互斥运行时宿主。
  await restore(false)
  await restore(true)
}

export function createLinkedComponentController(
  options: LinkedComponentControllerOptions,
): LinkedComponentController {
  return {
    async togglePlugin(packageName, enabled, requestedProfileName) {
      const settings = await options.readSettings()
      const profileName = requestedProfileName ?? settings.profileName
      const previousProfile = await options.readProfile(settings.dshHome, profileName)
      const plugin = previousProfile.plugins.find(item => item.packageName === packageName)
      if (!plugin) throw new Error('插件已不在当前配置中，请刷新后重试。')

      const previousApplications = await options.applications.list()
      const linkedApplications = plugin.repositoryFullName
        ? previousApplications.filter(item => sameRepository(item.repository, plugin.repositoryFullName))
        : []
      if (linkedApplications.length > 0 && options.isRuntimeRunning()) {
        throw new Error('请先停止 DSH，再修改协同 Plugin 与应用加载项状态。')
      }

      const profile = await options.togglePlugin(settings.dshHome, profileName, packageName, enabled)
      if (linkedApplications.length === 0) {
        return { profile, installedApplications: previousApplications, linked: false }
      }

      let installedApplications = previousApplications
      try {
        for (const application of linkedApplications) {
          if (application.enabled !== enabled) {
            installedApplications = await options.applications.toggle(application.id, enabled)
          }
        }
      } catch (error) {
        await Promise.allSettled([
          options.togglePlugin(settings.dshHome, profileName, packageName, plugin.enabled),
          restoreApplications(options.applications, previousApplications),
        ])
        throw error
      }
      return { profile, installedApplications, linked: true }
    },

    async toggleApplication(id, enabled) {
      const settings = await options.readSettings()
      const previousApplications = await options.applications.list()
      const application = previousApplications.find(item => item.id === id)
      if (!application) throw new Error('没有找到该应用加载项。')
      if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再修改应用加载项状态。')

      const previousProfile = await options.readProfile(settings.dshHome, settings.profileName)
      const linkedPlugins = previousProfile.plugins.filter(plugin =>
        sameRepository(plugin.repositoryFullName, application.repository),
      )
      if (!enabled && linkedPlugins.some(plugin => plugin.locked)) {
        throw new Error('该应用加载项关联了不能停用的核心 Plugin。')
      }

      let profile = previousProfile
      const changedPlugins = linkedPlugins.filter(plugin => plugin.enabled !== enabled)
      try {
        for (const plugin of changedPlugins) {
          profile = await options.togglePlugin(
            settings.dshHome,
            settings.profileName,
            plugin.packageName,
            enabled,
          )
        }
        const installedApplications = await options.applications.toggle(id, enabled)
        return { profile, installedApplications, linked: linkedPlugins.length > 0 }
      } catch (error) {
        for (const plugin of [...changedPlugins].reverse()) {
          await options.togglePlugin(
            settings.dshHome,
            settings.profileName,
            plugin.packageName,
            plugin.enabled,
          ).catch(() => undefined)
        }
        throw error
      }
    },
  }
}
