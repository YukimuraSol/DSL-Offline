/**
 * 离线整合包导入 CLI：把已导出的整合包在目标机上装成一个可用实例。
 *
 * 跑法：
 *   npx vite-node scripts/import-offline-pack.mts --pack "<整合包目录>" --home "<DSH家目录>" --id "<实例id>"
 *
 * 全程离线、无窗口（本脚本不 spawn 任何进程）。
 * 退出码：0 成功 / 1 预检阻塞（缺件、版本不匹配、实例已存在；一个字节都没写）/ 2 运行错误。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OfflineImportBlockedError,
  importOfflinePack,
  type OfflineImportReport,
} from '../electron/pack-offline-import'

export interface ImportArguments {
  pack?: string
  home?: string
  id?: string
}

export const IMPORT_USAGE = '用法：--pack <整合包目录> --home <DSH家目录> --id <实例id>'

export function parseImportArguments(argv: string[]): ImportArguments {
  const parsed: ImportArguments = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    switch (argv[index]) {
      case '--pack': parsed.pack = value; index += 1; break
      case '--home': parsed.home = value; index += 1; break
      case '--id': parsed.id = value; index += 1; break
      default: break
    }
  }
  return parsed
}

function megabytes(bytes: number): string {
  return (bytes / 1048576).toFixed(1) + ' MB'
}

function printReport(report: OfflineImportReport): void {
  console.log('')
  console.log('导入完成：' + report.profileDir)
  console.log('  dshVersion  : ' + report.dshVersion + '（' + report.platform + '）')
  console.log('  耗时        : ' + (report.durationMs / 1000).toFixed(1) + ' 秒')
  console.log('  插件        : ' + report.counts.plugins + ' 个 / ' + report.counts.pluginFiles + ' 个文件 / ' + megabytes(report.counts.pluginBytes))
  console.log('  junction    : ' + report.counts.junctions + ' 个（本机新建，只存绝对路径）')
  console.log('  依赖节点    : ' + report.counts.dependencies + ' 个（内核树提供，未安装）')
  console.log('    三处命中  : body ' + report.dependencyRoots.body + ' / profiles/<id> ' + report.dependencyRoots.profile
    + ' / profiles/node_modules ' + report.dependencyRoots.shared)
  console.log('    真依赖    : ' + report.counts.dependencyRequired + ' 个（插件运行时真的 import/require）')
  console.log('    真缺      : ' + report.counts.dependencyRequiredMissing + ' 个（有则阻塞）'
    + (report.missingRequiredDependencies.length > 0 ? ' → ' + report.missingRequiredDependencies.join(', ') : ''))
  console.log('    仅声明缺  : ' + report.counts.dependencyDeclaredOnlyMissing + ' 个（只记录，不阻塞）')
  if (report.missingDeclaredOnlyDependencies.length > 0) {
    console.log('    声明缺清单: ' + report.missingDeclaredOnlyDependencies.join(', '))
  }
  console.log('  extras      : ' + report.counts.extrasFiles + ' 个文件 / ' + megabytes(report.counts.extrasBytes)
    + ' / ' + report.counts.extrasDirectories + ' 个目录 → ' + report.extras.targetDir)
  if (report.extras.skippedLinks > 0) console.log('    跳过链接  : ' + report.extras.skippedLinks + ' 个（含源机路径）')
  if (!report.installOrderMatchesManifest) console.log('  warn        实际处理顺序与 manifest.installOrder 不一致')
  console.log('  自验        : ' + (report.verification.ok ? '通过' : '失败') + '（body ' + report.verification.checked.bodies
    + ' / junction ' + report.verification.checked.junctions + ' / dependencies 条目 ' + report.verification.checked.dependencyEntries + '）')
  for (const failure of report.verification.failures) console.log('    FAIL ' + failure)
  for (const warning of report.warnings) console.log('  warn        ' + warning)
  console.log('  报告        : ' + path.join(report.profileDir, 'import-report.json'))
}

/** CLI 主体；返回退出码（测试直接调用它，不 spawn）。 */
export async function runImportCli(argv: string[]): Promise<number> {
  const options = parseImportArguments(argv)
  if (!options.pack || !options.home || !options.id) {
    console.error(IMPORT_USAGE)
    return 2
  }
  try {
    const report = await importOfflinePack({
      packDir: path.resolve(options.pack),
      home: path.resolve(options.home),
      id: options.id,
      onProgress: event => console.log('[' + event.stage + '] ' + event.message),
    })
    printReport(report)
    return report.verification.ok ? 0 : 2
  } catch (error) {
    if (error instanceof OfflineImportBlockedError) {
      console.error('预检阻塞，未写入任何文件：')
      for (const issue of error.issues) console.error('  BLOCK [' + issue.code + '] ' + issue.message)
      return 1
    }
    console.error('导入失败：' + (error instanceof Error ? error.message : String(error)))
    return 2
  }
}

// 被直接执行才跑 main；被 vitest 引入时不触发。
// 注意：vite-node 的 process.argv 里只有它自己的 cli.mjs，没有脚本路径，所以两种入口都认。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const directInvocation = invokedPath === fileURLToPath(import.meta.url)
  || /[\\/]vite-node[\\/]dist[\\/]cli\.(?:mjs|js)$/.test(invokedPath)
if (directInvocation) {
  runImportCli(process.argv.slice(2))
    .then(code => { process.exitCode = code })
    .catch(error => {
      console.error('导入失败：' + (error instanceof Error ? error.message : String(error)))
      process.exitCode = 2
    })
}
