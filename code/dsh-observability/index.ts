/**
 * index.ts — dsh-observability：观测插件（roadmap P1a，ops-agent-future-roadmap-plan.md §2.1）
 *
 * 职责（跨切面能力，独立成插件）：
 *   1. usage 留档：ops-api afterTurn 上报 → usage-YYYYMMDD.jsonl（按日分文件 + 512KB×3 轮转）
 *   2. 护栏审计：订阅 dsh-plugin 的 `bkn/risk-hit` 自定义事件 → risk-YYYYMMDD.jsonl（verdict 分档）
 *   3. 聚合只读：ctx.provide('observability', …) 供 ops-api 挂 /v1/metrics 与 /admin 观测卡片
 *
 * 纪律：
 *   - H-15 推广：采集/写盘失败静默丢弃 + warn，绝不影响请求路径
 *   - 零跨插件 import（S0）：对 dsh-plugin/ops-api 的全部耦合走事件名与服务名（松契约）
 *   - 无本插件时 ops-api `ctx.get('observability')` 为 undefined → 自动降级（不挂路由）
 *
 * 加固批次（2026-11-05）：
 *   - 轮转分片（.jsonl.N）计入聚合与 recentRisk（修复分片被 readDays 漏读的数据失真 bug）
 *   - retentionDays 留存上限（默认 30，0=永久；写盘时惰性清理超期文件）
 *   - aggregate 行缓存（mtime+size 指纹失效，未变更文件不重读——/v1/metrics 从 O(全部数据) 降为 O(变更文件)）
 */

import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-observability'
export const inject = [] as const
export const reusable = true

export interface Config {
  enabled?: boolean
  dataDir?: string
  maxBytes?: number
  backups?: number
  /** 留存天数（默认 30；0=永久）。写盘时惰性清理超期的 usage-× / risk-× 日期文件（含轮转分片） */
  retentionDays?: number
}

/** 轮转参数（与 dsh-plugin supplement 同款 512KB×3，实现复制不 import——S0） */
const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_BACKUPS = 3
const DEFAULT_RETENTION_DAYS = 30

interface UsageRecord { ts: number; sessionId: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number; finishReason: string; turnMs?: number }
/** finishReason 口径（低基数属性，对齐 OTel GenAI error.type 纪律）：
 *  stop=正常 / timeout=turn 超时 / abandoned=turn 弃答 / error=其他异常 */
interface RiskRecord { ts: number; verdict: string; tool?: string; action?: string; state?: string; ruleId?: string | null; reason?: string | null; blockable?: boolean }
/** OTel GenAI 对齐注记（字段命名映射，不改运行时）：
 *  requests → gen_ai.invoke_agent.calls；totalTokens → gen_ai.client.token.usage{type=total}；
 *  riskHits → execute_tool 拦截事件分档；errors → gen_ai.invoke_agent 失败计数（error.type=finishReason）。 */
interface DailyAgg { days: number; requests: number; totalTokens: number; promptTokens: number; completionTokens: number; errors: number; errorsTimeout: number; errorsAbandoned: number; riskHits: { total: number; block: number; advisory: number; shadow: number; gray: number }; sessions: number }

function dayTag(ts = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 512KB×3 轮转（复制 dsh-plugin supplement.rotateIfNeeded 同款策略，S0 不 import） */
function rotateIfNeeded(path: string, maxBytes: number, backups: number): void {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return
    for (let i = backups - 1; i >= 1; i--) {
      const from = `${path}.${i}`
      const to = `${path}.${i + 1}`
      if (existsSync(from)) renameSync(from, to)
    }
    renameSync(path, `${path}.1`)
  } catch { /* 轮转失败不抛 */ }
}

/** usage-/risk- 前缀文件（含轮转分片 .jsonl.N）→ 日期段升序、同日内「最新优先」（主文件 shard=0 最右，
 * 分片 .1 次之、.N 越大越旧）——recentRisk 从最右倒序取即得最新 N 条；聚合求和与文件序无关。 */
function listBaseFiles(dataDir: string, base: string): string[] {
  try {
    const re = new RegExp(`^${base}-(\\d{8})\\.jsonl(\\.(\\d+))?$`)
    return readdirSync(dataDir)
      .map((f) => { const m = re.exec(f); return m ? { f, day: m[1]!, shard: Number(m[3] ?? 0) } : null })
      .filter((x): x is { f: string; day: string; shard: number } => x !== null)
      .sort((a, b) => a.day === b.day ? b.shard - a.shard : (a.day < b.day ? -1 : 1))
      .map((x) => x.f)
  } catch { return [] }
}

export function apply(ctx: Context, config: Config = {}): void {
  const log = (m: string): void => { try { ctx.logger('dsh-observability').info(m) } catch { /* 无 logger 静默 */ } }
  const warn = (m: string): void => { try { ctx.logger('dsh-observability').warn(m) } catch { console.warn(`[dsh-observability] ${m}`) } }
  if (config.enabled === false) { log('观测插件已禁用（enabled=false）'); return }

  const dshHome = process.env.DSH_HOME ?? process.cwd()
  const dataDir = config.dataDir || join(dshHome, 'observability')
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  const backups = config.backups ?? DEFAULT_BACKUPS
  const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS

  try { mkdirSync(dataDir, { recursive: true }) } catch (e) { warn(`dataDir 创建失败（观测停用，不影响主流程）: ${(e as Error).message}`); return }

  // ── 留存清理（惰性：随每次写盘触发；删除超期日期文件，失败静默） ──
  const pruneOldFiles = (): void => {
    if (retentionDays <= 0) return
    try {
      const cutoff = dayTag(Date.now() - retentionDays * 86_400_000)
      for (const f of readdirSync(dataDir)) {
        if (!/^((usage)|(risk))-\d{8}\.jsonl(\.\d+)?$/.test(f)) continue
        const day = /^((usage)|(risk))-(\d{8})/.exec(f)?.[4]
        if (day && day < cutoff) { try { unlinkSync(join(dataDir, f)) } catch { /* 静默 */ } }
      }
    } catch { /* 静默 */ }
  }

  // ── 落盘原语：JSONL 追加 + 轮转；任何失败静默 + warn ──
  const appendJsonl = (base: string, rec: unknown): void => {
    try {
      const path = join(dataDir, `${base}-${dayTag()}.jsonl`)
      rotateIfNeeded(path, maxBytes, backups)
      appendFileSync(path, JSON.stringify(rec) + '\n')
      pruneOldFiles()
    } catch (e) { warn(`落盘失败（静默丢弃）: ${(e as Error).message.slice(0, 120)}`) }
  }

  // ── 1. usage 流：ops-api afterTurn 调用 ──
  const recordUsage = (rec: UsageRecord): void => appendJsonl('usage', rec)

  // ── 2. 护栏审计流：dsh-plugin `bkn/risk-hit` 事件 ──
  try { ctx.on('bkn/risk-hit', (payload: RiskRecord) => { appendJsonl('risk', { ts: Math.floor(Date.now() / 1000), ...payload }) }) } catch (e) { warn(`risk-hit 订阅失败: ${(e as Error).message}`) }

  // ── 3. 聚合只读服务（ops-api /v1/metrics 与 /admin 消费；缺席时调用方 ctx.get 为 undefined）──
  // 行缓存：按 {path: mtime+size} 指纹失效——/v1/metrics 与 /admin 30s 轮询未变更文件不重读
  const lineCache = new Map<string, { fingerprint: string; lines: unknown[] }>()
  const readLines = (path: string): unknown[] => {
    try {
      const st = statSync(path)
      const fp = `${st.mtimeMs}:${st.size}`
      const hit = lineCache.get(path)
      if (hit && hit.fingerprint === fp) return hit.lines
      const out: unknown[] = []
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
      lineCache.set(path, { fingerprint: fp, lines: out })
      return out
    } catch { return [] }
  }

  const aggregate = (days?: number): DailyAgg => {
    const agg: DailyAgg = { days: 0, requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, errors: 0, errorsTimeout: 0, errorsAbandoned: 0, riskHits: { total: 0, block: 0, advisory: 0, shadow: 0, gray: 0 }, sessions: 0 }
    const sessions = new Set<string>()
    const allUsage = listBaseFiles(dataDir, 'usage')
    const usageDays = days ? allUsage.slice(-days) : allUsage
    for (const f of usageDays) {
      agg.days++
      for (const raw of readLines(join(dataDir, f))) {
        const r = raw as Partial<UsageRecord>
        agg.requests++
        agg.promptTokens += Number(r.promptTokens ?? 0)
        agg.completionTokens += Number(r.completionTokens ?? 0)
        agg.totalTokens += Number(r.totalTokens ?? 0)
        if (r.sessionId) sessions.add(r.sessionId)
        // 失败分档（审计报告 Top2）：finishReason 非 stop/空 即失败 turn（timeout/abandoned/error）
        const fr = String(r.finishReason ?? '')
        if (fr && fr !== 'stop') {
          agg.errors++
          if (fr === 'timeout') agg.errorsTimeout++
          else if (fr === 'abandoned') agg.errorsAbandoned++
        }
      }
    }
    const allRisk = listBaseFiles(dataDir, 'risk')
    const riskDays = days ? allRisk.slice(-days) : allRisk
    for (const f of riskDays) {
      for (const raw of readLines(join(dataDir, f))) {
        const r = raw as Partial<RiskRecord>
        agg.riskHits.total++
        const v = String(r.verdict ?? '')
        if (v === 'block' || v === 'advisory' || v === 'shadow' || v === 'gray') agg.riskHits[v]++
      }
    }
    agg.sessions = sessions.size
    return agg
  }

  ctx.provide('observability', {
    recordUsage,
    aggregate,
    dataDir: (): string => dataDir,
    recentRisk: (limit = 20): RiskRecord[] => {
      // listBaseFiles 同日内已「最新优先」（主文件最右）；从最右文件起逐文件倒行取，满足 limit 即止
      const out: RiskRecord[] = []
      const files = listBaseFiles(dataDir, 'risk')
      for (let fi = files.length - 1; fi >= 0 && out.length < limit; fi--) {
        const lines = readLines(join(dataDir, files[fi]!))
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) out.push(lines[i] as RiskRecord)
      }
      return out
    },
  })
  log(`观测就绪：dataDir=${dataDir} retention=${retentionDays}d`)
}
