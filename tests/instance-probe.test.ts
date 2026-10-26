import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandLineMatchesInstance, profileFromCommandLine } from '../electron/instance-probe'
import { rotateLogIfNeeded } from '../electron/instance-logs'

/**
 * 解耦之后「这个包在不在跑」全靠这两条判断：端口有人听 + 这条命令行确实是这个包的 DSH Web。
 * 认错一行就会显示错状态、停错进程，所以这两个纯函数必须有可跑的检查。
 */
describe('commandLineMatchesInstance', () => {
  const identity = { port: 4000, homePath: 'D:\\DSH Pack Launcher\\dsh-packs\\dsh-fallback-4000', kernelPath: null }

  it('包自带内核：命令行里有包家目录就算命中', () => {
    expect(commandLineMatchesInstance(
      'node "D:\\DSH Pack Launcher\\dsh-packs\\dsh-fallback-4000\\profiles\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh.js" web --port 4000',
      identity,
    )).toBe(true)
  })

  it('用启动器全局内核：命令行里没有包路径，靠 --port + dsh 认', () => {
    expect(commandLineMatchesInstance(
      'node "C:\\Users\\a\\dsh-runtime\\versions\\0.2.0\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh.js" web --no-open --port 4000',
      identity,
    )).toBe(true)
  })

  // 台式实测 0.2.0-rc.2 的真实命令行：参数带引号、没有 web 子命令。
  it('台式实测命令行：引号包裹的 --port、没有 web 也算命中', () => {
    expect(commandLineMatchesInstance(
      '"C:\\Users\\Administrator\\AppData\\Roaming\\dsh-launcher\\dsh-runtime\\versions\\0.2.0-rc.2\\node_modules\\.bin\\node.exe" "C:\\Users\\Administrator\\AppData\\Roaming\\dsh-launcher\\dsh-runtime\\versions\\0.2.0-rc.2\\node_modules\\.bin\\..\\@deepseek-ai\\dsh\\lib\\bin.js" "--profile" "pack-bili-min" "--no-open" "--port" "4000"',
      identity,
    )).toBe(true)
  })

  it('端口对不上就不认（挡住 PID 复用/别的实例）', () => {
    expect(commandLineMatchesInstance('node x\\dsh.js web --port 4001', identity)).toBe(false)
  })

  it('跟 dsh 无关的进程不认', () => {
    expect(commandLineMatchesInstance('"C:\\Windows\\System32\\notepad.exe"', identity)).toBe(false)
    expect(commandLineMatchesInstance('', identity)).toBe(false)
  })
})

describe('commandLineMatchesInstance · --profile 是首要身份证据', () => {
  // 两个包都声称 3080 的那个事故：命令行说 --profile web，就不是 pack-bili-min 的实例。
  const packA = { port: 3080, homePath: 'D:\\packs\\pack-bili-min', kernelPath: null, profileName: 'pack-bili-min' }

  it('命令行说的是别的 profile：端口对得上也不认', () => {
    expect(commandLineMatchesInstance(
      '"dsh.cmd" "--profile" "web" "--no-open" "--port" "3080"',
      packA,
    )).toBe(false)
  })

  it('profile 对上就认（哪怕命令行里没有包路径）', () => {
    expect(commandLineMatchesInstance(
      'node "C:\\dsh-runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile pack-bili-min --no-open --port 3080',
      packA,
    )).toBe(true)
  })

  it('命令行没有 --profile 时退回端口判断（web 别名启动不带 --profile）', () => {
    expect(commandLineMatchesInstance(
      'node "C:\\dsh-runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --no-open --port 3080',
      packA,
    )).toBe(true)
  })
})

describe('profileFromCommandLine', () => {
  it('认得空格分隔与引号包裹两种写法', () => {
    expect(profileFromCommandLine('dsh --profile pack-bili-min --no-open')).toBe('pack-bili-min')
    expect(profileFromCommandLine('"dsh.cmd" "--profile" "pack-x" "--port" "3080"')).toBe('pack-x')
    expect(profileFromCommandLine('dsh web --port 3080')).toBeNull()
  })
})

describe('rotateLogIfNeeded', () => {
  it('超过阈值就改名成 .1，旧的 .1 被覆盖', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-log-'))
    const file = path.join(dir, 'launcher.out.log')
    try {
      writeFileSync(file, 'x'.repeat(40))
      rotateLogIfNeeded(file, 32)
      expect(statSync(file + '.1').size).toBe(40)
      writeFileSync(file, 'y'.repeat(40))
      rotateLogIfNeeded(file, 32)
      expect(readFileSync(file + '.1', 'utf8')).toBe('y'.repeat(40))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没到阈值不动文件', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-log-'))
    const file = path.join(dir, 'launcher.err.log')
    try {
      writeFileSync(file, 'x'.repeat(10))
      rotateLogIfNeeded(file, 32)
      expect(statSync(file).size).toBe(10)
      expect(() => statSync(file + '.1')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
