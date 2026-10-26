import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPackHome, type PackVerifyReport } from '../electron/pack-verify'
import { runCli } from '../electron/pack-verify'

const ROOTS: string[] = []

afterEach(async () => {
  for (const root of ROOTS.splice(0)) await rm(root, { recursive: true, force: true })
})

const PROFILE_ID = 'demo-pack'

/**
 * 造一个最小但合格的家目录：
 *   <home>/kernels/1.0.0/                                  （假随包内核）
 *   <home>/profiles/demo-pack/package.json                 （清单：file: 相对依赖 + 一个启用插件）
 *   <home>/profiles/demo-pack/profile.yaml                 （dshVersion 对得上）
 *   <home>/profiles/demo-pack/node_modules/demo-plugin/    （插件本体 + 入口）
 *   <home>/profiles/demo-pack/.dsh-launcher-plugin-bodies/ （file: 依赖指向的目录）
 */
async function makeHome(): Promise<{ home: string; kernelsRoot: string; profileDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-verify-home-'))
  ROOTS.push(root)
  const home = path.join(root, 'home')
  const kernelsRoot = path.join(home, 'kernels')
  const profileDir = path.join(home, 'profiles', PROFILE_ID)
  const nodeModules = path.join(profileDir, 'node_modules')
  await mkdir(path.join(kernelsRoot, '1.0.0'), { recursive: true })
  await mkdir(path.join(nodeModules, 'demo-plugin'), { recursive: true })
  await mkdir(path.join(profileDir, '.dsh-launcher-plugin-bodies', 'demo-dep'), { recursive: true })
  await writeFile(path.join(profileDir, 'profile.yaml'), 'name: demo-pack\ndshVersion: 1.0.0\n', 'utf8')
  await writeFile(path.join(nodeModules, 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }), 'utf8')
  await writeFile(path.join(nodeModules, 'demo-plugin', 'index.js'), 'export default {}\n', 'utf8')
  await writeManifest(profileDir, { 'demo-dep': 'file:./.dsh-launcher-plugin-bodies/demo-dep' })
  return { home, kernelsRoot, profileDir }
}

async function writeManifest(profileDir: string, dependencies: Record<string, string>): Promise<void> {
  const manifest = { name: 'dsh-profile-demo-pack', version: '1.0.0', dependencies, dsh: { profile: { bundles: ['demo-plugin'] } } }
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

function checkOf(report: PackVerifyReport, id: number) {
  return report.checks.find(check => check.id === id)
}

describe('verifyPackHome', () => {
  it('结构、依赖、链接、入口、内核都对得上时 ok 为 true', async () => {
    const { home, kernelsRoot } = await makeHome()
    const report = await verifyPackHome(home, 'demo-pack', { kernelsRoot, profileId: PROFILE_ID })
    expect(report.checks.map(check => check.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
    expect(report.ok).toBe(true)
    expect(report.verdict).toBe('可以启动')
    expect(report.dshVersion).toBe('1.0.0')
    expect(report.availableKernels).toEqual(['1.0.0'])
    expect(report.prompt).toBe('')
  })

  it('依赖里留着本机绝对路径时 ok 为 false，且「换机会装不上」那条是 fail', async () => {
    const { home, kernelsRoot, profileDir } = await makeHome()
    await writeManifest(profileDir, { 'demo-dep': 'file:C:\\Users\\someone\\packs\\demo-dep' })
    const report = await verifyPackHome(home, 'demo-pack', { kernelsRoot, profileId: PROFILE_ID })
    expect(report.ok).toBe(false)
    const leak = checkOf(report, 2)
    expect(leak?.status).toBe('fail')
    expect(leak?.detail).toContain('换机会装不上')
    expect(leak?.findings.join(' ')).toContain('demo-dep')
    expect(report.verdict).toContain('对不上号')
    expect(report.prompt).toContain('就地修')
  })

  it('CLI 纯函数：--json 只吐合法 JSON、退出码跟 ok 走、错路径给 2', async () => {
    const { home, kernelsRoot, profileDir } = await makeHome()
    // 走 CLI 时内核目录是本机默认的那份，和这里的假 1.0.0 未必对得上，
    // 所以只断言「退出码与 ok 一致」而不是硬编码 0。
    const clean = await runCli([home, '--json'])
    const parsed = JSON.parse(clean.stdout) as PackVerifyReport
    expect(parsed.checks).toHaveLength(6)
    expect(clean.exitCode).toBe(parsed.ok ? 0 : 1)

    // 绝对路径那条一定 fail → ok:false → 退出码 1，这个与内核无关。
    await writeManifest(profileDir, { 'demo-dep': 'file:C:\\Users\\someone\\packs\\demo-dep' })
    const broken = await runCli([home, '--json'])
    expect((JSON.parse(broken.stdout) as PackVerifyReport).ok).toBe(false)
    expect(broken.exitCode).toBe(1)
    expect(broken.stderr).toBe('')

    // 人可读模式：按 PACK_CHECKS 的 level 分组，且带上唯一那份修法提示词。
    const human = await runCli([home])
    expect(human.stdout).toContain('【包内清单】')
    expect(human.stdout).toContain('【家目录】')
    expect(human.stdout).toContain('修法（可以直接把下面这段贴给 AI）')

    const missing = await runCli([path.join(home, 'not-here'), '--json'])
    expect(missing.exitCode).toBe(2)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('找不到这个路径')
    expect(kernelsRoot).toContain('kernels')
  })
})
