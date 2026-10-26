/**
 * 收编已有文件夹：把一个现成的 DSH 家目录登记成整合包。
 *
 * 三件事必须一直成立，否则自动收编会把用户的目录搞坏：
 *   1. 只登记，不搬 —— 目录里一个文件都不许增删；
 *   2. 包 id 等于 profile 目录名 —— 否则激活时 seedPackHome 会在用户目录里补空壳；
 *   3. 不像家目录的目录一律拒绝 —— 不登记点开就崩的空壳。
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings, ProfileState } from '../src/types'
import { createPackManager } from '../electron/pack'
import { adoptPackFromFolder, inspectAdoptableHome } from '../electron/pack-adopt'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** 造一个像样的 DSH 家目录：profiles/<id>/{package.json, profile.yaml}。 */
async function homeFixture(profileId = 'mypack') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-adopt-'))
  temporaryRoots.push(root)
  const dshHome = path.join(root, 'dsh-packs', profileId)
  const profileDir = path.join(dshHome, 'profiles', profileId)
  await mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  await mkdir(path.join(dshHome, 'extras'), { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profileId}`,
    dependencies: {
      '@deepseek-ai/dsh-core': '0.1.2',
      'dsh-plugin-alpha': 'file:./.dsh-launcher-plugin-bodies/dsh-plugin-alpha',
    },
  }))
  // name 走 isSafeProfileName 校验（profile-service.ts:115），中文会被打回目录名，
  // 所以 fixture 用 ASCII 名，才测得到「从 profile.yaml 读到显示名」这条路径。
  await writeFile(path.join(profileDir, 'profile.yaml'), `name: my_migrated_pack\ndshVersion: 0.1.2-rc.1\n`)
  await writeFile(path.join(dshHome, 'extras', 'readme.txt'), '附件')
  return { root, dshHome, registryPath: path.join(root, 'packs.json') }
}

describe('adoptPackFromFolder', () => {
  it('登记已有家目录：id 取 profile 目录名，homePath 指向原地，且不动磁盘', async () => {
    const env = await homeFixture()
    const before = await readdir(env.dshHome, { recursive: true })

    const { record, profileId } = await adoptPackFromFolder({ registryPath: env.registryPath, homePath: env.dshHome })

    expect(profileId).toBe('mypack')
    expect(record.id).toBe('mypack')
    expect(record.name).toBe('my_migrated_pack')
    expect(record.dshVersion).toBe('0.1.2-rc.1')
    expect(record.homePath).toBe(path.resolve(env.dshHome))
    expect(record.state).toBe('complete')
    // 内置 dsh 包不算插件。
    expect(record.plugins.map(plugin => plugin.packageName)).toEqual(['dsh-plugin-alpha'])

    const records = await readPackRegistry(env.registryPath)
    expect(records.map(item => item.id)).toEqual(['mypack'])
    // 只登记：目录内容一模一样。
    expect(await readdir(env.dshHome, { recursive: true })).toEqual(before)
  })

  it('重复收编同一个目录 = 幂等刷新，不产生第二条记录', async () => {
    const env = await homeFixture()
    await adoptPackFromFolder({ registryPath: env.registryPath, homePath: env.dshHome })
    await adoptPackFromFolder({ registryPath: env.registryPath, homePath: env.dshHome, name: '改过的名字' })
    const records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBe('改过的名字')
  })

  it('同 id 已被别的家目录占用时直接报错，绝不顶掉既有包', async () => {
    const env = await homeFixture()
    const other = await homeFixture()
    await adoptPackFromFolder({ registryPath: env.registryPath, homePath: other.dshHome })
    await expect(adoptPackFromFolder({ registryPath: env.registryPath, homePath: env.dshHome })).rejects.toThrow(/已被另一个整合包占用/)
    expect((await readPackRegistry(env.registryPath))[0]!.homePath).toBe(path.resolve(other.dshHome))
  })

  it('不是 DSH 家目录的文件夹拒绝收编', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pack-adopt-bad-'))
    temporaryRoots.push(root)
    const empty = path.join(root, 'just-a-folder')
    await mkdir(empty, { recursive: true })
    await expect(inspectAdoptableHome(empty)).rejects.toThrow(/不是 DSH 家目录/)
    // profiles 目录在、但没有 package.json：同样不算家目录。
    await mkdir(path.join(empty, 'profiles', 'half'), { recursive: true })
    await expect(inspectAdoptableHome(empty)).rejects.toThrow(/不是 DSH 家目录/)
  })
})

// ---------------------------------------------------------------------------
// listPacks 自动收编：目录摆进 packsRoot 就等于配置好了，不需要点按钮
// ---------------------------------------------------------------------------

function managerOptions(registryPath: string, dshHome: string) {
  let settings: AppSettings = { ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }), dshHome, profileName: 'web' }
  const emptyProfile: ProfileState = { initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 }
  return {
    readSettings: async () => settings,
    saveSettings: async (next: AppSettings) => { settings = next; return settings },
    registryPath,
    snapshotRoot: path.join(dshHome, 'snapshots'),
    pluginReceiptsPath: path.join(dshHome, 'plugin-installs.json'),
    presetReceiptsPath: path.join(dshHome, 'preset-installs.json'),
    skillReceiptsPath: path.join(dshHome, 'skill-installs.json'),
    applicationAddons: {
      list: async () => [],
      install: async () => ({}),
      uninstall: async () => [],
    },
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
    dshHome,
  }
}

describe('listPacks 自动收编 packsRoot 下的目录', () => {
  it('注册表为空 + 合规目录 → 自动收编成整合包，不用点任何按钮', async () => {
    const env = await homeFixture()
    const manager = createPackManager(managerOptions(env.registryPath, path.join(env.root, 'dsh-home')))

    const packs = await manager.listPacks()

    expect(packs.map(pack => pack.id)).toEqual(['mypack'])
    expect(packs[0]!.name).toBe('my_migrated_pack')
    // 收编结果写进注册表：下次启动直接读，不需要重扫。
    expect((await readPackRegistry(env.registryPath)).map(record => record.id)).toEqual(['mypack'])
  })

  it('目录不像家目录（profiles 里没有 package.json）→ 不收编，列表照常返回', async () => {
    const env = await homeFixture()
    await mkdir(path.join(env.root, 'dsh-packs', 'just-a-folder', 'profiles', 'half'), { recursive: true })
    const manager = createPackManager(managerOptions(env.registryPath, path.join(env.root, 'dsh-home')))

    const packs = await manager.listPacks()

    expect(packs.map(pack => pack.id)).toEqual(['mypack'])
    expect((await readPackRegistry(env.registryPath)).map(record => record.id)).toEqual(['mypack'])
  })
})

// ---------------------------------------------------------------------------
// 包 id = 家目录名（阶段 1 起就按这个认）：profile 目录名只用来读插件清单
// ---------------------------------------------------------------------------

/** 一个「profiles/web」布局的家目录（阶段 2 之后所有包都长这样）。 */
async function webLayoutHome(root: string, dirName: string) {
  const home = path.join(root, 'dsh-packs', dirName)
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { '@deepseek-ai/dsh-core': '0.1.2' },
  }))
  await writeFile(path.join(profileDir, 'profile.yaml'), `name: ${dirName}\ndshVersion: 0.1.2-rc.1\n`)
  return home
}

describe('自动收编：包 id 取目录名，去重按 homePath', () => {
  it('两个家目录里的 profile 都叫 web，也能各自收编成两个包', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pack-adopt-web-'))
    temporaryRoots.push(root)
    const alpha = await webLayoutHome(root, 'alpha')
    const beta = await webLayoutHome(root, 'beta')
    const registryPath = path.join(root, 'packs.json')
    const manager = createPackManager(managerOptions(registryPath, path.join(root, 'dsh-home')))

    const packs = await manager.listPacks()
    expect(packs.map(pack => pack.id).sort()).toEqual(['alpha', 'beta'])
    // 再刷一遍列表不会重复收编（同一个家目录只登记一次）。
    expect((await manager.listPacks()).map(pack => pack.id).sort()).toEqual(['alpha', 'beta'])

    const records = await readPackRegistry(registryPath)
    expect(records.map(record => record.id).sort()).toEqual(['alpha', 'beta'])
    expect(records.map(record => record.homePath).sort()).toEqual([alpha, beta].sort())
  })

  it('注册表里已有这个家目录（id 与目录名不同）时按路径认出来，不再收编第二条', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pack-adopt-known-'))
    temporaryRoots.push(root)
    const alpha = await webLayoutHome(root, 'alpha')
    const registryPath = path.join(root, 'packs.json')
    // 老版本按 profile 目录名登记的记录：id 叫 web，家目录却是 alpha。
    const legacy: PackRecord = {
      id: 'web',
      name: 'alpha',
      description: '',
      version: '1.0.0',
      homePath: alpha,
      source: 'created',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'complete',
      plugins: [],
    }
    await upsertPackRecord(registryPath, legacy)
    const manager = createPackManager(managerOptions(registryPath, path.join(root, 'dsh-home')))

    await manager.listPacks()

    expect((await readPackRegistry(registryPath)).map(record => record.id)).toEqual(['web'])
  })
})

