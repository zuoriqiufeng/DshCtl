/**
 * codeOrigin.ts — 错误码来源分类（批次 A5：对齐 plugin/code_origin.py）
 *
 * 为什么：i2Stream 产品码（在 `error_codes.yaml` 侧车）与数据库原生码（ORA-/SQLSTATE/1062…）
 * 不可能放进同一张表；DB 码空间无界，只能按**来源形状**分流。
 * 本模块只做「来源/形状」，**不解释含义**——含义永远在产品侧车或 DB 文档/Skill。
 *
 * 用途：diagnose_error 的 `dimension:unknown` 分支补「产品码 / 数据库原生码 / 歧义」的
 * 来源提示，帮助判断该走主库码表直查还是 diagnose_db_link——对应 BUG-0009 A 的导航补全。
 *
 * 零依赖口径：逐行解析（沿用 errorSemantics.ts 惯例，项目不依赖 yaml 库）。
 * H-15：缺文件/坏数据一律退化为空结构/unknown，不抛。
 *
 * 数据路径：与共享 BKN 同仓的 plugin/code_origin.yaml（bknRoot 的同级 plugin/ 目录）；
 * env I2STREAM_CODE_ORIGIN 可覆盖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadErrorCodes } from './errorSemantics.ts'

export interface OriginRule {
  origin: string
  vendor: string
  pattern: string
  ambiguous?: boolean
}

export interface OriginData {
  rules: OriginRule[]
  messageRules: OriginRule[]
}

export interface OriginInfo {
  origin: string
  vendor: string
  ambiguous: boolean
  rule: string
  confidence: 'high' | 'medium' | 'low'
  needs?: string
  hint?: string
}

const NEEDS = 'message 或 db_type'
const HINT_AMBIG =
  '无法单凭码形断言来源（ambiguous）；需要 message 或 db_type 才能裁决，也可能不是数据库错误码（i2Stream 内部引用 / HTTP 状态码）。'

const _VENDORS: Record<string, string> = {
  oracle: 'oracle', ora: 'oracle',
  mysql: 'mysql', mariadb: 'mysql',
  postgres: 'postgres', postgresql: 'postgres', pg: 'postgres',
  db2: 'db2',
  sqlserver: 'sqlserver', mssql: 'sqlserver',
}

/** 去掉行尾注释（# 前有空格且不在引号内——沿用 errorSemantics.stripComment 口径）。 */
function stripComment(line: string): string {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === '#' && !inQuote && i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i).trimEnd()
  }
  return line
}

/** 解析 `- {id: xx, origin: yy, pattern: '...'}` 内联 map（值去单引号；本数据无嵌套）。 */
function parseInlineMap(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  // 按逗号切，但 pattern 值内可能含逗号 → 用带引号感知的正则逐段取 key: value
  const re = /([\w-]+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g
  for (let m = re.exec(body); m; m = re.exec(body)) {
    out[m[1]!] = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  }
  return out
}

/** 解析 code_origin.yaml（rules + message_rules 两段；失败返回空结构）。 */
export function parseCodeOrigin(text: string): OriginData {
  const rules: OriginRule[] = []
  const messageRules: OriginRule[] = []
  let section = ''
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim()
    if (!line) continue
    if (/^rules:\s*$/.test(line)) { section = 'rules'; continue }
    if (/^message_rules:\s*$/.test(line)) { section = 'message_rules'; continue }
    const m = /^-\s*\{(.+)\}$/.exec(line)
    if (!m || !section) continue
    const f = parseInlineMap(m[1]!)
    if (!f.origin || !f.pattern) continue
    const rule: OriginRule = {
      origin: f.origin,
      vendor: f.vendor ?? '',
      pattern: f.pattern,
      ...(f.ambiguous === 'true' ? { ambiguous: true } : {}),
    }
    if (section === 'rules') rules.push(rule)
    else messageRules.push(rule)
  }
  return { rules, messageRules }
}

// ── 加载（模块级缓存；缺文件/坏数据 → 空结构，安全侧） ──────────
let originCache: OriginData | null = null
let originPathUsed = ''

export function codeOriginPath(bknRoot: string): string {
  const env = process.env.I2STREAM_CODE_ORIGIN
  if (env) return env
  return join(dirname(bknRoot), 'plugin', 'code_origin.yaml')
}

/** 加载来源规则（py code_origin._load_yaml 1:1：缺文件/坏数据 → 空结构）。 */
function loadCodeOrigin(bknRoot: string): OriginData {
  const p = codeOriginPath(bknRoot)
  if (originCache && originPathUsed === p) return originCache
  let data: OriginData = { rules: [], messageRules: [] }
  try {
    if (existsSync(p)) data = parseCodeOrigin(readFileSync(p, 'utf8'))
  } catch { /* 保持空结构 */ }
  originCache = data
  originPathUsed = p
  return data
}

export function resetCodeOriginCache(): void {
  originCache = null
  originPathUsed = ''
}

function _match(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

function _vendorHint(text: string): string {
  if (!text) return ''
  const t = String(text).toLowerCase()
  for (const key of Object.keys(_VENDORS)) {
    if (new RegExp('(?<![a-z])' + escapeRe(key) + '(?![a-z])').test(t)) return _VENDORS[key]!
  }
  return ''
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * classify（py code_origin.classify 1:1）：码 → {origin, vendor, ambiguous, rule, confidence}；
 * 异常一律 unknown。含义不解，只判来源形状。
 */
export function classifyCode(
  bknRoot: string,
  code: string,
  message = '',
  dbHint = '',
): OriginInfo {
  const out: OriginInfo = { origin: 'unknown', vendor: '', ambiguous: false, rule: '', confidence: 'low' }
  try {
    const raw = String(code ?? '').trim()
    if (!raw) return out
    const data = loadCodeOrigin(bknRoot)
    const text = raw.toUpperCase()
    // ① product：命中 error_codes.yaml 的产品码（懒加载比对）
    if (isProductCode(bknRoot, raw)) {
      out.origin = 'product'; out.vendor = 'i2stream'; out.ambiguous = false
      out.rule = 'product_sidecar'; out.confidence = 'high'
      return out
    }
    // ② vendor hint：db_hint / message 里出现厂商词
    const vendorHit = _vendorHint(dbHint) || _vendorHint(message)
    if (vendorHit) {
      out.origin = vendorHit; out.vendor = vendorHit; out.ambiguous = false
      out.rule = 'vendor_hint'; out.confidence = 'medium'
      return out
    }
    // ③ message_rules：message 文本命中
    if (message) {
      for (const r of data.messageRules) {
        if (_match(r.pattern, String(message))) {
          out.origin = r.origin; out.vendor = r.vendor; out.ambiguous = false
          out.rule = r.pattern; out.confidence = 'medium'
          return out
        }
      }
    }
    // ④ rules：码形命中；ambiguous 规则只回提示、不落定
    for (const r of data.rules) {
      if (!_match(r.pattern, text)) continue
      if (r.ambiguous) {
        out.origin = 'ambiguous'; out.vendor = r.vendor; out.ambiguous = true
        out.rule = r.pattern; out.confidence = 'low'
        out.needs = NEEDS; out.hint = HINT_AMBIG
        return out
      }
      out.origin = r.origin; out.vendor = r.vendor; out.ambiguous = false
      out.rule = r.pattern; out.confidence = 'medium'
      return out
    }
    out.needs = NEEDS
    out.hint = '未识别为已知数据库/产品错误码（origin=unknown）；可能为 i2Stream 内部引用或非数据库码，请提供 message 或 db_type。'
    return out
  } catch {
    return out
  }
}

// 产品码判定：命中 error_codes.yaml 的既有加载表（loadErrorCodes 已按 code/-code/define 三键登记），
// 与 A3 码义兜底的"产品码"口径同源，避免二次解析漂移。命中即 origin=product。
function isProductCode(bknRoot: string, code: string): boolean {
  try {
    const table = loadErrorCodes(bknRoot)
    const bare = code.replace(/^-/, '')
    return Boolean(table[code] || table[bare] || table['-' + bare])
  } catch {
    return false
  }
}