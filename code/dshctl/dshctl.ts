/**
 * dshctl.ts — CLI 入口（adopt/check/diff/apply/smoke/upgrade-check/registry）。
 * 运行：bin/dshctl <cmd>（自带 tsx，任意目录可用；编排动作仍走 dsh_source 的 harness 运行时）
 * 退出码：0=通过，1=校验失败，2=执行错误。
 */
import { join } from 'node:path'
import { writeFileSync, readFileSync } from 'node:fs'
import { adoptInstance } from './adopt.ts'
import { parseDomain, renderDomainYml } from './domain.ts'
import { loadRegistry, saveRegistry, upsertInstance, emptyRegistry } from './registry.ts'
import { loadPacks, renderPackYml } from './packs.ts'
import { runChecks, updateCheckResult, loadPrevRoster, type CheckReport } from './check.ts'
import { diffDomain } from './diff.ts'
import { applyDomain, applySummary, dryRun } from './apply.ts'
import { runSmoke } from './smoke.ts'
import { runUpgradeCheck, printUpgradeReport } from './upgrade-check.ts'
import { loadPluginRegistry, savePluginRegistry, addPlugin, removePlugin, setTrusted, publishDomain } from './plugin.ts'
import { loadCoreList, coreIds } from './core.ts'
import { runReplace, type ReplacePaths } from './replace.ts'
import { importFromZip, importFromGit } from './import.ts'
import { atomicWrite, ensureDir, fileExists } from './yml.ts'

const ROOT = join(import.meta.dirname, '..', '..') // dsh-info/
const DOMAINS = join(ROOT, 'domains')
const REGISTRY = join(DOMAINS, 'registry.yml')
const PACKS = join(ROOT, 'code', 'capability-packs')
const CACHE = join(DOMAINS, '.cache')
const PLUGIN_REGISTRY = join(ROOT, 'plugin-registry', 'registry.yml')
const CORE_LIST = join(ROOT, 'plugin-registry', 'core.yml')
const PLUGIN_SOURCES = join(ROOT, 'plugin-registry', 'sources')

function usage(): string {
  return `dshctl v0.3 — DSH 领域编排 CLI（交付期：生成/校验/对账/登记/冒烟/升级跟随；只读写文件与配置）

用法:
  dshctl adopt --instance <name> [--home <DSH_HOME>] [--unit <systemd-unit>] [--json]
      反向归档现存实例 → domains/<name>/domain.yml + capability-packs DRAFT（首次）+ registry 登记
  dshctl check <domain> [--refresh] [--ci] [--json]
      对账器（R1 端口/登记 · R2/R3 上游 roster · R4 script 白名单 · R5 契约目录 · R6 skills · R7 超时 · R8 密钥 env · R9 依赖探活 · R10 归层缺口）
  dshctl diff <domain> [--json]
      只读 diff：apply 生成面对账（能力包/manifest/profile patch/presets；子集语义）
  dshctl apply <domain> [--dry-run] [--yes] [--unit-out <path>]
      落盘生成物（check 有 error 拒绝；--dry-run 只出 diff 零写盘；settings 不生成）
  dshctl smoke <domain> [--bench] [--no-self-test]
      临时实例冒烟：api+100 端口顺延 + overlay patch + api-smoke + 领域自检 + 兜底清理
  dshctl upgrade-check [--refresh] [--json]
      升级跟随对账（手册第 2 步自动化）：全领域跑 R2/R3 子集 → 每领域"需要动的清单"
  dshctl registry [list] [--json]
      实例登记表一览
  dshctl plugin list [--json] | show <id> | trust <id> [--off]
  dshctl plugin add --id <id> --path <入口.ts> [--name --desc]
      插件库收编（登记引用，不拷贝源码；来源 local 默认 trusted）
  dshctl plugin remove <id>
  dshctl plugin publish <domain>
      编排产出入库：domain.yml 的 plugins + api_server 插件逐条登记（已存在跳过）
  dshctl plugin import <zip> --id <id> [--name --desc --entry index.ts]
      zip 导入：解压进 plugin-registry/sources/<id>/（zip-slip 过滤 + 50MB/2000条上限；untrusted）
  dshctl plugin import-git <url> --id <id> [--ref <分支/tag> --entry index.ts]
      git 导入（untrusted）：需 git 可达——本环境 github.com 不可达，失败会提示网络前提
  dshctl replace <old> --with <new> [--domain <域>] [--pack core] [--keep-old] [--path <入口|包名>] [--smoke] [--yes]
      替换通道全链：预检 → core.yml 声明槽成员 → 插入新件到 domain.yml plugins[] → 旧件进能力包 disable →
      check 验证（相对基线无新增 error；预期 R11 槽豁免）；验证不过自动回滚本次写入。
      无 --yes = 预演（零写入打印计划）；--keep-old = 保留旧件共存（M1）
`
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

function printReport(r: CheckReport, asJson: boolean): void {
  if (asJson) { console.log(JSON.stringify(r, null, 2)); return }
  console.log(`\n== check ${r.domain} ==`)
  for (const it of r.items) {
    const mark = it.level === 'pass' ? '✓' : it.level === 'warn' ? '⚠' : '✗'
    console.log(` ${mark} [${it.rule}:${it.level}] ${it.msg}`)
  }
  for (const d of r.degraded ?? []) console.log(` ⚠ [degraded] ${d}`)
  console.log(`\n${r.errors} error(s), ${r.warns} warn(s)${r.errors ? ' → FAIL' : ' → PASS'}`)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(usage()); return 0 }
  const { positional, flags } = parseFlags(argv.slice(1))
  const asJson = !!flags.json

  if (cmd === 'adopt') {
    const name = String(flags.instance ?? positional[0] ?? '')
    if (!name) { console.error('adopt: 需要 --instance <name>'); return 2 }
    const home = String(flags.home ?? join(ROOT, '.dsh-home'))
    const res = adoptInstance(name, home, PACKS, flags.unit ? { unit: String(flags.unit) } : {})
    // 落盘：domain.yml
    const ddir = join(DOMAINS, name)
    ensureDir(ddir)
    atomicWrite(join(ddir, 'domain.yml'), renderDomainYml(res.spec))
    // DRAFT 片段（仅首次）
    for (const p of res.draftPacks) {
      const pPath = join(PACKS, `${p.pack}.yml`)
      if (!fileExists(pPath)) { ensureDir(PACKS); writeFileSync(pPath, renderPackYml(p)) }
    }
    // registry 登记
    const reg = loadRegistry(REGISTRY)
    if (!reg.instances.length && !fileExists(REGISTRY)) Object.assign(reg, emptyRegistry())
    upsertInstance(reg, {
      domain: res.spec.domain, dsh_home: res.spec.dsh_home,
      ports: res.spec.ports ?? {}, ...(res.spec.systemd_unit ? { systemd_unit: res.spec.systemd_unit } : {}),
      status: 'trial',
    })
    saveRegistry(REGISTRY, reg)
    if (asJson) console.log(JSON.stringify({ spec: res.spec, warns: res.warns, classification: res.classification }, null, 2))
    else {
      console.log(`adopt ${name}: domains/${name}/domain.yml + registry 已登记；DRAFT 片段 ${res.draftPacks.length} 个`)
      for (const [pack, ids] of Object.entries(res.classification)) console.log(`  ${pack}: ${ids.length} ids`)
      for (const w of res.warns) console.log(`  ⚠ ${w}`)
      console.log('\n下一步：人工审层 capability-packs/*.yml（删除 DRAFT 行定稿）→ dshctl diff ' + name)
    }
    return 0
  }

  if (cmd === 'check') {
    const name = positional[0]
    if (!name) { console.error('check: 需要 <domain>'); return 2 }
    const dPath = join(DOMAINS, name, 'domain.yml')
    if (!fileExists(dPath)) { console.error(`check: ${dPath} 不存在——先 adopt`); return 2 }
    const { spec, errors } = parseDomain(dPath)
    if (!spec) { console.error(`check: domain.yml 解析失败: ${errors.join('; ')}`); return 2 }
    const version = (() => { try { return String(JSON.parse(readFileSyncSafe(join(spec.dsh_source, 'package.json')))?.version ?? '0.0.0') } catch { return '0.0.0' } })()
    const report = await runChecks(spec, REGISTRY, PACKS, CACHE, { refresh: !!flags.refresh, prevRoster: loadPrevRoster(CACHE, version), pluginRegistryPath: PLUGIN_REGISTRY, coreListPath: CORE_LIST })
    for (const e of errors) report.items.unshift({ rule: e.startsWith('R7') ? 'R7' : e.startsWith('R8') ? 'R8' : 'schema', level: 'error', msg: `${e} → 见 gernalarrange/dshctl-design.md §6` })
    report.errors = report.items.filter((i) => i.level === 'error').length
    updateCheckResult(REGISTRY, name, report)
    printReport(report, asJson)
    if (flags.ci && report.errors) return 1
    return report.errors ? 1 : 0
  }

  if (cmd === 'apply') {
    const name = positional[0]
    if (!name) { console.error('apply: 需要 <domain>'); return 2 }
    const dPath = join(DOMAINS, name, 'domain.yml')
    if (!fileExists(dPath)) { console.error(`apply: ${dPath} 不存在——先 adopt 或手工编写清单`); return 2 }
    const { spec, errors } = parseDomain(dPath)
    if (!spec) { console.error(`apply: domain.yml 解析失败: ${errors.join('; ')}`); return 2 }
      const version = (() => { try { return String(JSON.parse(readFileSyncSafe(join(spec.dsh_source, 'package.json')))?.version ?? '0.0.0') } catch { return '0.0.0' } })()
    const report = await runChecks(spec, REGISTRY, PACKS, CACHE, { refresh: false, prevRoster: loadPrevRoster(CACHE, version), pluginRegistryPath: PLUGIN_REGISTRY, coreListPath: CORE_LIST })
    if (report.errors) { printReport(report, asJson); console.error('apply 拒绝：check 有 error（先修复再落盘）'); return 1 }
    if (flags['dry-run']) {
      const { report: d, unitText } = dryRun(spec, PACKS)
      if (asJson) console.log(JSON.stringify({ diff: d, unit: unitText }, null, 2))
      else {
        console.log(`apply ${name} --dry-run：${d.empty ? '生成物与现状一致（零写盘）' : '将产生以下差异'}`)
        for (const l of d.lines) console.log('  ' + l)
        for (const n of d.notes) console.log(`  · ${n}`)
      }
      return d.empty ? 0 : 1
    }
    if (!flags.yes) { console.error('apply 需要 --yes 确认（写盘操作；建议先 --dry-run 审阅）'); return 2 }
    const res = applyDomain(spec, PACKS, flags['unit-out'] ? { unitOut: String(flags['unit-out']) } : {})
    if (res.errors.length) { for (const e of res.errors) console.error(`apply 错误: ${e}`); return 2 }
    const reg = loadRegistry(REGISTRY)
    upsertInstance(reg, { domain: spec.domain, dsh_home: spec.dsh_home, ports: spec.ports ?? {}, ...(spec.systemd_unit ? { systemd_unit: spec.systemd_unit } : {}), status: reg.instances.find((i) => i.domain === spec.domain)?.status ?? 'trial', applied_at: new Date().toISOString().slice(0, 10) })
    saveRegistry(REGISTRY, reg)
    if (asJson) console.log(JSON.stringify(res, null, 2))
    else { console.log(applySummary(spec, res)); console.log('\n--- systemd unit 模板（安装由人执行）---\n' + res.unitText) }
    return 0
  }

  if (cmd === 'smoke') {
    const name = positional[0]
    if (!name) { console.error('smoke: 需要 <domain>'); return 2 }
    const dPath = join(DOMAINS, name, 'domain.yml')
    if (!fileExists(dPath)) { console.error(`smoke: ${dPath} 不存在`); return 2 }
    const { spec } = parseDomain(dPath)
    if (!spec) { console.error('smoke: domain.yml 解析失败'); return 2 }
    const report = await runSmoke(spec, { cacheDir: CACHE, selfTest: !flags['no-self-test'], bench: !!flags.bench })
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`\n== smoke ${name} (port ${report.port}) ==`)
      for (const n of report.notes) console.log(` · ${n}`)
      console.log(` health: ${report.healthOk ? '✓' : '✗'}  api-smoke exit: ${report.apiSmokeExit}  bench: ${report.benchExit ?? '-'}  self-tests: ${report.selfTests.map((s) => s.exit).join(',') || '-'}  cleaned: ${report.cleaned}`)
    }
    const benchOk = report.benchExit === undefined || report.benchExit === 0
    return report.healthOk && report.apiSmokeExit === 0 && benchOk && report.selfTests.every((s) => s.exit === 0) ? 0 : 1
  }

  if (cmd === 'diff') {
    const name = positional[0]
    if (!name) { console.error('diff: 需要 <domain>'); return 2 }
    const dPath = join(DOMAINS, name, 'domain.yml')
    if (!fileExists(dPath)) { console.error(`diff: ${dPath} 不存在——先 adopt`); return 2 }
    const { spec } = parseDomain(dPath)
    if (!spec) { console.error('diff: domain.yml 解析失败'); return 2 }
    const report = diffDomain(spec, PACKS)
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else if (report.empty) console.log(`diff ${name}: 空 ✓（apply 生成面与现状一致——程序正确理解现状）`)
    else { console.log(`diff ${name}: 非空（差异即归层/生成面调整，逐项人工确认）`); for (const l of report.lines) console.log('  ' + l) }
    for (const n of report.notes) console.log(`  · ${n}`)
    return report.empty ? 0 : 1
  }

  if (cmd === 'upgrade-check') {
    const report = runUpgradeCheck({ registryPath: REGISTRY, domainsDir: DOMAINS, packsDir: PACKS, cacheDir: CACHE, refresh: !!flags.refresh })
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else printUpgradeReport(report)
    return report.verdict === 'pass' ? 0 : report.verdict === 'blocked' ? 1 : 2
  }

  if (cmd === 'registry') {
    const reg = loadRegistry(REGISTRY)
    if (asJson) { console.log(JSON.stringify(reg, null, 2)); return 0 }
    console.log('\n== registry ==')
    for (const i of reg.instances) {
      console.log(` ${i.domain}: home=${i.dsh_home} api=${i.ports.api ?? '-'} gui=${i.ports.gui ?? 'headless'} unit=${i.systemd_unit ?? '-'} status=${i.status ?? '-'} last_check=${i.last_check?.at ?? '-'}(${i.last_check?.result ?? '-'})`)
    }
    if (reg.unregistered_ports.length) console.log(` unregistered: ${reg.unregistered_ports.join(', ')}`)
    return 0
  }

  if (cmd === 'plugin') {
    const sub = positional[0]
    const reg = loadPluginRegistry(PLUGIN_REGISTRY)
    if (sub === 'list' || !sub) {
      if (asJson) { console.log(JSON.stringify({ ...reg, core: { schema: 1, core: coreIds(loadCoreList(CORE_LIST).core) } }, null, 2)); return 0 }
      console.log('\n== plugin-registry ==')
      for (const p of reg.plugins) console.log(` ${p.id}: ${p.path} [${p.source ?? 'local'}${p.trusted ? '' : ' ⚠untrusted'}]${p.description ? ' — ' + p.description : ''}`)
      console.log(` core 必须件 ${coreIds(loadCoreList(CORE_LIST).core).length} 项（R11：核心功能不可缺，槽内实现可替换）`)
      return 0
    }
    if (sub === 'show') {
      const id = positional[1]
      const e = reg.plugins.find((x) => x.id === id)
      if (!e) { console.error(`plugin show: '${id}' 不在插件库`); return 1 }
      if (asJson) console.log(JSON.stringify(e, null, 2)); else console.log(JSON.stringify(e, null, 2))
      return 0
    }
    if (sub === 'add') {
      const id = String(flags.id ?? '')
      const path = String(flags.path ?? '')
      if (!id || !path) { console.error('plugin add: 需要 --id <id> --path <入口.ts>'); return 2 }
      const r = addPlugin(reg, { id, path, ...(flags.name ? { name: String(flags.name) } : {}), ...(flags.desc ? { description: String(flags.desc) } : {}) })
      if (!r.ok) { for (const e of r.errors) console.error(`plugin add: ${e}`); return 1 }
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`plugin add ${id}: 已登记 → ${path}（source=local, trusted=true）`)
      return 0
    }
    if (sub === 'remove') {
      const id = positional[1]
      if (!id || !removePlugin(reg, id)) { console.error(`plugin remove: '${id}' 不在插件库`); return 1 }
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`plugin remove ${id}: 已从库移除（源码未动——登记引用模式）`)
      return 0
    }
    if (sub === 'trust') {
      const id = positional[1]
      const on = !flags.off
      if (!id || !setTrusted(reg, id, on)) { console.error(`plugin trust: '${id}' 不在插件库`); return 1 }
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`plugin trust ${id}: trusted=${on}`)
      return 0
    }
    if (sub === 'publish') {
      const name = positional[1]
      const dPath = join(DOMAINS, name ?? '', 'domain.yml')
      if (!name || !fileExists(dPath)) { console.error(`publish: ${dPath} 不存在`); return 2 }
      const { spec, errors } = parseDomain(dPath)
      if (!spec) { console.error(`publish: domain.yml 解析失败: ${errors.join('; ')}`); return 2 }
      const r = publishDomain(reg, spec)
      if (r.errors.length) { for (const e of r.errors) console.error(`publish: ${e}`); return 1 }
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`publish ${name}: 新入库 ${r.added.length ? r.added.join(', ') : '（无）'}；跳过已存在 ${r.skipped.join(', ') || '（无）'}`)
      return 0
    }
    if (sub === 'import') {
      const zip = positional[1]
      const id = String(flags.id ?? '')
      if (!zip || !id) { console.error('plugin import: 需要 <zip> --id <id>'); return 2 }
      const save = () => savePluginRegistry(PLUGIN_REGISTRY, reg)
      const r = importFromZip(zip, reg, PLUGIN_SOURCES, { id, ...(flags.name ? { name: String(flags.name) } : {}), ...(flags.desc ? { description: String(flags.desc) } : {}), ...(flags.entry ? { entry: String(flags.entry) } : {}) }, save)
      if (!r.ok) { for (const e of r.errors) console.error(`plugin import: ${e}`); return 1 }
      console.log(`plugin import ${id}: 已解压 → plugin-registry/sources/${id}/（untrusted——核实后 dshctl plugin trust ${id}）`)
      return 0
    }
    if (sub === 'import-git') {
      const url = positional[1]
      const id = String(flags.id ?? '')
      if (!url || !id) { console.error('plugin import-git: 需要 <url> --id <id>'); return 2 }
      const save = () => savePluginRegistry(PLUGIN_REGISTRY, reg)
      const r = importFromGit(url, reg, PLUGIN_SOURCES, { id, ...(flags.ref ? { ref: String(flags.ref) } : {}), ...(flags.entry ? { entry: String(flags.entry) } : {}) }, save)
      if (!r.ok) { for (const e of r.errors) console.error(`plugin import-git: ${e}`); return 1 }
      console.log(`plugin import-git ${id}: 已克隆 → plugin-registry/sources/${id}/（untrusted——核实后 dshctl plugin trust ${id}）`)
      return 0
    }
    console.error(`未知 plugin 子命令: ${sub ?? ''}（list/show/add/remove/trust/publish/import/import-git）`)
    return 2
  }

  // ── replace：替换通道全链（预检 → 声明 → 插入 → 禁旧 → check；失败自动回滚）──
  if (cmd === 'replace') {
    const oldId = positional[0]
    const newId = flags.with ? String(flags.with) : ''
    if (!oldId || !newId) { console.error('replace: 需要 <old> --with <new>（dshctl help 看完整用法）'); return 2 }
    const paths: ReplacePaths = {
      domainsDir: DOMAINS, packsDir: PACKS, cacheDir: CACHE,
      regYml: REGISTRY, pluginRegistryPath: PLUGIN_REGISTRY, corePath: CORE_LIST,
    }
    const result = await runReplace(paths, {
      oldId, newId,
      domain: String(flags.domain ?? 'ops'),
      ...(flags.pack ? { pack: String(flags.pack) } : {}),
      ...(flags['keep-old'] ? { keepOld: true } : {}),
      ...(flags.path ? { newPath: String(flags.path) } : {}),
      ...(flags.smoke ? { smoke: true } : {}),
    }, { yes: !!flags.yes })

    if (result.plan.warnings.length) for (const w of result.plan.warnings) console.log(`⚠ ${w}`)
    if (!result.ok && !result.steps?.length && result.plan.errors.length) {
      for (const e of result.plan.errors) console.error(`replace: ${e}`)
      return 1
    }
    if (result.dryRun) {
      console.log(`replace 预演（未写入，加 --yes 执行）：${oldId} → ${newId}`)
      for (const s of result.plan.steps) console.log(`  · ${s.action}${s.file ? `   [${s.file}]` : ''}`)
      console.log(`等价命令：${result.equivalentCommand}`)
      return 0
    }
    if (result.ok) {
      console.log(`replace 成功：${oldId} → ${newId}`)
      for (const s of result.steps ?? []) console.log(`  ✓ ${s.action}`)
      if (result.r11) console.log(`R11: ${result.r11}`)
      if (result.smoke) console.log(`smoke: ${result.smoke.pass ? 'PASS' : 'FAIL'}（${result.smoke.detail}）`)
      if (result.rollbackGuide) console.log(`\n${result.rollbackGuide}`)
      return 0
    }
    console.error(`replace 失败${result.rolledBack ? '（本次写入已自动回滚）' : ''}`)
    for (const e of result.newErrors ?? []) console.error(`  + ${e}`)
    if (result.r11) console.error(`  R11: ${result.r11}`)
    return 1
  }

  console.error(`未知命令: ${cmd}\n`)
  process.stdout.write(usage())
  return 2
}

function readFileSyncSafe(p: string): string {
  return readFileSync(p, 'utf8')
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`执行错误: ${(e as Error).message}`); process.exit(2) })
