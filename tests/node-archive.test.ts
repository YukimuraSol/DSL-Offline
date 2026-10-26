/**
 * 方案 C 的四档判定：有 Node 就什么都不做，没有才从安装包内的归档补齐。
 *
 * 这些用例把版本探测和联网安装都注入了：探测不注入会跟着跑测试的这台机器变，
 * 安装不注入则每条「回落到下载」的用例都要真下 35MB。
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledNodeArchiveName,
  findBundledNodeArchive,
  parseBundledNodeArchiveName,
  writeNodeRuntimeArchive,
} from '../electron/node-archive'
import {
  NODE_RUNTIME_VERSION,
  PNPM_VERSION,
  ensureNodeRuntime,
  managedNodeVersionRoot,
  pnpmExecutable,
  runtimePaths,
  type NodeRuntime,
} from '../electron/node-runtime'

const EXECUTABLES = process.platform === 'win32'
  ? ['node.exe', 'npm.cmd', 'npx.cmd']
  : ['node', 'npm', 'npx']

/** POSIX 的发行包把可执行文件放在 bin/ 下；Windows 平铺。 */
const DISTRIBUTION_BIN = process.platform === 'win32' ? '.' : 'bin'
const WINDOWS_ONLY = process.platform === 'win32' ? it : it.skip

let temporaryDirectory = ''

async function makeTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-node-archive-'))
  return temporaryDirectory
}

async function createExecutables(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const name of EXECUTABLES) await writeFile(path.join(directory, name), '', 'utf8')
}

/** 造一棵「完整」的发行包树：三个壳 + node_modules/npm（缺 npm 的随包 Node 是废的）。 */
async function createCompleteNode(root: string): Promise<void> {
  await createExecutables(path.join(root, DISTRIBUTION_BIN))
  const npmRoot = path.join(root, 'node_modules', 'npm')
  await mkdir(path.join(npmRoot, 'bin'), { recursive: true })
  await writeFile(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', version: '11.17.0' }), 'utf8')
  await writeFile(path.join(npmRoot, 'bin', 'npm-cli.js'), '', 'utf8')
}

/** 造一棵托管 pnpm 根的内容（归档里的 pnpm/）。 */
async function createPnpmRoot(root: string): Promise<void> {
  const pnpmManifest = path.join(root, 'node_modules', 'pnpm', 'package.json')
  await mkdir(path.dirname(pnpmManifest), { recursive: true })
  await writeFile(pnpmManifest, JSON.stringify({ name: 'pnpm', version: PNPM_VERSION }), 'utf8')
  const executable = pnpmExecutable(root)
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, '', 'utf8')
}

interface Fixture {
  root: string
  runtimeRoot: string
  pnpmRuntimeRoot: string
  archiveRoot: string
  systemBin: string
}

/**
 * 归档内容与 vendor/ 同形：node/（完整发行包）+ pnpm/（托管 pnpm 根）。
 * 用仓库自己的写入器压，不引外部 zip 工具。
 */
async function fixture(options: { archiveName?: string } = {}): Promise<Fixture> {
  const root = await makeTemporaryDirectory()
  const nodeSource = path.join(root, 'vendor', 'node')
  const pnpmSource = path.join(root, 'vendor', 'pnpm')
  await createCompleteNode(nodeSource)
  await createPnpmRoot(pnpmSource)
  const archiveRoot = path.join(root, 'node-archive')
  await mkdir(archiveRoot, { recursive: true })
  await writeNodeRuntimeArchive({
    outputPath: path.join(archiveRoot, options.archiveName ?? bundledNodeArchiveName(NODE_RUNTIME_VERSION)),
    nodeRoot: nodeSource,
    pnpmRoot: pnpmSource,
  })
  const systemBin = path.join(root, 'system-bin')
  await createExecutables(systemBin)
  return {
    root,
    runtimeRoot: path.join(root, 'userData', 'node-runtime'),
    pnpmRuntimeRoot: path.join(root, 'userData', 'pnpm-runtime'),
    archiveRoot,
    systemBin,
  }
}

/** 只把本机那份当成老版本，其余（解出来的 node）视为达标。 */
function probe(systemBin: string, systemVersion: string | null = '18.20.4') {
  return async (executable: string): Promise<string | null> =>
    (path.resolve(executable).startsWith(path.resolve(systemBin)) ? systemVersion : '24.19.0')
}

/** 没有本机 Node 的机器：PATH 只有随包目录，Program Files 指向不存在的位置。 */
function noSystemNode(root: string): NodeJS.ProcessEnv {
  return { PATH: path.join(root, 'nowhere'), ProgramFiles: path.join(root, 'absent') }
}

function withSystemNode(fixture: Fixture): NodeJS.ProcessEnv {
  return { PATH: fixture.systemBin, ProgramFiles: path.join(fixture.root, 'absent') }
}

/** 「回落到下载」的替身：不联网，只按托管布局落地并记账。 */
function stubInstall(calls: Array<{ root: string; version: string }>, version = NODE_RUNTIME_VERSION) {
  return async (runtimeRoot: string, requestedVersion: string): Promise<NodeRuntime> => {
    calls.push({ root: runtimeRoot, version: requestedVersion })
    const finalRoot = managedNodeVersionRoot(runtimeRoot, version)
    await createCompleteNode(finalRoot)
    return runtimePaths(finalRoot, true, 'distribution-root')
  }
}

async function listStaging(runtimeRoot: string): Promise<string[]> {
  return (await readdir(path.join(runtimeRoot, 'versions')).catch(() => [] as string[]))
    .filter(name => name.startsWith('.node-archive-'))
}

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('随包归档的命名与识别', () => {
  it('文件名带版本与架构，解压前靠它比对', () => {
    expect(bundledNodeArchiveName('v24.19.0', 'x64')).toBe('node-runtime-v24.19.0-win-x64.zip')
    expect(bundledNodeArchiveName('24.19.0', 'arm64')).toBe('node-runtime-v24.19.0-win-arm64.zip')
    expect(parseBundledNodeArchiveName('node-runtime-v24.19.0-win-x64.zip')).toEqual({ version: 'v24.19.0', architecture: 'x64' })
    expect(parseBundledNodeArchiveName('node-v24.19.0-win-x64.zip')).toBeNull()
    expect(parseBundledNodeArchiveName('node-modules.zip')).toBeNull()
  })

  it('架构对不上就不认（x64 归档不能被 arm64 机器用，反之亦然）', async () => {
    const { archiveRoot } = await fixture({ archiveName: bundledNodeArchiveName(NODE_RUNTIME_VERSION, 'arm64') })

    const mismatch = await findBundledNodeArchive(archiveRoot, NODE_RUNTIME_VERSION, 'x64')
    expect(mismatch.archive).toBeNull()
    expect(mismatch.skipped).toEqual([bundledNodeArchiveName(NODE_RUNTIME_VERSION, 'arm64')])

    const matched = await findBundledNodeArchive(archiveRoot, NODE_RUNTIME_VERSION, 'arm64')
    expect(matched.archive?.architecture).toBe('arm64')
  })

  it('版本对不上也不认（代码升了、归档还是旧的）', async () => {
    const { archiveRoot } = await fixture({ archiveName: 'node-runtime-v22.19.0-win-x64.zip' })
    const lookup = await findBundledNodeArchive(archiveRoot, NODE_RUNTIME_VERSION, 'x64')
    expect(lookup.archive).toBeNull()
  })

  it('归档目录不存在时安静返回 null（开发态没跑归档脚本是正常情况）', async () => {
    const root = await makeTemporaryDirectory()
    expect((await findBundledNodeArchive(path.join(root, 'absent'), NODE_RUNTIME_VERSION, 'x64')).archive).toBeNull()
    expect((await findBundledNodeArchive(null, NODE_RUNTIME_VERSION, 'x64')).archive).toBeNull()
  })
})

describe('ensureNodeRuntime 的五档顺序', () => {
  it('第一档：显式钉版本时用该版本的托管安装，不看本机也不解归档', async () => {
    const fixtureData = await fixture()
    const pinned = managedNodeVersionRoot(fixtureData.runtimeRoot, 'v22.19.0')
    await createCompleteNode(pinned)

    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, 'v22.19.0', undefined, {
      archiveRoot: fixtureData.archiveRoot,
      environment: withSystemNode(fixtureData),
      probeVersion: probe(fixtureData.systemBin, '24.19.0'),
    })

    expect(runtime.root).toBe(pinned)
    expect(runtime.origin).toBe('managed')
  })

  it('第二档：本机 Node 达标就什么都不做——绝不解压', async () => {
    const fixtureData = await fixture()

    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, null, undefined, {
      archiveRoot: fixtureData.archiveRoot,
      pnpmRuntimeRoot: fixtureData.pnpmRuntimeRoot,
      environment: withSystemNode(fixtureData),
      probeVersion: probe(fixtureData.systemBin, '24.19.0'),
    })

    expect(runtime.root).toBe(fixtureData.systemBin)
    expect(runtime.origin).toBe('system')
    // 「有就不补」的硬证据：userData 里连 versions/ 都没被创建。
    expect(await readdir(path.join(fixtureData.runtimeRoot, 'versions')).catch(() => null)).toBeNull()
  })

  it('第三档：已有完整托管运行时就直接复用，不解压', async () => {
    const fixtureData = await fixture()
    const existing = managedNodeVersionRoot(fixtureData.runtimeRoot, NODE_RUNTIME_VERSION)
    await createCompleteNode(existing)

    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, null, undefined, {
      archiveRoot: fixtureData.archiveRoot,
      pnpmRuntimeRoot: fixtureData.pnpmRuntimeRoot,
      environment: noSystemNode(fixtureData.root),
      probeVersion: probe(fixtureData.systemBin, null),
    })

    expect(runtime.root).toBe(existing)
    expect(runtime.origin).toBe('managed')
    expect(await listStaging(fixtureData.runtimeRoot)).toEqual([])
    // 复用路径连 pnpm 都不该铺。
    expect(await readdir(fixtureData.pnpmRuntimeRoot).catch(() => null)).toBeNull()
  })

  it('第三档：托管运行时缺 npm 时不算完整，继续往归档走', async () => {
    const fixtureData = await fixture()
    const broken = managedNodeVersionRoot(fixtureData.runtimeRoot, NODE_RUNTIME_VERSION)
    await createExecutables(path.join(broken, DISTRIBUTION_BIN))

    const calls: Array<{ root: string; version: string }> = []
    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, null, undefined, {
      // 归档也拿掉，只留下载：这条用例验证「缺 npm 的受托运行时」不会挡在第 3 档。
      archiveRoot: path.join(fixtureData.root, 'no-archive'),
      environment: noSystemNode(fixtureData.root),
      probeVersion: probe(fixtureData.systemBin, null),
      installRuntime: stubInstall(calls),
    })

    expect(calls).toHaveLength(1)
    expect(runtime.origin).toBe('managed')
  })

  WINDOWS_ONLY('第四档：既没本机 Node 也没有托管运行时 → 从归档解压出完整运行时', async () => {
    const fixtureData = await fixture()

    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, null, undefined, {
      archiveRoot: fixtureData.archiveRoot,
      pnpmRuntimeRoot: fixtureData.pnpmRuntimeRoot,
      environment: noSystemNode(fixtureData.root),
      probeVersion: probe(fixtureData.systemBin, null),
      installRuntime: async () => {
        throw new Error('不该走到联网下载')
      },
    })

    const expectedRoot = managedNodeVersionRoot(fixtureData.runtimeRoot, NODE_RUNTIME_VERSION)
    expect(runtime.root).toBe(expectedRoot)
    expect(runtime.origin).toBe('bundled')
    // 解出来的运行时必须是「能装 pnpm」的那种完整形态。
    expect(await readdir(path.join(expectedRoot, 'node_modules', 'npm')).catch(() => null)).not.toBeNull()
    // pnpm 也顺带铺开了：首启不必再联网。
    expect(await readdir(path.join(fixtureData.pnpmRuntimeRoot, 'node_modules', 'pnpm')).catch(() => null)).not.toBeNull()
    expect(await readdir(path.join(path.dirname(pnpmExecutable(fixtureData.pnpmRuntimeRoot)))).catch(() => [])).toContain(
      path.basename(pnpmExecutable(fixtureData.pnpmRuntimeRoot)),
    )
    // 临时目录必须清干净，不能留 .node-archive-* 给下一次误导。
    expect(await listStaging(fixtureData.runtimeRoot)).toEqual([])
  })

  WINDOWS_ONLY('第四档：归档损坏时不报错、不留半成品，回落到联网下载', async () => {
    const fixtureData = await fixture()
    const archiveName = bundledNodeArchiveName(NODE_RUNTIME_VERSION)
    // 把 zip 截断成 64 字节：文件在、名字对、内容读不出来。
    await writeFile(path.join(fixtureData.archiveRoot, archiveName), Buffer.alloc(64), { flag: 'w' })

    const calls: Array<{ root: string; version: string }> = []
    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, null, undefined, {
      archiveRoot: fixtureData.archiveRoot,
      pnpmRuntimeRoot: fixtureData.pnpmRuntimeRoot,
      environment: noSystemNode(fixtureData.root),
      probeVersion: probe(fixtureData.systemBin, null),
      installRuntime: stubInstall(calls),
    })

    expect(calls).toHaveLength(1)
    expect(runtime.origin).toBe('managed')
    expect(await listStaging(fixtureData.runtimeRoot)).toEqual([])
  })

  it('第五档：没有归档目录时照旧联网下载，不报错', async () => {
    const fixtureData = await fixture()
    const calls: Array<{ root: string; version: string }> = []

    const runtime = await ensureNodeRuntime(fixtureData.runtimeRoot, undefined, null, undefined, {
      archiveRoot: path.join(fixtureData.root, 'absent'),
      environment: noSystemNode(fixtureData.root),
      probeVersion: probe(fixtureData.systemBin, null),
      installRuntime: stubInstall(calls),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.version).toBe(NODE_RUNTIME_VERSION)
    expect(runtime.origin).toBe('managed')
  })
})
