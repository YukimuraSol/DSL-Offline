import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const githubClientId = process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID ?? env.DSH_LAUNCHER_GITHUB_CLIENT_ID ?? ''
  return {
    define: {
      // Client ID 不是密钥；发布构建通过仓库 Variable 注入后写入主进程包。
      'process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID': JSON.stringify(githubClientId),
    },
    plugins: [
      react(),
      electron({
        main: {
          // 第二个入口是整合包打包 worker：导出时在 worker_threads 里跑 CRC/deflate，
          // 主进程只负责收进度事件。
          entry: ['electron/main.ts', 'electron/snapshot-pack-worker.ts'],
          vite: {
            define: {
              'process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID': JSON.stringify(githubClientId),
            },
          },
        },
        preload: {
          input: 'electron/preload.ts',
        },
      }),
    ],
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: false,
      // vendor/ 是 npm run fetch:node 解出来的随包 Node：Windows 会锁住刚落地的
      // node.exe，被 vite 的文件监视器碰上就是 EBUSY 直接崩进程。
      watch: {
        // .verify/ 与 release/ 同理：验证脚本会在仓库里建临时 userData、构建产物也在
        // 这里落地，浏览器与安装器会锁住其中文件，监视器一碰就是 EBUSY 崩掉 dev。
        ignored: [
          '**/vendor/**', '**/.verify/**', '**/release/**', '**/.tmp/**',
          // 原子写（编辑器 / 工具写的 write-file-atomic）会在源文件旁边建
          // `.styles.css.<pid>.<uuid>.tmpdir/`，写完立刻删。vite 的 watcher 正好在这个窗口里
          // 挂 watch 就是 EBUSY 崩整个 dev。用正则而不是 glob：这类目录名以点开头，
          // glob 的 * 在部分实现里不匹配 dotfile。
          /\.tmpdir($|[\\/])/,
        ],
      },
    },
    build: {
      sourcemap: true,
    },
  }
})
