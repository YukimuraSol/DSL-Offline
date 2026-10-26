import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ACP_PROTOCOL_VERSION, createAcpClient, type AcpPermissionRequest } from '../electron/acp-client'
import {
  ACP_DEFAULT_MODEL,
  ACP_DEFAULT_PROVIDER,
  acpEnvironment,
  buildAcpServerCommand,
  createSpawnAcpTransport,
  prepareAcpRuntime,
  renderAcpComposition,
} from '../electron/ai-install'
import { ensureNodeRuntime } from '../electron/node-runtime'
import { spawnCommand } from '../electron/process'

/**
 * 真实 ACP 冒烟：装 ACP 运行时 → spawn dsh-acp-demo → initialize/session/new 握手
 * → 一条只读 prompt。只要在超时内收到 session/update 或 request_permission 之一
 * 即认为 agent 存活并成功握手，随后 cancel + 杀进程树 + 删临时目录。
 *
 * env 门控：仅当 DSH_TEST_ACP === '1' 时运行；且需要 DEEPSEEK_API_KEY。
 */
const integrationTest = process.env.DSH_TEST_ACP === '1' ? it : it.skip

integrationTest('prepares the ACP runtime, handshakes, observes a live read-only turn, then cleans up', async () => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DSH_TEST_ACP 需要 DEEPSEEK_API_KEY 环境变量。')

  const root = path.join(os.tmpdir(), 'dsh-ai-install-integration')
  await mkdir(root, { recursive: true })
  const nodeRuntime = await ensureNodeRuntime(path.join(root, 'node-runtime'))
  await prepareAcpRuntime(path.join(root, 'acp-runtime'), nodeRuntime, text => console.log(`[acp-install] ${text}`))

  const taskDir = await mkdtemp(path.join(root, 'ai-task-'))
  const configPath = path.join(taskDir, 'cordis.yml')
  await writeFile(configPath, renderAcpComposition({
    provider: ACP_DEFAULT_PROVIDER,
    model: ACP_DEFAULT_MODEL,
    persistenceRoot: path.join(taskDir, 'sessions'),
    workspaceRoot: root,
    platform: process.platform,
  }))

  const { executable, args } = buildAcpServerCommand(path.join(root, 'acp-runtime'), configPath)
  const child = spawnCommand(executable, args, { cwd: taskDir, env: acpEnvironment(root, apiKey) })

  let receivedUpdate = false
  let receivedPermission = false
  const stderr: string[] = []
  const acp = createAcpClient({
    transport: createSpawnAcpTransport(child, text => stderr.push(text)),
    clientInfo: { name: 'dsh-melody-launcher-integration', version: '0.1.4' },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      receivedPermission = true
      void request
      // 冒烟测试一律拒绝，fails closed。
      return false
    },
    onSessionUpdate: update => {
      if (update.text) receivedUpdate = true
    },
  })

  try {
    const init = await acp.initialize()
    expect(init.protocolVersion).toBe(ACP_PROTOCOL_VERSION)

    const sessionId = await acp.sessionNew(root)
    expect(sessionId.length).toBeGreaterThan(0)

    // 只读 prompt：只要求列出文件，不执行任何写操作。
    let promptSettled = false
    const promptPromise = acp.prompt(sessionId, '只读：请用只读命令列出当前工作目录下的文件，不要修改任何文件。')
      .finally(() => { promptSettled = true })

    // 120 秒内轮询，等 agent 活动证据（update / permission）或 turn 自然结束。
    const deadline = Date.now() + 120_000
    let signal: 'update' | 'permission' | 'ended' | 'timeout' = 'timeout'
    while (Date.now() < deadline) {
      if (receivedUpdate) { signal = 'update'; break }
      if (receivedPermission) { signal = 'permission'; break }
      if (promptSettled) { signal = 'ended'; break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(signal).not.toBe('timeout')

    // 若 turn 还在跑，主动取消并确认以 cancelled 结束。
    if (signal === 'update' || signal === 'permission') {
      await acp.cancel(sessionId)
      const stopReason = await promptPromise.catch(() => 'cancelled')
      expect(stopReason).toBe('cancelled')
    }

    // 冒烟至少观察到 agent 存活（文本更新或工具审批请求）。
    expect(receivedUpdate || receivedPermission).toBe(true)
  } finally {
    acp.close()
    await killProcessTree(child)
    await rm(root, { recursive: true, force: true }).catch(() => { /* 残留文件可忽略 */ })
  }
}, 300_000)

/** 与主进程 ai-install.ts 相同的进程树清理：Windows taskkill /t /f，其余 SIGTERM。 */
async function killProcessTree(child: ReturnType<typeof spawnCommand>): Promise<void> {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    await new Promise<void>(resolve => {
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
  } else {
    child.kill('SIGTERM')
  }
}
