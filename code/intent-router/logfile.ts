/**
 * logfile.ts — 插件文件日志：日期 + 大小双维轮转、级别门、易读文本（纯模块，可自测）
 *
 * 轮转语义 1:1 移植自共享 BKN 的 `/hdd/demo/public/i2stream-bkn/plugin/log_rotate.py`
 * （`day_file_path` / `rotate_day_file` / `_prune_old_days` / `iter_data_files`），
 * 其中"大小维度"复用 `code/dsh-plugin/supplement.ts` 的 `rotateIfNeeded`（同一 Python 函数的 TS 移植）。
 *
 * 命名规则（与 BKN 一致）：
 *   <dir>/<stem>_YYYY-MM-DD.log        当日文件（文件名带日期，跨日自动开新文件）
 *   <dir>/<stem>_YYYY-MM-DD.log.N      同日超大小轮转分片（.1/.2/.3，最旧先删）
 *   历史旧命名（<stem>.log 本体与其数字分片）仍被 listDataFiles 兼容枚举。
 *
 * 两处**刻意偏差**（语义不变，理由写明）：
 *   ① prune 频率：Python 每次写都 glob 目录；写日志在识别热路径上，这里收敛为
 *      「每进程每天最多一次 + 首次写入时一次」——跨日仍会立刻清理，但不再每次写都扫目录。
 *   ② 日期提取正则：Python 硬编码 `.jsonl`；这里按实际后缀构造，`.log` / `.jsonl` 都认。
 *
 * 降级铁律：任何写失败/清理失败都静默（可选一次性回调），**绝不抛**——日志坏了不能让会话失败。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { rotateIfNeeded } from '../dsh-plugin/supplement.ts'

// ─────────────────────────── 级别 ───────────────────────────

/** 级别门：off 关闭文件日志；error < warn < info < debug（数字越大越啰嗦）。 */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug'

const LEVEL_RANK: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }

/** 归一化级别字符串（非法值回落到 fallback，与插件其它枚举同款"配置容错"口径）。 */
export function normalizeLevel(value: unknown, fallback: LogLevel = 'info'): LogLevel {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw in LEVEL_RANK ? (raw as LogLevel) : fallback
}

const DAY_MS = 86_400_000

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** 本地日期串 YYYY-MM-DD（文件名用；用本地时区，与"人看日志"一致）。 */
export function dateStr(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * 时间戳：本地时间 + 显式时区偏移（易读且不歧义，如 `2026-10-08 21:06:45.871 +08:00`）。
 * 刻意不用 UTC ISO：这个文件是给人排查看的（结构化台账才用 UTC，见 ops-skill-manager ledger）。
 */
export function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  const time = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    + `.${pad(shifted.getUTCMilliseconds(), 3)}`
  return `${time} ${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
}

// ─────────────────────────── printf 格式化 ───────────────────────────

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * printf 风格格式化（`%s %d %i %f %o %O %%`），语义对齐 cordis `Logger.format` 的内建 formatter
 * ——插件的 `ctx.logger` 用 `%s`/`%d`/`%o` 写消息，落文件前要先把它格式化掉。
 * 未知占位符原样保留；多余参数以空格追加（与上游一致）。
 */
export function formatArgs(format: unknown, args: readonly unknown[]): string {
  if (typeof format !== 'string') return [format, ...args].map((v) => (typeof v === 'string' ? v : safeJson(v))).join(' ')
  const rest = [...args]
  const rendered = format.replace(/%([a-zA-Z%])/g, (match, char: string) => {
    if (char === '%') return '%'
    if (rest.length === 0) return match
    const value = rest.shift()
    switch (char) {
      case 's': return String(value)
      case 'd':
      case 'i': return String(Math.trunc(Number(value)))
      case 'f': return String(Number(value))
      case 'o':
      case 'O': return safeJson(value)
      case 'c': return ''
      default: return match
    }
  })
  return rest.length > 0 ? `${rendered} ${rest.map((v) => (typeof v === 'string' ? v : safeJson(v))).join(' ')}` : rendered
}

// ─────────────────────────── 一行的组装 ───────────────────────────

/** 一行日志：`<时间> <级别> <消息>`（级别左对齐 5 字符，便于人眼扫读与 grep）。 */
export function formatLine(level: Exclude<LogLevel, 'off'>, message: string, date: Date): string {
  return `${formatTimestamp(date)} ${level.toUpperCase().padEnd(5)} ${message}`
}

/** 转义成单行（换行会破坏"一条日志一行"的可 grep 性）。 */
function oneLine(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/** 决策行字段（与 index.ts 的观测点一一对应；字段名保持 ASCII 便于 awk）。 */
export interface DecisionEntry {
  turn: number
  sid: string
  mode: string
  accepted: boolean
  reason: string
  intent: string
  target: string
  kind: string
  tier: string
  rule: string
  slots: Record<string, string>
  ms: number
  /** 是否真的注入了提示（仅注入分支有值）。 */
  injected?: boolean
  text: string
  /** BM25/向量排名（debug 级才落盘）。 */
  rank?: Array<{ id: string; bm25?: number; cos?: number }>
  /** 本回合主模型实际调用的工具（debug 级才落盘）。 */
  actualTools?: string[]
}

export interface DecisionFormatOptions {
  /** info 级原文截断长度；debug 级恒记全文。 */
  textMaxChars: number
  debug: boolean
}

/** 决策行渲染（纯函数，可单测）。 */
export function formatDecision(entry: DecisionEntry, options: DecisionFormatOptions): string {
  const parts: string[] = [
    'decision',
    `turn=${entry.turn}`,
    `sid=${entry.sid}`,
    `mode=${entry.mode}`,
    `accepted=${entry.accepted ? 'yes' : 'no'}`,
    `reason=${entry.reason}`,
  ]
  if (entry.intent) {
    parts.push(`intent=${entry.intent}`, `kind=${entry.kind}`, `tier=${entry.tier}`)
  }
  if (entry.rule) parts.push(`rule=${entry.rule}`)
  const slots = Object.entries(entry.slots)
  if (slots.length > 0) parts.push(`slots=${slots.map(([k, v]) => `${k}:${v}`).join(',')}`)
  parts.push(`ms=${entry.ms}`)
  if (entry.injected !== undefined) parts.push(`inject=${entry.injected ? 'yes' : 'no'}`)
  if (options.debug && entry.rank && entry.rank.length > 0) {
    parts.push(`rank=${entry.rank.map((r) => `${r.id}:${r.bm25 ?? '-'}${r.cos === undefined ? '' : `/${r.cos.toFixed(3)}`}`).join(',')}`)
  }
  if (options.debug && entry.actualTools && entry.actualTools.length > 0) {
    parts.push(`actual=${entry.actualTools.join(',')}`)
  }
  const shown = options.debug ? entry.text : truncate(entry.text, options.textMaxChars)
  parts.push(`text="${oneLine(shown)}"`)
  return parts.join(' ')
}

// ─────────────────────────── 路径与轮转（1:1 log_rotate.py） ───────────────────────────

interface BaseParts {
  dir: string
  stem: string
  suffix: string
}

/** 拆逻辑路径为目录 / 词干 / 后缀（对齐 Python `Path.stem`/`Path.suffix`：只认最后一个点）。 */
function splitBase(basePath: string): BaseParts {
  const name = basename(basePath)
  const suffix = extname(name)
  return { dir: dirname(basePath), stem: suffix ? name.slice(0, -suffix.length) : name, suffix }
}

/** 1:1 `log_rotate.day_file_path`：`logs/x.log` → `logs/x_2026-10-08.log`。 */
export function dayFilePath(basePath: string, date: string): string {
  const { dir, stem, suffix } = splitBase(basePath)
  return join(dir, `${stem}_${date}${suffix}`)
}

/** 从文件名提取日期串（1:1 `_DATE_IN_NAME_RE` 语义，但按实际后缀构造，不硬编码 .jsonl）。 */
export function dateInName(name: string, suffix: string): string | undefined {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`_([0-9]{4}-[0-9]{2}-[0-9]{2})${escaped}`).exec(name)
  return match?.[1]
}

export interface RotationOptions {
  /** 单文件上限（字节），超出切 `.1/.2/...`。 */
  maxBytes: number
  /** 同日保留的分片数（最旧先删）。 */
  backups: number
  /** >0 时清理日期早于保留期的日文件及其分片；0 = 永久保留。 */
  retentionDays: number
  /** 注入"现在"（测试跨日用）。 */
  now: Date
}

/** 1:1 `rotate_day_file` 的路径部分：返回当日应写文件，并对其做大小轮转。 */
export function rotateDayFile(basePath: string, options: RotationOptions): string {
  const target = dayFilePath(basePath, dateStr(options.now))
  rotateIfNeeded(target, options.maxBytes, options.backups)
  return target
}

/**
 * 1:1 `_prune_old_days`：删除日期早于保留期的日文件**及其数字分片**，返回删除个数。
 * retentionDays ≤ 0 时不动（Python 同）。
 */
export function pruneOldDays(basePath: string, retentionDays: number, now: Date): number {
  if (retentionDays <= 0) return 0
  const { dir, stem, suffix } = splitBase(basePath)
  const cutoff = dateStr(new Date(now.getTime() - retentionDays * DAY_MS))
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${stem}_`)) continue
      const date = dateInName(name, suffix)
      if (date !== undefined && date < cutoff) {
        unlinkSync(join(dir, name))
        removed++
      }
    }
  } catch {
    /* 清理失败静默（降级铁律） */
  }
  return removed
}

/**
 * 1:1 `iter_data_files`：枚举某逻辑路径下的全部数据文件（新旧命名兼容，按文件名排序）。
 * 旧命名：`<stem>.log` 本体 + 数字分片；新命名：`<stem>_YYYY-MM-DD.log` 及其数字分片。
 */
export function listDataFiles(basePath: string): string[] {
  const { dir, stem, suffix } = splitBase(basePath)
  const files = new Set<string>()
  const isNumericShard = (name: string): boolean => /\.\d+$/.test(name)
  try {
    if (existsSync(basePath)) files.add(basePath)
    for (const name of readdirSync(dir)) {
      if (name === `${stem}${suffix}` || (name.startsWith(`${stem}${suffix}.`) && isNumericShard(name))) {
        files.add(join(dir, name))                    // 旧命名（本体与分片）
        continue
      }
      if (name.startsWith(`${stem}_`) && dateInName(name, suffix) !== undefined) {
        files.add(join(dir, name))                    // 新命名（日文件与分片）
      }
    }
  } catch {
    return []
  }
  return [...files].sort()
}

// ─────────────────────────── 写入口 ───────────────────────────

export interface FileLogOptions {
  /** 输出目录。 */
  dir: string
  /** 文件名词干 → `<stem>_YYYY-MM-DD.log`。 */
  stem: string
  level: LogLevel
  maxBytes: number
  backups: number
  retentionDays: number
  /** info 级原文截断长度；0 = 不截断（debug 级恒不截断）。 */
  textMaxChars: number
  /** 一次性故障回调（写失败/清理失败各最多一次）；缺省静默。 */
  onError?: (message: string) => void
  /** 注入时钟（测试用）。 */
  now?: () => Date
}

export interface FileLog {
  error(message: string): void
  warn(message: string): void
  info(message: string): void
  debug(message: string): void
  /** 决策行（info 级；debug 级附排名与工具对照、原文不截断）。 */
  decision(entry: DecisionEntry): void
  /** 当前应写文件路径（观测点/文档用；level=off 时返回空串）。 */
  currentPath(): string
  /** 是否启用（level != off）。 */
  enabled(): boolean
}

const NOOP = (): void => { /* level=off：什么都不做 */ }

/**
 * 创建文件日志。
 * @param options - 目录 / 词干 / 级别 / 轮转与清理参数 / 故障回调。
 */
export function createFileLog(options: FileLogOptions): FileLog {
  const now = options.now ?? (() => new Date())
  const basePath = join(options.dir, `${options.stem}.log`)
  let dirReady = false
  let lastPruneDay = ''
  let reportedWriteFailure = false
  let reportedPruneFailure = false

  const warnOnce = (message: string, which: 'write' | 'prune'): void => {
    const flag = which === 'write' ? reportedWriteFailure : reportedPruneFailure
    if (flag) return
    if (which === 'write') reportedWriteFailure = true
    else reportedPruneFailure = true
    try {
      options.onError?.(message)
    } catch {
      /* 回调再炸也只能吞掉 */
    }
  }

  const enabled = options.level !== 'off'
  const allows = (level: Exclude<LogLevel, 'off'>): boolean => LEVEL_RANK[options.level] >= LEVEL_RANK[level]

  /** 每进程每天最多清理一次（见文件头偏差①）；启动后的首次写入也会清一次。 */
  const maybePrune = (date: Date): void => {
    if (options.retentionDays <= 0) return
    const today = dateStr(date)
    if (today === lastPruneDay) return
    lastPruneDay = today
    try {
      pruneOldDays(basePath, options.retentionDays, date)
    } catch (error) {
      warnOnce(`[intent-router] 旧日志清理失败：${String(error)}`, 'prune')
    }
  }

  const write = (level: Exclude<LogLevel, 'off'>, message: string): void => {
    if (!allows(level)) return
    try {
      if (!dirReady) {
        mkdirSync(options.dir, { recursive: true })
        dirReady = true
      }
      const date = now()
      maybePrune(date)
      const target = rotateDayFile(basePath, {
        maxBytes: options.maxBytes,
        backups: options.backups,
        retentionDays: options.retentionDays,
        now: date,
      })
      appendFileSync(target, `${formatLine(level, message, date)}\n`)
    } catch (error) {
      // 写失败静默（降级铁律）+ 一次性告知 harness logger；下次写入会重试建目录
      dirReady = false
      warnOnce(`[intent-router] 文件日志写入失败（${options.dir}）：${String(error)}`, 'write')
    }
  }

  return {
    error: enabled ? (message) => { write('error', message) } : NOOP,
    warn: enabled ? (message) => { write('warn', message) } : NOOP,
    info: enabled ? (message) => { write('info', message) } : NOOP,
    debug: enabled ? (message) => { write('debug', message) } : NOOP,
    decision: enabled
      ? (entry) => {
          write('info', formatDecision(entry, {
            textMaxChars: options.textMaxChars,
            debug: allows('debug'),
          }))
        }
      : NOOP,
    currentPath: enabled ? () => dayFilePath(basePath, dateStr(now())) : () => '',
    enabled: () => enabled,
  }
}

/** 供测试/工具使用：给一个已存在的文件路径做"是否为日文件"判断。 */
export function isDayFile(path: string): boolean {
  const { suffix } = splitBase(path)
  return dateInName(basename(path), suffix) !== undefined
}

/** 供测试使用：不依赖 fs 的 statSync 版本判断（避免测试里再引 fs）。 */
export const _internal = { splitBase, statSize: (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
} }
