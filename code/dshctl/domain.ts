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

export interface SkeletonOpts {
  home: string
  source: string
  port: number
  presetSource: string
  unit: string
  /** --from 派生：可复用段（capabilities/guard/memory/shared_deps/plugins 与 api_server 细节） */
  derived?: Partial<DomainSpec>
}

/**
 * domain new 骨架：身份字段全部自动推导（home/端口/unit/env 名/preset 路径），
 * 可复用段由 --from 带入。dsh_home 默认避开已被占用的 .dsh-home——ops-app 能力包按
 * home 独立存放（apply.ts 固定写 <home>/bundles/ops-app），两域共用一份 home 会互相覆盖。
 */
export function renderDomainSkeleton(name: string, o: SkeletonOpts): string {
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`
  const d = o.derived ?? {}
  const api = d.api_server  // 仅 --from 派生时存在；手写新域默认无 api 段
  const spec: DomainSpec = {
    schema: 1,
    domain: name,
    display_name: `${name} domain agent`,
    dsh_home: o.home,
    dsh_source: o.source,
    capabilities: d.capabilities ?? ['remote-exec'],
    guard: d.guard ?? { rule_source: 'bkn' },
    // skills_dirs 默认不声明（R6 对空目录会报"无合法 SKILL.md"）——新域有技能时再加
    preset: { source: o.presetSource },
    ...(d.plugins?.length ? { plugins: d.plugins } : {}),
    // api_server 默认不进骨架：没有 domain-api 插件（plugin_path）时 renderProfilePatch 会诚实拒绝。
    // --from 派生时带入源域的 api_server（port/env 已重写）；手写时参照 domains/ops/domain.yml。
    ...(api ? {
      api_server: {
        port: o.port,
        api_key_env: envName,
        turn_timeout_sec: api.turn_timeout_sec ?? 120,
        max_task_duration_sec: api.max_task_duration_sec ?? 120,
        ...(api.plugin_path ? { plugin_path: api.plugin_path } : {}),
        ...(api.plugin_id ? { plugin_id: api.plugin_id } : {}),
      },
    } : {}),
    ...(d.memory ? { memory: d.memory } : {}),
    ports: { api: o.port, gui: null },
    systemd_unit: o.unit,
    ...(d.shared_deps?.length ? { shared_deps: d.shared_deps } : {}),
  }
  const header = [
    `# domains/${name}/domain.yml —— 由 dshctl domain new 生成（schema:1）；密钥只记 env 名`,
    `# 核对清单（路径/端口已按当前环境推导，逐项确认后跑 dshctl check ${name}）：`,
    `#   [ ] dsh_home —— 默认避开已被占用的 .dsh-home（ops-app 能力包按 home 存放，两域共用会互相覆盖）`,
    `#   [ ] preset.source —— persona + agent.cordis.yml 源目录（apply 时拷进 DSH_HOME/presets/${name}；目录需自建）`,
    `#   [ ] api_server —— 默认未声明（无 domain-api 插件时 profile patch 无法生成该段）；`,
    `#       需要 OpenAI 兼容 API 面时参照 domains/ops/domain.yml 加 api_server 段并填 plugin_path；`,
    `#       key 值由 systemd EnvironmentFile 注入（R8 只记 env 名，默认 <NAME>_API_KEY=${envName}）`,
    `#   [ ] capabilities —— core 隐含；追加 script 需配 guard.whitelist（R4）`,
    `#   [ ] skills_dirs —— 默认未声明（无技能域合法）；有技能时加 preset.skills_dirs: [<home>/skills] 并放入 SKILL.md`,
    `#   [ ] plugins —— 留空；需要时 dshctl plugin add --id <id> --path <入口> 后登记进本清单`,
    ``,
  ].join('\n')
  return header + dumpYaml(spec)
}
