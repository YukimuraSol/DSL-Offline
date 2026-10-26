import { Check, CircleAlert, Download, FileArchive, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { resolveLauncherApi } from '../../api/client'
import { failureReason, folderNameIssue, IMPORT_STAGE_TEXT, instanceNameIssue, packDirName } from '../../lib/pack-import'
import type { PackImportRequest, PackImportStage, PackStatus } from '../../types'
import { ModalShell } from './ModalShell'

export interface PackImportDialogProps {
  /** 现有实例：只用来判断「这个文件夹/这个名字是不是已经用过了」。 */
  packs: PackStatus[]
  /** 装配成功：外层刷新整合包列表（新实例得出现在列表里）。 */
  onImported?(): void
  onClose(): void
}

/** idle = 还没开始（可导入）；running = 正在装配；done / stopped = 已经收口。 */
type Phase = 'idle' | 'running' | 'done' | 'stopped'

/**
 * 导入整合包（只收一个 .zip 压缩包）。
 *
 * 一屏只做一件事：选包 → 给它取个名字 → 看着它装完。四条界面约定：
 *   1. 导入**永远是新建实例**，没有「装到哪个现有实例」这个选项。
 *   2. 文件夹名与实例名分开：文件夹名决定磁盘上的包标识（只收字母数字点横线，落盘是 pack-<文件夹名>），
 *      实例名只是列表里给人看的名字，允许中文。默认同名，改起来互不影响。
 *   3. 进度条是**不定态**的，不显示百分比、不显示 x/y：核心并不按插件数推进，
 *      写个假百分比比不写更坏。具体到哪一步由右上角那行小字给（主进程推阶段码）。
 *   4. 失败只说一句人话，**不写绝对路径**；要排查去看日志（主进程那边日志带全路径）。
 */
export function PackImportDialog(props: PackImportDialogProps) {
  const { packs, onImported, onClose } = props

  const [packDir, setPackDir] = useState('')
  /** 文件夹名（磁盘上的包标识 = Profile 名）。选包后默认取压缩包文件名，用户可改，改了就传下去。 */
  const [folder, setFolder] = useState('')
  const [folderTouched, setFolderTouched] = useState(false)
  /** 实例显示名。默认跟着文件夹名走，用户改过就不再跟随。 */
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [stage, setStage] = useState<PackImportStage | null>(null)
  const [reason, setReason] = useState('')
  const [picking, setPicking] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  /** 拖拽进入高亮：用计数器而不是布尔，否则子元素之间移动会闪。 */
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)

  // 阶段事件：主进程每跨一个阶段推一次（安装阶段会连推很多条，主进程已经去过重）。
  useEffect(() => {
    let alive = true
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = resolveLauncherApi().onOfflinePackProgress(progress => {
        if (alive) setStage(progress.stage)
      })
    } catch {
      // API 还没初始化（浏览器演示模式）：没有进度推送，界面照样能用。
    }
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [])

  const running = phase === 'running'
  const done = phase === 'done'
  const folderName = folder.trim()
  const instanceName = name.trim()
  // 两条即时检查：文件夹名派不出好标识 / 已经导入过；实例名空、太长、撞名。
  // 真正的判定都在主进程（那边拼磁盘目录名、写 packs.json），这里只是让按钮别指向一个必然失败的动作。
  // 文件夹名可编辑：填什么就传什么（PackImportRequest.folderName），主进程按同一口径复核后才落盘。
  const folderIssue = packDir
    ? (folderName ? folderNameIssue(folderName, packs.map(pack => pack.id)) : '先给新实例填个文件夹名。')
    : null
  const nameIssue = packDir ? instanceNameIssue(instanceName, packs.map(pack => pack.name)) : null
  const issue = folderIssue ?? nameIssue
  const canImport = packDir !== '' && issue === null

  /** 选包收尾：路径一落地就把默认文件夹名 / 实例名填上（各自被手工改过就不再跟随）。 */
  function applyPickedPath(next: string | null): void {
    if (!next) return
    const suggested = packDirName(next)
    setPackDir(next)
    // 两格互不影响：只填用户还没动过的那一个，改过的保持原样。
    if (!folderTouched) setFolder(suggested)
    if (!nameTouched) setName(suggested)
  }

  async function pickZip(): Promise<void> {
    setPicking(true)
    try {
      applyPickedPath(await resolveLauncherApi().pickOfflinePackZip())
    } catch {
      // 同上：选择框没开出来就当没选。
    } finally {
      setPicking(false)
    }
  }

  /** 拖 .zip 或文件夹进来都认：路径由 preload 的 webUtils 还原，目录也能拿到。 */
  function dropPickedPath(event: React.DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    try {
      applyPickedPath(resolveLauncherApi().getDroppedFilePath(file))
    } catch {
      // 不是本地真实路径（比如浏览器演示模式）：不猜，维持未选。
    }
  }

  async function startImport(): Promise<void> {
    if (!canImport || running || done) return
    const request: PackImportRequest = { packDir, name: instanceName, folderName }
    setPhase('running')
    setStage(null)
    setReason('')
    setCancelling(false)
    try {
      const outcome = await resolveLauncherApi().importOfflinePack(request)
      if (outcome.ok) {
        setStage('done')
        setPhase('done')
        onImported?.()
        return
      }
      setPhase('stopped')
      setReason(outcome.reason)
    } catch (error) {
      // 主进程的互斥守卫（同时有安装 / 装配在跑）会抛中文错误；其余一律收敛成人话。
      setPhase('stopped')
      setReason(failureReason(error))
    }
  }

  function cancelImport(): void {
    if (!running) {
      onClose()
      return
    }
    // 尽力而为：核心没有中断信号，主进程会在下一个阶段边界停下并自己清理半成品。
    setCancelling(true)
    try {
      void resolveLauncherApi().cancelOfflinePackImport()
    } catch {
      // 取消通道不通也不影响结果：startImport 那边迟早会收口。
    }
  }

  return (
    <ModalShell
      className="import-dialog"
      titleId="pack-import-title"
      icon={<span className="import-icon"><Download size={17} /></span>}
      title="导入整合包"
      closeDisabled={running}
      onClose={cancelImport}
      footer={<>
        <button type="button" className="secondary-button" onClick={cancelImport}>{running ? (cancelling ? '正在停止' : '取消') : '关闭'}</button>
        <button
          type="button"
          className="primary-command"
          disabled={running || done || !canImport}
          onClick={() => { void startImport() }}
        >
          {running ? <><LoaderCircle size={14} className="spin" />正在装配</> : '导入'}
        </button>
      </>}
    >
      {/* 整块都能接拖拽：.zip 与文件夹都认（拖拽走的是同一条装配路径）；
          选择框只留一个「选择压缩包」——压缩包是给用户的唯一导入入口。 */}
      <div
        className={`import-dropzone${dropping ? ' is-dropping' : ''}`}
        onDragEnter={event => {
          if (!event.dataTransfer?.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current += 1
          if (dragDepth.current === 1) setDropping(true)
        }}
        onDragOver={event => {
          if (!event.dataTransfer?.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={event => {
          if (!event.dataTransfer?.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDropping(false)
        }}
        onDrop={dropPickedPath}
      >
      {/* 1. 选整合包：整条路径放在只读输入框里（超长省略），「选择压缩包」在右。 */}
      <div className="import-row">
        <span className="import-label">选择整合包</span>
        <input
          className="import-field import-path"
          value={packDir}
          readOnly
          placeholder="还没有选"
          aria-label="整合包路径"
        />
        <button type="button" className="secondary-button import-pick" disabled={running || done || picking} onClick={() => { void pickZip() }}>
          <FileArchive size={14} />选择压缩包
        </button>
      </div>

      <div className="import-divider" />

      {/* 2. 文件夹名：可编辑（磁盘上的包标识，只收 ASCII），右边实例名允许中文；两者默认同名。 */}
      <div className="import-row">
        <span className="import-label">文件夹名</span>
        <input
          className="import-field import-folder"
          value={folder}
          placeholder="选取后自动填入"
          aria-label="文件夹名"
          disabled={running || done}
          onChange={event => {
            const next = event.target.value
            setFolder(next)
            setFolderTouched(true)
            // 实例名还没被单独改过时跟着走，保持「默认同文件夹名」。
            if (!nameTouched) setName(next)
          }}
        />
        <span className="import-label import-label-name">实例名</span>
        <input
          className="import-field import-name"
          value={name}
          placeholder="默认同文件夹名"
          aria-label="实例名"
          disabled={running || done || !packDir}
          onChange={event => { setName(event.target.value); setNameTouched(true) }}
        />
      </div>

      {/* 只有真出问题才占一行；未选包不再有提示行（顶部「还没有选」+「选择压缩包」已经说清）。 */}
      {issue && <p className="import-hint is-blocked">{issue}</p>}

      {/* 3. 状态行：左「正在装配」，右具体阶段；下面一条不定态进度条。 */}
      {running && (
        <div className="import-status">
          <div className="import-status-head">
            <span className="import-status-label"><span className="import-dot" />正在装配</span>
            <span className="import-stage">{stage ? IMPORT_STAGE_TEXT[stage] : ''}</span>
          </div>
          <div className="import-bar"><span /></div>
        </div>
      )}

      {/* 4. 结果行：完成就一句「已完成」，失败是「已停止」+ 一句人话。 */}
      {done && (
        <div className="import-result is-done"><Check size={14} /><strong>已完成</strong></div>
      )}
      {phase === 'stopped' && (
        <div className="import-result is-stopped">
          <CircleAlert size={14} />
          <div className="import-result-copy">
            <strong>已停止</strong>
            <span>{reason}</span>
          </div>
        </div>
      )}
      </div>
    </ModalShell>
  )
}
