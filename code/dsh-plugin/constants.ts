/**
 * constants.ts — i2Stream 跨模块共享常量（DSH 版）
 *
 * 移植自 plugin/constants.py（2026-09-24 本体分层重构 26 号后）：已知数据库列表、
 * 别名映射、诊断域值数据（症状/维度/错误码别名 25 号自 BKN 锚点表下沉）、
 * 值委托指针表（23 号：本体不持值数据）、场景路由规则（23 号：路由表属延展层）、
 * 归一化与匹配。
 */

// 已知支持的数据库列表 (用于兼容性检查 + 噪声推导)
// 2026-09-10 按业务实际支持清单补齐: 磐维DB/Datahub/DWS/PolarDB-X/PolarDB-pg/MogDB/ClickHouse/AnalyticDB
export const KNOWN_DBS = [
  'Oracle', 'MySQL', 'SQL Server', 'PostgreSQL', 'DB2',
  '达梦', 'OceanBase', 'GaussDB', 'TDSQL', 'GoldenDB',
  'KingBase', 'YashanDB', 'VastBase', 'Kafka', 'Hive',
  'HBase', 'Doris', 'Starrocks', 'TiDB', 'MongoDB', 'Redis',
  'MariaDB', 'Sybase', 'Informix',
  'MogDB', 'PolarDB-X', 'PolarDB-pg', '磐维DB',
  'ClickHouse', 'DWS', 'AnalyticDB', 'Datahub',
] as const

// 别名映射: 短写/英文名 → 规范名（constants.py::DB_ALIASES 1:1）
export const DB_ALIASES: Record<string, string> = {
  dm: '达梦',
  mssql: 'SQL Server',
  sqlserver: 'SQL Server',
  pg: 'PostgreSQL',
  ob: 'OceanBase',
  kingbase: 'KingBase',
  vastbase: 'VastBase',
  gauss: 'GaussDB',
  // 业务清单中的复合/变体写法 (2026-09-10)
  panwei: '磐维DB',
  panweidb: '磐维DB',
  'polardb-x': 'PolarDB-X',
  'polardb-pg': 'PolarDB-pg',
  'oceanbase@mysql': 'OceanBase',   // OB MySQL 模式写法, 归 OceanBase
  'tdsql for pg': 'TDSQL',          // TDSQL PG 版业务写法
  mogdb: 'MogDB',
  datahub: 'Datahub',
  dws: 'DWS',
  clickhouse: 'ClickHouse',
  adb: 'AnalyticDB',
  // 批 3-1：原 network.bkn「数据库同义词」中央表迁入（同址宿主 = 生产链路 DB_ALIASES）。
  // 大小写变体（ORACLE/Postgres/…）由 normalize_db 的 lower() 归一，不逐条登记。
  ora: 'Oracle',
  甲骨文: 'Oracle',
  'oracle database': 'Oracle',
  my: 'MySQL',
  mysqld: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  pgsql: 'PostgreSQL',
  'db/2': 'DB2',
  'ibm db2': 'DB2',
  dm8: '达梦',
  dameng: '达梦',
  达梦数据库: '达梦',
  'ocean base': 'OceanBase',
  华为gaussdb: 'GaussDB',
  yashan: 'YashanDB',
  崖山数据库: 'YashanDB',
  卡夫卡: 'Kafka',
  'pingcap tidb': 'TiDB',
}

// 错误码前缀 → 数据库 (值为小写标识, 与 diagnose_db_link 历史返回值一致)
// 新增数据库错误码族只在此处加一行; 匹配时按前缀长度降序, 避免短前缀抢占。
// 未核实的错误码族 (达梦/KingBase/GaussDB) 核实前禁止猜测添加——错前缀会引向错误路由。
export const DB_ERROR_PREFIXES: Record<string, string> = {
  'ORA-': 'oracle',
  'YAS-': 'yashandb',
  'PG-': 'postgresql',
  DB2: 'db2',
  MSSQL: 'sqlserver',
  MYSQL: 'mysql',
}

// 运行时进程对象注册集（24 号：目录不再是语义信号——原 bkn/processes/ 已并入 objects/）
// 用途：resolver 识别进程对象、lint 做「常量集 ↔ objects/<id>.bkn 存在性」一致性校验。
export const PROCESS_IDS = [
  'iatrack', 'iadumper', 'ialoader', 'iahelper', 'iamonitor', 'iadiff', 'iaproxy',
] as const

// ── 诊断域值数据（25 号：自 BKN 别名下沉，与 DB_ALIASES 同层）─────────────
//
// 25 号方案：`objects/diagnostics.bkn` 的「错误码锚点 / 症状锚点」两张表已删除——
//   · 「触发进程」列 = `relations/process_topology.bkn` 的 suspected_in 边（本体形态，权威）；
//   · 「检索指引」列 = 一条规则常量（DIAG_RETRIEVAL_GUIDE）；
//   · 「别名」列 = 值数据（现场口语 → 规范 ID 的归一映射）→ 下沉到本层。
// 规范 ID 空间（有哪些码/症状）由**边**承载；本表只做「口语 → ID」的归一映射。
// 机械变体（4073 → -4073、错误4073、ORA1555 → ORA-01555）由 resolver 代码派生，不在此登记。
export const ERROR_ALIASES: Record<string, string> = {
  日志解析异常: '-4073',
  REDO位点异常: '-4002',
  崖山增量异常: 'YAS-02276',
  工作节点离线: '-4016',
  数据库未打开: 'ORA-01109',
  登录失败: 'ORA-01017',
  '用户名/密码错误': 'ORA-01017',
  无监听: 'ORA-12541',
  目标端无监听器: 'ORA-12541',
  连接标识符无法解析: 'ORA-12154',
  TNS: 'ORA-12154',
  通用失败: '-1',
  运行中操作冲突: '-4071',
  ABNORMAL禁止重启: '-4031',
  装载进程异常: '-4046',
  'snapshot too old': 'ORA-01555',
  快照过期: 'ORA-01555',
  表不存在: 'ORA-00942',
  对象缺失: 'ORA-00942',
  'PL/SQL编译错误': 'ORA-24344',
}

export const SYMPTOM_ALIASES: Record<string, string> = {
  // 现场说法 → 规范症状 ID（值为 `symptom:` 后的裸 ID）
  增量卡住: 'incremental_stuck', 同步卡住: 'incremental_stuck',
  同步不动了: 'incremental_stuck', 位点不推进: 'incremental_stuck',
  规则变红: 'incremental_stuck', 同步停滞: 'incremental_stuck',
  增量延迟: 'incremental_stuck', 同步延迟大: 'incremental_stuck',
  卡住不动: 'incremental_stuck', 同步没同步: 'incremental_stuck',
  增量没同步: 'incremental_stuck',
  数据对不上: 'data_mismatch', 数据错乱: 'data_mismatch',
  两端不一致: 'data_mismatch', 校验不一致: 'data_mismatch',
  数据不一致: 'data_mismatch', 数据不同步: 'data_mismatch',
  数据校验失败: 'data_mismatch', 数据差异: 'data_mismatch',
  崩溃重启: 'crash_loop', 起不来: 'crash_loop', 反复重启: 'crash_loop',
  进程挂了: 'crash_loop', 崩溃循环: 'crash_loop', 进程崩溃: 'crash_loop',
  挂了: 'crash_loop', 报错: 'crash_loop', 出错: 'crash_loop',
  失败: 'crash_loop', crash: 'crash_loop',
  连不上库: 'connection_error', 连接超时: 'connection_error',
  认证失败: 'connection_error', 端口不通: 'connection_error',
  连接失败: 'connection_error', 连接异常: 'connection_error',
  无法连接: 'connection_error', 连不上: 'connection_error',
  连不通: 'connection_error', 不通: 'connection_error',
  超时: 'connection_error',
  变慢了: 'performance_degradation', 延迟大: 'performance_degradation',
  追不上: 'performance_degradation', 队列堆积: 'performance_degradation',
  性能下降: 'performance_degradation', 性能问题: 'performance_degradation',
  同步慢: 'performance_degradation', 延迟高: 'performance_degradation',
  // 表现型（无标准错误码的现场表现）
  进程退出: 'process_crash',
  脏数据: 'dirty_data_rejected', 装载拒绝: 'dirty_data_rejected',
  断点续传: 'resume_from_breakpoint_failed', 续传失败: 'resume_from_breakpoint_failed',
  TrackIPC: 'track_ipc_rule_not_found', 'rule not found': 'track_ipc_rule_not_found',
}

// 检查维度旧称/口语 → `dimension:` 后的裸 ID（21 号前 `class:*` 命名空间退场后的旧名同址化）
// 注意：与 SYMPTOM_ALIASES 冲突的键（「数据差异」）以症状优先——索引构建顺序症状在前，setdefault 不覆盖。
export const DIMENSION_ALIASES: Record<string, string> = {
  资源压力: 'resource', resource_pressure: 'resource',
  数据差异: 'consistency', data_diff: 'consistency',
  状态冲突: 'state_machine', state_conflict: 'state_machine',
  未归类: 'unknown',
}

// 诊断检索指引（一条规则，替代原锚点表逐行重复的「检索指引」列）
export const DIAG_RETRIEVAL_GUIDE = 'store:log_patterns_collection#错误码'

// 未登记错误码的处理规则（25 号：原锚点表的兜底行 → 规则常量）
export const UNKNOWN_RULE =
  '未登记错误码 → dimension:unknown（search_qdrant 兜底）+ gap_log 记录'

// ── 值委托指针表（Tool 层常量，23 号方案）────────────────────────────
// 本体层不持有会随实例/客户/版本增长的值数据，数据下延到 Skill references，
// 本体（Tool）只返回结构化指针，由 Agent 按需加载。
export interface Delegation {
  id: string
  path: string
  covers: string
  [key: string]: unknown
}

export const DELEGATIONS: Record<string, Delegation> = {
  compatibility: {
    id: 'skill:i2stream-migration-designer',
    path: 'references/compatibility.md',
    covers: '源端/目标端版本表、数据库对象兼容性、按库特殊约束、SQL Server 三种模式、OS/硬件要求',
  },
  charset: {
    id: 'skill:i2stream-db-manager',
    path: 'references/charset.md',
    covers: '字符集规则与各库确认项、脏数据处理',
  },
  architecture: {
    id: 'skill:i2stream-product-knowledge',
    path: 'references/architecture.md',
    covers: '三层控制/核心流水线/全量增量原理/Oracle 抽取/事务一致性/比对修复（完整架构正文）',
  },
  product: {
    id: 'skill:i2stream-product-knowledge',
    path: 'references/product.md',
    covers: '竞品对比/行业覆盖/信创适配/性能指标/数据源全景',
  },
  db_checkpoints: {
    id: 'skill:i2stream-db-diagnostics',
    path: 'references/db-checkpoints.md',
    covers: '进程/维度 × 各库检查点速查',
  },
  scenario_details: {
    id: 'skill:i2stream-migration-designer',
    path: 'references/scenario-details.md',
    covers: '场景方案优势对照、需求 → 拓扑选择指南',
  },
  compare_mechanism: {
    id: 'skill:i2stream-diff-op',
    path: 'references/compare-mechanism.md',
    covers: '比对机制（快照/排序递归/轨迹库）与修复方式明细',
  },
  cross_process_logs: {
    id: 'skill:i2stream-log-analyzer',
    path: 'references/cross-process-correlation.md',
    covers: '跨进程日志关联速查（可能根因 → 需对照日志）',
  },
}

// 值委托类返回值统一的 Qdrant 兜底提示（检索通道，无需归一化）
export const DELEGATION_QDRANT_HINT =
  "search_qdrant(query='<问题关键词>', collection='i2stream_collection')；" +
  "日志特征类问题可加 collection='log_patterns_collection' + dimension='日志模式'"

// ── 场景路由规则（Tool 层数据，23 号方案：路由表属延展层，不入 BKN 本体）──
// 原 bkn/scenarios/scenario-rules.bkn（已删）迁移至此；file 指向 objects/scenario-*.bkn（24 号目录收拢）。
export interface ScenarioRoutingRule {
  priority: number
  source_pattern: string
  target_pattern: string
  file: string
  scenario: string
  sub_scenario: string
  description: string
  relation_key: string
}

export const SCENARIO_ROUTING_RULES: ScenarioRoutingRule[] = [
  { priority: 1, source_pattern: 'same', target_pattern: 'same',
    file: 'objects/scenario-dual-active.bkn', scenario: '数据库双活', sub_scenario: '同构同步',
    description: '同构数据库双活同步', relation_key: '数据库双活' },
  { priority: 2, source_pattern: '*', target_pattern: 'kafka,hive,doris,starrocks',
    file: 'objects/scenario-bigdata-pipeline.bkn', scenario: '大数据采集分析', sub_scenario: '大数据入仓',
    description: '多元异构数据摄取到大数据平台', relation_key: '大数据采集' },
  { priority: 3, source_pattern: '*', target_pattern: '*',
    file: 'objects/scenario-dual-active.bkn', scenario: '跨平台迁移', sub_scenario: '异构迁移',
    description: '异构数据库在线数据迁移', relation_key: '跨平台迁移' },
  { priority: 4, source_pattern: '*', target_pattern: '*',
    file: 'objects/scenario-dual-active.bkn', scenario: '两地三中心', sub_scenario: '异地容灾',
    description: '两地三中心灾备同步', relation_key: '两地三中心' },
]

/** 将数据库名展开为规范名列表，消除别名歧义（支持 "达梦 DM" 复合名）。 */
export function normalizeDb(name: string): string[] {
  const stripped = (name || '').trim()
  const lower = stripped.toLowerCase()
  const result = [stripped]
  const canonical = DB_ALIASES[lower] ?? ''
  if (canonical && canonical !== stripped) result.push(canonical)
  for (const word of lower.split(/\s+/)) {
    const w = DB_ALIASES[word]
    if (w && !result.includes(w)) result.push(w)
  }
  return result
}

/** 检查 candidate 是否匹配 dbTarget（含别名展开）。 */
export function isDbMatch(candidate: string, dbTarget: string): boolean {
  const variants = normalizeDb(candidate)
  return variants.some((v) => dbTarget.toLowerCase().includes(v.toLowerCase()))
}
