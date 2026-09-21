/**
 * curator.ts — 技能生命周期迁移（对齐 Hermes agent/curator.py 的确定性部分）
 *
 * 规则（与 Hermes apply_automatic_transitions 1:1）：
 *   active → stale   ：last_activity_at 超过 staleAfterDays（默认 30 天）
 *   stale  → archived：超 archiveAfterDays（默认 90 天），目录改名 <name>.archived
 *   豁免：pinned；非 agent 自建（预置/Hub 技能只读）；已有 .archived 同名跳过。
 * 绝不删除——归档只改名（Hermes 不变式：archive is the only delete）。
 * LLM 合并对（umbrella-building / distillation）显式不做：Hermes 默认也关闭，
 * 且 DSH 侧 LLM 调用需走会话桥，保持进程内零依赖。
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readEntries } from './ledger.ts'
import { readUsage, setState, type UsageRecord } from './store.ts'

export interface CuratorConfig {
  /** 不活动阈值（天），默认 30 */
  staleAfterDays?: number
  /** 归档阈值（天），默认 90 */
  archiveAfterDays?: number
  /** 只迁移不改名（试跑） */
  dryRun?: boolean
}

export interface CuratorTransition {
  skill: string
  from: UsageRecord['state']
  to: UsageRecord['state']
  /** 目录改名（stale→archived 时） */
  renamed?: boolean
}

export interface CuratorReport {
  scanned: number
  transitions: CuratorTransition[]
  /** 跳过原因（pinned / not-agent-owned / already-archived-dir） */
  skipped: { skill: string; reason: string }[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 运行一轮迁移。纯函数式输入（台账快照 + now），副作用仅限 setState/rename。
 * 账本只用于读取 agent 所有权判定的历史（created_by: agent 的 create 记录）。
 */
export function runTransitions(skillsDir: string, cfg: CuratorConfig = {}): CuratorReport {
  const staleAfter = (cfg.staleAfterDays ?? 30) * DAY_MS
  const archiveAfter = (cfg.archiveAfterDays ?? 90) * DAY_MS
  const now = Date.now()
  const usage = readUsage(skillsDir)
  // 补充：账本里有 create 记录但台账缺失（.usage.json 被清）时恢复所有权判定。
  const ledgerOwned = new Set(
    readEntries(skillsDir)
      .filter((e) => e.action === 'create')
      .map((e) => e.skill),
  )
  const report: CuratorReport = { scanned: 0, transitions: [], skipped: [] }

  for (const [name, rec] of Object.entries(usage)) {
    report.scanned += 1
    const owned = rec.created_by === 'agent' || ledgerOwned.has(name)
    if (!owned) { report.skipped.push({ skill: name, reason: 'not-agent-owned' }); continue }
    if (rec.pinned) { report.skipped.push({ skill: name, reason: 'pinned' }); continue }
    const idle = now - Date.parse(rec.last_activity_at)
    if (Number.isNaN(idle)) continue

    if (rec.state === 'active' && idle >= staleAfter) {
      report.transitions.push({ skill: name, from: 'active', to: 'stale' })
      if (!cfg.dryRun) setState(skillsDir, name, 'stale')
    } else if (rec.state === 'stale' && idle >= archiveAfter) {
      // C1: archive = 移入 .archive/ 子目录（扫描器不递归，归档即下 catalog）。
      const src = join(skillsDir, name)
      const dst = join(skillsDir, '.archive', name)
      if (existsSync(dst)) { report.skipped.push({ skill: name, reason: 'archive-dir-exists' }); continue }
      const t: CuratorTransition = { skill: name, from: 'stale', to: 'archived' }
      if (!cfg.dryRun && existsSync(src)) {
        mkdirSync(join(skillsDir, '.archive'), { recursive: true })
        renameSync(src, dst)
        t.renamed = true
        setState(skillsDir, name, 'archived')
      }
      report.transitions.push(t)
    }
  }
  return report
}

/** 归档目录还原（误归档恢复入口；admin API 调用）。 */
export function unarchive(skillsDir: string, name: string): { ok: boolean; message: string } {
  const src = join(skillsDir, '.archive', name)
  const dst = join(skillsDir, name)
  if (!existsSync(src)) return { ok: false, message: `archive not found: .archive/${name}` }
  if (existsSync(dst)) return { ok: false, message: `target dir exists: ${name}` }
  renameSync(src, dst)
  return { ok: true, message: `unarchived: ${name}` }
}
