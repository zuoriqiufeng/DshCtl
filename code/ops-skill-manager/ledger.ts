/**
 * ledger.ts — 技能变更审计账本（对齐 Hermes tools/skill_ledger.py 的 JSONL+备份语义）
 *
 * 每次技能写操作追加一行 JSONL：{ ts, action, skill, files: [{ path, before_sha, after_sha }] }。
 * before 内容整体备份到 $skillsDir/.skill-backups/<sha256>（内容寻址去重）。
 * 回滚：按 ledger 条目恢复 before blobs（单条目粒度，对齐 Hermes rollback_entry）。
 * 账本为遥测而非闸门：写失败只 warn 不阻断技能写入；回滚路径失败则抛错（fail-closed）。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LedgerFileChange {
  /** 相对技能根的文件路径 */
  path: string
  /** 变更前内容 sha256（null = 新增文件） */
  before_sha: string | null
  /** 变更后内容 sha256（null = 删除文件） */
  after_sha: string | null
}

export interface LedgerEntry {
  /** ISO8601 */
  ts: string
  /** create | patch | write_file | archive | restore */
  action: string
  skill: string
  files: LedgerFileChange[]
}

export const sha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')

const ledgerPath = (skillsDir: string): string => join(skillsDir, '.skill-ledger.jsonl')
const blobDir = (skillsDir: string): string => join(skillsDir, '.skill-backups')

/** 把内容存为内容寻址 blob；已存在则跳过（去重）。返回 sha。 */
export function storeBlob(skillsDir: string, content: string): string {
  const sha = sha256(content)
  const dir = blobDir(skillsDir)
  const file = join(dir, sha)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return sha
}

export function readBlob(skillsDir: string, sha: string): string {
  const file = join(blobDir(skillsDir), sha)
  if (!existsSync(file)) throw new Error(`skill-ledger: missing backup blob ${sha.slice(0, 12)}`)
  return readFileSync(file, 'utf8')
}

/** 追加一条账本记录；best-effort（失败只由调用方 warn，不阻断）。 */
export function appendEntry(skillsDir: string, entry: LedgerEntry): void {
  const file = ledgerPath(skillsDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

/** 读取全账本（新→旧排序由调用方决定；此处按文件顺序返回）。 */
export function readEntries(skillsDir: string): LedgerEntry[] {
  const file = ledgerPath(skillsDir)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerEntry)
}
