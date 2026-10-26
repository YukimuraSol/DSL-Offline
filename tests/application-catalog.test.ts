import { describe, expect, it, vi } from 'vitest'
import {
  APPLICATION_MANIFEST_PATH,
  analyzeApplicationRepository,
  applicationTargetFromManifest,
} from '../electron/application-catalog'

const commit = 'a'.repeat(40)

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function repositoryFetch(options: {
  repository: string
  addonManifest?: unknown | null
  tree?: Array<{ path: string; type: 'blob' | 'tree' }>
  packages?: Record<string, unknown>
  published?: Record<string, unknown>
}): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes(`/repos/${options.repository}/commits/`)) return response({ sha: commit })
    if (url.includes(`/${commit}/${APPLICATION_MANIFEST_PATH}`)) {
      return options.addonManifest == null
        ? response({ message: 'not found' }, 404)
        : response(options.addonManifest)
    }
    if (url.includes(`/repos/${options.repository}/git/trees/${commit}`)) {
      return response({ tree: options.tree ?? [] })
    }
    for (const [packagePath, manifest] of Object.entries(options.packages ?? {})) {
      if (url.endsWith(`/${commit}/${packagePath}`)) return response(manifest)
    }
    for (const [packageName, manifest] of Object.entries(options.published ?? {})) {
      if (url === `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`) return response(manifest)
    }
    return response({ message: 'not found' }, 404)
  }) as typeof fetch
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'demo-host',
    name: 'Demo Host',
    description: 'A managed DSH host.',
    type: 'application',
    launchMode: 'after-runtime',
    install: { provider: 'npm', package: '@demo/dsh-host', version: '1.2.3' },
    launch: { bin: 'dsh-host', args: ['--quiet'] },
    platforms: ['win32', 'darwin', 'linux'],
    provides: ['demoRuntime'],
    ...overrides,
  }
}

function inferredHostPackage(repository: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo-electron-host',
    version: '2.4.1',
    description: 'A generic DSH Electron host.',
    repository: `https://github.com/${repository}.git`,
    bin: { 'demo-electron-host': 'lib/bin.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { electron: '^43.0.0' },
    build: {
      appId: 'dev.demo.dsh-host',
      productName: 'Demo Desktop',
      win: {},
      linux: {},
    },
    ...overrides,
  }
}

describe('application addon catalog', () => {
  it('loads and validates an explicit generic addon manifest', async () => {
    const analysis = await analyzeApplicationRepository(
      'demo/dsh-host',
      'main',
      repositoryFetch({ repository: 'demo/dsh-host', addonManifest: manifest() }),
      'win32',
    )

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets[0]).toMatchObject({
      addonId: 'demo-host',
      packageName: '@demo/dsh-host',
      version: '1.2.3',
      launchMode: 'after-runtime',
      launchArgs: ['--quiet'],
      supported: true,
      verified: true,
    })
  })

  it('resolves a missing explicit version to the exact npm latest version', async () => {
    const repository = 'demo/dsh-host'
    const analysis = await analyzeApplicationRepository(
      repository,
      'main',
      repositoryFetch({
        repository,
        addonManifest: manifest({
          install: { provider: 'npm', package: '@demo/dsh-host' },
        }),
        published: {
          '@demo/dsh-host': {
            name: '@demo/dsh-host',
            version: '3.1.4',
            repository: `https://github.com/${repository}`,
            bin: { 'dsh-host': 'lib/bin.js' },
          },
        },
      }),
    )

    expect(analysis.targets[0].version).toBe('3.1.4')
  })

  it('infers a generic DSH Electron host and pins its published npm version', async () => {
    const repository = 'demo/desktop-workspace'
    const packagePath = 'packages/desktop/package.json'
    const packageManifest = inferredHostPackage(repository, { version: '2.5.0-next' })
    const analysis = await analyzeApplicationRepository(
      repository,
      'main',
      repositoryFetch({
        repository,
        addonManifest: null,
        tree: [
          { path: packagePath, type: 'blob' },
          { path: 'packages/desktop/cordis.patch.yml', type: 'blob' },
          { path: 'packages/desktop/tests/fixtures/package.json', type: 'blob' },
        ],
        packages: { [packagePath]: packageManifest },
        published: { 'demo-electron-host': inferredHostPackage(repository) },
      }),
      'win32',
    )

    expect(analysis.installability).toBe('ready')
    expect(analysis.targets).toHaveLength(1)
    expect(analysis.targets[0]).toMatchObject({
      id: 'demo-electron-host:packages/desktop',
      addonId: 'demo-electron-host',
      name: 'Demo Desktop',
      packageName: 'demo-electron-host',
      version: '2.4.1',
      binName: 'demo-electron-host',
      launchMode: 'runtime-replacement',
      supported: true,
      verified: false,
    })
  })

  it('does not infer a normal DSH Plugin or an unrelated npm package as an application', async () => {
    const repository = 'demo/plugin-only'
    const packagePath = 'package.json'
    const source = inferredHostPackage(repository, { peerDependencies: {}, build: {} })
    const analysis = await analyzeApplicationRepository(
      repository,
      'main',
      repositoryFetch({
        repository,
        addonManifest: null,
        tree: [
          { path: packagePath, type: 'blob' },
          { path: 'cordis.patch.yml', type: 'blob' },
        ],
        packages: { [packagePath]: source },
        published: { 'demo-electron-host': inferredHostPackage('someone/else') },
      }),
    )

    expect(analysis.installability).toBe('invalid')
    expect(analysis.targets).toEqual([])
  })

  it('keeps platform incompatibility distinct from an invalid manifest', () => {
    const target = applicationTargetFromManifest(
      'demo/windows-host',
      manifest({ platforms: ['win32'] }),
      'linux',
    )
    expect(target.supported).toBe(false)
    expect(() => applicationTargetFromManifest(
      'demo/unsafe-host',
      manifest({ launch: { bin: '../escape' } }),
      'win32',
    )).toThrow(/启动入口无效/)
  })
})
