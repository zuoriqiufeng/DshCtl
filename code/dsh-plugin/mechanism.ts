/**
 * mechanism.ts — diagnose_mechanism 机制诊断（批次 C2：对齐 plugin/tools.py diagnose_mechanism
 *                + plugin/mechanism_detect.py + plugin/mechanisms.yaml）
 *
 * 现象 → 候选机制 → 收敛（29 号 §4.5 输出契约）。**只读** plugin/mechanisms.yaml 的 criterion
 * 与 convergence；结构式判据接 BKN 关系图（relations 遍历，5 类声明边）。不动 diagnose_error。
 *
 * 边界：
 *  · mechanisms.yaml 缺失/坏行 → 降级「无判据」（H-15），不抛。
 *  · manifests_as 候选召回走本模块对 relations/mechanism_causality.bkn 的**专属解析**，
 *    **不注册进全局 RELATION_TYPES**（守住对齐计划红线：不新增边类型注册）。
 *  · unknown 是**合法答案**：证据不足不许用推测填空（29 号 §4.5 硬要求 3）。
 *
 * 零依赖 YAML 子集解析（项目不依赖 yaml 库），仅覆盖本数据文件的缩进/缩进列表/内联标量形态。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RelationTraverser } from './relations.ts'
import { loadSkillManifest, defaultManifestPath } from './resolver.ts'

// ── 零依赖 YAML 子集解析（仅覆盖 mechanisms.yaml 所需形态） ──────────

function stripComment(line: string): string {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === '#' && !inQuote && i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i)
  }
  return line
}

function unquote(s: string): string {
  return s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/-$/, '')
}

/** 解析内联标量/数组：[a, "b", c] → 字符串数组；普通标量去引号；空 → ''。 */
function inlineValue(rest: string): unknown {
  const v = rest.trim()
  if (v.startsWith('[')) {
    const body = v.slice(1, v.lastIndexOf(']') === -1 ? v.length : v.lastIndexOf(']'))
    if (body.trim() === '') return []
    return body.split(',').map((x) => unquote(x)).filter((x) => x !== '')
  }
  return unquote(v)
}

interface Line { indent: number; text: string }

/**
 * 解析 indentation 块。支持：块映射（`key:`/`key: value`）、块序列（`- item`）、
 * 「- key: value + 续行映射字段」的 list-of-maps 形态、内联标量/数组。
 * 返回 object | array | string | number | boolean。失败即退化为 {}（H-15 由调用方兜底）。
 */
function parseBlockLines(lines: Line[], i: number, indent: number, out: unknown[]): [unknown, number] {
  // out[0] 接收结果，返回新的 i。具体解析交给 parseAt。
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  return parseAt(lines, i, indent)
}

function parseAt(lines: Line[], i: number, indent: number): [unknown, number] {
  if (i >= lines.length || lines[i]!.indent < indent) return [undefined, i]
  if (lines[i]!.indent > indent) {
    // 子块超出：向上归属交给调用方；这里视为空
    return [undefined, i]
  }
  if (lines[i]!.text.startsWith('-')) return parseSeq(lines, i, indent)
  return parseMap(lines, i, indent)
}

function parseSeq(lines: Line[], i0: number, indent: number): [unknown, number] {
  const arr: unknown[] = []
  let i = i0
  while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('-')) {
    const raw = lines[i]!.text.slice(1).trim()
    if (raw === '') {
      i++
      const [sub, ni] = parseAt(lines, i, indent + 2)
      arr.push(sub ?? [])
      i = ni
      continue
    }
    const m = /^([^:]+):\s*(.*)$/.exec(raw)
    if (m) {
      // list-of-maps：seed 对象 + 续行字段（indent+2）
      const obj: Record<string, unknown> = {}
      const key = m[1]!.trim()
      const rest = m[2]!
      i++
      if (rest === '') {
        const [sub, ni] = parseAt(lines, i, indent + 2)
        obj[key] = sub ?? {}
        i = ni
      } else {
        obj[key] = inlineValue(rest)
      }
      // 续行映射字段
      while (i < lines.length && lines[i]!.indent === indent + 2 && !lines[i]!.text.startsWith('-')) {
        const fm = /^([^:]+):\s*(.*)$/.exec(lines[i]!.text)
        if (!fm) { i++; continue }
        const fk = fm[1]!.trim()
        const fr = fm[2]!
        i++
        if (fr === '') {
          const [sub2, ni2] = parseAt(lines, i, indent + 4)
          obj[fk] = sub2 ?? {}
          i = ni2
        } else {
          obj[fk] = inlineValue(fr)
        }
      }
      arr.push(obj)
      continue
    }
    // 标量序列项
    arr.push(inlineValue(raw))
    i++
  }
  return [arr, i]
}

function parseMap(lines: Line[], i0: number, indent: number): [unknown, number] {
  const obj: Record<string, unknown> = {}
  let i = i0
  while (i < lines.length && lines[i]!.indent === indent && !lines[i]!.text.startsWith('-')) {
    const m = /^([^:]+):\s*(.*)$/.exec(lines[i]!.text)
    if (!m) { i++; continue }
    const key = m[1]!.trim()
    const rest = m[2]!
    i++
    if (rest === '') {
      const [sub, ni] = parseAt(lines, i, indent + 2)
      obj[key] = sub ?? {}
      i = ni
    } else {
      obj[key] = inlineValue(rest)
    }
  }
  return [obj, i]
}

export function parseMechanismsYaml(text: string): Record<string, unknown> {
  const lines: Line[] = []
  for (const raw of text.split('\n')) {
    const noComm = stripComment(raw).replace(/\s+$/, '')
    if (!noComm.trim()) continue
    const mm = /^(\s*)(.*)$/.exec(noComm)!
    lines.push({ indent: mm[1]!.length, text: mm[2]! })
  }
  const [root] = parseAt(lines, 0, 0)
  return (root ?? {}) as Record<string, unknown>
}

// ── mechanisms.yaml 数据访问（对齐 mechanism_detect.py） ──────────

export interface Criterion {
  tier?: string
  type?: string
  patterns?: string[]
  fields?: string[]
  condition?: string
  statement?: string
  evidenceStrength?: string
  hardenedBy?: string
  counterCheck?: string
  counterPatterns?: string[]
  evidence?: string
}

export interface Mechanism {
  id: string
  kind: string
  criteriaTier?: string
  necessaryCriteria?: string[]
  criterion?: Criterion[]
  sampling?: { method?: string; thresholds?: string[] }
}

let mechCache: Record<string, unknown> | null = null
let mechPathUsed = ''

function mechPath(bknRoot: string): string {
  const env = process.env.I2STREAM_MECHANISMS
  if (env) return env
  return join(dirname(bknRoot), 'plugin', 'mechanisms.yaml')
}

/** 读取 mechanisms.yaml（惰性；缺失/坏 → {}）。 */
function loadMechanisms(bknRoot: string): Record<string, unknown> {
  const p = mechPath(bknRoot)
  if (mechCache && mechPathUsed === p) return mechCache
  let data: Record<string, unknown> = {}
  try {
    if (existsSync(p)) data = parseMechanismsYaml(readFileSync(p, 'utf8'))
  } catch { /* 保持空结构 */ }
  mechCache = data
  mechPathUsed = p
  return data
}


/** 非根类机制 = 可独立出证的候选池（根类「不独立出证」，见 mechanisms.yaml entry_fields）。 */
function leafMechanisms(bknRoot: string): Mechanism[] {
  const data = loadMechanisms(bknRoot)
  const list = (data.mechanisms ?? []) as unknown[]
  return list
    .filter((m): m is Record<string, unknown> => Boolean((m as Record<string, unknown>).id))
    .map(normalizeMech)
    .filter((m) => m.kind !== '根类')
}

function mechRoots(bknRoot: string): string[] {
  const data = loadMechanisms(bknRoot)
  const list = (data.mechanisms ?? []) as unknown[]
  return list
    .filter((m): m is Record<string, unknown> => Boolean((m as Record<string, unknown>).id) && String((m as Record<string, unknown>).kind) === '根类')
    .map((m) => String(m.id))
}

function normalizeMech(raw: Record<string, unknown>): Mechanism {
  const crit = (raw.criterion ?? []) as unknown[]
  return {
    id: String(raw.id),
    kind: String(raw.kind ?? '子类'),
    criteriaTier: raw.criteria_tier != null ? String(raw.criteria_tier) : undefined,
    necessaryCriteria: (raw.necessary_criteria as unknown[] | undefined)?.map((s) => String(s)),
    criterion: crit.map((c): Criterion => {
      const cc = c as Record<string, unknown>
      return {
        tier: cc.tier != null ? String(cc.tier) : undefined,
        type: cc.type != null ? String(cc.type) : undefined,
        patterns: (cc.patterns as unknown[] | undefined)?.map((p) => String(p)),
        fields: (cc.fields as unknown[] | undefined)?.map((f) => String(f)),
        condition: cc.condition != null ? String(cc.condition) : undefined,
        statement: cc.statement != null ? String(cc.statement) : undefined,
        evidenceStrength: cc.evidence_strength != null ? String(cc.evidence_strength) : undefined,
        hardenedBy: cc.hardened_by != null ? String(cc.hardened_by) : undefined,
        counterCheck: cc.counter_check != null ? String(cc.counter_check) : undefined,
        counterPatterns: (cc.counter_patterns as unknown[] | undefined)?.map((p) => String(p)),
        evidence: cc.evidence != null ? String(cc.evidence) : undefined,
      }
    }),
    sampling: raw.sampling as Mechanism['sampling'],
  }
}

// ── manifests_as 边（专属解析 mechanism_causality.bkn；不入全局 RELATION_TYPES） ──

/** `src → tgt` 映射行抓取（对齐 relations.ts iterMappingLines 口径，支持 (abstract) 后缀）。 */
function manifestsAsEdges(bknRoot: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const p = join(bknRoot, 'relations', 'mechanism_causality.bkn')
  if (!existsSync(p)) return out
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return out
  }
  const pat = /`([^`]+)`[ \t]*→[ \t]*`([^`]+)`/
  let current: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.split('#', 1)[0]
    if (/^## Relation: /.test(line)) { current = null; continue }
    const relC = /^-\s*\*\*关系类型\*\*:\s*(.*)$/.exec(line)
    if (relC) { current = relC[1]!.trim().toLowerCase() === 'manifests_as' ? '' : null; continue }
    if (current === null) continue
    const m = pat.exec(line)
    if (m) {
      let tgt = m[2]!.trim()
      if (tgt.endsWith('(abstract)')) tgt = tgt.slice(0, -'(abstract)'.length).trim()
      const key = m[1]!.trim()
      if (!out.has(key)) out.set(key, [])
      out.get(key)!.push(tgt)
    }
  }
  return out
}

// ── 判据/收敛逻辑（对齐 tools.py diagnose_mechanism） ──────────

/** 把 <...> 占位展开为惰性通配（对齐 py _pat_match）。 */
function patMatch(pattern: string, text: string): boolean {
  if (!pattern || !text) return false
  if (pattern.indexOf('<') === -1) return text.includes(pattern)
  let rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch)
  rx = rx.replace(/<[^>]*>/g, '.+?')
  try {
    return new RegExp(rx).test(text)
  } catch {
    return false
  }
}

/** 观测条目的来源标签：`[来源]观测`；无标签归「未标注」。 */
function obsSources(observations: string[]): string[] {
  return observations.map((o) => {
    const m = /^\[([^\]]+)\]/.exec(o)
    return m ? m[1]! : '未标注'
  })
}

// 结构判据点名的既有关系类型（C-20261013-15）
const STRUCTURAL_EDGES = ['feeds', 'reads_from', 'runs_on', 'registered_on', 'supervises']

/** structural 判据：本体侧可查的「起点在声明边集上参与既有关系」半步 + 可选 affected_unit 两单元路径。 */
function structuralEvidence(
  traverser: RelationTraverser,
  node: string,
  affectedUnit?: string,
): Record<string, unknown> {
  const present: string[] = []
  for (const e of STRUCTURAL_EDGES) {
    try {
      if ((traverser.getTargets(node, e) ?? []).length || (traverser.getSources(node, e) ?? []).length) present.push(e)
    } catch {
      /* 单边失败静默 */
    }
  }
  let twoEnd: Record<string, unknown> | null = null
  if (affectedUnit) {
    try {
      const ends = walkBoth(traverser, node, STRUCTURAL_EDGES, 3)
      const found = affectedUnit in ends
      twoEnd = {
        affected_unit: affectedUnit,
        path_found: found,
        hops: found ? ends[affectedUnit] : undefined,
        note: found
          ? '两单元间存在既有关系路径'
          : '在本体**已声明边集**上未找到两单元间路径——可能是真无路径，也可能是结构边未补密',
      }
    } catch {
      twoEnd = { affected_unit: affectedUnit, path_found: null, note: '核验失败（按未知处理，不臆断）' }
    }
  }
  return {
    entry_node: node,
    declared_edges: [...STRUCTURAL_EDGES],
    present_at_entry: present,
    path_exists: present.length > 0,
    checkable: affectedUnit ? 'full' : 'partial',
    two_endpoint: twoEnd,
    note: affectedUnit
      ? `本体侧已核：起点在 ${present.join('/') || '上述边类型上均无'} 参与既有关系；并已核两单元间路径（受影响单元＝${affectedUnit}）。`
      : `本体侧已核：起点在 ${present.join('/') || '上述边类型上均无'} 参与既有关系；缺「受影响单元」，两单元路径半步仍须人给端点。`,
  }
}

/** 双向 BFS（深度限制），在声明边上找 node → affectedUnit 的最短 hop，返回 {target: hopCount}。 */
function walkBoth(
  traverser: RelationTraverser,
  node: string,
  edges: string[],
  depth: number,
): Record<string, number> {
  const ends: Record<string, number> = {}
  const visited = new Set<string>([node])
  const queue: Array<[string, number]> = [[node, 0]]
  while (queue.length) {
    const [cur, d] = queue.shift()!
    if (d >= depth) continue
    const neighbors = new Set<string>()
    for (const e of edges) {
      for (const t of traverser.getTargets(cur, e)) neighbors.add(t)
      for (const s of traverser.getSources(cur, e)) neighbors.add(s)
    }
    for (const n of neighbors) {
      if (visited.has(n)) continue
      visited.add(n)
      const nd = d + 1
      if (!(n in ends) || nd < ends[n]!) ends[n] = nd
      if (nd < depth) queue.push([n, nd])
    }
  }
  return ends
}

/** 处置锚点（两跳：本体 diagnosed_by → skill_manifest treatment_entry）；best-effort 缺席即不产出。 */
function treatmentHint(bknRoot: string, traverser: RelationTraverser, dimensions: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  try {
    const manifest = loadSkillManifest(defaultManifestPath(bknRoot))
    for (const d of dimensions || []) {
      let skills: string[] = []
      try { skills = traverser.getTargets(d, 'diagnosed_by') } catch { skills = [] }
      for (const sk of skills) {
        const item = manifest.find((m) => m.id === sk) as Record<string, unknown> | undefined
        const te = (item?.treatment_entry ?? {}) as Record<string, unknown>
        if (!te.file) continue
        out.push({
          dimension: d, skill: sk,
          skill_name: String(item?.entry ?? sk).replace(/\/+$/, '').split('/').pop() || sk,
          file: te.file, section: te.section, note: te.note,
          hint: '只给「去哪一节看」，不给命令',
        })
      }
    }
  } catch {
    return out
  }
  return out
}

// ── 主入口 ──────────

export interface MechanismArgs {
  entry?: string
  observations?: string[]
  affected_unit?: string
  max_candidates?: number
}

interface Deps {
  bknRoot: string
  resolver: {
    resolveSynonym: (s: string) => string
    normalizeErrorCode: (s: string) => string
    getRisk: (code: string, message?: string, logSource?: string) => { dimensions?: string[] } | null
  }
  traverser: RelationTraverser
}

/** diagnose_mechanism 主逻辑（py tools.diagnose_mechanism 1:1，无观测账目）。 */
export function diagnoseMechanism(deps: Deps, args: MechanismArgs): Record<string, unknown> {
  const { bknRoot, resolver, traverser } = deps
  const entry = String(args?.entry ?? '').trim()
  const observations = (args?.observations ?? []).map((o) => String(o))
  let maxC = 4
  try {
    const n = Number(args?.max_candidates)
    if (Number.isFinite(n) && n > 0) maxC = Math.min(Math.trunc(n), 10)
  } catch { maxC = 4 }
  const mechsRaw = loadMechanisms(bknRoot)
  const mechs = leafMechanisms(bknRoot).reduce<Record<string, Mechanism>>((acc, m) => { acc[m.id] = m; return acc }, {})
  const tierOrder = (mechsRaw.tier_order as unknown[] | undefined)?.map((s) => String(s)) ?? []
  const roots = mechRoots(bknRoot)

  // ① 入口归一
  let kind: string
  let node = ''
  const note: string[] = []
  const e = entry
  if (e.startsWith('process:')) { kind = 'process'; node = e }
  else if (e.includes(':')) { kind = 'node'; node = e }
  else {
    const syn = resolver.resolveSynonym(e)
    const norm = resolver.normalizeErrorCode(syn)
    if (/^-?\d{3,}$/.test(norm)) { kind = 'code'; node = norm }
    else { kind = 'symptom'; node = syn.includes(':') ? syn : 'symptom:' + syn }
  }
  let targets: string[] = []
  if (kind === 'node') {
    if (node.startsWith('error:')) { kind = 'code'; node = node.split(':', 1)[1] ?? node }
    else targets = [node]
  }
  let ctx: Record<string, unknown> | null = null
  if (kind === 'code') {
    try { ctx = resolver.getRisk(node, '', '') ?? null } catch { ctx = null }
    targets = Array.isArray(ctx?.dimensions) ? [...(ctx.dimensions as string[])] : []
  } else if (kind === 'symptom' || kind === 'process') {
    targets = [node]
  }

  // ② 候选召回
  const manifests = manifestsAsEdges(bknRoot)
  let narrowed = false
  let candIds: string[] = []
  if (targets.length) {
    const want = new Set(targets)
    const hit = Object.keys(mechs).filter((id) => (manifests.get(id) ?? []).some((t) => want.has(t)))
    if (hit.length) { candIds = hit; narrowed = true }
  }
  if (!candIds.length) candIds = Object.keys(mechs)
  const pool = candIds.filter((id) => mechs[id]).slice(0, maxC)
  const poolFinal = pool.length ? pool : Object.keys(mechs).slice(0, maxC)

  // ③ 逐候选评估
  const obsText = observations.join('\n')
  const srcs = obsSources(observations)
  const results: Array<Record<string, unknown>> = []
  const counters: Array<Record<string, unknown>> = []
  for (const mid of poolFinal) {
    const m = mechs[mid] ?? ({} as Mechanism)
    const hits: Array<Record<string, unknown>> = []
    for (const c of m.criterion ?? []) {
      const t = c.type
      const strength = c.evidenceStrength
      let matched: string[] = []
      let weak = false
      if (t === 'log_text' || t === 'log_text+sequence') {
        matched = (c.patterns ?? []).filter((p) => patMatch(p, obsText))
      } else if (t === 'field_condition') {
        matched = (c.fields ?? []).filter((f) => f && obsText.includes(f))
        weak = matched.length > 0
      } else if (t === 'structural') {
        continue
      }
      if (matched.length) {
        hits.push({ type: t, tier: c.tier, strength, matched, weak })
      }
      const cp = (c.counterPatterns ?? []).filter((p) => p)
      if (cp.length && cp.every((p) => patMatch(p, obsText))) {
        counters.push({ mechanism: mid, counter_patterns: cp, counter_check: c.counterCheck })
      }
    }
    const hard = hits.filter((h) => h.strength === 'hard' && !h.weak).length
    const weakHard = hits.filter((h) => h.strength === 'hard' && h.weak).length
    const srcsHit = new Set<string>()
    for (const h of hits) {
      const isPat = h.type === 'log_text' || h.type === 'log_text+sequence'
      const pats = (h.matched as string[]) ?? []
      for (let i = 0; i < observations.length; i++) {
        if (pats.some((x) => (isPat ? patMatch(x, observations[i]!) : observations[i]!.includes(x)))) srcsHit.add(srcs[i]!)
      }
    }
    const countersHere = counters.filter((c) => c.mechanism === mid)
    let state = 'unknown'
    let why = ''
    if (countersHere.length) {
      state = 'excluded'
      why = 'counter_check 成立（counter_patterns 命中）⇒ excluded，留档不静默丢弃'
    } else if (!hits.length) {
      why = '无判据命中：需先取证（见 next_actions）'
    } else if (hard === 0) {
      why = `仅软证据命中${weakHard ? `（另有 ${weakHard} 条弱字段名命中，判据 condition 未求值，不计 hard）` : ''} ⇒ 按 hard_cap 只能到 unknown`
    } else if (srcsHit.size >= 2) {
      state = 'confirmed'
      why = '≥2 个独立来源命中且含 hard ⇒ confirmed（counter_check 仍须人核）'
    } else {
      why = '命中含 hard，但来源不独立（同源多命中只算 1）⇒ 停在 unknown'
    }
    results.push({ id: mid, state, hits, why, tier: m.criteriaTier })
  }

  // 结构判据池外一遍（须覆盖根类）
  const structurals: Array<Record<string, unknown>> = []
  for (const rm of (mechsRaw.mechanisms as unknown[] | undefined) ?? []) {
    const m = rm as Record<string, unknown>
    for (const c of (m.criterion as unknown[] | undefined) ?? []) {
      const cc = c as Record<string, unknown>
      if (cc.type === 'structural') {
        const ev = structuralEvidence(traverser, node, args?.affected_unit)
        structurals.push({ ...ev, mechanism: String(m.id) })
      }
    }
  }

  const rank: Record<string, number> = { confirmed: 0, unknown: 1, excluded: 2 }
  results.sort((a, b) => {
    const ra = rank[a.state as string] ?? 1
    const rb = rank[b.state as string] ?? 1
    if (ra !== rb) return ra - rb
    const ha = (a.hits as unknown[]).length
    const hb = (b.hits as unknown[]).length
    if (hb !== ha) return hb - ha
    return (tierOrder.indexOf(String(a.tier)) === -1 ? 99 : tierOrder.indexOf(String(a.tier)))
      - (tierOrder.indexOf(String(b.tier)) === -1 ? 99 : tierOrder.indexOf(String(b.tier)))
  })

  // ⑤ 五段输出
  const nextActions: Array<Record<string, unknown>> = []
  for (const r of results) {
    const m = mechs[r.id as string] ?? {}
    const done = new Set((r.hits as Array<{ type: string }>).map((h) => h.type))
    for (const c of m.criterion ?? []) {
      if (done.has(c.type!) && c.type !== 'field_condition') continue
      const look = [...(c.patterns ?? []), ...(c.fields ?? [])]
      if (c.condition) look.push(c.condition)
      if (!look.length) continue
      nextActions.push({ mechanism: r.id, tier: c.tier, look_for: look.slice(0, 3), then: c.counterCheck })
      break
    }
  }
  if (results.length) {
    const smp = (mechs[results[0].id as string] ?? {}).sampling
    if (smp && smp.method) {
      nextActions.unshift({ mechanism: results[0].id, tier: 'sampling', sampling: smp.method, thresholds: smp.thresholds })
    }
  }

  const gaps: string[] = []
  if (kind === 'code' && !(ctx?.dimensions ?? []).length) {
    gaps.push('该码只给码定不了含义（Q27）：需要日志消息文本或该码出现在哪个进程的日志')
  } else if (kind === 'code' && Array.isArray(ctx?.dimensions) && ((ctx?.dimensions as string[]) ?? []).join() === 'dimension:unknown') {
    gaps.push('该码只给码定不了含义（Q27）：需要日志消息文本或该码出现在哪个进程的日志')
  }
  if (!narrowed) gaps.push('本体未给出收窄（无机制经 manifests_as 指向该端点）⇒ 候选按全量给出，召回优先于精度')
  if (!observations.length) gaps.push('本次未提供任何观测：结论只能是 unknown——取证动作见 next_actions')

  const facts: string[] = []
  for (const r of results) for (const h of r.hits as Array<{ matched: string[] }>) facts.push(String(h.matched.join(' / ')))
  const th = treatmentHint(bknRoot, traverser, targets)

  return {
    entry,
    entry_node: node,
    entry_kind: kind,
    entry_note: note.join(', '),
    candidates: results,
    chain_note: '因果层暂不可用：机制间边 triggers/amplifies 留空 ⇒ 候选平铺，按（状态 → 命中数 → 档位）排序。',
    root_note: roots.length ? `根类 ${roots.join('/')} 不独立出证（mechanisms.yaml entry_fields）：它的 confirmed 必须由某个子类的 hard 证据支撑，故不进 candidates。` : '',
    structural_evidence: structurals,
    treatment_hint: th,
    next_actions: nextActions,
    evidence_gaps: gaps,
    fact_vs_inference: {
      facts: facts.length ? ['判据命中原文：' + facts.join(' / ')] : ['本次无命中'],
      inference: results.map((r) => `${r.id} → ${r.state}：${r.why}`),
      note: 'unknown 是合法答案：证据不足时不许用推测填空',
    },
    silence_note: observations.length
      ? `已提供 ${observations.length} 条观测；未出现在观测里 ≠ 不存在——沉默端仍需按 next_actions 主动采。`
      : '沉默端：本次未提供任何观测——没有观测不等于没有故障；先按 next_actions 取证。',
  }
}