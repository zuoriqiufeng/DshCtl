/**
 * ops.ts — 技能写操作（对齐 Hermes tools/skill_manager_tool.py 的动作集与守卫语义）
 *
 * 动作：create / patch（SKILL.md 内容替换）/ write_file（技能目录内附属文件）/ archive（归档而非删除）。
 * 守卫：名字合法性（含 CJK）；路径逃逸防护（file_path 必须落在技能目录内）；
 * 预置技能（usage 台账无 agent 标记且目录不在 createDir）只读——archive/patch 拒绝，对齐
 * Hermes「bundled/hub 只读」不变式。每次成功写操作追加 ledger（before blob 备份）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { appendEntry, readBlob, readEntries, sha256, storeBlob } from './ledger.ts'
import { readdirSync, statSync } from 'node:fs'
import { bump, readUsage } from './store.ts'

const SKILL_NAME_RE = /^[\w\u4e00-\u9fff-]{1,64}$/

export interface OpsResult {
  ok: boolean
  message: string
  /** 变更的文件（ledger 已记录） */
  changed?: string[]
}

const fail = (message: string): OpsResult => ({ ok: false, message })

/** 目录存在且含 SKILL.md。 */
export function skillExists(skillsDir: string, name: string): boolean {
  return existsSync(join(skillsDir, name, 'SKILL.md'))
}

/** agent 可写 = usage 台账标记 created_by:agent（我们创建的）；预置技能只读。 */
function isAgentOwned(skillsDir: string, name: string): boolean {
  return readUsage(skillsDir)[name]?.created_by === 'agent'
}

/** 路径逃逸防护：resolve 后必须仍在技能目录内。 */
function safeFile(skillsDir: string, name: string, relPath: string): string | OpsResult {
  if (!SKILL_NAME_RE.test(name)) return fail(`invalid skill name: ${name}`)
  const base = join(skillsDir, name)
  const target = normalize(join(base, relPath))
  if (target !== base && !target.startsWith(base + sep)) return fail(`path escapes skill directory: ${relPath}`)
  return target
}

/** create：新建技能目录 + SKILL.md；创建即登记 agent 所有权。 */
export function createSkill(
  skillsDir: string,
  name: string,
  description: string,
  content: string,
): OpsResult {
  if (!SKILL_NAME_RE.test(name)) return fail(`invalid skill name: ${name} (allowed: word chars, CJK, hyphen; max 64)`)
  if (skillExists(skillsDir, name)) return fail(`skill already exists: ${name}`)
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  const front = `---\ndescription: ${JSON.stringify(description)}\ncreated_by: agent\n---\n\n`
  const body = content.trimStart().startsWith('---') ? content : front + content
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
  storeBlob(skillsDir, '')
  appendEntry(skillsDir, {
    ts: new Date().toISOString(),
    action: 'create',
    skill: name,
    files: [{ path: 'SKILL.md', before_sha: null, after_sha: sha256(body) }],
  })
  bump(skillsDir, name, { createdBy: 'agent' })
  return { ok: true, message: `skill created: ${name}`, changed: ['SKILL.md'] }
}

/** patch：整体替换 SKILL.md；仅限 agent 自建技能（预置只读）。before blob 入账。 */
export function patchSkill(skillsDir: string, name: string, content: string): OpsResult {
  if (!skillExists(skillsDir, name)) return fail(`skill not found: ${name}`)
  if (!isAgentOwned(skillsDir, name)) return fail(`skill ${name} is preset (read-only); only agent-created skills can be patched`)
  const file = join(skillsDir, name, 'SKILL.md')
  const before = readFileSync(file, 'utf8')
  storeBlob(skillsDir, before)
  writeFileSync(file, content, 'utf8')
  appendEntry(skillsDir, {
    ts: new Date().toISOString(),
    action: 'patch',
    skill: name,
    files: [{ path: 'SKILL.md', before_sha: sha256(before), after_sha: sha256(content) }],
  })
  bump(skillsDir, name)
  return { ok: true, message: `skill patched: ${name}`, changed: ['SKILL.md'] }
}

/** write_file：技能目录内附属文件（references/、scripts/ 等）；路径逃逸拒绝。 */
export function writeFile(
  skillsDir: string,
  name: string,
  relPath: string,
  content: string,
): OpsResult {
  if (!skillExists(skillsDir, name)) return fail(`skill not found: ${name}`)
  if (!isAgentOwned(skillsDir, name)) return fail(`skill ${name} is preset (read-only)`)
  const target = safeFile(skillsDir, name, relPath)
  if (typeof target !== 'string') return target
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (before !== null) storeBlob(skillsDir, before)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
  appendEntry(skillsDir, {
    ts: new Date().toISOString(),
    action: 'write_file',
    skill: name,
    files: [{ path: relPath, before_sha: before === null ? null : sha256(before), after_sha: sha256(content) }],
  })
  bump(skillsDir, name)
  return { ok: true, message: `written: ${name}/${relPath}`, changed: [relPath] }
}

/**
 * archive：目录移入 .archive/ 子目录（对齐 Hermes「归档不删除」不变式）。
 * C1 整改：不用 <name>.archived 后缀——扫描器按目录内 SKILL.md 的 frontmatter
 * name 注册技能，后缀目录内的 SKILL.md 仍会被发现；.archive/ 不被扫描器递归
 * （只查根下每目录的直接 SKILL.md），归档即真正下 catalog。
 */
export function archiveSkill(skillsDir: string, name: string): OpsResult {
  if (!skillExists(skillsDir, name)) return fail(`skill not found: ${name}`)
  if (!isAgentOwned(skillsDir, name)) return fail(`skill ${name} is preset (read-only); archiving would break the preset`)
  const src = join(skillsDir, name)
  const archiveRoot = join(skillsDir, '.archive')
  const dst = join(archiveRoot, name)
  if (existsSync(dst)) return fail(`archive target already exists: .archive/${name}`)
  mkdirSync(archiveRoot, { recursive: true })
  renameSync(src, dst)
  appendEntry(skillsDir, { ts: new Date().toISOString(), action: 'archive', skill: name, files: [] })
  return { ok: true, message: `skill archived: ${name} → .archive/${name}` }
}

/**
 * sync：从上游共享源拉取技能到本目录（C1 整改的上架机制）。
 * 上游 = 只读消费（拷贝动作，绝不写回）；目标已存在时整体覆盖（含附属文件）。
 * 用途：共享源更新后同步到 catalog 唯一源，使 admin/curator 操作始终有效。
 */
export function syncSkill(upstreamDir: string, skillsDir: string, name: string): OpsResult {
  if (!SKILL_NAME_RE.test(name)) return fail(`invalid skill name: ${name}`)
  const src = join(upstreamDir, name)
  if (!existsSync(join(src, 'SKILL.md'))) return fail(`upstream skill not found: ${upstreamDir}/${name}`)
  const dst = join(skillsDir, name)
  const changed: string[] = []
  // 递归拷贝上游技能目录（含 references/scripts 等附属文件）。
  const copyTree = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) {
      const srcPath = join(from, entry)
      const dstPath = join(to, entry)
      if (statSync(srcPath).isDirectory()) copyTree(srcPath, dstPath)
      else { writeFileSync(dstPath, readFileSync(srcPath)); changed.push(entry) }
    }
  }
  copyTree(src, dst)
  appendEntry(skillsDir, { ts: new Date().toISOString(), action: 'sync', skill: name, files: [] })
  return { ok: true, message: `synced ${name} from upstream (${changed.length} files)`, changed }
}
export function restoreSkill(skillsDir: string, name: string): OpsResult {
  // 回滚 fail-closed：任何缺失（技能/账本/blob）都拒绝，绝不静默半恢复。
  if (!skillExists(skillsDir, name)) return fail(`skill not found: ${name}`)
  const entries = readEntries(skillsDir)
  const last = [...entries].reverse().find((e) => e.skill === name && e.action === 'patch' && e.files[0]?.before_sha)
  if (!last) return fail(`no restorable patch entry for ${name}`)
  const before = readBlob(skillsDir, last.files[0].before_sha as string)
  const file = join(skillsDir, name, 'SKILL.md')
  writeFileSync(file, before, 'utf8')
  appendEntry(skillsDir, {
    ts: new Date().toISOString(),
    action: 'restore',
    skill: name,
    files: [{ path: 'SKILL.md', before_sha: last.files[0].after_sha, after_sha: last.files[0].before_sha }],
  })
  return { ok: true, message: `skill restored: ${name}` }
}
