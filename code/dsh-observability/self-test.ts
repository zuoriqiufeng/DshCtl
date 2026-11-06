/**
 * self-test.ts — dsh-observability 独立自测（node --import tsx/esm self-test.ts）
 * 风格对齐 ops-skill-manager：ok() 断言 + mkdtemp 临时目录隔离，failed>0 退出码 1。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(cond: boolean, tag: string, detail = ''): void {
  if (cond === true) { passed++; console.log(`  ✓ ${tag}`) } else { failed++; console.error(`  ✗ FAIL: ${tag}${detail ? ` ${detail}` : ''}`) }
}

// 行为面验证：最小 ctx stub 调 apply()，再检查落盘产物与服务方法。
// 不直接 import 纯函数（dayTag/rotateIfNeeded 走数据面间接覆盖），避免拉起 cordis 运行时依赖。

interface StubEvent { event: string; payload: unknown }
function makeCtx(dataDir: string): { ctx: any; events: StubEvent[]; provided: Map<string, any> } {
  const events: StubEvent[] = []
  const provided = new Map<string, any>()
  const ctx: any = {
    logger: () => (m: string): void => { void m },
    emit: (event: string, payload: unknown): void => { events.push({ event, payload }) },
    on: (event: string, fn: (p: any) => void): void => { ctx._handlers ??= {}; (ctx._handlers[event] ??= []).push(fn) },
    provide: (name: string, value: unknown): void => { provided.set(name, value) },
  }
  return { ctx, events, provided }
}

console.log('[1] apply()：dataDir 创建 + 服务 provide + risk-hit 订阅')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  ok(existsSync(dataDir), 'dataDir 被创建')
  ok(provided.has('observability'), 'observability 服务已 provide')
  const svc = provided.get('observability')!
  ok(typeof svc.recordUsage === 'function' && typeof svc.aggregate === 'function' && typeof svc.recentRisk === 'function' && svc.dataDir() === dataDir, '服务方法齐备（recordUsage/aggregate/recentRisk/dataDir）')
}

console.log('[2] usage 落盘 + 聚合')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  const svc = provided.get('observability')
  svc.recordUsage({ ts: Math.floor(Date.now() / 1000), sessionId: 's1', model: 'm', promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: 'stop' })
  svc.recordUsage({ ts: Math.floor(Date.now() / 1000), sessionId: 's2', model: 'm', promptTokens: 20, completionTokens: 8, totalTokens: 28, finishReason: 'stop' })
  const files = readdirSync(dataDir).filter((f) => f.startsWith('usage-') && f.endsWith('.jsonl'))
  ok(files.length === 1, 'usage-YYYYMMDD.jsonl 生成', JSON.stringify(readdirSync(dataDir)))
  const agg = svc.aggregate()
  ok(agg.requests === 2 && agg.totalTokens === 43 && agg.sessions === 2, '聚合：请求数/token 总量/会话数', JSON.stringify(agg))
  ok(agg.riskHits.total === 0, '聚合：风险命中为零')
}

console.log('[3] risk-hit 事件 → 审计落盘 + 分档计数')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  const handlers = ctx._handlers['bkn/risk-hit'] as Array<(p: any) => void>
  ok(Array.isArray(handlers) && handlers.length === 1, 'bkn/risk-hit 已订阅')
  handlers[0]({ verdict: 'block', tool: 'bash', action: 'failover', ruleId: 'R-01', reason: 'x', blockable: true })
  handlers[0]({ verdict: 'advisory', tool: 'bash', action: 'register_db', ruleId: 'R-02', reason: 'y', blockable: false })
  handlers[0]({ verdict: 'advisory', tool: 'bash', action: 'register_db', ruleId: 'R-02', reason: 'y', blockable: false })
  const svc = provided.get('observability')
  const agg = svc.aggregate()
  ok(agg.riskHits.total === 3 && agg.riskHits.block === 1 && agg.riskHits.advisory === 2, '审计落盘：total=3 block=1 advisory=2', JSON.stringify(agg.riskHits))
  const recent = svc.recentRisk(2)
  ok(recent.length === 2 && recent[0].verdict === 'advisory', 'recentRisk 限额返回最近 2 条', JSON.stringify(recent))
  const line = readFileSync(join(dataDir, readdirSync(dataDir).find((f) => f.startsWith('risk-'))!), 'utf8').trim().split('\n')[0]!
  ok(JSON.parse(line).ts > 0 && JSON.parse(line).verdict === 'block', '审计行含 ts 与 verdict 字段', line)
}

console.log('[4] 坏行/缺失容错（H-15：不抛）')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data'); mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'usage-20990101.jsonl'), 'not-json\n{"sessionId":"s9","totalTokens":7}\n\n')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  const svc = provided.get('observability')
  const agg = svc.aggregate()
  ok(agg.requests === 1 && agg.totalTokens === 7, '坏行跳过、好行计入', JSON.stringify(agg))
  ok(svc.aggregate(9999).days >= 0, '空目录聚合不抛')
}

console.log('[5] 轮转分片计入聚合 + recentRisk 分片序（2026-11-05 加固）')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data'); mkdirSync(dataDir, { recursive: true })
  // 造同日轮转态：.2（最旧 2 行）→ .1（2 行）→ 主文件（3 行）；rotate 语义 = 主文件改名 .1（旧主→.1），.1→.2
  writeFileSync(join(dataDir, 'risk-20990101.jsonl.2'), '{"verdict":"gray"}\n{"verdict":"gray"}\n')
  writeFileSync(join(dataDir, 'risk-20990101.jsonl.1'), '{"verdict":"shadow"}\n{"verdict":"advisory"}\n')
  writeFileSync(join(dataDir, 'risk-20990101.jsonl'), '{"verdict":"advisory"}\n{"verdict":"block"}\n{"verdict":"advisory"}\n')
  // 异日分片也造一个（跨日排序）
  writeFileSync(join(dataDir, 'usage-20990102.jsonl.1'), '{"sessionId":"sA","totalTokens":100}\n')
  writeFileSync(join(dataDir, 'usage-20990102.jsonl'), '{"sessionId":"sB","totalTokens":50}\n')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  const svc = provided.get('observability')
  const agg = svc.aggregate()
  ok(agg.riskHits.total === 7 && agg.riskHits.block === 1 && agg.riskHits.advisory === 3 && agg.riskHits.shadow === 1 && agg.riskHits.gray === 2, '分片计入聚合（7 条分档正确）', JSON.stringify(agg.riskHits))
  ok(agg.requests === 2 && agg.totalTokens === 150, 'usage 分片计入', JSON.stringify(agg))
  const recent = svc.recentRisk(4)
  ok(recent.length === 4 && recent[0].verdict === 'advisory' && recent[1].verdict === 'block' && recent[2].verdict === 'advisory' && recent[3].verdict === 'advisory', 'recentRisk：主文件新→分片旧（同日 .1 优先于 .2）', JSON.stringify(recent.map((r: any) => r.verdict)))
  ok(svc.recentRisk(100).length === 7, 'recentRisk limit 覆盖全部分片')
}

console.log('[6] 行缓存：未变更文件不重读、变更后生效')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data'); mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'usage-20990101.jsonl'), '{"sessionId":"s1","totalTokens":10}\n')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  const svc = provided.get('observability')
  const a1 = svc.aggregate()
  // mtime 精度防护：显式改 mtime 为过去再改回，保证指纹不变场景可测（这里直接依赖 size 未变 + 快速连调）
  const a2 = svc.aggregate()
  ok(a1.requests === 1 && a2.requests === 1 && a2.totalTokens === 10, '缓存后二次聚合结果一致')
  // 追加新行 → size/mtime 变 → 缓存失效重读
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dataDir, 'usage-20990101.jsonl'), '{"sessionId":"s2","totalTokens":5}\n')
  const a3 = svc.aggregate()
  ok(a3.requests === 2 && a3.totalTokens === 15, '文件变更后缓存失效重读', JSON.stringify(a3))
}

console.log('[6b] 失败 turn 分档计数（审计报告 Top2）')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data'); mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'usage-20990101.jsonl'), [
    '{"sessionId":"ok1","totalTokens":10,"finishReason":"stop"}',
    '{"sessionId":"t1","totalTokens":0,"finishReason":"timeout"}',
    '{"sessionId":"a1","totalTokens":0,"finishReason":"abandoned"}',
    '{"sessionId":"e1","totalTokens":0,"finishReason":"error"}',
    '{"sessionId":"ok2","totalTokens":5,"finishReason":"abandoned_partial"}', // 部分文本 abandoned 也算失败分档
  ].join('\n') + '\n')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir })
  const agg = provided.get('observability').aggregate()
  ok(agg.requests === 5 && agg.errors === 4, 'errors=4（非 stop 全计入）', JSON.stringify({ requests: agg.requests, errors: agg.errors }))
  ok(agg.errorsTimeout === 1 && agg.errorsAbandoned === 1, '分桶 timeout=1 abandoned=1（error/abandoned_partial 桶只进 errors 总数）', JSON.stringify({ t: agg.errorsTimeout, a: agg.errorsAbandoned }))
}

console.log('[7] retentionDays 惰性清理')
{
  const root = mkdtempSync(join(tmpdir(), 'obs-'))
  const dataDir = join(root, 'obs-data'); mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'usage-20200101.jsonl'), '{"sessionId":"old","totalTokens":1}\n')
  writeFileSync(join(dataDir, 'usage-20200101.jsonl.1'), '{"sessionId":"old-shard"}\n')
  writeFileSync(join(dataDir, 'risk-20200101.jsonl'), '{"verdict":"block"}\n')
  writeFileSync(join(dataDir, 'usage-20990101.jsonl'), '{"sessionId":"new","totalTokens":2}\n')
  const { ctx, provided } = makeCtx(dataDir)
  const { apply } = await import('./index.ts')
  apply(ctx, { dataDir, retentionDays: 30 })
  const svc = provided.get('observability')
  svc.recordUsage({ ts: Math.floor(Date.now() / 1000), sessionId: 'trigger', model: 'm', promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: 'stop' })
  const files = readdirSync(dataDir)
  ok(!files.some((f) => f.startsWith('usage-20200101') || f.startsWith('risk-20200101')), '超期文件（含分片）被清理', JSON.stringify(files))
  ok(files.some((f) => f.includes('20990101')), '未超期文件保留')
  const agg = svc.aggregate()
  ok(agg.requests === 2 && agg.totalTokens === 2, '聚合只含留存数据', JSON.stringify(agg))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
