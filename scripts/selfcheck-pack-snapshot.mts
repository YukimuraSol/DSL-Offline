/**
 * 自检：pack-snapshot.ts 的 link:/file: 依赖相对化 + 私人数据排除清单。
 * 跑法：npx vite-node scripts/selfcheck-pack-snapshot.mts
 *
 * 造一个假 DSH_HOME（profiles/web/package.json + 三份假插件本体），喂进 planSnapshot，
 * 断言 link:D:/... 与 file:D:/... 都被改写成 file:./.dsh-launcher-plugin-bodies/<name>；
 * 顺带断言几类私人数据（*.bak-* / plans / logs / cache / tmp / rewind-snapshots / 令牌）不进包。
 * 不联网、不碰真实 DSH_HOME，全部落在系统临时目录。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isSnapshotExcluded, planSnapshot, SNAPSHOT_BODIES_DIR } from '../electron/pack-snapshot'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail ? ' :: ' + detail : ''))
}

async function makeBody(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1' }) + '\n', 'utf8')
  await writeFile(path.join(dir, 'index.js'), 'export default {}\n', 'utf8')
  // 手改留下的备份：不能跟着本体进包。
  await writeFile(path.join(dir, 'cordis.patch.yml.bak-20261009'), 'old\n', 'utf8')
  return dir
}

async function main(): Promise<void> {
  const work = await mkdtemp(path.join(os.tmpdir(), 'dsh-selfcheck-'))
  try {
    const home = path.join(work, 'home')
    const bodiesRoot = path.join(work, 'bodies')
    const profileDir = path.join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })

    const alpha = await makeBody(bodiesRoot, 'dsh-alpha')
    const beta = await makeBody(bodiesRoot, 'dsh-beta')
    const gamma = await makeBody(bodiesRoot, 'dsh-gamma')

    // 三种写法都要能收：link: 正斜杠绝对路径、file: 正斜杠绝对路径、link: 反斜杠绝对路径。
    const packageJson = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        'dsh-alpha': 'link:' + alpha.split(path.sep).join('/'),
        'dsh-beta': 'file:' + beta.split(path.sep).join('/'),
        'dsh-gamma': 'link:' + gamma,
        'left-pad': '^1.0.0',
      },
    }
    await writeFile(path.join(profileDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8')

    const plan = await planSnapshot(home, { packId: 'web' })
    const entry = plan.entries.find(item => item.rel === 'profiles/web/package.json')
    check('profiles/web/package.json 进了计划', Boolean(entry))
    if (!entry) throw new Error('找不到 profiles/web/package.json，后面没法断言')

    const rewritten = JSON.parse((entry.data ?? Buffer.from('{}')).toString('utf8')) as {
      dependencies: Record<string, string>
    }
    const expected = (name: string): string => 'file:./' + SNAPSHOT_BODIES_DIR + '/' + name
    check('link: 正斜杠 → file:./本体目录', rewritten.dependencies['dsh-alpha'] === expected('dsh-alpha'), String(rewritten.dependencies['dsh-alpha']))
    check('file: 正斜杠 → file:./本体目录', rewritten.dependencies['dsh-beta'] === expected('dsh-beta'), String(rewritten.dependencies['dsh-beta']))
    check('link: 反斜杠 → file:./本体目录', rewritten.dependencies['dsh-gamma'] === expected('dsh-gamma'), String(rewritten.dependencies['dsh-gamma']))
    check('普通版本号依赖保持原样', rewritten.dependencies['left-pad'] === '^1.0.0', String(rewritten.dependencies['left-pad']))

    const bodyRel = 'profiles/web/' + SNAPSHOT_BODIES_DIR + '/'
    const alphaFiles = plan.entries.map(item => item.rel).filter(rel => rel.startsWith(bodyRel + 'dsh-alpha/'))
    check('本体 index.js 已收进包', alphaFiles.includes(bodyRel + 'dsh-alpha/index.js'), alphaFiles.join(', '))
    check('本体里的 *.bak-* 被挡掉', !alphaFiles.some(rel => rel.includes('.bak-')), alphaFiles.join(', '))
    check('三份本体都收了', ['dsh-alpha', 'dsh-beta', 'dsh-gamma'].every(name => plan.entries.some(item => item.rel === bodyRel + name + '/package.json')))

    const excluded = [
      'plans/x.md',
      'logs/dsh.log',
      'cache/abc',
      'tmp/abc',
      'rewind-snapshots/s1/a.json',
      'launch-token.json',
      'remote-web-ui-devices.json',
      'cordis.patch.yml.bak-20261009',
      'profiles/web/cordis.patch.yml.bak-20261009',
      'profiles/web/node_modules/x/y.bak-desktop-20260930',
      'profiles/web/node_modules/.modules.yaml',
    ]
    for (const rel of excluded) check('剔除 ' + rel, isSnapshotExcluded(rel))
    const kept = ['AGENTS.md', 'skills/x/SKILL.md', 'profiles/web/package.json', 'profiles/web/cordis.patch.yml']
    for (const rel of kept) check('保留 ' + rel, !isSnapshotExcluded(rel))
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures > 0) {
    console.error('\n自检失败：' + failures + ' 项')
    process.exitCode = 1
    return
  }
  console.log('\n自检通过：link:/file: 相对化与私人数据剔除均符合预期。')
}

await main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
