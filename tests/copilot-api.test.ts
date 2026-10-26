import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listCopilotModels, resolveAgentApiForModel, resolveCopilotAgentApi } from '../electron/copilot-api'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function freshHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-api-'))
  temporaryRoots.push(root)
  return root
}

async function writeSettings(dshHome: string, providersYaml: string, agentDefault?: string): Promise<void> {
  await mkdir(dshHome, { recursive: true })
  const agentBlock = agentDefault ?? 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
  await writeFile(path.join(dshHome, 'settings.yaml'), `${agentBlock}\nllm-pi-ai:\n  providers:\n${providersYaml}`, 'utf8')
}

async function writeCredentials(dshHome: string, refs: Record<string, string>): Promise<void> {
  await mkdir(dshHome, { recursive: true })
  const lines = Object.entries(refs).map(([name, secret]) => `  ${name}: ${secret}`)
  await writeFile(path.join(dshHome, '.credentials.yaml'), `version: 1\nrefs:\n${lines.join('\n')}\n`, 'utf8')
}

function providerYaml(route: string, displayName: string, models: string[], protocol = 'openai-completions'): string {
  return `    ${route}:\n      displayName: ${displayName}\n      api: ${protocol}\n      baseURL: https://${route}.example.com/v1\n      apiKeyEnv: ${route.toUpperCase().replace(/-/g, '_')}_API_KEY\n      models:\n${models.map(model => `        - id: ${model}\n          name: ${model}`).join('\n')}\n`
}

describe('resolveCopilotAgentApi', () => {
  it('DeepSeek Key 存在时返回 null（走官方默认路径）', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome, providerYaml('ali', 'ali', ['deepseek-v4-flash-0731']))
    await writeCredentials(dshHome, { DEEPSEEK_API_KEY: 'sk-official', ALI_API_KEY: 'sk-ali' })

    expect(await resolveCopilotAgentApi(dshHome)).toBeNull()
  })

  it('自定义 API 映射到 deepseek-official adapter + DEEPSEEK_BASE_URL，而非路由 id', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome, providerYaml('ali', 'ali', ['deepseek-v4-flash-0731']))
    await writeCredentials(dshHome, { ALI_API_KEY: 'sk-ali' })

    const resolved = await resolveCopilotAgentApi(dshHome)
    // ACP 运行时只注册了 deepseek-official adapter；路由 id 会报 no adapter registered。
    expect(resolved).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-0731',
      apiKeyEnvName: 'DEEPSEEK_API_KEY',
      apiKey: 'sk-ali',
      baseUrl: 'https://ali.example.com/v1',
    })
  })

  it('agent-default-model 指向自定义 provider 时优先使用它指定的模型', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome,
      providerYaml('sensenova', 'sensenova', ['glm-5.2', 'sensenova-6.7-flash-lite']) + providerYaml('ali', 'ali', ['deepseek-v4-flash-0731']),
      'agent-default-model:\n  provider: sensenova\n  model: sensenova-6.7-flash-lite\n')
    await writeCredentials(dshHome, { SENSENOVA_API_KEY: 'sk-sensenova', ALI_API_KEY: 'sk-ali' })

    const resolved = await resolveCopilotAgentApi(dshHome)
    expect(resolved).toEqual({
      provider: 'deepseek-official',
      model: 'sensenova-6.7-flash-lite',
      apiKeyEnvName: 'DEEPSEEK_API_KEY',
      apiKey: 'sk-sensenova',
      baseUrl: 'https://sensenova.example.com/v1',
    })
  })

  it('agent-default-model 指定的 provider 没有密钥时降级到回退链', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome,
      providerYaml('sensenova', 'sensenova', ['glm-5.2']) + providerYaml('ali', 'ali', ['deepseek-v4-flash-0731']),
      'agent-default-model:\n  provider: sensenova\n  model: glm-5.2\n')
    await writeCredentials(dshHome, { ALI_API_KEY: 'sk-ali' })

    const resolved = await resolveCopilotAgentApi(dshHome)
    expect(resolved?.apiKey).toBe('sk-ali')
    expect(resolved?.baseUrl).toBe('https://ali.example.com/v1')
  })

  it('非 openai-completions 协议的 provider 不参与回退', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome,
      providerYaml('claude-proxy', 'claude', ['claude-sonnet'], 'anthropic-messages')
      + providerYaml('ali', 'ali', ['deepseek-v4-flash-0731']))
    await writeCredentials(dshHome, { CLAUDE_PROXY_API_KEY: 'sk-claude', ALI_API_KEY: 'sk-ali' })

    const resolved = await resolveCopilotAgentApi(dshHome)
    expect(resolved?.baseUrl).toBe('https://ali.example.com/v1')
  })

  it('凭据文件为空或 provider 都没有密钥时返回 null', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome, providerYaml('ali', 'ali', ['deepseek-v4-flash-0731']))

    expect(await resolveCopilotAgentApi(dshHome)).toBeNull()
  })

  it('settings.yaml 缺失时不抛错，返回 null', async () => {
    const dshHome = await freshHome()
    await mkdir(dshHome, { recursive: true })
    expect(await resolveCopilotAgentApi(dshHome)).toBeNull()
  })

  it('用户真实场景：三个 provider 且 DeepSeek Key 缺失时选中带密钥的 ali', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome,
      providerYaml('sensenova', 'sensenova', ['sensenova-6.7-flash-lite'])
      + providerYaml('opencode', 'opencode', ['opencode-1'])
      + providerYaml('deepseek-v4-flash-0731', 'ali', ['deepseek-v4-flash-0731']))
    await writeCredentials(dshHome, {
      SENSENOVA_API_KEY: 'sk-sensenova',
      OPENCODE_API_KEY: 'sk-opencode',
      DEEPSEEK_V4_FLASH_0731_API_KEY: 'sk-ali',
    })

    const resolved = await resolveCopilotAgentApi(dshHome)
    expect(resolved).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-0731',
      apiKeyEnvName: 'DEEPSEEK_API_KEY',
      apiKey: 'sk-ali',
      baseUrl: 'https://deepseek-v4-flash-0731.example.com/v1',
    })
  })
})

describe('listCopilotModels', () => {
  it('列出官方与全部自定义模型，密钥缺失的标记不可用', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome,
      providerYaml('ali', 'ali', ['deepseek-v4-flash-0731', 'qwen-plus'])
      + providerYaml('sensenova', 'sensenova', ['glm-5.2'], 'anthropic-messages'))
    await writeCredentials(dshHome, { ALI_API_KEY: 'sk-ali' })

    const models = await listCopilotModels(dshHome)
    expect(models).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', label: 'DeepSeek 官方 · deepseek-v4-flash', available: false },
      { provider: 'ali', model: 'deepseek-v4-flash-0731', label: 'ali · deepseek-v4-flash-0731', available: true },
      { provider: 'ali', model: 'qwen-plus', label: 'ali · qwen-plus', available: true },
      { provider: 'sensenova', model: 'glm-5.2', label: 'sensenova · glm-5.2', available: false },
    ])
  })
})

describe('resolveAgentApiForModel', () => {
  it('官方模型有密钥时走官方默认路径', async () => {
    const dshHome = await freshHome()
    await writeCredentials(dshHome, { DEEPSEEK_API_KEY: 'sk-official' })

    expect(await resolveAgentApiForModel(dshHome, 'deepseek-official', 'deepseek-v4-flash')).toEqual({ kind: 'official' })
  })

  it('官方模型缺密钥时返回 unavailable', async () => {
    const dshHome = await freshHome()
    await mkdir(dshHome, { recursive: true })

    expect(await resolveAgentApiForModel(dshHome, 'deepseek-official', 'deepseek-v4-flash')).toEqual({
      kind: 'unavailable',
      reason: 'DeepSeek 官方 Key 未配置，请先在 API 配置中填写。',
    })
  })

  it('自定义模型映射到 deepseek-official adapter 并携带密钥与端点', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome, providerYaml('ali', 'ali', ['deepseek-v4-flash-0731', 'qwen-plus']))
    await writeCredentials(dshHome, { ALI_API_KEY: 'sk-ali' })

    const resolution = await resolveAgentApiForModel(dshHome, 'ali', 'qwen-plus')
    expect(resolution).toEqual({
      kind: 'custom',
      api: {
        provider: 'deepseek-official',
        model: 'qwen-plus',
        apiKeyEnvName: 'DEEPSEEK_API_KEY',
        apiKey: 'sk-ali',
        baseUrl: 'https://ali.example.com/v1',
      },
    })
  })

  it('自定义 provider 缺密钥时返回不可用原因', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome, providerYaml('ali', 'ali', ['qwen-plus']))

    const resolution = await resolveAgentApiForModel(dshHome, 'ali', 'qwen-plus')
    expect(resolution).toEqual({ kind: 'unavailable', reason: expect.stringContaining('缺少本地密钥') })
  })

  it('不存在的路由和协议不兼容的 provider 均返回不可用', async () => {
    const dshHome = await freshHome()
    await writeSettings(dshHome, providerYaml('claude-proxy', 'claude', ['claude-sonnet'], 'anthropic-messages'))
    await writeCredentials(dshHome, { CLAUDE_PROXY_API_KEY: 'sk-claude' })

    expect(await resolveAgentApiForModel(dshHome, 'ghost', 'x')).toMatchObject({ kind: 'unavailable' })
    expect(await resolveAgentApiForModel(dshHome, 'claude-proxy', 'claude-sonnet')).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('协议暂不支持'),
    })
  })
})
