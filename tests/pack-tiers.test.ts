import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPackManager } from '../electron/pack'
import { upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

// 三档徽章计数（本地Link / 安全外联 / 需转移）的探针：造一个真家目录，
// 走 listPacks 这条公开路径取计数，证明它不是假绿。

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Env { root: string; dshHome: string; registryPath: string }

async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-tiers-'))
  temporaryRoots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles'), { recursive: true })
  return { root, dshHome, registryPath: path.join(root, 'packs.json') }
}

function makeManager(env: Env) {
  const settings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome: env.dshHome,
    dshVersion: '0.1.0-rc.7',
    profileName: 'web',
    activePackId: 'demo',
  }
  return createPackManager({
    readSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async () => settings),
    registryPath: env.registryPath,
    snapshotRoot: path.join(env.root, 'pack-snapshots'),
    pluginReceiptsPath: path.join(env.root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(env.root, 'preset-installs.json'),
    skillReceiptsPath: path.join(env.root, 'skill-installs.json'),
    applicationAddons: { list: vi.fn(async () => []), install: vi.fn(async () => {}), uninstall: vi.fn(async () => []) },
    installer: {
      readProfile: vi.fn(async () => null),
      remove: vi.fn(async () => {}),
      togglePlugin: vi.fn(async () => null),
      installPluginTarget: vi.fn(async () => {}),
      installSkill: vi.fn(async () => null),
      installSkillPinned: vi.fn(async () => null),
      installSkillLocal: vi.fn(async () => {}),
      toggleSkill: vi.fn(async () => []),
      installPreset: vi.fn(async () => null),
      installPresetLocal: vi.fn(async () => {}),
      togglePreset: vi.fn(async () => []),
    } as never,
    emitEvent: vi.fn(),
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    dshHome: env.dshHome,
  })
}

/** 在 profiles/<id>/node_modules/<包名>/package.json 里写一个真实装的版本。 */
async function installPackage(home: string, packId: string, packageName: string, version: string): Promise<void> {
  const dir = path.join(home, 'profiles', packId, 'node_modules', packageName)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf8')
}

/** 写一个插件本体：profiles/<id>/.dsh-launcher-plugin-bodies/<名字>/package.json。 */
async function writePluginBody(home: string, packId: string, bodyName: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(home, 'profiles', packId, '.dsh-launcher-plugin-bodies', bodyName)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: bodyName.split('/').pop(), version: '1.0.0', ...manifest }), 'utf8')
}

async function writeDependencies(home: string, packId: string, dependencies: Record<string, string>): Promise<void> {
  const dir = path.join(home, 'profiles', packId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packId, version: '1.0.0', dependencies }, null, 2), 'utf8')
}

function recordFor(id: string, homePath: string): PackRecord {
  return {
    id,
    name: id,
    description: '',
    version: '1.0.0',
    source: 'created',
    homePath,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'complete',
    plugins: [],
  }
}

async function countersOf(env: Env) {
  await upsertPackRecord(env.registryPath, recordFor('demo', env.dshHome))
  const manager = makeManager(env)
  const packs = await manager.listPacks()
  const demo = packs.find(pack => pack.id === 'demo')
  if (!demo) throw new Error('探针没拿到 demo 包的计数')
  return { vaultCount: demo.vaultCount, remoteCount: demo.remoteCount, moveCount: demo.moveCount, extrasCount: demo.extrasCount }
}

describe('整合包三档计数（本地Link / 安全外联 / 需转移）', () => {
  it('混合依赖各归各档：本地 link、版本对得上、版本目录不在、未声明的散包', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      linked: 'link:D:/somewhere/x',   // 本地Link
      x: '^1.2.3',                     // 安全外联：装的是 1.2.9
      y: '^9.9.9',                     // 目录不在：哪一档都不算
    })
    await installPackage(env.dshHome, 'demo', 'x', '1.2.9')
    await installPackage(env.dshHome, 'demo', 'stray-pkg', '0.0.1')  // 没声明 → 需转移

    expect(await countersOf(env)).toEqual({ vaultCount: 1, remoteCount: 1, moveCount: 1, extrasCount: 0 })
  })

  it('版本比对宽容：~ 与裸版本认，major 对不上不认', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      tilde: '~0.4.0',       // 装 0.4.7 → 认
      exact: '1.0.0',        // 装 1.0.0 → 认
      wrongMajor: '^1.2.3',  // 装 2.0.0 → 不认
      missing: '^3.0.0',     // 目录不在 → 不认
    })
    await installPackage(env.dshHome, 'demo', 'tilde', '0.4.7')
    await installPackage(env.dshHome, 'demo', 'exact', '1.0.0')
    await installPackage(env.dshHome, 'demo', 'wrongMajor', '2.0.0')

    expect(await countersOf(env)).toEqual({ vaultCount: 0, remoteCount: 2, moveCount: 0, extrasCount: 0 })
  })

  it('插件本体声明的传递依赖不算需转移（js-yaml / zod 场景）', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      'dsh-context': 'file:./.dsh-launcher-plugin-bodies/dsh-context',   // 本地Link
    })
    // 插件本体把 zod / js-yaml 写在 dependencies 与 peerDependencies 里：它们在依赖图里。
    await writePluginBody(env.dshHome, 'demo', 'dsh-context', {
      dependencies: { zod: '^3.25.0' },
      peerDependencies: { 'js-yaml': '^4.1.0' },
    })
    await installPackage(env.dshHome, 'demo', 'zod', '3.25.0')
    await installPackage(env.dshHome, 'demo', 'js-yaml', '4.1.0')

    expect(await countersOf(env)).toEqual({ vaultCount: 1, remoteCount: 0, moveCount: 0, extrasCount: 0 })
  })

  it('谁都没声明的包仍然计入需转移', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      'dsh-context': 'file:./.dsh-launcher-plugin-bodies/dsh-context',
    })
    await writePluginBody(env.dshHome, 'demo', 'dsh-context', { optionalDependencies: { zod: '^3.25.0' } })
    await installPackage(env.dshHome, 'demo', 'zod', '3.25.0')          // 本体声明了 → 不算
    await installPackage(env.dshHome, 'demo', 'nobody-wants-me', '0.0.1') // 谁都没声明 → 需转移

    expect(await countersOf(env)).toEqual({ vaultCount: 1, remoteCount: 0, moveCount: 1, extrasCount: 0 })
  })

  it('退役插件本体里声明的依赖不算活跃声明，遗留目录仍计入需转移', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      'dsh-active': 'file:./.dsh-launcher-plugin-bodies/dsh-active',
    })
    await writePluginBody(env.dshHome, 'demo', 'dsh-active', { dependencies: {} })
    // 退役本体：目录还在、manifest 还声明着 zod，但 profile 已经不引用它。
    await writePluginBody(env.dshHome, 'demo', 'billion-context.bak-bcuninstall-20261023', { dependencies: { zod: '^3.25.0' } })
    await installPackage(env.dshHome, 'demo', 'zod', '3.25.0')

    expect(await countersOf(env)).toEqual({ vaultCount: 1, remoteCount: 0, moveCount: 1, extrasCount: 0 })
  })

  it('插件本体的 package.json 读不到时按没有声明处理，计数照常返回', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      'dsh-broken': 'file:./.dsh-launcher-plugin-bodies/dsh-broken',
      'dsh-gone': 'link:D:/no/such/body',
    })
    const broken = path.join(env.dshHome, 'profiles', 'demo', '.dsh-launcher-plugin-bodies', 'dsh-broken')
    await mkdir(broken, { recursive: true })
    await writeFile(path.join(broken, 'package.json'), '{ this is not json', 'utf8')
    await installPackage(env.dshHome, 'demo', 'stray-pkg', '0.0.1')

    expect(await countersOf(env)).toEqual({ vaultCount: 2, remoteCount: 0, moveCount: 1, extrasCount: 0 })
  })

  it('包内 .dsh-launcher-plugin-bodies 的 file: 依赖仍算本地Link', async () => {
    const env = await makeEnv()
    await writeDependencies(env.dshHome, 'demo', {
      inpack: 'file:./.dsh-launcher-plugin-bodies/inpack',
      outside: 'file:D:/elsewhere/y',
    })

    expect(await countersOf(env)).toEqual({ vaultCount: 2, remoteCount: 0, moveCount: 0, extrasCount: 0 })
  })
})
