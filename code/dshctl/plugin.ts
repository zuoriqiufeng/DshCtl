/**
 * plugin.ts — 插件库：登记/收编/发布/信任位（登记引用为主，导入件落 sources/）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { loadYamlText, dumpYaml, atomicWrite } from './yml.ts'
import type { DomainSpec } from './domain.ts'

export interface PluginEntry {
  id: string
  name?: string
  description?: string
  tier?: 'core' | 'extension'
  /** local=引用原地源码；sources=库内拷贝（zip/git 导入） */
  source?: 'local' | 'sources' | 'git'
  /** 插件入口文件绝对路径（patch insert.name 直接可用） */
  path: string
  /** git/zip 导入默认 false；人工信任后 check R12 才静默 */
  trusted: boolean
  /** 可选依赖声明（编排画布细粒度边；不校验目标存在） */
  depends_on?: string[]
  /** 对外提供的工具/能力清单（详情展示） */
  provides?: string[]
  /** 分类（插件目录分组展示；缺省归「其他」） */
  category?: string
  added_at?: string
}

export interface PluginRegistry { schema: number; plugins: PluginEntry[] }

/** registry.yml 序列化（savePluginRegistry 与预演 diff 虚拟写共用，保证逐字节一致） */
export function renderPluginRegistry(reg: PluginRegistry): string {
  return `# plugin-registry/registry.yml —— 插件库目录（schema:1）；登记引用为主，导入件落 sources/\n${dumpYaml(reg)}`
}

/**
 * 包名式路径判型：`@scope/pkg` 或无路径分隔符的裸名 = 上游包引用（patch insert.name 裸 import），
 * 不做 existsSync 检查；`/abs`、`./rel` 等带路径形态仍要求入口文件存在。
 */
export function isPackagePath(p: string): boolean {
  return p.startsWith('@') || (!p.includes('/') && !p.startsWith('.'))
}

export function loadPluginRegistry(path: string): PluginRegistry {
  if (!existsSync(path)) return { schema: 1, plugins: [] }
  const raw = loadYamlText(readFileSync(path, 'utf8')) as Partial<PluginRegistry> | null
  return { schema: raw?.schema ?? 1, plugins: raw?.plugins ?? [] }
}

export function savePluginRegistry(path: string, reg: PluginRegistry): void {
  atomicWrite(path, renderPluginRegistry(reg))
}

export interface AddResult { ok: boolean; errors: string[]; entry?: PluginEntry }

/** 收编：id 唯一 + 入口文件存在；trusted 默认 local=true / sources|git=false */
export function addPlugin(reg: PluginRegistry, e: { id: string; path: string; name?: string; description?: string; source?: PluginEntry['source']; trusted?: boolean }): AddResult {
  const errors: string[] = []
  if (!/^[a-z][a-z0-9-]*$/.test(e.id)) errors.push(`id '${e.id}' 非法（须 ^[a-z][a-z0-9-]*$）`)
  if (reg.plugins.some((p) => p.id === e.id)) errors.push(`id '${e.id}' 已登记`)
  if (!isPackagePath(e.path) && !existsSync(e.path)) errors.push(`入口文件不存在: ${e.path}`)
  if (errors.length) return { ok: false, errors }
  const source = e.source ?? 'local'
  const entry: PluginEntry = {
    id: e.id, ...(e.name ? { name: e.name } : {}), ...(e.description ? { description: e.description } : {}),
    tier: 'extension', source, path: e.path,
    trusted: e.trusted ?? source === 'local',
    added_at: new Date().toISOString().slice(0, 10),
  }
  reg.plugins.push(entry)
  return { ok: true, errors: [], entry }
}

export function removePlugin(reg: PluginRegistry, id: string): boolean {
  const i = reg.plugins.findIndex((p) => p.id === id)
  if (i < 0) return false
  reg.plugins.splice(i, 1)
  return true
}

export function setTrusted(reg: PluginRegistry, id: string, trusted: boolean): boolean {
  const p = reg.plugins.find((x) => x.id === id)
  if (!p) return false
  p.trusted = trusted
  return true
}

/** 领域产出一键入库：plugins[] + api_server.plugin_id/plugin_path（已存在跳过） */
export function publishDomain(reg: PluginRegistry, spec: DomainSpec): { added: string[]; skipped: string[]; errors: string[] } {
  const added: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const refs = [...(spec.plugins ?? []),
    ...(spec.api_server?.plugin_id && spec.api_server?.plugin_path ? [{ id: spec.api_server.plugin_id, path: spec.api_server.plugin_path }] : [])]
  for (const r of refs) {
    if (reg.plugins.some((p) => p.id === r.id)) { skipped.push(r.id); continue }
    const res = addPlugin(reg, { id: r.id, path: r.path })
    if (res.ok) added.push(r.id)
    else errors.push(...res.errors.map((x) => `${r.id}: ${x}`))
  }
  return { added, skipped, errors }
}

/** 领域引用的全部插件（plugins[] + api_server 插件） */
export function domainPluginRefs(spec: DomainSpec): Array<{ id: string; path: string }> {
  return [...(spec.plugins ?? []),
    ...(spec.api_server?.plugin_id && spec.api_server?.plugin_path ? [{ id: spec.api_server.plugin_id, path: spec.api_server.plugin_path }] : [])]
}

/** R12：领域插件引用与库对齐（missing/path 漂移 → error；untrusted → warn） */
export function checkDomainPlugins(spec: DomainSpec, reg: PluginRegistry): Array<{ level: 'error' | 'warn' | 'pass'; msg: string }> {
  const out: Array<{ level: 'error' | 'warn' | 'pass'; msg: string }> = []
  const refs = domainPluginRefs(spec)
  for (const r of refs) {
    const e = reg.plugins.find((p) => p.id === r.id)
    if (!e) { out.push({ level: 'error', msg: `插件 '${r.id}' 不在插件库（dshctl plugin add --id ${r.id} --path ${r.path}）` }); continue }
    if (e.path !== r.path) { out.push({ level: 'error', msg: `插件 '${r.id}' path 漂移：领域=${r.path} 库=${e.path}` }); continue }
    if (!e.trusted) { out.push({ level: 'warn', msg: `插件 '${r.id}' 未信任（git/zip 导入件需人工信任：dshctl plugin trust ${r.id}）` }); continue }
    out.push({ level: 'pass', msg: `插件 '${r.id}' 与库对齐（${e.source}）` })
  }
  if (!refs.length) out.push({ level: 'pass', msg: '领域未引用插件' })
  return out
}
