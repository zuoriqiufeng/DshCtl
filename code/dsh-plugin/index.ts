/**
 * index.ts — i2Stream BKN 业务知识网络的 DSH 原生插件入口
 *
 * 能力：
 *   1. 4 个 BKN 查询工具（query_product / resolve_relation / check_action_risk / resolve_operation）
 *   2. RiskGuard 风险护栏：经 tools/pre-execute 在写操作执行前拦截
 *      （规则来源于 bkn/risks/constraints.bkn，非硬编码）
 *
 * 挂载方式（源码模式，web profile）：
 *   /root/.dsh/profiles/web/cordis.patch.yml
 *     - insert:
 *         - id: bkn-plugin
 *           name: '/hdd/demo/public/dsh-info/code/dsh-plugin/index.ts'
 *           config:
 *             guardBlock: true
 *
 * 代码位置：/hdd/demo/public/dsh-info/code/dsh-plugin/（2026-09-14 自 i2stream-bkn/dsh-plugin 迁入，
 * 与 Hermes 工作区共用同一份 BKN：/hdd/demo/public/i2stream-bkn/bkn）
 */

import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BKNResolver, bknWalkIssues } from './resolver.ts'
import { validateBknContract, handleContractResult, type ContractMode } from './bknContract.ts'
import { RelationTraverser } from './relations.ts'
import { DEFAULT_MUTATING_TOOLS, guardDecision, resetRulesCache } from './riskGuard.ts'
import { buildTools } from './tools.ts'

export const name = 'i2stream-bkn'
export const inject = ['tools']

/** 共享 BKN 根目录（Hermes 与 DSH 共用一份）；env 或 Config 可覆盖 */
const SHARED_BKN_ROOT = '/hdd/demo/public/i2stream-bkn/bkn'

export interface Config {
  /** BKN 根目录（默认共享 BKN：/hdd/demo/public/i2stream-bkn/bkn，env I2STREAM_BKN_ROOT 可覆盖） */
  bknRoot?: string
  /** 是否启用 RiskGuard 护栏（默认 true） */
  guardEnabled?: boolean
  /** 护栏命中时是否阻断（true=deny；false=仅告警放行） */
  guardBlock?: boolean
  /** 参与命令指纹识别的写类工具名 */
  mutatingTools?: string[]
  /** RiskGuard 规则源（默认 bkn；whitelist=只放行白名单，SQL 域用；none=关闭规则） */
  ruleSource?: 'bkn' | 'whitelist' | 'none'
  /** whitelist 规则文件路径（ruleSource=whitelist 时用；默认 code/guard-rule-sources/whitelist.yml） */
  whitelistPath?: string
  /** BKN 契约校验档位（v26 契约）：strict=不匹配拒载（默认）/ warn=日志响亮继续 / off=不校验 */
  contractCheck?: 'strict' | 'warn' | 'off'
}

export const Config = Schema.object({
  bknRoot: Schema.string().required(false),
  guardEnabled: Schema.boolean().default(true),
  guardBlock: Schema.boolean().default(true),
  mutatingTools: Schema.array(Schema.string()).default(DEFAULT_MUTATING_TOOLS as unknown as string[]),
  ruleSource: Schema.string().default('bkn'),
  whitelistPath: Schema.string().default('/hdd/demo/public/dsh-info/code/guard-rule-sources/whitelist.yml'),
  contractCheck: Schema.string().default('strict'),
})

export function apply(ctx: Context, config: Config) {
  // 相对路径按「包根」解析（pack --with-bkn 内嵌快照场景：config.bknRoot='bkn' 随包走）。
  // 源码模式入口在插件根（index.ts）；打包后入口在 lib/（lib/index.js）——两者都归到包根。
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const pluginDir = basename(moduleDir) === 'lib' ? dirname(moduleDir) : moduleDir
  const resolvePath = (p: string): string => (isAbsolute(p) ? p : resolve(pluginDir, p))

  const bknRoot = resolvePath(config.bknRoot ?? process.env.I2STREAM_BKN_ROOT ?? SHARED_BKN_ROOT)
  const guardEnabled = config.guardEnabled ?? true
  const guardBlock = config.guardBlock ?? true
  const mutatingTools = config.mutatingTools ?? DEFAULT_MUTATING_TOOLS
  const ruleSource = (config.ruleSource ?? 'bkn') as 'bkn' | 'whitelist' | 'none'
  const whitelistPath = resolvePath(config.whitelistPath ?? '/hdd/demo/public/dsh-info/code/guard-rule-sources/whitelist.yml')
  const contractMode = (config.contractCheck ?? 'strict') as ContractMode
  const log = {
    info: (m: string) => ctx.logger('bkn-plugin').info(m),
    error: (m: string) => ctx.logger('bkn-plugin').error(m),
  }

  log.info(`[i2stream-bkn] loading BKN from ${bknRoot}`)

  // 0) BKN 契约校验（v26）：strict 下不匹配拒载——工具宁可消失不可静默错答
  const verdict = handleContractResult(validateBknContract(bknRoot), contractMode, log)
  if (verdict.fatal) throw new Error(verdict.message)

  const resolver = new BKNResolver(bknRoot)
  const traverser = new RelationTraverser(bknRoot)

  // 0.1) 构造后断言：解析产出为空即拒载（契约校验之外的兜底——区块级失配可能过契约检查但装配为空）
  if (contractMode !== 'off') {
    const ops = resolver.operations.size
    const nodes = traverser.graph.size
    if (ops === 0 || nodes === 0) {
      log.error(`[i2stream-bkn] 解析断言失败：operations=${ops}, graph nodes=${nodes}（${bknRoot}）`)
      if (contractMode === 'strict') throw new Error(`[i2stream-bkn] BKN 解析产出为空（operations=${ops}, graph nodes=${nodes}）——拒绝带病注册工具`)
    }
    const misses = resolver.loadMisses
    if (misses.length || bknWalkIssues.length) {
      log.error(`[i2stream-bkn] BKN 读取台账（非阻断）：未命中=${JSON.stringify(misses.slice(0, 8))} 遍历异常=${JSON.stringify(bknWalkIssues.slice(0, 4))}`)
    }
  }

  // 1) 注册查询工具
  buildTools(ctx, { resolver, traverser, bknRoot })

  // 2) RiskGuard 风险护栏（tools/pre-execute 策略）
  // waterfall 事件用 ctx.on 注册监听器；ctx.waterfall(...) 是调用方侧的
  // 发起入口，不能用来注册监听。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const decision = guardDecision(exec.name, args, {
      enabled: guardEnabled,
      block: guardBlock,
      bknRoot,
      mutatingTools,
      ruleSource,
      whitelistPath,
    })
    if (decision) {
      return { kind: 'deny' as const, reason: decision.reason ?? 'RiskGuard 拦截' }
    }
    return next()
  })

  // 3) 按需重载：配置热更时重新解析规则（事件名是 settings/updated）
  ctx.on('settings/updated', () => {
    resetRulesCache()
  })
}
