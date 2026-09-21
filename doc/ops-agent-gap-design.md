# i2Stream Ops-Agent 补齐设计：多轮会话 / 扩展端点 / 记忆层

> 2026-09-15 · 基于 Hermes 功能对齐审计 + DSH 生态调研
> 前置：`ops-agent-completion-plan.md`（W1-W3 已交付）、本文档覆盖"完全替代 Hermes"剩余三类差距

## 0. 背景与差距清单

| # | 差距 | Hermes 现状 | DSH 现状 | 影响 |
|---|------|------------|----------|------|
| G1 | 多轮会话 | `X-Hermes-Session-Id` header 续接对话窗口 | ops-api 每请求 `create→dispose` 临时会话，无状态 | 调用方依赖多轮上下文时不兼容 |
| G2 | 扩展端点 | `/v1/responses`、`/v1/capabilities`、`/api/sessions/*` | 仅 `/health` `/v1/models` `/v1/chat/completions` | 指定调用方（i2Agent planner 等）可能用到 |
| G3 | 长期记忆 | `X-Hermes-Session-Key` → Memory/MemPalace（本地 sqlite `memory_entries` + 可接第三方如 TencentDB） | **无** | 跨会话知识积累能力缺失 |

**调研结论（社区/内置复用可行性）**：

- DSH **没有**独立长期记忆包（全仓 `memory` 搜索无 match）。最接近的能力：
  - `session-query` 家族：durable 会话历史检索（SQLite FTS + 五件套工具）——**可作记忆底座之一**
  - `compaction` 家族：会话内压缩摘要——不是跨会话记忆
  - `context/session-reference`：跨会话快照引用（只读、bounded、防注入）——语义参考
  - `storage` 家族：非会话持久化（json/sqlite 后端 + typed records）——持久层备选
  - `api/session-controller`：已支持 `resume`/`fork`/`prompt`/`follow` 全套会话生命周期——**多轮会话直接可用**
- **第三方记忆的真相**（实地核查 `/hdd/demo/TencentDB-Agent-Memory/MemoryCore/`）：Hermes 的 TencentDB 记忆
  是一个**独立可移植的 Node.js Gateway sidecar**（四层记忆 L0-L3，HTTP :8420），Hermes 自身只是薄客户端。
  结论：**G1 不造轮子**（用 session-controller resume）；**G2 自建薄层**（ops-api 内加路由，无社区对应物）；
  **G3 也不造轮子**（DSH 写同款薄客户端插件对接同一 Gateway，四层管道/TencentDB 存储全部原样复用，数据零迁移）。

---

## 1. G1 多轮会话（不造轮子：session-controller resume）

### 1.1 语义（对齐 Hermes）

- Header：`X-Ops-Session-Id`（兼容别名 `X-Hermes-Session-Id`，同读同写）
- 不传 → 新会话（现状行为不变），响应头返回新派发 id
- 传入已知 id → **resume 同一 DSH session 继续对话**（上下文延续）
- 传入未知 id → 400（对齐 Hermes 行为：不静默创建）
- 响应头 `X-Ops-Session-Id` 回显生效值（body 保持纯 OpenAI 格式，对齐 Hermes FAQ）

### 1.2 实现路径（复用 DSH 内置能力）

```
ops-api/index.ts 路由层:
  sessionKey = header(X-Ops-Session-Id) 或 body.session_id(扩展字段,可选)
  if (!sessionKey)  sessionId = await sc.create({cwd, agentPreset})   // 现状
  else              sessionId = await sc.resume({sessionId: sessionKey}) // 复用 resume
  bridge.runTurn(driver, prompt, {sessionId, ...})                    // 复用 follow/prompt
  response.setHeader('X-Ops-Session-Id', sessionId)
```

- `SessionDriver` 增加 `resume(req)` 方法，适配 `ctx.sessionController.resume`
- `runTurn` 增加 `sessionId?` 入参：传入则跳过 `create`
- **follow 时序不变**（先开 consume 再 prompt——bridge 已验证的正确时序）
- 会话复用后的 follow 快照包含历史事件：extractMessageText 兜底只取**本 turn** 的文本——`consume` 的 snapshot 分支需跳过 `seq <= turnStartSeq` 的历史 assistant/message（用 prompt 返回后的第一个 `turn/start` 事件为界）

### 1.3 上下文增长控制

- Hermes 有 `compression.threshold` 自动压缩；DSH 侧**已有** `compaction-basic`（token 压力触发自动摘要），preset 组合挂载即可，不自建：
  ```yaml
  - name: '@deepseek-ai/dsh-compaction-basic'
    config: { threshold: 0.8 }   # 具体字段名以包 README 为准
  ```
- 超限兜底：resume 时若 session 事件数 > 阈值（配置 `maxTurnsPerSession`），ops-api 主动开新会话并在响应头加 `X-Ops-Session-Renewed: 1`

### 1.4 配置

```yaml
- id: ops-api
  config:
    session:
      enabled: true              # G1 开关
      headerNames: [X-Ops-Session-Id, X-Hermes-Session-Id]
      maxTurnsPerSession: 50     # 0=不限制（依赖 compaction）
      unknownIdPolicy: reject    # reject | create-new
```

---

## 2. G2 扩展端点（薄层自建，无社区对应物）

### 2.1 端点清单与语义

| 端点 | 语义 | 实现 |
|------|------|------|
| `GET /v1/capabilities` | 平台能力声明：模型列表、工具数、skills、记忆/多轮支持位图、limits | 静态组装（preset 元数据 + 配置），不走 LLM |
| `GET /v1/responses`（POST） | OpenAI Responses API 子集：`input` 字符串/数组 → `output` 数组 | 翻译层：input→messages → 复用 runTurn → 组装 response object |
| `GET /api/sessions` | 会话列表（id/title/created/turnCount） | `ctx.sessionQuery` 列表 API |
| `GET /api/sessions/{id}` | 单会话详情 + 消息历史（分页） | `ctx.sessionQuery` history pages |
| `DELETE /api/sessions/{id}` | 归档/删除会话 | sessionController commands（若有 delete；否则标记归档位） |

### 2.2 `/v1/responses` 翻译规则（子集）

```jsonc
请求: { "model": "i2stream-ops", "input": "问题" | [{role, content}...], "stream": false }
响应: {
  "id": "resp_...", "object": "response", "model": "...",
  "output": [
    { "type": "message", "role": "assistant",
      "content": [{ "type": "output_text", "text": "..." }] }
  ],
  "usage": { "input_tokens": ..., "output_tokens": ... }
}
```
- 不支持的字段（tools/functions/reasoning config）显式 400，不静默忽略
- `stream: true` 首期不支持（400），二期按 SSE `response.output_text.delta` 事件补

### 2.3 `/v1/capabilities` 响应

```jsonc
{
  "platform": "dsh-ops-agent", "version": "0.2.0",
  "models": [{ "id": "i2stream-ops", "object": "model" }],
  "features": {
    "chat.completions": true, "responses": true,
    "multi_turn_session": true, "memory": true,
    "streaming": true, "tools": 10, "skills": 26
  },
  "limits": { "max_tokens_per_request": 8000, "max_session_turns": 50 }
}
```

---

## 3. G3 记忆层（复用 TencentDB MemoryCore Gateway：DSH 写薄客户端，不自建四层管道）

> **调研修正**（2026-09-15 实地核查 `/hdd/demo/TencentDB-Agent-Memory/MemoryCore/`）：
> Hermes 的"TencentDB 记忆"不是 `state.db` 里的简单 `memory_entries` 表（那是旧版本地记忆），
> 而是**独立的四层记忆系统**，重活全部在 Node.js Gateway sidecar（默认 127.0.0.1:8420）：
>
> ```
> L0 会话捕获 → L1 情节记忆抽取(LLM+向量去重) → L2 场景块(Markdown) → L3 人设合成(persona.md)
> ```
>
> Hermes 侧 `hermes-plugin/memory/memory_tencentdb/` 只是薄 HTTP 客户端 + 进程 supervisor：
> `prefetch→/recall`（同步，取 `<memory-context>` 注入）、`sync_turn→/capture`（fire-and-forget，
> 最多 4 in-flight 背压）、`shutdown→/session/end`（flush 管道）、外加 3 个 LLM 工具
> （memory_search / conversation_search / read_scene）。
> 存储可插拔：`IMemoryStore`（sqlite+sqlite-vec / **Tencent Cloud VectorDB**）+
> `IStorageBackend`（local-fs / **腾讯云 COS** 存 L2/L3 文件）。
>
> **结论：Gateway 本身就是"第三方记忆"的完整实现且可移植（HTTP 服务，不依赖 Hermes）。
> DSH 对齐方式 = 写同款薄客户端插件，数据零迁移。**

### 3.1 架构（DSH 侧新增两个模块，Gateway 原样复用）

```
┌─ DSH 进程 ──────────────────────────────────────────┐
│  ops-api/index.ts 路由层                            │
│    header: X-Ops-Memory-Key（兼容 X-Hermes-         │
│    Session-Key）→ session_key                       │
│    prompt 前: await memory.recall(key, query)       │
│      → context 非空则追加为消息前缀（见 3.3）        │
│    turn 结束后: memory.capture(key, user, answer)   │
│      → 不阻塞响应（fire-and-forget，见 3.4）        │
│    会话结束: memory.sessionEnd(key)                 │
│                                                      │
│  dsh-plugin/memory.ts（新，对标 memory_tencentdb/   │
│    __init__.py + client.py + supervisor.py）         │
│    ctx.opsMemory = { recall, capture, sessionEnd,    │
│      searchMemories, searchConversations, readScene, │
│      health }                                        │
│    ├─ HTTP 客户端 → Gateway /recall /capture /       │
│    │  /search/* /session/end /health                 │
│    ├─ 熔断器: 连续 5 次失败 → 停 60s（对齐）         │
│    ├─ 背压: capture 在途 ≤4，第 5 个等最旧完成       │
│    │  （DSH 侧用队列实现，无需线程）                  │
│    └─ Gateway supervisor: 可选托管启动（spawn +      │
│       /health 轮询 30s + stderr 转储），或仅连接      │
│       已有实例                                      │
└────────────────────── HTTP :8420 ───────────────────┘
┌─ MemoryCore Gateway sidecar（原样复用，不动）────────┐
│  L0/L1/L2/L3 管道 + IMemoryStore(               │
│  sqlite-vec | TCVDB) + IStorageBackend(local|COS)    │
└──────────────────────────────────────────────────────┘
```

**为什么这样设计**：
- 四层抽取管道（LLM 抽取、向量去重、场景块、人设合成）是复杂资产，重写 = 纯浪费；Gateway 是独立 HTTP 服务，与 Hermes 零耦合
- 复用同一 Gateway + 同一数据目录（`~/.memory-tencentdb/`）→ **Hermes 期记忆零迁移**，DSH 会话直接能回忆
- TencentDB（TCVDB 向量库 + COS 文件存储）作为 Gateway 配置存在，DSH 侧无感——客户合规要求落 TCVDB 时只改 Gateway 配置
- Hermes provider 的可靠性设计（熔断/背压/监督启动）已在生产验证，1:1 移植

### 3.2 DSH 插件接口设计

```ts
// dsh-plugin/memory.ts —— ctx.opsMemory
interface OpsMemoryService {
  /** prompt 前同步召回；失败/熔断返回 ''，绝不抛错（记忆是非关键路径） */
  recall(sessionKey: string, query: string): Promise<RecallResult>
  /** turn 提交后异步捕获（背压队列） */
  capture(req: { sessionKey: string, sessionId?: string,
                 userContent: string, assistantContent: string }): void
  /** 会话/进程结束 flush */
  sessionEnd(sessionKey: string): Promise<void>
  /** 三个 LLM 工具的底层（工具本体挂 ops-api preset 工具表） */
  searchMemories(query, opts?): Promise<SearchResult>
  searchConversations(query, opts?): Promise<SearchResult>
  readScene(sceneId: string): Promise<string>
  health(): Promise<{ ok: boolean, degraded?: string }>
}
interface RecallResult { context: string, strategy: string, memoryCount: number }
```

配置：
```yaml
- id: ops-memory
  config:
    gateway:
      url: "http://127.0.0.1:8420"
      apiKey: "${TDAI_GATEWAY_API_KEY}"   # 走 DSH credentials 注入，不落明文
      autoStart: true                      # supervisor 托管 sidecar 启动
      command: "npx memory-tencentdb gateway"   # 或绝对路径
      healthTimeoutSec: 30
    reliability:
      breakerThreshold: 5          # 连续失败熔断
      breakerCooldownSec: 60
      captureMaxInFlight: 4
      captureWaitMs: 5000
    tools: { enabled: true, prefix: "memory_tencentdb_" }  # 3 个 LLM 工具挂载开关
```

### 3.3 recall 注入语义（对齐 Hermes prefetch）

- `POST /recall {query, session_key}` → `{context, strategy, memory_count, code, message, retryable}`
- `context` 非空 → 作为**用户消息前缀**注入（Gateway 侧已渲染为 `<memory-context>` 段；
  保留原格式注入，禁止 DSH 二次改写，保证与 Hermes 行为一致）
- `code != 0`（EmbeddingService 不可用/VDB 超时）→ 记日志、返回空 context，**不影响本轮问答**（H-15 语义：recall 失败 ≠ 请求失败）
- 注入端到端时序：`recall(同步, 带 2s 超时降级) → prompt → runTurn → capture(异步)`

### 3.4 LLM 工具挂载（对齐 Hermes get_tool_schemas）

Gateway 工具 1:1 挂到 ops-api preset（`schema 转 DSH tool 格式`，handler 调 ctx.opsMemory 对应方法）：

| 工具名 | 端点 | 说明 |
|--------|------|------|
| `memory_tencentdb_memory_search` | `/search/memories` | L1 情节记忆检索（type: persona/episodic/instruction） |
| `memory_tencentdb_conversation_search` | `/search/conversations` | L0 原始对话检索（L1 未命中时的兜底） |
| `memory_tencentdb_read_scene` | `/search/scenes`（read） | 按名读 L2 场景块全文 |

- header 映射：工具调用透传当前请求的 `session_key`（无记忆 key 的会话返回空结果+提示语）

### 3.5 Header 语义（1:1 对齐 Hermes）

- `X-Ops-Memory-Key`（兼容别名 `X-Hermes-Session-Key` 同读）：稳定租户标识 → `session_key`
- 与 Session-Id 完全独立（可只传其一/都传/都不传）；不传 → 无记忆注入、不 capture
- 约束对齐：长度 ≤255、禁 `\r\n\0`、需鉴权

### 3.6 部署形态

| 形态 | 说明 |
|------|------|
| A. 独立 Gateway（推荐） | 运维单独起 MemoryCore（systemd 托管），DSH `autoStart: false` 仅连接——与 Hermes 共存期可共享同一 Gateway |
| B. DSH 托管 | `autoStart: true`，ops-memory 插件 spawn sidecar + 健康轮询——单机独立部署 |

存储配置（Gateway 侧，与 DSH 无关）：默认 sqlite+sqlite-vec；客户合规要求 → Gateway 配置切 TCVDB+COS（`IMemoryStore`/`IStorageBackend` 已支持）。

---

## 4. 实施排序与验收

| 阶段 | 内容 | 工作量估计 | 验收 |
|------|------|-----------|------|
| P1 | G1 多轮会话（resume 复用 + header + compaction 挂载） | 0.5-1 天 | 同 sessionKey 两问第二问能引用上文；unknown id 400；响应头回显 |
| P2 | G3 记忆薄客户端 `dsh-plugin/memory.ts`（recall/capture/sessionEnd + 熔断/背压 + 3 工具挂载）对接已有 Gateway | 1-1.5 天 | 跨会话"你还记得…"测试：A 会话告知事实 → B 会话能复述（Hermes 期数据直接可回忆）；Gateway 停机时本轮问答不受影响（降级空记忆）；工具搜索返回记忆 |
| P3 | G2 扩展端点（capabilities/responses/sessions CRUD） | 1 天 | curl 逐端点契约测试；responses 子集翻译正确 |
| P4 | Gateway 托管启动（supervisor 移植）+ 部署文档 | 0.5 天 | kill Gateway 后自动拉起；/health 轮询 + stderr 转储 |
| P5 | （按需）`/v1/responses` 流式；Gateway 存储切 TCVDB+COS（纯 Gateway 配置，DSH 无改动） | 按需 | 客户合规场景验证 |

**依赖关系**：P1→P3(sessions CRUD 依赖 resume 语义稳定)；P2 独立可并行（只依赖 Gateway 在跑）；P4 依赖 P2。
**无数据迁移工作项**：P2 复用同一 Gateway 数据目录（`~/.memory-tencentdb/`），Hermes 期记忆天然共享。

**风险**：
- 记忆噪声（错误事实固化）→ 保守写入策略 + minScore 阈值 + forget 端点兜底
- 多轮 token 膨胀 → compaction-basic 自动摘要 + maxTurnsPerSession 兜底
- header 兼容漂移 → 双 header 名同读 + 契约测试锁行为

**不做的事**（明确边界）：
- 不实现 Hermes `/v1/responses` 的全量特性（仅子集，显式拒绝未知字段）
- 不自建向量库/嵌入服务、**不重写四层记忆管道**（L0-L3 抽取/场景/人设全在 MemoryCore Gateway，原样复用）
- 不自建记忆存储后端（sqlite-vec/TCVDB/COS 均为 Gateway 既有配置项）
- 不做 DSH 侧记忆格式转换（共享 Gateway 数据目录，零迁移）
