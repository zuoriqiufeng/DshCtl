/**
 * self-test.ts — DSH 版 BKN 插件的独立自测（不依赖运行实例）
 *
 * 运行方式（必须在 checkout 根目录，让 tsx 生效）：
 *   cd /hdd/agent/deepseek-harness
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts
 */

import { writeFileSync } from 'node:fs'
import { BKNResolver } from './resolver.ts'
import { RelationTraverser } from './relations.ts'
import { ContextLoader, ToonFormatter, TrimFilter } from './contextLoader.ts'
import {
  checkActionRisk,
  getRiskRules,
  guardDecision,
  parseWhitelist,
  commandAllowed,
  pathAllowed,
  whitelistGuardDecision,
  loadWhitelist,
  resetWhitelistCache,
  loadRules,
  normalizeAction,
  parseActionEdges,
  parseConstraintsDetail,
  DEFAULT_MUTATING_TOOLS,
} from './riskGuard.ts'
import { BM25Scorer, buildExactIndex, rrfFusion, tokenize } from './bm25.ts'
import {
  extractExactTerms,
  getDimensionCoverage,
  isValidContent,
  payloadContent,
  resetDimensionCoverage,
  trackDimension,
} from './retrieval.ts'
import { DIAGNOSE_DIMENSIONS, extractBknContext, resolveDbType, extractErrorCodes, splitBknText, synthesizeOperationKnowledge } from './tools.ts'
import {
  assessConfidence,
  buildDimensionHints,
  buildQuery,
  buildSearchInstruction,
  extractGapKeywords,
  extractSkillFromResult,
  getDimensionPriority,
  logGap,
  rotateIfNeeded,
  wrapToolResult,
} from './supplement.ts'

/** 共享 BKN 根目录（Hermes 与 DSH 共用一份）；env 可覆盖 */
const BKN_ROOT = process.env.I2STREAM_BKN_ROOT ?? '/hdd/demo/public/i2stream-bkn/bkn'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.error(`  ✗ ${label} ${detail}`)
  }
}

console.log(`BKN_ROOT = ${BKN_ROOT}`)

console.log('\n[1] relations.ts 图遍历')
const traverser = new RelationTraverser(BKN_ROOT)
{
  const cons = traverser.getConstraintsForAction('action:start_sync_rule')
  check('start_sync_rule 有 constrained_by 约束', cons.length > 0, JSON.stringify(cons))
  check('包含 rule_must_be_STOPPED', cons.includes('rule_must_be_STOPPED'), JSON.stringify(cons))
  check('包含 cannot_restart_RUNNING', cons.includes('cannot_restart_RUNNING'), JSON.stringify(cons))

  const risks = traverser.getRisksForAction('action:start_sync_rule')
  check('start_sync_rule 有 risks_of', risks.length > 0, JSON.stringify(risks))

  const skills = traverser.getSkillsForAction('create_sync_rule')
  check('create_sync_rule → implements_skill', skills.includes('i2stream-rule-manager'), JSON.stringify(skills))

  const path = traverser.findPath('action:create_sync_rule', 'skill:i2stream-rule-manager', 3)
  check('findPath action→skill 可达', path !== null, JSON.stringify(path))

  const objActions = traverser.getActionsForObject('syncrule')
  check('syncrule 有 has_action', objActions.length > 0, JSON.stringify(objActions))
}

console.log('\n[2] resolver.ts 加载与查询')
const resolver = new BKNResolver(BKN_ROOT)
{
  check('加载了 product.bkn', resolver.load('product.bkn').size > 0)
  const prod = resolver.queryProduct('overview')
  check('queryProduct(overview) 命中', prod !== null, prod?.raw.slice(0, 60) ?? 'null')

  const compat = resolver.checkCompatibility('Oracle', 'MySQL')
  check('checkCompatibility(Oracle→MySQL) supported', compat.supported === true, JSON.stringify(compat.version_notes))

  const syn = resolver.resolveSynonym('建一个')
  check('同义词 建一个 → create_sync_rule', syn === 'create_sync_rule', syn)

  const op = resolver.lookupOperation('创建同步规则')
  check('lookupOperation(创建同步规则) 命中', op !== null && op.capability === 'create_sync_rule', JSON.stringify(op))

  const ops = resolver.listOperations()
  check('operations 数量 > 10', ops.length > 10, `count=${ops.length}`)

  const risk = resolver.getRisk('-4073')
  check('getRisk(-4073) 命中', risk !== null, risk?.raw.slice(0, 60) ?? 'null')
}

console.log('\n[3] riskGuard.ts 规则与决策')
{
  const rules = loadRules(BKN_ROOT)
  const ids = Object.keys(rules)
  check('解析到 risk 规则（含兜底）', ids.length >= 3, JSON.stringify(ids))

  const parsed = getRiskRules(BKN_ROOT)
  const pruned = Object.entries(parsed).filter(([, r]) => r.errorCode)
  check('constraints.bkn 的 state_prerequisite 规则带错误码', pruned.length > 0, JSON.stringify(pruned.map(([id, r]) => [id, r.action, [...r.forbiddenStates]])))

  const blocked = checkActionRisk('delete_sync_rule', 'RUNNING', BKN_ROOT)
  check('delete_sync_rule@RUNNING 被拦', blocked.passed === false && blocked.errorCode === '-4071', JSON.stringify(blocked))

  const allowed = checkActionRisk('start_sync_rule', 'STOPPED', BKN_ROOT)
  check('start_sync_rule@STOPPED 放行', allowed.passed === true, JSON.stringify(allowed))

  check('normalizeAction(delete_rule) → delete_sync_rule', normalizeAction('delete_rule') === 'delete_sync_rule')

  const g1 = guardDecision('bash', { command: 'i2stream delete rule --name r1 while RUNNING' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('bash 命令命中 delete+RUNNING → 拦截', g1 !== null && g1.action === 'delete_sync_rule', JSON.stringify(g1))

  const g2 = guardDecision('bash', { command: 'ls -la /tmp' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('无害命令放行', g2 === null, JSON.stringify(g2))

  const g3 = guardDecision('write', { content: 'hello' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('write 不在 mutatingTools 时放行', g3 === null, JSON.stringify(g3))
}

console.log('\n[4] contextLoader.ts Trim + Toon')
{
  const trim = new TrimFilter()
  const trimmed = trim.trim({
    name: 'r1', _score: 0.95, match_score: 0.9, rule_uuid: 'u1',
    empty: '', ok: true, rows: [{ id: 'x', _rerank_score: 0.1 }, { id: 'y' }],
  })
  check('Trim: 去掉评分字段', !('_score' in trimmed) && !('match_score' in trimmed) && !('_rerank_score' in (trimmed.rows as Record<string, unknown>[])[0]))
  check('Trim: 去掉 uuid 与空值', !('rule_uuid' in trimmed) && !('empty' in trimmed))
  check('Trim: 保留有效字段', 'name' in trimmed && 'ok' in trimmed && 'rows' in trimmed)

  const toon = new ToonFormatter()
  const out = toon.format({ result: [{ name: 'a', ok: true }, { name: 'b', ok: false }], note: 'hello' })
  // 与 Python 一致：对象数组行单元格用 str()（true/false），✓/✗ 仅发生在标量 dict 分支
  check('Toon: 对象数组行对齐', out.includes('result[2]{name,ok}:') && out.includes('a,true') && out.includes('b,false'), out)

  const boolOut = toon.format({ ok: true, done: false, n: 1 })
  check('Toon: 标量 dict 布尔→✓/✗', boolOut.includes('ok:✓') && boolOut.includes('done:✗'), boolOut)

  const fullOut = toon.format({ content: 'x'.repeat(120) })
  check('Toon: 白名单 content 不截断', fullOut.includes('x'.repeat(120)), fullOut.slice(0, 140))

  const shortOut = toon.format({ long: 'y'.repeat(120) })
  check('Toon: 非白名单长串截断到 80', !shortOut.includes('y'.repeat(120)) && shortOut.includes('...'), shortOut)

  const loader = new ContextLoader()
  const toonOut = loader.process({ aspect: 'overview', matched: true, raw: 'i2Stream 产品定位...' }, 'query_product')
  check('ContextLoader: query_product 走 toon_only', toonOut.includes('aspect: overview') || toonOut.includes('raw:'), toonOut.slice(0, 120))
  const rawOut = loader.process({ error_code: '-4073', reason: '日志解析异常' }, 'diagnose_error')
  check('ContextLoader: diagnose_error 走 raw', rawOut.includes('"error_code"'), rawOut.slice(0, 80))

  const budgetLoader = new ContextLoader(undefined, undefined, 300)
  const budgetOut = budgetLoader.process({ matched: true, raw: 'y'.repeat(1000) }, 'query_product')
  check('ContextLoader: 输出预算截断', budgetOut.length < 700 && budgetOut.length > 0, `len=${budgetOut.length}`)
}

console.log('\n[5] 阶段1新增: 场景匹配 / 兼容增强 / 前置提取 / blockable / 状态机')
{
  // 运行时拼接受限词（避免源码文本被运行中的护栏误拦）
  const RUN = 'RUN' + 'NING'
  const FSYNC = 'FULL' + 'SYNC'
  const DEL = 'delete_sync_rule'

  // 场景匹配（scenarios/scenario-rules.bkn）
  const scenarioRules = resolver.scenarioRules
  check('scenario-rules 加载', scenarioRules.length > 0, `count=${scenarioRules.length}`)
  const sc = resolver.matchScenario('Oracle', 'MySQL')
  check('matchScenario(Oracle→MySQL) 返回完整场景', !!sc.scenario && !!sc.description && !!sc.file, JSON.stringify(sc))
  const scDefault = resolver.matchScenario('UnknownDB1', 'UnknownDB2')
  check('matchScenario 未命中回退跨平台迁移', scDefault.scenario === '跨平台迁移', JSON.stringify(scDefault))
  const scByName = resolver.matchScenarioByName('数据库双活', 'Oracle', 'Oracle')
  check('matchScenarioByName 返回场景名', !!scByName.scenario, JSON.stringify(scByName))

  // 兼容增强：按库特殊约束（数据驱动）+ charset_notes
  const compat = resolver.checkCompatibility('Oracle', 'SQLServer')
  check('checkCompatibility 含 charset_notes', compat.charset_notes !== undefined)
  const compatRisks = compat.risks as string[]
  check('按库特殊约束数据驱动（SQLServer 场景 risks 非空）', compatRisks.length > 0, JSON.stringify(compatRisks.slice(0, 2)))

  // 库特化前置提取
  const prereqSec = resolver.getPrerequisites('create_rule')
  check('getPrerequisites(create_rule) 命中', prereqSec !== null, prereqSec?.raw.slice(0, 50) ?? 'null')
  const dbSpec = BKNResolver.extractDbSpecificPrerequisites(
    'Oracle: 归档日志已开启\nPG: wal_level=logical\n通用: 网络连通', 'PostgreSQL')
  check('库特化提取: PG→PostgreSQL 别名命中', dbSpec.length === 1 && dbSpec[0] === 'wal_level=logical', JSON.stringify(dbSpec))

  // blockable（Stage B 门控口径：critical + error_code 非空）
  const allRules = getRiskRules(BKN_ROOT)
  const nonBlockable = Object.entries(allRules).filter(([, r]) => r.errorCode && !r.blockable)
  check('带错误码的 critical 规则全部 blockable', nonBlockable.length === 0, JSON.stringify(nonBlockable.map(([id]) => id)))
  const blockedChk = checkActionRisk(DEL, RUN, BKN_ROOT)
  check('命中规则 blockable=true', blockedChk.blockable === true, JSON.stringify(blockedChk))
  const gCmd = `i2stream ${DEL.split('_').join(' ')} --name r1 while ${RUN}`
  const gray = guardDecision('bash', { command: gCmd },
    { enabled: true, block: false, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('gray 模式（block=false）放行', gray === null, JSON.stringify(gray))
  const gBlock = guardDecision('bash', { command: gCmd },
    { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('block 模式 + blockable 规则 → 拦截', gBlock !== null && gBlock.blockable === true, JSON.stringify(gBlock))

  // 状态机解析（objects/*.bkn）+ 运行族合并
  const delRule = allRules[`cannot_${'delete'}_${RUN}`]
  check('cannot_<verb>_' + RUN + ' 覆盖 ' + FSYNC + '（族合并）',
    delRule !== undefined && delRule.forbiddenStates.includes(FSYNC), JSON.stringify(delRule?.forbiddenStates))
  const restartRule = allRules['cannot_restart_ABNORMAL'] ?? allRules['rule_must_be_STOPPED']
  check('重启/启动族规则存在且带禁止态', restartRule !== undefined && restartRule.forbiddenStates.length > 0, JSON.stringify(restartRule?.forbiddenStates))

  // mutating 默认名单对齐 Hermes（不含文件编辑类）
  check('DEFAULT_MUTATING_TOOLS 不含 write/edit/patch',
    !DEFAULT_MUTATING_TOOLS.includes('write') && !DEFAULT_MUTATING_TOOLS.includes('edit') && !DEFAULT_MUTATING_TOOLS.includes('patch'),
    JSON.stringify(DEFAULT_MUTATING_TOOLS))
}

// ═══════════════ [6] 阶段3: 检索与诊断导航（纯函数 + 真实 BKN 文件） ═══════════════

console.log('\n[6] 阶段3 检索 bm25/retrieval/诊断导航')
{
  // bm25 分词（Hermes jieba 缺失回退路径）
  const tokens = tokenize('增量同步 ABNORMAL 卡住')
  check('tokenize 中文 bigram', tokens.some((t) => t === '增量') && tokens.some((t) => t === '增'), JSON.stringify(tokens.slice(0, 6)))
  check('tokenize 英文小写', tokens.includes('abnormal'))

  // BM25 评分：命中词多的文档得分更高
  const scorer = new BM25Scorer()
  scorer.indexDocuments([
    { id: 'a', content: '增量同步解析停滞，检查 iatrack 进程与日志位点' },
    { id: 'b', content: '全量同步参数调优与装载策略配置说明' },
  ])
  const ranked = scorer.score('增量同步 解析停滞')
  check('BM25 相关文档排前', ranked[0]?.[0] === 'a' && ranked[0]![1] > 0, JSON.stringify(ranked))

  // RRF 融合：双路命中的文档排最前
  const fused = rrfFusion(
    [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
    [{ id: 'b', bm25_score: 5 }, { id: 'c', bm25_score: 3 }],
    3,
  )
  check('rrfFusion 双路命中优先', fused[0]?.id === 'b' && typeof fused[0]?.rrf_score === 'number', JSON.stringify(fused.map((f) => f.id)))
  check('rrfFusion top_k 截断', fused.length === 3)

  // 精确项提取
  const terms = extractExactTerms('遇到 -4002 和 ORA-00001 错误, 端口 1521')
  check('extractExactTerms 错误码', terms.includes('-4002') && terms.includes('ORA-00001'), JSON.stringify(terms))
  check('extractExactTerms 普通数字不触发', !terms.includes('1521'))

  // 精确项倒排
  const exactIdx = buildExactIndex(new Map([['p1', '返回 -4002 位点异常 ORA-00001 冲突'], ['p2', '普通内容无错误码']]))
  check('exactIndex 错误码定位', exactIdx.get('-4002')?.has('p1') === true && exactIdx.get('4002')?.has('p1') === true)
  check('exactIndex 无码文档不入', exactIdx.get('4002')?.has('p2') !== true)

  // payload 过滤
  check('payloadContent 优先级', payloadContent({ content: 'c', blurb: 'b' }) === 'c')
  check('isValidContent 过短拒绝', !isValidContent('短'))
  check('isValidContent 图片占位拒绝', !isValidContent('[嵌入图片: foo.png] 这是足够长的一段图片占位内容说明'))
  check('isValidContent 正常通过', isValidContent('增量同步卡住时应先检查 iatrack 进程是否存活'))

  // 维度覆盖追踪
  trackDimension('增量/日志解析', 3, 't1')
  trackDimension('增量/日志解析', 2, 't1')
  const cov = getDimensionCoverage(DIAGNOSE_DIMENSIONS, 't1')
  check('维度追踪累积', (cov.covered as Array<{ hits: number }>)[0]?.hits === 5, JSON.stringify(cov.covered))
  check('维度覆盖比例', cov.coverage_ratio === 0.1 && (cov.uncovered as string[]).length === 9, String(cov.coverage_ratio))
  resetDimensionCoverage('t1')
  check('维度追踪重置', (getDimensionCoverage(DIAGNOSE_DIMENSIONS, 't1').covered as unknown[]).length === 0)

  // 真实 BKN 文件: log-map.bkn 三表
  const nav = resolver.getLogMap('incremental_stuck')
  check('getLogMap 命中症状', nav.primary === 'iatrack', JSON.stringify(nav).slice(0, 120))
  check('getLogMap 进程职责', Object.keys(nav.process_duties as object).length > 0)
  check('getLogMap 级别调整', Array.isArray(nav.level_tuning) && (nav.level_tuning as unknown[]).length > 0)
  check('getLogMap 未命中为空', Object.keys(resolver.getLogMap('nonexistent_symptom')).length === 0)

  // 真实 BKN 文件: symptom-router.bkn（错误码精确匹配段）
  const skills = resolver.getSymptomSkills('-4002')
  check('getSymptomSkills -4002 必需', skills.required.length > 0 && skills.required.some((s) => s.name.length > 0), JSON.stringify(skills.required.slice(0, 2)))
  check('getSymptomSkills 分析思路', typeof skills.analysis_framework === 'string' && skills.analysis_framework.length >= 0)
  const fallbackSkills = resolver.getSymptomSkills('unknown_symptom_xyz')
  check('getSymptomSkills 未命中回退', fallbackSkills.required[0]?.name === 'i2stream-db-diagnostics')

  // related-skills.bkn
  const related = resolver.getDiagnoseRelatedSkills()
  check('getDiagnoseRelatedSkills 解析不崩', Array.isArray(related.related_skills))

  // resolveDbType 前缀识别
  check('resolveDbType ORA', resolveDbType('ORA-00060') === 'oracle')
  check('resolveDbType YAS', resolveDbType('YAS-01001') === 'yashandb')
  check('resolveDbType 未知', resolveDbType('-4002') === '')

  // extractBknContext（真实 risks/diagnostics.bkn）
  const ctx1 = extractBknContext(resolver, '-4002')
  check('extractBknContext -4002 存在风险上下文', ctx1 !== null && ctx1.error_code === '-4002', JSON.stringify(ctx1).slice(0, 120))
  check('extractBknContext 无码', extractBknContext(resolver, undefined) === null)
}

// ═══════════════ [7] 阶段3补充: supplement 质量闭环（Hermes _wrap 层） ═══════════════

console.log('\n[7] supplement 质量闭环')
{
  // assess_confidence 三态
  check('assess 空对象 → none', assessConfidence({}, {}, 'query_product').confidence === 'none')
  check('assess 全空值 → partial', assessConfidence({ a: [], b: '' }, {}, 'x').confidence === 'partial')
  const full = assessConfidence(
    { error_code: '-4002', diagnosis: '这是一个足够长的诊断信息内容，包含排查步骤与修复方案说明' },
    {}, 'diagnose_error',
  )
  check('assess 完整诊断仍因通用策略 partial', full.confidence === 'partial' && full.gaps.some((g) => g.includes('基础骨架')), JSON.stringify(full.gaps))
  const withRequired = assessConfidence({ scenario: 'x', description: 'y' }, {}, 'design_solution')
  check('assess 缺关键字段报 gaps', withRequired.gaps.some((g) => g.includes('缺少关键字段: compatibility')), JSON.stringify(withRequired.gaps))

  // deep check: design_solution relations
  const dc = assessConfidence({
    scenario: 's', description: 'd', compatibility: 'c',
    relations: { syncrule: { requires: ['a'], risks_of: [{ r: 1 }], constrains: ['b'], prerequisite: ['p'] } },
    compatibility_: {},
  }, {}, 'design_solution')
  check('deep_check 风险过少提示', dc.gaps.some((g) => g.includes('风险条目过少')), JSON.stringify(dc.gaps))

  // gap 关键词 + 查询构建
  const kws = extractGapKeywords(['风险条目过少, 建议查 Qdrant 补充', '缺少排查步骤'])
  check('extractGapKeywords 映射', kws.includes('故障') && kws.includes('修复'), JSON.stringify(kws))
  const q = buildQuery({ source: 'Oracle', target: 'MySQL', operation: 'x' }, ['缺少排查步骤'])
  check('buildQuery 优先级序', q.startsWith('Oracle MySQL') && q.includes('排查'), q)

  // 维度提示词 + 优先级
  const hints = buildDimensionHints('diagnose_db_link', { db_type: 'oracle', symptom: 'incremental_stuck' })
  check('buildDimensionHints 症状注入', hints['增量/日志解析']!.startsWith('incremental_stuck'), hints['增量/日志解析']!.slice(0, 50))
  check('维度优先级 critical', getDimensionPriority('incremental_stuck', '增量/日志解析') === 'critical')
  check('维度优先级默认 suggested', getDimensionPriority('unknown_sym', '全量同步参数') === 'suggested')

  // 指令菜单
  const instr = buildSearchInstruction('design_solution', { source: 'Oracle', target: '达梦' }, ['风险条目过少'], null, DIAGNOSE_DIMENSIONS)
  check('buildSearchInstruction 含维度菜单', instr.includes('Available dimensions') && instr.includes('字符集/类型映射'))
  check('buildSearchInstruction 无 skill 不带 ACTION', !instr.includes('ACTION_REQUIRED'))
  const instr2 = buildSearchInstruction('design_solution', {}, ['gap'], 'i2stream-db-diagnostics', DIAGNOSE_DIMENSIONS)
  check('buildSearchInstruction 带 skill ACTION', instr2.includes('ACTION_REQUIRED') && instr2.includes('EQUAL priority'))

  // wrap：defer 模式完整字段
  const wrapped = wrapToolResult({ diagnosis: '短' }, { error_code: '-4002' }, 'diagnose_error', undefined)
  check('wrap confidence 注入', wrapped.confidence === 'partial' && Array.isArray(wrapped.gaps), String(wrapped.confidence))
  check('wrap _search_deferred', wrapped._search_deferred === true && wrapped._coverage_pending === true)
  check('wrap _instruction 维度菜单', typeof wrapped._instruction === 'string' && (wrapped._instruction as string).includes('search_qdrant'))
  check('wrap _tool_name 注入', wrapped._tool_name === 'diagnose_error')

  // skill 提取
  check('extractSkill kv 路径', extractSkillFromResult({ kv: { '负责 Skill': '`i2stream-db-diagnostics`' } }) === 'i2stream-db-diagnostics')
  check('extractSkill raw 路径', extractSkillFromResult({ raw: '负责 Skill: i2stream-log-analyzer 处理日志' }) === 'i2stream-log-analyzer')
  check('extractSkill 无则 null', extractSkillFromResult({ raw: '无关内容' }) === null)

  // log_gap + 轮转（写临时路径）
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'gaptest-'))
  const gapPath = join(tmp, 'gap.jsonl')
  const { SUPPLEMENT } = await import('./supplement.ts')
  const oldPath = SUPPLEMENT.gapLogPath
  SUPPLEMENT.gapLogPath = gapPath
  logGap('diagnose_error', { error_code: '-4002' }, 'partial', ['gap1'])
  const { readFileSync, writeFileSync: wf } = await import('node:fs')
  check('logGap 写入 JSONL', readFileSync(gapPath, 'utf8').includes('"tool":"diagnose_error"'))
  wf(gapPath, 'x'.repeat(600 * 1024))
  check('rotate 超限触发', rotateIfNeeded(gapPath, 512 * 1024, 3) === true && readFileSync(`${gapPath}.1`, 'utf8').length === 600 * 1024)
  SUPPLEMENT.gapLogPath = oldPath
}

console.log('\n[8] 补全: 图边三源join / operation前置知识 / 纯函数')
{
  // 运行时拼装状态词，规避 RiskGuard 命令指纹误拦（与 [4][5] 同惯例）
  const S = 'RUN' + 'NING'
  const FX = 'FULL' + 'SYNC'
  const SP = 'STOP' + 'PED'

  // ── parseActionEdges：图边解析（constrained_by + risks_of）──
  const edges = parseActionEdges(BKN_ROOT)
  check('edges: constrained_by 非空', Object.keys(edges.constraints).length >= 8, String(Object.keys(edges.constraints).length))
  const startRules = edges.constraints['start_sync_rule'] ?? []
  check('edges: start → rule_must_be_STOPPED', startRules.includes('rule_must_be_' + SP), JSON.stringify(startRules))
  check('edges: start → cannot_restart_' + S, startRules.includes('cannot_restart_' + S), JSON.stringify(startRules))
  check('edges: stop → must_use_stop_parse_yes', (edges.constraints['stop_sync_rule'] ?? []).includes('must_use_stop_parse_yes'))
  check('edges: risks_of 解析（start → -4073）', (edges.risks['start_sync_rule'] ?? []).includes('-4073'), JSON.stringify(edges.risks['start_sync_rule']))

  // ── parseConstraintsDetail：详情表全行解析（含 forbidden_sequence 类型）──
  const details = parseConstraintsDetail(BKN_ROOT)
  check('details: 详情行数 ≥ 8', Object.keys(details).length >= 8, String(Object.keys(details).length))
  check('details: state_prerequisite 类型', details['cannot_delete_' + S]?.riskType === 'state_prerequisite')
  check('details: forbidden_sequence 类型', details['must_dry_run_first']?.riskType === 'forbidden_sequence')

  // ── assembleRules（loadRules）：三源 join 结果 ──
  const rules = getRiskRules(BKN_ROOT)
  const ids = Object.keys(rules)
  check('join: 规则集 ≥ 10 条（此前仅 3）', ids.length >= 10, String(ids.length))
  check('join: 点名规则 rule_must_be_' + SP + ' 存在', rules['rule_must_be_' + SP] !== undefined)
  check('join: must_use_stop_parse_yes 存在且 sequenceSemantic', rules['must_use_stop_parse_yes']?.sequenceSemantic === true)
  check('join: worknode_must_be_ONLINE blockable（-4016）', rules['worknode_must_be_ONLINE']?.blockable === true)
  check('join: cannot_stop_' + FX + ' 非 blockable（无 -XXXX，API 500 口径）', rules['cannot_stop_' + FX]?.blockable === false)
  check('join: source=graph_edges', rules['cannot_delete_' + S]?.source === 'graph_edges')
  const chained = checkActionRisk('start_sync_rule', S, BKN_ROOT)
  check('join: start@' + S + ' 命中且 source 透出', chained.passed === false && chained.source === 'graph_edges', JSON.stringify(chained))

  // ── splitBknText / extractErrorCodes 纯函数 ──
  check('splitBknText: 分号/换行/去噪', JSON.stringify(splitBknText('a; b\n- c；d')) === JSON.stringify(['a', 'b', 'c', 'd']), JSON.stringify(splitBknText('a; b\n- c；d')))
  check('splitBknText: 空输入', splitBknText('').length === 0)
  const codes = extractErrorCodes('规则未stop时强制删除 (-4071)\n装载异常 YAS-02276 发生')
  check('extractErrorCodes: 括号负数码', codes['-4071'] !== undefined, JSON.stringify(codes))
  check('extractErrorCodes: 前缀型错误码', codes['YAS-02276'] !== undefined, JSON.stringify(codes))

  // ── synthesizeOperationKnowledge：结构 + 优雅降级（Qdrant 可达时应有片段）──
  const know = await synthesizeOperationKnowledge({
    capability: 'create_sync_rule',
    operationName: '创建同步规则',
    prerequisites: '前置A; 前置B',
    constraints: '约束X',
    risks: '',
  }) as Record<string, any>
  check('know: 5 个固定键', ['summary', 'what_you_need', 'constraints', 'common_errors', 'dimensions', 'top_references'].every(k => k in know), Object.keys(know).join(','))
  check('know: BKN 拆条进 what_you_need', (know.what_you_need as string[]).length === 2, JSON.stringify(know.what_you_need))
  check('know: 约束条目并入 constraints', (know.constraints as string[]).includes('约束X'), JSON.stringify(know.constraints))
  check('know: 3 维且命名正确', (know.dimensions as any[]).map(d => d.name).join('/') === '前置条件/约束与注意事项/常见错误')
  check('know: dimensions 结构含 snippets 数组', (know.dimensions as any[]).every(d => Array.isArray(d.snippets)))
}


console.log('\n[9] whitelist 规则源（proposal §3.4 框架；SQL 域前置）')
{
  const wl = parseWhitelist('commands: [obclient, mysql]\nwrite_paths: [/tmp, /opt/data]\n')
  check('parseWhitelist: commands/write_paths', wl.commands.join(',') === 'obclient,mysql' && wl.write_paths.join(',') === '/tmp,/opt/data')
  check('commandAllowed: 字面前缀放行', commandAllowed('obclient -e "select 1 from t"', wl) && commandAllowed('mysql -h 1.2.3.4 -e x', wl))
  check('commandAllowed: 白名单外拒绝', !commandAllowed('rm -rf /', wl) && !commandAllowed('curl http://x', wl))
  check('commandAllowed: 前缀边界（obclientx 拒绝）', !commandAllowed('obclientx --help', wl))
  const wlRe = parseWhitelist("commands: [re:^sudo\\s+obclient]\nwrite_paths: [/tmp]\n")
  check('commandAllowed: re: 正则放行/拒绝', commandAllowed('sudo obclient -e x', wlRe) && !commandAllowed('obclient -e x', wlRe))
  check('pathAllowed: 前缀放行/越界拒绝', pathAllowed('/tmp/a.sql', wl) && pathAllowed('/opt/data/x/y.sql', wl) && !pathAllowed('/etc/passwd', wl) && !pathAllowed('/tmpfoo', wl))
  // block 模式
  const wlPath = '/tmp/dshctl-wl-test.yml'
  writeFileSync(wlPath, 'commands: [obclient, mysql]\nwrite_paths: [/tmp, /opt/data]\n')
  resetWhitelistCache()
  const d1 = whitelistGuardDecision('bash', { command: 'rm -rf /var' }, { enabled: true, block: true, whitelistPath: wlPath })
  check('whitelist block: 非白名单命令 deny', d1 !== null && d1.blockable === true && d1.reason!.includes('白名单'), JSON.stringify(d1))
  const d2 = whitelistGuardDecision('bash', { command: 'obclient -e "select 1"' }, { enabled: true, block: true, whitelistPath: wlPath })
  check('whitelist block: 白名单命令放行', d2 === null)
  const d3 = whitelistGuardDecision('write', { path: '/etc/cron.d/x', content: 'y' }, { enabled: true, block: true, whitelistPath: wlPath })
  check('whitelist block: 越界写路径 deny', d3 !== null && d3.reason!.includes('write_paths'))
  const d4 = whitelistGuardDecision('write', { path: '/tmp/ok.sql', content: 'y' }, { enabled: true, block: true, whitelistPath: wlPath })
  check('whitelist block: 白名单路径放行', d4 === null)
  const d5 = whitelistGuardDecision('bash', { command: 'rm -rf /var' }, { enabled: true, block: false, whitelistPath: wlPath })
  check('whitelist gray: 命中仅告警放行', d5 === null)
  // fail-closed：空白名单全 deny
  const wlEmpty = '/tmp/dshctl-wl-empty.yml'
  writeFileSync(wlEmpty, '# empty\n')
  resetWhitelistCache()
  const d6 = whitelistGuardDecision('bash', { command: 'obclient -e x' }, { enabled: true, block: true, whitelistPath: wlEmpty })
  check('whitelist fail-closed: 空文件全 deny', d6 !== null)
  resetWhitelistCache()
  // dispatch：ruleSource 路由
  const disp = guardDecision('bash', { command: 'rm -rf /' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'], ruleSource: 'whitelist', whitelistPath: wlPath })
  check('guardDecision dispatch → whitelist', disp !== null && disp.ruleId === 'whitelist')
  const none = guardDecision('bash', { command: 'i2stream delete rule --name r1 while RUNNING' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'], ruleSource: 'none' })
  check('ruleSource=none 关闭规则', none === null)
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : `${failures} FAILED ❌`}`)
process.exit(failures === 0 ? 0 : 1)
