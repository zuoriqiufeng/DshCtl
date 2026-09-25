/**
 * check.ts — F2 对账器（R1-R13 全规则），纯只读；runChecks 为 async（R9 fetch 探活）。
 * 上游 roster：`pnpm dsh --profile <p> --dump-config`（YAML）→ ids，按上游版本缓存于 domains/.cache/。
 * R2/R3 逻辑抽为 reconcileUpstream 纯函数（upgrade-check 复用）。
 */
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadYamlText, atomicWrite } from './yml.ts'
import type { DomainSpec } from './domain.ts'
import { crossCheckRegistries } from './plugin.ts'
import { ENV_NAME_RE } from './domain.ts'
import { loadRegistry, findDomainConflicts, saveRegistry, type Registry } from './registry.ts'
import { mergePacks, loadPacks } from './packs.ts'
import { loadPluginRegistry, checkDomainPlugins } from './plugin.ts'
import { loadCoreList, coreIds, coreViolations, slotFindings } from './core.ts'

export interface CheckItem { rule: string; level: 'pass' | 'warn' | 'error'; msg: string }
export interface CheckReport {
  domain: string
  items: CheckItem[]
  errors: number
  warns: number
  degraded?: string[] // 降级执行的子集（如 dump-config 失败）
}

const REF = '→ 见 gernalarrange/dshctl-design.md §6'

function item(rule: string, ok: boolean, msgOk: string, msgBad: string, level: 'warn' | 'error' = 'error'): CheckItem {
  return ok ? { rule, level: 'pass', msg: msgOk } : { rule, level, msg: `${msgBad} ${REF}` }
}

/** dump-config roster：优先版本缓存；--refresh 强刷。失败 → null（调用方降级） */
export function loadRoster(dshSource: string, profile: string, cacheDir: string, refresh: boolean, dshHome?: string): { ids: string[]; version: string; cached: boolean } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dshSource, 'package.json'), 'utf8')) as { version?: string }
    const version = pkg.version ?? '0.0.0'
    const cachePath = join(cacheDir, `dump-config-${version}.json`)
    if (!refresh && existsSync(cachePath)) {
      const c = JSON.parse(readFileSync(cachePath, 'utf8')) as { ids: string[] }
      return { ids: c.ids, version, cached: true }
    }
    const out = execFileSync('pnpm', ['dsh', '--profile', profile, '--dump-config'], {
      cwd: dshSource,
      env: { ...process.env, ...(dshHome ? { DSH_HOME: dshHome } : {}) },
      timeout: 180_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    })
    const doc = loadYamlText(out) as Array<{ id?: string }>
    const ids = [...new Set(doc.map((e) => e?.id).filter((x): x is string => !!x))]
    mkdirSync(cacheDir, { recursive: true })
    atomicWrite(cachePath, JSON.stringify({ version, ids }, null, 0))
    return { ids, version, cached: false }
  } catch {
    return null
  }
}

/** 端口是否被占用（ss -ltn 解析）；GUI 实例状态复用 */
export function portOccupied(port: number): boolean {
  try {
    const out = execSync('ss -ltn', { encoding: 'utf8', timeout: 5000 })
    return out.split('\n').some((l) => new RegExp(`[:.]${port}\\s`).test(l) && l.includes('LISTEN'))
  } catch { return false }
}

/** unit 活跃三态：true=active / false=inactive(exit 3) / null=不可判定；GUI 实例状态复用 */
export function unitActive(unit: string): boolean | null {
  try {
    execSync(`systemctl is-active --quiet ${JSON.stringify(unit)}`, { timeout: 5000 })
    return true
  } catch (e) {
    return (e as { status?: number }).status === 3 ? false : null // 3=inactive 其他=不可判定
  }
}

/** SKILL.md frontmatter 合法性：含 name 与 description 键 */
function frontmatterOk(skillMd: string): boolean {
  const t = readFileSync(skillMd, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(t)
  if (!fm) return false
  return /^\s*name:\s*\S/m.test(fm[1]!) && /^\s*description:\s*\S/m.test(fm[1]!)
}

export async function runChecks(spec: DomainSpec, regPath: string, packsDir: string, cacheDir: string, opts: { refresh?: boolean; prevRoster?: string[]; pluginRegistryPath?: string; coreListPath?: string }): Promise<CheckReport> {
  const items: CheckItem[] = []
  const degraded: string[] = []
  const reg = loadRegistry(regPath)

  // R1：domain 唯一 + 端口不冲突 + 占用核对
  const dup = reg.instances.filter((x) => x.domain === spec.domain)
  items.push(item('R1', dup.length <= 1, `domain '${spec.domain}' 登记唯一`, `domain '${spec.domain}' 在 registry 重复登记`))
  const conflicts = findDomainConflicts(reg, spec)
  items.push(item('R1', conflicts.length === 0, '端口与其他已登记实例无冲突', conflicts.join('；')))
  for (const [label, port] of [['api', spec.ports?.api], ['gui', spec.ports?.gui]] as Array<[string, number | undefined | null]>) {
    if (!port) continue
    const occupied = portOccupied(port)
    const self = spec.systemd_unit ? unitActive(spec.systemd_unit) : null
    if (occupied && self === true) items.push({ rule: 'R1', level: 'pass', msg: `端口 ${port}(${label}) 被本实例 unit(${spec.systemd_unit})占用（自证）` })
    else if (occupied && self === false) items.push({ rule: 'R1', level: 'warn', msg: `端口 ${port}(${label}) 被占用但本实例 unit 未运行——确认归属或登记 unregistered_ports${reg.unregistered_ports.includes(port) ? '（该端口已在 unregistered_ports：确认归属后回收或转正登记）' : ''}` })
    else if (occupied) items.push({ rule: 'R1', level: 'warn', msg: `端口 ${port}(${label}) 被占用且 unit 状态不可判定——人工确认` })
    else items.push({ rule: 'R1', level: 'pass', msg: `端口 ${port}(${label}) 空闲` })
  }

  if (spec.api_server) {
    items.push(item('R7', spec.api_server.turn_timeout_sec >= spec.api_server.max_task_duration_sec,
      `turn_timeout_sec(${spec.api_server.turn_timeout_sec}) ≥ max_task_duration(${spec.api_server.max_task_duration_sec})`,
      `turn_timeout_sec(${spec.api_server.turn_timeout_sec}) < max_task_duration(${spec.api_server.max_task_duration_sec})`))
    items.push(item('R8', ENV_NAME_RE.test(spec.api_server.api_key_env), `api_key_env '${spec.api_server.api_key_env}' 为环境变量名`, `api_key_env '${spec.api_server.api_key_env}' 疑似字面值`))
  }

  const caps = spec.capabilities ?? []
  if (caps.includes('script')) {
    const cmds = spec.guard?.whitelist?.commands ?? []
    items.push(item('R4', cmds.length > 0, `script 包命令白名单 ${cmds.length} 项（${cmds.join(', ')}）`,
      'capabilities 含 script 但 guard.whitelist.commands 为空（裸 bash 无护栏禁止）'))
  }

  const mediaDirs = spec.contracts?.media_dirs ?? []
  if (mediaDirs.length) {
    const wp = spec.guard?.whitelist?.write_paths ?? []
    const uncovered = mediaDirs.filter((m) => !wp.some((w) => m === w || m.startsWith(w.replace(/\/+$/, '') + '/')))
    items.push(item('R5', uncovered.length === 0, `media_dirs 均被写白名单覆盖（write_paths: ${wp.join(', ')}）`,
      `契约目录未被护栏放行（Agent 写得出、契约读不到）: ${uncovered.join(', ')}`))
  }

  for (const dep of spec.shared_deps ?? []) {
    const ok = await httpReachable(dep.url)
    items.push({ rule: 'R9', level: ok ? 'pass' : 'warn', msg: ok ? `${dep.name} ${dep.url} 可达` : `${dep.name} ${dep.url} 不可达（共享设施可能冷启动前）` })
  }

  for (const dir of spec.preset?.skills_dirs ?? []) {
    if (!existsSync(dir)) { items.push(item('R6', false, '', `skills_dirs 不存在: ${dir}`)); continue }
    const ok = readdirSync(dir, { withFileTypes: true }).some((d) =>
      d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')) && frontmatterOk(join(dir, d.name, 'SKILL.md')))
    items.push(item('R6', ok, `${dir}: 含合法 frontmatter 的 SKILL.md`, `${dir}: 无合法 frontmatter 的 SKILL.md`))
  }

  const packs = loadPacks(packsDir)
  const roster = loadRoster(spec.dsh_source, spec.domain, cacheDir, opts.refresh ?? false, spec.dsh_home)
  if (!roster) {
    degraded.push('dump-config 不可用（上游未构建或超时）——R2/R3 退化跳过，仅清单内部校验')
    items.push({ rule: 'R2', level: 'warn', msg: '上游 roster 不可用，跳过对账（见降级说明）' })
  } else {
    const rec = reconcileUpstream(spec, packs, roster.ids, opts.prevRoster, `v${roster.version}${roster.cached ? '，缓存' : ''}`)
    items.push(...rec.items)
  }

  const { entries: mergedEntries } = mergePacks(packs, caps)
  {
    const currentPatch = join(spec.dsh_home, 'bundles', 'ops-app', 'cordis.patch.yml')
    if (existsSync(currentPatch)) {
      const cur = (loadYamlText(readFileSync(currentPatch, 'utf8')) as Array<{ id?: string }>).map((e) => e?.id).filter((x): x is string => !!x)
      const rendered = new Set(mergedEntries.map((e) => e.id))
      const gap = cur.filter((id) => !rendered.has(id))
      items.push(gap.length === 0
        ? { rule: 'R10', level: 'pass', msg: '无归层缺口（现状 patch 全部 id 均被能力包覆盖）' }
        : { rule: 'R10', level: 'warn', msg: `归层缺口（现状有、清单无，交人工归层）: ${gap.join(', ')}` })
    }
  }

  // R13：两套 registry 交叉（领域引用的插件 id 不得同时被能力包 disable——语义冲突）
  items.push(...crossCheckRegistries(spec, mergedEntries.filter((e) => e.disabled).map((e) => e.id)))

  // R11：核心功能不可缺——无 slot 的 core id 严格不可裁；带 slot 的 id 同槽有活跃成员即可豁免
  if (opts.coreListPath) {
    const list = loadCoreList(opts.coreListPath)
    const ids = coreIds(list.core)
    if (!ids.length) items.push({ rule: 'R11', level: 'warn', msg: `core 清单缺失/为空（${opts.coreListPath}）——R11 降级` })
    else {
      const { entries } = mergePacks(packs, caps)
      const disabledIds = entries.filter((e) => e.disabled === true).map((e) => e.id)
      const declaredSlotIds = new Set(list.core.filter((e) => e.slot && list.slots?.[e.slot]).map((e) => e.id))
      const hard = coreViolations(disabledIds, ids).filter((id) => !declaredSlotIds.has(id))
      // 槽成员活跃判据：有 roster 时需存在性证据（上游 roster ∪ 本域插入插件）；roster 缺失时声明即活跃（保持 R11 roster 无关）
      const pluginIds = new Set((spec.plugins ?? []).map((p) => p.id))
      const rosterIds = roster ? new Set(roster.ids) : null
      const isActive = (m: string) => (rosterIds ? (rosterIds.has(m) || pluginIds.has(m)) : true)
      const findings = slotFindings(disabledIds, list.core, list.slots, isActive)
      const emptied = findings.filter((f) => f.covering.length === 0)
      const exempted = findings.filter((f) => f.covering.length > 0)
      if (hard.length || emptied.length) {
        const parts: string[] = []
        if (hard.length) parts.push(`核心必须件被裁（不可裁）: ${hard.join(', ')}——确需替换：core.yml 给该 id 加 slot 标记并在 slots 声明成员`)
        for (const f of emptied) parts.push(`核心功能槽被裁空: ${f.slot}（${f.id} 需保留，或同槽新增活跃成员）——确需替换：core.yml slots 声明同槽成员并插入实现`)
        items.push({ rule: 'R11', level: 'error', msg: parts.join('；') })
      } else {
        const note = exempted.length
          ? `（${exempted.map((f) => `${f.slot} 槽豁免: ${f.id} ← ${f.covering.join('/')}`).join('；')}）`
          : ''
        items.push({ rule: 'R11', level: 'pass', msg: `能力包未裁核心功能（${ids.length} 项在册）${note}` })
      }
    }
  }

  // R12：领域插件与插件库对齐（未入库/path 漂移 → error；untrusted → warn）
  if (opts.pluginRegistryPath) {
    const preg = loadPluginRegistry(opts.pluginRegistryPath)
    for (const r of checkDomainPlugins(spec, preg)) {
      items.push({ rule: 'R12', level: r.level, msg: r.msg })
    }
  }

  const errors = items.filter((i) => i.level === 'error').length
  const warns = items.filter((i) => i.level === 'warn').length
  return { domain: spec.domain, items, errors, warns, ...(degraded.length ? { degraded } : {}) }
}

/** HTTP 可达性探测：任何 HTTP 响应（含 4xx/5xx）= 可达；网络错/超时 = 不可达 */
async function httpReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

export interface ReconcileResult {
  items: CheckItem[]
  /** 清单里有、上游 roster 已消失的 id（error——升级后 disable 静默失效） */
  disappeared: string[]
  /** 上游新增且未被能力包覆盖的行（warn——人工评估是否裁剪） */
  addedUncovered: string[]
}

/** R2/R3 上游对账纯函数（check 与 upgrade-check 共用；rosterLabel 仅用于文案） */
export function reconcileUpstream(spec: DomainSpec, packs: ReturnType<typeof loadPacks>, rosterIds: string[], prevRoster?: string[], rosterLabel = 'roster'): ReconcileResult {
  const items: CheckItem[] = []
  const rosterSet = new Set(rosterIds)
  const { entries, errors } = mergePacks(packs, spec.capabilities ?? [])
  for (const e of errors) items.push({ rule: 'R2', level: 'error', msg: e })
  const disappeared: string[] = []
  for (const en of entries) {
    const ok = rosterSet.has(en.id)
    if (!ok) disappeared.push(en.id)
    items.push(item('R2', ok, `${en.id} 在上游 roster 存在（${rosterLabel}）`,
      `disable/override id '${en.id}' 已不在上游 roster（上游改名或删除 → 清单需跟进）`))
  }
  const addedUncovered: string[] = []
  if (prevRoster) {
    const covered = new Set(entries.map((e) => e.id))
    addedUncovered.push(...rosterIds.filter((id) => !prevRoster.includes(id) && !covered.has(id)))
    items.push(addedUncovered.length === 0
      ? { rule: 'R3', level: 'pass', msg: '无未评估的上游新增行' }
      : { rule: 'R3', level: 'warn', msg: `上游新增未覆盖行（需人工评估裁剪）: ${addedUncovered.join(', ')}` })
  } else {
    items.push({ rule: 'R3', level: 'pass', msg: '无上一版 roster 基线，新增评估跳过（首建缓存）' })
  }
  return { items, disappeared, addedUncovered }
}

export function loadPrevRoster(cacheDir: string, currentVersion: string): string[] | undefined {
  if (!existsSync(cacheDir)) return undefined
  const olds = readdirSync(cacheDir).filter((f) => /^dump-config-.*\.json$/.test(f) && !f.includes(currentVersion))
  if (!olds.length) return undefined
  try {
    const c = JSON.parse(readFileSync(join(cacheDir, olds.sort().at(-1)!), 'utf8')) as { ids: string[] }
    return c.ids
  } catch { return undefined }
}

export function updateCheckResult(regPath: string, domain: string, report: CheckReport): void {
  const reg = loadRegistry(regPath)
  const inst = reg.instances.find((x) => x.domain === domain)
  if (inst) {
    inst.last_check = { at: new Date().toISOString().slice(0, 10), result: report.errors ? 'fail' : 'pass', errors: report.errors, warns: report.warns }
    saveRegistry(regPath, reg)
  }
  appendCheckHistory(dirname(regPath), domain, report)
}

export interface CheckHistoryEntry { domain: string; at: string; result: string; errors: number; warns: number }

/** check 历史追加（cap 200）：GUI 趋势点阵数据源；失败静默（降级铁律——历史是非关键路径） */
export function appendCheckHistory(domainsDir: string, domain: string, report: CheckReport): void {
  try {
    const file = join(domainsDir, '.check-history.json')
    let hist: CheckHistoryEntry[] = []
    try { hist = JSON.parse(readFileSync(file, 'utf8')) as CheckHistoryEntry[] } catch { /* 首建 */ }
    hist.push({ domain, at: new Date().toISOString(), result: report.errors ? 'fail' : report.errors || report.warns ? 'warn' : 'pass', errors: report.errors, warns: report.warns })
    if (hist.length > 200) hist = hist.slice(-200)
    atomicWrite(file, JSON.stringify(hist))
  } catch { /* 非关键路径静默 */ }
}

export function loadCheckHistory(domainsDir: string): CheckHistoryEntry[] {
  try { return JSON.parse(readFileSync(join(domainsDir, '.check-history.json'), 'utf8')) as CheckHistoryEntry[] } catch { return [] }
}
