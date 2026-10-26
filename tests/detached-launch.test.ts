import { describe, expect, it } from 'vitest'
import { buildWindowsRedirectedCommand } from '../electron/process'

/**
 * 实例日志改成「cmd 自己重定向」之后，外部能不能在实例运行期间读到日志，
 * 全押在这条命令行拼得对不对上：引号错一个，重定向就会落到别的路径、
 * 或者干脆被 cmd 吃掉，日志变空的。所以这里把拼装结果逐字钉住。
 */
describe('buildWindowsRedirectedCommand', () => {
  it('真实台式路径（中文 + 空格）：命令、stdout、stderr 三段都整段加引号', () => {
    const out = buildWindowsRedirectedCommand(
      'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Pack Launcher\\dsh-packs\\pack-bili-min\\profiles\\node_modules\\.bin\\dsh.cmd',
      ['web', '--port', '3080', '--profile', 'pack-bili-min'],
      'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Pack Launcher\\dsh-packs\\pack-bili-min\\logs\\launcher.out.log',
      'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Pack Launcher\\dsh-packs\\pack-bili-min\\logs\\launcher.err.log',
    )
    expect(out).toBe(
      '"'
      + '"C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Pack Launcher\\dsh-packs\\pack-bili-min\\profiles\\node_modules\\.bin\\dsh.cmd" '
      + '"web" "--port" "3080" "--profile" "pack-bili-min" '
      + '>> "C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Pack Launcher\\dsh-packs\\pack-bili-min\\logs\\launcher.out.log" '
      + '2>> "C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Pack Launcher\\dsh-packs\\pack-bili-min\\logs\\launcher.err.log"'
      + '"',
    )
  })

  it('外层那一对引号是给 cmd /s 剥的，剥完必须是合法命令行', () => {
    const out = buildWindowsRedirectedCommand('C:\\a b\\dsh.cmd', ['web'], 'C:\\p\\out.log', 'C:\\p\\err.log')
    expect(out.startsWith('"')).toBe(true)
    expect(out.endsWith('"')).toBe(true)
    // cmd /s 规则：首字符是引号时剥掉首尾各一个引号，剩下的原样执行。
    const inner = out.slice(1, -1)
    expect(inner.startsWith('"C:\\a b\\dsh.cmd"')).toBe(true)
    expect(inner.endsWith('2>> "C:\\p\\err.log"')).toBe(true)
    // 剥掉后引号必须成对：每个 " 都是开或关，不能剩半个。
    expect((inner.match(/"/g) ?? []).length % 2).toBe(0)
  })

  it('路径里的 & ^ ( ) 留在引号内，不会被当成命令分隔符', () => {
    const out = buildWindowsRedirectedCommand('C:\\a&b\\x.exe', ['a^b'], 'C:\\p&q\\o.log', 'C:\\p&q\\e.log')
    expect(out).toContain('"C:\\a&b\\x.exe"')
    expect(out).toContain('"a^b"')
    expect(out).toContain('>> "C:\\p&q\\o.log"')
  })

  it('参数里的引号按现有约定翻倍（与 buildWindowsBatchCommand 一致）', () => {
    const out = buildWindowsRedirectedCommand('C:\\x.exe', ['say "hi"'], 'C:\\o.log', 'C:\\e.log')
    expect(out).toContain('"say ""hi"""')
  })

  it('换行/空字符直接拒绝，绝不拼进命令行', () => {
    expect(() => buildWindowsRedirectedCommand('C:\\x.exe', ['a\nb'], 'C:\\o.log', 'C:\\e.log')).toThrow()
    expect(() => buildWindowsRedirectedCommand('C:\\x.exe', [], 'C:\\o.log', 'C:\\e\0.log')).toThrow()
  })

  it('stderr 单独追加，不与 stdout 合并', () => {
    const out = buildWindowsRedirectedCommand('x.exe', [], 'o.log', 'e.log')
    expect(out).toContain('>> "o.log" 2>> "e.log"')
    expect(out).not.toContain('2>&1')
  })
})
