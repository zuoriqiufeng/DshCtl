/**
 * errorSemantics.ts — 错误码诊断链路 v2（62/63 号）TS 侧移植（plugin/resolver.py 1:1）。
 *
 * 背景：BKN 2026-10-12~15 数据编辑完成后，error: 前缀边全面退出本体（码只作入口、不在任何
 * 一层穷举——用户裁定 Q27）；语义规则迁至 plugin/error_semantics.yaml（有界 8 类，按**消息文本**
 * 命中），官方码表 plugin/error_codes.yaml dimension_map（仅 status=统一/单源 可信）。
 * Python 侧 resolver.get_risk 已按新链路实现；本模块为 TS 侧对齐。
 *
 * 零依赖口径：逐行解析（同 resolver.parseManifestYaml / intent-router/frontmatter.ts 惯例，
 * 项目不依赖 yaml 库）。缺文件/坏数据一律退化为空结构（安全侧，落 unknown），不抛。
 *
 * 数据路径：与共享 BKN 同仓的 plugin/*.yaml（bknRoot 的同级 plugin/ 目录）；
 * env I2STREAM_ERROR_SEMANTICS / I2STREAM_ERROR_CODES 可覆盖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 语义规则条目（error_semantics.yaml rules[]；与 py classify 的消费字段对齐） */
export interface SemRule {
  id: string
  dimension: string
  match: string[]
  match_official: string[]
  match_official_deny: string[]
  guide: string
  skill: string
}

export interface SemData {
  rules: SemRule[]
  fallback: { dimension: string; guide: string }
}

/** 官方码表条目（error_codes.yaml dimension_map[]） */
export interface CodeEntry {
  define: string
  code: string
  meaning: string
  dimension: string
  rule: string
  matched_by: string
  status: string
  note: string
}

/** classify 结果（py classify_error_message 返回形状） */
export interface Meaning {
  rule: string
  dimension: string
  guide: string
  skill: string
  evidence: string
}

const FALLBACK_DIM = 'dimension:unknown'

// ── 逐行解析 ──────────────────────────────────────────────

/** 去掉行尾注释（# 前有空格且不在引号内——本数据文件的双引号值都成对，保守按引号外处理） */
function stripComment(line: string): string {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === '#' && !inQuote && i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i).trimEnd()
  }
  return line
}

/** 解析 [a, "b", c] 形态的内联数组（可能跨行；引号包裹值；返回去引号字符串数组） */
function parseInlineArray(joined: string): string[] {
  const end = joined.lastIndexOf(']')
  if (end === -1) return []
  const body = joined.slice(0, end)
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'/g
  for (let m = re.exec(body); m; m = re.exec(body)) out.push(m[1] ?? m[2] ?? '')
  return out
}

/**
 * 解析 error_semantics.yaml（rules 列表 + fallback 节）。
 * 结构假设（与数据文件现状绑定，解析失败返回空结构）：
 *   rules: 下每条以「  - id: xxx」起始，字段 4 空格缩进；数组值可跨行直到中括号配平。
 */
export function parseErrorSemantics(text: string): SemData {
  const lines = text.split('\n').map(stripComment)
  const rules: SemRule[] = []
  const fallback: SemData['fallback'] = { dimension: FALLBACK_DIM, guide: '' }
  let section = ''
  let cur: { id: string; fields: Record<string, string> } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    if (/^rules:\s*$/.test(line)) { section = 'rules'; cur = null; continue }
    if (/^fallback:\s*$/.test(line)) { section = 'fallback'; cur = null; continue }
    if (section === 'rules') {
      const item = /^  - ([\w-]+):\s*(.*)$/.exec(line)
      if (item) {
        // 「  - id: log_readable」形态：键是字段名、值是字段值（id 字段的值即规则 id）
        cur = { id: (item[2] ?? '').trim(), fields: item[2] ? { [item[1] ?? '']: item[2] } : {} }
        rules.push({ id: cur.id, dimension: '', match: [], match_official: [], match_official_deny: [], guide: '', skill: '' })
        continue
      }
      const field = /^    ([\w-]+):\s*(.*)$/.exec(line)
      if (field && rules.length) {
        const key = field[1] ?? ''
        let val = field[2] ?? ''
        if (val.startsWith('[') && !val.includes(']')) {
          // 跨行数组：吞行直到中括号配平
          let depth = (val.match(/\[/g) ?? []).length - (val.match(/\]/g) ?? []).length
          let j = i + 1
          while (depth > 0 && j < lines.length) {
            const cont = lines[j] ?? ''
            val += ' ' + cont.trim()
            depth += (cont.match(/\[/g) ?? []).length - (cont.match(/\]/g) ?? []).length
            j++
          }
          i = j - 1
        }
        const r = rules[rules.length - 1] as unknown as Record<string, unknown>
        if (val.startsWith('[')) r[key] = parseInlineArray(val)
        else r[key] = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      }
      continue
    }
    if (section === 'fallback') {
      const field = /^  ([\w-]+):\s*(.*)$/.exec(line)
      if (field) {
        const key = field[1] ?? ''
        const val = (field[2] ?? '').replace(/^"(.*)"$/, '$1')
        if (key === 'dimension') fallback.dimension = val || FALLBACK_DIM
        else if (key === 'guide') fallback.guide = val
      }
    }
  }
  return { rules, fallback }
}

/**
 * 解析 error_codes.yaml 的 dimension_map 段（文件前部另有原始码表，不消费）。
 * 条目以「- define: xxx」起始（0 缩进），字段 2 空格缩进。
 */
export function parseErrorCodes(text: string): Record<string, CodeEntry> {
  const lines = text.split('\n').map(stripComment)
  const out: Record<string, CodeEntry> = {}
  let inMap = false
  let cur: CodeEntry | null = null
  for (const raw of lines) {
    if (!raw.trim()) continue
    if (/^dimension_map:\s*$/.test(raw)) { inMap = true; continue }
    if (!inMap) continue
    const item = /^- define:\s*(.*)$/.exec(raw)
    if (item) {
      cur = {
        define: item[1] ?? '', code: '', meaning: '', dimension: '',
        rule: '', matched_by: '', status: '', note: '',
      }
      out[cur.define] = cur
      continue
    }
    const field = /^  ([\w-]+):\s*(.*)$/.exec(raw)
    if (field && cur) {
      const key = field[1] as keyof CodeEntry
      if (key in cur) (cur as unknown as Record<string, string>)[key] = (field[2] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
    }
  }
  return out
}

// ── 加载（模块级缓存；缺文件/坏数据 → 空结构，安全侧） ──────────

let semCache: SemData | null = null
let semPathUsed = ''
let codesCache: Record<string, CodeEntry> | null = null
let codesPathUsed = ''

export function semanticsPath(bknRoot: string): string {
  const env = process.env.I2STREAM_ERROR_SEMANTICS
  if (env) return env
  return join(dirname(bknRoot), 'plugin', 'error_semantics.yaml')
}

export function codesPath(bknRoot: string): string {
  const env = process.env.I2STREAM_ERROR_CODES
  if (env) return env
  return join(dirname(bknRoot), 'plugin', 'error_codes.yaml')
}

/** 加载语义规则（py _load_error_semantics 1:1：缺文件/坏数据 → 空结构） */
export function loadErrorSemantics(bknRoot: string): SemData {
  const p = semanticsPath(bknRoot)
  if (semCache && semPathUsed === p) return semCache
  let data: SemData = { rules: [], fallback: { dimension: FALLBACK_DIM, guide: '' } }
  try {
    if (existsSync(p)) data = parseErrorSemantics(readFileSync(p, 'utf8'))
  } catch { /* 保持空结构 */ }
  semCache = data
  semPathUsed = p
  return data
}

/** 加载官方码表 dimension_map（py _load_error_codes 1:1：code/-code/define 三键都登记） */
export function loadErrorCodes(bknRoot: string): Record<string, CodeEntry> {
  const p = codesPath(bknRoot)
  if (codesCache && codesPathUsed === p) return codesCache
  let table: Record<string, CodeEntry> = {}
  try {
    if (existsSync(p)) {
      const entries = parseErrorCodes(readFileSync(p, 'utf8'))
      for (const [define, e] of Object.entries(entries)) {
        const code = (e.code ?? '').trim()
        if (code) {
          table[code] = e
          if (table['-' + code.replace(/^-/, '')] === undefined) table['-' + code.replace(/^-/, '')] = e
        }
        if (define && table[define] === undefined) table[define] = e
      }
    }
  } catch { /* 保持空表 */ }
  codesCache = table
  codesPathUsed = p
  return table
}

export function resetErrorSemanticsCache(): void {
  semCache = null
  codesCache = null
  semPathUsed = ''
  codesPathUsed = ''
}

// ── 分类（py classify_error_message / classify_official_meaning / _official_meaning_for 1:1） ──

/** 按**消息文本**命中语义规则（顺序即优先级，首位命中即返回；依据可溯） */
export function classifyErrorMessage(sem: SemData, message: string): Meaning {
  const text = String(message ?? '')
  const low = text.toLowerCase()
  for (const rule of sem.rules) {
    const hits = (rule.match ?? []).filter((k) => k && low.includes(String(k).toLowerCase()))
    if (hits.length) {
      return {
        rule: rule.id,
        dimension: rule.dimension,
        guide: rule.guide,
        skill: rule.skill,
        evidence: '命中关键词 ' + hits.slice(0, 3).map((h) => '『' + h + '』').join('、'),
      }
    }
  }
  const fb = sem.fallback
  return { rule: '', dimension: fb.dimension || FALLBACK_DIM, guide: fb.guide, skill: '', evidence: '未命中任何语义类别（需要消息文本或走检索）' }
}

/** 按**官方含义**命中语义规则（63 号 §3.2：先 match_official 后 match，官方路径带 deny 表） */
export function classifyOfficialMeaning(sem: SemData, text: string): Meaning {
  const low = String(text ?? '').toLowerCase()
  for (const scope of ['match_official', 'match'] as const) {
    for (const rule of sem.rules) {
      const deny = rule.match_official_deny ?? []
      if (deny.some((d) => d && low.includes(String(d).toLowerCase()))) continue
      const kws = (rule[scope] ?? []) as string[]
      const hits = kws.filter((k) => k && low.includes(String(k).toLowerCase()))
      if (hits.length) {
        const tag = scope === 'match_official' ? '官方含义关键词' : '关键词'
        return {
          rule: rule.id,
          dimension: rule.dimension,
          guide: rule.guide,
          skill: rule.skill,
          evidence: tag + ' ' + hits.slice(0, 3).map((h) => '『' + h + '』').join('、'),
        }
      }
    }
  }
  const fb = sem.fallback
  return { rule: '', dimension: fb.dimension || FALLBACK_DIM, guide: fb.guide, skill: '', evidence: '未命中任何语义类别（需要消息文本或走检索）' }
}

/** 裸码 → 官方含义 → 维度（63 号 §3.1 的 status 闸门：统一/单源可信，区分/待复核落 unknown 并记冲突） */
export function officialMeaningFor(sem: SemData, codes: Record<string, CodeEntry>, code: string, conflicts: string[]): Meaning {
  const fb: Meaning = { rule: '', dimension: FALLBACK_DIM, guide: '', skill: '', evidence: '未命中任何语义类别（需要消息文本或走检索）' }
  if (!code) return fb
  const ent = codes[code] ?? codes[code.replace(/^-/, '')] ?? codes['-' + code.replace(/^-/, '')]
  if (!ent) return fb
  const status = String(ent.status ?? '')
  const dm = String(ent.dimension || FALLBACK_DIM)
  if ((status === '统一' || status === '单源') && dm !== FALLBACK_DIM) {
    const got = classifyOfficialMeaning(sem, String(ent.meaning ?? ''))
    if (got.dimension === FALLBACK_DIM) got.dimension = dm
    if (status === '单源') got.evidence = '单源（厂商文档，未经现场验证）｜' + got.evidence
    got.evidence = '官方含义『' + (ent.meaning ?? '') + '』（' + (ent.define ?? '') + '）｜' + got.evidence
    return got
  }
  if (status === '区分' || status === '待现场复核') {
    conflicts.push((ent.define ?? '') + '（' + code + '）：官方含义『' + (ent.meaning ?? '') + '』与仓内证据不一致——' + (ent.note ?? ''))
  }
  return fb
}
