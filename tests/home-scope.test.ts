import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLauncherOwnedHome, assertLauncherOwnedRuntime, isLauncherOwnedHome, isLauncherOwnedRuntime } from '../electron/home-scope'

/**
 * 认领边界（第六项）。
 *
 * 这些断言守的是「启动器绝不会整棵删/覆盖写用户自己的 ~/.dsh」：
 * 用户手动把 dshHome 指到外部目录时，删整合包 / 回滚 / 删内核都必须被拒绝，
 * 而不是带着热情把真实环境清掉。
 *
 * 路径用宿主平台原生形状拼：守卫靠的是 path.isAbsolute / path.resolve 的语义，
 * 硬写 "C:\Users\..." 会让 ubuntu 腿把它们当成相对路径，四条断言全红。
 */

const fixtureRoot = path.join(os.tmpdir(), 'launcher-home-scope')
const userData = path.join(fixtureRoot, 'roaming', 'dsh-launcher')
const packsRoot = path.join(fixtureRoot, 'local', 'dsh-launcher', 'dsh-packs')
const managedDshRoot = path.join(userData, 'dsh-runtime')
const foreignHome = path.join(fixtureRoot, 'dsh')
const scope = { userData, packsRoot, managedDshRoot }

describe('home scope', () => {
  it('treats the user real ~/.dsh as foreign', () => {
    expect(isLauncherOwnedHome(foreignHome, scope)).toBe(false)
  })

  it('owns the private dsh-home under userData', () => {
    expect(isLauncherOwnedHome(path.join(userData, 'dsh-home'), scope)).toBe(true)
    expect(isLauncherOwnedHome(userData, scope)).toBe(true)
  })

  it('owns every pack home under the packs root', () => {
    expect(isLauncherOwnedHome(path.join(packsRoot, 'work'), scope)).toBe(true)
    expect(isLauncherOwnedHome(packsRoot, scope)).toBe(true)
  })

  it('does not get fooled by a sibling prefixed with the same name', () => {
    expect(isLauncherOwnedHome(`${userData}evil`, scope)).toBe(false)
  })

  it('does not accept a path that escapes userData with ..', () => {
    expect(isLauncherOwnedHome(path.join(userData, '..', '..', '..', 'Windows'), scope)).toBe(false)
  })

  it('refuses to delete a foreign home and says why', () => {
    expect(() => assertLauncherOwnedHome(foreignHome, scope, '删除整合包「web」')).toThrow(/不在启动器管理的目录内/)
    expect(() => assertLauncherOwnedHome(path.join(userData, 'dsh-home'), scope, 'ok')).not.toThrow()
  })

  it('only deletes kernels inside the managed runtime root', () => {
    expect(isLauncherOwnedRuntime(path.join(managedDshRoot, 'versions', '0.2.0-rc.2'), scope)).toBe(true)
    expect(isLauncherOwnedRuntime(path.join(fixtureRoot, 'dsh-runtime', 'versions', '0.2.0-rc.2'), scope)).toBe(false)
    expect(() => assertLauncherOwnedRuntime(path.join(fixtureRoot, 'dsh-runtime'), scope, '删除 DSH 版本 0.2.0-rc.2')).toThrow(/不在启动器托管的 DSH 目录内/)
  })
})
