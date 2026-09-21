/**
 * self-test.ts — ops-api 纯函数与会话桥行为自测（不依赖运行实例）
 *
 * 运行：cd /hdd/agent/deepseek-harness && node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-api/self-test.ts
 */

import {
  authorized,
  buildChunk,
  buildCompletion,
  buildFinalChunks,
  buildPromptText,
  completionId,
  errorBody,
  mapUsage,
  modelsBody,
  parseChatRequest,
} from './openai.ts'
import { extractMessageText, runTurn, TurnAbandonedError, type SessionDriver } from './bridge.ts'
import { createOpsMemory, memoryAls } from './memory.ts'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from './index.ts'
import { buildMemoryTools } from './tools-memory.ts'
import { parseResponsesRequest, buildResponse } from './responses.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.error(`  ✗ ${label} ${detail}`) }
}

console.log('\n[1] openai.ts 协议组装')
{
  const ok = parseChatRequest({ messages: [{ role: 'user', content: 'hi' }] })
  check('parseChatRequest 合法请求', ok.ok && !('stream' in ok && ok.stream === true), JSON.stringify(ok))
  check('parseChatRequest 空 messages 拒绝', !parseChatRequest({ messages: [] }).ok)
  check('parseChatRequest 非对象拒绝', !parseChatRequest(null).ok)
  check('parseChatRequest 缺 role 拒绝', !parseChatRequest({ messages: [{ content: 'x' }] }).ok)
  const streamed = parseChatRequest({ messages: [{ role: 'user', content: 'hi' }], stream: true })
  check('parseChatRequest stream=true', streamed.ok && streamed.stream)

  const single = buildPromptText([{ role: 'user', content: '直接问题' }])
  check('buildPromptText 单条直传', single === '直接问题', single)
  const multi = buildPromptText([
    { role: 'system', content: '你是运维专家' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ])
  check('buildPromptText 多轮含上下文标记', multi.includes('[对话上下文]') && multi.includes('系统: 你是运维专家') && multi.includes('[当前问题]') && multi.endsWith('第二问'), multi.slice(0, 120))

  const u1 = mapUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })
  check('mapUsage 全字段', u1.prompt_tokens === 10 && u1.completion_tokens === 20 && u1.total_tokens === 30, JSON.stringify(u1))
  const u2 = mapUsage({ inputTokens: 10, outputTokens: 20 })
  check('mapUsage 缺 total 回退求和', u2.total_tokens === 30, JSON.stringify(u2))

  const comp = buildCompletion({ id: completionId(), model: 'i2stream-ops', content: '答案', usage: u1 })
  check('buildCompletion 形状', comp.object === 'chat.completion' && Array.isArray(comp.choices) && (comp.choices as Array<{message:{content:string}}>)[0].message.content === '答案', JSON.stringify(comp).slice(0, 120))

  const chunks = buildFinalChunks('id1', 'm', u1)
  check('buildFinalChunks 含 stop chunk 与 usage chunk',
    chunks.some((c) => (c.choices as Array<{finish_reason: string|null}> | undefined)?.[0]?.finish_reason === 'stop')
    && chunks.some((c) => c.object === 'chat.completion.usage'), JSON.stringify(chunks.map((c) => c.object)))
  const delta = buildChunk('id1', 'm', { content: 'x' })
  check('buildChunk delta 形状', delta.object === 'chat.completion.chunk' && (delta.choices as Array<{delta:{content:string}}>)[0].delta.content === 'x')

  check('errorBody 形状', errorBody('msg', 'gateway_auth_error') !== undefined)
  check('modelsBody 单模型', (modelsBody('i2stream-ops').data as Array<{id:string}>)[0].id === 'i2stream-ops')

  check('authorized 空 key 放行', authorized(undefined, ''))
  check('authorized 正确 Bearer', authorized('Bearer sekrit', 'sekrit'))
  check('authorized 错误 key 拒绝', !authorized('Bearer wrong', 'sekrit'))
  check('authorized 缺头拒绝', !authorized(undefined, 'sekrit'))
}

console.log('\n[2] bridge.ts extractMessageText')
{
  check('字符串 data', extractMessageText('直接文本') === '直接文本')
  check('text 字段', extractMessageText({ text: 'abc' }) === 'abc')
  check('content parts', extractMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'ab')
  check('空对象', extractMessageText({}) === '')
  // durable assistant/message 事件真实形状：content 嵌套在 message 下
  check('嵌套 message.content', extractMessageText({ message: { role: 'assistant', content: [{ type: 'text', text: '嵌套文本' }] } }) === '嵌套文本')
  check('嵌套 message.content 多 part', extractMessageText({ message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '答案' }] } }) === '答案')
  check('嵌套 message.content 空', extractMessageText({ message: { content: [] } }) === '')
}

console.log('\n[3] bridge.ts runTurn（mock 驱动）')
{
  // mock：中间 attempt（assistant/attempt）被丢弃，最终 attempt（assistant/message）取胜
  const frames = [
    { type: 'snapshot', records: [] },
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1' } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '中间叙述' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a1', outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 10 } } },
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a2' } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a2', chunk: { type: 'text-delta', text: '最终答案' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a2', chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 8 } } } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a2', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 20 } } },
  ]
  const driver: SessionDriver = {
    create: async () => ({ sessionId: 's1', agentPreset: 'i2stream-ops' }),
    follow: async function* () { for (const f of frames) yield f },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const deltas: string[] = []
  const result = await runTurn(driver, '问题', { preset: 'i2stream-ops', timeoutSec: 5, onDelta: (t) => deltas.push(t) })
  check('runTurn 最终答案取胜', result.content === '最终答案', JSON.stringify(result))
  check('runTurn attempts=2', result.attempts === 2, String(result.attempts))
  check('runTurn usage 映射', result.usage.prompt_tokens === 50 && result.usage.completion_tokens === 8, JSON.stringify(result.usage))
  check('runTurn onDelta 收到全部增量', deltas.join('') === '中间叙述最终答案', JSON.stringify(deltas))

  // abandoned（且无 durable 文本）→ TurnAbandonedError
  const abandonedDriver: SessionDriver = {
    create: async () => ({ sessionId: 's2' }),
    follow: async function* () {
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'b1' } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'b1', outcome: { kind: 'abandoned' } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  let threw: unknown = null
  try { await runTurn(abandonedDriver, 'x', { preset: 'p', timeoutSec: 5 }) } catch (e) { threw = e }
  check('runTurn abandoned 抛错', threw instanceof TurnAbandonedError, String(threw))

  // durable 兜底：committed end 帧 buffer 空，但 durable assistant/message 已到
  const fallbackDriver: SessionDriver = {
    create: async () => ({ sessionId: 's3' }),
    follow: async function* () {
      yield { type: 'snapshot', records: [] }
      yield { type: 'event', event: { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '兜底答案' }] } } } }
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'b1' } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'b1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const fb = await runTurn(fallbackDriver, 'x', { preset: 'p', timeoutSec: 5 })
  check('runTurn committed buffer 空 → durable 兜底', fb.content === '兜底答案', JSON.stringify(fb))

  // snapshot records 兜底：follow 晚开（turn 已结束），文本只在 snapshot 里
  const snapshotDriver: SessionDriver = {
    create: async () => ({ sessionId: 's4' }),
    follow: async function* () {
      yield {
        type: 'snapshot',
        records: [
          { type: 'event', event: { type: 'assistant/message', data: { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '快照答案' }] } } } },
          { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
      }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const snap = await runTurn(snapshotDriver, 'x', { preset: 'p', timeoutSec: 5 })
  check('runTurn snapshot records 兜底', snap.content === '快照答案', JSON.stringify(snap))

  // 中间步 committed 带文本（文本+工具调用的 attempt 也结算为 assistant/message）
  // → 保留最近非空文本，turn/end 终局时最终步文本取胜
  const mixedDriver: SessionDriver = {
    create: async () => ({ sessionId: 's5' }),
    follow: async function* () {
      yield { type: 'snapshot', records: [] }
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'm1' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'm1', chunk: { type: 'text-delta', text: '我来查询前置条件' } } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'm1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } } }
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'm2' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'm2', chunk: { type: 'text-delta', text: '最终完整答案' } } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'm2', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } } }
      yield { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const mixed = await runTurn(mixedDriver, 'x', { preset: 'p', timeoutSec: 5 })
  check('runTurn 最终步文本取胜（中间步文本被覆盖）', mixed.content === '最终完整答案', JSON.stringify(mixed))
}

console.log('\n[9] bridge.ts 多轮续接（G1）')
{
  // 9.1 sessionId 入参 → 走 resume（create 不被调用）
  let created = 0
  let resumed: string[] = []
  const resumeDriver: SessionDriver = {
    create: async () => { created++; return { sessionId: 'new-s' } },
    resume: async (req) => { resumed.push(req.sessionId); return { sessionId: req.sessionId } },
    follow: async function* () {
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'r1' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'r1', chunk: { type: 'text-delta', text: '第二轮答案' } } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'r1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } } }
      yield { type: 'event', event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const r1 = await runTurn(resumeDriver, '第二问', { preset: 'p', timeoutSec: 5, sessionId: 'sess-1' })
  check('9.1 走 resume 不走 create', created === 0 && resumed.length === 1 && resumed[0] === 'sess-1', JSON.stringify({ created, resumed }))
  check('9.1 返回 sessionId 回显', r1.sessionId === 'sess-1', r1.sessionId)
  check('9.1 续接轮内容正确', r1.content === '第二轮答案', r1.content)

  // 9.2 armed 启发式：snapshot 历史文本（旧回合）不得污染本轮
  const poisonedDriver: SessionDriver = {
    create: async () => ({ sessionId: 'x' }),
    resume: async (req) => ({ sessionId: req.sessionId }),
    follow: async function* () {
      // 旧回合的历史 durable 事件（快照）
      yield {
        type: 'snapshot',
        records: [
          { type: 'event', event: { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '旧回合答案' }] } } } },
          { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
      }
      // 本轮：流式新答案
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'n1' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'n1', chunk: { type: 'text-delta', text: '本轮新答案' } } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'n1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } } }
      yield { type: 'event', event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const r2 = await runTurn(poisonedDriver, 'q', { preset: 'p', timeoutSec: 5, sessionId: 'sess-2' })
  check('9.2 snapshot 历史不污染（armed 前忽略）', r2.content === '本轮新答案', r2.content)

  // 9.3 armed 前的 turn/end 不得终止本轮
  const staleTurnEndDriver: SessionDriver = {
    create: async () => ({ sessionId: 'x' }),
    resume: async (req) => ({ sessionId: req.sessionId }),
    follow: async function* () {
      // 快照后立刻到达旧回合的 turn/end（armed 前）→ 必须忽略
      yield { type: 'snapshot', records: [] }
      yield { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'p1' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'p1', chunk: { type: 'text-delta', text: '真实本轮' } } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'p1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } } }
      yield { type: 'event', event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const r3 = await runTurn(staleTurnEndDriver, 'q', { preset: 'p', timeoutSec: 5, sessionId: 'sess-3' })
  check('9.3 旧回合 turn/end 不终止本轮', r3.content === '真实本轮', r3.content)

  // 9.4 resume 抛错（unknown id）→ runTurn 直接抛错（路由层映射 400）
  const unknownDriver: SessionDriver = {
    create: async () => ({ sessionId: 'x' }),
    resume: async () => { throw new Error('unknown session') },
    follow: async function* () { /* never */ },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  let threw: unknown = null
  try { await runTurn(unknownDriver, 'q', { preset: 'p', timeoutSec: 5, sessionId: 'no-such' }) } catch (e) { threw = e }
  check('9.4 unknown session id 抛错', threw instanceof Error && String(threw).includes('unknown'), String(threw))

  // 9.5 driver 无 resume 方法但传了 sessionId → 直接用该 id（不校验）
  const noResumeDriver: SessionDriver = {
    create: async () => ({ sessionId: 'x' }),
    follow: async function* () {
      yield { type: 'assistant-stream', frame: { type: 'start', attemptId: 'q1' } }
      yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'q1', chunk: { type: 'text-delta', text: '直用' } } }
      yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'q1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } }
      yield { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const r5 = await runTurn(noResumeDriver, 'q', { preset: 'p', timeoutSec: 5, sessionId: 'raw-id' })
  check('9.5 无 resume 时直用 sessionId', r5.sessionId === 'raw-id' && r5.content === '直用', JSON.stringify(r5))

  // 9.6 无 sessionId 行为回归（armed 初始 true，snapshot 兜底仍生效）
  const regressDriver: SessionDriver = {
    create: async () => ({ sessionId: 'fresh' }),
    follow: async function* () {
      yield {
        type: 'snapshot',
        records: [
          { type: 'event', event: { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '快照答案' }] } } } },
          { type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
      }
    },
    prompt: async () => ({ accepted: true as const }),
    cancel: () => undefined,
  }
  const r6 = await runTurn(regressDriver, 'q', { preset: 'p', timeoutSec: 5 })
  check('9.6 新会话 snapshot 兜底回归', r6.content === '快照答案' && r6.sessionId === 'fresh', JSON.stringify(r6))
}

await test10Memory()
await test11Responses()
await test12Supervisor()
await test13ResponsesStream()

// ─────────────────────────── [13] responses 流式（P5a）───────────────────────────
async function test13ResponsesStream(): Promise<void> {
  console.log('\n[13] responses.ts streaming (P5a)')
  const { parseResponsesRequest, buildResponsesStreamEvents, buildResponsesFailedEvent } = await import('./responses.ts')

  // 13.1 stream:true 不再 400（P5a 解除限制）
  const p = parseResponsesRequest({ input: 'hi', stream: true })
  check('13.1 stream:true 合法 + stream flag', p.ok && p.stream === true, JSON.stringify(p))

  // 13.2 stream 事件序列：created → delta × N → completed（首尾正确）
  const evs = buildResponsesStreamEvents({
    id: 'resp_1', model: 'm', deltas: ['你', '好'], fullText: '你好',
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })
  check('13.2 序列首事件 created', (evs[0] as { type: string }).type === 'response.created', JSON.stringify(evs[0]))
  check('13.2 中间 2 个 delta', evs.length === 4 && (evs[1] as { delta: string }).delta === '你' && (evs[2] as { delta: string }).delta === '好')
  const last = evs[evs.length - 1] as { type: string; response: { status: string; output: Array<{ content: Array<{ text: string }> }>; usage: { total_tokens: number } } }
  check('13.2b 尾事件 completed + usage', last.type === 'response.completed' && last.response.status === 'completed' && last.response.output[0].content[0].text === '你好' && last.response.usage.total_tokens === 3, JSON.stringify(last).slice(0, 120))

  // 13.3 failed 事件
  const f = buildResponsesFailedEvent('resp_2', 'turn timeout after 120s')
  check('13.3 failed 事件', (f as { type: string }).type === 'response.failed' && (f.response as { error: { message: string } }).error.message.includes('timeout'), JSON.stringify(f))
}

// ─────────────────────────── [12] gateway supervisor（P4，mock spawn/health）───────────────────────────
async function test12Supervisor(): Promise<void> {
  console.log('\n[12] supervisor.ts (P4)')
  const { createGatewaySupervisor } = await import('./supervisor.ts')
  const noopLog = { warn: (_m: string) => {}, info: (_m: string) => {}, error: (_m: string) => {} }

  // 12.1 health 已 ok（外部运行）→ 不 spawn，复用
  const origFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => { fetchCalls++; return new Response(JSON.stringify({ status: 'ok' }), { status: 200 }) }) as typeof fetch
  const sup1 = createGatewaySupervisor({ baseUrl: 'http://127.0.0.1:1', command: '/bad/cmd', healthTimeoutMs: 200 }, noopLog)
  const ok1 = await sup1.ensureRunning()
  check('12.1 health 已 ok → 复用（不 spawn）', ok1 && fetchCalls === 1 && !sup1.isManaged(), `ok=${ok1} fetch=${fetchCalls} managed=${sup1.isManaged()}`)

  // 12.2 health 失败 + 空 cmd → warn 不 crash，返回 false
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  const sup2 = createGatewaySupervisor({ baseUrl: 'http://127.0.0.1:1', command: '', healthTimeoutMs: 200 }, noopLog)
  const ok2 = await sup2.ensureRunning()
  check('12.2 空 cmd + health 失败 → false 不 crash', ok2 === false && !sup2.isManaged(), `ok=${ok2}`)

  // 12.3 连续失败 ×3 → giveUp，后续 ensureRunning 直接 false 不再尝试
  const sup3 = createGatewaySupervisor({ baseUrl: 'http://127.0.0.1:1', command: '', giveUpThreshold: 3, healthTimeoutMs: 100 }, noopLog)
  await sup3.ensureRunning(); await sup3.ensureRunning(); await sup3.ensureRunning()
  const gaveUp = sup3.hasGivenUp()
  const ok3 = await sup3.ensureRunning()
  check('12.3 连续失败 ×3 → giveUp 常开', gaveUp && ok3 === false, `gaveUp=${gaveUp} ok=${ok3}`)

  // 12.4 shutdown：无托管子进程 → 幂等 no-op
  const sup4 = createGatewaySupervisor({ baseUrl: 'http://127.0.0.1:1' }, noopLog)
  await sup4.shutdown()
  check('12.4 shutdown 无子进程 → 幂等 no-op', !sup4.isManaged())

  // 12.5 各种坏 baseUrl 不抛错（parseHost/parsePort 兜底）
  check('12.5 坏 baseUrl 不抛错', (() => {
    try { createGatewaySupervisor({ baseUrl: ':::bad-url:::' }, noopLog); return true } catch { return false }
  })())

  globalThis.fetch = origFetch
}

// ─────────────────────────── [11] responses 扩展端点（G2，纯函数翻译层）───────────────────────────
async function test11Responses(): Promise<void> {
  console.log('\n[11] responses.ts (G2)')

  // 11.1 input string → user 消息
  const s1 = parseResponsesRequest({ input: '你好' })
  check('11.1 input string → user 消息', s1.ok && s1.messages.length === 1 && s1.messages[0].role === 'user' && s1.messages[0].content === '你好', JSON.stringify(s1))

  // 11.2 input array（user+assistant）→ 多消息
  const s2 = parseResponsesRequest({ input: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })
  check('11.2 input array 多消息', s2.ok && s2.messages.length === 2 && s2.messages[1].role === 'assistant', JSON.stringify(s2))

  // 11.3 未知字段 → 400
  const s3 = parseResponsesRequest({ input: 'x', functions: {} })
  check('11.3 未知字段 400', !s3.ok && s3.status === 400 && s3.error.includes('unsupported field: functions'), JSON.stringify(s3))

  // 11.4 system 角色 → 400
  const s4 = parseResponsesRequest({ input: [{ role: 'system', content: 'sys' }] })
  check('11.4 system 角色 400', !s4.ok && s4.status === 400 && s4.error.includes('unsupported input role: system'), JSON.stringify(s4))

  // 11.6 model 覆盖
  const s6 = parseResponsesRequest({ input: 'x', model: 'gpt-x' })
  check('11.6 model 覆盖', s6.ok && s6.model === 'gpt-x', JSON.stringify(s6))

  // 11.7 空 input array → 400
  const s7 = parseResponsesRequest({ input: [] })
  check('11.7 空 input 400', !s7.ok, JSON.stringify(s7))

  // 11.8 buildResponse 形状
  const r = buildResponse({ id: 'resp_1', model: 'm', text: '答案', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
  const out = r.output as Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>
  check('11.8 buildResponse 形状', r.object === 'response' && r.status === 'completed' && out[0].type === 'message' && out[0].role === 'assistant' && out[0].content[0].type === 'output_text' && out[0].content[0].text === '答案', JSON.stringify(r).slice(0, 150))
  check('11.8b usage 透传', (r.usage as { total_tokens: number }).total_tokens === 3, JSON.stringify(r.usage))
}

// ─────────────────────────── [10] memory 薄客户端（G3）── mock fetch ───────────────────────────
async function test10Memory(): Promise<void> {
  console.log('\n[10] memory thin client (G3)')

  const realFetch = globalThis.fetch
  const logs: string[] = []
  const memLog = { warn: (m: string) => { logs.push(m) }, info: (m: string) => { logs.push(m) } }

  // 10.1 recall 成功 → context 透传；失败(网络错) → '' 不抛错
  {
    let mode: 'ok' | 'neterr' = 'ok'
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (mode === 'neterr') throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ context: '<memory-context>\nprod-tokyo C-7788</memory-context>', strategy: 'hybrid', memory_count: 3, code: 0 }), { status: 200 })
    }) as typeof fetch
    const m = createOpsMemory({ url: 'http://mock:8420' }, memLog)
    const r1 = await m.recall('k', 'q')
    check('10.1a recall 成功透传 context', r1.context.includes('prod-tokyo') && r1.memoryCount === 3, JSON.stringify(r1))
    mode = 'neterr'
    const r2 = await m.recall('k', 'q')
    check('10.1b recall 网络错降级空串不抛错', r2.context === '' && r2.memoryCount === 0, JSON.stringify(r2))
  }

  // 10.2 code!=0（H-15 语义）→ 空 context 不上抛
  {
    globalThis.fetch = (async () => new Response(JSON.stringify({ context: '', strategy: '', memory_count: 0, code: 503, message: 'EmbeddingService not ready' }), { status: 200 })) as typeof fetch
    const m = createOpsMemory({ url: 'http://mock:8420' }, memLog)
    const r = await m.recall('k', 'q')
    check('10.2 recall code!=0 降级空 context', r.context === '', JSON.stringify(r))
  }

  // 10.3 熔断：连续 threshold 次失败 → open；open 期间调用跳过（fetch 不再命中）
  {
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new TypeError('down') }) as typeof fetch
    const m = createOpsMemory({ url: 'http://mock:8420', breaker: { threshold: 5, cooldownMs: 60000 } }, memLog)
    for (let i = 0; i < 6; i++) await m.recall('k', 'q')
    const before = calls
    await m.recall('k', 'q'); await m.recall('k', 'q')
    check('10.3 熔断 open 后调用被跳过', m.breakerState().open && calls === before && before === 5, `calls=${calls} open=${m.breakerState().open}`)
  }

  // 10.4 背压：capture 在途 ≤ maxInFlight；慢网下不阻塞新请求
  {
    let inFlight = 0, maxSeen = 0
    globalThis.fetch = (async () => {
      inFlight++; maxSeen = Math.max(maxSeen, inFlight)
      await new Promise((r) => setTimeout(r, 40))
      inFlight--
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const m = createOpsMemory({ url: 'http://mock:8420', capture: { maxInFlight: 4, waitMs: 200 } }, memLog)
    for (let i = 0; i < 10; i++) m.capture({ sessionKey: 'k', userContent: `u${i}`, assistantContent: `a${i}` })
    await new Promise((r) => setTimeout(r, 400))
    check('10.4 capture 背压在途 ≤4', maxSeen <= 4, `maxInFlight=${maxSeen}`)
  }

  // 10.5 工具：无 ALS key → 提示语；有 key → 走 search 返回结果
  {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes('/search/memories')) return new Response(JSON.stringify({ results: '- [2026-08-20] 用户偏好 i2stream', total: 1, strategy: 'hybrid' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const m = createOpsMemory({ url: 'http://mock:8420' }, memLog)
    const tools = buildMemoryTools({ memory: m })
    check('10.5a 三工具注册名对齐 Hermes', tools.map((t) => t.name).join(',') === 'memory_tencentdb_memory_search,memory_tencentdb_conversation_search,memory_tencentdb_read_scene', tools.map((t) => t.name).join(','))
    const noKey = await tools[0].execute({ query: '偏好' })
    check('10.5b 无 ALS key → 未启用提示', String(noKey).includes('未启用记忆分片'), String(noKey).slice(0, 60))
    const withKey = await memoryAls.run({ memoryKey: 'k' }, () => tools[0].execute({ query: '偏好' }))
    check('10.5c 有 ALS key → 工具返回记忆', String(withKey).includes('i2stream'), String(withKey).slice(0, 60))
  }

  // 10.6 空 query/key 直接短路（不发 fetch）
  {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }) }) as typeof fetch
    const m = createOpsMemory({ url: 'http://mock:8420' }, memLog)
    await m.recall('', 'q'); await m.recall('k', ''); m.capture({ sessionKey: '', userContent: 'u', assistantContent: 'a' })
    check('10.6 空 key/query 短路不发请求', calls === 0, `calls=${calls}`)
  }

  globalThis.fetch = realFetch
}

// [14] api-server listener（E2）：fail-loud + 鉴权矩阵 + dispose 关闭（真端口随机起）
{
  const fakeCtx = (extra: Record<string, unknown> = {}) => ({
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    get: (name: string) => (name === 'webServer' ? { register: () => () => {} } : undefined),
    on: (_ev: string, _fn: () => void) => {},
    sessionController: {},
    ...extra,
  }) as never
  // 14.1 fail-loud：enabled + 空 key → apply 抛错
  {
    let threw = ''
    try {
      await apply(fakeCtx(), { preset: 'test-preset', modelId: 'test-model', apiServer: { enabled: true, host: '127.0.0.1', port: 1, apiKey: '' } })
    } catch (e) {
      threw = String(e)
    }
    check('14.1a enabled+空 key 拒绝启动（fail-loud）', threw.includes('apiServer.enabled=true requires'), threw.slice(0, 80))
  }
  // 14.2 鉴权矩阵：health 免鉴权 / 无 key 401 / 错 key 401 / 对 key 200
  {
    const port = 18640 + (process.pid % 2000)
    const key = 'st-14-key'
    apply(fakeCtx(), { preset: 'test-preset', modelId: 'test-model', apiServer: { enabled: true, host: '127.0.0.1', port, apiKey: key }, session: { enabled: false } })
    await new Promise((r) => setTimeout(r, 300))
    const base = `http://127.0.0.1:${port}`
    const h = await fetch(`${base}/health`)
    check('14.2a /health 免鉴权 200', h.status === 200, String(h.status))
    const noKey = await fetch(`${base}/v1/models`)
    check('14.2b 无 key → 401', noKey.status === 401, String(noKey.status))
    const badKey = await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer wrong' } })
    check('14.2c 错 key → 401', badKey.status === 401, String(badKey.status))
    const ok = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
    check('14.2d 对 key → 200 单模型清单', ok.status === 200, String(ok.status))
    const body = await ok.json() as { data?: { id?: string }[] }
    check('14.2e models 清单 id 正确', body.data?.[0]?.id === 'test-model', JSON.stringify(body).slice(0, 60))
    const nf = await fetch(`${base}/no/such/route`, { headers: { Authorization: `Bearer ${key}` } })
    check('14.2f 未知路由 → 404', nf.status === 404, String(nf.status))
  }
}
// [15] ops-admin 管理面（E3）：托管段读写 / 原子写+revision / schema 校验 / 技能启停
{
  const {
    MANAGED_BEGIN, MANAGED_END, computeRevision, ensureSkillsDir,
    listSkills, parseManagedServers, readManagedState, serializeServer,
    setSkillEnabled, validateServer, writeManagedState,
  } = await import('./admin.ts')
  const tmpDir = join(new URL('.', import.meta.url).pathname, `.ops-admin-st-${String(process.pid)}`)
  mkdirSync(tmpDir, { recursive: true })
  const patchPath = join(tmpDir, 'cordis.patch.yml')

  // 15.1 校验器：非法 serverName / 缺 url / 缺 command / 合法
  check('15.1a 非法 name 拒绝', validateServer({ serverName: 'bad name!', transport: 'stdio', command: 'x' }).length > 0, '')
  check('15.1b http 缺 url 拒绝', validateServer({ serverName: 'ok', transport: 'streamable-http' }).some((e) => e.includes('url')), '')
  check('15.1c stdio 缺 command 拒绝', validateServer({ serverName: 'ok', transport: 'stdio' }).some((e) => e.includes('command')), '')
  check('15.1d 合法定义通过', validateServer({ serverName: 'i2agent', transport: 'streamable-http', url: 'http://x/mcp' }).length === 0, '')

  // 15.2 序列化→解析往返（含 headers）
  const entry = { serverName: 'probe', transport: 'streamable-http' as const, url: 'http://127.0.0.1:8090/mcp', headers: { Authorization: 'Bearer sk-x' } }
  const roundtrip = parseManagedServers([MANAGED_BEGIN, ...serializeServer(entry), MANAGED_END].join('\n'))
  check('15.2a 往返 serverName', roundtrip[0]?.serverName === 'probe', JSON.stringify(roundtrip[0]))
  check('15.2b 往返 url', roundtrip[0]?.url === 'http://127.0.0.1:8090/mcp', String(roundtrip[0]?.url))
  check('15.2c 往返 header', roundtrip[0]?.headers?.Authorization === 'Bearer sk-x', JSON.stringify(roundtrip[0]?.headers))

  // 15.3 原子写：首次追加标记区 / 区外内容不动 / 修订冲突 409 / 覆盖删除
  writeFileSync(patchPath, '- id: agent-presets\n  config:\n    default: standard\n')
  const s1 = readManagedState(patchPath)
  check('15.3a 初始无托管段', s1.servers.length === 0, String(s1.servers.length))
  check('15.3b 首次写入成功', writeManagedState(patchPath, s1.revision, [entry]), '')
  const after = readFileSync(patchPath, 'utf8')
  check('15.3c 区外内容保留', after.includes('default: standard'), '')
  check('15.3d 标记区存在且含 - insert: 父级', after.includes(MANAGED_BEGIN) && after.includes(MANAGED_END) && after.includes('- insert:'), '')
  check('15.3e 修订冲突→false', !writeManagedState(patchPath, 'stale-revision', []), '')
  check('15.3f 删除全部→段清空', writeManagedState(patchPath, readManagedState(patchPath).revision, []), '')
  check('15.3g 清空后解析为空', parseManagedServers(readFileSync(patchPath, 'utf8')).length === 0, '')
  check('15.3h 清空后区外仍在', readFileSync(patchPath, 'utf8').includes('default: standard'), '')

  // 15.4 技能启停：SKILL.md 级重命名往返（C1 整改：目录改名对 frontmatter 注册无效）+ 非法名拒绝
  const skillsDir = join(tmpDir, 'skills')
  ensureSkillsDir(skillsDir)
  mkdirSync(join(skillsDir, 'log-analysis'))
  writeFileSync(join(skillsDir, 'log-analysis', 'SKILL.md'), '---\nname: log-analysis\ndescription: t\n---\nbody', 'utf8')
  check('15.4a 扫描列出', listSkills(skillsDir)[0]?.name === 'log-analysis' && listSkills(skillsDir)[0]?.enabled === true, JSON.stringify(listSkills(skillsDir)))
  check('15.4b 停用→SKILL.md 重命名', setSkillEnabled(skillsDir, 'log-analysis', false), '')
  check('15.4c 停用后状态', listSkills(skillsDir)[0]?.enabled === false && listSkills(skillsDir)[0]?.name === 'log-analysis', JSON.stringify(listSkills(skillsDir)))
  check('15.4d 启用→SKILL.md 重命名回', setSkillEnabled(skillsDir, 'log-analysis', true), '')
  check('15.4e 重复停用→false', setSkillEnabled(skillsDir, 'log-analysis', false) && !setSkillEnabled(skillsDir, 'log-analysis', false), '')
  check('15.4f 非法名→false', !setSkillEnabled(skillsDir, '../evil', true), '')

  // 15.5 revision 对 CRLF 稳定
  check('15.5 CRLF 归一化 revision 相等', computeRevision('a\r\nb') === computeRevision('a\nb'), '')
  rmSync(tmpDir, { recursive: true, force: true })
}
// [16] admin 页面 JS 语法（回归：模板字面量内 \' 求值成裸 ' 会让整个脚本块解析失败、页面永远空白）
const { ADMIN_HTML } = await import('./admin-html.ts')
try {
  const pageJs = ADMIN_HTML.split('<script>')[1].split('</script>')[0]
  new Function(pageJs)
  check('16.1 admin 页面脚本可解析', true, '')
} catch (e) {
  check('16.1 admin 页面脚本可解析', false, String(e).slice(0, 100))
}
check('16.2 页面含关键区块', ADMIN_HTML.includes('MCP 服务器') && ADMIN_HTML.includes('技能（新会话生效）') && ADMIN_HTML.includes('/admin/api/state'), '')

console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : `${failures} FAILED ❌`}`)
process.exit(failures === 0 ? 0 : 1)
