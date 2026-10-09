/**
 * inject.ts — 注入文案渲染（纯模块）
 *
 * 三条安全网之一：文案自带免责声明「若与用户意图不符请以用户输入为准」。
 * 误识别无法完全避免（任何分类器都有错），但误识别的影响可以被这句话压到最小：
 * 它是给主模型的**建议**，不是命令，且明确要求以用户原文为准。
 */

import type { IntentDef } from './taxonomy.ts'
import type { Hit } from './layer1.ts'

export const DEFAULT_TEMPLATE = [
  '[intent-router] 本地匹配识别到意图：{label}（{target}）{slots}。',
  '{advice}',
  '该提示由本地规则/算法得出，若与用户意图不符请以用户输入为准。',
].join('\n')

function renderSlots(slots: Record<string, string>): string {
  const pairs = Object.entries(slots)
  if (pairs.length === 0) return ''
  return `，${pairs.map(([k, v]) => `${k}=${v}`).join(' ')}`
}

function adviceOf(intent: IntentDef, hit: Hit): string {
  const skills = intent.skills.length > 0 ? `；如需要可加载 Skill ${intent.skills.join('、')}` : ''
  if (intent.kind === 'skill') {
    return `建议先加载 Skill ${intent.target ?? ''}，按其流程作答${skills}。`
  }
  if (intent.kind === 'tool') {
    const slot = Object.entries(hit.slots)[0]
    const arg = slot ? `（${slot[0]}=${slot[1]}）` : ''
    return `建议直接调用 ${intent.target ?? ''} 工具${arg}，无需再逐一探索其它工具${skills}。`
  }
  return `继续按你的判断作答${skills}。`
}

/**
 * 渲染注入文本。
 * @param intent - 识别到的意图。
 * @param hit - 命中细节（tier / slots / 证据）。
 * @param template - 可选自定义模板（支持 {label} {target} {slots} {advice} {tier} {evidence}）。
 */
export function renderInjectionText(intent: IntentDef, hit: Hit, template?: string): string {
  const tpl = template && template.trim() !== '' ? template : DEFAULT_TEMPLATE
  return tpl
    .replaceAll('{label}', intent.label)
    .replaceAll('{target}', intent.target ?? intent.id)
    .replaceAll('{slots}', renderSlots(hit.slots))
    .replaceAll('{advice}', adviceOf(intent, hit))
    .replaceAll('{tier}', hit.tier)
    .replaceAll('{evidence}', hit.matched)
    .trim()
}
