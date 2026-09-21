/**
 * supervisor.ts — MemoryCore Gateway 托管启动（G3，gap-exec-plan P4）
 *
 * 行为 1:1 对标 Hermes hermes-plugin/memory/memory_tencentdb/supervisor.py：
 *   - ensure_running：health 探测已运行则复用；否则 spawn + 轮询 /health ≤30s
 *   - spawn：独立进程组（detached:true）+ stdout/stderr 重定向日志文件（不用 PIPE——
 *     防 64KB 管道缓冲填满导致子进程 write 阻塞死锁）
 *   - 启动失败/早期退出：转储 stderr 日志尾部 2048 字节诊断
 *   - shutdown：killpg(SIGTERM) → wait 10s → killpg(SIGKILL) → wait 5s（杀整个进程组，
 *     防 pnpm→tsx→node 层级孤儿）
 *   - crash 策略：连续 spawn 失败 ≥3 → giveUp 常开（不再尝试，error 日志；需重启宿主）
 *
 * 与 Hermes 的差异（有意为之）：
 *   - 不注入 TDAI_GATEWAY_API_KEY 到子进程 env（鉴权是操作员在 Gateway 侧的职责，同 Hermes）
 *   - respawn 由请求驱动（recall/capture 失败后下一请求触发 ensureRunning），不设主动轮询定时器
 *   - 日志目录默认 ~/.dsh/logs/memory-tencentdb（DSH 风格，可 env/logDir 覆盖）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface SupervisorOptions {
  /** Gateway 监听地址（health 探测用） */
  baseUrl: string
  /** 启动命令（sh 风格字符串，按空白拆分；空 = 不可启动，仅复用外部实例） */
  command?: string
  /** 命令工作目录 */
  cwd?: string
  /** 日志目录（空 → ~/.dsh/logs/memory-tencentdb） */
  logDir?: string
  /** 子进程 env 附加（不包含 API key——鉴权由 Gateway 侧配置） */
  env?: Record<string, string>
  /** 健康等待上限（毫秒），默认 30000 */
  healthTimeoutMs?: number
  /** 连续失败放弃阈值，默认 3 */
  giveUpThreshold?: number
}

export interface GatewaySupervisor {
  /** 确保 Gateway 可用；已运行复用，未运行 spawn。返回是否可用。fire-and-forget 友好。 */
  ensureRunning(): Promise<boolean>
  /** 停掉托管的子进程（仅我们 spawn 的；外部启动的不动）。 */
  shutdown(): Promise<void>
  /** 是否由本 supervisor 托管（spawn 过且句柄仍在） */
  isManaged(): boolean
  /** 托管子进程 pid（无则 undefined） */
  pid(): number | undefined
  /** 是否已放弃（连续失败达阈值） */
  hasGivenUp(): boolean
}

export interface SupervisorLogger {
  warn(msg: string): void
  info(msg: string): void
  error(msg: string): void
}

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
const DEFAULT_GIVE_UP = 3
const HEALTH_POLL_INTERVAL_MS = 500
const STDERR_TAIL_BYTES = 2048

export function createGatewaySupervisor(opts: SupervisorOptions, log: SupervisorLogger): GatewaySupervisor {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const giveUpThreshold = opts.giveUpThreshold ?? DEFAULT_GIVE_UP

  let child: ChildProcess | null = null
  let stderrLogPath = ''
  let consecutiveFailures = 0
  let giveUp = false
  let starting = false // single-flight：并发 ensureRunning 只 spawn 一次

  const logDir = opts.logDir || join(homedir(), '.dsh', 'logs', 'memory-tencentdb')

  const probeHealth = async (): Promise<boolean> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 2000)
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: ctl.signal })
      if (!res.ok) return false
      const data = await res.json() as { status?: string }
      return data.status === 'ok' || data.status === 'degraded'
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const tailStderr = (): string => {
    if (!stderrLogPath || !existsSync(stderrLogPath)) return ''
    try {
      const buf = readFileSync(stderrLogPath)
      return buf.subarray(Math.max(0, buf.length - STDERR_TAIL_BYTES)).toString('utf8')
    } catch {
      return ''
    }
  }

  const isProcessAlive = (): boolean => child !== null && child.exitCode === null && child.signalCode === null

  const reapDead = (): void => {
    if (child && !isProcessAlive()) {
      log.warn(`[ops-supervisor] previous gateway child exited (code=${child.exitCode}); reaping before respawn`)
      child = null
    }
  }

  const doSpawn = async (): Promise<boolean> => {
    const cmd = (opts.command ?? '').trim()
    if (!cmd) {
      log.warn('[ops-supervisor] no gateway command configured; memory gateway must be started externally (form A)')
      return false
    }
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      /* 日志目录创建失败不阻断（下面 spawn 会回退） */
    }
    // 命令拆分（简单空白拆分；命令含空格路径时操作员应使用无空格路径或 wrapper 脚本）
    const parts = cmd.split(/\s+/).filter(Boolean)
    const [bin, ...args] = parts

    try {
      const outFd = safeOpen(join(logDir, 'gateway.stdout.log'))
      const errFd = safeOpen(join(logDir, 'gateway.stderr.log'))
      stderrLogPath = join(logDir, 'gateway.stderr.log')

      const proc = spawn(bin, args, {
        cwd: opts.cwd || undefined,
        env: { ...process.env, TDAI_GATEWAY_HOST: parseHost(baseUrl), TDAI_GATEWAY_PORT: parsePort(baseUrl), ...opts.env },
        detached: true, // 独立进程组：shutdown 可 killpg 清全组（pnpm→tsx→node）
        stdio: ['ignore', outFd, errFd],
      })
      child = proc
      proc.unref() // 不阻止宿主退出；dispose 时显式 shutdown

      // 轮询 health ≤ healthTimeoutMs
      const start = Date.now()
      while (Date.now() - start < healthTimeoutMs) {
        if (!isProcessAlive()) {
          const tail = tailStderr().slice(0, 500)
          log.error(`[ops-supervisor] gateway exited code=${proc.exitCode} during startup; stderr tail: ${tail}`)
          child = null
          return false
        }
        if (await probeHealth()) {
          log.info(`[ops-supervisor] gateway ready at ${baseUrl} (took ${((Date.now() - start) / 1000).toFixed(1)}s, pid=${proc.pid})`)
          return true
        }
        await sleep(HEALTH_POLL_INTERVAL_MS)
      }
      log.error(`[ops-supervisor] gateway did not become healthy within ${healthTimeoutMs}ms`)
      return false
    } catch (e) {
      log.error(`[ops-supervisor] failed to spawn gateway: ${String(e).slice(0, 200)}`)
      return false
    }
  }

  const ensureRunning = async (): Promise<boolean> => {
    if (giveUp) return false
    // 快路径：已健康（外部启动或已托管）→ 复用
    if (await probeHealth()) {
      consecutiveFailures = 0
      return true
    }
    // 我们托管的进程死了 → 先 reap
    reapDead()
    if (starting) {
      // 另一个并发调用正在 spawn：等它完成（轮询 health ≤ healthTimeoutMs）
      const start = Date.now()
      while (Date.now() - start < healthTimeoutMs) {
        if (await probeHealth()) return true
        await sleep(HEALTH_POLL_INTERVAL_MS)
      }
      return false
    }
    starting = true
    try {
      const ok = await doSpawn()
      if (ok) {
        consecutiveFailures = 0
        return true
      }
      consecutiveFailures++
      if (consecutiveFailures >= giveUpThreshold) {
        giveUp = true
        log.error(`[ops-supervisor] giving up after ${consecutiveFailures} consecutive failures; memory stays degraded until host restart`)
      }
      return false
    } finally {
      starting = false
    }
  }

  const shutdown = async (): Promise<void> => {
    const proc = child
    if (!proc || !isProcessAlive()) {
      child = null
      return
    }
    log.info(`[ops-supervisor] shutting down gateway pid=${proc.pid}`)
    try {
      // 杀整个进程组（负 pid；detached:true 使子进程成为组 leader）
      process.kill(-proc.pid!, 'SIGTERM')
    } catch {
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }
    // 等待 ≤10s
    const exited = await waitForExit(proc, 10_000)
    if (!exited) {
      log.warn('[ops-supervisor] gateway did not exit in 10s; sending SIGKILL')
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
      }
      await waitForExit(proc, 5_000)
    }
    child = null
  }

  return {
    ensureRunning,
    shutdown,
    isManaged: () => child !== null,
    pid: () => child?.pid,
    hasGivenUp: () => giveUp,
  }
}

// ── helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeOpen(path: string): number {
  try {
    return openSync(path, 'a')
  } catch {
    // 回退 DEVNULL 等价（fd 用 /dev/null）
    return openSync('/dev/null', 'a')
  }
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(proc)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

function parseHost(baseUrl: string): string {
  try { return new URL(baseUrl).hostname } catch { return '127.0.0.1' }
}

function parsePort(baseUrl: string): string {
  try { return new URL(baseUrl).port || '8420' } catch { return '8420' }
}
