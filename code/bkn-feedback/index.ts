/**
 * index.ts — bkn-feedback：BKN 反馈回流插件（roadmap P1b，ops-agent-future-roadmap-plan.md §2.2）
 *
 * 职责（把 gap_log 闭环闭上——现在只写不读）：
 *   1. capture_correction 工具：用户纠正后由 Agent 调用，追加 gap_log 行并置位 user_supplied
 *      （打通 dsh-plugin supplement.logGap 硬编码 user_supplied=null 的死字段；entry schema 只增不破）
 *   2. curator 式周期报告：扫描 gap_log → 置信度分布 / 高频 gap / resolved 积压 → reportDir/gap-report-<date>.md
 *
 * 纪律：
 *   - 不 import dsh-plugin 任何符号（S0）：gap_log 只按 JSONL 行协议消费（{tool,params,confidence,gaps,timestamp,user_supplied,resolved}）
 *   - 不自动改 BKN 数据：BKN 是与 Hermes 共享的资产，只读消费；本插件产出仅为"建议清单"
 *   - H-15：文件缺失/坏行 → 报告"无数据"，不抛错
 */

import { join, isAbsolute, resolve } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'bkn-feedback'
export const inject = ['tools', 'timer'] as const
export const reusable = true

/** 与 dsh-plugin EXTERNAL_DEFAULTS.gapLogPath 同值（复制常量，S0 不 import） */
const DEFAULT_GAP_LOG = '/hdd/demo/public/i2stream-bkn/logs/gap_log.jsonl'

export interface Config {
  /** gap 日志路径（与 dsh-plugin gapLogPath 同名同链：config → env I2STREAM_GAP_LOG → 默认共享路径） */
  gapLogPath?: string
  /** 报告输出目录（默认 $DSH_HOME/feedback-reports） */
  reportDir?: string
  /** 周期报告间隔（小时，默认 168 = 7 天） */
  intervalHours?: number
  /** 启动后首轮延迟（秒，默认 120，对齐 curator 惯例） */
  firstRunDelaySec?: number
  /** 工具与定时器总开关（默认 true） */
  enabled?: boolean
}

export const Config: Schema<Config> = Schema.object({
  gapLogPath: Schema.string().description('gap 日志路径；默认与 dsh-plugin 共享同一文件'),
  reportDir: Schema.string().description('周期报告输出目录；默认 $DSH_HOME/feedback-reports'),
  intervalHours: Schema.natural().min(1).default(168).description('周期报告间隔（小时）'),
  firstRunDelaySec: Schema.natural().default(120).description('首轮报告延迟（秒）'),
  enabled: Schema.boolean().default(true).description('总开关'),
})

const CAPTURE_PARAMS = {
  tool: { type: 'string' as const, required: true, description: '被纠正的工具名（如 design_solution）' },
  params: { type: 'string' as const, description: '当时的工具参数（JSON 字符串；可省）' },
  gaps: { type: 'string' as const, description: '缺失维度（逗号分隔，如 relations,risk）' },
  correction: { type: 'string' as const, required: true, description: '用户纠正内容（原文或要点）' },
}

// ── 纯函数（self-test 直接 import 验证；无 cordis 依赖） ──

export interface GapEntry { tool: string; params?: unknown; confidence?: string; gaps?: string[]; timestamp?: number; user_supplied?: string | null; resolved?: boolean; correction?: string }

/** gap_log 轮转参数（与 dsh-observability 同款 512KB×3，S0 复制不 import——审计报告 Top5：写侧三无） */
const GAP_MAX_BYTES = 512 * 1024
const GAP_BACKUPS = 3

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

/** correction 文本消毒（审计报告 Top6 注入面）：strip 控制字符（防 JSONL 行断裂）、长度截断。
 * JSON.stringify 已处理引号/换行转义；此处主要防超长行与原始控制字符进 admin 渲染面。 */
export function sanitizeCorrection(input: string, maxLen = 2000): string {
  return String(input)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

export function appendCorrection(gapLogPath: string, rec: { tool: string; params?: unknown; gaps?: string[]; correction: string }): { ok: boolean; error?: string } {
  try {
    const entry: GapEntry = {
      tool: sanitizeCorrection(rec.tool, 64),
      ...(rec.params !== undefined ? { params: rec.params } : {}),
      confidence: 'correction',
      ...(rec.gaps?.length ? { gaps: rec.gaps.map((g) => sanitizeCorrection(g, 64)) } : {}),
      timestamp: Math.floor(Date.now() / 1000),
      user_supplied: sanitizeCorrection(rec.correction),
      resolved: false,
    }
    rotateIfNeeded(gapLogPath, GAP_MAX_BYTES, GAP_BACKUPS)
    appendFileSync(gapLogPath, JSON.stringify(entry) + '\n')
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) } }
}

/** resolved 置位（审计报告 Top4 写回路径）：按 timestamp+tool 定位单行，改写 resolved: true。
 * 读-改-写整文件；写前重读防与 rotate 竞态（rotate 只在 appendCorrection 侧发生，同进程内低风险）。 */
export function resolveCorrection(gapLogPath: string, timestamp: number, tool: string): { ok: boolean; resolvedCount?: number; error?: string } {
  try {
    if (!existsSync(gapLogPath)) return { ok: false, error: 'gap log not found' }
    const lines = readFileSync(gapLogPath, 'utf8').split('\n')
    let resolvedCount = 0
    const next = lines.map((line) => {
      if (!line.trim()) return line
      let e: GapEntry
      try { e = JSON.parse(line) as GapEntry } catch { return line }
      if (e.timestamp === timestamp && e.tool === tool && e.resolved !== true && e.user_supplied) {
        resolvedCount++
        return JSON.stringify({ ...e, resolved: true })
      }
      return line
    })
    if (!resolvedCount) return { ok: false, error: 'no matching unresolved correction' }
    const tmp = `${gapLogPath}.resolve.tmp`
    writeFileSync(tmp, next.join('\n'))
    renameSync(tmp, gapLogPath)
    return { ok: true, resolvedCount }
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) } }
}

export interface GapReport { entries: number; scanned: number; confidenceDist: Record<string, number>; topGaps: Array<{ gap: string; count: number }>; backlog: number; correctedBacklog: number; corrections: number }

/** 扫描 gap_log 生成报告数据（坏行跳过；文件缺失 → entries=0）。
 * backlog 口径拆分（2026-11-05 加固）：backlog=纯积压（无 correction），correctedBacklog=有 correction 但 resolved 未置位。 */
export function analyzeGapLog(gapLogPath: string): GapReport {
  const rep: GapReport = { entries: 0, scanned: 0, confidenceDist: {}, topGaps: [], backlog: 0, correctedBacklog: 0, corrections: 0 }
  if (!existsSync(gapLogPath)) return rep
  const gapCount = new Map<string, number>()
  try {
    for (const line of readFileSync(gapLogPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      rep.scanned++
      let e: GapEntry
      try { e = JSON.parse(line) as GapEntry } catch { continue }
      rep.entries++
      const conf = String(e.confidence ?? 'unknown')
      rep.confidenceDist[conf] = (rep.confidenceDist[conf] ?? 0) + 1
      for (const g of Array.isArray(e.gaps) ? e.gaps : []) gapCount.set(g, (gapCount.get(g) ?? 0) + 1)
      if (e.user_supplied) { rep.corrections++; if (e.resolved === false) rep.correctedBacklog++ }
      else if (e.resolved === false) rep.backlog++
    }
  } catch { /* 读取失败按空处理 */ }
  rep.topGaps = [...gapCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([gap, count]) => ({ gap, count }))
  return rep
}

/** 报告数据 → markdown 文本（纯函数，供报告与 admin 复用） */
export function renderReport(rep: GapReport): string {
  const lines = [
    `# BKN gap 回流报告（${new Date().toISOString().slice(0, 10)}）`, '',
    `- 扫描行数：${rep.scanned}（有效 ${rep.entries}）`,
    `- 置信度分布：${Object.entries(rep.confidenceDist).map(([k, v]) => `${k}=${v}`).join(' / ') || '（无数据）'}`,
    `- 纯积压（无 correction，resolved=false）：${rep.backlog}`,
    `- 有 correction 待 resolve：${rep.correctedBacklog}`,
    `- 已回流纠正（user_supplied 非空）：${rep.corrections}`, '',
    '## 高频 gap 维度 Top10', '',
    ...(rep.topGaps.length ? rep.topGaps.map((g, i) => `${i + 1}. \`${g.gap}\` ×${g.count}`) : ['（无数据）']), '',
    '> 本报告由 bkn-feedback 生成，仅为知识更新建议清单——不自动修改 BKN 数据（共享资产只读消费）。',
  ]
  return lines.join('\n') + '\n'
}

// ── 插件装配 ──

/** 相对路径解析（与 dsh-plugin resolveExternalDeps 同款规则）：相对 $DSH_HOME → cwd 兜底——
 * 保证与 dsh-plugin 的 gapLogPath 同一配置值解析到同一绝对文件（C3 防漂移） */
function resolveGapLogPath(p: string): string {
  if (isAbsolute(p)) return p
  const home = process.env.DSH_HOME ?? process.cwd()
  return resolve(join(home, p))
}

export async function apply(ctx: Context, config?: Config): Promise<void> {
  const cfg = {
    gapLogPath: resolveGapLogPath(config?.gapLogPath || process.env.I2STREAM_GAP_LOG || DEFAULT_GAP_LOG),
    reportDir: config?.reportDir || join(process.env.DSH_HOME ?? join(process.cwd(), '.dsh'), 'feedback-reports'),
    intervalHours: config?.intervalHours ?? 168,
    firstRunDelaySec: config?.firstRunDelaySec ?? 120,
    enabled: config?.enabled ?? true,
  }
  const log = ctx.logger('bkn-feedback')
  if (!cfg.enabled) { log.info('[bkn-feedback] disabled by config'); return }
  log.info(`[bkn-feedback] gapLog=${cfg.gapLogPath} reportDir=${cfg.reportDir}`)

  // ── 1. capture_correction 工具 ──
  const tools = ctx.get('tools') as unknown as { register?(t: unknown): unknown } | undefined
  if (tools?.register) {
    tools.register(defineTool({
      name: 'capture_correction',
      description:
        'Record a user correction about BKN knowledge quality (wrong/missing/incomplete answer). '
        + 'Call this right after the user corrects a BKN-derived answer, quoting their correction. '
        + 'Writes to the shared gap log with user_supplied set — feeds the knowledge update loop.',
      parameters: CAPTURE_PARAMS as never,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (rawArgs: unknown) => {
        const a = (rawArgs ?? {}) as Record<string, string | undefined>
        if (!a.tool || !a.correction) return 'ERROR: tool and correction are required'
        let params: unknown
        if (a.params) { try { params = JSON.parse(a.params) } catch { params = a.params } }
        const gaps = (a.gaps ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const r = appendCorrection(cfg.gapLogPath, { tool: a.tool, params, gaps: gaps.length ? gaps : undefined, correction: a.correction })
        return r.ok ? `correction recorded to ${cfg.gapLogPath}` : `ERROR: ${r.error}`
      },
    }))
    // resolve_correction（审计报告 Top4 写回路径）：agent 侧确认知识更新已完成时置位 resolved
    tools.register(defineTool({
      name: 'resolve_correction',
      description:
        'Mark a previously recorded user correction as resolved (the BKN knowledge has been updated). '
        + 'Use the timestamp and tool name from the correction entry. Keeps the feedback backlog honest.',
      parameters: {
        timestamp: { type: 'number' as const, required: true, description: '被解决条目的 timestamp（gap_log 行内）' },
        tool: { type: 'string' as const, required: true, description: '被解决条目的 tool 名' },
      } as never,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (rawArgs: unknown) => {
        const a = (rawArgs ?? {}) as Record<string, unknown>
        const ts = Number(a.timestamp)
        const tool = String(a.tool ?? '')
        if (!Number.isFinite(ts) || !tool) return 'ERROR: timestamp (number) and tool are required'
        const r = resolveCorrection(cfg.gapLogPath, ts, tool)
        return r.ok ? `resolved ${r.resolvedCount} correction(s)` : `ERROR: ${r.error}`
      },
    }))
    log.info('[bkn-feedback] capture_correction / resolve_correction 工具已注册')
  } else {
    log.warn('[bkn-feedback] tools 服务不可用——工具未注册（周期报告仍启用）')
  }

  // ── 2. curator 式周期报告 ──
  const reportTick = (): void => {
    try {
      mkdirSync(cfg.reportDir, { recursive: true })
      const rep = analyzeGapLog(cfg.gapLogPath)
      const file = join(cfg.reportDir, `gap-report-${new Date().toISOString().slice(0, 10)}.md`)
      // 原子写（tmp+rename，同 dshctl yml.ts atomicWrite 惯例）：报告生成中途被读不会读到半截
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, renderReport(rep))
      renameSync(tmp, file)
      log.info(`[bkn-feedback] 报告已生成: ${file}（entries=${rep.entries} backlog=${rep.backlog} corrections=${rep.corrections}）`)
    } catch (e) {
      log.warn(`[bkn-feedback] 报告生成失败（不抛）: ${String(e).slice(0, 160)}`)
    }
  }
  ctx.setTimeout(() => {
    reportTick()
    ctx.setInterval(reportTick, cfg.intervalHours * 60 * 60 * 1000)
  }, cfg.firstRunDelaySec * 1000)

  // ── 3. admin 桥（只读 + resolve 动作经 ops-api admin 端点调用） ──
  ctx.provide('bknFeedbackAdmin', {
    analyze: (): GapReport => analyzeGapLog(cfg.gapLogPath),
    reportText: (): string => renderReport(analyzeGapLog(cfg.gapLogPath)),
    resolve: (timestamp: number, tool: string): { ok: boolean; resolvedCount?: number; error?: string } => resolveCorrection(cfg.gapLogPath, timestamp, tool),
    paths: (): { gapLogPath: string; reportDir: string } => ({ gapLogPath: cfg.gapLogPath, reportDir: cfg.reportDir }),
  })
}
