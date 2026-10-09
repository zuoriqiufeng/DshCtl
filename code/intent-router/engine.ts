/**
 * engine.ts — 分层调度：层 1 → 层 2 → 由调用方决定是否注入（纯模块 + 可注入的向量提供者）
 *
 * 刻意保持「零外部依赖」：向量那段由调用方以 VectorProvider 注入，失败必须返回
 * available:false 且不抛（降级铁律——意图识别是加速路径，绝不能让会话失败）。
 */

import { layer1, type Hit, type Tier } from './layer1.ts'
import { layer2, type AliasIndex, type GateConfig, type IntentScore } from './layer2.ts'
import { corpusOf, type IntentDef } from './taxonomy.ts'
import { BM25Scorer } from './bm25.ts'
import { normalizeText, stripSlashGesture } from './extract.ts'

export interface VectorProvider {
  /**
   * 给每个意图打余弦分。
   * @param text - 已归一化的用户文本。
   * @param intents - 意图清单（提供者自己缓存原型向量）。
   * @returns scores（intentId → cos）与 available（false = 不可用，调用方降级到 BM25-only）。
   */
  score(text: string, intents: readonly IntentDef[]): Promise<{ scores: Map<string, number>; available: boolean }>
}

export interface EngineDeps {
  intents: readonly IntentDef[]
  aliasIndex: AliasIndex
  gate: GateConfig
  /** 预先建好的 BM25 语料索引（生产路径由 apply() 建一次复用）；缺省则每次调用重建。 */
  scorer?: BM25Scorer
  vector?: VectorProvider
  errorToolTarget?: string
}

export interface Decision {
  accepted: boolean
  intent?: IntentDef
  hit?: Hit
  tier?: Tier
  /** 未采纳原因（no-decision / low-share / narrow-margin / low-cos / ...）。 */
  reason: string
  /** 端到端耗时（ms，含向量调用）。 */
  ms: number
  /** 排名（观测与评测用）。 */
  ranking: IntentScore[]
}

/** 用意图清单建 BM25 语料索引（含 keywords ×3 加权，见 taxonomy.corpusOf）。 */
export function buildScorer(intents: readonly IntentDef[]): BM25Scorer {
  const scorer = new BM25Scorer()
  scorer.indexDocuments(intents.map((intent) => ({ id: intent.id, content: corpusOf(intent) })))
  return scorer
}

/**
 * 对一句话做分层意图识别。
 * @param rawText - 原始用户文本（内部做归一化与 /手势剥离）。
 * @param deps - 意图清单、别名索引、门限、可选向量提供者。
 */
export async function classify(rawText: string, deps: EngineDeps): Promise<Decision> {
  const started = Date.now()
  const normalized = stripSlashGesture(normalizeText(rawText))
  const byId = new Map(deps.intents.map((intent) => [intent.id, intent]))

  const rule = layer1(normalized, deps.intents, deps.errorToolTarget ?? 'diagnose_error')
  if (rule) {
    const intent = byId.get(rule.intentId)
    return { accepted: true, ...(intent ? { intent } : {}), hit: rule, tier: rule.tier, reason: 'accepted', ms: Date.now() - started, ranking: [] }
  }

  const scorer = deps.scorer ?? buildScorer(deps.intents)
  const base = {
    normalized,
    intents: deps.intents,
    scorer,
    aliasIndex: deps.aliasIndex,
    gate: deps.gate,
  }

  // 第一段：只用本地 BM25/别名。多数输入在这一段就有定论 —— 此时**完全不碰向量**，
  // 热路径保持在 1ms 量级（实测 p95 ~1ms，含向量的补救分支 ~100ms）。
  let outcome = layer2(base)
  if (outcome.hit === undefined && deps.vector && outcome.reason !== 'no-overlap') {
    // 第二段（补救）：BM25 判不出时才看向量；no-overlap（BM25 零重叠）直接跳过——
    // 那种输入 BM25 前 K 名为空，跨方法互证不可能成立，调向量纯属浪费。
    let vectorScores: Map<string, number> | undefined
    let vectorAvailable: boolean | undefined
    try {
      const result = await deps.vector.score(normalized, deps.intents)
      if (result.available && result.scores.size > 0) {
        vectorScores = result.scores
        vectorAvailable = true
      } else {
        vectorAvailable = false
      }
    } catch {
      vectorAvailable = false   // 降级：不抛
    }
    if (vectorScores) {
      outcome = layer2({ ...base, vectorScores, ...(vectorAvailable === undefined ? {} : { vectorAvailable }) })
    }
  }

  if (!outcome.hit) {
    return { accepted: false, reason: outcome.reason, ms: Date.now() - started, ranking: outcome.ranking }
  }
  const intent = byId.get(outcome.hit.intentId)
  if (!intent) {
    return { accepted: false, reason: 'unknown-intent', ms: Date.now() - started, ranking: outcome.ranking }
  }
  return {
    accepted: true,
    intent,
    hit: outcome.hit,
    tier: outcome.hit.tier,
    reason: 'accepted',
    ms: Date.now() - started,
    ranking: outcome.ranking,
  }
}
