/**
 * layer2.ts — 第 2 层：算法识别（纯模块）
 *
 * 链路（先便宜后贵，任一步不达门限就放弃介入）：
 *   2a 别名归一   现场口语 → 规范 ID → 意图（长别名强证据 / 短别名只投票）
 *   2b BM25 原型  复用 dsh-plugin 分词器与 BM25（CJK 单字+bigram，纯本地）
 *   2c 向量相似   由调用方注入（P2 接 embed sidecar；不可达则整段缺席，走 BM25-only）
 *   2d RRF 融合 + 置信门（分数 + 间隔）——**门限是本层的质量闸门**
 *
 * 门限的意义：意图相近时（diagnose_error vs diagnose_db_link）强行选一个比不选更糟。
 * 因此采纳条件是「最高分过线」且「与第二名拉开距离」，否则返回未采纳 + 原因供观测。
 */

import { BM25Scorer, rrfFusion } from './bm25.ts'
import type { IntentDef } from './taxonomy.ts'
import type { Hit } from './layer1.ts'

export interface AliasVote {
  intentId: string
  alias: string
  /** 强证据（别名长度 ≥ STRONG_ALIAS_LENGTH）：可单独采纳；弱证据只参与投票。 */
  strong: boolean
}

/** 强别名阈值：≥4 字的口语别名（"同步卡住"/"数据对不上"）才算确定性证据。 */
export const STRONG_ALIAS_LENGTH = 4

export interface AliasTables {
  /** 口语别名 → 规范 ID（来自 dsh-plugin/constants.ts 的 SYMPTOM_ALIASES 等）。 */
  [table: string]: Record<string, string>
}

export interface AliasIndex {
  /** 别名（原样，扫描时大小写不敏感）→ 意图 id 与是否强证据。 */
  entries: Array<{ alias: string; intentId: string; strong: boolean }>
}

/**
 * 构建别名索引：规范 ID → 声明了该 ID 的意图。
 * 一个规范 ID 被多个意图声明时不入索引（歧义别名只会制造误判）。
 * @param intents - 意图清单。
 * @param tables - `{ symptom, error }` 两张别名表（键=口语，值=规范 ID）。
 */
export function buildAliasIndex(intents: readonly IntentDef[], tables: AliasTables): AliasIndex {
  const bySymptom = new Map<string, string[]>()
  const byError = new Map<string, string[]>()
  for (const intent of intents) {
    for (const id of intent.symptoms) bySymptom.set(id, [...(bySymptom.get(id) ?? []), intent.id])
    for (const id of intent.errors) byError.set(id, [...(byError.get(id) ?? []), intent.id])
  }
  const entries: AliasIndex['entries'] = []
  const add = (alias: string, owners: string[] | undefined): void => {
    if (!owners || owners.length !== 1) return
    const key = alias.trim()
    if (key === '') return
    entries.push({ alias: key, intentId: owners[0]!, strong: [...key].length >= STRONG_ALIAS_LENGTH })
  }
  for (const [alias, id] of Object.entries(tables.symptom ?? {})) add(alias, bySymptom.get(id))
  for (const [alias, id] of Object.entries(tables.error ?? {})) add(alias, byError.get(id))
  // 长别名优先，避免短别名抢先命中
  entries.sort((a, b) => [...b.alias].length - [...a.alias].length)
  return { entries }
}

/** 在文本里扫描别名（大小写不敏感，长别名优先，同一意图只记最长的一条）。 */
export function collectAliasVotes(normalized: string, index: AliasIndex): AliasVote[] {
  if (normalized === '') return []
  const haystack = normalized.toLowerCase()
  const best = new Map<string, AliasVote>()
  for (const entry of index.entries) {
    if (!haystack.includes(entry.alias.toLowerCase())) continue
    const current = best.get(entry.intentId)
    if (!current || [...entry.alias].length > [...current.alias].length) {
      best.set(entry.intentId, { intentId: entry.intentId, alias: entry.alias, strong: entry.strong })
    }
  }
  return [...best.values()]
}

export interface GateConfig {
  /**
   * BM25-only 路径的绝对分下限（top1 原始 BM25 分）。
   * 为什么不用「份额」：23 条意图共享大量通用词时份额天然只有 0.2~0.3，
   * 实测 0.35 的份额门限会大面积误杀正确结果（见 P3 标定记录）。
   */
  minBm25Score: number
  /**
   * top1 相对第二名的领先比例 `(top1-top2)/top1`。
   * 实测：正确命中 0.44~0.76、歧义输入 0.01~0.28，是比份额好得多的判别量。
   */
  minBm25RelMargin: number
  /** 向量路径的余弦门限。 */
  minCos: number
  /** 向量路径 top1 与 top2 的余弦间隔下限。 */
  minCosMargin: number
  /**
   * 跨方法互证：向量冠军必须同时落在 BM25 的前 K 名内。
   * 两条完全独立的信号都指向同一意图，才允许注入——实测这是拦住
   * 「看下日志 → search_qdrant（cos 0.669）」这类短泛化输入的最有效手段。
   */
  vectorCorroborateTopK: number
}

/**
 * 默认门限：标定于 2026-10-08 的 24 条标注样本（code/intent-router/eval/questions.json）。
 * 采纳组最低 top1=17.6 / rel=0.395（"Oracle 到 MySQL 支持吗"，正卡在间隔上），
 * 放弃组要么绝对分不足（最高 10.4 的"能不能便宜点"，模态词命中）、要么间隔不足
 * （最高 rel=0.28 的"帮我看看这个需求能不能实现"）——两个门限是互补的，缺一即误判。
 * 取 16 / 0.35 可在该样本集上完全分离。样本仍小，P3 用更大标注集与线上观测复核后再调。
 */
export const DEFAULT_GATE: GateConfig = {
  minBm25Score: 16,
  minBm25RelMargin: 0.35,
  minCos: 0.62,
  minCosMargin: 0.06,
  vectorCorroborateTopK: 2,
}

export interface IntentScore {
  intentId: string
  bm25: number
  cos?: number
  rrf: number
}

export interface Layer2Outcome {
  hit?: Hit
  ranking: IntentScore[]
  /** 未采纳原因：no-candidates / no-overlap / low-share / narrow-margin / low-cos / narrow-cos-margin / accepted */
  reason: string
  votes: AliasVote[]
}

export interface Layer2Input {
  normalized: string
  intents: readonly IntentDef[]
  scorer: BM25Scorer
  aliasIndex: AliasIndex
  gate?: GateConfig
  /** 2c 向量余弦分（P2 注入）；缺席即 BM25-only。 */
  vectorScores?: ReadonlyMap<string, number>
  /** vectorScores 是否可信（embed 调用失败时为 false，仅用于日志）。 */
  vectorAvailable?: boolean
}

/**
 * 跑第 2 层并做门限判定。
 * @param input - 文本、意图清单、已建好的 BM25 语料索引、别名索引、门限、可选向量分。
 */
export function layer2(input: Layer2Input): Layer2Outcome {
  const gate = input.gate ?? DEFAULT_GATE
  const { normalized, intents, scorer, aliasIndex } = input
  const votes = collectAliasVotes(normalized, aliasIndex)
  if (normalized === '' || intents.length === 0) {
    return { ranking: [], reason: 'no-candidates', votes }
  }

  const bm25 = new Map(scorer.score(normalized))
  const bm25Ranked = [...bm25.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([intentId, score]) => ({ intentId, score }))

  const vectorRanked = input.vectorScores === undefined
    ? []
    : [...input.vectorScores.entries()]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([intentId, score]) => ({ intentId, score }))

  // 2d RRF：向量为 dense 路、BM25 为 sparse 路（缺哪路就少一路，不影响另一路的排序）
  const fused = rrfFusion(
    vectorRanked.map(({ intentId, score }) => ({ id: intentId, score })),
    bm25Ranked.map(({ intentId, score }) => ({ id: intentId, score })),
    Math.max(intents.length, 1),
  )
  const ranking: IntentScore[] = fused.map((row) => ({
    intentId: String(row.id ?? ''),
    bm25: bm25.get(String(row.id ?? '')) ?? 0,
    ...(input.vectorScores?.has(String(row.id ?? '')) ? { cos: input.vectorScores.get(String(row.id ?? ''))! } : {}),
    rrf: Number(row.rrf_score ?? 0),
  }))

  if (ranking.length === 0) return { ranking, reason: 'no-overlap', votes }

  const strongVote = votes.find((v) => v.strong)
  const top = ranking[0]!
  const second = ranking[1]

  // 强别名（≥4 字口语，如「同步卡住」）单独成证据：语义明确，直接采纳。
  if (strongVote) {
    return {
      hit: { intentId: strongVote.intentId, tier: 'alias', slots: {}, matched: strongVote.alias, rule: `alias:${strongVote.alias}` },
      ranking,
      reason: 'accepted',
      votes,
    }
  }

  // ── 顺序判定：便宜且准确的一路先定论，向量只做「补救」而不是「接管」──
  //
  // 为什么不是「两路投票、谁高谁赢」：实测（2026-10-08，24 条标注集）向量接管后采纳率
  // 从 12/13 掉到 8/13——BM25 有把握的样本会被向量不足 0.62 的余弦误杀；反过来向量
  // 也没救回 BM25 判不出的样本。两路是互补关系而非替代关系：
  //   BM25 定论 → 直接采纳（btree 排序，微秒级，不欠向量调用）；
  //   BM25 无定论 → 再看向量（百余毫秒），要求余弦过线 + 间隔够 + BM25 前 K 名互证。
  // 这样热路径在多数情况下仍是 <1ms，且不会因为向量而丢掉本来能识别的意图。

  // ① BM25 定论：绝对分下限 + 相对间隔（用 BM25 自身 top1/top2，与门限语义自洽）。
  const bm25Top = bm25Ranked[0]
  if (bm25Top) {
    const relMargin = (bm25Top.score - (bm25Ranked[1]?.score ?? 0)) / bm25Top.score
    if (bm25Top.score >= gate.minBm25Score && relMargin >= gate.minBm25RelMargin) {
      const weakVote = votes.find((v) => v.intentId === bm25Top.intentId)
      return {
        hit: {
          intentId: bm25Top.intentId,
          tier: weakVote ? 'alias' : 'algo',
          slots: {},
          matched: weakVote?.alias ?? normalized.slice(0, 80),
          rule: weakVote ? `alias:${weakVote.alias}` : 'bm25',
        },
        ranking,
        reason: 'accepted',
        votes,
      }
    }
  }

  // ② 向量补救：只处理 BM25 判不出的情况。
  const vectorTop = vectorRanked[0]
  if (vectorTop && input.vectorAvailable !== false) {
    const cosTop = vectorTop.score
    const cosSecond = vectorRanked[1]?.score ?? 0
    if (cosTop < gate.minCos) return { ranking, reason: 'low-cos', votes }
    if (cosTop - cosSecond < gate.minCosMargin) return { ranking, reason: 'narrow-cos-margin', votes }
    const corroborated = bm25Ranked.slice(0, Math.max(gate.vectorCorroborateTopK, 1)).some((row) => row.intentId === vectorTop.intentId)
    if (!corroborated) return { ranking, reason: 'vector-uncorroborated', votes }
    return {
      hit: { intentId: vectorTop.intentId, tier: 'vector', slots: {}, matched: normalized.slice(0, 80), rule: 'vector' },
      ranking,
      reason: 'accepted',
      votes,
    }
  }

  // ③ 都判不出：说明本轮不表态，交回主模型（按当前原因归类，供观测统计）。
  if (!bm25Top) return { ranking, reason: 'no-overlap', votes }
  if (bm25Top.score < gate.minBm25Score) return { ranking, reason: 'low-score', votes }
  return { ranking, reason: 'narrow-margin', votes }
}
