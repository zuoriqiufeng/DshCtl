#!/usr/bin/env node
/**
 * eval-intent.ts — 意图识别的评测与门限标定工具
 *
 * 用途（三件事）：
 *   ① 回归：跑标注集，报告采纳率 / 误采纳，非达标即退出码 1（可进 CI）
 *   ② 标定：--sweep 扫描门限组合，打印「覆盖率 × 误采纳」曲线，供重新选门限
 *   ③ 对照：--with-vector 打开向量补救分支，量化它到底有没有救回样本
 *
 * 用法（在 deepseek-harness 下运行，与其它 scripts 一致）：
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/eval-intent.ts
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/eval-intent.ts --sweep
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/eval-intent.ts --with-vector
 *
 * 达标线（与 self-test [9] 同口径）：放弃组零误采纳 + 采纳组覆盖率 ≥ 85% + 命中意图零错判。
 * 为什么"零误采纳"是硬线：注入错误意图会误导主模型，比不注入更糟（详见设计文档「三条安全网」）。
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildScorer, classify, type EngineDeps } from '../intent-router/engine.ts'
import { createEmbedProvider } from '../intent-router/embed.ts'
import { buildAliasIndex, DEFAULT_GATE, type GateConfig } from '../intent-router/layer2.ts'
import { mergeTaxonomy } from '../intent-router/taxonomy.ts'
import { OVERRIDES } from '../intent-router/overrides.ts'
import { ERROR_ALIASES, SYMPTOM_ALIASES } from '../dsh-plugin/constants.ts'

const PLUGIN_DIR = resolve(import.meta.dirname, '..', 'intent-router')
const EVAL_PATH = join(PLUGIN_DIR, 'eval', 'questions.json')
const TAXONOMY_PATH = join(PLUGIN_DIR, 'taxonomy.generated.json')
const EMBED_URL = process.env.I2STREAM_EMBED_URL ?? 'http://127.0.0.1:8096/embed'

interface EvalCase {
  q: string
  expect: string | null
  mode: 'accept' | 'reject'
  note?: string
}

interface CaseResult {
  c: EvalCase
  accepted: boolean
  got: string
  tier: string
  reason: string
  ms: number
}

function loadEnv(): { cases: EvalCase[]; deps: EngineDeps; intents: ReturnType<typeof mergeTaxonomy>['intents'] } {
  const generated = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8')) as unknown
  const { intents } = mergeTaxonomy(generated, OVERRIDES)
  const aliasIndex = buildAliasIndex(intents, { symptom: SYMPTOM_ALIASES, error: ERROR_ALIASES })
  const evalu = JSON.parse(readFileSync(EVAL_PATH, 'utf8')) as { cases: EvalCase[] }
  const deps: EngineDeps = {
    intents,
    aliasIndex,
    gate: DEFAULT_GATE,
    scorer: buildScorer(intents),
    errorToolTarget: 'diagnose_error',
  }
  return { cases: evalu.cases, deps, intents }
}

function summarize(results: CaseResult[]): { acceptRate: number; wrongIntent: number; falseAccepts: string[]; misses: string[] } {
  const accepts = results.filter((r) => r.c.mode === 'accept')
  const rejects = results.filter((r) => r.c.mode === 'reject')
  const hit = accepts.filter((r) => r.accepted)
  const wrongIntent = hit.filter((r) => r.got !== r.c.expect).length
  // none 意图不可注入，落成 none 等价于不干预
  const falseAccepts = rejects
    .filter((r) => r.accepted && r.got !== 'none')
    .map((r) => `"${r.c.q}" → ${r.got}`)
  const misses = accepts.filter((r) => !r.accepted).map((r) => `"${r.c.q}"（${r.reason}）`)
  return { acceptRate: accepts.length === 0 ? 1 : hit.length / accepts.length, wrongIntent, falseAccepts, misses }
}

async function runOnce(deps: EngineDeps, cases: EvalCase[], gate?: GateConfig): Promise<CaseResult[]> {
  const useDeps = gate ? { ...deps, gate } : deps
  const out: CaseResult[] = []
  for (const c of cases) {
    const d = await classify(c.q, useDeps)
    out.push({
      c,
      accepted: d.accepted,
      got: d.intent?.id ?? '',
      tier: d.tier ?? '',
      reason: d.reason,
      ms: d.ms,
    })
  }
  return out
}

async function main(): Promise<void> {
  const sweep = process.argv.includes('--sweep')
  const withVector = process.argv.includes('--with-vector')
  const { cases, deps, intents } = loadEnv()
  console.log(`意图 ${intents.length} 条 · 标注 ${cases.length} 条（采纳 ${cases.filter((c) => c.mode === 'accept').length} / 放弃 ${cases.filter((c) => c.mode === 'reject').length}）`)

  if (withVector) {
    const provider = createEmbedProvider(intents, { url: EMBED_URL, timeoutMs: 1500, info: (m) => console.log(m) })
    provider.warmup()
    for (let i = 0; i < 40; i++) {
      if ((await provider.score('探测')).available) break
      await new Promise((r) => setTimeout(r, 500))
    }
    deps.vector = provider
  }

  const results = await runOnce(deps, cases)
  for (const r of results) {
    const ok = r.c.mode === 'accept'
      ? (r.accepted && r.got === r.c.expect ? '✓' : r.accepted ? `✗ 错判(${r.got})` : `✗ 漏(${r.reason})`)
      : (r.accepted && r.got !== 'none' ? `✗ 误采纳(${r.got})` : '✓')
    console.log(`  ${ok.padEnd(24)} tier=${(r.tier || '-').padEnd(7)} ms=${String(r.ms).padStart(4)}  ${r.c.q}`)
  }
  const s = summarize(results)
  console.log(`\n采纳率 ${(s.acceptRate * 100).toFixed(1)}% · 意图错判 ${s.wrongIntent} · 误采纳 ${s.falseAccepts.length}`)
  if (s.misses.length > 0) console.log(`未识别（交回主模型）：${s.misses.join('、')}`)
  if (s.falseAccepts.length > 0) console.log(`⚠ 误采纳：${s.falseAccepts.join('、')}`)

  if (sweep) {
    console.log('\n门限扫描（minBm25Score × minBm25RelMargin → 采纳率 / 误采纳）：')
    const scores = [8, 12, 16, 20, 24, 30]
    const margins = [0.2, 0.3, 0.35, 0.4, 0.5]
    const header = ['score\\margin', ...margins.map((m) => m.toFixed(2))].map((h) => h.padStart(11)).join('')
    console.log(`  ${header}`)
    for (const score of scores) {
      const cells: string[] = []
      for (const margin of margins) {
        const r = await runOnce(deps, cases, { ...DEFAULT_GATE, minBm25Score: score, minBm25RelMargin: margin })
        const ss = summarize(r)
        const ok = ss.falseAccepts.length === 0 && ss.wrongIntent === 0
        cells.push(`${(ss.acceptRate * 100).toFixed(0)}%/${ss.falseAccepts.length}${ok ? '' : '!'}`.padStart(11))
      }
      console.log(`  ${String(score).padStart(11)}${cells.join('')}`)
    }
    console.log('  说明：格式「采纳率/误采纳」；带 ! 表示该组合有误采纳或错判（不可接受）。')
  }

  const failed = s.falseAccepts.length > 0 || s.wrongIntent > 0 || s.acceptRate < 0.85
  console.log(failed ? '\neval-intent: NOT PASSED ❌（门限或用例需要复核）' : '\neval-intent: PASSED ✅')
  process.exit(failed ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error('eval-intent 失败：', error)
  process.exit(1)
})
