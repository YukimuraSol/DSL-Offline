/**
 * 「导入整合包」弹窗与主进程共用的一点点纯逻辑。
 *
 * 放在 lib 里（不是对话框里也不是主进程里）只有一个理由：**失败原因必须两边一个口径**。
 * 主进程把预检结果翻成人话再交给界面，界面自己也要用同一批句子做「同名的别装」这类即时提示；
 * 抄两份迟早对不上，改了一边忘了另一边。
 *
 * 三条硬约束（都是验收项）：
 *   1. 面对用户的句子里绝不出现绝对路径——路径只进日志。
 *   2. 不出现百分比、插件个数，也不出现 installOrder / tgz / junction 这类内部词。
 *   3. 不口语化，但也不是机器腔：说人话，能照着做。
 */

import type { PackImportStage } from '../types'

/** 装配阶段 → 状态行右上的那行小字。主进程推来的阶段码只有这几个。 */
export const IMPORT_STAGE_TEXT: Record<PackImportStage, string> = {
  precheck: '检查整合包',
  // 包里自带内核而本机没有这个版本时会出现：把内核解到本机（约一两分钟）。
  kernel: '解出内核',
  skeleton: '准备实例',
  install: '装配插件',
  extras: '复制附件',
  verify: '核对结果',
  done: '收尾',
}

/**
 * 预检阻塞码 → 一句人话。
 * 码表与 electron/pack-offline-import.ts 里 block() 的第一参数一一对应；
 * 那边多一个码这边就多一句，漏了会落到下面的兜底句（宁可含糊，也不把原始 message 摆出来）。
 */
const BLOCKED_REASON: Record<string, string> = {
  'pack-missing': '这个文件夹已经不在了，可能被移走或改名了。',
  'manifest-missing': '这个文件夹不是整合包：里面没有包目录清单。',
  'manifest-invalid': '整合包的目录清单读不出来，可能已经损坏。',
  // 压缩包那条路：解包与定位失败也走同一张码表（码值来自 electron/pack-offline-zip.ts）。
  'zip-unreadable': '这个压缩包打不开，可能已经损坏。',
  'zip-unsafe-entry': '这个压缩包里有不安全的路径，不能导入。',
  'zip-manifest-missing': '这个压缩包里没有 manifest.json，可能不是整合包。',
  'zip-manifest-ambiguous': '压缩包顶层有多个整合包，没法判断要装哪一个。',
  'vendor-missing': '整合包不完整：少了包内文件目录。',
  'vendor-empty': '整合包不完整：包内文件一个都没有。',
  'vendor-missing-file': '整合包不完整：清单里列出的文件有缺失。',
  'tgz-integrity': '整合包在拷贝过程中损坏了，重新拷一份再试。',
  'tgz-unreadable': '整合包里有文件打不开，重新拷一份再试。',
  'extras-missing': '整合包不完整：少了附件目录。',
  'home-missing': '要装配到的位置已经不在了。',
  'kernel-missing': '本机没有这个整合包要求的 DSH 版本，先去装好它。',
  'kernel-version-mismatch': '本机的 DSH 版本和整合包要求的不一致，先装好对应版本。',
  'instance-exists': '这个文件夹已经导入过了，先删掉那个实例，或者换个文件夹名。',
  'dependency-missing-required': '整合包里有内容要用到本机没有的东西，装上也起不来。',
  'unsafe-id': '名字只能用字母、数字和 - _ .，并且要以字母或数字开头。',
}

export function blockedReason(code: string): string {
  return BLOCKED_REASON[code] ?? '整合包没有通过检查。'
}

/** 系统错误码 → 人话（比原始 errno 文案有用，也不带路径）。 */
const SYSTEM_REASON: Record<string, string> = {
  ENOENT: '要读的文件找不到了，可能被移走或改名了。',
  EACCES: '没有权限写这个位置，换个目录或检查权限。',
  EPERM: '没有权限写这个位置，换个目录或检查权限。',
  ENOSPC: '磁盘空间不够了。',
  EBUSY: '有文件正被别的程序占用，关掉那个程序再试。',
  EEXIST: '这个位置上已经有东西了，换个名字再导入。',
}

/**
 * 导入失败的兜底人话。
 * 只认「已知的几种」，其余一律收敛成同一句：原始 message 里几乎必然带绝对路径和内部词，
 * 直接摆给用户既看不懂又把路径露出去了。要排查就去看日志。
 */
export function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && SYSTEM_REASON[code]) return SYSTEM_REASON[code]
  const message = error instanceof Error ? error.message : String(error)
  // 错误码也常只出现在文案里（"ENOENT: no such file or directory, open '…'"）。
  const token = /\b(E[A-Z]{2,})\b/.exec(message)?.[1]
  if (token && SYSTEM_REASON[token]) return SYSTEM_REASON[token]
  if (message.includes('已被另一个整合包占用')) return '已经有同名的实例了，换个名字再导入。'
  if (message.includes('字母或数字')) return '这个文件夹名里要有字母或数字。'
  return '装配中途停下来了。具体原因记在日志里。'
}

/** 与 electron/pack-manifest.ts 的 PACK_PROFILE_PREFIX 同一个前缀。 */
const PACK_ID_PREFIX = 'pack-'

/**
 * 包文件夹名 → 包标识（= 磁盘上的家目录名 = Profile 名），与主进程 packProfileName 同一口径：
 * 小写 + 非安全字符一律变 -。
 *
 * 为什么标识取文件夹名而不是实例名：文件夹名由导出端生成、只会是 ASCII（本来就是个标识），
 * 而实例名允许中文。两者拆开，中文名才不会退化成 pack------。
 */
export function packIdOf(folderName: string): string {
  return PACK_ID_PREFIX + folderName.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

/**
 * 包文件夹名能不能拿来装配；返回 null = 可以。`existingPackIds` 是列表里现有的包标识。
 * 撞名 = 这个文件夹已经导入过：家目录会被占，主进程也会拒绝，界面先一步挡住。
 */
export function folderNameIssue(folderName: string, existingPackIds: readonly string[]): string | null {
  const trimmed = folderName.trim()
  if (!trimmed) return '先选整合包所在的文件夹。'
  const packId = packIdOf(trimmed)
  // 只看 pack- 前缀后面的部分，否则光是前缀里的 "pack" 就把检查骗过去了。
  if (!/[a-z0-9]/.test(packId.slice(PACK_ID_PREFIX.length))) return '这个文件夹名里要有字母或数字。'
  // 以下两条与主进程 isSafeProfileName（electron/profile.ts）同一口径：
  // 落盘的是 pack + 这个词，所以路径分隔符、空格、中文都不许出现在这里——
  // 绝不能让用户看到一个「改了但被悄悄换成 -」的文件夹名。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return '文件夹名只能用字母、数字、点、横线或下划线，并且以字母或数字开头。'
  }
  // 主进程要求 Profile 名（含 pack- 前缀）不超过 64 位，这里先按同一上限挡住。
  if (PACK_ID_PREFIX.length + trimmed.length > 64) return `文件夹名太长了，${64 - PACK_ID_PREFIX.length} 个字符以内。`
  if (existingPackIds.includes(packId)) return '这个文件夹已经导入过了，先删掉那个实例，或者换个文件夹名。'
  return null
}

/**
 * 实例名（显示名）的即时检查；返回 null = 可以导入。
 * 允许中文：它只是列表里给人看的名字，磁盘标识取的是文件夹名（见 packIdOf）。
 */
export function instanceNameIssue(name: string, existingNames: readonly string[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '给新实例取个名字。'
  if (trimmed.length > 60) return '名字太长了，60 个字以内。'
  if (existingNames.some(existing => existing.trim().toLowerCase() === trimmed.toLowerCase())) return '已经有同名实例了，换个名字。'
  return null
}

/** 已选路径的简短显示：只留最后两级，前面用 … 代替（完整路径走 title 与日志）。 */
export function shortPackPath(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return ''
  return parts.length <= 2 ? parts.join('\\') : '…\\' + parts.slice(-2).join('\\')
}

/** 选中的是不是一个 .zip 整合包（.dspack 等老格式不在这里认）。 */
export function isZipPath(target: string): boolean {
  return /\.zip$/i.test(target.trim())
}

/** 包目录名：新实例的默认名字，「新建「…」」里显示的就是它；压缩包按去掉 .zip 的文件名算。 */
export function packDirName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return isZipPath(last) ? last.slice(0, -4) : last
}
