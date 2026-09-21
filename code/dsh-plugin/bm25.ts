/**
 * bm25.ts — BM25 稀疏检索 + RRF 融合（DSH 版，移植自 plugin/bm25.py）
 *
 * 分词：中文字符 bigram + 单字、英文小写词（Hermes 的 jieba 缺失回退路径；
 * DSH 无 jieba，恒用此路径 —— 已知偏差：BM25 排序与 Hermes 可能轻微不同，
 * 错误码/精确项走 exact_index 不受影响）。
 */

export const RRF_K = 60

/** 中英混合分词（Hermes bm25.tokenize 回退路径 1:1）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const cn = text.match(/[一-鿿]+/g) ?? []
  for (const chunk of cn) {
    for (let i = 0; i < chunk.length; i++) {
      tokens.push(chunk[i]!)
      if (i + 1 < chunk.length) tokens.push(chunk.slice(i, i + 2))
    }
  }
  const english = text.replace(/[^a-zA-Z0-9_ \t\n\r\f\v]/g, ' ')
  for (const w of english.split(/\s+/)) {
    if (w.length > 1) tokens.push(w.toLowerCase())
  }
  return tokens
}

export interface Bm25Doc {
  id: string
  content: string
}

export class BM25Scorer {
  readonly k1 = 1.5
  readonly b = 0.75
  docCount = 0
  avgDocLen = 0
  docLengths: number[] = []
  docIds: string[] = []
  invertedIndex = new Map<string, Map<number, number>>()
  docTermFreq: Map<string, number>[] = []

  indexDocuments(documents: Bm25Doc[]): void {
    this.docCount = documents.length
    let totalLen = 0
    documents.forEach((doc, idx) => {
      this.docIds.push(doc.id)
      const tokens = tokenize(doc.content)
      this.docLengths.push(tokens.length)
      totalLen += tokens.length
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      this.docTermFreq.push(tf)
      for (const [term, freq] of tf) {
        let postings = this.invertedIndex.get(term)
        if (!postings) this.invertedIndex.set(term, postings = new Map())
        postings.set(idx, freq)
      }
    })
    this.avgDocLen = totalLen / Math.max(this.docCount, 1)
  }

  /** 查询评分，返回降序 [(docId, score)]。 */
  score(query: string): Array<[string, number]> {
    const queryTerms = tokenize(query)
    if (!queryTerms.length) return []
    const scores = new Map<number, number>()
    for (const term of new Set(queryTerms)) {
      const postings = this.invertedIndex.get(term)
      if (!postings) continue
      const idf = Math.log((this.docCount - postings.size + 0.5) / (postings.size + 0.5) + 1)
      for (const [docIdx, tf] of postings) {
        const docLen = this.docLengths[docIdx]!
        const numerator = tf * (this.k1 + 1)
        const denominator = tf + this.k1 * (1 - this.b + (this.b * docLen) / this.avgDocLen)
        scores.set(docIdx, (scores.get(docIdx) ?? 0) + (idf * numerator) / denominator)
      }
    }
    return [...scores.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([idx, score]) => [this.docIds[idx]!, score])
  }
}

export interface FusionHit {
  id?: string
  score?: number
  rrf_score?: number
  [k: string]: unknown
}

/** Reciprocal Rank Fusion（k=60，1:1 移植 bm25.rrf_fusion）。 */
export function rrfFusion(dense: FusionHit[], sparse: FusionHit[], topK = 5): FusionHit[] {
  const rrfScores = new Map<string, number>()
  const docMap = new Map<string, FusionHit>()
  dense.forEach((item, i) => {
    const id = item.id ?? ''
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    docMap.set(id, item)
  })
  sparse.forEach((item, i) => {
    const id = item.id ?? ''
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    if (!docMap.has(id)) docMap.set(id, item)
  })
  const merged = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK)
  return merged.map(([id, rrfScore]) => ({
    ...(docMap.get(id) as FusionHit),
    rrf_score: Math.round(rrfScore * 10000) / 10000,
  }))
}

/** 精确项倒排（错误码/含数字长 token），错误码等精确关键词快速定位。 */
export function buildExactIndex(contentCache: Map<string, string>): Map<string, Set<string>> {
  const exact = new Map<string, Set<string>>()
  const errorPat = /(?<![0-9])-[0-9]{4}(?![0-9])/g
  const oraPat = /(?<![a-zA-Z0-9_])ORA-[0-9]{5}(?![a-zA-Z0-9_])/g
  const tokenPat = /[a-zA-Z0-9_-]{4,}/g
  const add = (term: string, id: string): void => {
    let set = exact.get(term)
    if (!set) exact.set(term, set = new Set())
    set.add(id)
  }
  for (const [id, content] of contentCache) {
    if (!content) continue
    const terms = new Set<string>()
    for (const m of content.match(errorPat) ?? []) terms.add(m)
    for (const m of content.match(oraPat) ?? []) terms.add(m)
    for (const token of content.match(tokenPat) ?? []) {
      if (/\d/.test(token)) terms.add(token)
    }
    for (const term of terms) {
      add(term, id)
      if (/^-[0-9]+$/.test(term)) add(term.slice(1), id)
    }
  }
  return exact
}
