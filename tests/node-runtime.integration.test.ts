import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ensureNodeRuntime, ensurePnpmRuntime, NODE_RUNTIME_VERSION, PNPM_VERSION } from '../electron/node-runtime'
import { spawnCommand } from '../electron/process'

const execFileAsync = promisify(execFile)
const integrationTest = process.env.DSH_TEST_NODE_RUNTIME === '1' ? it : it.skip

async function runBatch(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const child = spawnCommand(executable, args, { cwd, env: environment })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw new Error(stderr || `${path.basename(executable)} exited with ${exitCode}`)
  return stdout.trim()
}

integrationTest('downloads and runs the official portable Node.js runtime without system Node', async () => {
  const temporaryDirectory = path.join(os.tmpdir(), 'dsh-node-runtime-integration')
  await mkdir(temporaryDirectory, { recursive: true })
  const originalPath = process.env.PATH
  const originalProgramFiles = process.env.ProgramFiles
  const progress: number[] = []
  try {
    process.env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    process.env.ProgramFiles = path.join(temporaryDirectory, 'missing-program-files')
    const runtime = await ensureNodeRuntime(temporaryDirectory, update => progress.push(update.percent))
    const result = await execFileAsync(runtime.node, ['--version'], { windowsHide: true })
    const runtimeEnvironment = { ...process.env, PATH: `${path.dirname(runtime.node)}${path.delimiter}${process.env.PATH}` }
    const npmVersion = await runBatch(runtime.npm, ['--version'], temporaryDirectory, runtimeEnvironment)
    const npxVersion = await runBatch(runtime.npx, ['--version'], temporaryDirectory, runtimeEnvironment)
    const pnpmRuntime = await ensurePnpmRuntime(path.join(temporaryDirectory, 'pnpm-runtime'), runtime)
    const pnpmVersion = await runBatch(pnpmRuntime.executable, ['--version'], temporaryDirectory, runtimeEnvironment)
    expect(runtime.managed).toBe(true)
    expect(result.stdout.trim()).toBe(NODE_RUNTIME_VERSION)
    expect(npmVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(npxVersion).toBe(npmVersion)
    expect(pnpmVersion).toBe(PNPM_VERSION)
    expect(progress.at(-1)).toBe(100)
  } finally {
    process.env.PATH = originalPath
    process.env.ProgramFiles = originalProgramFiles
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}, 300_000)
