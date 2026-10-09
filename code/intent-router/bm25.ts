/**
 * bm25.ts — 打分原语适配层（纯模块）
 *
 * 复用 dsh-plugin 的稀疏检索实现（`code/dsh-plugin/bm25.ts`，零依赖纯函数：
 * 中英混合分词 = 中文单字+bigram、英文小写词；标准 BM25 k1=1.5/b=0.75；RRF k=60）。
 * 这里只做「单点转出」，不复制实现——避免两份分词器随版本漂移；
 * 若将来 intent-router 需要脱离 dsh-plugin 独立分发，只需替换本文件为内置副本。
 *
 * 另附 `cosine`（本插件新增，纯函数）：层 2c 的原型向量相似度。
 */

export { BM25Scorer, RRF_K, rrfFusion, tokenize, type Bm25Doc, type FusionHit } from '../dsh-plugin/bm25.ts'

/**
 * 余弦相似度。任一向量为零向量或维度不一致时返回 0（不抛）。
 * @param a - 向量 A。
 * @param b - 向量 B。
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
