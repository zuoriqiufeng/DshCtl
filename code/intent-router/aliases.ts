/**
 * aliases.ts — 症状/错误码口语别名表（intent-router 内联副本，S1 可搬移）
 *
 * 2026-10-21 从 code/dsh-plugin/constants.ts 复制（ERROR_ALIASES/SYMPTOM_ALIASES 两表 1:1），
 * 消除跨插件源码依赖（plugin pack 自包含）。同步纪律：源表变更时人工同步本副本。
 * 值数据层口径：本表只做「口语 → 规范 ID」归一映射；规范 ID 空间由 BKN 边承载。
 */

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
