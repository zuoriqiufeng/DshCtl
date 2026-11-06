/**
 * planCheck.ts — check_plan 计划可行性检查（批次 C1：对齐 plugin/plan_check.py）
 *
 * 按本体里**已登记动作的前置与约束**做机械核对，回答「这串操作能不能这么走」。
 * 只做机械核对（不推理、不猜）：
 *   · `prerequisites: [X must be Y, ...]` → 与调用方给的 `states` 比对；
 *   · `constraints: [cid, ...]` → 查 `risks/constraints.bkn` 登记表，回类型与约束原文；
 *   · 中文/不可解析的前置 → 进 `todo`（如实说「需人工确认」，不编结论）。
 *
 * 纯函数、无状态、无副作用（BKN **只读**）。
 * 约束登记表复用 riskGuard.parseConstraintsDetail（单一实现源，避免双源漂移）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseConstraintsDetail } from './riskGuard.ts'

const _ROW = /^\|[^|]+\|[ \t]*([a-z_][a-z0-9_]*)[ \t]*\|[ \t]*([a-z_]+)[ \t]*\|[ \t]*(.+?)[ \t]*\|$/
const _REQ = /([A-Za-z_][A-Za-z0-9_]*)[ \t]+must[ \t]+be[ \t]+([A-Za-z_][A-Za-z0-9_]*)/

interface ActionSeg {
  name: string
  capability: string
  file: string
  prereq: string[]
  constraints: string[]
  aliases: string[]
}

/** `- key: [a, b, c]` → ["a", "b", "c"]（对齐 py _list：逐项去方括号）。 */
function _list(line: string): string[] {
  const col = line.indexOf(':')
  if (col === -1) return []
  return line
    .slice(col + 1)
    .split(',')
    .map((x) => x.trim().replace(/^\[/, '').replace(/\]$/, ''))
    .filter(Boolean)
}

/** 解析 bkn/actions/*.bkn：`## Action: <name>` 段的 aliases/prerequisites/constraints。 */
function _actionSegments(bknRoot: string): Map<string, ActionSeg> {
  const out = new Map<string, ActionSeg>()
  const dir = join(bknRoot, 'actions')
  if (!existsSync(dir)) return out
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.bkn')).sort()
  } catch {
    return out
  }
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    let seg: ActionSeg | null = null
    for (const ln of text.split('\n')) {
      const s = ln.trim()
      if (s.startsWith('## Action: ')) {
        seg = { name: s.slice('## Action: '.length).trim(), capability: '', file: f, prereq: [], constraints: [], aliases: [] }
        out.set(seg.name, seg)
        continue
      }
      if (!seg) continue
      if (s.startsWith('- aliases:')) seg.aliases = _list(s)
      else if (s.startsWith('- prerequisites:')) seg.prereq = _list(s)
      else if (s.startsWith('- constraints:')) seg.constraints = _list(s)
      else if (s.startsWith('- capability:')) seg.capability = s.slice('- capability:'.length).trim()
    }
  }
  return out
}

/** 解析 risks/constraints.bkn 约束登记表（复用 riskGuard 的 detailMap：cid → {type/text}）。 */
function _constraints(bknRoot: string): Record<string, { type: string; text: string }> {
  try {
    return parseConstraintsDetail(bknRoot)
  } catch {
    return {}
  }
}

function _resolve(actions: Map<string, ActionSeg>, name: string): ActionSeg | null {
  if (actions.has(name)) return actions.get(name)!
  for (const seg of actions.values()) {
    if (seg.aliases.includes(name) || seg.capability === name) return seg
  }
  return null
}

export interface PlanCheckStep {
  action?: unknown
  state?: unknown
}

export interface PlanCheckArgs {
  steps?: PlanCheckStep[]
  states?: Record<string, unknown>
}

export interface PlanCheckResult {
  ok: boolean
  checked_steps: number
  violations: Array<Record<string, unknown>>
  advisories: Array<Record<string, unknown>>
  todo: Array<Record<string, unknown>>
}

/** check_plan 主入口：机械核对动作序列（py plan_check.check_plan 1:1，去掉观测账目）。 */
export function checkPlan(bknRoot: string, args: PlanCheckArgs): PlanCheckResult {
  const steps = Array.isArray(args?.steps) ? args.steps : []
  const states = (args?.states ?? {}) as Record<string, unknown>
  const actions = _actionSegments(bknRoot)
  const constraints = _constraints(bknRoot)
  const violations: Array<Record<string, unknown>> = []
  const advisories: Array<Record<string, unknown>> = []
  const todo: Array<Record<string, unknown>> = []
  steps.forEach((step, i) => {
    const idx = i + 1
    const name = String((step as PlanCheckStep)?.action ?? '').trim()
    const seg = _resolve(actions, name)
    if (!seg) {
      todo.push({ step: idx, why: '动作未在本体登记：' + name })
      return
    }
    const state = String((step as PlanCheckStep)?.state ?? '').trim()
    seg.prereq.forEach((req, ri) => {
      const m = _REQ.exec(req)
      if (!m) {
        todo.push({ step: idx, why: '前置需人工确认：' + req })
        return
      }
      const obj = m[1]!
      const want = m[2]!
      let have: unknown = states[obj]
      if (have === null || have === undefined) {
        if (ri === 0 && state) have = state
      }
      if (have === null || have === undefined) {
        todo.push({ step: idx, why: `前置需人工确认：${req}（未提供 ${obj} 状态）` })
        return
      }
      if (String(have).toUpperCase() !== want.toUpperCase()) {
        violations.push({
          step: idx, rule: 'state_prerequisite',
          message: `${seg!.name} 要求 ${obj}=${want}（现为 ${have}）`,
          evidence: `${seg!.file} · prerequisites`,
        })
      }
    })
    for (const cid of seg.constraints) {
      const info = constraints[cid] ?? {}
      advisories.push({
        step: idx, constraint: cid,
        type: (info as { riskType?: string }).riskType ?? (info as { type?: string }).type,
        text: (info as { text?: string }).text,
        evidence: 'risks/constraints.bkn',
      })
    }
  })
  return { ok: violations.length === 0, checked_steps: steps.length, violations, advisories, todo }
}