import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { biliEnvironment, packKernel, resolveProfileName } from '../electron/instances'

/**
 * 并发实例的内核解析与 bili 隔离（唯一的可运行检查）。
 *
 * 三级回退是「两包跑不同内核版本」的开关，搞错就会两个包偷偷共用同一份内核；
 * biliEnvironment 搞错就会两个实例抢同一个 18788 代理、共用一份会话数据。
 */

let root = ''
const shellName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

async function makeKernel(modulesRoot: string, version: string) {
  const bin = path.join(modulesRoot, '.bin')
  const manifestDir = path.join(modulesRoot, '@deepseek-ai', 'dsh')
  await mkdir(bin, { recursive: true })
  await mkdir(manifestDir, { recursive: true })
  await writeFile(path.join(bin, shellName), '', 'utf8')
  await writeFile(path.join(manifestDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  return path.join(bin, shellName)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-instances-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('packKernel', () => {
  it('优先用包内 profiles/node_modules 的内核', async () => {
    const home = path.join(root, 'pack')
    const bundled = await makeKernel(path.join(home, 'profiles', 'node_modules'), '0.2.0-rc.2')
    await makeKernel(path.join(root, 'versions', '0.2.1-rc.2', 'node_modules'), '0.2.1-rc.2')
    const kernel = packKernel(home, 'global-dsh', { root, version: '0.2.1-rc.2' })
    expect(kernel).toEqual({ executable: bundled, version: '0.2.0-rc.2', source: 'pack' })
  })

  it('包里没有内核时按 dshVersion 去版本库精确取', async () => {
    const home = path.join(root, 'pack')
    await mkdir(path.join(home, 'profiles'), { recursive: true })
    const pinned = await makeKernel(path.join(root, 'versions', '0.2.1-rc.2', 'node_modules'), '0.2.1-rc.2')
    const kernel = packKernel(home, 'global-dsh', { root, version: '0.2.1-rc.2' })
    expect(kernel).toEqual({ executable: pinned, version: '0.2.1-rc.2', source: 'pack' })
  })

  it('包内与版本库都没有才回落启动器全局那份', async () => {
    const home = path.join(root, 'pack')
    await mkdir(path.join(home, 'profiles'), { recursive: true })
    expect(packKernel(home, 'global-dsh', { root, version: '0.2.9-rc.9' }))
      .toEqual({ executable: 'global-dsh', version: null, source: 'launcher' })
    expect(packKernel(null, 'global-dsh')).toEqual({ executable: 'global-dsh', version: null, source: 'launcher' })
  })
})

describe('biliEnvironment', () => {
  it('每个实例一套会话目录与代理端口，互不重叠', () => {
    const a = biliEnvironment('C:\\inst\\a', 4000)
    const b = biliEnvironment('C:\\inst\\b', 3080)
    expect(a.BILI_SESSIONS_DIR).not.toBe(b.BILI_SESSIONS_DIR)
    expect(a.BILI_CONFIG_FILE).not.toBe(b.BILI_CONFIG_FILE)
    // 20000 起跳：3080→23080/23081、4000→24000/24001，避开 18788/18887/18888 这段旧布局。
    expect(b.BILI_ZONE_PORT).toBe('23080')
    expect(b.BILI_CLAUDE_NATIVE_PORT).toBe('23081')
    expect(a.BILI_ZONE_PORT).toBe('24000')
    expect(a.ACP_AUTO_UPDATE).toBe('0')
  })
})

/**
 * 包的 profile 目录名。判据是「目录里有 package.json」，不是「目录存在」——
 * 启动器写元数据时会顺手 mkdir 出同名空壳（只有 profile.yaml），
 * 把空壳当 profile 就会给内核传 `--profile <空壳>`，DSH 直接 exit 1。
 */
describe('resolveProfileName', () => {
  /** 造一个 profile 目录：withManifest 为真才是内核认的真 profile，否则只是空壳。 */
  async function makeProfile(home: string, name: string, withManifest: boolean) {
    const directory = path.join(home, 'profiles', name)
    await mkdir(directory, { recursive: true })
    if (withManifest) {
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}` }), 'utf8')
    } else {
      await writeFile(path.join(directory, 'profile.yaml'), 'dshVersion: 0.2.1-rc.2\n', 'utf8')
    }
  }

  it('同名 profile 目录里有 package.json 时用包 id', async () => {
    const home = path.join(root, 'pack-a')
    await makeProfile(home, 'pack-a', true)
    await makeProfile(home, 'web', true)
    expect(resolveProfileName(home, 'pack-a')).toBe('pack-a')
  })

  it('同名目录只是没有 package.json 的空壳、web 才是真 profile 时回落到 web', async () => {
    const home = path.join(root, 'pack-b')
    await makeProfile(home, 'pack-b', false)
    await makeProfile(home, 'web', true)
    expect(resolveProfileName(home, 'pack-b')).toBe('web')
  })

  it('两个目录都没有 package.json 时退回包 id', async () => {
    const home = path.join(root, 'pack-c')
    await makeProfile(home, 'pack-c', false)
    await makeProfile(home, 'web', false)
    expect(resolveProfileName(home, 'pack-c')).toBe('pack-c')
  })

  it('homePath 为 null 时直接用包 id，不碰文件系统', () => {
    expect(resolveProfileName(null, 'pack-d')).toBe('pack-d')
  })
})
