/**
 * replace.ts — 替换通道引擎：预检 → 声明槽成员 → 插入新件(domain.yml plugins[]) →
 * 旧件进能力包 disable → check 验证。
 *
 * 成功判据（相对基线的 delta 语义）：**无新增 error**，且 old∈core 且非 keep-old 时 R11 不得为 error
 * （预期出现「槽豁免」）。delta = 通道只对本次替换负责，不替历史债买单；现网 0-error 基线下等价于 0 error。
 * 失败 → 按快照原子恢复本次写过的全部文件（domain.yml / pack / core.yml / plugin-registry，按需 3~4 处）。
 *
 * 无 --yes = 预演（零写入，返回计划）；--smoke 通过后追加临时实例冒烟（失败不回滚，运行时问题人工决策）。
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import YAML, { YAMLMap, YAMLSeq } from 'yaml'
import { parseDomain, type DomainSpec } from './domain.ts'
import { loadPack } from './packs.ts'
import { loadPluginRegistry, savePluginRegistry, renderPluginRegistry, addPlugin, isPackagePath } from './plugin.ts'
import { loadCoreList, coreIds, mutateSlotMember, saveSlotMember } from './core.ts'
import { runChecks, loadPrevRoster, loadRoster, updateCheckResult, type CheckReport } from './check.ts'
import { editYaml, mutateYamlText, atomicWrite } from './yml.ts'
import { runSmoke, type SmokeReport } from './smoke.ts'

export interface ReplacePaths {
  domainsDir: string
  packsDir: string
  cacheDir: string
  /** domains/registry.yml（R1 用，可不存在） */
  regYml: string
  pluginRegistryPath: string
  corePath: string
}

export interface ReplaceOpts {
  oldId: string
  newId: string
  domain: string
  pack?: string
  keepOld?: boolean
  /** 新件插入所需：文件入口绝对路径或包名（未入库时必填；已入库取库内 path） */
  newPath?: string
  smoke?: boolean
}

export interface ReplaceStep { action: string; file?: string }

/** 行级 diff：单 hunk（本通道变更均为追加型，前后缀裁剪足够）；t=ctx/add/del */
export interface DiffLine { t: 'ctx' | 'add' | 'del'; s: string }
export interface ReplaceChange {
  /** 文件绝对路径 */
  file: string
  /** 展示名（core.yml / domain.yml / 能力包 / 插件库） */
  label: string
  /** 该文件上要执行的动作（声明槽成员 / 插入 plugins[] / disable 旧件 / 自动入库） */
  action: string
  hunks: { lines: DiffLine[] }
}

export interface ReplacePlan {
  errors: string[]
  warnings: string[]
  steps: ReplaceStep[]
  /** 预演可见的行级变更（只含将要写的文件；真实写与虚拟写共用 mutator，逐字节一致） */
  changes: ReplaceChange[]
  facts: {
    oldInCore: boolean
    slotName?: string
    alreadyDeclared: boolean
    newRegistered: boolean
    autoAdd: boolean
    insertNeeded: boolean
    alreadyInPlugins: boolean
    alreadyDisabled: boolean
    needDeclare: boolean
    needDisable: boolean
    insertPath?: string
    domainYml: string
    packPath: string
  }
}

export interface ReplaceResult {
  ok: boolean
  dryRun?: boolean
  plan: ReplacePlan
  steps?: ReplaceStep[]
  r11?: string
  newErrors?: string[]
  rolledBack?: boolean
  smoke?: { pass: boolean; detail: string }
  rollbackGuide?: string
  equivalentCommand: string
}

const DISABLE_KEYS = ['tools', 'skills', 'commands', 'surfaces', 'mcp'] as const

// ── 三个写入 mutator：真实写（runReplace）与预演 diff（planChanges 虚拟写）共用，保证逐字节一致 ──

/** ③ domain.yml plugins[] 追加新件 */
export function mutateDomainInsert(doc: YAML.Document.Parsed, newId: string, path: string): void {
  const seq = doc.get('plugins') as YAMLSeq | undefined
  if (!seq) {
    doc.set('plugins', doc.createNode([{ id: newId, path }]))
  } else {
    const arr = (seq.toJSON?.() ?? []) as Array<{ id?: string }>
    if (!arr.some((p) => p.id === newId)) seq.add(doc.createNode({ id: newId, path }))
  }
}

/** ④ 能力包 disable.tools 追加旧件 */
export function mutatePackDisable(doc: YAML.Document.Parsed, oldId: string): void {
  const disable = doc.get('disable') as YAMLMap | undefined
  if (!disable) { doc.set('disable', doc.createNode({ tools: [oldId] })); return }
  const tools = disable.get('tools') as YAMLSeq | undefined
  if (!tools) disable.set('tools', doc.createNode([oldId]))
  else {
    const arr = (tools.toJSON?.() ?? []) as string[]
    if (!arr.includes(oldId)) tools.add(oldId)
  }
}

/** 行级 diff：公共前后缀裁剪 → 单 hunk（含 3 行上下文）；本通道写入均为追加型，够用且诚实 */
function lineDiff(before: string, after: string): DiffLine[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  const ctx = 3
  const lines: DiffLine[] = []
  for (let i = Math.max(0, start - ctx); i < start; i++) lines.push({ t: 'ctx', s: a[i]! })
  for (let i = start; i <= endA; i++) lines.push({ t: 'del', s: a[i]! })
  for (let i = start; i <= endB; i++) lines.push({ t: 'add', s: b[i]! })
  for (let i = endA + 1; i <= Math.min(endA + ctx, a.length - 1); i++) lines.push({ t: 'ctx', s: a[i]! })
  return lines
}

/**
 * 预演行级变更：只对将要写的文件做内存虚拟写（mutate 与真实写同一函数）。
 * 每个文件独立 try/catch——diff 是辅助信息，失败不挡预演。
 */
function planChanges(o: ReplaceOpts, f: ReplacePlan['facts'], paths: ReplacePaths): ReplaceChange[] {
  const out: ReplaceChange[] = []
  const diffOne = (file: string, label: string, action: string, mutateText: (text: string) => string): void => {
    try {
      if (!existsSync(file)) return
      const before = readFileSync(file, 'utf8')
      const after = mutateText(before)
      if (before === after) return
      out.push({ file, label, action, hunks: { lines: lineDiff(before, after) } })
    } catch { /* diff 失败不挡预演 */ }
  }
  if (f.needDeclare && f.oldInCore) {
    diffOne(paths.corePath, 'core.yml', `声明槽成员 ${f.slotName ?? o.oldId} ← ${o.newId}`,
      (t) => mutateYamlText(t, (doc) => { mutateSlotMember(doc, o.oldId, o.newId) }))
  }
  if (f.insertNeeded) {
    diffOne(f.domainYml, 'domain.yml', `plugins[] 追加 ${o.newId}`,
      (t) => mutateYamlText(t, (doc) => mutateDomainInsert(doc, o.newId, f.insertPath!)))
  }
  if (f.needDisable) {
    diffOne(f.packPath, `能力包 ${o.pack ?? 'core'}`, `disable 追加 ${o.oldId}`,
      (t) => mutateYamlText(t, (doc) => mutatePackDisable(doc, o.oldId)))
  }
  if (f.autoAdd) {
    diffOne(paths.pluginRegistryPath, '插件库 registry.yml', `入库 ${o.newId}`, () => {
      const reg = loadPluginRegistry(paths.pluginRegistryPath)
      const r = addPlugin(reg, { id: o.newId, path: f.insertPath! })
      if (!r.ok) throw new Error(r.errors.join('; '))
      return renderPluginRegistry(reg)
    })
  }
  return out
}

function buildEquivalentCommand(o: ReplaceOpts): string {
  const pack = o.pack ?? 'core'
  return `dshctl replace ${o.oldId} --with ${o.newId} --domain ${o.domain} --pack ${pack}`
    + (o.keepOld ? ' --keep-old' : '') + (o.newPath ? ` --path ${o.newPath}` : '') + (o.smoke ? ' --smoke' : '') + ' --yes'
}

const errFmt = (i: { rule: string; msg: string }) => `${i.rule}: ${i.msg}`

function loadSpec(paths: ReplacePaths, domain: string): { spec: DomainSpec | null; domainYml: string; errors: string[] } {
  const domainYml = join(paths.domainsDir, domain, 'domain.yml')
  if (!existsSync(domainYml)) return { spec: null, domainYml, errors: [`domain.yml 不存在: ${domainYml}`] }
  const { spec, errors } = parseDomain(domainYml)
  return { spec, domainYml, errors }
}

async function runCheckFor(paths: ReplacePaths, spec: DomainSpec): Promise<CheckReport> {
  let version = '0.0.0'
  try { version = (JSON.parse(readFileSync(join(spec.dsh_source, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0' } catch { /* 版本取不到 → prevRoster 缺省 */ }
  return runChecks(spec, paths.regYml, paths.packsDir, paths.cacheDir, {
    refresh: false,
    prevRoster: loadPrevRoster(paths.cacheDir, version),
    pluginRegistryPath: paths.pluginRegistryPath,
    coreListPath: paths.corePath,
  })
}

/** 预检：零写入，产出计划与全部错误/警告 */
export function planReplace(paths: ReplacePaths, o: ReplaceOpts): { plan: ReplacePlan; spec: DomainSpec | null } {
  const errors: string[] = []
  const warnings: string[] = []
  const steps: ReplaceStep[] = []
  const pack = o.pack ?? 'core'
  const facts: ReplacePlan['facts'] = {
    oldInCore: false, alreadyDeclared: false, newRegistered: false, autoAdd: false,
    insertNeeded: false, alreadyInPlugins: false, alreadyDisabled: false,
    needDeclare: false, needDisable: false,
    domainYml: join(paths.domainsDir, o.domain, 'domain.yml'),
    packPath: join(paths.packsDir, `${pack}.yml`),
  }

  if (!o.oldId || !o.newId) errors.push('old 与 --with new 均必填')
  if (o.oldId && o.oldId === o.newId) errors.push('旧件与新件相同')
  const { spec, domainYml, errors: dErrs } = loadSpec(paths, o.domain)
  facts.domainYml = domainYml
  if (!spec) errors.push(...dErrs)
  if (!existsSync(facts.packPath)) errors.push(`能力包不存在: ${facts.packPath}`)

  if (spec) {
    // pack 是否对该域生效（core 隐含）
    if (pack !== 'core' && !(spec.capabilities ?? []).includes(pack)) {
      warnings.push(`能力包 ${pack} 不在该域 capabilities——disable 不会生效（现 ${JSON.stringify(spec.capabilities ?? [])}）`)
    }
    const reg = loadPluginRegistry(paths.pluginRegistryPath)
    const regEntry = reg.plugins.find((p) => p.id === o.newId)
    facts.newRegistered = !!regEntry
    const roster = loadRoster(spec.dsh_source, spec.domain, paths.cacheDir, false, spec.dsh_home)
    if (!roster) warnings.push('roster 缓存不可用——存在证据将只认本域 plugins[]')

    facts.alreadyInPlugins = (spec.plugins ?? []).some((p) => p.id === o.newId)
    const inRoster = !!roster?.ids.includes(o.newId)
    facts.insertNeeded = !facts.alreadyInPlugins && !inRoster

    // 路径解析：库内 path > --path > 已在 plugins[] 条目自带 path（R12 漂移/未入库时的回落）
    const pluginsEntry = (spec.plugins ?? []).find((p) => p.id === o.newId)
    const resolvedPath = regEntry?.path ?? o.newPath ?? pluginsEntry?.path
    // 未入库 → 自动 plugin add（有 path 就登记；包名豁免 existsSync 在 addPlugin 内已处理）
    facts.autoAdd = !regEntry && !!resolvedPath
    if (facts.insertNeeded && !resolvedPath) {
      errors.push(`新件 ${o.newId} 不在 roster 也未入库——需 --path（文件入口绝对路径或包名）`)
    } else if (resolvedPath && (facts.autoAdd || facts.insertNeeded)) {
      facts.insertPath = resolvedPath
      if (!isPackagePath(resolvedPath) && !existsSync(resolvedPath)) errors.push(`入口文件不存在: ${resolvedPath}`)
    }
    if (facts.autoAdd) {
      steps.push({ action: `入库新件 ${o.newId}（path: ${facts.insertPath}）`, file: paths.pluginRegistryPath })
    } else if (regEntry) {
      steps.push({ action: `新件 ${o.newId} 已入库，跳过入库` })
    } else if (!facts.insertNeeded) {
      steps.push({ action: `新件 ${o.newId} 未入库且未给 path——免插入（roster 证据）时无需入库（R12 不查 roster 件）` })
    }
    if (facts.insertNeeded) {
      steps.push({ action: `domain.yml plugins[] 追加 ${o.newId}（R11 存在证据）`, file: domainYml })
    } else {
      steps.push(facts.alreadyInPlugins
        ? { action: `新件已在 plugins[]，跳过插入（证据已成立）` }
        : { action: `新件 ${o.newId} ∈ roster（上游已在位），免插入` })
    }

    const core = loadCoreList(paths.corePath)
    facts.oldInCore = coreIds(core.core).includes(o.oldId)
    if (o.keepOld) {
      steps.push({ action: 'keep-old：保留旧件（M1 共存）——跳过槽声明与禁用' })
    } else {
      if (facts.oldInCore) {
        const entry = core.core.find((e) => e.id === o.oldId)
        facts.slotName = entry?.slot
        if (entry?.slot) {
          const members = core.slots?.[entry.slot]?.members ?? []
          facts.alreadyDeclared = members.includes(o.newId)
        }
        facts.needDeclare = !facts.alreadyDeclared
        steps.push(facts.needDeclare
          ? { action: `core.yml 声明功能槽成员：${facts.slotName ?? o.oldId} ← ${o.newId}${entry?.slot ? '' : '（载体无 slot 标记，自动补）'}`, file: paths.corePath }
          : { action: `槽成员已声明（幂等跳过）：${facts.slotName} ← ${o.newId}` })
      }
      let disableBody: { [k: string]: unknown } = {}
      try { disableBody = loadPack(facts.packPath).disable } catch (e) { errors.push(`能力包读取失败: ${(e as Error).message}`) }
      facts.alreadyDisabled = DISABLE_KEYS.some((k) => Array.isArray(disableBody[k]) && (disableBody[k] as unknown[]).includes(o.oldId))
      facts.needDisable = !facts.alreadyDisabled
      steps.push(facts.needDisable
        ? { action: `能力包 ${pack} disable 追加 ${o.oldId}`, file: facts.packPath }
        : { action: `${o.oldId} 已在能力包 disable（幂等跳过）` })
    }
  }

  // 预演行级变更：与真实写同一 mutator 虚拟执行（有预检 error 时不出 diff——计划本身不可执行）
  const changes = errors.length ? [] : planChanges(o, facts, paths)
  return { plan: { errors, warnings, steps, changes, facts }, spec }
}

interface Snapshot { path: string; existed: boolean; content: string }

function restore(snaps: Snapshot[]): void {
  for (const s of snaps) {
    if (s.existed) atomicWrite(s.path, s.content)
    else { try { unlinkSync(s.path) } catch { /* 本就不存在 */ } }
  }
}

function rollbackGuide(o: ReplaceOpts, paths: ReplacePaths, plan: ReplacePlan): string {
  const lines = ['回退（清单驱动，反向编辑后重跑）：']
  if (plan.facts.needDisable) lines.push(`  · ${paths.packsDir}/${o.pack ?? 'core'}.yml disable 中移除 ${o.oldId}`)
  if (plan.facts.insertNeeded) lines.push(`  · domains/${o.domain}/domain.yml plugins[] 移除 ${o.newId}`)
  if (plan.facts.autoAdd) lines.push(`  · plugin-registry/registry.yml 移除 ${o.newId}`)
  if (plan.facts.needDeclare) lines.push(`  · plugin-registry/core.yml slots 中移除 ${o.newId}（及载体 slot: 标记）`)
  lines.push(`  · dshctl apply ${o.domain} && dshctl check ${o.domain} --ci`)
  return lines.join('\n')
}

/** 执行替换。yes=false → 预演（零写入）。 */
export async function runReplace(paths: ReplacePaths, o: ReplaceOpts, opts?: { yes?: boolean }): Promise<ReplaceResult> {
  const equivalentCommand = buildEquivalentCommand(o)
  const { plan, spec } = planReplace(paths, o)
  if (plan.errors.length || !spec) return { ok: false, plan, equivalentCommand }
  if (!opts?.yes) return { ok: true, dryRun: true, plan, steps: plan.steps, equivalentCommand }

  // 基线（写前）：delta 判据的参照
  const baseline = await runCheckFor(paths, spec)
  const baselineErrs = new Set(baseline.items.filter((i) => i.level === 'error').map(errFmt))

  const written: Snapshot[] = []
  const snap = (p: string): void => {
    if (written.some((w) => w.path === p)) return
    written.push(existsSync(p) ? { path: p, existed: true, content: readFileSync(p, 'utf8') } : { path: p, existed: false, content: '' })
  }
  const steps: ReplaceStep[] = []
  const f = plan.facts

  try {
    // ① 自动入库
    if (f.autoAdd) {
      snap(paths.pluginRegistryPath)
      const reg = loadPluginRegistry(paths.pluginRegistryPath)
      const r = addPlugin(reg, { id: o.newId, path: f.insertPath! })
      if (!r.ok) throw new Error(`入库失败: ${r.errors.join('; ')}`)
      savePluginRegistry(paths.pluginRegistryPath, reg)
      steps.push({ action: `入库新件 ${o.newId}`, file: paths.pluginRegistryPath })
    }
    // ② 声明槽成员（保注释）
    if (f.needDeclare) {
      snap(paths.corePath)
      const slotName = saveSlotMember(paths.corePath, o.oldId, o.newId)
      steps.push({ action: `core.yml 声明槽成员 ${slotName} ← ${o.newId}`, file: paths.corePath })
    }
    // ③ 插入 domain.yml plugins[]（保注释；mutator 与预演 diff 共用）
    if (f.insertNeeded) {
      snap(f.domainYml)
      editYaml(f.domainYml, (doc) => mutateDomainInsert(doc, o.newId, f.insertPath!))
      const re = parseDomain(f.domainYml)
      if (!re.spec || re.errors.length) throw new Error(`domain.yml 写后校验失败: ${re.errors.join('; ') || 'parse 空'}`)
      steps.push({ action: `domain.yml plugins[] 追加 ${o.newId}`, file: f.domainYml })
    }
    // ④ 禁旧件（保注释；mutator 与预演 diff 共用）
    if (f.needDisable) {
      snap(f.packPath)
      editYaml(f.packPath, (doc) => mutatePackDisable(doc, o.oldId))
      steps.push({ action: `能力包 ${o.pack ?? 'core'} disable ${o.oldId}`, file: f.packPath })
    }
  } catch (e) {
    restore(written)
    return { ok: false, plan, steps, rolledBack: true, newErrors: [(e as Error).message], equivalentCommand }
  }

  // ⑤ 验证：delta 无新增 error + R11 不得为 error（预期豁免）
  // post-check 必须重读 domain.yml——spec 是写前快照，stale plugins[] 会让 R11
  // 认不出刚插入的成员（roster 无此件时误判「被裁空」→ 假回滚）
  const reparsed = parseDomain(f.domainYml)
  if (!reparsed.spec) {
    restore(written)
    return { ok: false, plan, steps, rolledBack: true, newErrors: [`domain.yml 写后重读失败: ${reparsed.errors.join('; ')}`], equivalentCommand }
  }
  const finalSpec = reparsed.spec
  const post = await runCheckFor(paths, finalSpec)
  const newErrs = post.items.filter((i) => i.level === 'error').map(errFmt).filter((e) => !baselineErrs.has(e))
  const r11 = post.items.find((i) => i.rule === 'R11')
  const expectExemption = f.needDeclare && f.needDisable
  const r11Failed = !!r11 && r11.level === 'error'
  if (newErrs.length || (expectExemption && r11Failed)) {
    restore(written)
    return { ok: false, plan, steps, rolledBack: true, newErrors: newErrs, r11: r11?.msg, equivalentCommand }
  }

  // 成功：记录 check 结果（updateCheckResult 内部已 appendCheckHistory——勿再追加，防双写同一条）
  try {
    updateCheckResult(paths.regYml, finalSpec.domain, post)
  } catch { /* 记录失败不挡替换成功 */ }

  const result: ReplaceResult = {
    ok: true, plan, steps,
    r11: r11 ? `${r11.level}: ${r11.msg}` : undefined,
    rollbackGuide: rollbackGuide(o, paths, plan),
    equivalentCommand,
  }

  // ⑥ 可选冒烟（失败不回滚——运行时问题人工决策）
  if (o.smoke) {
    try {
      const sr: SmokeReport = await runSmoke(finalSpec, { cacheDir: paths.cacheDir })
      const pass = sr.healthOk && sr.cleaned
      result.smoke = { pass, detail: `port=${sr.port} health=${sr.healthOk} apiSmokeExit=${sr.apiSmokeExit} cleaned=${sr.cleaned}` }
      if (!pass) result.ok = false
    } catch (e) {
      result.smoke = { pass: false, detail: (e as Error).message }
      result.ok = false
    }
  }
  return result
}
