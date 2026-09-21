/**
 * adopt.ts — F1 反向归档：探测实例 → domain.yml + 能力包 DRAFT（首次）+ registry 登记。
 * 密钥红线：只提取 `!!js process.env.X` 的 env 名，字面值 → R8 warn + 占位，绝不落盘。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadYamlFile } from './yml.ts'
import type { DomainSpec } from './domain.ts'
import { classify, type CapabilityPack } from './packs.ts'

export interface AdoptResult {
  spec: DomainSpec
  warns: string[]
  /** 归层结果：packName → id 列表（含 'unclassified'） */
  classification: Record<string, string[]>
  /** 覆写条目（原样，如 connection） */
  overrides: Array<{ id: string; inject?: string[]; config?: unknown }>
  /** 首次运行产出的 DRAFT 片段（已有片段时为空） */
  draftPacks: CapabilityPack[]
}

interface PatchEntry {
  id?: string
  name?: string
  disabled?: boolean
  inject?: string[]
  config?: Record<string, unknown>
  insert?: PatchEntry[]
}

/** 从 `!!js ...process.env.X...` 提取 env 名；字面值密钥 → warn 并返回占位 */
function envNameOf(value: unknown, field: string, warns: string[]): string | undefined {
  if (typeof value !== 'string') return undefined
  const m = /process\.env\.([A-Z_]+)/.exec(value)
  if (m) return m[1]!
  if (value.trim() && !/process\.env/.test(value)) {
    warns.push(`R8: ${field} 疑似字面值密钥（已忽略不落盘）——请改用 ${field}_env 环境变量名`)
    return 'REPLACE_ME'
  }
  return undefined
}

function findInsert(entries: PatchEntry[], id: string): PatchEntry | undefined {
  for (const e of entries) {
    if (e.insert) for (const s of e.insert) if (s.id === id) return s
    if (e.id === id) return e
  }
  return undefined
}

export function adoptInstance(name: string, home: string, packsDir: string, opts: { unit?: string } = {}): AdoptResult {
  const warns: string[] = []
  const profileDir = join(home, 'profiles', name)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) throw new Error(`profile patch 不存在: ${patchPath}`)
  const profilePatch = loadYamlFile(patchPath) as PatchEntry[]

  // 1) ops-api config → api_server / memory
  const opsApi = findInsert(profilePatch, 'ops-api')
  const apiCfg = (opsApi?.config ?? {}) as Record<string, unknown>
  const apiServerCfg = (apiCfg.apiServer ?? {}) as Record<string, unknown>
  const apiPort = Number(apiServerCfg.port ?? 0)
  const turnTimeout = Number(apiCfg.turnTimeoutSec ?? 120)
  const apiKeyEnv = envNameOf(apiServerCfg.apiKey ?? apiCfg.apiKey, 'api_server.api_key_env', warns) ?? 'OPS_API_KEY'
  const memoryCfg = (apiCfg.memory ?? {}) as Record<string, unknown>

  // 2) ops-app disable 层 → 归层
  const opsAppPath = join(home, 'bundles', 'ops-app', 'cordis.patch.yml')
  const disables = existsSync(opsAppPath) ? (loadYamlFile(opsAppPath) as PatchEntry[]) : []
  // packs 目录无片段 → 首次引导（启发式池 = 内置包名）；已有片段 → 按在盘片段归层
  const onDisk = existsSync(packsDir)
    ? (readdirSync(packsDir).filter((f) => f.endsWith('.yml')).map((f) => f.replace(/\.yml$/, '')))
    : []
  const firstRun = onDisk.length === 0
  const pool = firstRun ? ['core', 'file-ops', 'script', 'remote-exec'] : onDisk
  const classification: Record<string, string> = {}
  const overrides: Array<{ id: string; inject?: string[]; config?: unknown }> = []
  const coreIds: string[] = []
  const scriptIds: string[] = []
  const fileOpsIds: string[] = []
  for (const e of disables) {
    const id = e.id
    if (!id) continue
    const isOverride = e.disabled !== true
    const owner = isOverride ? 'core' : classify(id, pool)
    classification[owner] = [...(classification[owner] ?? []), id]
    if (isOverride) {
      overrides.push({ id, ...(e.inject ? { inject: e.inject } : {}), ...(e.config !== undefined ? { config: e.config } : {}) })
    } else if (owner === 'core') coreIds.push(id)
    else if (owner === 'script') scriptIds.push(id)
    else if (owner === 'file-ops') fileOpsIds.push(id)
  }
  const draftPacks: CapabilityPack[] = []
  if (firstRun) {
    draftPacks.push({
      pack: 'core', draft: true,
      description: 'subagent/workflow/goal/plan/web/桌面联动等编码 agent 能力 + 实例覆写（如 connection headless）',
      disable: { tools: coreIds, overrides: overrides.length ? overrides : undefined },
    })
    if (scriptIds.length) draftPacks.push({ pack: 'script', draft: true, description: '本机命令执行面（bash/terminal/run_code）', disable: { tools: scriptIds } })
    if (fileOpsIds.length) draftPacks.push({ pack: 'file-ops', draft: true, description: '文件读写能力', disable: { tools: fileOpsIds } })
    draftPacks.push({
      pack: 'remote-exec', draft: true,
      description: '不挂本机 bash/fs；执行面只走 MCP 远程通道（运维域勾选；本身无额外 disable 项）',
      disable: {},
    })
  }
  if (classification.unclassified?.length) {
    warns.push(`unclassified: ${classification.unclassified.join(', ')}（不猜，交人工归层）`)
  }

  // 3) preset / skills_dirs
  const presetName = String(apiCfg.preset ?? 'i2stream-ops')
  const presetFile = join(home, 'presets', presetName, 'agent.cordis.yml')
  let skillsDirs: string[] = []
  let presetSource = join(home, 'presets', presetName)
  if (existsSync(presetFile)) {
    const presetEntries = loadYamlFile(presetFile) as PatchEntry[]
    for (const e of presetEntries) {
      if (e.id === 'skill-filesystem') {
        skillsDirs = ((e.config as Record<string, unknown> | undefined)?.customSkillDirs as string[] | undefined) ?? []
      }
    }
  } else {
    warns.push(`preset 文件不存在: ${presetFile}（skills_dirs 置空，交人工补）`)
  }
  if (!skillsDirs.length && existsSync(join(home, 'skills'))) skillsDirs = [join(home, 'skills')]

  // 4) plugins（领域工具插件；ops-api 由 api_server 段自动注入不列）
  const plugins: Array<{ id: string; path: string }> = []
  for (const id of ['bkn-plugin', 'ops-skill-manager']) {
    const e = findInsert(profilePatch, id)
    if (e?.name) plugins.push({ id, path: String(e.name) })
  }

  // 5) headless 判定 → gui 端口
  const headless = disables.some((e) => e.id === 'webserver' && e.disabled === true)
  const ports: { gui?: number | null; api: number } = { api: apiPort }
  if (headless) ports.gui = null

  // 6) shared_deps：admin healthDeps + 记忆/检索基础设施常量登记
  const healthDeps = ((apiCfg.admin as Record<string, unknown> | undefined)?.healthDeps as Array<{ name: string; url: string }> | undefined) ?? []
  const sharedDeps = [...healthDeps]
  if (memoryCfg.enabled) sharedDeps.push({ name: 'memory-gateway', url: String(memoryCfg.gatewayUrl ?? 'http://127.0.0.1:8420') })

  const spec: DomainSpec = {
    schema: 1,
    domain: name,
    display_name: `DSH ${name} domain agent`,
    dsh_home: home,
    dsh_source: join(home, '..', 'deepseek-harness'),
    capabilities: ['remote-exec'],
    guard: { rule_source: 'bkn' },
    preset: { source: presetSource, skills_dirs: skillsDirs },
    plugins,
    api_server: {
      port: apiPort, api_key_env: apiKeyEnv, turn_timeout_sec: turnTimeout, max_task_duration_sec: turnTimeout,
      ...(opsApi?.name ? { plugin_path: String(opsApi.name), plugin_id: String(opsApi.id ?? 'ops-api') } : {}),
    },
    ...(memoryCfg.enabled ? { memory: { gateway_url: String(memoryCfg.gatewayUrl ?? 'http://127.0.0.1:8420'), session_keys: [] } } : {}),
    ports,
    ...(opts.unit ? { systemd_unit: opts.unit } : {}),
    shared_deps: sharedDeps,
  }
  return { spec, warns, classification: Object.fromEntries(Object.entries(classification).map(([k, v]) => [k, v])), overrides, draftPacks }
}
