import { ChevronRight, CircleStop, Download, FolderOpen, LoaderCircle, Package, Play, Plus, SquareArrowOutUpRight } from 'lucide-react'
import launcherLogo from '../assets/launcher-logo.png'
import packageMetadata from '../../package.json'
import { WidgetZone } from './WidgetZone'
import type { DshInstallationStatus, InstallProgress, InstalledApplicationAddon, RuntimeState } from '../types'

/**
 * 「启动」tab：离线整合包启动器的首页。左列品牌（logo / DSH / 半行说明 / 版本），右列分两种形态：
 *   - 空状态（一个整合包都没有）：一行标题 + 两张等大入口卡（新建空白实例 / 导入整合包）+ 内核状态条；
 *   - 已有整合包：「开放端口」卡 + 底部动作区（启动大按钮 + 运行时「打开网页」+ 当前整合包条）。
 */

interface LauncherHomeProps {
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  installProgress: InstallProgress | null
  busy: boolean
  installingDsh: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  /** 当前激活整合包（名称 + 绑定 DSH 版本），显示在「当前整合包」条上。 */
  activePack: { name: string; dshVersion: string | null } | null
  /**
   * 实际会跑的那份内核（版本 + 出处）。由上层按「整合包自带 → 启动器安装」算好；
   * 取不到就是 null —— 这里如实写「版本未知」，不拿 settings.dshVersion 冒充。
   */
  kernel: { version: string | null; origin: 'pack' | 'launcher' | 'system' | null }
  /** 启动过程中主进程的后台活动（如 Office 工具下载进度），非空时顶替「正在启动本地工作台」小字。 */
  launchActivity?: string | null
  /** 该整合包实例实际使用的网页端口（只认快照），显示在端口卡里；未登记过为 null。 */
  webPort: number | null
  onSaveWebPort: (port: number) => Promise<boolean>
  onToggleRuntime: () => void
  /** 服务运行中把网页重新拉起来（网页窗口被用户关掉后的唯一找回入口，与顶栏同源）。 */
  onOpenWeb: () => void
  /** 切到「整合包」页（已有当前整合包时用它换包）。 */
  onVersionSelect: () => void
  /** 切到「整合包」页并立刻弹出「新建整合包」弹窗（空状态左卡）。 */
  onCreatePack: () => void
  /** 打开「导入整合包」弹窗（空状态右卡）：导入永远新建实例，只收一个 .zip 压缩包。 */
  onImportPack: () => void
}

export function LauncherHome({
  runtime,
  dshInstallation,
  installProgress,
  busy,
  installingDsh,
  activeRuntimeReplacement,
  activePack,
  kernel,
  launchActivity,
  webPort,
  onSaveWebPort,
  onToggleRuntime,
  onOpenWeb,
  onVersionSelect,
  onCreatePack,
  onImportPack,
}: LauncherHomeProps) {
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement
  // 零包引导态：没有激活包（通常是删光了整合包）时，首页按钮指向整合包页引导新建。
  const noPack = !activePack && !runtime.running && !busy
  const starting = busy && !runtime.running && !installingDsh
  // 空状态：一个整合包都没有（也没在跑）。右列整块换成两张入口卡：端口卡与启停按钮都不出现。
  const empty = !activePack && !runtime.running
  // 内核状态条回答「核心要不要先装」：版本只认真实生效的那份（优先整合包自带内核），
  // 出处跟着版本一起给；取不到版本就写「版本未知」。
  const kernelOrigin = kernel.origin === 'pack' ? '随整合包'
    : kernel.origin === 'system' ? '已检测到系统安装'
      : kernel.origin === 'launcher' ? '随启动器安装'
        : null

  return (
    <div className="launcher-home">
      <section className="home-brand">
        <div className="home-brand-head">
          {/* 品牌 logo：设计稿里的像素头像原图（src/assets/launcher-logo.png，256×256）。 */}
          <img className="home-brand-logo" src={launcherLogo} width={112} height={112} alt="DSH 整合包启动器" draggable={false} />
          <h1 className="home-brand-name">
            <strong>DSH</strong>
            <span>Pack Launcher</span>
            <small className="home-brand-overture">Offline</small>
          </h1>
          <p className="home-brand-tagline">DSH 整合包启动器 · 离线版</p>
        </div>
        <div className="home-brand-meta">
          <span className="home-brand-version">v{packageMetadata.version}</span>
        </div>
      </section>

      <section className="home-side">
        {empty ? (
          <div className="home-empty">
            <header className="home-empty-head">
              <h2>还没有整合包</h2>
              <p className="home-empty-sub">新建一个空实例，或导入一个 .zip 整合包。</p>
            </header>
            {/* 两条路并排、等大、不分主次：左边从空环境开始，右边导入一个压缩包。 */}
            <div className="home-empty-routes">
              <button type="button" className="home-empty-route" onClick={onCreatePack}>
                <span className="home-empty-route-icon"><Plus size={20} /></span>
                <strong>新建空白实例</strong>
                <p>从空环境开始</p>
              </button>
              <button type="button" className="home-empty-route" onClick={onImportPack}>
                <span className="home-empty-route-icon"><FolderOpen size={20} /></span>
                <strong>导入整合包</strong>
                <p>.zip 压缩包</p>
              </button>
            </div>
            <div className="home-empty-ready">
              <span className="home-empty-ready-dot" aria-hidden="true" />
              <strong>内核已就绪</strong>
              <span>DSH {kernel.version ?? '版本未知'}{kernelOrigin ? ` · ${kernelOrigin}` : ''}</span>
            </div>
          </div>
        ) : (
          <>
            <WidgetZone
              webPort={webPort}
              onSaveWebPort={onSaveWebPort}
              runtimeUrl={runtime.running ? runtime.url : null}
              running={runtime.running}
              busy={busy}
            />
            <div className="home-actions">
              <div className="home-start-row">
                <button
                  type="button"
                  className={'launcher-start-button' + (runtime.running ? ' stop' : '') + (starting ? ' busy' : '')}
                  onClick={noPack ? onCreatePack : onToggleRuntime}
                  disabled={busy}
                  title={noPack ? '先到「整合包」页新建或导入一个整合包' : undefined}
                >
                  {busy ? <LoaderCircle className="spin" size={24} /> : noPack ? <Package size={24} /> : runtime.running ? <CircleStop size={24} /> : needsInstallation ? <Download size={24} /> : <Play size={25} fill="currentColor" />}
                  <span>
                    <small>{starting ? '正在启动本地工作台' : busy ? (installingDsh ? installProgress?.message ?? '正在准备本地 DSH' : runtime.running ? '正在停止本地服务' : launchActivity ?? '正在启动本地工作台') : noPack ? '先创建一个整合包环境' : runtime.running ? '结束本地服务' : needsInstallation ? '首次使用需要完成本地部署' : activeRuntimeReplacement ? '由应用加载项托管 DSH' : '启动本工作台'}</small>
                    <strong>{starting ? '请稍候…' : runtime.running ? '停止 DSH' : noPack ? '新建整合包' : installingDsh ? installProgress?.indeterminate ? '安装进行中' : `安装 DSH ${installProgress?.percent ?? 0}%` : needsInstallation ? '下载安装 DSH' : busy ? '请稍候…' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : '启动 DSH'}</strong>
                  </span>
                </button>
                {/* 运行中的第二分段：网页窗口被关掉后，这里是一键找回的入口（与左侧停止段等宽同构）。 */}
                {runtime.running && runtime.url && (
                  <button type="button" className="launcher-start-button launcher-open-web" onClick={onOpenWeb} disabled={busy} title="在浏览器中重新打开 DSH 网页工作台">
                    <SquareArrowOutUpRight size={24} />
                    <span>
                      <small>浏览器中访问</small>
                      <strong>打开网页</strong>
                    </span>
                  </button>
                )}
              </div>
              <button type="button" className="launcher-utility-button home-version-button" onClick={activePack ? onVersionSelect : onCreatePack} title={activePack ? '切换到其它整合包' : '创建或导入整合包'}>
                <Package size={24} className="home-version-icon" />
                <span className="home-version-copy">
                  <small>{activePack ? '当前整合包' : '还没有整合包'}</small>
                  <strong>{activePack ? `${activePack.name}${activePack.dshVersion ? ` · DSH ${activePack.dshVersion}` : ''}` : '新建整合包'}</strong>
                </span>
                <ChevronRight size={18} className="home-version-chevron" />
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
