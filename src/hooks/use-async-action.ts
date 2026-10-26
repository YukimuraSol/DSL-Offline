import { useCallback, useState } from 'react'
import { errorText } from '../lib/format'
import type { ToastState } from './use-toast'

/**
 * 「标记忙碌 → 执行 → 成功提示 / 失败提示 → 解除忙碌」这套流程
 * 原本在六个动作里各写了一遍。这里收敛为一处。
 *
 * busy 保存的是当前忙碌动作的标识，组件据此只禁用相关按钮而不是整个界面。
 */

/** 全局动作的忙碌标识。插件级动作直接用包名。 */
export const BUSY = {
  runtime: 'runtime',
  dshInstall: 'dsh-install',
  settings: 'settings',
  credential: 'credential',
  reorder: 'reorder',
} as const

export interface RunOptions<T> {
  /** 成功后的提示文案，可根据结果动态生成。 */
  success?: string | ((result: T) => string)
  /** 自定义失败处理；不提供则默认弹出错误提示。 */
  onError?: (error: unknown) => void
}

export function useAsyncAction(showToast: (toast: ToastState) => void) {
  const [busy, setBusy] = useState<string | null>(null)

  const run = useCallback(async <T>(
    key: string,
    action: () => Promise<T>,
    options: RunOptions<T> = {},
  ): Promise<T | undefined> => {
    setBusy(key)
    try {
      const result = await action()
      if (options.success !== undefined) {
        showToast({
          kind: 'success',
          message: typeof options.success === 'function' ? options.success(result) : options.success,
        })
      }
      return result
    } catch (error) {
      if (options.onError) options.onError(error)
      else showToast({ kind: 'error', message: errorText(error) })
      return undefined
    } finally {
      setBusy(null)
    }
  }, [showToast])

  return { busy, run }
}
