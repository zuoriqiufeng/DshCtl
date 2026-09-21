/**
 * contextLoader.ts — Trim + Toon 上下文优化管道（DSH 版）
 *
 * 移植自 plugin/context_loader.py：在 Tool 结果写入 LLM 上下文前进行
 *   Trim: 过滤评分/UUID/空值等低价值字段
 *   Toon: JSON → 紧凑优化格式 (Token-Optimized Notation)
 * 压缩效果: Token -30~60%, 准确率 +14pp (MSFAgentBench)
 *
 * DSH 接入点：tools.ts 中每个 defineTool 的 `output.render(args, value)`
 * 调用 `contextLoader.process(value, toolName)`，让模型看到优化文本，
 * 而 execute 返回的规范 JSON 值保持完整（供结果记录/卡片使用）。
 */

/** 字段级相关性裁剪器 */
export class TrimFilter {
  static SCORING_PATTERNS = [
    /_score$/i, /match_score$/i, /rerank_score$/i,
    /intent_score$/i, /similarity$/i,
  ]
  static TECHNICAL_PATTERNS = [
    /.*_uuid$/i, /md5$/i, /document_id$/i, /element_id$/i,
    /state_time$/i, /start_time$/i,
  ]
  static REDUNDANT_FIELDS = new Set([
    'display_name', 'data_source', 'module_type',
    'samples', 'metadata',
  ])

  constructor(private readonly keep = new Set<string>()) {}

  private shouldSkip(key: string, value: unknown): boolean {
    if (this.keep.has(key)) return false
    if (value === null || value === undefined || value === '' ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)) {
      return true
    }
    if (TrimFilter.SCORING_PATTERNS.some((p) => p.test(key))) return true
    if (TrimFilter.TECHNICAL_PATTERNS.some((p) => p.test(key))) return true
    if (TrimFilter.REDUNDANT_FIELDS.has(key)) return true
    return false
  }

  trim<T>(data: T): T {
    if (Array.isArray(data)) {
      return data.map((item) => this.trim(item)) as unknown as T
    }
    if (data && typeof data === 'object') {
      const result: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (this.shouldSkip(k, v)) continue
        result[k] = this.trim(v)
      }
      return result as unknown as T
    }
    return data
  }
}

/** Token-Optimized Notation 格式化器 */
export class ToonFormatter {
  static INDENT = '  '

  /** 不截断的关键字段：知识内容容器完整保留 */
  static FULL_CONTENT_KEYS = new Set([
    'content', 'fallback_hint', 'enrichment',
    '_instruction', 'quality', 'raw', 'diagnosis', 'description',
    '_fallback_reason', '_warning', '_model_hint',
    'knowledge', 'prerequisite_knowledge', 'dimensions', 'snippets',
    'summary', 'top_references', 'detail', 'check_method',
    'recommended_steps', 'what_you_need', 'constraints', 'common_errors',
    'related_skills', 'knowledge_snippets', 'missing_info', 'must_know',
  ])

  format(data: unknown, key = 'root', indent = 0): string {
    if (Array.isArray(data)) return this.fmtArray(data, key, indent)
    if (data && typeof data === 'object') return this.fmtDict(data as Record<string, unknown>, key, indent)
    return this.fmtScalar(data)
  }

  private fmtArray(arr: unknown[], key: string, indent: number): string {
    const pad = ' '.repeat(indent)
    if (!arr.length) return `${pad}${key}[0]: `
    if (arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      return this.fmtObjectArray(arr as Record<string, unknown>[], key, indent)
    }
    const values = arr.map((v) => this.fmtScalar(v)).join(', ')
    return `${pad}${key}[${arr.length}]: ${values}`
  }

  private fmtObjectArray(arr: Record<string, unknown>[], key: string, indent: number): string {
    const pad = ' '.repeat(indent)
    const fields = ToonFormatter.commonFields(arr)
    const lines = [`${pad}${key}[${arr.length}]{${fields.join(',')}}:`]
    for (const item of arr) {
      const row = fields.map((f) => String(item[f] ?? '')).join(',')
      lines.push(`${pad}${ToonFormatter.INDENT}${row}`)
    }
    return lines.join('\n')
  }

  private fmtDict(obj: Record<string, unknown>, key: string, indent: number): string {
    const pad = ' '.repeat(indent)
    const entries = Object.entries(obj)
    const nScalars = entries.filter(([, v]) => !(v && typeof v === 'object')).length
    // 紧凑格式仅在「全部为标量且 1..5 键」时启用（含嵌套值走紧凑分支会静默丢失，P0-3）
    if (nScalars === entries.length && entries.length > 0 && entries.length <= 5) {
      const pairs = entries.map(([k, v]) => `${k}:${this.fmtScalar(v, k)}`)
      return `${pad}${key}: {${pairs.join(', ')}}`
    }
    const lines = [`${pad}${key}:`]
    for (const [k, v] of entries) {
      if (v && typeof v === 'object') {
        lines.push(this.format(v, k, indent + 1))
      } else {
        lines.push(`${pad}${ToonFormatter.INDENT}${k}: ${this.fmtScalar(v, k)}`)
      }
    }
    return lines.join('\n')
  }

  private fmtScalar(value: unknown, key = ''): string {
    if (typeof value === 'boolean') return value ? '✓' : '✗'
    if (typeof value === 'string') {
      if (value.length > 80) {
        if (ToonFormatter.FULL_CONTENT_KEYS.has(key)) return value
        return `${value.slice(0, 80)}...`
      }
      return value
    }
    return String(value)
  }

  /** 出现率 >= threshold 的公共字段（对象数组行对齐用） */
  static commonFields(arr: Record<string, unknown>[], threshold = 0.5): string[] {
    const counts = new Map<string, number>()
    for (const item of arr) {
      for (const k of Object.keys(item)) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const total = arr.length
    return [...counts.entries()]
      .filter(([, c]) => c >= total * threshold)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
  }
}

export type LoaderMode = 'full' | 'trim_only' | 'toon_only' | 'raw'

/** Trim + Toon 管道（按工具策略） */
export class ContextLoader {
  static STRATEGIES: Record<string, LoaderMode> = {
    design_solution: 'trim_only',
    check_compatibility: 'full',
    query_product: 'toon_only',
    list_scenarios: 'full',
    get_prerequisites: 'full',
    explain_architecture: 'toon_only',
    diagnose_error: 'raw',
    resolve_relation: 'full',
    resolve_operation: 'full',
  }

  constructor(
    private readonly trimFilter = new TrimFilter(),
    private readonly toon = new ToonFormatter(),
    /** 输出总量预算（字符）；0 = 无限制 */
    private readonly outputMaxChars = 0,
  ) {}

  /** 按优先级把 data 截断到 budget 字符内。白名单内容字段最后被动。 */
  private enforceBudget(data: unknown, budget: number): { data: unknown; truncated: boolean } {
    const size = (d: unknown): number => JSON.stringify(d).length
    if (size(data) <= budget) return { data, truncated: false }

    const clone = structuredClone(data)
    const fullKeys = ToonFormatter.FULL_CONTENT_KEYS

    // 第 1 轮: 非白名单长字符串截断到 200 字符（递归）
    const clipLongStrings = (obj: unknown): void => {
      if (Array.isArray(obj)) {
        for (const item of obj) clipLongStrings(item)
      } else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 200 && !fullKeys.has(k)) {
            ;(obj as Record<string, unknown>)[k] = `${v.slice(0, 200)}...`
          } else if (v && typeof v === 'object') {
            clipLongStrings(v)
          }
        }
      }
    }
    clipLongStrings(clone)
    if (size(clone) <= budget) return { data: clone, truncated: true }

    // 第 2 轮: 删除非白名单顶层 key（按 key 排序逐个删）
    if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
      const obj = clone as Record<string, unknown>
      for (const k of Object.keys(obj).sort()) {
        if (fullKeys.has(k) || k.startsWith('_')) continue
        delete obj[k]
        if (size(obj) <= budget) return { data: obj, truncated: true }
      }
    }

    // 第 3 轮: 白名单长字符串保留头部截断
    if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
      const obj = clone as Record<string, unknown>
      for (const k of Object.keys(obj).sort()) {
        const v = obj[k]
        if (typeof v === 'string' && v.length > 500) {
          const keep = Math.max(500, Math.floor(budget / Math.max(Object.keys(obj).length, 1)))
          obj[k] = `${v.slice(0, keep)}\n...[截断，原文 ${v.length} 字符]`
          if (size(obj) <= budget) return { data: obj, truncated: true }
        }
      }
    }
    return { data: clone, truncated: true }
  }

  /**
   * 处理查询结果，返回优化后的模型可见文本。
   * @param toolName 工具名 → 查 STRATEGIES 决定模式
   * @param mode 显式模式覆盖（raw=原样 JSON 缩进；full=trim+toon；trim_only；toon_only）
   */
  process(data: unknown, toolName?: string, mode: LoaderMode = 'full'): string {
    if (toolName && toolName in ContextLoader.STRATEGIES) {
      mode = ContextLoader.STRATEGIES[toolName]
    }
    if (mode === 'raw') return JSON.stringify(data, null, 2)

    let payload = data
    if (this.outputMaxChars > 0) {
      const { data: clipped, truncated } = this.enforceBudget(data, this.outputMaxChars)
      payload = clipped
      if (truncated && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        ;(payload as Record<string, unknown>)['_budget_note'] =
          `输出超预算 ${this.outputMaxChars} 字符，已按优先级截断`
      }
    }

    let trimmed: unknown = payload
    if (mode === 'full' || mode === 'trim_only') trimmed = this.trimFilter.trim(payload)
    if (mode === 'full' || mode === 'toon_only') return this.toon.format(trimmed)
    return JSON.stringify(trimmed, null, 2)
  }
}
