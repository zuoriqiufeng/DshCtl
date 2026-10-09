/**
 * index.ts — intent-router：分层意图识别插件（DSH 侧入口）
 *
 * 设计目标（来自需求）：意图识别不再一律交给大模型——太慢、太费 token。
 *   第 1 层 正则/精确：意图明确的输入（错误码、寒暄、显式点名的工具/Skill）直接判定
 *   第 2 层 算法     ：别名归一 → BM25 原型 →（可选）向量相似 → RRF 融合 → 置信门
 *   第 3 层 大模型   ：**不新增任何调用**。层 1/2 不达门限时本插件完全不干预，
 *                      交回主模型按既有方式（读热路径提示边推边选工具）处理。
 *
 * 落地强度（v1）：只注入提示。挂点是 waterfall `agent/pre-step`——它能拿到本步
 * 从 inbox 取出的真实用户消息，并在其后追加一条上下文消息（上游 tool-skill 的
 * 确定性注入就是这个用法）。主模型仍照常回答，省掉的是探索性工具调用与试错轮次。
 *
 * 安全网三件：① 门限（分数 + 间隔）② 注入文案自带「以用户输入为准」免责声明
 * ③ 按 session+turn 去重，只在回合第一步注入一次。
 *
 * 观测：mode=observe 时只算不注入，并把决策写入 JSONL；同时用 `tools/result`
 * 记录主模型实际调用了什么工具，用于事后对照「识别 vs 实际」的一致率。
 *
 * 降级铁律：本插件任何异常都不允许影响会话——所有入口 try/catch + warn，失败即返回
 * 原 decision（等价于插件不存在）。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ERROR_ALIASES, SYMPTOM_ALIASES } from '../dsh-plugin/constants.ts'
import { classify, buildScorer, type EngineDeps, type VectorProvider } from './engine.ts'
import { createEmbedProvider } from './embed.ts'
import { lastUserText } from './extract.ts'
import { renderInjectionText } from './inject.ts'
import { buildAliasIndex, DEFAULT_GATE, type GateConfig } from './layer2.ts'
import { mergeTaxonomy, type IntentDef } from './taxonomy.ts'
import { OVERRIDES } from './overrides.ts'

/** 声明本插件注入的用户消息来源（MessageSourceMap 是合并扩展类型，各生产者声明自己的 kind）。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'intent-router': {
      kind: 'intent-router'
      intent: string
      tier: string
      rule: string
    }
  }
}

export const name = 'intent-router'

export interface Config {
  /** off | observe | inject（默认 observe：先测准再改行为）。 */
  mode?: string
  /** 意图体系生成物路径；缺省=插件目录下的 taxonomy.generated.json。 */
  taxonomyPath?: string
  /** 层 2 门限。 */
  minBm25Score?: number
  minBm25RelMargin?: number
  minCos?: number
  minCosMargin?: number
  vectorCorroborateTopK?: number
  /**
   * 是否启用向量路径（2c，默认 false）。
   * 实测（2026-10-08，24 条标注集 + 9 条同义改写样本）：向量在当前语料上**救不回** BM25
   * 判不出的样本（0/9），逐原型取最大相似度后短泛化输入的余弦反而更高
   * （「看下日志」→ sql_generation 0.827、「创建规则」→ 0.784），没有可用的工作点。
   * 因此默认关闭：插件零外部依赖、热路径 p95 ≈ 1ms。要重新评估时把它打开即可，
   * 但请先按 code/intent-router/doc/intent-router-design.md 的「向量路径复核」一节重测。
   */
  useVector?: boolean
  /** embed sidecar 地址（BGE，1024 维）。 */
  embedUrl?: string
  /** 单次 embed 超时（ms）。 */
  embedTimeoutMs?: number
  /** 观测日志路径；缺省 $DSH_HOME/logs/intent-router.jsonl。 */
  logPath?: string
  /** 注入文案模板（支持 {label} {target} {slots} {advice} {tier} {evidence}）。 */
  injectTemplate?: string
  /** 错误码内建规则落到的工具名（默认 diagnose_error）。 */
  errorToolTarget?: string
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.string().default('observe').description('off | observe | inject'),
  taxonomyPath: Schema.string().description('意图体系生成物路径'),
  minBm25Score: Schema.number().default(16).description('BM25-only 绝对分下限'),
  minBm25RelMargin: Schema.number().default(0.35).description('BM25-only top1 相对间隔下限'),
  minCos: Schema.number().default(0.62).description('向量路径余弦门限'),
  minCosMargin: Schema.number().default(0.06).description('向量路径余弦间隔门限'),
  vectorCorroborateTopK: Schema.natural().default(2).description('向量冠军须在 BM25 前 K 名内（跨方法互证）'),
  useVector: Schema.boolean().default(false).description('是否启用向量路径（默认关，见 Config 注释）'),
  embedUrl: Schema.string().default('http://127.0.0.1:8096/embed').description('embed sidecar 地址'),
  embedTimeoutMs: Schema.natural().default(800).description('单次 embed 超时（ms）'),
  logPath: Schema.string().description('观测日志路径'),
  injectTemplate: Schema.string().description('注入文案模板'),
  errorToolTarget: Schema.string().default('diagnose_error').description('错误码规则的落点工具'),
})

interface Resolved {
  mode: 'off' | 'observe' | 'inject'
  taxonomyPath: string
  gate: GateConfig
  useVector: boolean
  embedUrl: string
  embedTimeoutMs: number
  logPath: string
  injectTemplate?: string
  errorToolTarget: string
}

function resolveConfig(config: Config | undefined): Resolved {
  const modeRaw = (config?.mode ?? 'observe').trim().toLowerCase()
  const mode = modeRaw === 'off' || modeRaw === 'inject' ? modeRaw : 'observe'
  const dshHome = process.env.DSH_HOME ?? join(process.cwd(), '.dsh')
  return {
    mode,
    taxonomyPath: config?.taxonomyPath?.trim() || join(import.meta.dirname, 'taxonomy.generated.json'),
    gate: {
      minBm25Score: config?.minBm25Score ?? DEFAULT_GATE.minBm25Score,
      minBm25RelMargin: config?.minBm25RelMargin ?? DEFAULT_GATE.minBm25RelMargin,
      minCos: config?.minCos ?? DEFAULT_GATE.minCos,
      minCosMargin: config?.minCosMargin ?? DEFAULT_GATE.minCosMargin,
      vectorCorroborateTopK: config?.vectorCorroborateTopK ?? DEFAULT_GATE.vectorCorroborateTopK,
    },
    useVector: config?.useVector ?? false,
    embedUrl: config?.embedUrl?.trim() || 'http://127.0.0.1:8096/embed',
    embedTimeoutMs: config?.embedTimeoutMs ?? 800,
    logPath: config?.logPath?.trim() || join(dshHome, 'logs', 'intent-router.jsonl'),
    ...(config?.injectTemplate ? { injectTemplate: config.injectTemplate } : {}),
    errorToolTarget: config?.errorToolTarget?.trim() || 'diagnose_error',
  }
}

function loadIntents(path: string, knownSkills: ReadonlySet<string>): { intents: IntentDef[]; skipped: number } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const merged = mergeTaxonomy(raw, OVERRIDES, knownSkills)
  return { intents: merged.intents, skipped: merged.skipped.length }
}

/** 观测日志：一行一条 JSON（append 模式；失败静默——日志坏了不该影响会话）。 */
function makeObserver(path: string): (row: Record<string, unknown>) => void {
  let ready = false
  return (row) => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true })
        ready = true
      }
      appendFileSync(path, `${JSON.stringify(row)}\n`)
    } catch {
      /* 观测失败静默（降级铁律） */
    }
  }
}

export function apply(ctx: Context, config?: Config): void {
  const cfg = resolveConfig(config)
  const log = ctx.logger('intent-router')
  if (cfg.mode === 'off') {
    log.info('[intent-router] disabled by config (mode=off)')
    return
  }

  let intents: IntentDef[]
  try {
    const loaded = loadIntents(cfg.taxonomyPath, new Set())
    intents = loaded.intents
    log.info('[intent-router] 意图体系已加载：%d 条（跳过 %d），mode=%s',
      intents.length, loaded.skipped, cfg.mode)
  } catch (error) {
    log.warn('[intent-router] 意图体系加载失败，插件不生效：%s', String(error))
    return
  }
  if (intents.length === 0) {
    log.warn('[intent-router] 意图体系为空，插件不生效（可重跑 gen-intent-taxonomy.ts）')
    return
  }

  const aliasIndex = buildAliasIndex(intents, { symptom: SYMPTOM_ALIASES, error: ERROR_ALIASES })
  const observe = makeObserver(cfg.logPath)
  const deps: EngineDeps = {
    intents,
    aliasIndex,
    gate: cfg.gate,
    scorer: buildScorer(intents),
    errorToolTarget: cfg.errorToolTarget,
  }

  // 层 2c 向量：默认关闭（实测无可用工作点，见 Config.useVector 注释）。
  // 打开时异步预热原型向量（CPU 批量编码约 5s）；预热期间或 sidecar 不可达时自然退化为 BM25-only。
  if (cfg.useVector) {
    const provider = createEmbedProvider(intents, {
      url: cfg.embedUrl,
      timeoutMs: cfg.embedTimeoutMs,
      warn: (message) => log.warn(message),
      info: (message) => log.info(message),
    })
    deps.vector = provider
    provider.warmup()
  }

  // 每个会话只记最后一次注入的 turn（O(1)、按会话数增长，不随回合累积）
  const lastInjected = new Map<string, number>()
  // 本回合主模型实际调用了哪些工具（用于 observe 模式的「识别 vs 实际」对照）
  const actualTools = new Map<string, string[]>()

  ctx.on('tools/result', (exec) => {
    try {
      const agentId = (exec as { agent?: { id?: string } }).agent?.id
      if (typeof agentId !== 'string') return
      const toolName = (exec as { name?: string }).name
      if (typeof toolName !== 'string' || toolName === '') return
      const bucket = actualTools.get(agentId) ?? []
      if (!bucket.includes(toolName)) bucket.push(toolName)
      actualTools.set(agentId, bucket)
    } catch {
      /* 观测失败静默 */
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter') return decision
      const text = lastUserText(messages)
      if (text.trim() === '') return decision

      const result = await classify(text, deps)
      signal.throwIfAborted()

      const agentId = String((agent as { id?: unknown }).id ?? '')
      const row: Record<string, unknown> = {
        ts: new Date().toISOString(),
        sid: agentId,
        turn,
        mode: cfg.mode,
        text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        accepted: result.accepted,
        reason: result.reason,
        intent: result.intent?.id ?? '',
        target: result.intent?.target ?? '',
        kind: result.intent?.kind ?? '',
        tier: result.tier ?? '',
        rule: result.hit?.rule ?? '',
        slots: result.hit?.slots ?? {},
        ms: result.ms,
        top: result.ranking.slice(0, 3).map((r) => ({ id: r.intentId, bm25: Number(r.bm25.toFixed(2)), cos: r.cos })),
      }

      if (!result.accepted || !result.intent || !result.intent.injectable) {
        observe(row)
        return decision
      }
      if (cfg.mode !== 'inject') {
        observe(row)
        return decision
      }

      // 去重：同一回合只注入一次
      const seenTurn = lastInjected.get(agentId)
      if (seenTurn === turn) {
        observe({ ...row, injected: false, reason: 'already-injected' })
        return decision
      }

      const textToInject = renderInjectionText(result.intent, result.hit!, cfg.injectTemplate)
      const injection = createUserMessage({
        content: [{ type: 'text', text: textToInject }],
        source: { kind: 'intent-router', intent: result.intent.id, tier: result.tier ?? '', rule: result.hit?.rule ?? '' },
      })
      lastInjected.set(agentId, turn)
      observe({ ...row, injected: true, actualTools: actualTools.get(agentId) ?? [] })
      actualTools.delete(agentId)
      return { ...decision, messages: [...decision.messages, injection] }
    } catch (error) {
      // 降级铁律：意图识别是加速路径，任何失败都不影响会话
      log.warn('[intent-router] 识别/注入失败，已跳过本步：%s', String(error))
      return decision
    }
  })

  log.info('[intent-router] 已挂载 agent/pre-step（mode=%s，意图 %d 条，向量=%s）',
    cfg.mode, intents.length, cfg.useVector ? 'on' : 'off')
}

export type { VectorProvider }
