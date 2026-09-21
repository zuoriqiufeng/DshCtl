# DSH 运维对话 Agent 方案：替代 Hermes api-server 并提速

> 状态：待评审 | 日期：2026-09-11 | 范围：`dsh-plugin/` + agent preset + HTTP api 插件
> 背景：Hermes api-server 对话响应慢（已确认慢因组合：工具链/检索链开销 + 多轮工具调用 + 模型推理）；
> 目标：用 DSH 插件编排实现同等运维对话 Agent，双入口（HTTP api-server + DSH web GUI），响应显著提速。
> 已确认决策：范围=核心先行；检索栈=复用现有 Qdrant（后置阶段）。

---

## 一、调研结论：DSH 原生能力盘点（全部现成，无需发明）

| 需求 | DSH 对应物 | 结论 |
|---|---|---|
| HTTP 服务挂自定义路由 | `dsh-host-webserver`（node:http，插件注册命名路由，exact→prefix→fallback） | ✅ 一个小插件即可挂 REST 端点 |
| 程序化驱动对话 | `dsh-api-session-controller`（`ctx.sessionController`：`create`/`prompt`/`fork`/历史分页/跟随流事件） | ✅ 会话原语齐全 |
| 运维 Agent 独立组合 | `packages/preset`（agent preset = 目录 + `agent.cordis.yml`；**一进程多 agent 共存**，per-session 组合 tools/prompt/skills） | ✅ 原生机制，命名 `i2stream-ops` 即可 |
| 风险护栏 | `dsh-plugin-i2stream-bkn` 的 `tools/pre-execute` waterfall（已挂载运行） | ✅ 已有 |
| BKN 查询工具 | `dsh-plugin-i2stream-bkn` 4 工具（+ContextLoader 优化） | ⚠️ 需补 6~8 个 |
| 模型 | llm-pi-ai（deepseek-v4-flash，settings.yaml 已配；磁盘缓存） | ✅ 可直接用，流式 |

## 二、目标架构

```
                     ┌─ 人 ──→ DSH web GUI (3080) ──┐ 会话用 i2stream-ops preset 组合
调用方 ──┬───────────┤                              ├──────────────┐
         │           └─ 程序(i2Agent/脚本)           │              ↓
         │             → HTTP: POST /ops/v1/chat    │        DSH Agent 会话
         │               (ops-api 插件挂 webserver) │              │
         │                    │                     │    ┌─────────┴──────────┐
         │                    └→ ctx.sessionController(create/prompt/follow) │
         │                                                                   ↓
         └──（阶段3）Qdrant HTTP sidecar ←—— dsh-plugin-i2stream-bkn（12 工具 + 护栏分级 + 状态机）
```

- **ops-api 插件**（~200 行）：注册 `POST /ops/v1/chat`（SSE 流式）+ `GET /ops/v1/health`；内部 `sessionController.create`（preset=i2stream-ops）→ `prompt` → follow 事件转 SSE。
- **i2stream-ops preset**：`agent.cordis.yml` 组合 = BKN 插件 + 精简运维系统提示词 + 模型配置 + 后续 skills。
- **协议**：新定义简单 REST 契约（见 §5 开放决策），不复用 Hermes api-server 线上协议。

## 三、性能策略（对症三类慢因）

### ② 工具链/检索链开销
- TS 原生插件链（无 Python 插件调度开销）；护栏 pre-execute 同步内存判断（μs 级，不增加往返）
- BKN resolver 启动加载一次、内存缓存；ContextLoader Toon 压缩工具返回 token（返回越短，下一轮推理越快）
- **核心阶段不带 supplement/Embedding/BM25 兜底链**（检索后置本身也是提速）

### ③ 多轮工具调用（最大优化空间）
- **preset 提示词内置热路径知识**：从 `network.bkn` 导出高频「操作→Skill」「症状→诊断方向」映射直接进 prompt section——常见问题**零工具调用直接回答**，省掉 1-3 轮 LLM 往返
- **工具返回即答案**：单次调用给足上下文（约束+风险+Skill 指针+知识），模型不需要二次追问
- **去掉 Hermes 的强制多轮行为**：Hermes 的 `_skill_enforcement`（强制加载全部 required skill 才许输出）与 `_model_hint` 维度搜索指引都会增加轮次；DSH preset 按需简化
- 评估 DSH agent-loop 的并行工具调用能力（多工具一批发出，一轮推理解决）

### ④ 模型推理
- 流式输出（TTFT 感知）+ llm-pi-ai 磁盘缓存（重复前缀命中）
- 系统提示词精简（更少 prefill token；更长的缓存前缀）
- provider/模型可配置：若深度对比后 4-flash 不满意可单独为 ops preset 换更快模型（preset 级模型选择）

## 四、分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0 基线** | 采集 Hermes api-server 延迟基线：5-10 个典型运维问题，记录 p50/p95（用户提供调用样本或我们直接调） | 基线表 |
| **1 核心** | ① 补 6 工具（explain_architecture/design_solution/check_compatibility/list_scenarios/get_prerequisites/diagnose_error，纯 BKN 查询）② 护栏分级对齐（severity/blockable/状态机解析，扩展性设计步 0）③ ops preset + 热路径提示词 ④ web GUI 人机验证 | 同样问题集在 DSH web 对话跑通，逐题计时 |
| **2 HTTP** | ops-api 插件（REST+SSE）+ 调用方联调 | i2Agent/脚本调用跑通 |
| **3 检索** | search_qdrant + diagnose_db_link 移植；Qdrant HTTP sidecar（embedding 复用现有服务）；supplement 兜底 | 日志分析/兜底检索场景跑通 |
| **4 skills** | 关键 skills（log-analyzer/db-diagnostics/iadebug…）按 DSH preset skills 组合接入 | 诊断→执行闭环 |

> 阶段 1 完成即达成"对话可用 + 提速可测"；阶段 2 完成即达成"等价替代 Hermes api-server"。

## 五、已确认决策与 api-server 调研结果

1. **HTTP 契约：兼容 Hermes 协议** ✅ 已调研落地口径——Hermes api-server 是 **OpenAI 兼容的 aiohttp 服务**（`gateway/platforms/api_server.py`）：
   - 路由表：`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/capabilities`、`/api/sessions`、`/v1/runs`、`/api/jobs`、`/health*`（multiplex 模式还有 `/p/<profile>/...`）
   - 默认 `http://127.0.0.1:8642/v1`，`API_SERVER_KEY`（Bearer）鉴权，实测在跑：`/health` → `{"status":"ok","platform":"hermes-agent","version":"0.21.1"}`；`/v1/models` → `[{"id":"hermes-agent"}]`
   - **DSH ops-api 插件按此契约实现**：最小兼容面 = `POST /v1/chat/completions`（stream/非 stream）+ `GET /v1/models` + `GET /health`；OpenAI 兼容意味着调用方（i2Agent/任何 OpenAI client）无感替换
2. **基线数据：直接测 Hermes api-server** ✅ 已开始——探测脚本对 8642 发 4 个典型运维问题（建规则/增量卡住/删除约束/错误码），逐题记录墙钟耗时与 usage，结果见下节（探测完成后回填）。
3. **模型**：DSH 侧先用现有 deepseek-v4-flash 起步（阶段 1），对比后再定。

## 六、阶段 0 基线结果（2026-09-14 实测）

探测条件：`POST http://127.0.0.1:8642/v1/chat/completions`，model=`hermes-agent`，非流式，Bearer 鉴权，4 题顺序，curl 超时 300s。

| # | 问题 | 耗时(s) | 答案长度 | total_tokens |
|---|---|---|---|---|
| 1 | 如何创建一条 Oracle 到 MySQL 的增量同步规则？ | 182.5 | 1534 | 334,932 |
| 2 | 增量同步卡住不动了，怎么排查？ | 129.2 | 2127 | 131,320 |
| 3 | 什么情况下禁止删除同步规则？ | 99.1 | 604 | 84,139 |
| 4 | YAS-01001 错误是什么原因？ | **≥300 超时** | — | — |

**结论**：完成的三题耗时 99-182s（p50≈114s），Q4 在 300s 内未完成；token 消耗 8.4 万-33.5 万/题。
- Q1 的 334K tokens 是单题总量（含全部工具往返的累计 prefill）——印证"上下文装配过重 + 多轮串行"是主要慢因；
- Q3（纯风险查询，最简单的知识型问题）也要 99s——说明**热路径问题同样背负全量上下文装配**；
- **DSH 版目标（阶段 1 验收基准）**：同类热路径问题 <15s、千-万级 token；带工具链的诊断问题 <60s。

## 七、风险

| 风险 | 缓解 |
|---|---|
| 提示词内置知识与 BKN 双源漂移 | 热路径提示词由脚本从 network.bkn 导出（bkn-creator 同链路），不手抄 |
| sessionController 驱动会话的权限/信任面 | ops-api 仅挂 loopback 路由（webserver 默认 127.0.0.1）；对外暴露由调用方网络策略控制 |
| 无 Hermes 协议兼容导致联调返工 | §5-1 先确认再动工阶段 2 |
| SSE 与 Cordis 生命周期管理 | ops-api 插件 unload 时中断在途会话；阶段 2 单测覆盖 |

---

*配套：`/hdd/demo/public/dsh-info/code/dsh-plugin/doc/dsh-extensibility-design.md`（扩展性/护栏对齐）、`/hdd/demo/public/dsh-info/code/dsh-plugin/README.md`、`/hdd/demo/public/bkn/l2-integration-design.md`、`/hdd/demo/public/i2stream-bkn/optimize/bkn-utilization-comparison.md`（工具清单与差距基线）*
> 文档位置说明：本文件在 `/hdd/demo/public/dsh-info/doc/`（DSH 方案文档统一归档处）；插件代码已迁至 `/hdd/demo/public/dsh-info/code/dsh-plugin/`（2026-09-14）。
