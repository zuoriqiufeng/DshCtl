#!/usr/bin/env node
/**
 * gen-intent-taxonomy.ts — 生成 intent-router 的意图体系基线（taxonomy.generated.json）
 *
 * 为什么是生成而不是手写：意图的原型语料散落在已有资产里——12 个 BKN 工具的语义、
 * skill_manifest 的 capability / load_criterion、各 SKILL.md 的 description 与 triggers
 * （宿主从不消费 triggers，属闲置语料）、constants.ts 的口语别名表、hotpath 的症状→Skill 映射。
 * 手抄一遍必然随上游漂移，所以「派生部分全部生成、只有措辞部分手工维护」。
 *
 * 手工维护的部分（TOOL_INTENTS 的 label/prototypes/skills、SKILL_ONLY、SYMPTOM_OWNER）
 * 就在本文件里，跟着一起 review——它们是「人对这个领域的理解」，不该藏进数据文件。
 *
 * 用法（在 deepseek-harness 下运行，与其它 scripts 一致）：
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/gen-intent-taxonomy.ts [--check]
 *   --check：只比对不写盘，退出码 1 表示生成物过期（可用于 CI 守护漂移）
 *
 * 生成物只接受重新生成，不接受手改（AGENTS §3「脚本生成物只接受重新生成」）。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ERROR_ALIASES, DB_ALIASES, KNOWN_DBS, SYMPTOM_ALIASES } from '../dsh-plugin/constants.ts'
import { defaultManifestPath, loadSkillManifest } from '../dsh-plugin/resolver.ts'
import { parseSkillMeta } from '../intent-router/frontmatter.ts'
import type { ExactRule, IntentDef } from '../intent-router/taxonomy.ts'

// ── 路径配置（换环境改这一段）─────────────────────────────────────────────
const BKN_ROOT = '/hdd/demo/public/i2stream-bkn/bkn'
const SKILLS_DIR = '/hdd/demo/public/dsh-info/.dsh-home/skills'
const OUT_PATH = resolve(import.meta.dirname, '..', 'intent-router', 'taxonomy.generated.json')

/**
 * 12 个 BKN 工具对应的意图（人工维护：标签、原型问法、关联 Skill）。
 * prototypes 是 BM25/向量的打分语料，写「运维工程师会怎么问」而不是工具文档的措辞。
 */
const TOOL_INTENTS: Array<Pick<IntentDef, 'id' | 'target' | 'label' | 'skills' | 'prototypes' | 'keywords'>> = [
  {
    id: 'query_product', target: 'query_product', label: '产品信息查询',
    skills: ['i2stream-product-knowledge'],
    prototypes: [
      'i2Stream 支持哪些数据库', '产品支持哪些数据源', 'i2Stream 有哪些核心组件',
      '你们的同步工具能接哪些库', '支持哪些源端和目标端', '产品版本有哪些能力',
    ],
    keywords: ['支持哪些', '产品', '组件', '数据源', '源端', '目标端'],
  },
  {
    id: 'resolve_relation', target: 'resolve_relation', label: '实体关系查询',
    skills: ['i2stream-product-knowledge'],
    prototypes: [
      '这条规则对应哪个进程', 'iatrack 负责什么', '哪个进程负责装载',
      '工作节点和规则是什么关系', '这个报错来自哪个进程', '进程之间的依赖关系',
    ],
    keywords: ['哪个进程', '关系', '依赖'],
  },
  {
    id: 'resolve_operation', target: 'resolve_operation', label: '操作解析',
    skills: ['i2stream-rule-manager', 'i2stream-node-manager', 'i2stream-db-manager'],
    prototypes: [
      '怎么创建同步规则', '如何激活工作节点', '注册数据库的步骤是什么',
      '怎么停止一条规则', '如何删除同步规则', '创建比较任务怎么操作',
      '灾备切换怎么做', '激活节点',
    ],
    keywords: ['操作', '创建', '删除', '启动', '停止', '激活', '注册'],
  },
  {
    id: 'list_scenarios', target: 'list_scenarios', label: '场景清单',
    skills: ['i2stream-migration-designer'],
    prototypes: [
      '有哪些同步场景', '支持双活吗', '两地三中心怎么做', '有哪些灾备场景',
      '能做什么类型的同步', '支持异构迁移场景吗',
    ],
    keywords: ['场景', '双活', '两地三中心', '容灾', '迁移类型'],
  },
  {
    id: 'get_prerequisites', target: 'get_prerequisites', label: '前置条件',
    skills: ['i2stream-rule-manager', 'i2stream-db-manager'],
    prototypes: [
      '创建规则需要什么前置条件', '同步前要准备什么', '做灾备切换有什么前提',
      '需要开启归档日志吗', '有什么限制条件', '操作之前要检查什么',
    ],
    keywords: ['前置', '前提', '条件', '限制', '归档日志'],
  },
  {
    id: 'check_action_risk', target: 'check_action_risk', label: '操作风险校验',
    skills: ['i2stream-rule-manager'],
    prototypes: [
      '能不能删除这个规则', '什么情况下禁止删除同步规则', '重启规则有风险吗',
      '这个操作安全吗', '可以强制恢复吗', '直接停掉规则会怎样',
    ],
    keywords: ['禁止', '风险'],
  },
  {
    id: 'check_compatibility', target: 'check_compatibility', label: '兼容性检查',
    skills: ['i2stream-migration-designer', 'i2stream-db-manager'],
    prototypes: [
      'Oracle 到 MySQL 支持吗', '源端 MySQL 能同步到 Doris 吗', '版本兼容性怎么样',
      '支持哪些版本的 Oracle', '这个库和目标库兼容吗', '字符集要求是什么',
    ],
    keywords: ['兼容', '版本', '字符集'],
  },
  {
    id: 'diagnose_error', target: 'diagnose_error', label: '错误码诊断',
    skills: ['i2stream-db-diagnostics', 'i2stream-log-analyzer'],
    prototypes: [
      '错误码 ORA-00942 是什么意思', '报错 -4073 怎么解决', 'YAS-02276 是什么原因',
      '这个错误码什么原因导致的', '日志解析异常怎么处理', 'ORA-01555 怎么恢复',
    ],
    keywords: ['错误码', '报错', '异常', '什么原因', '错误'],
  },
  {
    id: 'diagnose_db_link', target: 'diagnose_db_link', label: '链路诊断',
    skills: ['i2stream-db-diagnostics'],
    prototypes: [
      '数据库连不上', '链路报错怎么排查', '连接超时是什么问题', '目标端无监听',
      '同步链路断了', '源端连不通怎么查',
    ],
    keywords: ['连不上', '连接', '链路', '超时', '监听', '不通', '排查'],
  },
  {
    id: 'design_solution', target: 'design_solution', label: '方案设计',
    skills: ['i2stream-migration-designer'],
    prototypes: [
      '设计一个 Oracle 到 MySQL 的迁移方案', '怎么做双活方案', '给个同步方案',
      '两地三中心方案怎么设计', '异构迁移的方案建议', '帮我出个容灾方案',
    ],
    keywords: ['方案', '设计', '规划'],
  },
  {
    id: 'explain_architecture', target: 'explain_architecture', label: '架构原理',
    skills: ['i2stream-product-knowledge'],
    prototypes: [
      '增量同步的原理是什么', '全量和增量怎么实现的', '事务一致性怎么保证',
      '抽取是怎么做的', '同步的底层原理', '数据是怎么被捕获的',
    ],
    keywords: ['原理', '架构', '机制', '底层', '一致性'],
  },
  {
    id: 'search_qdrant', target: 'search_qdrant', label: '知识检索',
    skills: [],
    prototypes: [
      '帮我查一下相关资料', '检索一下文档里关于性能的内容', '知识库里有没有关于日志的说明',
      '查一下这块的经验', '搜一下相关案例',
    ],
    keywords: ['检索', '资料', '文档', '知识库'],
  },
]

/**
 * 「只有 Skill 形态」的用户需求：没有对应工具，只能靠加载 Skill 承接。
 * 其余 skill（rule-manager / db-manager / node-manager / db-diagnostics / log-analyzer /
 * diff-op / failover / product-knowledge / migration-designer）与上面的工具意图重叠，
 * **刻意不单独建意图**——否则两个意图争同一句话会把间隔拉平、门限反而拒绝（精度换覆盖率不划算）。
 * 它们作为对应工具意图的 `skills[]` 属性出现。
 *
 * 未部署的 skill（skills 目录下没有该目录）会被跳过并打印——给模型推一个加载不了的
 * Skill 比不推更糟，所以这里以「实际部署」为准，而不是以 manifest 为准。
 */
const SKILL_ONLY: Array<{ skill: string; id: string; label: string; keywords: string[] }> = [
  { skill: 'i2stream-env-validator', id: 'env_validation', label: '环境校验', keywords: ['环境', '校验', '检查项', '合规'] },
  { skill: 'i2stream-iadebug', id: 'process_debug', label: '进程级调试', keywords: ['iadebug', '位点', '日志级别', '强制恢复'] },
  { skill: 'i2stream-list-lic', id: 'license_query', label: '许可查询', keywords: ['许可', 'license', '授权'] },
  { skill: 'i2stream-sql-generator', id: 'sql_generation', label: 'SQL 生成', keywords: ['生成SQL', '建表语句', 'DDL'] },
  { skill: 'i2stream-topology-visualizer', id: 'topology_view', label: '拓扑可视化', keywords: ['拓扑', '架构图', '画图'] },
]

/**
 * 症状 ID → 主 owner。owner 可以是 Skill 名（生成 skill 意图），也可以是工具意图 id
 * （`tool:` 前缀，落到该工具意图上）。
 *
 * `connection_error` 刻意归到工具意图 `diagnose_db_link` 而不是 skill 意图：
 * ① 领域里本来就有「链路诊断」这个工具，注入"调用 diagnose_db_link"比"加载某 Skill"更可执行；
 * ② 症状类 skill 意图彼此语义相邻（连不上/不一致/卡住/崩溃/变慢），每多一个就多一个抢票者，
 *    间隔被拉平后门限会集体拒绝——实测把连不上从 skill 意图挪走后，相邻意图的间隔才拉开。
 */
const SYMPTOM_OWNER: Record<string, { owner: string; siblings: string[] }> = {
  incremental_stuck: { owner: 'i2stream-db-diagnostics', siblings: ['i2stream-log-analyzer'] },
  data_mismatch: { owner: 'i2stream-db-diagnostics', siblings: [] },
  crash_loop: { owner: 'i2stream-log-analyzer', siblings: ['i2stream-db-diagnostics'] },
  connection_error: { owner: 'tool:diagnose_db_link', siblings: ['i2stream-db-diagnostics'] },
  performance_degradation: { owner: 'i2stream-log-analyzer', siblings: ['i2stream-db-diagnostics'] },
}

/**
 * 泛化触发器拒绝表：这些词在现场口语里跨意图通用（"看日志"可能是查日志/诊断/调试），
 * 留在语料里只会互相抢话、拉低间隔。实测「看下日志」曾因此被误判到 process_debug。
 * 只保留能区分意图的触发器，泛化词交给层 2 的 BM25/向量与主模型。
 */
const TRIGGER_DENY = new Set(['看日志', '查看日志', '看规则', '查看规则', '规则状态', '查询规则状态', '查规则', '看下日志'])

function listSkillNames(): string[] {
  try {
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function readSkillMeta(skill: string): ReturnType<typeof parseSkillMeta> {
  try {
    return parseSkillMeta(readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8'))
  } catch {
    return { name: '', description: '', triggers: [] }
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))]
}

function build(): { intents: IntentDef[]; sources: string[]; skippedSkills: string[] } {
  const skillNames = listSkillNames()
  const knownSkills = new Set(skillNames)
  const manifest = loadSkillManifest(defaultManifestPath(BKN_ROOT))
  const skippedSkills: string[] = []
  const sources = [
    `tools: plugin-registry/registry.yml（bkn-plugin provides ×${TOOL_INTENTS.length}）`,
    `aliases: code/dsh-plugin/constants.ts（SYMPTOM ×${Object.keys(SYMPTOM_ALIASES).length} / ERROR ×${Object.keys(ERROR_ALIASES).length} / DB ×${Object.keys(DB_ALIASES).length}）`,
    `skills: ${SKILLS_DIR}（×${skillNames.length}）`,
    `manifest: ${defaultManifestPath(BKN_ROOT)}（×${manifest.length}）`,
    'hotpath: code/presets/i2stream-ops/hotpath.md（症状 → Skill）',
  ]

  const intents: IntentDef[] = []

  // ① 12 个工具意图
  const dbNames = uniq([...KNOWN_DBS, ...Object.values(DB_ALIASES)])
  for (const spec of TOOL_INTENTS) {
    const exact: ExactRule[] = [{ pattern: `re:(?<![A-Za-z0-9_])${spec.target}(?![A-Za-z0-9_])`, slot: 'tool' }]
    const keywords = [...spec.keywords]
    if (spec.target === 'check_compatibility' || spec.target === 'query_product') keywords.push(...dbNames)
    // 错误码诊断：把别名表的值（规范错误码）全量登记，供层 2a 别名归一
    const errors = spec.target === 'diagnose_error' ? uniq(Object.values(ERROR_ALIASES)) : []
    if (spec.target === 'diagnose_error') {
      exact.push({ pattern: 're:(?<![A-Za-z0-9_])(?:[A-Z]{2,}-[0-9]+|-[0-9]{3,5})(?![0-9])', slot: 'error_code' })
    }
    intents.push({
      id: spec.id,
      kind: 'tool',
      target: spec.target,
      label: spec.label,
      skills: spec.skills.filter((s) => knownSkills.has(s)),
      symptoms: [],
      errors,
      prototypes: spec.prototypes,
      keywords: uniq(keywords),
      exact,
      injectable: true,
    })
  }

  // ② 症状 → 主 owner（诊断类 Skill 意图）：别名表的键即现场口语
  const bySkillIntent = new Map<string, IntentDef>()
  for (const [symptom, mapping] of Object.entries(SYMPTOM_OWNER)) {
    const aliasesForSymptom = uniq(Object.entries(SYMPTOM_ALIASES).filter(([, v]) => v === symptom).map(([k]) => k))
    // owner = 工具意图：症状别名并到该工具意图上（不新建意图，减少抢票者）
    if (mapping.owner.startsWith('tool:')) {
      const toolIntent = intents.find((intent) => intent.id === mapping.owner.slice(5))
      if (!toolIntent) continue
      toolIntent.symptoms = uniq([...toolIntent.symptoms, symptom])
      toolIntent.keywords = uniq([...toolIntent.keywords, ...aliasesForSymptom])
      toolIntent.prototypes = uniq([...toolIntent.prototypes, ...aliasesForSymptom.slice(0, 6)])
      continue
    }
    const id = `diagnose_${symptom}`
    const meta = readSkillMeta(mapping.owner)
    const intentsForSymptom = aliasesForSymptom
    const def: IntentDef = {
      id,
      kind: 'skill',
      target: mapping.owner,
      label: meta.name ? `${meta.name} 诊断（${symptom}）` : `症状诊断（${symptom}）`,
      skills: uniq([mapping.owner, ...mapping.siblings]).filter((s) => knownSkills.has(s)),
      symptoms: [symptom],
      errors: [],
      prototypes: uniq([
        ...intentsForSymptom.slice(0, 8).map((alias) => `${alias}怎么办`),
        ...intentsForSymptom.slice(0, 8),
        meta.description.split('\n')[0]!.slice(0, 120),
      ]),
      keywords: uniq([...intentsForSymptom, symptom]),
      exact: [],
      injectable: true,
    }
    intents.push(def)
    bySkillIntent.set(id, def)
  }

  // ③ 只有 Skill 形态的需求（无对应工具）
  for (const spec of SKILL_ONLY) {
    if (!knownSkills.has(spec.skill)) {
      skippedSkills.push(spec.skill)
      continue
    }
    const meta = readSkillMeta(spec.skill)
    const manifestItem = manifest.find((item) => item.id === `skill:${spec.skill}`)
    const usableTriggers = meta.triggers.filter((t) => !TRIGGER_DENY.has(t))
    // 原型取「触发器原样 + capability 文本」：触发器本身就是现场说法（"看日志"/"查规则"），
    // 拼成 "XXX怎么做" 会把它扭曲成操作类问法，反而与 resolve_operation 抢话。
    intents.push({
      id: spec.id,
      kind: 'skill',
      target: spec.skill,
      label: spec.label,
      skills: [spec.skill],
      symptoms: [],
      errors: [],
      prototypes: uniq([
        ...usableTriggers,
        ...(manifestItem?.capability ? [(manifestItem.capability as string).split(/[（(]/)[0]!] : []),
        ...(manifestItem?.load_criterion ? [(manifestItem.load_criterion as string)] : []),
        meta.description.split('\n')[0]!.slice(0, 120),
      ]),
      keywords: uniq([...spec.keywords, ...usableTriggers]),
      exact: [{ pattern: `re:(?<![A-Za-z0-9_-])${spec.skill}(?![A-Za-z0-9_-])` }],
      injectable: true,
    })
  }

  // ④ none：问候/致谢（层 1 命中后不注入）
  intents.push({
    id: 'none',
    kind: 'none',
    label: '寒暄/无明确意图',
    skills: [],
    symptoms: [],
    errors: [],
    prototypes: ['你好', '在吗', '谢谢', '收到', '好的', '你好，帮我看个问题'],
    keywords: ['你好', '谢谢', '收到'],
    exact: [],
    injectable: false,
  })

  return { intents, sources, skippedSkills }
}

function main(): void {
  const check = process.argv.includes('--check')
  const { intents, sources, skippedSkills } = build()
  const payload = {
    schema: 1,
    generatedAt: new Date().toISOString().slice(0, 10),
    sources,
    intents,
  }
  const text = `${JSON.stringify(payload, undefined, 2)}\n`
  if (check) {
    let current = ''
    try {
      current = readFileSync(OUT_PATH, 'utf8')
    } catch {
      console.error(`gen-intent-taxonomy: 生成物缺失 → ${OUT_PATH}`)
      process.exit(1)
    }
    const strip = (s: string): string => s.replace(/"generatedAt": "[^"]*",\n/, '')
    if (strip(current) !== strip(text)) {
      console.error('gen-intent-taxonomy: 生成物已过期，请重跑生成器')
      process.exit(1)
    }
    console.log(`gen-intent-taxonomy: 生成物最新（${intents.length} 条意图）`)
    return
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, text)
  const tools = intents.filter((i) => i.kind === 'tool').length
  const skills = intents.filter((i) => i.kind === 'skill').length
  console.log(`gen-intent-taxonomy: 写入 ${OUT_PATH}`)
  console.log(`  tool 意图 ${tools} · skill 意图 ${skills} · none ${intents.length - tools - skills}`)
  if (skippedSkills.length > 0) console.log(`  跳过（未部署）：${skippedSkills.join('、')}`)
  console.log(`  数据源：${sources.join(' / ')}`)
}

// 顶层直接执行（与 code/scripts 其它脚本一致：bench-tools.ts 同样没有入口守卫；
// `import.meta.main` 在以文件为入口、经 tsx loader 加载时不成立）。
main()
