import { Check, Copy, Download, FolderOpen, Package, PackagePlus, Pencil, Plus, ShieldCheck, Play, Square, Trash2, LoaderCircle, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { resolveLauncherApi } from '../api/client'
import { copyText } from '../lib/clipboard'
import { downloadPercent, formatBytes, formatSpeed } from '../lib/format'
import { migratePrompt } from '../lib/prompts'
import type {
  AppSettings,
  HomeTab,
  PackDownloadProgress,
  PackStageProgress,
  PackStatus,
} from '../types'

/**
 * 「整合包」页：整个启动器只剩这一块面板（版本/插件/技能/预设已并入 DSH 自己的网页设置）。
 * 结构照 lch-packs 稿：标题行（图标 + 整合包 + 计数 + 刷新/新建/导入）
 * → 单列行式包列表（包名 + 徽章 + 统计 + 运行状态点 + 五个常显图标按钮）
 * → 搬家提示词入口。
 */

interface SettingsPanelsProps {
  settings: AppSettings
  tab: Exclude<HomeTab, 'start'>
  packs: PackStatus[]
  /** 当前激活的整合包（settings.profileName 命中或 activePackId）。 */
  activePack: PackStatus | null
  /** 正在跑的那个包 id；null = 没有实例在跑。多开留到集成阶段，现在只可能有一个。 */
  runningPackIds: string[]
  busy: string | null
  /** 整合包后台活动（导出打包等）；null 表示空闲。 */
  packActivity?: string | null
  packDownload?: PackDownloadProgress | null
  packStage?: PackStageProgress | null
  onRefresh: () => void
  onImportPack: () => void
  onImportPackPath: (path: string) => void
  /** 打开「新建整合包」弹窗：弹窗由 App 统一持有，首页两个入口与这里共用同一个开关。 */
  onRequestCreate: () => void
  /** 点垃圾桶：只打开删除确认窗（窗口由 App 持有），确认后才真的删。 */
  onRemovePack: (packId: string) => void
  onRenamePack: (packId: string, name: string) => Promise<boolean>
  /** 每个运行中实例的端口（packId → 端口），胶囊里显示「运行中 | 3080」。 */
  runningPorts: Record<string, number | null>
  /** 点整行：只把「当前整合包」指针切过去并跳「启动」页，不启动实例。 */
  onActivatePack: (packId: string) => void
  /** 电源键：跑着的停止，没跑的先激活再启动。 */
  onTogglePackRuntime: (packId: string) => void
  /** 「制作整合包」：null = 标题栏入口（默认选当前激活的包），带 id = 行内入口（预选该行）。 */
  onRequestBuild: (packId: string | null) => void
  onRequestVerify: (packId: string) => void
  /** 行内「附件」：打开（必要时创建）这个整合包的 <家目录>/extras/。 */
  onOpenExtras: (packId: string) => void
}

export function SettingsPanels({
  settings,
  packs,
  activePack,
  runningPackIds,
  runningPorts,
  busy,
  packActivity,
  packDownload,
  packStage,
  onRefresh,
  onImportPack,
  onImportPackPath,
  onRequestCreate,
  onRemovePack,
  onRenamePack,
  onTogglePackRuntime,
  onRequestBuild,
  onRequestVerify,
  onActivatePack,
  onOpenExtras,
}: SettingsPanelsProps) {
  const locked = busy !== null

  // 整个面板都能接收拖入的 .zip（老文件 .dspack 仍兼容）：drop 区是 settings-content 全区域，不只是列表。
  const [zoneDroppingZip, setZoneDroppingZip] = useState(false)
  const zoneDropCounter = useRef(0)
  const onZoneDragEnter = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    zoneDropCounter.current += 1
    if (zoneDropCounter.current === 1) setZoneDroppingZip(true)
  }
  const onZoneDragLeave = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    zoneDropCounter.current = Math.max(0, zoneDropCounter.current - 1)
    if (zoneDropCounter.current === 0) setZoneDroppingZip(false)
  }
  const onZoneDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onZoneDrop = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    zoneDropCounter.current = 0
    setZoneDroppingZip(false)
    const files = Array.from(event.dataTransfer.files).filter(file => /\.(zip|dspack)$/i.test(file.name))
    if (files.length === 0) return
    const api = resolveLauncherApi()
    for (const file of files) onImportPackPath(api.getDroppedFilePath(file))
  }

  return (
    <div className="home-tab-page">
      <main className="settings-content">
        <div
          className={`packs-zone${zoneDroppingZip ? ' is-dragging-zip' : ''}`}
          data-pack-activity={packActivity ?? undefined}
          onDragEnter={onZoneDragEnter}
          onDragLeave={onZoneDragLeave}
          onDragOver={onZoneDragOver}
          onDrop={onZoneDrop}
        >
          {/* 下载有字节进度、导入有阶段进度，两者共用同一条进度条位置；都没有时才退回文字横幅。 */}
          {packDownload
            ? <PackDownloadBar progress={packDownload} />
            : packStage
              ? <PackStageBar stage={packStage} />
              : packActivity && <div className="settings-pack-activity"><LoaderCircle size={13} className="spin" /><span>{packActivity}</span></div>}
          <PackList
            packs={packs}
            activePack={activePack}
            runningPackIds={runningPackIds}
            runningPorts={runningPorts}
            locked={locked}
            busy={busy}
            dshHome={settings.dshHome}
            onRefresh={onRefresh}
            onImport={onImportPack}
            onRequestCreate={onRequestCreate}
            onRemove={onRemovePack}
            onRename={onRenamePack}
            onActivate={onActivatePack}
            onToggleRuntime={onTogglePackRuntime}
            onBuild={onRequestBuild}
            onVerify={onRequestVerify}
            onOpenExtras={onOpenExtras}
          />
        </div>
      </main>
    </div>
  )
}

function PackList({
  packs,
  activePack,
  runningPackIds,
  runningPorts,
  locked,
  busy,
  dshHome,
  onRefresh,
  onImport,
  onRequestCreate,
  onRemove,
  onRename,
  onActivate,
  onToggleRuntime,
  onBuild,
  onVerify,
  onOpenExtras,
}: {
  packs: PackStatus[]
  activePack: PackStatus | null
  runningPackIds: string[]
  runningPorts: Record<string, number | null>
  locked: boolean
  busy: string | null
  dshHome: string
  onRefresh: () => void
  onImport: () => void
  onRequestCreate: () => void
  onRemove: (packId: string) => void
  onRename: (packId: string, name: string) => Promise<boolean>
  onActivate: (packId: string) => void
  onToggleRuntime: (packId: string) => void
  onBuild: (packId: string | null) => void
  onVerify: (packId: string) => void
  onOpenExtras: (packId: string) => void
}) {
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [migrateCopied, setMigrateCopied] = useState(false)

  const copyMigrate = async () => {
    // 目标家目录要真路径（提示词里给 agent 照建），渲染层没有 path 模块也没有 userData：由主进程给 packsRoot。
    // 名称不由启动器代定：传空串，提示词第一件事就是让 agent 问用户要一个名称。
    let base: string
    // 启动器 exe：提示词里那条 `--verify` 要用真路径（对面机器上就是他自己那一份启动器）。
    let exe = ''
    try {
      const launcher = resolveLauncherApi()
      base = (await launcher.readPacksRoot()).trim().replace(/[\\/]+$/, '')
      exe = (await launcher.readLauncherExecutablePath().catch(() => '')).trim()
    } catch {
      // 主进程连 userData 都取不到时启动器本身已经坏了，这里复制出去的东西也没落点，不复制。
      return
    }
    const ok = await copyText(migratePrompt(dshHome, '', base, exe))
    if (!ok) return
    setMigrateCopied(true)
    window.setTimeout(() => setMigrateCopied(false), 1600)
  }

  return (
    <div className="panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Package size={16} />
          <span>整合包</span>
          {packs.length > 0 && <span className="count">{packs.length}</span>}
        </div>
        <div className="heading-actions">
          {/* 标题行三钮照 lch-packs-v2 稿：搬家提示词 / 新建实例（加号）/ 导入（主按钮，上传图标）。 */}
          <button type="button" className="secondary-button" onClick={() => { void copyMigrate() }} disabled={locked}>
            {migrateCopied ? <Check size={13} /> : <Copy size={13} />}{migrateCopied ? '已复制' : '复制搬家提示词'}
          </button>
          <button type="button" className="secondary-button" onClick={onRequestCreate} disabled={locked}>
            <Plus size={13} />新建实例
          </button>
          {/* 制作整合包走绿色（--build），与蓝色的「导入整合包」区分：一个是造包，一个是收包。 */}
          <button type="button" className="primary-command build-command" onClick={() => onBuild(null)} disabled={locked}>
            <PackagePlus size={13} />制作整合包
          </button>
          {/* 导入＝把包装进来：箭头朝下（Download）。制作/导出才用朝上的 Upload。 */}
          <button type="button" className="primary-command" onClick={onImport} disabled={locked}>
            <Download size={13} />导入整合包
          </button>
        </div>
      </div>

      <div className="list">
        {packs.length === 0 && (
          <div className="packs-empty">
            还没有整合包。点「新建实例」建一个空白实例，或者直接导入一个 .zip。
          </div>
        )}

        {packs.map(pack => {
          const running = runningPackIds.includes(pack.id)
          // 三档徽章由主进程读 <家目录>/profiles/<id>/package.json 的 dependencies 现算：
          // 本地目录副本（file:./.dsh-launcher-plugin-bodies/）= 随包；可安全外联的包（npm 上存在同名同版本）= 安全外联；
          // 仍是绝对 file:/link: 的 = 需转移。extrasCount 是附件数，不算徽章。
          const vaultCount = pack.vaultCount ?? 0
          const remoteCount = pack.remoteCount ?? 0
          const moveCount = pack.moveCount ?? 0
          const extrasCount = pack.extrasCount ?? 0
          const meta = [
            pack.dshVersion ? `DSH ${pack.dshVersion}` : 'DSH 未绑定版本',
            `${pack.plugins.length} 插件`,
            `${pack.skills?.length ?? 0} 技能`,
            `${pack.presets?.length ?? 0} 预设`,
          ].join(' · ')
          return (
            <div
              key={pack.id}
              className={`pack-row${running ? ' running' : ''}`}
              title="点这一行＝把首页当前整合包切到它（不会启动）"
              onClick={() => onActivate(pack.id)}
            >
              <div className="pack-copy">
                <span className="pack-title-line">
                  <span className="pack-glyph"><Package size={14} /></span>
                  {renaming?.id === pack.id ? (
                    <>
                      <input
                        className="pack-create-name"
                        value={renaming.value}
                        autoFocus
                        onClick={event => event.stopPropagation()}
                        onChange={event => setRenaming({ id: pack.id, value: event.target.value })}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void onRename(pack.id, renaming.value.trim()).then(() => setRenaming(null))
                          if (event.key === 'Escape') setRenaming(null)
                        }}
                      />
                      <button type="button" className="icon-btn" title="保存名称" onClick={event => { event.stopPropagation(); void onRename(pack.id, renaming.value.trim()).then(() => setRenaming(null)) }}><Check size={14} /></button>
                      <button type="button" className="icon-btn" title="取消重命名" onClick={event => { event.stopPropagation(); setRenaming(null) }}><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      <strong>{pack.name}</strong>
                      {/* 稿顺序：名字 → 铅笔 → 版本 pill → 计数 tag；铅笔跟着名字走，不飘到徽章后面。 */}
                      <button
                        type="button"
                        className="pack-edit"
                        title="重命名"
                        onClick={event => { event.stopPropagation(); setRenaming({ id: pack.id, value: pack.name }) }}
                      ><Pencil size={12} strokeWidth={1.8} /></button>
                      <span className="pack-badge">{pack.dshVersion ? `DSH ${pack.dshVersion}` : 'DSH 未绑定'}</span>
                      {vaultCount > 0 && <span className="pack-badge vault">本地Link {vaultCount}</span>}
                      {remoteCount > 0 && <span className="pack-badge remote">安全外联 {remoteCount}</span>}
                      {moveCount > 0 && <span className="pack-badge move">需转移 {moveCount}</span>}
                    </>
                  )}
                </span>
                <span className="pack-meta">
                  {meta
                    + (pack.state === 'complete' ? '' : ' · 未完成安装')
                    + (extrasCount > 0 ? ` · 附件 ${extrasCount}` : '')}
                </span>
              </div>
              <div className="pack-actions" onClick={event => event.stopPropagation()}>
                <span className={running ? 'pack-state run' : 'pack-state idle'}>
                  <span className="dot" />{running ? '运行中' : '未启动'}
                  {running && runningPorts[pack.id] != null && <span className="port">{runningPorts[pack.id]}</span>}
                </span>
                <button
                  type="button"
                  className={'icon-btn pwr' + (running ? ' stop' : '')}
                  title={running ? '停止实例' : '启动实例'}
                  disabled={locked}
                  onClick={() => onToggleRuntime(pack.id)}
                >
                  {running ? <Square size={14} /> : <Play size={14} />}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="制作整合包"
                  disabled={locked}
                  onClick={() => onBuild(pack.id)}
                ><Upload size={14} /></button>
                <button
                  type="button"
                  className="icon-btn"
                  title="自检"
                  disabled={locked}
                  onClick={() => onVerify(pack.id)}
                ><ShieldCheck size={14} /></button>
                <button
                  type="button"
                  className="icon-btn"
                  title="附件"
                  disabled={locked}
                  onClick={() => onOpenExtras(pack.id)}
                ><FolderOpen size={14} /></button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="删除整合包"
                  disabled={locked}
                  onClick={() => onRemove(pack.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          )
        })}

      </div>
    </div>
  )
}

/** 导入阶段的进度条（下载完成之后）：写盘 / 解压快照 / 补装缺失的 DSH 运行时。 */
function PackStageBar({ stage }: { stage: PackStageProgress }) {
  const percent = stage.percent
  return (
    <div className="settings-pack-download">
      <div className="settings-progress">
        <LoaderCircle size={14} className="spin" />
        <span className="settings-pack-download-label">{stage.label}</span>
        <div className={`settings-progress-track ${percent === null ? 'indeterminate' : 'determinate'}`}>
          {percent !== null && <span style={{ width: `${percent}%` }} />}
        </div>
        {percent !== null && <strong>{percent}%</strong>}
      </div>
      <div className="settings-pack-download-meta">
        {percent === null && <span>这一步没有细粒度进度，会自己往下走；最慢的是首次导入解压上万个文件，可能一两分钟。</span>}
      </div>
    </div>
  )
}

/** 包体这类百 MB 级下载：百分比 + 已下载/总量 + 实时速度 + 当前下载源。 */
function PackDownloadBar({ progress }: { progress: PackDownloadProgress }) {
  const total = progress.total
  const percent = downloadPercent(progress.received, total)
  const speed = formatSpeed(progress.speed)
  return (
    <div className="settings-pack-download">
      <div className="settings-progress">
        <Download size={14} />
        <span className="settings-pack-download-label">{progress.label}</span>
        <div className={`settings-progress-track ${percent === null ? 'indeterminate' : 'determinate'}`}>
          {percent !== null && <span style={{ width: `${percent}%` }} />}
        </div>
        <strong>{percent !== null ? `${percent}%` : formatBytes(progress.received)}</strong>
      </div>
      <div className="settings-pack-download-meta">
        {percent !== null && total != null && <span>{formatBytes(progress.received)} / {formatBytes(total)}</span>}
        <span>{speed || '连接中…'}</span>
        <span className="settings-pack-download-source" title="直连太慢或断流时自动改用镜像">经 {progress.source}</span>
      </div>
    </div>
  )
}
