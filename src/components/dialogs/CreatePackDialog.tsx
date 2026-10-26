import { PackagePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { compareDshVersions, parseDshVersion } from '../../lib/dsh-version'
import { ModalShell } from './ModalShell'

/**
 * 「新建整合包」弹窗（稿 lch-create）：文件夹名 + 整合包名两个输入，底部一行写死核心。
 *
 * 两条硬规则：
 *   1) 核心不让用户挑 —— 固定为 0.2.1 系列里本机已安装的最新一个；一个都没有时创建按钮禁用并说明原因。
 *   2) 文件夹名就是磁盘目录名（= 包标识 = Profile 名），所以只收 ASCII 字母数字与 - _；
 *      整合包名只是列表里给人看的那一行字，留空时跟随文件夹名。
 */

/** 新建实例的核心固定在这个系列里已安装的最新一个（当前是 0.2.1-rc.2）。 */
export const NEW_PACK_DSH_SERIES = '0.2.1'

/** 文件夹名允许的字符：它同时是磁盘目录名与 Profile 名，中文进不去。 */
const FOLDER_NAME_RE = /^[A-Za-z0-9_-]+$/

/** 今天（本地时区）的默认文件夹名：pack-YYYYMMDD。 */
export function defaultPackFolderName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `pack-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

/**
 * 系列里最新的已安装版本；没有就返回 null（按钮禁用 + 一行提示，绝不静默失败）。
 * 按主版本号取系列（0.2.1 只认 0.2.1 / 0.2.1-rc.x），0.2.10 不会被误算进来。
 */
export function latestSeriesVersion(
  versions: readonly string[],
  series: string = NEW_PACK_DSH_SERIES,
): string | null {
  const inSeries = versions.filter(version => parseDshVersion(version).base === series)
  if (inSeries.length === 0) return null
  return inSeries.reduce((best, next) => (compareDshVersions(next, best) > 0 ? next : best))
}

export interface CreatePackDialogProps {
  /** 本机已安装的 DSH 版本（store.runtimeEnvironment.dshInstalled）。 */
  installedDshVersions: string[]
  /** 主进程正忙（装包/启动实例等）时不许再开一个创建任务。 */
  busy: boolean
  /** 创建；返回 false = 没建成（弹窗留在原地，错误提示走 store 的 toast）。 */
  onCreate(request: { name: string; dshVersion: string; folderName: string }): Promise<boolean>
  onClose(): void
}

export function CreatePackDialog(props: CreatePackDialogProps) {
  const { installedDshVersions, busy, onCreate, onClose } = props
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  /** 整合包名被用户手改过就停止跟随文件夹名（ref：改回来也不算没改过）。 */
  const nameEdited = useRef(false)
  const [creating, setCreating] = useState(false)

  const core = latestSeriesVersion(installedDshVersions)
  const folderValue = folder.trim()
  const resolvedFolder = folderValue === '' ? defaultPackFolderName() : folderValue
  const folderInvalid = folderValue !== '' && !FOLDER_NAME_RE.test(folderValue)
  const resolvedName = name.trim() === '' ? resolvedFolder : name.trim()
  const canCreate = !creating && !busy && core !== null && !folderInvalid

  const hint = folderInvalid
    ? '文件夹名称只能用字母、数字、- 和 _。'
    : core === null
      ? `本机没有 ${NEW_PACK_DSH_SERIES} 内核：先在版本页装好，再回来新建实例。`
      : ''

  /** 文件夹名称变化：整合包名称没被手改过就跟着走（留空时跟到时间戳默认值）。 */
  function onFolderChange(value: string): void {
    setFolder(value)
    if (nameEdited.current) return
    const trimmed = value.trim()
    setName(trimmed === '' ? defaultPackFolderName() : trimmed)
  }

  async function submit(): Promise<void> {
    if (!canCreate || !core) return
    setCreating(true)
    try {
      const ok = await onCreate({ name: resolvedName, dshVersion: core, folderName: resolvedFolder })
      if (ok) onClose()
    } finally {
      setCreating(false)
    }
  }

  return (
    <ModalShell
      className="create-dialog"
      titleId="pack-create-title"
      icon={<span className="build-icon"><PackagePlus size={17} /></span>}
      title="新建整合包"
      onClose={onClose}
      closeDisabled={creating}
    >
      <div className="create-fields">
        <label className="create-field">
          <span className="create-label">文件夹名称</span>
          <input
            className="create-input"
            value={folder}
            placeholder="留空自动使用时间戳"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={event => onFolderChange(event.target.value)}
          />
        </label>
        <label className="create-field">
          <span className="create-label">整合包名称</span>
          <input
            className="create-input"
            value={name}
            placeholder="留空则跟随文件夹名称"
            spellCheck={false}
            autoComplete="off"
            onChange={event => { nameEdited.current = true; setName(event.target.value) }}
          />
        </label>
      </div>
      {hint && <p className="create-hint">{hint}</p>}
      <div className="create-footer">
        <span className="create-core">
          <span className="create-core-label">核心</span>
          <span className={'create-core-value' + (core ? '' : ' is-missing')}>{core ?? '未找到'}</span>
          {core && (
            <span className="create-core-state">
              <span className="create-dot" aria-hidden="true" />已安装
            </span>
          )}
        </span>
        <span className="create-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={creating}>取消</button>
          <button type="button" className="primary-command" onClick={() => { void submit() }} disabled={!canCreate}>
            {creating ? '创建中…' : '创建'}
          </button>
        </span>
      </div>
    </ModalShell>
  )
}
