import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSettingsStore, defaultSettings, packsRootHasPacks, decidePacksRootMigration } from '../electron/settings'
import type { AppSettings } from '../src/types'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** 造一个临时目录树，返回其绝对路径。 */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packsroot-migrate-'))
  temporaryRoots.push(root)
  return root
}

/** 旧默认位置的两个候选（与 main.ts 的 legacyPacksRootDefaults 同一口径）。 */
const legacyCandidates = [
  path.join('/fake', 'AppData', 'Local', 'dsh-launcher', 'dsh-packs'),
  path.join('/fake', 'AppData', 'Roaming', 'dsh-launcher', 'dsh-packs'),
]

describe('decidePacksRootMigration', () => {
  it('migrates when stored is a legacy default, the old location is empty and the new one differs', () => {
    const plan = decidePacksRootMigration({
      stored: legacyCandidates[0],
      legacyCandidates,
      next: '/fake/DSH Pack Launcher/dsh-packs',
      legacyHasPacks: false,
    })
    expect(plan.migrate).toBe(true)
    expect(plan.target).toBe('/fake/DSH Pack Launcher/dsh-packs')
  })

  it('keeps the old location when it already holds a real pack', () => {
    const plan = decidePacksRootMigration({
      stored: legacyCandidates[0],
      legacyCandidates,
      next: '/fake/DSH Pack Launcher/dsh-packs',
      legacyHasPacks: true,
    })
    expect(plan.migrate).toBe(false)
    expect(plan.target).toBe(legacyCandidates[0])
  })

  it('never touches a user-chosen directory', () => {
    const plan = decidePacksRootMigration({
      stored: 'E:\\my-packs',
      legacyCandidates,
      next: '/fake/DSH Pack Launcher/dsh-packs',
      legacyHasPacks: false,
    })
    expect(plan.migrate).toBe(false)
    expect(plan.target).toBe('E:\\my-packs')
  })

  it('is idempotent: stored already at the new location is left alone', () => {
    const next = '/fake/DSH Pack Launcher/dsh-packs'
    const plan = decidePacksRootMigration({
      stored: next,
      legacyCandidates,
      next: next,
      legacyHasPacks: false,
    })
    expect(plan.migrate).toBe(false)
    expect(plan.target).toBe(next)
  })
  it('keeps the location when the packs live in the sibling directory next to the install dir', () => {
    // 1.0.3 之前的另一处旧默认：<安装目录父级>\dsh-packs（legacyPacksRootBesideInstall）。
    // 这条最容易漏：只比对前两个候选就迁移，会把兄弟位置里的真实包「迁走」。
    const besideInstall = path.join('/fake', 'dsh-packs')
    const plan = decidePacksRootMigration({
      stored: besideInstall,
      legacyCandidates: [...legacyCandidates, besideInstall],
      next: '/fake/DSH Pack Launcher/dsh-packs',
      legacyHasPacks: true,
    })
    expect(plan.migrate).toBe(false)
    expect(plan.target).toBe(besideInstall)
  })

  it('recognises the sibling location as a legacy default, not a user-chosen directory', () => {
    // 兄弟位置必须留在候选里，否则 stored 恰好等于它时会被当成「用户自己选的」，
    // 于是既不被认作旧默认值、又永远不迁移 —— 反过来说，认作旧默认值就是这条断言：
    // 它空了就会迁移（有包时见上一条，不迁移）。
    const besideInstall = path.join('/fake', 'dsh-packs')
    const plan = decidePacksRootMigration({
      stored: besideInstall,
      legacyCandidates: [...legacyCandidates, besideInstall],
      next: '/fake/DSH Pack Launcher/dsh-packs',
      legacyHasPacks: false,
    })
    expect(plan.migrate).toBe(true)
    expect(plan.target).toBe('/fake/DSH Pack Launcher/dsh-packs')
  })
})

/** 与 main.ts 的 migrateStoredPacksRoot 同一条写回路径：读存储态 → 只改 packsRoot → save。 */
async function applyPlan(settingsPath: string, userData: string, target: string): Promise<void> {
  const store = createSettingsStore({
    filePath: settingsPath,
    createDefaults: () => defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      dshInstallPath: path.join(userData, 'dsh-runtime'),
      userDataPath: userData,
      packsRoot: target,
    }),
    detectInstalledDsh: () => Promise.resolve({ installed: false, version: null, executable: null, source: null }),
  })
  const current: AppSettings = await store.readStored()
  await store.save({ ...current, packsRoot: target })
}

describe('packsRoot migration write-back', () => {
  it('rewrites settings.json and is idempotent on the next start', async () => {
    const userData = await temporaryRoot()
    const settingsPath = path.join(userData, 'settings.json')
    const stored = path.join('/fake', 'AppData', 'Local', 'dsh-launcher', 'dsh-packs')
    const next = path.join('/fake', 'DSH Pack Launcher', 'dsh-packs')
    const defaults = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      dshInstallPath: path.join(userData, 'dsh-runtime'),
      userDataPath: userData,
      packsRoot: stored,
    })
    await writeFile(settingsPath, `${JSON.stringify({ ...defaults, packsRoot: stored }, null, 2)}\n`, 'utf8')

    await applyPlan(settingsPath, userData, next)
    // validateSettings 会把 packsRoot 归一化成 path.resolve 的结果，比较时按同一口径。
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).packsRoot).toBe(path.resolve(next))

    // 第二次启动：stored 已是新位置，判定器不再迁移。
    const storedNow = JSON.parse(await readFile(settingsPath, 'utf8')).packsRoot as string
    const plan = decidePacksRootMigration({ stored: storedNow, legacyCandidates, next: next, legacyHasPacks: false })
    expect(plan.migrate).toBe(false)
    expect(plan.target).toBe(storedNow)
  })
})

describe('packsRoot migration against a real sibling directory', () => {
  it('leaves stored alone when the real packs sit in the sibling directory next to the install dir', async () => {
    const root = await temporaryRoot()
    const installDir = path.join(root, 'DSH Pack Launcher')
    const besideInstall = path.join(root, 'dsh-packs')
    await mkdir(installDir, { recursive: true })
    await mkdir(path.join(besideInstall, 'web', 'profiles', 'web'), { recursive: true })

    // main.ts 的三候选口径：defaultPacksRoot、<userData>\dsh-packs、兄弟目录。
    const stored = path.join('/fake', 'AppData', 'Local', 'dsh-launcher', 'dsh-packs')
    const legacyCandidates = [stored, path.join('/fake', 'AppData', 'Roaming', 'dsh-launcher', 'dsh-packs'), besideInstall]
    const legacyHasPacks = (await Promise.all(legacyCandidates.map(item => packsRootHasPacks(item)))).some(Boolean)
    expect(legacyHasPacks).toBe(true)

    const plan = decidePacksRootMigration({
      stored,
      legacyCandidates,
      next: path.join(installDir, 'dsh-packs'),
      legacyHasPacks,
    })
    expect(plan.migrate).toBe(false)
    expect(plan.target).toBe(stored)
  })
})

describe('packsRootHasPacks', () => {
  it('treats a missing directory as empty', async () => {
    const root = await temporaryRoot()
    expect(await packsRootHasPacks(path.join(root, 'nope'))).toBe(false)
  })

  it('treats an empty directory and an empty shell as empty', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'web'), { recursive: true })
    await mkdir(path.join(root, '.deleting-old'), { recursive: true })
    expect(await packsRootHasPacks(root)).toBe(false)
  })

  it('detects a real pack by its profiles/<id> directory', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'web', 'profiles', 'web'), { recursive: true })
    await writeFile(path.join(root, 'web', 'pack.json'), '{}\n', 'utf8')
    expect(await packsRootHasPacks(root)).toBe(true)
    expect(await readFile(path.join(root, 'web', 'pack.json'), 'utf8')).toBe('{}\n')
  })
})
