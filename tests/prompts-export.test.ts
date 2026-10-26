import { describe, expect, it } from 'vitest'
import { exportPrompt } from '../src/lib/prompts'

/**
 * 导出提示词的硬规则（都是验收项，破一条就会把 agent 引回手工打包）：
 *   1. 只给一条命令：--export-pack <包id> [输出目录]；默认落启动器安装目录下的 dsh-exports，产物是 <包id>.zip。
 *   2. 结果靠退出码 0/1/2 + 最后一行 JSON 摘要读；采集必须 2>&1 | Out-String（GUI 子系统程序）。
 *   3. 对方用「导入整合包」装配成新实例，API Key 自己填。
 *   4. 凭据与会话永远不进包；extras 目录是用户自己放的附件，要带。这句是排除语义，目录名必须点出来。
 *   5. 手搓痕迹一个都不许复活：installOrder / sha512- / package 前缀 / PowerShell 算哈希 / --workbench。
 *   6. 参数缺省（exportDir 空、launcherExe 空）不崩，也不编一个盘符绝对路径出来。
 */
const HANDWORK = [
  'installOrder',
  'sha512-',
  'package/',
  'Get-FileHash',
  'ToBase64String',
  '.dsh-launcher-plugin-bodies',
  '--workbench',
  '--verify',
]

describe('exportPrompt（一条命令导出）', () => {
  it('只走 --export-pack：默认目录、zip 产物、解压即得包目录', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    expect(text).toContain('--export-pack')
    expect(text).toContain('"pack-origin-3080"')
    expect(text).toContain('dsh-exports')
    expect(text).toContain('.zip')
    expect(text).toContain('manifest.json')
    expect(text).toContain('vendor')
    expect(text).toContain('extras')
  })

  it('结果这么读：退出码 0/1/2 + 最后一行 JSON 摘要 + 采集方式', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    expect(text).toContain('退出码 0')
    expect(text).toContain('退出码 2')
    expect(text).toContain('最后一行 stdout 是 JSON 摘要')
    expect(text).toContain('"vendorFiles"')
    expect(text).toContain('"vendorBytes"')
    expect(text).toContain('2>&1 | Out-String')
  })

  it('失败别自己动手：把 stdout/stderr 原样贴回来', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    expect(text).toContain('stdout/stderr 原样贴回来')
    expect(text).toContain('别手工补 manifest')
  })

  it('收尾要报路径和四个数', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    expect(text).toContain('绝对路径')
    expect(text).toContain('四个数')
    expect(text).toContain('tgz')
  })

  it('讲清对方怎么用：导入整合包 + 自己填 API Key', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    expect(text).toContain('导入整合包')
    expect(text).toContain('API Key')
    expect(text).toContain('解压')
  })

  it('凭据与会话写死不带，extras 要带', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    // 排除语义：目录名不点出来的话，agent 根本不知道「凭据与会话」指哪几个目录。
    expect(text).toContain('凭据与会话永远不进包')
    expect(text).toContain('.credentials.yaml')
    expect(text).toContain('sessions\\')
    expect(text).toContain('dsh-session-archive\\')
    expect(text).toContain('attachments\\')
    expect(text).toContain('extras\\ 是用户自己放的附件，要带')
    expect(text).toContain('不含凭据')
    expect(text).toContain('不含会话记录')
  })

  it('没有手搓痕迹：manifest 字段样例 / 哈希算法 / installOrder 都不在', () => {
    const texts = [
      exportPrompt('日常位', 7, '', 'pack-origin-3080', ''),
      exportPrompt('日常位', 7, 'D:\\dsh-exports', 'pack-origin-3080', 'C:\\DSH Launcher\\DSH Launcher.exe'),
    ]
    for (const text of texts) {
      for (const word of HANDWORK) expect(text).not.toContain(word)
      // manifest.json 只作为「zip 里有这个文件」出现，不许再贴字段样例。
      expect(text).not.toContain('"format"')
      expect(text).not.toContain('"dshVersion"')
    }
  })

  it('短：不超过 25 行，别把命令接管的事又抄回来', () => {
    const text = exportPrompt('日常位', 7, '', 'pack-origin-3080', '')
    expect(text.split('\n').length).toBeLessThanOrEqual(25)
  })

  it('参数缺省：不崩、不出现盘符绝对路径、不编假 exe 路径', () => {
    const text = exportPrompt('日常位', 0, '', '', '')
    expect(text).toContain('dsh-exports')
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(text).toContain('<启动器 exe 路径>')
    expect(text).toContain('<导出目录>')
  })

  it('给了导出目录就写真路径；包 id 按 ASCII 收紧', () => {
    const text = exportPrompt('日常位', 7, 'D:\\dsh-exports', 'pack origin 3080', '')
    expect(text).toContain('D:\\dsh-exports')
    expect(text).toContain('pack-origin-3080')
    expect(text).toContain('D:\\dsh-exports\\pack-origin-3080.zip')
  })

  it('exe 给了就写完整命令行', () => {
    const text = exportPrompt('日常位', 7, 'D:\\dsh-exports', 'pack-origin-3080', 'C:\\DSH Launcher\\DSH Launcher.exe')
    expect(text).toContain('"C:\\DSH Launcher\\DSH Launcher.exe" --export-pack "pack-origin-3080" "D:\\dsh-exports"')
  })
})
