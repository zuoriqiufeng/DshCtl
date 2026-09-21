/**
 * index.ts — ops-api 插件：OpenAI 兼容 HTTP api-server（替代 Hermes api-server 的 /v1 面）
 *
 * 路由（挂在现有 dsh-host-webserver，exact 优先于 SPA fallback）：
 *   POST /v1/chat/completions  流式(SSE)/非流式，Bearer 鉴权（可选）
 *   GET  /v1/models            单模型清单
 *   GET  /health               存活探测
 *
 * 会话驱动：ctx.sessionController.create(agentPreset) → follow → prompt → 消费 StreamChunk。
 * 协议形状对齐 Hermes api-server（gateway/platforms/api_server.py）。
 *
 * 挂载（cordis.patch.yml）：
 *   - id: ops-api
 *     name: '/hdd/demo/public/dsh-info/code/ops-api/index.ts'
 *     config:
 *       apiKey: '<Bearer key，留空则不鉴权>'
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { extractMessageText, runTurn, type SessionDriver } from './bridge.ts'
import { createOpsMemory, memoryAls, type OpsMemoryService } from './memory.ts'
import { ensureSkillsDir, listSkills, readManagedState, setSkillEnabled, validateServer, writeManagedState } from './admin.ts'
import { ADMIN_HTML } from './admin-html.ts'
import { buildMemoryTools } from './tools-memory.ts'
import { parseResponsesRequest, buildResponse, buildResponsesFailedEvent } from './responses.ts'
import { createGatewaySupervisor, type GatewaySupervisor } from './supervisor.ts'
import {
  authorized,
  buildChunk,
  buildCompletion,
  buildFinalChunks,
  buildPromptText,
  completionId,
  errorBody,
  modelsBody,
  parseChatRequest,
} from './openai.ts'

export const name = 'ops-api'
export const inject = ['sessionController']

export interface Config {
  /** 总开关 */
  enabled?: boolean
  /** 会话使用的 agent preset */
  preset?: string
  /** Bearer 鉴权 key（空 = 不鉴权；生产建议配置） */
  apiKey?: string
  /** 单轮超时（秒），超时 → 504 + cancel */
  turnTimeoutSec?: number
  /** /v1/models 与响应回显的模型名 */
  modelId?: string
  /** 会话工作目录 */
  cwd?: string
  /** 对外 api-server 监听面（独立端口 + 强制 Bearer；与 GUI 面同进程共存） */
  apiServer?: {
    /** 总开关（true 时必须配置 apiKey，否则 fail-loud 拒绝启动） */
    enabled?: boolean
    /** 监听地址 */
    host?: string
    /** 监听端口 */
    port?: number
    /** Bearer key（OPS_API_KEY；enabled=true 且为空 → 抛错） */
    apiKey?: string
  }
  /** 管理面（/admin）：MCP 托管段 + 技能启停（独立 OPS_ADMIN_KEY） */
  admin?: {
    /** 总开关 */
    enabled?: boolean
    /** 管理面 Bearer key（与采集面 apiKey 分离） */
    adminKey?: string
    /** 待编辑的 profile cordis.patch.yml 路径（托管段所在文件） */
    patchPath?: string
    /** 技能目录（DSH_HOME 内拷贝，启停通过重命名子目录实现） */
    skillsDir?: string
  }
  /** 多轮会话（G1） */
  session?: {
    enabled?: boolean
    /** 会话续接 header 名（按序读取第一个非空） */
    headerNames?: string[]
    /** 单会话最大轮数（0=不限制，靠 compaction 控膨胀） */
    maxTurnsPerSession?: number
    /** 未知 session id 策略：reject=400 / create-new=新建 */
    unknownIdPolicy?: 'reject' | 'create-new'
  }
  /** 记忆分片（G3，对接 TencentDB MemoryCore Gateway） */
  memory?: {
    enabled?: boolean
    /** 记忆分片 header 名（按序读取第一个非空） */
    headerNames?: string[]
    /** Gateway 地址 */
    gatewayUrl?: string
    /** TDAI_GATEWAY_API_KEY（空 = 不带鉴权头） */
    gatewayApiKey?: string
    /** 挂载 3 个记忆检索 LLM 工具 */
    toolsEnabled?: boolean
    /** Gateway 托管启动（P4）：true 时 ops-api spawn + 健康轮询 + crash 诊断 */
    autoStart?: boolean
    /** Gateway 启动命令（空 → 默认 node --import tsx src/gateway/server.ts） */
    gatewayCmd?: string
    /** Gateway 命令工作目录（空 → MemoryCore 默认路径） */
    gatewayCwd?: string
    /** supervisor 日志目录（空 → ~/.dsh/logs/memory-tencentdb） */
    logDir?: string
  }
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  /** 对外平台标识（/health 等响应体）；领域无关，默认 dsh-domain-agent */
  platform: Schema.string().default('dsh-domain-agent'),
  /** 版本号（/health、/v1/capabilities 响应体）；默认 0.3.0 */
  version: Schema.string().default('0.3.0'),
  /** 会话使用的 agent preset；无默认（领域必填，未配置启动时 fail-loud） */
  preset: Schema.string().default(''),
  apiKey: Schema.string().default(''),
  apiServer: Schema.object({
    enabled: Schema.boolean().default(false),
    host: Schema.string().default('127.0.0.1'),
    /** 默认 8643（8642 常被历史实例占用，避免撞端口） */
    port: Schema.number().default(8643),
    apiKey: Schema.string().default(''),
  }).default({ enabled: false, host: '127.0.0.1', port: 8643, apiKey: '' }),
  admin: Schema.object({
    enabled: Schema.boolean().default(false),
    adminKey: Schema.string().default(''),
    patchPath: Schema.string().default(''),
    skillsDir: Schema.string().default(''),
    /** 健康检查依赖清单 [{name,url}]；空 = 不探测（替代硬编码 i2agent） */
    healthDeps: Schema.array(Schema.object({ name: Schema.string(), url: Schema.string() })).default([]),
  }).default({ enabled: false, adminKey: '', patchPath: '', skillsDir: '', healthDeps: [] }),
  turnTimeoutSec: Schema.number().default(120),
  /** /v1/models 与响应回显的模型名；无默认（领域必填，未配置启动时 fail-loud） */
  modelId: Schema.string().default(''),
  /** 会话工作目录；空 = $DSH_HOME */
  cwd: Schema.string().default(''),
  session: Schema.object({
    enabled: Schema.boolean().default(true),
    headerNames: Schema.array(String).default(['X-Ops-Session-Id', 'X-Hermes-Session-Id']),
    maxTurnsPerSession: Schema.number().default(0),
    /** 'reject'（默认，unknown id → 400）| 'create-new'（unknown id → 新建会话） */
    unknownIdPolicy: Schema.string().default('reject'),
  }).default({ enabled: true, headerNames: ['X-Ops-Session-Id', 'X-Hermes-Session-Id'], maxTurnsPerSession: 0, unknownIdPolicy: 'reject' }),
  memory: Schema.object({
    enabled: Schema.boolean().default(false),
    headerNames: Schema.array(String).default(['X-Ops-Memory-Key', 'X-Hermes-Session-Key']),
    gatewayUrl: Schema.string().default('http://127.0.0.1:8420'),
    gatewayApiKey: Schema.string().default(''),
    toolsEnabled: Schema.boolean().default(true),
    autoStart: Schema.boolean().default(false),
    gatewayCmd: Schema.string().default(''),
    gatewayCwd: Schema.string().default('/hdd/demo/TencentDB-Agent-Memory/MemoryCore'),
    logDir: Schema.string().default(''),
  }).default({ enabled: false, headerNames: ['X-Ops-Memory-Key', 'X-Hermes-Session-Key'], gatewayUrl: 'http://127.0.0.1:8420', gatewayApiKey: '', toolsEnabled: true, autoStart: false, gatewayCmd: '', gatewayCwd: '/hdd/demo/TencentDB-Agent-Memory/MemoryCore', logDir: '' }),
})

const MAX_BODY_BYTES = 2 * 1024 * 1024 // 2MB（Hermes 为 10MB；本面 messages 体量小）

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return null
  return JSON.parse(text)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

export function apply(ctx: Context, config: Config) {
  // C3 整改：preset/modelId 无领域默认——未配置 fail-loud（领域实例必填）。
  if (!config.preset) throw new Error('ops-api: config.preset is required (agent preset name)')
  if (!config.modelId) throw new Error('ops-api: config.modelId is required (model id for /v1/models)')
  const cfg = {
    enabled: config.enabled ?? true,
    platform: config.platform ?? 'dsh-domain-agent',
    version: config.version ?? '0.3.0',
    preset: config.preset,
    apiKey: config.apiKey ?? '',
    turnTimeoutSec: config.turnTimeoutSec ?? 120,
    modelId: config.modelId,
    // C3：cwd 无领域默认——空则用 $DSH_HOME（领域无关兜底）。
    cwd: config.cwd || process.env.DSH_HOME || process.cwd(),
    apiServer: {
      enabled: config.apiServer?.enabled ?? false,
      host: config.apiServer?.host ?? '127.0.0.1',
      port: config.apiServer?.port ?? 8643,
      apiKey: config.apiServer?.apiKey ?? '',
    },
    admin: {
      enabled: config.admin?.enabled ?? false,
      adminKey: config.admin?.adminKey ?? '',
      healthDeps: config.admin?.healthDeps ?? [],
      patchPath: config.admin?.patchPath ?? '',
      skillsDir: config.admin?.skillsDir ?? '',
    },
    session: {
      enabled: config.session?.enabled ?? true,
      headerNames: config.session?.headerNames ?? ['X-Ops-Session-Id', 'X-Hermes-Session-Id'],
      maxTurnsPerSession: config.session?.maxTurnsPerSession ?? 0,
      unknownIdPolicy: config.session?.unknownIdPolicy === 'create-new' ? 'create-new' : 'reject',
    },
    memory: {
      enabled: config.memory?.enabled ?? false,
      headerNames: config.memory?.headerNames ?? ['X-Ops-Memory-Key', 'X-Hermes-Session-Key'],
      gatewayUrl: config.memory?.gatewayUrl ?? 'http://127.0.0.1:8420',
      gatewayApiKey: config.memory?.gatewayApiKey ?? '',
      toolsEnabled: config.memory?.toolsEnabled ?? true,
      autoStart: config.memory?.autoStart ?? false,
      gatewayCmd: config.memory?.gatewayCmd ?? 'node --import tsx src/gateway/server.ts',
      gatewayCwd: config.memory?.gatewayCwd ?? '/hdd/demo/TencentDB-Agent-Memory/MemoryCore',
      logDir: config.memory?.logDir ?? '',
    },
  }
  const log = ctx.logger('ops-api')
  if (!cfg.enabled) {
    log.info('[ops-api] disabled')
    return
  }
  // 对外监听面 fail-loud：enabled 而无 key = 把无鉴权的 /v1 面暴露到网络，拒绝启动
  if (cfg.apiServer.enabled && !cfg.apiServer.apiKey) {
    throw new Error('[ops-api] apiServer.enabled=true requires a non-empty apiServer.apiKey (Bearer key); refusing to expose an unauthenticated listener')
  }

  // 未在 inject 中声明的属性访问会被上下文代理拒绝；ctx.get 对缺失服务返回 undefined

  // webServer 可选：存在时把内部路由表同步挂到 GUI 面；不存在（headless profile）时只走 apiServer
  const webServer = ctx.get('webServer') as unknown as { register(r: unknown): () => void } | undefined
  const controller = (ctx as unknown as { sessionController?: unknown }).sessionController
  if (!webServer) log.info('[ops-api] webServer absent (headless profile); api-server only')
  if (!controller) {
    log.warn('[ops-api] sessionController service missing; ops-api not mounted')
    return
  }

  // sessionController → SessionDriver 适配（方法均为对象方法，bind 到原实例）
  // resume 语义：sessionController 无独立 resume 方法，`prompt`/`follow` 内部隐式 resolve-or-resume；
  // 显式校验用 resolveAgent(sessionId) → {agent} 成功 / {error: RemoteError('session/not-found')}
  const sc = controller as SessionDriver & {
    cancel(req: { sessionId: string }): unknown
    resolveAgent?(sessionId: string): Promise<{ agent?: unknown; error?: { code?: string; message?: string } }>
  }
  const driver: SessionDriver = {
    create: (req) => sc.create(req),
    resume: sc.resolveAgent
      ? async (req) => {
          const r = await sc.resolveAgent!(req.sessionId)
          if (r.error) throw new Error(`session resume failed: ${r.error.code ?? 'unknown'} ${r.error.message ?? ''}`)
          return { sessionId: req.sessionId }
        }
      : undefined,
    follow: (req, signal) => sc.follow(req, signal),
    prompt: (req, signal) => sc.prompt(req, signal),
    cancel: (req) => { try { sc.cancel(req) } catch { /* ignore */ } },
  }

  // ── 会话续接 header 解析（G1）──
  const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
  function pickSessionHeader(req: IncomingMessage): string | '' {
    for (const name of cfg.session.headerNames) {
      const v = req.headers[name.toLowerCase()]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  function validSessionId(id: string): boolean {
    return SESSION_ID_RE.test(id)
  }

  // ── 记忆服务（G3，对接 TencentDB MemoryCore Gateway）──
  let memory: OpsMemoryService | null = null
  let supervisor: GatewaySupervisor | null = null
  const memoryKeysSeen = new Set<string>()   // dispose 时 flush session/end
  if (cfg.memory.enabled) {
    memory = createOpsMemory(
      { url: cfg.memory.gatewayUrl, apiKey: cfg.memory.gatewayApiKey || undefined },
      { warn: (m) => log.warn(m), info: (m) => log.info(m) },
    )
    // ── Gateway 托管启动（P4）──
    if (cfg.memory.autoStart) {
      supervisor = createGatewaySupervisor({
        baseUrl: cfg.memory.gatewayUrl,
        command: cfg.memory.gatewayCmd,
        cwd: cfg.memory.gatewayCwd,
        logDir: cfg.memory.logDir || undefined,
      }, { warn: (m) => log.warn(m), info: (m) => log.info(m), error: (m) => log.error(m) })
      // fire-and-forget：不阻塞 ops-api 挂载（Gateway 冷启动 ≤30s 不该卡路由注册）
      void supervisor.ensureRunning().then((ok) => {
        if (!ok) log.warn('[ops-api] gateway autoStart failed; memory stays degraded until respawn')
      })
      log.info(`[ops-api] gateway supervisor armed (cmd=${cfg.memory.gatewayCmd})`)
    }
    // 3 个 LLM 工具挂载（schema 1:1 对齐 Hermes get_tool_schemas）
    if (cfg.memory.toolsEnabled) {
      const tools = ctx.get('tools') as unknown as { register?(t: unknown): unknown } | undefined
      if (tools?.register) {
        for (const def of buildMemoryTools({ memory })) {
          tools.register(defineTool({
            name: def.name,
            description: def.description,
            parameters: def.parameters as never,
            output: {
              schema: { type: 'string' },
              render: (_args, value) => [{ type: 'text', text: value }],
            },
            execute: async (args: never) => def.execute((args ?? {}) as Record<string, unknown>),
          }))
        }
        log.info('[ops-api] memory tools registered: memory_search / conversation_search / read_scene')
      } else {
        log.warn('[ops-api] tools service missing; memory tools not mounted')
      }
    }
    log.info(`[ops-api] memory enabled: gateway=${cfg.memory.gatewayUrl} headers=${cfg.memory.headerNames.join(',')}`)
  }
  /** 记忆分片 header 校验（对齐 Hermes：长度 ≤255、禁 \r\n\0） */
  const memoryKeyOf = (req: IncomingMessage): string => {
    if (!cfg.memory.enabled || !memory) return ''
    for (const name of cfg.memory.headerNames) {
      const v = req.headers[name.toLowerCase()]
      if (typeof v === 'string' && v.trim() && /^[^\r\n\0]{1,255}$/.test(v.trim())) return v.trim()
    }
    return ''
  }

  const disposers: Array<() => void> = []

  // 统一路由表：同一 handler 集合按面挂载——webServer 存在时挂 GUI 面；
  // apiServer listener 按同一张表分发（去 web 后对外唯一入口）。
  type OpsRoute = { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }
  const routes: OpsRoute[] = []
  const mountRoute = (r: OpsRoute): (() => void) => {
    routes.push(r)
    return webServer ? webServer.register(r) : () => {}
  }

  // ── GET /health ──
  disposers.push(mountRoute({
    kind: 'exact',
    path: '/health',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      sendJson(res, 200, { status: 'ok', platform: cfg.platform, version: cfg.version, preset: cfg.preset })
    },
  }))

  // ── GET /v1/models ──
  disposers.push(mountRoute({
    kind: 'exact',
    path: '/v1/models',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!authorized(req.headers.authorization, cfg.apiKey)) {
        sendJson(res, 401, errorBody('Invalid gateway API key (API_SERVER_KEY)', 'gateway_auth_error'))
        return
      }
      sendJson(res, 200, modelsBody(cfg.modelId))
    },
  }))

  // ── POST /v1/chat/completions ──
  disposers.push(mountRoute({
    kind: 'exact',
    path: '/v1/chat/completions',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void handleChat(req, res).catch((e) => {
        log.warn(`[ops-api] chat handler error: ${String(e).slice(0, 200)}`)
        if (!res.headersSent) sendJson(res, 500, errorBody(`internal error: ${String(e).slice(0, 200)}`, 'api_error'))
        else res.end()
      })
    },
  }))

  // ── GET /v1/capabilities（G2 扩展端点，静态能力位图）──
  disposers.push(mountRoute({
    kind: 'exact',
    path: '/v1/capabilities',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!authorized(req.headers.authorization, cfg.apiKey)) {
        sendJson(res, 401, errorBody('Invalid gateway API key (API_SERVER_KEY)', 'gateway_auth_error'))
        return
      }
      sendJson(res, 200, capabilitiesBody())
    },
  }))

  // ── POST /v1/responses（G2 扩展端点，Responses API 子集）──
  disposers.push(mountRoute({
    kind: 'exact',
    path: '/v1/responses',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void handleResponses(req, res).catch((e) => {
        log.warn(`[ops-api] responses handler error: ${String(e).slice(0, 200)}`)
        if (!res.headersSent) sendJson(res, 500, errorBody(`internal error: ${String(e).slice(0, 200)}`, 'api_error'))
        else res.end()
      })
    },
  }))

  // ── /api/sessions（G2 扩展端点，prefix 路由 + 手动解析 id）──
  disposers.push(mountRoute({
    kind: 'prefix',
    path: '/api/sessions',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void handleSessions(req, res).catch((e) => {
        log.warn(`[ops-api] sessions handler error: ${String(e).slice(0, 200)}`)
        if (!res.headersSent) sendJson(res, 500, errorBody(`internal error: ${String(e).slice(0, 200)}`, 'api_error'))
        else res.end()
      })
    },
  }))

  // ── E2: 对外 api-server listener（独立端口，与 GUI 面同进程）──
  // 由于 webServer 是单例 Service，对外面不能再注册到它上；自建 listener 并用同一组 handler 分发。
  // 鉴权：apiServer 面先用 apiServer.apiKey 强校验（fail-loud 保证非空），通过后改写
  // authorization 头为 GUI 面的 cfg.apiKey，使共享 handler 内的 authorized() 检查通过。
  if (cfg.apiServer.enabled) {
    // 分发按统一路由表：exact 优先，其次最长 prefix。鉴权两段：
    // /health 免鉴权；/admin/* 走 adminKey（handler 内自行校验，此处不改写头）；
    // 其余业务路由先验 apiServer.apiKey 再改写为 GUI 面 cfg.apiKey，使共享 handler 的 authorized() 通过。
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/health') { sendJson(res, 200, { status: 'ok', platform: cfg.platform, version: cfg.version, preset: cfg.preset }); return }
      const isAdminPath = path === '/admin' || path.startsWith('/admin/')
      if (!isAdminPath) {
        if (!authorized(req.headers.authorization, cfg.apiServer.apiKey)) {
          sendJson(res, 401, errorBody('Invalid gateway API key (OPS_API_KEY)', 'gateway_auth_error'))
          return
        }
        req.headers.authorization = cfg.apiKey ? `Bearer ${cfg.apiKey}` : undefined
      }
      const exact = routes.find((r) => r.kind === 'exact' && r.path === path)
      let matched = exact
      if (matched === undefined) {
        for (const r of routes) {
          if (r.kind !== 'prefix') continue
          if (path !== r.path && !path.startsWith(`${r.path}/`)) continue
          if (matched === undefined || r.path.length > matched.path.length) matched = r
        }
      }
      if (matched === undefined) { sendJson(res, 404, errorBody(`no route for ${path}`, 'not_found')); return }
      try { matched.handler(req, res) } catch (e) {
        log.warn(`[ops-api] route ${path} handler error: ${String(e).slice(0, 200)}`)
        if (!res.headersSent) sendJson(res, 500, errorBody(`internal error: ${String(e).slice(0, 200)}`, 'api_error'))
        else res.end()
      }
    })
    const sockets = new Set<Socket>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(cfg.apiServer.port, cfg.apiServer.host, () => {
      log.info(`[ops-api] api-server listening on ${cfg.apiServer.host}:${cfg.apiServer.port}`)
    })
    disposers.push(() => {
      server.close()
      for (const socket of sockets) socket.destroy()
    })
  }

  // ── E3: 管理面 /admin（托管段 MCP 增删改 / 技能启停）──
  if (cfg.admin.enabled) {
    if (!cfg.admin.adminKey) {
      throw new Error('[ops-api] admin.enabled=true requires a non-empty admin.adminKey; refusing an unauthenticated management surface')
    }
    if (!cfg.admin.patchPath) {
      throw new Error('[ops-api] admin.enabled=true requires admin.patchPath (the profile cordis.patch.yml holding the managed section)')
    }
    ensureSkillsDir(cfg.admin.skillsDir)
    const adminAuthorized = (req: IncomingMessage) => authorized(req.headers.authorization, cfg.admin.adminKey)
    // GET /admin — 静态页面壳（免鉴权；数据靠 JS 带 Bearer 从 /admin/api 拉）
    disposers.push(mountRoute({
      kind: 'exact',
      path: '/admin',
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ADMIN_HTML)
      },
    }))
    // GET /admin/api/state — 聚合状态（托管段 + 技能 + 外部依赖健康）
    disposers.push(mountRoute({
      kind: 'exact',
      path: '/admin/api/state',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!adminAuthorized(req)) { sendJson(res, 401, errorBody('invalid admin key', 'admin_auth_error')); return }
        const state = readManagedState(cfg.admin.patchPath)
        const skills = listSkills(cfg.admin.skillsDir)
        void (async () => {
          const health: Record<string, string> = {}
          // C3：依赖清单入 config（admin.healthDeps）；gateway 恒探测（memory 配置已含 URL）；
          // 原硬编码 i2agent http://127.0.0.1:8090 移至 profile patch healthDeps 配置。
          const deps: Array<readonly [string, string]> = []
          if (cfg.memory.enabled) deps.push(['gateway', cfg.memory.gatewayUrl])
          for (const d of cfg.admin.healthDeps) deps.push([d.name, d.url])
          for (const [depName, url] of deps) {
            try {
              const ctrl = new AbortController()
              const t = setTimeout(() => ctrl.abort(), 2000)
              const resp = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: ctrl.signal })
              clearTimeout(t)
              health[depName] = resp.ok ? 'ok' : `http ${String(resp.status)}`
            } catch { health[depName] = 'unreachable' }
          }
          sendJson(res, 200, { revision: state.revision, mcp: state.servers, skills, health })
        })()
      },
    }))
    type AdminMcpEntry = import('./admin.ts').McpServerEntry
    // POST /admin/api/mcp — 新增（body.revision 可选，缺省读当前；并发下由写入时 revision 比对保护）
    disposers.push(mountRoute({
      kind: 'exact',
      path: '/admin/api/mcp',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!adminAuthorized(req)) { sendJson(res, 401, errorBody('invalid admin key', 'admin_auth_error')); return }
        void (async () => {
          try {
            const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
            const entry: AdminMcpEntry = {
              serverName: String(body.serverName ?? ''),
              transport: (body.transport ?? 'streamable-http') as AdminMcpEntry['transport'],
              url: body.url === undefined ? undefined : String(body.url),
              headers: body.headers as Record<string, string> | undefined,
              command: body.command === undefined ? undefined : String(body.command),
              args: Array.isArray(body.args) ? body.args.map(String) : undefined,
            }
            const errors = validateServer(entry)
            if (errors.length > 0) { sendJson(res, 400, errorBody(errors.join('; '), 'invalid_mcp')); return }
            const cur = readManagedState(cfg.admin.patchPath)
            if (cur.servers.some((s) => s.serverName === entry.serverName)) { sendJson(res, 409, errorBody('server already exists', 'conflict')); return }
            const expected = typeof body.revision === 'string' ? body.revision : cur.revision
            if (!writeManagedState(cfg.admin.patchPath, expected, [...cur.servers, entry])) { sendJson(res, 409, errorBody('revision conflict; re-read /admin/api/state', 'conflict')); return }
            sendJson(res, 200, readManagedState(cfg.admin.patchPath))
          } catch (e) { sendJson(res, 400, errorBody(String(e).slice(0, 120), 'invalid_request')) }
        })()
      },
    }))
    // PUT /admin/api/mcp/<name> — 替换定义（body.enabled===false 等价停用）；
    // DELETE /admin/api/mcp/<name> — 删除条目；?revision= 可选并发保护。
    // webserver 禁止重复 prefix 路由，因此 PUT/DELETE 合并为单一 handler 按 method 分发。
    disposers.push(mountRoute({
      kind: 'prefix',
      path: '/admin/api/mcp',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!adminAuthorized(req)) { sendJson(res, 401, errorBody('invalid admin key', 'admin_auth_error')); return }
        const method = (req.method ?? 'GET').toUpperCase()
        const url = new URL(req.url ?? '/', 'http://x')
        const name = decodeURIComponent(url.pathname.slice('/admin/api/mcp'.length).replace(/^\//, ''))
        if (method === 'DELETE') {
          const cur = readManagedState(cfg.admin.patchPath)
          const expected = url.searchParams.get('revision') ?? cur.revision
          if (!writeManagedState(cfg.admin.patchPath, expected, cur.servers.filter((s) => s.serverName !== name))) { sendJson(res, 409, errorBody('revision conflict', 'conflict')); return }
          sendJson(res, 200, readManagedState(cfg.admin.patchPath))
          return
        }
        if (method !== 'PUT') { sendJson(res, 405, errorBody('PUT or DELETE only', 'method_not_allowed')); return }
        void (async () => {
          try {
            const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
            const cur = readManagedState(cfg.admin.patchPath)
            const expected = typeof body.revision === 'string' ? body.revision : cur.revision
            const existing = cur.servers.find((s) => s.serverName === name)
            let next = cur.servers.filter((s) => s.serverName !== name)
            if (body.enabled !== false) {
              const entry: AdminMcpEntry = {
                serverName: name,
                transport: (body.transport ?? existing?.transport ?? 'streamable-http') as AdminMcpEntry['transport'],
                url: body.url === undefined ? existing?.url : String(body.url),
                headers: (body.headers as Record<string, string> | undefined) ?? existing?.headers,
                command: body.command === undefined ? existing?.command : String(body.command),
                args: Array.isArray(body.args) ? body.args.map(String) : existing?.args,
              }
              const errors = validateServer(entry)
              if (errors.length > 0) { sendJson(res, 400, errorBody(errors.join('; '), 'invalid_mcp')); return }
              next = [...next, entry]
            }
            if (!writeManagedState(cfg.admin.patchPath, expected, next)) { sendJson(res, 409, errorBody('revision conflict; re-read /admin/api/state', 'conflict')); return }
            sendJson(res, 200, readManagedState(cfg.admin.patchPath))
          } catch (e) { sendJson(res, 400, errorBody(String(e).slice(0, 120), 'invalid_request')) }
        })()
      },
    }))
    // POST /admin/api/skills/<name>/enable|disable — 技能启停（目录重命名，新会话生效）
    disposers.push(mountRoute({
      kind: 'prefix',
      path: '/admin/api/skills',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!adminAuthorized(req)) { sendJson(res, 401, errorBody('invalid admin key', 'admin_auth_error')); return }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, errorBody('POST only', 'method_not_allowed')); return }
        const parts = new URL(req.url ?? '/', 'http://x').pathname.slice('/admin/api/skills'.length).replace(/^\//, '').split('/')
        const skillName = decodeURIComponent(parts[0] ?? '')
        const action = parts[1] ?? ''
        if (action !== 'enable' && action !== 'disable') { sendJson(res, 400, errorBody('action must be enable or disable', 'invalid_action')); return }
        if (!setSkillEnabled(cfg.admin.skillsDir, skillName, action === 'enable')) { sendJson(res, 409, errorBody('skill not found or already in target state', 'conflict')); return }
        sendJson(res, 200, { skill: skillName, enabled: action === 'enable' })
      },
    }))
    log.info('[ops-api] admin surface mounted at /admin')
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req.headers.authorization, cfg.apiKey)) {
      sendJson(res, 401, errorBody('Invalid gateway API key (API_SERVER_KEY)', 'gateway_auth_error'))
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, errorBody(`bad request: ${String(e).slice(0, 120)}`, 'invalid_request_error'))
      return
    }
    const parsed = parseChatRequest(body)
    if (!parsed.ok) {
      sendJson(res, 400, errorBody(parsed.error, 'invalid_request_error'))
      return
    }

    const id = completionId()
    const promptText = buildPromptText(parsed.messages)

    // ── 多轮会话续接（G1）──
    let sessionId: string | undefined
    let renewed = false
    const sessionHeader = cfg.session.enabled ? pickSessionHeader(req) : ''
    if (sessionHeader) {
      if (!validSessionId(sessionHeader)) {
        sendJson(res, 400, errorBody('invalid session id header', 'invalid_request_error'))
        return
      }
      if (!driver.resume) {
        sendJson(res, 501, errorBody('session resume not supported by sessionController', 'not_implemented'))
        return
      }
      try {
        const r = await driver.resume({ sessionId: sessionHeader })
        sessionId = r.sessionId
      } catch (e) {
        if (cfg.session.unknownIdPolicy === 'create-new') {
          sessionId = undefined // 落到 create 分支
        } else {
          sendJson(res, 400, errorBody(`unknown session id: ${sessionHeader.slice(0, 64)}`, 'invalid_request_error'))
          return
        }
      }
      // maxTurnsPerSession 兜底：inspect 事件数超限 → 换新会话（响应头 X-Ops-Session-Renewed: 1）
      if (sessionId && cfg.session.maxTurnsPerSession > 0) {
        try {
          const insp = await (sc as unknown as { inspect?(id: string): Promise<{ events?: unknown[] }> }).inspect?.(sessionId)
          const count = insp?.events?.length ?? 0
          if (count > cfg.session.maxTurnsPerSession * 2) { // 每轮约 2 事件（user + assistant）
            sessionId = undefined
            renewed = true
          }
        } catch { /* 历史查询失败不阻断续接 */ }
      }
    }

    // 客户端断开 → 中止
    const clientCtl = new AbortController()
    req.on('close', () => { if (!res.writableEnded) clientCtl.abort() })

    // ── 记忆（G3）：prompt 前同步 recall 注入前缀 + ALS 传 key 给工具 + turn 后异步 capture ──
    const memoryKey = memoryKeyOf(req)
    const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === 'user')
    const lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''
    let effectivePrompt = promptText
    if (memory && memoryKey) {
      memoryKeysSeen.add(memoryKey)
      const recalled = await memory.recall(memoryKey, lastUserText || promptText)
      if (recalled.context) {
        // Gateway 已渲染好 <memory-context> 段，原样前缀注入（对齐 Hermes prefetch 语义）
        effectivePrompt = `${recalled.context}\n\n${promptText}`
      } else if (supervisor && !supervisor.hasGivenUp()) {
        // 惰性 respawn（P4）：recall 失败 → 后台 ensureRunning（不阻塞本轮响应）
        void supervisor.ensureRunning()
      }
    }
    /** turn 完成后异步 capture（不阻塞响应）+ ALS scope 工具 */
    const afterTurn = (sessionIdOut: string | undefined, answer: string): void => {
      if (memory && memoryKey && answer) {
        memory.capture({ sessionKey: memoryKey, sessionId: sessionIdOut, userContent: lastUserText, assistantContent: answer })
      }
    }
    /** runTurn 包一层 ALS：工具执行链读 memoryKey */
    const runWithMemory = <T>(fn: () => Promise<T>): Promise<T> => {
      if (memory && memoryKey) return memoryAls.run({ memoryKey }, fn)
      return fn()
    }

    if (!parsed.stream) {
      const result = await runWithMemory(() => runTurn(driver, effectivePrompt, {
        preset: cfg.preset, cwd: cfg.cwd, sessionId, timeoutSec: cfg.turnTimeoutSec, signal: clientCtl.signal,
      })).catch((e) => {
        if (e && e.name === 'TurnTimeoutError') {
          res.setHeader('X-Ops-Session-Id', sessionId ?? '')
          sendJson(res, 504, errorBody(`turn timeout after ${cfg.turnTimeoutSec}s`, 'timeout_error'))
          return null
        }
        throw e
      })
      if (!result) return
      afterTurn(result.sessionId, result.content)
      res.setHeader('X-Ops-Session-Id', result.sessionId)
      if (renewed) res.setHeader('X-Ops-Session-Renewed', '1')
      sendJson(res, 200, buildCompletion({ id, model: cfg.modelId, content: result.content, usage: result.usage, finishReason: result.finishReason }))
      return
    }

    // ── SSE 流式 ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(sessionId ? { 'X-Ops-Session-Id': sessionId } : {}),
      ...(renewed ? { 'X-Ops-Session-Renewed': '1' } : {}),
    })
    const write = (payload: unknown): void => { res.write(`data: ${JSON.stringify(payload)}\n\n`) }
    let resultSessionId = sessionId
    try {
      const result = await runWithMemory(() => runTurn(driver, effectivePrompt, {
        preset: cfg.preset, cwd: cfg.cwd, sessionId, timeoutSec: cfg.turnTimeoutSec, signal: clientCtl.signal,
        onDelta: (text) => write(buildChunk(id, cfg.modelId, { content: text })),
      }))
      resultSessionId = result.sessionId
      afterTurn(result.sessionId, result.content)
      for (const chunk of buildFinalChunks(id, cfg.modelId, result.usage)) write(chunk)
      res.write('data: [DONE]\n\n')
    } catch (e) {
      const isTimeout = e && (e as Error).name === 'TurnTimeoutError'
      write(errorBody(isTimeout ? `turn timeout after ${cfg.turnTimeoutSec}s` : String(e).slice(0, 200), isTimeout ? 'timeout_error' : 'api_error'))
    } finally {
      res.end()
    }
    log.info(`[ops-api] sse turn done session=${resultSessionId ?? 'new'}`)
  }

  // ── GET /v1/capabilities：动态能力面（C3 整改：原为静态位图且 tools 恒 3 漏报 BKN 12 工具）──
  // C3：endpoints 按实际挂载路由生成（routes 记账）；admin 面单列。
  function mountedEndpoints(): string[] {
    const eps = new Set<string>(['/health']) // 免鉴权，恒在
    for (const r of routes) eps.add(r.path)
    if (cfg.admin.enabled) eps.add('/admin')
    return [...eps].sort()
  }

  function capabilitiesBody(): Record<string, unknown> {
    // tools 计数从 tools.schemas() 实际注册面读取（含 BKN/skill-manage/记忆扩展，领域无关）。
    // schemas 抛错（无 tools 服务）时降级 0——能力面非关键路径（H-15）。
    let toolCount = 0
    try { toolCount = ctx.get('tools')?.schemas().length ?? 0 } catch { toolCount = 0 }
    return {
      platform: cfg.platform,
      version: cfg.version,
      models: [{ id: cfg.modelId }],
      features: {
        'chat.completions': true,
        responses: true,
        multi_turn_session: cfg.session.enabled && !!driver.resume,
        memory: cfg.memory.enabled,
        streaming: true,
      },
      tools: {
        count: toolCount,
        memory_extension: cfg.memory.enabled && cfg.memory.toolsEnabled,
      },
      limits: {
        max_session_turns: cfg.session.maxTurnsPerSession > 0 ? cfg.session.maxTurnsPerSession : null,
        turn_timeout_sec: cfg.turnTimeoutSec,
      },
      // endpoints 按实际挂载路由生成（mountRoute 记账 + admin/apiServer 面）
      endpoints: mountedEndpoints(),
    }
  }

  // ── POST /v1/responses：Responses API 子集（G2）──
  async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req.headers.authorization, cfg.apiKey)) {
      sendJson(res, 401, errorBody('Invalid gateway API key (API_SERVER_KEY)', 'gateway_auth_error'))
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, errorBody(`bad request: ${String(e).slice(0, 120)}`, 'invalid_request_error'))
      return
    }
    const parsed = parseResponsesRequest(body)
    if (!parsed.ok) {
      sendJson(res, parsed.status ?? 400, errorBody(parsed.error, 'invalid_request_error'))
      return
    }

    const id = `resp_${completionId()}`
    const model = parsed.model ?? cfg.modelId
    const promptText = buildPromptText(parsed.messages)

    // 复用 handleChat 的 session 续接逻辑（提取为 prepareSession）
    const prep = await prepareSession(req, res)
    if (prep === null) return // 已写响应（错误）
    const { sessionId } = prep

    const clientCtl = new AbortController()
    req.on('close', () => { if (!res.writableEnded) clientCtl.abort() })

    // memory hook（同 handleChat）
    const memoryKey = memoryKeyOf(req)
    const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === 'user')
    const lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''
    let effectivePrompt = promptText
    if (memory && memoryKey) {
      memoryKeysSeen.add(memoryKey)
      const recalled = await memory.recall(memoryKey, lastUserText || promptText)
      if (recalled.context) effectivePrompt = `${recalled.context}\n\n${promptText}`
      else if (supervisor && !supervisor.hasGivenUp()) void supervisor.ensureRunning()
    }

    // ── SSE 流式分支（P5a）──
    if (parsed.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(sessionId ? { 'X-Ops-Session-Id': sessionId } : {}),
      })
      const write = (payload: unknown): void => { res.write(`data: ${JSON.stringify(payload)}\n\n`) }
      write({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', model } })
      try {
        const result = await (memory && memoryKey
          ? memoryAls.run({ memoryKey }, () => runTurn(driver, effectivePrompt, { preset: cfg.preset, cwd: cfg.cwd, sessionId, timeoutSec: cfg.turnTimeoutSec, signal: clientCtl.signal, onDelta: (t) => write({ type: 'response.output_text.delta', item_id: id, delta: t }) }))
          : runTurn(driver, effectivePrompt, { preset: cfg.preset, cwd: cfg.cwd, sessionId, timeoutSec: cfg.turnTimeoutSec, signal: clientCtl.signal, onDelta: (t) => write({ type: 'response.output_text.delta', item_id: id, delta: t }) })
        )
        if (memory && memoryKey && result.content) {
          memory.capture({ sessionKey: memoryKey, sessionId: result.sessionId, userContent: lastUserText, assistantContent: result.content })
        }
        write({
          type: 'response.completed',
          response: {
            id, object: 'response', status: 'completed', model,
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: result.content }] }],
            usage: { prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens, total_tokens: result.usage.total_tokens },
          },
        })
        res.write('data: [DONE]\n\n')
        log.info(`[ops-api] responses(stream) turn done session=${result.sessionId}`)
      } catch (e) {
        const isTimeout = e && (e as Error).name === 'TurnTimeoutError'
        write(buildResponsesFailedEvent(id, isTimeout ? `turn timeout after ${cfg.turnTimeoutSec}s` : String(e).slice(0, 200)))
      } finally {
        res.end()
      }
      return
    }

    const result = await (memory && memoryKey
      ? memoryAls.run({ memoryKey }, () => runTurn(driver, effectivePrompt, { preset: cfg.preset, cwd: cfg.cwd, sessionId, timeoutSec: cfg.turnTimeoutSec, signal: clientCtl.signal }))
      : runTurn(driver, effectivePrompt, { preset: cfg.preset, cwd: cfg.cwd, sessionId, timeoutSec: cfg.turnTimeoutSec, signal: clientCtl.signal })
    ).catch((e) => {
      if (e && e.name === 'TurnTimeoutError') {
        res.setHeader('X-Ops-Session-Id', sessionId ?? '')
        sendJson(res, 504, errorBody(`turn timeout after ${cfg.turnTimeoutSec}s`, 'timeout_error'))
        return null
      }
      throw e
    })
    if (!result) return

    if (memory && memoryKey && result.content) {
      memory.capture({ sessionKey: memoryKey, sessionId: result.sessionId, userContent: lastUserText, assistantContent: result.content })
    }
    res.setHeader('X-Ops-Session-Id', result.sessionId)
    sendJson(res, 200, buildResponse({ id, model, text: result.content, usage: result.usage }))
    log.info(`[ops-api] responses turn done session=${result.sessionId}`)
  }

  // ── session 续接公共段（供 handleChat / handleResponses 复用）──
  /** 返回 { sessionId } 或 null（已写错误响应）。sessionId undefined = 新建。 */
  async function prepareSession(req: IncomingMessage, res: ServerResponse): Promise<{ sessionId?: string } | null> {
    if (!cfg.session.enabled) return {}
    const sessionHeader = pickSessionHeader(req)
    if (!sessionHeader) return {}
    if (!validSessionId(sessionHeader)) {
      sendJson(res, 400, errorBody('invalid session id header', 'invalid_request_error'))
      return null
    }
    if (!driver.resume) {
      sendJson(res, 501, errorBody('session resume not supported by sessionController', 'not_implemented'))
      return null
    }
    let sessionId: string | undefined
    try {
      const r = await driver.resume({ sessionId: sessionHeader })
      sessionId = r.sessionId
    } catch {
      if (cfg.session.unknownIdPolicy === 'create-new') sessionId = undefined
      else {
        sendJson(res, 400, errorBody(`unknown session id: ${sessionHeader.slice(0, 64)}`, 'invalid_request_error'))
        return null
      }
    }
    // maxTurnsPerSession 兜底
    if (sessionId && cfg.session.maxTurnsPerSession > 0) {
      try {
        const insp = await (sc as unknown as { inspect?(id: string): Promise<{ events?: unknown[] }> }).inspect?.(sessionId)
        if ((insp?.events?.length ?? 0) > cfg.session.maxTurnsPerSession * 2) sessionId = undefined
      } catch { /* ignore */ }
    }
    return { sessionId }
  }

  // ── /api/sessions（G2）：prefix 路由，手动解析 id ──
  async function handleSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req.headers.authorization, cfg.apiKey)) {
      sendJson(res, 401, errorBody('Invalid gateway API key (API_SERVER_KEY)', 'gateway_auth_error'))
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    // 解析 /api/sessions/{id}?... → { id, query }
    const url = new URL(req.url ?? '/api/sessions', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean) // ['api','sessions', id?]
    const id = segments.length >= 3 ? decodeURIComponent(segments[2]) : undefined

    if (method === 'DELETE') {
      // sessionController 无 delete/archive 远程方法（事实核实），诚实返回 405
      sendJson(res, 405, errorBody('session deletion not supported: sessionController exposes no delete/archive command', 'not_implemented'))
      return
    }
    if (method !== 'GET') {
      sendJson(res, 405, errorBody(`method ${method} not allowed`, 'invalid_request_error'))
      return
    }

    if (!id) {
      // GET /api/sessions — 列表
      const listFn = (sc as unknown as { list?(req: unknown, signal: AbortSignal): Promise<{ items: Array<{ sessionId: string; updatedAt: number; running: boolean; cwd?: string }> }> }).list
      if (!listFn) {
        sendJson(res, 501, errorBody('session list not supported by sessionController', 'not_implemented'))
        return
      }
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 5000)
      try {
        const { items } = await listFn.call(sc, {}, ctl.signal)
        sendJson(res, 200, {
          sessions: items.map((s) => ({ id: s.sessionId, updated_at: s.updatedAt, running: s.running, ...(s.cwd ? { cwd: s.cwd } : {}) })),
          count: items.length,
        })
      } finally { clearTimeout(timer) }
      return
    }

    // GET /api/sessions/{id} — 详情（历史精简）
    const inspectFn = (sc as unknown as { inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: unknown; events?: Array<{ type?: string; data?: unknown }> }> }).inspect
    if (!inspectFn) {
      sendJson(res, 501, errorBody('session inspect not supported', 'not_implemented'))
      return
    }
    let inspection: { meta?: unknown; events?: Array<{ type?: string; data?: unknown }> }
    try {
      inspection = await inspectFn.call(sc, id)
    } catch (e) {
      sendJson(res, 404, errorBody(`session not found: ${id.slice(0, 64)}`, 'invalid_request_error'))
      return
    }
    const allEvents = inspection.events ?? []
    // 过滤 user/assistant 消息事件，精简为 {role, content}
    const messages: Array<{ role: string; content: string }> = []
    for (const ev of allEvents) {
      if (ev.type === 'user/message') {
        const text = extractMessageText(ev.data)
        if (text) messages.push({ role: 'user', content: text })
      } else if (ev.type === 'assistant/message') {
        const text = extractMessageText(ev.data)
        if (text) messages.push({ role: 'assistant', content: text })
      }
    }
    // 本地切片（limit/offset，默认 50）
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
    const page = messages.slice(offset, offset + limit)
    sendJson(res, 200, {
      id,
      total: messages.length,
      offset,
      limit,
      messages: page,
    })
  }

  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
    // 记忆 flush：进程退出前对本进程见过的分片发 session/end（有界等待）
    if (memory && memoryKeysSeen.size > 0) {
      const keys = [...memoryKeysSeen]
      void Promise.race([
        Promise.allSettled(keys.map((k) => memory!.sessionEnd(k))),
        new Promise((r) => setTimeout(r, 2000)),
      ]).catch(() => { /* ignore */ })
    }
    // Gateway 托管子进程（P4）：停掉我们 spawn 的 Gateway（外部启动的不受影响）
    if (supervisor) {
      void Promise.race([
        supervisor.shutdown(),
        new Promise((r) => setTimeout(r, 15_000)),
      ]).catch(() => { /* ignore */ })
    }
  })

  log.info(`[ops-api] mounted: /v1/chat/completions /v1/responses /v1/capabilities /api/sessions (preset=${cfg.preset}, auth=${cfg.apiKey ? 'bearer' : 'off'}, timeout=${cfg.turnTimeoutSec}s, session=${cfg.session.enabled ? 'multi-turn' : 'stateless'}, resume=${driver.resume ? 'yes' : 'no'}, memory=${cfg.memory.enabled ? `on(${cfg.memory.gatewayUrl})` : 'off'})`)
}
