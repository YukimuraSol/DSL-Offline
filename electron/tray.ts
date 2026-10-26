import { Menu, Tray, app } from 'electron'

/**
 * 系统托盘：左键唤起主窗口，右键菜单提供显示与退出入口。
 * 关闭按钮只隐藏窗口，「退出」是唯一结束进程的入口。
 */

export interface TrayController {
  /** 首次隐藏到托盘时的一次性气泡提示。 */
  notifyBackground(): void
  /** 托盘提示文字：与窗口标题共用主进程那一份实例状态快照。 */
  setSummary(summary: string): void
  destroy(): void
}

interface CreateTrayOptions {
  iconPath: string
  showMainWindow: () => void
}

export function createTray(options: CreateTrayOptions): TrayController {
  const tray = new Tray(options.iconPath)
  tray.setToolTip('DSH 旋律启动器：序曲')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => options.showMainWindow() },
    { type: 'separator' },
    // 解耦之后「退出」只退启动器本身：正在运行的实例是独立进程，它们继续跑。
    { label: '退出启动器（实例继续运行）', click: () => app.quit() },
  ]))
  tray.on('click', () => options.showMainWindow())

  return {
    setSummary(summary) {
      if (tray.isDestroyed()) return
      tray.setToolTip(`DSH 旋律启动器：序曲 · ${summary}`)
    },
    notifyBackground() {
      if (tray.isDestroyed() || process.platform !== 'win32') return
      tray.displayBalloon({
        iconType: 'info',
        title: 'DSH 旋律启动器：序曲',
        content: '程序仍在后台运行，右键托盘图标可退出。',
      })
    },
    destroy() {
      // 退出前移除图标，避免通知区残留僵尸图标。
      tray.destroy()
    },
  }
}
