/**
 * smoke.ts — F4 冒烟：临时实例（api+100 端口顺延）+ overlay patch（整段替换 domain-api config 仅改 port——
 * 上游 config 是整体替换语义）+ api-smoke + 领域自检 + bench(可选) + 进程组兜底清理。
 * 同 DSH_HOME 并发安全（无 home 级单例锁）；ops.env 风格文件合入子进程 env。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadYamlText, dumpYaml } from './yml.ts'
import type { DomainSpec } from './domain.ts'

interface PatchEntry { id?: string; name?: string; config?: Record<string, unknown>; insert?: PatchEntry[] }

export interface SmokeReport {
  port: number
  healthOk: boolean
  apiSmokeExit: number | null
  benchExit?: number | null
  selfTests: Array<{ path: string; exit: number | null }>
  cleaned: boolean
  notes: string[]
}

/** 端口顺延探测：base 起找空闲端口，上限 +maxDelta（默认 10） */
export function pickPort(base: number, isFree: (p: number) => boolean, maxDelta = 10): number | null {
  for (let d = 0; d <= maxDelta; d++) if (isFree(base + d)) return base + d
  return null
}

export function portFree(port: number): boolean {
  try {
    const out = execSync('ss -ltn', { encoding: 'utf8', timeout: 5000 })
    return !out.split('\n').some((l) => new RegExp(`[:.]${port}\\s`).test(l) && l.includes('LISTEN'))
  } catch { return true /* ss 失败时不阻断，靠 health 探测兜底 */ }
}

/** 定位 profile patch 中的 domain-api 条目（id 或 name 启发式） */
export function findApiEntry(entries: PatchEntry[], pluginId?: string, pluginPath?: string): PatchEntry | undefined {
  for (const e of entries) {
    if (e.insert) {
      const hit = findApiEntry(e.insert, pluginId, pluginPath)
      if (hit) return hit
    }
    if (e.id && (e.id === pluginId || e.id === 'ops-api' || e.id === 'domain-api')) return e
    if (pluginPath && e.name === pluginPath) return e
  }
  return undefined
}

/**
 * 生成 smoke overlay：深拷贝 domain-api 完整 config，仅改 apiServer.port。
 * （config 整体替换语义下，只传 port 会清掉 preset/memory/admin 等全部配置——必须整段携带。）
 */
export function buildOverlay(profilePatchPath: string, smokePort: number, pluginId?: string, pluginPath?: string): { content: string; error?: string } {
  const entries = loadYamlText(readFileSync(profilePatchPath, 'utf8')) as PatchEntry[]
  const api = findApiEntry(entries, pluginId, pluginPath)
  if (!api?.config) return { content: '', error: `profile patch 中未找到 domain-api 条目（id=${pluginId ?? 'ops-api|domain-api'}）` }
  const config = JSON.parse(JSON.stringify(api.config)) as Record<string, unknown>
  const apiServer = (config.apiServer ?? {}) as Record<string, unknown>
  if (!apiServer.port) return { content: '', error: 'domain-api config 缺 apiServer.port' }
  apiServer.port = smokePort
  config.apiServer = apiServer
  return { content: dumpYaml([{ id: api.id!, config }]) }
}

/** 解析 EnvironmentFile 风格 env 文件（KEY=VAL 行；# 注释；值可带引号） */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

async function waitHealth(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<number | null> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } })
    c.stdout?.pipe(process.stdout)
    c.stderr?.pipe(process.stderr)
    c.on('exit', (code) => res(code))
    c.on('error', () => res(null))
  })
}

/** 停进程组：SIGTERM → 等 5s → SIGKILL */
export function killGroup(pid: number | undefined): void {
  if (!pid) return
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* */ } }
}

export async function runSmoke(spec: DomainSpec, opts: { cacheDir: string; selfTest?: boolean; bench?: boolean }): Promise<SmokeReport> {
  const notes: string[] = []
  const home = spec.dsh_home
  const domain = spec.domain
  const api = spec.api_server
  if (!api) throw new Error('清单缺 api_server 段，无法冒烟')
  const basePort = api.port
  const port = pickPort(basePort + 100, portFree, 10)
  if (port === null) throw new Error(`端口 ${basePort}+100~+110 全被占用`)
  notes.push(`smoke 端口 ${port}（声明 ${basePort} + offset，避开运行中实例）`)

  const patchPath = join(home, 'profiles', domain, 'cordis.patch.yml')
  const overlay = buildOverlay(patchPath, port, api.plugin_id, api.plugin_path)
  if (overlay.error) throw new Error(overlay.error)
  mkdirSync(opts.cacheDir, { recursive: true })
  const overlayPath = join(opts.cacheDir, `smoke-overlay-${domain}.yml`)
  writeFileSync(overlayPath, overlay.content)
  notes.push(`overlay: ${overlayPath}（整段替换 domain-api config，仅改 port）`)

  const envFile = parseEnvFile(join(home, 'ops.env'))
  const key = process.env[api.api_key_env] ?? envFile[api.api_key_env] ?? ''
  if (!key) notes.push(`env ${api.api_key_env} 未设置——api-smoke 不带鉴权（若实例强制 Bearer 将 401）`)

  const logPath = join(opts.cacheDir, `smoke-${domain}-${port}.log`)
  const logFd = openSync(logPath, 'w')
  let child: ChildProcess | undefined
  const report: SmokeReport = { port, healthOk: false, apiSmokeExit: null, selfTests: [], cleaned: false, notes }
  try {
    child = spawn('pnpm', ['dsh', '--profile', domain, '--patch', overlayPath], {
      cwd: spec.dsh_source,
      env: { ...process.env, DSH_HOME: home, ...envFile },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    const pid = child.pid
    notes.push(`spawn pid=${pid}（detached 进程组）；日志 ${logPath}`)
    // 父进程不等待——detached 子进程独立；立即解除 ref 防挂住
    child.unref()

    const base = `http://127.0.0.1:${port}`
    report.healthOk = await waitHealth(base, 30_000)
    if (report.healthOk) {
      const script = join(dirname(dirname(new URL(import.meta.url).pathname)), 'scripts', 'api-smoke.sh')
      report.apiSmokeExit = existsSync(script)
        ? await run('bash', [script, base, key], { cwd: spec.dsh_source })
        : null
      if (report.apiSmokeExit === null) notes.push(`api-smoke.sh 不存在: ${script}`)
      // 领域自检约定：plugin.path 同目录 self-test.ts
      if (opts.selfTest !== false) {
        for (const p of spec.plugins ?? []) {
          const st = join(dirname(p.path), 'self-test.ts')
          if (existsSync(st)) {
            const code = await run('node', ['--import', 'tsx/esm', st], { cwd: spec.dsh_source })
            report.selfTests.push({ path: st, exit: code })
          }
        }
      }
    } else {
      notes.push('health 30s 未就绪——跳过 api-smoke（日志见上）')
    }
    // --bench：领域基准（ops=bench-4q.sh <base> <model> <key>；真实 LLM 调用，耗时分钟级）
    if (opts.bench && report.healthOk) {
      const bench = join(dirname(dirname(new URL(import.meta.url).pathname)), 'scripts', 'bench-4q.sh')
      if (existsSync(bench)) {
        report.benchExit = await run('bash', [bench, `http://127.0.0.1:${port}`, spec.domain, key], { cwd: spec.dsh_source })
        notes.push(`bench-4q exit=${report.benchExit}（端口 ${port}）`)
      } else notes.push(`bench 脚本不存在: ${bench}`)
    }
  } finally {
    // 兜底清理：进程组 SIGTERM → 5s → SIGKILL（trap/finally 覆盖 Ctrl-C/异常）
    killGroup(child?.pid)
    const pid = child?.pid
    if (pid) {
      await new Promise((r) => setTimeout(r, 5000))
      try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
    try { closeSync(logFd) } catch { /* */ }
    report.cleaned = true
  }
  return report
}
