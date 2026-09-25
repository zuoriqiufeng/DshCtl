/**
 * dshctl.ts — CLI 入口（domain new/list · adopt · check · up · diff · apply · smoke · upgrade-check · registry · plugin · replace · gui）。
 * 运行：bin/dshctl <cmd>（自带 tsx，任意目录可用；编排动作仍走 dsh_source 的 harness 运行时）
 * 退出码：0=通过/无差异；1=校验失败或存在待处理差异；2=用法/执行错误。
 *   check --ci = 门禁模式：供 CI/脚本判定（error→1；另强制素色输出）；--strict = 严格模式（warn 也→1）。
 *   v0.3 的 --ci 是空操作（两分支等价），v0.4 起按上述语义真生效。
 * 帮助：dshctl <cmd> --help 看单条命令（用法/参数/示例）；无参数打印全量 usage。
 */
import { join } from 'node:path'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { adoptInstance } from './adopt.ts'
import { parseDomain, renderDomainYml, renderDomainSkeleton, DOMAIN_RE, type DomainSpec } from './domain.ts'
import { loadRegistry, saveRegistry, upsertInstance, emptyRegistry, listDomainNames, pickDomain } from './registry.ts'
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
import { scaffoldPlugin, packPlugin, installIntoDomain } from './unitize.ts'
import { atomicWrite, ensureDir, fileExists } from './yml.ts'

const ROOT = join(import.meta.dirname, '..', '..') // dsh-info/
const DOMAINS = join(ROOT, 'domains')
const REGISTRY = join(DOMAINS, 'registry.yml')
const PACKS = join(ROOT, 'code', 'capability-packs')
const CACHE = join(DOMAINS, '.cache')
const PLUGIN_REGISTRY = join(ROOT, 'plugin-registry', 'registry.yml')
const CORE_LIST = join(ROOT, 'plugin-registry', 'core.yml')
const PLUGIN_SOURCES = join(ROOT, 'plugin-registry', 'sources')

const VERSION = (() => { try { return String(JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')).version) } catch { return '0.0.0' } })()

// ── ANSI 着色（TTY 且未设 NO_COLOR；--json 输出永远素色；--no-color 显式关闭）──
let COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string, s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const green = (s: string): string => paint('32', s)
const yellow = (s: string): string => paint('33', s)
const red = (s: string): string => paint('31', s)
const bold = (s: string): string => paint('1', s)

// ── 命令元数据：usage() 与 `dshctl <cmd> --help` 的单一来源 ──
interface CmdHelp { name: string; args: string; desc: string; detail?: string[]; examples?: string[] }
const CMDS: CmdHelp[] = [
  {
    name: 'domain new', args: '<name> [--from <已有域>] [--home <DSH_HOME>] [--port <api>] [--source <dsh_source>]', desc: '生成 domain.yml 骨架（路径自动推导，不再手写绝对路径）',
    detail: ['dsh_home 默认取未被占用的 .dsh-home；被现有域占用时自动落到 .dsh-home-<name>',
      'api 端口默认取登记表中未占用的最小值（≥8643）；api_key_env 默认 <NAME>_API_KEY',
      'preset.source 默认 code/presets/<name>（放 persona + agent.cordis.yml；apply 时拷进 DSH_HOME）',
      '骨架只写清单——实例骨架（settings/凭据/unit 安装）仍由 apply 提示人工完成'],
    examples: ['dshctl domain new sql-transform', 'dshctl domain new sql-transform --from ops'],
  },
  { name: 'domain list', args: '[--json]', desc: 'domains/ 下全部领域清单（与 registry 登记态并排）' },
  {
    name: 'adopt', args: '--instance <name> [--home <DSH_HOME>] [--unit <systemd-unit>] [--json]', desc: '反向归档现存实例 → domains/<name>/domain.yml + capability-packs DRAFT（首次）+ registry 登记',
    examples: ['dshctl adopt --instance ops'],
  },
  {
    name: 'check', args: '<domain> [--refresh] [--ci] [--strict] [--json]', desc: '对账器（R1 端口/登记 · R2/R3 上游 roster · R4 script 白名单 · R5 契约目录 · R6 skills · R7 超时 · R8 密钥 env · R9 依赖探活 · R10 归层缺口 · R11 核心清单 · R12 插件库 · R13 registry 交叉）',
    detail: ['--ci = 门禁模式：供 CI/脚本判定（error→1），并强制素色输出；不带时仅 error 也→1，但保留 TTY 着色',
      '--strict = 严格模式：warn 也→1（可与 --ci 组合）'],
    examples: ['dshctl check ops --ci'],
  },
  {
    name: 'up', args: '<domain> [--yes] [--skip-smoke] [--refresh]', desc: '一键链：check → dry-run 预览 →（--yes）apply 落盘 → smoke 冒烟',
    detail: ['不加 --yes 时只做只读预览（check + dry-run），零写盘', 'smoke 起临时实例（api+100 端口），不碰现网；--skip-smoke 跳过',
      'unit 安装与 settings/.credentials 拷贝仍为人工步骤（执行后会打印指引）'],
    examples: ['dshctl up ops            # 预览到 dry-run 为止', 'dshctl up ops --yes      # 全链执行到 smoke'],
  },
  { name: 'diff', args: '<domain> [--json]', desc: '只读 diff：apply 生成面对账（能力包/manifest/profile patch/presets；子集语义）', examples: ['dshctl diff ops'] },
  {
    name: 'apply', args: '<domain> [--dry-run] [--yes] [--unit-out <path>]', desc: '落盘生成物（check 有 error 拒绝；--dry-run 只出 diff 零写盘；settings 不生成）',
    detail: ['退出码：0=无差异已一致；1=存在待落盘差异（--dry-run 时）；2=用法/执行错误'],
    examples: ['dshctl apply ops --dry-run', 'dshctl apply ops --yes'],
  },
  { name: 'smoke', args: '<domain> [--bench] [--no-self-test]', desc: '临时实例冒烟：api+100 端口顺延 + overlay patch + api-smoke + 领域自检 + 兜底清理', examples: ['dshctl smoke ops'] },
  { name: 'upgrade-check', args: '[--refresh] [--json]', desc: '升级跟随对账（手册第 2 步自动化）：全领域跑 R2/R3 子集 → 每领域"需要动的清单"', examples: ['dshctl upgrade-check'] },
  { name: 'registry', args: '[--json]', desc: '实例登记表一览', examples: ['dshctl registry'] },
  {
    name: 'plugin', args: 'list | show <id> | add | scaffold <id> | pack <id> | install <id> --domain <域> | remove <id> | trust <id> [--off] | publish <domain> | import <zip> --id <id> | import-git <url> --id <id>', desc: '插件库：登记 / 收编 / 导入 / 单元化 / 信任 / 发布',
    detail: ['add 按参数形态自动判型：存在的目录/文件 → local 收编；*.zip → zip 导入；http(s):// 或 git@ → git 导入',
      'import / import-git 保留为显式别名（行为不变）；zip/git 导入默认 untrusted——核实后 trust',
      'scaffold = 把插件目录补成自描述单元（dsh.plugin.yml + package.json main/exports/files/peerDeps）',
      'pack = tsc 构建出 lib/ + 生成组合包 patch + pnpm pack → tgz（上游②通道可消费）',
      'install = 把插件装进领域 domain.yml plugins[]（layout 决定 in-place / vendored 路径）'],
    examples: ['dshctl plugin list', 'dshctl plugin add --id bkn-plugin --path code/dsh-plugin/index.ts', 'dshctl plugin add --id demo --path ~/downloads/demo.zip'],
  },
  {
    name: 'replace', args: '<old> --with <new> [--domain <域>] [--pack core] [--keep-old] [--path <入口|包名>] [--smoke] [--yes]', desc: '替换通道全链：预检 → core.yml 声明槽成员 → 插入新件到 domain.yml plugins[] → 旧件进能力包 disable → check 验证（失败自动回滚）',
    detail: ['无 --yes = 预演（零写入打印计划）；--keep-old = 保留旧件共存'],
    examples: ['dshctl replace tool-bash --with tool-bash-persistent --smoke'],
  },
]

function usageFor(c: CmdHelp): string {
  const lines = [`用法: dshctl ${c.name} ${c.args}`, `    ${c.desc}`]
  for (const d of c.detail ?? []) lines.push(`    · ${d}`)
  for (const e of c.examples ?? []) lines.push(`    示例: ${e}`)
  return lines.join('\n')
}

function usage(): string {
  const head = `dshctl v${VERSION} — DSH 领域编排 CLI（交付期：生成/校验/对账/登记/冒烟/升级跟随；只读写文件与配置）

`
  const body = CMDS.map((c) => `  dshctl ${c.name} ${c.args}\n      ${c.desc}`).join('\n')
  const tail = `

提示:
  dshctl <cmd> --help   单条命令的参数与示例
  dshctl up <域>        一条命令跑 check → apply → smoke
  退出码: 0=通过/无差异 · 1=校验失败或存在差异 · 2=用法/执行错误
  术语: 领域(domain)=domain.yml 清单；实例=该清单落盘后的运行部署（registry 登记）
`
  return head + body + tail
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

/** 统一用法错误：报缺什么 + 指向单命令 help（v0.3 只报缺什么都不给下一步） */
function usageError(cmd: string, msg: string): number {
  console.error(`${cmd}: ${msg}（用法与示例: dshctl help ${cmd}）`)
  return 2
}

function printReport(r: CheckReport, asJson: boolean, colorOk = COLOR): void {
  if (asJson) { console.log(JSON.stringify(r, null, 2)); return }
  const p = (c: string, s: string): string => (colorOk ? `\x1b[${c}m${s}\x1b[0m` : s)
  console.log(`\n== check ${r.domain} ==`)
  for (const it of r.items) {
    const mark = it.level === 'pass' ? p('32', '✓') : it.level === 'warn' ? p('33', '⚠') : p('31', '✗')
    console.log(` ${mark} [${it.rule}:${it.level}] ${it.msg}`)
  }
  for (const d of r.degraded ?? []) console.log(` ${p('33', '⚠')} [degraded] ${d}`)
  const tail = `${r.errors} error(s), ${r.warns} warn(s)${r.errors ? ' → ' + p('31', 'FAIL') : ' → ' + p('32', 'PASS')}`
  console.log(`\n${tail}`)
}

function readFileSyncSafe(p: string): string {
  return readFileSync(p, 'utf8')
}

/** 域清单加载三连（存在性 → 解析 → 返回 spec 或错误文本）；check/apply/diff/smoke/up 共用 */
function loadSpec(cmd: string, name: string): { spec: DomainSpec } | { error: string; code: number } {
  const dPath = join(DOMAINS, name, 'domain.yml')
  if (!fileExists(dPath)) return { error: `${dPath} 不存在${name === 'ops' ? '——先 adopt' : '——先 dshctl domain new ' + name + ' 或 adopt'}`, code: 2 }
  const { spec, errors } = parseDomain(dPath)
  if (!spec) return { error: `domain.yml 解析失败: ${errors.join('; ')}`, code: 2 }
  return { spec }
}

/** check 执行体（check 与 up 共用；写 last_check 历史） */
async function runCheckFor(name: string, spec: DomainSpec, flags: Record<string, string | boolean>, asJson: boolean): Promise<{ code: number; report: CheckReport }> {
  const version = (() => { try { return String(JSON.parse(readFileSyncSafe(join(spec.dsh_source, 'package.json')))?.version ?? '0.0.0') } catch { return '0.0.0' } })()
  const report = await runChecks(spec, REGISTRY, PACKS, CACHE, { refresh: !!flags.refresh, prevRoster: loadPrevRoster(CACHE, version), pluginRegistryPath: PLUGIN_REGISTRY, coreListPath: CORE_LIST })
  updateCheckResult(REGISTRY, name, report)
  printReport(report, asJson, asJson ? false : !flags.ci)
  const failed = report.errors > 0 || (!!flags.strict && report.warns > 0)
  return { code: failed ? 1 : 0, report }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(usage()); return 0 }
  if (cmd === 'help') {
    const target = argv[1]
    const c = CMDS.find((x) => x.name === target || x.name.split(' ')[0] === target)
    if (!c) { process.stdout.write(usage()); return target ? 2 : 0 }
    process.stdout.write(usageFor(c) + '\n')
    return 0
  }
  const helpWanted = argv.includes('--help') || argv.includes('-h')
  const { positional, flags } = parseFlags(argv.slice(1))
  const asJson = !!flags.json
  if (flags['no-color']) COLOR = false
  if (helpWanted) {
    const c = CMDS.find((x) => x.name === cmd || x.name.split(' ')[0] === cmd)
    if (c) { process.stdout.write(usageFor(c) + '\n'); return 0 }
    // 未知命令的 --help 落到末尾的未知命令分支
  }

  // ── domain new / list ──
  if (cmd === 'domain') {
    const sub = positional[0]
    if (sub === 'new' || sub === 'create') {
      const name = positional[1] ?? ''
      if (!name) return usageError('domain new', '需要 <name>')
      if (!DOMAIN_RE.test(name)) return usageError('domain new', `域名 '${name}' 非法（须 ${DOMAIN_RE}）`)
      const dPath = join(DOMAINS, name, 'domain.yml')
      if (fileExists(dPath)) return usageError('domain new', `domains/${name}/domain.yml 已存在（改用编辑或 adopt）`)
      const claimed = new Set<string>(loadRegistry(REGISTRY).instances.map((i) => i.dsh_home))
      for (const n of listDomainNames(DOMAINS)) {
        const s = loadSpec('domain new', n)
        if ('spec' in s) claimed.add(s.spec.dsh_home)
      }
      const defaultHome = claimed.has(join(ROOT, '.dsh-home')) ? join(ROOT, `.dsh-home-${name}`) : join(ROOT, '.dsh-home')
      const home = flags.home ? String(flags.home) : defaultHome
      const usedPorts = new Set<number>(loadRegistry(REGISTRY).instances.flatMap((i) => Object.values(i.ports ?? {})).filter((p): p is number => typeof p === 'number'))
      for (const n of listDomainNames(DOMAINS)) {
        const s = loadSpec('domain new', n)
        if ('spec' in s && s.spec.ports?.api) usedPorts.add(s.spec.ports.api)
      }
      if (flags.port === true) return usageError('domain new', '--port 需要值（如 --port 8644）')
      let port = typeof flags.port === 'string' ? Number(flags.port) : 8643
      if (!Number.isInteger(port) || port <= 0) return usageError('domain new', `--port '${String(flags.port)}' 不是正整数`)
      if (flags.port === undefined) { while (usedPorts.has(port)) port++ }
      const source = flags.source ? String(flags.source) : join(ROOT, 'deepseek-harness')
      const presetSource = existsSync(join(ROOT, 'code', 'presets', name)) ? join(ROOT, 'code', 'presets', name) : join(home, 'presets', name)
      // --from 派生：复制可复用段（capabilities/guard/memory/shared_deps/plugins/api_server 细节），重写身份字段
      let derived: Partial<DomainSpec> | undefined
      if (flags.from) {
        const fromName = String(flags.from)
        const base = loadSpec('domain new', fromName)
        if ('error' in base) return usageError('domain new', base.error)
        const { domain: _d, display_name: _dn, dsh_home: _h, ports: _p, systemd_unit: _u, api_key_env: _ake, ...rest } = base.spec as unknown as Record<string, unknown>
        void _d; void _dn; void _h; void _p; void _u; void _ake
        derived = rest as Partial<DomainSpec>
      }
      const skeleton = renderDomainSkeleton(name, { home, source, port, presetSource, unit: `dsh-${name}.service`, derived })
      ensureDir(join(DOMAINS, name))
      atomicWrite(dPath, skeleton)
      // preset 源目录（apply 拷贝源）——空目录合法；skills_dirs 默认不声明（无技能域合法，R6 不扫）
      if (asJson) { console.log(JSON.stringify({ domain: name, path: dPath, home, port }, null, 2)); return 0 }
      console.log(`domain new ${name}: 已生成 ${dPath}`)
      console.log(`  dsh_home=${home}${claimed.has(join(ROOT, '.dsh-home')) && home !== join(ROOT, '.dsh-home') ? '（.dsh-home 已被现有域占用——独立 home 避免 ops-app 能力包互相覆盖）' : ''}`)
      console.log(`  api 端口=${port} · systemd unit=dsh-${name}.service · api_key_env=${name.toUpperCase().replace(/-/g, '_')}_API_KEY`)
      console.log(`\n下一步：`)
      console.log(green(`  1) 编辑清单核对 [ ] 标注项 → dshctl check ${name}`))
      console.log(green(`  2) dshctl up ${name}            # 预览到 dry-run；加 --yes 全链执行`))
      console.log(green(`  3) dshctl plugin install <id> --domain ${name}   # 需要插件时（阶段 2 提供）`))
      return 0
    }
    if (sub === 'list' || !sub) {
      const names = listDomainNames(DOMAINS)
      const reg = loadRegistry(REGISTRY)
      if (asJson) { console.log(JSON.stringify({ domains: names, registry: reg.instances }, null, 2)); return 0 }
      if (!names.length) { console.log('domains/ 下没有领域清单——dshctl domain new <name> 或 dshctl adopt --instance <name>'); return 0 }
      console.log('\n== domains ==')
      for (const n of names) {
        const inst = reg.instances.find((i) => i.domain === n)
        const mark = inst?.last_check?.result === 'pass' ? green('✓') : inst?.last_check?.result === 'fail' ? red('✗') : yellow('·')
        console.log(` ${mark} ${n}${inst ? `  [登记 unit=${inst.systemd_unit ?? '-'} api=${inst.ports.api ?? '-'} last_check=${inst.last_check?.at ?? '-'}]` : '  [未登记——apply 后自动登记]'}`)
      }
      return 0
    }
    console.error(`未知 domain 子命令: ${sub}（new/list）`)
    return 2
  }

  if (cmd === 'adopt') {
    const name = String(flags.instance ?? positional[0] ?? '')
    if (!name) return usageError('adopt', '需要 --instance <name>')
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
      for (const w of res.warns) console.log(`  ${yellow('⚠')} ${w}`)
      console.log('\n下一步：人工审层 capability-packs/*.yml（删除 DRAFT 行定稿）→ dshctl diff ' + name)
    }
    return 0
  }

  if (cmd === 'check') {
    const inf = pickDomain(process.cwd(), DOMAINS, (positional[0] ?? (typeof flags.domain === 'string' ? flags.domain : '')), listDomainNames(DOMAINS))
    if ('candidates' in inf) return usageError('check', `需要 <domain>（候选: ${inf.candidates.join(', ') || '无——先 domain new 或 adopt'}）`)
    const loaded = loadSpec('check', inf.name)
    if ('error' in loaded) { console.error(`check: ${loaded.error}`); return loaded.code }
    const { code } = await runCheckFor(inf.name, loaded.spec, flags, asJson)
    return code
  }

  if (cmd === 'apply') {
    const inf = pickDomain(process.cwd(), DOMAINS, (positional[0] ?? (typeof flags.domain === 'string' ? flags.domain : '')), listDomainNames(DOMAINS))
    if ('candidates' in inf) return usageError('apply', `需要 <domain>（候选: ${inf.candidates.join(', ') || '无——先 domain new 或 adopt'}）`)
    const loaded = loadSpec('apply', inf.name)
    if ('error' in loaded) { console.error(`apply: ${loaded.error}`); return loaded.code }
    const spec = loaded.spec
    const version = (() => { try { return String(JSON.parse(readFileSyncSafe(join(spec.dsh_source, 'package.json')))?.version ?? '0.0.0') } catch { return '0.0.0' } })()
    const report = await runChecks(spec, REGISTRY, PACKS, CACHE, { refresh: false, prevRoster: loadPrevRoster(CACHE, version), pluginRegistryPath: PLUGIN_REGISTRY, coreListPath: CORE_LIST })
    if (report.errors) { printReport(report, asJson); console.error('apply 拒绝：check 有 error（先修复再落盘）'); return 1 }
    if (flags['dry-run']) {
      const { report: d, unitText } = dryRun(spec, PACKS)
      if (asJson) console.log(JSON.stringify({ diff: d, unit: unitText }, null, 2))
      else {
        console.log(`apply ${inf.name} --dry-run：${d.empty ? '生成物与现状一致（零写盘）' : '将产生以下差异'}`)
        for (const l of d.lines) console.log('  ' + l)
        for (const n of d.notes) console.log(`  · ${n}`)
      }
      return d.empty ? 0 : 1
    }
    if (!flags.yes) return usageError('apply', '需要 --yes 确认（写盘操作；建议先 --dry-run 审阅）')
    const res = applyDomain(spec, PACKS, flags['unit-out'] ? { unitOut: String(flags['unit-out']) } : {})
    if (res.errors.length) { for (const e of res.errors) console.error(`apply 错误: ${e}`); return 2 }
    const reg = loadRegistry(REGISTRY)
    upsertInstance(reg, { domain: spec.domain, dsh_home: spec.dsh_home, ports: spec.ports ?? {}, ...(spec.systemd_unit ? { systemd_unit: spec.systemd_unit } : {}), status: reg.instances.find((i) => i.domain === spec.domain)?.status ?? 'trial', applied_at: new Date().toISOString().slice(0, 10) })
    saveRegistry(REGISTRY, reg)
    if (asJson) console.log(JSON.stringify(res, null, 2))
    else { console.log(applySummary(spec, res)); console.log('\n--- systemd unit 模板（安装由人执行）---\n' + res.unitText) }
    return 0
  }

  // ── up：一键链 check → dry-run →（--yes）apply → smoke ──
  if (cmd === 'up') {
    const inf = pickDomain(process.cwd(), DOMAINS, (positional[0] ?? (typeof flags.domain === 'string' ? flags.domain : '')), listDomainNames(DOMAINS))
    if ('candidates' in inf) return usageError('up', `需要 <domain>（候选: ${inf.candidates.join(', ') || '无——先 domain new 或 adopt'}）`)
    const name = inf.name
    console.log(bold(`== up ${name} ==`))
    // ① check（up 内永远严格：error 拦截；--ci 透传 warn 严格语义）
    const loaded = loadSpec('up', name)
    if ('error' in loaded) { console.error(`up: ${loaded.error}`); return loaded.code }
    const ck = await runCheckFor(name, loaded.spec, { ...flags, ci: true }, asJson)
    if (ck.code !== 0) { console.error(red('up 停止：check 未过（先修复再 up）')); return 1 }
    // ② dry-run 预览
    const { report: d } = dryRun(loaded.spec, PACKS)
    if (asJson) console.log(JSON.stringify({ step: 'dry-run', diff: d }, null, 2))
    else {
      console.log(`\n[2/4] dry-run：${d.empty ? green('生成物与现状一致（零写盘）') : yellow('将产生以下差异')}`)
      for (const l of d.lines) console.log('  ' + l)
      for (const n of d.notes) console.log(`  · ${n}`)
    }
    if (!flags.yes) {
      console.log(`\n预览完成（零写盘）。确认执行：${bold(`dshctl up ${name} --yes`)}`)
      return 0
    }
    // ③ apply
    const res = applyDomain(loaded.spec, PACKS, {})
    if (res.errors.length) { for (const e of res.errors) console.error(`apply 错误: ${e}`); return 2 }
    const reg = loadRegistry(REGISTRY)
    upsertInstance(reg, { domain: loaded.spec.domain, dsh_home: loaded.spec.dsh_home, ports: loaded.spec.ports ?? {}, ...(loaded.spec.systemd_unit ? { systemd_unit: loaded.spec.systemd_unit } : {}), status: reg.instances.find((i) => i.domain === loaded.spec.domain)?.status ?? 'trial', applied_at: new Date().toISOString().slice(0, 10) })
    saveRegistry(REGISTRY, reg)
    if (!asJson) {
      console.log(`\n[3/4] apply：写入 ${res.written.length} 个文件`)
      for (const w of res.written) console.log(`  + ${w}`)
      for (const s of res.skipped) console.log(`  · ${s}`)
      console.log(yellow('\n人工步骤：① settings/.credentials 若缺失从模板实例拷贝；② systemctl 安装 unit（模板见上）后启停。'))
    }
    if (flags['skip-smoke']) { console.log('[4/4] smoke：--skip-smoke 跳过'); return 0 }
    // ④ smoke（临时实例，不碰现网）
    console.log(`\n[4/4] smoke（临时实例 api+100）`)
    const sreport = await runSmoke(loaded.spec, { cacheDir: CACHE, selfTest: true, bench: false })
    if (!asJson) {
      console.log(` health: ${sreport.healthOk ? green('✓') : red('✗')}  api-smoke exit: ${sreport.apiSmokeExit}  self-tests: ${sreport.selfTests.map((s) => s.exit).join(',') || '-'}  cleaned: ${sreport.cleaned}`)
      for (const n of sreport.notes) console.log(` · ${n}`)
    } else console.log(JSON.stringify({ step: 'smoke', report: sreport }, null, 2))
    const benchOk = sreport.benchExit === undefined || sreport.benchExit === 0
    const smokeOk = sreport.healthOk && sreport.apiSmokeExit === 0 && benchOk && sreport.selfTests.every((s) => s.exit === 0)
    console.log(smokeOk ? `\nup ${name}: ${green('ALL GREEN')}` : `\nup ${name}: ${red('SMOKE FAIL')}`)
    return smokeOk ? 0 : 1
  }

  if (cmd === 'smoke') {
    const inf = pickDomain(process.cwd(), DOMAINS, (positional[0] ?? (typeof flags.domain === 'string' ? flags.domain : '')), listDomainNames(DOMAINS))
    if ('candidates' in inf) return usageError('smoke', `需要 <domain>（候选: ${inf.candidates.join(', ') || '无——先 domain new 或 adopt'}）`)
    const loaded = loadSpec('smoke', inf.name)
    if ('error' in loaded) { console.error(`smoke: ${loaded.error}`); return loaded.code }
    const report = await runSmoke(loaded.spec, { cacheDir: CACHE, selfTest: !flags['no-self-test'], bench: !!flags.bench })
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`\n== smoke ${inf.name} (port ${report.port}) ==`)
      for (const n of report.notes) console.log(` · ${n}`)
      console.log(` health: ${report.healthOk ? green('✓') : red('✗')}  api-smoke exit: ${report.apiSmokeExit}  bench: ${report.benchExit ?? '-'}  self-tests: ${report.selfTests.map((s) => s.exit).join(',') || '-'}  cleaned: ${report.cleaned}`)
    }
    const benchOk = report.benchExit === undefined || report.benchExit === 0
    return report.healthOk && report.apiSmokeExit === 0 && benchOk && report.selfTests.every((s) => s.exit === 0) ? 0 : 1
  }

  if (cmd === 'diff') {
    const inf = pickDomain(process.cwd(), DOMAINS, (positional[0] ?? (typeof flags.domain === 'string' ? flags.domain : '')), listDomainNames(DOMAINS))
    if ('candidates' in inf) return usageError('diff', `需要 <domain>（候选: ${inf.candidates.join(', ') || '无——先 domain new 或 adopt'}）`)
    const loaded = loadSpec('diff', inf.name)
    if ('error' in loaded) { console.error(`diff: ${loaded.error}`); return loaded.code }
    const report = diffDomain(loaded.spec, PACKS)
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else if (report.empty) console.log(`diff ${inf.name}: 空 ${green('✓')}（apply 生成面与现状一致——程序正确理解现状）`)
    else { console.log(`diff ${inf.name}: 非空（差异即归层/生成面调整，逐项人工确认）`); for (const l of report.lines) console.log('  ' + l) }
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
    if (positional[0] && positional[0] !== 'list') return usageError('registry', `未知子命令 '${positional[0]}'`)
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
      for (const p of reg.plugins) console.log(` ${p.id}: ${p.path} [${p.source ?? 'local'}${p.trusted ? '' : ' ' + yellow('⚠untrusted')}]${p.description ? ' — ' + p.description : ''}`)
      console.log(` core 必须件 ${coreIds(loadCoreList(CORE_LIST).core).length} 项（R11：核心功能不可缺，槽内实现可替换）`)
      return 0
    }
    if (sub === 'show') {
      const id = positional[1]
      const e = reg.plugins.find((x) => x.id === id)
      if (!e) return usageError('plugin show', `'${id}' 不在插件库（dshctl plugin list 看全部）`)
      if (asJson) { console.log(JSON.stringify(e, null, 2)); return 0 }
      console.log(`\n== plugin ${e.id} ==`)
      console.log(` 名称: ${e.name ?? '-'}（${e.tier ?? 'extension'}）`)
      if (e.description) console.log(` 描述: ${e.description}`)
      console.log(` 入口: ${e.path}`)
      console.log(` 来源: ${e.source ?? 'local'} · trusted=${e.trusted}${e.trusted ? '' : '（git/zip 导入件需人工信任：dshctl plugin trust ' + e.id + '）'}`)
      if (e.depends_on?.length) console.log(` 依赖: ${e.depends_on.join(', ')}`)
      if (e.provides?.length) console.log(` 提供: ${e.provides.join(', ')}`)
      if (e.category) console.log(` 分类: ${e.category}`)
      if (e.added_at) console.log(` 登记: ${e.added_at}`)
      console.log(` 等价: dshctl plugin show ${e.id} --json`)
      return 0
    }
    if (sub === 'add') {
      const id = String(flags.id ?? '')
      // 形态自动判型：*.zip → zip 导入；http(s):// 或 git@ → git 导入；其余 → local 收编
      const target = String(flags.path ?? positional[1] ?? '')
      if (!id || !target) return usageError('plugin add', '需要 --id <id> 与来源（目录/入口.ts/*.zip/http(s)://url 均可）')
      const save = () => savePluginRegistry(PLUGIN_REGISTRY, reg)
      if (/\.zip$/i.test(target)) {
        const r = importFromZip(target, reg, PLUGIN_SOURCES, { id, ...(flags.name ? { name: String(flags.name) } : {}), ...(flags.desc ? { description: String(flags.desc) } : {}), ...(flags.entry ? { entry: String(flags.entry) } : {}) }, save)
        if (!r.ok) { for (const e of r.errors) console.error(`plugin add: ${e}`); return 1 }
        console.log(`plugin add ${id}: zip 已解压 → plugin-registry/sources/${id}/（untrusted——核实后 dshctl plugin trust ${id}）`)
        return 0
      }
      if (/^https?:\/\//.test(target) || target.startsWith('git@')) {
        const r = importFromGit(target, reg, PLUGIN_SOURCES, { id, ...(flags.ref ? { ref: String(flags.ref) } : {}), ...(flags.entry ? { entry: String(flags.entry) } : {}) }, save)
        if (!r.ok) { for (const e of r.errors) console.error(`plugin add: ${e}`); return 1 }
        console.log(`plugin add ${id}: git 已克隆 → plugin-registry/sources/${id}/（untrusted——核实后 dshctl plugin trust ${id}）`)
        return 0
      }
      const r = addPlugin(reg, { id, path: target, ...(flags.name ? { name: String(flags.name) } : {}), ...(flags.desc ? { description: String(flags.desc) } : {}) })
      if (!r.ok) { for (const e of r.errors) console.error(`plugin add: ${e}`); return 1 }
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`plugin add ${id}: 已登记 → ${target}（source=local, trusted=true）`)
      return 0
    }
    if (sub === 'remove') {
      const id = positional[1]
      if (!id || !removePlugin(reg, id)) return usageError('plugin remove', `'${id}' 不在插件库`)
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`plugin remove ${id}: 已从库移除（源码未动——登记引用模式）`)
      return 0
    }
    if (sub === 'trust') {
      const id = positional[1]
      const on = !flags.off
      if (!id || !setTrusted(reg, id, on)) return usageError('plugin trust', `'${id}' 不在插件库`)
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`plugin trust ${id}: trusted=${on}`)
      return 0
    }
    if (sub === 'publish') {
      const name = positional[1]
      const dPath = join(DOMAINS, name ?? '', 'domain.yml')
      if (!name || !fileExists(dPath)) return usageError('plugin publish', `${dPath} 不存在`)
      const { spec, errors } = parseDomain(dPath)
      if (!spec) return usageError('plugin publish', `domain.yml 解析失败: ${errors.join('; ')}`)
      const r = publishDomain(reg, spec)
      if (r.errors.length) { for (const e of r.errors) console.error(`publish: ${e}`); return 1 }
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      console.log(`publish ${name}: 新入库 ${r.added.length ? r.added.join(', ') : '（无）'}；跳过已存在 ${r.skipped.join(', ') || '（无）'}`)
      return 0
    }
    if (sub === 'scaffold') {
      const id = positional[1]
      if (!id) return usageError('plugin scaffold', '需要 <id>')
      const r = scaffoldPlugin(reg, id, DOMAINS, flags.vendored ? { layout: 'vendored' } : {})
      if (r.errors.length) { for (const e of r.errors) console.error(`plugin scaffold: ${e}`); return 1 }
      if (asJson) { console.log(JSON.stringify(r, null, 2)); return 0 }
      for (const w of r.warnings) console.log(`  ${yellow('⚠')} ${w}`)
      console.log(`plugin scaffold ${id}: ${r.dir}`)
      console.log(r.createdManifest ? `  + dsh.plugin.yml（新建，layout=${r.manifest.layout}${r.manifest.config !== undefined ? '，config 自现网 patch 回填' : ''}）` : `  · dsh.plugin.yml 已存在（保留）`)
      for (const c of r.pkgChanges) console.log(`  ${c.startsWith('已是') ? '·' : '+'} ${c.replace('package.json: ', '')}`)
      console.log(`\n下一步：dshctl plugin install ${id} --domain <域>   # 装进领域（或 pack 出 tgz）`)
      return 0
    }
    if (sub === 'pack') {
      const id = positional[1]
      if (!id) return usageError('plugin pack', '需要 <id>')
      const r = packPlugin(reg, id, { outDir: join(ROOT, 'plugin-registry', 'dist'), dshSource: join(ROOT, 'deepseek-harness') })
      if (asJson) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1 }
      for (const l of r.log) console.log(`  · ${l}`)
      if (!r.ok) { for (const e of r.errors) console.error(`plugin pack: ${e}`); return 1 }
      console.log(`plugin pack ${id}: ${green('OK')} → ${r.tgzPath}`)
      console.log(`\n消费（上游组合包通道）：dsh plugin --profile <p> add ${r.tgzPath}`)
      return 0
    }
    if (sub === 'install') {
      const id = positional[1]
      const dName = String(flags.domain ?? (positional[2] && !String(positional[2]).startsWith('--') ? positional[2] : '')) || ''
      if (!id || !dName) return usageError('plugin install', '需要 <id> --domain <域>')
      const dPath = join(DOMAINS, dName, 'domain.yml')
      if (!fileExists(dPath)) return usageError('plugin install', `${dPath} 不存在`)
      const parsed = parseDomain(dPath)
      if (!parsed.spec) return usageError('plugin install', `domain.yml 解析失败: ${parsed.errors.join('; ')}`)
      const spec = parsed.spec
      const r = installIntoDomain(reg, spec, id, flags['in-place'] ? { layout: 'in-place' } : flags.vendored ? { layout: 'vendored' } : {})
      if (!r.ok) { for (const e of r.errors) console.error(`plugin install: ${e}`); return 1 }
      // 回写 domain.yml（保注释）：plugins[] 里该条目覆写 path/config，无则追加——其余键不动
      const { editYaml } = await import('./yml.ts')
      const existing = (spec.plugins ?? []).find((p) => p.id === id)
      const row: Record<string, unknown> = { id, path: r.path }
      if (existing?.config !== undefined) row.config = existing.config
      editYaml(dPath, (doc) => {
        const seq = doc.get('plugins', true) as unknown as
          | { items: Array<{ get: (k: string) => unknown; set: (k: string, v: unknown) => void }> }
          | undefined
        if (!seq || !Array.isArray(seq.items)) { doc.set('plugins', [row]); return }
        const hit = seq.items.find((it) => it.get?.('id') === id)
        if (!hit) { seq.items.push(doc.createNode(row)); return }
        hit.set('path', r.path)
        if (existing?.config !== undefined) hit.set('config', existing.config)
      })
      // editYaml 之后的 spec 从盘上重读，保证后续输出与 json 分支一致
      const reread = parseDomain(dPath)
      if (reread.spec) Object.assign(spec, reread.spec)
      if (asJson) { console.log(JSON.stringify({ ...r, domain: dName, spec }, null, 2)); return 0 }
      for (const n of r.notes) console.log(`  · ${n}`)
      console.log(`plugin install ${id}: 领域 ${dName} → ${r.path}`)
      console.log(`\n下一步：dshctl up ${dName}   # check → apply 落 patch（加 --yes 全链）`)
      return 0
    }
    if (sub === 'import') {
      const zip = positional[1]
      const id = String(flags.id ?? '')
      if (!zip || !id) return usageError('plugin import', '需要 <zip> --id <id>（等价：dshctl plugin add --id <id> --path <zip>）')
      const save = () => savePluginRegistry(PLUGIN_REGISTRY, reg)
      const r = importFromZip(zip, reg, PLUGIN_SOURCES, { id, ...(flags.name ? { name: String(flags.name) } : {}), ...(flags.desc ? { description: String(flags.desc) } : {}), ...(flags.entry ? { entry: String(flags.entry) } : {}) }, save)
      if (!r.ok) { for (const e of r.errors) console.error(`plugin import: ${e}`); return 1 }
      console.log(`plugin import ${id}: 已解压 → plugin-registry/sources/${id}/（untrusted——核实后 dshctl plugin trust ${id}）`)
      return 0
    }
    if (sub === 'import-git') {
      const url = positional[1]
      const id = String(flags.id ?? '')
      if (!url || !id) return usageError('plugin import-git', '需要 <url> --id <id>（等价：dshctl plugin add --id <id> --path <url>）')
      const save = () => savePluginRegistry(PLUGIN_REGISTRY, reg)
      const r = importFromGit(url, reg, PLUGIN_SOURCES, { id, ...(flags.ref ? { ref: String(flags.ref) } : {}), ...(flags.entry ? { entry: String(flags.entry) } : {}) }, save)
      if (!r.ok) { for (const e of r.errors) console.error(`plugin import-git: ${e}`); return 1 }
      console.log(`plugin import-git ${id}: 已克隆 → plugin-registry/sources/${id}/（untrusted——核实后 dshctl plugin trust ${id}）`)
      return 0
    }
    console.error(`未知 plugin 子命令: ${sub ?? ''}（list/show/add/remove/trust/publish/import/import-git）`)
    return 2
  }

  // ── gui：README 曾写了不存在的 `gui serve`——v0.4 起真提供（转发到 bin/dshctl-gui）──
  if (cmd === 'gui') {
    const bin = join(import.meta.dirname, 'bin', 'dshctl-gui')
    if (!existsSync(bin)) { console.error('gui: bin/dshctl-gui 不存在（先 cd gui && pnpm build 以生成 dist）'); return 2 }
    try {
      execFileSync(bin, argv.slice(1), { stdio: 'inherit' })
      return 0
    } catch (e) {
      const code = (e as { status?: number }).status
      return typeof code === 'number' ? code : 2
    }
  }

  // ── replace：替换通道全链（预检 → 声明 → 插入 → 禁旧 → check；失败自动回滚）──
  if (cmd === 'replace') {
    const oldId = positional[0]
    const newId = flags.with ? String(flags.with) : ''
    if (!oldId || !newId) return usageError('replace', '需要 <old> --with <new>')
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

    if (result.plan.warnings.length) for (const w of result.plan.warnings) console.log(`${yellow('⚠')} ${w}`)
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
      for (const s of result.steps ?? []) console.log(`  ${green('✓')} ${s.action}`)
      if (result.r11) console.log(`R11: ${result.r11}`)
      if (result.smoke) console.log(`smoke: ${result.smoke.pass ? green('PASS') : red('FAIL')}（${result.smoke.detail}）`)
      if (result.rollbackGuide) console.log(`\n${result.rollbackGuide}`)
      return 0
    }
    console.error(`replace 失败${result.rolledBack ? '（本次写入已自动回滚）' : ''}`)
    for (const e of result.newErrors ?? []) console.error(`  + ${e}`)
    if (result.r11) console.error(`  R11: ${result.r11}`)
    return 1
  }

  console.error(`${red(`未知命令: ${cmd}`)}\n`)
  process.stdout.write(usage())
  return 2
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`执行错误: ${(e as Error).message}`); process.exit(2) })
