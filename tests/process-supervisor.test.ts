import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureProcessTracker, spawnCommand } from '../electron/process'
import { createProcessSupervisor, type ProcessSupervisor } from '../electron/process-supervisor'

let temporaryDirectory = ''
let supervisor: ProcessSupervisor | null = null

async function waitForPidExit(pid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`进程 ${pid} 在超时时间内仍未退出。`)
}

afterEach(async () => {
  configureProcessTracker(null)
  await supervisor?.shutdown()
  supervisor = null
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('process supervisor', () => {
  it('ends a tracked long-running process during launcher shutdown', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-process-supervisor-'))
    const workingDirectory = path.join(temporaryDirectory, 'working')
    await mkdir(workingDirectory)
    supervisor = await createProcessSupervisor({
      root: path.join(temporaryDirectory, 'supervisor'),
      executable: process.execPath,
    })
    configureProcessTracker(supervisor)

    const child = spawnCommand(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      cwd: workingDirectory,
      env: process.env,
    })
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.on('data', chunk => {
        if (chunk.toString('utf8').includes('ready')) resolve()
      })
    })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => resolve())
    })
    await ready

    await supervisor.shutdown()
    await exited

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('ends a detached descendant created by a tracked process', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-process-supervisor-descendant-'))
    supervisor = await createProcessSupervisor({
      root: path.join(temporaryDirectory, 'supervisor'),
      executable: process.execPath,
    })
    configureProcessTracker(supervisor)

    const script = [
      'const { spawn } = require("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })',
      'process.stdout.write(String(child.pid) + "\\n")',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const parent = spawnCommand(process.execPath, ['-e', script], {
      cwd: temporaryDirectory,
      env: process.env,
    })
    const descendantPid = await new Promise<number>((resolve, reject) => {
      parent.once('error', reject)
      parent.stdout.on('data', chunk => {
        const pid = Number.parseInt(chunk.toString('utf8').trim(), 10)
        if (Number.isSafeInteger(pid) && pid > 0) resolve(pid)
      })
    })
    const parentExited = new Promise<void>((resolve, reject) => {
      parent.once('error', reject)
      parent.once('exit', () => resolve())
    })

    await supervisor.shutdown()
    await parentExited
    await waitForPidExit(descendantPid)
  }, 30_000)
})
