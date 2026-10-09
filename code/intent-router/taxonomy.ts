/**
 * taxonomy.ts — 意图体系的数据模型、合并与校验（纯模块：只用 node 内建 + 相对导入）
 *
 * 数据来源分两层（单一来源，互不重叠）：
 *   ① `taxonomy.generated.json` —— 生成物（scripts/gen-intent-taxonomy.ts 重跑再生，禁止手改）
 *   ② `overrides.ts`            —— 人工增量（补原型/关键词/正则、禁用条目；带注释与类型）
 *
 * 本模块不做任何 I/O 之外的事：合并 → 校验 → 产出可打分的语料与查找表。
 * 坏条目一律 warn 后跳过（降级铁律：意图识别是加速路径，绝不能让它拖垮会话）。
 */

/** 一条精确匹配规则：`re:` 前缀为正则，否则按小写全等/包含的字面量处理。 */
export interface ExactRule {
  pattern: string
  /** 命中后写入 slots 的字段名（如 error_code / operation）。 */
  slot?: string
}

export type IntentKind = 'tool' | 'skill' | 'none'

export interface IntentDef {
  id: string
  kind: IntentKind
  /** kind=tool → 工具名；kind=skill → 技能名；kind=none → 缺省。 */
  target?: string
  /** 人类可读标签（注入文案用）。 */
  label: string
  /** 该意图相关的 skill（注入文案里的「建议加载」提示）。 */
  skills: string[]
  /** 关联的规范症状 ID（`symptom:` 后的裸 ID）。 */
  symptoms: string[]
  /** 关联的规范错误码。 */
  errors: string[]
  /** 送入 BM25 / 向量打分的原型语料（越接近真实问法越有效）。 */
  prototypes: string[]
  /** 关键词（会以重复计数的方式加权进 BM25 语料）。 */
  keywords: string[]
  exact: ExactRule[]
  /** 是否允许把该意图注入提示（kind=none 恒为 false）。 */
  injectable: boolean
}

export interface Taxonomy {
  schema: number
  /** 生成时间与数据源指纹（可读，用于判断是否需要重跑生成器）。 */
  generatedAt: string
  sources: string[]
  intents: IntentDef[]
}

/** 人工增量：与生成物合并，键为意图 id。 */
export interface TaxonomyOverrides {
  /** 禁用某些生成的意图（例如跨域复用时不适用的条目）。 */
  disable?: string[]
  appendPrototypes?: Record<string, string[]>
  appendKeywords?: Record<string, string[]>
  appendExact?: Record<string, ExactRule[]>
  /** 整体覆盖某条意图的标签。 */
  labels?: Record<string, string>
}

const KINDS: readonly IntentKind[] = ['tool', 'skill', 'none']

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
}

function asExactRules(value: unknown): ExactRule[] {
  if (!Array.isArray(value)) return []
  const rules: ExactRule[] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      if (raw.trim()) rules.push({ pattern: raw.trim() })
      continue
    }
    if (raw && typeof raw === 'object') {
      const rec = raw as Record<string, unknown>
      const pattern = typeof rec.pattern === 'string' ? rec.pattern.trim() : ''
      if (!pattern) continue
      const slot = typeof rec.slot === 'string' && rec.slot.trim() ? rec.slot.trim() : undefined
      rules.push(slot ? { pattern, slot } : { pattern })
    }
  }
  return rules
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * 校验并规范化单条意图；缺 id/label/kind 或 kind 与 target 不匹配时返回 undefined（调用方 warn 后跳过）。
 * @param raw - 生成物或人工覆盖里的原始对象。
 * @param knownSkills - 已知技能名集合（校验 skills 引用；缺省不校验）。
 */
export function normalizeIntent(raw: unknown, knownSkills?: ReadonlySet<string>): IntentDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const id = typeof rec.id === 'string' ? rec.id.trim() : ''
  if (!id) return undefined
  const kindRaw = typeof rec.kind === 'string' ? rec.kind.trim() : ''
  const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as IntentKind) : undefined
  if (!kind) return undefined
  const target = typeof rec.target === 'string' && rec.target.trim() ? rec.target.trim() : undefined
  if (kind !== 'none' && !target) return undefined
  const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : id
  const skills = asStringArray(rec.skills).filter((s) => knownSkills === undefined || knownSkills.has(s))
  const injectable = kind === 'none' ? false : rec.injectable === undefined ? true : rec.injectable === true
  return {
    id,
    kind,
    ...(target === undefined ? {} : { target }),
    label,
    skills,
    symptoms: asStringArray(rec.symptoms),
    errors: asStringArray(rec.errors),
    prototypes: asStringArray(rec.prototypes),
    keywords: asStringArray(rec.keywords),
    exact: asExactRules(rec.exact),
    injectable,
  }
}

export interface MergeReport {
  intents: IntentDef[]
  skipped: Array<{ id: string; reason: string }>
}

/**
 * 合并生成物与人工增量，产出最终意图清单。
 * @param generated - `taxonomy.generated.json` 解析结果。
 * @param overrides - 人工增量。
 * @param knownSkills - 已知技能名集合（可选）。
 * @returns 规范化意图清单 + 被跳过的条目（供日志）。
 */
export function mergeTaxonomy(
  generated: unknown,
  overrides: TaxonomyOverrides | undefined,
  knownSkills?: ReadonlySet<string>,
): MergeReport {
  const skipped: Array<{ id: string; reason: string }> = []
  const rawList = (generated && typeof generated === 'object' && Array.isArray((generated as { intents?: unknown }).intents))
    ? (generated as { intents: unknown[] }).intents
    : []
  const disabled = new Set(asStringArray(overrides?.disable))
  const out: IntentDef[] = []
  const seen = new Set<string>()
  for (const raw of rawList) {
    const id = raw && typeof raw === 'object' ? String((raw as { id?: unknown }).id ?? '') : ''
    if (disabled.has(id)) {
      skipped.push({ id, reason: 'disabled by overrides' })
      continue
    }
    const intent = normalizeIntent(raw, knownSkills)
    if (!intent) {
      skipped.push({ id: id || '(missing id)', reason: 'invalid definition' })
      continue
    }
    if (seen.has(intent.id)) {
      skipped.push({ id: intent.id, reason: 'duplicate id' })
      continue
    }
    seen.add(intent.id)
    out.push(intent)
  }
  const merged = out.map((intent) => {
    const extraProtos = asStringArray(overrides?.appendPrototypes?.[intent.id])
    const extraKeywords = asStringArray(overrides?.appendKeywords?.[intent.id])
    const extraExact = asExactRules(overrides?.appendExact?.[intent.id])
    const label = overrides?.labels?.[intent.id]
    return {
      ...intent,
      ...(label ? { label } : {}),
      prototypes: dedupe([...intent.prototypes, ...extraProtos]),
      keywords: dedupe([...intent.keywords, ...extraKeywords]),
      exact: [...intent.exact, ...extraExact],
    }
  })
  return { intents: merged, skipped }
}

/** 单个意图的 BM25 语料：原型 ×1 + 关键词 ×3（加权）+ 标签。 */
export function corpusOf(intent: IntentDef): string {
  const parts = [...intent.prototypes, intent.label]
  for (const kw of intent.keywords) parts.push(kw, kw, kw)
  return parts.join(' ')
}

/**
 * 单个意图的向量语料：原型 + 标签，**不含关键词**。
 * 关键词是给 BM25 加权用的（×3 重复）；塞进句向量只会稀释语义、拉长文本（实测编码耗时翻倍）。
 * @param intent - 意图定义。
 */
export function embedCorpusOf(intent: IntentDef): string {
  return [...intent.prototypes, intent.label].join(' ')
}

/** 语料条数下限：BM25 的 IDF 需要 ≥2 篇文档才有意义。 */
export const CORPUS_MIN_INTENTS = 2
