/**
 * import.ts — 插件库导入通道：zip 上传（CLI 本地 zip / GUI base64）+ git clone。
 * 安全：zip-slip 路径过滤 + 大小/文件数上限；git 失败给网络前提提示（诚实原则）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, rmSync, mkdirSync, readdirSync, readFileSync, renameSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { addPlugin, type PluginRegistry, type AddResult } from './plugin.ts'

export const ZIP_MAX_BYTES = 50 * 1024 * 1024
export const ZIP_MAX_ENTRIES = 2000
/** 解压后总字节上限（zip 炸弹防护——压缩率可上千倍，压缩包大小不等于展开大小） */
export const ZIP_MAX_UNCOMPRESSED = 200 * 1024 * 1024
export const GIT_MAX_BYTES = 200 * 1024 * 1024

/** 列 zip 条目（zipinfo -1）；任何 shell 元数据不进解析——参数数组调用 */
function listZip(zipPath: string): string[] {
  const out = execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** zip 展开总字节（zipinfo -t 尾行 "N files, X bytes uncompressed"）——防解压炸弹 */
function zipUncompressedBytes(zipPath: string): number {
  const out = execFileSync('zipinfo', ['-t', zipPath], { encoding: 'utf8', timeout: 30_000 })
  const m = /([\d,]+) bytes uncompressed/.exec(out)
  return m ? Number(m[1]!.replace(/,/g, '')) : Number.NaN
}

/** 解压后逐条目 realpath 校验：符号链接/硬链接逃逸出目标目录 → 拒绝（v0.4 只做名字层，v0.5 补落地层） */
function assertNoEscape(dest: string): void {
  const stack = [dest]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const fp = join(cur, e.name)
      if (e.isSymbolicLink()) {
        const real = realpathSync(fp)
        if (!real.startsWith(resolve(dest) + '/') && real !== resolve(dest)) throw new Error(`symlink 逃逸: ${relative(dest, fp)} → ${real}`)
        continue
      }
      if (e.isDirectory()) stack.push(fp)
    }
  }
}

/** 目录总字节（git 通道深拷后的尺寸闸） */
function dirBytes(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const fp = join(cur, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) stack.push(fp)
      else total += statSync(fp).size
    }
  }
  return total
}

/**
 * GitHub 式 zip 归位：解包后根上没有 package.json / 入口候选，且只有唯一顶层目录时，
 * 把该目录内容上提一层（否则 entry 探测永远失配，用户得手工数层级）。
 */
function reRootIfSingleDir(dest: string): boolean {
  const rootHasEntry = existsSync(join(dest, 'package.json')) || readdirSync(dest).some((f) => f.endsWith('.ts'))
  if (rootHasEntry) return false
  const tops = readdirSync(dest, { withFileTypes: true })
  const dirs = tops.filter((d) => d.isDirectory())
  if (dirs.length !== 1 || tops.length !== 1) return false
  const inner = join(dest, dirs[0]!.name)
  for (const e of readdirSync(inner)) renameSync(join(inner, e), join(dest, e))
  rmSync(inner, { recursive: true, force: true })
  return true
}

/** entry 自动探测：package.json 的 main（须存在）→ index.ts → 唯一 *.ts */
function detectEntry(dest: string): string | undefined {
  const pkgPath = join(dest, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: string }
      if (pkg.main && existsSync(join(dest, pkg.main))) return pkg.main
    } catch { /* 坏 package.json 不挡导入——回落探测 */ }
  }
  if (existsSync(join(dest, 'index.ts'))) return 'index.ts'
  const ts = readdirSync(dest).filter((f) => f.endsWith('.ts'))
  return ts.length === 1 ? ts[0] : undefined
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
  const rawBytes = zipUncompressedBytes(zipPath)
  if (!Number.isNaN(rawBytes) && rawBytes > ZIP_MAX_UNCOMPRESSED) return { ok: false, errors: [`zip 展开超限: ${rawBytes} bytes > ${ZIP_MAX_UNCOMPRESSED}（解压炸弹防护）`] }
  if (reg.plugins.some((p) => p.id === meta.id)) return { ok: false, errors: [`id '${meta.id}' 已登记`] }
  const dest = join(sourcesDir, meta.id)
  if (existsSync(dest)) return { ok: false, errors: [`目标已存在: ${dest}`] }
  mkdirSync(sourcesDir, { recursive: true })
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest], { timeout: 60_000, maxBuffer: 1024 })
    assertNoEscape(dest)
    reRootIfSingleDir(dest)
  } catch (e) {
    rmSync(dest, { recursive: true, force: true })
    return { ok: false, errors: [`unzip 失败: ${String((e as Error).message).slice(0, 120)}`] }
  }
  const entryRel = meta.entry ?? detectEntry(dest)
  if (!entryRel) { rmSync(dest, { recursive: true, force: true }); return { ok: false, errors: ['入口探测失败：根上无 package.json main / index.ts / 唯一 *.ts——用 --entry 显式指定'] } }
  const entryFile = join(dest, entryRel)
  if (!existsSync(entryFile)) { rmSync(dest, { recursive: true, force: true }); return { ok: false, errors: [`入口不存在: ${entryRel}`] } }
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
  const r = addPlugin(reg, { id: meta.id, path: join(dest, meta.entry ?? detectEntry(dest) ?? 'index.ts'), ...(meta.name ? { name: meta.name } : {}), ...(meta.description ? { description: meta.description } : {}), source: 'git' })
  if (!r.ok) { rmSync(dest, { recursive: true, force: true }); return r }
  if (dirBytes(dest) > GIT_MAX_BYTES) { rmSync(dest, { recursive: true, force: true }); removePlugin(reg, meta.id); return { ok: false, errors: [`克隆体积超限 > ${GIT_MAX_BYTES}`] } }
  save()
  return r
}
