import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanPackNameHint,
  DEFAULT_RAW_SCAN_LIMITS,
  extractRawPluginBodies,
  extractRawPluginBodiesFromPath,
  extractRawPresetSourcesFromPath,
  extractRawSkillSources,
  scanRawPackZip,
  scanRawPackZipFromPath,
} from '../electron/pack-scan'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-scan-'))
  temporaryRoots.push(root)
  return root
}

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content))
  }
  return zip.toBuffer()
}

function skillDoc(name: string): string {
  return `---\nname: ${name}\ndescription: a skill\n---\n\n# ${name}\n\nbody\n`
}

function packageJson(name: string, version = '1.0.0'): string {
  return JSON.stringify({ name, version })
}

/**
 * 构造带任意 entryName 的 zip（store 方法）。adm-zip 的 addFile 会归一化路径，
 * 无法用它造出 zip-slip 条目，这里手工拼字节保留原始名称。
 */
function rawZipWithEntries(entries: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  const centrals: Buffer[] = []
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, dataBuf)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + dataBuf.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, ...centrals, end])
}

describe('scanRawPackZip — 插件识别', () => {
  it('剥离整体套一层顶层目录并识别内部插件', () => {
    const zip = makeZip({
      'wrapper/dsh-anchored-standard/package.json': packageJson('dsh-anchored-standard'),
      'wrapper/dsh-anchored-standard/lib/index.js': 'export {}',
    })
    const scan = scanRawPackZip(zip)
    expect(scan.topName).toBe('wrapper')
    expect(scan.plugins).toEqual([
      { kind: 'plugin', packageName: 'dsh-anchored-standard', version: '1.0.0', entryPrefix: 'dsh-anchored-standard' },
    ])
  })

  it('识别 suite 内多插件（父目录无 package.json）', () => {
    const zip = makeZip({
      'dsh-routing-suite/injector/package.json': packageJson('@dsh-external/dsh-super-injector', '0.3.1'),
      'dsh-routing-suite/injector/lib/index.js': 'export {}',
      'dsh-routing-suite/preset/package.json': packageJson('dsh-router-standard', '0.1.0'),
      'dsh-routing-suite/preset/index.js': 'export {}',
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName).sort()).toEqual([
      '@dsh-external/dsh-super-injector',
      'dsh-router-standard',
    ])
  })

  it('排除含 node_modules 的整棵子树（应用分发包 harness-backend 不被识别为插件）', () => {
    const zip = makeZip({
      'harness-backend/package.json': packageJson('harness-backend'),
      'harness-backend/node_modules/dep/package.json': packageJson('dep'),
      'dsh-anchored-standard/package.json': packageJson('dsh-anchored-standard'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName)).toEqual(['dsh-anchored-standard'])
  })

  it('git 仓库形式的插件（目录内含 .git）正常识别，.git 内部不误报', () => {
    // 真实包回归：dsh-anchored-standard / dsh-routing-suite 均以 git 仓库形式分发，
    // .git 不能作为整棵剪除信号；.git 内部 package.json 由 blocklist 名字检查排除。
    const zip = makeZip({
      // 根级散文件（真实包同 README.txt / node.exe 一样）让首段不止一个，避免触发整体包裹层 strip。
      'README.txt': 'distro notes',
      'dsh-anchored-standard/.git/HEAD': 'ref: refs/heads/main',
      'dsh-anchored-standard/.git/objects/pack/x.pack': 'x',
      'dsh-anchored-standard/package.json': packageJson('dsh-anchored-standard'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins).toEqual([
      { kind: 'plugin', packageName: 'dsh-anchored-standard', version: '1.0.0', entryPrefix: 'dsh-anchored-standard' },
    ])
  })

  it('suite 内子模块带空 node_modules 目录仍识别（真实包 injector 形态）', () => {
    // 真实包 dsh-routing-suite/injector 带一个空的 node_modules 目录条目（其下无文件），
    // 剪除根按文件条目判定，空目录不触发剪除，插件照常识别。
    const zip = makeZip({
      'dsh-routing-suite/injector/node_modules/': '',
      'dsh-routing-suite/injector/package.json': packageJson('@dsh-external/dsh-super-injector', '0.3.1'),
      'dsh-routing-suite/injector/lib/index.js': 'export {}',
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName)).toEqual(['@dsh-external/dsh-super-injector'])
  })

  it('git 仓库 + submodule 的 suite（含 .git/.gitmodules 与各插件内 .git）全部识别', () => {
    // 真实包回归：dsh-routing-suite 是 git 仓库（.git + .gitmodules），
    // injector/preset 是 submodule（各自带 .git），都必须作为插件识别。
    const zip = makeZip({
      'dsh-routing-suite/.git/HEAD': 'ref: refs/heads/main',
      'dsh-routing-suite/.gitmodules': '[submodule "injector"]',
      'dsh-routing-suite/injector/.git/HEAD': 'ref: refs/heads/main',
      'dsh-routing-suite/injector/package.json': packageJson('@dsh-external/dsh-super-injector', '0.3.1'),
      'dsh-routing-suite/preset/.git/HEAD': 'ref: refs/heads/main',
      'dsh-routing-suite/preset/package.json': packageJson('dsh-router-standard', '0.1.0'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName).sort()).toEqual([
      '@dsh-external/dsh-super-injector',
      'dsh-router-standard',
    ])
  })

  it('blocklist 目录与 .git 子树不参与识别', () => {
    const zip = makeZip({
      'dist/package.json': packageJson('dist'),
      'app/.git/package.json': packageJson('git-internal'),
      'real/package.json': packageJson('real'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName)).toEqual(['real'])
  })

  it('package.json name 非法时回退目录名，仍非法则记 skipped', () => {
    const zip = makeZip({
      'my-plugin/package.json': JSON.stringify({ name: 'My Plugin With Spaces!', version: '1.0.0' }),
      'bad dir/package.json': JSON.stringify({ version: '1.0.0' }),
    })
    const scan = scanRawPackZip(zip)
    // 'My Plugin With Spaces!' 非法 → 回退目录名 'my-plugin'（合法）。
    expect(scan.plugins.map(plugin => plugin.packageName)).toContain('my-plugin')
    // 'bad dir' 目录名含空格非法 → skipped。
    expect(scan.skipped.some(item => item.reason.includes('包名'))).toBe(true)
  })

  it('同名插件去重（保留先出现的），模板包跳过', () => {
    const zip = makeZip({
      'a/package.json': packageJson('dup'),
      'b/package.json': packageJson('dup'),
      '__template__/package.json': packageJson('__template__'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.filter(plugin => plugin.packageName === 'dup')).toHaveLength(1)
    expect(scan.plugins.some(plugin => plugin.packageName === '__template__')).toBe(false)
  })

  it('根目录 package.json 存在同级候选时拒绝（避免吞并同压缩包其它组件）', () => {
    // 安全回归：根级 package.json 的 entryPrefix='' 会让 extractUnderPrefix 吞掉整个压缩包
    // （包括同级 real 插件），既污染本体又破坏字节统计。只要存在其它插件/技能候选就拒绝。
    const zip = makeZip({
      'package.json': packageJson('root-plugin'),
      'index.js': 'export {}',
      'real/package.json': packageJson('real'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName)).toEqual(['real'])
    expect(scan.skipped.some(item => item.reason.includes('根目录 package.json'))).toBe(true)
  })

  it('单独一个插件目录（剥包裹层后为根级 package.json）仍识别为插件', () => {
    // 真实包形态：单个插件目录被当作整体包裹层剥离后，根级 package.json 是唯一候选 → 合法。
    const zip = makeZip({
      'plugin-alpha/package.json': packageJson('alpha'),
      'plugin-alpha/lib/index.js': 'export {}',
    })
    const scan = scanRawPackZip(zip)
    expect(scan.topName).toBe('plugin-alpha')
    expect(scan.plugins).toEqual([
      { kind: 'plugin', packageName: 'alpha', version: '1.0.0', entryPrefix: '' },
    ])
  })

  it('package.json 带 UTF-8 BOM 仍可解析（真实包 preset 形态）', () => {
    const zip = makeZip({
      'bom-plugin/package.json': '\uFEFF' + packageJson('bom-plugin'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins.map(plugin => plugin.packageName)).toEqual(['bom-plugin'])
  })

  it('zip-slip 路径整体拒绝', () => {
    // adm-zip 的 addFile 会归一化路径，无法造出 `..` 条目；手工拼字节保留原始 entryName。
    const zip = rawZipWithEntries([
      { name: '../evil.txt', content: 'x' },
      { name: 'pkg/package.json', content: packageJson('pkg') },
    ])
    expect(() => scanRawPackZip(zip)).toThrow('不安全路径')
  })
})

describe('scanRawPackZip — 技能识别', () => {
  it('识别 bundle（目录含 SKILL.md）与 flat（顶层 skills/ 下单 .md）', () => {
    const zip = makeZip({
      'tools/git-workflow/SKILL.md': skillDoc('git-workflow'),
      'tools/git-workflow/helper.js': 'export {}',
      'skills/quick-ref.md': skillDoc('quick-ref'),
    })
    const scan = scanRawPackZip(zip)
    // 实现按 entryPrefix 字典序稳定排序（skills/quick-ref.md 先于 tools/git-workflow），
    // 此处断言内容、不依赖顺序。
    const byName = [...scan.skills].sort((a, b) => a.name.localeCompare(b.name))
    expect(byName).toEqual([
      { kind: 'skill', name: 'git-workflow', format: 'bundle', entryPrefix: 'tools/git-workflow' },
      { kind: 'skill', name: 'quick-ref', format: 'flat', entryPrefix: 'skills/quick-ref.md' },
    ])
  })

  it('readme / license / 无效 frontmatter 的 .md 不误报为 skill', () => {
    const zip = makeZip({
      'README.md': '# readme',
      'docs/guide.md': 'no frontmatter',
      'tools/SKILL.md': 'plain text without frontmatter',
    })
    const scan = scanRawPackZip(zip)
    expect(scan.skills).toEqual([])
  })

  it('node_modules 内的 SKILL.md 不识别', () => {
    const zip = makeZip({
      'dep/node_modules/fake-skill/SKILL.md': skillDoc('fake-skill'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.skills).toEqual([])
  })
})

describe('cleanPackNameHint', () => {
  it('清洗 ASCII 文件名并去掉 .zip 后缀', () => {
    expect(cleanPackNameHint('My Pack v2.zip')).toBe('My Pack v2')
    expect(cleanPackNameHint('my-pack-1')).toBe('my-pack-1')
  })

  it('纯中文 / 纯数字 / 空名返回 null', () => {
    expect(cleanPackNameHint('整合包(1).zip')).toBeNull()
    expect(cleanPackNameHint('20260816')).toBeNull()
    expect(cleanPackNameHint('')).toBeNull()
  })
})

describe('extractRawPluginBodies', () => {
  it('只解候选插件子树到 workDir/<packageName>，scoped 拆两级', async () => {
    const workDir = await temporaryDirectory()
    const zip = makeZip({
      'harness-backend/node_modules/dep/package.json': packageJson('dep'),
      'dsh-routing-suite/injector/package.json': packageJson('@dsh-external/dsh-super-injector', '0.3.1'),
      'dsh-routing-suite/injector/lib/index.js': 'export {}',
      'dsh-routing-suite/preset/package.json': packageJson('dsh-router-standard'),
    })
    const scan = scanRawPackZip(zip)
    const map = await extractRawPluginBodies(zip, scan.plugins, workDir)
    expect([...map.keys()].sort()).toEqual(['@dsh-external/dsh-super-injector', 'dsh-router-standard'])
    expect(map.get('@dsh-external/dsh-super-injector')).toBe(path.join(workDir, '@dsh-external', 'dsh-super-injector'))
    expect(map.get('dsh-router-standard')).toBe(path.join(workDir, 'dsh-router-standard'))
    expect(await readFile(path.join(workDir, '@dsh-external', 'dsh-super-injector', 'package.json'), 'utf8'))
      .toBe(packageJson('@dsh-external/dsh-super-injector', '0.3.1'))
    // harness-backend 的 node_modules 未被解出。
    expect(await readFile(path.join(workDir, 'dsh-router-standard', 'package.json'), 'utf8')).toBe(packageJson('dsh-router-standard'))
  })

  it('解出字节超过上限时拒绝', async () => {
    const workDir = await temporaryDirectory()
    const zip = makeZip({
      'pkg/package.json': packageJson('pkg'),
      'pkg/big.bin': 'x'.repeat(100),
    })
    const scan = scanRawPackZip(zip)
    await expect(extractRawPluginBodies(zip, scan.plugins, workDir, { ...DEFAULT_RAW_SCAN_LIMITS, maxExtractedBytes: 50 }))
      .rejects.toThrow('解压体积')
  })

  it('共享预算跨候选累计：多个候选各自低于上限但总和超限时拒绝（zip-bomb 防拆单）', async () => {
    const workDir = await temporaryDirectory()
    // 每个插件约 30+ 字节；总预算 60 字节，单独看任一插件都不超，合起来必超。
    const zip = makeZip({
      'a/package.json': packageJson('alpha'),
      'b/package.json': packageJson('beta'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.plugins).toHaveLength(2)
    await expect(extractRawPluginBodies(zip, scan.plugins, workDir, { ...DEFAULT_RAW_SCAN_LIMITS, maxExtractedBytes: 60 }))
      .rejects.toThrow('解压体积')
  })
})

describe('extractRawSkillSources', () => {
  it('bundle 解整目录，flat 解单文件', async () => {
    const workDir = await temporaryDirectory()
    const zip = makeZip({
      'tools/git-workflow/SKILL.md': skillDoc('git-workflow'),
      'tools/git-workflow/helper.js': 'export {}',
      'skills/quick-ref.md': skillDoc('quick-ref'),
    })
    const scan = scanRawPackZip(zip)
    const map = await extractRawSkillSources(zip, scan.skills, workDir)
    expect(map.get('git-workflow')).toBe(path.join(workDir, 'git-workflow'))
    expect(map.get('quick-ref')).toBe(path.join(workDir, 'quick-ref.md'))
    expect(await readFile(path.join(workDir, 'git-workflow', 'SKILL.md'), 'utf8')).toBe(skillDoc('git-workflow'))
    expect(await readFile(path.join(workDir, 'quick-ref.md'), 'utf8')).toBe(skillDoc('quick-ref'))
  })

  it('插件与技能共享同一预算：跨两次顶层调用的累计解压字节统一封顶', async () => {
    // pack.ts 真实流程：先 extractRawPluginBodies 再 extractRawSkillSources，传同一 budget 对象。
    // 插件（~64 字节）不超 80 上限，技能 flat 再解出 ~50 字节后累计超限 → 第二次调用拒绝。
    const workDir = await temporaryDirectory()
    const zip = makeZip({
      'pkg/package.json': packageJson('pkg'),
      'pkg/data.bin': 'x'.repeat(30),
      'skills/tool.md': skillDoc('tool'),
    })
    const scan = scanRawPackZip(zip)
    const budget = { extracted: 0 }
    const limits = { ...DEFAULT_RAW_SCAN_LIMITS, maxExtractedBytes: 80 }
    await extractRawPluginBodies(zip, scan.plugins, workDir, limits, budget)
    await expect(extractRawSkillSources(zip, scan.skills, workDir, limits, budget)).rejects.toThrow('解压体积')
  })
})

describe('streaming raw path API', () => {
  it('scanRawPackZipFromPath / extractRawPluginBodiesFromPath', async () => {
    const root = await temporaryDirectory()
    const zipPath = path.join(root, 'raw.zip')
    await writeFile(zipPath, makeZip({
      'plugin-alpha/package.json': packageJson('alpha'),
      'plugin-beta/package.json': packageJson('beta'),
      'skills/my-skill/SKILL.md': skillDoc('my-skill'),
    }))

    const scan = await scanRawPackZipFromPath(zipPath)
    expect(scan.plugins.map(plugin => plugin.packageName)).toEqual(['alpha', 'beta'])
    expect(scan.skills.map(skill => skill.name)).toEqual(['my-skill'])

    const bodies = await extractRawPluginBodiesFromPath(zipPath, scan.plugins, path.join(root, 'bodies'))
    expect(bodies.get('alpha')).toBe(path.join(root, 'bodies', 'alpha'))
    expect(bodies.get('beta')).toBe(path.join(root, 'bodies', 'beta'))
    expect(await readFile(path.join(root, 'bodies', 'alpha', 'package.json'), 'utf8')).toContain('"alpha"')
    expect(await readFile(path.join(root, 'bodies', 'beta', 'package.json'), 'utf8')).toContain('"beta"')
  })
})

describe('raw Agent preset scan', () => {
  it('scanRawPackZip 识别 preset.yml 目录为预设', () => {
    const zip = makeZip({
      'agent-presets/router-standard/preset.yml': 'name: router-standard\n',
      'agent-presets/router-standard/helper.js': 'export {}',
      'plugin-alpha/package.json': packageJson('alpha'),
    })
    const scan = scanRawPackZip(zip)
    expect(scan.presets).toEqual([{ kind: 'preset', name: 'router-standard', entryPrefix: 'agent-presets/router-standard' }])
  })

  it('scanRawPackZipFromPath / extractRawPresetSourcesFromPath', async () => {
    const root = await temporaryDirectory()
    const zipPath = path.join(root, 'raw-preset.zip')
    await writeFile(zipPath, makeZip({
      'presets/router-standard/preset.yml': 'name: router-standard\n',
      'presets/router-standard/helper.js': 'export {}',
      'plugin-alpha/package.json': packageJson('alpha'),
    }))

    const scan = await scanRawPackZipFromPath(zipPath)
    expect(scan.presets.map(preset => preset.name)).toEqual(['router-standard'])

    const sources = await extractRawPresetSourcesFromPath(zipPath, scan.presets, path.join(root, 'presets'))
    expect(sources.get('router-standard')).toBe(path.join(root, 'presets', 'router-standard'))
    expect(await readFile(path.join(root, 'presets', 'router-standard', 'preset.yml'), 'utf8')).toContain('router-standard')
  })
})
