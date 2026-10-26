import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import type { PackManifest } from '../src/types'
import {
  buildPackZip,
  buildPackZipToFile,
  extractPackBodies,
  extractPackBodiesFromPath,
  findManifestInArchive,
  findManifestInArchiveFromPath,
  inspectPackZip,
  inspectPackZipFromPath,
} from '../electron/pack-zip'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-'))
  temporaryRoots.push(root)
  return root
}

const manifestYaml = `
name: Round Trip
description: a round trip pack
version: 1.0.0
plugins:
  - packageName: alpha
    repository: demo/alpha
    source: github
`

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content))
  }
  return zip.toBuffer()
}

/**
 * 构造带任意 entryName 的 zip（store 方法，CRC=0）。
 * adm-zip 的 addFile 会归一化路径，无法用它造出 zip-slip 条目，这里手工拼字节保留原始名称。
 */
function rawZipWithEntries(entries: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  const centrals: Buffer[] = []
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14) // crc
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, dataBuf)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + dataBuf.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, ...centrals, end])
}

describe('inspectPackZip', () => {
  it('识别 manifest-only 包', () => {
    const inspection = inspectPackZip(makeZip({ 'dsh-pack.yaml': manifestYaml }))
    expect(inspection.manifest.name).toBe('Round Trip')
    expect(inspection.manifest.plugins[0].source).toBe('github')
    expect(inspection.hasBodies).toBe(false)
    expect(inspection.bodyPackageNames).toEqual([])
  })

  it('识别 plugin-bodies，兼容嵌套与编码两种 scoped 形态', () => {
    const zip = makeZip({
      'dsh-pack.yaml': manifestYaml,
      'plugin-bodies/alpha/package.json': JSON.stringify({ name: 'alpha' }),
      'plugin-bodies/@demo/beta/package.json': JSON.stringify({ name: '@demo/beta' }),
      'plugin-bodies/@demo-gamma/package.json': JSON.stringify({ name: '@demo/gamma' }),
    })
    const inspection = inspectPackZip(zip)
    expect(inspection.hasBodies).toBe(true)
    expect([...inspection.bodyPackageNames].sort()).toEqual(['@demo/beta', '@demo/gamma', 'alpha'])
  })

  it('按清单包名消歧嵌套 scoped：@my-scope/web-ui 解码为自身而非 @my/scope', () => {
    const scopedManifest = `
name: Scoped Nested
description: nested scoped pack
version: 1.0.0
plugins:
  - packageName: '@my-scope/web-ui'
    source: npm
`
    const zip = makeZip({
      'dsh-pack.yaml': scopedManifest,
      'plugin-bodies/@my-scope/web-ui/package.json': JSON.stringify({ name: '@my-scope/web-ui' }),
    })
    const inspection = inspectPackZip(zip)
    expect(inspection.bodyPackageNames).toEqual(['@my-scope/web-ui'])
  })

  it('剥离整体套一层顶层目录', () => {
    const zip = makeZip({
      'pack-name/dsh-pack.yaml': manifestYaml,
      'pack-name/plugin-bodies/alpha/package.json': JSON.stringify({ name: 'alpha' }),
    })
    const inspection = inspectPackZip(zip)
    expect(inspection.manifest.name).toBe('Round Trip')
    expect(inspection.hasBodies).toBe(true)
    expect(inspection.bodyPackageNames).toEqual(['alpha'])
  })

  it('缺少 dsh-pack.yaml 时抛错', () => {
    expect(() => inspectPackZip(makeZip({ 'README.md': '# hi' }))).toThrow('dsh-pack.yaml')
  })

  it('拒绝 zip-slip 路径', () => {
    const badPaths = [
      '../evil.txt',
      '/etc/passwd',
      '..\\evil.txt',
      'a//b.txt',
      'plugin-bodies/../evil',
      'plugin-bodies/./evil',
    ]
    for (const bad of badPaths) {
      const zip = rawZipWithEntries([
        { name: 'dsh-pack.yaml', content: manifestYaml },
        { name: bad, content: 'x' },
      ])
      expect(() => inspectPackZip(zip), `path: ${bad}`).toThrow('不安全路径')
    }
  })

  it('超过限额时抛错', () => {
    const zip = makeZip({
      'dsh-pack.yaml': manifestYaml,
      'plugin-bodies/alpha/package.json': JSON.stringify({ name: 'alpha' }),
    })
    expect(() => inspectPackZip(zip, { maxArchiveBytes: 1, maxFiles: 100_000, maxUnpackedBytes: 100_000_000 }))
      .toThrow('压缩包过大')
    expect(() => inspectPackZip(zip, { maxArchiveBytes: 1_000_000_000, maxFiles: 1, maxUnpackedBytes: 100_000_000 }))
      .toThrow('文件数量超过安全限制')
    expect(() => inspectPackZip(zip, { maxArchiveBytes: 1_000_000_000, maxFiles: 100_000, maxUnpackedBytes: 1 }))
      .toThrow('解压体积超过安全限制')
  })
})

describe('findManifestInArchive', () => {
  it('标准包返回清单文本', () => {
    const text = findManifestInArchive(makeZip({ 'dsh-pack.yaml': manifestYaml }))
    expect(text).toContain('name: Round Trip')
  })

  it('非标准包（无 dsh-pack.yaml）返回 null', () => {
    expect(findManifestInArchive(makeZip({ 'README.md': '# hi', 'app/package.json': '{"name":"app"}' }))).toBeNull()
  })

  it('剥离整体包裹层后仍能找到清单', () => {
    const text = findManifestInArchive(makeZip({
      'pack-name/dsh-pack.yaml': manifestYaml,
      'pack-name/plugin-bodies/alpha/package.json': '{"name":"alpha"}',
    }))
    expect(text).toContain('name: Round Trip')
  })

  it('宽松 probe 仍做全量路径校验：zip-slip 整体拒绝', () => {
    const zip = rawZipWithEntries([
      { name: 'dsh-pack.yaml', content: manifestYaml },
      { name: '../evil.txt', content: 'x' },
    ])
    expect(() => findManifestInArchive(zip)).toThrow('不安全路径')
  })
})

describe('extractPackBodies', () => {
  it('把 plugin-bodies 解到 workDir/<packageName>，兼容嵌套与编码 scoped', async () => {
    const workDir = await temporaryDirectory()
    const zip = makeZip({
      'dsh-pack.yaml': manifestYaml,
      'plugin-bodies/alpha/package.json': '{"name":"alpha"}',
      'plugin-bodies/@scope/beta/package.json': '{"name":"@scope/beta"}',
      'plugin-bodies/@scope-gamma/index.js': 'export {}',
    })
    const map = await extractPackBodies(zip, workDir)
    expect(map.get('alpha')).toBe(path.join(workDir, 'alpha'))
    expect(map.get('@scope/beta')).toBe(path.join(workDir, '@scope', 'beta'))
    expect(map.get('@scope/gamma')).toBe(path.join(workDir, '@scope', 'gamma'))
    expect(await readFile(path.join(workDir, 'alpha', 'package.json'), 'utf8')).toBe('{"name":"alpha"}')
    expect(await readFile(path.join(workDir, '@scope', 'beta', 'package.json'), 'utf8')).toBe('{"name":"@scope/beta"}')
    expect(await readFile(path.join(workDir, '@scope', 'gamma', 'index.js'), 'utf8')).toBe('export {}')
  })

  it('manifest-only 包解出为空 Map', async () => {
    const workDir = await temporaryDirectory()
    const map = await extractPackBodies(makeZip({ 'dsh-pack.yaml': manifestYaml }), workDir)
    expect(map.size).toBe(0)
  })
})

describe('buildPackZip', () => {
  it('manifest-only 打包可被 inspectPackZip 读回', () => {
    const manifest: PackManifest = {
      name: 'OnlyManifest',
      description: 'no bodies',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const inspection = inspectPackZip(buildPackZip(manifest, new Map()))
    expect(inspection.manifest).toEqual(manifest)
    expect(inspection.hasBodies).toBe(false)
    expect(inspection.bodyPackageNames).toEqual([])
  })

  it('打包含 plugin-bodies（含 scoped）后可被 inspectPackZip 读回', async () => {
    const root = await temporaryDirectory()
    const alphaDir = path.join(root, 'alpha')
    const betaDir = path.join(root, '@scope', 'beta')
    await mkdir(alphaDir, { recursive: true })
    await mkdir(betaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))
    await writeFile(path.join(betaDir, 'package.json'), JSON.stringify({ name: '@scope/beta' }))

    const manifest: PackManifest = {
      name: 'WithBodies',
      description: 'has bodies',
      version: '1.0.0',
      plugins: [
        { packageName: 'alpha', source: 'npm' },
        { packageName: '@scope/beta', source: 'npm' },
      ],
    }
    const bodyDirs = new Map<string, string>([
      ['alpha', alphaDir],
      ['@scope/beta', betaDir],
    ])
    const inspection = inspectPackZip(buildPackZip(manifest, bodyDirs))
    expect(inspection.manifest).toEqual(manifest)
    expect(inspection.hasBodies).toBe(true)
    expect([...inspection.bodyPackageNames].sort()).toEqual(['@scope/beta', 'alpha'])
  })
})

describe('streaming path API', () => {
  it('findManifestInArchiveFromPath / inspectPackZipFromPath / extractPackBodiesFromPath', async () => {
    const root = await temporaryDirectory()
    const alphaDir = path.join(root, 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))

    const manifest: PackManifest = {
      name: 'PathPack',
      description: 'path pack',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = path.join(root, 'pack.zip')
    await writeFile(zipPath, Buffer.from(buildPackZip(manifest, new Map([['alpha', alphaDir]]))))

    expect(await findManifestInArchiveFromPath(zipPath)).toContain('PathPack')
    const inspection = await inspectPackZipFromPath(zipPath)
    expect(inspection.manifest.name).toBe('PathPack')
    expect(inspection.hasBodies).toBe(true)
    expect(inspection.bodyPackageNames).toEqual(['alpha'])

    const extracted = await extractPackBodiesFromPath(zipPath, path.join(root, 'out'))
    expect(extracted.get('alpha')).toBe(path.join(root, 'out', 'alpha'))
    expect(await readFile(path.join(root, 'out', 'alpha', 'package.json'), 'utf8')).toContain('"alpha"')
  })

  it('buildPackZipToFile writes a valid zip readable by inspectPackZip', async () => {
    const root = await temporaryDirectory()
    const alphaDir = path.join(root, 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))

    const manifest: PackManifest = {
      name: 'StreamExport',
      description: 'stream export',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const outputPath = path.join(root, 'export.zip')
    await buildPackZipToFile(manifest, new Map([['alpha', alphaDir]]), outputPath)
    const inspection = inspectPackZip(await readFile(outputPath))
    expect(inspection.manifest.name).toBe('StreamExport')
    expect(inspection.hasBodies).toBe(true)
    expect(inspection.bodyPackageNames).toEqual(['alpha'])
  })
})
