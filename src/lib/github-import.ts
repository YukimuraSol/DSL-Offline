/**
 * 从 GitHub 链接解析出仓库名（owner/repo）与可选分支。
 * 纯函数、无网络、无 node 依赖 —— 渲染层（demo）、主进程与测试三处共享。
 */

export interface GitHubImportParseResult {
  fullName: string
  /** 从链接 /tree/<branch> 或 /blob/<branch> 解析出的分支；缺省时由调用方决定。 */
  defaultBranch?: string
}

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function isSafeGitHubBranch(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

/**
 * 解析 GitHub 仓库链接 → { fullName, defaultBranch? }。
 * 支持：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<branch>[/subdir...]   （只取首段作分支）
 *   https://github.com/owner/repo/blob/<branch>/path
 *   git@github.com:owner/repo.git  /  git+https://github.com/owner/repo.git
 *   github:owner/repo  /  owner/repo  /  github.com/owner/repo
 * 非 GitHub / 无法解析时抛出中文错误。
 * 注意：子目录被忽略 —— 检测会扫描整棵仓库树，安装目标自带 subdirectory；
 * 含 '/' 的分支名（如 feature/foo）只取首段，属已知限制。
 */
export function parseGitHubImportUrl(value: string): GitHubImportParseResult {
  const input = value.trim()
  if (!input) throw new Error('请输入 GitHub 仓库链接。')

  // 无 scheme 的 github.com/owner/repo 补全 https，统一走 URL 解析。
  const normalized = /^github\.com\//i.test(input) ? `https://${input}` : input

  let url: URL | null = null
  try {
    url = new URL(normalized)
  } catch {
    url = null
  }

  if (url && url.hostname.replace(/^www\./i, '').toLowerCase() === 'github.com') {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) throw new Error('GitHub 链接缺少仓库名称。')
    const fullName = `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
    if (!REPOSITORY_NAME.test(fullName)) throw new Error('GitHub 仓库名称无效。')
    const mode = segments[2]
    if ((mode === 'tree' || mode === 'blob') && isSafeGitHubBranch(segments[3] ?? '')) {
      return { fullName, defaultBranch: segments[3] }
    }
    return { fullName }
  }

  // scp 形式：git@github.com:owner/repo.git
  const scp = /(?:^|@)github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input)
  if (scp) {
    const fullName = `${scp[1]}/${scp[2]}`
    if (!REPOSITORY_NAME.test(fullName)) throw new Error('GitHub 仓库名称无效。')
    return { fullName }
  }

  // 快捷形式 / 裸名：github:owner/repo、owner/repo（允许 .git 与 #ref 后缀）
  const shortcut = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/.exec(input)
  if (shortcut) {
    const fullName = `${shortcut[1]}/${shortcut[2]}`
    if (!REPOSITORY_NAME.test(fullName)) throw new Error('GitHub 仓库名称无效。')
    return { fullName }
  }

  throw new Error('只支持 GitHub 仓库链接。')
}
