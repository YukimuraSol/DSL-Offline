/**
 * 最小 ACP（Agent Client Protocol）JSON-RPC 2.0 客户端。
 *
 * 协议细节直接对齐 @agentclientprotocol/sdk@0.25.1（@deepseek-ai/dsh-acp
 * 固定使用的版本），并通过真实 dsh-acp-demo 握手验证：
 *   - 行分隔 JSON（NDJSON）走 stdio：发送 JSON.stringify(msg) + "\n"；
 *     接收按换行拆分、trim 后 JSON.parse。
 *   - 请求 {jsonrpc, id, method, params}；响应 {id, result | error}；
 *     通知 {jsonrpc, method, params}。PROTOCOL_VERSION = 1。
 *
 * 传输层由调用方注入（生产 = spawn 的 stdout 行缓冲 + stdin 写入，测试 =
 * 内存双端 stub），本模块只关心协议。将来协议漂移只需替换这一个文件。
 */

export const ACP_PROTOCOL_VERSION = 1

/** 传输层接口：发送一行帧、注册行回调、注册关闭回调。 */
export interface AcpTransport {
  /** 发送一行协议帧（不含换行；实现方负责写行尾）。 */
  send(line: string): void
  /** 注册逐行回调，每收到一行完整帧触发一次。 */
  onLine(handler: (line: string) => void): void
  /** 注册关闭回调（底层流结束或出错时触发）。 */
  onClose(handler: (error?: Error) => void): void
  /** 关闭底层流。 */
  close(): void
}

/** session/prompt 返回的停止原因。 */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | (string & {})

export interface AcpInitializeResult {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string } | null
}

/** 归一化后的 session/update 通知。 */
export interface AcpSessionUpdate {
  sessionId: string
  /** session/update 判别字段，如 agent_message_chunk / tool_call。 */
  kind: string
  /** *_chunk 类的文本内容。 */
  text?: string
  /** *_chunk 类的思考/推理内容（与 text 同 chunk 到达时可能都非空）。 */
  reasoning?: string
  /** tool_call 类的标题。 */
  title?: string
  toolCallId?: string
}

/** 归一化一条 session/update 通知：提取 kind 与 *_chunk 的 text/reasoning。 */
export function normalizeSessionUpdate(params: unknown): AcpSessionUpdate {
  const record = (params ?? {}) as Record<string, unknown>
  const update = (record.update ?? {}) as Record<string, unknown>
  const base: AcpSessionUpdate = {
    sessionId: String(record.sessionId ?? ''),
    kind: String(update.sessionUpdate ?? ''),
  }
  const kind = base.kind
  if (kind.endsWith('_chunk')) {
    const content = update.content
    if (content && typeof content === 'object') {
      const value = content as Record<string, unknown>
      if (value.type === 'reasoning') {
        if (typeof value.text === 'string') base.reasoning = value.text
      } else {
        if (value.reasoning !== undefined && value.reasoning !== null) base.reasoning = String(value.reasoning)
        if ('text' in value) base.text = String(value.text ?? '')
      }
    }
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    base.title = typeof update.title === 'string' ? update.title : undefined
    base.toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
  }
  return base
}

/** 归一化后的 session/request_permission 请求。 */
export interface AcpPermissionRequest {
  sessionId: string
  /** 工具调用 id，用于审批回执关联。 */
  toolCallId: string
  toolTitle: string
  toolKind?: string
  /** 原始输入参数（渲染层展示前需脱敏）。 */
  rawInput?: unknown
  /** 服务端给出的可选审批项名称（allow_once / reject_once …）。 */
  options: string[]
}

export interface AcpClientOptions {
  transport: AcpTransport
  /** 控制面请求（initialize / session/new）超时，默认 30 秒。prompt 不设超时。 */
  requestTimeoutMs?: number
  /** initialize 时上报的客户端信息。 */
  clientInfo?: { name: string; version: string }
  /** 收到 request_permission 时回调：返回 true 回复 allow_once，false 回复 reject_once。抛错或缺失按拒绝处理（fails closed）。 */
  onPermissionRequest?: (request: AcpPermissionRequest) => boolean | Promise<boolean>
  /** 收到 session/update 通知时回调。 */
  onSessionUpdate?: (update: AcpSessionUpdate) => void
  /** 连接关闭时回调（正常结束 error 为 undefined）。 */
  onClose?: (error?: Error) => void
}

export interface AcpClient {
  /** initialize 握手，协商协议版本。 */
  initialize(): Promise<AcpInitializeResult>
  /** 创建会话，返回 sessionId。 */
  sessionNew(cwd: string): Promise<string>
  /** 发送一条 prompt，等待整轮结束，返回停止原因。 */
  prompt(sessionId: string, text: string): Promise<AcpStopReason>
  /** 取消会话的进行中请求。 */
  cancel(sessionId: string): Promise<void>
  /** 关闭连接。 */
  close(): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : fallback)
}

export function createAcpClient(options: AcpClientOptions): AcpClient {
  const { transport } = options
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  let nextId = 0
  const pending = new Map<number, PendingRequest>()
  let closedError: Error | undefined
  let closed = false

  function rejectPendingRequests(error: Error): void {
    closed = true
    closedError = error
    for (const { reject, timer } of pending.values()) {
      if (timer) clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  transport.onLine(line => {
    if (closed) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    const hasId = 'id' in record
    const hasMethod = typeof record.method === 'string'
    if (hasId && hasMethod) {
      void handleIncomingRequest(record)
    } else if (hasMethod) {
      handleIncomingNotification(record)
    } else if (hasId) {
      handleResponse(record)
    }
  })

  transport.onClose(error => {
    if (closed) return
    const closeError = error ?? new Error('ACP 连接已关闭')
    rejectPendingRequests(closeError)
    options.onClose?.(closeError)
  })

  function sendRaw(message: unknown): void {
    if (closed) throw closedError ?? new Error('ACP 连接已关闭')
    transport.send(JSON.stringify(message))
  }

  function sendRequest<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (closed) return Promise.reject(closedError ?? new Error('ACP 连接已关闭'))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === 0
          ? undefined
          : setTimeout(() => {
              pending.delete(id)
              reject(new Error(`ACP 请求超时：${method}`))
            }, timeoutMs ?? requestTimeoutMs)
      pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
      try {
        sendRaw({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        if (timer) clearTimeout(timer)
        pending.delete(id)
        reject(asError(error, `ACP 发送失败：${method}`))
      }
    })
  }

  function sendNotification(method: string, params: unknown): Promise<void> {
    if (closed) return Promise.reject(closedError ?? new Error('ACP 连接已关闭'))
    return Promise.resolve(sendRaw({ jsonrpc: '2.0', method, params }))
  }

  function handleResponse(message: Record<string, unknown>): void {
    const id = message.id
    const entry = typeof id === 'number' ? pending.get(id) : undefined
    if (!entry) return
    pending.delete(id as number)
    if (entry.timer) clearTimeout(entry.timer)
    if ('error' in message && message.error !== null && message.error !== undefined) {
      const error = message.error as { code?: number; message?: string; data?: unknown }
      const err = new Error(error?.message ?? `ACP 请求失败（code ${error?.code ?? '未知'}）`)
      ;(err as Error & { code?: number }).code = error?.code
      ;(err as Error & { data?: unknown }).data = error?.data
      entry.reject(err)
      return
    }
    entry.resolve(message.result)
  }

  async function handleIncomingRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id
    const method = String(message.method)
    try {
      if (method === 'session/request_permission') {
        const request = normalizePermissionRequest(message.params)
        let allow = false
        if (options.onPermissionRequest) {
          allow = Boolean(await Promise.resolve(options.onPermissionRequest(request)))
        }
        sendRaw({ jsonrpc: '2.0', id, result: { outcome: allow ? 'allow_once' : 'reject_once' } })
        return
      }
      sendRaw({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    } catch (error) {
      sendRaw({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: asError(error, 'ACP 入站请求处理失败').message },
      })
    }
  }

  function handleIncomingNotification(message: Record<string, unknown>): void {
    if (message.method === 'session/update') {
      options.onSessionUpdate?.(normalizeSessionUpdate(message.params))
    }
  }

  function normalizePermissionRequest(params: unknown): AcpPermissionRequest {
    const record = (params ?? {}) as Record<string, unknown>
    const toolCall = (record.toolCall ?? {}) as Record<string, unknown>
    const optionsList = Array.isArray(record.options)
      ? (record.options as Array<Record<string, unknown>>).map(option => String(option?.name ?? option))
      : []
    return {
      sessionId: String(record.sessionId ?? ''),
      toolCallId: String(toolCall.toolCallId ?? ''),
      toolTitle: String(toolCall.title ?? toolCall.kind ?? '未知工具'),
      toolKind: typeof toolCall.kind === 'string' ? toolCall.kind : undefined,
      rawInput: toolCall.rawInput,
      options: optionsList,
    }
  }

  return {
    initialize(): Promise<AcpInitializeResult> {
      const clientInfo = options.clientInfo ?? { name: 'dsh-melody-launcher', version: '0.0.0' }
      return sendRequest<AcpInitializeResult>('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo,
        clientCapabilities: {},
      })
    },
    sessionNew(cwd: string): Promise<string> {
      return sendRequest<{ sessionId: string }>('session/new', {
        cwd,
        additionalDirectories: [],
        mcpServers: [],
      }).then(result => result.sessionId)
    },
    prompt(sessionId: string, text: string): Promise<AcpStopReason> {
      return sendRequest<{ stopReason: AcpStopReason }>(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        0,
      ).then(result => result.stopReason)
    },
    cancel(sessionId: string): Promise<void> {
      return sendNotification('session/cancel', { sessionId })
    },
    close(): void {
      if (closed) return
      // transport.close() only closes stdin and may not emit onClose until the child exits.
      // Reject requests here so an unbounded session/prompt cannot keep cancellation stuck.
      rejectPendingRequests(new Error('ACP 连接已关闭'))
      transport.close()
    },
  }
}
