/**
 * resolver.ts — BKN 文件加载与解析引擎（DSH 版）
 *
 * 移植自 plugin/resolver.py：遍历 bkn/ 加载所有 .bkn 文件，
 * 提供结构化查询（Markdown 表格 / Section 拆分 / 键值对提取）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isDbMatch, KNOWN_DBS } from './constants.ts'

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

/** scenarios/scenario-rules.bkn「场景匹配规则」单条规则。 */
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
function walkBkn(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    try {
      if (statSync(p).isDirectory()) walkBkn(p, out)
      else if (e.endsWith('.bkn')) out.push(p)
    } catch { /* ignore */ }
  }
  return out
}

const PREREQ_OP_MAP: Record<string, string> = {
  activate_node: '激活工作节点',
  register_db: '注册数据库节点',
  create_rule: '创建同步规则',
  create_sync_rule: '创建同步规则',
  start_rule: '启动同步规则',
  start_sync_rule: '启动同步规则',
  stop_rule: '停止同步规则',
  stop_sync_rule: '停止同步规则',
  delete_rule: '删除同步规则',
  delete_sync_rule: '删除同步规则',
  compare_table: '创建表比较任务',
  create_compare: '创建表比较任务',
  failover: '执行灾备切换',
}

export class BKNResolver {
  readonly root: string
  readonly cache = new Map<string, Map<string, Section>>()
  readonly index = new Map<string, string>() // section_name → rel path
  readonly operations = new Map<string, OperationInfo>() // capability → info
  #synonymIndex?: Map<string, string>

  constructor(bknRoot: string) {
    this.root = bknRoot
    this.#loadAll()
  }

  #loadAll(): void {
    const files = walkBkn(this.root).sort()
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

  // ========== 同义词索引 ==========

  #buildSynonymIndex(): Map<string, string> {
    const index = new Map<string, string>()
    const data = this.cache.get('network.bkn')
    if (!data) return index
    const synSection = data.get('同义词映射')
    if (!synSection) return index
    for (const table of synSection.tables) {
      for (const row of table.rows) {
        const canonical = row['规范ID'] || row['规范名'] || row['规范格式'] || row['标准词'] || ''
        if (!canonical) continue
        const mainName = row['主名称']
        if (mainName) index.set(mainName.toLowerCase(), canonical)
        const synonyms = row['同义词'] || row['变体表达'] || ''
        for (const syn of synonyms.split(/[,，]/)) {
          const s = syn.trim().toLowerCase()
          if (s) index.set(s, canonical)
        }
      }
    }
    return index
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
    if (m) return `ORA-${m[1].padStart(5, '0')}`
    return c
  }

  // ========== 查询接口 ==========

  load(fileName: string): Map<string, Section> {
    return this.cache.get(fileName) ?? new Map()
  }

  getSection(sectionName: string): Section | null {
    const file = this.index.get(sectionName)
    return file ? this.cache.get(file)?.get(sectionName) ?? null : null
  }

  queryProduct(aspect = 'overview'): Section | null {
    const data = this.load('product.bkn')
    const sectionMap: Record<string, string> = {
      overview: '产品定位',
      positioning: '产品定位',
      advantages: '核心能力',
      competitors: '竞品对比',
      industries: '行业覆盖',
      xinchuang: '信创适配',
    }
    const target = sectionMap[aspect] ?? '产品定位'
    for (const [secName, sec] of data) {
      if (secName.includes(target)) return sec
    }
    return null
  }

  queryArchitecture(topic = 'all'): Section | null {
    const data = this.load('architecture.bkn')
    if (topic === 'all') return null // 调用方自行决定如何聚合
    const topicMap: Record<string, string> = {
      full_sync: '初始化全同步原理',
      incremental_sync: '实时增量同步原理',
      topology: '拓扑结构',
      transaction: '事务一致性保障',
      validation: '数据比对和修复机制',
      performance: '性能特性',
      oracle_log: 'Oracle 抽取与日志配置',
      mssql_mode: 'SQL Server 三种模式对比',
      matrix: '原理矩阵',
    }
    const target = topicMap[topic] ?? topic
    for (const [secName, sec] of data) {
      if (secName.includes(target)) return sec
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

  checkCompatibility(
    source: string,
    target: string,
    sourceVersion?: string,
    targetVersion?: string,
  ): Record<string, unknown> {
    const data = this.load('compatibility.bkn')
    const sMatch = KNOWN_DBS.some((db) => isDbMatch(source, db))
    const tMatch = KNOWN_DBS.some((db) => isDbMatch(target, db))

    const versionNotes: Record<string, Record<string, string>> = { source: {}, target: {} }
    const verTable = BKNResolver.findTableInSection(data.get('源端数据库版本'))
    if (verTable) {
      const sRow = BKNResolver.matchDbRow(verTable.rows, '数据库', source)
      const tRow = BKNResolver.matchDbRow(verTable.rows, '数据库', target)
      if (sRow) versionNotes.source = {
        min_version: sRow['最低版本'] ?? '',
        verified_versions: sRow['验证版本'] ?? '',
        special_notes: sRow['特殊说明'] ?? '',
      }
      if (tRow) versionNotes.target = {
        min_version: tRow['最低版本'] ?? '',
        verified_versions: tRow['验证版本'] ?? '',
        special_notes: tRow['特殊说明'] ?? '',
      }
    }

    const objectCompat: Record<string, string>[] = []
    const objTable = BKNResolver.findTableInSection(data.get('数据库对象兼容性'))
    if (objTable) objectCompat.push(...objTable.rows)

    const risks: string[] = []
    const unsupportedMarks = ['✗', '×', 'N/A']
    for (const row of objectCompat) {
      const objType = row['对象类型'] ?? ''
      const full = row['全量同步'] ?? ''
      const incr = row['增量同步'] ?? ''
      if (unsupportedMarks.some((m) => full.includes(m) || incr.includes(m))) {
        risks.push(`${objType}: 全量同步=${full}, 增量同步=${incr}`)
      }
    }
    // 按库特殊约束（数据驱动: compatibility.bkn「按库特殊约束」section；对齐 Hermes db-extensibility Phase 3）
    risks.push(...this.getDbConstraints(source, target))

    return {
      supported: sMatch && tMatch,
      source,
      target,
      source_version: sourceVersion ?? null,
      target_version: targetVersion ?? null,
      version_notes: versionNotes,
      object_compat: objectCompat,
      charset_notes: this.buildCharsetNotes(source, target),
      risks,
    }
  }

  /** 从 compatibility.bkn「按库特殊约束」section 按库名匹配收集约束（替代硬编码分支）。 */
  getDbConstraints(source: string, target: string): string[] {
    const section = this.load('compatibility.bkn').get('按库特殊约束')
    if (!section) return []
    const constraints: string[] = []
    for (const table of section.tables) {
      for (const row of table.rows) {
        const db = row['数据库'] ?? ''
        const note = row['约束说明'] ?? ''
        if (!db || !note) continue
        if (isDbMatch(source, db) || isDbMatch(target, db)) {
          const impact = row['影响面'] ?? ''
          constraints.push(`${db} 模式约束: ${note}${impact ? `（影响面: ${impact}）` : ''}`)
        }
      }
    }
    return constraints
  }

  /** 从 objects/env_matrix.bkn「字符集速查」构建字符集说明。 */
  buildCharsetNotes(source: string, target: string): Record<string, unknown> {
    const notes: { rules: Record<string, string>[]; source: Record<string, string>; target: Record<string, string> } = {
      rules: [], source: {}, target: {},
    }
    const section = this.load('objects/env_matrix.bkn').get('字符集速查')
    if (!section) return notes
    const tables = section.tables
    if (tables[0]) notes.rules = tables[0].rows
    if (tables[1]) {
      for (const row of tables[1].rows) {
        const db = row['数据库'] ?? ''
        if (isDbMatch(source, db)) notes.source = row
        if (isDbMatch(target, db)) notes.target = row
      }
    }
    return notes
  }

  /** 边界感知的错误码匹配：前后不能是字母/数字/_/-，避免 -407 命中 -4073。 */
  static codeBoundaryMatch(code: string, text: string): boolean {
    if (!code || !code.trim()) return false
    const boundary = '[a-zA-Z0-9_-]'
    return new RegExp(`(?<!${boundary})${escapeRegExp(code)}(?!${boundary})`).test(text)
  }

  getRisk(errorCode: string): Section | null {
    const data = this.load('risks/diagnostics.bkn')
    const clean = (errorCode ?? '').trim()
    if (!clean) return null
    for (const [secName, sec] of data) {
      if (BKNResolver.codeBoundaryMatch(clean, secName)) return sec
    }
    for (const [, sec] of data) {
      if (BKNResolver.codeBoundaryMatch(clean, sec.raw)) return sec
    }
    return null
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
    const [, cap, info, matchedBy] = candidates[0]
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

  listScenarios(): Array<Record<string, unknown>> {
    const scenariosDir = join(this.root, 'scenarios')
    const results: Array<Record<string, unknown>> = []
    let files: string[]
    try {
      files = readdirSync(scenariosDir).filter((f) => f.endsWith('.bkn')).sort()
    } catch {
      return results
    }
    for (const file of files) {
      if (file.endsWith('-rules.bkn')) continue
      const rel = `scenarios/${file}`
      const data = this.load(rel)
      const kv = data.get('基本信息')?.kv ?? {}
      let id = kv['场景 ID'] ?? ''
      let name = kv['场景名称'] ?? ''
      const keywordsRaw = kv['关键词'] ?? ''
      if (!id) id = file.replace(/\.bkn$/, '')
      if (!name) {
        for (const secName of data.keys()) {
          if (secName !== '_head' && secName !== '基本信息') { name = secName; break }
        }
      }
      if (!name) name = file.replace(/\.bkn$/, '')
      const keywords = keywordsRaw.split(/[，,、 \t\n\r\f\v]+/).map((k) => k.trim()).filter(Boolean)
      results.push({ id, name, keywords, file: rel })
    }
    return results
  }

  getPrerequisites(operation: string, dbType?: string): Section | null {
    const data = this.load('operations/actions/prerequisites.bkn')
    const keyword = PREREQ_OP_MAP[operation] ?? operation
    const kw = keyword.replace(/\s+/g, '').toLowerCase()
    // 优先精确包含匹配，回退到词干匹配（如「创建同步规则」章节吸收 create_sync_rule 族）
    const stem = kw.replace(/^(创建|启动|停止|删除|注册|激活|执行)/, '')
    for (const [secName, sec] of data) {
      const name = secName.replace(/\s+/g, '').toLowerCase()
      if (kw && name.includes(kw)) return sec
    }
    if (stem.length >= 3) {
      for (const [secName, sec] of data) {
        const name = secName.replace(/\s+/g, '').toLowerCase()
        if (name.includes(stem)) return sec
      }
    }
    return null
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

  // ========== 场景匹配（scenarios/scenario-rules.bkn「场景匹配规则」）==========

  #scenarioRules?: ScenarioRule[]

  #loadScenarioRules(): ScenarioRule[] {
    const data = this.load('scenarios/scenario-rules.bkn')
    const table = BKNResolver.findTableInSection(data.get('场景匹配规则'))
    const rules: ScenarioRule[] = []
    if (table) {
      for (const row of table.rows) {
        rules.push({
          priority: Number.parseInt(row['priority'] ?? '0', 10) || 0,
          sourcePattern: row['source_pattern'] ?? '*',
          targetPattern: row['target_pattern'] ?? '*',
          file: row['scenario_file'] ?? 'scenarios/dual-active.bkn',
          scenario: row['scenario_name'] ?? '跨平台迁移',
          subScenario: row['sub_scenario'] ?? '',
          description: row['description'] ?? '',
          relationKey: row['relation_key'] ?? '',
        })
      }
    }
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

  /** 基于 BKN 规则匹配 L3 场景（对齐 Hermes match_scenario）。 */
  matchScenario(source: string, target: string): ScenarioMatch {
    const fallback: ScenarioMatch = {
      scenario: '跨平台迁移',
      subScenario: '',
      file: 'scenarios/dual-active.bkn',
      description: '异构数据库在线数据迁移',
      relationKey: '跨平台迁移',
    }
    const rules = this.scenarioRules
    if (!rules.length) return fallback
    for (const rule of rules) {
      const s = rule.sourcePattern
      const t = rule.targetPattern
      let matched = false
      if (s === 'same' && t === 'same') {
        matched = isDbMatch(source, target) && isDbMatch(target, source)
      } else if (s === 'same') {
        matched = isDbMatch(source, target) && this.#matchScenarioPattern(target, t)
      } else if (t === 'same') {
        matched = this.#matchScenarioPattern(source, s) && isDbMatch(target, source)
      } else {
        matched = this.#matchScenarioPattern(source, s) && this.#matchScenarioPattern(target, t)
      }
      if (matched) {
        return {
          scenario: rule.scenario,
          subScenario: rule.subScenario,
          file: rule.file,
          description: rule.description,
          relationKey: rule.relationKey,
        }
      }
    }
    return fallback
  }

  /** 按场景名匹配规则；未命中时回退自动匹配（对齐 Hermes match_scenario_by_name）。 */
  matchScenarioByName(scenarioName: string, source: string, target: string): ScenarioMatch {
    const fallback = this.matchScenario(source, target)
    const rules = this.scenarioRules
    if (!rules.length) return fallback
    for (const rule of rules) {
      if (rule.scenario !== scenarioName) continue
      const s = rule.sourcePattern
      const t = rule.targetPattern
      let matched = false
      if (s === 'same' && t === 'same') {
        matched = isDbMatch(source, target) && isDbMatch(target, source)
      } else if (s === 'same') {
        matched = isDbMatch(source, target) && this.#matchScenarioPattern(target, t)
      } else if (t === 'same') {
        matched = this.#matchScenarioPattern(source, s) && isDbMatch(target, source)
      } else {
        matched = this.#matchScenarioPattern(source, s) && this.#matchScenarioPattern(target, t)
      }
      if (matched) {
        return {
          scenario: rule.scenario,
          subScenario: rule.subScenario,
          file: rule.file,
          description: rule.description,
          relationKey: rule.relationKey,
        }
      }
    }
    return fallback
  }
  // ─────────── 诊断导航（阶段3，移植自 resolver.get_log_map / get_symptom_skills） ───────────

  /**
   * log-map.bkn → 症状日志导航（症状→查看顺序 + 进程职责 + 级别调整 + 模式库入口）。
   * 未命中症状或文件缺失返回 {}（缺省放行不报错）。
   */
  getLogMap(symptom = ''): Record<string, unknown> {
    const data = this.load('diagnostics/log-map.bkn')
    if (!data.size) return {}

    const parseTable = (raw: string): string[][] => {
      const rows: string[][] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('|')) continue
        const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        if (cells.length && cells.filter(Boolean).every((c) => /^-{2,}$/.test(c))) continue
        rows.push(cells)
      }
      return rows
    }

    const symptomMap = new Map<string, Record<string, string>>()
    const processMap: Record<string, string> = {}
    const levelTuning: Array<{ scenario: string; suggestion: string; action: string }> = []

    for (const [secName, sec] of data) {
      const raw = sec.raw
      if (secName.includes('症状') && secName.includes('查看顺序')) {
        for (const row of parseTable(raw)) {
          if (row.length >= 4 && row[0] !== '症状') {
            symptomMap.set(row[0]!, { primary: row[1]!, secondary: row[2]!, analysis_order: row[3]! })
          }
        }
      } else if (secName.includes('进程') && secName.includes('职责')) {
        for (const row of parseTable(raw)) {
          if (row.length >= 3 && row[0] !== '进程') processMap[row[0]!] = row[1]!
        }
      } else if (secName.includes('级别') && secName.includes('调整')) {
        for (const row of parseTable(raw)) {
          if (row.length >= 3 && row[0] !== '场景') {
            levelTuning.push({ scenario: row[0]!, suggestion: row[1]!, action: row[2]! })
          }
        }
      }
    }

    const entry = symptomMap.get(symptom.trim())
    if (!entry) return {}
    return {
      ...entry,
      process_duties: processMap,
      level_tuning: levelTuning,
      pattern_library_entry: 'search_qdrant(collection=log_patterns_collection, dimension=日志模式)',
    }
  }

  /**
   * symptom-router.bkn → 必需/可选 Skill 列表 + 分析思路 + 能力概要。
   * 直接匹配 `Symptom: <key>` 区块，或「错误码精确匹配」段内 `### <key>:` 子块。
   * 未命中时回退默认诊断 Skill。
   */
  getSymptomSkills(key: string): {
    required: Array<{ name: string; reason: string }>
    optional: Array<{ name: string; reason: string }>
    analysis_framework: string
    skill_capabilities: string
  } {
    const clean = (key ?? '').trim()
    const data = this.load('diagnostics/symptom-router.bkn')
    let raw = clean && data.size ? data.get(`Symptom: ${clean}`)?.raw ?? '' : ''

    if (!raw && clean) {
      const errorSection = data.get('错误码精确匹配')
      const errorRaw = errorSection?.raw ?? ''
      if (errorRaw) {
        const parts = errorRaw.split(/\n### /)
        for (const part of parts.slice(1)) {
          if (part.startsWith(`${clean}:`) || part.startsWith(`${clean} `)) { raw = part; break }
        }
      }
    }
    if (!raw) return BKNResolver.fallbackSymptomSkills()
    return {
      required: BKNResolver.extractSkillsFromBlock(raw, '**需要加载的 Skill**'),
      optional: BKNResolver.extractSkillsFromBlock(raw, '**可选 Skill**'),
      analysis_framework: BKNResolver.extractTextAfterHeader(raw, '**分析思路**'),
      skill_capabilities: BKNResolver.extractTextAfterHeader(raw, '**Skill 能力概要**'),
    }
  }

  /** related-skills.bkn → Skill 索引（失败回退空）。 */
  getDiagnoseRelatedSkills(): { related_skills: Array<{ name: string; reason: string }>; when_to_load?: string } {
    const data = this.load('diagnostics/related-skills.bkn')
    const section = data.get('Skill 索引')
    if (!section) return { related_skills: [] }
    const related = BKNResolver.extractSkillsFromBlock(section.raw, '**Skill 索引**').length
      ? BKNResolver.extractSkillsFromBlock(section.raw, '**Skill 索引**')
      : section.tables.length
        ? section.tables.flatMap((t) => t.rows.map((r) => ({ name: String(r[0] ?? ''), reason: String(r[1] ?? '') }))).filter((s) => s.name)
        : []
    const when = section.kv['when_to_load'] ?? section.kv['**when_to_load**']
    return { related_skills: related, when_to_load: when }
  }

  static fallbackSymptomSkills(): {
    required: Array<{ name: string; reason: string }>
    optional: Array<{ name: string; reason: string }>
    analysis_framework: string
    skill_capabilities: string
  } {
    return {
      required: [{ name: 'i2stream-db-diagnostics', reason: '默认诊断入口' }],
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
      if (stripped.startsWith(header)) { inBlock = true; continue }
      if (!inBlock) continue
      if (stripped.startsWith('##') || stripped.startsWith('###')) break
      if (stripped.startsWith('**') && !header.includes(stripped.replace(/\*/g, '')) && stripped !== header) break
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
    const lines = text.split('\n')
    let inBlock = false
    const paragraphs: string[] = []
    for (const line of lines) {
      const stripped = line.trim()
      if (stripped.startsWith(header)) {
        const inline = stripped.slice(stripped.indexOf(header) + header.length).replace(/^[:：]\s*/, '').trim()
        if (inline) paragraphs.push(inline)
        inBlock = true
        continue
      }
      if (!inBlock) continue
      if (stripped.startsWith('##') || stripped.startsWith('###') || stripped.startsWith('**') || stripped.startsWith('- ') || stripped.startsWith('|')) break
      if (stripped) paragraphs.push(stripped)
    }
    return paragraphs.join('\n')
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
