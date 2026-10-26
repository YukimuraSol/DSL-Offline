#!/usr/bin/env node
// dsh-melody-launcher npm 启动入口
// 通过 electron 加载当前包（package.json main -> dist-electron/main.js）。

const { spawn } = require('node:child_process')
const path = require('node:path')

// 在 Node 环境下 require('electron') 返回 Electron 可执行文件路径。
let electronPath
try {
  electronPath = require('electron')
} catch (error) {
  console.error('无法加载 Electron，请先执行 npm install。')
  console.error(error)
  process.exit(1)
}

const appPath = path.join(__dirname, '..')
const child = spawn(electronPath, [appPath], {
  stdio: 'inherit',
  windowsHide: false,
})

child.on('close', code => {
  process.exit(code ?? 0)
})

child.on('error', error => {
  console.error('启动 DSH Melody Launcher 失败：', error)
  process.exit(1)
})
