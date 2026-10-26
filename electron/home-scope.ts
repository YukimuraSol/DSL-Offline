import path from 'node:path'
import { isSameOrInsidePath } from './settings'

/**
 * 「这个家目录归不归启动器管」的唯一判据。
 *
 * 存在的理由：启动器会整棵删 / 覆盖写家目录（删整合包、回滚快照、重放内核）。
 * 只要 dshHome 指到用户自己的 ~/.dsh（用户有权这么改，命令行部署的用户也常常这么用），
 * 那些删除就会越界删掉真实环境。这里做第二道防线：
 *
 *   - 只认启动器自己的地盘（userData 与整合包根目录）之内的路径；
 *   - **不拦「手动接管外部家目录」**：接管只登记不搬（见 pack-adopt.ts 文件头），
 *     不删不写外部目录，所以不需要过守卫；
 *   - 接管之后真要「删除那条包」，守卫会明确拒绝 —— 宁可报错，也不许删用户的外部目录。
 */

export interface HomeScope {
  /** 启动器私有目录（Electron 的 userData）。 */
  userData: string
  /** 整合包根目录（%LOCALAPPDATA%\dsh-launcher\dsh-packs 或用户自定义）。 */
  packsRoot: string
  /** 启动器托管的 DSH 内核根目录（<userData>/dsh-runtime）。 */
  managedDshRoot: string
}

function foldPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** home 是否落在启动器管理的目录之内。 */
export function isLauncherOwnedHome(home: string, scope: HomeScope): boolean {
  if (typeof home !== 'string' || !home.trim() || !path.isAbsolute(home)) return false
  return isSameOrInsidePath(home, scope.userData) || isSameOrInsidePath(home, scope.packsRoot)
}

/** 内核根目录的归属判定：内核只能放在启动器托管的 dshInstallPath 里。 */
export function isLauncherOwnedRuntime(target: string, scope: HomeScope): boolean {
  if (typeof target !== 'string' || !target.trim() || !path.isAbsolute(target)) return false
  return isSameOrInsidePath(target, scope.managedDshRoot)
}

/** 不在范围内就抛错（文案直接进界面/日志，要能指着说清是哪一步被拒）。 */
export function assertLauncherOwnedHome(home: string, scope: HomeScope, action: string): void {
  if (isLauncherOwnedHome(home, scope)) return
  throw new Error(`拒绝执行「${action}」：${foldPath(home)} 不在启动器管理的目录内。启动器只管理自己的 dsh-home 与整合包目录（${foldPath(scope.userData)}、${foldPath(scope.packsRoot)}），不会删改外部家目录（例如 ~/.dsh）。如果这是你手动接管的命令行环境，删包请自行处理那个目录。`)
}

/** 同上，用于内核目录（scope 换成 dshInstallPath）。 */
export function assertLauncherOwnedRuntime(target: string, scope: HomeScope, action: string): void {
  if (isLauncherOwnedRuntime(target, scope)) return
  throw new Error(`拒绝执行「${action}」：${foldPath(target)} 不在启动器托管的 DSH 目录内（${foldPath(scope.managedDshRoot)}）。`)
}
