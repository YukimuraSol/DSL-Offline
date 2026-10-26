; DSH 整合包启动器 —— Inno Setup 6 安装向导脚本
; 正常用法：npm run package:inno（先 build + electron-builder --dir，再调 ISCC 编译本文件）
; 手动编译：ISCC.exe /DAppVersion=1.0.3 build\installer.iss
;
; 所有路径都相对脚本自身位置（{#SourcePath}）拼出来，脚本里不出现任何机器相关的绝对路径，
; 换一台机器、换一个仓库位置都能直接编译。

; 警告：不要用本脚本编出来的安装包在真机上做安装/卸载验证。
; AppId 是全局唯一安装标识，同一个 AppId 再装一次会把已有的卸载注册项
; （HKCU\...\Uninstall\com.local.dshlauncher_is1）和开始菜单快捷方式改写成
; 指向新位置，随后卸载那个临时安装就会把用户的真实注册项和快捷方式一起删掉。
; 2026-10-19 已经因此毁过一次用户真实安装的注册项。
;
; 要做安装/卸载验证，请复制本文件为 installer-<用途>.iss 并至少改三处：
;   1. AppId 换成独立值（例如 com.local.dshlauncher.<用途>）
;   2. AppName 加后缀，避免和真实安装的快捷方式同名
;   3. [Icons] 段去掉 {autodesktop} 那条（或用 /TASKS="" 静默安装），
;      否则会覆盖用户桌面快捷方式
; 验证完把副本与产物一起删掉。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "DSH Launcher"
#define AppPublisher "dsh-launcher"
#define AppExeName "DSH Launcher.exe"
#define AppId "com.local.dshlauncher"
#define RepoRoot SourcePath + "\.."
#define UnpackedDir RepoRoot + "\release\win-unpacked"

[Setup]
; 与 electron-builder 的 appId 完全一致：同一个程序只算一份安装，升级/卸载能对上。
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
; per-user 安装：与底座原来的形态一致，全程不需要管理员权限，不弹 UAC。
PrivilegesRequired=lowest

DefaultDirName={localappdata}\Programs\DSH Pack Launcher
DefaultGroupName={#AppName}
; 允许用户在向导里改安装目录（用户明确要求「允许指定地方」）。
DisableDirPage=no
DisableProgramGroupPage=yes
OutputDir={#RepoRoot}\release
OutputBaseFilename=DSH-Pack-Launcher-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}
SetupIconFile={#RepoRoot}\build\icon.ico
; 启动器开着的时候装新版，必须真的装上（1.0.15 及更早：静默装返回 0 却一个文件没换）。
; 用 Restart Manager 关掉占用安装目标的启动器进程；静默模式下这条不弹窗、直接生效。
;
; 为什么是 force 而不是默认的 yes：yes 走的是「请应用自己关掉」（WM_CLOSE），而本产品的
; 关闭按钮是「隐藏到托盘」（electron/main.ts 的 close 处理），窗口收到 WM_CLOSE 只会躲进托盘，
; 进程照样活着、照样占着 DSH Launcher.exe 与 resources\app.asar。RM 等不到退出，安装就只能
; 把占用的文件留到重启后再换 —— 静默安装带着 /NORESTART，于是退出码 0、什么都没装。
; force 让 RM 直接结束这些进程（只限于占用本次要替换的文件的那几个，也就是本产品自己的进程，
; 不会按名字扫全机）。交互式安装仍会先在「准备安装」页列出并征求用户同意。
CloseApplications=force
; 默认过滤器只有 *.exe,*.dll,*.chm,*.ocx,*.sys。启动器真正被占住的是 resources\app.asar
; 和 resources\node-archive\*.zip —— 不把这两类算进去，RM 就只认得半个正在运行的启动器
; （子进程往往只握着 asar），关不干净还是会漏文件。
CloseApplicationsFilter=*.exe,*.dll,*.asar,*.zip,*.pak,*.bin,*.dat,*.chm,*.ocx,*.sys
; 不自动重开：被 force 结束的是同一个 exe 的 6 个进程，RM 会把它们逐个拉起来，装完就是一串
; 一闪而过的重复实例（单实例锁能挡住多余窗口，但托盘图标会跳）；而静默安装本来就不该顺手
; 起一个 GUI。想让用户装完就用，走 [Run] 那条（交互式安装的「立即运行」，silent 不执行）。
RestartApplications=no


; Inno Setup 6.7 起官方安装包不再附带简体中文语言包（ChineseSimplified.isl 属于
; 「非官方语言」，要自己下载放进 Languages 目录），所以向导外壳用内置英文，
; 安装器自己的文案（任务、快捷方式、程序组）全部由下面的 [CustomMessages] 给中文。
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
LauncherDesktopIcon=创建桌面快捷方式
LauncherGroupIcons=附加快捷方式
LauncherLaunchProgram=立即运行 {#AppName}
LauncherUninstall=卸载 {#AppName}

[Tasks]
Name: "desktopicon"; Description: "{cm:LauncherDesktopIcon}"; GroupDescription: "{cm:LauncherGroupIcons}"; Flags: checkedonce

[InstallDelete]
; 【升级清旧内核】{app}\resources\kernels 下只该有本版随包的那一个内核（当前 0.2.1-rc.2）。
;
; 为什么需要：Inno 的 [Files] 只往里铺，不删「本版已经没有的文件」。内核目录名就是版本号，
; 换一次内核就多一个目录，旧的那个原地留下 —— 1.0.24 装完 resources\kernels 里就同时躺着
; 0.2.0-rc.2（26,625 文件 / 542MB）和 0.2.1-rc.2（63,619 文件 / 781MB），白占 542MB。
;
; 为什么整目录删，而不是在 [Code] 里按版本号逐个比对：随包内核不是 iss 里的常量，而是
; electron-builder 的 extraResources 把 runtime\kernels 整个烤进 release\win-unpacked 的产物。
; 在这里写死一个 #define KernelVersion 就等于多一个必须在升内核时手工同步的点，忘一次就
; 复发 —— 这次留下的 0.2.0-rc.2 就是这么来的。整目录删完由下面的 [Files] 原样铺回，永远
; 等于本版产物，没有需要维护的版本号。
;
; 顺序与安全性：InstallDelete 在文件复制之前执行；[Files] 的 Source 是 {#UnpackedDir}\* 且带
; recursesubdirs，覆盖 resources\kernels\<版本>\** 全部，所以删掉的一定会被装回来。
; 额外代价只有「先删一遍」这一步，这些文件本来就要被 ignoreversion 全量重写。
; 中途失败（断电 / 用户取消）只会留下一个没有 kernels 的安装目录，重跑安装包即恢复；
; 不会出现新旧内核混装的半截状态，也不会碰到 {app}\dsh-packs（整合包在同一层，不在 kernels 里）。
;
; 生效范围：本规则要被编进安装包才生效。已经装好的 1.0.24 不受影响；从下一个用本脚本
; 编出来的版本开始，每次安装都会先清空 kernels 再铺本版内核。
Type: filesandordirs; Name: "{app}\resources\kernels"

[Files]
; electron-builder --dir 的整份目录产物原样铺进安装目录（exe/dll/asar/资源一个不少）。
Source: "{#UnpackedDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autoprograms}\{cm:LauncherUninstall}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LauncherLaunchProgram}"; Flags: nowait postinstall skipifsilent

[Code]
// 卸载不删包（配套 [UninstallDelete] 的说明）。
//
// 整合包根目录 = {app}\dsh-packs，落在安装目录内部；卸载器只按自己的卸载日志删除
// [Files] 装进去的文件，dsh-packs 是启动器运行时才创建的、日志里没有，所以原样保留。
// 下面这段不做任何删除/移动，只在交互式卸载时把这件事明确告诉用户，
// 免得用户以为「卸载了所以包也没了」，又去别处找。
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  PacksDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    PacksDir := ExpandConstant('{app}\dsh-packs');
    if DirExists(PacksDir) and not UninstallSilent then
      MsgBox('卸载只删除启动器本体，整合包会原样保留：' + #13#10 + PacksDir + #13#10 + #13#10
             + '不再需要时请自行删除该目录。' + #13#10 + #13#10
             + '注意：正在运行的实例是独立进程（输出写各自的 logs\launcher.out.log），'
             + '安装、卸载、退出启动器都不会结束它们；要停请回整合包页点电源键。', mbInformation, MB_OK);
  end;
end;

[UninstallDelete]
; 【卸载不删包】整合包根目录默认在 {app}\dsh-packs（安装目录**内部**）。
;
; 这里绝不能出现 Type: filesandordirs; Name: "{app}" —— 那条会递归删掉整个安装目录，
; 连用户几十 GB 的整合包一起删。删掉它之后，卸载只走 Inno 的卸载日志：
; 日志里逐条记着 [Files] 装进去的文件，运行时才出现的 dsh-packs 不在日志里，
; 因此一个字节都不会被碰（{app} 目录本身也因为非空而保留）。
;
; 这里唯一的一条是 dirifempty：{app} 里还有东西（典型的就是 dsh-packs）时目录保留，
; 空目录才清掉。它不递归删除任何内容，所以对整合包零风险。
; 配套的交互式提示见上方 [Code] 的 CurUninstallStepChanged。
; （不要在这里加 Type: filesandordirs; Name: "{app}\dsh-packs" 之类的「清理」，
;   那正是要避免的数据丢失。）
Type: dirifempty; Name: "{app}"
