// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PackImportDialog } from '../src/components/dialogs/PackImportDialog'
import {
  blockedReason,
  failureReason,
  folderNameIssue,
  instanceNameIssue,
  isZipPath,
  packDirName,
  packIdOf,
  shortPackPath,
} from '../src/lib/pack-import'
import type { PackImportOutcome, PackImportProgress, PackImportRequest, PackStatus } from '../src/types'

/**
 * 「导入整合包」弹窗的硬规则（都是验收项，破一条这个界面就不能用）：
 *   1. 阶段事件驱动状态行：主进程说「装配插件」，界面就写「装配插件」，且**永远没有百分比、没有 x/y**。
 *   2. 路径是只读输入框（在「选择压缩包」左边，超长省略，整条路径就在框里，点不进去改）。
 *   3. **没有**「装配到哪个现有实例」这个控件：导入永远新建实例。
 *   4. 文件夹名（可编辑，ASCII 标识；压缩包按去掉 .zip 的文件名算）与实例名（可编辑，允许中文）是两个字段，默认同名；
 *      改过的文件夹名必须原样进请求（folderName），否则就是假可编辑。
 *   5. 失败只说一句人话，且**绝不出现绝对路径**（路径只进日志）。
 *   6. 弹窗有自己的圆角（不靠现场推断）。
 */

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

const PACK_ZIP = 'D:\\packs\\dsh-origin-3080.zip'
/** 压缩包去掉 .zip 之后的文件名：界面拿它当默认实例名。 */
const PACK_NAME = 'dsh-origin-3080'

function pack(id: string, overrides: Partial<PackStatus> = {}): PackStatus {
  return {
    id,
    name: id.toUpperCase(),
    description: '',
    version: '1.0.0',
    dshVersion: '0.9.2',
    source: 'created',
    enabled: false,
    state: 'complete',
    plugins: [],
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as PackStatus
}

interface Probe {
  /** 「选择压缩包」返回的路径（取消 = null）。 */
  picked: string | null
  /** 一次导入的结果；给函数时可以用 deferred 把界面钉在「正在装配」。 */
  outcome: PackImportOutcome | (() => Promise<PackImportOutcome>)
  requests: PackImportRequest[]
  cancelled: number
  listener: ((progress: PackImportProgress) => void) | null
}

/**
 * resolveLauncherApi 会把第一个见到的 window.launcher 缓存住（整个渲染层只一份），
 * 所以探针字段必须挂在**同一个对象**上，用例只改字段。
 */
const currentProbe: Probe = { picked: null, outcome: { ok: false, reason: '' }, requests: [], cancelled: 0, listener: null }

function installApi(probe: Partial<Probe>): void {
  currentProbe.picked = probe.picked ?? null
  currentProbe.outcome = probe.outcome ?? { ok: true, packId: 'pack-dsh-origin-3080', packName: 'dsh-origin-3080' }
  currentProbe.requests = []
  currentProbe.cancelled = 0
  currentProbe.listener = null
  ;(window as unknown as { launcher: unknown }).launcher = {
    pickOfflinePackZip: async () => currentProbe.picked,
    importOfflinePack: async (request: PackImportRequest) => {
      currentProbe.requests.push(request)
      return typeof currentProbe.outcome === 'function' ? currentProbe.outcome() : currentProbe.outcome
    },
    cancelOfflinePackImport: async () => { currentProbe.cancelled += 1 },
    onOfflinePackProgress: (listener: (progress: PackImportProgress) => void) => {
      currentProbe.listener = listener
      return () => { currentProbe.listener = null }
    },
  }
}

const containers: Array<{ root: Root; node: HTMLElement }> = []

async function render(probe: Partial<Probe>, props: Partial<Parameters<typeof PackImportDialog>[0]> = {}) {
  installApi(probe)
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  containers.push({ root, node })
  await act(async () => {
    root.render(
      <PackImportDialog
        packs={[pack('pack-a'), pack('pack-b')]}
        onClose={() => undefined}
        {...props}
      />,
    )
  })
  return node
}

/** 选整合包：点「选择压缩包」，主进程返回探针里的 picked。 */
async function pickZip(node: HTMLElement): Promise<void> {
  const pick = node.querySelector<HTMLButtonElement>('.import-pick')
  await act(async () => { pick?.click() })
}

function importButton(node: HTMLElement): HTMLButtonElement | null {
  return node.querySelector<HTMLButtonElement>('footer .primary-command')
}

/** 受控输入框改值：得走原生 setter，React 才认这次改值。 */
async function typeInto(node: HTMLElement, selector: string, value: string): Promise<void> {
  const input = node.querySelector<HTMLInputElement>(selector)
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    if (!input || !setValue) return
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => { window.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  for (const { root, node } of containers.splice(0)) {
    act(() => root.unmount())
    node.remove()
  }
})

describe('导入整合包弹窗', () => {
  it('弹窗自带圆角，不靠 .modal 那条基准规则', () => {
    // jsdom 不解析外部样式表，所以直接查样式源：这条断言防的是「圆角被人改回去 / 删掉」。
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css).toMatch(/\.import-dialog\s*\{\s*width:[^}]*border-radius:\s*14px/)
  })

  it('路径在「选择压缩包」左边，整条路径在只读输入框里', async () => {
    const node = await render({ picked: PACK_ZIP })
    await pickZip(node)

    const row = node.querySelector('.import-row')
    const path = row?.querySelector<HTMLInputElement>('input.import-path')
    const pick = row?.querySelector('.import-pick')
    expect(path).not.toBeNull()
    expect(pick).not.toBeNull()
    // 唯一入口是「选择压缩包」：「选择文件夹」已随压缩包收口一起删掉
    expect(pick!.textContent).toContain('选择压缩包')
    expect(node.textContent ?? '').not.toContain('选择文件夹')
    // 路径必须排在按钮前面（左边）
    expect((path!.compareDocumentPosition(pick!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    // 完整路径就在框里（放不下时由 CSS 省略），而且只读：看得见，改不了
    expect(path!.value).toBe(PACK_ZIP)
    expect(path!.readOnly).toBe(true)
    expect(path!.placeholder).toBe('还没有选')
  })

  it('没有「装配到现有实例」的切换控件：导入永远新建实例', async () => {
    const node = await render({ picked: PACK_ZIP })
    await pickZip(node)

    expect(node.querySelector('.import-box')).toBeNull()
    expect(node.querySelector('.import-menu')).toBeNull()
    expect(node.querySelector('[role="listbox"]')).toBeNull()
    // 下拉去的文案也一并消失
    expect(node.textContent ?? '').not.toContain('新建「')
    // 现有实例只用来判断撞名，不出现在可选列表里
    expect(node.textContent ?? '').not.toContain('PACK-A')
  })

  it('实例名默认取压缩包文件名（去掉 .zip），可改成中文并照原样发给主进程', async () => {
    const node = await render({ picked: PACK_ZIP })
    await pickZip(node)

    const input = node.querySelector<HTMLInputElement>('.import-name')
    expect(input?.value).toBe(PACK_NAME)
    // 文件夹名默认也取压缩包文件名，但现在是可编辑输入框（不是只读文本）
    const folder = node.querySelector<HTMLInputElement>('.import-folder')
    expect(folder?.value).toBe(PACK_NAME)
    expect(folder?.readOnly).toBe(false)
    expect(importButton(node)?.disabled).toBe(false)

    await typeInto(node, '.import-name', '我的整合包')
    expect(node.querySelector<HTMLInputElement>('.import-name')?.value).toBe('我的整合包')
    // 改实例名不动文件夹名
    expect(node.querySelector<HTMLInputElement>('.import-folder')?.value).toBe(PACK_NAME)
    expect(importButton(node)?.disabled).toBe(false)

    await act(async () => { importButton(node)?.click() })
    expect(currentProbe.requests[0]).toEqual({ packDir: PACK_ZIP, name: '我的整合包', folderName: PACK_NAME })
  })

  it('文件夹名可改，且改过的值原样发给主进程（不是假可编辑）', async () => {
    const node = await render({ picked: PACK_ZIP })
    await pickZip(node)

    await typeInto(node, '.import-folder', 'team-a')
    expect(node.querySelector<HTMLInputElement>('.import-folder')?.value).toBe('team-a')
    // 实例名还没被单独改过：跟着文件夹名走（默认同文件夹名）
    expect(node.querySelector<HTMLInputElement>('.import-name')?.value).toBe('team-a')
    expect(importButton(node)?.disabled).toBe(false)

    await act(async () => { importButton(node)?.click() })
    expect(currentProbe.requests[0]).toEqual({ packDir: PACK_ZIP, name: 'team-a', folderName: 'team-a' })
  })

  it('文件夹名不合法：路径分隔符 / 超长 / 非法首字符当场提示并禁用导入', async () => {
    const node = await render({ picked: PACK_ZIP })
    await pickZip(node)
    expect(importButton(node)?.disabled).toBe(false)

    // 路径分隔符：绝不能让主进程把 a/b 悄悄换成 a-b 之后再落盘
    await typeInto(node, '.import-folder', 'a/b')
    expect(node.querySelector('.import-hint')?.textContent).toContain('只能用字母、数字')
    expect(importButton(node)?.disabled).toBe(true)

    // 含空格同理
    await typeInto(node, '.import-folder', 'team a')
    expect(node.querySelector('.import-hint')?.textContent).toContain('只能用字母、数字')
    expect(importButton(node)?.disabled).toBe(true)

    // 首字符必须是字母或数字
    await typeInto(node, '.import-folder', '-abc')
    expect(node.querySelector('.import-hint')?.textContent).toContain('以字母或数字开头')
    expect(importButton(node)?.disabled).toBe(true)

    // 落盘名是 pack-<文件夹名>，整个标识不超过 64 位，所以文件夹名最多 59 字
    await typeInto(node, '.import-folder', 'a'.repeat(60))
    expect(node.querySelector('.import-hint')?.textContent).toContain('文件夹名太长了')
    expect(importButton(node)?.disabled).toBe(true)

    // 改回合法值：提示消失、按钮恢复
    await typeInto(node, '.import-folder', PACK_NAME)
    expect(node.querySelector('.import-hint')).toBeNull()
    expect(importButton(node)?.disabled).toBe(false)
  })

  it('选包前：路径写「还没有选」，实例名输入框禁用', async () => {
    const node = await render({ picked: PACK_ZIP })
    // 未选包：路径框是空的，占位符说「还没有选」；框只读，点不进去改
    expect(node.querySelector<HTMLInputElement>('.import-path')?.value).toBe('')
    expect(node.querySelector<HTMLInputElement>('.import-path')?.readOnly).toBe(true)
    expect(node.querySelector<HTMLInputElement>('.import-path')?.placeholder).toBe('还没有选')
    // 文件夹名同样空着，等选包后自动填入；它可编辑，不是只读
    expect(node.querySelector<HTMLInputElement>('.import-folder')?.value).toBe('')
    expect(node.querySelector<HTMLInputElement>('.import-folder')?.readOnly).toBe(false)
    expect(node.querySelector<HTMLInputElement>('.import-folder')?.placeholder).toBe('选取后自动填入')
    // 标签是「文件夹名」（不再是「装配到」）；提示行「选一个 .zip 压缩包。」整条删掉，未选包不留空位
    expect([...node.querySelectorAll('.import-label')].map(label => label.textContent)).toEqual([
      '选择整合包',
      '文件夹名',
      '实例名',
    ])
    expect(node.querySelector('.import-hint')).toBeNull()
    expect(node.textContent ?? '').not.toContain('选一个 .zip 压缩包。')
    expect(node.querySelector<HTMLInputElement>('.import-name')?.disabled).toBe(true)
    expect(importButton(node)?.disabled).toBe(true)
  })

  it('同名实例已经存在：提示换名字，导入置灰', async () => {
    // 只撞实例名（别的包 id）：文件夹名这一关能过，提示与禁用来自实例名检查。
    const node = await render(
      { picked: PACK_ZIP },
      { packs: [pack('pack-other', { name: PACK_NAME })] },
    )
    await pickZip(node)

    expect(node.textContent ?? '').toContain('已经有同名实例了，换个名字。')
    expect(importButton(node)?.disabled).toBe(true)
  })

  it('文件夹名已经导入过：提示换文件夹名，导入置灰', async () => {
    // 文件夹名可编辑之后，压缩包这条路径也会先按包包标识查重（以前只查实例名）。
    const node = await render(
      { picked: PACK_ZIP },
      { packs: [pack('pack-dsh-origin-3080', { name: '别的名字' })] },
    )
    await pickZip(node)

    expect(node.textContent ?? '').toContain('这个文件夹已经导入过了，先删掉那个实例，或者换个文件夹名。')
    expect(importButton(node)?.disabled).toBe(true)
  })

  it('阶段事件驱动状态行：装配中显示阶段，装完显示「已完成」', async () => {
    let finish: (value: PackImportOutcome) => void = () => undefined
    const pending = new Promise<PackImportOutcome>(resolve => { finish = resolve })
    const node = await render({ picked: PACK_ZIP, outcome: () => pending })
    await pickZip(node)

    await act(async () => { importButton(node)?.click() })
    expect(node.textContent ?? '').toContain('正在装配')
    expect(node.querySelector('.import-bar')).not.toBeNull()

    // 主进程推阶段 → 只换右上角那行小字
    await act(async () => { currentProbe.listener?.({ stage: 'install' }) })
    expect(node.querySelector('.import-stage')?.textContent).toBe('装配插件')
    await act(async () => { currentProbe.listener?.({ stage: 'verify' }) })
    expect(node.querySelector('.import-stage')?.textContent).toBe('核对结果')

    await act(async () => { finish({ ok: true, packId: 'pack-dsh-origin-3080', packName: '我的整合包' }) })
    expect(node.textContent ?? '').toContain('已完成')
    // 收口后不再画进度条，也不再有任何百分比 / x/y
    expect(node.querySelector('.import-bar')).toBeNull()
    expect(node.textContent ?? '').not.toMatch(/\d+\s*%/)
    expect(node.textContent ?? '').not.toMatch(/\d+\s*\/\s*\d+/)
  })

  it('失败：显示「已停止」+ 一句人话，且不含绝对路径', async () => {
    const node = await render({ picked: PACK_ZIP, outcome: { ok: false, reason: blockedReason('tgz-integrity') } })
    await pickZip(node)
    await act(async () => { importButton(node)?.click() })

    const text = node.textContent ?? ''
    expect(text).toContain('已停止')
    expect(text).toContain('整合包在拷贝过程中损坏了，重新拷一份再试。')
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(text.match(/D:\\packs/g)).toBeNull()

    // 失败可以再试：进度条收掉、按钮还亮着，再点一次会再发一条请求
    expect(node.querySelector('.import-bar')).toBeNull()
    expect(importButton(node)?.disabled).toBe(false)
    await act(async () => { importButton(node)?.click() })
    expect(currentProbe.requests).toHaveLength(2)
  })

  it('取消走取消通道，不直接关窗', async () => {
    let finish: (value: PackImportOutcome) => void = () => undefined
    const pending = new Promise<PackImportOutcome>(resolve => { finish = resolve })
    const node = await render({ picked: PACK_ZIP, outcome: () => pending })
    await pickZip(node)
    await act(async () => { importButton(node)?.click() })

    const cancel = [...node.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === '取消')
    await act(async () => { cancel?.click() })
    expect(currentProbe.cancelled).toBe(1)
    expect(node.querySelector('.import-dialog')).not.toBeNull()

    await act(async () => { finish({ ok: false, reason: '你取消了这次导入。' }) })
    expect(node.textContent ?? '').toContain('你取消了这次导入。')
  })
})

describe('导入判定与文案的口径', () => {
  it('文件夹名 → 包标识（与主进程 packProfileName 同口径）', () => {
    expect(packIdOf('dsh-origin-3080')).toBe('pack-dsh-origin-3080')
    expect(packIdOf(' DSH Origin ')).toBe('pack-dsh-origin')
  })

  it('文件夹名必须能派生出 ASCII 标识，且不能是导入过的', () => {
    expect(folderNameIssue('', [])).toBe('先选整合包所在的文件夹。')
    expect(folderNameIssue('我的整合包', [])).toBe('这个文件夹名里要有字母或数字。')
    expect(folderNameIssue('dsh-origin-3080', ['pack-dsh-origin-3080'])).toBe('这个文件夹已经导入过了，先删掉那个实例，或者换个文件夹名。')
    expect(folderNameIssue('dsh-origin-3080', ['pack-a'])).toBeNull()
    // 可编辑之后：与主进程 isSafeProfileName 同口径（路径分隔符 / 空格 / 首字符 / 长度）
    expect(folderNameIssue('a/b', [])).toContain('只能用字母、数字')
    expect(folderNameIssue('dsh origin', [])).toContain('只能用字母、数字')
    expect(folderNameIssue('-abc', [])).toContain('以字母或数字开头')
    expect(folderNameIssue('a'.repeat(60), [])).toBe('文件夹名太长了，59 个字符以内。')
    // 59 字是上限（pack- + 59 = 64）
    expect(folderNameIssue('a'.repeat(59), [])).toBeNull()
  })

  it('实例名允许中文，只拦空名、超长与重名', () => {
    expect(instanceNameIssue('', [])).toBe('给新实例取个名字。')
    expect(instanceNameIssue('   ', [])).toBe('给新实例取个名字。')
    expect(instanceNameIssue('我的整合包', [])).toBeNull()
    expect(instanceNameIssue('我的整合包', ['我的整合包'])).toBe('已经有同名实例了，换个名字。')
    expect(instanceNameIssue('a'.repeat(61), [])).toBe('名字太长了，60 个字以内。')
  })

  it('系统错误翻成人话，且不把路径带出来', () => {
    const reason = failureReason(new Error("ENOENT: no such file or directory, open 'D:\\packs\\vendor\\a.tgz'"))
    expect(reason).toBe('要读的文件找不到了，可能被移走或改名了。')
    expect(reason).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('未知异常收敛成同一句，不抄原始 message', () => {
    const reason = failureReason(new Error('boom at C:\\Users\\demo\\.dsh\\profiles\\x'))
    expect(reason).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(reason.length).toBeGreaterThan(0)
  })

  it('预检码有对应人话；未知码不抛、也不含路径', () => {
    expect(blockedReason('kernel-version-mismatch')).toContain('DSH 版本')
    expect(blockedReason('没人定义过的码')).toBe('整合包没有通过检查。')
    for (const code of ['pack-missing', 'vendor-empty', 'extras-missing', 'instance-exists', 'dependency-missing-required']) {
      expect(blockedReason(code)).not.toMatch(/[A-Za-z]:[\\/]/)
    }
  })

  it('路径只留最后两级', () => {
    expect(shortPackPath('D:\\a\\b\\c')).toBe('…\\b\\c')
    expect(shortPackPath('c')).toBe('c')
    expect(shortPackPath('')).toBe('')
  })

  it('只认 .zip 压缩包，默认实例名取压缩包文件名', () => {
    expect(isZipPath(PACK_ZIP)).toBe(true)
    expect(isZipPath('D:\\packs\\dsh-origin-3080')).toBe(false)
    expect(packDirName(PACK_ZIP)).toBe(PACK_NAME)
    expect(packDirName('D:\\packs\\dsh-origin-3080')).toBe(PACK_NAME)
  })
})
