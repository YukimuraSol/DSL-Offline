import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSubdirectoryPlugin, type PluginSourceProgress } from '../electron/plugin-source'
import type { PluginInstallTarget } from '../src/types'

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('plugin source download progress', () => {
  it('reports downloaded bytes when GitHub omits the total size', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-source-'))
    const commit = 'a'.repeat(40)
    const zip = new AdmZip()
    zip.addFile('repository-main/packages/example/package.json', Buffer.from(JSON.stringify({ name: 'example' })))
    const archive = zip.toBuffer()
    const progress: PluginSourceProgress[] = []
    const target: PluginInstallTarget = {
      id: 'example:packages/example',
      packageName: 'example',
      version: '1.0.0',
      source: 'archive-subdirectory',
      profileName: 'web',
      platform: 'unknown',
      subdirectory: 'packages/example',
      commit,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
    }

    const packageDirectory = await prepareSubdirectoryPlugin(
      temporaryDirectory,
      'owner/repository',
      target,
      update => progress.push(update),
      async () => new Response(new Uint8Array(archive)),
    )

    expect(JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))).toEqual({ name: 'example' })
    expect(progress).toContainEqual(expect.objectContaining({
      percent: 20,
      indeterminate: true,
      downloadedBytes: archive.byteLength,
    }))
    expect(progress.some(update => update.totalBytes != null)).toBe(false)
  })
})
