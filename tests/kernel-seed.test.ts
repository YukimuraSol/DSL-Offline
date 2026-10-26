import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kernelIsComplete, seedBundledKernels } from '../electron/kernel-seed'

/**
 * 随包内核释放（缺陷 3）。
 *
 * 只看「目标目录存在」就判 present 是致命的：首启释放到一半被关掉会留下半截目录，
 * 之后启动器再也不补，用户点启动就报错或者退回联网。这里要求 presence =
 * dsh.cmd + node_modules/@deepseek-ai/dsh/package.json（version 非空）同时就位。
 */

let root = ''
const shellName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

function kernelFiles(kernelRoot: string) {
  return {
    shell: path.join(kernelRoot, 'node_modules', '.bin', shellName),
    manifest: path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  }
}

async function writeKernel(kernelRoot: string, version: string) {
  const { shell, manifest } = kernelFiles(kernelRoot)
  await mkdir(path.dirname(shell), { recursive: true })
  await mkdir(path.dirname(manifest), { recursive: true })
  await writeFile(shell, 'dsh', 'utf8')
  await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-kernel-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('随包内核释放', () => {
  it('只认同时有 dsh.cmd 与包清单的内核', async () => {
    const complete = path.join(root, 'complete')
    await writeKernel(complete, '0.2.0-rc.2')
    expect(await kernelIsComplete(complete)).toBe(true)

    // 只有外壳、没有包清单 = 半截。
    const shellOnly = path.join(root, 'shell-only')
    await mkdir(path.dirname(kernelFiles(shellOnly).shell), { recursive: true })
    await writeFile(kernelFiles(shellOnly).shell, 'dsh', 'utf8')
    expect(await kernelIsComplete(shellOnly)).toBe(false)

    // 有清单但 version 是空串也不能算完整。
    const blankVersion = path.join(root, 'blank-version')
    await writeKernel(blankVersion, '')
    expect(await kernelIsComplete(blankVersion)).toBe(false)
  })

  it('目标目录存在但不完整时重拷自愈（缺陷 3）', async () => {
    const kernelsRoot = path.join(root, 'kernels')
    const dshInstallPath = path.join(root, 'userdata', 'dsh-runtime')
    const version = '0.2.0-rc.2'
    await writeKernel(path.join(kernelsRoot, version), version)

    // 造一个「上次首启拷到一半」的目标：目录在，外壳在，包清单缺。
    const target = path.join(dshInstallPath, 'versions', version)
    const { shell, manifest } = kernelFiles(target)
    await mkdir(path.dirname(shell), { recursive: true })
    await writeFile(shell, 'stale', 'utf8')
    expect(await kernelIsComplete(target)).toBe(false)

    const result = await seedBundledKernels({
      kernelsRoot,
      dshInstallPath,
      homeScope: { userData: path.join(root, 'userdata'), packsRoot: path.join(root, 'packs'), managedDshRoot: dshInstallPath },
    })

    expect(result.seeded).toEqual([{ version, state: 'seeded' }])
    expect(await kernelIsComplete(target)).toBe(true)
    // 重拷是「整棵换掉」：外壳内容来自源，不是那个 stale。
    expect(await readFile(shell, 'utf8')).toBe('dsh')
    expect(JSON.parse(await readFile(manifest, 'utf8')).version).toBe(version)
  })

  it('目标已完整就不动（不覆盖可能正在跑的运行时）', async () => {
    const kernelsRoot = path.join(root, 'kernels')
    const dshInstallPath = path.join(root, 'userdata', 'dsh-runtime')
    const version = '0.2.0-rc.2'
    await writeKernel(path.join(kernelsRoot, version), version)
    const target = path.join(dshInstallPath, 'versions', version)
    await writeKernel(target, version)
    const before = (await stat(kernelFiles(target).manifest)).mtimeMs

    const result = await seedBundledKernels({
      kernelsRoot,
      dshInstallPath,
      homeScope: { userData: path.join(root, 'userdata'), packsRoot: path.join(root, 'packs'), managedDshRoot: dshInstallPath },
    })

    expect(result.seeded).toEqual([{ version, state: 'present' }])
    expect((await stat(kernelFiles(target).manifest)).mtimeMs).toBe(before)
  })

  it('dshInstallPath 被指到启动器私有目录之外时拒绝覆盖写（第六项）', async () => {
    const kernelsRoot = path.join(root, 'kernels')
    const version = '0.2.0-rc.2'
    await writeKernel(path.join(kernelsRoot, version), version)

    // 模拟用户把内核目录改到了自己的家目录下：这里绝不能整棵删。
    const outside = path.join(root, 'user-home', 'dsh-runtime')
    const target = path.join(outside, 'versions', version)
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'keep.txt'), 'user data', 'utf8')

    const result = await seedBundledKernels({
      kernelsRoot,
      dshInstallPath: outside,
      homeScope: { userData: path.join(root, 'userdata'), packsRoot: path.join(root, 'packs'), managedDshRoot: path.join(root, 'userdata', 'dsh-runtime') },
    })

    expect(result.seeded).toEqual([])
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('user data')
  })
})
