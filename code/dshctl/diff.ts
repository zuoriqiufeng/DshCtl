/**
 * diff.ts — 只读 diff。diffOpsApp：能力包 vs ops-app patch（规范化集合，忽略注释/顺序）；
 * diffDomain：四组生成面对账（子集语义——现状多余项记 note 不记差异）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { loadYamlText } from './yml.ts'
import { mergePacks, loadPacks } from './packs.ts'
import type { DomainSpec } from './domain.ts'

interface PatchEntry { id?: string; disabled?: boolean; inject?: string[]; config?: unknown; insert?: PatchEntry[] }

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

/** 递归列出目录下相对文件路径集合（presets 文件清单对比用） */
function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) out.push(...listFiles(p, base))
    else out.push(relative(base, p))
  }
  return out.sort()
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
  const wantIds = [...(spec.plugins ?? []).map((p) => p.id), api?.plugin_id ?? 'domain-api', 'agent-presets']
  const patchPath = join(home, 'profiles', domain, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const got = new Set(allIds(loadYamlText(readFileSync(patchPath, 'utf8')) as PatchEntry[]))
    for (const id of wantIds) if (!got.has(id)) lines.push(`- profile patch 缺 insert: ${id}   (apply 管理面)`)
    const extra = [...got].filter((id) => !wantIds.includes(id))
    if (extra.length) notes.push(`profile patch 现状多余 id（非 apply 生成面，忽略）: ${extra.join(', ')}`)
  } else {
    lines.push(`- profile patch 缺失: profiles/${domain}/cordis.patch.yml   (apply 将创建)`)
  }

  // ④ presets 文件清单（preset.source 已在 DSH_HOME 内时视为自源自比——adopt 记录的即实例目录）
  const src = spec.preset?.source
  const srcInsideHome = !!src && resolve(src).startsWith(resolve(home) + '/')
  const dst = srcInsideHome ? src : join(home, 'presets', domain)
  if (src && existsSync(src)) {
    const srcFiles = listFiles(src)
    const dstFiles = existsSync(dst) ? listFiles(dst) : []
    const { removed, added } = setDiff(dstFiles, srcFiles)
    for (const r of removed) lines.push(`- presets 多余文件: ${r}`)
    for (const x of added) lines.push(`+ presets 缺文件: ${x}`)
  }

  return { empty: lines.length === 0, lines, notes }
}
