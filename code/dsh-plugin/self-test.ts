/**
 * self-test.ts — DSH 版 BKN 插件的独立自测（不依赖运行实例）
 *
 * 运行方式（必须在 checkout 根目录，让 tsx 生效）：
 *   cd /hdd/agent/deepseek-harness
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BKNResolver, bknWalkIssues } from './resolver.ts'
import { validateBknContract, handleContractResult, CONTRACT_MIN_GENERATION } from './bknContract.ts'
import { DIAG_EVIDENCE_COLLECTION, DIAG_RETRIEVAL_GUIDE, PROCESS_IDS } from './constants.ts'
import { classifyCode } from './codeOrigin.ts'
import { RelationTraverser } from './relations.ts'
import { ContextLoader, ToonFormatter, TrimFilter } from './contextLoader.ts'
import {
  checkActionRisk,
  getRiskRules,
  guardDecision,
  identifyHit,
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
  configureRetrieval,
  extractExactTerms,
  getDimensionCoverage,
  getPointsCount,
  isValidContent,
  payloadContent,
  refreshBm25IfStale,
  resetBm25,
  resetDimensionCoverage,
  RETRIEVAL,
  trackDimension,
} from './retrieval.ts'
import { DIAGNOSE_DIMENSIONS, extractBknContext, resolveDbType, extractErrorCodes, splitBknText, synthesizeOperationKnowledge } from './tools.ts'
import {
  assessConfidence,
  buildDimensionHints,
  buildQuery,
  buildSearchInstruction,
  configureGapLog,
  extractGapKeywords,
  extractSkillFromResult,
  getDimensionPriority,
  logGap,
  rotateIfNeeded,
  SUPPLEMENT,
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

  // ── 2026-11-06 批次 A：对齐 i2stream-bkn（BUG-0009 码义兜底 + 进程实体补缺 + 导航层口径）──
  const rk4073 = resolver.getRisk('-4073')
  const m4073 = (rk4073?.meaning ?? {}) as { rule?: string; exact_meaning?: string; semantic_rule?: string }
  check('BUG-0009 B：未登记产品码走码义兜底（code_row_exact + 码表中文义）',
    rk4073?.meaning_source === 'qdrant_code_row' && m4073.rule === 'code_row_exact' && Boolean(m4073.exact_meaning),
    JSON.stringify({ src: rk4073?.meaning_source, rule: m4073.rule, exact: m4073.exact_meaning }))
  check('BUG-0009 B：码形机械归一（4217 → -4217 命中同一条码义）',
    resolver.getRisk('4217')?.meaning?.exact_code === '-4217',
    JSON.stringify(resolver.getRisk('4217')?.meaning ?? {}))
  check('BUG-0009 B：非产品码不触发兜底（ORA-01555 维持官方含义路径）',
    resolver.getRisk('ORA1555')?.meaning_source === 'code',
    String(resolver.getRisk('ORA1555')?.meaning_source))
  check('BUG-0009 B：未登记且码表无此码 → 静默维持 unknown',
    resolver.getRisk('-9999')?.meaning_source === 'code' &&
      (resolver.getRisk('-9999')?.dimensions ?? []).includes('dimension:unknown'),
    JSON.stringify(resolver.getRisk('-9999')?.dimensions ?? []))
  check('BUG-0009 A：Agent 指引改主库优先（主集合 → 模式库）',
    DIAG_RETRIEVAL_GUIDE.startsWith('store:i2stream_collection#错误码 → store:log_patterns_collection#错误码'),
    DIAG_RETRIEVAL_GUIDE)
  check('BUG-0009 A：内部兜底常量与 Agent 指引解耦',
    DIAG_EVIDENCE_COLLECTION === 'store:log_patterns_collection#错误码' && DIAG_EVIDENCE_COLLECTION !== DIAG_RETRIEVAL_GUIDE,
    DIAG_EVIDENCE_COLLECTION)
  check('进程实体补缺：PROCESS_IDS 10 个且三个新进程对象可解析',
    PROCESS_IDS.length === 10 &&
      ['iamss', 'pgtrack', 'pgreplicator'].every((p) => Object.keys(resolver.getProcessAttrs('process:' + p)).length > 0),
    'count=' + PROCESS_IDS.length)
  const arch = resolver.queryArchitecture('all')
  const archText = JSON.stringify(arch)
  check('架构输出收录新进程（本体派生，非硬编码清单）',
    archText.includes('process:iamss') && archText.includes('process:pgtrack') && archText.includes('process:pgreplicator'),
    'procs=' + String((arch as { processes?: unknown[] }).processes?.length ?? 'n/a'))
  // ── 批次 A5（code_origin 码来源提示，对齐 BUG-0009 导航）──
  const o1 = classifyCode(BKN_ROOT, 'ORA-04031')
  check('A5 code_origin：ORA 前缀 → origin=oracle（数据库原生码，规则命中）',
    o1.origin === 'oracle' && !o1.ambiguous, JSON.stringify(o1))
  const o2 = classifyCode(BKN_ROOT, '1062')
  check('A5 code_origin：裸数字 4-5 位 → ambiguous（需 message/db_type 才能落定）',
    o2.origin === 'ambiguous' && o2.ambiguous, JSON.stringify(o2))
  const o3 = classifyCode(BKN_ROOT, '-4002')
  check('A5 code_origin：产品码命中 error_codes.yaml → origin=product',
    o3.origin === 'product', JSON.stringify(o3))
  const o4 = classifyCode(BKN_ROOT, 'FOOBAR9')
  check('A5 code_origin：未知 → origin=unknown + hint（不解释含义，H-15 静默）',
    o4.origin === 'unknown' && Boolean(o4.hint), JSON.stringify(o4))
  const rk9999 = resolver.getRisk('-9999')
  const needs9999 = (rk9999?.needs ?? []) as string[]
  check('A5 集成：unknown 分支附 code_origin 歧义提示（needs 含来源形状，解析不抛）',
    needs9999.some((n) => n.includes('无法单凭码形断言来源')), JSON.stringify(needs9999))
}

console.log('\n[3] riskGuard.ts 规则与决策')
{
  const rules = loadRules(BKN_ROOT)
  const ids = Object.keys(rules)
  check('解析到 risk 规则（含兜底）', ids.length >= 3, JSON.stringify(ids))

  const parsed = getRiskRules(BKN_ROOT)
  // 2026-10-21 对齐：BKN 数据（10-12~15 编辑）移除 constraints 错误码标注——语义迁 plugin/error_semantics.yaml；
  // 规则仍命中 action/state，errorCode 为空是预期（非 blockable，advisory 口径）。若 BKN 恢复错误码需反向同步。
  const stateRules = Object.entries(parsed).filter(([, r]) => (r as { riskType?: string }).riskType === 'state_prerequisite')
  check('constraints.bkn 的 state_prerequisite 规则解析（错误码列已移除 ⇒ errorCode 空为预期）',
    stateRules.length > 0 && stateRules.every(([, r]) => !r.errorCode),
    JSON.stringify(stateRules.slice(0, 3).map(([id, r]) => [id, r.action, [...r.forbiddenStates], r.errorCode])))

  const blocked = checkActionRisk('delete_sync_rule', 'RUNNING', BKN_ROOT)
  check('delete_sync_rule@RUNNING 命中且 advisory（错误码移除 ⇒ 非 blockable，Stage B 口径）',
    blocked.passed === false && blocked.errorCode === '' && blocked.blockable === false, JSON.stringify(blocked))

  const allowed = checkActionRisk('start_sync_rule', 'STOPPED', BKN_ROOT)
  check('start_sync_rule@STOPPED 放行', allowed.passed === true, JSON.stringify(allowed))

  check('normalizeAction(delete_rule) → delete_sync_rule', normalizeAction('delete_rule') === 'delete_sync_rule')

  const g1 = guardDecision('bash', { command: 'i2stream delete rule --name r1 while RUNNING' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  // advisory 放行（命中规则无错误码 ⇒ 非 blockable；guardDecision 返回 null 但控制台记 warn）
  check('bash 命中 delete+RUNNING → advisory 放行（非 blockable 不拦）', g1 === null, JSON.stringify(g1))

  const g2 = guardDecision('bash', { command: 'ls -la /tmp' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('无害命令放行', g2 === null, JSON.stringify(g2))

  const g3 = guardDecision('write', { content: 'hello' }, { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('write 不在 mutatingTools 时放行', g3 === null, JSON.stringify(g3))

  // identifyHit 单源一致性（2026-11-05 加固）：guardDecision 与放行侧广播共用识别实现
  const h1 = identifyHit('bash', { command: 'i2stream delete rule --name r1 while RUNNING' }, ['bash'])
  check('identifyHit：命令文本识别 delete_rule + RUNNING', h1?.action === 'delete_sync_rule' && h1?.state === 'RUNNING', JSON.stringify(h1))
  const h2 = identifyHit('mcp-act', { operation: 'failover', state: 'ABNORMAL' }, [])
  check('identifyHit：显式参数路径（非 mutating 工具）', h2?.action === 'failover' && h2?.state === 'ABNORMAL', JSON.stringify(h2))
  // C-3（2026-11-09）：拆坍成恒真的旧断言 → 两个独立真断言（identifyHit 与 guardDecision 各自主张，互相对照）
  check('identifyHit：delete+RUNNING 识别命中（单源识别为 guardDecision 提供同一输入）',
    h1 !== null, JSON.stringify(h1))
  check('guardDecision：同一命中 blockable=false → 按 advisory 放行返回 null（非无害路径 g2/g3 的 null）',
    g1 === null && h1 !== null && g2 === null && g3 === null, 'g1=' + JSON.stringify(g1) + ' g2=' + JSON.stringify(g2))
  const h3 = identifyHit('bash', { command: 'ls -la /tmp' }, ['bash'])
  check('identifyHit：无害命令 → null', h3 === null, JSON.stringify(h3))
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
  // 23 号方案：compatibility.bkn 值数据下延 Skill references，本体只回委托指针
  check('按库特殊约束改值委托指针（risks 含 compatibility.md 指针）',
    compatRisks.length > 0 && compatRisks.some((r) => String(r).includes('references/compatibility.md')), JSON.stringify(compatRisks.slice(0, 2)))

  // 库特化前置提取
  const prereqSec = resolver.getPrerequisites('create_rule')
  check('getPrerequisites(create_rule) 命中', prereqSec !== null, prereqSec?.raw.slice(0, 50) ?? 'null')
  const dbSpec = BKNResolver.extractDbSpecificPrerequisites(
    'Oracle: 归档日志已开启\nPG: wal_level=logical\n通用: 网络连通', 'PostgreSQL')
  check('库特化提取: PG→PostgreSQL 别名命中', dbSpec.length === 1 && dbSpec[0] === 'wal_level=logical', JSON.stringify(dbSpec))

  // blockable（Stage B 门控口径）。2026-10-21 对齐：BKN 数据移除错误码标注 ⇒ 全部规则
  // errorCode='' ⇒ 非 blockable（advisory）；拦截面收窄是数据侧决定，语义迁 error_semantics.yaml。
  // 若 BKN 恢复错误码标注，本组断言需反向同步回 blockable=true。
  const allRules = getRiskRules(BKN_ROOT)
  const codeBearing = Object.entries(allRules).filter(([, r]) => r.errorCode)
  check('规则集不含错误码（数据终态：语义已迁 error_semantics.yaml）', codeBearing.length === 0, JSON.stringify(codeBearing.map(([id]) => id)))
  const blockedChk = checkActionRisk(DEL, RUN, BKN_ROOT)
  check('命中规则 blockable=false（advisory）', blockedChk.passed === false && blockedChk.blockable === false, JSON.stringify(blockedChk))
  const gCmd = `i2stream ${DEL.split('_').join(' ')} --name r1 while ${RUN}`
  const gray = guardDecision('bash', { command: gCmd },
    { enabled: true, block: false, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('gray 模式（block=false）放行', gray === null, JSON.stringify(gray))
  const gBlock = guardDecision('bash', { command: gCmd },
    { enabled: true, block: true, bknRoot: BKN_ROOT, mutatingTools: ['bash'] })
  check('block 模式 + 非 blockable 规则 → advisory 放行', gBlock === null, JSON.stringify(gBlock))

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
  check('getLogMap 进程职责', Object.keys((nav.process_duties as object) ?? {}).length > 0)
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

  // extractBknContext（62/63 号链路：码 → 官方含义/语义规则 → dimension → diagnosed_by/observed_in）
  const ctx1 = extractBknContext(resolver, '-4002')
  check('extractBknContext -4002 风险上下文（官方含义 → dimension:log_readable + 别名 + needs）',
    ctx1 !== null && ctx1.error_code === '-4002'
    && (ctx1.dimensions as string[]).includes('dimension:log_readable')
    && (ctx1.aliases as string[]).includes('REDO位点异常')
    && Array.isArray(ctx1.needs),
    JSON.stringify(ctx1).slice(0, 200))
  check('extractBknContext 无码', extractBknContext(resolver, undefined) === null)

  // ── 62/63 号链路（errorSemantics.ts；py resolver.get_risk 1:1）──
  const risk4002 = resolver.getRisk('-4002')
  check('getRisk(-4002) 裸码走官方含义（status=统一 ⇒ dimension:log_readable + diagnosed_by Skill）',
    risk4002 !== null && risk4002.meaning_source === 'code' && risk4002.meaning?.rule === 'log_readable'
    && (risk4002.dimensions ?? []).includes('dimension:log_readable')
    && (risk4002.diagnosed_skills ?? []).includes('skill:i2stream-db-diagnostics'),
    JSON.stringify(risk4002?.meaning) + ' | skills=' + JSON.stringify(risk4002?.diagnosed_skills))
  const riskMsg = resolver.getRisk('', '归档日志被清理，位点不连续')
  check('getRisk(message) 现场文本命中 log_readable（meaning_source=message）',
    riskMsg !== null && riskMsg.meaning_source === 'message' && riskMsg.meaning?.rule === 'log_readable'
    && (riskMsg.meaning?.evidence ?? '').includes('命中关键词'),
    JSON.stringify(riskMsg?.meaning))
  const risk4071 = resolver.getRisk('-4071')
  check('getRisk(-4071) 官方含义 → state_machine（match_official 词表）',
    risk4071 !== null && (risk4071.dimensions ?? []).includes('dimension:state_machine'),
    JSON.stringify(risk4071?.meaning) + ' | conflicts=' + JSON.stringify(risk4071?.conflicts))
  const riskLog = resolver.getRisk('-4002', '', 'iatrack')
  check('getRisk(log_source) 嫌疑进程直接取来源进程（未给则不猜）',
    riskLog !== null && (riskLog.suspected_process ?? []).includes('process:iatrack')
    && (risk4002?.suspected_process ?? []).length === 0,
    JSON.stringify(riskLog?.suspected_process))
  const skillViaChain = resolver.getSymptomSkills('-4002')
  check('getSymptomSkills(错误码) 62/63 号链路回退到 diagnosed_by Skill',
    skillViaChain.required.length > 0 && skillViaChain.required.some((s) => s.name === 'i2stream-db-diagnostics'),
    JSON.stringify(skillViaChain.required))
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
  // 边目标带命名空间前缀（risk:）是有意设计——图节点 ID 空间与裸错误码不同。
  // 2026-10-21 对齐：error: 前缀边已退出本体（码只作入口，语义迁 error_semantics.yaml），
  // risks_of 只承载 risk: 风险节点。
  check('edges: risks_of 解析（start → risk:fullsync_stuck）', (edges.risks['start_sync_rule'] ?? []).includes('risk:fullsync_stuck'), JSON.stringify(edges.risks['start_sync_rule']))
  check('edges: risks_of 不含 error: 边（数据终态）', !(edges.risks['start_sync_rule'] ?? []).some((t) => t.startsWith('error:')), JSON.stringify(edges.risks['start_sync_rule']))

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
  check('join: worknode_must_be_ONLINE 非 blockable（-4016 错误码标注已移除）', rules['worknode_must_be_ONLINE']?.blockable === false, JSON.stringify(rules['worknode_must_be_ONLINE']))
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

console.log('\n[10] v26 契约校验：世代/目录/关键文件/区块 + strict/warn/off 处置')
{
  const { mkdirSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const fixture = (): string => mkdtempSync(join(tmpdir(), 'dshp-contract-'))

  const mk = (root: string, over: { generation?: number; omit?: string; blankKey?: string; noGen?: boolean } = {}): string => {
    const gen = over.generation ?? 26
    for (const d of ['objects', 'relations', 'actions', 'risks']) mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'SCHEMA.md'), over.noGen
      ? '# BKN 类型枚举标准（SCHEMA）\n\n本体分层重构后世代标记可不在首部（2026-10-21 软化口径）\n'
      : `# BKN 类型枚举标准（SCHEMA）\n\n> 2026-09-24（${gen} 号四元收敛终态）\n`)
    writeFileSync(join(root, 'SKILL.md'), '# 导航\n')
    for (const d of ['objects', 'relations', 'actions', 'risks']) writeFileSync(join(root, d, 'x.bkn'), '## X\n')
    const req: Array<[string, string]> = [
      ['objects/product.bkn', '## 产品定位\n'],
      ['objects/syncrule.bkn', over.blankKey === '状态机' ? '（区块被抹）\n' : '## 状态机\n'],
      ['relations/action_routing.bkn', 'constrained_by / risks_of\n'],
      ['relations/process_topology.bkn', 'suspected_in\n'],
      ['risks/constraints.bkn', '| Risk | 约束ID | 类型 | 约束 |\n'],
      ['risks/prerequisites.bkn', '## 状态前置\n'],
    ]
    for (const [rel, body] of req) { if (over.omit === rel) continue; writeFileSync(join(root, rel), body) }
    return root
  }
  const good = mk(join(fixture(), 'bkn'))
  const r1 = validateBknContract(good)
  check('契约：合格副本通过且世代=26', r1.ok && r1.generation === 26, JSON.stringify(r1.issues))
  check('契约：不存在的根目录拒绝', !validateBknContract(join(good, 'nope')).ok)
  check('契约：世代号 25（旧版）拒绝且点名', (() => { const r = validateBknContract(mk(join(fixture(), 'bkn'), { generation: 25 })); return !r.ok && r.issues.some((i) => i.includes('世代号 25')) })())
  // 2026-10-21 软化：世代标记缺省不拒载（结构校验是硬契约）；有标记仍 ≥26 把关
  check('契约：无世代标记 → 结构通过且 generation=null', (() => { const r = validateBknContract(mk(join(fixture(), 'bkn'), { noGen: true })); return r.ok && r.generation === null })())
  check('契约：缺关键文件点名', (() => { const r = validateBknContract(mk(join(fixture(), 'bkn'), { omit: 'risks/prerequisites.bkn' })); return !r.ok && r.issues.some((i) => i.includes('risks/prerequisites.bkn')) })())
  check('契约：关键区块被抹点名（syncrule 状态机）', (() => { const r = validateBknContract(mk(join(fixture(), 'bkn'), { blankKey: '状态机' })); return !r.ok && r.issues.some((i) => i.includes('状态机')) })())
  // 2026-10-21：bkn-version.json 发布清单锚（BKN 去装饰收敛跟随）——清单存在即世代满足 MIN + 哈希校验
  check('契约：清单锚存在 → generation 视为满足 MIN', (() => {
    const root = mk(join(fixture(), 'bkn'), { noGen: true })
    const h = createHash('sha256').update(readFileSync(join(root, 'SCHEMA.md'))).digest('hex')
    writeFileSync(join(root, '..', 'bkn-version.json'), JSON.stringify({ version_id: 'bkn-20261015-2', files: { 'bkn/SCHEMA.md': h } }))
    const r = validateBknContract(root)
    return r.ok && r.generation === CONTRACT_MIN_GENERATION
  })())
  check('契约：清单文件被篡改 → 哈希不匹配点名', (() => {
    const root = mk(join(fixture(), 'bkn'), { noGen: true })
    writeFileSync(join(root, '..', 'bkn-version.json'), JSON.stringify({ version_id: 'x', files: { 'bkn/SCHEMA.md': 'deadbeef' } }))
    const r = validateBknContract(root)
    return !r.ok && r.issues.some((i) => i.includes('哈希不匹配'))
  })())

  const logs: string[] = []
  const logger = { info: (m: string) => { logs.push('I:' + m) }, error: (m: string) => { logs.push('E:' + m) } }
  const bad = { ok: false, generation: 25, issues: ['示例问题'] }
  check('契约：strict → fatal + 日志 error', handleContractResult(bad, 'strict', logger).fatal === true && logs.some((l) => l.startsWith('E:')))
  check('契约：warn → 非 fatal 但日志 error', handleContractResult(bad, 'warn', logger).fatal === false && logs.filter((l) => l.startsWith('E:')).length >= 2)
  const logsBefore = logs.length
  check('契约：off → 不校验不记日志', handleContractResult(bad, 'off', logger).fatal === false && logs.length === logsBefore)
  check('契约：合格 → info 通过语', handleContractResult({ ok: true, generation: 26, issues: [] }, 'strict', logger).fatal === false && logs.some((l) => l.includes('契约校验通过')))
  check('契约：读取台账 API 在位（loadMisses/bknWalkIssues 非静默化）', Array.isArray(new BKNResolver('/hdd/demo/public/i2stream-bkn/bkn').loadMisses) && Array.isArray(bknWalkIssues))
}

console.log('\n[11] 外部依赖配置化：config > env > 常量 + 运行期注入')
{
  const pluginDir = '/hdd/demo/public/dsh-info/code/dsh-plugin'
  const { resolveExternalDeps, EXTERNAL_DEFAULTS } = await import('./index.ts')
  // 解析链三级
  const d1 = resolveExternalDeps({ qdrantUrl: 'http://cfg:6333' }, pluginDir, { I2STREAM_QDRANT_URL: 'http://env:6333', I2STREAM_BKN_ROOT: '/env/bkn' })
  check('解析链：config 覆盖 env', d1.qdrantUrl === 'http://cfg:6333')
  const d2 = resolveExternalDeps({}, pluginDir, { I2STREAM_QDRANT_URL: 'http://env:6333', I2STREAM_BKN_ROOT: '/env/bkn' })
  check('解析链：env 覆盖常量', d2.qdrantUrl === 'http://env:6333' && d2.bknRoot === '/env/bkn')
  const d3 = resolveExternalDeps({}, pluginDir, {})
  check('解析链：常量兜底（与 AGENTS §9 端口同值）',
    d3.qdrantUrl === EXTERNAL_DEFAULTS.qdrantUrl && d3.embedUrl === EXTERNAL_DEFAULTS.embedUrl
    && d3.qdrantCollection === EXTERNAL_DEFAULTS.qdrantCollection && d3.bknRoot === '/hdd/demo/public/i2stream-bkn/bkn',
    JSON.stringify(d3))
  check('路径型相对包根派生（whitelist 默认去硬编码）',
    d3.gapLogPath === EXTERNAL_DEFAULTS.gapLogPath && d3.whitelistPath === '/hdd/demo/public/dsh-info/code/guard-rule-sources/whitelist.yml', d3.whitelistPath)
  check('相对 bknRoot（pack 快照模式）按包根解析', resolveExternalDeps({ bknRoot: 'bkn' }, pluginDir, {}).bknRoot === pluginDir + '/bkn')
  check('skillManifestPath 缺省留空（由 resolver 按 bknRoot 派生）', d3.skillManifestPath === '')

  // 运行期注入（未注入时行为 = 模块加载期 env/常量）
  const beforeQ = RETRIEVAL.qdrantUrl, beforeC = RETRIEVAL.collection, beforeE = RETRIEVAL.embedUrl
  const beforeGap = SUPPLEMENT.gapLogPath
  configureRetrieval({ qdrantUrl: 'http://inj:6333', collection: 'inj_col' })
  check('configureRetrieval：注入生效', RETRIEVAL.qdrantUrl === 'http://inj:6333' && RETRIEVAL.collection === 'inj_col')
  check('configureRetrieval：未传字段保持原值', RETRIEVAL.embedUrl === beforeE)
  configureRetrieval({ qdrantUrl: beforeQ, collection: beforeC })
  check('configureRetrieval：还原生效', RETRIEVAL.qdrantUrl === beforeQ && RETRIEVAL.collection === beforeC)
  configureGapLog('/tmp/gap-inj.jsonl')
  check('configureGapLog：注入生效', SUPPLEMENT.gapLogPath === '/tmp/gap-inj.jsonl')
  configureGapLog(beforeGap)
  check('configureGapLog：还原生效', SUPPLEMENT.gapLogPath === beforeGap)

  // manifest 路径透传（BKNResolver 第二参）
  const BKN_ROOT_11 = '/hdd/demo/public/i2stream-bkn/bkn'
  check('BKNResolver：显式 manifestPath 透传', new BKNResolver(BKN_ROOT_11, '/tmp/x-manifest.yaml').manifestPath === '/tmp/x-manifest.yaml')
  check('BKNResolver：缺省按 bknRoot 派生', new BKNResolver(BKN_ROOT_11).manifestPath === '/hdd/demo/public/i2stream-bkn/plugin/skill_manifest.yaml')

  // BM25 刷新（审计报告 Top1）：失败缓存可重试 + refreshBm25IfStale 降级语义
  const fresh = await getPointsCount('http-nonexistent-collection-xyz')
  check('getPointsCount：Qdrant 不可达 → null 不抛（H-15）', fresh === null)
  // refresh 对未构建过的 collection 是 no-op
  check('refreshBm25IfStale：未构建 collection → false（无操作）', await refreshBm25IfStale('never-built-col') === false)
  // 失败缓存可重试语义：resetBm25 后 bm25Ready 清空，下次调用重建（此为 refresh 失效路径的核心不变式）
  const { bm25Search } = await import('./retrieval.ts')
  resetBm25('retry-col')
  // 无法在此连真 Qdrant；改验证"reset 后不再命中 ready 集"的可重试不变式——通过再次 refresh 返回 false（未构建）确认
  check('BM25 可重试不变式：reset 后未构建即懒加载（refresh no-op）', await refreshBm25IfStale('retry-col') === false)

  // hotpath 防漂移（审计报告 Top3）：preset 触达行必须在生成产物里，丢失即断言失败
  const { existsSync, readFileSync: rf } = await import('node:fs')
  const hpPath = '/hdd/demo/public/dsh-info/code/presets/i2stream-ops/hotpath.md'
  check('hotpath 防漂移：产物存在', existsSync(hpPath))
  if (existsSync(hpPath)) {
    const hp = rf(hpPath, 'utf8')
    check('hotpath 防漂移：含 capture_correction 触达行', hp.includes('capture_correction'), hp.slice(-200))
    check('hotpath 防漂移：高频操作段非空', hp.includes('【高频操作 → Skill 绑定】') && hp.includes('→ Skill:'))
  }
}

console.log('\n[12] check_plan（批次 C1，对齐 plugin/plan_check.py）')
{
  const { checkPlan } = await import('./planCheck.ts')
  const v = checkPlan(BKN_ROOT, { steps: [{ action: 'compare_table', state: 'RUNNING' }], states: {} })
  check('check_plan：首前置取 step.state 命中（rule must be RUNNING）',
    v.ok === true && v.violations.length === 0, JSON.stringify(v))
  const v2 = checkPlan(BKN_ROOT, { steps: [{ action: 'create_compare', state: 'STOPPED' }], states: {} })
  check('check_plan：RUNNING 前置违例 → violation + ok=false',
    !v2.ok && v2.violations.length >= 1 && String(v2.violations[0].message).includes('rule'),
    JSON.stringify(v2.violations))
  const v3 = checkPlan(BKN_ROOT, { steps: [{ action: 'start_sync_rule', state: 'STOPPED' }], states: {} })
  check('check_plan：启动动作约束 → advisory（rule_must_be_STOPPED 在位）',
    v3.ok && v3.advisories.some((a) => a.constraint === 'rule_must_be_STOPPED'),
    JSON.stringify(v3.advisories))
  const v4 = checkPlan(BKN_ROOT, { steps: [{ action: 'not_a_real_action' }], states: {} })
  check('check_plan：未登记动作 → todo（需人工确认）',
    v4.ok && v4.todo.some((t) => String(t.why).includes('未在本体登记')), JSON.stringify(v4.todo))
  const v5 = checkPlan(BKN_ROOT, { steps: [{ action: 'create_compare' }], states: { rule: 'RUNNING', target: 'accessible' } })
  // source 未给状态但首前置(rule)已命中 → source 进 todo；两前置均已满足 → 无 violation
  check('check_plan：states 补齐后无违例（未给 source 进 todo）',
    v5.ok && v5.violations.length === 0, JSON.stringify({ v: v5.violations, t: v5.todo }))
}

console.log('\n[13] diagnose_mechanism（批次 C2，对齐 tools.py + mechanisms.yaml）')
{
  const { diagnoseMechanism } = await import('./mechanism.ts')
  const deps = {
    bknRoot: BKN_ROOT,
    resolver: {
      resolveSynonym: (s: string) => resolver.resolveSynonym(s),
      normalizeErrorCode: (s: string) => BKNResolver.normalizeErrorCode(s),
      getRisk: (c: string, m?: string, l?: string) => resolver.getRisk(c, m ?? '', l ?? ''),
    },
    traverser,
  }
  const cOf = (r: Record<string, unknown>) => (r.candidates as Array<{ id: string }>).map((x) => x.id)
  const stOf = (r: Record<string, unknown>, id: string) => (r.candidates as Array<{ id: string; state: string }>).find((x) => x.id === id)?.state
  const r1 = diagnoseMechanism(deps as { resolver: never }, { entry: 'dimension:state_machine' } as never)
  check('mechanism：候选经 manifests_as 收窄含 control_plane_desync/single_point_fail_stop',
    cOf(r1).includes('control_plane_desync') && cOf(r1).includes('single_point_fail_stop'), JSON.stringify(cOf(r1)))
  const r2 = diagnoseMechanism(deps as { resolver: never }, { entry: 'symptom:incremental_stuck' } as never)
  check('mechanism：symptom 收窄 → control_plane_desync',
    cOf(r2).includes('control_plane_desync'), JSON.stringify(cOf(r2)))
  const r3 = diagnoseMechanism(deps as { resolver: never }, { entry: 'control_plane_desync', observations: ['[iatrack] SvcManager service [track:1042] online, but process not found'] } as never)
  check('mechanism：仅软证据命中 → 只能到 unknown（hard_cap）',
    stOf(r3, 'control_plane_desync') === 'unknown', String(stOf(r3, 'control_plane_desync')))
  const r4 = diagnoseMechanism(deps as { resolver: never }, { entry: 'control_plane_desync', observations: ['[iatrack] jps：iatrack 进程存在，规则同步正常', '[console] 控制面与数据面一致'] } as never)
  check('mechanism：counter_patterns 全中 → excluded（留档不静默丢弃）',
    stOf(r4, 'control_plane_desync') === 'excluded', String(stOf(r4, 'control_plane_desync')))
  const r5 = diagnoseMechanism(deps as { resolver: never }, { entry: 'symptom:incremental_stuck' } as never)
  check('mechanism：无观测 → gaps 含"未提供任何观测"（unknown 合法答案）',
    (r5.evidence_gaps as string[]).some((g) => g.includes('未提供任何观测')), JSON.stringify(r5.evidence_gaps))
  const chk = (r: Record<string, unknown>) => (r.structural_evidence as Array<{ checkable: string }>).map((s) => s.checkable)
  const r6 = diagnoseMechanism(deps as { resolver: never }, { entry: 'process:iatrack', affected_unit: 'syncrule' } as never)
  check('mechanism：给了 affected_unit → 结构判据 checkable=full',
    chk(r6).length > 0 && chk(r6).every((c) => c === 'full'), JSON.stringify(chk(r6)))
  const r7 = diagnoseMechanism(deps as { resolver: never }, { entry: 'process:iatrack' } as never)
  check('mechanism：缺 affected_unit → 结构判据 checkable=partial（两单元半步须人给端点）',
    chk(r7).length > 0 && chk(r7).every((c) => c === 'partial'), JSON.stringify(chk(r7)))
  // ── 批次 D2（P6 混合输入）：堆栈输入给明确指引而非「未识别」──
  const stk = 'Exception in thread "main" java.lang.NoSuchMethodError\n  at com.i2stream.dumper.DumperMain.start(DumperMain.java:88)'
  const rkStack = resolver.getRisk('', stk)
  check('D2：堆栈输入 → needs 含 stack-analysis 堆栈指引（非裸"未识别"）',
    (rkStack?.needs ?? []).some((n) => String(n).includes('i2stream-stack-analysis')), JSON.stringify(rkStack?.needs))
  const rkNormal = resolver.getRisk('-4073')
  check('D2：普通错误码不加堆栈指引（只对堆栈特征生效）',
    !(rkNormal?.needs ?? []).some((n) => String(n).includes('i2stream-stack-analysis')))
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : `${failures} FAILED ❌`}`)
process.exit(failures === 0 ? 0 : 1)
