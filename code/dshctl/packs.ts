/**
 * packs.ts — 能力包片段：加载、归属启发式（家族名任意位置）、两段式拼接
 * （core 隐含必裁；keep_tools 从 core disable"放回"；同 id 多片段报错；overrides 原样保留）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadYamlText, dumpYaml } from './yml.ts'

export interface PackBody {
  tools?: string[]
  keep_tools?: string[]
  skills?: string[]
  commands?: string[]
  surfaces?: string[]
  mcp?: string[]
  /** 非纯 disable 的覆写条目（如 connection: inject:[] + config 覆写），原样保留 */
  overrides?: Array<{ id: string; inject?: string[]; config?: unknown }>
  [k: string]: unknown
}

export interface CapabilityPack {
  pack: string
  description?: string
  draft?: boolean
  disable: PackBody
}

export function loadPack(path: string): CapabilityPack {
  const raw = loadYamlText(readFileSync(path, 'utf8')) as CapabilityPack
  if (!raw.pack) throw new Error(`${path}: missing pack:`)
  return { ...raw, draft: /# 状态：DRAFT|# DRAFT:/.test(readFileSync(path, 'utf8')) }
}

export function loadPacks(dir: string): CapabilityPack[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f) => loadPack(join(dir, f)))
}

/** 归属启发式（设计 §5 F1）：id 前缀/分类 → 片段名；匹配不上 → 'unclassified' */
export function classify(id: string, packNames: string[]): string {
  const has = (n: string) => packNames.includes(n)
  if (has('core') && /^(subagent|workflow|goal|plan|ui-|open-in-app|session-log|client-hmr|webserver$|web-runtime$|connection$|message-feedback$|ui-trajectory|directory-picker)/.test(id)) return 'core'
  // 家族名在任意位置（tool-subagent-* / command-goal / tool-workflow 等）→ core
  if (has('core') && /(^|[-_])(subagent|workflow|goal|plan)([-_]|$)/.test(id)) return 'core'
  if (has('core') && /(web|feedback|trajectory|desktop|download)/.test(id) && !/file|terminal|bash/.test(id)) return 'core'
  if (has('file-ops') && /(read|write|edit|file-|workspace-files)/.test(id)) return 'file-ops'
  if (has('script') && /(bash|terminal|run_code)/.test(id)) return 'script'
  return 'unclassified'
}

/** 片段拼接为统一 disable id 清单（含 override 原样条目）；同 id 多片段 → 错。
 * 核心层（core）为所有领域必裁层，始终隐含参与拼接（domain.yml 的 capabilities 无需声明）。
 * keep_tools 语义（设计 §7.1）：勾选能力包时把 core 的对应 disable"放回"——两段式：
 * 先收集全部 disable/override（disable 间重名报错），再用 keep_tools 从结果中移除。 */
export function mergePacks(packs: CapabilityPack[], picked: string[]): { entries: Array<{ id: string; disabled?: boolean; inject?: string[]; config?: unknown }>; errors: string[] } {
  const errors: string[] = []
  const seen = new Map<string, string>()
  const entries: Array<{ id: string; disabled?: boolean; inject?: string[]; config?: unknown }> = []
  const order = ['core', ...picked.filter((p) => p !== 'core')]
  const keeps: Array<{ id: string; pack: string }> = []
  for (const name of [...order].sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)))) {
    const p = packs.find((x) => x.pack === name)
    if (!p) { errors.push(`能力包片段不存在: ${name}.yml`); continue }
    const d = p.disable ?? {}
    for (const key of ['tools', 'skills', 'commands', 'surfaces', 'mcp'] as const) {
      for (const id of (d[key] as string[] | undefined) ?? []) {
        const prev = seen.get(id)
        if (prev && prev !== name) errors.push(`id '${id}' 同时出现在能力包 ${prev} 与 ${name}（归属必须唯一）`)
        if (!prev) { seen.set(id, name); entries.push({ id, disabled: true }) }
      }
    }
    for (const id of d.keep_tools ?? []) keeps.push({ id, pack: name })
    for (const ov of d.overrides ?? []) {
      const prev = seen.get(ov.id)
      if (prev && prev !== name) errors.push(`id '${ov.id}'（override）同时出现在 ${prev} 与 ${name}`)
      if (!prev) { seen.set(ov.id, name); entries.push({ id: ov.id, ...(ov.inject ? { inject: ov.inject } : {}), ...(ov.config !== undefined ? { config: ov.config } : {}) }) }
    }
  }
  // keep_tools：从 disable 结果中"放回"（override 不受 keep 影响——覆写是独立语义）
  for (const k of keeps) {
    const i = entries.findIndex((e) => e.id === k.id && e.disabled === true)
    if (i >= 0) { entries.splice(i, 1); seen.delete(k.id) }
  }
  return { entries, errors }
}

export function renderPackYml(p: CapabilityPack): string {
  const head = [
    `# capability-packs/${p.pack}.yml`,
    `# ${p.description ?? ''}`,
    ...(p.draft ? ['# 状态：DRAFT（adopt 引导产出，待人工审层）→ 人工审层后删除本行即定稿'] : []),
  ].join('\n')
  return `${head}\n${dumpYaml({ pack: p.pack, disable: p.disable })}`
}
