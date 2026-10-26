import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastState {
  kind: 'success' | 'error'
  message: string
}

const TOAST_DURATION = 4200

/** 短暂提示条。同一时刻只显示一条，新提示会顶掉旧的并重置计时。 */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<number | null>(null)

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const showToast = useCallback((next: ToastState) => {
    clearTimer()
    setToast(next)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setToast(current => (current === next ? null : current))
    }, TOAST_DURATION)
  }, [])

  const dismissToast = useCallback(() => {
    clearTimer()
    setToast(null)
  }, [])

  useEffect(() => clearTimer, [])

  return { toast, showToast, dismissToast }
}
