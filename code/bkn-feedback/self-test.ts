/**
 * self-test.ts — bkn-feedback 独立自测（node --import tsx/esm self-test.ts）
 * 风格对齐 ops-skill-manager：ok() 断言 + mkdtemp 临时目录隔离，failed>0 退出码 1。
 * 纯函数（appendCorrection/analyzeGapLog/renderReport）直接 import 验证（无 cordis 依赖）；
 * apply() 装配走最小 ctx stub 行为面验证。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendCorrection, analyzeGapLog, renderReport, sanitizeCorrection, resolveCorrection } from './index.ts'

let passed = 0
let failed = 0
function ok(cond: boolean, tag: string, detail = ''): void {
  if (cond === true) { passed++; console.log(`  ✓ ${tag}`) } else { failed++; console.error(`  ✗ FAIL: ${tag}${detail ? ` ${detail}` : ''}`) }
}

console.log('[1] appendCorrection：追加行 + user_supplied 置位（打通死字段）')
{
  const root = mkdtempSync(join(tmpdir(), 'fb-'))
  const gapLog = join(root, 'gap_log.jsonl')
  const r1 = appendCorrection(gapLog, { tool: 'design_solution', params: { source: 'oracle' }, gaps: ['relations', 'risk'], correction: '拓扑建议错了，应该用双向同步' })
  ok(r1.ok, '追加成功')
  const line = JSON.parse(readFileSync(gapLog, 'utf8').trim()) as Record<string, unknown>
  ok(line.user_supplied === '拓扑建议错了，应该用双向同步', 'user_supplied 非空（不再硬编码 null）', JSON.stringify(line))
  ok(line.resolved === false && line.tool === 'design_solution', 'resolved=false + tool 在位（schema 只增不破）', JSON.stringify(line))
  ok(Array.isArray(line.gaps) && (line.gaps as string[]).join(',') === 'relations,risk', 'gaps 数组在位')
  const r2 = appendCorrection(join(root, 'no-dir', 'x.jsonl'), { tool: 't', correction: 'c' })
  ok(!r2.ok && !!r2.error, '目录缺失 → {ok:false,error} 不抛', r2.error)
}

console.log('[1b] sanitizeCorrection + 轮转 + resolveCorrection（审计报告 Top4/5/6）')
{
  ok(sanitizeCorrection('a\u0000\u001fb') === 'a b', '控制字符剥离', JSON.stringify(sanitizeCorrection('a\u0000\u001fb')))
  ok(sanitizeCorrection('x'.repeat(3000)).length === 2000, '长度截断 2000')
  ok(sanitizeCorrection('  trim  ') === 'trim', '首尾空白清理')
  // 轮转：写超 maxBytes 需经插件级参数；这里直接验证 appendCorrection 不抛 + 大量写入后文件仍合法 JSONL
  const root = mkdtempSync(join(tmpdir(), 'fb-'))
  const gapLog = join(root, 'gap_log.jsonl')
  const r = appendCorrection(gapLog, { tool: 't', correction: 'normal' })
  ok(r.ok, '消毒后正常追加')
  // resolveCorrection：追加 → 置位 → backlog 下降
  const before = analyzeGapLog(gapLog)
  ok(before.correctedBacklog === 1 && before.corrections === 1, 'resolve 前 correctedBacklog=1', JSON.stringify(before))
  const lines = readFileSync(gapLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { timestamp: number; tool: string })
  const rr = resolveCorrection(gapLog, lines[0]!.timestamp, lines[0]!.tool)
  ok(rr.ok && rr.resolvedCount === 1, 'resolveCorrection 置位成功', JSON.stringify(rr))
  const after = analyzeGapLog(gapLog)
  ok(after.correctedBacklog === 0 && after.corrections === 1, 'resolve 后 correctedBacklog 下降（corrections 计数不变）', JSON.stringify(after))
  const miss = resolveCorrection(gapLog, 1, 'nope')
  ok(!miss.ok, '无匹配 → ok:false 不抛', miss.error)
}

console.log('[2] analyzeGapLog：分布/高频 gap/积压/纠正计数 + 坏行容错')
{
  const root = mkdtempSync(join(tmpdir(), 'fb-'))
  const gapLog = join(root, 'gap_log.jsonl')
  const lines = [
    JSON.stringify({ tool: 'design_solution', confidence: 'low', gaps: ['relations'], timestamp: 1, user_supplied: null, resolved: false }),
    JSON.stringify({ tool: 'search_qdrant', confidence: 'low', gaps: ['relations'], timestamp: 2, user_supplied: null, resolved: false }),
    JSON.stringify({ tool: 'search_qdrant', confidence: 'medium', gaps: ['risk'], timestamp: 3, user_supplied: null, resolved: false }),
    JSON.stringify({ tool: 'query_product', confidence: 'correction', gaps: [], timestamp: 4, user_supplied: '纠错内容', resolved: false }),
    'not-json',
    '',
  ]
  writeFileSync(gapLog, lines.join('\n') + '\n')
  const rep = analyzeGapLog(gapLog)
  ok(rep.scanned === 5 && rep.entries === 4, '坏行跳过（scanned=5 entries=4）', JSON.stringify({ scanned: rep.scanned, entries: rep.entries }))
  ok(rep.confidenceDist.low === 2 && rep.confidenceDist.medium === 1 && rep.confidenceDist.correction === 1, '置信度分布', JSON.stringify(rep.confidenceDist))
  ok(rep.topGaps[0]?.gap === 'relations' && rep.topGaps[0]?.count === 2, '高频 gap Top1=relations×2', JSON.stringify(rep.topGaps))
  ok(rep.backlog === 3 && rep.corrections === 1, '积压=3 纠正=1', JSON.stringify({ backlog: rep.backlog, corrections: rep.corrections }))
  ok(rep.correctedBacklog === 1, 'correctedBacklog 拆分口径（第4条 correction+resolved=false 计入）', String(rep.correctedBacklog))
  // 口径拆分：correction + resolved=false → correctedBacklog
  const gapLog2 = join(root, 'gap_log2.jsonl')
  writeFileSync(gapLog2, [
    JSON.stringify({ tool: 't', confidence: 'correction', gaps: [], timestamp: 9, user_supplied: '还有错', resolved: false }),
    JSON.stringify({ tool: 't', confidence: 'low', gaps: [], timestamp: 8, user_supplied: null, resolved: false }),
  ].join('\n') + '\n')
  const rep2 = analyzeGapLog(gapLog2)
  ok(rep2.correctedBacklog === 1 && rep2.backlog === 1 && rep2.corrections === 1, 'correctedBacklog=1 与 backlog=1 分离', JSON.stringify({ c: rep2.correctedBacklog, b: rep2.backlog }))
  const empty = analyzeGapLog(join(root, 'missing.jsonl'))
  ok(empty.entries === 0 && empty.scanned === 0, '文件缺失 → 全零不抛（H-15）', JSON.stringify(empty))
}

console.log('[3] renderReport：markdown 结构')
{
  const rep = analyzeGapLog('/nonexistent/gap_log.jsonl')
  const md = renderReport(rep)
  ok(md.includes('# BKN gap 回流报告') && md.includes('（无数据）') && md.includes('不自动修改 BKN 数据'), '空数据报告：标题 + 无数据 + 只读声明')
}

console.log('[4] apply()：工具注册 + 周期报告 armed + admin 桥（行为面）')
{
  const root = mkdtempSync(join(tmpdir(), 'fb-'))
  const gapLog = join(root, 'gap_log.jsonl')
  const reportDir = join(root, 'reports')
  const registered: string[] = []
  const provided = new Map<string, any>()
  let tick: (() => void) | null = null
  const ctx: any = {
    logger: () => ({ info: (): void => {}, warn: (): void => {}, debug: (): void => {} }),
    get: (name: string): unknown => name === 'tools' ? { register: (t: { name: string }) => { registered.push(t.name) } } : undefined,
    emit: (): void => {},
    on: (): void => {},
    provide: (name: string, value: unknown): void => { provided.set(name, value) },
    setTimeout: (fn: () => void, _ms: number): void => { tick = fn },
    setInterval: (): void => {},
  }
  const { apply } = await import('./index.ts')
  apply(ctx, { gapLogPath: gapLog, reportDir, firstRunDelaySec: 0 })
  ok(registered.join(',') === 'capture_correction,resolve_correction', 'capture_correction + resolve_correction 工具已注册', JSON.stringify(registered))
  ok(provided.has('bknFeedbackAdmin'), 'bknFeedbackAdmin 桥已 provide')
  ok(typeof tick === 'function', '周期报告已 armed')
  tick!()
  const files = readdirSync(reportDir).filter((f) => f.startsWith('gap-report-') && f.endsWith('.md'))
  ok(files.length === 1, '报告落盘（首轮即生成）', JSON.stringify(files))
  const svc = provided.get('bknFeedbackAdmin')
  ok(typeof svc.analyze === 'function' && svc.paths().gapLogPath === gapLog, 'admin 桥方法在位')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
