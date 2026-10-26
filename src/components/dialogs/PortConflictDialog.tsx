import { PlugZap } from 'lucide-react'
import type { PortConflictPrompt } from '../../types'
import { ModalShell } from './ModalShell'

/**
 * 端口被占用时的询问（缺陷 7）。
 *
 * 启动器不再静默往后换端口——换完用户找不到服务，旧的 DSH 还占着同一份家目录。
 * 这里把占用者摊开给用户看，由他决定要不要结束进程；默认动作是「不结束」。
 */

export interface PortConflictDialogProps {
  prompt: PortConflictPrompt
  onAnswer: (accepted: boolean) => void
}

export function PortConflictDialog({ prompt, onAnswer }: PortConflictDialogProps) {
  return (
    <ModalShell
      className="port-conflict-dialog"
      titleId="port-conflict-title"
      icon={<PlugZap size={19} />}
      title={`端口 ${prompt.port} 已被占用`}
      onClose={() => onAnswer(false)}
      dismissOnBackdrop={false}
      footer={<>
        <button type="button" className="secondary-button" onClick={() => onAnswer(false)}>取消启动</button>
        <button type="button" className="primary-command" onClick={() => onAnswer(true)}>结束这些进程并重试</button>
      </>}
    >
      <p className="port-conflict-lead">
        启动器需要端口 {prompt.port}，但它正被下面的进程占着。结束它们会丢掉这些进程里未保存的东西。
      </p>
      <ul className="port-conflict-owners">
        {prompt.owners.map((owner, index) => (
          <li key={`${owner.pid}:${index}`}>
            {owner.pid > 0 ? `PID ${owner.pid}` : '未知 PID'} · {owner.name}
            {/* 端口在标题里，PID 与进程名在上行；这里补「疑似属于哪个整合包」，用户才认得出是哪个实例。 */}
            {owner.packName && <span className="port-conflict-pack">疑似整合包「{owner.packName}」</span>}
            {owner.path && <span className="port-conflict-path">{owner.path}</span>}
          </li>
        ))}
      </ul>
      <p className="port-conflict-hint">
        选「结束这些进程并重试」只会按 PID 结束上面列出的进程；结束后端口仍绑不上时会直接报错，不会再偷偷换端口。
      </p>
    </ModalShell>
  )
}
