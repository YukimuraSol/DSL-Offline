import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 卸载不删包的护栏。
 *
 * 整合包根目录现在落在 {app}\\dsh-packs（安装目录内部，见 electron/settings.ts 的
 * packsRootInsideInstall）。Inno Setup 的 [UninstallDelete] 里只要出现一条
 * `Type: filesandordirs; Name: "{app}"`，卸载就会递归删掉整个安装目录 ——
 * 用户几十 GB 的整合包一起消失。这个测试就是那条线的绊索。
 *
 * 实测证据（Inno Setup 6.7.3）：同一份脚本 + 同样的 dsh-packs 目录，
 * 有那条规则 → 卸载后 {app} 与 dsh-packs 都没了；去掉那条规则 → dsh-packs 原样保留。
 */
describe('安装包的卸载行为', () => {
  it('installer.iss 不出现递归删掉整个 {app} 的 UninstallDelete 规则', async () => {
    const source = await readFile(path.join(process.cwd(), 'build', 'installer.iss'), 'utf8')
    const uninstallDelete = source.split(/^\[UninstallDelete\]/m)[1]?.split(/^\[/m)[0] ?? ''
    // 整段里不允许任何一条「递归删掉 {app} 本身」的规则。
    // 允许 Type: dirifempty; Name: "{app}"：它只在 {app} 已经空了的时候才删目录，
    // 不递归、不碰内容，dsh-packs 还在时 {app} 非空，这条规则什么也不做。
    const rules = uninstallDelete
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith(';'))
    for (const rule of rules) {
      const targetsAppRoot = /Name:\s*"\{app\}"/i.test(rule)
      const recursive = /Type:\s*(filesandordirs|files)\b/i.test(rule)
      expect(targetsAppRoot && recursive).toBe(false)
    }
  })

  it('packsRoot 的默认位置确实在 {app} 里（安装目录内部）', async () => {
    const source = await readFile(path.join(process.cwd(), 'electron', 'settings.ts'), 'utf8')
    expect(source).toMatch(/return path\.join\(installLocation, 'dsh-packs'\)/)
  })
})