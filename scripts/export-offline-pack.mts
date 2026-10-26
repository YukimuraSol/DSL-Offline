/**
 * 离线整合包导出 CLI（计划第五节）：从装好的实例产出 vendor/*.tgz + manifest.json，然后自检。
 *
 * 跑法：
 *   npx vite-node scripts/export-offline-pack.mts --profile "<实例目录>" --out "<输出目录>" [--json <结果文件>]
 *   npx vite-node scripts/export-offline-pack.mts --check "<整合包目录>"        # 只跑包级检查
 *
 * 全程不出网、不弹窗；stdout 是给人看的小结，--json 才写机器可读结果。
 * 退出码：0 通过 / 1 包级检查有阻塞项 / 2 运行错误（路径不存在、解析失败）。
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportOfflinePack, verifyOfflinePack } from '../electron/pack-offline-export'

interface Arguments {
  profile?: string
  out?: string
  check?: string
  json?: string
  dshVersion?: string
  platform?: string
  extras?: string
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    switch (argv[index]) {
      case '--profile': parsed.profile = value; index += 1; break
      case '--out': parsed.out = value; index += 1; break
      case '--check': parsed.check = value; index += 1; break
      case '--json': parsed.json = value; index += 1; break
      case '--dsh-version': parsed.dshVersion = value; index += 1; break
      case '--platform': parsed.platform = value; index += 1; break
      case '--extras': parsed.extras = value; index += 1; break
      case '--attachments': parsed.extras = value; index += 1; break // 旧名兼容
      default: break
    }
  }
  return parsed
}

function megabytes(bytes: number): string {
  return (bytes / 1048576).toFixed(1) + ' MB'
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const options = parseArguments(argv)

  if (options.check) {
    const check = await verifyOfflinePack(path.resolve(options.check))
    console.log('包级检查：' + (check.ok ? '通过' : '有阻塞项'))
    console.log('  三件    : 核心 / 插件 / 附件（缺任何一件都在下面列 BLOCK）')
    console.log('  manifest: ' + megabytes(check.stats.manifestBytes))
    console.log('  plugins : ' + check.stats.plugins + ' 个，vendor ' + check.stats.tgzFiles + ' 个 tgz / ' + megabytes(check.stats.vendorBytes))
    console.log('  extras  : ' + check.stats.extrasFiles + ' 个文件 / ' + megabytes(check.stats.extrasBytes))
    console.log('  产物合计: ' + megabytes(check.stats.totalBytes))
    for (const item of check.blocking) console.log('  BLOCK ' + item)
    for (const item of check.warnings) console.log('  warn  ' + item)
    if (options.json) {
      await writeFile(path.resolve(options.json), JSON.stringify(check, null, 2) + '\n', 'utf8')
    }
    return check.ok ? 0 : 1
  }

  if (!options.profile || !options.out) {
    console.error('用法：--profile <实例目录> --out <输出目录> [--json <结果文件>] [--dsh-version <版本>] [--platform <平台>] [--extras <附件目录>]')
    console.error('      或：--check <整合包目录> [--json <结果文件>]')
    return 2
  }

  const result = await exportOfflinePack({
    profileDir: path.resolve(options.profile),
    outputDir: path.resolve(options.out),
    dshVersion: options.dshVersion,
    platform: options.platform,
    extrasDir: options.extras ? path.resolve(options.extras) : undefined,
    onProgress: event => console.log('[' + event.stage + '] ' + event.message),
  })

  const report = result.report
  console.log('')
  console.log('导出完成：' + result.manifestPath)
  console.log('  dshVersion  : ' + result.manifest.dshVersion)
  console.log('  platform    : ' + result.manifest.platform)
  console.log('  活跃插件    : ' + report.activePlugins + ' 个（全部进 vendor）')
  console.log('  本体原尺寸  : ' + megabytes(report.rawBytes))
  console.log('  vendor 体量 : ' + megabytes(report.vendorBytes))
  console.log('  剔除垃圾条目: ' + report.strippedJunk + ' 条')
  console.log('  剔除链接位  : ' + report.strippedLinks + ' 条')
  console.log('  附件 extras : ' + report.extras.fileCount + ' 个文件 / ' + megabytes(report.extras.bytes)
    + ' / ' + report.extras.directoryCount + ' 个目录（原样复制，未压缩）')
  if (!report.extras.sourceDir) {
    console.log('    源目录 <家目录>/extras 不存在，产物里建了空 extras/')
  }
  if (report.extras.skippedLinks > 0) {
    console.log('    附件里有 ' + report.extras.skippedLinks + ' 个链接未复制（含源机路径）')
  }
  console.log('  产物总体积  : ' + megabytes(report.totalBytes) + '（vendor + 附件 + manifest）')
  console.log('  installOrder: ' + result.manifest.installOrder.length + ' 项（插件 + dependencies 里的外部包）')
  console.log('  依赖边      : 本体自带 ' + report.dependencyEdges.filter(edge => edge.source === 'body').length
    + ' 条 / shared tree ' + report.linkedDeps.length + ' 个包 / 构建期内联 ' + report.bundledDeps.length + ' 个包')
  if (report.linkedDeps.length > 0) {
    console.log('    shared tree 依赖（导入端要宿主提供或下一批 vendor）：' + report.linkedDeps.join(', '))
  }
  if (report.skippedGates.length > 0) {
    console.log('  跳过的门控  :')
    for (const skipped of report.skippedGates) {
      console.log('    - ' + skipped.packageName + ' :: ' + skipped.reason + ' :: ' + skipped.detail)
    }
  }
  const missingEntries = report.facts.filter(facts => !facts.entryExists)
  if (missingEntries.length > 0) {
    console.log('  入口不存在的插件：' + missingEntries.map(facts => facts.name).join(', '))
  }
  console.log('')
  console.log('包级检查：' + (result.check.ok ? '通过' : '有阻塞项'))
  for (const item of result.check.blocking) console.log('  BLOCK ' + item)
  for (const item of result.check.warnings) console.log('  warn  ' + item)

  if (options.json) {
    const payload = { manifest: result.manifest, report, check: result.check }
    await writeFile(path.resolve(options.json), JSON.stringify(payload, null, 2) + '\n', 'utf8')
    console.log('结果已写入：' + path.resolve(options.json))
  }
  // 报告里的绝对路径会泄漏本机目录，stdout 已经够用；这里不再回显。
  return result.check.ok ? 0 : 1
}

main()
  .then(code => { process.exitCode = code })
  .catch(error => {
    console.error('导出失败：' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 2
  })
