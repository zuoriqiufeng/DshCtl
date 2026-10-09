/**
 * self-test.ts — intent-router 独立自测（纯模块 + 真实生成物；不依赖运行实例）
 *
 * 运行（必须在 deepseek-harness checkout 下，与其它插件自测一致）：
 *   cd /hdd/demo/public/dsh-info/deepseek-harness
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/intent-router/self-test.ts
 *
 * 约定：只测纯模块与磁盘上的生成物；不 import 任何 @deepseek-ai/* 包
 * （插件目录没有 node_modules，裸包导入只在 DSH loader 加载 index.ts 时才解析得到）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYMPTOM_ALIASES, ERROR_ALIASES } from '../dsh-plugin/constants.ts'
import { buildScorer, classify } from './engine.ts'
import { isLikelyGreeting, lastUserText, normalizeText, stripSlashGesture } from './extract.ts'
import { ERROR_CODE_RE, extractErrorCodes, layer1 } from './layer1.ts'
import { buildAliasIndex, collectAliasVotes, DEFAULT_GATE, layer2 } from './layer2.ts'
import { mergeTaxonomy, normalizeIntent, type IntentDef } from './taxonomy.ts'
import { renderInjectionText } from './inject.ts'
import { parseFrontmatter, parseSkillMeta } from './frontmatter.ts'
import { cosine } from './bm25.ts'
import { OVERRIDES } from './overrides.ts'

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const HERE = import.meta.dirname
const GENERATED = JSON.parse(readFileSync(join(HERE, 'taxonomy.generated.json'), 'utf8')) as unknown
const LOADED = mergeTaxonomy(GENERATED, OVERRIDES)
const INTENTS = LOADED.intents
const ALIAS_INDEX = buildAliasIndex(INTENTS, { symptom: SYMPTOM_ALIASES, error: ERROR_ALIASES })
const DEPS = { intents: INTENTS, aliasIndex: ALIAS_INDEX, gate: DEFAULT_GATE, errorToolTarget: 'diagnose_error' }
const byId = (id: string): IntentDef | undefined => INTENTS.find((i) => i.id === id)

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] taxonomy：生成物加载 / 校验 / 合并')
check('生成物可加载且非空', INTENTS.length >= 10, `intents=${INTENTS.length}`)
check('12 个工具意图齐全', INTENTS.filter((i) => i.kind === 'tool').length === 12)
check('含 none 意图且不可注入', byId('none')?.injectable === false)
check('无重复 id', new Set(INTENTS.map((i) => i.id)).size === INTENTS.length)
check('overrides 已生效（check_action_risk 补了口语原型）',
  (byId('check_action_risk')?.prototypes ?? []).includes('这个动作会不会被拦'))
check('生成物每条 kind 与 target 自洽',
  INTENTS.every((i) => (i.kind === 'none' ? true : typeof i.target === 'string' && i.target !== '')))
check('normalizeIntent 拒绝缺 target 的工具意图',
  normalizeIntent({ id: 'x', kind: 'tool', label: 'x' }) === undefined)
check('normalizeIntent 拒绝未知 kind', normalizeIntent({ id: 'x', kind: 'magic', target: 't' }) === undefined)
check('normalizeIntent 接受合法条目', normalizeIntent({ id: 'x', kind: 'tool', target: 't' })?.id === 'x')
{
  const merged = mergeTaxonomy({ intents: [{ id: 'a', kind: 'tool', target: 'a' }, { id: 'b', kind: 'tool' }] }, { disable: [] })
  check('坏条目被跳过且计数正确', merged.intents.length === 1 && merged.skipped.length === 1,
    JSON.stringify(merged.skipped))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] extract：用户消息抽取与归一化')
const msg = (kind: string, text: string): { content: Array<{ type: string; text: string }>; source: { kind: string } } =>
  ({ content: [{ type: 'text', text }], source: { kind } })
check('只认 source.kind=user',
  lastUserText([msg('recall', '注入的召回上下文'), msg('user', '真正的用户问题')]) === '真正的用户问题')
check('外部注入的消息不参与识别',
  lastUserText([msg('intent-router', '上一轮的注入'), msg('tool', '工具结果')]) === '')
check('取最后一条用户消息', lastUserText([msg('user', '第一句'), msg('user', '第二句')]) === '第二句')
check('全角错误码归一为半角', normalizeText('ＯＲＡ－００９４２') === 'ORA-00942',
  normalizeText('ＯＲＡ－００９４２'))
check('零宽字符被剔除', normalizeText('同步\u200b卡住') === '同步卡住')
check('空白折叠', normalizeText('  创建   规则  ') === '创建 规则')
check('问候识别', isLikelyGreeting(normalizeText('你好')) && isLikelyGreeting('谢谢') && !isLikelyGreeting('你好，创建规则报错了'))
check('/手势被剥离（由上游 tool-skill 处理，本插件不重复接管）',
  stripSlashGesture('/i2stream-log-analyzer 看下日志') === '看下日志')

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] layer1：正则 / 精确规则')
{
  const hit = layer1(normalizeText('ORA-00942 是什么原因'), INTENTS)
  // 规则来源可以是 taxonomy 的精确规则（数据驱动优先）或内建兜底，两者都算命中
  check('错误码 → 诊断意图', hit?.intentId === 'diagnose_error'
    && (hit?.rule === 'builtin:error-code' || hit?.rule === 'exact:diagnose_error'), hit?.rule)
  check('错误码进 slots', hit?.slots.error_code === 'ORA-00942')
}
{
  const hit = layer1(normalizeText('出现 -4073 怎么办'), INTENTS)
  check('短数字码同样命中', hit?.intentId === 'diagnose_error' && hit?.slots.error_code === '-4073')
}
{
  const hit = layer1(normalizeText('YAS-02276 增量停了'), INTENTS)
  check('YAS 码命中', hit?.slots.error_code === 'YAS-02276')
}
{
  const hit = layer1(normalizeText('你好'), INTENTS)
  check('寒暄 → none 意图', hit?.intentId === 'none' && hit?.rule === 'builtin:greeting')
}
{
  const hit = layer1(normalizeText('用 diagnose_error 查一下'), INTENTS)
  check('显式点名工具 → 该意图（taxonomy exact 规则）', hit?.intentId === 'diagnose_error' && hit?.rule === 'exact:diagnose_error')
}
{
  // log-analyzer 被多个意图共同引用（诊断类），显式点名它本身有歧义——
  // 正确行为是「要么不表态、要么落到确实引用该 Skill 的意图」，绝不能乱指到无关意图。
  const hit = layer1(normalizeText('加载 i2stream-log-analyzer'), INTENTS)
  const owners = INTENTS.filter((i) => i.skills.includes('i2stream-log-analyzer')).map((i) => i.id)
  check('显式点名共享 Skill 不误判到无关意图',
    hit === undefined || owners.includes(hit.intentId), `${hit?.intentId} owners=${owners.join(',')}`)
}
check('明确的操作类问句不在层 1 命中（保守：交给层 2/主模型）',
  layer1(normalizeText('如何创建一条 Oracle 到 MySQL 的增量同步规则'), INTENTS) === undefined)
check('错误码正则不误吞普通数字', extractErrorCodes(normalizeText('2026 年 10 月 8 日')).length === 0)
check('错误码正则匹配多码', extractErrorCodes('ORA-00942 与 -4073 同时出现').length === 2)
check('ERROR_CODE_RE 支持全局匹配', ERROR_CODE_RE.global === true)

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] layer2：别名 / BM25 / RRF / 门限')
check('别名索引构建出条目', ALIAS_INDEX.entries.length > 20, `entries=${ALIAS_INDEX.entries.length}`)
check('长别名标为强证据', ALIAS_INDEX.entries.some((e) => e.alias === '同步卡住' && e.strong))
check('短别名只投票（非强证据）', ALIAS_INDEX.entries.some((e) => e.alias === '超时' && !e.strong))
{
  const votes = collectAliasVotes(normalizeText('同步卡住不动了'), ALIAS_INDEX)
  check('口语命中症状别名', votes.some((v) => v.strong), JSON.stringify(votes.map((v) => v.alias)))
}
{
  const scorer = buildScorer(INTENTS)
  const outcome = layer2({ normalized: normalizeText('同步卡住不动了'), intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX, gate: DEFAULT_GATE })
  check('强别名直接采纳（tier=alias）', outcome.hit?.tier === 'alias', `reason=${outcome.reason}`)
  check('强别名的落点是症状诊断意图', (outcome.hit?.intentId ?? '').startsWith('diagnose_'), outcome.hit?.intentId)
}
{
  const scorer = buildScorer(INTENTS)
  const outcome = layer2({ normalized: normalizeText('随便说点什么'), intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX, gate: DEFAULT_GATE })
  check('无意义输入 → 不采纳', outcome.hit === undefined, `reason=${outcome.reason}`)
}
{
  const scorer = buildScorer(INTENTS)
  // 苛刻门限：BM25-only 路径应被拒（用于验证门限真的在起作用，而不是形同虚设）
  const outcome = layer2({
    normalized: normalizeText('什么情况下禁止删除同步规则'), intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX,
    gate: { minBm25Score: 9999, minBm25RelMargin: 0.4, minCos: 2, minCosMargin: 2 },
  })
  check('门限可拒绝（绝对分不过线 → low-score）', outcome.hit === undefined && outcome.reason === 'low-score', outcome.reason)
  const narrow = layer2({
    normalized: normalizeText('什么情况下禁止删除同步规则'), intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX,
    gate: { minBm25Score: 0, minBm25RelMargin: 0.999, minCos: 2, minCosMargin: 2 },
  })
  check('门限可拒绝（间隔过窄 → narrow-margin）', narrow.hit === undefined && narrow.reason === 'narrow-margin', narrow.reason)
  const ok = layer2({
    normalized: normalizeText('什么情况下禁止删除同步规则'), intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX,
    gate: DEFAULT_GATE,
  })
  check('默认门限下采纳且落到 check_action_risk', ok.hit?.intentId === 'check_action_risk' && ok.hit.tier === 'algo', `${ok.hit?.intentId}/${ok.reason}`)
}
{
  // 向量分支只在 BM25 无法定论时参与（顺序补救设计），所以单测用一个"BM25 永不定论"的门限，
  // 才能把向量分支单独拎出来测。互证要求向量冠军同时落在 BM25 前 2 名内。
  const scorer = buildScorer(INTENTS)
  const normalized = normalizeText('目标端无监听')
  const weakGate = { ...DEFAULT_GATE, minBm25Score: 1e9 }
  const bmRanked = scorer.score(normalized).filter(([, v]) => v > 0).map(([id]) => id)
  const winner = bmRanked[0]!
  const outsider = INTENTS.map((i) => i.id).find((id) => !bmRanked.slice(0, 2).includes(id))!

  const accepted = layer2({
    normalized, intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX, gate: weakGate,
    vectorScores: new Map([[winner, 0.91], [outsider, 0.5]]), vectorAvailable: true,
  })
  check('向量路径采纳（tier=vector，且与 BM25 互证）',
    accepted.hit?.tier === 'vector' && accepted.hit?.intentId === winner, `${accepted.hit?.tier}/${accepted.reason}`)

  const lowCos = layer2({
    normalized, intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX, gate: weakGate,
    vectorScores: new Map([[winner, 0.40], [outsider, 0.30]]), vectorAvailable: true,
  })
  check('向量分不过线 → 拒绝（low-cos）', lowCos.hit === undefined && lowCos.reason === 'low-cos', lowCos.reason)

  const narrow = layer2({
    normalized, intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX, gate: weakGate,
    vectorScores: new Map([[winner, 0.90], [outsider, 0.89]]), vectorAvailable: true,
  })
  check('向量间隔过窄 → 拒绝（narrow-cos-margin）', narrow.hit === undefined && narrow.reason === 'narrow-cos-margin', narrow.reason)

  const uncorroborated = layer2({
    normalized, intents: INTENTS, scorer, aliasIndex: ALIAS_INDEX, gate: weakGate,
    vectorScores: new Map([[outsider, 0.95], [winner, 0.40]]), vectorAvailable: true,
  })
  check('向量冠军不在 BM25 前 2 名 → 拒绝（跨方法互证）',
    uncorroborated.hit === undefined && uncorroborated.reason === 'vector-uncorroborated', uncorroborated.reason)
}
check('cosine 基本性质', cosine([1, 0], [1, 0]) === 1 && cosine([1, 0], [0, 1]) === 0 && cosine([], [1]) === 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] engine：端到端分类')
{
  const decision = await classify('ORA-00942 是什么原因', DEPS)
  check('层 1 短路（不进入层 2）', decision.accepted && decision.tier === 'rule' && decision.ranking.length === 0)
  check('槽位透传到决策', decision.hit?.slots.error_code === 'ORA-00942')
}
{
  const decision = await classify('你好', DEPS)
  check('寒暄被识别为 none（可注入=false → 不注入）', decision.accepted && decision.intent?.injectable === false)
}
{
  const decision = await classify('同步卡住不动了，帮我看看', DEPS)
  check('层 2 强别名采纳', decision.accepted && decision.tier === 'alias', `reason=${decision.reason}`)
}
{
  const decision = await classify('今天天气不错', DEPS)
  check('无关输入不采纳（交回主模型）', !decision.accepted, `reason=${decision.reason}`)
}
{
  // 向量提供者抛异常 → 必须降级而不是抛出（降级铁律）
  const broken = {
    score: async () => {
      throw new Error('sidecar down')
    },
  }
  const decision = await classify('同步卡住不动了', { ...DEPS, vector: broken })
  check('向量不可达 → 降级到 BM25-only 且不抛', decision.accepted && decision.tier === 'alias')
}
{
  const unavailable = { score: async () => ({ scores: new Map<string, number>(), available: false }) }
  const decision = await classify('同步卡住不动了', { ...DEPS, vector: unavailable })
  check('向量 available=false → 同样降级', decision.accepted)
}
{
  // 顺序补救的核心收益：BM25 有定论的输入完全不碰向量（热路径零额外延迟）
  let calls = 0
  const counting = { score: async () => { calls++; return { scores: new Map<string, number>(), available: false } } }
  const decision = await classify('什么情况下禁止删除同步规则？', { ...DEPS, vector: counting })
  check('BM25 有定论时不调用向量（顺序补救）', decision.accepted && decision.tier === 'algo' && calls === 0, `calls=${calls}`)

  let calls2 = 0
  const counting2 = { score: async () => { calls2++; return { scores: new Map<string, number>(), available: false } } }
  const decision2 = await classify('数据库连不上怎么办', { ...DEPS, vector: counting2 })
  check('BM25 判不出时才调用向量', calls2 === 1, `calls=${calls2} accepted=${decision2.accepted}`)

  let calls3 = 0
  const counting3 = { score: async () => { calls3++; return { scores: new Map<string, number>(), available: false } } }
  await classify('嗯', { ...DEPS, vector: counting3 })
  check('BM25 零重叠（no-overlap）时也跳过向量', calls3 === 0, `calls=${calls3}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] inject：注入文案')
{
  const decision = await classify('ORA-00942 是什么原因', DEPS)
  const text = renderInjectionText(decision.intent!, decision.hit!)
  check('含免责声明（以用户输入为准）', text.includes('以用户输入为准'))
  check('含工具名与参数', text.includes('diagnose_error') && text.includes('ORA-00942'))
  check('含关联 Skill 提示', text.includes('i2stream-db-diagnostics'))
}
{
  const intent = byId('none')!
  const text = renderInjectionText(intent, { intentId: 'none', tier: 'rule', slots: {}, matched: '你好', rule: 'builtin:greeting' })
  check('none 文案不出现工具指令', !text.includes('建议直接调用'))
}
{
  const decision = await classify('同步卡住不动了', DEPS)
  const custom = renderInjectionText(decision.intent!, decision.hit!, '[{tier}] {label} → {target} ({evidence})')
  check('自定义模板生效', custom.startsWith('[alias]') && custom.includes(decision.intent!.label))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] frontmatter：SKILL.md 解析')
{
  const text = [
    '---',
    'name: demo-skill',
    'description: |',
    '  第一行说明',
    '  第二行说明',
    'triggers:',
    '  - "看日志"',
    '  - 查规则',
    '---',
    '',
    '# 正文',
  ].join('\n')
  const meta = parseSkillMeta(text)
  check('name 解析', meta.name === 'demo-skill')
  check('多行块 description 解析', meta.description.includes('第一行说明') && meta.description.includes('第二行说明'))
  check('列表 triggers 解析', meta.triggers.length === 2 && meta.triggers[0] === '看日志' && meta.triggers[1] === '查规则')
  check('无 frontmatter 时返回空结构', Object.keys(parseFrontmatter('')).length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] 真实语料冒烟（bench-4q 四问 + 现场口语）')
const SMOKE = [
  '如何创建一条 Oracle 到 MySQL 的增量同步规则？',
  '增量同步卡住不动了，怎么排查？',
  '什么情况下禁止删除同步规则？',
  'YAS-01001 错误是什么原因？',
  '数据库连不上怎么办',
  'i2Stream 支持哪些数据库',
  '你好',
  '帮我看看这个需求能不能实现',
]
for (const q of SMOKE) {
  const decision = await classify(q, DEPS)
  const intentText = decision.accepted ? `${decision.intent?.id ?? '?'}（${decision.tier}）` : `不干预（${decision.reason}）`
  console.log(`  · ${q}  →  ${intentText}  ${decision.ms}ms`)
  check(`冒烟：${q.slice(0, 12)}… 结论合法`, decision.accepted ? (decision.intent !== undefined && decision.tier !== undefined) : true)
}
{
  const decisions = await Promise.all(SMOKE.map((q) => classify(q, DEPS)))
  const accepted = decisions.filter((d) => d.accepted && d.intent?.kind !== 'none').length
  check('冒烟集里多数问题被本地识别（覆盖率不为 0）', accepted >= 4, `accepted=${accepted}/${SMOKE.length}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9] 标定集分离度（eval/questions.json —— 门限回归防线）')
{
  const evals = JSON.parse(readFileSync(join(HERE, 'eval', 'questions.json'), 'utf8')) as {
    cases: Array<{ q: string; expect: string | null; mode: string }>
  }
  const acceptCases = evals.cases.filter((c) => c.mode === 'accept')
  const rejectCases = evals.cases.filter((c) => c.mode === 'reject')
  let acceptHit = 0
  let acceptWrong = 0
  const falseAccepts: string[] = []
  const misses: string[] = []
  for (const c of acceptCases) {
    const d = await classify(c.q, DEPS)
    if (!d.accepted) { misses.push(c.q); continue }
    acceptHit++
    if (d.intent?.id !== c.expect) acceptWrong++
  }
  for (const c of rejectCases) {
    const d = await classify(c.q, DEPS)
    if (d.accepted && d.intent?.kind !== 'none') falseAccepts.push(`${c.q} → ${d.intent?.id}`)
  }
  const acceptRate = acceptHit / acceptCases.length
  console.log(`  采纳组 ${acceptHit}/${acceptCases.length}（错误意图 ${acceptWrong}）· 放弃组误采纳 ${falseAccepts.length}/${rejectCases.length}`)
  if (misses.length > 0) console.log(`  未识别（交回主模型）：${misses.join(' / ')}`)
  if (falseAccepts.length > 0) console.log(`  ⚠ 误采纳：${falseAccepts.join(' / ')}`)
  check('放弃组零误采纳（精度优先：宁可拒不可错）', falseAccepts.length === 0, falseAccepts.join(' / '))
  check('采纳组覆盖率 ≥ 85%', acceptRate >= 0.85, `${(acceptRate * 100).toFixed(1)}%`)
  check('采纳组命中意图无误判', acceptWrong === 0, `wrong=${acceptWrong}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[10] 性能：层 1+2 本地耗时')
{
  const N = 200
  const times: number[] = []
  for (let i = 0; i < N; i++) {
    const q = SMOKE[i % SMOKE.length]!
    const started = performance.now()
    await classify(q, DEPS)
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(N * 0.5)]!
  const p95 = times[Math.floor(N * 0.95)]!
  const max = times[N - 1]!
  console.log(`  p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms（含每次重建 BM25 索引）`)
  check('p95 < 10ms（本地路径，远低于一次大模型调用）', p95 < 10, `p95=${p95.toFixed(2)}ms`)
  check('max < 30ms', max < 30, `max=${max.toFixed(2)}ms`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures} failed`)
console.log(failures === 0 ? 'ALL PASSED ✅' : 'FAILED ❌')
process.exit(failures === 0 ? 0 : 1)
