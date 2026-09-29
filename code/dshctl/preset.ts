/**
 * preset.ts — agent preset 的作者源读取与 id 推导（dshctl v1.6，声明式机制）。
 *
 * 上游 v0.1.7（commit d1e22a7e24）移除了目录式 preset（`@deepseek-ai/dsh-agent-presets`
 * 包整体删除、registry Config 不再接受 roots/trust），preset 改为 profile patch 里的
 * 声明行：`- insert: [{id: preset-<id>, name: '@deepseek-ai/dsh-agent-preset',
 * config: {id, name?, description?, order?, plugins}}]`。
 *
 * 作者源（domain.yml `preset.source` 目录）仍是内容的事实来源：`preset.yml` 提供显示
 * 元数据，`agent.cordis.yml` 提供 plugins 组合（顶层插件行列表）。apply 时把两者内联进
 * profile patch 声明行——**原文缩进内嵌，不做 YAML 往返**，以保真 `!!js` 表达式与注释。
 * 改作者源后需 re-apply 才生效。
 */
import { readFileSync, existsSync } from 'node:fs'
import { basename, resolve, join } from 'node:path'
import { loadYamlFile } from './yml.ts'
import type { DomainSpec } from './domain.ts'

export const PRESET_ID_RE = /^[a-z][a-z0-9-]*$/

/** v0.1.7 声明式 preset 的插件名（profile patch 声明行的 name 字段） */
export const PRESET_DECL_NAME = '@deepseek-ai/dsh-agent-preset'

/** 声明式 preset 的显示元数据（来自作者源 preset.yml，全部可选） */
export interface PresetMeta {
  name?: string
  description?: string
  order?: number
}

/** 交给 renderProfilePatch 的声明输入：id + 元数据 + plugins 组合原文 */
export interface PresetDecl {
  id: string
  meta: PresetMeta
  /** agent.cordis.yml 原文（逐行原样，供缩进内嵌保真 `!!js`/注释） */
  pluginsRaw: string
}

/**
 * preset id 推导：显式 `preset.id` > 作者源目录名 > 域名。
 * 目录名即内容身份（与 3080 现网 `preset: i2stream-ops` 口径一致）。
 */
export function presetIdOf(spec: DomainSpec): string {
  const explicit = spec.preset?.id?.trim()
  if (explicit) return explicit
  const dir = spec.preset?.source ? basename(resolve(spec.preset.source)) : ''
  if (dir && dir !== '.' && dir !== '/' && dir !== '..') return dir
  return spec.domain
}

/**
 * 读取作者源 → 声明输入。fail-loud：
 * - 源目录 / agent.cordis.yml 缺失、非顶层插件行列表、含 tab → 返回 error（调用方入 errors 或 R14）
 */
export function loadPresetDeclaration(source: string, id: string): { decl?: PresetDecl; error?: string } {
  const dir = resolve(source)
  if (!existsSync(dir)) return { error: `preset 作者源目录不存在: ${dir}（v0.1.7 声明式机制需要它生成声明行）` }
  if (!PRESET_ID_RE.test(id)) return { error: `preset id '${id}' 非法（须匹配 ${PRESET_ID_RE.source}）` }

  const compPath = join(dir, 'agent.cordis.yml')
  if (!existsSync(compPath)) return { error: `preset 组合文件缺失: ${compPath}` }
  const raw = readFileSync(compPath, 'utf8')
  if (raw.includes('\t')) return { error: `preset 组合含 tab 缩进，拒绝内嵌: ${compPath}` }

  const first = raw.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'))
  if (first === undefined || !/^- /.test(first)) {
    return { error: `preset 组合不是顶层插件行列表（首行须以 "- " 开头）: ${compPath}` }
  }

  const meta: PresetMeta = {}
  const metaPath = join(dir, 'preset.yml')
  if (existsSync(metaPath)) {
    const m = loadYamlFile(metaPath) as Record<string, unknown> | null
    if (typeof m?.name === 'string' && m.name.trim()) meta.name = m.name
    if (typeof m?.description === 'string' && m.description.trim()) meta.description = m.description
    if (typeof m?.order === 'number') meta.order = m.order
  }
  return { decl: { id, meta, pluginsRaw: raw } }
}
