/**
 * constants.ts — i2Stream 跨模块共享常量（DSH 版）
 *
 * 移植自 plugin/constants.py：已知数据库列表、别名映射、归一化与匹配。
 */

export const KNOWN_DBS = [
  'Oracle', 'MySQL', 'SQL Server', 'PostgreSQL', 'DB2',
  '达梦', 'OceanBase', 'GaussDB', 'TDSQL', 'GoldenDB',
  'KingBase', 'YashanDB', 'VastBase', 'Kafka', 'Hive',
  'HBase', 'Doris', 'Starrocks', 'TiDB', 'MongoDB',
  'MariaDB', 'Sybase', 'Informix',
] as const

export const DB_ALIASES: Record<string, string> = {
  dm: '达梦',
  mssql: 'SQL Server',
  sqlserver: 'SQL Server',
  pg: 'PostgreSQL',
  ob: 'OceanBase',
  kingbase: 'KingBase',
  vastbase: 'VastBase',
  gauss: 'GaussDB',
}

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
