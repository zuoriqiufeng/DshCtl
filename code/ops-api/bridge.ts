/**
 * bridge.ts — 会话驱动桥：程序化驱动 DSH Agent 会话并回收流式输出
 *
 * 流程（每请求一个临时会话，preset=i2stream-ops）：
 *   create → 启动 consume(follow) → prompt(queue) → 等 turn/end → dispose
 *   ⚠ follow 必须在 prompt 之前打开：晚开错过 attempt start → revision 校验抛错 → abandoned
 *
 * follow 帧序（sessionController.follow）：
 *   1. snapshot{records}           — 开场快照；records 含历史 durable 事件（提取 assistant/message 兜底）
 *   2. 交错到达：
 *      event{event:{type,data}}    — durable 事件（assistant/message / turn/end / ...）
 *                                    data 为完整 {turn, step, message:{content:[...]}, usage, stream}
 *      assistant-stream{frame}     — 实时 attempt 帧
 *        start  — 新 attempt 开始（attemptId/turn/step）
 *        chunk  — text-delta{text} / usage{usage} / ...
 *        end    — outcome: committed(eventType: assistant/message|assistant/attempt) / abandoned
 *
 * ⚠ eventType=assistant/message 不代表 turn 终局：带文本+工具调用的中间步也结算为
 *   assistant/message。turn 终局唯一定位是 turn/end durable 事件（立即 return）。
 *
 * 最终答案语义：保留最近一次非空 committed 文本（或 durable assistant/message 兜底文本），
 * turn/end 终局时返回；全无文本且 attempt abandoned → TurnAbandonedError。
 */

import { mapUsage, type Usage } from './openai.ts'

export interface SessionDriver {
  create(req: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  /** 续接已有会话（多轮）。unknown sessionId 必须 reject（抛错），不得静默新建。 */
  resume?(req: { sessionId: string }): Promise<{ sessionId: string }>
  follow(req: { address: { kind: 'session'; sessionId: string }; assistantStream?: true }, signal: AbortSignal): AsyncIterable<unknown>
  prompt(req: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: Array<{ type: 'text'; text: string }> }, signal: AbortSignal): Promise<{ accepted: true }>
  cancel(req: { sessionId: string }): unknown
}

export interface TurnResult {
  content: string
  usage: Usage
  finishReason: string
  attempts: number
}

export class TurnTimeoutError extends Error {
  constructor(sec: number) {
    super(`turn timeout after ${sec}s`)
    this.name = 'TurnTimeoutError'
  }
}

export class TurnAbandonedError extends Error {
  constructor() {
    super('assistant turn abandoned')
    this.name = 'TurnAbandonedError'
  }
}

/** 从 durable assistant/message 事件 data 中尽力提取文本（流中断兜底）。 */
export function extractMessageText(data: unknown): string {
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  if (typeof d.text === 'string') return d.text
  const content = d.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean)
      .join('')
  }
  // durable assistant/message 事件真实形状：{turn, step, message:{role, content:[{type:'text'|'reasoning', text}]}, ...}
  // content 嵌套在 message 下，需递归提取（仅取 type==='text' 的 part，reasoning 不算最终答案）
  const msg = d.message
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>
    if (typeof m.text === 'string') return m.text
    const mc = m.content
    if (typeof mc === 'string') return mc
    if (Array.isArray(mc)) {
      return mc
        .filter((p): p is { type: string; text: string } =>
          !!p && typeof p === 'object'
            && (p as { type?: unknown }).type === 'text'
            && typeof (p as { text?: unknown }).text === 'string')
        .map((p) => p.text)
        .join('')
    }
  }
  return ''
}

interface StreamFrame {
  type: 'start' | 'chunk' | 'end'
  attemptId?: string
  chunk?: { type?: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  outcome?: { kind: string; eventType?: string; seq?: number }
}

/**
 * 驱动一轮对话直到 committed（assistant/message）或失败。
 *
 * @param driver  SessionDriver（生产环境传 ctx.sessionController 适配层）
 * @param prompt  完整 prompt 文本（历史压缩后）
 * @param opts    preset/cwd/timeout/AbortSignal/onDelta（SSE 增量回调）
 */
export async function runTurn(
  driver: SessionDriver,
  prompt: string,
  opts: {
    preset: string
    cwd?: string
    /** 多轮续接：传入已有会话 id 则跳过 create（driver.resume 也会被优先用于校验） */
    sessionId?: string
    timeoutSec: number
    signal?: AbortSignal
    onDelta?: (text: string) => void
  },
): Promise<TurnResult & { sessionId: string }> {
  let sessionId: string
  if (opts.sessionId) {
    // 多轮：走 resume 校验（unknown id 抛错，由路由层映射 400）
    sessionId = opts.sessionId
    if (driver.resume) {
      const r = await driver.resume({ sessionId })
      sessionId = r.sessionId
    }
  } else {
    ({ sessionId } = await driver.create({ cwd: opts.cwd, agentPreset: opts.preset }))
  }

  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), opts.timeoutSec * 1000)
  const signal = mergeSignals(opts.signal, timeoutCtl.signal)

  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  let attempts = 0
  const buffers = new Map<string, string>()
  let finalText = ''
  let durableFallback = ''
  // 多轮防污染（armed 启发式）：resume 会话的 follow 开场快照含历史全部 durable 事件。
  // 旧回合的 assistant/message 文本不得计入本轮 durableFallback。
  // prompt 与 follow 同时在 runTurn 内部打开，prompt 提交后的第一帧必属本轮 → 首帧武装。
  let armed = !opts.sessionId

  // 必须在 prompt 之前打开 follow：实时 assistant-stream 帧与 durable 事件在 turn 期间到达；
  // 晚开（prompt 之后）会错过 attempt start → revision 校验抛错 → abandoned。
  // snapshot 帧（records 含 durable 事件）也要提取 assistant/message 文本作兜底。
  const consume = async (): Promise<void> => {
    for await (const raw of driver.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, signal)) {
      const frame = raw as {
        type?: string
        records?: Array<{ type?: string; event?: { type?: string; data?: unknown } }>
        event?: { type?: string; data?: unknown }
        frame?: StreamFrame
      }
      if (frame?.type === 'snapshot') {
        // resume 场景：快照是历史事件，armed=false 时不计入 durableFallback（防旧回合文本污染）
        if (armed) {
          for (const rec of frame.records ?? []) {
            if (rec?.event?.type === 'assistant/message') {
              const text = extractMessageText(rec.event.data)
              if (text) durableFallback = text
            }
          }
        }
        continue
      }
      if (frame?.type === 'event') {
        const et = frame.event?.type
        if (et === 'assistant/message') {
          if (!armed) continue
          const text = extractMessageText(frame.event?.data)
          if (text) durableFallback = text
        } else if (et === 'turn/end') {
          // turn 终局信号：立即返回（follow 生成器不会自行结束，等超时会拖到 timeoutSec）
          // resume 场景：武装前的 turn/end 属旧回合，忽略
          if (armed) {
            if (!finalText && durableFallback) finalText = durableFallback
            return
          }
        }
        continue
      }
      if (frame?.type !== 'assistant-stream' || !frame.frame) continue
      const f = frame.frame
      if (!armed) armed = true   // prompt 后第一帧（start/chunk/end 任一）即属本轮
      if (f.type === 'start') {
        attempts++
        buffers.set(f.attemptId ?? `attempt-${attempts}`, '')
      } else if (f.type === 'chunk') {
        const c = f.chunk
        if (!c) continue
        if (c.type === 'text-delta' && typeof c.text === 'string') {
          const key = f.attemptId ?? `attempt-${attempts}`
          buffers.set(key, (buffers.get(key) ?? '') + c.text)
          opts.onDelta?.(c.text)
        } else if (c.type === 'usage') {
          usage = mapUsage(c.usage)
        }
      } else if (f.type === 'end') {
        const key = f.attemptId ?? `attempt-${attempts}`
        if (f.outcome?.kind === 'committed') {
          // eventType=assistant/message 只表示该 attempt 结算为 durable assistant/message
          // （带文本+工具调用的中间步也会如此），不代表 turn 终局。
          // 语义：保留最近一次非空 committed 文本，等 turn/end 确认终局。
          const t = buffers.get(key) ?? ''
          buffers.delete(key)
          if (t) finalText = t
          else if (!finalText && durableFallback) finalText = durableFallback
          continue
        }
        if (f.outcome?.kind === 'abandoned') {
          // 有可用文本则继续等终局（弃单 attempt 可能有重试）；全无文本才视为失败
          if (finalText || durableFallback) continue
          throw new TurnAbandonedError()
        }
        // 其他 outcome：缓冲丢弃，继续等终局
        buffers.delete(key)
      }
    }
    if (durableFallback) finalText = durableFallback
  }

  const consuming = consume()
  try {
    await driver.prompt({
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    }, signal)
    await consuming
  } catch (e) {
    try { consuming.catch(() => { /* ignore consume failure after prompt error */ }) } catch { /* ignore */ }
    try { driver.cancel({ sessionId }) } catch { /* ignore */ }
    if (timeoutCtl.signal.aborted && !opts.signal?.aborted) throw new TurnTimeoutError(opts.timeoutSec)
    throw e
  } finally {
    clearTimeout(timer)
  }

  const content = finalText
  return { content, usage, finishReason: content ? 'stop' : 'abandoned', attempts, sessionId }
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!a) return b!
  if (!b) return a
  const ctl = new AbortController()
  const abort = () => ctl.abort()
  if (a.aborted || b.aborted) ctl.abort()
  else {
    a.addEventListener('abort', abort, { once: true })
    b.addEventListener('abort', abort, { once: true })
  }
  return ctl.signal
}
