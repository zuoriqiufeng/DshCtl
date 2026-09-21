/**
 * gen-hotpath-prompt.ts — 从共享 BKN 生成 ops preset 热路径提示词
 *
 * 生成物：
 *   1. presets/i2stream-ops/hotpath.md（独立速查，供人审阅）
 *   2. presets/i2stream-ops/agent.cordis.yml 中 # <generated-hotpath> 块内容（persona 注入）
 *
 * 内容（目标 <600 token）：
 *   ① 高频操作 → capability + Skill 绑定（operations/actions/*.bkn + implements_skill 边）
 *   ② 症状 → 首选日志/分析方向/Skill（diagnostics/symptom-router.bkn）
 *   ③ 常见错误码 → 一句话方向（risks/diagnostics.bkn，文件序前 N 条）
 *
 * 运行（bkn 更新后重新生成）：
 *   cd /hdd/agent/deepseek-harness
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/gen-hotpath-prompt.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BKNResolver } from '../dsh-plugin/resolver.ts'
import { RelationTraverser } from '../dsh-plugin/relations.ts'

const BKN_ROOT = process.env.I2STREAM_BKN_ROOT ?? '/hdd/demo/public/i2stream-bkn/bkn'
const PRESET_DIR = '/hdd/demo/public/dsh-info/code/presets/i2stream-ops'
const MAX_ERROR_CODES = 12

const CANONICAL_OPS: Array<[string, string]> = [
  ['activate_node', '激活工作节点'],
  ['register_db', '注册数据库节点'],
  ['create_rule', '创建同步规则'],
  ['start_rule', '启动同步规则'],
  ['stop_rule', '停止同步规则'],
  ['delete_rule', '删除同步规则'],
  ['compare_table', '创建表比较任务'],
  ['failover', '执行灾备切换'],
]

function firstSentence(text: string, max = 60): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('<!--')) ?? ''
  const cleaned = line.replace(/\*\*/g, '').replace(/^[:：\-\s]+/, '')
  const cut = cleaned.split(/[。；;]/)[0] ?? cleaned
  return cut.length > max ? `${cut.slice(0, max)}…` : cut
}

function buildHotpath(resolver: BKNResolver, traverser: RelationTraverser): string {
  const out: string[] = []

  // ① 操作 → capability + Skill
  out.push('【高频操作 → Skill 绑定】(具体命令一律由 Skill 提供)')
  for (const [op, cn] of CANONICAL_OPS) {
    const info = resolver.lookupOperation(op)
    if (!info) continue
    const skills = traverser.getSkillsForAction(info.capability)
    out.push(`- ${op}（${cn}）→ ${info.capability}${skills.length ? ` → Skill: ${skills.join('、')}` : ''}`)
  }

  // ② 症状 → 诊断方向
  out.push('')
  out.push('【症状 → 诊断方向】(详见 diagnostics/symptom-router.bkn 与 log-map.bkn)')
  const router = resolver.load('diagnostics/symptom-router.bkn')
  for (const [secName, sec] of router) {
    if (!secName.startsWith('Symptom:')) continue
    const id = secName.replace('Symptom:', '').trim()
    const desc = firstSentence(sec.raw, 30)
    const direction = /\*\*分析思路\*\*[:：]?\s*(.+)/.exec(sec.raw)
    const skills = [...sec.raw.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])
    const dirText = direction ? firstSentence(direction[1], 44) : ''
    out.push(`- ${id}: ${desc}${dirText ? ` → ${dirText}` : ''}${skills.length ? ` → Skill: ${skills.slice(0, 2).join('、')}` : ''}`)
  }

  // ③ 常见错误码 → 一句话方向
  out.push('')
  out.push(`【常见错误码方向】(前 ${MAX_ERROR_CODES} 条；完整诊断 diagnose_error 工具)`)
  const diag = resolver.load('risks/diagnostics.bkn')
  let count = 0
  for (const [secName, sec] of diag) {
    if (count >= MAX_ERROR_CODES) break
    if (secName === '_head' || secName === '查询策略') continue
    // section 名形如 "Risk: -4073 (源端日志不可读)" / "Risk: YAS-02276 (...)" / "Risk: 脏数据无法装载"
    const m = /((?:-\d{4,5})|(?:YAS-\d+)|(?:ORA-\d{4,5}))/.exec(secName)
    const label = m ? m[1] : secName.replace(/^Risk:\s*/, '').split('(')[0].trim()
    if (!label) continue
    const trigger = /\*\*触发条件\*\*[:：]?\s*(.+)/.exec(sec.raw)
    const dir = trigger ? firstSentence(trigger[1], 50) : firstSentence(sec.raw, 50)
    out.push(`- ${label}: ${dir}`)
    count++
  }
  return out.join('\n')
}

function inject(yamlPath: string, content: string): void {
  const text = readFileSync(yamlPath, 'utf8')
  const lines = text.split('\n')
  const isMarker = (l: string, tag: string) => new RegExp(`^\\s*#\\s*<${tag}>\\s*$`).test(l)
  const start = lines.findIndex((l) => isMarker(l, 'generated-hotpath'))
  const end = lines.findIndex((l) => isMarker(l, '/generated-hotpath'))
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`agent.cordis.yml 缺少 generated-hotpath 标记对`)
  }
  const indented = content.split('\n').map((l) => `      ${l}`)
  const next = [...lines.slice(0, start + 1), ...indented, ...lines.slice(end)]
  writeFileSync(yamlPath, next.join('\n'))
}

function main(): void {
  const resolver = new BKNResolver(BKN_ROOT)
  const traverser = new RelationTraverser(BKN_ROOT)
  const hotpath = buildHotpath(resolver, traverser)
  writeFileSync(join(PRESET_DIR, 'hotpath.md'), `${hotpath}\n`)
  inject(join(PRESET_DIR, 'agent.cordis.yml'), hotpath)
  const tokens = Math.round(hotpath.length / 1.6)
  console.log(`[gen-hotpath] 已生成 hotpath.md 并注入 agent.cordis.yml（约 ${tokens} token，${hotpath.length} 字符）`)
}

main()
