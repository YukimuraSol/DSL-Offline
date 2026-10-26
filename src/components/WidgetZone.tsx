import { Check, Copy, EthernetPort } from 'lucide-react'
import { useEffect, useState } from 'react'
import { copyText } from '../lib/clipboard'

/**
 * 启动页右栏唯一的卡片：开放端口。
 * 端口属于**当前这个实例**（写进 instances.json 该包那一格，跨重启记得），
 * 不是全局 settings.webPort；复制按钮复制的是运行中那条带 token 的本地网址。
 */
export interface WidgetZoneProps {
  /** 当前实例的网页端口；还没登记过端口时为 null。 */
  webPort: number | null
  /** 提交新端口（失焦 / 回车时调用）。返回是否真的存下；被驳回（如实例运行中）时 false，输入框要回退。 */
  onSaveWebPort: (port: number) => Promise<boolean>
  /** 运行中的带 token 本地网址；未运行为 null。 */
  runtimeUrl: string | null
  running: boolean
  busy: boolean
}

export function WidgetZone({ webPort, onSaveWebPort, runtimeUrl, running, busy }: WidgetZoneProps) {
  const shown = webPort == null ? '' : String(webPort)
  const [draft, setDraft] = useState(shown)
  const [copied, setCopied] = useState(false)

  useEffect(() => { setDraft(shown) }, [shown])

  const commit = async () => {
    const next = Number.parseInt(draft, 10)
    if (!Number.isInteger(next) || next < 1 || next > 65535) { setDraft(shown); return }
    if (next === webPort) return
    // 没存下（例如实例运行中被驳回）就把输入框拨回真实端口，别留着那个没生效的数字。
    if (!(await onSaveWebPort(next))) setDraft(shown)
  }

  const copyLink = () => {
    if (!runtimeUrl) return
    void copyText(runtimeUrl).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="widget-zone">
      <div className="widget-card">
        <header className="widget-card-head">
          <span className="widget-card-icon"><EthernetPort size={15} /></span>
          <span>开放端口</span>
          <span className="widget-card-actions">
            <small className="widget-card-meta">{busy ? 'bind 中' : running ? '运行中' : '未启动'}</small>
          </span>
        </header>
        <div className="widget-card-body">
          <div className="port-main">
            <span className="port-k">端口</span>
            <span className="port-edit">
              <input
                value={draft}
                inputMode="numeric"
                maxLength={5}
                aria-label="端口号"
                onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commit}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              />
            </span>
            <button
              type="button"
              className={copied ? 'port-copy is-copied' : 'port-copy'}
              onClick={copyLink}
              disabled={!runtimeUrl}
              title={runtimeUrl ? '复制这个实例的网页地址（带 token）' : '先启动实例，才有带 token 的地址可复制'}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
