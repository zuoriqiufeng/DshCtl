/**
 * unitize.ts — 插件单元化（v0.5）：dsh.plugin.yml 自描述 / scaffold / pack（tsc 构建 lib + tgz）/ install。
 * 单元 = 插件目录：自描述（dsh.plugin.yml）+ 完整 package.json + 可选构建产物 lib/。
 * 两种布局（插件自选，写在 dsh.plugin.yml.layout）：
 *   in-place  源码原地——patch 指工作区路径（改源码即生效；现有三插件模式）
 *   vendored  装配拷贝进 $DSH_HOME/plugins/<id>/——profile+插件整体可搬移（新导入件默认）
 * 构建链：tsc --rewriteRelativeImportExtensions（TS≥5.7，把 ./x.ts 相对导入重写为 .js 产物），
 * tsc 二进制取自 dsh_source（harness 已装 6.0.3；dshctl 自身零新增依赖）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { loadYamlText, dumpYaml, atomicWrite } from './yml.ts'
import type { DomainSpec } from './domain.ts'
import type { PluginRegistry } from './plugin.ts'

export const MANIFEST_FILE = 'dsh.plugin.yml'

export interface PluginManifest {
  schema: 1
  id: string
  /** 入口相对插件目录（默认 index.ts） */
  entry: string
  layout: 'in-place' | 'vendored'
  description?: string
  /** install 时写入 domain.yml plugins[] 的 config 模板——必须纯值（禁 !!js，见 manifestWarnings） */
  config?: unknown
  provides?: string[]
  category?: string
}

export function manifestPath(pluginDir: string): string {
  return join(pluginDir, MANIFEST_FILE)
}

export function loadPluginManifest(pluginDir: string): PluginManifest | null {
  const p = manifestPath(pluginDir)
  if (!existsSync(p)) return null
  const raw = loadYamlText(readFileSync(p, 'utf8')) as Partial<PluginManifest> | null
  if (!raw || raw.schema !== 1 || !raw.id) return null
  return { schema: 1, id: raw.id, entry: raw.entry ?? 'index.ts', layout: raw.layout ?? 'in-place', ...(raw.description ? { description: raw.description } : {}), ...(raw.config !== undefined ? { config: raw.config } : {}), ...(raw.provides?.length ? { provides: raw.provides } : {}), ...(raw.category ? { category: raw.category } : {}) }
}

export function savePluginManifest(pluginDir: string, m: PluginManifest): void {
  const header = `# ${MANIFEST_FILE} —— 插件自描述（schema:1）；profile 装配的元数据来源（dshctl plugin install 消费）\n# layout: in-place=源码原地（patch 指工作区路径，改源码即生效）| vendored=装配拷贝进 DSH_HOME/plugins/<id>/\n`
  atomicWrite(manifestPath(pluginDir), header + dumpYaml(m))
}

/** config 含 !!js（对 manifest 原文检测）则 install 不回写 domain.yml——loadYamlText 会丢 tag 语义，回写即失真 */
export function manifestConfigPlain(pluginDir: string, m: PluginManifest): boolean {
  if (m.config === undefined) return true
  const raw = readFileSync(manifestPath(pluginDir), 'utf8')
  return !raw.includes('!!js')
}

/** 扫插件目录 *.ts 的外部包 import（@scope/pkg / 裸名），相对路径忽略——peerDependencies 采集 */
export function collectPeerDeps(dir: string): string[] {
  const out = new Set<string>()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'lib' || e.name.startsWith('.')) continue
      const fp = join(d, e.name)
      if (e.isDirectory()) { walk(fp); continue }
      if (!e.name.endsWith('.ts')) continue
      const src = readFileSync(fp, 'utf8')
      for (const m of src.matchAll(/(?:from\s+|import\s+)['"]([^'"]+)['"]/g)) {
        const spec = m[1]!
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
        if (pkg) out.add(pkg)
      }
    }
  }
  walk(dir)
  return [...out].sort()
}

export interface ScaffoldResult { dir: string; manifest: PluginManifest; createdManifest: boolean; pkgChanges: string[]; warnings: string[]; errors: string[] }

/**
 * scaffold：把插件目录补成自描述单元。
 * ① dsh.plugin.yml（缺则生成；config 尽力从现网生成 patch 回填——原文含 !!js 时跳过并告警）
 * ② package.json 补全：main/exports/files/type/peerDependencies（不覆盖既有键；peerDeps 从 import 采集）
 */
export function scaffoldPlugin(reg: PluginRegistry, pluginId: string, domainsDir: string, opts: { layout?: 'in-place' | 'vendored' } = {}): ScaffoldResult {
  const errors: string[] = []
  const warnings: string[] = []
  const pkgChanges: string[] = []
  const entry = reg.plugins.find((x) => x.id === pluginId)
  if (!entry) return { dir: '', manifest: null as unknown as PluginManifest, createdManifest: false, pkgChanges, warnings, errors: [`插件 '${pluginId}' 不在插件库`] }
  const dir = dirname(entry.path)
  if (!existsSync(dir)) return { dir, manifest: null as unknown as PluginManifest, createdManifest: false, pkgChanges, warnings, errors: [`插件目录不存在: ${dir}`] }

  // ① manifest：config 从现网生成 patch 回填（原文层提取，保 !!js 字面——含 !!js 则放弃回填）
  let m = loadPluginManifest(dir)
  let createdManifest = false
  if (!m) {
    let config: unknown
    const backfilled = backfillConfigFromPatch(reg, pluginId, domainsDir)
    if (backfilled.error) warnings.push(backfilled.error)
    else if (backfilled.config !== undefined) config = backfilled.config
    m = { schema: 1, id: pluginId, entry: relative(dir, entry.path) || 'index.ts', layout: opts.layout ?? 'in-place', ...(entry.description ? { description: entry.description } : {}), ...(config !== undefined ? { config } : {}), ...(entry.provides?.length ? { provides: entry.provides } : {}), ...(entry.category ? { category: entry.category } : {}) }
    savePluginManifest(dir, m)
    createdManifest = true
  } else if (opts.layout && opts.layout !== m.layout) {
    m.layout = opts.layout
    savePluginManifest(dir, m)
    pkgChanges.push(`dsh.plugin.yml: layout → ${m.layout}`)
  }

  // ② package.json 补全
  const pkgPath = join(dir, 'package.json')
  let pkg: Record<string, unknown> = {}
  if (existsSync(pkgPath)) { try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown> } catch { warnings.push('package.json 解析失败——按空骨架补全') ; pkg = {} } }
  else { pkg = { name: `dsh-plugin-${pluginId}`, version: '0.1.0', private: true, description: m.description ?? pluginId }; pkgChanges.push('package.json: 新建') }
  const peers = collectPeerDeps(dir)
  if (!pkg.type) { pkg.type = 'module'; pkgChanges.push('package.json: +type=module') }
  if (!pkg.main) { pkg.main = 'index.ts'; pkgChanges.push('package.json: +main=index.ts（源码直跑；pack 构建后改写为 lib/index.js）') }
  if (!pkg.exports) { pkg.exports = { '.': './index.ts', './package.json': './package.json' }; pkgChanges.push('package.json: +exports（源码直跑）') }
  if (!pkg.files) { pkg.files = ['*.ts', 'dsh.plugin.yml', 'package.json']; pkgChanges.push('package.json: +files') }
  if (peers.length) {
    const want = Object.fromEntries(peers.map((p) => [p, '*']))
    const cur = (pkg.peerDependencies ?? {}) as Record<string, string>
    const merged = { ...want, ...cur }
    if (JSON.stringify(merged) !== JSON.stringify(cur)) { pkg.peerDependencies = merged; pkgChanges.push(`package.json: +peerDependencies ${peers.join(' ')}`) }
    if (!pkg.devDependencies || !(pkg.devDependencies as Record<string, string>)['@deepseek-ai/cordis']) {
      pkg.devDependencies = { ...(pkg.devDependencies as Record<string, string>), '@deepseek-ai/cordis': '*' }
      pkgChanges.push('package.json: +devDependencies 镜像（上游 publish 约定 peer+dev 双声明）')
    }
  }
  if (pkgChanges.some((c) => c.startsWith('package.json:'))) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  if (!createdManifest && !pkgChanges.length) pkgChanges.push('已是完整单元（零改动）')
  return { dir, manifest: m, createdManifest, pkgChanges, warnings, errors }
}

/** 从引用该插件的域的现网生成 patch 回填 config（原文层提取，保 !!js 字面）。含 !!js → 跳过（loadYamlText 会丢 tag 语义） */
function backfillConfigFromPatch(reg: PluginRegistry, pluginId: string, domainsDir: string): { config?: unknown; error?: string } {
  if (!existsSync(domainsDir)) return {}
  for (const d of readdirSync(domainsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dPath = join(domainsDir, d.name, 'domain.yml')
    if (!existsSync(dPath)) continue
    let spec: DomainSpec | null = null
    try { spec = (loadYamlText(readFileSync(dPath, 'utf8')) as DomainSpec) } catch { continue }
    if (!spec?.plugins?.some((p) => p.id === pluginId)) continue
    const patchPath = join(spec.dsh_home, 'profiles', spec.domain, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    const text = readFileSync(patchPath, 'utf8')
    const block = extractInsertBlock(text, pluginId)
    if (!block) continue
    if (block.includes('!!js')) return { error: `config 含 !!js（${d.name} 现网 patch）——保真回写会失真，config 留空请手工维护 dsh.plugin.yml` }
    try {
      const parsed = loadYamlText(block) as Array<{ config?: unknown }>
      return { config: parsed[0]?.config }
    } catch (e) { return { error: `config 回填解析失败: ${(e as Error).message.slice(0, 80)}` } }
  }
  return {}
}

/** 从 patch 原文提取 `- id: <id>` 的整个列表项（到下一个同级 `- id:` 或缩进退出为止） */
export function extractInsertBlock(patchText: string, id: string): string | null {
  const lines = patchText.split('\n')
  const start = lines.findIndex((l) => l.trim() === `- id: ${id}`)
  if (start < 0) return null
  const out: string[] = [lines[start]!]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim().startsWith('- id:')) break
    if (l.trim() === '') { out.push(l); continue }
    out.push(l)
  }
  return out.join('\n')
}

// ── pack：构建 lib/ + 生成组合包发行版 + tgz ──

export interface PackResult { ok: boolean; tgzPath?: string; errors: string[]; log: string[] }

/**
 * pack：源码单元 → 可分发组合包。
 * ① tsc 构建出 lib/（rewriteRelativeImportExtensions：./x.ts → ./x.js）
 * ② package.json 改写：main/exports → lib/；files += lib；dsh.bundle.patch → ./cordis.patch.yml
 * ③ 生成组合包 cordis.patch.yml（insert 行 name=包名——安装后由 profile node_modules 解析）
 * ④ pnpm pack → plugin-registry/dist/<name>-<version>.tgz
 * 消费方式（上游②通道）：dsh plugin --profile <p> add <tgz 路径>
 */
export function packPlugin(reg: PluginRegistry, pluginId: string, opts: { outDir: string; dshSource: string }): PackResult {
  const errors: string[] = []
  const log: string[] = []
  const entry = reg.plugins.find((x) => x.id === pluginId)
  if (!entry) return { ok: false, errors: [`插件 '${pluginId}' 不在插件库`], log }
  const dir = dirname(entry.path)
  const m = loadPluginManifest(dir)
  if (!m) return { ok: false, errors: [`缺 ${MANIFEST_FILE}——先 dshctl plugin scaffold ${pluginId}`], log }
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, errors: [`缺 package.json——先 dshctl plugin scaffold ${pluginId}`], log }
  const srcPkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string; private?: boolean; files?: string[]; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string>; description?: string }
  if (!srcPkg.name) return { ok: false, errors: ['package.json 缺 name——先 scaffold'], log }

  // staging：源目录拷贝（排除 node_modules/lib/dist/.git），源目录零污染
  const staging = join(opts.outDir, `${pluginId}-staging`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const walk = (s: string, d: string): void => {
    for (const e of readdirSync(s, { withFileTypes: true })) {
      if (['node_modules', 'lib', 'dist', '.git'].includes(e.name) || e.name.startsWith('.')) continue
      const sp = join(s, e.name)
      const dp = join(d, e.name)
      if (e.isDirectory()) { mkdirSync(dp, { recursive: true }); walk(sp, dp) }
      else if (e.isFile()) cpSync(sp, dp)
    }
  }
  walk(dir, staging)

  // ① tsc 构建（staging 内：./x.ts 相对导入 → lib/ 里 .js）
  const tscBin = join(opts.dshSource, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tscBin)) return { ok: false, errors: [`tsc 不可用（${tscBin}）——dsh_source 未安装依赖`], log }
  const jsEntry = m.entry.replace(/\.ts$/, '.js')
  // tsc 类型报错不阻断产物（默认 emit 不被类型错误拦截；插件此前从未类型检查——存量类型债另计）
  let typeErrors = 0
  try {
    execFileSync(process.execPath, [
      tscBin, join(staging, m.entry),
      '--outDir', 'lib', '--rootDir', staging,
      '--rewriteRelativeImportExtensions', 'true',
      '--module', 'nodenext', '--moduleResolution', 'nodenext',
      '--target', 'es2023', '--skipLibCheck',
    ], { cwd: staging, timeout: 120_000, encoding: 'utf8' })
  } catch (e) {
    const out = String((e as { stdout?: unknown }).stdout ?? '')
    typeErrors = (out.match(/error TS\d+/g) ?? []).length
    log.push(`tsc 类型诊断 ${typeErrors} 条（不阻断 emit；peer 模块无类型声明占多数）`)
  }
  if (!existsSync(join(staging, 'lib', jsEntry))) return { ok: false, errors: [`构建产物缺失：lib/${jsEntry}（tsc 语法级失败，见上方诊断）`], log }
  log.push(`tsc 构建 lib/ 完成（${m.entry} → lib/${jsEntry}）`)

  // ② staging 内 package.json 改写为发行形态（源目录不动）
  const distPkg = {
    ...srcPkg,
    main: `lib/${jsEntry}`,
    exports: { '.': `./lib/${jsEntry}`, './package.json': './package.json' },
    files: ['lib', 'cordis.patch.yml', MANIFEST_FILE, 'package.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  writeFileSync(join(staging, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n')
  log.push('staging package.json 改写为发行形态（main/exports → lib/；+dsh.bundle）')

  // ③ 组合包 cordis.patch.yml（insert 行 name=包名——安装后由 profile node_modules 解析）
  const patchLines = [`# ${String(srcPkg.name)} 组合包 patch —— 由 dshctl plugin pack 生成（勿手改）`, '- insert:', `    - id: ${m.id}`, `      name: '${String(srcPkg.name)}'`]
  if (m.config !== undefined) {
    patchLines.push('      config:')
    for (const l of dumpYaml(m.config).split('\n')) if (l.trim()) patchLines.push('        ' + l)
  }
  atomicWrite(join(staging, 'cordis.patch.yml'), patchLines.join('\n') + '\n')
  log.push('cordis.patch.yml 生成（dsh.bundle.patch 指向它）')

  // ④ pnpm pack（staging 内）→ tgz
  mkdirSync(opts.outDir, { recursive: true })
  try {
    const out = execFileSync('pnpm', ['pack', '--pack-destination', opts.outDir], { cwd: staging, timeout: 60_000, encoding: 'utf8' })
    const tgz = out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.tgz')).pop()
    if (!tgz) return { ok: false, errors: ['pnpm pack 未返回 tgz 路径'], log }
    const full = join(opts.outDir, tgz.split('/').pop()!)
    log.push(`tgz: ${full}`)
    rmSync(staging, { recursive: true, force: true })
    if (typeErrors) errors.push(`tsc 类型诊断 ${typeErrors} 条（不阻断；存量类型债，修偿见 plan）`)
    return { ok: true, tgzPath: full, errors, log }
  } catch (e) {
    return { ok: false, errors: [`pnpm pack 失败: ${String((e as Error).message).slice(0, 200)}`], log }
  }
}

// ── install：按布局算出 domain.yml plugins[].path 并登记 ──

export interface InstallResult { ok: boolean; path?: string; errors: string[]; notes: string[] }

/**
 * install：把插件装进领域的 domain.yml plugins[]（清单驱动——装配仍由 apply 落 patch）。
 * in-place → registry.path；vendored → 拷贝目录到 <home>/plugins/<id>/ 后指向 home 内入口。
 * manifest.config 为纯值时随 plugins[] 写入；含 !!js 则告警留给手工维护（回写会失真）。
 */
export function installIntoDomain(reg: PluginRegistry, spec: DomainSpec, pluginId: string, opts: { layout?: 'in-place' | 'vendored' } = {}): InstallResult {
  const errors: string[] = []
  const notes: string[] = []
  const entry = reg.plugins.find((x) => x.id === pluginId)
  if (!entry) return { ok: false, errors: [`插件 '${pluginId}' 不在插件库（dshctl plugin add 先入库）`], notes }
  const dir = dirname(entry.path)
  let m = loadPluginManifest(dir)
  if (!m) {
    const sc = scaffoldPlugin(reg, pluginId, '')
    if (sc.errors.length) return { ok: false, errors: sc.errors, notes }
    m = sc.manifest
    notes.push(`已自动 scaffold ${dir}`)
  }
  const layout = opts.layout ?? m.layout
  let targetPath: string
  if (layout === 'vendored') {
    const home = spec.dsh_home
    const dest = join(home, 'plugins', pluginId)
    copyPluginDir(dir, dest)
    targetPath = join(dest, m.entry)
    notes.push(`vendored：${dir} → ${dest}（lib/node_modules 不随拷；改源码后需重新 install）`)
  } else {
    targetPath = entry.path
  }
  if (!existsSync(targetPath)) return { ok: false, errors: [`入口不存在: ${targetPath}`], notes }
  const configPlain = manifestConfigPlain(dir, m)
  if (m.config !== undefined && !configPlain) notes.push(`manifest.config 含 !!js——未写入 domain.yml（保真需手工维护）`)
  const item: { id: string; path: string; config?: unknown } = { id: pluginId, path: targetPath }
  if (m.config !== undefined && configPlain) item.config = m.config
  spec.plugins = spec.plugins ?? []
  const existing = spec.plugins.find((p) => p.id === pluginId)
  if (existing) Object.assign(existing, item)
  else spec.plugins.push(item)
  return { ok: true, path: targetPath, errors, notes }
}

/** 目录拷贝（排除 node_modules/lib/dist/.git；vendored 语义=源码单元） */
function copyPluginDir(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const walk = (s: string, d: string): void => {
    for (const e of readdirSync(s, { withFileTypes: true })) {
      if (['node_modules', 'lib', 'dist', '.git'].includes(e.name) || e.name.startsWith('.')) continue
      const sp = join(s, e.name)
      const dp = join(d, e.name)
      if (e.isDirectory()) { mkdirSync(dp, { recursive: true }); walk(sp, dp) }
      else if (e.isFile()) { cpSync(sp, dp) }
    }
  }
  walk(src, dest)
}

/** manifest.config 是否纯值（递归禁 !!js 字符串与函数） */
export function isPlainConfig(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return !(typeof v === 'string' && v.includes('!!js'))
  for (const x of Object.values(v as Record<string, unknown>)) if (!isPlainConfig(x)) return false
  return true
}
