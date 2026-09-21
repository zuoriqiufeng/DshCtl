/**
 * retrieval.ts — Qdrant 向量检索 + BM25 混合（DSH 版，移植自 plugin/supplement.py + bm25.py）
 *
 * 链路：embed(→Python sidecar, 与 Hermes 同模型同向量) → Qdrant HTTP query/scroll
 *      → 精度保护(错误码精确项) → 全库 BM25(scroll 建索引) → RRF(k=60)
 * chunk_mode 五模式：mini_first(默认)/auto/parent_expand/standard_image/large_only
 * 降级：sidecar/Qdrant 不可用 → BM25-only 或空结果 + _warning（对齐 Hermes client/model None 行为）
 */

import { BM25Scorer, buildExactIndex, rrfFusion, type Bm25Doc, type FusionHit } from './bm25.ts'

export const RETRIEVAL = {
  qdrantUrl: process.env.I2STREAM_QDRANT_URL ?? 'http://127.0.0.1:6333',
  embedUrl: process.env.I2STREAM_EMBED_URL ?? 'http://127.0.0.1:8096/embed',
  collection: process.env.I2STREAM_QDRANT_COLLECTION ?? 'i2stream_collection',
  timeoutMs: 8000,
  scoreThreshold: 0.3, // config.yaml search.score_threshold
  fallbackScore: 0.1, // search.bm25_fallback_score
  precisionGuard: true, // search.bm25_precision_guard
  miniMultiplier: 2, // search.mini_first_top_k_multiplier
  parentExpandMultiplier: 5,
  dimension: 1024,
  scrollPageSize: 200,
}

const searchWarnings: string[] = []
const bm25Warnings: string[] = []
function recordSearchWarning(msg: string): void { if (!searchWarnings.includes(msg)) searchWarnings.push(msg) }
function recordBm25Warning(msg: string): void { if (!bm25Warnings.includes(msg)) bm25Warnings.push(msg) }
export function getSearchWarnings(): string[] { return [...searchWarnings] }
export function getBm25Warnings(): string[] { return [...bm25Warnings] }

// ── HTTP 基础 ──

async function httpJson(url: string, init: RequestInit, timeoutMs = RETRIEVAL.timeoutMs): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
  return res.json()
}

/** BGE embedding（sidecar）。失败抛错，由上层降级。 */
export async function embed(text: string): Promise<number[]> {
  const data = await httpJson(RETRIEVAL.embedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text] }),
  })
  return data?.data?.[0]?.embedding as number[]
}

interface QdrantPoint { id: string | number; score?: number; payload?: Record<string, any> }

async function queryPoints(collection: string, vector: number[], limit: number, filter?: unknown): Promise<QdrantPoint[]> {
  // Qdrant Query API：score_threshold 需 query 字段（plain vector 不支持）
  const body: Record<string, unknown> = { query: vector, limit, score_threshold: RETRIEVAL.scoreThreshold, with_payload: true }
  if (filter) body.filter = filter
  const data = await httpJson(`${RETRIEVAL.qdrantUrl}/collections/${collection}/points/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return data?.result?.points ?? []
}

async function scrollPoints(collection: string, opts: { limit?: number; offset?: unknown; withPayload?: unknown; filter?: unknown }): Promise<{ points: QdrantPoint[]; nextOffset: unknown }> {
  const body: Record<string, unknown> = {
    limit: opts.limit ?? RETRIEVAL.scrollPageSize,
    with_payload: opts.withPayload ?? true,
    with_vectors: false,
  }
  if (opts.offset !== undefined && opts.offset !== null) body.offset = opts.offset
  if (opts.filter) body.filter = opts.filter
  const data = await httpJson(`${RETRIEVAL.qdrantUrl}/collections/${collection}/points/scroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { points: data?.result?.points ?? [], nextOffset: data?.result?.next_page_offset ?? null }
}

/** 校验 collection 向量维度与 embedding 维度一致（默认集合强校验）。 */
export async function validateDimension(collection: string, strict: boolean): Promise<void> {
  try {
    const data = await httpJson(`${RETRIEVAL.qdrantUrl}/collections/${collection}`, { method: 'GET' })
    const size = data?.result?.config?.params?.vectors?.size
    if (size && Number(size) !== RETRIEVAL.dimension) {
      const msg = `collection '${collection}' 维度 ${size} 与 embedding.dimension=${RETRIEVAL.dimension} 不匹配`
      if (strict) throw new Error(msg)
      recordSearchWarning(`自定义 collection '${collection}' 维度校验已跳过`)
    }
  } catch (e) {
    if (strict) throw e
  }
}

// ── payload 过滤（1:1 supplement） ──

const IMAGE_PLACEHOLDERS = ['[嵌入图片:', '[圖片:', '[image:', '[Picture:']

export function payloadContent(payload: Record<string, any>): string {
  return String(payload?.content ?? payload?.blurb ?? payload?.text ?? '').slice(0, 600)
}

export function isValidContent(text: string): boolean {
  const t = text.trim()
  if (t.length < 20) return false
  return !IMAGE_PLACEHOLDERS.some((p) => t.includes(p))
}

const EXACT_TERM_PATTERNS = [/(?<![0-9])-[0-9]{4}(?![0-9])/g, /(?<![a-zA-Z0-9_])ORA-[0-9]{5}(?![a-zA-Z0-9_])/g]

export function extractExactTerms(query: string): string[] {
  const terms: string[] = []
  for (const pat of EXACT_TERM_PATTERNS) {
    pat.lastIndex = 0
    for (const m of query.match(pat) ?? []) terms.push(m)
  }
  return [...new Set(terms)]
}

function anyHitContainsTerm(hits: Hit[], terms: string[]): boolean {
  if (!terms.length) return false
  return hits.some((h) => terms.some((t) => (h.content ?? '').includes(t)))
}

// ── 命中结构 ──

export interface Hit extends FusionHit {
  content: string
  score: number
  source: string
  id: string
  chunk_id?: string | number | null
  chunk_level?: string | null
  section_type?: string
  image_file_id?: string | null
  large_chunk_id?: string | number | null
  title?: string
  blurb?: string
  mini_chunk_count?: number
  parent_chunk_id?: string | number | null
  parent_document_id?: string | null
  mini_chunk_index?: number | null
  hit_mini?: Array<{ index: number; text: string; offset: number | null }>
  _parent?: { large_chunk_id: unknown; title: string; doc_summary: string } | null
  _fallback_reason?: string
}

const PATTERN_FIELDS = ['pattern_id', 'log_fingerprint', 'component', 'severity', 'error_codes', 'db_types', 'source_note'] as const

function pointToHit(r: QdrantPoint): Hit {
  const payload = r.payload ?? {}
  return {
    content: payloadContent(payload),
    score: Math.round((r.score ?? 0) * 10000) / 10000,
    source: String(payload.document_id ?? ''),
    id: String(r.id),
    chunk_id: payload.chunk_id,
    chunk_level: payload.chunk_level,
    section_type: payload.section_type ?? 'text',
    image_file_id: payload.image_file_id,
    large_chunk_id: payload.large_chunk_id,
    title: String(payload.title ?? ''),
    parent_chunk_id: payload.parent_chunk_id,
    parent_document_id: payload.parent_document_id,
    mini_chunk_index: payload.mini_chunk_index,
    blurb: String(payload.blurb ?? ''),
  }
}

function withPatternFields(hit: Hit, payload: Record<string, any>): Hit {
  for (const f of PATTERN_FIELDS) if (payload[f] !== undefined && payload[f] !== null) (hit as any)[f] = payload[f]
  return hit
}

// ── BM25 per-collection 索引（懒加载 + scroll 构建） ──

interface Bm25Bundle { index: BM25Scorer; contentCache: Map<string, string>; exactIndex: Map<string, Set<string>> }
const bm25Indexes = new Map<string, Bm25Bundle | null>()
const bm25Ready = new Set<string>()

export function resetBm25(collection?: string): void {
  if (collection) { bm25Indexes.delete(collection); bm25Ready.delete(collection) }
  else { bm25Indexes.clear(); bm25Ready.clear() }
}

async function getBm25Index(collection: string): Promise<Bm25Bundle | null> {
  const name = collection || RETRIEVAL.collection
  if (bm25Ready.has(name)) return bm25Indexes.get(name) ?? null
  bm25Ready.add(name)
  try {
    const docs: Bm25Doc[] = []
    const contentCache = new Map<string, string>()
    let offset: unknown = null
    do {
      const page = await scrollPoints(name, { limit: RETRIEVAL.scrollPageSize, offset, withPayload: true })
      for (const p of page.points) {
        const id = String(p.id)
        const content = String(p.payload?.content ?? '').slice(0, 1000)
        docs.push({ id, content })
        contentCache.set(id, content)
      }
      offset = page.nextOffset
    } while (offset !== null && offset !== undefined && offset !== '')
    if (!docs.length) { recordBm25Warning(`collection '${name}' 空或未向量化，BM25 索引未构建`); bm25Indexes.set(name, null); return null }
    const index = new BM25Scorer()
    index.indexDocuments(docs)
    const bundle: Bm25Bundle = { index, contentCache, exactIndex: buildExactIndex(contentCache) }
    bm25Indexes.set(name, bundle)
    return bundle
  } catch (e) {
    recordBm25Warning(`BM25 索引构建失败: ${String(e).slice(0, 80)}`)
    bm25Indexes.set(name, null)
    return null
  }
}

export async function bm25Search(query: string, topK = 5, collection?: string): Promise<Array<{ id: string; bm25_score: number; content: string }>> {
  const bundle = await getBm25Index(collection ?? RETRIEVAL.collection)
  if (!bundle) return []
  return bundle.index.score(query).slice(0, topK).map(([id, score]) => ({
    id, bm25_score: score, content: bundle.contentCache.get(id) ?? '',
  }))
}

/** content_exact：精确项倒排直接取内容（precision guard 用）。 */
async function searchContentExact(terms: string[], topK: number, collection: string): Promise<Array<{ id: string; bm25_score: number; content: string }>> {
  const bundle = await getBm25Index(collection)
  if (!bundle) return []
  const seen = new Set<string>()
  const hits: Array<{ id: string; bm25_score: number; content: string }> = []
  for (const term of terms) {
    for (const id of bundle.exactIndex.get(term) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      hits.push({ id, bm25_score: 0, content: bundle.contentCache.get(id) ?? '' })
      if (hits.length >= topK) return hits
    }
  }
  return hits
}

// ── 精度保护（v3.7 1:1） ──

async function precisionGuardFallback(query: string, denseHits: Hit[], topK: number, collection: string): Promise<Hit[] | null> {
  if (!RETRIEVAL.precisionGuard) return null
  const bgeFailed = !denseHits.length || denseHits.every((h) => (h.score ?? 0) < RETRIEVAL.fallbackScore)
  const terms = extractExactTerms(query)
  let precisionFail = false
  if (!bgeFailed && denseHits.length && terms.length) {
    if (!anyHitContainsTerm(denseHits, terms)) precisionFail = true
  }
  if (!bgeFailed && !precisionFail) return null

  let fallbackHits: Array<{ id: string; bm25_score: number; content: string }> = []
  if (precisionFail && terms.length) {
    const exactHits = await searchContentExact(terms, topK, collection)
    const targeted = await bm25Search(terms.join(' '), topK, collection)
    const seen = new Set(exactHits.map((h) => h.id))
    fallbackHits = [...exactHits, ...targeted.filter((h) => !seen.has(h.id))].slice(0, topK)
  } else {
    fallbackHits = await bm25Search(query, topK, collection)
  }
  if (!fallbackHits.length) return []
  const out: Hit[] = []
  for (const h of fallbackHits) {
    if (!isValidContent(h.content)) continue
    out.push({
      content: h.content, score: Math.round(h.bm25_score * 10000) / 10000,
      source: ` [BM25_fallback]`, id: h.id, _fallback_reason: precisionFail ? 'precision' : 'low_score',
    })
  }
  return out
}

// ── chunk_level 过滤 ANN + RRF（1:1 _search_chunk_level） ──

export async function searchChunkLevel(
  query: string, topK: number, levels: string[], opts: { hybrid?: boolean; collection?: string } = {},
): Promise<Hit[]> {
  const hybrid = opts.hybrid ?? true
  const collection = opts.collection || RETRIEVAL.collection
  const denseHits: Hit[] = []
  try {
    const vector = await embed(query)
    const filter = { must: [{ key: 'chunk_level', match: { any: levels } }] }
    const points = await queryPoints(collection, vector, topK, filter)
    for (const r of points) {
      const hit = pointToHit(r)
      if (!isValidContent(hit.content)) continue
      denseHits.push(hit)
    }
  } catch (e) {
    // dense 降级：embedding/Qdrant 不可用 → 继续走 BM25/RRF（1:1 Hermes client/model None 精神）
    recordSearchWarning(`dense(chunk_level) 不可用: ${String(e).slice(0, 80)}`)
  }

  if (hybrid) {
    const pgHits = await precisionGuardFallback(query, denseHits, topK, collection)
    if (pgHits?.length) {
      const seen = new Set(denseHits.map((h) => h.id))
      let inserted = 0
      for (const h of pgHits) {
        if (seen.has(h.id)) continue
        h.source = `${h.source ?? ''} [PG]`
        denseHits.splice(inserted++, 0, h)
        seen.add(h.id)
      }
    }
  }

  if (hybrid) {
    const sparseHits = await bm25Search(query, topK * 2, collection)
    if (sparseHits.length) {
      const sparse: FusionHit[] = sparseHits.map((h) => ({ id: h.id, content: h.content, bm25_score: h.bm25_score }))
      const merged = rrfFusion(denseHits, sparse, topK)
      for (const h of merged) h.source = `${(h.source as string) ?? ''} [RRF]`
      return merged as Hit[]
    }
  }
  return denseHits.slice(0, topK)
}

// ── 全库搜索（auto 模式主体，1:1 search_qdrant 模块级） ──

export async function searchFull(query: string, topK = 5, hybrid = true): Promise<Hit[]> {
  const collection = RETRIEVAL.collection
  const denseHits: Hit[] = []
  try {
    await validateDimension(collection, true)
    const vector = await embed(query)
    const points = await queryPoints(collection, vector, topK)
    for (const r of points) {
      const hit = pointToHit(r)
      if (!isValidContent(hit.content)) continue
      denseHits.push(hit)
    }
  } catch (e) {
    recordSearchWarning(`dense 搜索不可用: ${String(e).slice(0, 80)}`)
  }

  if (!hybrid || (!denseHits.length && (await getBm25Index(collection)) === null)) {
    if (!hybrid) return denseHits.slice(0, topK)
  }

  // 精度保护
  const pgHits = await precisionGuardFallback(query, denseHits, topK, collection)
  if (pgHits?.length) {
    const seen = new Set(denseHits.map((h) => h.id))
    let inserted = 0
    for (const h of pgHits) {
      if (seen.has(h.id)) continue
      h.source = `${h.source ?? ''} [PG]`
      denseHits.splice(inserted++, 0, h)
      seen.add(h.id)
    }
  }

  if (hybrid) {
    // v3.3: 全部 dense score 低于阈值 → BM25-only
    if (denseHits.length && denseHits.every((h) => (h.score ?? 0) < RETRIEVAL.fallbackScore)) {
      const sparse = await bm25Search(query, topK * 2, collection)
      if (sparse.length) {
        return sparse.map((h) => ({
          content: h.content, score: Math.round(h.bm25_score * 10000) / 10000,
          source: ' [BM25_only]', id: h.id, _fallback_reason: 'low_score',
        })) as Hit[]
      }
    }
    // 精确项优先 BM25 → RRF
    const exactTerms = extractExactTerms(query)
    const sparseHits: Array<{ id: string; bm25_score: number; content: string }> = []
    const seen = new Set<string>()
    if (exactTerms.length) {
      for (const h of await bm25Search(exactTerms.join(' '), topK, collection)) { sparseHits.push(h); seen.add(h.id) }
    }
    for (const h of await bm25Search(query, topK * 2, collection)) {
      if (!seen.has(h.id)) { sparseHits.push(h); seen.add(h.id) }
    }
    if (sparseHits.length) {
      const merged = rrfFusion(denseHits, sparseHits, topK)
      for (const h of merged) h.source = `${(h.source as string) ?? ''} [RRF]`
      return merged as Hit[]
    }
  }
  return denseHits.slice(0, topK)
}

// ── mini_first 五阶段（1:1 _search_mini_first） ──

export async function searchMiniFirst(query: string, topK = 5, collection?: string): Promise<Hit[]> {
  let allHits: Hit[]
  try {
    allHits = await searchChunkLevel(query, topK * RETRIEVAL.miniMultiplier, ['mini'], { hybrid: true, collection })
  } catch {
    return []
  }
  const miniHits = allHits.filter((h) => h.chunk_level === 'mini')
  const otherHits = allHits.filter((h) => h.chunk_level !== 'mini')

  if (!miniHits.length) {
    return searchChunkLevel(query, topK, ['standard'], { hybrid: true, collection })
  }

  const standards = await resolveStandardBatch(miniHits, collection)
  const resultMap = new Map<string, Hit>()
  for (const mh of miniHits) {
    const key = `${mh.parent_document_id}::${mh.parent_chunk_id}`
    const sp = standards.get(key)
    if (!sp) continue
    const existing = resultMap.get(key)
    if (existing) {
      existing.hit_mini!.push(makeHitMini(mh, sp))
      continue
    }
    const spPayload = sp.payload ?? {}
    const hit: Hit = {
      content: String(spPayload.content ?? ''), score: mh.score ?? 0, source: String(spPayload.document_id ?? ''),
      id: String(sp.id), chunk_id: spPayload.chunk_id, chunk_level: 'standard',
      section_type: spPayload.section_type ?? 'text', large_chunk_id: spPayload.large_chunk_id,
      title: String(spPayload.title ?? ''), blurb: String(spPayload.blurb ?? ''),
      mini_chunk_count: spPayload.mini_chunk_count ?? 0,
      hit_mini: [makeHitMini(mh, sp)],
    }
    withPatternFields(hit, spPayload)
    resultMap.set(key, hit)
  }

  for (const oh of otherHits) {
    const key = `${oh.source}::${oh.chunk_id}`
    if (!resultMap.has(key)) resultMap.set(key, oh)
  }

  let results = [...resultMap.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  if (results.length < topK) {
    const existingIds = new Set(results.map((h) => `${h.source}::${h.chunk_id}`))
    const stdHits = await searchChunkLevel(query, topK - results.length, ['standard'], { hybrid: true, collection })
    for (const h of stdHits) {
      if (!existingIds.has(`${h.source}::${h.chunk_id}`)) results.push(h)
    }
  }
  return results.slice(0, topK)
}

async function resolveStandardBatch(miniHits: Hit[], collection?: string): Promise<Map<string, QdrantPoint>> {
  const target = collection || RETRIEVAL.collection
  const parentKeys = new Set<string>()
  for (const h of miniHits) {
    if (h.parent_chunk_id !== undefined && h.parent_chunk_id !== null && h.parent_document_id) {
      parentKeys.add(`${h.parent_document_id}::${h.parent_chunk_id}`)
    }
  }
  const result = new Map<string, QdrantPoint>()
  if (!parentKeys.size) return result
  const payloadFields = [
    'content', 'mini_chunk_texts', 'mini_chunk_offsets', 'mini_chunk_count', 'chunk_id', 'document_id',
    'title', 'large_chunk_id', 'section_type', 'blurb',
    ...PATTERN_FIELDS,
  ]
  // 【暂不改】循环单点 scroll，与 Hermes 一致（top_k=5 约 10 次往返）
  for (const key of parentKeys) {
    const [docId, chunkId] = key.split('::')
    const filter = {
      must: [
        { key: 'document_id', match: { value: docId } },
        { key: 'chunk_id', match: { value: isNaN(Number(chunkId)) ? chunkId : Number(chunkId) } },
        { key: 'chunk_level', match: { any: ['standard', 'log_pattern_standard'] } },
      ],
    }
    const page = await scrollPoints(target, { limit: 1, withPayload: payloadFields, filter })
    if (page.points.length) result.set(key, page.points[0]!)
  }
  return result
}

function makeHitMini(mh: Hit, sp: QdrantPoint): { index: number; text: string; offset: number | null } {
  const mi = mh.mini_chunk_index ?? 0
  const offsets = (sp.payload?.mini_chunk_offsets ?? []) as unknown[]
  const texts = (sp.payload?.mini_chunk_texts ?? []) as unknown[]
  return {
    index: mi,
    text: (Array.isArray(texts) && mi < texts.length ? texts[mi] : '') as string,
    offset: (Array.isArray(offsets) && mi < offsets.length ? offsets[mi] : null) as number | null,
  }
}

// ── parent_expand（1:1 _expand_parents：补父大块 title，不取 large content） ──

export async function expandParents(hits: Hit[], collection?: string): Promise<Hit[]> {
  const target = collection || RETRIEVAL.collection
  const lcIds = new Set(hits.filter((h) => h.large_chunk_id !== undefined && h.large_chunk_id !== null).map((h) => String(h.large_chunk_id)))
  if (!lcIds.size) return hits
  const parents = new Map<string, { title: string }>()
  const filter = {
    must: [
      { key: 'chunk_level', match: { value: 'large' } },
      { key: 'large_chunk_id', match: { any: [...lcIds] } },
    ],
  }
  const page = await scrollPoints(target, { limit: lcIds.size * RETRIEVAL.parentExpandMultiplier, withPayload: ['title', 'large_chunk_id'], filter })
  for (const p of page.points) {
    const pid = p.payload?.large_chunk_id
    if (pid !== undefined && pid !== null && !parents.has(String(pid))) parents.set(String(pid), { title: String(p.payload?.title ?? '') })
  }
  for (const h of hits) {
    const lcId = h.large_chunk_id
    h._parent = lcId !== undefined && lcId !== null
      ? { large_chunk_id: lcId, title: parents.get(String(lcId))?.title ?? '', doc_summary: '' }
      : null
  }
  return hits
}

// ── 维度覆盖追踪（1:1 supplement _DIM_STORE，task_id 分桶） ──

const dimStore = new Map<string, Map<string, { hits: number }>>()
const DEFAULT_DIM_KEY = '__default__'

export function trackDimension(dim: string, hitCount: number, taskId?: string): void {
  const bucket = dimStore.get(taskId ?? DEFAULT_DIM_KEY) ?? new Map()
  const cur = bucket.get(dim) ?? { hits: 0 }
  cur.hits += hitCount
  bucket.set(dim, cur)
  dimStore.set(taskId ?? DEFAULT_DIM_KEY, bucket)
}

export function resetDimensionCoverage(taskId?: string): void { dimStore.delete(taskId ?? DEFAULT_DIM_KEY) }

export function getDimensionCoverage(dimensions: string[], taskId?: string): Record<string, unknown> {
  const bucket = dimStore.get(taskId ?? DEFAULT_DIM_KEY) ?? new Map()
  const covered: Array<{ name: string; hits: number }> = []
  const uncovered: string[] = []
  for (const d of dimensions) {
    const entry = bucket.get(d)
    if (entry) covered.push({ name: d, hits: entry.hits })
    else uncovered.push(d)
  }
  return { covered, uncovered, coverage_ratio: dimensions.length ? Math.round((covered.length / dimensions.length) * 100) / 100 : 0 }
}

// ─────────── v2.0: 查询分解 + 聚合（移植自 supplement.py _decompose_queries / _aggregate_results）───────────
// Hermes 内部多路检索：按 Tool 类型把单一查询分解为多个维度子查询，各自检索后去重重排序聚合。
// DSH 版将其作为 search_qdrant 的 decompose 聚合模式（Agent 可选开启；默认仍单查询）。

/** decompose 配置默认值（1:1 py config SEARCH_DECOMPOSE_*） */
export const DECOMPOSE = {
  topK: 5,          // SEARCH_DECOMPOSE_TOP_K
  minQueries: 3,    // SEARCH_DECOMPOSE_MIN
  maxQueries: 8,    // SEARCH_DECOMPOSE_MAX
  dedupRatio: 0.85, // SEARCH_DECOMPOSE_DEDUP（0.85 = 前 425 字符去重）
}

/** 维度模板（1:1 py _DECOMPOSE_TEMPLATES）。每个 lambda (a, b) 生成一个维度查询。 */
const DECOMPOSE_TEMPLATES: Record<string, Array<[string, (a: string, b: string) => string]>> = {
  design_solution: [
    ['字符集/类型映射', (s, t) => `${s}到${t} 字符集转换 数据类型映射 字段长度 注意事项`],
    ['全量同步参数', () => '全量同步 大表拆分 导出线程 装载线程 表覆盖策略 单表拆分'],
    ['增量/日志解析', (s) => `${s} 增量同步 日志解析 CDC 配置要求`],
    ['断点续传/容错', () => '断点续传 checkpoint LSN 中断恢复 错误处理 冲突处理'],
    ['数据校验/对比', () => '数据校验 整库对比 表对比 一致性检查 差异修复'],
    ['源端特定配置', (s) => `${s} 数据库配置 编目 编码 环境要求 i2Stream部署`],
    ['目标端特定配置', (t) => `${t} 同步 配置 字符集 用户授权 环境要求`],
    ['跨地域/网络优化', () => '跨地域 异地同步 网络优化 压缩 带宽 延迟 批量提交'],
    ['风险/异常处理', (s, t) => `${s} ${t} 同步 风险 异常 常见错误 故障排查`],
  ],
  check_compatibility: [
    ['源端版本要求', (s) => `${s} 版本要求 兼容性 i2Stream支持`],
    ['目标端配置要求', (_s, t) => `${t} 配置要求 兼容性 前置条件`],
    ['数据类型映射', (s, t) => `${s}到${t} 数据类型 不兼容对象 限制`],
  ],
  diagnose_error: [
    ['错误原因', (ec) => `错误码${ec} 原因 异常 触发条件`],
    ['修复步骤', (ec) => `错误码${ec} 修复 处理 解决方案`],
    ['操作约束', (ec) => `错误码${ec} 操作约束 前置条件 注意事项`],
  ],
  explain_architecture: [
    ['原理机制', (topic) => `i2Stream ${topic} 原理 机制 架构`],
    ['配置调优', (topic) => `i2Stream ${topic} 配置 调优 参数 性能`],
    ['异常场景', (topic) => `i2Stream ${topic} 异常 故障 排查`],
  ],
  get_prerequisites: [
    ['环境要求', (op) => `${op} 环境要求 前置条件`],
    ['权限配置', (op) => `${op} 权限 授权 用户`],
    ['参数验证', (op) => `${op} 配置 参数 验证`],
  ],
  query_product: [
    ['产品定位', (a) => `i2Stream 产品定位 核心能力 ${a}`],
    ['行业覆盖', (a) => `i2Stream 行业 场景 ${a}`],
    ['信创适配', (a) => `i2Stream 信创 国产化适配 ${a}`],
  ],
  list_scenarios: [
    ['迁移场景', (kws) => `i2Stream 数据迁移 场景 ${kws}`],
    ['容灾场景', (kws) => `i2Stream 容灾 双活 高可用 ${kws}`],
    ['大数据场景', (kws) => `i2Stream 大数据 实时同步 流式 ${kws}`],
  ],
  resolve_relation: [
    ['实体关系', (src) => `i2Stream ${src} 关联 关系 配置`],
    ['关联约束', (src) => `i2Stream ${src} 约束 依赖 限制`],
  ],
}

/** 生成 decompose 查询（1:1 py _decompose_queries）。返回 [(维度名, 查询文本), ...]。 */
export function decomposeQueries(
  toolName: string,
  args: Record<string, unknown>,
  gaps: string[] = [],
  extractGapKeywords: (g: string[]) => string[] = () => [],
  buildQuery: (a: Record<string, unknown>, g?: string[]) => string = () => '',
): Array<[string, string]> {
  const templates = DECOMPOSE_TEMPLATES[toolName]
  const gapKws = gaps.length ? extractGapKeywords(gaps) : []
  if (!templates) {
    return [['通用查询', buildQuery(args, gaps)]]
  }

  const source = String(args.source ?? '')
  const target = String(args.target ?? '')
  const errorCode = String(args.error_code ?? '')
  const topic = String(args.topic ?? args.aspect ?? '')
  const operation = String(args.operation ?? '')
  const aspect = String(args.aspect ?? 'overview')
  const sourceEntity = String(args.source_entity ?? '')
  const kwRaw = args.keywords
  const keywordsStr = Array.isArray(kwRaw) ? kwRaw.join(' ') : String(kwRaw ?? '')

  const queries: Array<[string, string]> = []
  for (const [dimName, fn] of templates) {
    let query: string
    if (toolName === 'diagnose_error') query = fn(errorCode, '')
    else if (toolName === 'explain_architecture') query = fn(topic, '')
    else if (toolName === 'get_prerequisites') query = fn(operation, '')
    else if (toolName === 'query_product') query = fn(aspect, '')
    else if (toolName === 'list_scenarios') query = fn(keywordsStr.split(/\s+/).filter(Boolean).join(' ') || '通用', '')
    else if (toolName === 'resolve_relation') query = fn(sourceEntity, '')
    else query = fn(source, target)

    if (gapKws.length) query += ' ' + gapKws.slice(0, 3).join(' ')
    queries.push([dimName, query])
  }

  // 保证在 [min, max] 区间
  if (queries.length > DECOMPOSE.maxQueries) {
    return queries.slice(0, DECOMPOSE.maxQueries)
  }
  if (queries.length < DECOMPOSE.minQueries) {
    const generic = buildQuery(args, gaps)
    while (queries.length < DECOMPOSE.minQueries) {
      queries.push([`补充维度${queries.length}`, `${generic} 补充维度${queries.length}`])
    }
  }
  return queries
}

/** 简单 FNV-1a 字符串 hash（去重 key；去重场景无需真 md5，碰撞可接受） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * 聚合多路查询结果：去重 + 重排序（1:1 py _aggregate_results）。
 * @param allHitsByQuery - [(queryText, [hits]), ...]
 * @param maxTotal - 最大返回条数（默认 topK*2）
 */
export function aggregateResults(
  allHitsByQuery: Array<[string, Array<Record<string, unknown>>]>,
  maxTotal?: number,
): Array<Record<string, unknown>> {
  const limit = maxTotal ?? DECOMPOSE.topK * 2
  const dedupLen = Math.max(80, Math.floor(500 * DECOMPOSE.dedupRatio))

  const seen = new Map<string, Record<string, unknown>>()
  for (const [queryText, hits] of allHitsByQuery) {
    for (const h of hits) {
      const content = String(h.content ?? '')
      const key = fnv1a(content.slice(0, dedupLen))
      const existing = seen.get(key)
      if (existing) {
        // 保留更高分
        if (Number(h.score ?? 0) > Number(existing.score ?? 0)) {
          const copy = { ...h, _query: queryText.slice(0, 50) }
          seen.set(key, copy)
        }
        continue
      }
      seen.set(key, { ...h, _query: queryText.slice(0, 50) })
    }
  }

  const unique = [...seen.values()]
  unique.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
  return unique.slice(0, limit)
}
