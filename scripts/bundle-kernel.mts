/**
 * 把 npx 缓存里那份装好的 DSH 内核整棵拷进 runtime/kernels/<ver>/，
 * 供 electron-builder 的 extraResources 打进启动器；首启由 electron/kernel-seed.ts
 * 释放到 <dshInstallPath>/versions/<ver>/，目标机不装 Node、不联网、不跑 pnpm。
 *
 *   npm run bundle:kernel -- --from D:\OpenCode\cache\npm\_npx\7eff65a5cfe9d1d1
 *   npm run bundle:kernel -- --from <npx 缓存目录> --force
 *
 * 为什么是「整棵搬」：npx 缓存里已经有一份装好的 @deepseek-ai/dsh（含全部
 * dependencies），直接搬比重新 install 快且不需要网络。再往 node_modules/.bin
 * 里放一份 node.exe —— dsh.cmd 脚本本身会优先用 `%dp0%\node.exe`，于是内核自带
 * 运行时，完全不受目标机 PATH 上有没有 node 影响。
 *
 * 源目录怎么找：--from / 环境变量 DSH_KERNEL_SOURCE。不猜默认路径——npx 缓存
 * 目录名是随机的（_npx/<hash>），猜错会静默打错包。
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KERNELS_ROOT = path.join(REPO_ROOT, 'runtime', 'kernels')
const DSH_PACKAGE_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh']

interface Options {
  /** npx 缓存目录（该目录下必须有 node_modules/@deepseek-ai/dsh）。 */
  from: string | null
  /** 目标已存在时重新拷贝。 */
  force: boolean
  /** 随包 node 可执行文件；默认用当前跑脚本的 node。 */
  nodeExecutable: string
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function parseOptions(argv: string[]): Options {
  let from = process.env.DSH_KERNEL_SOURCE?.trim() || null
  let force = false
  let nodeExecutable = process.execPath
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--from') {
      from = argv[index + 1]?.trim() ?? null
      index += 1
    } else if (argument.startsWith('--from=')) {
      from = argument.slice('--from='.length).trim() || null
    } else if (argument === '--force') {
      force = true
    } else if (argument === '--node') {
      nodeExecutable = argv[index + 1] ?? nodeExecutable
      index += 1
    }
  }
  return { from, force, nodeExecutable }
}

/** 递归统计：不跟符号链接（npx 缓存里没有，但防将来有环）。 */
async function measure(target: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()!
    const dirents = await readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name)
      if (dirent.isDirectory()) stack.push(full)
      else if (dirent.isFile()) {
        files += 1
        bytes += (await stat(full)).size
      }
    }
  }
  return { files, bytes }
}

interface KernelManifest {
  version: string
  binFile: string
}

/** 读源/目标内核的版本与 bin 入口，同时校验二者都存在。 */
async function readKernelManifest(kernelRoot: string): Promise<KernelManifest> {
  const packageJsonPath = path.join(kernelRoot, ...DSH_PACKAGE_SEGMENTS, 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(`内核目录缺少 @deepseek-ai/dsh：${packageJsonPath}`)
  }
  const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    version?: unknown
    bin?: unknown
  }
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
  if (!version) throw new Error(`内核 package.json 没有 version：${packageJsonPath}`)
  const binField = parsed.bin
  const binFile = typeof binField === 'string'
    ? binField
    : binField && typeof binField === 'object' && typeof (binField as Record<string, unknown>).dsh === 'string'
      ? (binField as Record<string, string>).dsh
      : 'lib/bin.js'
  const binPath = path.join(kernelRoot, ...DSH_PACKAGE_SEGMENTS, binFile)
  if (!existsSync(binPath)) throw new Error(`内核缺少 bin 入口文件：${binPath}`)
  return { version, binFile }
}

/** dsh.cmd / dsh 外壳：Windows 是 .cmd，其它平台是无扩展名的 sh。 */
function launcherShellName(): string {
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

function bundledNodeName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (!options.from) {
    throw new Error(
      '没有指定内核源目录。用法：npm run bundle:kernel -- --from <npx 缓存目录>\n'
      + '  npx 缓存目录里必须有 node_modules/@deepseek-ai/dsh（例如 %LOCALAPPDATA%\\npm-cache\\_npx\\<hash>）。',
    )
  }
  const source = path.resolve(options.from)
  if (!existsSync(source)) throw new Error(`内核源目录不存在：${source}`)
  if (!existsSync(options.nodeExecutable)) throw new Error(`找不到 node 可执行文件：${options.nodeExecutable}`)

  const manifest = await readKernelManifest(source)
  const target = path.join(KERNELS_ROOT, manifest.version)
  const staging = `${target}.staging`

  if (existsSync(target) && !options.force) {
    console.log(`内核 ${manifest.version} 已就位，跳过拷贝（要重拷加 --force）：${target}`)
  } else {
    // 先拷到 staging 再改名：半截目录会被 findManagedDshVersions 认成「已安装」，必须原子。
    await rm(staging, { recursive: true, force: true })
    await mkdir(path.dirname(target), { recursive: true })
    console.log(`拷贝内核：${source} → ${staging}`)
    await cp(source, staging, { recursive: true, force: true })
    // dsh.cmd 里 `IF EXIST "%dp0%\node.exe"` 优先用同目录的 node：放一份进来就自带运行时。
    await cp(options.nodeExecutable, path.join(staging, 'node_modules', '.bin', bundledNodeName()), { force: true })
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  }

  // 自检：只认「文件真的在」，不认一次成功的 cp 返回值。
  const binDirectory = path.join(target, 'node_modules', '.bin')
  const shellPath = path.join(binDirectory, launcherShellName())
  const nodePath = path.join(binDirectory, bundledNodeName())
  const copied = await readKernelManifest(target)
  const binPath = path.join(target, ...DSH_PACKAGE_SEGMENTS, copied.binFile)
  const missing = [
    [shellPath, 'dsh 启动外壳'],
    [nodePath, '随包 node'],
    [binPath, 'bin 入口'],
  ].filter(([filePath]) => !existsSync(filePath))
  if (missing.length > 0) {
    throw new Error(`内核自检失败，缺：${missing.map(([filePath, label]) => `${label}（${filePath}）`).join('、')}`)
  }
  if (copied.version !== manifest.version) {
    throw new Error(`内核版本不一致：源 ${manifest.version}，目标 ${copied.version}`)
  }

  const size = await measure(target)
  console.log(`内核版本：${copied.version}`)
  console.log(`已就位：${target}（${size.files} 个文件，约 ${megabytes(size.bytes)} MB）`)
  console.log(`自检：node_modules/.bin/${launcherShellName()} ✓  node_modules/.bin/${bundledNodeName()} ✓  @deepseek-ai/dsh/${copied.binFile} ✓`)
}

await main().catch(error => {
  console.error(`准备随包内核失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
