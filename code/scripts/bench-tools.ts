/**
 * bench-tools.ts — 阶段1工具层计时脚本（无 LLM，纯 resolver/traverser 链路）
 *
 * 对 4 道基线问题的典型工具链逐链计时，断言单次 <100ms（ops-agent-phase1-plan 验收）。
 * 运行：cd /hdd/agent/deepseek-harness && node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/bench-tools.ts
 */

import { BKNResolver } from '../dsh-plugin/resolver.ts'
import { RelationTraverser } from '../dsh-plugin/relations.ts'

const BKN_ROOT = process.env.I2STREAM_BKN_ROOT ?? '/hdd/demo/public/i2stream-bkn/bkn'
const LIMIT_MS = 100

const resolver = new BKNResolver(BKN_ROOT)
const traverser = new RelationTraverser(BKN_ROOT)

interface Case { name: string; fn: () => unknown }

const chains: Array<{ question: string; cases: Case[] }> = [
  {
    question: 'Q1 如何创建一条 Oracle 到 MySQL 的增量同步规则？',
    cases: [
      { name: 'resolve_operation(create_rule)', fn: () => {
        const info = resolver.lookupOperation('create_rule')
        return { info, skills: info ? traverser.getSkillsForAction(info.capability) : [] }
      } },
      { name: 'design_solution(Oracle→MySQL)', fn: () => {
        const sc = resolver.matchScenario('Oracle', 'MySQL')
        const expanded = traverser.expand(`scenario:${sc.scenario}`, 3)
        return { sc, expanded: Object.keys(expanded.relations).length }
      } },
      { name: 'check_compatibility(Oracle→MySQL)', fn: () => resolver.checkCompatibility('Oracle', 'MySQL') },
    ],
  },
  {
    question: 'Q2 增量同步卡住不动了，怎么排查？',
    cases: [
      { name: 'get_prerequisites(start_rule)', fn: () => resolver.getPrerequisites('start_rule') },
      { name: 'diagnose 链: getRisk(-4073)', fn: () => resolver.getRisk('-4073') },
      { name: 'resolve_relation(start_sync_rule)', fn: () => ({
        constraints: traverser.getConstraintsForAction('action:start_sync_rule'),
        risks: traverser.getRisksForAction('action:start_sync_rule'),
      }) },
    ],
  },
  {
    question: 'Q3 什么情况下禁止删除同步规则？',
    cases: [
      { name: 'listScenarios()', fn: () => resolver.listScenarios() },
      { name: 'lookupOperation(delete_rule)', fn: () => resolver.lookupOperation('delete_rule') },
    ],
  },
  {
    question: 'Q4 YAS-01001 错误是什么原因？',
    cases: [
      { name: 'diagnose_error(getRisk YAS-01001)', fn: () => resolver.getRisk('YAS-01001') },
      { name: 'resolve_relation(泛化)', fn: () => traverser.expand('object:syncrule', 2) },
    ],
  },
]

let failures = 0
const all: number[] = []
for (const chain of chains) {
  console.log(`\n${chain.question}`)
  for (const c of chain.cases) {
    // 预热一次（懒加载 section tables/kv）
    c.fn()
    const t0 = performance.now()
    c.fn()
    const ms = performance.now() - t0
    all.push(ms)
    const ok = ms < LIMIT_MS
    if (!ok) failures++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}: ${ms.toFixed(1)}ms`)
  }
}
all.sort((a, b) => a - b)
const p50 = all[Math.floor(all.length * 0.5)] ?? 0
const p95 = all[Math.floor(all.length * 0.95)] ?? 0
console.log(`\n共 ${all.length} 次调用 | p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${(all.at(-1) ?? 0).toFixed(1)}ms | 限制 ${LIMIT_MS}ms`)
console.log(failures === 0 ? 'BENCH PASSED ✅' : `BENCH FAILED ❌ (${failures})`)
process.exit(failures === 0 ? 0 : 1)
