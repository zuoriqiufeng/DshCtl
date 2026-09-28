/**
 * bknContract.ts — BKN 契约校验（v26 世代）：把「解析静默失灵」变为「启动响亮失败」。
 *
 * 背景：插件按 BKN v26（2026-09-24 本体分层重构 19→26 号）语义解析。BKN 是共享只读数据
 * （与 Hermes 工作区共用一份），上游再重构时插件若不匹配，旧行为是各工具静默返回空/兜底，
 * 表现为「能回答但答错」。本校验在插件加载时锁定最小契约集，不匹配即：
 *   strict（默认）→ logger.error + throw（fiber FAILED，工具从模型工具表消失，实例照常启动）
 *   warn → logger.error + 继续（工具保留，风险自知）；off → 仅 info
 *
 * 校验集合（最小覆盖，对应 /hdd/demo/public/i2stream-bkn/bkn/SCHEMA.md 26 号终态）：
 *   ① 根目录存在 ② SCHEMA.md/SKILL.md 存在 ③ 世代号 ≥ CONTRACT_MIN_GENERATION
 *   ④ objects/relations/actions/risks 四目录各 ≥1 个 .bkn
 *   ⑤ 关键 6 文件存在且含关键区块（syncrule 状态机、constraints 约束ID、
 *      action_routing 双关系类型、process_topology suspected_in、product 产品定位、prerequisites 状态前置）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 插件解析语义对应的最低 BKN 世代（26 号 = KWeaver 四元收敛终态） */
export const CONTRACT_MIN_GENERATION = 26

export type ContractMode = 'strict' | 'warn' | 'off'

export interface ContractResult {
  ok: boolean
  /** 从 SCHEMA.md（缺则 SKILL.md）提取的世代号；提取不到为 null */
  generation: number | null
  issues: string[]
}

/** 关键文件 → 必须包含的区块/标记（任一缺失即 issue） */
const REQUIRED_FILES: Array<[string, string[]]> = [
  ['objects/product.bkn', ['## 产品定位']],
  ['objects/syncrule.bkn', ['## 状态机']],
  ['relations/action_routing.bkn', ['constrained_by', 'risks_of']],
  ['relations/process_topology.bkn', ['suspected_in']],
  ['risks/constraints.bkn', ['约束ID']],
  ['risks/prerequisites.bkn', ['状态前置']],
]

const GENERATION_RE = /(\d+)\s*号/

export function validateBknContract(bknRoot: string): ContractResult {
  const issues: string[] = []
  if (!existsSync(bknRoot)) return { ok: false, generation: null, issues: [`BKN 根目录不存在: ${bknRoot}`] }

  const schemaPath = join(bknRoot, 'SCHEMA.md')
  const skillPath = join(bknRoot, 'SKILL.md')
  if (!existsSync(schemaPath)) issues.push(`缺 SCHEMA.md（类型枚举标准，v26 契约锚）：${schemaPath}`)
  if (!existsSync(skillPath)) issues.push(`缺 SKILL.md（导航/批次演进）：${skillPath}`)

  let generation: number | null = null
  for (const p of [schemaPath, skillPath]) {
    if (generation !== null || !existsSync(p)) continue
    const m = GENERATION_RE.exec(readFileSync(p, 'utf8'))
    if (m) generation = Number(m[1])
  }
  if (generation === null) issues.push('SCHEMA.md/SKILL.md 均无世代号标记（正则 `(\\d+)\\s*号`）——无法确认契约世代')
  else if (generation < CONTRACT_MIN_GENERATION) issues.push(`BKN 世代号 ${generation} < ${CONTRACT_MIN_GENERATION}（本插件按 v26 四元收敛语义解析）`)

  for (const dir of ['objects', 'relations', 'actions', 'risks']) {
    const d = join(bknRoot, dir)
    const files = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.bkn')) : []
    if (!files.length) issues.push(`目录 ${dir}/ 缺 .bkn 文件（v26 本体层四核心类别）`)
  }

  for (const [rel, needles] of REQUIRED_FILES) {
    const p = join(bknRoot, rel)
    if (!existsSync(p)) { issues.push(`缺关键文件 ${rel}`); continue }
    const text = readFileSync(p, 'utf8')
    for (const n of needles) if (!text.includes(n)) issues.push(`${rel} 缺关键区块/标记「${n}」`)
  }

  return { ok: issues.length === 0, generation, issues }
}

/**
 * 校验结果 → 处置（index.ts 调用；保持 strict 语义集中在此，便于 self-test 覆盖）。
 * 返回 fatal 表示调用方应 throw（strict 且不匹配）。
 */
export function handleContractResult(
  result: ContractResult,
  mode: ContractMode,
  log: { info: (m: string) => void; error: (m: string) => void },
): { fatal: boolean; message?: string } {
  if (mode === 'off') return { fatal: false }
  if (result.ok) {
    log.info(`[i2stream-bkn] BKN 契约校验通过（世代 ${result.generation ?? '未知'}）`)
    return { fatal: false }
  }
  const detail = result.issues.map((i) => `  - ${i}`).join('\n')
  log.error(`[i2stream-bkn] BKN 契约校验失败（世代 ${result.generation ?? '未知'}，模式 ${mode}，${result.issues.length} 项）：\n${detail}`)
  if (mode === 'strict') {
    return {
      fatal: true,
      message: `[i2stream-bkn] BKN 契约校验失败（${result.issues.length} 项，详见启动日志）——插件按 v26 语义解析，数据不匹配会导致工具静默错答；确需带病运行请设 contractCheck: 'warn'|'off'`,
    }
  }
  return { fatal: false }
}
