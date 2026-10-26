import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApplicationAddonManager } from '../electron/application-addons'
import { APPLICATION_MANIFEST_PATH } from '../electron/application-catalog'
import type { CommandOptions } from '../electron/command'
import type { NodeRuntime, PnpmRuntime } from '../electron/node-runtime'
import type { AppSettings, InstalledApplicationAddon } from '../src/types'

let temporaryDirectory = ''
let registryPath = ''
let installRoot = ''
let settings: AppSettings
let nodeRuntime: NodeRuntime
let pnpmRuntime: PnpmRuntime
const applicationRepository = 'demo/desktop-host'

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-application-addons-'))
  registryPath = path.join(temporaryDirectory, 'application-addons.json')
  installRoot = path.join(temporaryDirectory, 'application-addons')
  settings = {
    dshInstallPath: path.join(temporaryDirectory, 'dsh-runtime'),
    dshHome: path.join(temporaryDirectory, '.dsh'),
    profileName: 'web',
    workspace: temporaryDirectory,
    launchExecutable: 'dsh.cmd',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: true,
  }
  nodeRuntime = {
    root: path.join(temporaryDirectory, 'node'),
    node: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
  pnpmRuntime = {
    root: path.join(temporaryDirectory, 'pnpm'),
    executable: path.join(temporaryDirectory, 'pnpm', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
  }
})

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
})

function manager(options: {
  githubFetch?: typeof fetch
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<{ exitCode: number; output: string }>
  running?: boolean
} = {}) {
  return createApplicationAddonManager({
    registryPath,
    installRoot,
    readSettings: async () => settings,
    prepareNodeRuntime: async () => nodeRuntime,
    preparePnpmRuntime: async () => pnpmRuntime,
    emitOutput: () => {},
    emitProgress: () => {},
    isRuntimeRunning: () => options.running ?? false,
    githubFetch: options.githubFetch,
    runCommand: options.runCommand,
  })
}

async function writePackageAt(packageRoot: string, packageName: string, bin: string): Promise<void> {
  await mkdir(path.dirname(path.join(packageRoot, bin)), { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '2.0.0',
    bin: { [packageName]: bin },
  }), 'utf8')
  await writeFile(path.join(packageRoot, bin), 'console.log("started")\n', 'utf8')
}

function applicationFetch(): typeof fetch {
  const commit = 'c'.repeat(40)
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: commit }), { status: 200 })
    if (url.includes(`/${commit}/${APPLICATION_MANIFEST_PATH}`)) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        id: 'demo-host',
        name: 'Demo Host',
        type: 'application',
        launchMode: 'runtime-replacement',
        install: { provider: 'npm', package: 'demo-host' },
        launch: { bin: 'demo-host' },
      }), { status: 200 })
    }
    if (url === 'https://registry.npmjs.org/demo-host/latest') {
      return new Response(JSON.stringify({
        name: 'demo-host',
        version: '2.0.0',
        repository: `https://github.com/${applicationRepository}`,
        bin: { 'demo-host': 'dist/main.js' },
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

function installedAddon(id: string, launchMode: InstalledApplicationAddon['launchMode'], enabled: boolean): InstalledApplicationAddon {
  const installPath = path.join(installRoot, id)
  return {
    id,
    name: id,
    description: `${id} addon`,
    repository: `demo/${id}`,
    provider: 'npm',
    packageName: id,
    version: '1.0.0',
    binName: id,
    entryPath: path.join(installPath, 'runtime', 'index.js'),
    installPath,
    launchMode,
    launchArgs: [],
    enabled,
    verified: true,
    provides: [],
    installedAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }
}

describe('application addon manager', () => {
  it('installs a generic application addon in isolation and returns a replacement launch plan', async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    const addons = manager({
      githubFetch: applicationFetch(),
      runCommand: async (executable, args) => {
        calls.push({ executable, args })
        const runtimePath = args[1]
        const packageRoot = path.join(
          runtimePath,
          'node_modules',
          '.pnpm',
          'demo-host@2.0.0',
          'node_modules',
          'demo-host',
        )
        await writePackageAt(packageRoot, 'demo-host', 'dist/main.js')
        const linkedPackage = path.join(runtimePath, 'node_modules', 'demo-host')
        await symlink(packageRoot, linkedPackage, process.platform === 'win32' ? 'junction' : 'dir')
        return { exitCode: 0, output: '' }
      },
    })

    const result = await addons.install({
      repository: applicationRepository,
      defaultBranch: 'main',
      targetId: 'demo-host:.',
    })

    expect(calls[0].args).toContain('--ignore-scripts')
    expect(calls[0].args).toContain('demo-host@2.0.0')
    expect(result.installedAddon).toMatchObject({
      id: 'demo-host',
      launchMode: 'runtime-replacement',
      enabled: true,
      version: '2.0.0',
    })
    expect(existsSync(result.installedAddon.entryPath)).toBe(true)
    expect(result.installedAddon.entryPath).toBe(await realpath(result.installedAddon.entryPath))
    expect(result.installedAddon.entryPath).toContain(`${path.sep}.pnpm${path.sep}`)
    expect((await addons.list())).toHaveLength(1)
    await expect(addons.launchPlan()).resolves.toMatchObject({
      replacement: {
        id: 'demo-host',
        executable: nodeRuntime.node,
        args: [result.installedAddon.entryPath],
      },
      companions: [],
    })
  })

  it('allows only one replacement host to be active', async () => {
    const first = installedAddon('first-host', 'runtime-replacement', true)
    const second = installedAddon('second-host', 'runtime-replacement', false)
    await mkdir(path.dirname(registryPath), { recursive: true })
    await writeFile(registryPath, JSON.stringify({ version: 1, addons: [first, second] }), 'utf8')

    const next = await manager().toggle('second-host', true)
    expect(next.find(item => item.id === 'first-host')?.enabled).toBe(false)
    expect(next.find(item => item.id === 'second-host')?.enabled).toBe(true)
  })

  it('rejects npm bin entries that escape the installed package directory', async () => {
    const commit = 'b'.repeat(40)
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: commit }), { status: 200 })
      if (url.includes(`/${commit}/${APPLICATION_MANIFEST_PATH}`)) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          id: 'demo-host',
          name: 'Demo Host',
          type: 'application',
          launchMode: 'standalone',
          install: { provider: 'npm', package: 'demo-host', version: '1.0.0' },
          launch: { bin: 'demo-host' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const addons = manager({
      githubFetch: fetchImpl,
      runCommand: async (_executable, args) => {
        const runtimePath = args[1]
        const packageRoot = path.join(runtimePath, 'node_modules', 'demo-host')
        await mkdir(packageRoot, { recursive: true })
        await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
          name: 'demo-host',
          version: '1.0.0',
          bin: { 'demo-host': '../escape.js' },
        }), 'utf8')
        await writeFile(path.join(runtimePath, 'node_modules', 'escape.js'), 'unsafe\n', 'utf8')
        return { exitCode: 0, output: '' }
      },
    })

    await expect(addons.install({
      repository: 'demo/dsh-host',
      defaultBranch: 'main',
      targetId: 'demo-host:.',
    })).rejects.toThrow(/越过了包目录/)
    expect(await addons.list()).toEqual([])
  })

  it('never deletes a registry path outside the managed install root', async () => {
    const external = path.join(temporaryDirectory, 'keep-me')
    await mkdir(external, { recursive: true })
    await writeFile(path.join(external, 'important.txt'), 'keep', 'utf8')
    const unsafe = { ...installedAddon('external-host', 'standalone', false), installPath: external }
    await writeFile(registryPath, JSON.stringify({ version: 1, addons: [unsafe] }), 'utf8')

    const next = await manager().uninstall('external-host')
    expect(next).toEqual([])
    expect(await readFile(path.join(external, 'important.txt'), 'utf8')).toBe('keep')
  })

  it('blocks state changes while the DSH runtime is active', async () => {
    await expect(manager({ running: true }).install({
      repository: applicationRepository,
      defaultBranch: 'main',
      targetId: 'demo-host:.',
    })).rejects.toThrow(/请先停止 DSH/)
  })
})
