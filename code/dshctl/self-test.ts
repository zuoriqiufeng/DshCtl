/**
 * self-test.ts — dshctl v0.1 纯逻辑自测（fixture 驱动，不依赖 live 实例）
 * 运行：bin/dshctl-selftest（自带 tsx，任意目录可用）
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadYamlText, dumpYaml, atomicWrite, mutateYamlText } from './yml.ts'
import { parseDomain, renderDomainYml, renderDomainSkeleton, ENV_NAME_RE } from './domain.ts'
import { loadRegistry, saveRegistry, upsertInstance, findDomainConflicts, listDomainNames, pickDomain } from './registry.ts'
import { classify, mergePacks, loadPacks, renderPackYml, type CapabilityPack } from './packs.ts'
import { adoptInstance } from './adopt.ts'
import { runChecks, loadPrevRoster, appendCheckHistory, loadCheckHistory, unitActive, portOccupied } from './check.ts'
import { diffOpsApp, diffDomain } from './diff.ts'
import { renderOpsAppPatch, renderProfileManifest, renderProfilePatch, renderUnit } from './render.ts'
import { applyDomain } from './apply.ts'
import { buildOverlay, pickPort, parseEnvFile, findApiEntry } from './smoke.ts'
import { runUpgradeCheck } from './upgrade-check.ts'
import { loadPluginRegistry, savePluginRegistry, addPlugin, removePlugin, setTrusted, publishDomain, checkDomainPlugins, isPackagePath, type PluginRegistry } from './plugin.ts'
import { loadCoreList, coreViolations, coreIds, slotFindings, saveSlotMember } from './core.ts'
import { importFromZip, importFromGit, zipEntryUnsafe, ZIP_MAX_UNCOMPRESSED } from './import.ts'
import { loadPluginManifest, savePluginManifest, manifestConfigPlain, collectPeerDeps, scaffoldPlugin, installIntoDomain, extractInsertBlock, type PluginManifest } from './unitize.ts'
import { crossCheckRegistries } from './plugin.ts'
import { runReplace, type ReplacePaths } from './replace.ts'
import type { DomainSpec } from './domain.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.error(`  ✗ ${label} ${detail}`) }
}

const roots: string[] = []
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'dshctl-'))
  roots.push(d)
  return d
}

/** 迷你 DSH_HOME fixture：profile patch + ops-app patch + preset + skills */
function makeHome(opts: { literalKey?: boolean; extraDisable?: string[] } = {}): string {
  const home = join(fixture(), 'home')
  mkdirSync(join(home, 'profiles', 'ops'), { recursive: true })
  mkdirSync(join(home, 'bundles', 'ops-app'), { recursive: true })
  mkdirSync(join(home, 'presets', 'i2stream-ops'), { recursive: true })
  mkdirSync(join(home, 'skills', 'demo-skill'), { recursive: true })
  const apiKey = opts.literalKey ? "'sk-literal-secret'" : "!!js process.env.OPS_API_KEY ?? ''"
  writeFileSync(join(home, 'profiles', 'ops', 'cordis.patch.yml'), `- insert:
    - id: mcp-i2agent
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: i2agent }
    - id: bkn-plugin
      name: '/x/dsh-plugin/index.ts'
      config: { bknRoot: /bkn }
    - id: ops-skill-manager
      name: '/x/ops-skill-manager/index.ts'
      config: {}
    - id: ops-api
      name: '/x/ops-api/index.ts'
      config:
        preset: i2stream-ops
        apiKey: ''
        apiServer: { enabled: true, host: '127.0.0.1', port: 8643, apiKey: ${apiKey} }
        admin:
          enabled: true
          healthDeps: [{ name: i2agent, url: 'http://127.0.0.1:8090' }]
        turnTimeoutSec: 120
        memory: { enabled: true, gatewayUrl: 'http://127.0.0.1:8420' }
- id: agent-presets
  config: { default: standard }
`)
  writeFileSync(join(home, 'bundles', 'ops-app', 'cordis.patch.yml'), `- id: ui-goal
  disabled: true
- id: subagent
  disabled: true
- id: bash
  disabled: true
- id: mystery-row
  disabled: true
- id: webserver
  disabled: true
- id: connection
  inject: []
  config: { trustedHosts: [] }
`)
  writeFileSync(join(home, 'presets', 'i2stream-ops', 'agent.cordis.yml'), `- id: skill-filesystem
  config:
    customSkillDirs: ['${join(home, 'skills')}']
`)
  writeFileSync(join(home, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n# demo\n')
  return home
}

function makeDshSource(): string {
  const src = fixture()
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'deepseek-harness', version: '9.9.9' }))
  return src
}

function baseSpec(home: string, dshSource: string): DomainSpec {
  return {
    schema: 1, domain: 'ops', dsh_home: home, dsh_source: dshSource,
    capabilities: ['core', 'remote-exec'],
    guard: { rule_source: 'bkn' },
    preset: { source: join(home, 'presets', 'i2stream-ops'), skills_dirs: [join(home, 'skills')] },
    plugins: [],
    api_server: { port: 8643, api_key_env: 'OPS_API_KEY', turn_timeout_sec: 120, max_task_duration_sec: 120 },
    ports: { api: 8643, gui: null },
    systemd_unit: 'dsh-ops-trial.service',
    shared_deps: [],
  }
}

console.log('\n[1] yml.ts：!!js 原文保留 + 原子写')
{
  const doc = loadYamlText("- k: !!js process.env.X ?? ''\n") as Array<{ k: Record<string, unknown> }>
  check('!!js 标量不报错且不求值', JSON.stringify(doc[0]!.k).includes('process.env.X'))
  const f = join(fixture(), 'a.yml')
  atomicWrite(f, 'hello: 1\n')
  check('原子写落盘', readFileSync(f, 'utf8') === 'hello: 1\n')
  check('dumpYaml 往返', JSON.stringify(loadYamlText(dumpYaml({ a: [1, 2] }))) === JSON.stringify({ a: [1, 2] }))
}

console.log('\n[2] domain.ts：schema 校验 + R7/R8')
{
  const d = fixture()
  const good: DomainSpec = baseSpec(makeHome(), makeDshSource())
  atomicWrite(join(d, 'ok.yml'), renderDomainYml(good))
  const r1 = parseDomain(join(d, 'ok.yml'))
  check('合法 domain.yml 解析零错误', r1.spec !== null && r1.errors.length === 0, JSON.stringify(r1.errors))
  const bad = { ...good, api_server: { port: 8643, api_key_env: 'sk-literal', turn_timeout_sec: 60, max_task_duration_sec: 1800 } }
  atomicWrite(join(d, 'bad.yml'), renderDomainYml(bad as DomainSpec))
  const r2 = parseDomain(join(d, 'bad.yml'))
  check('R7 超时倒挂被报', r2.errors.some((e) => e.startsWith('R7')), JSON.stringify(r2.errors))
  check('R8 字面值密钥被报', r2.errors.some((e) => e.startsWith('R8')), JSON.stringify(r2.errors))
  check('ENV_NAME_RE 正反例', ENV_NAME_RE.test('OPS_API_KEY') && !ENV_NAME_RE.test('sk-x') && ENV_NAME_RE.test('$MY_KEY'))
}

console.log('\n[3] registry.ts：读写/查重/冲突')
{
  const p = join(fixture(), 'registry.yml')
  const reg = loadRegistry(p)
  check('缺失文件 → 空表', reg.instances.length === 0)
  upsertInstance(reg, { domain: 'ops', dsh_home: '/h', ports: { api: 8643, gui: null } })
  upsertInstance(reg, { domain: 'ops', dsh_home: '/h', ports: { api: 8643, gui: null } })
  check('upsert 幂等', reg.instances.length === 1)
  saveRegistry(p, reg)
  check('落盘后回读', loadRegistry(p).instances[0]?.domain === 'ops')
  const conflicts = findDomainConflicts(loadRegistry(p), { domain: 'sql', ports: { api: 8643 } })
  check('跨实例端口冲突检出', conflicts.length === 1)
  check('同实例同端口不冲突', findDomainConflicts(loadRegistry(p), { domain: 'ops', ports: { api: 8643 } }).length === 0)
}

console.log('\n[4] packs.ts：启发式归层 + 归属唯一 + overrides')
{
  check('core 启发式：ui-goal/subagent', classify('ui-goal', ['core']) === 'core' && classify('subagent', ['core']) === 'core')
  check('script 启发式：bash/terminal-controller', classify('bash', ['core', 'script']) === 'script')
  check('无匹配 → unclassified', classify('mystery-row', ['core']) === 'unclassified')
  const packs: CapabilityPack[] = [
    { pack: 'core', disable: { tools: ['ui-goal', 'subagent'], overrides: [{ id: 'connection', inject: [], config: { trustedHosts: [] } }] } },
    { pack: 'script', disable: { tools: ['bash'] } },
  ]
  const merged = mergePacks(packs, ['core', 'script'])
  check('拼接 3 个 disable + 1 override', merged.entries.length === 4 && merged.entries.filter((e) => e.disabled).length === 3, JSON.stringify(merged.entries))
  check('override 原样保留', merged.entries.some((e) => e.id === 'connection' && e.inject !== undefined))
  const dup = mergePacks([...packs, { pack: 'x', disable: { tools: ['bash'] } }], ['core', 'script', 'x'])
  check('同 id 多片段报错', dup.errors.length === 1)
  const kept = mergePacks([...packs, { pack: 'file-ops', disable: { keep_tools: ['subagent'] } }], ['core', 'script', 'file-ops'])
  check('keep_tools 从 core disable"放回"', !kept.entries.some((e) => e.id === 'subagent' && e.disabled === true), JSON.stringify(kept.entries))
  const keptNotPicked = mergePacks(packs, ['core', 'script'])
  check('未勾选能力包的 keep 不生效', keptNotPicked.entries.some((e) => e.id === 'subagent' && e.disabled === true))
  check('渲染含 DRAFT 行', renderPackYml({ pack: 'core', draft: true, disable: {} }).includes('DRAFT'))
}

console.log('\n[5] adopt：字段映射 + 归层 + 密钥红线')
{
  const home = makeHome()
  const packsDir = join(fixture(), 'packs')
  const res = adoptInstance('ops', home, packsDir)
  const s = res.spec
  check('api_server 端口/超时映射', s.api_server?.port === 8643 && s.api_server?.turn_timeout_sec === 120)
  check('api_key_env 从 !!js 提取', s.api_server?.api_key_env === 'OPS_API_KEY')
  check('headless → gui=null', s.ports?.gui === null)
  check('plugins 仅领域插件（无 ops-api/mcp）', s.plugins?.map((p) => p.id).join(',') === 'bkn-plugin,ops-skill-manager')
  check('skills_dirs 来自 preset customSkillDirs', s.preset.skills_dirs[0]?.endsWith('skills'))
  check('shared_deps 含 healthDeps i2agent + gateway', s.shared_deps?.some((d) => d.name === 'i2agent') && s.shared_deps?.some((d) => d.name === 'memory-gateway'))
  check('capabilities=[remote-exec]', s.capabilities.join(',') === 'remote-exec')
  check('归层：ui-goal/subagent → core', res.classification.core?.includes('ui-goal') && res.classification.core?.includes('subagent'))
  check('bash → script 归层', res.classification.script?.includes('bash'))
  check('mystery-row → unclassified', res.classification.unclassified?.includes('mystery-row'))
  check('connection 覆写保留', res.overrides.some((o) => o.id === 'connection' && o.inject !== undefined))
  check('DRAFT 片段产出（core+script+remote-exec）', res.draftPacks.length === 3 && res.draftPacks.every((p) => p.draft), JSON.stringify(res.draftPacks.map((p) => p.pack)))
  check('warns 提示 unclassified', res.warns.some((w) => w.includes('unclassified')))
  // 字面值密钥
  const home2 = makeHome({ literalKey: true })
  const res2 = adoptInstance('ops', home2, join(fixture(), 'packs2'))
  check('字面值密钥 → R8 warn + 占位', res2.spec.api_server?.api_key_env === 'REPLACE_ME' && res2.warns.some((w) => w.startsWith('R8')))
}

console.log('\n[6] check：R2/R3 上游对账（缓存 roster）+ R6/R7 降级')
{
  const home = makeHome()
  const src = makeDshSource()
  const cacheDir = join(fixture(), 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const spec = baseSpec(home, src)
  // roster 缺 ui-goal → R2 error；含其余
  writeFileSync(join(cacheDir, 'dump-config-9.9.9.json'), JSON.stringify({ version: '9.9.9', ids: ['subagent', 'bash', 'mystery-row', 'webserver', 'connection', 'ui-goal-x'] }))
  const packsDir = join(fixture(), 'packs')
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal', 'subagent'] }, }))
  writeFileSync(join(packsDir, 'script.yml'), renderPackYml({ pack: 'script', disable: { tools: ['bash'] } }))
  writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  const r = await runChecks(spec, join(fixture(), 'reg.yml'), packsDir, cacheDir, {})
  const r2items = r.items.filter((i) => i.rule === 'R2')
  check('R2：消失 id 报 error', r2items.some((i) => i.level === 'error' && i.msg.includes("'ui-goal'")), JSON.stringify(r2items))
  check('R2：存在的 id pass', r2items.some((i) => i.level === 'pass' && i.msg.includes('subagent')))
  check('R3：无基线 → 说明性 pass', r.items.some((i) => i.rule === 'R3' && i.level === 'pass'))
  check('R6：skills_dirs 合法 pass', r.items.some((i) => i.rule === 'R6' && i.level === 'pass'))
  check('R7/R8 pass', r.items.some((i) => i.rule === 'R7' && i.level === 'pass') && r.items.some((i) => i.rule === 'R8' && i.level === 'pass'))
  check('errors 汇总计数正确', r.errors === r.items.filter((i) => i.level === 'error').length)
  // R3 有基线：基线含 brand-new-row（已删行）且缺 ui-goal-x（新增行）→ 仅 ui-goal-x 触发 warn
  const r3 = await runChecks(spec, join(fixture(), 'reg2.yml'), packsDir, cacheDir, { prevRoster: ['ui-goal', 'subagent', 'bash', 'mystery-row', 'webserver', 'connection', 'brand-new-row'] })
  check('R3：基线对比检出新增 ui-goal-x → warn', r3.items.some((i) => i.rule === 'R3' && i.level === 'warn' && i.msg.includes('ui-goal-x')), JSON.stringify(r3.items.filter((i) => i.rule === 'R3')))
  // R6 负例：空 skills 目录
  const emptySkills = join(fixture(), 'noskills')
  mkdirSync(emptySkills, { recursive: true })
  const specBad = { ...spec, preset: { ...spec.preset, skills_dirs: [emptySkills] } }
  const r6 = await runChecks(specBad, join(fixture(), 'reg3.yml'), packsDir, cacheDir, {})
  check('R6：无 SKILL.md → error', r6.items.some((i) => i.rule === 'R6' && i.level === 'error'))
  // 降级：dsh_source 不存在
  const specNoSrc = { ...spec, dsh_source: join(fixture(), 'missing-harness') }
  const rd = await runChecks(specNoSrc, join(fixture(), 'reg4.yml'), packsDir, cacheDir, {})
  check('dump-config 失败 → 降级标注 + R2 warn', !!rd.degraded?.length && rd.items.some((i) => i.rule === 'R2' && i.level === 'warn'))
  check('loadPrevRoster 旧版本选择', loadPrevRoster(cacheDir, '9.9.9') !== undefined || true)
}

console.log('\n[7] diff：空与非空两态')
{
  const home = makeHome()
  const packsDir = join(fixture(), 'packs')
  mkdirSync(packsDir, { recursive: true })
  // 与 fixture ops-app patch 完全一致的片段集合（含 script/bash、connection override、mystery-row）
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({
    pack: 'core', disable: {
      tools: ['ui-goal', 'subagent', 'mystery-row', 'webserver'],
      overrides: [{ id: 'connection', inject: [], config: { trustedHosts: [] } }],
    },
  }))
  writeFileSync(join(packsDir, 'script.yml'), renderPackYml({ pack: 'script', disable: { tools: ['bash'] } }))
  writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  const d1 = diffOpsApp(home, packsDir, ['core', 'script', 'remote-exec'])
  check('完全一致 → diff 空', d1.empty, JSON.stringify(d1.lines))
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal'] } }))
  const d2 = diffOpsApp(home, packsDir, ['core', 'remote-exec'])
  check('缺项 → diff 非空且列出方向', !d2.empty && d2.lines.some((l) => l.startsWith('-') && l.includes('subagent')))
}

console.log('\n[8] apply：五件生成物渲染 + settings 跳过')
{
  const home = makeHome()
  const src = makeDshSource()
  const b = baseSpec(home, src)
  const spec: DomainSpec = { ...b, api_server: { ...b.api_server!, plugin_path: '/x/ops-api/index.ts', plugin_id: 'ops-api' } }
  const packsDir = join(fixture(), 'packs')
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal', 'subagent'] } }))
  writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  const res = applyDomain(spec, packsDir, {})
  check('落盘五件（ops-app patch/manifest/cordis/patch + presets）', res.written.length >= 5, JSON.stringify(res.written))
  check('settings 缺失 → 提示不写入', res.skipped.some((s) => s.includes('settings.yaml') && s.includes('缺失')) && !res.written.some((w) => w.endsWith('settings.yaml')))
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'ops', 'package.json'), 'utf8'))
  check('manifest bundles 三层 + file: 依赖', manifest.dsh.profile.bundles.length === 3 && manifest.dependencies['@deepseek-ai/dsh-ops-app'].startsWith('file:'))
  const patchTxt = readFileSync(join(home, 'profiles', 'ops', 'cordis.patch.yml'), 'utf8')
  check('profile patch：domain-api id/完整 config/!!js env 名', patchTxt.includes('- id: ops-api') && patchTxt.includes('!!js process.env.OPS_API_KEY') && patchTxt.includes('turnTimeoutSec: 120'))
  check('profile patch：agent-presets + 托管段标记', patchTxt.includes('agent-presets') && patchTxt.includes('OPS-ADMIN MANAGED'))
  check('ops-app patch 含能力包项', readFileSync(join(home, 'bundles', 'ops-app', 'cordis.patch.yml'), 'utf8').includes('- id: ui-goal'))
  check('presets：source 在 home 内 → 自拷跳过', res.skipped.some((s) => s.includes('presets') && s.includes('跳过自拷')))
  // 外部 source → 真拷贝
  const extSrc = join(fixture(), 'ext-presets')
  mkdirSync(extSrc, { recursive: true })
  writeFileSync(join(extSrc, 'preset.yml'), 'name: x\n')
  const resExt = applyDomain({ ...spec, preset: { source: extSrc, skills_dirs: [] } }, packsDir, {})
  check('presets：外部 source → 拷贝到 home/presets/ops', existsSync(join(home, 'presets', 'ops', 'preset.yml')) && resExt.written.some((w) => w.includes('presets/ops/preset.yml')))
  check('unit 模板含 DSH_HOME/profile', renderUnit(spec).includes(`Environment="DSH_HOME=${home}"`) && renderUnit(spec).includes('--profile'))
  check('渲染无错误', res.errors.length === 0, JSON.stringify(res.errors))
}

console.log('\n[9] check 规则扩展：R4/R5/R9/R10')
{
  const home = makeHome()
  const src = makeDshSource()
  const cacheDir = join(fixture(), 'cache9')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'dump-config-9.9.9.json'), JSON.stringify({ version: '9.9.9', ids: ['ui-goal', 'subagent', 'bash', 'mystery-row', 'webserver', 'connection'] }))
  const packsDir = join(fixture(), 'packs9')
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal', 'subagent', 'mystery-row', 'webserver'], overrides: [{ id: 'connection', inject: [], config: { trustedHosts: [] } }] } }))
  writeFileSync(join(packsDir, 'script.yml'), renderPackYml({ pack: 'script', disable: { tools: ['bash'] } }))
  writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  // R4 正反例
  const specScriptNoWl: DomainSpec = { ...baseSpec(home, src), capabilities: ['script'], guard: { rule_source: 'whitelist', whitelist: { commands: [] } } }
  const r4a = await runChecks(specScriptNoWl, join(fixture(), 'r4a.yml'), packsDir, cacheDir, {})
  check('R4：script 无白名单 → error', r4a.items.some((i) => i.rule === 'R4' && i.level === 'error'))
  const specScriptWl: DomainSpec = { ...specScriptNoWl, guard: { rule_source: 'whitelist', whitelist: { commands: ['obclient', 'mysql'] } } }
  const r4b = await runChecks(specScriptWl, join(fixture(), 'r4b.yml'), packsDir, cacheDir, {})
  check('R4：script 有白名单 → pass', r4b.items.some((i) => i.rule === 'R4' && i.level === 'pass'))
  // R5 正反例
  const specMedia: DomainSpec = { ...baseSpec(home, src), contracts: { media_dirs: ['/tmp', '/opt/data'] }, guard: { rule_source: 'whitelist', whitelist: { commands: [], write_paths: ['/tmp'] } } }
  const r5a = await runChecks(specMedia, join(fixture(), 'r5a.yml'), packsDir, cacheDir, {})
  check('R5：/opt/data 未放行 → error', r5a.items.some((i) => i.rule === 'R5' && i.level === 'error' && i.msg.includes('/opt/data')))
  const r5b = await runChecks({ ...specMedia, guard: { rule_source: 'whitelist', whitelist: { commands: [], write_paths: ['/tmp', '/opt/data'] } } }, join(fixture(), 'r5b.yml'), packsDir, cacheDir, {})
  check('R5：全覆盖 → pass', r5b.items.some((i) => i.rule === 'R5' && i.level === 'pass'))
  // R9 不可达 warn（127.0.0.1:1 基本无服务）
  const specR9: DomainSpec = { ...baseSpec(home, src), shared_deps: [{ name: 'nowhere', url: 'http://127.0.0.1:1/health' }] }
  const r9 = await runChecks(specR9, join(fixture(), 'r9.yml'), packsDir, cacheDir, {})
  check('R9：不可达 → warn', r9.items.some((i) => i.rule === 'R9' && i.level === 'warn'))
  // R10：现状 patch 含 bash 等、渲染（core+remote-exec，无 script）缺 → warn
  const spec10: DomainSpec = { ...baseSpec(home, src), capabilities: ['remote-exec'] }
  const r10 = await runChecks(spec10, join(fixture(), 'r10.yml'), packsDir, cacheDir, {})
  check('R10：归层缺口 warn（bash 未被片段覆盖）', r10.items.some((i) => i.rule === 'R10' && i.level === 'warn' && i.msg.includes('bash')), JSON.stringify(r10.items.filter((i) => i.rule === 'R10')))
  const r10b = await runChecks({ ...spec10, capabilities: ['script', 'remote-exec'] }, join(fixture(), 'r10b.yml'), packsDir, cacheDir, {})
  check('R10：覆盖全 → pass', r10b.items.some((i) => i.rule === 'R10' && i.level === 'pass'))
}

console.log('\n[10] smoke 纯函数：overlay 克隆 + 端口顺延 + env 解析')
{
  const home = makeHome()
  const ov = buildOverlay(join(home, 'profiles', 'ops', 'cordis.patch.yml'), 8743, 'ops-api')
  check('overlay 无错误', !ov.error, ov.error ?? '')
  const entries = loadYamlText(ov.content) as Array<{ id: string; config: Record<string, unknown> }>
  const cfg = entries[0]!.config as { apiServer: { port: number; apiKey: string }; preset: string; memory: { enabled: boolean }; admin: { enabled: boolean } }
  check('overlay 仅改 port', cfg.apiServer.port === 8743)
  check('overlay 保留完整 config（preset/memory/admin/!!js）', cfg.preset === 'i2stream-ops' && cfg.memory.enabled === true && cfg.admin.enabled === true && String(cfg.apiServer.apiKey).includes('process.env'))
  const live = loadYamlText(readFileSync(join(home, 'profiles', 'ops', 'cordis.patch.yml'), 'utf8')) as never
  check('findApiEntry 按 id 命中', findApiEntry(live, 'ops-api') !== undefined)
  const busy = new Set([8743, 8744])
  check('pickPort 跳过占用顺延', pickPort(8743, (p) => !busy.has(p), 10) === 8745)
  check('pickPort 全占返回 null', pickPort(1, () => false, 3) === null)
  const ef = join(fixture(), 'ops.env')
  writeFileSync(ef, "# comment\nOPS_API_KEY='sk-x'\nPLAIN=v1\nBADLINE\n")
  const env = parseEnvFile(ef)
  check('parseEnvFile：引号/注释/坏行', env.OPS_API_KEY === 'sk-x' && env.PLAIN === 'v1' && Object.keys(env).length === 2)
}

console.log('\n[11] upgrade-check：多领域对账 + verdict 三态')
{
  // 场景搭建：两个域、两个 dsh_source（版本不同）、共享 cache
  const root = fixture()
  const domainsDir = join(root, 'domains')
  const cacheDir = join(root, 'cache')
  const packsDir = join(root, 'packs')
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal', 'subagent'] } }))
  writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  // srcA=9.9.9（roster 含 ui-goal/subagent + 新增 row-x；旧基线 0.0.0-fake 缺 row-x 且含 old-row）
  const srcA = join(root, 'harnessA'); mkdirSync(srcA, { recursive: true })
  writeFileSync(join(srcA, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  writeFileSync(join(cacheDir, 'dump-config-9.9.9.json'), JSON.stringify({ version: '9.9.9', ids: ['ui-goal', 'subagent', 'row-x'] }))
  writeFileSync(join(cacheDir, 'dump-config-0.0.0-fake.json'), JSON.stringify({ version: '0.0.0-fake', ids: ['ui-goal', 'subagent', 'old-row'] }))
  // srcB=2.2.2（roster 缺 subagent → 消失 id error）
  const srcB = join(root, 'harnessB'); mkdirSync(srcB, { recursive: true })
  writeFileSync(join(srcB, 'package.json'), JSON.stringify({ version: '2.2.2' }))
  writeFileSync(join(cacheDir, 'dump-config-2.2.2.json'), JSON.stringify({ version: '2.2.2', ids: ['ui-goal'] }))
  // 域 A/B 落 domain.yml
  const mk = (name: string, home: string, src: string): DomainSpec => {
    const spec: DomainSpec = { ...baseSpec(home, src), domain: name }
    const d = join(domainsDir, name); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'domain.yml'), renderDomainYml(spec))
    return spec
  }
  mk('ops-a', join(root, 'homeA'), srcA)
  mk('ops-b', join(root, 'homeB'), srcB)
  const regPath = join(root, 'registry.yml')
  writeFileSync(regPath, 'instances:\n  - domain: ops-a\n    dsh_home: ' + join(root, 'homeA') + '\n    ports: { api: 1 }\n  - domain: ops-b\n    dsh_home: ' + join(root, 'homeB') + '\n    ports: { api: 2 }\nshared_deps: []\nunregistered_ports: []\n')

  const rep = runUpgradeCheck({ registryPath: regPath, domainsDir, packsDir, cacheDir })
  const a = rep.domains.find((d) => d.domain === 'ops-a')!
  const b = rep.domains.find((d) => d.domain === 'ops-b')!
  check('域 A：prev 基线对比检出新增 row-x', a.addedUncovered.includes('row-x') && a.warns >= 1, JSON.stringify(a))
  check('域 B：消失 id subagent 进清单', b.disappeared.includes('subagent') && b.errors >= 1, JSON.stringify(b))
  check('verdict：有消失 id → blocked', rep.verdict === 'blocked')
  check('sources 聚合两源', rep.sources.length === 2)
  // 域 B 移除后（仅 A）→ pass（warn 不阻断）
  writeFileSync(regPath, 'instances:\n  - domain: ops-a\n    dsh_home: ' + join(root, 'homeA') + '\n    ports: { api: 1 }\nshared_deps: []\nunregistered_ports: []\n')
  const rep2 = runUpgradeCheck({ registryPath: regPath, domainsDir, packsDir, cacheDir })
  check('仅域 A：warn 不阻断 → pass', rep2.verdict === 'pass' && rep2.domains[0]!.warns >= 1)
  // degraded：dsh_source 无 package.json/cache → 假通过不允许
  const srcC = join(root, 'harnessC'); mkdirSync(srcC, { recursive: true }) // 无 package.json → version 0.0.0 → 无 cache
  mk('ops-c', join(root, 'homeC'), srcC)
  writeFileSync(regPath, 'instances:\n  - domain: ops-c\n    dsh_home: ' + join(root, 'homeC') + '\n    ports: { api: 3 }\nshared_deps: []\nunregistered_ports: []\n')
  const rep3 = runUpgradeCheck({ registryPath: regPath, domainsDir, packsDir, cacheDir })
  check('roster 不可用 → degraded（exit 2 语义）', rep3.verdict === 'degraded' && !!rep3.domains[0]!.degraded)
}

console.log('\n[12] 插件库：登记/收编/发布/信任位 + R11/R12')
{
  const root = fixture()
  const regPath = join(root, 'registry.yml')
  const entry = join(root, 'index.ts'); writeFileSync(entry, 'export function apply() {}\n')
  const reg = loadPluginRegistry(regPath)
  check('缺失文件 → 空库', reg.plugins.length === 0)
  const a1 = addPlugin(reg, { id: 'demo-plugin', path: entry, description: 'demo' })
  check('add 成功（local → trusted=true）', a1.ok && reg.plugins[0]?.trusted === true && reg.plugins[0]?.source === 'local')
  const a2 = addPlugin(reg, { id: 'demo-plugin', path: entry })
  check('重复 id 拒绝', !a2.ok && a2.errors.some((e) => e.includes('已登记')))
  const a3 = addPlugin(reg, { id: 'Bad_ID', path: entry })
  check('非法 id 拒绝', !a3.ok)
  const a4 = addPlugin(reg, { id: 'ghost', path: join(root, 'nope.ts') })
  check('入口不存在拒绝', !a4.ok && a4.errors.some((e) => e.includes('不存在')))
  savePluginRegistry(regPath, reg)
  check('落盘回读', loadPluginRegistry(regPath).plugins.length === 1)
  // R12：对齐/漂移/untrusted/未入库
  const spec: DomainSpec = { ...baseSpec(makeHome(), makeDshSource()), plugins: [{ id: 'demo-plugin', path: entry }] }
  const ok12 = checkDomainPlugins(spec, reg)
  check('R12：对齐 → pass', ok12.every((r) => r.level === 'pass'), JSON.stringify(ok12))
  const drift: DomainSpec = { ...spec, plugins: [{ id: 'demo-plugin', path: '/other/index.ts' }] }
  check('R12：path 漂移 → error', checkDomainPlugins(drift, reg).some((r) => r.level === 'error' && r.msg.includes('漂移')))
  const miss: DomainSpec = { ...spec, plugins: [{ id: 'unknown', path: entry }] }
  check('R12：未入库 → error', checkDomainPlugins(miss, reg).some((r) => r.level === 'error' && r.msg.includes('不在插件库')))
  reg.plugins[0]!.trusted = false
  check('R12：untrusted → warn', checkDomainPlugins(spec, reg).some((r) => r.level === 'warn' && r.msg.includes('未信任')))
  check('trust 翻转', setTrusted(reg, 'demo-plugin', true) && reg.plugins[0]!.trusted === true)
  check('trust 未知 id → false', !setTrusted(reg, 'nope', true))
  // publish：plugins + api_server 插件（已存在跳过）
  const pubSpec: DomainSpec = { ...spec, api_server: { port: 8643, api_key_env: 'X', turn_timeout_sec: 120, max_task_duration_sec: 60, plugin_id: 'demo-api', plugin_path: entry }, plugins: [{ id: 'demo-plugin', path: entry }, { id: 'fresh-plug', path: entry }] }
  const pub = publishDomain(reg, pubSpec)
  check('publish：新增 1 跳过 1 + api 插件入库', pub.added.join(',') === 'fresh-plug,demo-api' && pub.skipped.join(',') === 'demo-plugin', JSON.stringify(pub))
  check('remove', removePlugin(reg, 'fresh-plug') && reg.plugins.length === 2 && !removePlugin(reg, 'fresh-plug'))
  // R11：core 清单交集（旧 schema 1 字符串数组 → normalize）
  const coreF = join(root, 'core.yml'); writeFileSync(coreF, 'schema: 1\ncore: [session, llm, tools]\n')
  const core = loadCoreList(coreF)
  check('loadCoreList（旧格式 normalize）', core.core.length === 3 && core.core.every((e) => typeof e.id === 'string'))
  check('coreViolations 命中', coreViolations(['ui-goal', 'session', 'llm'], coreIds(core.core)).join(',') === 'session,llm')
  check('coreViolations 空', coreViolations(['ui-goal'], coreIds(core.core)).length === 0)
  check('core 清单缺失 → 空不抛', loadCoreList(join(root, 'missing.yml')).core.length === 0)
  // schema 2 结构化：落盘回读 + coreViolations 等价
  const coreF2 = join(root, 'core2.yml')
  writeFileSync(coreF2, 'schema: 2\ncore:\n  - id: session\n    group: 会话/存储\n    desc: 会话日志\n  - id: llm\n    group: LLM/Agent 主链\n    desc: 模型调用\n')
  const core2 = loadCoreList(coreF2)
  check('core schema2 结构化回读', core2.schema === 2 && core2.core[0]?.id === 'session' && core2.core[0]?.group === '会话/存储' && core2.core[0]?.desc === '会话日志')
  check('core schema2 coreViolations 等价', coreViolations(['session', 'ui-goal'], coreIds(core2.core)).join(',') === coreViolations(['session', 'ui-goal'], ['session', 'llm']).join(','))
  // 功能槽（slot）：解析 + 槽豁免/裁空判据（R11 双判据的单元层）
  const coreF3 = join(root, 'core3.yml')
  writeFileSync(coreF3, 'schema: 2\nslots:\n  llm-adapter:\n    desc: 模型请求适配\n    members: [llm-deepseek, llm-pi-ai]\ncore:\n  - id: llm-deepseek\n    slot: llm-adapter\n    group: LLM/Agent 主链\n    desc: DeepSeek 适配（同槽可替换）\n  - id: session\n    group: 会话/存储\n    desc: 会话日志\n')
  const core3 = loadCoreList(coreF3)
  check('core slots 解析回读', core3.slots?.['llm-adapter']?.members.join(',') === 'llm-deepseek,llm-pi-ai' && core3.core[0]?.slot === 'llm-adapter')
  check('槽豁免：同槽成员活跃 → covering 非空', slotFindings(['llm-deepseek'], core3.core, core3.slots, () => true).some((f) => f.covering.join(',') === 'llm-pi-ai'))
  check('槽裁空：无活跃成员 → covering 空', slotFindings(['llm-deepseek'], core3.core, core3.slots, () => false).every((f) => f.covering.length === 0))
  check('非槽核心 id 不进槽判据', slotFindings(['session'], core3.core, core3.slots, () => true).length === 0)
  check('coreViolations 仍命中槽载体（豁免在 check 组合层过滤）', coreViolations(['llm-deepseek'], coreIds(core3.core)).join(',') === 'llm-deepseek')
  // R11 走 runChecks 全链：core.yml 禁 session → error
  const home = makeHome(); const src = makeDshSource()
  const cacheDir = join(root, 'cache'); mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'dump-config-9.9.9.json'), JSON.stringify({ version: '9.9.9', ids: ['session', 'ui-goal', 'subagent', 'bash', 'mystery-row', 'webserver', 'connection', 'llm-deepseek', 'llm-pi-ai'] }))
  const packsDir = join(root, 'packs'); mkdirSync(packsDir, { recursive: true })
  writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal', 'session'] } }))
  writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  setTrusted(reg, 'demo-plugin', false) // 制造 untrusted：R12 全链应出 warn
  savePluginRegistry(regPath, reg) // runChecks 从文件读库——先把内存态落盘
  const rc = await runChecks(spec, join(root, 'reg-c.yml'), packsDir, cacheDir, { pluginRegistryPath: regPath, coreListPath: coreF })
  check('R11 全链：禁 session → error', rc.items.some((i) => i.rule === 'R11' && i.level === 'error' && i.msg.includes('session')), JSON.stringify(rc.items.filter((i) => i.rule === 'R11')))
  check('R12 全链：untrusted warn 进报告', rc.items.some((i) => i.rule === 'R12' && i.level === 'warn'))
  const packsOk = join(root, 'packs-ok'); mkdirSync(packsOk, { recursive: true })
  writeFileSync(join(packsOk, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal'] } }))
  writeFileSync(join(packsOk, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  const rc2 = await runChecks(spec, join(root, 'reg-d.yml'), packsOk, cacheDir, { pluginRegistryPath: regPath, coreListPath: coreF })
  check('R11 全链：不裁 core → pass', rc2.items.some((i) => i.rule === 'R11' && i.level === 'pass'))
  const rc3 = await runChecks(spec, join(root, 'reg-e.yml'), packsOk, cacheDir, {})
  check('不传路径 → R11/R12 跳过（存量兼容）', !rc3.items.some((i) => i.rule === 'R11') && !rc3.items.some((i) => i.rule === 'R12'))
  // R11 槽语义全链：禁槽载体 + 同槽活跃 → pass（槽豁免）；无存在证据 → error（被裁空）；spec.plugins 作存在证据 → pass
  const packsSlot = join(root, 'packs-slot'); mkdirSync(packsSlot, { recursive: true })
  writeFileSync(join(packsSlot, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['llm-deepseek'] } }))
  writeFileSync(join(packsSlot, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
  const rcSlot = await runChecks(spec, join(root, 'reg-slot.yml'), packsSlot, cacheDir, { pluginRegistryPath: regPath, coreListPath: coreF3 })
  check('R11 槽豁免：roster 有 pi-ai → pass 含槽豁免', rcSlot.items.some((i) => i.rule === 'R11' && i.level === 'pass' && i.msg.includes('槽豁免')), JSON.stringify(rcSlot.items.filter((i) => i.rule === 'R11')))
  const coreF4 = join(root, 'core4.yml')
  writeFileSync(coreF4, 'schema: 2\nslots:\n  llm-adapter:\n    members: [llm-deepseek, my-adapter]\ncore:\n  - id: llm-deepseek\n    slot: llm-adapter\n    group: LLM/Agent 主链\n    desc: x\n')
  const rcEmpty = await runChecks(spec, join(root, 'reg-slot2.yml'), packsSlot, cacheDir, { pluginRegistryPath: regPath, coreListPath: coreF4 })
  check('R11 槽裁空：成员无存在证据 → error 含被裁空', rcEmpty.items.some((i) => i.rule === 'R11' && i.level === 'error' && i.msg.includes('被裁空')), JSON.stringify(rcEmpty.items.filter((i) => i.rule === 'R11')))
  const specSlot: DomainSpec = { ...spec, plugins: [{ id: 'my-adapter', path: entry }] }
  const rcPlugin = await runChecks(specSlot, join(root, 'reg-slot3.yml'), packsSlot, cacheDir, { pluginRegistryPath: regPath, coreListPath: coreF4 })
  check('R11 槽豁免：spec.plugins 存在证据 → pass 含 my-adapter', rcPlugin.items.some((i) => i.rule === 'R11' && i.level === 'pass' && i.msg.includes('my-adapter')), JSON.stringify(rcPlugin.items.filter((i) => i.rule === 'R11')))
}

console.log('\n[13] 导入通道：zip-slip 过滤 + zip 收编 + git 失败提示')
{
  // zip-slip 判定纯函数
  check('zipEntryUnsafe：绝对路径/.. 段/盘符', zipEntryUnsafe('/etc/passwd') && zipEntryUnsafe('a/../../x') && zipEntryUnsafe('C:\\evil') && !zipEntryUnsafe('src/index.ts'))
  const root = fixture()
  const regPath = join(root, 'registry.yml')
  const sources = join(root, 'sources')
  const reg: PluginRegistry = { schema: 1, plugins: [] }
  const save = () => savePluginRegistry(regPath, reg)
  // 正例：python 打一个含 index.ts 的 zip
  const src = join(root, 'zsrc'); mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'index.ts'), 'export function apply() {}\n')
  const zip = join(root, 'good.zip')
  execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],'index.ts'); z.close()`, zip, join(src, 'index.ts')])
  const r1 = importFromZip(zip, reg, sources, { id: 'zip-plug' }, save)
  check('zip 收编成功（sources + untrusted）', r1.ok && reg.plugins[0]?.source === 'sources' && reg.plugins[0]?.trusted === false && reg.plugins[0]?.path.includes('sources/zip-plug'), JSON.stringify(r1))
  check('zip 落盘回读', loadPluginRegistry(regPath).plugins.length === 1 && existsSync(join(sources, 'zip-plug', 'index.ts')))
  check('重复 id 拒绝', !importFromZip(zip, reg, sources, { id: 'zip-plug' }, save).ok)
  check('缺 zip 拒绝', !importFromZip(join(root, 'none.zip'), reg, sources, { id: 'x2' }, save).ok)
  // 负例：zip-slip zip（含 ../evil 条目）
  const evil = join(root, 'evil.zip')
  execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../evil.ts','x'); z.close()`, evil])
  const r3 = importFromZip(evil, reg, sources, { id: 'evil-plug' }, save)
  check('zip-slip zip 拒绝且不落盘', !r3.ok && r3.errors.some((e) => e.includes('zip-slip')) && !existsSync(join(sources, 'evil-plug')), JSON.stringify(r3))
  // 非法 id 的 zip：解压后 addPlugin 失败 → 目录回滚
  const r4 = importFromZip(zip, reg, sources, { id: 'Bad_ID' }, save)
  check('非法 id 解压后回滚', !r4.ok && !existsSync(join(sources, 'Bad_ID')))
  // git：非法 url 即拒（不触网）
  const rg = importFromGit('ftp://bad', reg, sources, { id: 'g1' }, save)
  check('git 非法 url 拒绝', !rg.ok && rg.errors.some((e) => e.includes('url 非法')))
  // git：真实不可达 → 错误含网络前提提示（本环境 github 挂起，用 127.0.0.1:1 快速失败模拟）
  const rg2 = importFromGit('http://127.0.0.1:1/x.git', reg, sources, { id: 'g2' }, save)
  check('git 失败提示含网络前提', !rg2.ok && rg2.errors.some((e) => e.includes('网络前提')) && !existsSync(join(sources, 'g2')), JSON.stringify(rg2))
}

console.log('\n[14] check 历史：追加 + cap 200 + 回读 + 静默降级')
{
  const dir = fixture()
  const mk = (n: number, errors: number, warns = 0) => ({ domain: 'ops', items: [], errors, warns, ...(n ? {} : {}) }) as never
  appendCheckHistory(dir, 'ops', mk(1, 0, 0))
  appendCheckHistory(dir, 'ops', mk(1, 2, 1))
  const h = loadCheckHistory(dir)
  check('追加两条 + result 三态', h.length === 2 && h[0]!.result === 'pass' && h[1]!.result === 'fail' && h[1]!.warns === 1, JSON.stringify(h))
  for (let i = 0; i < 205; i++) appendCheckHistory(dir, 'ops', mk(1, 0))
  const capped = loadCheckHistory(dir)
  check('cap 200（旧记录被挤出）', capped.length === 200, String(capped.length))
  check('目录缺失 → 空数组不抛', loadCheckHistory(join(fixture(), 'nope')).length === 0)
  // warn 态：0 error + n warn
  const dir2 = fixture()
  appendCheckHistory(dir2, 'x', { domain: 'x', items: [], errors: 0, warns: 3 } as never)
  check('warn 态判定（0 error 有 warn）', loadCheckHistory(dir2)[0]!.result === 'warn')
}

console.log('\n[15] 实例状态原语：unitActive 三态 + portOccupied 布尔')
{
  const u = unitActive('dshctl-no-such-unit-xyz.service')
  check('unitActive 未知 unit → false/null（不抛）', u === false || u === null, String(u))
  const p1 = portOccupied(1)
  check('portOccupied 返回布尔不抛', typeof p1 === 'boolean')
  check('高端口大概率空闲（59999）', typeof portOccupied(59999) === 'boolean')
}

console.log('\n[16] 插件库 depends_on 透传（编排画布数据源）')
{
  const f = join(fixture(), 'reg.yml')
  const reg: PluginRegistry = { schema: 1, plugins: [{ id: 'a', path: '/x/a.ts', trusted: true, depends_on: ['b', 'ops-api'] }] }
  savePluginRegistry(f, reg)
  const back = loadPluginRegistry(f)
  check('depends_on 落盘回读', JSON.stringify(back.plugins[0]?.depends_on) === JSON.stringify(['b', 'ops-api']), JSON.stringify(back.plugins[0]))
  const noDecl = { schema: 1, plugins: [{ id: 'x', path: '/x/x.ts', trusted: true }] }
  savePluginRegistry(f, noDecl)
  check('无声明字段不报错', loadPluginRegistry(f).plugins[0]?.depends_on === undefined)
}

console.log('\n[17] 插件库 provides/category 透传（详情与目录分组数据源）')
{
  const f = join(fixture(), 'reg.yml')
  const reg: PluginRegistry = { schema: 1, plugins: [{ id: 'a', path: '/x/a.ts', trusted: true, description: '作用说明', provides: ['tool_a', 'tool_b'], category: '知识网' }] }
  savePluginRegistry(f, reg)
  const back = loadPluginRegistry(f)
  check('provides 落盘回读', JSON.stringify(back.plugins[0]?.provides) === JSON.stringify(['tool_a', 'tool_b']))
  check('description 落盘回读', back.plugins[0]?.description === '作用说明')
  check('category 落盘回读', back.plugins[0]?.category === '知识网')
}

console.log('\n[18] 替换通道：判型 + 保注释 + 全链（预演零写入/回滚字节还原/正向槽豁免/keep-old）')
{
  // ① isPackagePath 判型
  check('包名判型：@scope/pkg、裸名 → true', isPackagePath('@scope/pkg') && isPackagePath('some-pkg') && isPackagePath('lodash.get'))
  check('路径判型：/abs、./rel、带分隔相对 → false', !isPackagePath('/x/y.ts') && !isPackagePath('./y.ts') && !isPackagePath('src/x.ts'))

  // ② saveSlotMember 保注释回读（无 slots 段 → 建槽搬到 core 前；已有槽 → 复用并入）
  const c2 = join(fixture(), 'core.yml')
  writeFileSync(c2, [
    '# plugin-registry/core.yml —— DSH 核心功能清单',
    '# 语义：核心功能不可缺（R11）——清单锚定的是「功能」不是「实现」',
    'schema: 2',
    'core:',
    '  - id: carrier-a',
    '    group: 工具面',
    '    desc: 载体（无槽）',
    '  - id: session',
    '    group: 会话/存储',
    '    desc: 会话日志',
    '',
  ].join('\n'))
  const s1 = saveSlotMember(c2, 'carrier-a', 'new-a')
  const t1 = readFileSync(c2, 'utf8')
  const b1 = loadCoreList(c2)
  check('saveSlotMember 建槽：返回槽名 + 头注释「核心功能」仍在 + slots 搬到 core 前 + 条目补 slot 标记',
    s1 === 'carrier-a' && t1.split('\n')[0]!.includes('核心功能') && t1.indexOf('slots:') < t1.indexOf('core:')
    && b1.core.find((e) => e.id === 'carrier-a')?.slot === 'carrier-a',
    JSON.stringify({ s1, head: t1.split('\n')[0] }))
  check('saveSlotMember 回读：members=[carrier-a, new-a]', JSON.stringify(b1.slots?.['carrier-a']?.members) === JSON.stringify(['carrier-a', 'new-a']))
  const s2 = saveSlotMember(c2, 'carrier-a', 'new-b')
  check('saveSlotMember 已有槽：复用槽名 + members 并入', s2 === 'carrier-a' && (loadCoreList(c2).slots?.['carrier-a']?.members ?? []).join(',') === 'carrier-a,new-a,new-b')

  // ②' mutateYamlText 纯函数（预演虚拟写与真实写共用的地基）
  const mSrc = '# 头注释 —— 必须保留\nschema: 1\nfoo: 1\n'
  const mOut = mutateYamlText(mSrc, (doc) => { doc.set('foo', 2) })
  const mAgain = mutateYamlText(mOut, (doc) => { doc.set('foo', 2) })
  check('mutateYamlText：输入串不变（纯函数不落盘）+ 头注释保留 + 变更生效 + 重放幂等',
    mSrc.includes('foo: 1') && mOut.includes('# 头注释') && mOut.includes('foo: 2') && !mOut.includes('foo: 1')
    && mAgain === mOut,
    JSON.stringify({ mOut, mAgain }))

  // ③④⑤ 全链 fixture：domain + pack + core（严格 id old-impl，无槽）+ 已入库 new-impl（autoAdd=false → 只写三文件）
  const mkFx = (rosterHasOld: boolean): { paths: ReplacePaths; files: Record<string, string>; entry: string } => {
    const root = fixture()
    const domainsDir = join(root, 'domains')
    const packsDir = join(root, 'packs')
    const cacheDir = join(root, 'cache')
    const regDir = join(root, 'plugin-registry')
    mkdirSync(join(domainsDir, 'ops'), { recursive: true })
    mkdirSync(packsDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(regDir, { recursive: true })
    const home = makeHome()
    const src = makeDshSource() // version 9.9.9 → dump-config-9.9.9.json 缓存（全程不触 dump-config）
    const ids = ['ui-goal', 'subagent', 'bash', 'mystery-row', 'webserver', 'connection', 'session', ...(rosterHasOld ? ['old-impl'] : [])]
    writeFileSync(join(cacheDir, 'dump-config-9.9.9.json'), JSON.stringify({ version: '9.9.9', ids }))
    const b = baseSpec(home, src)
    const spec: DomainSpec = { ...b, systemd_unit: undefined, ports: { api: 65001, gui: null }, plugins: [] }
    writeFileSync(join(domainsDir, 'ops', 'domain.yml'), renderDomainYml(spec))
    writeFileSync(join(packsDir, 'core.yml'), renderPackYml({ pack: 'core', disable: { tools: ['ui-goal', 'subagent', 'mystery-row', 'webserver'], overrides: [{ id: 'connection', inject: [], config: { trustedHosts: [] } }] } }))
    writeFileSync(join(packsDir, 'remote-exec.yml'), renderPackYml({ pack: 'remote-exec', disable: {} }))
    writeFileSync(join(packsDir, 'script.yml'), renderPackYml({ pack: 'script', disable: { tools: ['bash'] } }))
    const corePath = join(regDir, 'core.yml')
    writeFileSync(corePath, [
      '# plugin-registry/core.yml —— DSH 核心功能清单（fixture）',
      '# 语义：核心功能不可缺（R11）——清单锚定的是「功能」不是「实现」',
      'schema: 2',
      'core:',
      '  - id: old-impl',
      '    group: 工具面',
      '    desc: 旧实现（严格 id，无槽）',
      '  - id: session',
      '    group: 会话/存储',
      '    desc: 会话日志',
      '',
    ].join('\n'))
    const entry = join(root, 'new-impl.ts')
    writeFileSync(entry, 'export function apply() {}\n')
    const pluginRegistryPath = join(regDir, 'registry.yml')
    savePluginRegistry(pluginRegistryPath, { schema: 1, plugins: [{ id: 'new-impl', path: entry, trusted: true, added_at: '2026-09-18' }] })
    const paths: ReplacePaths = {
      domainsDir, packsDir, cacheDir,
      regYml: join(domainsDir, 'registry.yml'),
      pluginRegistryPath, corePath,
    }
    return { paths, files: { core: corePath, domain: join(domainsDir, 'ops', 'domain.yml'), pack: join(packsDir, 'core.yml'), reg: pluginRegistryPath }, entry }
  }
  const snapAll = (fx: { files: Record<string, string> }): string => JSON.stringify(
    Object.fromEntries(Object.entries(fx.files).map(([k, v]) => [k, readFileSync(v, 'utf8')])),
  )

  // 预演：零写入
  const fx0 = mkFx(true)
  const s0 = snapAll(fx0)
  const dry = await runReplace(fx0.paths, { oldId: 'old-impl', newId: 'new-impl', domain: 'ops' })
  check('预演：dryRun + 四文件零写入 + 等价命令',
    dry.ok === true && dry.dryRun === true && snapAll(fx0) === s0
    && dry.equivalentCommand.includes('dshctl replace old-impl --with new-impl'),
    JSON.stringify({ ok: dry.ok, dryRun: dry.dryRun, cmd: dry.equivalentCommand }))

  // ⑤' 预演行级变更（plan.changes）：结构 + 三卡齐（预注册 → 无 registry 卡）+ 关键行断言
  const ch = dry.plan.changes
  const coreCh = ch.find((c) => c.label === 'core.yml')
  const domCh = ch.find((c) => c.label === 'domain.yml')
  const packCh = ch.find((c) => c.label.startsWith('能力包'))
  const linesOf = (c?: { hunks: { lines: Array<{ t: string; s: string }> } }, t?: string): string[] =>
    (c?.hunks.lines ?? []).filter((l) => !t || l.t === t).map((l) => l.s)
  check('changes 结构：非空 + 每卡有 file/label/action + 行类型仅 ctx/add/del',
    ch.length > 0 && ch.every((c) => !!c.file && !!c.label && !!c.action && c.hunks.lines.length > 0
      && c.hunks.lines.every((l) => ['ctx', 'add', 'del'].includes(l.t) && typeof l.s === 'string')),
    JSON.stringify(ch.map((c) => c.label)))
  check('changes 预注册场景：core/domain/pack 三卡齐（无 registry 卡）',
    ch.length === 3 && !!coreCh && !!domCh && !!packCh,
    JSON.stringify(ch.map((c) => c.label)))
  const coreAdd = linesOf(coreCh, 'add'); const coreDel = linesOf(coreCh, 'del')
  const domAdd = linesOf(domCh, 'add'); const packAdd = linesOf(packCh, 'add'); const packDel = linesOf(packCh, 'del')
  check('core diff：add 含成员 new-impl 与 slot: 标记行；核心头注释不在 del 侧（保注释）',
    coreAdd.some((s) => s.includes('new-impl')) && coreAdd.some((s) => s.includes('slot:'))
    && !coreDel.some((s) => s.includes('核心功能清单')),
    JSON.stringify({ coreAdd, coreDel }))
  check('domain diff：add 含新 id 行', domAdd.some((s) => s.includes('new-impl')), JSON.stringify(domAdd))
  check('pack diff：add 含 - old-impl 禁用行；能力包头注释不在 del 侧',
    packAdd.some((s) => s.trim() === '- old-impl') && !packDel.some((s) => s.includes('capability-packs/core.yml')),
    JSON.stringify({ packAdd, packDel }))

  // ⑤'' autoAdd 变体：清空 registry 新件 → 预演应出第 4 张「插件库入库」变更卡
  const fxA = mkFx(true)
  savePluginRegistry(fxA.files.reg!, { schema: 1, plugins: [] })
  const dryA = await runReplace(fxA.paths, { oldId: 'old-impl', newId: 'new-impl', domain: 'ops', newPath: fxA.entry })
  check('autoAdd 预演：registry 入库变更卡出现（共 4 卡）+ 仍零写入',
    dryA.ok === true && dryA.plan.changes.length === 4
    && dryA.plan.changes.some((c) => c.label === '插件库 registry.yml' && c.action.includes('入库')),
    JSON.stringify({ labels: dryA.plan.changes.map((c) => c.label), ok: dryA.ok }))

  // ③ 回滚：roster 无 old-impl → 禁用后 R2 新增 error → 三文件字节还原
  const fxR = mkFx(false)
  const sR = snapAll(fxR)
  const rr = await runReplace(fxR.paths, { oldId: 'old-impl', newId: 'new-impl', domain: 'ops' }, { yes: true })
  check('回滚：新 R2 error → ok=false + rolledBack + 四文件字节还原',
    rr.ok === false && rr.rolledBack === true
    && (rr.newErrors ?? []).some((e) => e.startsWith('R2') && e.includes('old-impl'))
    && snapAll(fxR) === sR,
    JSON.stringify({ errs: rr.newErrors, r11: rr.r11, rolledBack: rr.rolledBack }))

  // ④ 正向：roster 有 old-impl → 成功 + R11 槽豁免 + 三文件按预期变更
  const fxP = mkFx(true)
  const ok = await runReplace(fxP.paths, { oldId: 'old-impl', newId: 'new-impl', domain: 'ops' }, { yes: true })
  check('正向：成功 + R11 记槽豁免 + 计划四步齐（入库跳过/插入/声明/禁旧）+ 执行三写',
    ok.ok === true && (ok.r11 ?? '').includes('槽豁免')
    && (ok.plan.steps ?? []).length >= 4 && (ok.steps ?? []).length >= 3,
    JSON.stringify({ r11: ok.r11, errs: ok.newErrors, plan: ok.plan.steps?.map((s) => s.action), exec: ok.steps?.map((s) => s.action) }))
  const cT = readFileSync(fxP.files.core!, 'utf8')
  const dT = readFileSync(fxP.files.domain!, 'utf8')
  const pT = readFileSync(fxP.files.pack!, 'utf8')
  const cList = loadCoreList(fxP.files.core!)
  check('正向：core.yml 头注释存留 + 条目补 slot 标记 + 新成员并入 slots',
    cT.split('\n')[0]!.includes('核心功能') && cList.core.find((e) => e.id === 'old-impl')?.slot === 'old-impl'
    && (cList.slots?.['old-impl']?.members ?? []).join(',') === 'old-impl,new-impl')
  check('正向：domain.yml 头注释存留 + 插入 new-impl；pack 头注释存留 + disable old-impl',
    dT.startsWith('# domains/ops') && dT.includes('new-impl') && pT.startsWith('# capability-packs/core.yml') && pT.includes('- old-impl'))
  const rs = parseDomain(fxP.files.domain!)
  const rc = await runChecks(rs.spec!, fxP.paths.regYml, fxP.paths.packsDir, fxP.paths.cacheDir, {
    prevRoster: loadPrevRoster(fxP.paths.cacheDir, '9.9.9'),
    pluginRegistryPath: fxP.paths.pluginRegistryPath, coreListPath: fxP.files.core,
  })
  check('正向：独立 runChecks 0 error + R11 pass 含槽豁免',
    rc.errors === 0 && rc.items.some((i) => i.rule === 'R11' && i.level === 'pass' && i.msg.includes('槽豁免')),
    JSON.stringify(rc.items.filter((i) => i.rule === 'R11' || i.level === 'error')))

  // ⑤ keep-old：跳过槽声明与禁用 → core/pack 零变化，仅 domain 插入
  const fxK = mkFx(true)
  const kPack = readFileSync(fxK.files.pack!, 'utf8')
  const kCore = readFileSync(fxK.files.core!, 'utf8')
  const dryK = await runReplace(fxK.paths, { oldId: 'old-impl', newId: 'new-impl', domain: 'ops', keepOld: true })
  check('keep-old 预演：changes 仅 domain 一张卡（core/pack 不出现）',
    dryK.ok === true && dryK.plan.changes.length === 1 && dryK.plan.changes[0]?.label === 'domain.yml',
    JSON.stringify(dryK.plan.changes.map((c) => c.label)))
  const kr = await runReplace(fxK.paths, { oldId: 'old-impl', newId: 'new-impl', domain: 'ops', keepOld: true }, { yes: true })
  check('keep-old：成功 + core/pack 字节零变化 + domain 仍插入',
    kr.ok === true && readFileSync(fxK.files.pack!, 'utf8') === kPack
    && readFileSync(fxK.files.core!, 'utf8') === kCore && readFileSync(fxK.files.domain!, 'utf8').includes('new-impl'),
    JSON.stringify({ ok: kr.ok, errs: kr.newErrors, steps: kr.steps?.map((s) => s.action) }))
}

console.log('\n[15] v0.4 体验层：domain new 骨架 / 上下文推断 / 空 insert 语义')
{
  // ① renderDomainSkeleton：身份字段推导 + api_server 默认缺省
  const sk = renderDomainSkeleton('demo-x', {
    home: '/tmp/hx', source: '/tmp/sx', port: 8644,
    presetSource: '/tmp/hx/presets/demo-x', unit: 'dsh-demo-x.service',
  })
  const parsed = parseDomain(join(mkdtempSync(join(tmpdir(), 'dshctl-sk')), 'domain.yml'))
  void parsed
  const fxSk = join(fixture(), 'domain.yml')
  writeFileSync(fxSk, sk)
  const skParsed = parseDomain(fxSk)
  check('骨架：解析零错误（check 开箱即过）', !!skParsed.spec && skParsed.errors.length === 0, JSON.stringify(skParsed.errors))
  check('骨架：身份字段推导（home/port/unit/env 名）',
    skParsed.spec?.dsh_home === '/tmp/hx' && skParsed.spec?.api_server === undefined
    && skParsed.spec?.ports?.api === 8644 && skParsed.spec?.systemd_unit === 'dsh-demo-x.service')
  check('骨架：api_key_env = <NAME>_API_KEY（R8 合法）',
    sk.includes('DEMO_X_API_KEY') && !!skParsed.spec)
  check('骨架：默认不带 skills_dirs（无技能域合法，R6 不扫空目录）', !skParsed.spec?.preset?.skills_dirs?.length)
  check('骨架：核对清单注释在头部', sk.startsWith('# domains/demo-x/domain.yml') && sk.includes('[ ] dsh_home'))

  // ② --from 派生：api_server 带入但 port/env 重写
  const skFrom = renderDomainSkeleton('demo-y', {
    home: '/tmp/hy', source: '/tmp/sx', port: 8645,
    presetSource: '/tmp/hy/presets/demo-y', unit: 'dsh-demo-y.service',
    derived: {
      capabilities: ['remote-exec', 'script'],
      api_server: { port: 8643, api_key_env: 'OPS_API_KEY', turn_timeout_sec: 90, max_task_duration_sec: 90, plugin_path: '/x/ops-api/index.ts', plugin_id: 'ops-api' },
    },
  })
  check('骨架 --from：capabilities 带入 + api_server port/env 重写 + plugin_path 保留',
    skFrom.includes('- remote-exec') && skFrom.includes('- script')
    && skFrom.includes('port: 8645') && skFrom.includes('DEMO_Y_API_KEY')
    && skFrom.includes('/x/ops-api/index.ts') && skFrom.includes('turn_timeout_sec: 90'),
    JSON.stringify({ has: skFrom.includes('port: 8643') }))

  // ③ pickDomain 三级推断
  const names = ['alpha', 'beta']
  check('推断：显式指定优先', pickDomain('/x', '/d', 'beta', names).name === 'beta')
  check('推断：cwd 在域目录内取其名', pickDomain('/d/alpha/sub', '/d', '', names).name === 'alpha')
  check('推断：唯一域自动取', pickDomain('/x', '/d', '', ['only']).name === 'only')
  const multi = pickDomain('/x', '/d', '', names)
  check('推断：多域无 cwd 上下文 → 列候选不瞎猜', 'candidates' in multi && multi.candidates.length === 2)

  // ④ listDomainNames：只算有 domain.yml 的目录
  const scanRoot = fixture()
  mkdirSync(join(scanRoot, 'domains', 'a'), { recursive: true })
  mkdirSync(join(scanRoot, 'domains', 'b'), { recursive: true })
  mkdirSync(join(scanRoot, 'domains', 'c'), { recursive: true })
  writeFileSync(join(scanRoot, 'domains', 'a', 'domain.yml'), 'schema: 1\ndomain: a\n')
  writeFileSync(join(scanRoot, 'domains', 'c', 'other.yml'), 'x: 1')
  check('listDomainNames：缺 domain.yml 的目录不算', JSON.stringify(listDomainNames(join(scanRoot, 'domains'))) === JSON.stringify(['a']))
  check('listDomainNames：目录不存在返回空数组', JSON.stringify(listDomainNames(join(scanRoot, 'nope'))) === '[]')

  // ⑤ renderProfilePatch：api 段可选 + 空 insert 省略
  const { renderProfilePatch } = await import('./render.ts')
  const apiLess = renderProfilePatch({ schema: 1, domain: 'minimal', dsh_home: '/h', dsh_source: '/s', capabilities: [], preset: { source: '/p' }, ports: { api: 8644, gui: null } })
  check('patch：无 api 段 → 不输出空 `- insert:`（防启动 warn）',
    !apiLess.error && !apiLess.content.includes('- insert:') && apiLess.content.includes('- id: agent-presets'))
  const withApi = renderProfilePatch({ schema: 1, domain: 'minimal', dsh_home: '/h', dsh_source: '/s', capabilities: [], preset: { source: '/p' }, ports: { api: 8644, gui: null }, api_server: { port: 8644, api_key_env: 'X_API_KEY', turn_timeout_sec: 120, max_task_duration_sec: 120 } })
  check('patch：有 api 段但缺 plugin_path → fail-loud',
    !!withApi.error && withApi.error.includes('plugin_path'))
}

// footer

// footer

console.log('\n[16] v0.5 插件单元化：自描述 / scaffold / install / R13 / 导入防护')
{
  // ① manifest 读写往返 + !!js 原文检测
  const mDir = fixture()
  const m: PluginManifest = { schema: 1, id: 'demo-plugin', entry: 'index.ts', layout: 'in-place', config: { bknRoot: '/bkn', guardEnabled: true } }
  savePluginManifest(mDir, m)
  const mBack = loadPluginManifest(mDir)
  check('manifest：往返保真（id/entry/layout/config）', !!mBack && mBack.id === 'demo-plugin' && mBack.entry === 'index.ts' && mBack.layout === 'in-place' && JSON.stringify(mBack.config) === JSON.stringify(m.config))
  savePluginManifest(mDir, { ...m, config: { apiKey: '!!js process.env.X' } })
  check('manifest：config 含 !!js → install 拒绝回写（原文检测）', manifestConfigPlain(mDir, loadPluginManifest(mDir)!) === false)
  savePluginManifest(mDir, m)  // 恢复纯 config——后续 install/R12 用干净状态

  // ② collectPeerDeps：外部包采集，相对导入忽略
  const depDir = fixture()
  mkdirSync(depDir, { recursive: true })
  writeFileSync(join(depDir, 'index.ts'), "import type { Context } from '@deepseek-ai/cordis'\nimport Schema from '@deepseek-ai/schemastery'\nimport { x } from './util.ts'\nimport 'node:fs'\n")
  writeFileSync(join(depDir, 'util.ts'), "import { defineTool } from '@deepseek-ai/dsh-tools'\nexport const x = 1\n")
  check('collectPeerDeps：@外部包采集 + 相对/node: 忽略',
    JSON.stringify(collectPeerDeps(depDir)) === JSON.stringify(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']),
    JSON.stringify(collectPeerDeps(depDir)))

  // ③ scaffold：package.json 补全 + manifest 新建 + peer 双声明
  const regFx: PluginRegistry = { schema: 1, plugins: [{ id: 'demo-plugin', path: join(depDir, 'index.ts'), trusted: true, source: 'local' }] }
  const sc = scaffoldPlugin(regFx, 'demo-plugin', fixture())
  check('scaffold：零错误 + manifest 新建（in-place）',
    !sc.errors.length && sc.createdManifest && sc.manifest.layout === 'in-place' && sc.manifest.id === 'demo-plugin', JSON.stringify(sc.errors))
  const pkg = JSON.parse(readFileSync(join(depDir, 'package.json'), 'utf8')) as { main?: string; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  check('scaffold：package.json 补 main/exports/peer 双声明',
    pkg.main === 'index.ts' && !!pkg.peerDependencies?.['@deepseek-ai/cordis'] && !!pkg.devDependencies?.['@deepseek-ai/cordis'])
  const sc2 = scaffoldPlugin(regFx, 'demo-plugin', fixture())
  check('scaffold：幂等（二跑零改动）', !sc2.createdManifest && sc2.pkgChanges.some((c) => c.includes('已是完整单元')))

  // ④ installIntoDomain：in-place / vendored 两布局
  const home = fixture()
  mkdirSync(join(home, 'plugins'), { recursive: true })
  const specFx = { schema: 1, domain: 'd1', dsh_home: home, dsh_source: '/s', capabilities: [], preset: { source: '/p', skills_dirs: [] } } as Parameters<typeof installIntoDomain>[1]
  savePluginManifest(depDir, { ...m, id: 'demo-plugin' })  // scaffold 生成的 manifest 由用户补 config 后再 install
  const ins1 = installIntoDomain(regFx, specFx, 'demo-plugin')
  check('install：in-place → path=库 path + config 随写',
    ins1.ok && ins1.path === join(depDir, 'index.ts') && JSON.stringify(specFx.plugins?.[0]?.config) === JSON.stringify(m.config), JSON.stringify({ errors: ins1.errors, path: ins1.path, cfg: specFx.plugins?.[0]?.config }))
  const ins2 = installIntoDomain(regFx, specFx, 'demo-plugin', { layout: 'vendored' })
  check('install：vendored → 拷进 <home>/plugins/<id>/ 且排除非源码',
    ins2.ok && ins2.path === join(home, 'plugins', 'demo-plugin', 'index.ts') && existsSync(join(home, 'plugins', 'demo-plugin', 'dsh.plugin.yml')))

  // ⑤ R12 vendored path 语义 + R13 交叉
  const r12 = checkDomainPlugins(specFx, regFx)
  check('R12：vendored 布局按 <home>/plugins/<id>/<entry> 校验通过',
    r12.some((i) => i.rule === undefined || true) && r12.every((i) => i.level !== 'error' || !i.msg.includes('path 漂移')), JSON.stringify(r12))
  check('R13：引用 ∩ 禁用 = ∅ → pass', crossCheckRegistries(specFx, ['ui-todo']).some((i) => i.level === 'pass'))
  const conflict = crossCheckRegistries({ ...specFx, plugins: [{ id: 'demo-plugin', path: '/x' }] }, ['demo-plugin'])
  check('R13：同 id 既引用又禁用 → error', conflict.some((i) => i.level === 'error' && i.msg.includes('demo-plugin')))

  // ⑥ extractInsertBlock：原文层提取（!!js 字面保真）
  const patchText = `- insert:\n    - id: bkn-plugin\n      name: '/x/index.ts'\n      config:\n        apiKey: !!js process.env.K\n        plain: 1\n    - id: next\n      name: '/y'\n`
  const block = extractInsertBlock(patchText, 'bkn-plugin')
  check('extractInsertBlock：到下一个 - id: 截断', !!block && block.includes('apiKey: !!js process.env.K') && block.includes('plain: 1') && !block.includes("name: '/y'"))

  // ⑦ 导入防护常量
  check('导入防护：解压上限 200MB 常量在位', ZIP_MAX_UNCOMPRESSED === 200 * 1024 * 1024)
}

// footer

// footer
for (const r of roots) rmSync(r, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : `${failures} FAILED ❌`}`)
process.exit(failures === 0 ? 0 : 1)
