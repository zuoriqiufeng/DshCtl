/**
 * import.ts — 插件库导入通道：zip 上传（CLI 本地 zip / GUI base64）+ git clone。
 * 安全：zip-slip 路径过滤 + 大小/文件数上限；git 失败给网络前提提示（诚实原则）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { addPlugin, type PluginRegistry, type AddResult } from './plugin.ts'

export const ZIP_MAX_BYTES = 50 * 1024 * 1024
export const ZIP_MAX_ENTRIES = 2000

/** 列 zip 条目（zipinfo -1）；任何 shell 元数据不进解析——参数数组调用 */
function listZip(zipPath: string): string[] {
  const out = execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** zip-slip 判定：绝对路径 / `..` 段 / 反斜杠绕过 → 拒绝 */
export function zipEntryUnsafe(name: string): boolean {
  const n = name.replace(/\\/g, '/')
  return n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..')
}

export interface ImportMeta { id: string; name?: string; description?: string; /** 入口相对 sources/<id>/ 的路径，默认 index.ts */ entry?: string }

/** zip → sources/<id>/ 收编（untrusted）。sourcesDir = plugin-registry/sources */
export function importFromZip(zipPath: string, reg: PluginRegistry, sourcesDir: string, meta: ImportMeta, save: () => void): AddResult {
  if (!existsSync(zipPath)) return { ok: false, errors: [`zip 不存在: ${zipPath}`] }
  const size = statSync(zipPath).size
  if (size > ZIP_MAX_BYTES) return { ok: false, errors: [`zip 超限: ${size} bytes > ${ZIP_MAX_BYTES}`] }
  let entries: string[]
  try { entries = listZip(zipPath) } catch (e) { return { ok: false, errors: [`zip 解析失败: ${(e as Error).message.slice(0, 120)}`] } }
  if (entries.length > ZIP_MAX_ENTRIES) return { ok: false, errors: [`zip 条目超限: ${entries.length} > ${ZIP_MAX_ENTRIES}`] }
  const bad = entries.find(zipEntryUnsafe)
  if (bad) return { ok: false, errors: [`zip-slip 拒绝（非法条目路径）: ${bad}`] }
  if (reg.plugins.some((p) => p.id === meta.id)) return { ok: false, errors: [`id '${meta.id}' 已登记`] }
  const dest = join(sourcesDir, meta.id)
  if (existsSync(dest)) return { ok: false, errors: [`目标已存在: ${dest}`] }
  mkdirSync(sourcesDir, { recursive: true })
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest], { timeout: 60_000, maxBuffer: 1024 })
  } catch (e) {
    rmSync(dest, { recursive: true, force: true })
    return { ok: false, errors: [`unzip 失败: ${(e as Error).message.slice(0, 120)}`] }
  }
  const entryFile = join(dest, meta.entry ?? 'index.ts')
  const r = addPlugin(reg, { id: meta.id, path: entryFile, ...(meta.name ? { name: meta.name } : {}), ...(meta.description ? { description: meta.description } : {}), source: 'sources' })
  if (!r.ok) { rmSync(dest, { recursive: true, force: true }); return r }
  save()
  return r
}

/** git clone --depth 1 → sources/<id>/（untrusted）。本环境 github 不可达时错误含网络前提提示 */
export function importFromGit(url: string, reg: PluginRegistry, sourcesDir: string, meta: ImportMeta & { ref?: string }, save: () => void): AddResult {
  if (reg.plugins.some((p) => p.id === meta.id)) return { ok: false, errors: [`id '${meta.id}' 已登记`] }
  if (!/^https?:\/\/|^git@/.test(url)) return { ok: false, errors: [`url 非法（须 http(s):// 或 git@）: ${url}`] }
  const dest = join(sourcesDir, meta.id)
  if (existsSync(dest)) return { ok: false, errors: [`目标已存在: ${dest}`] }
  mkdirSync(sourcesDir, { recursive: true })
  try {
    execFileSync('git', ['clone', '--depth', '1', ...(meta.ref ? ['--branch', meta.ref] : []), url, dest], { timeout: 120_000, maxBuffer: 1024 * 1024 })
  } catch (e) {
    rmSync(dest, { recursive: true, force: true })
    const msg = (e as Error).message.slice(0, 200)
    return { ok: false, errors: [`git clone 失败: ${msg}。网络前提：本环境实测 github.com HTTPS 不可达——需代理/中转或改用 zip 通道（dshctl plugin import）`] }
  }
  const r = addPlugin(reg, { id: meta.id, path: join(dest, meta.entry ?? 'index.ts'), ...(meta.name ? { name: meta.name } : {}), ...(meta.description ? { description: meta.description } : {}), source: 'git' })
  if (!r.ok) { rmSync(dest, { recursive: true, force: true }); return r }
  save()
  return r
}
