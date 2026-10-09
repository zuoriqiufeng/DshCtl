/**
 * embed.ts — 层 2c 的向量提供者（BGE sidecar；失败一律降级，不抛）
 *
 * 为什么第 2 层还要向量：BM25 靠词面重叠，同义改写（"同步卡住" vs "位点不推进"）只能靠
 * 别名表覆盖；向量补的正是这块。但向量是**可选增强**：
 *   · sidecar 不可达 / 超时 / 维度不符 → available:false，调用方退回 BM25-only
 *   · 原型向量只在首次调用时算一次并按意图集指纹缓存
 *
 * 实测（2026-10-08，bge-large-zh-v1.5 / CPU）：单条查询 ~85ms，但 23 条原型语料批量 ~5s
 * ——**批量绝不能放在热路径上**。因此：
 *   · 批量在插件启动后异步预热（warmup()，失败只 warn 一次）
 *   · 每次识别最多等 queryWaitMs（默认 400ms）；预热没赶上就这一轮走 BM25-only，
 *     下一轮自然用上（不阻塞、不报错、不影响回答）
 *   · 语料取「原型 + 标签」（不含关键词：关键词是给 BM25 加权用的，塞进句向量只会稀释语义）
 *
 * 只用全局 fetch（node 内建），所以本模块可直接被自测跑，不需要 DSH 上下文。
 */

import { cosine } from './bm25.ts'
import { embedCorpusOf, type IntentDef } from './taxonomy.ts'
import type { VectorProvider } from './engine.ts'

export interface EmbedProviderOptions {
  /** 查询侧 embed 地址。 */
  url: string
  /** 单条查询超时（ms）。 */
  timeoutMs: number
  /** 原型语料批量超时（ms）；只影响预热，不影响请求。 */
  prototypeTimeoutMs?: number
  /**
   * 每次识别等待预热完成的预算（ms）。默认 0 = 完全不等待：预热约 5s（23 条语料，
   * CPU bge-large），等它只会给请求平白加延迟；预热没赶上就本轮 BM25-only，下一轮自然用上。
   */
  queryWaitMs?: number
  warn?: (message: string) => void
  info?: (message: string) => void
}

type Prototypes = Array<{ id: string; vector: number[] }>
export type EmbedVectorProvider = VectorProvider & {
  /** 异步预热原型向量（幂等，不抛）。建议在插件 apply() 后 fire-and-forget 调用。 */
  warmup: () => void
}

interface SidecarResponse {
  data?: Array<{ embedding?: number[] }>
}

async function postEmbed(url: string, texts: readonly string[], timeoutMs: number): Promise<number[][] | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: [...texts] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const payload = (await res.json()) as SidecarResponse
    const vectors = (payload.data ?? []).map((row) => row.embedding)
    if (vectors.length !== texts.length) return null
    if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) return null
    return vectors as number[][]
  } catch {
    return null   // 超时/连接拒绝/JSON 错误 —— 全部按"不可用"处理
  }
}

/** 意图集指纹：语料变化时让原型向量缓存失效。 */
function fingerprint(intents: readonly IntentDef[]): string {
  return intents.map((intent) => `${intent.id}:${embedCorpusOf(intent).length}`).join('|')
}

/**
 * 构建向量提供者。
 * @param intents - 意图清单（原型向量按其语料生成）。
 * @param options - sidecar 地址、超时预算与日志回调。
 */
export function createEmbedProvider(intents: readonly IntentDef[], options: EmbedProviderOptions): EmbedVectorProvider {
  const corpora = intents.map((intent) => ({ id: intent.id, text: embedCorpusOf(intent) }))
  const stamp = fingerprint(intents)
  const prototypeTimeoutMs = options.prototypeTimeoutMs ?? 30_000
  const queryWaitMs = options.queryWaitMs ?? 0

  let prototypeVectors: Prototypes | null = null
  let embedding: Promise<Prototypes | null> | null = null
  let lastStamp = stamp
  let warnedUnavailable = false
  let warnedQuery = false

  const reset = (): void => {
    if (lastStamp === stamp) return
    prototypeVectors = null
    embedding = null
    lastStamp = stamp
    warnedUnavailable = false
    warnedQuery = false
  }

  const start = (): Promise<Prototypes | null> => {
    reset()
    embedding ??= (async () => {
      const vectors = await postEmbed(options.url, corpora.map((c) => c.text), prototypeTimeoutMs)
      if (!vectors) {
        if (!warnedUnavailable) {
          warnedUnavailable = true
          options.warn?.(`[intent-router] embed sidecar 不可达或超时（${options.url}），层 2c 退化为 BM25-only`)
        }
        return null
      }
      prototypeVectors = corpora.map((c, i) => ({ id: c.id, vector: vectors[i]! }))
      options.info?.(`[intent-router] 原型向量就绪（${prototypeVectors.length} 条）`)
      return prototypeVectors
    })()
    return embedding
  }

  const waitReady = async (budgetMs: number): Promise<Prototypes | null> => {
    if (prototypeVectors) return prototypeVectors
    const pending = start()
    // 预算 ≤0 = 完全不等待（热路径零成本）：预热没赶上就这一轮走 BM25-only，下一轮自然用上。
    if (budgetMs <= 0) return null
    const ready = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ])
    return ready ?? null
  }

  return {
    warmup(): void {
      void start()
    },
    async score(text) {
      const prototypes = await waitReady(queryWaitMs)
      if (!prototypes) {
        // 预热未完成或不可用：本轮不表态（不阻塞回答），下一轮自然用上
        if (!warnedQuery && prototypeVectors === null && embedding !== null && queryWaitMs > 0) {
          warnedQuery = true
          options.info?.(`[intent-router] 原型向量预热中（>${queryWaitMs}ms），本轮按 BM25-only 处理`)
        }
        return { scores: new Map(), available: false }
      }
      const [query] = (await postEmbed(options.url, [text], options.timeoutMs)) ?? []
      if (!query) return { scores: new Map(), available: false }
      const scores = new Map<string, number>()
      for (const { id, vector } of prototypes) scores.set(id, cosine(query, vector))
      return { scores, available: true }
    },
  }
}
