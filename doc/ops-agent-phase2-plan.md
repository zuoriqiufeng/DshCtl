# Ops Agent 阶段 2 实施计划：OpenAI 兼容 HTTP api-server（ops-api 插件）

> 状态：已评审，开始实施 | 日期：2026-09-14
> 上游：`ops-agent-plan.md` 阶段 2 + 阶段 1 交付（10 工具 + i2stream-ops preset）
> 目标：DSH 侧提供与 Hermes api-server **协议兼容**的 OpenAI 兼容面，调用方（i2Agent/任意 OpenAI client）零改动切换；
> 验收：curl 脚本联调跑通（流式/非流式/鉴权/超时），4 题计时 vs Hermes 基线（182.5/129.2/99.1/≥300s）。

---

## 一、调研结论（计划依据）

| 事实 | 结论 |
|---|---|
| Hermes api-server = OpenAI 兼容 aiohttp（`/v1/chat/completions`+`/v1/models`+`/health`，Bearer `API_SERVER_KEY`）；另有 `/api/sessions/*` 会话面 | 阶段 2 实现 **`/v1` 面 + `/health`**；会话面（`/api/sessions/*`）留待需要时补 |
| `dsh-host-webserver`：`ctx.webServer.register({kind,path,handler})`，exact>prefix>fallback；web profile 已挂 3080 | ops-api 挂**现有 3080 服务**注册 `/v1/*`（协议兼容 ≠ 端口兼容；端口分离可后续加独立 WebServer 实例） |
| `ctx.sessionController`（web profile 已挂 session-controller）：`create({cwd?,agentPreset?})` / `prompt({requestId,sessionId,mode:'queue',content:[{type:'text',text}]})` / `follow({address:{kind:'session',sessionId},assistantStream:true})` / `cancel` | 程序化驱动会话的原语齐全，无需自建 agent loop |
| follow 帧：`assistant-stream`（start/chunk/end，chunk 为 `StreamChunk`：`text-delta{text}`/`usage{usage}`/`finish{reason}`）+ `event`（durable，`assistant/message` 提交） | SSE 映射：text-delta→delta.content；end(committed)→finish；usage→usage 字段 |
| Hermes `/v1/chat/completions` 为无状态语义（请求自带 messages 数组） | 每请求**临时会话**（preset=i2stream-ops）：历史消息压成上下文块 + 最新 user 消息 → 单次 prompt |
| TokenUsage = {inputTokens, outputTokens, totalTokens?} | → OpenAI usage {prompt_tokens, completion_tokens, total_tokens} |

## 二、目标架构

```
调用方（i2Agent / OpenAI client / curl）
   │  POST /v1/chat/completions  (Bearer)
   ▼
DSH web (3080) ── ops-api 插件（本阶段新代码）
   │  exact 路由: /v1/chat/completions, /v1/models, /health
   ▼
会话驱动桥（每请求）
   create(agentPreset=i2stream-ops) → follow(assistantStream) → prompt(队列)
   → 消费 StreamChunk（text-delta 累积 / usage / finish）→ 组装 OpenAI 响应 → dispose
   ▼
i2stream-ops 会话（host 级 bkn-plugin 10 工具 + RiskGuard + 热路径 persona）
```

## 三、工作项

### W1 ops-api 插件骨架（`/hdd/demo/public/dsh-info/code/ops-api/`）

- `index.ts`：`apply(ctx, config)`；`inject=['sessionController','webServer']`（webServer 经 ctx.get 兜底）；
  register 三条路由，unload 时 dispose；Config（Schemastery）：
  | 字段 | 默认 | 说明 |
  |---|---|---|
  | `enabled` | `true` | 总开关 |
  | `preset` | `'i2stream-ops'` | 会话使用的 agent preset |
  | `apiKey` | `''` | Bearer 鉴权 key；空 = 不鉴权（仅建议 loopback 使用） |
  | `turnTimeoutSec` | `120` | 单轮超时（超时→504 + cancel） |
  | `modelId` | `'i2stream-ops'` | /v1/models 与响应中回显的模型名 |

### W2 会话驱动桥（`bridge.ts`）

- `runTurn(text, opts) → { content, usage, finishReason, events }`：
  1. `sessionController.create({ agentPreset })` → sessionId
  2. `follow({address, assistantStream:true}, signal)` 开始消费（先订阅后 prompt，防漏帧）
  3. `prompt({requestId: uuid, sessionId, mode:'queue', content:[{type:'text',text}]})`
  4. 帧消费：`text-delta` 累积 content（`reasoning-delta` 丢弃）；`usage` 记账；`end.outcome.kind==='committed'` → 结束；
     `abandoned` → 报错；超时/客户端断开 → `cancel` + 会话丢弃
  5. 兜底：committed 的 durable `assistant/message` 事件可重构最终文本（流中断时使用）
- 历史压缩：`messages` 数组 → `[上下文] user/assistant 交替摘要 + [当前问题] 最新 user`（无历史则直传）

### W3 OpenAI 协议面（`openai.ts` + 路由 handler）

- `POST /v1/chat/completions`
  - 入参：`{model?, messages:[{role,content}], stream?}`；校验 400（缺 messages/空数组）
  - 非流式：`{id:'chatcmpl-<uuid>', object:'chat.completion', created, model, choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}], usage}`
  - 流式 SSE：`chat.completion.chunk` 逐 delta；结束 `finish_reason:'stop'` + `data: [DONE]`
  - 错误：401 `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)","type":"gateway_auth_error"}}`（对齐 Hermes 错误形状）；504 超时；500 内部错误
- `GET /v1/models` → `{"object":"list","data":[{"id":modelId,"object":"model","owned_by":"dsh"}]}`
- `GET /health` → `{"status":"ok","platform":"dsh-ops-agent","version":<插件版本>,"preset":<preset>}`
- 鉴权：`Authorization: Bearer <apiKey>`（config 非空时强制）

### W4 验证

1. **单测桥逻辑**：StreamChunk 映射/历史压缩为纯函数，`ops-api/self-test.ts` 断言（text-delta 累积、usage 映射、压缩格式、鉴权比对）
2. **挂载**：cordis.patch.yml insert ops-api；`dump-config` 合成正确
3. **联调脚本**（重启后）：`scripts/api-smoke.sh`——health/models/非流式/流式/错误 key 五连测
4. **4 题计时**：阶段 0 脚本改指 3080，逐题计时 vs Hermes 基线，回填本文件

## 四、风险

| 风险 | 缓解 |
|---|---|
| follow 帧消费遗漏或顺序假设错误 | 先 follow 后 prompt；committed durable 事件兜底重构；W4.1 覆盖映射 |
| 3080 同端口暴露 API 面 | loopback 默认 + apiKey 可配；GUI 与 API 同端口仅影响监听面，无路由冲突（exact 优先于 fallback） |
| 每请求临时会话的资源开销 | 会话随请求结束丢弃；超时强制 cancel；后续可加会话复用（`/api/sessions/*` 阶段） |
| preset 未加载/拼错导致会话无工具 | create 返回 agentPreset 校验；不匹配时 500 + 明确错误信息 |
| 超时值与模型慢请求冲突 | 可配 turnTimeoutSec；504 响应带 partial 提示 |

## 五、交付物

- `ops-api/index.ts`（路由+Config）、`ops-api/bridge.ts`（会话驱动）、`ops-api/openai.ts`（协议组装）、`ops-api/self-test.ts`
- `scripts/api-smoke.sh`（联调脚本）
- cordis.patch.yml 第三行 insert（ops-api）
- 本文件 §验收 回填（含 4 题对比表）

---

## 验收（实施后回填）

- [x] ops-api self-test ALL PASSED（27 断言：协议组装 18 + extractMessageText 4 + runTurn mock 5；2026-09-14 实测）
- [x] dump-config 合成正确（ops-api → file:// 新路径，config 五字段齐全）
- [ ] 重启后 smoke：health/models/非流式/流式/鉴权五连测通过（`scripts/api-smoke.sh`）
- [ ] 4 题计时 vs Hermes 基线（回填对比表）

> **实施记录（2026-09-14）**
> - W1/W2/W3 完成：`ops-api/{index,bridge,openai}.ts` + `self-test.ts` + `package.json`；
>   路由挂现有 webserver 3080（exact 优先于 SPA fallback）；会话桥 create→follow→prompt→StreamChunk 消费，
>   多 attempt 语义（仅 `committed+assistant/message` 的 attempt 文本为答案，中间轮丢弃）；
>   durable assistant/message 兜底重构；超时 504+cancel；客户端断开自动中止。
> - 历史压缩：messages 数组 → `[对话上下文] + [当前问题]` 单 prompt（临时会话无状态语义）。
> - 遗留同阶段1：**需重启 `pnpm dsh web`** 才加载新插件（config-only HMR）；重启后先跑
>   `bash scripts/api-smoke.sh`，再跑 4 题计时脚本回填。
