/**
 * server.ts — dshctl GUI 薄壳后端（v0.4+）：node:http 绑定可配（--host/--port），
 * 桥接核心函数，不另建业务逻辑（设计 §2 GUI 边界）。每个响应带 equivalentCommand。
 * 运行：bin/dshctl-gui [--port 8780] [--host 0.0.0.0]（自带 tsx，任意目录可用）
 */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadRegistry } from '../registry.ts'
import { parseDomain, renderDomainYml, DOMAIN_RE, type DomainSpec } from '../domain.ts'
import { loadPacks } from '../packs.ts'
import { diffDomain } from '../diff.ts'
import { runChecks, loadPrevRoster, loadCheckHistory, appendCheckHistory, unitActive, portOccupied } from '../check.ts'
import { runUpgradeCheck } from '../upgrade-check.ts'
import { runSmoke } from '../smoke.ts'
import { loadPluginRegistry, savePluginRegistry, addPlugin, removePlugin, setTrusted, publishDomain, checkDomainPlugins } from '../plugin.ts'
import { loadCoreList } from '../core.ts'
import { runReplace, type ReplacePaths } from '../replace.ts'
import { importFromZip, importFromGit, ZIP_MAX_BYTES } from '../import.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..') // dsh-info/
const DOMAINS = join(ROOT, 'domains')
const REGISTRY = join(DOMAINS, 'registry.yml')
const PACKS = join(ROOT, 'code', 'capability-packs')
const CACHE = join(DOMAINS, '.cache')
const PLUGIN_REGISTRY = join(ROOT, 'plugin-registry', 'registry.yml')
const CORE_LIST = join(ROOT, 'plugin-registry', 'core.yml')
const PLUGIN_SOURCES = join(ROOT, 'plugin-registry', 'sources')
const DIST = join(import.meta.dirname, 'dist')

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 表单回写的 spec：剪除空段（可选段为空对象/空数组 → 删键，保持 YAML 干净） */
function pruneSpec(raw: unknown): DomainSpec {
  const o = JSON.parse(JSON.stringify(raw)) as Record<string, undefined>
  // 表单不暴露 schema/domain：置顶重排（YAML 无序但保持人类阅读习惯）
  const { schema: _s, domain: _d, ...rest } = o
  const s = { schema: 1, ...(rest as object) } as Record<string, undefined>
  const empty = (v: unknown): boolean => v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) || (Array.isArray(v) && v.length === 0)
  for (const k of ['contracts', 'guard', 'memory', 'ports', 'plugins', 'shared_deps', 'systemd_unit', 'display_name'] as const) {
    if (empty(s[k])) delete s[k]
  }
  const g = s.guard as Record<string, unknown> | undefined
  if (g && g.whitelist && empty((g.whitelist as Record<string, unknown>).commands) && empty((g.whitelist as Record<string, unknown>).write_paths)) delete g.whitelist
  const api = s.api_server as Record<string, unknown> | undefined
  if (api && empty(api.plugin_id)) delete api.plugin_id
  return s as unknown as DomainSpec
}

/** 校验 + 原子落盘（与 CLI 同一 parseDomain 规则）；失败返回错误列表（不落盘） */
function validateAndWrite(file: string, spec: DomainSpec): { ok: true } | { ok: false; errors: string[] } {
  const yml = renderDomainYml(spec)
  const tmp = `${file}.gui-tmp-${process.pid}`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, yml)
  const { spec: parsed, errors } = parseDomain(tmp)
  if (!parsed || errors.length) { rmSync(tmp, { force: true }); return { ok: false, errors: errors.length ? errors : ['解析失败'] } }
  renameSync(tmp, file)
  return { ok: true }
}

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }

/** 实例运行状态三件套：unit 活跃（三态）+ 端口占用 + API /health 探活（1.5s） */
async function instanceStatus(domain: string): Promise<{ domain: string; unit: string | null; unitActive: boolean | null; portOccupied: boolean; apiHealth: boolean | null } | { domain: string; error: string }> {
  const reg = loadRegistry(REGISTRY)
  const inst = reg.instances.find((x) => x.domain === domain)
  const unit = inst?.systemd_unit ?? null
  const apiPort = inst?.ports?.api
  let health: boolean | null = null
  if (apiPort) {
    try { await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(1500) }); health = true } catch { health = false }
  }
  return {
    domain,
    unit,
    unitActive: unit ? unitActive(unit) : null,
    portOccupied: apiPort ? portOccupied(apiPort) : false,
    apiHealth: health,
  }
}

/** systemctl 固定 argv 执行（unit 只来自 registry；无 shell；超时 30s） */
function systemctl(action: 'start' | 'stop' | 'restart', unit: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile('systemctl', [action, unit], { timeout: 30_000 }, (err, _out, stderr) => {
      resolve({ ok: !err, stderr: String(stderr ?? err?.message ?? '').slice(0, 400) })
    })
  })
}

/** 轮询 /health ≤30s（start 后等就绪） */
async function waitApiHealth(port: number, timeoutMs = 30_000): Promise<{ healthy: boolean; elapsedMs: number }> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) }); return { healthy: true, elapsedMs: Date.now() - t0 } } catch { await new Promise((r) => setTimeout(r, 700)) }
  }
  return { healthy: false, elapsedMs: Date.now() - t0 }
}

const portArg = process.argv.indexOf('--port')
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8780
const hostArg = process.argv.indexOf('--host')
const HOST = hostArg > 0 ? process.argv[hostArg + 1]! : '127.0.0.1'
const LAN = HOST !== '127.0.0.1' && HOST !== 'localhost'
const keyArg = process.argv.indexOf('--key')
/** 鉴权 key：--key 或 DSHCTL_GUI_KEY。非回环绑定必须配置（fail-loud，对齐 ops-api 双 key 模式） */
const GUI_KEY = keyArg > 0 ? process.argv[keyArg + 1]! : process.env.DSHCTL_GUI_KEY ?? ''
if (LAN && !GUI_KEY) {
  console.error(`gui: 非回环绑定（${HOST}）必须配置鉴权 key——--key <key> 或 DSHCTL_GUI_KEY（GUI 具备清单写与 systemctl 起停能力，裸奔拒绝启动）`)
  process.exit(2)
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const p = url.pathname
  try {
    // /api/* 鉴权：配置了 key 时校验 Bearer（静态资源放行——页面壳无数据，401 由前端引导输 key）
    if (GUI_KEY && p.startsWith('/api/')) {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${GUI_KEY}`) return json(res, 401, { error: 'unauthorized——GUI Key 缺失或不正确（--key / DSHCTL_GUI_KEY）' })
    }
    // ── 只读 API ──
    if (p === '/api/registry') {
      return json(res, 200, { data: loadRegistry(REGISTRY), equivalentCommand: 'dshctl registry --json' })
    }
    if (p === '/api/upgrade') {
      const data = runUpgradeCheck({ registryPath: REGISTRY, domainsDir: DOMAINS, packsDir: PACKS, cacheDir: CACHE })
      try { writeFileSync(join(CACHE, 'upgrade-verdict.json'), JSON.stringify({ verdict: data.verdict, at: new Date().toISOString() })) } catch { /* 缓存失败不挡响应 */ }
      return json(res, 200, { data, equivalentCommand: 'dshctl upgrade-check --json' })
    }
    if (p === '/api/domains') {
      const list = existsSync(DOMAINS)
        ? readdirSync(DOMAINS, { withFileTypes: true })
            .filter((d) => d.isDirectory() && existsSync(join(DOMAINS, d.name, 'domain.yml')))
            .map((d) => d.name).sort()
        : []
      return json(res, 200, { data: list, equivalentCommand: 'ls domains/*/domain.yml' })
    }
    if (p === '/api/packs') {
      const packs = loadPacks(PACKS).map((x) => ({ pack: x.pack, description: x.description ?? '', draft: !!x.draft }))
      return json(res, 200, { data: packs, equivalentCommand: 'ls code/capability-packs/' })
    }
    // ── 插件库 ──
    if (p === '/api/plugins') {
      if (req.method === 'GET') {
        const reg = loadPluginRegistry(PLUGIN_REGISTRY)
        return json(res, 200, { data: reg.plugins, equivalentCommand: 'dshctl plugin list --json' })
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { id?: string; path?: string; name?: string; description?: string }
        const reg = loadPluginRegistry(PLUGIN_REGISTRY)
        const r = addPlugin(reg, { id: String(body.id ?? ''), path: String(body.path ?? ''), ...(body.name ? { name: body.name } : {}), ...(body.description ? { description: body.description } : {}) })
        if (!r.ok) return json(res, 400, { error: r.errors.join('; '), errors: r.errors })
        savePluginRegistry(PLUGIN_REGISTRY, reg)
        return json(res, 200, { ok: true, data: r.entry, equivalentCommand: `dshctl plugin add --id ${body.id} --path ${body.path}` })
      }
    }
    if (p === '/api/plugins/core') {
      // schema 2 结构化：{ id, group?, desc }[]（分组与一句话说明由 core.yml 提供）
      return json(res, 200, { data: loadCoreList(CORE_LIST), equivalentCommand: 'cat plugin-registry/core.yml' })
    }
    if (p === '/api/history') {
      return json(res, 200, { data: loadCheckHistory(DOMAINS), equivalentCommand: 'cat domains/.check-history.json' })
    }
    // ── 提示中心：静态环境 + 动态结果聚合（只读，便宜项实时算）──
    // 已读持久化：domains/.cache/notices-ack.json（{ acked: string[] }）；key = level|nav|domain|title，
    // title 内含 check 时间戳/错误数——底层问题变化 → key 变 → 自动重新亮（已读不误伤新问题）。
    const NOTICE_ACK = join(CACHE, 'notices-ack.json')
    const readAcked = (): string[] => {
      try { return (JSON.parse(readFileSync(NOTICE_ACK, 'utf8')) as { acked?: string[] }).acked ?? [] } catch { return [] }
    }
    const noticeKey = (n: { level: string; nav: string; domain?: string; title: string }) => `${n.level}|${n.nav}|${n.domain ?? ''}|${n.title}`
    if (p === '/api/notices/ack') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { keys?: string[] }
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : []
        if (!keys.length) return json(res, 400, { error: 'keys 非空数组' })
        const merged = [...new Set([...readAcked(), ...keys])]
        try { writeFileSync(NOTICE_ACK, JSON.stringify({ acked: merged })) } catch { /* 写失败不挡响应（降级铁律） */ }
        return json(res, 200, { ok: true, data: { acked: merged.length } })
      }
      if (req.method === 'DELETE') {
        try { writeFileSync(NOTICE_ACK, JSON.stringify({ acked: [] })) } catch { /* 同上 */ }
        return json(res, 200, { ok: true })
      }
    }
    if (p === '/api/notices') {
      const reg = loadRegistry(REGISTRY)
      const notices: Array<{ level: 'error' | 'warn' | 'info'; title: string; detail: string; nav: string; domain?: string }> = []
      for (const i of reg.instances) {
        if (i.last_check && i.last_check.result !== 'pass') {
          notices.push({ level: 'error', title: `${i.domain} 最近 check 未通过`, detail: `${i.last_check.errors} error / ${i.last_check.warns} warn（${i.last_check.at}）——进详情页看逐条规则`, nav: 'domains', domain: i.domain })
        }
      }
      if (reg.unregistered_ports?.length) {
        notices.push({ level: 'warn', title: `未登记占用端口 ${reg.unregistered_ports.join(', ')}`, detail: '归属取证见 domains/registry.yml 注释；确认后回收或登记', nav: 'registry' })
      }
      const preg = loadPluginRegistry(PLUGIN_REGISTRY)
      for (const inst of reg.instances) {
        const { spec } = parseDomain(join(DOMAINS, inst.domain, 'domain.yml'))
        if (!spec) continue
        for (const r of checkDomainPlugins(spec, preg)) {
          if (r.level === 'error') notices.push({ level: 'error', title: `${inst.domain}: ${r.msg}`, detail: '插件库对齐（check R12）', nav: 'plugins', domain: inst.domain })
          else if (r.level === 'warn') notices.push({ level: 'warn', title: `${inst.domain}: ${r.msg}`, detail: '插件库对齐（check R12）——核实源码后在插件详情里点信任', nav: 'plugins', domain: inst.domain })
        }
      }
      try {
        const v = JSON.parse(readFileSync(join(CACHE, 'upgrade-verdict.json'), 'utf8')) as { verdict?: string; at?: string }
        if (v.verdict && v.verdict !== 'pass') notices.push({ level: 'info', title: `升级对账 ${String(v.verdict).toUpperCase()}`, detail: `最近运行 ${v.at ?? '-'}——详见升级对账页`, nav: 'upgrade' })
      } catch { /* 未跑过升级对账 → 不出条目 */ }
      const acked = new Set(readAcked())
      const data = notices.map((n) => ({ ...n, key: noticeKey(n) })).filter((n) => !acked.has(n.key))
      return json(res, 200, { data, equivalentCommand: 'dshctl registry --json && dshctl check <域> --ci' })
    }
    // ── 实例生命周期（真控制：unit 只来自 registry，固定 argv）──
    if (p === '/api/instances/status') {
      const reg = loadRegistry(REGISTRY)
      const list = await Promise.all(reg.instances.map((i) => instanceStatus(i.domain)))
      return json(res, 200, { data: list, equivalentCommand: 'systemctl is-active <unit> && curl 127.0.0.1:<api>/health' })
    }
    const mInst = /^\/api\/instance\/([\w-]+)\/(status|ctl|smoke)$/.exec(p)
    if (mInst) {
      const name = mInst[1]!
      const action = mInst[2]!
      if (!DOMAIN_RE.test(name)) return json(res, 400, { error: `非法 domain 名 '${name}'` })
      const reg = loadRegistry(REGISTRY)
      const inst = reg.instances.find((x) => x.domain === name)

      if (action === 'status') {
        return json(res, 200, { data: await instanceStatus(name), equivalentCommand: `systemctl is-active ${inst?.systemd_unit ?? '<unit>'}` })
      }
      if (action === 'ctl' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { action?: string }
        const act = String(body.action ?? '')
        if (!['start', 'stop', 'restart'].includes(act)) return json(res, 400, { error: `action 白名单：start/stop/restart（收到 '${act}'）` })
        if (!inst?.systemd_unit) return json(res, 400, { error: `领域 '${name}' 未登记 systemd_unit——先 apply 并人工安装 unit（见 code/scripts/run-ops-trial.sh）` })
        const unit = inst.systemd_unit // unit 只来自 registry，不信请求体
        const r = await systemctl(act as 'start' | 'stop' | 'restart', unit)
        const eq = `systemctl ${act} ${unit}`
        if (!r.ok) {
          const hint = act === 'start' && /not found|no such/i.test(r.stderr)
            ? '（瞬态 unit 可能已被 GC——先人工 systemd-run 安装，见 code/scripts/run-ops-trial.sh）' : ''
          return json(res, 500, { error: `systemctl ${act} 失败：${r.stderr || '未知错误'}${hint}`, equivalentCommand: eq })
        }
        let health: { healthy: boolean; elapsedMs: number } | null = null
        if (act !== 'stop' && inst.ports?.api) health = await waitApiHealth(inst.ports.api)
        return json(res, 200, { ok: true, health, equivalentCommand: eq })
      }
      if (action === 'smoke' && req.method === 'POST') {
        const dPath = join(DOMAINS, name, 'domain.yml')
        const { spec, errors } = parseDomain(dPath)
        if (!spec) return json(res, 400, { error: `domain.yml 解析失败: ${errors.join('; ')}` })
        // 长任务：runSmoke 内部自带超时与兜底清理；同步等待（前端 loading）
        const report = await runSmoke(spec, { cacheDir: CACHE, selfTest: true })
        return json(res, 200, { data: report, equivalentCommand: `dshctl smoke ${name}` })
      }
      return json(res, 405, { error: 'GET status；POST ctl/smoke' })
    }
    if (p === '/api/plugins/publish' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { domain?: string }
      const name = String(body.domain ?? '')
      const { spec, errors } = parseDomain(join(DOMAINS, name, 'domain.yml'))
      if (!spec) return json(res, 400, { error: `domain.yml 解析失败: ${errors.join('; ')}` })
      const reg = loadPluginRegistry(PLUGIN_REGISTRY)
      const r = publishDomain(reg, spec)
      if (r.errors.length) return json(res, 400, { error: r.errors.join('; ') })
      savePluginRegistry(PLUGIN_REGISTRY, reg)
      return json(res, 200, { ok: true, data: r, equivalentCommand: `dshctl plugin publish ${name}` })
    }
    // 替换通道（与 CLI dshctl replace 同源引擎）
    if (p === '/api/replace' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { old_id?: string; new_id?: string; domain?: string; pack?: string; keep_old?: boolean; path?: string; smoke?: boolean; dry_run?: boolean }
      const oldId = String(body.old_id ?? ''); const newId = String(body.new_id ?? '')
      if (!oldId || !newId) return json(res, 400, { error: '需要 old_id 与 new_id' })
      const paths: ReplacePaths = {
        domainsDir: DOMAINS, packsDir: PACKS, cacheDir: CACHE,
        regYml: REGISTRY, pluginRegistryPath: PLUGIN_REGISTRY, corePath: CORE_LIST,
      }
      try {
        const result = await runReplace(paths, {
          oldId, newId,
          domain: String(body.domain ?? 'ops'),
          ...(body.pack ? { pack: String(body.pack) } : {}),
          ...(body.keep_old ? { keepOld: true } : {}),
          ...(body.path ? { newPath: String(body.path) } : {}),
          ...(body.smoke ? { smoke: true } : {}),
        }, { yes: body.dry_run !== true })
        if (!result.ok) {
          // 预检失败 = plan.errors（零写入阶段）；执行失败 = newErrors（已回滚）——都透传给前端
          const errs = result.newErrors?.length ? result.newErrors : result.plan.errors
          return json(res, 400, {
            error: errs.join('; ') || (result.rolledBack ? 'check 未通过，已回滚' : 'replace 失败'),
            errors: errs, rolledBack: result.rolledBack,
            r11: result.r11, plan: result.plan, equivalentCommand: result.equivalentCommand,
          })
        }
        if (result.dryRun) {
          return json(res, 200, {
            ok: true,
            data: { dryRun: true, steps: result.plan.steps, warnings: result.plan.warnings, changes: result.plan.changes },
            equivalentCommand: result.equivalentCommand,
          })
        }
        return json(res, 200, {
          ok: true, data: { steps: result.steps, r11: result.r11, smoke: result.smoke, rollbackGuide: result.rollbackGuide },
          equivalentCommand: result.equivalentCommand,
        })
      } catch (e) { return json(res, 500, { error: (e as Error).message }) }
    }
    // zip 上传（JSON base64 承载，免 multipart；上限 ZIP_MAX_BYTES）
    if (p === '/api/plugins/upload' && req.method === 'POST') {
      const raw = await readBody(req)
      if (raw.length > Math.ceil(ZIP_MAX_BYTES * 4 / 3) + 8192) return json(res, 413, { error: `上传超限（> ${ZIP_MAX_BYTES} bytes zip）` })
      const body = JSON.parse(raw) as { id?: string; name?: string; description?: string; entry?: string; zip_base64?: string }
      if (!body.id || !body.zip_base64) return json(res, 400, { error: '需要 id 与 zip_base64' })
      const zipPath = join(PLUGIN_SOURCES, `.upload-${process.pid}-${Date.now()}.zip`)
      mkdirSync(PLUGIN_SOURCES, { recursive: true })
      writeFileSync(zipPath, Buffer.from(body.zip_base64, 'base64'))
      const reg = loadPluginRegistry(PLUGIN_REGISTRY)
      try {
        const r = importFromZip(zipPath, reg, PLUGIN_SOURCES,
          { id: String(body.id), ...(body.name ? { name: body.name } : {}), ...(body.description ? { description: body.description } : {}), ...(body.entry ? { entry: body.entry } : {}) },
          () => savePluginRegistry(PLUGIN_REGISTRY, reg))
        if (!r.ok) return json(res, 400, { error: r.errors.join('; '), errors: r.errors })
        return json(res, 200, { ok: true, data: r.entry, equivalentCommand: `dshctl plugin import <zip> --id ${body.id}` })
      } finally { rmSync(zipPath, { force: true }) }
    }
    if (p === '/api/plugins/import-git' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { id?: string; url?: string; ref?: string; entry?: string }
      const reg = loadPluginRegistry(PLUGIN_REGISTRY)
      const r = importFromGit(String(body.url ?? ''), reg, PLUGIN_SOURCES,
        { id: String(body.id ?? ''), ...(body.ref ? { ref: body.ref } : {}), ...(body.entry ? { entry: body.entry } : {}) },
        () => savePluginRegistry(PLUGIN_REGISTRY, reg))
      if (!r.ok) return json(res, 400, { error: r.errors.join('; '), errors: r.errors })
      return json(res, 200, { ok: true, data: r.entry, equivalentCommand: `dshctl plugin import-git ${body.url} --id ${body.id}` })
    }
    const mPlug = /^\/api\/plugins\/([\w-]+)$/.exec(p)
    if (mPlug) {
      const id = mPlug[1]!
      const reg = loadPluginRegistry(PLUGIN_REGISTRY)
      if (req.method === 'DELETE') {
        if (!removePlugin(reg, id)) return json(res, 404, { error: `'${id}' 不在插件库` })
        savePluginRegistry(PLUGIN_REGISTRY, reg)
        return json(res, 200, { ok: true, equivalentCommand: `dshctl plugin remove ${id}` })
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { trusted?: boolean }
        if (!setTrusted(reg, id, body.trusted !== false)) return json(res, 404, { error: `'${id}' 不在插件库` })
        savePluginRegistry(PLUGIN_REGISTRY, reg)
        return json(res, 200, { ok: true, equivalentCommand: `dshctl plugin trust ${id}${body.trusted === false ? ' --off' : ''}` })
      }
    }
    if (p === '/api/summary') {
      // Dashboard 专用轻量聚合：绝不触发 dump-config（重活只在 upgrade-check 页手动跑）
      const reg = loadRegistry(REGISTRY)
      const domains = existsSync(DOMAINS)
        ? readdirSync(DOMAINS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(DOMAINS, d.name, 'domain.yml'))).map((d) => d.name)
        : []
      const packs = loadPacks(PACKS)
      const deps = loadRegistry(REGISTRY).shared_deps.length ? reg.shared_deps : []
      const health = await Promise.all(deps.map(async (d) => {
        try {
          await fetch(d.url, { signal: AbortSignal.timeout(1500) })
          return { ...d, ok: true }
        } catch { return { ...d, ok: false } }
      }))
      return json(res, 200, {
        data: {
          instances: reg.instances.length,
          domains: domains.length,
          domainList: domains.sort(),
          packs: packs.length,
          lastChecks: reg.instances.map((i) => ({ domain: i.domain, last_check: i.last_check ?? null })),
          unregisteredPorts: reg.unregistered_ports,
          sharedDeps: health,
        },
        equivalentCommand: 'dshctl registry --json',
      })
    }
    const mCheck = /^\/api\/check\/([\w-]+)$/.exec(p)
    if (mCheck) {
      const name = mCheck[1]!
      const { spec, errors } = parseDomain(join(DOMAINS, name, 'domain.yml'))
      if (!spec) return json(res, 400, { error: errors.join('; ') })
      const version = (() => { try { return String(JSON.parse(readFileSync(join(spec.dsh_source, 'package.json'), 'utf8')).version) } catch { return '0.0.0' } })()
      const report = await runChecks(spec, REGISTRY, PACKS, CACHE, { prevRoster: loadPrevRoster(CACHE, version), pluginRegistryPath: PLUGIN_REGISTRY, coreListPath: CORE_LIST })
      appendCheckHistory(DOMAINS, name, report) // 趋势点阵数据源（只追加记录，不改 check 语义）
      return json(res, 200, { data: report, equivalentCommand: `dshctl check ${name} --json` })
    }
    const mDiff = /^\/api\/diff\/([\w-]+)$/.exec(p)
    if (mDiff) {
      const name = mDiff[1]!
      const { spec } = parseDomain(join(DOMAINS, name, 'domain.yml'))
      if (!spec) return json(res, 400, { error: 'domain.yml 解析失败' })
      return json(res, 200, { data: diffDomain(spec, PACKS), equivalentCommand: `dshctl diff ${name} --json` })
    }

    // ── 清单读写（表单化：JSON spec）──
    if (p === '/api/domain' && req.method === 'POST') {
      // 新建领域：只写 domain.yml（不自动 apply、不自动登记 registry——安全门保持 CLI 侧）
      const body = JSON.parse(await readBody(req)) as { name?: string; spec?: unknown }
      const name = body.name ?? ''
      if (!DOMAIN_RE.test(name)) return json(res, 400, { error: `非法 domain 名 '${name}'（须匹配 ${DOMAIN_RE}）` })
      const file = join(DOMAINS, name, 'domain.yml')
      if (existsSync(file)) return json(res, 409, { error: `领域 '${name}' 已存在` })
      const spec = { schema: 1, domain: name, ...pruneSpec(body.spec) } as DomainSpec
      const r = validateAndWrite(file, spec)
      if (!r.ok) return json(res, 400, { error: `校验失败: ${r.errors.join('; ')}`, errors: r.errors })
      return json(res, 200, {
        ok: true,
        equivalentCommand: `dshctl check ${name} && dshctl apply ${name} --dry-run`,
        hint: `已创建 domains/${name}/domain.yml。下一步：check 通过后 dshctl apply ${name} --dry-run → --yes 造实例骨架。`,
      })
    }
    const mDom = /^\/api\/domain\/([\w-]+)$/.exec(p)
    if (mDom) {
      const name = mDom[1]!
      const file = join(DOMAINS, name, 'domain.yml')
      if (req.method === 'GET') {
        if (!existsSync(file)) return json(res, 404, { error: 'not found' })
        const { spec, errors } = parseDomain(file)
        return json(res, 200, {
          data: { content: readFileSync(file, 'utf8'), spec: spec ?? null, specErrors: errors },
          equivalentCommand: `cat domains/${name}/domain.yml`,
        })
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { spec?: unknown }
        const spec = { schema: 1, domain: name, ...pruneSpec(body.spec) } as DomainSpec
        const r = validateAndWrite(file, spec)
        if (!r.ok) return json(res, 400, { error: `校验失败: ${r.errors.join('; ')}`, errors: r.errors })
        return json(res, 200, { ok: true, equivalentCommand: `dshctl check ${name} --ci` })
      }
    }
    // ── 静态 dist ──
    if (existsSync(DIST)) {
      const f = p === '/' ? '/index.html' : p
      const fp = join(DIST, f.replace(/^\//, ''))
      if (existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': MIME[fp.slice(fp.lastIndexOf('.'))] ?? 'application/octet-stream' })
        return res.end(readFileSync(fp))
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(join(DIST, 'index.html')))
    }
    res.writeHead(404); res.end('gui not built — cd gui && pnpm build')
  } catch (e) {
    json(res, 500, { error: String(e).slice(0, 200) })
  }
}).listen(PORT, HOST, () => {
  console.log(`dshctl GUI: http://${HOST}:${PORT} （薄壳：操作可复现为等价 CLI 命令）`)
  console.log(GUI_KEY ? `鉴权：已启用（Bearer key；非回环绑定 fail-loud 强制）` : `鉴权：未启用（仅回环绑定可用；非回环绑定会拒绝启动）`)
})
