/**
 * overrides.ts — 人工增量（唯一允许手改的意图数据；生成物 taxonomy.generated.json 禁止手改）
 *
 * 用法：这里只做「补」，不做「改」——生成物负责派生部分（工具语义、别名表、Skill 触发器），
 * 本文件负责三件事：
 *   · appendPrototypes：补真实问法（生成器不可能穷举一线说法）
 *   · appendKeywords  ：补关键词权重（BM25 语料里关键词 ×3）
 *   · disable         ：整体停用某条生成的意图（跨域复用时最常见的动作）
 *
 * 当前内容刻意保持精简：**门限与原型按 P3 的观测/评测数据校准后再补**，先按真实
 * 误判证据加条目，而不是凭想象堆语料（堆得越多，意图越互相抢话、间隔越小、门限越容易拒）。
 */

import type { TaxonomyOverrides } from './taxonomy.ts'

export const OVERRIDES: TaxonomyOverrides = {
  // 跨域复用时可在此停用不适用条目，如：disable: ['diagnose_incremental_stuck']
  disable: [],

  appendPrototypes: {
    // RiskGuard 语义下的口语问法（护栏相关问句，"拦/放行/强制"是现场高频词）
    check_action_risk: ['这个动作会不会被拦', '强制操作可以吗', '会被护栏拦住吗'],
    // 错误码的弱指代问法（没有具体码时用户常这么说，靠上下文里的码补足）
    diagnose_error: ['这个报错是什么原因', '日志里这个错误码什么意思'],
  },

  appendKeywords: {
    diagnose_error: ['报错', '什么错'],
    diagnose_db_link: ['链路'],
  },
}
