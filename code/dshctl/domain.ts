/**
 * domain.ts — domain.yml（schema:1）解析/校验/渲染；R7（超时）、R8（密钥 env 名）内嵌校验。
 */
import { loadYamlFile, dumpYaml } from './yml.ts'

export interface DomainSpec {
  schema: number
  domain: string
  display_name?: string
  dsh_home: string
  dsh_source: string
  capabilities: string[]
  contracts?: { media_dirs?: string[] }
  guard?: { rule_source: 'bkn' | 'whitelist' | 'none'; whitelist?: { commands?: string[]; write_paths?: string[] } }
  preset: { source: string; skills_dirs: string[] }
  plugins?: Array<{ id: string; path: string; config?: unknown }>
  api_server?: {
    port: number
    api_key_env: string
    turn_timeout_sec: number
    max_task_duration_sec: number
    /** domain-api 插件源码绝对路径（adopt 从实例回填；新域手工声明） */
    plugin_path?: string
    /** profile patch 中 domain-api insert 的 id（adopt 回填如 'ops-api'；缺省 'domain-api'） */
    plugin_id?: string
  }
  memory?: { gateway_url?: string; session_keys?: string[] }
  ports?: { gui?: number | null; api?: number }
  systemd_unit?: string
  shared_deps?: Array<{ name: string; url: string }>
}

export const ENV_NAME_RE = /^\$?[A-Z_]+$/
export const DOMAIN_RE = /^[a-z][a-z0-9-]*$/

/** 解析 domain.yml → { spec, errors }；结构错误收集不抛（check 汇总输出） */
export function parseDomain(path: string): { spec: DomainSpec | null; errors: string[] } {
  const errors: string[] = []
  let raw: Record<string, unknown>
  try {
    raw = loadYamlFile(path) as Record<string, unknown>
  } catch (e) {
    return { spec: null, errors: [`load failed: ${(e as Error).message}`] }
  }
  if (!raw || typeof raw !== 'object') return { spec: null, errors: ['not a mapping'] }
  if (raw.schema !== 1) errors.push(`schema: expected 1, got ${String(raw.schema)}`)
  for (const k of ['domain', 'dsh_home', 'dsh_source', 'preset'] as const) {
    if (!raw[k]) errors.push(`${k}: required`)
  }
  if (raw.domain && !DOMAIN_RE.test(String(raw.domain))) errors.push(`domain: ${String(raw.domain)} !~ ${DOMAIN_RE}`)
  const spec = raw as unknown as DomainSpec
  // R7
  const api = spec.api_server
  if (api) {
    if (!(api.turn_timeout_sec >= api.max_task_duration_sec)) {
      errors.push(`R7: turn_timeout_sec(${api.turn_timeout_sec}) < max_task_duration_sec(${api.max_task_duration_sec})`)
    }
  }
  // R8
  if (api?.api_key_env && !ENV_NAME_RE.test(api.api_key_env)) {
    errors.push(`R8: api_key_env '${api.api_key_env}' 不是环境变量名`)
  }
  return { spec, errors }
}

/** 渲染 domain.yml 文本（diff 用；adopt 落盘也用它） */
export function renderDomainYml(spec: DomainSpec): string {
  return `# domains/${spec.domain}/domain.yml —— 由 dshctl adopt 产出（schema:1）；密钥只记 env 名\n${dumpYaml(spec)}`
}
