/**
 * self-test.ts — ops-skill-manager 运行时自测（tsx 直跑，与 ops-api 同一验证平面）
 * 覆盖：store 原子读写/bump；ledger blob 去重与恢复；ops create/patch/archive/restore
 * 守卫（路径逃逸/预置只读/重名）；curator 生命周期迁移与豁免。
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bump, readUsage, setState, seedIfMissing } from './store.ts'
import { appendEntry, readBlob, readEntries, sha256, storeBlob } from './ledger.ts'
import { archiveSkill, createSkill, patchSkill, restoreSkill, skillExists, syncSkill, writeFile } from './ops.ts'
import { runTransitions, unarchive } from './curator.ts'

let passed = 0
let failed = 0
function ok(cond: boolean, tag: string): void {
  if (cond) { passed++; console.log(`  ✓ ${tag}`) } else { failed++; console.error(`  ✗ FAIL: ${tag}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'skill-mgr-test-'))
console.log('== store ==')
const r1 = bump(dir, 'alpha', { createdBy: 'agent' })
ok(r1.use_count === 1 && r1.state === 'active', 'bump creates record')
bump(dir, 'alpha')
ok(readUsage(dir).alpha.use_count === 2, 'bump increments')
setState(dir, 'alpha', 'stale')
ok(readUsage(dir).alpha.state === 'stale', 'setState transitions')
seedIfMissing(dir, 'beta')
ok(readUsage(dir).beta.use_count === 0, 'seedIfMissing registers baseline')
// regression: bump with createdBy on existing record must merge created_by
bump(dir, 'gamma')  // first bump without createdBy creates bare record
ok(!readUsage(dir).gamma.created_by, 'first bump without createdBy leaves field unset')
bump(dir, 'gamma', { createdBy: 'agent' })  // second bump must merge created_by
ok(readUsage(dir).gamma.created_by === 'agent', 'bump merges createdBy on existing record')

console.log('== ledger ==')
const blobSha = storeBlob(dir, 'hello world')
ok(blobSha === sha256('hello world'), 'blob sha matches')
storeBlob(dir, 'hello world')  // dedupe no-throw
ok(readBlob(dir, blobSha) === 'hello world', 'blob roundtrip')
appendEntry(dir, { ts: new Date().toISOString(), action: 'patch', skill: 'alpha', files: [{ path: 'SKILL.md', before_sha: blobSha, after_sha: blobSha }] })
ok(readEntries(dir).length === 1, 'ledger append+read')

console.log('== ops create/patch/archive ==')
const tmpSkills = mkdtempSync(join(tmpdir(), 'skill-mgr-skills-'))
const c1 = createSkill(tmpSkills, 'log-analysis', '分析 i2Stream 同步日志', '## 步骤\n1. 收集日志')
ok(c1.ok && skillExists(tmpSkills, 'log-analysis'), 'create writes SKILL.md')
ok(readUsage(tmpSkills)['log-analysis'].created_by === 'agent', 'create registers agent ownership')
const c2 = createSkill(tmpSkills, 'log-analysis', 'x', 'y')
ok(!c2.ok && c2.message.includes('already exists'), 'create rejects duplicate')
const p1 = patchSkill(tmpSkills, 'log-analysis', '## 步骤\n1. 收集\n2. 聚类')
ok(p1.ok && readFileSync(join(tmpSkills, 'log-analysis', 'SKILL.md'), 'utf8').includes('聚类'), 'patch replaces content')
// 预置技能（无 agent 标记）patch 拒绝
mkdirSync(join(tmpSkills, 'preset-skill'), { recursive: true })
writeFileSync(join(tmpSkills, 'preset-skill', 'SKILL.md'), 'preset', 'utf8')
const p2 = patchSkill(tmpSkills, 'preset-skill', 'hacked')
ok(!p2.ok && p2.message.includes('read-only'), 'preset skill patch rejected')
// 路径逃逸
const w1 = writeFile(tmpSkills, 'log-analysis', '../../escape.md', 'x')
ok(!w1.ok && w1.message.includes('escapes'), 'path escape rejected')
const w2 = writeFile(tmpSkills, 'log-analysis', 'references/errors.md', 'YAS-02276: OOM')
ok(w2.ok && existsSync(join(tmpSkills, 'log-analysis', 'references', 'errors.md')), 'nested write_file ok')
// archive（不删除，改名）
const a1 = archiveSkill(tmpSkills, 'log-analysis')
ok(a1.ok && !existsSync(join(tmpSkills, 'log-analysis')) && existsSync(join(tmpSkills, '.archive', 'log-analysis')), 'archive moves to .archive/ subdir not deletes')
const a2 = archiveSkill(tmpSkills, 'preset-skill')
ok(!a2.ok && a2.message.includes('read-only'), 'preset archive rejected')

console.log('== restore ==')
const restoreDir = mkdtempSync(join(tmpdir(), 'skill-mgr-restore-'))
createSkill(restoreDir, 's1', 'd', 'v1')
patchSkill(restoreDir, 's1', 'v2')
const rs = restoreSkill(restoreDir, 's1')
ok(rs.ok && readFileSync(join(restoreDir, 's1', 'SKILL.md'), 'utf8').includes('v1'), 'restore rolls back to before content')

console.log('== curator lifecycle ==')
const curDir = mkdtempSync(join(tmpdir(), 'skill-mgr-cur-'))
createSkill(curDir, 'old-active', 'd', 'x')
createSkill(curDir, 'old-stale', 'd', 'x')
createSkill(curDir, 'pinned-one', 'd', 'x')
createSkill(curDir, 'preset-x', 'd', 'x')
// 手工布置时间：old-active 超 30 天；old-stale 已 stale 且超 90 天；pinned-one 超 90 天但 pinned
const table = readUsage(curDir)
table['old-active'].last_activity_at = new Date(Date.now() - 31 * 86400e3).toISOString()
table['old-stale'].state = 'stale'
table['old-stale'].last_activity_at = new Date(Date.now() - 91 * 86400e3).toISOString()
table['pinned-one'].pinned = true
table['pinned-one'].state = 'stale'
table['pinned-one'].last_activity_at = new Date(Date.now() - 100 * 86400e3).toISOString()
delete table['preset-x'].created_by  // 模拟预置
writeFileSync(join(curDir, '.usage.json'), JSON.stringify(table, null, 2), 'utf8')
const rep = runTransitions(curDir, {})
ok(rep.transitions.some((t) => t.skill === 'old-active' && t.to === 'stale'), 'active->stale after 30d')
ok(rep.transitions.some((t) => t.skill === 'old-stale' && t.to === 'archived'), 'stale->archived after 90d')
ok(!existsSync(join(curDir, 'old-stale')) && existsSync(join(curDir, '.archive', 'old-stale')), 'curator archives into .archive/ subdir')
ok(!rep.transitions.some((t) => t.skill === 'pinned-one'), 'pinned exempt from transitions')
ok(!rep.transitions.some((t) => t.skill === 'preset-x'), 'not-agent-owned exempt')
// dry-run 无副作用
const rep2 = runTransitions(curDir, { dryRun: true })
ok(rep2.transitions.length === 0, 'dry-run after transitions: nothing left to move')
// unarchive 还原
const un = unarchive(curDir, 'old-stale')
ok(un.ok && existsSync(join(curDir, 'old-stale')), 'unarchive restores directory')

console.log('== sync (C1 upstream pull) ==')
const upDir = mkdtempSync(join(tmpdir(), 'skill-mgr-up-'))
const syncDst = mkdtempSync(join(tmpdir(), 'skill-mgr-syncdst-'))
mkdirSync(join(upDir, 'up-skill', 'references'), { recursive: true })
writeFileSync(join(upDir, 'up-skill', 'SKILL.md'), '---\ndescription: up\n---\nup body', 'utf8')
writeFileSync(join(upDir, 'up-skill', 'references', 'ref.md'), 'ref content', 'utf8')
const sy1 = syncSkill(upDir, syncDst, 'up-skill')
ok(sy1.ok && skillExists(syncDst, 'up-skill'), 'sync copies SKILL.md')
ok(existsSync(join(syncDst, 'up-skill', 'references', 'ref.md')), 'sync copies nested files')
const sy2 = syncSkill(upDir, syncDst, 'missing-skill')
ok(!sy2.ok && sy2.message.includes('not found'), 'sync rejects missing upstream skill')
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('ALL PASSED ✅')
