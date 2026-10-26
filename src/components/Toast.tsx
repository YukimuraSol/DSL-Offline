import { CircleAlert, CircleCheck, X } from 'lucide-react'
import type { ToastState } from '../hooks/use-toast'

/** 右下角的短暂提示条。 */
export function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  return (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.kind === 'success' ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
      <span>{toast.message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><X size={15} /></button>
    </div>
  )
}
