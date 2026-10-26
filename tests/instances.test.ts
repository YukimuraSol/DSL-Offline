import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { biliEnvironment, packKernel } from '../electron/instances'

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
