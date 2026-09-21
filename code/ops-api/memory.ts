/**
 * memory.ts — TencentDB MemoryCore Gateway 薄客户端（G3，gap-exec-plan P2）
 *
 * 对标 Hermes 侧 hermes-plugin/memory/memory_tencentdb/{__init__.py, client.py, supervisor.py}：
 * 四层记忆（L0-L3）全在独立 Gateway（默认 127.0.0.1:8420），本模块只是 HTTP 客户端 +
 * 可靠性层。数据零迁移：与 Hermes 共享同一 Gateway 与数据目录（~/.memory-tencentdb/）。
 *
 * Gateway API（server.ts 路由）：
 *   GET  /health                — 存活（无需鉴权）
 *   POST /recall   {query, session_key}
 *        → {context, strategy, memory_count, code, message, retryable}
 *        code!=0 时 context 可能为空（EmbeddingService 不可用/VDB 超时等）
 *   POST /capture  {user_content, assistant_content, session_key, session_id?}
 *        → {l0_recorded, scheduler_notified}   （fire-and-forget 语义）
 *   POST /search/memories        {query, limit?, type?} → {results, total, strategy}
 *   POST /search/conversations   {query, limit?}        → {results, total, ...}
 *   POST /session/end  {session_key}             — flush 管道
 *   鉴权：Authorization: Bearer ${TDAI_GATEWAY_API_KEY}（除 /health）
 *
 * 可靠性（1:1 移植 Hermes provider 数值）：
 *   熔断：连续 5 次失败（网络错/5xx/超时）→ open 60s；open 期间 recall 立即返 ''、
 *         capture 丢弃并 warn；冷却后放一个探测请求（半开）
 *   背压：capture 在途 ≤ 4；第 5 个起进入等待，直到最旧完成（上限 5s）才发出
 *   超时：recall 2s / capture 5s / search 5s / sessionEnd 3s（AbortSignal）
 *   降级铁律：recall 失败 ≠ 请求失败（H-15）——所有方法失败路径返回空值，绝不抛错
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface MemoryGatewayConfig {
  /** Gateway 基址，如 http://127.0.0.1:8420 */
  url: string
  /** TDAI_GATEWAY_API_KEY（空 = 不带鉴权头；Gateway 未配置 key 时全路由开放） */
  apiKey?: string
  /** 各调用超时（毫秒） */
  timeouts?: { recall?: number; capture?: number; search?: number; sessionEnd?: number }
  /** 熔断配置 */
  breaker?: { threshold?: number; cooldownMs?: number }
  /** capture 背压配置（maxInFlight=在途上限；队列满 64 丢弃新请求） */
  capture?: { maxInFlight?: number }
}

export interface RecallResult {
  /** Gateway 渲染好的 <memory-context> 文本；失败/无命中为 '' */
  context: string
  strategy: string
  memoryCount: number
}

export interface OpsMemoryService {
  recall(sessionKey: string, query: string): Promise<RecallResult>
  capture(req: { sessionKey: string; sessionId?: string; userContent: string; assistantContent: string }): void
  sessionEnd(sessionKey: string): Promise<void>
  searchMemories(query: string, opts?: { limit?: number; type?: string }): Promise<string>
  searchConversations(query: string, opts?: { limit?: number }): Promise<string>
  readScene(sceneId: string): Promise<string>
  health(): Promise<{ ok: boolean; detail?: string }>
  /** 熔断状态快照（自测/诊断用） */
  breakerState(): { open: boolean; consecutiveFailures: number }
}

export interface MemoryLogger {
  warn(msg: string): void
  info(msg: string): void
}

// per-request memory key 传递（工具 handler 无 per-request 上下文，用 ALS 桥接）
export interface MemoryAlsScope { memoryKey: string }
export const memoryAls = new AsyncLocalStorage<MemoryAlsScope>()

const DEFAULTS = {
  timeouts: { recall: 2000, capture: 5000, search: 5000, sessionEnd: 3000 },
  breaker: { threshold: 5, cooldownMs: 60_000 },
  capture: { maxInFlight: 4, waitMs: 5000 },
}

export function createOpsMemory(cfg: MemoryGatewayConfig, log: MemoryLogger): OpsMemoryService {
  const url = cfg.url.replace(/\/+$/, '')
  const timeouts = { ...DEFAULTS.timeouts, ...cfg.timeouts }
  const breakerCfg = { ...DEFAULTS.breaker, ...cfg.breaker }
  const captureCfg = { ...DEFAULTS.capture, ...cfg.capture }

  // ── 熔断器 ──
  // 状态：CLOSED(openUntil=0) / OPEN(now < openUntil) / HALF-OPEN(cooldown 过后放一个探测)
  let consecutiveFailures = 0
  let openUntil = 0 // epoch ms；0 = 关闭
  let probing = false

  const breakerOpen = (): boolean => openUntil !== 0 && Date.now() < openUntil
  const recordFailure = (): void => {
    consecutiveFailures++
    if (consecutiveFailures >= breakerCfg.threshold) {
      openUntil = Date.now() + breakerCfg.cooldownMs
      probing = false
      log.warn(`[ops-memory] circuit breaker OPEN after ${consecutiveFailures} consecutive failures; pause ${breakerCfg.cooldownMs / 1000}s`)
    }
  }
  const recordSuccess = (): void => {
    if (openUntil !== 0) log.info('[ops-memory] circuit breaker probe succeeded; closed')
    consecutiveFailures = 0
    openUntil = 0
    probing = false
  }
  /** 熔断前置检查；true = 本次跳过。冷却期内全跳；冷却过后放行一个探测（其余等探测结果） */
  const shouldSkip = (): boolean => {
    if (openUntil === 0) return false // CLOSED
    if (breakerOpen()) return true // OPEN 窗口内：全部跳过
    // 冷却已过：HALF-OPEN，仅放行首个探测
    if (probing) return true
    probing = true
    return false
  }

  const post = async <T>(path: string, body: unknown, timeoutMs: number): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, data: await res.json() as T }
    } catch (e) {
      return { ok: false, error: (e as Error)?.name === 'AbortError' ? 'timeout' : String(e).slice(0, 120) }
    } finally {
      clearTimeout(timer)
    }
  }

  // ── recall（同步，失败绝不抛错）──
  const recall = async (sessionKey: string, query: string): Promise<RecallResult> => {
    const empty: RecallResult = { context: '', strategy: 'none', memoryCount: 0 }
    if (!sessionKey || !query) return empty
    if (shouldSkip()) return empty
    interface RecallResp { context?: string; strategy?: string; memory_count?: number; code?: number; message?: string }
    const r = await post<RecallResp>('/recall', { query, session_key: sessionKey }, timeouts.recall)
    if (!r.ok) {
      recordFailure()
      log.warn(`[ops-memory] recall failed: ${r.error} (degraded to empty context)`)
      return empty
    }
    recordSuccess()
    // H-15：code!=0 表示 recall 路径失败（但 HTTP 200）——同样降级为空，不影响主请求
    if (r.data.code) {
      log.warn(`[ops-memory] recall degraded code=${r.data.code}: ${r.data.message ?? ''}`)
      return empty
    }
    return {
      context: r.data.context ?? '',
      strategy: r.data.strategy ?? 'unknown',
      memoryCount: r.data.memory_count ?? 0,
    }
  }

  // ── capture 背压队列（fire-and-forget；在途 ≤ maxInFlight，超出进队列等完成）──
  const inFlight = new Set<Promise<void>>()
  const captureQueue: Array<{ sessionKey: string; sessionId?: string; userContent: string; assistantContent: string }> = []
  const CAPTURE_QUEUE_MAX = 64

  const capture = (req: { sessionKey: string; sessionId?: string; userContent: string; assistantContent: string }): void => {
    if (!req.sessionKey || !req.userContent) return
    if (shouldSkip()) {
      log.warn('[ops-memory] capture skipped (breaker open)')
      return
    }
    if (inFlight.size >= captureCfg.maxInFlight) {
      if (captureQueue.length >= CAPTURE_QUEUE_MAX) {
        log.warn('[ops-memory] capture queue full; dropped')
        return
      }
      captureQueue.push(req)
      return
    }
    void doCapture(req)
  }

  const doCapture = async (req: { sessionKey: string; sessionId?: string; userContent: string; assistantContent: string }): Promise<void> => {
    const p = (async () => {
      interface CaptureResp { l0_recorded?: number; scheduler_notified?: boolean }
      const r = await post<CaptureResp>('/capture', {
        user_content: req.userContent,
        assistant_content: req.assistantContent,
        session_key: req.sessionKey,
        ...(req.sessionId ? { session_id: req.sessionId } : {}),
      }, timeouts.capture)
      if (!r.ok) {
        recordFailure()
        log.warn(`[ops-memory] capture failed: ${r.error}`)
      } else {
        recordSuccess()
      }
    })().finally(() => {
      inFlight.delete(p)
      const next = captureQueue.shift()
      if (next) void doCapture(next)
    })
    inFlight.add(p)
  }

  // ── sessionEnd（flush 管道）──
  const sessionEnd = async (sessionKey: string): Promise<void> => {
    if (!sessionKey) return
    if (breakerOpen()) return
    const r = await post<unknown>('/session/end', { session_key: sessionKey }, timeouts.sessionEnd)
    if (!r.ok) log.warn(`[ops-memory] session/end failed: ${r.error}`)
    else recordSuccess()
  }

  // ── 搜索（工具底层；失败返回 '' 由调用方组提示语）──
  const searchGeneric = async (path: string, body: Record<string, unknown>): Promise<{ ok: boolean; results: string; total: number }> => {
    if (shouldSkip()) return { ok: false, results: '', total: 0 }
    interface SearchResp { results?: string; total?: number }
    const r = await post<SearchResp>(path, body, timeouts.search)
    if (!r.ok) {
      recordFailure()
      log.warn(`[ops-memory] ${path} failed: ${r.error}`)
      return { ok: false, results: '', total: 0 }
    }
    recordSuccess()
    return { ok: true, results: r.data.results ?? '', total: r.data.total ?? 0 }
  }

  const searchMemories = async (query: string, opts?: { limit?: number; type?: string }): Promise<string> => {
    const r = await searchGeneric('/search/memories', { query, limit: opts?.limit ?? 5, ...(opts?.type ? { type: opts.type } : {}) })
    return r.results
  }
  const searchConversations = async (query: string, opts?: { limit?: number }): Promise<string> => {
    const r = await searchGeneric('/search/conversations', { query, limit: opts?.limit ?? 5 })
    return r.results
  }
  const readScene = async (sceneId: string): Promise<string> => {
    const r = await searchGeneric('/search/scenes', { scene_id: sceneId })
    return r.results
  }

  // ── health（GET，无鉴权要求）──
  const health = async (): Promise<{ ok: boolean; detail?: string }> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 1500)
    try {
      const res = await fetch(`${url}/health`, { signal: ctl.signal })
      return { ok: res.ok }
    } catch (e) {
      return { ok: false, detail: (e as Error)?.name === 'AbortError' ? 'timeout' : String(e).slice(0, 80) }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    recall,
    capture,
    sessionEnd,
    searchMemories,
    searchConversations,
    readScene,
    health,
    breakerState: () => ({ open: breakerOpen(), consecutiveFailures }),
  }
}
