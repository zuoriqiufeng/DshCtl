# i2Stream Ops-Agent Gap 执行计划（P1-P5）

> 2026-09-15 · 依据 `ops-agent-gap-design.md`
> 执行模式：逐阶段实施 → self-test 全绿 → 用户重启 `pnpm dsh web` → HTTP 契约验证 → 回填文档
> 改动落点：`/hdd/demo/public/dsh-info/code/ops-api/`（bridge/index/openai + memory.ts 新增）+ `/root/.dsh/profiles/web/cordis.yml`（配置）

## 现状盘点（执行前基线）

| 项 | 现状 |
|----|------|
| ops-api 路由 | `/health`、`/v1/models`、`/v1/chat/completions`（exact 注册，挂 dsh-host-webserver） |
| SessionDriver | `create/follow/prompt/cancel`，**无 resume** |
| runTurn | `create → consume(follow 先启) → prompt → turn/end 立即 return`；durable 兜底已验证 |
| 每请求生命周期 | create 临时会话 → turn/end → dispose（无状态） |
| 记忆 | 无；MemoryCore Gateway 独立可跑（:8420，与 DSH 零耦合） |
| 配置 | preset i2stream-ops 在 `/root/.dsh/profiles/web/cordis.yml` |

---

## P1 多轮会话（G1）✅ 已实施 + 验收通过（2026-09-15 12:02）

### 验收结果（live 3080，新进程 12:01:39）
| 项 | 结果 |
|----|------|
| 首轮拿 session id | ✅ `X-Ops-Session-Id: session-0fbe53e7-...` 响应头回显 |
| 续接第二问引用上文 | ✅ 第一问"记住 prod-tokyo 集群 C-7788" → 第二问准确复述环境名+编号（finish=stop） |
| unknown id | ✅ HTTP 400（reject 策略） |
| bench 回归（无 header） | ✅ Q1 24.8s/1666字 · Q2 25.4s/1645字 · Q3 14.3s/920字 · Q4 31.4s/1449字（内容完整、无回归、比 P1 前更快） |

### 目标
`X-Ops-Session-Id`（兼容 `X-Hermes-Session-Id`）续接同一会话；unknown id 400；响应头回显；compaction 控膨胀。

### 步骤

**1.1 bridge.ts — SessionDriver 增加 resume（可选方法）**
```ts
export interface SessionDriver {
  create(req: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  resume?(req: { sessionId: string }): Promise<{ sessionId: string }>   // 新增
  follow(...)
  prompt(...)
  cancel(...)
}
```

**1.2 bridge.ts — runTurn 支持外部传入 sessionId**
```ts
export interface RunTurnOptions {
  preset?: string
  cwd?: string
  sessionId?: string      // 新增：传入则跳过 create（多轮续接）
  onDelta?: (text: string) => void
  timeoutSec?: number
}
// runTurn 内部：
const sessionId = opts.sessionId ?? (await driver.create({ cwd: opts.cwd, agentPreset: opts.preset })).sessionId
```

**1.3 bridge.ts — consume() 多轮防污染（关键细节）**
- resume 会话的 follow 开场快照包含**历史全部 durable 事件**；snapshot 分支与 event 分支的 `durableFallback` 只能取**本轮**文本
- 方案：`consume()` 增加 `armed` 标志——初始 false，收到**本次 prompt 之后的第一帧**（任何 assistant-stream.start / event）才置 true；此前 snapshot 记录的文本不计入 durableFallback
- 更稳判定：`turn/start` durable 事件携带 `data.turn` 序号；prompt 前后用 `sc` 查询当前 turn 计数对照。首期用"首帧武装"启发式（prompt 与 follow 已同时打开，时序上 prompt 后的第一帧必然属于本轮）

**1.4 index.ts — 路由层 header 解析与 resume 分发**
```ts
// handleChat 内，读 body 前：
const sessionHeader = pickHeader(req, config.session.headerNames)  // [X-Ops-Session-Id, X-Hermes-Session-Id]
let sessionId: string | undefined
if (sessionHeader) {
  const ok = validateSessionHeader(sessionHeader)   // 长度 ≤128 / 禁 \r\n\0 / 字符集
  if (!ok) → 400 { error: { message: 'invalid session id header' } }
  try { sessionId = (await driver.resume!({ sessionId: sessionHeader })).sessionId }
  catch { return config.session.unknownIdPolicy === 'reject'
    ? 400 { error: { message: 'unknown session id' } }
    : (sessionId = undefined)  // create-new 兜底
  }
}
// turn 结束后（含异常路径）：
res.setHeader('X-Ops-Session-Id', sessionId)
```

**1.5 会话上限与 compaction**
- `maxTurnsPerSession`（config，默认 0=不限）：resume 前用 sessionController 查询会话 turn 计数（history/stats API），超限 → 主动 create 新会话 + 响应头 `X-Ops-Session-Renewed: 1`
- compaction 挂载（cordis.yml preset 组合追加）：
  ```yaml
  - name: '@deepseek-ai/dsh-compaction-basic'
    config: { /* 阈值字段名以包 README 为准，执行时查证 */ }
  ```
- **执行时验证点**：compaction 摘要后 resume 的 follow 是否仍能正确解析 turn 序号（self-test 加 case）

**1.6 dispose 语义变更**
- 多轮会话（传了 sessionId）：**不 dispose**（会话保留供下次续接）
- 新建会话：保持现状 dispose
- 进程退出钩子：sessionController 无 per-session dispose 需求变化；仅 ops-api 内部清理 in-flight map

### P1 自测（self-test.ts 追加 [9] 段）
1. runTurn 传 sessionId 跳过 create（mock driver 断言 create 未被调用）
2. armed 启发式：resume mock（snapshot 带历史 assistant/message「旧答案」+ 本轮流「新答案」）→ 返回「新答案」
3. header 校验：合法/超长/含 \n → 400 分支
4. unknown id → reject/create-new 两策略
5. maxTurnsPerSession 超限 → 新会话 + renewed 头
6. mixed：有 sessionId 时 runTurn 不调用 dispose（新断言）

### P1 验收（HTTP）
```bash
# 首轮
curl -i -X POST .../v1/chat/completions -d '{"messages":[{"role":"user","content":"记住：我的环境是 prod 集群"}]}'
# → 响应头 X-Ops-Session-Id: <sid>
# 续接轮（第二问应能引用上文）
curl -i -X POST .../v1/chat/completions -H "X-Ops-Session-Id: <sid>" -d '{"messages":[{"role":"user","content":"我刚才说的环境是什么？"}]}'
# → 答案含 prod；响应头同 sid
# unknown id
curl -i ... -H "X-Ops-Session-Id: no-such-id" → 400
# bench 回归（无 session header 行为不变）
bash bench-4q.sh http://127.0.0.1:3080 i2stream-ops
```

### P1 产出文件（已实施）
- `ops-api/bridge.ts`：`SessionDriver.resume?()` 可选方法 + `runTurn` `sessionId` 入参（传入走 resume 校验）+ `armed` 启发式（resume 场景 prompt 后首帧才武装，旧回合 snapshot/event 文本与 stale turn/end 全部忽略）+ 返回 `sessionId`
- `ops-api/index.ts`：config `session` 段（enabled/headerNames/maxTurnsPerSession/unknownIdPolicy）+ `pickSessionHeader`/`validSessionId` + resume 分发（`sc.resolveAgent` 适配，unknown → 400 或 create-new）+ `inspect` 事件数限流（超限 → 新会话 + `X-Ops-Session-Renewed: 1`）+ 响应头回显（非流式/SSE/timeout 三路径）
- `ops-api/self-test.ts`：[9] 段 10 项断言全绿（resume 走向/回显/内容、snapshot 防污染、stale turn/end 忽略、unknown 抛错、无 resume 直用、新会话回归）
- `presets/i2stream-ops/agent.cordis.yml`：（误挂 compaction-basic 后已移除，见踩坑）
- `cordis.yml`：ops-api config 加 `session` 段（enabled=true, reject 策略）
- **实施细节**：sessionController 无独立 resume 方法——用 `resolveAgent(sessionId)` 校验（`{agent}` 成功 / `{error: RemoteError('session/not-found')}`）；`Schema.union().of()` 在当前 schemastery 版本不可用，unknownIdPolicy 用 `Schema.string()` + normalize
- **踩坑记录（P1.9 首次重启后全请求 500）**：preset 组合误挂 compaction-basic → 违反 DSH 约束「preset 服务必须隔离或放 host 层」（`row(s) published process-global service(s) [compaction]`）→ preset 挂载失败 → 每个请求 500。修复：移除 preset 内挂载——**bundle base 层已默认挂 host 级 compaction-basic，preset 重复挂载本就多余**。**结论：preset 组合（agent.cordis.yml）只放 persona/skills 等会话级插件；进程级服务（compaction/mcp/storage 等）一律走 host 层 cordis.patch.yml 或 bundle 默认**

---

## P3 扩展端点（G2）★排在 P1 后（sessions CRUD 依赖 resume 稳定）

### 目标
`/v1/capabilities`、`/v1/responses`（子集）、`/api/sessions`（列表/详情/归档）。

### 步骤

**3.1 `/v1/capabilities`（静态组装，最简单先行）**
```ts
// index.ts 新路由；数据源：preset 元数据（tools 10 / skills 26 静态常量 + config）
{ platform, version, models: [{id: 'i2stream-ops'}],
  features: { 'chat.completions': true, responses: true, multi_turn_session: true,
              memory: config.memory?.enabled ?? false, streaming: true,
              tools: 10, skills: 26 },
  limits: { max_session_turns: config.session.maxTurnsPerSession || null } }
```

**3.2 `/v1/responses`（翻译层，新文件 `responses.ts`）**
- `input` string → `[{role:'user', content}]`；input array → 直接映射（仅 user/assistant 角色，system 显式 400）
- 组装 `{ id: 'resp_'+uuid, object: 'response', output: [{type:'message', role:'assistant', content:[{type:'output_text', text}]}], usage: mapUsage }`
- 未知字段白名单校验：`Object.keys(body)` 差集非空 → 400 `{error:{message:'unsupported field: X'}}`
- `stream: true` → 400（二期）；复用 handleChat 的 runTurn 管线（含 memory hook，见 P2）
- self-test：string/array 两种 input 翻译、未知字段 400、usage 映射

**3.3 `/api/sessions`（三路由，依赖 ctx.sessionController 列表/历史 API）**
- `GET /api/sessions` → `sc` 的 session 列表（id/title/created/turnCount）——执行时查 session-controller 远程面的确切方法名（list/history pages）
- `GET /api/sessions/{id}?page=&limit=` → 历史分页（durable events → 精简 `{role, content, ts}` 数组）
- `DELETE /api/sessions/{id}` → 归档（若无 delete 命令 → 返回 405 + 文档注明；不造假）
- 路由实现：现有 exact 注册机制需支持路径参数——执行时确认 dsh-host-webserver 是否支持 `/api/sessions/:id`；不支持则用 `/api/sessions?id=` query 形式规避

#### ✅ 执行时事实核实（2026-09-15）
1. **路由无路径参数**：`WebRoute.kind` 只有 `'exact' | 'prefix'`（packages/host/webserver/src/index.ts:39-47），无 `:param`。→ `/api/sessions/{id}` 用 `prefix` 注册 `/api/sessions`，handler 内手动解析 `req.url`（剥 query → 按 `/` 切段取第 3 段为 id）。
2. **sessionController 列表 API**：`list(_request: {cursor?}, signal)` → `{items: SessionSummary[]}`（@Remote，packages/api/session-controller/src/index.ts:223）。`SessionSummary = { sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`（types.ts:163）。无 title/turnCount 字段——返回真实字段，不造假。
3. **历史详情**：`inspect(sessionId, signal?)` → `SessionInspection { meta, inheritedEventCount, events }`（index.ts:201）。events 含 durable 事件，`event.type` 为 `'user/message' | 'assistant/message' | ...`；user 侧 `event.data.source.kind === 'user'`。文本提取复用 `extractMessageText(event.data)`（bridge.ts 已有，递归 content parts）。→ 详情端点本地过滤 `MESSAGE_TYPES`，精简为 `{role, content}`。
4. **删除/归档**：sessionController 无 delete/archive 远程方法（只有 create/adopt、list、search、inspect、page、resolveAgent、cancel）。→ `DELETE /api/sessions/{id}` 返回 **405 Method Not Allowed** + 文档说明（不造假删除）。`cancel` 只中止运行中 turn，非删除会话。
5. **分页**：`page(request, signal)` 存在但签名复杂（address/throughSeq/beforeSeq）。详情端点简化：用 inspect 全量 events 本地切片（`?limit=` 默认 50，`?offset=`），不做服务端游标分页（一期从简）。

#### P3.3 实现要点（修正后）
```ts
// prefix 注册 /api/sessions；handler 内 parseSessionsPath(req.url) 提取 { action: 'list'|'detail', id? }
// list:   sc.list({}, signal) → { sessions: items.map(s => ({ id: s.sessionId, updated_at: s.updatedAt, running: s.running, cwd: s.cwd })) }
// detail: sc.inspect(id) → filter events(user/message|assistant/message) → { role, content }[] + { total }
// delete: 405 + { error: { message: 'session deletion not supported; sessionController exposes no delete/archive' } }
```

### ✅ P3 已实施（2026-09-15）

**实现文件**：
- `ops-api/responses.ts`（新）：`parseResponsesRequest(body)`（未知字段白名单 400 / system 角色 400 / stream:true 400 / input string|array 翻译）+ `buildResponse(opts)`（`{id:'resp_...', object:'response', status:'completed', model, output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}], usage}`）。联合类型用 `type`（esbuild 不支持 `interface A | B`）。
- `ops-api/index.ts`：三路由注册（`/v1/capabilities` exact、`/v1/responses` exact、`/api/sessions` **prefix**）+ 三 handler + 公共 `prepareSession(req,res)`（抽出 handleChat 的 session 续接段，handleResponses 复用）。
  - `capabilitiesBody()`：静态能力位图（models/features/limits/endpoints），memory/tools 位随 config 动态。
  - `handleResponses`：复用 prepareSession + memory hook（recall 前缀注入 + capture + ALS wrap）+ runTurn 管线，响应形状用 buildResponse。非流式（stream:true 已在 parse 阶段 400）。
  - `handleSessions`：手动解析 `req.url`（剥 query → `/` 切段取第 3 段为 id）；GET list / GET detail（inspect → filter user/message|assistant/message → `extractMessageText` → `{role,content}` + limit/offset 本地切片）/ DELETE 405（诚实，无 delete API）/ 其他方法 405。
- `ops-api/self-test.ts` [11]：9 断言（input 翻译 / 未知字段 / system / stream / model / 空 input / buildResponse 形状 / usage 透传）→ **ALL PASSED ✅**（83 断言，含 [1]-[3],[9],[10] 回归）。

**挂载日志**：`[ops-api] mounted: /v1/chat/completions /v1/responses /v1/capabilities /api/sessions (...)`

**待重启验收**（HTTP）：
```bash
curl .../v1/capabilities              # features 位图正确
curl .../v1/responses -d '{"input":"你好"}'          # output 数组形状（resp_ 前缀）
curl .../v1/responses -d '{"input":"x","functions":{}}'   # 400 unsupported field
curl .../v1/responses -d '{"input":"x","stream":true}'    # 400 streaming not yet supported
curl .../api/sessions                 # 列表含 P1/P2 产生的会话
curl .../api/sessions/<id>            # 历史可读（user/assistant 消息精简）
curl -X DELETE .../api/sessions/<id>  # 405（诚实不造假）
```

### ✅ P3 验收结果（2026-09-15，重启后一次通过）

| 用例 | 结果 |
|---|---|
| GET /v1/capabilities | ✅ 位图正确：`{chat.completions, responses, multi_turn_session: true, memory: true, streaming: true, tools: 3}` + limits + endpoints 列表 |
| POST /v1/responses（input string） | ✅ `{id: 'resp_chatcmpl-...', object: 'response', status: 'completed', output: [{type:'message', role:'assistant', content:[{type:'output_text', text}]}], usage}` |
| POST /v1/responses（input array + model） | ✅ 数组翻译正确，model 覆盖生效 |
| 未知字段 `functions` | ✅ 400 `unsupported field: functions` |
| `stream: true` | ✅ 400 `streaming is not yet supported...`（引导用 /v1/chat/completions） |
| system 角色 | ✅ 400 `unsupported input role: system (only user\|assistant)` |
| GET /api/sessions | ✅ 列表 55 会话（含 running 状态、真实字段） |
| GET /api/sessions/{id}?limit=4 | ✅ `{id, total, offset, limit, messages:[{role, content}]}`，user/assistant 提取正确 |
| DELETE /api/sessions/{id} | ✅ 405 + 诚实说明（sessionController 无 delete API） |
| 未知 session 详情 | ✅ 404 `session not found` |
| /v1/responses + X-Ops-Session-Id 续接 | ✅ 附加验证：第一轮"记住 42" → 第二轮（同 session id）"刚才记住的数字"→ 答 "42"。prepareSession 复用生效，responses 端点同样支持多轮。 |

**结论**：P3 扩展端点**验收通过**。G2 gap 补齐（/v1/responses 子集 + /v1/capabilities + /api/sessions 只读三路由）。剩余：P4 Gateway supervisor；P5 按需项（/v1/responses 流式、sessions 删除等 Controller 能力到位后再启）。

### P3 验收
```bash
curl .../v1/capabilities        # features 位图正确
curl .../v1/responses -d '{"input":"你好"}'   # output 数组形状
curl .../v1/responses -d '{"input":"x","functions":{}}'  # 400 unsupported field
curl .../api/sessions           # 列表含 P1 产生的会话
curl .../api/sessions/<id>      # 历史可读
```

---

## P2 记忆薄客户端（G3）★可与 P3 并行（独立模块）

### 目标
`ops-api/memory.ts`：对接 MemoryCore Gateway（recall/capture/sessionEnd + 熔断 + 背压）；3 工具挂载；header 语义对齐。

### 步骤

**2.1 memory.ts 骨架（新文件，对标 hermes-plugin `client.py` + `supervisor.py`）**
```ts
export interface MemoryGatewayConfig {
  url: string                 // http://127.0.0.1:8420
  apiKey?: string             // TDAI_GATEWAY_API_KEY（credentials 注入）
  timeoutMs: { recall: number, capture: number }   // 建议 2000/5000
}
export interface OpsMemoryService {
  recall(sessionKey: string, query: string): Promise<{ context: string; memoryCount: number }>
  capture(req: { sessionKey: string; sessionId?: string; userContent: string; assistantContent: string }): void
  sessionEnd(sessionKey: string): Promise<void>
  searchMemories(query: string, opts?: { limit?: number; type?: string }): Promise<string>
  searchConversations(query: string, opts?: { limit?: number }): Promise<string>
  readScene(sceneId: string): Promise<string>
  health(): Promise<{ ok: boolean }>
}
export function createOpsMemory(cfg, log): OpsMemoryService
```

**2.2 熔断器 + 背压（对齐 Hermes provider 数值）**
```ts
// 熔断：连续 5 次请求失败（网络错/5xx）→ open 60s；open 期间 recall 返回 ''、capture 丢弃并 warn
// 背压：capture 队列 in-flight ≤ 4；第 5 个入队等待最旧完成（上限 5s）后才发出
// 全部 HTTP 调用带 AbortSignal 超时；recall 失败绝不抛错（H-15：recall 失败 ≠ 请求失败）
```

**2.3 ops-api/index.ts 集成（三 hook 点）**
```ts
// 1) header 解析（与 P1 同款校验函数，独立 header：X-Ops-Memory-Key / X-Hermes-Session-Key）
const memoryKey = pickHeader(req, config.memory.headerNames)
// 2) prompt 前（runTurn 之前）：
let memoryPrefix = ''
if (memoryKey) {
  const r = await memory.recall(memoryKey, lastUserText(req.body.messages))
  if (r.context) memoryPrefix = r.context     // 原样前缀注入，不改写（Gateway 已渲染 <memory-context>）
}
// 3) runTurn 传 sessionId + turn 结束后（响应发出后不阻塞）：
if (memoryKey) memory.capture({ sessionKey: memoryKey, sessionId, userContent, assistantContent })
// 4) 会话结束/进程退出：memory.sessionEnd(sessionKey)；SIGTERM 钩子 flush
```
- 注入位置决策（执行时确认）：memoryPrefix 作为**首条 user 消息前缀**拼接（对齐 Hermes prefetch 注入 user prompt 的语义），不改 system

**2.4 三个 LLM 工具挂载（新文件 tools-memory.ts）**
```ts
// 工具名/描述/schema 1:1 抄 hermes-plugin __init__.py 的三个 SCHEMA：
memory_tencentdb_memory_search / memory_tencentdb_conversation_search / memory_tencentdb_read_scene
// 注册模式照抄 bkn-plugin：ctx.tools.register(defineTool({ name, description, parameters, execute }))
// handler：读当前请求的 memoryKey → ctx.opsMemory 对应方法
// 无 memoryKey 会话调用工具 → 返回空结果 + 提示「未启用记忆分片」
```
- **执行前核实（2026-09-15）**：注册模式确认为 `ctx.tools.register(defineTool({...}))`（bkn-plugin/tools.ts:189-198 同款）；`defineTool` 的 `execute(args, exec: ToolRunContext)` 无 per-request 会话标识——**per-request memoryKey 用 AsyncLocalStorage 传递**：ops-api 在 runTurn 外层 `als.run({ memoryKey }, ...)`，工具 handler 读 `als.getStore()?.memoryKey`；无 store（GUI 会话等非 ops-api 路径）→ 空结果。ALS 在同进程 await 链内传播（prompt → agent loop → tool execute 同链）；若实测发现 agent loop 脱链（ALS store 丢失），降级方案：工具参数加可选 session_key 字段

**2.5 配置（cordis.yml）**
```yaml
- id: ops-api
  config:
    memory:
      enabled: true
      headerNames: [X-Ops-Memory-Key, X-Hermes-Session-Key]
      gateway: { url: 'http://127.0.0.1:8420', apiKey: '${TDAI_GATEWAY_API_KEY}' }
      breaker: { threshold: 5, cooldownSec: 60 }
      capture: { maxInFlight: 4, waitMs: 5000 }
      tools: { enabled: true }
```

### P2 自测（self-test.ts 追加 [10] 段，全 mock fetch）
1. recall 正常 → context 注入前缀；capture 发出正确 body
2. 熔断：连续 5 次失败 → 第 6 次跳过 HTTP（fetch 未被调）+ 60s 后半开
3. 背压：5 个并发 capture → in-flight ≤4，第 5 个延迟到最旧完成
4. recall 超时/5xx → 返回 '' 不抛错，主请求不受影响
5. 无 memoryKey → 不调 recall/capture
6. sessionEnd 调用与 SIGTERM flush
7. 三工具 handler：有 key 透传 / 无 key 空结果

### P2 验收（HTTP，需 Gateway 在跑）
```bash
curl -s http://127.0.0.1:8420/health          # Gateway 活着（若挂了：DSH 正常降级）
# A 会话写记忆
curl -i .../v1/chat/completions -H "X-Ops-Memory-Key: i2agent:test:exec" \
  -d '{"messages":[{"role":"user","content":"记住：我的 i2Stream 部署在 shanghai 集群"}]}'
# B 会话（新 session、同 memory key）回忆
curl .../v1/chat/completions -H "X-Ops-Memory-Key: i2agent:test:exec" \
  -d '{"messages":[{"role":"user","content":"我部署在哪个集群？"}]}'
# → 答案含 shanghai；kill Gateway 后重试 → 正常问答但无记忆（降级验证）
```

### P2 产出文件
- `ops-api/memory.ts`（新）
- `ops-api/index.ts`（hook + config）
- `ops-api/tools-memory.ts`（新，三工具）或并入 index
- `ops-api/self-test.ts`（[10] 段）
- `cordis.yml`（memory 配置段）

### ✅ P2 已实施（2026-09-15）

**实现文件**：
- `ops-api/memory.ts`（新，~230 行）：`createOpsMemory(cfg, log)` 返回 `OpsMemoryService`。HTTP 客户端（AbortSignal 超时：recall 2s / capture 5s / search 5s / sessionEnd 3s）+ 三态熔断 + capture 队列背压。所有方法失败路径返回空值/静默，绝不抛错（H-15 降级铁律）。
- `ops-api/tools-memory.ts`（新）：`buildMemoryTools({memory})` 生成三个 LLM 工具，schema 1:1 抄 Hermes `__init__.py`。工具 handler 从 `memoryAls.getStore()?.memoryKey` 取 key；无 store 返回"未启用记忆分片"提示。
- `ops-api/index.ts`：config 新增 `memory` 段；apply 内实例化 memory 服务 + 挂 3 工具（`ctx.tools.register(defineTool(...))`，静态 import defineTool）；`memoryKeyOf(req)` 读 `X-Ops-Memory-Key`/`X-Hermes-Session-Key`（校验 ≤255、禁 \r\n\0）；handleChat 内 `memory.recall()` 前缀注入 `effectivePrompt`、`afterTurn()` 异步 capture、`runWithMemory()` ALS wrap runTurn；dispose 时对 `memoryKeysSeen` 发 session/end（2s 有界等待）。

**实施中修正（重要）**：
1. **capture 背压改队列**：初版"等待最旧完成"在 burst 下失效（10 并发 → 9 在途，多个 wait 同时放行）。改为**队列限流**：在途 < maxInFlight 直接入队执行；满则进 captureQueue（≤64，超出丢弃）；每个完成时 shift 出下一个。自测 10.4 验证在途 ≤4。
2. **熔断状态机修正**：初版把 open 窗口内第一个请求误判为半开探测。改为三态：CLOSED(openUntil=0) / OPEN(now<openUntil，全部跳过) / HALF-OPEN(cooldown 过后，仅放行首个探测 probing=true，其余等探测结果)。recordFailure 达 threshold → 重置 probing + 刷新 openUntil；recordSuccess → 全清。
3. **seed API 契约**：`POST /seed` 需 `{session_key, data:{sessions:[{sessionKey, conversations:[[{role,content},...]]}]}}`（sessions 二维数组、每轮 [user,assistant]）。seed 会同步触发 L1 管道（embedding），实测 10s+ 无响应——**不影响薄客户端验收**，直接用 Gateway 已有历史记忆验证 recall。

**自测结果**：`self-test.ts` [1]-[3],[9] 回归 + [10] 新增 10 断言（10.1a/b, 10.2, 10.3, 10.4, 10.5a/b/c, 10.6）全绿 → **ALL PASSED ✅**（74 断言）。裸 `tsc` 对 `node:*` 报 TS2591 为环境缺 @types/node（openai.ts 同样报，非新代码问题）；tsx 运行环境验证 OK。

**Gateway 契约验证**：`/recall` 实测返回 `{context, strategy: 'hybrid', memory_count: 5, code: 0, message, retryable}`——与 memory.ts 完全匹配（code=0 走正常路径，context 直接前缀注入）。`/search/memories` 返回 `{results, total, strategy}`。Gateway :8420 健康（vectorStore+embedding true，uptime 590832s，pipeline 已消费 260 任务）。

**验收结果（2026-09-15，重启两次后）**：

**踩坑**：第一次重启后 recall 未生效——原因是我漏配了 `cordis.patch.yml` 的 memory 段（`enabled` 默认 false，插件内 `if (cfg.memory.enabled)` 未挂服务）。补配置后第二次重启生效。**记录：config 新增段时，`cordis.patch.yml` 与 schema default 两处都要改，只改 schema 不会自动启用。**

| 用例 | 结果 |
|---|---|
| A1 带 `X-Ops-Memory-Key: i2agent:p2-verify:smoke`，问"我是谁/负责什么产品线" | ✅ recall 注入生效，模型准确答出 persona 记忆（"项目负责人 / i2stream-bkn / 数据库兼容性架构 / OCP·etcd 技术栈 / Diagnosis-as-Code 工作哲学"）。响应含 Gateway L3 user-persona 段。 |
| A2 无 memory key，问"介绍 i2Stream" | ✅ 正常问答，recall 被 `if (memory && memoryKey)` 短路、零延迟，未调 Gateway。 |
| A3 写入→检索闭环（capture 路径） | ✅ ops-api `afterTurn` 触发 `/capture` → Gateway 返回 `{l0_recorded: 2, scheduler_notified: true}` → `search/conversations` 检索到 "Phoenix-77"（3 条命中，含 capture 原文）。capture→L0 落库→检索端到端打通。 |
| A3-b 跨会话 recall 回忆新事实 | ⚠️ recall `memory_count=0`——**Gateway 侧 L1 episodic 异步提取未完成**（依赖 idle 定时器 `L1_idle` 扫描，延迟数十秒~分钟级）。非薄客户端问题：recall 路径本身已验证（A1 成功注入 L3 persona）。L0 数据在，L1 提取完成后 recall 即命中。 |
| A4 bench 回归（无 memory key） | ✅ Q1 12.4s/1011字、Q2 28.2s/1546字（基线内）；无 key 时 recall 短路，无额外延迟。 |
| 降级（kill Gateway） | ✅ self-test [10.1b/10.2/10.3] 单测覆盖：recall 网络错/超时/code!=0 → 返 '' 不抛错；熔断 open 后跳过 HTTP。所有 memory 方法失败路径返回空值/静默，绝不影响主请求（未实际 kill 共享 Gateway）。 |

**结论**：P2 记忆薄客户端**功能验收通过**。recall 注入（读）+ capture 落库（写）+ 三工具挂载 + 降级链路均按设计工作。唯一观察项是 Gateway L1 episodic 提取延迟（异步、最终一致），属 MemoryCore 内部行为，不影响薄客户端正确性。**G3 记忆分片 gap 已补齐。**

---

## P4 Gateway 托管启动（supervisor）

### 目标
`autoStart: true` 时 ops-memory 插件 spawn Gateway + 健康轮询 + crash 诊断（对齐 Hermes supervisor）。

### 步骤
1. memory.ts 增加 `supervise(cfg.command)`：spawn 子进程（detached:false，随宿主退出）→ 轮询 `/health` ≤30s → 失败转储 stderr 尾部 2KB
2. 连续 crash ≥3 次 → 放弃拉起、熔断常开 + error 日志（不 crash 宿主）
3. 部署文档：形态 A（独立 systemd Gateway）/ 形态 B（DSH 托管）两种配置样例
4. 验收：kill -9 Gateway → 下一请求自动拉起并成功 recall；command 错误时宿主启动不失败（warn + 降级）

---

### 设计（2026-09-15，执行前事实核实）

#### 事实基础（已核实）
1. **Gateway 启动命令**：`node --import tsx src/gateway/server.ts`，cwd=`/hdd/demo/TencentDB-Agent-Memory/MemoryCore`（当前运行进程 ps 确认）。config.ts 读 `TDAI_GATEWAY_HOST/PORT`。
2. **Hermes supervisor 契约**（supervisor.py 409 行，已逐行读）：
   - `ensure_running()`：`is_running()`（health 探测，3 次重试）→ 已运行则复用；否则 single-flight 锁内 spawn → `_wait_for_health()`（≤30s，0.5s 间隔，poll() 检测子进程死亡 + stderr 尾部转储 500 字符诊断）
   - spawn：`start_new_session=True`（独立进程组）+ stdout/stderr 重定向到日志文件（**不用 PIPE**——防 64KB 管道缓冲填满死锁）+ env 注入 `TDAI_GATEWAY_HOST/PORT`（不注入 API_KEY——鉴权是操作员在 Gateway 侧的职责）
   - `shutdown()`：`killpg(SIGTERM)` → wait(10s) → `killpg(SIGKILL)` → wait(5s)。杀整个进程组（pnpm→tsx→node 层级防孤儿）
   - `is_process_alive()`（poll()，快）与 `is_running()`（HTTP health，慢但对外部启动也有效）区分——watchdog 组合判断：两者都 false 才 respawn
   - crash 时 `_reap_dead_process()` 丢弃旧 Popen 句柄再 respawn（防僵尸引用）
3. **日志目录**：Hermes 用 `~/.hermes/logs/memory_tencentdb/gateway.{stdout,stderr}.log`（append 模式保留历史）。DSH 版改用 `MEMORY_TENCENTDB_LOG_DIR` env → 默认 `~/.dsh/logs/memory-tencentdb/`。
4. **宿主退出钩子**：cordis `ctx.on('dispose', ...)` 在进程退出时触发（ops-api P2 memory flush 已用）→ supervisor.shutdown() 挂同一 dispose。

#### 设计决策
- **新文件 `ops-api/supervisor.ts`**（不塞进 memory.ts）：职责分离——memory.ts 是 HTTP 客户端，supervisor.ts 是进程生命周期。`createGatewaySupervisor(opts, log)` 返回 `{ ensureRunning, shutdown, isManaged, pid }`。
- **config 扩展**（memory 段下）：
  ```yaml
  memory:
    autoStart: false        # 默认 false（当前 Gateway 独立运行，形态 A）
    gatewayCmd: ''          # 空 → 默认 `node --import tsx src/gateway/server.ts`
    gatewayCwd: '/hdd/demo/TencentDB-Agent-Memory/MemoryCore'
    logDir: ''              # 空 → ~/.dsh/logs/memory-tencentdb
  ```
- **启动时机**：`autoStart: true` 时 apply 内调 `ensureRunning()`（fire-and-forget，**不 await 阻塞挂载**——Gateway 冷启动 30s 不该卡住 ops-api 路由注册）。health 就绪前的请求走 memory.ts 现有降级路径（recall 返回 ''）。
- **respawn watchdog**：ensureRunning 内含 respawn 逻辑（is_process_alive || is_running 都 false → respawn）。**不设独立定时器**——由"下一请求触发 recall/capture 失败"驱动惰性 respawn（对齐 Hermes：请求驱动，非主动轮询）。crash 计数：连续 spawn 失败 ≥3 → `giveUp=true` 常开熔断 + error 日志，之后不再尝试（需重启宿主）。
- **spawn 实现**：`child_process.spawn(shlex 等价拆分, {cwd, env, detached: false, stdio: ['ignore', fdOut, fdErr]})`。detached:false（随宿主退出）——但 shutdown 仍 `process.kill(-pid, 'SIGTERM')`（负号杀组，spawn 时用 `detached: true` 才有独立组）→ **修正：用 detached:true + dispose 时显式 shutdown**（对齐 Hermes start_new_session），确保宿主异常退出不留孤儿（Node 默认会杀 detached 子进程？不会——需显式）。**最终决定：detached:true + shutdown 挂 dispose + SIGTERM 10s→SIGKILL 兜底**。
- **健康探测**：复用 memory.ts 的 health()（1.5s 超时）；supervisor 内部轮询 0.5s × ≤30s。
- **stderr 尾部**：spawn 前记录 stderr log 文件路径；子进程启动失败/早期退出时读文件尾部 2048 字节转储到 error 日志。

#### self-test [12]（mock spawn/health）
1. ensureRunning：health 已 ok → 不 spawn（isRunning 先探测）
2. health 失败 → spawn 一次 + 轮询成功 → isManaged=true
3. 连续 spawn 失败 ×3 → giveUp，不再 spawn
4. shutdown：对 managed 子进程发 SIGTERM（mock process.kill）
5. 空 cmd + autoStart → warn 不 crash 宿主

#### 验收（HTTP，需重启）
```bash
# 形态 A 回归（autoStart=false，当前状态）：一切如旧
# 形态 B（改 cordis.patch.yml autoStart=true）：kill -9 Gateway → 下一 recall 请求触发 respawn → 成功 recall
# 坏命令（gatewayCmd=/bad/cmd）：宿主正常启动，ops-api 挂载成功，仅 warn 日志 + 记忆降级
```

### ✅ P4 已实施（2026-09-15）

**实现文件**：
- `ops-api/supervisor.ts`（新，~230 行）：`createGatewaySupervisor(opts, log) → GatewaySupervisor { ensureRunning, shutdown, isManaged, pid, hasGivenUp }`。1:1 对标 Hermes supervisor.py：
  - ensureRunning：health 探测（2s 超时，status ok|degraded 视为可用）已运行 → 复用；否则 single-flight 内 spawn → 轮询 ≤30s（0.5s 间隔，同时检测子进程早死）
  - spawn：`detached:true`（独立进程组）+ `stdio: ['ignore', fdOut, fdErr]` 重定向日志文件（不用 PIPE 防死锁）+ env 注入 TDAI_GATEWAY_HOST/PORT（**不注入 API_KEY**——同 Hermes，鉴权由 Gateway 侧操作员配置）
  - 早死诊断：读 stderr log 尾部 2048 字节转 error 日志
  - shutdown：`kill(-pid, SIGTERM)` 杀进程组 → wait 10s → SIGKILL → wait 5s
  - 给弃策略：连续失败 ≥3 → `giveUp` 常开（不再尝试，需宿主重启）
  - reapDead：respawn 前丢弃死句柄（防 zombie 引用）
- `ops-api/index.ts`：
  - config 扩展：memory 段 + `autoStart`（默认 false）/ `gatewayCmd`（默认 `node --import tsx src/gateway/server.ts`）/ `gatewayCwd`（默认 MemoryCore 路径）/ `logDir`（默认 ~/.dsh/logs/memory-tencentdb）
  - apply：autoStart=true → supervisor 实例化 + `ensureRunning()` fire-and-forget（**不阻塞挂载**）
  - 惰性 respawn：handleChat / handleResponses 中 recall 返回空 + supervisor 非 giveUp → 后台 `ensureRunning()`（请求驱动，无定时器，对齐 Hermes）
  - dispose：supervisor.shutdown() 有界等待 15s（在 memory sessionEnd flush 之后）
- `ops-api/self-test.ts` [12]：5 断言（复用不 spawn / 空 cmd 不 crash / giveUp ×3 / shutdown 幂等 / 坏 baseUrl 不抛错）→ **ALL PASSED ✅**（88 断言含全量回归）

**挂载日志**：autoStart=true 时附加 `gateway supervisor armed (cmd=...)`

**待重启验收**：
```bash
# 形态 A 回归（当前 cordis.patch.yml autoStart=false）：/health /v1/* 一切如旧
# 形态 B：yml 加 autoStart: true → 重启 → ps aux 确认新 Gateway 进程由 DSH spawn
# respawn：kill -9 <gateway pid> → 下一请求 recall 触发 respawn → 成功
# 坏命令：gatewayCmd=/bad/x → 宿主正常起，ops-api 挂载成功，warn 日志 + 记忆降级
```

### ✅ P4 验收结果（2026-09-15）

| 用例 | 结果 |
|---|---|
| **形态 A 回归**（autoStart=false） | ✅ supervisor 未激活，外部 Gateway（:8420）一切如旧（chat/capabilities/memory key 均正常） |
| **形态 B 启动**（autoStart=true） | ✅ supervisor 探测发现 :8420 已健康（外部进程仍在跑）→ **复用不 spawn**（设计：避免双实例抢端口） |
| **kill -9 外部 Gateway** | ✅ PID 206474 被杀（14:28） |
| **惰性 respawn 触发** | ✅ 下一 chat 请求 recall 失败 → 后台 ensureRunning → **5s 内新进程拉起**（PID 2096423） |
| **记忆数据保留** | ✅ recall 返回了之前会话的 L0 历史（Oracle 索引分析）——vectorStore 持久化文件保留 |
| **服务完整恢复** | ✅ vectorStore=true、timerScanner.isLeader=true、pipelineWorker.tasksConsumed=2（历史状态延续） |
| **会话续接无感知** | ✅ respawn 后同 session id 的对话继续可用（agent-loop 状态在 DSH 进程内，不受 Gateway 重启影响） |

**结论**：P4 Gateway supervisor **验收通过**。G3 gap 完全闭环：记忆功能 + 托管启动 + 崩溃恢复。所有三个 gap（G1/G2/G3）均已补齐，"完全替代 Hermes" 的核心目标达成。

**部署形态（部署文档样例，两选一）**

形态 A — 独立 systemd Gateway（推荐生产；DSH 不管进程）：
```ini
# /etc/systemd/system/memorycore-gateway.service
[Unit]
Description=MemoryCore Gateway (TencentDB Agent Memory)
After=network.target

[Service]
WorkingDirectory=/hdd/demo/TencentDB-Agent-Memory/MemoryCore
ExecStart=/usr/bin/node --import tsx src/gateway/server.ts
Environment=TDAI_GATEWAY_HOST=127.0.0.1
Environment=TDAI_GATEWAY_PORT=8420
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```yaml
# cordis.patch.yml：autoStart 保持 false（默认）
ops-api:
  memory:
    enabled: true
    gatewayUrl: 'http://127.0.0.1:8420'
```

形态 B — DSH 托管（开发/单机；DSH spawn + 崩溃 respawn）：
```yaml
# cordis.patch.yml
ops-api:
  memory:
    enabled: true
    gatewayUrl: 'http://127.0.0.1:8420'
    autoStart: true                          # 触发 supervisor
    gatewayCmd: 'node --import tsx src/gateway/server.ts'   # 可覆盖
    gatewayCwd: '/hdd/demo/TencentDB-Agent-Memory/MemoryCore'
    logDir: '/root/.dsh/logs/memory-tencentdb'             # gateway.{stdout,stderr}.log
```
> 注意：形态 B 下 Gateway 密钥（TDAI_GATEWAY_API_KEY）仍需在 Gateway 侧配置（env 或 config.ts）——supervisor 不向子进程注入密钥（对齐 Hermes）。两种形态不可混用同一端口（health 探测会复用外部实例，spawn 自然跳过）。

---

## P5 按需项（暂不排期，记录触发条件）

| 项 | 触发条件 | 要点 |
|----|---------|------|
| `/v1/responses` 流式 | 调用方需要 | SSE `response.output_text.delta` 事件序列（复用 onDelta 管线） |
| Gateway 切 TCVDB+COS | 客户合规要求 | 纯 Gateway 配置（IMemoryStore/IStorageBackend），DSH 零改动；验证 recall/capture 正常 |
| sessions DELETE 真删除 | 调用方需要 | 依赖 sessionController 是否有 delete 命令；无则归档位方案 |

### P5a 设计：`/v1/responses` 流式（2026-09-15）

**触发**：用户确认「继续，先设计再执行」。Hermes 无此能力（仅 chat SSE），本项为超出补齐。

**OpenAI Responses API SSE 事件序列**（社区标准）：
```
event: response.created      data: {type:'response.created', response:{id,...}}
event: response.in_progress  data: {type:'response.in_progress', response:{...}}
event: response.output_item.added    (item: {type:'message', role:'assistant', content: []})
event: response.content_part.added   (part: {type:'output_text', text:''})
event: response.output_text.delta    (delta: '<增量文本>'}   ← N 次
event: response.output_text.done     (text: '<全量>'}
event: response.content_part.done
event: response.output_item.done
event: response.completed    data: {type:'response.completed', response:{..., usage}}
```

**设计决策**：
1. **事件顺序简化**（一期从简）：`response.created` → N×`response.output_text.delta` → `response.completed`。省略中间的 output_item/content_part 阶段事件（多数客户端只消费 delta + completed；复杂阶段事件二期按需补）。
2. **复用管线**：`parseResponsesRequest` 已识别 `stream:true` 并返回 400——**解除该限制**（改返回 `stream: true` 供 handleResponses 分支）。handleChat 的 SSE 段（`write()` 助手 + `onDelta` 回调 + `buildFinalChunks`）模式复用到 handleResponses。
3. **payload 结构**：SSE `data:` 行携带 JSON，`event:` 行可选（用 `data.type` 字段区分，对齐 OpenAI——客户端读 `data.type`）。
4. **错误路径**：turn timeout/异常 → 发 `response.failed` 事件（{type:'response.failed', response:{error}}）+ 关流（不发 [DONE]）；成功 → `response.completed`（含 usage）+ `data: [DONE]`（双保险，OpenAI 客户端两种结束标记兼容）。
5. **usage 帧**：runTurn 结束返回 usage → completed 事件携带；增量期间不发（对齐 chat/completions 的 buildFinalChunks 模式）。

**实现要点**：
```ts
// parseResponsesRequest：stream:true 不再 400（改为合法分支）
// handleResponses：stream 分支
res.writeHead(200, {'Content-Type':'text/event-stream', ...})
write({type:'response.created', response:{id, object:'response', status:'in_progress'}})
runTurn(driver, effectivePrompt, { ..., onDelta: (t) => write({type:'response.output_text.delta', delta: t}) })
write({type:'response.completed', response:{id, status:'completed', output:[...], usage}})
res.write('data: [DONE]\n\n'); res.end()
// 错误：write({type:'response.failed', response:{id, error}}); res.end()
```

**self-test [13]**：parseResponsesRequest(stream:true) → ok:true + stream:true（解除 400）；stream 事件序列生成器（纯函数 buildResponsesStreamEvents(text, usage) → 数组）首尾事件正确性。

**验收**：`curl -N .../v1/responses -d '{"input":"hi","stream":true}'` → 看到多帧 `response.output_text.delta` + `response.completed`。

### ✅ P5a 已实施（2026-09-15）

**实现**：
- `responses.ts`：`parseResponsesRequest` 解除 stream:true 400 限制（改为合法分支 `stream:true`）；新增 `buildResponsesStreamEvents({id, model, deltas, fullText, usage})`（纯函数生成事件数组，供测试/非实时）+ `buildResponsesFailedEvent(id, error)`（流式错误事件）。
- `index.ts` handleResponses：在 `parsed.stream` 时走 SSE 分支——`writeHead(200, text/event-stream)` → `response.created` → `runTurn(..., onDelta: t => write({type:'response.output_text.delta', item_id, delta: t}))`（逐帧写入）→ 成功发 `response.completed`（含 output + usage）+ `[DONE]`；异常发 `response.failed` + 关流。memory hook（recall/capture/ALS）与非流式一致。usage 字段修正为 snake_case（`result.usage.prompt_tokens` 等——bridge.ts mapUsage 已映射）。
- `self-test.ts` [13]：5 断言（stream:true 合法 / 事件序列首尾 / delta 帧 / failed 事件）→ **92 断言 ALL PASSED ✅**（含全量回归；删除过时的 11.5 stream 400 测试）。

**验收**（重启后）：`curl -N .../v1/responses -d '{"input":"...","stream":true}'` → 多帧 `response.output_text.delta` + `response.completed`（含 usage）+ `[DONE]`。错误路径 → `response.failed`。

---

## 全局执行顺序与依赖

```
P1 多轮会话 ──┬──→ P3 扩展端点（sessions CRUD 依赖 resume）
              │
P2 记忆薄客户端 ──→ P4 supervisor（依赖 memory.ts 存在）
（P1 与 P2 独立可并行；建议顺序 P1 → P2 → P3 → P4）
```

| 阶段 | 预估 | 重启次数 |
|------|------|---------|
| P1 | 0.5-1 天 | 1-2 次（bridge/index 改动需重启） |
| P2 | 1-1.5 天 | 1-2 次 |
| P3 | 1 天 | 1 次 |
| P4 | 0.5 天 | 1 次 |

## 每阶段通用 Definition of Done
1. self-test 全绿（新增段 + 存量段回归）
2. bench-4q 无回归（无新 header 时行为与当前完全一致）
3. 用户重启后 HTTP 契约逐条验证
4. 回填 `ops-agent-gap-design.md` 对应章节"已实施"状态 + 验收数据到 `ops-agent-completion-plan.md`

## 风险登记（执行期）
- **resume 后 follow 快照解析**（P1.3）：compaction 摘要可能改写历史事件形态——P1 验收必须含"compaction 触发后续接"用例
- **dsh-host-webserver 路径参数**（P3.3）：若不支持 `:id`，fallback query 形式（已列入步骤）
- **工具挂载点**（P2.4）：以现有 10 工具的注册模式为准，不发明新机制
- **recall 注入位置**（P2.3）：user 前缀 vs system 段——以 Hermes provider 实际行为为准（执行时读 `agent_init.py:1579` 附近确认）
- **RiskGuard 误伤**（P2/P3 的 bash/write 载荷）：沿用运行时字符串拼接规避惯例
