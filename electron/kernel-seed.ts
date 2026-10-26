import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertLauncherOwnedRuntime, type HomeScope } from './home-scope'

/**
 * 随包内核：启动器自带 `runtime/kernels/<ver>/`（构建期由 scripts/bundle-kernel.mts
 * 从 npx 缓存整棵拷来，打包后落在 resources/kernels/<ver>/）。首启把它们释放到
 * `<dshInstallPath>/versions/<ver>/` —— 这正是 runtime-versions.ts 里 findManagedDshVersions
 * 认的布局，于是目标机不装 Node、不联网、不跑 pnpm 也算「已安装」。
 *
 * 拷贝而不是直接引用 resources 目录：resources 在 asar/安装目录里可能只读，
 * 而 DSH 运行时要往 node_modules 里写缓存。
 */

export interface SeedBundledKernelsOptions {
  /** 构建产物里的内核根：打包后是 `<resources>/kernels`，开发态是 `<repo>/runtime/kernels`。 */
  kernelsRoot: string
  /** 启动器托管的 DSH 运行时根（settings.dshInstallPath），内核释放到 `<它>/versions/<ver>`。 */
  dshInstallPath: string
  /** 认领边界（第六项）：覆盖写 `versions/<ver>` 只允许发生在启动器自己管的内核目录里。 */
  homeScope?: HomeScope
}

export interface SeededKernel {
  version: string
  /** seeded = 本次拷入；present = 目标已存在、未动。 */
  state: 'seeded' | 'present'
}

export interface SeedBundledKernelsResult {
  seeded: SeededKernel[]
}

/** 版本目录名必须能安全拼进路径；只接受安全字符，避免 `..` 之类越界。 */
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/

/** 内核的 dsh 启动外壳（windows 是 dsh.cmd）。 */
function kernelShellPath(kernelRoot: string): string {
  const shell = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  return path.join(kernelRoot, 'node_modules', '.bin', shell)
}

/** 内核自报版本的那个 package.json。 */
function kernelManifestPath(kernelRoot: string): string {
  return path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

/**
 * 一份内核是否**完整**：启动外壳 + `@deepseek-ai/dsh` 的 package.json（version 非空）都齐。
 *
 * 只看目录存在是不够的：首启释放内核时被关掉/断电会留下半截目录，
 * 那种目录一旦被判成「已安装」，启动器就再也不补了（点启动直接报错或退回联网）。
 */
export async function kernelIsComplete(kernelRoot: string): Promise<boolean> {
  try {
    await stat(kernelShellPath(kernelRoot))
  } catch {
    return false
  }
  try {
    const manifest = JSON.parse(await readFile(kernelManifestPath(kernelRoot), 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== '@deepseek-ai/dsh') return false
    return typeof manifest.version === 'string' && manifest.version.trim() !== ''
  } catch {
    return false
  }
}

/** 递归拷贝：只认文件/目录，符号链接跳过（内核里不该有链接，有也不跟）。 */
async function copyDirectory(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const stack: Array<{ from: string; to: string }> = [{ from: source, to: target }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const dirents = await readdir(current.from, { withFileTypes: true })
    for (const dirent of dirents) {
      const from = path.join(current.from, dirent.name)
      const to = path.join(current.to, dirent.name)
      if (dirent.isDirectory()) {
        await mkdir(to, { recursive: true })
        stack.push({ from, to })
      } else if (dirent.isFile()) {
        await copyFile(from, to)
      }
    }
  }
}

/**
 * 把 kernelsRoot 下每个 <ver>/ 拷到 <dshInstallPath>/versions/<ver>/，仅当目标不存在。
 * 永不抛：内核释放失败只让首启退回「按需下载」的老路，不能把启动器挡在门口。
 */
export async function seedBundledKernels(options: SeedBundledKernelsOptions): Promise<SeedBundledKernelsResult> {
  const result: SeedBundledKernelsResult = { seeded: [] }
  const kernelsRoot = options.kernelsRoot
  if (!kernelsRoot || !options.dshInstallPath || !existsSync(kernelsRoot)) return result

  let entries
  try {
    entries = await readdir(kernelsRoot, { withFileTypes: true })
  } catch {
    return result
  }

  for (const entry of entries) {
    const version = entry.name
    if (!entry.isDirectory() || !SAFE_VERSION_RE.test(version)) continue
    const source = path.join(kernelsRoot, version)
    const target = path.join(options.dshInstallPath, 'versions', version)
    // 目标**完整**才算「已安装」：不覆盖 —— 用户可能已经在跑这个版本，
    // 也可能装过更新的补丁；覆盖会把正在用的运行时抽掉。
    // 目标存在但不完整（首启中途被关掉留下的半截）要重拷，这正是自愈路径。
    if (await kernelIsComplete(target)) {
      result.seeded.push({ version, state: 'present' })
      continue
    }
    if (!(await kernelIsComplete(source))) {
      // 源都不完整（比如只留了半截），跳过而不是拷进去一个坏版本。
      continue
    }
    // 认领边界（第六项）：copyDirectory 第一件事是 rm(target)。dshInstallPath 若被指到
    // 启动器私有目录之外（用户自己改的），宁可放弃自愈也不整棵删外部目录。
    const scope: HomeScope = options.homeScope ?? {
      userData: path.dirname(options.dshInstallPath),
      packsRoot: path.join(path.dirname(options.dshInstallPath), 'dsh-packs'),
      managedDshRoot: options.dshInstallPath,
    }
    try {
      assertLauncherOwnedRuntime(target, scope, `释放随包内核 ${version}`)
    } catch (error) {
      // 不归自己管：记一行就走，绝不让下面的 catch 顺手 rm 掉外部目录。
      console.error('[kernel-seed] 跳过不属于启动器的内核目录。', error)
      continue
    }
    try {
      await copyDirectory(source, target)
      result.seeded.push({ version, state: 'seeded' })
    } catch (error) {
      console.error(`[kernel-seed] 内核 ${version} 释放失败。`, error)
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return result
}
