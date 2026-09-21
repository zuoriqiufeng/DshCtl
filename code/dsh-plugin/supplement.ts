/**
 * supplement.ts — 工具结果质量闭环（DSH 版，移植自 plugin/supplement.py 尾段 + tools._wrap）
 *
 * Hermes 行为：每个工具返回都经 _wrap 包装：
 *   assess_confidence（full/partial/none + gaps）→ log_gap（JSONL+轮转）
 *   → fallback_to_qdrant（defer 模式返回 _instruction 维度菜单 + _skill_recommendation，
 *     由 Agent 自主决定 search_qdrant 补查哪些维度）
 * 常量与 config.yaml 默认值 1:1：min_content_length=50, min_risk_count=5,
 * defer_to_hermes=true, decompose_min=3/max=8, gap_log 512KB 轮转 3 备份。
 */

import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

export const SUPPLEMENT = {
  minContentLength: 50,
  minRiskCount: 5,
  deferToHermes: true,
  decomposeMin: 3,
  decomposeMax: 8,
  gapLogPath: process.env.I2STREAM_GAP_LOG ?? '/hdd/demo/public/i2stream-bkn/logs/gap_log.jsonl',
  gapMaxBytes: 512 * 1024,
  gapBackups: 3,
}

/** REQUIRED_FIELDS（supplement.py 1:1）。 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  design_solution: ['scenario', 'description', 'compatibility'],
  check_compatibility: ['supported', 'version_notes', 'object_compat', 'charset_notes'],
  explain_architecture: ['raw'],
  query_product: ['raw'],
  diagnose_error: ['error_code', 'diagnosis'],
  get_prerequisites: ['operation', 'prerequisites'],
  list_scenarios: ['scenarios'],
  resolve_relation: ['source', 'targets'],
  resolve_operation: ['operation', 'capability'],
}

type Json = Record<string, unknown>

// ─────────── assess_confidence（1:1） ───────────

export function assessConfidence(result: Json, args: Json, toolName?: string): { confidence: 'full' | 'partial' | 'none'; gaps: string[] } {
  const gaps: string[] = []
  if (!result || !Object.keys(result).length) return { confidence: 'none', gaps: ['BKN 未找到相关数据'] }
  const hasContent = Object.values(result).some((v) => v && v !== {} && !(Array.isArray(v) && !v.length) && v !== '')
  if (!hasContent) return { confidence: 'partial', gaps: ['返回数据为空'] }

  const rawText = JSON.stringify(result)
  if (rawText.length < SUPPLEMENT.minContentLength) {
    gaps.push(`返回内容过短(${rawText.length}字符 < ${SUPPLEMENT.minContentLength}), 可能不充分`)
  }
  if (toolName && REQUIRED_FIELDS[toolName]) {
    for (const field of REQUIRED_FIELDS[toolName]!) {
      const val = result[field]
      if (val === undefined || val === null || val === '' || val === [] || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val as object).length)) {
        gaps.push(`缺少关键字段: ${field}`)
      } else if (typeof val === 'string' && val.length < 10) {
        gaps.push(`关键字段 ${field} 内容过短(${val.length}字符): '${val.slice(0, 30)}...'`)
      }
    }
  }
  gaps.push(...deepCheck(result, toolName))
  if (gaps.length) return { confidence: 'partial', gaps }
  return { confidence: 'full', gaps: [] }
}

function deepCheck(result: Json, toolName?: string): string[] {
  const gaps: string[] = []
  if (toolName === 'design_solution') {
    const rels = result.relations as Record<string, unknown> | undefined
    if (rels && typeof rels === 'object') {
      if (!Object.keys(rels).length) {
        gaps.push('relations 为空, 缺少拓扑/约束/前置/风险信息')
      } else {
        const allRelText = JSON.stringify(rels).toLowerCase()
        for (const keyword of ['requires', 'constrains', 'prerequisite', 'risks_of']) {
          if (!allRelText.includes(keyword)) gaps.push(`relations 中缺少 ${keyword} 信息`)
        }
        const riskCount = countRisks(rels)
        if (riskCount < SUPPLEMENT.minRiskCount) {
          gaps.push(`风险条目过少(仅${riskCount}条 < ${SUPPLEMENT.minRiskCount}), 建议查 Qdrant 补充数据库特定/跨地域/版本兼容等风险`)
        }
      }
      const compat = result.compatibility as Json | undefined
      if (compat && typeof compat === 'object') {
        const hasNotes = !!(compat.version_notes || compat.object_compat || compat.charset_notes || compat.risks)
        if (compat.supported && !hasNotes) gaps.push('兼容性确认但缺少版本/限制说明')
      }
    } else {
      gaps.push('relations 格式异常, 非字典类型')
    }
  } else if (toolName === 'diagnose_error') {
    const diag = result.diagnosis
    if (typeof diag === 'string') {
      if (diag.length < 20) gaps.push(`诊断信息过短(${diag.length}字符), 可能缺少修复步骤`)
      if (!diag.includes('排查步骤') && !diag.includes('修复')) gaps.push('诊断信息缺少排查步骤/修复方案, 建议查 Qdrant 补充')
    }
  }
  // 通用策略：未经过 Qdrant enrichment 时统一建议补查（defer 模式的触发源）
  if (!result.enrichment && !result.fallback_hint) {
    gaps.push('BKN 仅提供基础骨架，建议查 Qdrant 补充详细参数/案例/版本信息')
  }
  return gaps
}

function countRisks(rels: Record<string, unknown>): number {
  let count = 0
  for (const [, relations] of Object.entries(rels)) {
    if (relations && typeof relations === 'object') {
      const risks = (relations as Json).risks_of
      if (Array.isArray(risks)) count += risks.length
      else if (typeof risks === 'string' && risks.trim()) count++
    }
  }
  return count
}

// ─────────── log_gap（JSONL + 大小轮转，1:1 log_rotate.rotate_if_needed） ───────────

export function rotateIfNeeded(path: string, maxBytes: number, backups: number): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false
    const oldest = `${path}.${backups}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = backups - 1; i >= 1; i--) {
      const src = `${path}.${i}`
      if (existsSync(src)) renameSync(src, `${path}.${i + 1}`)
    }
    renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}

export function logGap(tool: string, params: Json, confidence: string, gaps: string[]): void {
  const entry = {
    tool, params, confidence, gaps,
    timestamp: Math.floor(Date.now() / 1000),
    user_supplied: null,
    resolved: false,
  }
  try {
    rotateIfNeeded(SUPPLEMENT.gapLogPath, SUPPLEMENT.gapMaxBytes, SUPPLEMENT.gapBackups)
    appendFileSync(SUPPLEMENT.gapLogPath, JSON.stringify(entry) + '\n')
  } catch {
    // 静默，不影响主流程
  }
}

// ─────────── gap 关键词 + 查询构建（1:1） ───────────

const GAP_KEYWORD_MAP: Record<string, string> = {
  风险: '风险 故障 异常 处理 约束',
  跨地域: '跨地域 异地 远程 网络 延迟 带宽',
  版本兼容: '版本 兼容性 限制 要求 不支持',
  数据库特定: '数据库 同步 配置 源端 目标端 兼容性',
  限制说明: '限制 约束 注意事项 不支持',
  排查步骤: '排查 步骤 修复 处理 解决方案',
  修复方案: '修复 处理 解决方案 操作',
  前置条件: '前置条件 准备工作 环境要求',
  内容过短: '配置 参数 步骤 操作 注意事项',
  内容可能不完整: '配置 参数 步骤 注意事项 兼容性',
  建议查Qdrant: '配置 参数 操作 步骤 注意事项',
}

export function extractGapKeywords(gaps: string[]): string[] {
  const keywords = new Set<string>()
  for (const gap of gaps) {
    for (const [topic, keywordStr] of Object.entries(GAP_KEYWORD_MAP)) {
      if (gap.includes(topic)) for (const kw of keywordStr.split(' ')) keywords.add(kw)
    }
  }
  return [...keywords].sort()
}

export function buildQuery(args: Json, gaps?: string[]): string {
  const parts: string[] = []
  const priorityKeys = ['source', 'target', 'error_code', 'operation', 'topic']
  for (const k of priorityKeys) {
    const v = args[k]
    if (v && typeof v === 'string') parts.push(v)
  }
  for (const [k, v] of Object.entries(args)) {
    if (!priorityKeys.includes(k) && v && typeof v === 'string') parts.push(v)
  }
  if (gaps?.length) {
    const gapKeywords = extractGapKeywords(gaps)
    if (gapKeywords.length) parts.push(gapKeywords.join(' '))
  }
  return parts.join(' ')
}

// ─────────── 维度提示词注册表（_build_dimension_hints 1:1） ───────────

export function buildDimensionHints(toolName: string, args: Json): Record<string, string> {
  const source = String(args.source ?? args.db_type ?? '').trim()
  const target = String(args.target ?? '').trim()
  const symptom = String(args.symptom ?? '').trim()

  let hints: Record<string, string> = {
    '字符集/类型映射': `${source} 字符集转换 数据类型映射 字段长度 NLS_LANG 精度丢失`,
    '全量同步参数': '全量同步 大表拆分 导出线程 装载线程 表覆盖策略 单表拆分 并发',
    '增量/日志解析': `${source} 增量同步 日志解析 CDC redo log 归档 archive log supplemental 错误处理策略 插入冲突 更新未找到 装载错误`,
    '断点续传/容错': '断点续传 checkpoint 中断恢复 错误处理 冲突处理 主键冲突 位点异常 dumpredo',
    '数据校验/对比': '数据校验 整库对比 表对比 一致性检查 差异修复 SCN sequence',
    '源端特定配置': `${source} 数据库配置 权限 授权 环境要求 前置条件 supplemental log force logging 归档模式`,
    '目标端特定配置': `${target} 数据库配置 编目 编码 用户授权 表空间 环境要求`,
    '跨地域/网络优化': '跨地域 异地同步 网络优化 LZ4 ZSTD 压缩 批量提交 带宽 延迟',
    '风险/异常处理': '同步 风险 异常 常见错误 故障排查 ORA- -4002 -4073 -4006',
    '规则配置/装载策略': '同步规则 错误处理策略 更新未找到记录 删除未找到记录 插入冲突 装载错误 过滤条件 维护模式 DDL过滤 字段映射 DML追踪 全量对象过滤',
  }
  if (symptom && (toolName === 'diagnose_db_link' || toolName === 'diagnose_error')) {
    hints = Object.fromEntries(Object.entries(hints).map(([k, v]) => [k, v.includes(symptom) ? v : `${symptom} ${v}`]))
  }
  return hints
}

/** 症状 → 维度优先级（supplement._SYMPTOM_DIMENSION_PRIORITY 1:1）。 */
export const SYMPTOM_DIMENSION_PRIORITY: Record<string, Record<string, 'critical' | 'suggested' | 'optional'>> = {
  data_mismatch: {
    '增量/日志解析': 'critical', '规则配置/装载策略': 'critical', '数据校验/对比': 'critical', '源端特定配置': 'critical',
    '风险/异常处理': 'suggested', '字符集/类型映射': 'suggested', '全量同步参数': 'suggested',
    '断点续传/容错': 'optional', '目标端特定配置': 'suggested', '跨地域/网络优化': 'suggested',
  },
  incremental_stuck: {
    '增量/日志解析': 'critical', '断点续传/容错': 'critical', '源端特定配置': 'critical',
    '风险/异常处理': 'suggested', '跨地域/网络优化': 'suggested', '规则配置/装载策略': 'suggested',
    '数据校验/对比': 'optional', '字符集/类型映射': 'optional', '全量同步参数': 'suggested', '目标端特定配置': 'optional',
  },
  connection_error: {
    '跨地域/网络优化': 'critical', '源端特定配置': 'critical', '目标端特定配置': 'critical', '风险/异常处理': 'suggested',
  },
  performance_degradation: {
    '增量/日志解析': 'critical', '全量同步参数': 'critical', '跨地域/网络优化': 'critical',
    '源端特定配置': 'suggested', '目标端特定配置': 'suggested',
  },
  crash_loop: {
    '风险/异常处理': 'critical', '断点续传/容错': 'critical', '源端特定配置': 'suggested', '增量/日志解析': 'suggested',
  },
}

export function getDimensionPriority(symptom: string, dimName: string): 'critical' | 'suggested' | 'optional' {
  const priMap = SYMPTOM_DIMENSION_PRIORITY[symptom] ?? {}
  return priMap[dimName] ?? 'suggested'
}

// ─────────── _extract_skill_from_result（1:1） ───────────

export function extractSkillFromResult(result: Json): string | null {
  const kv = result.kv as Record<string, string> | undefined
  if (kv && typeof kv === 'object') {
    for (const [key, val] of Object.entries(kv)) {
      if (key.includes('Skill') || key.toLowerCase().includes('skill')) {
        const m = /"?([a-zA-Z0-9_-]+)"?/.exec(String(val))
        if (m) return m[1]!
      }
    }
  }
  const raw = String(result.raw ?? result.diagnosis ?? '')
  if (raw) {
    const m = /负责[ \t]*Skill[：:][ \t]*"?([a-zA-Z0-9_-]+)"?/.exec(raw)
    if (m) return m[1]!
  }
  return null
}

// ─────────── _build_search_instruction（菜单式，1:1 文案） ───────────

export function buildSearchInstruction(toolName: string, args: Json, gaps: string[], skillName?: string | null, knownDims?: string[]): string {
  const paramsStr = Object.entries(args).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')
  const dimNames = knownDims ?? []
  const queryHints = buildDimensionHints(toolName, args)
  const dimMenu = dimNames.map((dim) => `  - ${dim}\n    hint: ${queryHints[dim] ?? `${dim} 相关配置参数和命令`}`).join('\n')

  const skillLine = skillName
    ? `ACTION_REQUIRED: BKN is partial but has identified responsible Skill. Execute BOTH in parallel: (1) skill_view("${skillName}") for diagnostic commands and repair steps, AND (2) choose 3-5 relevant dimensions from the menu below and search_qdrant per dimension. These are EQUAL priority actions — do both, not just one.\n`
    : ''

  return (
    `${skillLine}BKN data is partial for ${toolName}(${paramsStr}). ` +
    `Gaps: ${gaps.slice(0, 4).join('; ')}. ` +
    `YOU (the Agent) choose which dimensions to search based on the context. ` +
    `Pick 3-5 relevant dimensions, use the hints below as query starting points, ` +
    `and call \`search_qdrant\` with PRECISE technical terms.\n` +
    `Available dimensions (you decide):\n${dimMenu}`
  )
}

// ─────────── _wrap 等价物：工具结果统一包装 ───────────

/**
 * 每个工具返回统一包装（Hermes tools._wrap 1:1）：
 * confidence/gaps + （defer 模式）_instruction 维度菜单 + _skill_recommendation + _search_deferred。
 * 命令字段安全网由 renderFor/output 层处理（DSH 侧已接入），此处不重复。
 */
export function wrapToolResult(result: unknown, args: Json, toolName: string, knownDims?: string[]): Json {
  const { confidence, gaps } = assessConfidence((result ?? {}) as Json, args, toolName)
  const wrapped: Json = (result && typeof result === 'object' ? result as Json : { data: result })
  wrapped.confidence = confidence
  wrapped.gaps = gaps
  wrapped._tool_name = toolName
  if (confidence !== 'full') logGap(toolName, args, confidence, gaps)

  if (confidence === 'none' || confidence === 'partial') {
    // defer 模式（生产配置 defer_to_hermes=true）：返回提示即止，不内部检索
    if (SUPPLEMENT.deferToHermes) {
      const skillName = extractSkillFromResult(wrapped)
      if (skillName) {
        wrapped._skill_recommendation = {
          skill: skillName,
          reason: 'BKN 标记此对象由该 Skill 负责，含完整诊断命令、修复步骤和操作约束',
          priority: 'equal',
        }
      }
      wrapped._instruction = buildSearchInstruction(toolName, args, gaps, skillName, knownDims)
      wrapped._search_deferred = true
      wrapped._coverage_pending = true
    }
  }
  return wrapped
}

// ─────────── v3.6: 通用诊断知识消费优化（snippet 可操作性 + 关键事实提取）───────────
// 1:1 移植 supplement.py `_actionability_score` + `_extract_must_know`（语法级模式，
// 不做 DB/症状语义解释）。

/** 通用、与 DB/症状无关的 snippet 可操作性信号（py _ACTIONABILITY_PATTERNS 1:1） */
const ACTIONABILITY_PATTERNS: Array<[RegExp, number]> = [
  [/[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+[ \t\n\r\f\v]*[:=][ \t\n\r\f\v]*[^ \t\n\r\f\v,;]+/, 1.0],
  [/(?<![a-zA-Z0-9_])-[0-9]{3,}(?![a-zA-Z0-9_])/, 1.0],
  [/(?<![a-zA-Z0-9_])\/([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)/i, 1.0],
  [/(?<![a-zA-Z0-9_])(?:SELECT|ALTER|CREATE|INSERT|UPDATE|DELETE)(?![a-zA-Z0-9_])/i, 0.8],
  [/(?:不支持|暂不支持|not supported|limited)/i, 0.8],
]

/** 从 snippet 文本中提取顶层关键事实的通用模式（py _MUST_KNOW_PATTERNS 1:1） */
const MUST_KNOW_PATTERNS = {
  critical_params: /(?:^|[ \t\n\r\f\v])([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)[ \t\n\r\f\v]*[:=][ \t\n\r\f\v]*([^ \t\n\r\f\v,;]+)/g,
  error_codes: /(?<![a-zA-Z0-9_])-?[0-9]{3,}(?![a-zA-Z0-9_])/g,
  paths: /(?<![a-zA-Z0-9_])\/([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)/gi,
  flags: /(?<![a-zA-Z0-9_])(YES|NO|TRUE|FALSE|ON|OFF)(?![a-zA-Z0-9_])/gi,
}

const MUST_KNOW_MAX_ITEMS = 8

/**
 * 基于通用结构信号给 snippet 打分，越高表示越可能包含可直接操作的信息。
 * 1:1 py _actionability_score：命中模式权重累加，上限 3.0。
 */
export function actionabilityScore(text: string): number {
  if (!text) return 0
  let score = 0
  for (const [pat, weight] of ACTIONABILITY_PATTERNS) {
    if (pat.test(text)) {
      score += weight
      pat.lastIndex = 0 // 重置带 /g 的 lastIndex（test 会推进）
    }
  }
  return Math.min(score, 3.0)
}

/**
 * 从 dimension snippets 中通用提取关键事实（py _extract_must_know 1:1）。
 * 仅使用语法级模式：点分参数名、错误码、路径、开关值；每类上限 8 项。
 * @param dimensions - 形如 [{name, snippets:[{content,...}]}]（诊断知识合成结果）
 * @returns {critical_params, error_codes, paths, flags}
 */
export function extractMustKnow(dimensions: Array<{ name?: string; snippets?: Array<Record<string, unknown>> }>): {
  critical_params: Array<{ name: string; value: string }>
  error_codes: string[]
  paths: string[]
  flags: string[]
} {
  const allText = dimensions
    .flatMap((d) => d.snippets ?? [])
    .map((s) => String(s.content ?? ''))
    .join('\n')

  // 1. 点分参数名赋值
  const params: Array<{ name: string; value: string }> = []
  const seenParams = new Set<string>()
  for (const m of allText.matchAll(MUST_KNOW_PATTERNS.critical_params)) {
    const name = m[1]!
    const value = m[2]!
    if (seenParams.has(name) || name.length <= 3) continue
    // 过滤明显非配置项（URL、版本号）
    if (value.startsWith('http') || value.startsWith('www')) continue
    if (/^[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}$/.test(value)) continue
    seenParams.add(name)
    params.push({ name, value })
    if (params.length >= MUST_KNOW_MAX_ITEMS) break
  }

  // 2. 错误码
  const errorCodes: string[] = []
  const seenCodes = new Set<string>()
  for (const m of allText.matchAll(MUST_KNOW_PATTERNS.error_codes)) {
    const code = m[0]
    if (!seenCodes.has(code)) {
      seenCodes.add(code)
      errorCodes.push(code)
    }
    if (errorCodes.length >= MUST_KNOW_MAX_ITEMS) break
  }

  // 3. 路径
  const paths: string[] = []
  const seenPaths = new Set<string>()
  for (const m of allText.matchAll(MUST_KNOW_PATTERNS.paths)) {
    const path = '/' + m[1]!.replace(/[.,;:!?'']+$/, '')
    if (!seenPaths.has(path)) {
      seenPaths.add(path)
      paths.push(path)
    }
    if (paths.length >= MUST_KNOW_MAX_ITEMS) break
  }

  // 4. 开关值
  const flags: string[] = []
  const seenFlags = new Set<string>()
  for (const m of allText.matchAll(MUST_KNOW_PATTERNS.flags)) {
    const flag = m[1]!.toUpperCase()
    if (!seenFlags.has(flag)) {
      seenFlags.add(flag)
      flags.push(flag)
    }
    if (flags.length >= MUST_KNOW_MAX_ITEMS) break
  }

  return { critical_params: params, error_codes: errorCodes, paths, flags }
}
