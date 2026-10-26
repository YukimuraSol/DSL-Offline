import { Layers3, LoaderCircle } from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { LauncherApiProvider, resolveLauncherApi, useLauncherApi } from './api/client'
import { LauncherHome } from './components/LauncherHome'
import { TopBar } from './components/TopBar'
import { Toast } from './components/Toast'
import { DshFailureDialog } from './components/dialogs/DshFailureDialog'
import { PortConflictDialog } from './components/dialogs/PortConflictDialog'
import { UpdateDialog } from './components/dialogs/UpdateDialog'
import { DSH_REPOSITORY } from './constants'
import { BUSY } from './hooks/use-async-action'
import { useLauncherStore } from './hooks/use-launcher-store'
import { useNavigation } from './hooks/use-navigation'
import { usePackInstall } from './hooks/use-pack-install'
import { errorText } from './lib/format'
import { isInstallProgressActive } from './lib/install-progress'
import { HOME_TAB_ORDER } from './lib/nav'
import type { PackVerifyInput } from './components/dialogs/PackVerifyDialog'
import type { HomeTab, PackStatus } from './types'

// 启动页只看得到 LauncherHome；整合包面板与三个包级对话框拆成按需加载的 chunk，
// 首屏要解析的 JS 就少一截。
const SettingsPanels = lazy(() => import('./views/SettingsView').then(module => ({ default: module.SettingsPanels })))
const PackInstallDialog = lazy(() => import('./components/dialogs/PackInstallDialog').then(module => ({ default: module.PackInstallDialog })))
const PackBuildDialog = lazy(() => import('./components/dialogs/PackBuildDialog').then(module => ({ default: module.PackBuildDialog })))
const PackVerifyDialog = lazy(() => import('./components/dialogs/PackVerifyDialog').then(module => ({ default: module.PackVerifyDialog })))
const PackImportDialog = lazy(() => import('./components/dialogs/PackImportDialog').then(module => ({ default: module.PackImportDialog })))
const CreatePackDialog = lazy(() => import('./components/dialogs/CreatePackDialog').then(module => ({ default: module.CreatePackDialog })))
const DeletePackDialog = lazy(() => import('./components/dialogs/DeletePackDialog').then(module => ({ default: module.DeletePackDialog })))

/**
 * 应用根。
 * 只做三件事：提供主进程 API、组装状态与视图、挂载对话框。
 * 业务逻辑在 hooks 里，展示逻辑在 components 与 views 里。
 * 管理界面（开发人员选项）已随「暴力整合包模式」路线整体移除。
 */
export default function App() {
  const api = useMemo(() => resolveLauncherApi(), [])
  return (
    <LauncherApiProvider value={api}>
      <LauncherShell />
    </LauncherApiProvider>
  )
}

function LauncherShell() {
  const api = useLauncherApi()
  const store = useLauncherStore()
  const navigation = useNavigation()
  // 整合包创建/导入是流式任务；结算后刷新包列表与快照状态。
  const packInstall = usePackInstall(() => {
    void store.refreshPacks()
    void store.refreshPackSnapshots()
  }, store.showToast)

  /** 本机已安装的 DSH 版本集合：导入的整合包若要求缺失版本，安装前需确认下载。 */
  const installedDshVersions = useMemo(
    () => new Set((store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)),
    [store.runtimeEnvironment],
  )

  // 对话框开关是纯展示状态，不进 store。
  const [updateOpen, setUpdateOpen] = useState(false)
  // 「制作整合包」对话框：preselect 是行内入口带进来的实例 id（null = 默认选当前激活的包）。
  const [buildTarget, setBuildTarget] = useState<{ preselect: string | null } | null>(null)
  // 导出目录不落 settings：主进程 packs:export-dir 一档给的就是安装目录下的 dsh-exports
  // （与 dsh-packs 同级），打开弹窗时就取一次，提示词里才有真路径。
  const [exportDir, setExportDir] = useState('')
  // 启动器自己的 exe：导出 / 搬家的提示词要用它写 `--verify` / `--export` 两行命令。
  const [launcherExe, setLauncherExe] = useState('')
  // 「自检」对话框的目标：整合包行的自检按钮，或导出对话框里选进来的 .zip。
  const [verifyTarget, setVerifyTarget] = useState<PackVerifyInput | null>(null)
  // 「导入整合包」对话框：选离线包的文件夹 → 装配出一个新实例（走 pack-offline-import 那条线）。
  const [importOpen, setImportOpen] = useState(false)
  // 「新建整合包」弹窗：首页两个入口与整合包页「新建实例」共用这一个开关与同一个组件。
  const [createOpen, setCreateOpen] = useState(false)
  // 删除确认窗的目标包 id：列表行点垃圾桶只开窗，确认后才真的调 removePack。
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // keep-mounted 集合：访问过的一级 tab 保持挂载，切换只切可见性。
  const visitedTabs = useRef(new Set<HomeTab>(['start']))

  useEffect(() => {
    document.documentElement.dataset.theme = store.settings?.uiTheme ?? 'deepseek'
  }, [store.settings?.uiTheme])

  const installingResource = isInstallProgressActive(store.installProgress)
  const installingDsh = store.busy === BUSY.dshInstall
    || (installingResource && store.installProgress?.kind === 'dsh')
  const installingApplication = installingResource && store.installProgress?.kind === 'application'
  // The selector itself must not be latched by a stale install-progress event.
  // The main-process mutation guard remains authoritative while a real
  // installer is still active; only an in-flight Profile switch disables it.
  const profileSwitcherLocked = store.busy?.startsWith('profile-switch:') === true
  const runtimeBusy = store.busy === BUSY.runtime || installingResource || installingApplication || Boolean(store.busy?.startsWith('application'))
  const toggleRuntime = async () => {
    await store.toggleRuntime()
  }

  // 打开浏览器失败要说话：静默失败就是「点了没反应」，用户连去哪儿复制链接都不知道。
  const openHarness = () => {
    const url = store.runtime.url
    if (!url) return
    void api.openExternal(url).catch(error => {
      store.showToast({ kind: 'error', message: `打不开浏览器：${errorText(error)}。可以点「复制链接」手动打开。` })
    })
  }

  const closeWindow = () => void api.closeWindow()
  const minimizeWindow = () => void api.minimizeWindow()

  /**
   * 「导入整合包」：打开离线包对话框（选包目录 + 选装配到哪）。
   * 以前这条路是「选 .zip → analyze → PackInstallDialog」，现在整包已经能直接按目录装配，
   * 就把按钮让给新对话框；拖 .zip 进窗口那条老路保持不动（onImportPackPath）。
   */
  const handlePackImport = () => {
    setImportOpen(true)
  }

  /** 首页空状态左卡「新建空白实例」：先切到「整合包」页，再立刻弹出新建弹窗。 */
  const openCreatePackFromHome = () => {
    navigation.goHome('packs')
    setCreateOpen(true)
  }

  /**
   * 电源键：一个动作完成「激活 + 启动」或「停止」。
   * 主进程现在按 packId 启停（instances:* 通道），不再需要界面里两步拼接。
   */
  const togglePackRuntime = async (packId: string) => {
    await store.togglePackInstance(packId)
  }

  /**
   * 自检：`packId` 就是整包列表里那一行的 id，主进程按它找到这个包的家目录，直接对着目录跑六条。
   * 打开对话框时 report=null 显示进度，主进程返回后填进去。
   */
  const openVerify = (packId: string, packName: string, pluginCount: number) => {
    const target: PackVerifyInput = { packId, packName, pluginCount, report: null, error: null }
    setVerifyTarget(target)
    void api.verifyPack(packId).then(
      report => setVerifyTarget(current => (current === target ? { ...target, report } : current)),
      error => setVerifyTarget(current => (current === target ? { ...target, error: errorText(error) } : current)),
    )
  }

  /**
   * 导入完成后主进程已经顺手跑过自检（结果随 importPack 一起回来）。
   * 有提示词就直接把那份报告摆出来，没有就维持原样：关掉导入对话框，回启动画面。
   * 判定只看 prompt 是否非空 —— 主进程 buildPrompt 只在真有 failed/warned 时才生成。
   */
  useEffect(() => {
    const pending = packInstall.verifyReport
    if (!pending) return
    // 先关掉「整合包处理完成」，否则两个 modal 的遮罩会叠在一起。
    packInstall.reset()
    setVerifyTarget({ packId: pending.packId, packName: pending.packName, pluginCount: pending.pluginCount, report: pending.report, error: null })
    packInstall.clearVerify()
  }, [packInstall.verifyReport, packInstall.reset, packInstall.clearVerify])

  /** 包行自检：直接对该包出报告，不再让用户挑文件。 */
  const verifyInstalledPack = (packId: string) => {
    const pack = store.packs.find(item => item.id === packId) ?? null
    openVerify(packId, pack?.name ?? packId, pack?.plugins.length ?? 0)
  }

  if (store.loading || !store.settings || !store.profile) {
    return (
      <div className="app-loading">
        <div className="brand-mark"><Layers3 size={22} /></div>
        <LoaderCircle className="spin" size={22} />
        <span>正在读取 DSH 配置</span>
      </div>
    )
  }

  const { settings, profile } = store
  // 当前激活的整合包：「制作整合包」默认选它，整合包页也拿它判断哪一行是当前包。
  const activePack = store.packs.find(item => item.id === settings.activePackId)
    ?? store.packs.find(item => item.name === settings.profileName)
    ?? null
  /**
   * 内核状态条要显示**真正会跑的那份内核**：整合包自带内核优先（实例快照已按
   * 「包内 profiles/node_modules → 版本库 → 启动器」算好），没有整合包/包里没带才回落
   * 启动器安装的那份。都取不到就是 null，界面如实写「版本未知」——
   * 不能用 settings.dshVersion 冒充实际跑的内核（旧台式就报成了两个版本）。
   */
  const effectiveKernel = (() => {
    const snapshot = activePack
      ? store.instances.find(item => item.packId === activePack.id)
      : store.instances.find(item => item.kernelVersion) ?? store.instances[0]
    if (snapshot?.kernelVersion) return { version: snapshot.kernelVersion, origin: 'pack' as const }
    if (store.dshInstallation.installed && store.dshInstallation.version) {
      return {
        version: store.dshInstallation.version,
        origin: store.dshInstallation.source === 'system' ? 'system' as const : 'launcher' as const,
      }
    }
    return { version: null, origin: null }
  })()
  visitedTabs.current.add(navigation.homeTab)

  return (
    <div className="app-root">
      <TopBar
        activeTab={navigation.homeTab}
        runningCount={store.instances.filter(instance => instance.running).length}
        onSelectTab={navigation.goHome}
        onMinimize={minimizeWindow}
        onClose={closeWindow}
      />
      <div className="app-content">
        <div className="surface-stage surface-launcher">
          <div className="surface-host launcher-surface-host">
            {HOME_TAB_ORDER.filter(tab => visitedTabs.current.has(tab)).map(tab => (
              <div key={tab} className={`home-tab-pane ${navigation.homeTab === tab ? '' : 'view-hidden'}`}>
                {tab === 'start' ? (
                  <LauncherHome
                    runtime={store.runtime}
                    dshInstallation={store.dshInstallation}
                    installProgress={store.installProgress?.repository === DSH_REPOSITORY ? store.installProgress : null}
                    busy={runtimeBusy}
                    installingDsh={installingDsh}
                    activeRuntimeReplacement={store.activeRuntimeReplacement}
                    activePack={(() => {
                      const pack = store.packs.find(item => item.id === settings.activePackId)
                      return pack ? { name: pack.name, dshVersion: pack.dshVersion } : null
                    })()}
                    kernel={effectiveKernel}
                    launchActivity={store.packActivity}
                    webPort={store.instances.find(instance => instance.packId === settings.activePackId)?.webPort ?? null}
                    onSaveWebPort={port => store.setInstancePort(port)}
                    onToggleRuntime={toggleRuntime}
                    onOpenWeb={openHarness}
                    onVersionSelect={() => navigation.goHome('packs')}
                    onCreatePack={openCreatePackFromHome}
                    onImportPack={handlePackImport}
                  />
                ) : (
                  <Suspense fallback={null}>
                    <SettingsPanels
                    tab={tab}
                    settings={settings}
                    packs={store.packs}
                    activePack={activePack}
                    runningPackIds={store.instances.filter(instance => instance.running).map(instance => instance.packId)}
                    runningPorts={Object.fromEntries(store.instances.map(instance => [instance.packId, instance.webPort]))}
                    onActivatePack={packId => { void store.activateInstance(packId); navigation.goHome('start') }}
                    busy={store.busy}
                    packActivity={store.packActivity}
                    packDownload={store.packDownload}
                    packStage={store.packStage}
                    onRefresh={() => {
                      void store.refreshProfile()
                      void store.refreshSecondaryResources()
                      void store.refreshPacks()
                      void store.refreshRuntimeEnvironment(true)
                    }}
                    onImportPack={() => void handlePackImport()}
                    onImportPackPath={path => { void packInstall.startImport(path) }}
                    onRequestCreate={() => setCreateOpen(true)}
                    onRemovePack={packId => setDeleteTarget(packId)}
                    onRenamePack={store.renamePack}
                    onTogglePackRuntime={packId => { void togglePackRuntime(packId) }}
                    onRequestBuild={packId => {
                      setBuildTarget({ preselect: packId })
                      // 一打开就把默认导出目录和启动器 exe 取回来，复制出去的提示词里才有真路径。
                      void (async () => {
                        try {
                          const [dir, exe] = await Promise.all([api.readPackExportDir(), api.readLauncherExecutablePath()])
                          if (dir) setExportDir(dir)
                          if (exe) setLauncherExe(exe)
                        } catch {
                          // 取不到就退回不带绝对路径的提示词：不挡这条路。
                        }
                      })()
                    }}
                    onRequestVerify={verifyInstalledPack}
                    onOpenExtras={packId => {
                      void api.openPackExtras(packId).catch(error => {
                        store.showToast({ kind: 'error', message: errorText(error) })
                      })
                    }}
                  />
                  </Suspense>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {packInstall.phase !== 'idle' && (
        <Suspense fallback={null}>
          <PackInstallDialog
          phase={packInstall.phase}
          events={packInstall.events}
          result={packInstall.result}
          error={packInstall.error}
          analysis={packInstall.analysis}
          itemProgress={packInstall.itemProgress}
          hasSnapshot={packInstall.hasSnapshot}
          packSnapshotsAvailable={store.packSnapshotsAvailable}
          installedDshVersions={installedDshVersions}
          busy={store.busy !== null || packInstall.busy !== null}
          onConfirmImport={(items, name) => void packInstall.confirmImport(packInstall.importPath ?? '', items, name)}
          onRollback={() => void packInstall.rollback()}
          onActivate={packId => {
            void (async () => {
              if (await store.activatePack(packId)) packInstall.reset()
            })()
          }}
          onClose={packInstall.reset}
        />
        </Suspense>
      )}
      {importOpen && (
        <Suspense fallback={null}>
          <PackImportDialog
            packs={store.packs}
            onImported={() => {
              // 新实例要立刻出现在列表里（主进程已经把记录写进 packs.json 了）。
              void store.refreshPacks()
              void store.refreshPackSnapshots()
            }}
            onClose={() => setImportOpen(false)}
          />
        </Suspense>
      )}
      {createOpen && (
        <Suspense fallback={null}>
          <CreatePackDialog
            installedDshVersions={(store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)}
            busy={store.busy !== null}
            onCreate={async request => {
              const created = await store.createBlankPack(request)
              if (!created) return false
              // 零包状态下主进程已经把它设成当前包；已有当前包时这里再选中它。
              if (!created.enabled) await store.activatePack(created.id)
              return true
            }}
            onClose={() => setCreateOpen(false)}
          />
        </Suspense>
      )}
      {deleteTarget && (
        <Suspense fallback={null}>
          <DeletePackDialog
            packId={deleteTarget}
            running={store.instances.some(instance => instance.packId === deleteTarget && instance.running)}
            busy={store.busy !== null}
            onConfirm={() => store.removePack(deleteTarget)}
            onClose={() => setDeleteTarget(null)}
          />
        </Suspense>
      )}
      {buildTarget && (
        <Suspense fallback={null}>
          <PackBuildDialog
            packs={store.packs}
            activePackId={activePack?.id ?? null}
            preselectedPackId={buildTarget.preselect}
            runningPackIds={store.instances.filter(instance => instance.running).map(instance => instance.packId)}
            runningPorts={Object.fromEntries(store.instances.map(instance => [instance.packId, instance.webPort]))}
            installedDshVersions={Array.from(installedDshVersions)}
            exportDir={exportDir}
            launcherExe={launcherExe}
            onClose={() => setBuildTarget(null)}
          />
        </Suspense>
      )}
      {verifyTarget && (
        <Suspense fallback={null}>
          <PackVerifyDialog
            input={verifyTarget}
            onClose={() => setVerifyTarget(null)}
            onRecheck={() => openVerify(verifyTarget.packId, verifyTarget.packName, verifyTarget.pluginCount)}
          />
        </Suspense>
      )}
      {updateOpen && store.launcherUpdate && (
        <UpdateDialog
          status={store.launcherUpdate}
          progress={store.launcherUpdateProgress}
          busy={store.busy === 'launcher-update-download' || store.busy === 'launcher-update-apply'}
          onDownload={() => { void store.downloadLauncherUpdate() }}
          onApply={() => { void store.applyLauncherUpdate() }}
          onClose={() => setUpdateOpen(false)}
        />
      )}
      {store.dshFailure && (
        <DshFailureDialog failure={store.dshFailure} onClose={store.dismissDshFailure} />
      )}
      {store.portConflict && (
        <PortConflictDialog prompt={store.portConflict} onAnswer={store.answerPortConflict} />
      )}
      {store.toast && <Toast toast={store.toast} onClose={store.dismissToast} />}
    </div>
  )
}
