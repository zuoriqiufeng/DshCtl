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

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BKNResolver } from './resolver.ts'
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
}

export const Config = Schema.object({
  bknRoot: Schema.string().required(false),
  guardEnabled: Schema.boolean().default(true),
  guardBlock: Schema.boolean().default(true),
  mutatingTools: Schema.array(Schema.string()).default(DEFAULT_MUTATING_TOOLS as unknown as string[]),
  ruleSource: Schema.string().default('bkn'),
  whitelistPath: Schema.string().default('/hdd/demo/public/dsh-info/code/guard-rule-sources/whitelist.yml'),
})

export function apply(ctx: Context, config: Config) {
  const bknRoot = config.bknRoot ?? process.env.I2STREAM_BKN_ROOT ?? SHARED_BKN_ROOT
  const guardEnabled = config.guardEnabled ?? true
  const guardBlock = config.guardBlock ?? true
  const mutatingTools = config.mutatingTools ?? DEFAULT_MUTATING_TOOLS
  const ruleSource = (config.ruleSource ?? 'bkn') as 'bkn' | 'whitelist' | 'none'
  const whitelistPath = config.whitelistPath ?? '/hdd/demo/public/dsh-info/code/guard-rule-sources/whitelist.yml' 

  ctx.logger('bkn-plugin').info(`[i2stream-bkn] loading BKN from ${bknRoot}`)

  const resolver = new BKNResolver(bknRoot)
  const traverser = new RelationTraverser(bknRoot)

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
