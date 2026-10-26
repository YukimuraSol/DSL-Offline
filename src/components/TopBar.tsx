import { Minus, X } from 'lucide-react'
import { HOME_TABS } from '../lib/nav'
import type { HomeTab } from '../types'

/**
 * 全局顶栏（PCL2 式）：DSL 文字标记 + 居中一级导航 tab + 窗口键。
 * 整条可拖拽；按钮区 no-drag。
 * 栏目顺序在 src/lib/nav.ts 里定义（App 的挂载顺序同源）。
 */

interface TopBarProps {
  activeTab: HomeTab | null
  /** 正在运行的实例数：稿 v2 的启动页顶栏右侧是「● N 实例」胶囊。 */
  runningCount: number
  onSelectTab: (tab: HomeTab) => void
  onMinimize: () => void
  onClose: () => void
}

export function TopBar({ activeTab, runningCount, onSelectTab, onMinimize, onClose }: TopBarProps) {
  return (
    <header className="topbar">
      <span className="topbar-mark" aria-hidden="true">DSL</span>
      <nav className="topbar-tabs" aria-label="一级导航">
        {HOME_TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`topbar-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="topbar-right">
        {/* 稿 v2：启动页顶栏右侧是「● N 实例」胶囊；整合包页那份稿没有它（行里已经写了状态）。 */}
        {activeTab === 'start' && runningCount > 0 && (
          <span className="topbar-instance-pill"><span className="dot" />{runningCount} 实例</span>
        )}
        <button type="button" className="topbar-window-button" title="最小化" aria-label="最小化" onClick={onMinimize}><Minus size={17} /></button>
        <button type="button" className="topbar-window-close" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      </div>
    </header>
  )
}
