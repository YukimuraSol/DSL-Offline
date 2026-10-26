/**
 * 收编一个已经存在的 DSH 家目录，把它登记成启动器里的一条整合包。
 *
 * 存在的理由：搬家（migrate）与手工整理出来的目录，只要结构符合启动器规范
 * （<home>/profiles/<id>/{package.json, profile.yaml}），就不该被逼着压成 zip 再导入
 * ——登录态、会话、附件都在原地，压一次解一次反而把路径全改坏。
 *
 * 三条硬约定：
 *   1. **只登记，不搬**：homePath 指向用户给的那个绝对路径，本模块不拷、不移、不删。
 *   2. **包 id 就是目录名**：包身份对外只有目录名一个来源（阶段 2 起 profiles/ 下所有包
 *      都叫 web，再拿里面那个 profile 目录名当 id 会把整排家目录收编成同一个）。
 *      里面那个 profile 目录名（profileId）只用来读插件清单；激活时由
 *      instances.resolveProfileName 现探 profiles/<包 id> 还是 profiles/web。
 *      撞名时报错让人改名，绝不加后缀——加了后缀就是一个谁也指不上的包。
 *   3. **不建骨架**：目录必须是现成的 DSH 家目录（profiles/<某个 id>/package.json 为证），
 *      不像家目录的就拒绝——宁可不收，也不要登记个点开就崩的空壳。
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDesktopHomeProfile, isSafePackageName, isSafeProfileName } from './profile'
import { readProfileMetadata } from './profile-service'
import { readPackRegistry, upsertPackRecord, type PackRecord } from './pack-registry'
import { samePath } from './settings'

export interface AdoptPackOptions {
  /** 注册表里那条记录的路径。 */
  registryPath: string
  /** 用户给的家目录（绝对路径）。 */
  homePath: string
  /** 覆盖显示名；缺省取 profile.yaml 的 name，再退到 profile 目录名。 */
  name?: string
}

export interface AdoptPackResult {
  record: PackRecord
  /** 读插件清单用的那个 profile 目录名（包 id 是家目录名，二者不再捆绑）。 */
  profileId: string
}

/**
 * 一个目录里第一个像样的 Profile：profiles/<id>/package.json 存在。
 * 传入 dirName 时优先认目录名对得上的那个 profile（收编要求二者相等）。
 */
async function findProfileId(home: string, dirName?: string): Promise<string | null> {
  const entries = await readdir(path.join(home, 'profiles'), { withFileTypes: true }).catch(() => [])
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    // 官方桌面端独占的 profile 归它自己管，收编进来会让插件开关改朝它的目录写。
    .filter(name => isSafeProfileName(name) && name !== 'node_modules' && !isDesktopHomeProfile(name))
    .sort()
  // 目录名本身就是一个 profile 时直接用它：中文包名下的 profile 可能叫别的名字。
  if (dirName && candidates.includes(dirName) && existsSync(path.join(home, 'profiles', dirName, 'package.json'))) return dirName
  for (const name of candidates) {
    if (existsSync(path.join(home, 'profiles', name, 'package.json'))) return name
  }
  return null
}

/** 从 profile 的 package.json 里读出插件清单（内置 dsh 包不算插件）。 */
export async function readProfilePlugins(home: string, profileId: string): Promise<PackRecord['plugins']> {
  let manifest: { dependencies?: Record<string, unknown> } | null = null
  try {
    manifest = JSON.parse(await readFile(path.join(home, 'profiles', profileId, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
  } catch {
    return []
  }
  const dependencies = manifest?.dependencies
  if (!dependencies || typeof dependencies !== 'object') return []
  return Object.keys(dependencies)
    .filter(name => isSafePackageName(name) && !name.startsWith('@deepseek-ai/dsh'))
    .sort()
    .map(packageName => ({ packageName, enabled: true }))
}

/**
 * 校验这个目录真的像个 DSH 家目录：有 profiles/<id>/package.json。
 * 只看目录存在是不够的——空目录、普通文件夹、别的软件的目录都「存在」。
 */
export async function inspectAdoptableHome(homePath: string): Promise<{ profileId: string; name: string; dshVersion: string | null }> {
  if (typeof homePath !== 'string' || !path.isAbsolute(homePath)) throw new Error('路径无效：需要一个绝对路径。')
  if (!existsSync(homePath)) throw new Error('这个文件夹不存在。')
  const dirName = path.basename(path.resolve(homePath))
  const profileId = await findProfileId(homePath, dirName)
  if (!profileId) throw new Error('这个文件夹不是 DSH 家目录：里面没有 profiles/<包 id>/package.json。')
  const metadata = await readProfileMetadata(homePath, profileId).catch(() => null)
  return { profileId, name: metadata?.name || profileId, dshVersion: metadata?.dshVersion ?? null }
}

/**
 * 把一个已存在的家目录登记成整合包。**只写 packs.json，不碰磁盘上的任何文件。**
 * 调用方（IPC / PackManager）负责决定是否顺手激活它。
 */
export async function adoptPackFromFolder(options: AdoptPackOptions): Promise<AdoptPackResult> {
  const { registryPath, homePath } = options
  const info = await inspectAdoptableHome(homePath)
  const resolvedHome = path.resolve(homePath)
  const records = await readPackRegistry(registryPath)
  // 包 id = 家目录的目录名（见文件头第 2 条）；里面的 profile 目录名只用来读插件清单。
  const id = path.basename(resolvedHome)
  const displayName = (options.name ?? '').trim() || info.name || id
  const plugins = await readProfilePlugins(resolvedHome, info.profileId)
  const now = new Date().toISOString()

  // 同一个目录重复收编 = 幂等刷新（用户搬家后又改了目录内容时能刷新记录）。
  // 按路径认这个目录，不按 id：id 是目录名，改过名的老记录还得认得出是同一个家。
  const existing = records.find(record => record.homePath && samePath(record.homePath, resolvedHome))
  if (existing) {
    const next: PackRecord = {
      ...existing,
      name: displayName,
      ...(info.dshVersion ? { dshVersion: info.dshVersion } : {}),
      homePath: resolvedHome,
      state: 'complete',
      plugins,
      updatedAt: now,
    }
    await upsertPackRecord(registryPath, next)
    return { record: next, profileId: info.profileId }
  }
  // 目录名撞上了别的家目录（见文件头第 2 条），只能报错让人改名。
  const taken = records.find(record => record.id === id)
  if (taken) {
    const where = taken.homePath ?? '默认家目录'
    throw new Error(`整合包标识「${id}」已被另一个整合包占用（${where}）。请先删除那个整合包，或把这个文件夹改成别的名字后再接入。`)
  }

  const record: PackRecord = {
    id,
    name: displayName,
    description: '',
    version: '1.0.0',
    ...(info.dshVersion ? { dshVersion: info.dshVersion } : {}),
    homePath: resolvedHome,
    source: 'created',
    installedAt: now,
    updatedAt: now,
    state: 'complete',
    plugins,
  }
  await upsertPackRecord(registryPath, record)
  return { record, profileId: info.profileId }
}
