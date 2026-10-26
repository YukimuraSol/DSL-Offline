/**
 * 悬空记录：家目录已经被手删/搬走的旧包记录不能留在列表里。
 *
 * 旧台式实测：清理时清了 packs.json，但 settings.json 的 packsV2Migrated 还是 false，
 * 老迁移照着记录又把目录 mkdir 了回来 —— 列表里留着一个点开就报错的包，
 * 还挡住「导入同名文件夹」（提示「这个文件夹已经导入过了」）。
 *
 * 这里锁住两件事：
 *   1. 记录指向的家目录不存在 → listPacks 直接摘掉，并写回 packs.json；
 *   2. 家目录还在（或没写 homePath、默认家目录在）→ 一条都不能动。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings, ProfileState } from '../src/types'
import { createPackManager } from '../electron/pack'
import { readPackRegistry, upsertPackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

/** 一个「profiles/web」布局的真家目录，放在 packsRoot 之外，避免被自动收编影响断言。 */
async function realHome(root: string, dirName: string) {
  const home = path.join(root, dirName)
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { '@deepseek-ai/dsh-core': '0.1.2' },
  }))
  return home
}

function makeManager(registryPath: string, dshHome: string) {
  let settings: AppSettings = { ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }), dshHome, profileName: 'web' }
  const emptyProfile: ProfileState = { initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 }
  return createPackManager({
    readSettings: async () => settings,
    saveSettings: async (next: AppSettings) => { settings = next; return settings },
    registryPath,
    snapshotRoot: path.join(dshHome, 'snapshots'),
    pluginReceiptsPath: path.join(dshHome, 'plugin-installs.json'),
    presetReceiptsPath: path.join(dshHome, 'preset-installs.json'),
    skillReceiptsPath: path.join(dshHome, 'skill-installs.json'),
    applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
    installer: {
      installPluginTarget: async () => ({}),
      installSkillLocal: async () => ({}),
      installSkill: async () => ({ installedSkill: null as never, installedSkills: [] }),
      installSkillPinned: async () => null as never,
      toggleSkill: async () => [],
      installPreset: async () => ({ installedPreset: null as never, installedPresets: [] }),
      installPresetLocal: async () => ({}),
      togglePreset: async () => [],
      remove: async () => ({}),
      readProfile: async () => emptyProfile,
      togglePlugin: async () => emptyProfile,
    },
    emitEvent: () => undefined,
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
  })
}

describe('listPacks 清掉家目录不存在的悬空记录', () => {
  it('记录指向的家目录没了 → 列表里没有它，并写回 packs.json（真实目录一个不动）', async () => {
    const root = await makeRoot('pack-dangling-')
    const registryPath = path.join(root, 'packs.json')
    const dshHome = path.join(root, 'dsh-home')
    const aliveHome = await realHome(root, 'alive-home')
    const goneHome = path.join(root, 'gone-home')

    await upsertPackRecord(registryPath, {
      id: 'alive', name: 'alive', description: '', version: '1.0.0', source: 'created',
      installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'complete', plugins: [], homePath: aliveHome,
    })
    await upsertPackRecord(registryPath, {
      id: 'gone', name: 'gone', description: '', version: '1.0.0', source: 'created',
      installedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      state: 'complete', plugins: [], homePath: goneHome,
    })

    const manager = makeManager(registryPath, dshHome)
    expect((await manager.listPacks()).map(pack => pack.id)).toEqual(['alive'])
    // 悬空记录从注册表里也消失了：下次启动不会再冒出来，也不会挡住同名导入。
    expect((await readPackRegistry(registryPath)).map(record => record.id)).toEqual(['alive'])
    // 只摘记录，绝不删目录：还在的那个家目录原封不动。
    await expect(writeFile(path.join(aliveHome, 'probe.txt'), 'ok')).resolves.toBeUndefined()
  })

  it('没有 homePath 的记录按默认家目录算：默认家目录没了同样摘掉（旧台式就是这么坏的）', async () => {
    const root = await makeRoot('pack-dangling-shared-')
    const registryPath = path.join(root, 'packs.json')
    const dshHome = path.join(root, 'dsh-packs', 'dsh-origin-3080') // 不创建：等同于被手删

    await upsertPackRecord(registryPath, {
      id: 'web', name: 'web', description: '', version: '1.0.0', source: 'created',
      installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'complete', plugins: [],
    })

    const manager = makeManager(registryPath, dshHome)
    expect(await manager.listPacks()).toEqual([])
    expect(await readPackRegistry(registryPath)).toEqual([])
  })

  it('家目录还在 → 一条都不动', async () => {
    const root = await makeRoot('pack-alive-')
    const registryPath = path.join(root, 'packs.json')
    const dshHome = path.join(root, 'dsh-home')
    const aliveHome = await realHome(root, 'alive-home')

    await upsertPackRecord(registryPath, {
      id: 'alive', name: 'alive', description: '', version: '1.0.0', source: 'created',
      installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'complete', plugins: [], homePath: aliveHome,
    })

    const manager = makeManager(registryPath, dshHome)
    expect((await manager.listPacks()).map(pack => pack.id)).toEqual(['alive'])
    expect((await readPackRegistry(registryPath)).map(record => record.id)).toEqual(['alive'])
  })
})
