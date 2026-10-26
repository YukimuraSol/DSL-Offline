/**
 * 把 vendor/node（含 npm）与 vendor/pnpm 打成一个归档，交给安装包随包下发：
 *
 *   node scripts/build-node-archive.mts        生成 runtime/node-runtime-<版本>-win-<架构>.zip
 *
 * 为什么是归档而不是直接塞 extraResources：electron-builder 会无条件剥掉
 * node_modules（见 scripts/fetch-node-runtime.mts 顶部实测），而 npm 就住在
 * node_modules/npm 里；打成 zip 之后解包由启动器自己做，内部目录不受打包器约束。
 *
 * 每次打包都重做（不按 mtime 偷懒）：归档和代码一样是产物，凭「上次生成过」跳过
 * 正是「代码更新了但归档还是旧的」那种坑的来源。体积上也就复制 100MB 再压一次。
 *
 * 前置条件是 vendor/ 已就绪（npm run fetch:runtimes，打包链路里自动跑）。
 * 版本断言放在这里，而不是只信 fetch 脚本：单独跑本脚本时也不能把旧内容打成新名字。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_NODE_ARCHIVE_PREFIX,
  archiveArchitecture,
  bundledNodeArchiveName,
  writeNodeRuntimeArchive,
} from '../electron/node-archive'
import { NODE_RUNTIME_VERSION, PNPM_VERSION, normalizeNodeVersion, pnpmExecutable } from '../electron/node-runtime'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_ROOT = path.join(REPO_ROOT, 'vendor')
const NODE_ROOT = path.join(VENDOR_ROOT, 'node')
const PNPM_ROOT = path.join(VENDOR_ROOT, 'pnpm')
const OUTPUT_ROOT = path.join(REPO_ROOT, 'runtime')

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 以 `node -v` 为准，不信任目录名：随包内容与常量漂移过一次就再也不会一致。 */
function reportedNodeVersion(executable: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(executable, ['-v'], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim())
    })
  })
}

async function assertSources(): Promise<void> {
  const nodeExecutable = path.join(NODE_ROOT, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  if (!existsSync(nodeExecutable)) {
    throw new Error(`vendor/node 不存在（${nodeExecutable}）。先跑 npm run fetch:runtimes。`)
  }
  const reported = await reportedNodeVersion(nodeExecutable)
  if (reported !== normalizeNodeVersion(NODE_RUNTIME_VERSION)) {
    throw new Error(`vendor/node 跑出来是 ${reported ?? '读不到版本'}，与 NODE_RUNTIME_VERSION=${NODE_RUNTIME_VERSION} 不一致。先跑 npm run fetch:runtimes -- --force。`)
  }
  const npmManifest = path.join(NODE_ROOT, 'node_modules', 'npm', 'package.json')
  if (!existsSync(npmManifest)) {
    throw new Error(`vendor/node 缺 node_modules/npm（${npmManifest}）。归档必须带 npm，否则解出来装不了 pnpm。`)
  }
  const pnpmManifest = path.join(PNPM_ROOT, 'node_modules', 'pnpm', 'package.json')
  if (!existsSync(pnpmManifest) || !existsSync(pnpmExecutable(PNPM_ROOT))) {
    throw new Error('vendor/pnpm 不完整（缺 node_modules/pnpm 或 .bin/pnpm.cmd）。先跑 npm run fetch:runtimes。')
  }
  const manifest = JSON.parse(await readFile(pnpmManifest, 'utf8')) as { version?: unknown }
  if (manifest.version !== PNPM_VERSION) {
    throw new Error(`vendor/pnpm 是 ${String(manifest.version)}，与 PNPM_VERSION=${PNPM_VERSION} 不一致。先跑 npm run fetch:runtimes -- --force。`)
  }
}

/** 只留当前版本/架构那一份：同名目录里堆着旧归档，打包时会被 filter 一起带进安装包。 */
async function removeStaleArchives(keepName: string): Promise<string[]> {
  const removed: string[] = []
  for (const name of await readdir(OUTPUT_ROOT).catch(() => [] as string[])) {
    if (!name.startsWith(BUNDLED_NODE_ARCHIVE_PREFIX) || !name.endsWith('.zip') || name === keepName) continue
    await rm(path.join(OUTPUT_ROOT, name), { force: true })
    removed.push(name)
  }
  return removed
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('非 Windows：跳过随包 Node 归档（打包目标是 Windows）。')
    return
  }
  await assertSources()

  const name = bundledNodeArchiveName(NODE_RUNTIME_VERSION)
  const outputPath = path.join(OUTPUT_ROOT, name)
  // 先写 .partial 再改名：中途失败不会留下一个「看起来能用」的半截 zip 被下一次打包带走。
  const partialPath = path.join(OUTPUT_ROOT, `.node-runtime-${archiveArchitecture()}.partial`)
  await rm(partialPath, { force: true })

  const startedAt = Date.now()
  const result = await writeNodeRuntimeArchive({
    outputPath: partialPath,
    nodeRoot: NODE_ROOT,
    pnpmRoot: PNPM_ROOT,
  })
  await rename(partialPath, outputPath)
  const removed = await removeStaleArchives(name)
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const { size } = await stat(outputPath)

  console.log(`已生成随包归档：${outputPath}`)
  console.log(`  ${result.entries} 个条目，未压缩 ${megabytes(result.sourceBytes)} → ${megabytes(size)}，耗时 ${elapsed}s`)
  console.log(`  顶层目录：node/（含 node_modules/npm）、pnpm/（含 node_modules/pnpm）`)
  if (removed.length > 0) console.log(`  已删除过期归档：${removed.join('、')}`)
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
