#!/usr/bin/env node
/**
 * DSH Pack Launcher 的 Inno Setup 安装包构建脚本。
 *
 * 流程：npm run build → electron-builder --win --dir → ISCC 编译 build/installer.iss
 * 产物：release/DSH-Pack-Launcher-<版本>-setup.exe
 *
 * 加 --verify-install 会接着在本机静默装一遍产物，并比对装完的 resources\app.asar
 * 与新版的字节数/修改时间：对不上就以非 0 退出。装完到底有没有换上，只有这一步说得清 ——
 * 安装器自己的退出码不算数（1.0.15 及更早：启动器开着时静默装返回 0，一个文件没动）。
 * 默认不跑：它会真的安装、并改写本机的卸载注册项（见 build/installer.iss 顶部警告）。
 *
 * 为什么要自己找 ISCC：Inno 不是 npm 依赖，装在机器上而不是 node_modules 里，
 * 位置随安装方式变化（官方安装器 per-machine / winget 的 per-user / 绿色版）。
 * 这里按「标准安装路径 → 用户级安装路径 → PATH」逐个探，都没有就打印可照做的
 * 中文提示并以退出码 1 结束 —— 不自动下载安装 Inno，那是用户机器上的软件决定。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

function fail(lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** 把子进程输出原样接到终端上；返回退出码。 */
function run(command, args, label) {
  console.log(`\n> ${label}`)
  // windowsHide：不能弹控制台窗口抢用户焦点。
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true })
  if (result.error) {
    fail([`无法启动 ${label}：${result.error.message}`])
  }
  return result.status ?? 1
}

/** Inno Setup 6 的常见安装位置，按可靠性排序。 */
function isccCandidates() {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''
  const programFiles = process.env.ProgramFiles ?? ''
  // 官方安装器：per-machine（Program Files (x86)）或 per-user（%LOCALAPPDATA%\Programs）。
  // 三个根都用环境变量拼，不写死 C:\ —— 系统装在别的盘、或用 32 位系统时也能找到。
  const roots = [programFilesX86, programFiles, localAppData && path.join(localAppData, 'Programs'), localAppData].filter(Boolean)
  const fromRoots = roots.map(root => path.join(root, 'Inno Setup 6', 'ISCC.exe'))
  return [process.env.ISCC_PATH, ...fromRoots].filter(Boolean)
}

function findIscc() {
  for (const candidate of isccCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  // PATH 上的 ISCC（绿色版或用户自己加进 PATH 的）。
  const probe = spawnSync(isWindows ? 'where' : 'which', ['ISCC.exe'], { encoding: 'utf8' })
  const first = (probe.stdout ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return first && existsSync(first) ? first : null
}

const iscc = findIscc()
if (!iscc) {
  fail([
    '未找到 Inno Setup 6 的编译器 ISCC.exe，无法生成安装包。',
    '',
    '已探测的位置：',
    '  %ISCC_PATH%',
    '  %ProgramFiles(x86)%\\Inno Setup 6\\ISCC.exe',
    '  %ProgramFiles%\\Inno Setup 6\\ISCC.exe',
    '  %LOCALAPPDATA%\\Programs\\Inno Setup 6\\ISCC.exe',
    '  %LOCALAPPDATA%\\Inno Setup 6\\ISCC.exe',
    '  PATH 上的 ISCC.exe',
    '',
    '请先安装 Inno Setup 6，任选一种：',
    '  winget install --id JRSoftware.InnoSetup -e --accept-package-agreements --accept-source-agreements --silent',
    '  或从 https://jrsoftware.org/isdl.php 下载安装（安装时勾选编译器组件）',
    '',
    '装完重新执行：npm run package:inno',
    '如果装在非标准目录，把环境变量 ISCC_PATH 指向 ISCC.exe 即可。',
  ])
}
console.log(`使用编译器：${iscc}`)

const electronCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js')
if (!existsSync(electronCli)) {
  fail([
    '未找到 node_modules/electron-builder/cli.js，依赖没装全。',
    '请先在仓库根目录执行 npm install（本项目用 npm，不用 pnpm install）。',
  ])
}

// 0) 随包运行时归档：vendor/node（含 npm）+ vendor/pnpm → runtime/node-runtime-<版本>-win-<架构>.zip。
//    fetch:runtimes 在 vendor 已就绪时是秒过的（它自己按 node -v / pnpm 版本判断）；
//    archive 每轮都重压，避免「代码更新了但归档还是旧的」。缺归档的安装包就等于没做这件事，
//    所以这两步失败直接终止，不往下打包。
const viteNodeBin = path.join(root, 'node_modules', 'vite-node', 'dist', 'cli.mjs')
if (!existsSync(viteNodeBin)) {
  fail(['未找到 node_modules/vite-node/dist/cli.mjs，依赖没装全。请先 npm install。'])
}
if (run(process.execPath, [viteNodeBin, path.join(root, 'scripts', 'fetch-node-runtime.mts')], 'fetch:runtimes') !== 0) {
  fail(['随包 Node 运行时准备失败（首次需要联网下载 node 与 pnpm），安装包没做出来。'])
}
if (run(process.execPath, [viteNodeBin, path.join(root, 'scripts', 'build-node-archive.mts')], 'archive:runtime') !== 0) {
  fail(['随包 Node 归档生成失败，安装包没做出来。'])
}

// 1) 前端 + 主进程产物，等价于 npm run build（tsc --noEmit && vite build）。
//    不经过 npm：Node 新版 spawn 一个 .cmd 会 EINVAL，直接调本地的两个 bin 更稳，
//    而且不用开 shell（开 shell 在 Windows 上会闪一个控制台窗口）。
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
if (run(process.execPath, [tscBin, '--noEmit'], 'tsc --noEmit') !== 0) {
  fail(['类型检查没通过，安装包没做出来。先修 tsc 报错。'])
}
if (run(process.execPath, [viteBin, 'build'], 'vite build') !== 0) {
  fail(['vite build 失败，安装包没做出来。'])
}

// 2) 目录形态产物：安装包要打的是这个，而不是 electron-builder 自己的单文件 target。
if (run(process.execPath, [electronCli, '--win', '--dir'], 'electron-builder --win --dir') !== 0) {
  fail(['electron-builder --win --dir 失败，没拿到 release/win-unpacked。'])
}

const unpacked = path.join(root, 'release', 'win-unpacked')
if (!existsSync(path.join(unpacked, 'DSH Launcher.exe'))) {
  fail([
    'release/win-unpacked/DSH Launcher.exe 不存在，不能打包。',
    '常见原因：Electron 二进制没下载完整（node_modules/electron/dist/electron.exe 缺失）。',
    '可执行 npm rebuild electron 或重新 npm install 后再试。',
  ])
}

// 2b) 归档必须真的进了 extraResources。这一步是「离线包到底离线不离线」的唯一硬证据：
//     electron-builder 的目录规则改一次就可能悄悄把它漏掉，装完才发现目标机要来下载 35MB。
const archiveDirectory = path.join(unpacked, 'resources', 'node-archive')
const archiveFiles = existsSync(archiveDirectory)
  ? readdirSync(archiveDirectory).filter(name => /^node-runtime-.*\.zip$/.test(name))
  : []
if (archiveFiles.length === 0) {
  fail([
    'release/win-unpacked/resources/node-archive 里没有 node-runtime-*.zip。',
    '检查 package.json 的 build.extraResources 是否还带着 runtime → node-archive 那一条。',
    archiveDirectory,
  ])
}
console.log(`随包归档已就位：resources/node-archive/${archiveFiles.join('、')}`)

// 3) Inno 编译。
if (run(iscc, [`/DAppVersion=${version}`, '/Qp', path.join(root, 'build', 'installer.iss')], 'ISCC build/installer.iss') !== 0) {
  fail(['ISCC 编译失败，上面是 Inno 的原始报错。'])
}

const output = path.join(root, 'release', `DSH-Pack-Launcher-${version}-setup.exe`)
if (!existsSync(output)) {
  const listing = existsSync(path.join(root, 'release')) ? readdirSync(path.join(root, 'release')).join('\n  ') : '（release 目录不存在）'
  fail(['ISCC 返回成功，但没有预期的产物：', `  ${output}`, 'release 目录里现在有：', `  ${listing}`])
}

const size = statSync(output).size
console.log(`\n安装包已生成：${output}`)
console.log(`大小：${(size / 1024 / 1024).toFixed(1)} MB（${size} 字节）`)

if (process.argv.includes('--verify-install')) {
  verifyInstall(output, path.join(unpacked, 'resources', 'app.asar'))
}

/**
 * 安装后自校验：静默装一遍产物，再拿装完的 resources\app.asar 跟新版的字节数/修改时间比。
 *
 * 为什么不能只看安装器的退出码：启动器开着时，旧安装包会以 0 退出而且一个文件都不换
 * （占用中的 app.asar 被留到重启后再替换，而静默安装带着 /NORESTART，于是永远等不到）。
 * 那种「成功」在流水线里是绿的，装的却还是旧版 —— 所以这里直接以文件为准，对不上就非 0。
 *
 * 默认不执行：这一步会真的安装到本机，并且同一个 AppId 会改写本机的卸载注册项
 * （build/installer.iss 顶部有专门的警告）。要验就显式加 --verify-install。
 */
function verifyInstall(setupExe, builtAsar) {
  // Inno 默认 UsePreviousAppDir=yes：装过一次之后会沿用注册表里记录的安装位置，
  // 所以按注册表找，找不到才回落到 [Setup] 里的 DefaultDirName。
  const fromRegistry = (() => {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.dshlauncher_is1'
    const probe = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true })
    const line = (probe.stdout ?? '').split(/\r?\n/).find(text => /InstallLocation\s+REG_/.test(text))
    return line ? line.trim().split(/\s\s+/).pop() : null
  })()
  const appDir = fromRegistry ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Pack Launcher')
  const installedAsar = path.join(appDir, 'resources', 'app.asar')
  const snapshot = () => (existsSync(installedAsar) ? { size: statSync(installedAsar).size, mtime: statSync(installedAsar).mtimeMs } : null)
  const before = snapshot()
  const built = { size: statSync(builtAsar).size, mtime: statSync(builtAsar).mtimeMs }

  console.log(`\n> 安装后自校验：静默安装 ${path.basename(setupExe)}`)
  console.log(`  安装位置：${appDir}`)
  const status = run(setupExe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', '/SP-'], '安装包静默安装')
  const after = snapshot()

  const problems = []
  if (status !== 0) problems.push(`安装器退出码 ${status}，不是 0。`)
  if (!after) problems.push(`装完没有 ${installedAsar}。`)
  else {
    if (after.size !== built.size) problems.push(`resources\\app.asar 字节数不是新版：装完 ${after.size}，新版 ${built.size}（装前 ${before ? before.size : '无'}）。`)
    if (before && after.mtime === before.mtime) problems.push(`resources\\app.asar 的修改时间没变（${new Date(after.mtime).toISOString()}），安装什么都没换。`)
  }
  if (problems.length > 0) {
    fail(['安装后自校验没通过 —— 安装器说自己成功了，但实际上没装上：', ...problems.map(text => `  ${text}`), `  安装包：${setupExe}`])
  }
  console.log(`安装后自校验通过：app.asar ${before ? before.size : '（首次安装）'} → ${after.size} 字节，修改时间 ${new Date(after.mtime).toISOString()}`)
}
