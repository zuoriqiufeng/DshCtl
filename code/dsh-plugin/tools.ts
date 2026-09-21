/**
 * tools.ts — BKN 查询工具的 defineTool 定义（DSH 版）
 *
 * 遵循 BKN 边界：工具只返回结构化数据 + 推荐 Skill 名，绝不返回可执行命令串。
 * 输出经 _filterCommandFields 清洗（键级黑名单 + 值级 SQL/路径/端口/命令扫描）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ContextLoader } from './contextLoader.ts'
import { BKNResolver } from './resolver.ts'
import { RelationTraverser } from './relations.ts'
import { checkActionRisk, loadRules, normalizeAction, parseConstraintsDetail } from './riskGuard.ts'
import {
  aggregateResults,
  bm25Search,
  decomposeQueries,
  DECOMPOSE,
  expandParents,
  getBm25Warnings,
  getDimensionCoverage,
  getSearchWarnings,
  resetDimensionCoverage,
  searchChunkLevel,
  searchFull,
  searchMiniFirst,
  trackDimension,
  type Hit,
} from './retrieval.ts'
import { actionabilityScore, buildDimensionHints, buildQuery, extractGapKeywords, extractMustKnow, getDimensionPriority, wrapToolResult } from './supplement.ts'

// ── operation 前置知识合成（1:1 Hermes resolver.synthesize_operation_knowledge）──

/** 将 BKN 单行/分号/换行文本拆为可读条目。 */
export function splitBknText(text: string): string[] {
  if (!text) return []
  return text.split(/[;；\n]/).map((p) => p.replace(/^[- *•]+/, '').trim()).filter(Boolean)
}

/** 从风险文本提取错误码及其描述行。 */
export function extractErrorCodes(text: string): Record<string, string> {
  const codes: Record<string, string> = {}
  if (!text) return codes
  const pattern = /((?:[A-Z]{2,}-)+[0-9]+|-[0-9]{3,})/g
  for (let line of text.split(/[;；\n]/)) {
    line = line.replace(/^[- *•]+/, '').trim()
    if (!line) continue
    for (const code of line.match(pattern) ?? []) {
      codes[code] = line
    }
  }
  return codes
}

/** 前置知识 3 维模板（Hermes _OPERATION_DIMENSION_TEMPLATES 1:1）。 */
const OPERATION_DIMENSION_TEMPLATES: Array<[string, (op: string, cap: string) => string]> = [
  ['前置条件', (op) => `${op} 前置条件 准备工作 环境要求`],
  ['约束与注意事项', (op) => `${op} 约束 禁止 注意事项`],
  ['常见错误', (op) => `${op} 常见错误 错误码 排查`],
]

/**
 * 基于 BKN capability 信息 + Qdrant 多维度检索，合成操作前置知识。
 * 每维检索独立 try/catch 优雅降级——检索不可达不影响工具返回。
 */
export async function synthesizeOperationKnowledge(opts: {
  capability: string
  operationName: string
  prerequisites: string
  constraints: string
  risks: string
  topK?: number
}): Promise<Record<string, unknown>> {
  const { capability, operationName, prerequisites, constraints, risks } = opts
  const topK = opts.topK ?? 3
  const label = operationName || capability
  const whatYouNeed = splitBknText(prerequisites)
  const constraintItems = splitBknText(constraints)
  if (risks) {
    for (const item of splitBknText(risks)) {
      if (!constraintItems.includes(item)) constraintItems.push(item)
    }
  }
  const commonErrors = extractErrorCodes(risks)

  const dimensions: Array<{ name: string; snippets: Array<{ content: string; score: number; source: string }> }> = []
  const allReferences = new Set<string>()
  for (const [dimName, template] of OPERATION_DIMENSION_TEMPLATES) {
    const query = template(label, capability)
    const snippets: Array<{ content: string; score: number; source: string }> = []
    try {
      const hits = await searchFull(query, topK, true)
      for (const h of hits) {
        const content = h.content ?? ''
        if (!content) continue
        snippets.push({ content: content.slice(0, 500), score: h.score ?? 0, source: h.source ?? '' })
        if (h.source) allReferences.add(h.source)
      }
    } catch { /* 检索不可达 → 空 snippets 降级 */ }
    dimensions.push({ name: dimName, snippets })
  }

  return {
    summary: `基于 BKN 与知识库合成的「${label}」操作前置知识（${dimensions.reduce((n, d) => n + d.snippets.length, 0)} 条片段）`,
    what_you_need: whatYouNeed,
    constraints: constraintItems,
    common_errors: commonErrors,
    dimensions,
    top_references: [...allReferences].sort(),
  }
}

/** 取 capability 关联约束的文本（从 constraints.bkn 详情表按 ruleId 取约束列）。 */
function capabilityConstraintTexts(ruleIds: string[], detailMap: Record<string, { text: string }>): string {
  return ruleIds
    .map((id) => detailMap[id]?.text ?? '')
    .filter(Boolean)
    .join('\n')
}

// ── 命令字段清洗（移植自 tools.py _filterCommandFields）──

const COMMAND_FIELD_DENYLIST = new Set([
  '检查命令', '执行命令', '执行步骤', '命令', '命令模板',
  'command', 'commands', 'script', 'scripts', 'cmd',
  'out_dir', 'bin_dir', 'default_value',
  'log_dir', 'cache_dir', 'alert_log_path', 'core_dump_dir',
])

const COMMAND_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/(?<![0-9])(?:1521|3306|5432|1433|50000|5236|2881|2882|2883|8080|8000|8001|1688|9030|8030|8040|22001|6379|27017|2181|58086|58084|26803|26804|26837|40000)(?![0-9])/, '具体端口号'],
  [/~\/\.i2stream\/|~\/idata\//, '绝对路径'],
  [/ALTER[ \t\n\r\f\v]+DATABASE|ALTER[ \t\n\r\f\v]+TABLE|ALTER[ \t\n\r\f\v]+SYSTEM|CREATE[ \t\n\r\f\v]+USER|GRANT[ \t\n\r\f\v]+|SET[ \t\n\r\f\v]+GLOBAL|ADD[ \t\n\r\f\v]+SUPPLEMENTAL[ \t\n\r\f\v]+LOG|SELECT[ \t\n\r\f\v]+.*[ \t\n\r\f\v]+FROM/i, 'SQL片段'],
  [/dumpredo|dumptxn|dumpdict|dumpasm|dumptab/i, '具体诊断工具名'],
  [/--force/, '命令标志--force'],
  [/cd[ \t\n\r\f\v]+~\/\.i2stream|python[ \t\n\r\f\v]+.*check|uv[ \t\n\r\f\v]+run/, '可执行命令字符串'],
]

function filterCommandFields<T>(value: T, leaked: string[] = []): T {
  if (Array.isArray(value)) {
    return value.map((v) => filterCommandFields(v, leaked)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COMMAND_FIELD_DENYLIST.has(String(k).toLowerCase())) {
        leaked.push(String(k))
        continue
      }
      let filtered = filterCommandFields(v, leaked)
      if (typeof filtered === 'string') {
        for (const [pat, label] of COMMAND_VALUE_PATTERNS) {
          if (pat.test(filtered)) {
            filtered = `[${label}已移除 — 请加载对应 Skill 获取具体命令/参数]`
            leaked.push(`${k}: ${label}`)
            break
          }
        }
      }
      result[k] = filtered
    }
    return result as unknown as T
  }
  return value
}

// ── 渲染辅助 ──

/** 默认 ContextLoader（Trim + Toon；可按工具策略自动选模式）。 */
const contextLoader = new ContextLoader()

/** 生成某工具的 render：规范值 → ContextLoader 优化文本（模型可见）。 */
function renderFor(toolName: string) {
  return (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: contextLoader.process(value, toolName) },
  ]
}

function sectionToJson(section: { raw: string; tables: unknown[]; kv: Record<string, string> } | null, fallback: string): Record<string, unknown> {
  if (!section) return { matched: false, fallback }
  return { matched: true, raw: section.raw, tables: section.tables, kv: section.kv }
}

// ── 工具定义 ──

export function buildTools(ctx: Context, deps: { resolver: BKNResolver; traverser: RelationTraverser; bknRoot: string }) {
  const { resolver, traverser } = deps

  // Hermes tools._wrap 等价：前 10 个 BKN 工具统一包置信度/gap/defer 补查提示；
  // search_qdrant/diagnose_db_link 自带完整质量字段（对齐 Hermes 不包 _wrap 的行为）
  const UNWRAPPED = new Set(['search_qdrant', 'diagnose_db_link'])
  const registerTool = (def: { name: string; execute: (args: any) => Promise<unknown> } & Record<string, unknown>) =>
    ctx.tools.register(defineTool({
      ...def,
      execute: async (args: any) => {
        const result = await def.execute(args)
        if (UNWRAPPED.has(def.name)) return result
        const knownDims = def.name === 'design_solution' ? DIAGNOSE_DIMENSIONS : undefined
        return wrapToolResult(result, (args ?? {}) as Record<string, unknown>, def.name, knownDims)
      },
    } as Parameters<typeof defineTool>[0]))

  registerTool({
    name: 'query_product',
    description: '查询 i2Stream 产品信息: 定位、核心能力、竞品对比、行业覆盖、信创适配。当用户问 i2Stream 是什么、有什么优势、和某竞品对比时调用。',
    parameters: {
      aspect: {
        type: 'string',
        enum: ['overview', 'positioning', 'advantages', 'competitors', 'industries', 'xinchuang', 'all'],
        description: '查询方面: overview=概述, positioning=产品定位, advantages=核心优势, competitors=竞品对比, industries=行业覆盖, xinchuang=信创适配, all=全部',
        required: true,
      },
      competitor: {
        type: 'string',
        description: '竞品名, 如 OGG/DSG/Kettle。仅 aspect=competitors 时需要',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('query_product'),
    },
    async execute(args) {
      const aspect = args.aspect ?? 'overview'
      const leaked: string[] = []
      const section = aspect === 'all'
        ? null
        : resolver.queryProduct(aspect)
      const result = aspect === 'all'
        ? { aspect, matched: false, fallback: 'product.bkn', hint: '请改用具体 aspect 查询' }
        : sectionToJson(section, 'product.bkn 未找到对应小节')
      const filtered = filterCommandFields(result, leaked)
      return { ...(filtered as Record<string, unknown>), aspect, leaked }
    },
  })

  registerTool({
    name: 'resolve_relation',
    description: '查询 BKN 关系图中实体之间的关联关系（12 种关系类型: constrained_by/risks_of/implements_skill/has_action 等）。当需要确认某个关系是否存在、某动作的约束/风险、或 Object→Action→Skill 路由时调用。',
    parameters: {
      source_entity: {
        type: 'string',
        description: '源实体: syncrule/dbnode/worknode 或 action:xxx / skill:xxx / risk 规范名',
        required: true,
      },
      relation_type: {
        type: 'string',
        enum: ['requires', 'implements', 'constrains', 'constrained_by', 'prerequisite', 'risks_of', 'has_action', 'references', 'runs_on', 'registered_on', 'supports', 'implements_skill', 'all'],
        description: '关系类型; all=全部出边',
      },
      target_hint: {
        type: 'string',
        description: '目标实体类型过滤(可选): skill/action/object/risk',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('resolve_relation'),
    },
    async execute(args) {
      const source = String(args.source_entity ?? '')
      const relType = args.relation_type && args.relation_type !== 'all' ? String(args.relation_type) : undefined
      let targets = traverser.getTargets(source, relType)
      const hint = args.target_hint ? String(args.target_hint).toLowerCase() : ''
      if (hint) {
        const prefix = hint === 'skill' ? 'skill:' : hint === 'action' ? 'action:' : `${hint}:`
        targets = targets.filter((t) => t.startsWith(prefix) || t.toLowerCase().includes(hint))
      }
      const sources = relType ? traverser.getSources(source, relType) : []
      const expand = traverser.expand(source, 2)
      return {
        source,
        relation_type: relType ?? 'all',
        targets,
        sources,
        adjacent: expand.relations,
        hint,
      }
    },
  })

  registerTool({
    name: 'check_action_risk',
    description: 'RiskGuard 风险自查: 在执行 i2Stream 写操作（删除规则/注册数据库/重启规则等）前，检查对象当前状态是否违反 L0 状态前置约束。返回 passed/block_reason。当准备执行危险操作且已知对象状态时调用。',
    parameters: {
      action: {
        type: 'string',
        description: '动作名: delete_sync_rule/register_db/restart_sync_rule（支持别名 delete_rule/register_database/restart_rule）',
        required: true,
      },
      current_state: {
        type: 'string',
        description: '对象当前状态: RUNNING/FULLSYNC/STOPPED/ABNORMAL/OFFLINE/ONLINE',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('check_action_risk'),
    },
    async execute(args) {
      const action = normalizeAction(String(args.action ?? ''))
      const state = String(args.current_state ?? '').toUpperCase()
      const check = checkActionRisk(action, state, resolver.root)
      return {
        action: check.action,
        state: check.state,
        passed: check.passed,
        rule_id: check.ruleId,
        block_reason: check.blockReason,
        severity: check.severity,
        error_code: check.errorCode,
        blockable: check.blockable,
      }
    },
  })

  registerTool({
    name: 'resolve_operation',
    description: '根据操作名返回 capability + 绑定的 Skill 列表 + 前置约束/风险。当模型知道要执行某操作但不知道用哪个 Skill、或需要确认操作的前置条件时调用。只返回语义与 Skill 指针，不含具体命令。',
    parameters: {
      operation: {
        type: 'string',
        description: '操作名: 创建同步规则/启动规则/停止规则/删除规则/激活节点/注册数据库/表比较/灾备切换/...',
        required: true,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('resolve_operation'),
    },
    async execute(args) {
      const op = String(args.operation ?? '')
      const syn = resolver.resolveSynonym(op)
      const info = resolver.lookupOperation(syn || op)
      if (!info) {
        const all = resolver.listOperations()
        return { matched: false, operation: op, hint: `未找到操作，已知操作: ${all.join('、')}` }
      }
      const capability = info.capability
      const skills = traverser.getSkillsForAction(capability)
      const constraints = traverser.getConstraintsForAction(`action:${capability}`)
      const risks = traverser.getRisksForAction(`action:${capability}`)
      const prereq = resolver.getPrerequisites(capability)
      // operation 前置知识合成：BKN 拆条 + 3 维检索（每维独立降级）
      const detailMap = parseConstraintsDetail(deps.bknRoot)
      const riskRules = loadRules(deps.bknRoot)
      const opConstraints = constraints
      const constraintSource = opConstraints.length
        ? (riskRules[opConstraints[0]!]?.source ?? 'fallback_assoc')
        : 'fallback_assoc'
      const prerequisiteKnowledge = await synthesizeOperationKnowledge({
        capability,
        operationName: syn || op,
        prerequisites: prereq?.raw ?? '',
        constraints: capabilityConstraintTexts(opConstraints, detailMap),
        risks: '',
      })
      return {
        matched: true,
        operation: op,
        resolved_as: syn ?? null,
        capability,
        matched_by: info.matchedBy,
        skills,
        skill_hint: skills.length ? `请加载 Skill: ${skills.join('、')} 获取具体命令/参数` : '',
        constraints,
        risks,
        prerequisites: prereq ? prereq.raw.slice(0, 2000) : '',
        prerequisite_knowledge: prerequisiteKnowledge,
        _op_constraints: opConstraints,
        _constraints_source: constraintSource,
      }
    },
  })

  // ── Tool 5: explain_architecture ──

  registerTool({
    name: 'explain_architecture',
    description: '查询 i2Stream 技术原理: 全量同步、增量同步、拓扑模式、事务一致性、数据校验、性能特性、各数据库实现细节。当用户问原理/架构/如何实现时调用。',
    parameters: {
      topic: {
        type: 'string',
        enum: ['full_sync', 'incremental_sync', 'topology', 'transaction', 'validation', 'performance', 'oracle_log', 'mssql_mode', 'matrix', 'all'],
        description: '主题: full_sync=全量同步, incremental_sync=增量同步, topology=拓扑, transaction=事务一致性, validation=数据校验, performance=性能, oracle_log=Oracle抽取, mssql_mode=MSSQL模式, matrix=原理矩阵, all=全部',
        required: true,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('explain_architecture'),
    },
    async execute(args) {
      const topic = String(args.topic ?? 'all')
      const section = resolver.queryArchitecture(topic)
      if (!section) {
        return {
          error: `未找到主题: ${topic}`,
          available_topics: ['full_sync', 'incremental_sync', 'topology', 'transaction', 'validation', 'performance', 'oracle_log', 'mssql_mode', 'matrix'],
        }
      }
      return { ...sectionToJson(section, 'architecture.bkn 未找到对应小节'), topic }
    },
  })

  // ── Tool 6: design_solution ──

  /** 从 expanded.relations 提取所有实体指定关系类型的目标列表（对齐 tools.py _extract_from_relations）。 */
  const extractFromRelations = (expanded: { relations: Record<string, Record<string, string[]>> }, relType: string): string[] => {
    const items = new Set<string>()
    for (const rels of Object.values(expanded.relations ?? {})) {
      if (rels && typeof rels === 'object') {
        for (const tgt of rels[relType] ?? []) {
          if (typeof tgt === 'string') items.add(tgt)
        }
      }
    }
    return [...items].sort()
  }

  const SCENARIO_HINT_MAP: Record<string, string> = {
    migration: '跨平台迁移',
    dual_active: '数据库双活',
    bigdata: '大数据采集分析',
    disaster_recovery: '两地三中心',
  }

  registerTool({
    name: 'design_solution',
    description: '根据源端和目标端数据库类型, 设计完整的同步方案。返回适用场景/兼容性约束/关联拓扑/前置要求/潜在风险。当用户要求设计同步方案、做迁移规划时调用。',
    parameters: {
      source: { type: 'string', description: '源端数据库类型: Oracle/MySQL/PostgreSQL/SQLServer/DB2/DM/OceanBase/...', required: true },
      target: { type: 'string', description: '目标端数据库类型', required: true },
      scenario_hint: {
        type: 'string',
        enum: ['migration', 'dual_active', 'disaster_recovery', 'bigdata', 'auto'],
        description: '场景提示: auto=自动匹配(默认)',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('design_solution'),
    },
    async execute(args) {
      const source = String(args.source ?? '')
      const target = String(args.target ?? '')
      const hint = String(args.scenario_hint ?? 'auto')
      const hintedName = SCENARIO_HINT_MAP[hint]
      const scenario = hintedName
        ? resolver.matchScenarioByName(hintedName, source, target)
        : resolver.matchScenario(source, target)
      const expanded = traverser.expand(`scenario:${scenario.scenario || 'migration'}`, 3)
      const compat = resolver.checkCompatibility(source, target)
      return {
        scenario: scenario.scenario || '跨平台迁移',
        description: scenario.description,
        compatibility: compat,
        relations: expanded.relations,
        prerequisites: extractFromRelations(expanded, 'prerequisite'),
        constraints: extractFromRelations(expanded, 'constrains'),
        risks: extractFromRelations(expanded, 'risks_of'),
      }
    },
  })

  // ── Tool 7: check_compatibility ──

  registerTool({
    name: 'check_compatibility',
    description: '检查源端到目标端的兼容性: 是否支持、版本要求、对象兼容、限制条件。当用户问兼容性、某组合能不能用时调用。',
    parameters: {
      source: { type: 'string', description: '源端数据库类型', required: true },
      target: { type: 'string', description: '目标端数据库类型', required: true },
      source_version: { type: 'string', description: '源端版本(可选)' },
      target_version: { type: 'string', description: '目标端版本(可选)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('check_compatibility'),
    },
    async execute(args) {
      return resolver.checkCompatibility(
        String(args.source ?? ''),
        String(args.target ?? ''),
        args.source_version ? String(args.source_version) : undefined,
        args.target_version ? String(args.target_version) : undefined,
      )
    },
  })

  // ── Tool 8: list_scenarios ──

  registerTool({
    name: 'list_scenarios',
    description: '列出 i2Stream 支持的应用场景。当用户描述需求但不清楚对应哪个方案时调用。',
    parameters: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '搜索关键词: 迁移/双活/容灾/大数据/同步/...',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('list_scenarios'),
    },
    async execute(args) {
      const raw = args.keywords
      const keywords = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []
      let scenarios = resolver.listScenarios()
      if (keywords.length) {
        const kwLower = keywords.map((k) => k.toLowerCase())
        scenarios = scenarios.filter((s) => {
          const joined = (s.keywords as string[]).join(' ').toLowerCase()
          return kwLower.some((kw) => joined.includes(kw))
        })
      }
      return { scenarios }
    },
  })

  // ── Tool 9: diagnose_error ──

  registerTool({
    name: 'diagnose_error',
    description: '根据错误码诊断 i2Stream 同步异常。返回错误原因、修复步骤、可能违反的操作约束。当用户报告错误码或描述异常时调用。',
    parameters: {
      error_code: { type: 'string', description: '错误码: -4073/-4016/-4071/-4031/-4046/...', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('diagnose_error'),
    },
    async execute(args) {
      const errorCode = String(args.error_code ?? '')
      const section = resolver.getRisk(errorCode)
      if (!section) {
        return { error_code: errorCode, diagnosis: '未在 BKN 中找到该错误码的诊断信息' }
      }
      return { error_code: errorCode, diagnosis: section.raw, matched: true }
    },
  })

  // ── Tool 10: get_prerequisites ──

  registerTool({
    name: 'get_prerequisites',
    description: '获取某操作的前置条件检查清单。当用户准备执行操作前需要确认准备就绪时调用。',
    parameters: {
      operation: {
        type: 'string',
        enum: ['activate_node', 'register_db', 'create_rule', 'start_rule', 'stop_rule', 'delete_rule', 'compare_table', 'failover'],
        description: '操作名: activate_node=激活节点, register_db=注册数据库, create_rule=创建规则, start_rule=启动规则, stop_rule=停止规则, delete_rule=删除规则, compare_table=表比较, failover=灾备切换',
        required: true,
      },
      db_type: { type: 'string', description: '数据库类型(可选), 用于补充DB特定前置' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderFor('get_prerequisites'),
    },
    async execute(args) {
      const operation = String(args.operation ?? '')
      const dbType = args.db_type ? String(args.db_type) : undefined
      const section = resolver.getPrerequisites(operation)
      if (!section) {
        return {
          operation,
          prerequisites: '未找到该操作的前置条件, 请检查操作名',
          available: resolver.listOperations(),
        }
      }
      const dbSpecific = dbType
        ? BKNResolver.extractDbSpecificPrerequisites(section.raw, dbType)
        : []
      return {
        operation,
        prerequisites: section.raw,
        ...(dbSpecific.length ? { db_specific_prerequisites: dbSpecific } : {}),
      }
    },
  })

  // ═══════════ Tool 11: search_qdrant（阶段3，移植自 Hermes tools.search_qdrant_handler） ═══════════

  /** 单查询核心：chunk_mode 路由 + 维度追踪 + 输出整形 + 降级。 */
  async function runSingleSearch(a: {
    query: string; topK: number; collection?: string; dimension?: string; chunkMode: string; toolName: string; taskId?: string;
  }): Promise<Record<string, unknown>> {
    const { query, topK, collection, dimension, chunkMode, toolName, taskId } = a
    let rawHits: Hit[] = []
    try {
      if (chunkMode === 'mini_first') {
        rawHits = await searchMiniFirst(query, topK, collection)
      } else if (chunkMode === 'standard_image') {
        rawHits = await searchChunkLevel(query, topK, ['standard', 'image'], { hybrid: true, collection })
      } else if (chunkMode === 'large_only') {
        rawHits = await searchChunkLevel(query, topK, ['large'], { hybrid: true, collection })
      } else if (chunkMode === 'parent_expand') {
        rawHits = await expandParents(await searchFull(query, topK, true))
      } else {
        // auto：全量 BGE+BM25→RRF（自定义 collection 走同链路）
        rawHits = await searchFull(query, topK, true)
      }
    } catch (e) {
      // 降级链：embedding/Qdrant 不可用 → BM25-only（对齐 Hermes client/model None 行为）
      try {
        const sparse = await bm25Search(query, topK * 2, collection)
        rawHits = sparse.map((h) => ({
          content: h.content, score: Math.round(h.bm25_score * 10000) / 10000,
          source: ' [BM25_only]', id: h.id, _fallback_reason: 'embed_unavailable',
        })) as Hit[]
        if (!rawHits.length) {
          return { hits: [], count: 0, query, dimension: dimension ?? null, chunk_mode: chunkMode, error: `Qdrant 搜索失败: ${String(e).slice(0, 160)}` }
        }
      } catch {
        return { hits: [], count: 0, query, dimension: dimension ?? null, chunk_mode: chunkMode, error: `Qdrant 搜索失败: ${String(e).slice(0, 160)}` }
      }
    }

    if (dimension) trackDimension(dimension, rawHits.length, taskId)
    const knownDims = DIAGNOSE_DIMENSIONS
    const coverage = getDimensionCoverage(dimension ? knownDims : [], taskId)

    const hits = rawHits.map((h) => {
      const hOut: Record<string, unknown> = {
        content: String(h.content ?? '').slice(0, 500),
        score: h.score ?? 0,
        source: h.source ?? '',
      }
      for (const f of ['chunk_id', 'chunk_level', 'section_type', 'image_file_id', 'large_chunk_id', 'title', 'blurb', 'mini_chunk_count'] as const) {
        if (h[f] !== undefined && h[f] !== null) hOut[f] = h[f]
      }
      if (h.hit_mini) hOut.hit_mini = h.hit_mini.map((m) => ({ ...m, text: (m.text ?? '').slice(0, 500) }))
      if (h._parent) hOut._parent = h._parent
      for (const f of ['pattern_id', 'log_fingerprint', 'component', 'severity', 'error_codes', 'db_types', 'source_note'] as const) {
        if ((h as any)[f] !== undefined) hOut[f] = (h as any)[f]
      }
      if (dimension) hOut._dim = dimension
      if (h._fallback_reason) hOut._fallback_reason = h._fallback_reason
      return hOut
    })

    const warnings = [...getSearchWarnings(), ...getBm25Warnings()]
    const result: Record<string, unknown> = {
      hits,
      count: hits.length,
      query,
      dimension: dimension ?? null,
      coverage,
      chunk_mode: chunkMode,
    }
    if (!hits.length) result.note = '未找到相关结果，尝试更换查询词'
    if (warnings.length) result._warning = warnings.join('; ')
    return result
  }

  registerTool({
    name: 'search_qdrant',
    description: 'Qdrant 向量检索（BGE+BM25 混合，RRF 融合）。支持单查询与批量；decompose:true 按 tool_name 分解为多维度子查询并聚合去重（Hermes v2.0 内部多路检索，提升单次召回密度）；dimension 参数标注目标维度以累积覆盖度；dimension="__report__" 返回覆盖度报告，"__reset__" 清空。检索 BKN 外的详细知识（日志模式、文档片段）时使用。',
    parameters: {
      query: { type: 'string', description: '单查询文本（queries 未传时必填）' },
      queries: {
        type: 'array',
        description: '批量查询: [{query, dimension?, top_k?, collection?, chunk_mode?}, ...]，最多 10 条，按原序返回',
        items: { type: 'object', additionalProperties: true },
      },
      decompose: { type: 'boolean', description: 'true=按 tool_name 分解多维度子查询并聚合去重（需配 args 提取源/目标/错误码等）' },
      args: { type: 'object', additionalProperties: true, description: 'decompose 模式的原始工具入参（source/target/error_code/topic/operation 等，用于生成维度查询）' },
      gaps: { type: 'array', items: { type: 'string' }, description: 'decompose 模式可选：gap 关键词来源，融合进子查询' },
      top_k: { type: 'integer', description: '返回条数上限 1-20，默认 5' },
      collection: { type: 'string', description: '自定义 Qdrant collection（默认主集合 i2stream_collection）' },
      dimension: { type: 'string', description: '目标知识维度标签；"__report__"=覆盖度报告；"__reset__"=清空追踪' },
      tool_name: { type: 'string', description: '维度集归属（默认 design_solution）' },
      chunk_mode: {
        type: 'string',
        enum: ['mini_first', 'auto', 'parent_expand', 'standard_image', 'large_only'],
        description: '分块策略，默认 mini_first（mini ANN→standard 回源）',
      },
      task_id: { type: 'string', description: '覆盖度分桶 ID（多任务并发时区分）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderFor('search_qdrant') },
    async execute(args) {
      const toolName = (args.tool_name as string) || 'design_solution'
      const taskId = args.task_id as string | undefined

      // 批量模式
      const queriesSpec = args.queries as Array<Record<string, unknown>> | undefined
      if (Array.isArray(queriesSpec) && queriesSpec.length) {
        const batch = queriesSpec.slice(0, 10)
        const results: Array<Record<string, unknown>> = []
        for (const spec of batch) {
          results.push(await runSingleSearch({
            query: String(spec.query ?? ''),
            topK: clampTopK(spec.top_k),
            collection: spec.collection as string | undefined,
            dimension: spec.dimension as string | undefined,
            chunkMode: (spec.chunk_mode as string) || 'mini_first',
            toolName,
            taskId,
          }))
        }
        return { mode: 'batch', count: results.length, results }
      }

      const query = ((args.query as string) ?? '').trim()
      const dimension = args.dimension as string | undefined
      const chunkMode = (args.chunk_mode as string) || 'mini_first'

      if (dimension === '__report__') {
        return {
          coverage: getDimensionCoverage(DIAGNOSE_DIMENSIONS, taskId),
          mode: 'report_only',
          hint: '用 dimension 参数标注每次搜索的目标维度以累积覆盖度',
        }
      }
      if (dimension === '__reset__') {
        resetDimensionCoverage(taskId)
        return { mode: 'reset', hint: '当前任务的维度覆盖记录已清空，可开始新一轮逐维度搜索' }
      }
      // ── decompose 模式（Hermes v2.0 内部多路检索）：按 tool_name 分解多维度子查询 + 去重聚合 ──
      if (args.decompose === true) {
        const decomposeArgs = (args.args as Record<string, unknown>) ?? {}
        const decomposeGaps = Array.isArray(args.gaps) ? (args.gaps as string[]) : []
        const subQueries = decomposeQueries(toolName, decomposeArgs, decomposeGaps, extractGapKeywords, buildQuery)
        const topKPer = clampTopK(args.top_k) || DECOMPOSE.topK
        const allHits: Array<[string, Array<Record<string, unknown>>]> = []
        for (const [dimName, q] of subQueries) {
          const single = await runSingleSearch({
            query: q, topK: topKPer, collection: args.collection as string | undefined,
            dimension: dimName, chunkMode, toolName, taskId,
          })
          const hits = Array.isArray(single.hits) ? (single.hits as Array<Record<string, unknown>>) : []
          if (hits.length) {
            // 给每个 hit 打维度标签 + 追踪覆盖度（1:1 py）
            for (const h of hits) h._dim = dimName
            trackDimension(dimName, hits.length, taskId)
            allHits.push([dimName, hits])
          }
        }
        const aggregated = aggregateResults(allHits)
        return {
          mode: 'decomposed',
          count: aggregated.length,
          queries: subQueries.map(([dim, q]) => ({ dimension: dim, query: q })),
          hits: aggregated,
          coverage: getDimensionCoverage(subQueries.map(([dim]) => dim), taskId),
          chunk_mode: chunkMode,
        }
      }
      if (!query) {
        return {
          error: 'query 参数不能为空 (或使用 queries 参数进行批量搜索)',
          hint: '单查询: {"query": "..."} 或批量: {"queries": [{"query":"...","dimension":"..."}, ...]} 或分解: {"decompose":true,"args":{...}}',
        }
      }
      return runSingleSearch({
        query, topK: clampTopK(args.top_k), collection: args.collection as string | undefined,
        dimension, chunkMode, toolName, taskId,
      })
    },
  })

  // ═══════════ Tool 12: diagnose_db_link（阶段3，移植自 Hermes tools.diagnose_db_link_handler） ═══════════

  registerTool({
    name: 'diagnose_db_link',
    description: '根据症状+DB类型推荐诊断 Skill 并返回 BKN 风险上下文与排查知识。识别 DB 类型、读取诊断风险、按症状路由必需/可选 Skill、合成多维排查知识（BKN+检索）。具体 action 路由和命令构建由 Skill 完成。',
    parameters: {
      symptom: { type: 'string', description: '症状标识, 如 incremental_stuck/data_mismatch/connection_error/performance_degradation/crash_loop' },
      db_type: { type: 'string', description: '数据库类型, 默认 auto (按 error_code 前缀识别)' },
      error_code: { type: 'string', description: '可选: 关联错误码 (如 -4002, YAS-01001)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderFor('diagnose_db_link') },
    async execute(args) {
      const symptom = (args.symptom as string) ?? ''
      const rawDbType = ((args.db_type as string) || 'auto').trim()
      const errorCode = args.error_code as string | undefined

      let dbType: string
      let dbTypeSource: string
      if (rawDbType === 'auto') {
        dbType = resolveDbType(errorCode)
        dbTypeSource = dbType ? 'error_code_prefix' : 'unknown'
      } else {
        dbType = rawDbType
        dbTypeSource = 'explicit'
      }
      if (!dbType) dbType = 'unknown'

      const bknContext = extractBknContext(resolver, errorCode)
      const displaySymptom = errorCode || symptom
      const skillMap = resolver.getSymptomSkills(displaySymptom)
      const required = skillMap.required
      const optional = skillMap.optional

      const recommendedSkills = [
        ...required.map((s) => ({ name: s.name, role: 'required', reason: s.reason })),
        ...optional.map((s) => ({ name: s.name, role: 'optional', reason: s.reason })),
      ]
      const recommendedSkill = required[0]?.name ?? 'i2stream-db-diagnostics'

      const knowledge = await synthesizeDiagnosisKnowledge({
        symptom: symptom || displaySymptom,
        dbType: dbType === 'unknown' ? '' : dbType,
        errorCode,
        bknContext,
      })

      const relatedIndex = resolver.getDiagnoseRelatedSkills()
      const relatedSkills = relatedIndex.related_skills.length
        ? relatedIndex.related_skills.map((s) => ({ name: s.name, when: s.reason }))
        : [
            { name: 'i2stream-rule-manager', when: '需要查看/修改规则配置' },
            { name: 'i2stream-db-diagnostics', when: '需要执行 dump 工具深度排查' },
            { name: 'i2stream-log-analyzer', when: '需要分析规则日志' },
            { name: 'i2stream-diff-op', when: '需要对比源目两端表数据' },
            { name: 'i2stream-iadebug', when: '需要处理 -4002 位点异常' },
          ]
      const whenToLoad = relatedIndex.when_to_load || '需要具体诊断工具名和命令参数时'

      const note = knowledge.summary
        || `整理了 ${dbType} ${symptom || displaySymptom} 的排查知识，详情见 knowledge.dimensions。`

      const knowledgeSnippets: Array<Record<string, unknown>> = []
      for (const dim of knowledge.dimensions) {
        ;(dim.snippets as Array<Record<string, unknown>>).forEach((snippet, idx) => {
          knowledgeSnippets.push({
            dimension: dim.name, index: idx,
            preview: String(snippet.content ?? '').slice(0, 120),
            score: snippet.score, source: snippet.source,
          })
        })
      }

      const knowledgeContext: Record<string, unknown> = {
        analysis_framework: skillMap.analysis_framework,
        skill_capabilities: skillMap.skill_capabilities,
        summary: knowledge.summary,
        common_causes: [], recommended_steps: [], configuration_checks: [], logs_and_tools: [],
      }
      if (bknContext) knowledgeContext.bkn_risk_context = bknContext
      const DIM_TO_KC: Record<string, string> = {
        常见原因: 'common_causes', 排查步骤: 'recommended_steps',
        配置检查: 'configuration_checks', 日志与工具: 'logs_and_tools',
      }
      for (const dim of knowledge.dimensions) {
        const key = DIM_TO_KC[dim.name as string]
        if (key) knowledgeContext[key] = dim.snippets
      }

      const skillContext = {
        primary_skill: recommendedSkill,
        when_to_load: whenToLoad,
        related_skills: relatedSkills,
        recommended_skills: recommendedSkills,
      }

      const logNavigation = resolver.getLogMap(symptom || displaySymptom)

      const result: Record<string, unknown> = {
        _skill_enforcement: {
          level: 'CRITICAL',
          skills_required: required.map((s) => s.name),
          reason: '诊断类 Tool 返回的是知识框架（原因/步骤/配置），不包含可执行命令和工具路径。Skill 才持有具体命令模板、工具参数、执行环境要求。缺少 Skill 的排查方案无法落地执行。',
          guard: '禁止在 required skill 未全部加载前输出最终排查方案。先 skill_view 加载全部 required skill，再结合 Qdrant 搜索结果输出完整方案。',
        },
        symptom: displaySymptom,
        db_type: dbType,
        db_type_source: dbTypeSource,
        error_code: errorCode ?? null,
        knowledge,
        knowledge_context: knowledgeContext,
        skill_context: skillContext,
        related_skills: relatedSkills,
        recommended_skill: recommendedSkill,
        recommended_skills: recommendedSkills,
        note,
        bkn_context: bknContext,
        knowledge_snippets: knowledgeSnippets,
        supplement_hits: knowledgeSnippets, // 向后兼容
      }
      if (logNavigation && Object.keys(logNavigation).length) result.log_navigation = logNavigation
      // v3.7 Agent 自主维度选择 — 按症状优先级排序+标注（supplement 维度提示注册表）
      const symptomStr = symptom || displaySymptom
      const dimHints = buildDimensionHints('diagnose_db_link', { source: dbType, target: '', symptom: symptomStr })
      const availableDims = DIAGNOSE_DIMENSIONS
        .map((name) => ({ name, priority: getDimensionPriority(symptomStr, name), hint: dimHints[name] ?? `${name} 相关配置参数和命令` }))
        .sort((a, b) => ({ critical: 0, suggested: 1, optional: 2 }[a.priority] ?? 3) - ({ critical: 0, suggested: 1, optional: 2 }[b.priority] ?? 3))
      result._available_dimensions = availableDims
      result._search_deferred = true
      result._severity = 'suggested'
      return result
    },
  })
}

// ─────────── 阶段3 诊断辅助（移植自 tools/constants/supplement） ───────────

function clampTopK(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) return 5
  return Math.min(Math.trunc(n), 20)
}

/** DB_ERROR_PREFIXES（constants.py 1:1）：错误码前缀 → db 标识。 */
const DB_ERROR_PREFIXES: Record<string, string> = {
  'ORA-': 'oracle',
  'YAS-': 'yashandb',
  'PG-': 'postgresql',
  DB2: 'db2',
  MSSQL: 'sqlserver',
  MYSQL: 'mysql',
}

export function resolveDbType(errorCode?: string): string {
  if (!errorCode) return ''
  const upper = errorCode.toUpperCase()
  for (const prefix of Object.keys(DB_ERROR_PREFIXES).sort((a, b) => b.length - a.length)) {
    if (upper.startsWith(prefix)) return DB_ERROR_PREFIXES[prefix]!
  }
  return ''
}

/** 从 risks/diagnostics.bkn 提取错误码风险上下文（_extract_bkn_context 1:1）。 */
export function extractBknContext(resolver: BKNResolver, errorCode?: string): Record<string, string> | null {
  if (!errorCode) return null
  const risk = resolver.getRisk(errorCode)
  if (!risk) return null
  const context: Record<string, string> = { error_code: errorCode }
  const kv = risk.kv
  for (const [key, mapped] of [
    ['**风险级别**', 'risk_level'],
    ['**触发条件**', 'trigger'],
    ['**处置策略**', 'handling'],
    ['**禁止**', 'prohibitions'],
  ] as const) {
    const val = kv[key] ?? kv[key.replace(/\*/g, '')]
    if (val) context[mapped] = val
  }
  return Object.keys(context).length > 1 ? context : null
}

/** 诊断知识维度（supplement._DIAGNOSE_DIMENSIONS 1:1）。 */
export const DIAGNOSE_DIMENSIONS = [
  '增量/日志解析', '规则配置/装载策略', '数据校验/对比', '源端特定配置', '风险/异常处理',
  '字符集/类型映射', '全量同步参数', '断点续传/容错', '目标端特定配置', '跨地域/网络优化',
]

const KNOWLEDGE_DIM_QUERIES = ['常见原因', '排查步骤', '配置检查', '日志与工具', '操作约束']

/**
 * 合成多维度排查知识：Phase1 = BKN 风险上下文；Phase2 = Qdrant 按维度检索（可降级）。
 * 1:1 简化版 supplement.synthesize_diagnosis_knowledge（跳过 registry 观测字段）。
 */
export async function synthesizeDiagnosisKnowledge(opts: {
  symptom: string; dbType: string; errorCode?: string; bknContext?: Record<string, string> | null; topK?: number;
}): Promise<{
  summary: string
  must_know: { critical_params: Array<{ name: string; value: string }>; error_codes: string[]; paths: string[]; flags: string[] }
  dimensions: Array<{ name: string; snippets: Array<Record<string, unknown>> }>
}> {
  const { symptom, dbType, bknContext } = opts
  const topK = opts.topK ?? 3
  const dimensions: Array<{ name: string; snippets: Array<Record<string, unknown>> }> = []
  for (const dim of KNOWLEDGE_DIM_QUERIES) {
    const query = [symptom, dbType, dim].filter(Boolean).join(' ')
    const snippets: Array<Record<string, unknown>> = []
    try {
      const hits = await searchFull(query, topK, true)
      for (const h of hits) {
        snippets.push({ content: String(h.content ?? '').slice(0, 300), score: h.score ?? 0, source: h.source ?? '', id: h.id })
      }
    } catch {
      // 检索不可用：该维度为空（优雅降级，BKN 部分仍有效）
    }
    dimensions.push({ name: dim, snippets })
  }
  // 按可操作性对每维度内部 snippet 排序（1:1 py，通用不依赖 DB/症状）
  for (const dim of dimensions) {
    if (dim.snippets.length) {
      dim.snippets.sort((a, b) => {
        const sa = actionabilityScore(String(a.content ?? '')) * 1000 + Number(a.score ?? 0)
        const sb = actionabilityScore(String(b.content ?? '')) * 1000 + Number(b.score ?? 0)
        return sb - sa // 降序（py reverse=True + tuple 排序等价：actionability 主序，score 次序）
      })
    }
  }
  // 从所有 snippets 中提取通用关键事实（1:1 py，不做语义解释）
  const mustKnow = extractMustKnow(dimensions)
  const totalSnippets = dimensions.reduce((n, d) => n + d.snippets.length, 0)
  const parts: string[] = []
  if (bknContext) parts.push(`BKN 风险上下文(${Object.keys(bknContext).length - 1} 项)`)
  parts.push(`${dimensions.filter((d) => d.snippets.length).length}/${dimensions.length} 维度检索片段(${totalSnippets})`)
  return { summary: `整理了 ${dbType || '(未知库)'} ${symptom} 的排查知识：${parts.join(' + ')}。`, must_know: mustKnow, dimensions }
}
