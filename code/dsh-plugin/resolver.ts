/**
 * resolver.ts — BKN 文件加载与解析引擎（DSH 版）
 *
 * 移植自 plugin/resolver.py（2026-09-24 本体分层重构 26 号后语义）：遍历 bkn/ 加载所有 .bkn 文件，
 * 提供结构化查询（Markdown 表格 / Section 拆分 / 键值对提取）。
 *
 * 26 号终态的关键差异（相对旧 TS 版）：
 *   · 已删文件：`compatibility.bkn` / `architecture.bkn` / `network.bkn` / `objects/env_matrix.bkn` /
 *     `risks/diagnostics.bkn` / `diagnostics/*` / `scenarios/*` —— 值数据下延 Skill references，
 *     本体只回委托指针（DELEGATIONS）；导航数据改由「边 + 进程对象属性」派生。
 *   · 新路径：`objects/product.bkn`、`objects/scenario-*.bkn`、`risks/prerequisites.bkn`。
 *   · 错误码/症状规范 ID 空间由 `relations/process_topology.bkn` 的 `suspected_in` 边承载；
 *     别名在 constants.ts 值数据层（ERROR_ALIASES / SYMPTOM_ALIASES / DIMENSION_ALIASES）。
 *   · 关系图由 `RelationTraverser`（relations/*.bkn 整目录）提供，24 种关系类型。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import {
  DB_ALIASES,
  DELEGATIONS,
  DELEGATION_QDRANT_HINT,
  DIAG_RETRIEVAL_GUIDE,
  DIMENSION_ALIASES,
  ERROR_ALIASES,
  KNOWN_DBS,
  PROCESS_IDS,
  SCENARIO_ROUTING_RULES,
  SYMPTOM_ALIASES,
  UNKNOWN_RULE,
  isDbMatch,
  type Delegation,
} from './constants.ts'
import { RelationTraverser } from './relations.ts'

export interface Table {
  header: string[]
  rows: Record<string, string>[]
}

export interface OperationInfo {
  name: string
  file: string
  capability: string
  aliases: string[]
  implements?: string
  params?: string
  constraints?: string
  notes?: string
  prerequisites?: string
  risks?: string
  [key: string]: unknown
}

/** 场景匹配规则（Tool 层常量 constants.SCENARIO_ROUTING_RULES；23 号：路由表不入 BKN 本体）。 */
export interface ScenarioRule {
  priority: number
  sourcePattern: string
  targetPattern: string
  file: string
  scenario: string
  subScenario: string
  description: string
  relationKey: string
}

/** 场景匹配结果（对齐 Hermes match_scenario 返回结构）。 */
export interface ScenarioMatch {
  scenario: string
  subScenario: string
  file: string
  description: string
  relationKey: string
}

/** 值委托指针（23 号）：本体只回结构化指针，值数据按需加载 Skill references。 */
export interface DelegationPointer extends Delegation {
  qdrant_hint: string
  reason?: string
  sections?: unknown
}

/** getRisk 返回值：25 号「常量 + 边」结构（锚点表已删）。 */
export interface RiskInfo {
  error_code: string
  retrieval_guide: string
  suspected_process: string[]
  dimensions: string[]
  aliases: string[]
  unknown_rule: string
  /** Tool 层投影：派生字段的可读渲染（Python get_risk 无 raw 键，TS 侧 diagnose_error 需诊断正文）。 */
  raw: string
}

export interface SymptomSkill {
  name: string
  reason: string
}

export interface SymptomSkills {
  required: SymptomSkill[]
  optional: SymptomSkill[]
  analysis_framework: string
  skill_capabilities: string
  analysis_source?: string
  capabilities_source?: string
  diag_class?: string
}

/** Section 数据容器：raw 立即存储，tables/kv 首次访问时懒提取。 */
export class Section {
  readonly raw: string
  #tables?: Table[]
  #kv?: Record<string, string>

  constructor(raw: string) {
    this.raw = raw
  }

  get tables(): Table[] {
    if (!this.#tables) this.#tables = extractTables(this.raw)
    return this.#tables
  }

  get kv(): Record<string, string> {
    if (!this.#kv) this.#kv = extractKeyValues(this.raw)
    return this.#kv
  }
}

/** 提取 Markdown 表格 → list[{header, rows}] */
export function extractTables(text: string): Table[] {
  const tables: Table[] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    if (lines[i].includes('|') && (lines[i + 1] ?? '').includes('---')) {
      const header = lines[i].split('|').map((h) => h.trim()).filter(Boolean)
      i += 2
      const rows: Record<string, string>[] = []
      while (i < lines.length && lines[i].includes('|')) {
        const cells = lines[i].split('|').map((c) => c.trim()).filter(Boolean)
        if (cells.length === header.length) {
          const row: Record<string, string> = {}
          header.forEach((h, idx) => { row[h] = cells[idx] })
          rows.push(row)
        }
        i++
      }
      tables.push({ header, rows })
    } else {
      i++
    }
  }
  return tables
}

/** 提取 key: value 和 - key: value 行（支持中文 key）。 */
export function extractKeyValues(text: string): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const m = line.match(/^-?[ \t]*([^:\n>|# \t\n\r\f\v][^:\n]*?)[ \t]*:[ \t]*(.+)/)
    if (m) kv[m[1].trim()] = m[2].trim()
  }
  return kv
}

/** 遍历目录下的 .bkn 文件（递归）。 */
/** 遍历异常台账（模块级：walkBkn 是纯函数，异常交由启动侧聚合告警） */
export const bknWalkIssues: string[] = []

function walkBkn(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (e) {
    bknWalkIssues.push(`${dir}: ${(e as Error).message.slice(0, 120)}`)
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    try {
      if (statSync(p).isDirectory()) walkBkn(p, out)
      else if (e.endsWith('.bkn')) out.push(p)
    } catch (err) {
      bknWalkIssues.push(`${p}: ${(err as Error).message.slice(0, 120)}`)
    }
  }
  return out
}

// ═══════════════ manifest（Skill 层「ID → 实现」间接层，值委托） ═══════════════
//
// 移植自 plugin/manifest.py：BKN 只持语义 ID（skill:/tool:/store:），实现映射在
// skill_manifest.yaml 单点维护。DSH 侧默认取共享 BKN 同仓的 plugin/skill_manifest.yaml
// （env `I2STREAM_SKILL_MANIFEST` 可覆盖）；缺失/解析失败返回空结构，调用方回落 ID 本身。

export interface ManifestItem {
  id: string
  entry?: string
  capability?: string
  load_criterion?: string
  [key: string]: unknown
}

const manifestCache = new Map<string, ManifestItem[]>()

/** 默认 manifest 路径：与共享 BKN 同仓的 plugin/skill_manifest.yaml。 */
export function defaultManifestPath(bknRoot: string): string {
  const override = process.env.I2STREAM_SKILL_MANIFEST
  if (override) return override
  return join(dirname(bknRoot), 'plugin', 'skill_manifest.yaml')
}

function unquote(v: string): string {
  const s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim()
  }
  return s
}

/** 解析 skill_manifest.yaml 的条目列表（行式 YAML 子集，不依赖 yaml 库）。 */
function parseManifestYaml(text: string): ManifestItem[] {
  const items: ManifestItem[] = []
  let current: ManifestItem | null = null
  for (const raw of text.split('\n')) {
    const stripped = raw.trim()
    if (!stripped || stripped.startsWith('#')) continue
    const item = stripped.match(/^-[ \t]+([A-Za-z0-9_]+):[ \t]*(.*)$/)
    if (item) {
      current = { id: unquote(item[2]!), [item[1]!]: unquote(item[2]!) } as ManifestItem
      items.push(current)
      continue
    }
    const kv = stripped.match(/^([A-Za-z0-9_]+):[ \t]*(.*)$/)
    if (kv && current && kv[2]!.trim()) current[kv[1]!] = unquote(kv[2]!)
  }
  return items.filter((it) => typeof it.id === 'string' && it.id.includes(':'))
}

export function loadSkillManifest(manifestPath: string): ManifestItem[] {
  const cached = manifestCache.get(manifestPath)
  if (cached) return cached
  let items: ManifestItem[] = []
  try {
    items = parseManifestYaml(readFileSync(manifestPath, 'utf8'))
  } catch {
    items = [] // manifest 缺失/不可读 → 空结构（调用方回落 ID 本身）
  }
  manifestCache.set(manifestPath, items)
  return items
}

/** 清缓存（测试用：改动 manifest 后重载）。 */
export function resetSkillManifestCache(): void {
  manifestCache.clear()
}

/** skill:xxx → manifest 项（含 entry/capability/load_criterion）；未命中返回 null。 */
export function resolveSkillId(skillId: string, manifestPath: string): ManifestItem | null {
  for (const item of loadSkillManifest(manifestPath)) {
    if (item.id === skillId) return item
  }
  return null
}

/** manifest 解析 skill ID → 显示名（entry 目录尾段）；未命中回落 ID 本身。 */
export function manifestSkillName(skillId: string, manifestPath: string): string {
  const item = resolveSkillId(skillId, manifestPath)
  const entry = String(item?.entry ?? '').replace(/\/+$/, '')
  const tail = entry ? entry.split('/').filter(Boolean).pop() ?? '' : ''
  return tail || skillId.split(':').slice(1).join(':') || skillId
}

/** 关联 Skill 的能力概要（Skill 层 manifest，值委托；23 号方案）。 */
export function manifestSkillCapabilities(names: string[], manifestPath: string): string {
  const lines: string[] = []
  for (const n of names) {
    const cap = String(resolveSkillId(`skill:${n}`, manifestPath)?.capability ?? '')
    if (cap) lines.push(`- ${n}: ${cap}`)
  }
  return lines.join('\n')
}

function manifestSkill(skillId: string, reason: string, manifestPath: string): SymptomSkill {
  return { name: manifestSkillName(skillId, manifestPath), reason }
}

/** diagnose_db_link 默认 related_skills（tools.py _manifest_related_skills 1:1）。 */
const DEFAULT_RELATED_SKILLS: Array<[string, string]> = [
  ['skill:i2stream-rule-manager', '需要查看/修改规则配置'],
  ['skill:i2stream-db-diagnostics', '需要执行 dump 工具深度排查'],
  ['skill:i2stream-log-analyzer', '需要分析规则日志'],
  ['skill:i2stream-diff-op', '需要对比源目两端表数据'],
  ['skill:i2stream-iadebug', '需要处理 -4002 位点异常'],
]

/** 日志级别调整指引（Tool 层静态常量）。
 *
 * 26 号：`diagnostics/log-map.bkn` 整文件删除（导航类数据下延）——本表为「日志级别」
 * 导航的 Tool 层投影，动作本体见 `actions/iadebug.bkn`（iadebug_set_loglevel /
 * iadebug_reload_helper_config，具体命令由 skill:i2stream-iadebug 提供）。 */
const LOG_LEVEL_TUNING = [
  { scenario: '默认级别看不出原因', suggestion: '调高相关进程日志级别后复现', action: 'iadebug set_loglevel（具体命令由 i2stream-iadebug 提供）' },
  { scenario: '调整完毕', suggestion: '恢复默认级别（避免日志膨胀）', action: 'iadebug set_loglevel（同上）' },
  { scenario: '配置变更不重启生效', suggestion: '热加载', action: 'iadebug reload_helper_config（同上）' },
]

export class BKNResolver {
  readonly root: string
  readonly cache = new Map<string, Map<string, Section>>()
  readonly index = new Map<string, string>() // section_name → rel path
  readonly operations = new Map<string, OperationInfo>() // capability → info
  #synonymIndex?: Map<string, string>
  #scenarioRules?: ScenarioRule[]
  #traverser?: RelationTraverser
  readonly manifestPath: string

  constructor(bknRoot: string) {
    this.root = bknRoot
    this.manifestPath = defaultManifestPath(bknRoot)
    this.#loadAll()
  }

  #loadAll(): void {
    let files: string[]
    try {
      files = walkBkn(this.root).sort()
    } catch (e) {
      throw new Error(`BKN 根目录不可读: ${this.root} (${String(e)})`)
    }
    for (const path of files) {
      const rel = relative(this.root, path).split(sep).join('/')
      if (rel.startsWith('templates/')) continue
      this.cache.set(rel, this.#parse(path))
    }
    this.#buildIndex()
  }

  #parse(path: string): Map<string, Section> {
    const text = readFileSync(path, 'utf8')
    const sections = new Map<string, Section>()
    let current = '_head'
    const lines: string[] = []
    for (const line of text.split('\n')) {
      if (line.startsWith('## ') && !line.startsWith('### ')) {
        sections.set(current, new Section(lines.join('\n')))
        current = line.slice(3).trim()
        lines.length = 0
      } else {
        lines.push(line)
      }
    }
    sections.set(current, new Section(lines.join('\n')))
    return sections
  }

  #buildIndex(): void {
    for (const [rel, data] of this.cache) {
      for (const sectionName of data.keys()) this.index.set(sectionName, rel)
      this.#registerActions(rel, data)
    }
  }

  #registerActions(rel: string, data: Map<string, Section>): void {
    for (const [sectionName, section] of data) {
      if (!sectionName.startsWith('Action:')) continue
      const kv = section.kv
      const capability = kv['capability'] ?? ''
      if (!capability) continue
      const aliases = (kv['aliases'] ?? '').split(/[，,]/).map((a) => a.trim()).filter(Boolean)
      this.operations.set(capability, {
        ...kv,
        name: sectionName.replace('Action: ', ''),
        file: rel,
        capability,
        aliases,
      })
    }
  }

  /** 惰性构建关系图遍历器（关系边 / 症状→进程→Skill 路由用）。 */
  getTraverser(): RelationTraverser {
    if (!this.#traverser) this.#traverser = new RelationTraverser(this.root)
    return this.#traverser
  }

  /** objects/*.bkn 的 YAML frontmatter 元数据（容错逐行解析，不依赖 yaml 库）。 */
  getObjectMeta(relPath: string): Record<string, string | string[]> {
    const data = this.cache.get(relPath)
    const head = data?.get('_head')?.raw ?? ''
    if (!head.startsWith('---')) return {}
    const meta: Record<string, string | string[]> = {}
    let currentListKey: string | null = null
    let inFm = false
    for (const line of head.split('\n')) {
      const stripped = line.trim()
      if (stripped === '---') {
        if (inFm) break // frontmatter 结束
        inFm = true
        continue
      }
      if (!inFm) continue
      const m = stripped.match(/^([a-zA-Z0-9_]+):[ \t]*(.*)$/)
      if (m && !stripped.startsWith('- ')) {
        const key = m[1]!
        const val = m[2]!.trim()
        if (val) {
          meta[key] = val
          currentListKey = null
        } else {
          meta[key] = []
          currentListKey = key
        }
      } else if (stripped.startsWith('- ') && currentListKey) {
        const item = stripped.slice(2).trim()
        const cur = meta[currentListKey]
        if (item && Array.isArray(cur)) cur.push(item)
      }
    }
    return meta
  }

  // ========== 同义词索引（批 3-1：同址化） ==========

  /**
   * 构建同义词索引 → {同义词(小写): 规范ID/规范名}（数据源为**同址字段**）。
   *
   * - 对象：`objects/*.bkn` frontmatter `aliases:`（基点 = frontmatter `id`）+ `name`
   * - 动作：`actions/*.bkn` 段内 `- aliases:`（基点 = `capability`）+ 中文名
   * - 症状/维度/错误码：constants.ts 值数据常量（25 号自 BKN 锚点表下沉）
   * - 场景：`objects/scenario-*.bkn`「关键词」行（基点 = 场景 ID）
   * - 数据库：constants.DB_ALIASES + 规范名自映射
   *
   * 顺序有意为之（setdefault 不覆盖）：对象 → 动作 → 症状 → 维度 → 错误码 → 场景 → 库，
   * 保证「数据差异」这类症状/维度冲突键归症状。
   */
  #buildSynonymIndex(): Map<string, string> {
    const index = new Map<string, string>()
    const put = (key: string | undefined, canonical: string | undefined): void => {
      const k = (key ?? '').trim().toLowerCase()
      if (k && canonical && !index.has(k)) index.set(k, canonical)
    }

    // ── 对象：frontmatter aliases + name（同址，基点 = id）
    for (const rel of this.cache.keys()) {
      if (!rel.includes('objects/')) continue
      const meta = this.getObjectMeta(rel)
      const canonical = String(meta['id'] ?? '')
      if (!canonical) continue
      const aliases = meta['aliases']
      if (Array.isArray(aliases)) for (const alias of aliases) put(alias, canonical)
      put(String(meta['name'] ?? ''), canonical)
    }

    // ── 动作：段内 aliases（同址，基点 = capability）
    for (const [cap, info] of this.operations) {
      for (const alias of info.aliases) put(alias, cap)
      put(info.name, cap)
    }

    // ── 症状 / 维度 / 错误码别名（25 号：自 BKN 下沉到 constants.ts 值数据层）
    for (const [alias, sid] of Object.entries(SYMPTOM_ALIASES)) put(alias, sid)
    for (const [alias, dim] of Object.entries(DIMENSION_ALIASES)) put(alias, dim)
    for (const [alias, code] of Object.entries(ERROR_ALIASES)) put(alias, code)
    // 机械变体（不必写进任何表）：去横杠 / 补横杠 / 去前导零 / ORA 变体 + 4 位数字补负号
    for (const code of new Set(Object.values(ERROR_ALIASES))) {
      for (const variant of BKNResolver.errorCodeVariants(code)) put(variant, code)
    }

    // ── 场景：objects/scenario-*.bkn「关键词」行（同址，基点 = 场景 ID）
    for (const [rel, data] of this.cache) {
      if (!rel.includes('objects/') || !rel.includes('scenario-')) continue
      for (const sec of data.values()) {
        const sid = (sec.kv['场景 ID'] ?? '').trim()
        if (!sid) continue
        for (const alias of (sec.kv['关键词'] ?? '').split(/[、,，]/)) put(alias, sid)
      }
    }

    // ── 数据库：DB_ALIASES + 规范名自映射（已在生产链路，normalizeDb 消费）
    for (const [alias, canonical] of Object.entries(DB_ALIASES)) put(alias, canonical)
    for (const db of KNOWN_DBS) put(db, db)
    for (const canonical of Object.values(DB_ALIASES)) put(canonical, canonical)

    return index
  }

  /** 错误码的机械变体（口语/不规范写法），由规范码派生而非在 BKN 里写死。 */
  static errorCodeVariants(code: string): string[] {
    const variants: string[] = []
    const c = (code ?? '').trim()
    if (!c) return variants
    if (c.startsWith('-')) {
      const digits = c.slice(1)
      variants.push(digits, `错误${digits}`, `error ${digits}`, `error${digits}`)
    }
    const m = c.match(/^([A-Za-z]+)-([0-9]+)$/)
    if (m) {
      const prefix = m[1]!
      const digits = m[2]!
      const stripped = digits.replace(/^0+/, '') || digits
      variants.push(
        `${prefix}${digits}`, `${prefix}${stripped}`, `${prefix}-${stripped}`,
        stripped, digits, `错误${digits}`, `错误${stripped}`, `${prefix} ${digits}`,
      )
    }
    return variants
  }

  resolveSynonym(text: string): string {
    if (!text) return text
    if (!this.#synonymIndex) this.#synonymIndex = this.#buildSynonymIndex()
    return this.#synonymIndex.get(text.trim().toLowerCase()) ?? text
  }

  static normalizeErrorCode(code: string): string {
    const c = (code ?? '').trim()
    if (/^[0-9]{4}$/.test(c)) return `-${c}`
    const m = c.match(/^ORA-?([0-9]{4,5})$/i)
    if (m) return `ORA-${m[1]!.padStart(5, '0')}`
    return c
  }

  // ========== 查询接口 ==========

  /** 值委托指针（23 号方案）：{id, path, covers, qdrant_hint} + 附加说明。 */
  #delegation(key: string, extra: Record<string, unknown> = {}): DelegationPointer {
    return { ...(DELEGATIONS[key] as Delegation), qdrant_hint: DELEGATION_QDRANT_HINT, ...extra }
  }

  /**
   * 加载指定文件的全部 sections。
   *
   * 26 号目录收拢后 `product.bkn` 等旧裸名已迁入 `objects/`；为兼容裸名调用点
   * （self-test / 旧调用方）补一层 objects/ 兜底（Python `load()` 只认精确 rel 路径）。
   */
  /** 读取 miss 台账（v26 契约：不再静默返回空——由 index.ts 在启动后聚合告警） */
  readonly loadMisses: string[] = []

  load(fileName: string): Map<string, Section> {
    const exact = this.cache.get(fileName)
    if (exact) return exact
    if (fileName && !fileName.includes('/')) {
      const moved = this.cache.get(`objects/${fileName}`)
      if (moved) return moved
    }
    // 未命中的独立文件计入台账（同名段索引可命中的走 getSection，不经此处）
    const key = fileName.includes('/') ? fileName : `*.${fileName}`
    if (!this.loadMisses.includes(key)) this.loadMisses.push(key)
    return new Map()
  }

  getSection(sectionName: string): Section | null {
    const file = this.index.get(sectionName)
    return file ? this.cache.get(file)?.get(sectionName) ?? null : null
  }

  /**
   * 查询 objects/product.bkn（本体层：定位 / 核心能力 / 适用场景）。
   *
   * 23 号方案：竞品对比/行业覆盖/信创适配/性能指标/数据源全景/ETL 对比**已下延** Skill
   * references（值数据会随客户/竞品/版本增长），本体侧返回结构化指针。
   */
  queryProduct(aspect = 'overview'): Section | Record<string, unknown> | null {
    const data = this.load('objects/product.bkn')
    const sectionMap: Record<string, string> = {
      overview: '产品定位',
      positioning: '产品定位',
      advantages: '核心能力',
      core_capabilities: '核心能力',
      scenarios: '适用场景',
    }
    // 已下延 aspect → 指针（不再返回空段）
    const delegated: Record<string, [string, string]> = {
      competitors: ['product', '竞品对比'],
      industries: ['product', '行业覆盖'],
      xinchuang: ['product', '信创适配'],
      performance: ['product', '性能指标'],
      sources: ['product', '数据源全景'],
      etl_compare: ['product', '与传统 ETL 对比'],
    }
    if (aspect === 'all') {
      const sections: Record<string, Section> = {}
      const raws: string[] = []
      for (const [name, sec] of data) {
        if (name === '_head') continue
        sections[name] = sec
        raws.push(sec.raw)
      }
      const pointerLine =
        '> 23 号方案：竞品对比/行业覆盖/信创适配/性能指标/数据源全景已下延 ' +
        '`skill:i2stream-product-knowledge/references/product.md`（值委托）。'
      return {
        raw: `${raws.join('\n\n')}\n\n${pointerLine}`,
        sections,
        delegated_to: [this.#delegation('product')],
      }
    }
    const delegatedKey = delegated[aspect]
    if (delegatedKey) {
      const [key, cn] = delegatedKey
      // 先试本体是否仍有该段（兼容期），无则返回指针
      for (const [secName, sec] of data) {
        if (secName.includes(cn)) return sec
      }
      return {
        aspect,
        delegated_to: [this.#delegation(key, { reason: `「${cn}」不在本体层（23 号：值数据下延）` })],
        note: `本体层只保留产品定义（定位/核心能力/适用场景）；「${cn}」见上述 Skill 引用，` +
          '或按 qdrant_hint 检索兜底。',
      }
    }
    const target = sectionMap[aspect] ?? '产品定位'
    for (const [secName, sec] of data) {
      if (secName.includes(target)) return sec
    }
    return null
  }

  // ========== 运行时对象域（进程拓扑推导链） ==========

  /** 本体层进程注册集（24 号：以 PROCESS_IDS 为准，文件在 objects/<id>.bkn）。 */
  #iterProcessIds(): string[] {
    const ids: string[] = []
    for (const pid of PROCESS_IDS) {
      if (this.load(`objects/${pid}.bkn`).size) ids.push(`process:${pid}`)
    }
    return ids.sort()
  }

  /** process:* ID → 对应进程对象文件相对路径（小写规范化）。 */
  static processFile(processId: string): string {
    return `objects/${processId.replace(/^process:/, '').toLowerCase()}.bkn`
  }

  /**
   * 读进程对象「关键属性」段，返回 {属性: 值}（剥 process: 前缀）。
   *
   * 23 号方案：关键属性为 **KV bullet**（`- **属性**: 值`）；兼容旧表格行（`| 属性 | 值 |`）。
   * 枚举值（频度/自证性）只取主枚举 token（如「高（现场问题最多）」→「高」）。
   */
  getProcessAttrs(processId: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    for (const sec of this.load(BKNResolver.processFile(processId)).values()) {
      for (const line of sec.raw.split('\n')) {
        let key = ''
        let val = ''
        const stripped = line.trim()
        const mKv = stripped.match(/^-[ \t]*\*\*([^*]+)\*\*[ \t]*:[ \t]*(.+)$/)
        const mTbl = stripped.match(/^\|[ \t]*([^|]+)[ \t]*\|[ \t]*([^|]+)[ \t]*\|/)
        if (mKv) {
          key = mKv[1]!
          val = mKv[2]!
        } else if (mTbl && !['属性', '值', '---'].includes(mTbl[1]!.trim())) {
          key = mTbl[1]!
          val = mTbl[2]!
        }
        key = key.trim().replace(/^`+/, '').replace(/`+$/, '')
        val = val.trim().replace(/^`+/, '').replace(/`+$/, '')
        if (key && val && !(key in attrs)) {
          // 枚举属性截取主 token：`高（现场问题最多）` → `高`；`需关联（...）` → `需关联`
          if (key === '排查频度' || key === '日志自证性') {
            val = val.split('（')[0]!.split('(')[0]!.trim().replace(/\*/g, '')
          }
          attrs[key] = val
        }
      }
    }
    return attrs
  }

  /**
   * 症状/错误码 → 嫌疑进程（suspected_in 边，20 号方案替代 has_class）。
   *
   * 输入 `error:-4073` / `symptom:incremental_stuck` / 裸名（先归一，再补命名空间前缀）。
   */
  getProcessesForSymptom(key: string): string[] {
    let k = (key ?? '').trim()
    if (!k) return []
    if (!k.includes(':')) k = this.resolveSynonym(k)
    if (!k.includes(':')) {
      // 裸名无命名空间：先试 symptom: 前缀（现场描述多为症状），再试 error:
      for (const prefix of ['symptom:', 'error:']) {
        const hits = this.getTraverser().getTargets(`${prefix}${k}`, 'suspected_in')
        if (hits.length) return hits
      }
    }
    return this.getTraverser().getTargets(k, 'suspected_in')
  }

  /** 进程 → 数据流链（feeds 正向遍历，结构顺序 = 链路方向）。 */
  getProcessChain(processId: string): Array<Record<string, unknown>> {
    const chain: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    const queue = [processId]
    while (queue.length) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      const attrs = this.getProcessAttrs(cur)
      chain.push({
        process: cur,
        role: attrs['角色'] ?? '',
        language: attrs['语言'] ?? '',
        log: attrs['日志标识'] ?? '',
        frequency: attrs['排查频度'] ?? '',
        self_sufficient: attrs['日志自证性'] ?? '',
        checks: this.getProcessTools(cur),
      })
      for (const nxt of this.getTraverser().getTargets(cur, 'feeds')) {
        if (!seen.has(nxt)) queue.push(nxt)
      }
    }
    return chain
  }

  /** 进程语言 → 工具类别（属性驱动排障的核心推导）。 */
  getProcessTools(processId: string): string[] {
    const lang = this.getProcessAttrs(processId)['语言'] ?? ''
    if (lang.includes('C++') && lang.includes('Java')) return [] // iadumper 按库而异——适用库清单待核
    if (lang.includes('C++')) return ['core dump / stderr / 动态库（gdb / ldd / LD_LIBRARY_PATH）']
    if (lang.includes('Java')) return ['JDK 工具链（jstack / jmap / jstat / GC 日志 / JDK 版本）']
    return []
  }

  /**
   * 进程对象「关联」段里的 skill: 引用（与 diagnosed_by 对称的进程侧路由）。
   *
   * 23 号方案：只扫「关联」段——「关键属性」段中的 `skill:` 是**值委托指针**
   * （如日志路径由某 Skill 提供），不代表该进程的排查 Skill 归属。
   */
  getProcessSkills(processId: string): string[] {
    const skills: string[] = []
    for (const [secName, sec] of this.load(BKNResolver.processFile(processId))) {
      if (!secName.includes('关联')) continue
      for (const line of sec.raw.split('\n')) {
        for (const m of line.matchAll(/`skill:([a-z0-9_-]+)`/g)) {
          if (!skills.includes(m[1]!)) skills.push(m[1]!)
        }
      }
    }
    return skills
  }

  /** 从 relations/process_topology.bkn 派生数据流/生命周期/控制面边（投影为文本边）。 */
  #deriveDataFlow(): [string[], string[], string[]] {
    const t = this.getTraverser()
    const dataFlow: string[] = []
    const lifecycle: string[] = []
    const control: string[] = []
    for (const pid of this.#iterProcessIds()) {
      for (const tgt of t.getTargets(pid, 'feeds')) dataFlow.push(`${pid} --feeds--> ${tgt}`)
      for (const tgt of t.getTargets(pid, 'supervises')) lifecycle.push(`${pid} --supervises--> ${tgt}`)
      for (const tgt of t.getTargets(pid, 'monitors')) control.push(`${pid} --monitors--> ${tgt}`)
    }
    return [dataFlow, lifecycle, control]
  }

  /**
   * 查询架构主题（23 号方案：本体派生 + 值委托指针）。
   *
   * `architecture.bkn` 已删除——可抽象的部分上升为进程对象属性与 topology 边（本体派生）；
   * 完整原理正文（叙述类）下延 `skill:i2stream-product-knowledge/references/architecture.md`。
   */
  queryArchitecture(topic: string): Record<string, unknown> | null {
    const [dataFlow, lifecycle, control] = this.#deriveDataFlow()
    const procLines = this.#iterProcessIds().map((pid) => {
      const attrs = this.getProcessAttrs(pid)
      return `- ${pid}（${attrs['角色'] ?? ''} / ${attrs['语言'] ?? ''} / ` +
        `频度 ${attrs['排查频度'] ?? ''}）: 日志 ${attrs['日志标识'] ?? ''}`
    })
    if (topic === 'all') {
      const raw = [
        '## 进程对象与拓扑（本体派生）',
        ...procLines,
        '',
        '## 数据流边（feeds）',
        ...dataFlow.map((e) => `- ${e}`),
        '',
        '## 生命周期边（supervises）',
        ...lifecycle.map((e) => `- ${e}`),
        '',
        `> 完整架构正文（三层控制/核心流水线/初始化全同步/实时增量/Oracle 抽取/事务一致性/` +
        `比对修复）见 ${DELEGATIONS['architecture']!.id} 的 ` +
        `\`${DELEGATIONS['architecture']!.path}\`（值委托，23 号方案）。`,
      ].join('\n')
      return {
        topic: 'all',
        raw,
        processes: procLines,
        data_flow: dataFlow,
        lifecycle,
        delegated_to: [this.#delegation('architecture')],
        note: '本体层给进程骨架与拓扑边；原理叙述与逐库实现要点按 delegated_to 加载。',
      }
    }
    // 主题 → 本体可派生部分（feeds 链）/ 值委托章节
    const entryMap: Record<string, string> = { full_sync: 'process:iadumper', incremental_sync: 'process:iatrack' }
    const entry = entryMap[topic]
    if (entry) {
      const chain = this.getProcessChain(entry)
      const raw = [
        `## ${topic} 链路（本体派生：feeds 边）`,
        ...chain.map((c) => `- ${c['process']}（${c['role']}）: ${c['log']}；自证性=${c['self_sufficient']}`),
        `> 机制细节（抽取/解析/装载各阶段原理）见 ` +
        `${DELEGATIONS['architecture']!.path}（值委托）。`,
      ].join('\n')
      return {
        topic,
        raw,
        entry,
        chain,
        data_flow: dataFlow.filter((e) => e.includes(entry)),
        delegated_to: [
          this.#delegation('architecture', {
            reason: `${topic} 的机制叙述不在本体层`,
            sections: topic === 'full_sync' ? '初始化全同步原理' : '实时增量同步原理',
          }),
        ],
        note: '链路结构由进程对象与 feeds 边派生（本体层）；阶段机制见 delegated_to。',
      }
    }
    if (topic === 'topology') {
      const raw = [
        '## 部署与进程拓扑（本体派生）',
        ...lifecycle.concat(control).map((e) => `- ${e}`),
        `> 部署架构（控制机/工作节点/端口）见 ${DELEGATIONS['architecture']!.path}（值委托）。`,
      ].join('\n')
      return {
        topic,
        raw,
        lifecycle,
        control,
        delegated_to: [this.#delegation('architecture', { reason: '端口/部署点位明细' })],
      }
    }
    // 其余主题：直接给指针（章节名映射到 Skill 引用内的标题）
    const sectionMap: Record<string, string | null> = {
      transaction: '事务一致性保障',
      validation: '数据比对和修复机制',
      performance: null,
      oracle_log: 'Oracle 抽取与日志配置',
      mssql_mode: 'SQL Server 三种模式对比',
      matrix: '原理矩阵：15 种数据库',
    }
    if (topic in sectionMap) {
      const section = sectionMap[topic]
      if (topic === 'mssql_mode') {
        // SQL Server 三种模式：本体层保留「随库差异」指针级事实 + Skill 对照表
        return {
          topic,
          raw: '> SQL Server 三种部署模式（开 CDC / 开发布订阅 / 全都不开）约束对照已下延 ' +
            '`skill:i2stream-migration-designer/references/compatibility.md`（值委托）；' +
            '本体侧仅登记「三种模式」这一事实（`bkn/objects/database.bkn` MSSQLSource 段）。',
          delegated_to: [this.#delegation('compatibility', { reason: 'SQL Server 三种模式约束表' })],
        }
      }
      return {
        topic,
        raw: `> 「${section}」不在本体层（叙述类，23 号方案下延）——见 ` +
          `${DELEGATIONS['architecture']!.path}。`,
        delegated_to: [this.#delegation('architecture', { sections: section })],
      }
    }
    return null
  }

  static findTableInSection(section: Section | null | undefined, index = 0): Table | null {
    if (!section) return null
    const tables = section.tables
    return tables[index] ?? null
  }

  static matchDbRow(rows: Record<string, string>[], colName: string, candidate: string): Record<string, string> | null {
    for (const row of rows) {
      if (isDbMatch(candidate, row[colName] ?? '')) return row
    }
    return null
  }

  /**
   * 按库特殊约束 → 值委托指针（23 号方案）。
   *
   * 原 `compatibility.bkn`「按库特殊约束」表随值数据下延
   * `skill:i2stream-migration-designer/references/compatibility.md`；此处只给指针行。
   */
  getDbConstraints(source: string, target: string): string[] {
    const hits = [source, target].filter((db) => db && KNOWN_DBS.some((k) => isDbMatch(db, k)))
    if (!hits.length) return []
    return [`${hits.join('、')} 按库特殊约束: 见 ${DELEGATIONS['compatibility']!.id} 的 ` +
      `${DELEGATIONS['compatibility']!.path}（值委托，23 号方案）`]
  }

  /**
   * 字符集说明 → 值委托指针（23 号方案）。
   *
   * 原 `objects/env_matrix.bkn`「字符集速查」随值数据下延
   * `skill:i2stream-db-manager/references/charset.md`。
   */
  buildCharsetNotes(source: string, target: string): Record<string, unknown> {
    return {
      delegated_to: [
        this.#delegation('charset', {
          reason: `字符集规则与 ${source || '源端'}/${target || '目标端'} 确认项不在本体层`,
        }),
      ],
    }
  }

  /**
   * 本体侧 DB 对象事实（objects/database.bkn 的 `Object: <DB>Source` 段）。
   *
   * 只取定义性 KV（标识/数据库类型/全量方式/增量方式/部署模式要点），
   * 逐库版本下限/对象兼容/DDL 对照等值数据不在本体层。
   */
  #bknDbFacts(db: string): Record<string, string> {
    if (!db) return {}
    const keep = new Set(['标识', '数据库类型', '全量方式', '增量方式', '三种部署模式', '特殊', '原理'])
    for (const [secName, sec] of this.load('objects/database.bkn')) {
      if (!secName.startsWith('Object:')) continue
      const objDb = secName.slice('Object:'.length).replace(/Source$/, '').trim()
      if (!(isDbMatch(db, objDb) || isDbMatch(objDb, db))) continue
      const facts: Record<string, string> = {}
      for (const [k, v] of Object.entries(sec.kv)) {
        const key = k.trim().replace(/^\*+/, '').replace(/\*+$/, '').trim()
        if (keep.has(key)) facts[key] = v.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
      }
      facts['_source'] = `bkn:objects/database.bkn#${secName}`
      return facts
    }
    return {}
  }

  /**
   * 兼容性查询（23 号方案：本体派生注册集判定 + 值委托指针）。
   *
   * 保留（本体可判）：`supported`（KNOWN_DBS 注册集）+ 本体侧 DB 对象事实（bkn_db_facts）。
   * 下延（值数据）：源端/目标端版本下限、数据库对象兼容性、按库特殊约束、字符集规则
   * → `delegated_to` 指针 + Qdrant 兜底提示。
   */
  checkCompatibility(
    source: string,
    target: string,
    sourceVersion?: string,
    targetVersion?: string,
  ): Record<string, unknown> {
    const sMatch = KNOWN_DBS.some((db) => isDbMatch(source, db))
    const tMatch = KNOWN_DBS.some((db) => isDbMatch(target, db))
    return {
      supported: sMatch && tMatch,
      source,
      target,
      source_version: sourceVersion ?? null,
      target_version: targetVersion ?? null,
      bkn_db_facts: {
        source: this.#bknDbFacts(source),
        target: this.#bknDbFacts(target),
      },
      version_notes: {
        delegated: true,
        reason: '源端/目标端支持版本与验证版本为值数据（随版本发布增长），23 号下延',
      },
      object_compat: [],
      charset_notes: this.buildCharsetNotes(source, target),
      delegated_to: [
        this.#delegation('compatibility', {
          reason: '版本表/对象兼容性/按库约束/SQL Server 三种模式不在本体层（值数据）',
        }),
        this.#delegation('charset', { reason: '字符集规则与各库确认项不在本体层（值数据）' }),
      ],
      qdrant_hint: DELEGATION_QDRANT_HINT,
      risks: this.getDbConstraints(source, target),
      note: '本体层只能判定「是否受支持」（注册集）与 DB 对象定义事实；' +
        '版本/对象兼容/字符集明细按 delegated_to 加载 Skill 引用，或按 qdrant_hint 检索兜底。',
    }
  }

  /** 边界感知的错误码匹配：前后不能是字母/数字/_/-，避免 -407 命中 -4073。 */
  static codeBoundaryMatch(code: string, text: string): boolean {
    if (!code || !code.trim()) return false
    const boundary = '[a-zA-Z0-9_-]'
    return new RegExp(`(?<!${boundary})${escapeRegExp(code)}(?!${boundary})`).test(text)
  }

  /**
   * 查询错误码诊断指引（25 号：锚点表已删，改为「常量 + 边」组装）。
   *
   * 返回结构（字段名与 21 号对齐）：
   *   - `error_code`：规范码
   *   - `retrieval_guide`：完整定义去哪查（常量 DIAG_RETRIEVAL_GUIDE）
   *   - `suspected_process`：嫌疑进程列表，取自 `suspected_in` 边（本体权威）
   *   - `dimensions`：跨切面检查维度（has_class 边）
   *   - `aliases`：该码的语义别名（constants.ERROR_ALIASES，值数据层）
   *   - `unknown_rule`：未登记码的处理规则（dimension:unknown + gap_log）
   * 未知码（不在别名常量、且无边）返回 null——调用方据此走兜底。
   */
  getRisk(errorCode: string): RiskInfo | null {
    const clean = (errorCode ?? '').trim().replace(/^error:/, '').trim()
    if (!clean) return null
    const traverser = this.getTraverser()
    const processes = traverser.getTargets(`error:${clean}`, 'suspected_in')
    const aliases = Object.entries(ERROR_ALIASES).filter(([, c]) => c === clean).map(([a]) => a)
    const dimensions = traverser.getTargets(`error:${clean}`, 'has_class')
    if (!processes.length && !aliases.length && !dimensions.length) return null
    const info = {
      error_code: clean,
      retrieval_guide: DIAG_RETRIEVAL_GUIDE,
      suspected_process: processes,
      dimensions,
      aliases,
      unknown_rule: UNKNOWN_RULE,
    }
    return { ...info, raw: renderRiskContext(info) }
  }

  lookupOperation(operation: string): (OperationInfo & { matchedBy: string }) | null {
    if (!operation || !operation.trim()) return null
    const norm = (s: string) => s.replace(/\s+/g, '').replace(/_/g, '').toLowerCase()
    const q = norm(operation)
    type Cand = [number, string, OperationInfo, string]
    const candidates: Cand[] = []
    for (const [cap, info] of this.operations) {
      const capNorm = norm(cap)
      const nameNorm = norm(info.name ?? '')
      const aliasNorms = (info.aliases ?? []).filter(Boolean).map(norm)
      if (q === capNorm) candidates.push([0, cap, info, 'capability'])
      else if (aliasNorms.includes(q)) candidates.push([1, cap, info, 'alias'])
      else if (q.includes(nameNorm) && nameNorm) candidates.push([2, cap, info, 'name'])
      else if (q.includes(capNorm)) candidates.push([3, cap, info, 'capability_partial'])
      else if (aliasNorms.some((a) => q.includes(a))) candidates.push([4, cap, info, 'alias_partial'])
    }
    if (!candidates.length) return null
    candidates.sort((a, b) => a[0] - b[0])
    const [, cap, info, matchedBy] = candidates[0]!
    return {
      capability: cap,
      name: info.name,
      implements: info.implements ?? '',
      params: info.params ?? '',
      constraints: info.constraints ?? '',
      notes: info.notes ?? '',
      prerequisites: info.prerequisites ?? '',
      risks: info.risks ?? '',
      aliases: info.aliases ?? [],
      matchedBy,
      file: info.file,
    }
  }

  listOperations(): string[] {
    return [...this.operations.values()].map((o) => o.name)
  }

  /** 扫描 objects/scenario-*.bkn（24 号：原 bkn/scenarios/ 已并入 objects/ 并加 `scenario-` 前缀）。 */
  listScenarios(): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = []
    for (const [rel, data] of this.cache) {
      if (!/^objects\/scenario-[^/]+\.bkn$/.test(rel)) continue
      const kv = data.get('基本信息')?.kv ?? {}
      let id = kv['场景 ID'] ?? ''
      let name = kv['场景名称'] ?? ''
      const keywordsRaw = kv['关键词'] ?? ''
      const stem = rel.split('/').pop()!.replace(/\.bkn$/, '').replace(/^scenario-/, '')
      if (!id) id = stem
      if (!name) {
        for (const secName of data.keys()) {
          if (secName !== '_head' && secName !== '基本信息') { name = secName; break }
        }
      }
      if (!name) name = stem
      const keywords = keywordsRaw.split(/[，,、 \t\n\r\f\v]+/).map((k) => k.trim()).filter(Boolean)
      results.push({ id, name, keywords, file: rel })
    }
    return results.sort((a, b) => String(a.file).localeCompare(String(b.file)))
  }

  // ========== 场景匹配（Tool 层常量 SCENARIO_ROUTING_RULES，23 号） ==========

  /** 加载场景匹配规则（原 BKN scenario-rules.bkn 已下延为 Tool 层常量）。 */
  #loadScenarioRules(): ScenarioRule[] {
    const rules: ScenarioRule[] = SCENARIO_ROUTING_RULES.map((r) => ({
      priority: r.priority,
      sourcePattern: r.source_pattern,
      targetPattern: r.target_pattern,
      file: r.file,
      scenario: r.scenario,
      subScenario: r.sub_scenario,
      description: r.description,
      relationKey: r.relation_key,
    }))
    rules.sort((a, b) => a.priority - b.priority)
    this.#scenarioRules = rules
    return rules
  }

  get scenarioRules(): ScenarioRule[] {
    return this.#scenarioRules ?? this.#loadScenarioRules()
  }

  /** 单条模式匹配: same / * / 逗号分隔列表（same 在 matchScenario 中组合使用，这里恒 false）。 */
  #matchScenarioPattern(candidate: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (pattern === 'same') return false
    for (const pat of pattern.split(/[，,]/)) {
      const p = pat.trim()
      if (p && isDbMatch(candidate, p)) return true
    }
    return false
  }

  #ruleMatched(rule: ScenarioRule, source: string, target: string): boolean {
    const s = rule.sourcePattern
    const t = rule.targetPattern
    if (s === 'same' && t === 'same') return isDbMatch(source, target) && isDbMatch(target, source)
    if (s === 'same') return isDbMatch(source, target) && this.#matchScenarioPattern(target, t)
    if (t === 'same') return this.#matchScenarioPattern(source, s) && isDbMatch(target, source)
    return this.#matchScenarioPattern(source, s) && this.#matchScenarioPattern(target, t)
  }

  static #ruleResult(rule: ScenarioRule): ScenarioMatch {
    return {
      scenario: rule.scenario,
      subScenario: rule.subScenario,
      file: rule.file,
      description: rule.description,
      relationKey: rule.relationKey,
    }
  }

  static #scenarioDefault(): ScenarioMatch {
    return {
      scenario: '跨平台迁移',
      subScenario: '异构迁移',
      file: 'objects/scenario-dual-active.bkn',
      description: '异构数据库在线数据迁移',
      relationKey: '跨平台迁移',
    }
  }

  /** 基于规则匹配 L3 场景（对齐 Hermes match_scenario）。 */
  matchScenario(source: string, target: string): ScenarioMatch {
    const rules = this.scenarioRules
    if (!rules.length) return BKNResolver.#scenarioDefault()
    for (const rule of rules) {
      if (this.#ruleMatched(rule, source, target)) return BKNResolver.#ruleResult(rule)
    }
    return BKNResolver.#scenarioDefault()
  }

  /** 按场景名匹配规则；未命中时回退自动匹配（对齐 Hermes match_scenario_by_name）。 */
  matchScenarioByName(scenarioName: string, source: string, target: string): ScenarioMatch {
    const fallback = this.matchScenario(source, target)
    for (const rule of this.scenarioRules) {
      if (rule.scenario !== scenarioName) continue
      if (this.#ruleMatched(rule, source, target)) return BKNResolver.#ruleResult(rule)
    }
    return fallback
  }

  // ========== 前置条件（批 2-1 起为派生实现，P-A：Tool 是 BKN 的投影） ==========

  /** prerequisites.bkn 中「只读查询」段的段名前缀（无约束动作的兜底维度） */
  static readonly READONLY_DIMENSION_PREFIX = '只读查询'

  /**
   * 查询操作前置条件（派生）。
   *
   * 逐 action 前置不再存于 prerequisites.bkn：约束类前置由
   * `relations/action_routing.bkn` 的 constrained_by 边 × `risks/constraints.bkn`
   * 约束表实时派生；非约束类业务前置由各负责 Skill 承载。
   * prerequisites.bkn 只提供按 risk_type 维度的通行指引（T-Box 常数段）。
   *
   * 输出 raw 按「维度标题 + 通行指引 + 该操作具体约束」组装，末尾为
   * `- **负责 Skill**: \`xxx\`` 行与 `<!-- type: action -->` 段尾标记——
   * supplement.extractSkillFromResult 靠 kv 中的 `**负责 Skill**` 键提取 Skill。
   */
  getPrerequisites(operation: string): (Section & {
    capability: string
    matched_by: string
    skills: string[]
    constraint_ids: string[]
  }) | null {
    const info = this.lookupOperation(operation)
    if (!info) return null
    const capability = info.capability

    // 约束边与负责 Skill：图键是裸 capability（action: 前缀查不到）
    const traverser = this.getTraverser()
    const constraintIds = traverser.getConstraintsForAction(capability)
    let skills = traverser.getSkillsForAction(capability)
    if (!skills.length && (info.implements ?? '').startsWith('skill:')) {
      skills = [info.implements!.slice('skill:'.length)] // 无边动作回落 action 段 implements
    }

    // constraints.bkn 约束行（跨段汇总；加载策略/排查入口等表无「约束ID」列，自动跳过）
    const rowsById = new Map<string, Record<string, string>>()
    for (const sec of this.load('risks/constraints.bkn').values()) {
      for (const table of sec.tables) {
        for (const row of table.rows) {
          const cid = row['约束ID']
          if (cid) rowsById.set(cid, row)
        }
      }
    }
    const matchedRows = constraintIds
      .map((cid) => rowsById.get(cid))
      .filter((r): r is Record<string, string> => r !== undefined)

    // 维度段（T-Box 通行指引），段名形如 "state_prerequisite — 状态前置"
    const prereqData = this.load('risks/prerequisites.bkn')
    const dimensions = [...prereqData.entries()].filter(([name]) => name !== '_head')

    const dimensionBody = (sec: Section): string =>
      sec.raw.split('\n').filter((ln) => !ln.trim().startsWith('<!--')).join('\n').trim()

    const grouped = new Map<string, string[]>()
    const orphans: string[] = []
    for (const row of matchedRows) {
      const riskType = (row['类型'] ?? '').trim()
      const label = (row['Risk'] ?? '').trim()
      const text = (row['约束'] ?? '').trim()
      const item = label ? `- [${label}] ${text}` : `- ${text}`
      const secName = dimensions.find(([n]) => riskType && n.startsWith(riskType))?.[0]
      if (secName) {
        const items = grouped.get(secName) ?? []
        items.push(item)
        grouped.set(secName, items)
      } else {
        orphans.push(item) // 类型暂无维度段：不静默丢弃，落「其他约束」
      }
    }

    const lines = [`# ${info.name}（${capability}）前置条件`, '']
    if (matchedRows.length || orphans.length) {
      for (const [name, sec] of dimensions) {
        const items = grouped.get(name)
        if (!items) continue
        lines.push(`## ${name}`)
        const body = dimensionBody(sec)
        if (body) lines.push(body)
        lines.push(...items)
        lines.push('')
      }
    } else {
      lines.push(`## ${BKNResolver.READONLY_DIMENSION_PREFIX} — 无约束前置`)
      const sec = dimensions.find(([n]) => n.startsWith(BKNResolver.READONLY_DIMENSION_PREFIX))?.[1]
      if (sec) lines.push(dimensionBody(sec))
      lines.push('')
    }
    if (orphans.length) {
      lines.push('## 其他约束')
      lines.push(...orphans)
      lines.push('')
    }

    // 前置链（action 段 prerequisites kv，如 "[activate_node, register_source_db]"）
    const chainRaw = (info.prerequisites ?? '').trim().replace(/^\[/, '').replace(/\]$/, '')
    const chain = chainRaw.split(',').map((p) => p.trim()).filter(Boolean)
    if (chain.length) lines.push(`- 前置链: ${chain.join(' → ')}`)
    if (skills.length) lines.push('- **负责 Skill**: ' + skills.map((s) => `\`${s}\``).join(', '))
    lines.push('<!-- type: action -->')
    const raw = lines.join('\n')

    const section = new Section(raw)
    return Object.assign(section, {
      capability,
      matched_by: info.matchedBy,
      skills,
      constraint_ids: [...constraintIds],
    })
  }

  // ========== 症状 → Skill 路由（21/23 号方案对象轴） ==========

  /** 本体派生的排查框架（23 号方案，替代原 symptom-router「分析思路」段）。
   *
   * 组成：嫌疑进程链（feeds）× 各进程「日志自证性」× 检索源顺序（getEvidenceSources）。
   */
  #analysisFrameworkFor(processes: string[]): string {
    if (!processes.length) return ''
    const chain = this.getProcessChain(processes[0]!)
    const parts = ['对象轴排查框架（本体派生）：']
    for (const c of chain) {
      const suffix = String(c['self_sufficient'] ?? '').includes('需关联')
        ? ' → 需与链上其他进程对照时间线' : ''
      parts.push(`${c['process']}（${c['role'] ?? ''}，日志 ${c['log'] ?? ''}）${suffix}`)
    }
    const sources = this.getEvidenceSources(processes[0]!)
    if (sources.length) parts.push(`检索源顺序: ${sources.join(' → ')}`)
    return parts.join('\n')
  }

  /** 症状/错误码 → 过程轴必需的 Skill 列表（进程对象「关联」段派生）。 */
  #requiredSkillsForProcesses(processes: string[]): SymptomSkill[] {
    const required: SymptomSkill[] = []
    const seen = new Set<string>()
    for (const pid of processes) {
      for (const name of this.getProcessSkills(pid)) {
        if (seen.has(name)) continue
        seen.add(name)
        required.push({ name, reason: `进程 ${pid} 关联（objects/*.bkn 进程对象）` })
      }
    }
    return required
  }

  /**
   * 错误码 → 嫌疑进程（suspected_in 边）→ 进程 Skill（20 号方案对象轴）。
   *
   * 过渡期回退：suspected_in 未命中时走 has_class → diagnosed_by（保留一个版本周期）。
   * 码未登记返回 null，由调用方走 fallback。
   */
  #skillsForErrorCode(code: string): SymptomSkills | null {
    const traverser = this.getTraverser()
    const processes = traverser.getTargets(`error:${code}`, 'suspected_in')
    if (processes.length) {
      const required = this.#requiredSkillsForProcesses(processes)
      if (required.length) {
        const names = required.map((s) => s.name)
        return {
          required,
          optional: [manifestSkill('skill:i2stream-bkn-plugin', '补查错误码上下文（diagnose_error）', this.manifestPath)],
          analysis_framework: this.#analysisFrameworkFor(processes),
          skill_capabilities: manifestSkillCapabilities(names, this.manifestPath),
          analysis_source: 'bkn:objects/*.bkn（进程对象派生：进程链/日志自证性/检索源）',
          capabilities_source: 'manifest:plugin/skill_manifest.yaml（Skill 层能力概要）',
          diag_class: processes[0],
        }
      }
    }
    // 过渡期回退：has_class → diagnosed_by（20 号方案 §4.2，保留一个版本周期）
    const classes = traverser.getClassesForSymptom(`error:${code}`)
    if (!classes.length) return null
    const classId = classes[0]! // has_class 为 N:1
    const required = traverser.getSkillsForClass(classId).map((name) => ({
      name,
      reason: `诊断类 ${classId} 路由（diagnosed_by 边）`,
    }))
    // 分析思路：25 号起为「检索指引常量 + 维度边」（原锚点表已删）
    const dims = traverser.getTargets(`error:${code}`, 'has_class')
    let analysis = `诊断指引：完整定义查 ${DIAG_RETRIEVAL_GUIDE}`
    if (dims.length) analysis += `；跨切面维度 ${dims.join('、')}`
    const names = required.map((s) => s.name)
    return {
      required,
      optional: [manifestSkill('skill:i2stream-bkn-plugin', '补查错误码上下文（diagnose_error）', this.manifestPath)],
      analysis_framework: analysis,
      skill_capabilities: manifestSkillCapabilities(names, this.manifestPath),
      analysis_source: `bkn:relations/process_topology.bkn#suspected_in + constants.DIAG_RETRIEVAL_GUIDE（${DIAG_RETRIEVAL_GUIDE}）`,
      capabilities_source: 'manifest:plugin/skill_manifest.yaml（Skill 层能力概要）',
      diag_class: classId,
    }
  }

  /**
   * 根据症状或错误码提取 required/optional Skill 列表、分析思路（21/23 号方案对象轴）。
   *
   * 症状/错误码 → suspected_in → 进程关联 Skill（objects/*.bkn 各进程对象「关联」段）；
   * 跨切面回退 has_class → dimension diagnosed_by。分析思路/能力概要均为本体与 manifest 派生。
   * 未命中时 fallback 到默认 diagnostic skill。
   */
  getSymptomSkills(key: string): SymptomSkills {
    const clean = (key ?? '').trim()
    if (!clean) return this.fallbackSymptomSkills()

    // 裸名判定：数字/`-` 开头 → 错误码；否则 → 症状（现场说法 → 锚点归一）
    let node: string
    if (clean.includes(':')) node = clean
    else if (/^[0-9]/.test(clean) || clean.startsWith('-')) node = `error:${clean}`
    else node = `symptom:${clean}`
    const processes = this.getTraverser().getTargets(node, 'suspected_in')
    if (processes.length) {
      const required = this.#requiredSkillsForProcesses(processes)
      if (required.length) {
        const names = required.map((s) => s.name)
        return {
          required,
          optional: [],
          analysis_framework: this.#analysisFrameworkFor(processes),
          skill_capabilities: manifestSkillCapabilities(names, this.manifestPath),
          analysis_source: 'bkn:objects/*.bkn（进程对象派生：进程链/日志自证性/检索源）',
          capabilities_source: 'manifest:plugin/skill_manifest.yaml（Skill 层能力概要）',
        }
      }
    }
    // 错误码入参（带 error: 前缀）走对象轴 Skill（suspected_in → 进程）
    if (node.startsWith('error:')) {
      const graphResult = this.#skillsForErrorCode(node.slice('error:'.length))
      if (graphResult) return graphResult
    }
    return this.fallbackSymptomSkills()
  }

  /**
   * 读取诊断目标的「检索源」有序列表（18 号方向三元组的「查哪」）。
   *
   * 返回 store:xxx 有序列表（先查哪个集合/维度、后查哪个）；无字段返回 []。
   * 源端进程（iatrack/iadumper/ialoader）优先查 `store:log_patterns_collection#日志模式`，
   * 其余进程与维度类查 `store:i2stream_collection`。
   */
  getEvidenceSources(classId: string): string[] {
    if (!classId) return []
    if (classId.startsWith('process:')) {
      const proc = classId.slice('process:'.length)
      if (['iatrack', 'iadumper', 'ialoader'].includes(proc)) {
        return ['store:log_patterns_collection#日志模式', 'store:i2stream_collection']
      }
      return ['store:i2stream_collection']
    }
    if (classId.startsWith('dimension:')) {
      const dim = classId.slice('dimension:'.length)
      if (['consistency', 'state_machine'].includes(dim)) {
        return ['store:i2stream_collection', 'store:log_patterns_collection#日志模式']
      }
      return ['store:i2stream_collection']
    }
    return []
  }

  /**
   * 症状 → 日志导航（23 号方案：**本体派生**，不再解析导航表）。
   *
   * 派生链：症状/错误码 → `suspected_in` 边 → 嫌疑进程 → 进程链（`feeds` 边）
   * → 各进程「关键属性」的日志标识/频度/自证性。
   * `primary` = 首选嫌疑进程；`secondary` = 链上其余进程 + 守护（iahelper）；
   * `analysis_order` = 建议查看顺序。未命中症状返回 {}（缺省放行不报错）。
   */
  getLogMap(symptom = ''): Record<string, unknown> {
    const key = (symptom ?? '').trim()
    if (!key) return {}
    const processes = this.getProcessesForSymptom(key)
    if (!processes.length) return {}

    const short = (pid: string): string => pid.replace(/^process:/, '')
    const primary = processes[0]!
    const chain = this.getProcessChain(primary)
    const chainIds = chain.map((c) => String(c['process']))
    const secondary: string[] = []
    for (const pid of [...processes.slice(1), ...chainIds.slice(1)]) {
      const s = short(pid)
      if (s !== short(primary) && !secondary.includes(s)) secondary.push(s)
    }
    // 守护进程（生命周期管理）——排查进程存活/拉起问题时需要
    const supervisor = 'iahelper'
    if (supervisor !== short(primary) && !secondary.includes(supervisor)) secondary.push(supervisor)

    const analysisOrder = [primary, ...secondary.map((s) => `process:${s}`)].map((pid) => {
      const attrs = this.getProcessAttrs(pid)
      const selfSufficient = attrs['日志自证性'] ?? ''
      return {
        process: short(pid),
        log: attrs['日志标识'] ?? '',
        self_sufficient: selfSufficient,
        note: selfSufficient.includes('需关联') ? '需与链上其他进程对照时间线' : '本进程日志通常自证',
      }
    })

    const processDuties: Record<string, Record<string, string>> = {}
    for (const p of this.#iterProcessIds()) {
      const attrs = this.getProcessAttrs(p)
      processDuties[short(p)] = {
        log: attrs['日志标识'] ?? '',
        frequency: attrs['排查频度'] ?? '',
        self_sufficient: attrs['日志自证性'] ?? '',
      }
    }

    return {
      primary: short(primary),
      secondary,
      analysis_order: analysisOrder,
      chain: chainIds.map((p) => short(p)),
      level_tuning: LOG_LEVEL_TUNING,
      process_duties: processDuties,
      pattern_library_entry: 'search_qdrant(collection=log_patterns_collection, dimension=日志模式)',
      derived_from: 'bkn:relations/process_topology.bkn#suspected_in + bkn:objects/*.bkn#关键属性',
      note: '23 号方案：症状→日志顺序由 suspected_in/feeds 边与进程属性派生（本体层），' +
        '跨进程对照的根因速查见 skill:i2stream-log-analyzer。',
    }
  }

  /**
   * related_skills（Skill 索引，值委托）。
   *
   * 23 号方案：原 `diagnostics/related-skills.bkn`（已删）的导航下延 Skill 层，
   * 经 manifest 解析显示名（tools.py `_manifest_related_skills` 1:1）。
   */
  getDiagnoseRelatedSkills(): {
    related_skills: Array<{ name: string; when: string }>
    when_to_load: string
  } {
    const related = DEFAULT_RELATED_SKILLS.map(([sid, when]) => ({
      name: manifestSkillName(sid, this.manifestPath),
      when,
    }))
    return { related_skills: related, when_to_load: '需要具体诊断工具名和命令参数时' }
  }

  fallbackSymptomSkills(): SymptomSkills {
    return {
      required: [manifestSkill('skill:i2stream-db-diagnostics', '按 DB 类型执行具体诊断', this.manifestPath)],
      optional: [],
      analysis_framework: '',
      skill_capabilities: '',
    }
  }

  /** 从 Markdown 区块提取 `- \`skill:name\` (reason)` 列表（1:1 resolver._extract_skills_from_block）。 */
  static extractSkillsFromBlock(text: string, header: string): Array<{ name: string; reason: string }> {
    const skills: Array<{ name: string; reason: string }> = []
    const skillPattern = /^-[ \t]*`([^`]+)`[ \t]*(?:[(（](.*)[)）])?[ \t]*$/
    let inBlock = false
    for (const line of text.split('\n')) {
      const stripped = line.trim()
      // BKN 中加粗标题常写作列表项（- **标题**：），头匹配前先剥列表前缀
      const content = stripped.startsWith('- ') ? stripped.slice(2).trimStart() : stripped
      if (content.startsWith(header)) { inBlock = true; continue }
      if (!inBlock) continue
      if (stripped.startsWith('##') || stripped.startsWith('###')) break
      if (content.startsWith('**') && !content.includes(header)) break
      if (stripped.startsWith('- ')) {
        const m = skillPattern.exec(stripped)
        if (m) skills.push({ name: m[1]!.trim(), reason: (m[2] ?? '').trim() })
      }
    }
    return skills
  }

  /** 提取加粗标题后的自然语言段落（同行或后续行，直到下一个标题/区块结束）。 */
  static extractTextAfterHeader(text: string, header: string): string {
    if (!text) return ''
    let inBlock = false
    const paragraphs: string[] = []
    for (const line of text.split('\n')) {
      const stripped = line.trim()
      const content = stripped.startsWith('- ') ? stripped.slice(2).trimStart() : stripped
      if (content.startsWith(header)) {
        inBlock = true
        const rest = content.slice(header.length).replace(/^[ \t:：]+/, '')
        if (rest) paragraphs.push(rest)
        continue
      }
      if (!inBlock) continue
      if (stripped.startsWith('##') || stripped.startsWith('###')) break
      if (content.startsWith('**') && !content.includes(header)) break
      if (stripped.startsWith('- ')) break
      if (stripped) paragraphs.push(stripped)
      else if (paragraphs.length) break
    }
    return paragraphs.join(' ').trim()
  }

  /** 从前置条件 raw 文本中提取指定数据库类型的条目（"Oracle: xxx" 行式；别名经 isDbMatch 展开）。 */
  static extractDbSpecificPrerequisites(text: string, dbType: string): string[] {
    if (!text || !dbType) return []
    const results: string[] = []
    for (const line of text.split('\n')) {
      const stripped = line.trim().replace(/^[- *•]+/, '').trim()
      const idx = stripped.indexOf(':')
      if (idx <= 0) continue
      const prefix = stripped.slice(0, idx).trim()
      const rest = stripped.slice(idx + 1).trim()
      if (prefix && rest && isDbMatch(prefix, dbType)) {
        results.push(rest.replace(/[.,;，；]+$/, ''))
      }
    }
    return results
  }
}

/** getRisk 派生字段的可读渲染（Tool 层投影；字段全部来自常量与边，不引入新知识）。 */
function renderRiskContext(info: Omit<RiskInfo, 'raw'>): string {
  const lines = [`# 错误码 ${info.error_code} 诊断指引`, '']
  lines.push(`- 检索指引: ${info.retrieval_guide}`)
  if (info.suspected_process.length) lines.push(`- 嫌疑进程: ${info.suspected_process.join('、')}`)
  if (info.dimensions.length) lines.push(`- 检查维度: ${info.dimensions.join('、')}`)
  if (info.aliases.length) lines.push(`- 别名: ${info.aliases.join('、')}`)
  lines.push(`- 未登记码处理: ${info.unknown_rule}`)
  return lines.join('\n')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
