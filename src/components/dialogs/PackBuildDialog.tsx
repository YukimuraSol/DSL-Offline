import { Check, ChevronDown, Copy, LoaderCircle, Package } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { resolveLauncherApi } from '../../api/client'
import { copyText } from '../../lib/clipboard'
import { exportPrompt } from '../../lib/prompts'
import type { PackExtras, PackSource, PackStatus, WorkbenchStatus } from '../../types'
import { ModalShell } from './ModalShell'

/** 「当前对话所在实例」不是整合包：它指这次对话跑着的那一个（= 当前激活的整合包）。 */
const CURRENT = 'current'

/** 包的来源：注册表里存的是 ASCII 枚举，框里要印的是人话（别把 zip / manifest 直接给用户看）。 */
const SOURCE_LABEL: Record<PackSource, string> = {
  created: '新建',
  zip: '压缩包',
  manifest: '整合包',
  raw: '目录导入',
  snapshot: '快照',
}

export interface PackBuildDialogProps {
  packs: PackStatus[]
  /** 当前激活的整合包：标题栏入口默认选它，也是「当前对话所在实例」指向的那一个。 */
  activePackId: string | null
  /** 行内入口带进来的实例 id；null = 走默认（当前激活的整合包）。 */
  preselectedPackId: string | null
  runningPackIds: string[]
  runningPorts: Record<string, number | null>
  /** 本机已装的 DSH 版本：内核这一件的要求是「包绑定的版本本机装着」。 */
  installedDshVersions: string[]
  /** 提示词要用的两个真路径（主进程给；取不到就是空串，提示词自己会退回不写绝对路径）。 */
  exportDir: string
  launcherExe: string
  onClose(): void
}

/**
 * 制作整合包（稿 lch-build）。
 *
 * 这一屏只做两件事：选目标实例、把装配进度照实显示出来。
 * 进度全部来自后台装配运行目录里的 status.json（经 IPC 读），**读不到就不显示进度**：
 * 核心行写「未检测」、不放进度条、插件区一行「尚未开始装配」——不拿假数据把界面填满。
 */
export function PackBuildDialog(props: PackBuildDialogProps) {
  const { packs, activePackId, preselectedPackId, runningPackIds, runningPorts, installedDshVersions, exportDir, launcherExe, onClose } = props

  // 行内入口把 id 带进来；标题栏入口没带，就落在当前激活的整合包上。
  const [target, setTarget] = useState<string>(() => {
    const preset = [preselectedPackId, activePackId].find(id => id != null && packs.some(pack => pack.id === id))
    return preset ?? CURRENT
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<WorkbenchStatus | null>(null)
  /** 附件目录（<家目录>/extras）探测结果：null = 还没读到 / 读不到（界面写「附件 —」，不猜条数）。 */
  const [extras, setExtras] = useState<PackExtras | null>(null)
  const selectRef = useRef<HTMLDivElement>(null)

  // 装配是后台跑的：弹窗开着的时候每 1.2s 读一拍。读不到（null）就一直是空闲态。
  useEffect(() => {
    let alive = true
    const read = () => {
      try {
        void resolveLauncherApi().readWorkbenchStatus().then(
          next => { if (alive) setStatus(next) },
          // 单拍失败不改写上一拍：接口抖一下不该让界面从「装配中」跳回「未开始」。
          () => undefined,
        )
      } catch {
        // API 还没初始化（浏览器演示模式）：停在空闲态。
      }
    }
    read()
    const timer = window.setInterval(read, 1200)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  // 点框外面收起菜单（点框本身由 onClick 自己切换，这里放行）。
  useEffect(() => {
    if (!menuOpen) return undefined
    const onMouseDown = (event: MouseEvent) => {
      if (!selectRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [menuOpen])

  const activePack = packs.find(pack => pack.id === activePackId) ?? null
  const selectedPack = target === CURRENT ? activePack : packs.find(pack => pack.id === target) ?? null
  const selectedName = target === CURRENT ? '当前对话所在实例' : selectedPack?.name ?? target
  const selectedId = selectedPack?.id ?? null
  const selectedRunning = selectedPack ? runningPackIds.includes(selectedPack.id) : false

  // 附件目录只在换实例时读一次。
  // ponytail: 不跟 1.2s 的进度轮询一起读 —— 用户随时会往 extras/ 里丢东西，
  // 但一次 readdir 顶层已经够便宜；真需要实时再挂到轮询上。
  useEffect(() => {
    setExtras(null)
    if (!selectedId) return undefined
    let alive = true
    try {
      void resolveLauncherApi().readPackExtras(selectedId).then(
        next => { if (alive && next) setExtras(next) },
        () => undefined,
      )
    } catch {
      // API 还没初始化（浏览器演示模式）：停在「附件 —」。
    }
    return () => { alive = false }
  }, [selectedId])

  /** 单行状态灰字：「运行中 · 3080」或「未启动」。 */
  const stateText = (pack: PackStatus | null): string => {
    if (!pack || !runningPackIds.includes(pack.id)) return '未启动'
    const port = runningPorts[pack.id]
    return port == null ? '运行中' : `运行中 · ${port}`
  }

  // 提示词跟选择走；没有可导出的包（列表空 / 还没激活任何包）时按钮禁用，不编一份空的出来。
  const prompt = selectedPack ? exportPrompt(selectedPack.name, selectedPack.plugins.length, exportDir, selectedPack.id, launcherExe) : ''

  /**
   * 导出前三件：核心（包绑定的 DSH 版本本机装着）、插件（至少有一个）、
   * 附件（目录得在，可以是空的）。
   *
   * 没有「槽位」这件：那是装配工作台的独占锁，和导出无关；包的 state 也不是缺件，
   * 不因为它没装完整就拦人。附件还没读到（null）不算缺件 —— 只看得到的事实才拦人。
   * 附件 = <家目录>/extras/（启动器「附件」按钮打开的那个），不是对话上传的 attachments/。
   * 权威判定在 electron/workbench.ts 的装配前置检查里，这里只是界面侧的预检。
   */
  const missing: string[] = []
  if (!selectedPack?.dshVersion || !installedDshVersions.includes(selectedPack.dshVersion)) missing.push('核心')
  if (!selectedPack || selectedPack.plugins.length === 0) missing.push('插件')
  if (extras && !extras.exists) missing.push('附件')

  const copyDisabled = !prompt || missing.length > 0
  const copyTitle = missing.length > 0
    ? `缺少${missing.join('、')}，导出会被拒绝`
    : prompt ? '复制发给 agent 的导出提示词' : '先选一个目标实例'

  /**
   * 附件行：条目数口径与整合包列表行的「· 附件 N」一致（顶层条目数，子目录算 1 条）。
   * 只有一条：没有就说「没有附件」，目录不在就说「目录不存在」，不显示路径、不带体积。
   */
  const attachText = !extras
    ? '—'
    : !extras.exists
      ? '目录不存在'
      : extras.count === 0
        ? '没有附件'
        : `${extras.count} 个文件`

  function copyPrompt(): void {
    if (copyDisabled) return
    void copyText(prompt).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  /** 打开附件目录：走既有的 packs:open-extras（主进程会按需建目录）。 */
  function openAttachments(): void {
    if (!selectedId) return
    try {
      void resolveLauncherApi().openPackExtras(selectedId).catch(() => undefined)
    } catch {
      // API 还没初始化：没得可开。
    }
  }

  /** 打开导出目录：packs:open-export-dir，主进程同样按需建目录；与选中的包无关。 */
  function openExportFolder(): void {
    try {
      void resolveLauncherApi().openPackExportDir().catch(() => undefined)
    } catch {
      // API 还没初始化：没得可开。
    }
  }

  // 核心一行：引擎判 ok 且有版本才说「已就绪」，否则老实写未检测（绿点也跟着只在就绪时出现）。
  // 文案统一叫「核心」（用户对这件东西的称呼），标识符仍是 kernel。
  const kernelReady = status?.kernel.state === 'ok' && Boolean(status.kernel.version)
  const kernelText = kernelReady && status ? `核心 ${status.kernel.version} · 已就绪` : '核心 · 未检测'

  /**
   * 右侧那行：跑着的阶段一律「装配中」；收尾后换成「已完成 / 已停止」——
   * 一个早就跑完（或被卡住）的 status.json 继续显示「装配中」+ 滑动进度条，就是在演进度。
   * 引擎写的 reason 不显示：里面是带绝对路径的排查话术。
   */
  const terminal = status?.phase === 'done' || status?.phase === 'blocked' || status?.phase === 'failed'
  const phaseText = !status ? '' : status.phase === 'done' ? '已完成' : terminal ? '已停止' : '装配中'
  const chipDelay = (index: number) => `${Math.min(index, 12) * 60}ms`

  return (
    <ModalShell
      className="build-dialog"
      titleId="pack-build-title"
      icon={<span className="build-icon"><Package size={17} /></span>}
      title="制作整合包"
      onClose={onClose}
    >
      <div className="build-select">
        <span className="build-select-label">选择目标实例</span>
        {/* 框与菜单同一个定位容器：菜单 left/right 0 就是框的宽度。 */}
        <div className="build-select-field" ref={selectRef}>
          <button
            type="button"
            className="build-select-box"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}
          >
            <span className="build-select-name">{selectedName}</span>
            {selectedPack && (
              <span className="build-select-meta">
                {selectedPack.plugins.length} 插件 · {SOURCE_LABEL[selectedPack.source] ?? selectedPack.source}
              </span>
            )}
            {/* 未启动不带绿点：只有真在跑才给状态点，别让「未启动」也看起来是活的。 */}
            <span className="build-select-state">
              {selectedRunning && <span className="build-dot is-steady" aria-hidden="true" />}
              {stateText(selectedPack)}
            </span>
            <ChevronDown size={14} className="build-select-caret" />
          </button>
          {menuOpen && (
            <div className="build-menu" role="listbox" aria-label="选择目标实例">
              <div className="build-menu-list">
                {packs.map(pack => (
                  <button
                    key={pack.id}
                    type="button"
                    role="option"
                    aria-selected={target === pack.id}
                    className={'build-menu-row' + (target === pack.id ? ' is-selected' : '')}
                    onClick={() => { setTarget(pack.id); setMenuOpen(false) }}
                  >
                    <span className="build-menu-copy">
                      <strong>{pack.name}</strong>
                      <span>{stateText(pack)}</span>
                    </span>
                    {target === pack.id && <Check size={14} className="build-menu-check" />}
                  </button>
                ))}
              </div>
              <div className="build-menu-sep" role="presentation" />
              <button
                type="button"
                role="option"
                aria-selected={target === CURRENT}
                className={'build-menu-row' + (target === CURRENT ? ' is-selected' : '')}
                onClick={() => { setTarget(CURRENT); setMenuOpen(false) }}
              >
                <span className="build-menu-copy">
                  <strong>当前对话所在实例</strong>
                  <span>通用对话</span>
                </span>
                {target === CURRENT && <Check size={14} className="build-menu-check" />}
              </button>
            </div>
          )}
        </div>
        {/* title 挂在 span 上：禁用的 button 在 Chromium 里不弹原生 tooltip。 */}
        <span className="build-copy-wrap" title={copyTitle}>
          <button
            type="button"
            className={'build-copy' + (copied ? ' is-copied' : '')}
            onClick={copyPrompt}
            disabled={copyDisabled}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制提示词'}
          </button>
        </span>
      </div>

      <div className="build-divider" role="presentation" />

      <div className="build-progress">
        <div className="build-progress-head">
          <span className="build-kernel">
            {kernelReady && <span className="build-dot" aria-hidden="true" />}
            {kernelText}
          </span>
          {status && (
            <span className="build-phase">
              <span className={'build-dot' + (terminal ? ' is-steady' : '')} aria-hidden="true" />
              {phaseText}
            </span>
          )}
        </div>

        {/* 不定态进度条只在真的跑着时出现：停了就不该有东西还在滑。 */}
        {status && !terminal && <div className="build-bar" role="progressbar" aria-label="装配进度"><span /></div>}

        {status ? (
          <div className="build-plugins">
            {status.passed.map((name, index) => (
              <span key={name + ':' + index} className="build-chip" style={{ animationDelay: chipDelay(index) }}>{name}</span>
            ))}
            {/* 最后一个永远是「正在核验」那一个：白色虚线边 + 转圈。 */}
            {status.current && (
              <span className="build-chip is-checking" style={{ animationDelay: chipDelay(status.passed.length) }}>
                <LoaderCircle size={11} className="spin" />{status.current}
              </span>
            )}
          </div>
        ) : (
          <p className="build-plugins-empty">尚未开始装配</p>
        )}
      </div>

      {/* 附件与导出并成一行：标签 │ 条目数，右侧两个入口。路径不显示（一行放不下，也没什么可读的）。 */}
      <div className="build-attach">
        <span className="build-attach-row">
          <span className="build-attach-label">附件</span>
          <span className="build-attach-sep" role="presentation" />
          <span className={'build-attach-value' + (extras && !extras.exists ? ' is-missing' : '')}>{attachText}</span>
        </span>
        <span className="build-attach-actions">
          <button
            type="button"
            className="secondary-button build-attach-btn"
            onClick={openAttachments}
            disabled={!selectedId}
          >打开附件文件夹</button>
          <button type="button" className="secondary-button build-attach-btn" onClick={openExportFolder}>打开导出文件夹</button>
        </span>
      </div>
    </ModalShell>
  )
}
