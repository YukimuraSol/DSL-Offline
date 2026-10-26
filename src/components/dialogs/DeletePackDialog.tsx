import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ModalShell } from './ModalShell'

/**
 * 「删除整合包」确认窗（1.0.22）。
 *
 * 二次确认从列表行里的「再点一次」搬进弹窗：行内两段式只能塞一句口语提示，
 * 说不清到底删掉哪些东西。这里两句书面语把范围讲完，运行中的实例再多一行现状说明
 * （不是额外门槛：点删除就会先停它再删）。
 *
 * 尺寸与骨架照 CreatePackDialog：560 宽、14 圆角、ModalShell 的头（红底垃圾桶 + 标题 + ×）
 * 与底部一行按钮；红底删除按钮用 --danger 变量，浅色/夜间各自取值。
 */

export interface DeletePackDialogProps {
  /** 目标整合包 id（正文里就是它）。 */
  packId: string
  /** 该实例此刻是否在运行：为真时正文追加一行「删除前会先停止它」。 */
  running: boolean
  /** 主进程正忙（安装/启动实例等）时禁用删除按钮。 */
  busy?: boolean
  /** 确认删除；返回 false = 没删成（弹窗留在原地，错误由 store 的 toast 报告）。 */
  onConfirm(): Promise<boolean>
  onClose(): void
}

export function DeletePackDialog(props: DeletePackDialogProps) {
  const { packId, running, busy = false, onConfirm, onClose } = props
  const [deleting, setDeleting] = useState(false)
  const canDelete = !deleting && !busy

  async function confirm(): Promise<void> {
    if (!canDelete) return
    setDeleting(true)
    try {
      if (await onConfirm()) onClose()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <ModalShell
      className="delete-dialog"
      titleId="pack-delete-title"
      icon={<span className="delete-icon"><Trash2 size={17} /></span>}
      title="删除整合包"
      onClose={onClose}
      closeDisabled={deleting}
      footer={(
        <>
          <button type="button" className="secondary-button" onClick={onClose} disabled={deleting}>取消</button>
          <button type="button" className="primary-command danger-solid" onClick={() => { void confirm() }} disabled={!canDelete}>
            {deleting ? '删除中…' : '删除'}
          </button>
        </>
      )}
    >
      <p className="delete-line">将删除 {packId}。</p>
      <p className="delete-line secondary">该实例包含的插件、技能、预设、会话记录、凭据与附件将一并移除，此操作不可撤销。</p>
      {running && <p className="delete-running">该实例正在运行，删除前会先停止它。</p>}
    </ModalShell>
  )
}
