import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createAiInstaller, type AiInstaller } from '../electron/ai-install'
import { ensureNodeRuntime, ensurePnpmRuntime } from '../electron/node-runtime'
import type { AiInstallEvent, AppSettings, RepositoryAnalysis } from '../src/types'

/**
 * 真实端到端：把真实存在的非标准仓库交给 createAiInstaller 完整跑一轮 ——
 * 真实 key、真实 ACP 运行时、真实 sandbox、快照 / 审批闸门 / 审计事件全走生产代码。
 *
 * 本轮目标（与首次 E2E 区分）：
 *   1. 换一个非标准仓库 —— hyhmrright/brooks-lint 是「invalid」形态（真实分类，
 *      非上次的 application），AI 应研究后给出「不可安装」结论或识别出可装目标。
 *   2. 验证凭据锁 —— throwaway dshHome 里放一个假的 .credentials.yaml，断言
 *      start() 在会话期间把凭据文件移出工作区（agent 摸不到）、结束后还原字节一致。
 *
 * 用 throwaway dshHome + throwaway profile；repo 由 AI_E2E_SEED_REPO 预置为本地副本。
 * 有副作用动作一律自动批准（模拟用户点「允许」）。
 *
 * env 门控：DSH_TEST_ACP === '1' 且需 DEEPSEEK_API_KEY。
 */
const integrationTest = process.env.DSH_TEST_ACP === '1' ? it : it.skip

integrationTest('drives the AI to research an invalid repo inside a throwaway profile, with the credentials lock active', async () => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DSH_TEST_ACP 需要 DEEPSEEK_API_KEY 环境变量。')

  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ai-e2e-'))
  const dshHome = path.join(root, 'dshhome')
  const profileName = 'web'
  const profileDir = path.join(dshHome, 'profiles', profileName)
  const originalProfile = {
    name: profileName,
    private: true,
    version: '0.0.0',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify(originalProfile, null, 2))
  await writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - ../../../node_modules\n')

  // 假凭据文件：真实 key 走 env 注入（readApiKey 回调），这个文件只用来证明
  // 凭据锁在真实 start() 流程里真的把 .credentials.yaml 移出、再还原。
  const credentialsPath = path.join(dshHome, '.credentials.yaml')
  const FAKE_CREDENTIALS = 'DEEPSEEK_API_KEY: sk-e2e-placeholder-not-a-real-key\n'
  await writeFile(credentialsPath, FAKE_CREDENTIALS, 'utf8')

  // 预置真实仓库的本地副本（浅克隆），让 agent 直接研究而非网络克隆。
  const seedRepo = process.env.AI_E2E_SEED_REPO
  if (seedRepo) await cp(seedRepo, path.join(dshHome, 'brooks-lint'), { recursive: true })

  const settings: AppSettings = {
    dshInstallPath: path.join(root, 'dsh-runtime'),
    dshHome,
    profileName,
    workspace: dshHome,
    launchExecutable: 'npx',
    launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
    webPort: 3080,
    openAfterLaunch: false,
  }

  // 与真实 analyzeRepository 输出一致：hyhmrright/brooks-lint → invalid。
  const analysis: RepositoryAnalysis = {
    repository: 'hyhmrright/brooks-lint',
    defaultBranch: 'main',
    installability: 'invalid',
    summary: '没有找到同时包含 package.json、dsh.bundle.patch 和对应补丁文件的插件组件。',
    targets: [],
  }

  const events: AiInstallEvent[] = []
  let approvalCount = 0
  let autoApprovedCount = 0
  let lockLogFired = false
  let lockObservedGone = false
  let restoreLogFired = false
  let installer: AiInstaller | undefined
  const emitOutput = (level: 'info' | 'error' | 'success', text: string) => {
    // 凭据锁的审计日志：锁日志触发瞬间，文件必须已物理移出；还原日志触发后复位。
    if (text.includes('已临时移出凭据文件')) {
      lockLogFired = true
      lockObservedGone = !existsSync(credentialsPath)
    }
    if (text.includes('凭据文件已还原')) {
      restoreLogFired = true
    }
    console.log(`[ai-e2e ${level}] ${text}`)
  }
  const emitEvent = (event: AiInstallEvent) => {
    events.push(event)
    if (event.kind === 'approval') {
      approvalCount += 1
      // 模拟用户每次点击「允许」，让任务继续。
      void installer?.approve(event.request.id, true)
    } else if (event.kind === 'auto-approved') {
      autoApprovedCount += 1
    }
  }

  try {
    const nodeRuntime = await ensureNodeRuntime(path.join(root, 'node-runtime'))
    installer = createAiInstaller({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => nodeRuntime,
      preparePnpmRuntime: async () => ensurePnpmRuntime(path.join(root, 'pnpm-runtime'), nodeRuntime),
      acpRuntimeRoot: path.join(root, 'acp-runtime'),
      snapshotRoot: path.join(root, 'snapshots'),
      emitOutput,
      emitEvent,
      isRuntimeRunning: () => false,
      isInstallerBusy: () => false,
      analyzePlugin: async () => analysis,
      readApiKey: async () => apiKey,
    })

    const result = await installer.start({ repository: analysis.repository, defaultBranch: analysis.defaultBranch })

    // 管线断言：任务应正常结束（done），而不是抛错或超时中止。
    expect(result.ok).toBe(true)
    expect(installer.isBusy()).toBe(false)
    expect(installer.hasSnapshot()).toBe(true)

    // 审计事件：应当出现快照、以及 at least 一次 agent 存活证据。
    const kinds = events.map(event => event.kind)
    expect(kinds).toContain('snapshot')
    expect(kinds.some(kind => kind === 'done' || kind === 'cancelled' || kind === 'error')).toBe(true)

    // 凭据锁：锁日志触发、且触发瞬间文件已不在工作区（agent 物理摸不到）；结束后还原。
    expect(lockLogFired).toBe(true)
    expect(lockObservedGone).toBe(true)
    expect(restoreLogFired).toBe(true)
    expect(await readFile(credentialsPath, 'utf8')).toBe(FAKE_CREDENTIALS)

    // Skill 安装：brooks-lint 是 Agent Skills 仓库（6 个 bundle skills），prompt 现在
    // 教 AI 把它安装为 Skill。断言 agent 真把 skill 复制进了 <dshHome>/skills/。
    const skillsDir = path.join(dshHome, 'skills')
    const skillsEntries = existsSync(skillsDir) ? await readdir(skillsDir) : []
    const bundleSkills = skillsEntries.filter(entry => existsSync(path.join(skillsDir, entry, 'SKILL.md')))
    console.log(`[ai-e2e] skills/ 目录条目: ${skillsEntries.join(', ') || '(空)'}`)
    console.log(`[ai-e2e] bundle skills 已装: ${bundleSkills.join(', ') || '(无)'}`)
    expect(bundleSkills.length).toBeGreaterThan(0)

    console.log(`[ai-e2e] 最终 message: ${result.message}`)
    console.log(`[ai-e2e] 审批弹窗 ${approvalCount} 次，只读自动放行 ${autoApprovedCount} 次，事件总数 ${events.length}`)
    console.log(`[ai-e2e] 凭据锁：lock=${lockLogFired}（触发瞬间文件已移出=${lockObservedGone}）、restore=${restoreLogFired}`)

    // 报告 profile 是否真的被改动（invalid 形态大概率不给改动，仅报告）。
    const afterProfile = await readFile(path.join(profileDir, 'package.json'), 'utf8')
    const profileChanged = afterProfile !== JSON.stringify(originalProfile, null, 2)
    console.log(`[ai-e2e] profile/package.json 是否被 AI 改动: ${profileChanged ? '是（安装了组件）' : '否（保持原样）'}`)

    // 快照还原可用：profile 回到原样，且 AI 装的 skill 被一并清掉（快照已纳入 skills/）。
    const restored = await installer.rollback()
    expect(restored.restored).toBeGreaterThanOrEqual(1)
    const afterRollback = await readFile(path.join(profileDir, 'package.json'), 'utf8')
    expect(afterRollback).toBe(JSON.stringify(originalProfile, null, 2))
    expect(existsSync(skillsDir)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => { /* 残留可忽略 */ })
  }
}, 600_000)
