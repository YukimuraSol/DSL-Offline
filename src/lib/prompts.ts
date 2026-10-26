/**
 * 提示词草稿：启动器自己不动用户的文件，只把「照做的步骤」交给 agent。
 * 三段都在前端拼装，主进程不需要知道内容；集成阶段若需要真实路径，再从这里取参数。
 */

const SAFE_PACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const PACK_NAME_RULE = '只能用字母、数字、点、下划线、连字符，首字符必须是字母或数字，最长 64 个字符'

/**
 * 搬家：把现有这台机器上的 DSH 家目录按启动器规范落成一个**目录**（不是整合包文件）。
 *
 * @param dshHome     源家目录（用户正在用的那个，如 C:\Users\ASUS\.dsh）
 * @param packName    条目名称，由用户自己定。名称拆成两个：目录名（必须过 SAFE_PACK_NAME）与显示名（可中文）。
 *                    传空 = 名称还没定，提示词第一件事就是让 agent 问用户要这两个名字。
 * @param packsRoot   启动器的整合包根目录真路径（可选，渲染层用 launcher:packs-root 取）。
 *                    只有「名称合法 + 根目录拿到」时才拼绝对路径。
 * @param launcherExe 启动器可执行文件真路径（可选，渲染层用 launcher:executable-path 取）。
 *                    给了就在第六节写出可以直接复制的自检命令；没给就写「用启动器的 --verify 子命令」，不编路径。
 */
export function migratePrompt(dshHome: string, packName?: string, packsRoot?: string, launcherExe?: string): string {
  const given = (packName ?? '').trim()
  const root = (packsRoot ?? '').trim().replace(/[\\/]+$/, '')
  const nameOk = SAFE_PACK_NAME.test(given)
  // 目录名与显示名是两个东西：目录名必须是 ASCII（启动器拿它当包 id、也是 profiles 下那一层），
  // 显示名写进 profile.yaml 的 name:，中文完全可以。
  const dirName = nameOk ? given : '<目录名>'
  // 名称未定时 dest 退化成自然语言描述，全文不出现任何可照着建的绝对路径，
  // 免得 agent 真去建一个叫「<目录名>」的目录。
  const dest = nameOk && root ? root + '\\' + given : '启动器的整合包目录下的一个新目录'
  const exe = (launcherExe ?? '').trim()
  // 自检命令：有 exe 路径就写完整可复制的一行（目标目录也拿到时直接补真路径）；
  // 没有就写相对描述，绝不编一个假盘符路径。
  // 末尾统一接上 2>&1 | Out-String：启动器是 GUI 子系统程序，PowerShell 的纯文件重定向
  // 对它既不挂句柄也不等退出，agent 自己接一个 > out.txt 会拿到 0 字节，误判成「自检没输出」。
  const selfCheck = exe
    ? '   "' + exe + '" --verify "' + (nameOk && root ? dest : '<目标目录>') + '" 2>&1 | Out-String'
    : '   用启动器的 --verify 子命令：<启动器 exe 路径> --verify <目标目录> 2>&1 | Out-String'
  return [
    '把我在用的 DSH 环境按启动器规范搬成一个目录。产出物是一个**文件夹**（不是 zip、不是整合包文件），',
    '最终落在：' + dest + (nameOk && root ? '' : '   ← 等你定了目录名再建，别自己编一个'),
    '',
    '源环境在家目录：' + dshHome,
    '',
    '--- 一、先说清楚产出物是什么 ---',
    '',
    '目标目录本身就是一个 DSH 家目录（DSH_HOME），里面只有一个 profile。',
    '启动器把「一个家目录」当一个整合包：家目录下 profiles 里那唯一一个目录，就是这个包的 profile。',
    '目录摆好就完事：启动器下次启动会自己扫到这个目录，不用打包、不用再解压、也不用点任何按钮。',
    '',
    '--- 二、先出规划，我说「开始」你再动手 ---',
    '',
    '这是搬家，不是做给别人下载的包。下面这些默认值我已经定好，你按默认值填，不要逐项来问我。',
    '',
    '**默认复制过去（写进规划，不要问我）**：',
    '- 所有已安装插件，包括本体在别的盘的（link: / 绝对路径依赖），本体一起拷进包内',
    '- 家目录顶层的 cordis.patch.yml 与 package.json：这两个必须带。',
    '  本机的 cordis.patch.yml 里 insert 了插件，不带的话插件会静默消失，启动器列表里就什么都不剩了。',
    '- 家目录顶层的 AGENTS.md，整份带',
    '  它是全局规则，这个包里所有会话都读它。profile 里的 AGENTS.md、插件自带的指令不算全局，属于插件自身，跟着插件走。',
    '- profiles\\node_modules\\：必须带。内核包在这里（实测 450MB 上下、两万多个文件），漏了整个包起不来。',
    '- 所有 skill、所有 Agent 预设',
    '- 会话记录：sessions\\、dsh-session-archive\\、attachments\\',
    '- 用户的持久数据：storages\\',
    '- 凭据：.credentials.yaml、.anonymous-user-id',
    '- 插件在家目录下自己建的状态目录、以及含密钥的插件目录：带，逐个列名字',
    '',
    '**默认清掉（写进规划，不要问我）**：',
    'logs\\、cache\\、tmp\\、plans\\、rewind-snapshots\\、dsh-usage\\、task-board\\、',
    'launch-token.json、remote-web-ui-devices.json，',
    '以及手改留下的备份：任意层级、名字里含 backup 或以 .bak 结尾的（不分大小写）。',
    '',
    '**总则：清单里没点名的顶层条目一律不带。** 没点名的既不拷、也不删——留着别管它，别自作主张帮我清理。',
    '',
    '**规划里要写清这五组清单**：',
    '1. 插件：逐个列包名，注明哪些的本体在别的盘、要拷进包内',
    '2. skill 与 Agent 预设：逐个列名字，没有就写「无」',
    '3. AGENTS.md 与家目录顶层的 cordis.patch.yml、package.json：整份带（默认），有特殊情况就说明',
    '4. 会话与持久数据：sessions / dsh-session-archive / attachments / storages 各多少、多大，一句话',
    '5. 要清掉的东西：按上面的默认清单，说明实际清掉哪些',
    '',
    '顺手做一件事：凡是要带的目录，先打开看一眼里面有没有 apiKey / apiKeyEnv / token 这类字段，',
    '有就在规划里单独起一行「**以下含密钥**」，把目录名和文件名列出来。凭据按这个判，不按目录名猜。',
    '',
    '**只有一件事必须问我**：条目名称，两个名字，不是一个：',
    '   - **目录名**：必须 ASCII，' + PACK_NAME_RULE + '。',
    '     启动器拿它当包 id，也是 profiles 下那一层目录名。中文、空格、斜杠都不行。',
    '   - **显示名**：写进 profiles\\<目录名>\\profile.yaml 的 name: 字段，**中文完全可以**，这才是启动器列表里看到的那个名字。',
    '   先问我要这两个名字。我给不出目录名时，你按显示名给个 ASCII 建议让我确认。',
    '',
    '**规划列完就停下来，等我说「开始」或「就这样」。** 我没点头之前不要建目录、不要拷任何文件。',
    '我说了之后再一口气做完，中途不用再问一遍；我改过的地方以我改的为准。',
    '',
    '--- 三、目标结构规范（照这个建，一项都不能少、一项都不能多） ---',
    '',
    '<目标目录>\\                              ← 这一个包的 DSH 家目录（= DSH_HOME）',
    '  cordis.patch.yml                    ← 家目录级补丁层，原样带过来（里面有 insert 的插件）',
    '  package.json                        ← 家目录级依赖清单，原样带过来',
    '  AGENTS.md                           ← 全局规则，整份带',
    '  profiles\\',
    '    node_modules\\                     ← 内核包，整目录带，不筛内容',
    '    ' + dirName + '\\                    ← 唯一的 profile，目录名必须等于包 id',
    '      package.json                    ← dependencies 每一项都写 file:./.dsh-launcher-plugin-bodies/<插件名>',
    '      cordis.patch.yml                ← profile 级补丁层，原样带过来，不要重排、不要改注释',
    '      profile.yaml                    ← 至少要有 name: 与 dshVersion: 两个字段',
    '      node_modules\\                   ← 只有指向插件本体的 junction（门），不许留 .pnpm、不许留 .modules.yaml',
    '      .dsh-launcher-plugin-bodies\\    ← 插件本体实体副本，每个插件一个目录',
    '  sessions\\                           ← 会话记录，整目录带',
    '  dsh-session-archive\\                ← 归档会话，整目录带',
    '  attachments\\                        ← 会话附件，整目录带',
    '  storages\\                           ← 用户持久数据，整目录带',
    '  <插件状态目录>\\                     ← 插件在家目录下自己建的持久目录，按规划逐个带',
    '  <含密钥的插件目录>\\                 ← 含 API Key 的插件目录，按规划逐个带（规划里标了「以下含密钥」的）',
    '  skills\\                             ← 技能；源有就整目录带，没有就跳过（不要建空目录）',
    '  .agent-presets\\                     ← Agent 预设；源有就带，没有就跳过',
    '  extras\\                             ← 只放和 DSH 没有直接关系的东西：说明书、素材、外部工具等，整目录照拷，不筛内容',
    '',
    '每一项的作用：',
    '- 家目录那层的 cordis.patch.yml / package.json 是家目录自己的补丁层与清单，不是 profile 的，两层都要。',
    '- profiles/ 下那个 profile 目录是这个包的「清单层」，启动器只认这一个 profile。',
    '- package.json 的 dependencies 是插件清单的唯一真实来源；键是包名，值是 file: 相对路径。',
    '- cordis.patch.yml 是 Cordis 的补丁层（插件启用顺序等），原样保留。',
    '- profile.yaml 是启动器自己读的元数据；name 是显示名（可中文），dshVersion 决定要用哪个 DSH 跑。',
    '- profiles/node_modules 是内核包本体，DSH 从这里起；profile 的 node_modules 只是「门」。',
    '- profile 的 node_modules 只是「门」：每个插件一个指向 .dsh-launcher-plugin-bodies 的 junction。',
    '- .dsh-launcher-plugin-bodies 是插件本体的实体副本，包能带走就靠它。',
    '- extras 是给人看的东西，DSH 自己不读，也不要往里塞 DSH 要用的文件；它不能叫 attachments（那个名字底座已经占用了，指会话附件）。',
    '',
    '--- 四、硬性规矩（逐条照做） ---',
    '',
    '0. **这是复制，不是移动。** 源环境（' + dshHome + '）全程只读：可以读、可以拷出来，',
    '   但绝不允许改名、移动、删除、清空、覆盖其中任何一个文件或目录。',
    '   搬完之后源环境必须跟搬之前一模一样，我随时还要用它。所有写操作只发生在目标目录里。',
    '1. 路径一律写包内相对路径。package.json 与任何配置文件里都不许留下 D:\\ 或 C:\\ 这类绝对路径。',
    '2. 插件本体从原位置拷进 profiles\\' + dirName + '\\.dsh-launcher-plugin-bodies\\<插件名>\\，跳过备份文件。',
    '   本体自带 node_modules 的，按里面三种形态分别处理，不要写死本机目录名：',
    '     a. 指向内核包的 junction → 换成分指向包内 profiles\\node_modules\\ 的对应包',
    '     b. 指向其他插件或 .pnpm 虚拟库的 junction → 本体已经随包带走，改指包内对应位置',
    '     c. 实体目录 → 直接照拷，不要动里面的内容',
    '3. package.json 里那一行统一改成 file:./.dsh-launcher-plugin-bodies/<插件名>。',
    '   原来的 link: 也要改——启动器读包时只认包内相对路径，link: 带的是本机绝对路径，换台机器就断。',
    '4. **目标副本里**的 node_modules 下旧 junction 全部删掉，按新位置重建（junction 存的是绝对路径，搬一次就断）。',
    '   这句话只管目标副本：源环境的 junction 一个都不要碰。',
    '5. 删掉目标副本里的 node_modules/.modules.yaml（留着 pnpm 会报 ERR_PNPM_UNEXPECTED_VIRTUAL_STORE），',
    '   同理删掉 node_modules/.pnpm-workspace-state-v1.json 与 node_modules/.package-map.json。',
    '6. 不跑 pnpm install（跑不跑都不影响，跑了反而会重建 .pnpm 把包弄脏）。',
    '7. 收尾再核一遍第 0 条：源环境一个字节都不要改，它原地不动。',
    '',
    '--- 五、产物只落在一个地方 ---',
    '',
    '只认一个最终位置：启动器的整合包目录下那个新建的目录。',
    '桌面上、源 .dsh 旁边，一律不留副本，也不要留中间态目录。',
    '需要暂存可以在系统临时目录里建一个（只有这里允许），但收尾时必须删干净（见第六节第 1 条）。',
    '**源环境不属于「产物」**，它原地不动——不要因为「只留一个位置」就把源目录删掉。',
    '',
    '--- 六、收尾：自清 + 自查 ---',
    '',
    '1. 删掉你建的临时脚本（*.ps1 / *.mjs / *.py / *.bat 之类）、临时解压目录、备份副本，以及临时目录里的暂存物。',
    '2. 跑一遍启动器自带的命令行自检，六条：清单与目录对得上 / 没有对不上号的散件 / 链接不指向包外 /',
    '   插件入口存在 / 内核版本匹配 / 每个插件的依赖能在包内解析：',
    selfCheck,
    '   退出码 0 = 六条全过；1 = 有对不上号的（输出里会写清是哪条、怎么改）；2 = 自检没跑起来。',
    '   **采集方式**：这个 exe 是 GUI 子系统程序，PowerShell 里不要用 >、1>、2>、*> 这类纯文件重定向，',
    '   它对 GUI 程序既不挂标准输出句柄、也不等进程退出——命令几十毫秒就返回、文件永远是 0 字节，看着像「自检没输出」。',
    '   要落盘就用上面那行这种 2>&1 | Out-String；或者 cmd /c "\\"<启动器 exe 路径>\\" --verify \\"<目标目录>\\" > out.txt 2>&1"',
    '   （cmd 会等它退出，所以能拿到内容）；或者 PowerShell 的',
    '   Start-Process -Wait -RedirectStandardOutput out.txt -RedirectStandardError err.txt。',
    '   读到空输出先怀疑采集方式，别直接判「自检没跑起来」，也别判「自检没输出」。',
    '   命令是首选路径，不是唯一手段。exe 找不到、这台机器没有 --verify 子命令、或者命令直接报错，',
    '   就按上面这六条人工核一遍，别卡在这儿不往下走。',
    '   注意区分两件事：命令本身能跑、只是你看不到输出，那是采集方式不对——换一种重跑一次再判定，',
    '   别把「看不到」当成「跑不通」。',
    '   **报告里必须写明这次是「跑过命令」还是「人工核的」**，不许含糊带过。',
    '   不许用 tree 代替第 3 条：那要读 junction 的真实目标，肉眼看不出来。',
    '3. 不管命令跑没跑通，都再逐个插件过一遍依赖，四个检查项：',
    '   a. 每个插件 package.json 的 main（或 exports["."]）指向的文件在包内存在',
    '   b. 它的 dependencies / peerDependencies 每一项都能解析到——沿「插件自己的 node_modules →',
    '      profiles\\<目录名>\\node_modules → profiles\\node_modules → 内核」这个顺序，跟 Node 一样',
    '   c. 每个 junction 的 LinkType 与 Target 都指向包内，没有指向包外的',
    '   d. 插件源码里写到的家目录路径（形如 ~/.dsh/xxx 或 join(home, "xxx")）对应的目录在包里存在',
    '4. 用 tree 或 readdir 把目标目录的最终结构列给我看，对照第三节的结构规范逐项核对。',
    '5. 明确告诉我：有没有非预期文件（该在的不在、不该在的在）。',
    '6. 最后告诉我：把包放在这个位置之后，启动器启动时会自动扫到它，不需要额外点任何按钮。',
    '',
    '启动器下次启动会自己把这个目录认成整合包，在列表里出现，点启动就能跑。',
  ].join('\n')
}

/**
 * 导出：把当前整合包交给启动器自己的装配引擎，产出一个能离线分发的 zip。
 *
 * 以前这份提示词让 agent 扫插件、打 tgz、算 sha512、写 manifest、排 installOrder，再拿 --workbench
 * 反过来验 —— 现在那套手搓流程全在 electron/pack-offline-export.ts 里
 * （exportOfflinePack + verifyOfflinePack），1.0.18 起由 --export-pack <包id> [输出目录] 暴露成一条命令。
 * 提示词因此只剩三件事：跑命令、读退出码与最后一行 JSON 摘要、把结果报回来。
 *
 * 命令管不了的事实仍留在提示词里：凭据与会话一律不带（extras\ 要带）、对方自己填 Key、导出源只读。
 *
 * @param packName    整合包显示名，写进开头一句
 * @param pluginCount 插件数量，写进开头一句
 * @param exportDir   启动器给出的导出目录；空 = 未取到，命令里写 <导出目录> 占位，并说明默认落 dsh-exports
 * @param packId      整合包 id：既是 --export-pack 的参数，也是 zip 文件名（ASCII；中文和空格会把标识打散）
 * @param launcherExe 启动器 exe 真路径；空则命令那行只写 <启动器 exe 路径>，不编路径
 */
export function exportPrompt(
  packName: string,
  pluginCount: number,
  exportDir: string,
  packId: string,
  launcherExe: string,
): string {
  const exe = (launcherExe ?? '').trim()
  const count = Number.isFinite(pluginCount) ? Math.max(0, Math.trunc(pluginCount)) : 0
  // 包 id 同时是 zip 的文件名，导入端还会拿它派生实例 id：先收紧成 ASCII 标识，中文显示名走 packName。
  const id = (packId ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'pack'
  // 末尾分隔符先削掉，拼路径时统一补一个反斜杠（'D:' 补出来正好是盘根 'D:\'）。
  const dir = (exportDir ?? '').trim().replace(/[\\/]+$/, '')
  const zipPath = dir ? dir + '\\' + id + '.zip' : 'dsh-exports\\' + id + '.zip'
  return [
    '把整合包「' + packName + '」（' + count + ' 个插件）导出成能离线交给别人的 zip：调启动器自带的命令，别自己扫插件、打 tgz、算校验、写 manifest。',
    '',
    '命令：',
    '  "' + (exe || '<启动器 exe 路径>') + '" --export-pack "' + id + '" "' + (dir || '<导出目录>') + '" 2>&1 | Out-String',
    '输出目录不给就落到启动器安装目录下的 dsh-exports；产物是 ' + zipPath + '，zip 里顶层是一个同名文件夹（manifest.json + vendor\\ + extras\\），解压即得包目录。',
    '导出源全程只读：不许改名、移动、删除其中任何文件。',
    '',
    '结果这么读：',
    '- 退出码 0 = 成功，1 = 导出失败，2 = 校验没过（manifest / vendor / integrity / extras 由命令自己核过，别再人工对清单）。',
    '- 最后一行 stdout 是 JSON 摘要：{"zip":"<绝对路径>","plugins":N,"vendorFiles":N,"vendorBytes":N,"extras":{"files":N,"bytes":N,"dirs":N}}。',
    '- 采集方式：启动器是 GUI 子系统程序，PowerShell 里必须 2>&1 | Out-String；用 > / 1> / 2> 会几十毫秒返回、文件 0 字节，看着像没输出。',
    '- 退出码 2：把 stdout/stderr 原样贴回来，别自己改包、别手工补 manifest。',
    '',
    '命令管不了的事实：',
    '- 凭据与会话永远不进包：.credentials.yaml、sessions\\、dsh-session-archive\\、attachments\\ 一律不带；extras\\ 是用户自己放的附件，要带。',
    '',
    '收尾：报告 zip 的绝对路径 + 摘要里四个数（插件 / tgz / extras 文件数 / 合计多大），写明这个包不含凭据、不含会话记录；',
    '告诉对方怎么用 —— 解压 → 启动器「导入整合包」→ 选解压出来的文件夹 → 起实例名 → 自己填 API Key；删掉临时脚本。',
  ].join('\n')
}
