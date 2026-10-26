/**
 * 自检：electron/pack-verify.ts 的六条检查。
 * 跑法：npx vite-node scripts/selfcheck-pack-verify.mts
 *
 * 造两个假 .dspack（一个只差建议项、一个真对不上号）喂进 verifyPackFile，
 * 断言逐条判定、总判定、quick 模式与修复提示词都与预期一致。不联网、不碰真实包。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { verifyPackFile } from '../electron/pack-verify'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail ? ' :: ' + detail : ''))
}

/** good=true：依赖与入口都齐；good=false：缺依赖目录 + 入口文件不存在 + 有散件。 */
async function build(good: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-verify-'))
  const file = path.join(dir, good ? 'good.dspack' : 'bad.dspack')
  const zip = new AdmZip()
  const profile = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-alpha': '1.0.0', 'dsh-missing': '1.0.0', 'dsh-secondary': '1.0.0', '@scope/pkg': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-alpha', 'dsh-secondary'] } },
  }
  zip.addFile('profiles/web/package.json', Buffer.from(JSON.stringify(profile, null, 2), 'utf8'))
  zip.addFile('profiles/web/profile.yaml', Buffer.from('name: web\n# 与随包内核一致，好让第 5 条能判 pass\ndshVersion: 0.2.1-rc.2\n', 'utf8'))
  zip.addFile('AGENTS.md', Buffer.from('# hi\n', 'utf8'))
  const addPlugin = (name: string, entry: string, withEntry: boolean): void => {
    zip.addFile(`profiles/web/node_modules/${name}/package.json`, Buffer.from(JSON.stringify({ name, main: entry }), 'utf8'))
    if (withEntry) zip.addFile(`profiles/web/node_modules/${name}/${entry}`, Buffer.from('export default {}\n', 'utf8'))
  }
  addPlugin('dsh-alpha', 'lib/index.js', true)
  addPlugin('dsh-secondary', 'lib/index.js', good)
  // scoped 包：验证第 2 条不会把 @scope/pkg 自己的子目录误报成套件。
  zip.addFile('profiles/web/node_modules/@scope/pkg/package.json', Buffer.from('{"name":"@scope/pkg","main":"lib/index.js"}', 'utf8'))
  zip.addFile('profiles/web/node_modules/@scope/pkg/lib/index.js', Buffer.from('export default {}\n', 'utf8'))
  if (good) zip.addFile('profiles/web/node_modules/dsh-missing/package.json', Buffer.from('{"name":"dsh-missing"}', 'utf8'))
  else zip.addFile('profiles/web/node_modules/dsh-stray/lib/index.js', Buffer.from('x\n', 'utf8'))
  await writeFile(file, zip.toBuffer())
  return file
}

const kernelsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '../runtime/kernels')
const goodFile = await build(true)
const badFile = await build(false)
try {
  const good = await verifyPackFile(goodFile, 'good.dspack', { kernelsRoot })
  check('齐全的包：六条检查都在', good.checks.length === 6, String(good.checks.length))
  check('齐全的包：第 1 条（清单与目录）通过', good.checks[0]?.status === 'pass', String(good.checks[0]?.status))
  check('齐全的包：第 4 条（插件入口）通过', good.checks[3]?.status === 'pass', String(good.checks[3]?.status))
  check('齐全的包：总判定 ok', good.ok)
  check('齐全的包：不产出修复提示词', good.prompt === '', good.checks.map(c => c.id + '=' + c.status).join(' ') + ' | ' + good.prompt.slice(0, 80))

  const bad = await verifyPackFile(badFile, 'bad.dspack', { kernelsRoot })
  check('残缺的包：第 1 条判 fail', bad.checks[0]?.status === 'fail', String(bad.checks[0]?.status))
  check('残缺的包：第 1 条点出缺的依赖', (bad.checks[0]?.findings ?? []).some(item => item.includes('dsh-missing')), JSON.stringify(bad.checks[0]?.findings))
  check('残缺的包：第 2 条判 warn 并点出散件', bad.checks[1]?.status === 'warn' && (bad.checks[1]?.findings ?? []).some(item => item.includes('dsh-stray')), JSON.stringify(bad.checks[1]?.findings))
  check('残缺的包：第 4 条判 fail', bad.checks[3]?.status === 'fail', String(bad.checks[3]?.status))
  check('残缺的包：总判定 ok=false', !bad.ok)
  check('残缺的包：有修复提示词', bad.prompt.length > 0)
  check('提示词里明写「不要跑 pnpm install」', bad.prompt.includes('不要跑 `pnpm install`'), bad.prompt.slice(0, 120))

  const quick = await verifyPackFile(badFile, 'bad.dspack', { kernelsRoot, mode: 'quick' })
  check('quick 模式只跑前三条', quick.checks.length === 3, String(quick.checks.length))
  check('quick 模式同样判出问题', !quick.ok)
} finally {
  await rm(path.dirname(goodFile), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.dirname(badFile), { recursive: true, force: true }).catch(() => undefined)
}

if (failures > 0) {
  console.error('\n自检失败：' + failures + ' 项')
  process.exitCode = 1
} else {
  console.log('\n自检通过：pack-verify 六条检查判定符合预期。')
}
