/**
 * riskGuard.ts — 代码级风险护栏（DSH 版）
 *
 * 移植自 plugin/risk_guard.py (v1.6, B1: 规则 BKN 驱动)：
 * 将 bkn/risks/constraints.bkn 中类型为 state_prerequisite 的约束自动翻译为
 * 代码校验，经 DSH `tools/pre-execute` 策略在动作执行前拦截。
 *
 * 规则来源（不再硬编码）：解析 constraints.bkn 表格行 → 只取
 * state_prerequisite → 由约束ID 命名约定推导 forbidden_states；
 * 解析失败/为空时回退内置兜底规则（保证护栏不失效）。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface RiskRule {
  action: string
  object: string
  forbiddenStates: Set<string>
  severity: string
  errorCode: string
  /** Stage B 门控：severity==critical 且 errorCode 非空才可阻断（对齐 Hermes L2 集成阶段B）。 */
  blockable: boolean
  message: string
  /** 约束类型（constraints.bkn「类型」列）：state_prerequisite/forbidden_sequence/threshold/... */
  riskType?: string
  /** 语义为顺序类（无 _STATE 后缀可推导）：登记供会话时序判定（阶段D，数据休眠）。 */
  sequenceSemantic?: boolean
  /** 装配来源：graph_edges / fallback_assoc / fallback。 */
  source?: string
}

export interface RiskCheck {
  passed: boolean
  ruleId: string | null
  blockReason: string | null
  action: string
  state: string
  severity: string | null
  errorCode: string | null
  blockable: boolean | null
  /** 规则装配来源：graph_edges / fallback_assoc / fallback。 */
  source?: string
}

// ── 对象状态全集（硬编码回退；objects/*.bkn 状态机解析优先）──
const FALLBACK_OBJECT_STATES: Record<string, Set<string>> = {
  syncrule: new Set(['RUNNING', 'FULLSYNC', 'ABNORMAL', 'STOPPED']),
  worknode: new Set(['ONLINE', 'OFFLINE']),
  dbnode: new Set(['NORMAL', 'ABNORMAL']),
}

// 运行族状态：cannot_<verb>_RUNNING 这类约束应同时覆盖 RUNNING 族全部成员
// （BKN 无运行族 kv 声明时的硬编码回退，与 Hermes 相同）
const FALLBACK_STATE_FAMILY: Record<string, Set<string>> = {
  RUNNING: new Set(['RUNNING', 'FULLSYNC']),
}

// 状态 → 归属对象（硬编码回退；解析成功时构建反向索引）
const FALLBACK_STATE_OWNER: Record<string, string> = {
  ONLINE: 'worknode', OFFLINE: 'worknode',
  NORMAL: 'dbnode',
  RUNNING: 'syncrule', FULLSYNC: 'syncrule',
  ABNORMAL: 'syncrule', STOPPED: 'syncrule',
}

/** 解析后的状态集结构（对齐 Hermes _parse_object_states 输出）。 */
interface ObjectStates {
  states: Set<string>
  families: Record<string, Set<string>>
  stateOwner: Record<string, string>
}

/**
 * 解析 objects/*.bkn 状态机表（对齐 Hermes _parse_object_states）：
 *   1. syncrule: | 当前状态 | 允许操作 | 禁止操作 |
 *   2. dbnode:   | 状态 | 说明 | 用于规则 |
 *   3. worknode: 无状态表（ASCII 图），解析不出 → 调用方回退硬编码。
 * 另解析「运行族: X={...}」kv 声明（BKN 当前缺失 → 硬编码回退补入）。
 */
function parseObjectStates(bknRoot: string): Record<string, ObjectStates> {
  const result: Record<string, ObjectStates> = {}
  const objectsDir = join(bknRoot, 'objects')
  let files: string[]
  try {
    files = readdirSync(objectsDir).filter((f) => f.endsWith('.bkn')).sort()
  } catch {
    return result
  }
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(objectsDir, file), 'utf8')
    } catch {
      continue
    }
    const obj = file.replace(/\.bkn$/, '').toLowerCase()
    const states = new Set<string>()
    const families: Record<string, Set<string>> = {}

    // ── 状态机段落内找表格 ──
    let inStateMachine = false
    for (const line of text.split('\n')) {
      if (line.includes('## 状态机') || line.includes('## 状态约束')) {
        inStateMachine = true
        continue
      }
      if (inStateMachine && line.startsWith('## ')) break
      if (inStateMachine && line.includes('|')) {
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean)
        // 表头/分隔行
        if (!cells.length || (cells[0].includes('状态') && (cells.length > 1 ? cells[1].includes('允许') : true))) continue
        if (!cells[0] || cells[0].startsWith('-')) continue
        const state = cells[0].toUpperCase()
        if (/^[A-Z][A-Z0-9_]*$/.test(state)) states.add(state)
      }
    }

    // ── 运行族声明（kv 行）: > 运行族: RUNNING={RUNNING,FULLSYNC} ──
    for (const m of text.matchAll(/运行族[:：][ \t]*([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*\{([^}]+)\}/g)) {
      const parent = m[1].trim()
      const children = m[2].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      if (parent && children.length) families[parent] = new Set(children)
    }

    if (states.size) result[obj] = { states, families, stateOwner: {} }
  }

  // ── 构建 state → owner 反向索引（全库扫描）──
  const stateOwner: Record<string, string> = {}
  for (const [obj, info] of Object.entries(result)) {
    for (const st of info.states) {
      if (!(st in stateOwner)) stateOwner[st] = obj
    }
  }
  for (const info of Object.values(result)) info.stateOwner = { ...stateOwner }
  return result
}

let statesCache: Record<string, ObjectStates> | null = null

function buildFallbackStates(): Record<string, ObjectStates> {
  const result: Record<string, ObjectStates> = {}
  for (const [obj, states] of Object.entries(FALLBACK_OBJECT_STATES)) {
    result[obj] = {
      states: new Set(states),
      families: Object.fromEntries(Object.entries(FALLBACK_STATE_FAMILY).map(([k, v]) => [k, new Set(v)])),
      stateOwner: { ...FALLBACK_STATE_OWNER },
    }
  }
  return result
}

/** 获取状态集缓存；解析不完整/失败回退硬编码（对齐 Hermes _get_states）。 */
function getStates(bknRoot: string): Record<string, ObjectStates> {
  if (statesCache) return statesCache
  try {
    const parsed = parseObjectStates(bknRoot)
    if (parsed && 'syncrule' in parsed && 'dbnode' in parsed) {
      // 补充硬编码回退（worknode 无表，从硬编码补）
      for (const obj of Object.keys(FALLBACK_OBJECT_STATES)) {
        if (!(obj in parsed)) {
          parsed[obj] = { states: new Set(FALLBACK_OBJECT_STATES[obj]), families: {}, stateOwner: {} }
        }
      }
      // 合并运行族：BKN 声明优先，硬编码按"族状态归属哪个对象"补入该对象
      // （族只在目标状态所属的对象内生效，避免全局族污染其他对象的推导）
      const allOwner: Record<string, string> = {}
      for (const [obj, info] of Object.entries(parsed)) {
        for (const st of info.states) {
          if (!(st in allOwner)) allOwner[st] = obj
        }
      }
      for (const [parent, children] of Object.entries(FALLBACK_STATE_FAMILY)) {
        const owner = allOwner[parent]
        if (owner && !(parent in parsed[owner].families)) {
          parsed[owner].families[parent] = new Set(children)
        }
      }
      for (const info of Object.values(parsed)) info.stateOwner = { ...allOwner }
      statesCache = parsed
      return statesCache
    }
    console.warn('[bkn-plugin] objects/*.bkn 状态机解析不完整, 使用硬编码状态集')
    statesCache = buildFallbackStates()
  } catch (e) {
    console.warn(`[bkn-plugin] objects/*.bkn 状态机解析失败(${e}), 使用硬编码状态集`)
    statesCache = buildFallbackStates()
  }
  return statesCache
}

// 关联列「对象.动作」→ action 规范名
const ASSOC_TO_ACTION: Record<string, string> = {
  'SyncRule.delete': 'delete_sync_rule',
  'SyncRule.modify': 'modify_sync_rule',
  'SyncRule.restart': 'restart_sync_rule',
  'SyncRule.start': 'start_sync_rule',
  'SyncRule.stop': 'stop_sync_rule',
  'SyncRule.create': 'create_sync_rule',
  'DatabaseNode.create': 'register_db',
  'WorkerNode.activate': 'activate_node',
}

// 兜底规则（BKN 解析失败时使用）
const FALLBACK_RULES: Record<string, Omit<RiskRule, 'forbiddenStates'> & { forbiddenStates: string[] }> = {
  cannot_delete_RUNNING: {
    action: 'delete_sync_rule', object: 'syncrule',
    forbiddenStates: ['RUNNING', 'FULLSYNC'], severity: 'critical', errorCode: '-4071',
    message: '规则处于 {state} 状态，禁止删除。请先安全 stop，再执行删除。',
  },
  worknode_must_be_ONLINE: {
    action: 'register_db', object: 'worknode',
    forbiddenStates: ['OFFLINE'], severity: 'critical', errorCode: '-4016',
    message: '工作节点处于 {state} 状态，禁止注册数据库节点 (-4016)。请先恢复节点在线。',
  },
  cannot_restart_ABNORMAL: {
    action: 'restart_sync_rule', object: 'syncrule',
    forbiddenStates: ['ABNORMAL'], severity: 'critical', errorCode: '-4031',
    message: '规则处于 ABNORMAL 状态，禁止直接 restart (-4031)。请先安全 stop、修复根因后再恢复。',
  },
}

// 动作别名 → 规范 action 名
const ACTION_ALIASES: Record<string, string> = {
  delete_rule: 'delete_sync_rule', remove_rule: 'delete_sync_rule', delete_sync_rule: 'delete_sync_rule',
  modify_rule: 'modify_sync_rule', modify_sync_rule: 'modify_sync_rule',
  start_rule: 'start_sync_rule', start_sync_rule: 'start_sync_rule',
  stop_rule: 'stop_sync_rule', stop_sync_rule: 'stop_sync_rule',
  register_database: 'register_db', register_db: 'register_db', create_db_node: 'register_db',
  create_sync_rule: 'create_sync_rule', create_rule: 'create_sync_rule',
  restart_rule: 'restart_sync_rule', restart_sync_rule: 'restart_sync_rule',
  activate_node: 'activate_node',
}

// terminal/execute_code 命令中的 i2stream 管理操作指纹 → action
const COMMAND_PATTERNS: Array<[RegExp, string]> = [
  [/delete[^\n]{0,40}(rule|sync)/i, 'delete_sync_rule'],
  [/(rule|sync)[^\n]{0,40}delete/i, 'delete_sync_rule'],
  [/register[^\n]{0,40}(db|database|node)/i, 'register_db'],
  [/restart[^\n]{0,40}(rule|sync)/i, 'restart_sync_rule'],
  [/(rule|sync)[^\n]{0,40}restart/i, 'restart_sync_rule'],
  [/modify[^\n]{0,40}(rule|sync)/i, 'modify_sync_rule'],
  [/start[^\n]{0,40}(rule|sync)/i, 'start_sync_rule'],
  [/stop[^\n]{0,40}(rule|sync)/i, 'stop_sync_rule'],
]

/** DSH 命令执行类工具的默认名单（pre-execute 拦截对象）。
 * 对齐 Hermes（只拦终端/执行类）：不含 write/edit/patch——对源码/文档编辑做
 * 命令指纹必然误伤（文本提及受限词即触发），文件操作类工具不参与指纹识别。 */
export const DEFAULT_MUTATING_TOOLS = ['bash', 'run_code', 'terminal', 'execute_code', 'shell']

// 约束ID 推导正则
const RE_CANNOT_STATE = /^cannot_[a-z]+_([A-Z][A-Z0-9_]*)$/
const RE_CANNOT_NOT_STATE = /^cannot_[a-z]+_not_([A-Z][A-Z0-9_]*)$/
const RE_MUST_BE_STATE = /_must_be_([A-Z][A-Z0-9_]*)$/
const RE_TRAILING_STATE = /_([A-Z][A-Z0-9_]*)$/

function deriveForbiddenStates(ruleId: string, obj: string, states: Record<string, ObjectStates>): Set<string> {
  const objStates = states[obj]?.states ?? new Set<string>()
  let m = RE_CANNOT_NOT_STATE.exec(ruleId)
  if (m) return new Set([...objStates].filter((s) => s !== m![1]))

  m = RE_CANNOT_STATE.exec(ruleId)
  if (m) {
    const state = m[1]
    const family = states[obj]?.families[state] ?? new Set([state])
    return objStates.size ? new Set([...family].filter((s) => objStates.has(s))) : family
  }

  m = RE_MUST_BE_STATE.exec(ruleId) ?? RE_TRAILING_STATE.exec(ruleId)
  if (m) {
    const state = m[1]
    const owner = states[state]?.stateOwner[state] ?? obj
    return new Set([...(states[owner]?.states ?? new Set<string>())].filter((s) => s !== state))
  }
  return new Set()
}

/** 解析 relations/action_routing.bkn 的 constrained_by/risks_of 映射边（1:1 Hermes _parse_action_edges）。 */
export function parseActionEdges(bknRoot: string): { constraints: Record<string, string[]>; risks: Record<string, string[]> } {
  const constraints: Record<string, string[]> = {}
  const risks: Record<string, string[]> = {}
  let text: string
  try {
    text = readFileSync(join(bknRoot, 'relations', 'action_routing.bkn'), 'utf8')
  } catch {
    return { constraints, risks }
  }
  const pat = /`([^`]+)`[ \t]*→[ \t]*`([^`]+)`/
  let currentRel: 'constrained_by' | 'risks_of' | null = null
  for (const line of text.split('\n')) {
    if (line.includes('关系类型')) {
      currentRel = line.includes('constrained_by') ? 'constrained_by' : line.includes('risks_of') ? 'risks_of' : null
      continue
    }
    if (currentRel && line.trim().startsWith('-')) {
      const m = pat.exec(line.split('#')[0] ?? '')
      if (!m) continue
      let src = m[1]!.trim()
      if (src.startsWith('action:')) src = src.slice('action:'.length)
      const tgt = m[2]!.trim()
      const bucket = currentRel === 'constrained_by' ? constraints : risks
      ;(bucket[src] ??= []).push(tgt)
    }
  }
  return { constraints, risks }
}

interface ConstraintDetail {
  riskName: string
  riskType: string
  assoc: string
  text: string
}

/** 解析 risks/constraints.bkn 全部行 → {ruleId: 详情}（1:1 Hermes _parse_constraints_detail）。 */
export function parseConstraintsDetail(bknRoot: string): Record<string, ConstraintDetail> {
  const details: Record<string, ConstraintDetail> = {}
  let text: string
  try {
    text = readFileSync(join(bknRoot, 'risks', 'constraints.bkn'), 'utf8')
  } catch {
    return details
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || line.includes('约束ID') || line.includes('---')) continue
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean)
    if (cells.length < 5) continue
    const [riskName, ruleId, riskType, assoc, text_] = cells as [string, string, string, string, string]
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(ruleId)) continue
    details[ruleId] = { riskName, riskType, assoc, text: text_ }
  }
  return details
}

/** 可进拦截的约束类型白名单（Hermes _STATICALLY_DECIDABLE_TYPES 1:1）。 */
const STATICALLY_DECIDABLE_TYPES = new Set(['state_prerequisite', 'forbidden_sequence', 'threshold'])

function objectFromAssoc(assoc: string, action: string): string {
  if (assoc && assoc.includes('.')) {
    return assoc.split('.')[0]!.toLowerCase().replace('databasenode', 'dbnode').replace('workernode', 'worknode')
  }
  return action.includes('rule') ? 'syncrule' : action.includes('node') ? 'worknode' : 'dbnode'
}

/** 三源 join 装配规则（1:1 Hermes _assemble_rules）：图边关联 + 约束详情 + 状态机推导。 */
function assembleRules(bknRoot: string, states: Record<string, ObjectStates>): Record<string, RiskRule> {
  const { constraints: edgeConstraints } = parseActionEdges(bknRoot)
  const details = parseConstraintsDetail(bknRoot)
  const rules: Record<string, RiskRule> = {}

  // 关联源：图边优先，为空回退硬编码关联列
  const actionToRules: Record<string, string[]> = {}
  let assocSource: string
  if (Object.keys(edgeConstraints).length) {
    for (const [action, rids] of Object.entries(edgeConstraints)) {
      actionToRules[action] = [...(actionToRules[action] ?? []), ...rids]
    }
    assocSource = 'graph_edges'
  } else {
    assocSource = 'fallback_assoc'
    for (const [assoc, action] of Object.entries(ASSOC_TO_ACTION)) {
      for (const [ruleId, det] of Object.entries(details)) {
        if (det.assoc === assoc) (actionToRules[action] ??= []).push(ruleId)
      }
    }
  }

  for (const [action, ruleIds] of Object.entries(actionToRules)) {
    for (const ruleId of ruleIds) {
      if (rules[ruleId]) continue
      const det = details[ruleId]
      if (!det) continue // 图边指向的约束在表中无定义 → 跳过（保底不误拦）
      if (!STATICALLY_DECIDABLE_TYPES.has(det.riskType)) continue // data_loss/param_constraint 不进拦截
      const obj = objectFromAssoc(det.assoc, action)
      let forbidden: Set<string>
      let seqSemantic: boolean
      if (det.riskType === 'state_prerequisite') {
        forbidden = deriveForbiddenStates(ruleId, obj, states)
        seqSemantic = !forbidden.size // 无 _STATE 后缀可推导 → 降级为会话时序语义
      } else {
        // forbidden_sequence / threshold：不走状态推导（阶段 D/E 判定，数据休眠）
        forbidden = new Set()
        seqSemantic = det.riskType === 'forbidden_sequence'
      }
      const em = /\((-[0-9]{4})\)/.exec(det.text)
      const message = det.text.replace(/\*\*/g, '').trim()
      const errorCode = em?.[1] ?? ''
      rules[ruleId] = {
        action, object: obj, forbiddenStates: forbidden,
        severity: 'critical', errorCode,
        riskType: det.riskType, sequenceSemantic: seqSemantic, source: assocSource,
        message: message.includes('{state}')
          ? message
          : `违反约束 [${det.riskName}]: ${message}（当前状态: {state}）`,
      }
    }
  }
  return rules
}

let rulesCache: Record<string, RiskRule> | null = null

export function loadRules(bknRoot: string): Record<string, RiskRule> {
  if (rulesCache) return rulesCache
  const states = getStates(bknRoot)
  let merged: Record<string, RiskRule>
  try {
    const parsed = assembleRules(bknRoot, states)
    merged = { ...FALLBACK_RULES }
    for (const [id, r] of Object.entries(parsed)) {
      merged[id] = { ...r, forbiddenStates: new Set(r.forbiddenStates) }
    }
    if (!Object.keys(parsed).length) {
      console.warn('[bkn-plugin] 三源 join 未装配出规则，使用兜底规则')
    }
  } catch (e) {
    console.warn(`[bkn-plugin] BKN 规则装配失败(${e})，使用兜底规则`)
    merged = { ...FALLBACK_RULES }
  }
  for (const id of Object.keys(merged)) {
    if (merged[id].forbiddenStates instanceof Set) continue
    merged[id] = { ...merged[id], forbiddenStates: new Set(merged[id].forbiddenStates) }
  }
  // 兜底规则补 blockable（对象字面量不含该字段）
  for (const r of Object.values(merged)) {
    if (r.blockable === undefined) r.blockable = r.severity === 'critical' && r.errorCode !== ''
  }
  rulesCache = merged
  return rulesCache
}

export function resetRulesCache(): void {
  rulesCache = null
  statesCache = null
}

export function getRiskRules(bknRoot: string): Record<string, Omit<RiskRule, 'forbiddenStates'> & { forbiddenStates: string[] }> {
  const out: Record<string, Omit<RiskRule, 'forbiddenStates'> & { forbiddenStates: string[] }> = {}
  for (const [id, r] of Object.entries(loadRules(bknRoot))) {
    out[id] = { ...r, forbiddenStates: [...r.forbiddenStates].sort() }
  }
  return out
}

export function normalizeAction(action: string): string {
  const key = (action ?? '').trim()
  return ACTION_ALIASES[key] ?? key
}

export function checkActionRisk(action: string, currentState = '', bknRoot: string): RiskCheck {
  const actionNorm = normalizeAction(action)
  const state = (currentState ?? '').trim().toUpperCase()
  const rules = loadRules(bknRoot)
  const source = Object.values(rules)[0]?.source ?? 'fallback'

  for (const [ruleId, rule] of Object.entries(rules)) {
    if (rule.action !== actionNorm) continue
    if (state && rule.forbiddenStates.has(state)) {
      const msg = rule.message.includes('{state}') ? rule.message.replaceAll('{state}', state) : rule.message
      return {
        passed: false, ruleId, blockReason: msg,
        action: actionNorm, state,
        severity: rule.severity, errorCode: rule.errorCode,
        blockable: rule.blockable, source: rule.source ?? source,
      }
    }
  }
  return { passed: true, ruleId: null, blockReason: null, action: actionNorm, state, severity: null, errorCode: null, blockable: null, source }
}

function detectActionFromCommand(command: string): string {
  for (const [pattern, action] of COMMAND_PATTERNS) {
    if (pattern.test(command ?? '')) return action
  }
  return ''
}

export interface GuardDecision {
  action: string
  state: string
  ruleId: string | null
  reason: string | null
  blockable: boolean
}

/**
 * DSH pre-execute 策略决策：受控动作执行前的风险拦截。
 *
 * 返回 reason=null 表示放行；否则返回阻断原因。
 * 只拦截明确命中 i2stream 管理语义的调用（保守识别）。
 * Stage B 门控：仅 blockable（critical + error_code 非空）规则在 block=true 时阻断；
 * 非 blockable 命中放行并记 warn（对齐 Hermes 阶段B 灰度口径）。
 *
 * @param toolName  DSH 命令执行类工具名（bash/run_code/...，见 DEFAULT_MUTATING_TOOLS）
 * @param args      工具参数（command/code/content 等）
 * @param opts      guardEnabled / guardBlock / mutatingTools
 */
export function guardDecision(
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    enabled: boolean
    block: boolean
    bknRoot: string
    mutatingTools: string[]
    /** 规则源（默认 bkn）：whitelist=只放行白名单（SQL 域）；none=关闭 */
    ruleSource?: 'bkn' | 'whitelist' | 'none'
    /** whitelist 规则文件路径（ruleSource=whitelist 时必需；空白名单 fail-closed 全 deny） */
    whitelistPath?: string
  },
): GuardDecision | null {
  if (!opts.enabled) return null
  if (opts.ruleSource === 'none') return null
  if (opts.ruleSource === 'whitelist') {
    return whitelistGuardDecision(toolName, args, { enabled: opts.enabled, block: opts.block, whitelistPath: opts.whitelistPath ?? '' })
  }
  const a = args ?? {}

  // 路径1: 显式动作参数（未来 i2agent MCP 暴露动作 Tool 时）
  let action = normalizeAction(String(a.operation ?? a.action ?? ''))
  let state = String(a.state ?? a.current_state ?? a.rule_state ?? '')

  // 路径2: mutating tool 的命令文本识别
  if (!action && opts.mutatingTools.includes(toolName)) {
    const command = String(a.command ?? a.code ?? a.content ?? a.new_string ?? '')
    action = detectActionFromCommand(command)
    if (!state) {
      const m = command.match(/(?<![a-zA-Z0-9_])(RUNNING|FULLSYNC|ABNORMAL|STOPPED|OFFLINE|ONLINE|NORMAL)(?![a-zA-Z0-9_])/i)
      if (m) state = m[1]
    }
  }

  if (!action) return null // 非受控动作，放行

  const check = checkActionRisk(action, state, opts.bknRoot)
  if (check.passed) return null

  const blockable = check.blockable === true
  const reason = `[RiskGuard:${check.ruleId}] ${check.blockReason}`
  if (!opts.block || !blockable) {
    console.warn(`[bkn-plugin] RiskGuard(${opts.block && !blockable ? 'advisory' : 'gray'}) would block: tool=${toolName} action=${action} state=${state} rule=${check.ruleId} blockable=${blockable}`)
    return null
  }
  console.warn(`[bkn-plugin] RiskGuard blocked: tool=${toolName} action=${action} state=${state} rule=${check.ruleId}`)
  return { action, state, ruleId: check.ruleId, reason, blockable }
}

// ── 规则源：whitelist（proposal §3.4 通用化；首个消费方 = SQL 转换域）──
// 语义与 BKN 相反："只放行"——script 类工具仅放行白名单命令（其余一律 deny）；
// write/edit 类仅放行白名单路径前缀。无状态机/无错误码，规则 = 一个 yaml + 匹配函数。

export interface WhitelistRules {
  /** 命令白名单：字面前缀，或 `re:` 前缀的正则（如 re:^obclient\b） */
  commands: string[]
  /** 写路径白名单：前缀匹配（/tmp 放行 /tmp/x.sql） */
  write_paths: string[]
}

const WHITELIST_TOOLS = new Set(['bash', 'run_code', 'terminal', 'execute_code', 'shell'])
const WRITE_TOOLS = new Set(['write', 'edit', 'patch'])

/** 手写解析（dsh-plugin 零依赖惯例）：`commands: [a, b]` / `write_paths: [/x, /y]` 两行结构 */
export function parseWhitelist(text: string): WhitelistRules {
  const pick = (key: string): string[] => {
    const m = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(text)
    if (!m) return []
    return m[1]!.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  return { commands: pick('commands'), write_paths: pick('write_paths') }
}

const whitelistCache = new Map<string, WhitelistRules>()

export function loadWhitelist(path: string): WhitelistRules {
  const hit = whitelistCache.get(path)
  if (hit) return hit
  let rules: WhitelistRules = { commands: [], write_paths: [] }
  try { rules = parseWhitelist(readFileSync(path, 'utf8')) } catch { /* 缺文件 → 空白名单（全 deny，fail-closed） */ }
  whitelistCache.set(path, rules)
  return rules
}

export function resetWhitelistCache(): void {
  whitelistCache.clear()
}

export function commandAllowed(command: string, rules: WhitelistRules): boolean {
  const cmd = command.trim()
  if (!cmd) return true // 空命令无载荷
  for (const entry of rules.commands) {
    if (entry.startsWith('re:')) {
      try { if (new RegExp(entry.slice(3)).test(cmd)) return true } catch { /* 坏正则忽略 */ }
    } else if (cmd === entry || cmd.startsWith(entry + ' ') || cmd.startsWith(entry + ';') || cmd.startsWith(entry + '\n')) {
      return true
    }
  }
  return false
}

export function pathAllowed(path: string, rules: WhitelistRules): boolean {
  if (!path) return true
  for (const p of rules.write_paths) {
    if (path === p || path.startsWith(p.replace(/\/+$/, '') + '/')) return true
  }
  return false
}

/** whitelist 规则源的 pre-execute 决策（block 语义沿用：block=false → gray warn 放行） */
export function whitelistGuardDecision(
  toolName: string,
  args: Record<string, unknown>,
  opts: { enabled: boolean; block: boolean; whitelistPath: string },
): GuardDecision | null {
  if (!opts.enabled) return null
  const a = args ?? {}
  const rules = loadWhitelist(opts.whitelistPath)
  let hit: string | null = null
  let payload = ''
  if (WHITELIST_TOOLS.has(toolName)) {
    payload = String(a.command ?? a.code ?? a.content ?? '')
    if (payload && !commandAllowed(payload, rules)) hit = `命令不在白名单（commands: ${rules.commands.join(', ') || '空'}）`
  } else if (WRITE_TOOLS.has(toolName)) {
    const path = String(a.path ?? a.file_path ?? a.filePath ?? '')
    payload = path
    if (path && !pathAllowed(path, rules)) hit = `写路径不在白名单（write_paths: ${rules.write_paths.join(', ') || '空'}）`
  }
  if (!hit) return null
  const reason = `[RiskGuard:whitelist] ${toolName}: ${hit}`
  if (!opts.block) {
    console.warn(`[bkn-plugin] RiskGuard(whitelist/gray) would block: tool=${toolName} payload=${payload.slice(0, 80)}`)
    return null
  }
  console.warn(`[bkn-plugin] RiskGuard(whitelist) blocked: tool=${toolName} payload=${payload.slice(0, 80)}`)
  return { action: `whitelist:${toolName}`, state: '', ruleId: 'whitelist', reason, blockable: true }
}
