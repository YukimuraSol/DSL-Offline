import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PackManifest } from '../src/types'
import { buildPackExport, collectPackBodies } from '../electron/pack-export'
import { buildPackZip, inspectPackZip } from '../electron/pack-zip'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-'))
  temporaryRoots.push(root)
  return root
}

async function makeProfile(): Promise<string> {
  const root = await temporaryDirectory()
  const profileDir = path.join(root, 'profile')
  const alphaDir = path.join(profileDir, 'node_modules', 'alpha')
  const betaDir = path.join(profileDir, 'node_modules', '@scope', 'beta')
  await mkdir(alphaDir, { recursive: true })
  await mkdir(betaDir, { recursive: true })
  await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))
  await writeFile(path.join(betaDir, 'package.json'), JSON.stringify({ name: '@scope/beta' }))
  // gamma 故意缺失
  return profileDir
}

describe('collectPackBodies', () => {
  it('定位 scoped 与非 scoped 包目录，缺失项记入 missing', async () => {
    const profileDir = await makeProfile()
    const result = await collectPackBodies(profileDir, ['alpha', '@scope/beta', 'gamma'])
    expect([...result.bodies.keys()]).toEqual(['alpha', '@scope/beta'])
    expect(result.bodies.get('alpha')).toBe(path.join(profileDir, 'node_modules', 'alpha'))
    expect(result.bodies.get('@scope/beta')).toBe(path.join(profileDir, 'node_modules', '@scope', 'beta'))
    expect(result.missing).toEqual(['gamma'])
  })
})

describe('buildPackZip / buildPackExport', () => {
  const manifest: PackManifest = {
    name: 'Exported',
    description: 'exported pack',
    version: '1.0.0',
    plugins: [
      { packageName: 'alpha', source: 'npm' },
      { packageName: '@scope/beta', source: 'npm' },
    ],
  }

  it('collectPackBodies 的产物可被 buildPackZip 打包并 round-trip 读回', async () => {
    const profileDir = await makeProfile()
    const { bodies, missing } = await collectPackBodies(profileDir, ['alpha', '@scope/beta', 'gamma'])
    expect(missing).toEqual(['gamma'])
    const inspection = inspectPackZip(buildPackZip(manifest, bodies))
    expect(inspection.manifest).toEqual(manifest)
    expect(inspection.hasBodies).toBe(true)
    expect([...inspection.bodyPackageNames].sort()).toEqual(['@scope/beta', 'alpha'])
  })

  it('buildPackExport 组合收集与打包，返回 zip 与缺失列表', async () => {
    const profileDir = await makeProfile()
    const { zip, missing } = await buildPackExport(profileDir, manifest, ['alpha', '@scope/beta', 'gamma'])
    expect(missing).toEqual(['gamma'])
    const inspection = inspectPackZip(zip)
    expect(inspection.manifest).toEqual(manifest)
    expect(inspection.hasBodies).toBe(true)
    expect([...inspection.bodyPackageNames].sort()).toEqual(['@scope/beta', 'alpha'])
  })

  it('全部缺失时打包为 manifest-only 包', async () => {
    const profileDir = await makeProfile()
    const { zip, missing } = await buildPackExport(profileDir, manifest, ['missing-a', 'missing-b'])
    expect(missing).toEqual(['missing-a', 'missing-b'])
    const inspection = inspectPackZip(zip)
    expect(inspection.hasBodies).toBe(false)
    expect(inspection.bodyPackageNames).toEqual([])
    expect(inspection.manifest).toEqual(manifest)
  })
})
