// 一级导航栏目的单一来源：数组顺序即顶栏从左到右的显示顺序。
// 顶栏（TopBar）与 keep-mounted 渲染顺序（App）都必须从这里取，
// 否则会出现「顺序改了但页面挂载顺序没改」的两份硬编码不同步问题。

import type { HomeTab } from '../types'

export interface HomeTabDefinition {
  id: HomeTab
  label: string
}

/** 离线整合包启动器只有两页：启动 + 整合包。 */
export const HOME_TABS: ReadonlyArray<HomeTabDefinition> = [
  { id: 'start', label: '启动' },
  { id: 'packs', label: '整合包' },
]

/** 面板挂载顺序，派生自 HOME_TABS。 */
export const HOME_TAB_ORDER: HomeTab[] = HOME_TABS.map(tab => tab.id)
