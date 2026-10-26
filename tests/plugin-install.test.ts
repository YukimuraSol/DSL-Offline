import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { approveBuildKeys, approveIgnoredGitHubBuilds, denyBuildKeys, ignoredBuildKeys } from '../electron/plugin-install'

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('plugin build approval', () => {
  it('approves only the ignored build key from the repository being installed', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-builds-'))
    const workspacePath = path.join(temporaryDirectory, 'pnpm-workspace.yaml')
    const matchingKey = '@deepseek-ai/dsh-root@https://codeload.github.com/anywhere-labs/deepseek-harness-desktop/tar.gz/abc123'
    const otherKey = 'other-plugin@https://codeload.github.com/another-owner/other-plugin/tar.gz/def456'
    await writeFile(workspacePath, `packages:\n  - .\nallowBuilds:\n  '${matchingKey}': set this to true or false\n  '${otherKey}': false\n`, 'utf8')

    const approved = await approveIgnoredGitHubBuilds(
      workspacePath,
      `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ${matchingKey}, ${otherKey}\n`,
      'anywhere-labs/deepseek-harness-desktop',
    )
    const workspace = parse(await readFile(workspacePath, 'utf8'))

    expect(approved).toEqual([matchingKey])
    expect(workspace.allowBuilds[matchingKey]).toBe(true)
    expect(workspace.allowBuilds[otherKey]).toBe(false)
  })

  it('does not modify the workspace when the ignored build belongs to another repository', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-builds-'))
    const workspacePath = path.join(temporaryDirectory, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, 'packages:\n  - .\n', 'utf8')
    const before = await readFile(workspacePath, 'utf8')

    const approved = await approveIgnoredGitHubBuilds(
      workspacePath,
      '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: plugin@https://codeload.github.com/owner/repository/tar.gz/abc123\n',
      'different/repository',
    )

    expect(approved).toEqual([])
    expect(await readFile(workspacePath, 'utf8')).toBe(before)
  })

  it('extracts registry and GitHub build keys and approves only the selected entries', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-builds-'))
    const workspacePath = path.join(temporaryDirectory, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, 'packages:\n  - .\n', 'utf8')
    const githubKey = 'plugin@https://codeload.github.com/owner/plugin/tar.gz/abc123'
    const registryKey = 'node-pty@1.1.0'
    const output = `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ${githubKey}, ${registryKey}\n`

    expect(ignoredBuildKeys(output)).toEqual([githubKey, registryKey])
    await approveBuildKeys(workspacePath, [registryKey])

    const workspace = parse(await readFile(workspacePath, 'utf8'))
    expect(workspace.allowBuilds).toEqual({ [registryKey]: true })
  })

  it('records exact optional native builds as explicitly denied', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-builds-'))
    const workspacePath = path.join(temporaryDirectory, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, 'packages:\n  - .\n', 'utf8')
    await denyBuildKeys(workspacePath, ['cpu-features@0.0.10', 'ssh2@1.17.0'])
    expect(parse(await readFile(workspacePath, 'utf8')).allowBuilds).toEqual({
      'cpu-features@0.0.10': false,
      'ssh2@1.17.0': false,
    })
  })
})
