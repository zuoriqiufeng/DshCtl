/**
 * diff.ts — 只读 diff。diffOpsApp：能力包 vs ops-app patch（规范化集合，忽略注释/顺序）；
 * diffDomain：四组生成面对账（子集语义——现状多余项记 note 不记差异）。
 * preset 面自 v0.1.7 声明式（上游 d1e22a7e24）：第 ④ 组对账「作者源 ↔ profile patch 声明行」。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadYamlText, dumpYaml, loadYamlFile } from './yml.ts'
import { mergePacks, loadPacks } from './packs.ts'
import type { DomainSpec } from './domain.ts'
import { presetIdOf, PRESET_DECL_NAME } from './preset.ts'

interface PatchEntry { id?: string; name?: string; disabled?: boolean; inject?: string[]; config?: unknown; insert?: PatchEntry[] }

function canon(e: PatchEntry): string {
  if (!e.id) return `#noname:${JSON.stringify(e)}`
  if (e.disabled === true) return `${e.id}|disabled=true`
  const parts: string[] = []
  if (e.inject !== undefined) parts.push(`inject=${JSON.stringify(e.inject)}`)
  if (e.config !== undefined) parts.push(`config=${JSON.stringify(e.config)}`)
  return parts.length ? `${e.id}|${parts.join(' ')}` : `${e.id}|`
}

function setDiff(from: string[], to: string[]): { removed: string[]; added: string[] } {
  const f = new Set(from)
  const t = new Set(to)
  return { removed: [...f].filter((x) => !t.has(x)).sort(), added: [...t].filter((x) => !f.has(x)).sort() }
}

export interface DiffReport {
  empty: boolean
  lines: string[] // 差异行；empty 时为空
  notes: string[] // 子集语义注记（现状多余项等，不算差异）
}

/** v0.1：对比「能力包拼接的 disable 集」与「实例 ops-app patch 现状」 */
export function diffOpsApp(home: string, packsDir: string, capabilities: string[]): { empty: boolean; lines: string[] } {
  const currentPath = join(home, 'bundles', 'ops-app', 'cordis.patch.yml')
  const current = existsSync(currentPath) ? (loadYamlText(readFileSync(currentPath, 'utf8')) as PatchEntry[]) : []
  const packs = loadPacks(packsDir)
  const { entries, errors } = mergePacks(packs, capabilities)
  const lines: string[] = []
  for (const e of errors) lines.push(`! ${e}`)
  const { removed, added } = setDiff(current.map(canon).sort(), entries.map(canon).sort())
  for (const r of removed) lines.push(`- ${r}   (现状有、清单无)`)
  for (const a of added) lines.push(`+ ${a}   (清单有、现状无)`)
  return { empty: lines.length === 0, lines }
}

/** 收集 patch 顶层与 insert 内的全部 id */
function allIds(entries: PatchEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.id) out.push(e.id)
    for (const s of e.insert ?? []) if (s.id) out.push(s.id)
  }
  return out
}

/** v0.2：apply 生成面对账（四组，子集语义） */
export function diffDomain(spec: DomainSpec, packsDir: string): DiffReport {
  const lines: string[] = []
  const notes: string[] = []
  const home = spec.dsh_home
  const domain = spec.domain

  const a = diffOpsApp(home, packsDir, spec.capabilities ?? [])
  lines.push(...a.lines)

  const manifestPath = join(home, 'profiles', domain, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      const got = m.dsh?.profile?.bundles ?? []
      const want = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-ops-app']
      const { removed, added } = setDiff(got, want)
      for (const r of removed) lines.push(`- manifest bundles: ${r}   (现状有、清单无)`)
      for (const x of added) lines.push(`+ manifest bundles: ${x}   (清单有、现状无)`)
    } catch { lines.push(`! manifest 解析失败: ${manifestPath}`) }
  } else {
    lines.push(`- manifest 缺失: profiles/${domain}/package.json   (apply 将创建)`)
  }

  const api = spec.api_server
  const pid = presetIdOf(spec)
  const wantIds = [...(spec.plugins ?? []).map((p) => p.id), api?.plugin_id ?? 'domain-api', 'agent-preset-registry', `preset-${pid}`]
  const patchPath = join(home, 'profiles', domain, 'cordis.patch.yml')
  const patchEntries = existsSync(patchPath) ? (loadYamlText(readFileSync(patchPath, 'utf8')) as PatchEntry[]) : null
  if (patchEntries) {
    const got = new Set(allIds(patchEntries))
    for (const id of wantIds) if (!got.has(id)) lines.push(`- profile patch 缺 insert: ${id}   (apply 管理面)`)
    const extra = [...got].filter((id) => !wantIds.includes(id))
    if (extra.length) notes.push(`profile patch 现状多余 id（非 apply 生成面，忽略）: ${extra.join(', ')}`)
  } else {
    lines.push(`- profile patch 缺失: profiles/${domain}/cordis.patch.yml   (apply 将创建)`)
  }

  // ④ preset 声明一致性（v0.1.7 声明式：作者源 agent.cordis.yml ↔ profile patch 声明行 config.plugins）
  const src = spec.preset?.source
  if (!src || !existsSync(join(src, 'agent.cordis.yml'))) {
    lines.push(`+ preset 作者源缺失（${src ?? '未声明'}/agent.cordis.yml）   (apply 将报错)`)
  } else if (patchEntries) {
    const decl = patchEntries.flatMap((e) => e.insert ?? []).find((r) => r.name === PRESET_DECL_NAME)
    if (!decl) lines.push(`- profile patch 缺 preset 声明行   (apply 管理面)`)
    else {
      const srcNorm = dumpYaml(loadYamlFile(join(src, 'agent.cordis.yml')))
      const declNorm = dumpYaml((decl.config as Record<string, unknown> | undefined)?.plugins)
      if (srcNorm !== declNorm) lines.push(`! preset 声明行与作者源不一致（改 agent.cordis.yml 后需 re-apply）`)
    }
  }

  return { empty: lines.length === 0, lines, notes }
}
