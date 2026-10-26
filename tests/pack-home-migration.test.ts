import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adoptLegacyPackHomes } from '../electron/pack-home-migration'
import { readPackRegistry, writePackRegistry, type PackRecord } from '../electron/pack-registry'

/**
 * 修 2 的可运行检查：旧包（packs.json 里没有 homePath）在启动时拿到自己的家目录。
 *
 * 台式实测形态（第一条用例就是照它写的）：
 *   web              —— 缺 homePath（要被补齐的那个）
 *   pack-bili-min    —— 有 homePath，且 settings.activePackId 指向它
 *   pack-bili-min-2  —— 有 homePath
 * 老 guard（「只有激活包自己缺家才搬」）在这种形态下整段跳过，web 永远没绿边 ——
 * 那正是用户报的第一个问题。
 *
 * 另一半同样重要：绝不能搬错人（把已登记整合包的私有家目录搬给别的包）。
 */

let root = ''
let registryPath = ''
let packsRoot = ''
let sharedHome = ''

function packRecord(id: string, homePath?: string): PackRecord {
  return {
    id,
    name: id.toUpperCase(),
    description: '',
    version: '1.0.0',
    ...(homePath ? { homePath } : {}),
    source: 'zip' as const,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    state: 'complete' as const,
    plugins: [],
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-home-'))
  registryPath = path.join(root, 'packs.json')
  packsRoot = path.join(root, 'dsh-packs')
  sharedHome = path.join(root, 'dsh-home')
  await mkdir(path.join(sharedHome, 'profiles', 'web'), { recursive: true })
  await writeFile(path.join(sharedHome, 'profiles', 'web', 'package.json'), '{"dependencies":{}}', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('adoptLegacyPackHomes', () => {
  it('台式真实形态：激活包有家、web 缺家 → 把共享目录搬给 web', async () => {
    const biliHome = path.join(packsRoot, 'pack-bili-min')
    const biliHome2 = path.join(packsRoot, 'pack-bili-min-2')
    await mkdir(biliHome, { recursive: true })
    await writeFile(path.join(biliHome, 'bili-marker.txt'), 'bili', 'utf8')
    await mkdir(biliHome2, { recursive: true })
    await writePackRegistry(registryPath, [
      packRecord('web'),
      packRecord('pack-bili-min', biliHome),
      packRecord('pack-bili-min-2', biliHome2),
    ])

    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'pack-bili-min',
    })

    expect(result.moved).toHaveLength(1)
    expect(result.moved[0]).toMatchObject({ packId: 'web', homePath: path.join(packsRoot, 'web') })
    expect(await readFile(path.join(packsRoot, 'web', 'profiles', 'web', 'package.json'), 'utf8'))
      .toBe('{"dependencies":{}}')
    const records = await readPackRegistry(registryPath)
    expect(records.find(record => record.id === 'web')?.homePath).toBe(path.join(packsRoot, 'web'))
    // 激活包自己的家一个字节都没动（「别搬错人」的核心断言）
    expect(await readFile(path.join(biliHome, 'bili-marker.txt'), 'utf8')).toBe('bili')
    expect(records.find(record => record.id === 'pack-bili-min')?.homePath).toBe(biliHome)
  })

  it('幂等：第二次启动不再搬', async () => {
    await writePackRegistry(registryPath, [packRecord('web')])
    await adoptLegacyPackHomes({ registryPath, packsRoot, sharedHome, activePackId: 'web' })
    const second = await adoptLegacyPackHomes({ registryPath, packsRoot, sharedHome, activePackId: 'web' })
    expect(second.moved).toHaveLength(0)
    expect(second.skipped).toHaveLength(0)
  })

  it('激活包自己缺家目录：共享目录归它（1.0.9 的老行为保留）', async () => {
    const otherHome = path.join(packsRoot, 'pack-x')
    await mkdir(otherHome, { recursive: true })
    await writePackRegistry(registryPath, [packRecord('web'), packRecord('pack-x', otherHome)])
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'web',
    })
    expect(result.moved).toHaveLength(1)
    expect(result.moved[0].packId).toBe('web')
  })

  it('激活包缺家、但还有另一个也缺家 → 只搬激活包，另一个跳过', async () => {
    await writePackRegistry(registryPath, [packRecord('web'), packRecord('pack-x')])
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'web',
    })
    expect(result.moved.map(item => item.packId)).toEqual(['web'])
    expect(result.skipped.map(item => item.packId)).toEqual(['pack-x'])
    expect(await exists(path.join(packsRoot, 'pack-x'))).toBe(false)
  })

  it('两条都缺家目录且激活包已独立 → 一条都不搬，只记日志说明', async () => {
    const activeHome = path.join(packsRoot, 'active')
    await mkdir(activeHome, { recursive: true })
    await writePackRegistry(registryPath, [packRecord('web'), packRecord('vendor'), packRecord('active', activeHome)])
    const logs: string[] = []
    const result = await adoptLegacyPackHomes({
      registryPath,
      packsRoot,
      sharedHome,
      activePackId: 'active',
      log: message => logs.push(message),
    })
    expect(result.moved).toHaveLength(0)
    expect(result.skipped.map(item => item.packId).sort()).toEqual(['vendor', 'web'])
    expect(await exists(path.join(packsRoot, 'web'))).toBe(false)
    expect(await exists(path.join(packsRoot, 'vendor'))).toBe(false)
    expect(logs.join('\n')).toContain('只能给其中一个')
  })

  it('共享家目录就是某个已登记包的家 → 谁都不搬（别把人家的环境送人）', async () => {
    // 「拿 settings.read().dshHome 来补」就会造成这个场景：共享值其实指向激活包的私有目录。
    await writePackRegistry(registryPath, [packRecord('web'), packRecord('pack-bili-min', sharedHome)])
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'pack-bili-min',
    })
    expect(result.moved).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('私有家目录')
    expect(await readFile(path.join(sharedHome, 'profiles', 'web', 'package.json'), 'utf8'))
      .toBe('{"dependencies":{}}')
  })

  it('目标目录已有内容时只认领、不重复搬', async () => {
    const target = path.join(packsRoot, 'web')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'marker.txt'), 'kept', 'utf8')
    await writePackRegistry(registryPath, [packRecord('web')])
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'web',
    })
    expect(result.moved).toHaveLength(1)
    expect(result.moved[0].via).toBe('adopt')
    expect(await readFile(path.join(target, 'marker.txt'), 'utf8')).toBe('kept')
    expect((await readPackRegistry(registryPath))[0]?.homePath).toBe(target)
  })

  it('共享家目录不存在时安静跳过，不抛错也不建空目录', async () => {
    await rm(sharedHome, { recursive: true, force: true })
    await writePackRegistry(registryPath, [packRecord('web')])
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'web',
    })
    expect(result.moved).toHaveLength(0)
    expect(await exists(path.join(packsRoot, 'web'))).toBe(false)
  })

  it('没有激活包时不动任何目录', async () => {
    await writePackRegistry(registryPath, [packRecord('web')])
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: null,
    })
    expect(result.moved).toHaveLength(0)
    expect(await exists(sharedHome)).toBe(true)
  })

  it('packs.json 坏掉时不抛错（启动不能因为这个挂）', async () => {
    await writeFile(registryPath, '{ 不是 JSON', 'utf8')
    const result = await adoptLegacyPackHomes({
      registryPath, packsRoot, sharedHome, activePackId: 'web',
    })
    expect(result.moved).toHaveLength(0)
  })
})
