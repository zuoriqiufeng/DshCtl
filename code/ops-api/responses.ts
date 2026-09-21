/**
 * responses.ts — OpenAI Responses API 翻译层（G2 扩展端点，gap-exec-plan P3）
 *
 * 把 `/v1/responses` 请求翻译成 ops-api 内部 messages，跑 runTurn 后组装回
 * Responses API 形状。仅支持子集：
 *   - input: string | Array<{role:'user'|'assistant', content:string}>（system 显式 400）
 *   - model: 可选（覆盖默认）
 *   - stream: 暂不支持（stream:true → 400，二期实现）
 *   - 未知字段白名单校验：Object.keys(body) 中不在允许集的 → 400 unsupported field
 *
 * 响应形状（非流式）：
 *   { id: 'resp_...', object: 'response', status: 'completed',
 *     model, output: [{ type: 'message', role: 'assistant',
 *                       content: [{ type: 'output_text', text }] }],
 *     usage: { prompt_tokens, completion_tokens, total_tokens } }
 */

import type { ChatMessage } from './openai.ts'

/** 允许的请求字段（白名单） */
const ALLOWED_FIELDS = new Set(['input', 'model', 'stream', 'metadata'])

export type ResponsesParse = {
  ok: true
  messages: ChatMessage[]
  model?: string
  stream: boolean
} | {
  ok: false
  error: string
  /** HTTP 状态码，默认 400 */
  status?: number
}

/**
 * 校验并翻译 /v1/responses 请求体。
 * - 未知字段 → 400 unsupported field: X
 * - stream:true → SSE 流式分支（P5a：response.output_text.delta 事件序列）
 * - input string → [{role:'user', content}]
 * - input array → 逐项映射（仅 user/assistant；system → 400）
 */
export function parseResponsesRequest(body: unknown): ResponsesParse {
  if (!body || typeof body !== 'object') return { ok: false, error: 'request body must be a JSON object' }
  const b = body as Record<string, unknown>

  // 未知字段白名单校验
  for (const key of Object.keys(b)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, error: `unsupported field: ${key}`, status: 400 }
    }
  }

  const stream = b.stream === true

  const input = b.input
  let messages: ChatMessage[]

  if (typeof input === 'string') {
    messages = [{ role: 'user', content: input }]
  } else if (Array.isArray(input)) {
    messages = []
    for (const item of input) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'input array items must be objects' }
      const role = (item as { role?: unknown }).role
      const content = (item as { content?: unknown }).content
      if (role !== 'user' && role !== 'assistant') {
        return { ok: false, error: `unsupported input role: ${String(role)} (only user|assistant)`, status: 400 }
      }
      if (typeof content !== 'string') {
        return { ok: false, error: 'input array items must have string content' }
      }
      messages.push({ role, content })
    }
  } else {
    return { ok: false, error: '"input" must be a string or an array of {role, content}' }
  }

  if (messages.length === 0) return { ok: false, error: '"input" must not be empty' }

  const model = typeof b.model === 'string' && b.model ? b.model : undefined
  return { ok: true, messages, model, stream }
}

/** 组装 Responses API 非流式响应对象 */
export function buildResponse(opts: {
  id: string
  model: string
  text: string
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}): Record<string, unknown> {
  return {
    id: opts.id,
    object: 'response',
    status: 'completed',
    model: opts.model,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: opts.text },
        ],
      },
    ],
    usage: {
      prompt_tokens: opts.usage.prompt_tokens,
      completion_tokens: opts.usage.completion_tokens,
      total_tokens: opts.usage.total_tokens,
    },
  }
}

/**
 * 组装 /v1/responses 流式事件序列（P5a）
 *
 * 简化的一期序列（省略 output_item/content_part 中间阶段事件，多数客户端只消费
 * delta + completed）：
 *   1. response.created          — {id, object, status: 'in_progress'}
 *   2. N × response.output_text.delta — {delta: '<增量>'}（运行时由 onDelta 逐帧产生）
 *   3. response.completed        — {id, status: 'completed', output, usage}
 * 错误路径：response.failed — {id, error}
 *
 * 返回待写入的事件数组（用于非实时场景/测试）；实时流式由 handleResponses 逐帧 write。
 */
export function buildResponsesStreamEvents(opts: {
  id: string
  model: string
  /** 增量文本帧（按顺序） */
  deltas: string[]
  /** 完整文本（completed 事件的 output） */
  fullText: string
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: { id: opts.id, object: 'response', status: 'in_progress', model: opts.model } },
  ]
  for (const delta of opts.deltas) {
    events.push({ type: 'response.output_text.delta', item_id: opts.id, delta })
  }
  events.push({
    type: 'response.completed',
    response: {
      id: opts.id,
      object: 'response',
      status: 'completed',
      model: opts.model,
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: opts.fullText }] },
      ],
      usage: {
        prompt_tokens: opts.usage.prompt_tokens,
        completion_tokens: opts.usage.completion_tokens,
        total_tokens: opts.usage.total_tokens,
      },
    },
  })
  return events
}

/** 流式错误事件（response.failed） */
export function buildResponsesFailedEvent(id: string, error: string): Record<string, unknown> {
  return { type: 'response.failed', response: { id, object: 'response', status: 'failed', error: { message: error } } }
}
