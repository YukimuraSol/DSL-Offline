import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { CustomApiProtocol, CustomApiProvider, CustomApiProviderInput } from '../src/types'
import { hasCredential, readCredential, removeCredential, setCredential } from './credentials'

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const CREDENTIAL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROTOCOLS = new Set<CustomApiProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settingsPath(dshHome: string): string {
  return path.join(dshHome, 'settings.yaml')
}

async function readSettingsSource(dshHome: string): Promise<string | null> {
  try {
    return await readFile(settingsPath(dshHome), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseSettings(source: string | null) {
  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error('DSH settings.yaml 格式无效，请先修复配置文件后重试。')
  }
  const value = document.toJS() as unknown
  if (value !== null && !isRecord(value)) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  return { document, values: (value ?? {}) as JsonRecord }
}

async function writeSettingsDocument(dshHome: string, content: string): Promise<void> {
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  const target = settingsPath(dshHome)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
    await chmod(target, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function credentialNameForRoute(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function providerMap(values: JsonRecord): JsonRecord {
  const namespace = values['llm-pi-ai']
  if (!isRecord(namespace)) return {}
  const providers = namespace.providers
  return isRecord(providers) ? providers : {}
}

function providerCredentialName(route: string, provider: JsonRecord): string | null {
  return typeof provider.apiKeyEnv === 'string' && CREDENTIAL_PATTERN.test(provider.apiKeyEnv)
    ? provider.apiKeyEnv
    : null
}

function modelIdsFromProvider(provider: JsonRecord): string[] {
  if (!Array.isArray(provider.models)) return []
  return provider.models.flatMap(model => {
    if (typeof model === 'string') return model.trim() ? [model.trim()] : []
    if (isRecord(model) && typeof model.id === 'string' && model.id.trim()) return [model.id.trim()]
    return []
  })
}

function normalizeInput(input: CustomApiProviderInput): Required<Omit<CustomApiProviderInput, 'originalRoute' | 'apiKey'>> & {
  originalRoute: string
  apiKey: string
} {
  if (!input || typeof input !== 'object') throw new Error('自定义 API 配置无效。')
  const route = typeof input.route === 'string' ? input.route.trim() : ''
  const originalRoute = typeof input.originalRoute === 'string' ? input.originalRoute.trim() : route
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''

  if (!ROUTE_PATTERN.test(route) || route.length > 64) {
    throw new Error('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
  }
  if (!ROUTE_PATTERN.test(originalRoute) || originalRoute.length > 64) throw new Error('原路由格式无效。')
  if (!displayName || displayName.length > 80) throw new Error('显示名称不能为空，且不能超过 80 个字符。')
  if (!PROTOCOLS.has(input.protocol)) throw new Error('API 协议不受支持。')
  if (!baseUrl || baseUrl.length > 2048) throw new Error('Base URL 不能为空。')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('Base URL 不是有效的网址。')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Base URL 必须是 HTTP(S) 地址，且不能包含账号或密码。')
  }
  if (!Array.isArray(input.modelIds)) throw new Error('模型列表格式无效。')
  const modelIds = [...new Set(input.modelIds.map(id => typeof id === 'string' ? id.trim() : ''))]
    .filter(Boolean)
  if (modelIds.length === 0) throw new Error('至少需要填写一个模型 ID。')
  if (modelIds.length > 100 || modelIds.some(id => id.length > 200 || /[\r\n\0]/.test(id))) {
    throw new Error('模型 ID 数量或格式无效。')
  }
  if (apiKey.length > 32_768) throw new Error('API Key 过长。')

  return { route, originalRoute, displayName, baseUrl, protocol: input.protocol, modelIds, apiKey }
}

function preservedModels(existing: JsonRecord | undefined, modelIds: string[]): Array<JsonRecord> {
  const existingModels = Array.isArray(existing?.models) ? existing.models : []
  const byId = new Map<string, JsonRecord>()
  for (const model of existingModels) {
    if (isRecord(model) && typeof model.id === 'string') byId.set(model.id, model)
  }
  return modelIds.map(id => ({ ...(byId.get(id) ?? {}), id }))
}

export async function listCustomApiProviders(dshHome: string): Promise<CustomApiProvider[]> {
  const source = await readSettingsSource(dshHome)
  const { values } = parseSettings(source)
  const providers = providerMap(values)
  const parsed = Object.entries(providers).flatMap(([route, value]) => {
    if (!ROUTE_PATTERN.test(route) || !isRecord(value)) return []
    const protocol = value.api
    const baseUrl = value.baseURL
    const modelIds = modelIdsFromProvider(value)
    if (!PROTOCOLS.has(protocol as CustomApiProtocol) || typeof baseUrl !== 'string' || modelIds.length === 0) return []
    const credentialName = providerCredentialName(route, value)
    return [{
      route,
      displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : route,
      baseUrl,
      protocol: protocol as CustomApiProtocol,
      modelIds,
      credentialName,
    }]
  })

  const withStatus = await Promise.all(parsed.map(async provider => ({
    ...provider,
    hasApiKey: provider.credentialName ? await hasCredential(dshHome, provider.credentialName) : false,
  })))
  return withStatus.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
}

export async function saveCustomApiProvider(
  dshHome: string,
  input: CustomApiProviderInput,
): Promise<CustomApiProvider[]> {
  const normalized = normalizeInput(input)
  const source = await readSettingsSource(dshHome)
  const { document, values } = parseSettings(source)
  const providers = providerMap(values)
  const existing = isRecord(providers[normalized.originalRoute]) ? providers[normalized.originalRoute] as JsonRecord : undefined
  const oldCredentialName = existing ? providerCredentialName(normalized.originalRoute, existing) : null
  const routeChanged = normalized.originalRoute !== normalized.route
  if (routeChanged && providers[normalized.route] !== undefined) throw new Error('目标路由已存在，请换一个路由名称。')

  let nextCredentialName: string | null = !routeChanged && oldCredentialName
    ? oldCredentialName
    : null
  let migratedSecret: string | null = null
  if (normalized.apiKey) {
    nextCredentialName = routeChanged || !oldCredentialName ? credentialNameForRoute(normalized.route) : oldCredentialName
    await setCredential(dshHome, nextCredentialName, normalized.apiKey)
  } else if (routeChanged && oldCredentialName) {
    migratedSecret = await readCredential(dshHome, oldCredentialName)
    if (migratedSecret) {
      nextCredentialName = credentialNameForRoute(normalized.route)
      await setCredential(dshHome, nextCredentialName, migratedSecret)
    }
  }

  if (routeChanged && existing) {
    document.deleteIn(['llm-pi-ai', 'providers', normalized.originalRoute])
    document.setIn(['llm-pi-ai', 'providers', normalized.route], document.createNode({ ...existing }))
  } else if (!existing) {
    document.setIn(['llm-pi-ai', 'providers', normalized.route], document.createNode({}))
  }
  const basePath = ['llm-pi-ai', 'providers', normalized.route]
  document.setIn([...basePath, 'displayName'], normalized.displayName)
  document.setIn([...basePath, 'api'], normalized.protocol)
  document.setIn([...basePath, 'baseURL'], normalized.baseUrl)
  document.setIn([...basePath, 'models'], preservedModels(existing, normalized.modelIds))
  if (nextCredentialName) document.setIn([...basePath, 'apiKeyEnv'], nextCredentialName)
  else document.deleteIn([...basePath, 'apiKeyEnv'])

  await writeSettingsDocument(dshHome, document.toString({ lineWidth: 0 }))
  if (routeChanged && oldCredentialName && oldCredentialName !== nextCredentialName) {
    await removeCredential(dshHome, oldCredentialName)
  }
  return listCustomApiProviders(dshHome)
}

export async function removeCustomApiProvider(dshHome: string, route: string): Promise<CustomApiProvider[]> {
  const normalizedRoute = typeof route === 'string' ? route.trim() : ''
  if (!ROUTE_PATTERN.test(normalizedRoute)) throw new Error('自定义 API 路由格式无效。')
  const source = await readSettingsSource(dshHome)
  const { document, values } = parseSettings(source)
  const providers = providerMap(values)
  const existing = providers[normalizedRoute]
  if (!isRecord(existing)) throw new Error('没有找到该自定义 API。')
  const credentialName = providerCredentialName(normalizedRoute, existing) ?? credentialNameForRoute(normalizedRoute)

  document.deleteIn(['llm-pi-ai', 'providers', normalizedRoute])
  const remainingProviders = { ...providers }
  delete remainingProviders[normalizedRoute]
  if (Object.keys(remainingProviders).length === 0) document.deleteIn(['llm-pi-ai', 'providers'])
  await writeSettingsDocument(dshHome, document.toString({ lineWidth: 0 }))
  await removeCredential(dshHome, credentialName)
  return listCustomApiProviders(dshHome)
}
