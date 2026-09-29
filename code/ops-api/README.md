# ops-api — OpenAI 兼容 HTTP api-server（DSH 领域实例的 API 面）

把 DSH 会话驱动包成 Hermes api-server 同形状的 `/v1` 面（`/v1/chat/completions`、`/v1/responses`、
`/v1/models`、`/api/sessions`、`/health`），供 i2agent / Hermes 侧既有客户端零改造接入。
形状与错误体对齐 `hermes-gateway`（`gateway/platforms/api_server.py`）。

> **位置**：`/hdd/demo/public/dsh-info/code/ops-api/`。挂载由 profile patch 的 `ops-api` insert 行完成，
> config 由 `domains/<域>/domain.yml` 的 `api_server` / `memory` 段经 `dshctl apply` 渲染
> （见 `code/dshctl/render.ts`——**本插件的 config 由 dshctl 专用段合成，不是手写 patch**）。

## 文件

```
ops-api/
├── index.ts       插件入口：config schema + 路由挂载 + /admin 静态页
├── bridge.ts      会话桥：create → follow → prompt → 消费 StreamChunk（含 resume/armed 首帧）
├── openai.ts      OpenAI 兼容请求/响应/SSE 形状
├── responses.ts   /v1/responses（Responses API 子集）
├── memory.ts      MemoryCore Gateway 客户端 + 3 个检索工具（recall/search/capture）
├── supervisor.ts  记忆网关托管（autoStart 时拉起子进程并探活）
├── admin.ts       /admin 托管面：patch 托管段 / 技能启停 / MCP 增删
├── admin-html.ts  /admin 单页
└── self-test.ts   独立自测（node --import tsx/esm self-test.ts）
```

## 外部依赖（需自行部署/提供）

| 依赖 | 用途 | 配置项 | 不可用时行为 |
|---|---|---|---|
| **Agent preset** | 每个会话挂载的能力组合（v0.1.7 起为 profile patch 内的 `preset-<id>` 声明行） | `preset`（**必填**，与声明行 id 一致；缺省 fail-loud 拒启） | 启动期报错（诚实原则：不默认猜） |
| **MemoryCore Gateway**（:8420） | 跨会话记忆：`recall` / `search` / `capture` 工具 + 会话 payload 注入 | `memory.gatewayUrl`、`memory.gatewayApiKey`（空=不鉴权）、`memory.gatewayCmd`/`gatewayCwd`/`logDir`（`autoStart` 托管时用） | `memory.enabled=false` 时整段跳过；开启但不可达 → 检索工具返回空 + warn（**非关键路径，绝不让请求失败**，H-15） |
| **/admin 依赖探活** | 管理面显示外部依赖健康点 | `admin.healthDeps: [{name,url}]`（如 i2agent `http://127.0.0.1:8090`） | 不可达显示红点，不影响服务 |
| **技能目录** | /admin 技能启停（目录改名）+ 技能清单 | `admin.skillsDir`（**admin.enabled 时必填**，缺失会抛错——配 `$DSH_HOME/skills`） | 启动期报错 |
| **profile patch 路径** | /admin 托管段读写（MCP 增删写入标记区） | `admin.patchPath`（`$DSH_HOME/profiles/<域>/cordis.patch.yml`） | 写操作报错，只读正常 |

## Config 全字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件开关 |
| `platform` / `version` | `dsh-domain-agent` / `0.3.0` | `/health` 与 capabilities 回报 |
| `preset` | 无（**必填**） | 会话挂载的 agent preset id |
| `modelId` | 无（**必填**） | `/v1/models` 与响应体里的模型名 |
| `apiKey` | `''` | GUI 面共享 handler 的内部 key（apiServer 面用 `apiServer.apiKey`） |
| `cwd` | `''`→`$DSH_HOME`→`cwd` | 会话工作目录 |
| `turnTimeoutSec` | `120` | 单轮超时（须 ≥ 域清单 `max_task_duration_sec`，R7） |
| `apiServer.enabled` | `false` | 自建 listener 开关（不挂 webserver，独立端口） |
| `apiServer.host` / `port` | `127.0.0.1` / `8643` | 监听地址与端口 |
| `apiServer.apiKey` | `''` | Bearer key；**经 patch `!!js process.env.OPS_API_KEY ?? ''` 注入，密钥永不落盘** |
| `session.enabled` | `true` | 多轮会话（`X-Ops-Session-Id` / `X-Hermes-Session-Id` 续接） |
| `session.headerNames` | `[X-Ops-Session-Id, X-Hermes-Session-Id]` | 会话头名 |
| `session.maxTurnsPerSession` | `0`（不限） | 单会话轮数上限 |
| `session.unknownIdPolicy` | `reject` | 未知会话 id 策略 |
| `memory.enabled` | `false` | 记忆分片开关 |
| `memory.headerNames` | `[X-Ops-Memory-Key, X-Hermes-Session-Key]` | 记忆 key 头 |
| `memory.gatewayUrl` | `http://127.0.0.1:8420` | MemoryCore Gateway 地址 |
| `memory.gatewayApiKey` | `''` | 网关鉴权（`TDAI_GATEWAY_API_KEY` 语义；由 patch 注入） |
| `memory.toolsEnabled` | `true` | 挂 3 个记忆检索工具 |
| `memory.autoStart` | `false` | 是否托管拉起网关子进程（现网由独立 unit 托管，保持 false 防抢 8420） |
| `memory.gatewayCmd` / `gatewayCwd` / `logDir` | node tsx 启动 / MemoryCore 目录 / `~/.dsh/logs/memory-tencentdb` | autoStart 时用 |
| `admin.enabled` | `false` | /admin 管理面 |
| `admin.adminKey` | `''` | 管理面 Bearer key（`OPS_ADMIN_KEY` 注入） |
| `admin.patchPath` | `''` | 托管段读写的 profile patch 路径 |
| `admin.skillsDir` | `''` | 技能目录（admin 启用时必填） |
| `admin.healthDeps` | `[]` | 依赖健康探测清单 |

## 密钥约定

- **清单只记 env 名**（`api_key_env: OPS_API_KEY`，R8 校验字面值）；值经 systemd `EnvironmentFile`
  （`.dsh-home/ops.env`，600）注入，patch 里是 `!!js process.env.X ?? ''` 表达式。
- `/admin` 与 `/v1` 用两把独立 key：`OPS_ADMIN_KEY` / `OPS_API_KEY`；非回环绑定必须配 key（fail-loud）。

## 会话协议要点（bridge 维护必读）

- **follow 必须在 prompt 之前打开**：晚开错过 attempt start → revision 校验抛错 → abandoned。
- follow 帧序：`snapshot{records}`（含历史 durable 事件）→ 交错的 `event{event}` 与 `assistant-stream{frame}`。
- **`eventType=assistant/message` 不代表 turn 终局**——带文本+工具调用的中间步也结算为 assistant/message；
  turn 终局唯一定位是 **`turn/end` durable 事件**（命中立即 return，否则拖到超时）。
- durable assistant/message 的真实形状是 `{turn, step, message:{content:[{type:'text'}...]}}`（嵌套），
  提取走 `extractMessageText` 递归。
- resume 场景用 **armed 首帧武装**启发式防污染：prompt 后第一帧才计入本轮，旧回合 snapshot/event 文本与
  stale turn/end 全部忽略。
- 最终答案语义：保留最近一次非空 committed 文本；全无文本且 abandoned → `TurnAbandonedError`。

## 自测

```sh
cd /hdd/demo/public/dsh-info/deepseek-harness
node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-api/self-test.ts
```

联调（8643 试验实例，key 见 `.dsh-home/ops.env`）：

```sh
bash /hdd/demo/public/dsh-info/code/scripts/api-smoke.sh http://127.0.0.1:8643 "$OPS_API_KEY"
```
