import { describe, expect, it } from 'vitest'
import { createAcpClient, type AcpTransport } from '../electron/acp-client'

function inertTransport(): AcpTransport & { sent: string[]; closed: boolean } {
  let lineHandler: (line: string) => void = () => undefined
  let closeHandler: (error?: Error) => void = () => undefined
  return {
    sent: [],
    closed: false,
    send(line) {
      this.sent.push(line)
    },
    onLine(handler) {
      lineHandler = handler
      void lineHandler
    },
    onClose(handler) {
      closeHandler = handler
      void closeHandler
    },
    close() {
      // Reproduce the stdio transport: closing stdin does not synchronously emit onClose.
      this.closed = true
    },
  }
}

describe('ACP client cancellation', () => {
  it('rejects an unbounded prompt immediately when the client is closed', async () => {
    const transport = inertTransport()
    const client = createAcpClient({ transport })
    const promptResult = client.prompt('session-1', 'diagnose').then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )

    client.close()

    await expect(promptResult).resolves.toBe('ACP 连接已关闭')
    expect(transport.closed).toBe(true)
    await expect(client.cancel('session-1')).rejects.toThrow('ACP 连接已关闭')
  })
})

describe('normalizeSessionUpdate', () => {
  it('extracts text and reasoning from agent message chunks', async () => {
    const { normalizeSessionUpdate } = await import('../electron/acp-client')
    const update = normalizeSessionUpdate({
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: '正文片段', reasoning: '思考片段' },
      },
    })
    expect(update.kind).toBe('agent_message_chunk')
    expect(update.text).toBe('正文片段')
    expect(update.reasoning).toBe('思考片段')
  })

  it('keeps reasoning-only chunks without text', async () => {
    const { normalizeSessionUpdate } = await import('../electron/acp-client')
    const update = normalizeSessionUpdate({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_reasoning_chunk', content: { reasoning: '先想一下' } },
    })
    expect(update.reasoning).toBe('先想一下')
    expect(update.text).toBeUndefined()
  })
})

describe('normalizeSessionUpdate reasoning type', () => {
  it('maps a reasoning-typed chunk to the reasoning field instead of text', async () => {
    const { normalizeSessionUpdate } = await import('../electron/acp-client')
    const update = normalizeSessionUpdate({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'reasoning', text: '思考增量' } },
    })
    expect(update.reasoning).toBe('思考增量')
    expect(update.text).toBeUndefined()
  })
})
