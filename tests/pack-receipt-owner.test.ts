/**
 * 收据归属键 = 包 id。
 *
 * 这条线守的是「删一个包不许动别的包的安装收据」：阶段 1 里两个包的 profile 目录名
 * 还可能撞成同一个（阶段 2 起全都叫 web），只要收据按 profile 目录名存，
 * 删一个包就会把别的包的同名收据一起删掉、或者一个都删不掉。
 *
 * 这里故意走真实的 createInstaller + 真实的 recordPluginInstall 写盘（只把
 * analyzeRepository / readProfile 换成替身），再用真实的 createPackManager 删包 ——
 * 把实现退回「收据键 = profile 目录名」，最后那条断言就会变红。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProfileState } from '../src/types'
import type { CommandOptions } from '../electron/command'
import { createInstaller } from '../electron/installer'
import { analyzeRepository } from '../electron/plugin-catalog'
import { readProfile } from '../electron/profile'
import { readPluginReceipts } from '../electron/plugin-receipts'
import { createPackManager } from '../electron/pack'
import { upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

vi.mock('../electron/profile', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/profile')>()
  return { ...actual, readProfile: vi.fn() }
})

vi.mock('../electron/plugin-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/plugin-catalog')>()
  return { ...actual, analyzeRepository: vi.fn() }
})

let root = ''
let settings: AppSettings

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pack-receipt-owner-'))
  settings = settingsFor(path.join(root, 'dsh-packs', 'pack-a'), 'pack-a')
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  vi.resetAllMocks()
})

function settingsFor(home: string, activePackId: string): AppSettings {
  return {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome: home,
    // 两个包的 profile 目录名故意撞成同一个：这正是阶段 2 的样子。
    profileName: 'web',
    activePackId,
  }
}

function installedProfile(packageName: string): ProfileState {
  const plugin = {
    packageName,
    displayName: packageName,
    version: '1.2.3',
    description: '',
    enabled: true,
    builtin: false,
    locked: false,
    compatible: true,
    order: 1,
  }
  return {
    initialized: true,
    profileDir: path.join('profiles', 'web'),
    manifestPath: path.join('profiles', 'web', 'package.json'),
    plugins: [plugin],
    activeBundles: [packageName],
    dependencyCount: 1,
    disabledCount: 0,
  }
}

/** 真实的 createInstaller，只有命令执行器与分析器是替身（收据写盘是真的）。 */
function createInstallerUnderTest(receiptsPath: string) {
  const node = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpm = path.join(root, 'pnpm', 'node_modules', '.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  return createInstaller({
    readSettings: async () => settings,
    saveSettings: async next => next,
    prepareNodeRuntime: async () => ({ root: path.join(root, 'node'), node, npm: node, npx: node, managed: true }),
    preparePnpmRuntime: async () => ({ root: path.join(root, 'pnpm'), executable: pnpm }),
    pluginSourceRoot: path.join(root, 'plugin-source'),
    pluginReceiptsPath: receiptsPath,
    presetReceiptsPath: path.join(root, 'preset-receipts.json'),
    skillReceiptsPath: path.join(root, 'skill-receipts.json'),
    skillSourceRoot: path.join(root, 'skill-source'),
    emitOutput: () => {},
    emitProgress: () => {},
    isRuntimeRunning: () => false,
    runCommand: async (_executable: string, _args: string[], _options: CommandOptions) => ({ exitCode: 0, output: '' }),
  })
}

async function installIntoPackage(installer: ReturnType<typeof createInstallerUnderTest>, pluginDir: string, packId: string): Promise<void> {
  const target = {
    id: 'demo-plugin:.',
    packageName: 'demo-plugin',
    version: null,
    source: 'local-directory' as const,
    profileName: 'web',
    platform: 'unknown' as const,
    subdirectory: null,
    commit: '',
    requiresBuild: false,
    buildScripts: [] as string[],
    nodeRange: null,
    localDirectory: pluginDir,
  }
  vi.mocked(analyzeRepository).mockResolvedValue({
    repository: 'demo/plugin',
    defaultBranch: 'main',
    installability: 'ready',
    summary: 'ok',
    targets: [target],
  } as never)
  vi.mocked(readProfile).mockResolvedValue(installedProfile('demo-plugin'))
  settings = settingsFor(path.join(root, 'dsh-packs', packId), packId)
  await installer.installPluginTarget({ repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' }, 'web', packId)
}

function record(id: string, homePath: string): PackRecord {
  return {
    id,
    name: id,
    description: '',
    version: '1.0.0',
    homePath,
    source: 'created',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'complete',
    plugins: [],
  }
}

describe('收据归属键是包 id：删一个包不碰别的包的收据', () => {
  it('两个包的 profile 都叫 web 时，各装各的，删 A 只删 A 的收据', async () => {
    const receiptsPath = path.join(root, 'plugin-installs.json')
    const pluginDir = path.join(root, 'plugin-local')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo-plugin' }))
    const registryPath = path.join(root, 'packs.json')
    const packsRoot = path.join(root, 'dsh-packs')
    const homeA = path.join(packsRoot, 'pack-a')
    const homeB = path.join(packsRoot, 'pack-b')
    for (const home of [homeA, homeB]) await mkdir(path.join(home, 'profiles', 'web'), { recursive: true })

    const installer = createInstallerUnderTest(receiptsPath)
    await installIntoPackage(installer, pluginDir, 'pack-a')
    await installIntoPackage(installer, pluginDir, 'pack-b')

    // 两条收据必须分得清是哪个包装的（按 profile 目录名存就会变成两条 'web'）。
    expect((await readPluginReceipts(receiptsPath)).map(item => item.packId).sort()).toEqual(['pack-a', 'pack-b'])

    await upsertPackRecord(registryPath, record('pack-a', homeA))
    await upsertPackRecord(registryPath, record('pack-b', homeB))
    const emptyProfile: ProfileState = { initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 }
    const manager = createPackManager({
      readSettings: async () => settings,
      saveSettings: async next => next,
      registryPath,
      snapshotRoot: path.join(root, 'pack-snapshots'),
      pluginReceiptsPath: receiptsPath,
      presetReceiptsPath: path.join(root, 'preset-receipts.json'),
      skillReceiptsPath: path.join(root, 'skill-receipts.json'),
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
      dshHome: path.join(root, 'dsh-packs', 'pack-a'),
    })

    await manager.removePack('pack-a')

    const left = await readPluginReceipts(receiptsPath)
    // 别的包的收据一条不动。
    expect(left.filter(item => item.packId === 'pack-b')).toHaveLength(1)
    // 被删包的收据收拾干净（退回按 profile 目录名存，这条就会红）。
    expect(left.filter(item => item.packId === 'pack-a')).toHaveLength(0)
  })
})
