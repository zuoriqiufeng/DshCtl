/**
 * openai.ts — OpenAI 兼容协议组装（纯函数，无 IO，可单测）
 *
 * 对齐 Hermes api-server（gateway/platforms/api_server.py）的 /v1 面形状：
 *   POST /v1/chat/completions（流式/非流式）、GET /v1/models、错误 envelope。
 */

import { randomUUID } from 'node:crypto'

export interface ChatMessage {
  role: string
  content: unknown
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** TokenUsage（DSH llm 层）→ OpenAI usage */
export function mapUsage(u: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null | undefined): Usage {
  const prompt = u?.inputTokens ?? 0
  const completion = u?.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u?.totalTokens ?? prompt + completion,
  }
}

/** 校验 chat/completions 请求体；返回错误消息或规范化输入。 */
export function parseChatRequest(body: unknown): { ok: true; messages: ChatMessage[]; stream: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: '请求体必须是 JSON 对象' }
  const b = body as Record<string, unknown>
  const messages = b.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: '"messages" 必须是非空数组' }
  }
  const normalized: ChatMessage[] = []
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof (m as ChatMessage).role !== 'string') {
      return { ok: false, error: 'messages 每项必须含 role 字符串' }
    }
    normalized.push({ role: (m as ChatMessage).role, content: (m as ChatMessage).content })
  }
  return { ok: true, messages: normalized, stream: b.stream === true }
}

/** messages 数组 → 临时会话的单条 prompt 文本（无状态协议的多轮上下文压缩）。 */
export function buildPromptText(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]
  const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  const history = messages.slice(0, -1)
  if (!history.length) return lastText
  const lines: string[] = ['[对话上下文]']
  for (const m of history) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    const role = m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '用户'
    lines.push(`${role}: ${text.replace(/\n+/g, ' ').slice(0, 400)}`)
  }
  lines.push('', '[当前问题]', lastText)
  return lines.join('\n')
}

export function completionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, '')}`
}

/** 非流式响应组装。 */
export function buildCompletion(opts: { id: string; model: string; content: string; usage: Usage; finishReason?: string }): Record<string, unknown> {
  return {
    id: opts.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: opts.content },
      finish_reason: opts.finishReason ?? 'stop',
    }],
    usage: opts.usage,
  }
}

/** 流式 chunk 组装（delta.content 增量）。 */
export function buildChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** 流式收尾 chunk（role 头 + usage）。 */
export function buildFinalChunks(id: string, model: string, usage: Usage): Array<Record<string, unknown>> {
  return [
    buildChunk(id, model, { role: 'assistant' }),
    buildChunk(id, model, {}, 'stop'),
    { id, object: 'chat.completion.usage', created: Math.floor(Date.now() / 1000), model, usage },
  ]
}

/** 错误 envelope（对齐 Hermes gateway_auth_error 形状）。 */
export function errorBody(message: string, type: string): Record<string, unknown> {
  return { error: { message, type } }
}

/** /v1/models 响应。 */
export function modelsBody(modelId: string): Record<string, unknown> {
  return {
    object: 'list',
    data: [{
      id: modelId,
      object: 'model',
      created: 1789371819,
      owned_by: 'dsh',
      permission: [],
      root: modelId,
      parent: null,
    }],
  }
}

/** Bearer 鉴权比对（apiKey 为空 = 不鉴权）。 */
export function authorized(header: string | string[] | undefined, apiKey: string): boolean {
  if (!apiKey) return true
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return false
  const m = /^Bearer\s+(.+)$/.exec(raw.trim())
  return !!m && timingSafeEqual(m[1], apiKey)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
