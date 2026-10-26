import { Check, CircleAlert, CircleCheck, Copy, Clock, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { copyText } from '../../lib/clipboard'
import type { PackVerifyReport } from '../../types'
import { ModalShell } from './ModalShell'

/**
 * 自检输入：report 是主进程 packs:verify 的返回值（electron/pack-verify.ts 的 PackVerifyReport），
 * 界面只做映射，不再自己推导结论。
 */
export interface PackVerifyInput {
  /** 被检查的整合包 id；「重新自检」用它再跑一次（主进程按它找家目录）。 */
  packId: string
  packName: string
  pluginCount: number
  /** null = 自检还在跑（或没跑起来，见 error）；主进程返回后填进来。 */
  report: PackVerifyReport | null
  /** 主进程跑不起来时的错误（家目录读不到等）；null = 没出错。 */
  error?: string | null
}

interface VerifyCheck {
  id: string
  title: string
  detail?: string
  ok: boolean
  /** 处置标签：通过 / 建议修 / 对不上号 / 跳过。 */
  tag?: string
  tagKind?: 'ok' | 'agent' | 'self'
}

/** 把主进程的六条检查映射成这一层的形状；warn 算「建议修」，只有 fail 算对不上号。 */
function reportChecks(report: PackVerifyReport): VerifyCheck[] {
  return report.checks.map(check => {
    const tag = check.status === 'pass'
      ? '通过'
      : check.status === 'warn'
        ? '建议修'
        : check.status === 'skip'
          ? '跳过'
          : '对不上号'
    const tagKind: 'ok' | 'agent' | 'self' = check.status === 'warn' ? 'agent' : check.status === 'fail' ? 'self' : 'ok'
    const findings = check.findings.slice(0, 3).join('；')
    return {
      id: String(check.id),
      title: check.title,
      detail: [check.detail, findings].filter(Boolean).join(' '),
      ok: check.status === 'pass' || check.status === 'skip',
      tag,
      tagKind,
    }
  })
}

export interface PackVerifyDialogProps {
  input: PackVerifyInput
  onClose(): void
  /** 「重新自检」：再跑一次 packs:verify。 */
  onRecheck?(): void
}

/**
 * 自检报告（稿 lch-verify）。
 *
 * 启动器不改用户的文件，所以这里只给判定、逐条原因和一段照做的修复提示词。
 * 提示词优先用主进程 buildPrompt 生成的那份（它知道具体是哪个插件、哪条链接）。
 */
export function PackVerifyDialog(props: PackVerifyDialogProps) {
  const { input, onClose, onRecheck } = props
  const [copied, setCopied] = useState(false)
  const report = input.report
  const checks = useMemo(() => (report ? reportChecks(report) : []), [report])
  const problems = checks.filter(check => !check.ok)
  // 提示词只用主进程 buildPrompt 生成的那一份；没生成就是没有（用户拍板不留兜底）。
  const prompt = report?.prompt ?? ''
  const copyDisabled = report === null || prompt === ''

  function copyPrompt(): void {
    if (!prompt) return
    void copyText(prompt).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <ModalShell
      className="verify-dialog"
      titleId="pack-verify-title"
      icon={<ShieldCheck size={19} />}
      title={<>{'自检：' + input.packName}{input.pluginCount > 0 && <span className="head-meta">本机 · {input.pluginCount} 个插件</span>}</>}
      onClose={onClose}
      footer={<>
        <span className="footer-note">
          <Clock size={13} />
          自检只读：只看清单、链接、入口与内核版本，不改动这个包，也不看 extras/。
        </span>
        <button type="button" className="secondary-button" onClick={onRecheck} disabled={!onRecheck}>
          <RefreshCw size={13} />重新自检
        </button>
        <button type="button" className={'primary-command' + (copied ? ' is-copied' : '')} onClick={copyPrompt} disabled={copyDisabled}>
          {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制修复提示词'}
        </button>
      </>}
    >
      {report === null ? (
        <div className="verdict">
          {input.error ? <TriangleAlert size={18} /> : <LoaderCircle size={18} className="spin" />}
          <div className="verdict-copy">
            <strong>{input.error ? '自检没跑起来' : '正在自检…'}</strong>
            <span>{input.error ?? '正在读这个包的家目录、对清单与链接，跑完会自动更新。'}</span>
          </div>
          <span className="verdict-count">{input.error ? '失败' : '进行中'}</span>
        </div>
      ) : (
        <>
          <div className={report.ok && problems.length === 0 ? 'verdict ok' : 'verdict'}>
            {report.ok ? <CircleCheck size={18} /> : <TriangleAlert size={18} />}
            <div className="verdict-copy">
              <strong>{report.verdict}</strong>
              <span>
                {report.ok
                  ? '清单、目录、链接与内核版本都对得上，这个包可以直接启动。'
                  : '插件放在运行目录里是正常做法，只有清单里查不到出处的家伙才需要挪进包内的内置目录。'}
              </span>
            </div>
            <span className="verdict-count">{problems.length === 0 ? '全部通过' : problems.length + ' 处待处理'}</span>
          </div>

          <div className="check-list">
            {checks.map(check => (
              <div key={check.id} className={check.ok ? 'check-row' : 'check-row bad'}>
                <span className={'check-mark ' + (check.ok ? 'ok' : 'bad')}>
                  {check.ok ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
                </span>
                <div className="check-copy">
                  <strong>{check.title}</strong>
                  {check.detail && <span>{check.detail}</span>}
                </div>
                <span className={'check-tag ' + (check.tagKind ?? 'ok')}>{check.tag}</span>
              </div>
            ))}
          </div>

          <div className="prompt-card">
            <div className="prompt-head">
              <ShieldCheck size={15} />
              <span className="prompt-title">
                修这个实例
                <small>启动器不动你的文件，只给出照做的步骤</small>
              </span>
            </div>
            <pre className="prompt-body">{prompt || '自检没有发现需要修的地方，这段提示词用不上。'}</pre>
          </div>
        </>
      )}
    </ModalShell>
  )
}
