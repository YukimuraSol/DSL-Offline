import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTarGz, writeTarGz, type TarEntry } from '../electron/tar-archive'
import {
  acquireSlot,
  bootInstance,
  buildCleanHome,
  compareHome,
  installPlugin,
  listVendorPlugins,
  isStaleSlot,
  classifyResidue,
  parseWorkbenchArgs,
  residueCount,
  restoreProfileGate,
  restoreHome,
  runWorkbench,
  selectPlugins,
  snapshotHome,
  uninstallPlugin,
  type BootRunner,
  type ComposeRunner,
  type HomeDiff,
  type SnapshotEntry,
  type VendorPlugin,
} from '../electron/workbench'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(root)
  return root
}

/** 造一个 npm 风格的插件 tgz（归档内统一 package/ 前缀）。 */
async function writePluginTgz(target: string, packageName = 'demo-plugin', version = '1.0.0'): Promise<void> {
  const entries: TarEntry[] = [
    { path: 'package', type: 'directory' },
    {
      path: 'package/package.json',
      type: 'file',
      data: Buffer.from(JSON.stringify({
        name: packageName,
        version,
        main: 'index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2), 'utf8'),
    },
    { path: 'package/index.js', type: 'file', data: Buffer.from('export default {}\n', 'utf8') },
    { path: 'package/cordis.patch.yml', type: 'file', data: Buffer.from('- insert: []\n', 'utf8') },
  ]
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, writeTarGz(entries))
}

/** 源实例家目录：内核入口 + 一个 profile + 附件目录 extras/（装配工作台只读它）。 */
async function makeSourceHome(root: string): Promise<string> {
  const home = path.join(root, 'source-home')
  const kernel = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.join(kernel, 'lib'), { recursive: true })
  await writeFile(path.join(kernel, 'lib', 'bin.js'), '// stub kernel\n', 'utf8')
  await writeFile(path.join(kernel, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }), 'utf8')
  await mkdir(path.join(home, 'profiles', 'demo'), { recursive: true })
  await writeFile(path.join(home, 'profiles', 'demo', 'profile.yaml'), 'name: demo\ndshVersion: 9.9.9\n', 'utf8')
  await mkdir(path.join(home, 'extras'), { recursive: true })
  return home
}

async function makePack(root: string, packageName = 'demo-plugin'): Promise<string> {
  const packDir = path.join(root, 'pack')
  await writePluginTgz(path.join(packDir, 'vendor', packageName + '-1.0.0.tgz'), packageName)
  return packDir
}

async function vendorPlugin(packDir: string, name = 'demo-plugin'): Promise<VendorPlugin> {
  const scan = await listVendorPlugins(packDir)
  const plugin = scan.plugins.find(item => item.name === name)
  if (!plugin) throw new Error('fixture 里没有 ' + name)
  return plugin
}

/** 读一行行事件，按 kind 过滤。 */
async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(runDir, 'events.jsonl'), 'utf8')
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('装配工作台：快照与还原', () => {
  it('安装再卸载后目录项完全对称（含 scope 目录与清单）', async () => {
    const root = await temporaryRoot('dsh-workbench-symmetry-')
    const sourceHome = await makeSourceHome(root)
    const packDir = await makePack(root)
    const plugin = await vendorPlugin(packDir)
    const home = path.join(root, 'home')
    const clean = await buildCleanHome({
      home,
      sourceHome,
      profileId: 'demo',
      kernelModules: path.join(sourceHome, 'profiles', 'node_modules'),
    })
    const manifestPath = path.join(clean.profileDir, 'package.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    const before = await snapshotHome(home)

    await installPlugin(clean.profileDir, plugin)
    const installed = await snapshotHome(home)
    const installedPaths = installed.map(entry => entry.path)
    expect(installedPaths).toContain('profiles/demo/.dsh-launcher-plugin-bodies/demo-plugin/package.json')
    expect(installedPaths).toContain('profiles/demo/node_modules/demo-plugin')
    expect(installed.find(entry => entry.path === 'profiles/demo/node_modules/demo-plugin')?.kind).toBe('link')
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).dsh.profile.bundles).toContain('demo-plugin')

    await uninstallPlugin(clean.profileDir, plugin)
    const after = await snapshotHome(home)
    expect(residueCount(compareHome(before, after))).toBe(0)
    // 清单也要原样还回去，否则下一次装配会带上上一次的依赖。
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
  })

  it('空目录也是残留，逐项回滚后归零', async () => {
    const root = await temporaryRoot('dsh-workbench-emptydir-')
    const sourceHome = await makeSourceHome(root)
    const home = path.join(root, 'home')
    const clean = await buildCleanHome({
      home,
      sourceHome,
      profileId: 'demo',
      kernelModules: path.join(sourceHome, 'profiles', 'node_modules'),
    })
    const before = await snapshotHome(home)
    await mkdir(path.join(clean.profileDir, 'leftover-empty-dir'), { recursive: true })

    const diff = compareHome(before, await snapshotHome(home))
    const residue = diff.added.find(entry => entry.path.endsWith('leftover-empty-dir'))
    expect(residue?.kind).toBe('dir')
    expect(residueCount(diff)).toBe(1)

    const restore = await restoreHome(home, diff)
    expect(restore.failed).toEqual([])
    expect(restore.removed).toContain('profiles/demo/leftover-empty-dir')
    expect(residueCount(compareHome(before, await snapshotHome(home)))).toBe(0)
  })

  it('噪声目录（logs/cache/sessions/rewind-snapshots）写了多少都不算残留', async () => {
    const root = await temporaryRoot('dsh-workbench-noise-')
    const home = path.join(root, 'home')
    await mkdir(home, { recursive: true })
    for (const noise of ['logs', 'cache', 'sessions', 'rewind-snapshots']) {
      await mkdir(path.join(home, noise), { recursive: true })
      await writeFile(path.join(home, noise, 'before.txt'), 'x', 'utf8')
    }
    await writeFile(path.join(home, 'settings.yaml'), 'a: 1\n', 'utf8')
    const before = await snapshotHome(home)
    expect(before.some(entry => entry.path.startsWith('logs/'))).toBe(false)

    for (const noise of ['logs', 'cache', 'sessions', 'rewind-snapshots']) {
      await mkdir(path.join(home, noise, 'nested'), { recursive: true })
      await writeFile(path.join(home, noise, 'nested', 'after.txt'), 'y'.repeat(1024), 'utf8')
    }
    expect(residueCount(compareHome(before, await snapshotHome(home)))).toBe(0)

    // 对照：非噪声目录里多一个空目录就必须报出来。
    await mkdir(path.join(home, 'state'), { recursive: true })
    expect(compareHome(before, await snapshotHome(home)).added.map(entry => entry.path)).toContain('state')
  })

  it('附件（extras/）只比目录项与文件大小，不比内容；attachments/ 不参与', async () => {
    const root = await temporaryRoot('dsh-workbench-extras-')
    const home = path.join(root, 'home')
    await mkdir(path.join(home, 'extras'), { recursive: true })
    await writeFile(path.join(home, 'extras', 'a.bin'), Buffer.alloc(3))
    await writeFile(path.join(home, 'notes.txt'), 'short', 'utf8')
    const before = await snapshotHome(home)

    // extras 里的文件变长 → 计一处差异；同样的字节数换了内容则不算（绝不读内容）。
    await writeFile(path.join(home, 'extras', 'a.bin'), Buffer.alloc(5))
    const diff = compareHome(before, await snapshotHome(home))
    expect(diff.sizeChanged.map(entry => entry.path)).toEqual(['extras/a.bin'])
    expect(diff.added).toEqual([])

    // 普通文件的内容变化（大小也变了）不在判定范围：那是实例自己每次启动都会重写的东西。
    await writeFile(path.join(home, 'notes.txt'), 'a much longer text', 'utf8')
    const second = compareHome(before, await snapshotHome(home))
    expect(second.sizeChanged.map(entry => entry.path)).toEqual(['extras/a.bin'])

    // attachments/ 是对话上传的私有数据：同名文件出现/变大都不进判定（工作台根本不建它）。
    await mkdir(path.join(home, 'attachments'), { recursive: true })
    await writeFile(path.join(home, 'attachments', 'upload.png'), Buffer.alloc(9))
    const third = compareHome(before, await snapshotHome(home))
    // attachments/ 里的文件只算「新增目录项」，永远不进 sizeChanged（不比大小、更不读内容）。
    expect(third.sizeChanged.map(entry => entry.path)).toEqual(['extras/a.bin'])
  })
})

describe('装配工作台：前置四件与槽位', () => {
  it('解析命令行：目录参数 + 可选开关 + 退出码语义', () => {
    const parsed = parseWorkbenchArgs(['pack-dir', '--plugin', 'demo-plugin', '--home', 'D:/home', '--timeout', '60000'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.packDir).toBe('pack-dir')
    expect(parsed.value.plugin).toBe('demo-plugin')
    expect(parsed.value.sourceHome).toBe('D:/home')
    expect(parsed.value.timeoutMs).toBe(60000)
    expect(parseWorkbenchArgs([]).ok).toBe(false)
    expect(parseWorkbenchArgs(['a', 'b']).ok).toBe(false)
    expect(parseWorkbenchArgs(['pack', '--nope']).ok).toBe(false)
    expect(parseWorkbenchArgs(['pack', '--timeout', '0']).ok).toBe(false)
  })

  it('槽位被活着的工作台占着时直接退出码 2，不排队也不碰运行目录', async () => {
    const root = await temporaryRoot('dsh-workbench-slot-')
    const sourceHome = await makeSourceHome(root)
    const packDir = await makePack(root)
    const runRoot = path.join(root, 'runs')
    await mkdir(runRoot, { recursive: true })
    // 手动占住槽位（写自己的 PID：一定还活着）。
    const holder = await acquireSlot(runRoot)
    expect(holder.ok).toBe(true)

    const lines: string[] = []
    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot,
      nodeExecutable: process.execPath,
      boot: bootInstance,
      onOutput: line => lines.push(line),
    })
    expect(result.exitCode).toBe(2)
    expect(result.runDir).toBeNull()
    expect(lines.join('\n')).toContain('槽位被占用')
    if (holder.ok) await holder.release()
  })

  it('陈旧锁会被接管：持有者进程已死，或锁放了超过两小时', async () => {
    const root = await temporaryRoot('dsh-workbench-stale-')
    const runRoot = path.join(root, 'runs')
    await mkdir(runRoot, { recursive: true })
    const lockPath = path.join(runRoot, 'workbench.lock')

    // 1) 进程已死（用一个不可能存在的 PID）。
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }), 'utf8')
    expect(isStaleSlot({ pid: 999_999, startedAt: new Date().toISOString() })).toBe(true)
    const first = await acquireSlot(runRoot)
    expect(first.ok).toBe(true)
    if (first.ok) await first.release()

    // 2) 进程还活着（自己的 PID）但锁已经放了三小时。
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    expect(isStaleSlot({ pid: process.pid, startedAt: threeHoursAgo })).toBe(true)
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: threeHoursAgo }), 'utf8')
    const second = await acquireSlot(runRoot)
    expect(second.ok).toBe(true)
    if (second.ok) await second.release()

    // 3) 活着且新鲜 → 占用，不接管。
    expect(isStaleSlot({ pid: process.pid, startedAt: new Date().toISOString() })).toBe(false)
  })

  it('缺附件文件夹（extras/）时阻塞并写清楚缺的是哪一项', async () => {
    const root = await temporaryRoot('dsh-workbench-missing-extras-')
    const sourceHome = await makeSourceHome(root)
    await rm(path.join(sourceHome, 'extras'), { recursive: true, force: true })
    const packDir = await makePack(root)
    const runRoot = path.join(root, 'runs')

    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot,
      nodeExecutable: process.execPath,
      boot: bootInstance,
    })
    expect(result.exitCode).toBe(2)
    const status = JSON.parse(await readFile(path.join(result.runDir!, 'status.json'), 'utf8')) as {
      phase: string
      reason: string
      kernel: { version: string; state: string }
    }
    expect(status.phase).toBe('blocked')
    expect(status.reason).toContain('附件文件夹')
    expect(status.kernel.version).toBe('9.9.9')
    const start = (await readEvents(result.runDir!)).find(event => event.kind === 'start')
    const details = start?.details as Record<string, { ok: boolean; detail: string }>
    expect(details.extras.ok).toBe(false)
    expect(details.kernel.ok).toBe(true)
  })

  it('缺内核时阻塞：不在跑到一半的时候才炸', async () => {
    const root = await temporaryRoot('dsh-workbench-missing-kernel-')
    const sourceHome = await makeSourceHome(root)
    await rm(path.join(sourceHome, 'profiles', 'node_modules'), { recursive: true, force: true })
    const packDir = await makePack(root)

    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot: path.join(root, 'runs'),
      nodeExecutable: process.execPath,
      boot: bootInstance,
    })
    expect(result.exitCode).toBe(2)
    const status = JSON.parse(await readFile(path.join(result.runDir!, 'status.json'), 'utf8')) as { phase: string; reason: string }
    expect(status.phase).toBe('blocked')
    expect(status.reason).toContain('内核')
  })

  it('缺插件（vendor 为空）时阻塞', async () => {
    const root = await temporaryRoot('dsh-workbench-missing-plugin-')
    const sourceHome = await makeSourceHome(root)
    const packDir = path.join(root, 'empty-pack')
    await mkdir(path.join(packDir, 'vendor'), { recursive: true })

    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot: path.join(root, 'runs'),
      nodeExecutable: process.execPath,
      boot: bootInstance,
    })
    expect(result.exitCode).toBe(2)
    const status = JSON.parse(await readFile(path.join(result.runDir!, 'status.json'), 'utf8')) as { phase: string; reason: string }
    expect(status.phase).toBe('blocked')
    expect(status.reason).toContain('插件')
  })
})

/** 假组合树：门控在 = 插件进了组合；门控不在 = 只有 core。 */
const fakeCompose: ComposeRunner = async context => {
    const gate = path.join(context.profileDir, 'node_modules', 'demo-plugin')
    const installed = await stat(gate).then(() => true, () => false)
    return installed ? '# composition\n- id: demo-plugin\n' : '# composition\n- id: @deepseek-ai/dsh-base\n'
}

/**
 * 假启动：装上了才写东西，卸掉就不写。三种痕迹对应三档判定：
   *   dirty  —— 留在装配场地里（profiles/<id>/node_modules 根），卸载撤不掉 → 不合格
   *   writes —— 运行期用户数据（home 根下的 state/），不进包 → 合格但标 writes
   *   gate   —— 写进 profile 的 cordis.patch.yml（像 dsh-free-search 那样存设置）→ 卸载要撤掉
   */
function fakeBoot(mode: { dirty?: boolean; writes?: boolean; gate?: boolean }): BootRunner {
  return async context => {
    const gate = path.join(context.profileDir, 'node_modules', 'demo-plugin')
    const installed = await stat(gate).then(() => true, () => false)
    if (installed && mode.dirty) {
      await mkdir(path.join(context.profileDir, 'node_modules'), { recursive: true })
      await writeFile(path.join(context.profileDir, 'node_modules', 'stale-plugin.txt'), 'left behind', 'utf8')
    }
    if (installed && mode.writes) {
      await mkdir(path.join(context.home, 'state'), { recursive: true })
      await writeFile(path.join(context.home, 'state', 'demo-plugin.json'), '{"left":true}', 'utf8')
    }
    if (installed && mode.gate) {
      await writeFile(
        path.join(context.profileDir, 'cordis.patch.yml'),
        '- id: demo-plugin\n  config:\n    provider: bing\n',
        'utf8',
      )
    }
    return { ok: true, reason: '注入的假启动（端口 ' + context.port + '）', output: '', pid: null, readyMs: 1, portReleased: true }
  }
}

describe('装配工作台：单个插件闭环', () => {

  it('装配 → 启停 → 卸载 → 再启 → 对比 → 回滚；残留会被报出来并回滚干净', async () => {
    const root = await temporaryRoot('dsh-workbench-flow-')
    const sourceHome = await makeSourceHome(root)
    const packDir = await makePack(root)
    const runRoot = path.join(root, 'runs')

    const first = await runWorkbench({
      packDir,
      sourceHome,
      runRoot,
      plugin: 'demo-plugin',
      nodeExecutable: process.execPath,
      boot: fakeBoot({ dirty: true }),
      compose: fakeCompose,
    })
    expect(first.exitCode).toBe(1)
    expect(first.verdicts).toHaveLength(1)
    expect(first.verdicts[0]!.ok).toBe(false)
    expect(first.verdicts[0]!.class).toBe('dirty')
    expect(first.verdicts[0]!.reason).toContain('残留')
    expect(first.verdicts[0]!.reason).toContain('stale-plugin.txt')

    const events = await readEvents(first.runDir!)
    const kinds = events.map(event => event.kind)
    for (const required of ['slot-lock', 'start', 'kernel-check', 'snapshot', 'install', 'boot', 'stop', 'uninstall', 'compare', 'verdict']) {
      expect(kinds).toContain(required)
    }
    expect(events.filter(event => event.kind === 'boot').map(event => event.role)).toEqual([
      'warmup', 'installed', 'uninstalled',
    ])
    const compare = events.find(event => event.kind === 'compare')!
    expect(compare.remainingCount).toBe(0)
    expect(compare.emptyDirResidue).toBeDefined()

    const verdictFile = JSON.parse(await readFile(path.join(first.runDir!, 'verdict.json'), 'utf8')) as Array<{ name: string; ok: boolean; class: string }>
    expect(verdictFile).toEqual([{ name: 'demo-plugin', ok: false, class: 'dirty', reason: expect.any(String) }])
    const finalStatus = JSON.parse(await readFile(path.join(first.runDir!, 'status.json'), 'utf8')) as { phase: string; passed: string[] }
    expect(finalStatus.phase).toBe('done')
    expect(finalStatus.passed).toEqual([])

    // 第二次跑同一个插件：上一次的残留已经被回滚掉，这次干净的启动必须过。
    const second = await runWorkbench({
      packDir,
      sourceHome,
      runRoot,
      plugin: 'demo-plugin',
      nodeExecutable: process.execPath,
      boot: fakeBoot({}),
      compose: fakeCompose,
    })
    expect(second.exitCode).toBe(0)
    expect(second.verdicts[0]!.ok).toBe(true)
    expect(second.verdicts[0]!.reason).toContain('全部通过')
    const passed = JSON.parse(await readFile(path.join(second.runDir!, 'status.json'), 'utf8')) as { passed: string[] }
    expect(passed.passed).toEqual(['demo-plugin'])

    // 两次跑完（一次不合格、一次合格）槽位都必须已经释放，否则下一次只会拿到 exit 2。
    await expect(stat(path.join(runRoot, 'workbench.lock'))).rejects.toThrow()
  })

  it('workbench-<时间戳>/ 下的三个契约文件形状正确', async () => {
    const root = await temporaryRoot('dsh-workbench-contract-')
    const sourceHome = await makeSourceHome(root)
    const packDir = await makePack(root)
    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot: path.join(root, 'runs'),
      nodeExecutable: process.execPath,
      boot: fakeBoot({}),
      compose: fakeCompose,
    })
    expect(result.exitCode).toBe(0)
    const runDir = result.runDir!
    expect(path.basename(runDir)).toMatch(/^workbench-\d{8}-\d{6}/)

    const status = JSON.parse(await readFile(path.join(runDir, 'status.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(status).sort()).toEqual(['current', 'kernel', 'passed', 'phase', 'reason', 'startedAt'])
    expect(status.kernel).toEqual({ version: '9.9.9', state: 'ok' })
    expect(status.phase).toBe('done')
    expect(status.passed).toEqual(['demo-plugin'])
    expect(status.current).toBeNull()
    expect(typeof status.startedAt).toBe('string')

    const events = await readEvents(runDir)
    for (const event of events) {
      expect(typeof event.ts).toBe('string')
      expect(typeof event.kind).toBe('string')
    }
    const verdict = JSON.parse(await readFile(path.join(runDir, 'verdict.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(verdict).toHaveLength(1)
    expect(Object.keys(verdict[0]!).sort()).toEqual(['class', 'name', 'ok', 'reason'])
    expect(verdict[0]!.class).toBe('ok')
    expect(verdict[0]!.name).toBe('demo-plugin')
    expect(verdict[0]!.ok).toBe(true)
  })
})

describe('装配工作台：三档判定与 profile 补丁层', () => {
  it('classifyResidue：装配场地里的算 dirty，运行期数据算 writes，少文件一律 dirty', () => {
    const entry = (p: string, kind: 'file' | 'dir' = 'file'): SnapshotEntry => ({ path: p, kind, size: 1 })
    const diff: HomeDiff = {
      added: [
        entry('profiles/demo/node_modules/demo-plugin', 'dir'),
        entry('profiles/demo/.dsh-launcher-plugin-bodies/demo-plugin/x.js'),
        entry('openai-gateway', 'dir'),
        entry('our-free-model/settings.json'),
        entry('profiles/demo/.dsh-market/state.json'),
      ],
      removed: [entry('profiles/demo/profile.yaml')],
      sizeChanged: [entry('extras/a.bin')],
    }
    const { dirty, writes } = classifyResidue(diff, 'demo')
    expect(dirty).toEqual([
      'profiles/demo/.dsh-launcher-plugin-bodies/demo-plugin/x.js',
      'profiles/demo/node_modules/demo-plugin',
      '缺:profiles/demo/profile.yaml',
    ])
    expect(writes).toEqual([
      'extras/a.bin',
      'openai-gateway',
      'our-free-model/settings.json',
      'profiles/demo/.dsh-market/state.json',
    ])
  })

  it('restoreProfileGate：原来没有就删掉，原来有就写回原文', async () => {
    const root = await temporaryRoot('dsh-workbench-gate-')
    const profileDir = path.join(root, 'profiles', 'demo')
    await mkdir(profileDir, { recursive: true })
    const gatePath = path.join(profileDir, 'cordis.patch.yml')

    // 基线没有这个文件（干净 home 的常态）：插件写进来的整份都要带走。
    await writeFile(gatePath, '- id: demo-plugin\n', 'utf8')
    expect(await restoreProfileGate(profileDir, null)).toBe('deleted')
    await expect(stat(gatePath)).rejects.toThrow()

    // 再调一次：已经不在，什么都不做（不报错）。
    expect(await restoreProfileGate(profileDir, null)).toBe('unchanged')

    // 基线有内容：被插件改过就写回原文。
    const baseline = '- id: user-own\n  config:\n    keep: true\n'
    await writeFile(gatePath, baseline, 'utf8')
    expect(await restoreProfileGate(profileDir, baseline)).toBe('unchanged')
    await writeFile(gatePath, baseline + '- id: demo-plugin\n', 'utf8')
    expect(await restoreProfileGate(profileDir, baseline)).toBe('restored')
    expect(await readFile(gatePath, 'utf8')).toBe(baseline)
  })

  it('插件往 cordis.patch.yml 存设置时，卸载要撤掉，不能算残留', async () => {
    const root = await temporaryRoot('dsh-workbench-gate-flow-')
    const sourceHome = await makeSourceHome(root)
    const packDir = await makePack(root)
    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot: path.join(root, 'runs'),
      nodeExecutable: process.execPath,
      boot: fakeBoot({ gate: true }),
      compose: fakeCompose,
    })
    // 补丁层复原后组合树才能复原，否则这两项都会误判。
    expect(result.exitCode).toBe(0)
    expect(result.verdicts[0]!.ok).toBe(true)
    expect(result.verdicts[0]!.class).toBe('ok')
    const events = await readEvents(result.runDir!)
    expect(events.find(event => event.kind === 'uninstall')!.profileGate).toBe('deleted')
    const compare = events.find(event => event.kind === 'compare')!
    expect(compare.added).toEqual([])
    expect(compare.dirty).toEqual([])
    // 家里不应该还留着这份补丁文件。
    await expect(stat(path.join(result.runDir!, 'home', 'profiles', 'demo', 'cordis.patch.yml'))).rejects.toThrow()
  })

  it('只写运行期数据的插件判 writes：合格，但把路径列出来', async () => {
    const root = await temporaryRoot('dsh-workbench-writes-')
    const sourceHome = await makeSourceHome(root)
    const packDir = await makePack(root)
    const result = await runWorkbench({
      packDir,
      sourceHome,
      runRoot: path.join(root, 'runs'),
      nodeExecutable: process.execPath,
      boot: fakeBoot({ writes: true }),
      compose: fakeCompose,
    })
    expect(result.exitCode).toBe(0)
    expect(result.verdicts[0]!.ok).toBe(true)
    expect(result.verdicts[0]!.class).toBe('writes')
    expect(result.verdicts[0]!.reason).toContain('运行期写入')
    expect(result.verdicts[0]!.reason).toContain('state')
    const verdict = JSON.parse(await readFile(path.join(result.runDir!, 'verdict.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(verdict[0]!.class).toBe('writes')
    expect(verdict[0]!.ok).toBe(true)
    // 仍然逐项回滚（工作台的家目录是消耗品，跑完要还回去）。
    const compare = (await readEvents(result.runDir!)).find(event => event.kind === 'compare')!
    expect(compare.writes).toEqual(['state', 'state/demo-plugin.json'])
    expect(compare.remainingCount).toBe(0)
  })
})

describe('装配工作台：安装顺序与 tgz 阅读', () => {
  it('按 manifest.installOrder 排，再补上名单外的 tgz', async () => {
    const root = await temporaryRoot('dsh-workbench-order-')
    const packDir = path.join(root, 'pack')
    await writePluginTgz(path.join(packDir, 'vendor', 'a-1.0.0.tgz'), 'alpha')
    await writePluginTgz(path.join(packDir, 'vendor', 'b-1.0.0.tgz'), 'beta')
    await writePluginTgz(path.join(packDir, 'vendor', 'c-1.0.0.tgz'), 'gamma')
    const sha = 'sha512-' + Buffer.alloc(64, 7).toString('base64')
    await writeFile(path.join(packDir, 'manifest.json'), JSON.stringify({
      format: 1,
      dshVersion: '9.9.9',
      platform: 'win32-x64',
      plugins: [
        { name: 'alpha', version: '1.0.0', integrity: sha, tgz: 'vendor/a-1.0.0.tgz', entry: 'index.js', hasBundle: true, hasClient: false, deps: [], enabled: true },
        { name: 'theta', version: '1.0.0', integrity: sha, tgz: 'vendor/t-1.0.0.tgz', entry: 'index.js', hasBundle: true, hasClient: false, deps: [], enabled: true },
        { name: 'beta', version: '1.0.0', integrity: sha, tgz: 'vendor/b-1.0.0.tgz', entry: 'index.js', hasBundle: true, hasClient: false, deps: ['alpha'], enabled: true },
      ],
      extras: { path: 'extras', fileCount: 0, bytes: 0, directoryCount: 0 },
      installOrder: ['alpha', 'beta', 'theta'],
    }, null, 2), 'utf8')

    const scan = await listVendorPlugins(packDir)
    expect(scan.problems).toEqual([])
    expect(selectPlugins(scan).map(plugin => plugin.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(selectPlugins(scan, 'gamma').map(plugin => plugin.name)).toEqual(['gamma'])
    expect(selectPlugins(scan, 'nope')).toEqual([])
  })

  it('解 tgz 时拒绝跳出本体目录的路径', async () => {
    const root = await temporaryRoot('dsh-workbench-slip-')
    const tgz = path.join(root, 'evil.tgz')
    await writeFile(tgz, writeTarGz([
      { path: 'package/package.json', type: 'file', data: Buffer.from(JSON.stringify({ name: 'evil', version: '1.0.0' }), 'utf8') },
      { path: 'package/../../escaped.txt', type: 'file', data: Buffer.from('nope', 'utf8') },
    ]))
    const archive = readTarGz(await readFile(tgz))
    expect(archive.some(entry => entry.path.includes('..'))).toBe(true)

    const sourceHome = await makeSourceHome(root)
    const home = path.join(root, 'home')
    const clean = await buildCleanHome({
      home,
      sourceHome,
      profileId: 'demo',
      kernelModules: path.join(sourceHome, 'profiles', 'node_modules'),
    })
    await expect(installPlugin(clean.profileDir, {
      name: 'evil', version: '1.0.0', tgz, entry: null, hasBundle: false,
    })).rejects.toThrow(/越界/)
    // 越界条目在原子上写之前就被拦住：目标目录之外不应该出现文件。
    await expect(stat(path.join(root, 'escaped.txt'))).rejects.toThrow()
  })
})
