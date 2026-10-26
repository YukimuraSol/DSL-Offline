import { describe, expect, it } from 'vitest'
import { decidePortConflict, findPortOwners, parseNetstatListeners, releasePort } from '../electron/port-control'

/**
 * 端口占用治理（缺陷 7）。
 *
 * 守两件事：
 *   1. 解析口径 —— 只认「本地端口 + LISTENING」，别把远端端口/ESTABLISHED 算进来；
 *   2. 杀伤范围 —— 只按 PID 结束，绝不按映像名批量杀。
 * 真跑 netstat/taskkill 的路径不在单测里验证（会把本机进程搅乱），一律注入假 run。
 */

const NETSTAT = [
  '',
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    0.0.0.0:3080       0.0.0.0:0       LISTENING       4096',
  '  TCP    127.0.0.1:3080     127.0.0.1:52001 ESTABLISHED     4096',
  '  TCP    127.0.0.1:3080     127.0.0.1:52002 ESTABLISHED     7777',
  '  TCP    [::]:3080          [::]:0          LISTENING       5120',
  '  TCP    127.0.0.1:13080    0.0.0.0:0       LISTENING       9999',
  '  TCP    127.0.0.1:3081     0.0.0.0:0       LISTENING       4096',
  '',
].join('\r\n')

describe('parseNetstatListeners', () => {
  it('只挑本地端口匹配且处于 LISTENING 的 PID', () => {
    expect(parseNetstatListeners(NETSTAT, 3080)).toEqual([4096, 5120])
  })

  it('不会把 13080 当成 3080，也不把 ESTABLISHED 的连接算成占用', () => {
    expect(parseNetstatListeners(NETSTAT, 3081)).toEqual([4096])
    expect(parseNetstatListeners(NETSTAT, 13080)).toEqual([9999])
    expect(parseNetstatListeners(NETSTAT, 3082)).toEqual([])
  })

  it('空输出与垃圾行不抛错', () => {
    expect(parseNetstatListeners('', 3080)).toEqual([])
    expect(parseNetstatListeners('随便写点什么\nTCP 乱来', 3080)).toEqual([])
  })
})

describe('findPortOwners', () => {
  it('查得到名字和路径就带上', async () => {
    const calls: string[] = []
    const owners = await findPortOwners(3080, {
      run: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`)
        if (file === 'netstat.exe') return { stdout: NETSTAT }
        const pid = Number(args.at(-1)?.match(/ProcessId=(\d+)/)?.[1] ?? 0)
        return { stdout: JSON.stringify({ ProcessId: pid, Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe' }) }
      },
    })
    expect(owners).toEqual([
      { pid: 4096, name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe' },
      { pid: 5120, name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe' },
    ])
    // 先一次 netstat，再每个 PID 一次 powershell；绝不整表枚举。
    expect(calls[0]).toContain('netstat.exe -ano -p TCP')
    expect(calls.filter(call => call.startsWith('powershell.exe'))).toHaveLength(2)
  })

  it('查不到进程详情也返回记录（<未知> 不等于没占用）', async () => {
    const owners = await findPortOwners(3080, {
      run: async file => {
        if (file === 'netstat.exe') return { stdout: NETSTAT }
        throw new Error('拒绝访问')
      },
    })
    expect(owners.map(owner => owner.name)).toEqual(['<未知>', '<未知>'])
  })

  it('netstat 本身就跑不起来时按「有人占着」返回', async () => {
    await expect(findPortOwners(3080, { run: async () => { throw new Error('ENOENT') } }))
      .resolves.toEqual([{ pid: -1, name: '<未知>', path: null }])
  })

  it('端口号不合法直接当没人占（不跑命令）', async () => {
    let called = false
    await expect(findPortOwners(0, { run: async () => { called = true; return { stdout: '' } } })).resolves.toEqual([])
    expect(called).toBe(false)
  })
})

describe('releasePort', () => {
  it('只按 PID 结束，单个失败不影响其余', async () => {
    const calls: string[][] = []
    const result = await releasePort(3080, [
      { pid: 4096, name: 'node.exe', path: null },
      { pid: 5120, name: 'node.exe', path: null },
      { pid: -1, name: '<未知>', path: null },
    ], {
      run: async (file, args) => {
        calls.push([file, ...args])
        if (args.includes('5120')) throw new Error('拒绝访问')
        return { stdout: '' }
      },
    })

    expect(calls.every(([file]) => file === 'taskkill.exe')).toBe(true)
    expect(calls.every(call => call.includes('/pid') && !call.includes('/im'))).toBe(true)
    expect(result.killed).toEqual([4096])
    // 顺序跟 owners 走：先 5120（taskkill 抛错），再 -1（PID 校验挡下）。
    expect(result.failed).toEqual([{ pid: 5120, reason: '拒绝访问' }, { pid: -1, reason: '进程号无效' }])
  })

  it('一个都没结束时不白等', async () => {
    const started = Date.now()
    const result = await releasePort(3080, [], { run: async () => { throw new Error('不该被调用') } })
    expect(result).toEqual({ killed: [], failed: [] })
    expect(Date.now() - started).toBeLessThan(120)
  })
})

describe('decidePortConflict', () => {
  it('占用者全是自己 track 的子进程才自愈', () => {
    expect(decidePortConflict([{ pid: 4096, name: 'node.exe', path: null }], [4096])).toBe('self-heal')
  })

  it('混进陌生进程就得问用户', () => {
    expect(decidePortConflict([
      { pid: 4096, name: 'node.exe', path: null },
      { pid: 7777, name: 'chrome.exe', path: null },
    ], [4096])).toBe('ask')
  })

  it('什么都不知道时宁可问，也不替用户杀进程', () => {
    expect(decidePortConflict([], [4096])).toBe('ask')
    expect(decidePortConflict([{ pid: 4096, name: 'node.exe', path: null }], [])).toBe('ask')
  })
})
