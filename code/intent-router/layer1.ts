/**
 * layer1.ts — 第 1 层：正则 / 精确规则（纯模块）
 *
 * 只处理「意图非常明确」的输入，命中即 high confidence、不进入第 2 层：
 *   · 极短问候/致谢            → none（不注入，直接放行）
 *   · 错误码形态（ORA-00942）  → 错误诊断意图（内建规则，目标按 target 约定查找）
 *   · taxonomy 里声明的 exact  → 命中即采纳（正则 `re:` 前缀，或 ≥3 字的字面量）
 *
 * 保守原则：宁可漏（交给第 2 层/主模型），不可错（注入错误提示比不注入更糟）。
 */

import type { IntentDef } from './taxonomy.ts'
import { isLikelyGreeting } from './extract.ts'

export type Tier = 'rule' | 'alias' | 'algo' | 'vector'

export interface Hit {
  intentId: string
  tier: Tier
  /** 抽取到的槽位（如 error_code=ORA-00942）。 */
  slots: Record<string, string>
  /** 命中的原文片段（日志/观测用）。 */
  matched: string
  /** 命中的规则名（可观测：builtin:greeting / builtin:error-code / exact:<intent>）。 */
  rule: string
}

/** 内建错误码形态：ORA-00942 / YAS-02276 / -4073 / -4073 类数字码。 */
export const ERROR_CODE_RE = /(?<![A-Za-z0-9_])(?:[A-Z]{2,}-[0-9]+|-[0-9]{3,5})(?![0-9])/g

/** 字面量精确匹配的最短长度（过短的词（"失败"/"超时"）会大面积误触发）。 */
export const MIN_LITERAL_LENGTH = 3

/** 按 target 找意图（用于内建规则的落点约定）。 */
export function findIntentByTarget(intents: readonly IntentDef[], target: string): IntentDef | undefined {
  return intents.find((intent) => intent.target === target)
}

/** 全部错误码形态抽取（供诊断意图记录多个码）。 */
export function extractErrorCodes(text: string): string[] {
  return [...new Set(text.match(ERROR_CODE_RE) ?? [])]
}

function matchExactRule(pattern: string, haystack: string): string | undefined {
  if (pattern.startsWith('re:')) {
    let re: RegExp
    try {
      re = new RegExp(pattern.slice(3), 'i')
    } catch {
      return undefined
    }
    const m = re.exec(haystack)
    return m?.[0]
  }
  if (pattern.length < MIN_LITERAL_LENGTH) return undefined
  const idx = haystack.toLowerCase().indexOf(pattern.toLowerCase())
  return idx === -1 ? undefined : haystack.slice(idx, idx + pattern.length)
}

/**
 * 跑第 1 层。
 * @param normalized - 已归一化的用户文本。
 * @param intents - 意图清单（顺序即优先级）。
 * @param errorToolTarget - 内建错误码规则落到的工具名（缺省 `diagnose_error`）。
 * @returns 命中结果；未命中返回 undefined（交第 2 层）。
 */
export function layer1(
  normalized: string,
  intents: readonly IntentDef[],
  errorToolTarget = 'diagnose_error',
): Hit | undefined {
  if (normalized === '') return undefined

  if (isLikelyGreeting(normalized)) {
    const none = intents.find((intent) => intent.kind === 'none')
    if (none) return { intentId: none.id, tier: 'rule', slots: {}, matched: normalized, rule: 'builtin:greeting' }
  }

  for (const intent of intents) {
    for (const rule of intent.exact) {
      const matched = matchExactRule(rule.pattern, normalized)
      if (matched === undefined) continue
      const slots: Record<string, string> = {}
      if (rule.slot) slots[rule.slot] = matched
      return { intentId: intent.id, tier: 'rule', slots, matched, rule: `exact:${intent.id}` }
    }
  }

  const codes = extractErrorCodes(normalized)
  if (codes.length > 0) {
    const errorIntent = findIntentByTarget(intents, errorToolTarget)
    if (errorIntent) {
      return {
        intentId: errorIntent.id,
        tier: 'rule',
        slots: { error_code: codes[0]! },
        matched: codes[0]!,
        rule: 'builtin:error-code',
      }
    }
  }

  return undefined
}
