/**
 * store.ts — 技能使用台账（对齐 Hermes tools/skill_usage.py 的 sidecar 语义）
 *
 * 布局：$skillsDir/.usage.json，按技能名索引；写入原子（tmp+rename）。
 * 生命周期：active → stale（staleAfterDays 无活动）→ archived（archiveAfterDays）。
 * pinned 豁免自动迁移；created_by 标记区分 agent 自建与预置（curator 只管前者）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UsageRecord {
  /** 累计活动次数（view/create/patch 均 bump） */
  use_count: number
  /** ISO8601 最近活动时间 */
  last_activity_at: string
  /** ISO8601 首次登记时间 */
  created_at: string
  /** active | stale | archived */
  state: 'active' | 'stale' | 'archived'
  /** 豁免自动迁移 */
  pinned?: boolean
  /** agent | preset（curator 只管理 agent 自建） */
  created_by?: 'agent' | 'preset'
}

export type UsageTable = Record<string, UsageRecord>

const usagePath = (skillsDir: string): string => join(skillsDir, '.usage.json')

export function readUsage(skillsDir: string): UsageTable {
  const file = usagePath(skillsDir)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UsageTable : {}
  } catch {
    return {}
  }
}

export function writeUsage(skillsDir: string, table: UsageTable): void {
  const file = usagePath(skillsDir)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

const nowIso = (): string => new Date().toISOString()

/** bump 一次活动；无记录则登记（created_by 由调用方给出）。返回 bump 后记录。 */
export function bump(
  skillsDir: string,
  name: string,
  opts: { createdBy?: 'agent' | 'preset' } = {},
): UsageRecord {
  const table = readUsage(skillsDir)
  const cur = table[name]
  const rec: UsageRecord = cur
    ? {
        ...cur,
        use_count: cur.use_count + 1,
        last_activity_at: nowIso(),
        // merge createdBy when provided even if record already exists
        ...(opts.createdBy ? { created_by: opts.createdBy } : {}),
      }
    : {
        use_count: 1,
        last_activity_at: nowIso(),
        created_at: nowIso(),
        state: 'active',
        ...(opts.createdBy ? { created_by: opts.createdBy } : {}),
      }
  table[name] = rec
  writeUsage(skillsDir, table)
  return rec
}

/** curator 用：设置生命周期状态（不触碰活动计数）。 */
export function setState(skillsDir: string, name: string, state: UsageRecord['state']): void {
  const table = readUsage(skillsDir)
  const cur = table[name]
  if (!cur) return
  table[name] = { ...cur, state }
  writeUsage(skillsDir, table)
}

/** 首次见到的预置技能：登记基线记录，使不活动时钟从 NOW 起算（对齐 Hermes seed 语义）。 */
export function seedIfMissing(skillsDir: string, name: string): void {
  const table = readUsage(skillsDir)
  if (table[name]) return
  table[name] = { use_count: 0, last_activity_at: nowIso(), created_at: nowIso(), state: 'active' }
  writeUsage(skillsDir, table)
}
