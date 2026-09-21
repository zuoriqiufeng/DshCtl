# AGENTS.md — dsh-info 工作区公用规则

> 适用范围：本工作区全部子目录（`doc/`、`code/`、`deepseek-harness/`）。
> 来源：ops-agent 系列方案文档与实施沉淀（2026-09-14 ~ 09-15），冲突时以最新回填的 plan 文档为准。

---

## 1. 工作区结构与职责边界

| 路径 | 职责 | 规则 |
|---|---|---|
| `doc/` | 方案文档统一归档处 | 所有方案/实施计划/验收回填只放这里；插件内 `doc/` 仅放实现设计 |
| `code/dsh-plugin/` | BKN 插件（TS，12 工具 + 护栏 + 检索栈） | 外部插件，不进 harness 仓 |
| `code/ops-api/` | api-server + 会话桥 + 记忆 + supervisor | 外部插件，不进 harness 仓 |
| `code/ops-skill-manager/` | 技能自管理插件（skill_manage 工具 + usage 台账 + curator 迁移） | 外部插件，不进 harness 仓 |
| `code/dshctl/` | 领域编排 CLI（v0.1~v1.1 全量；使用手册 `doc/dshctl-manual.md`） | 交付期工具，只读写文件与配置 |
| `plugin-registry/` | 插件库：registry.yml 目录 + core.yml 核心功能清单（R11 红线：功能不可缺、功能槽内实现可替换；任何核心 id 可经 slots 声明替代成员后替换）+ sources/ 导入件 | 登记引用为主；git/zip 导入件 trusted=false 需人工信任 |
| `code/presets/i2stream-ops/` | 运维 agent preset（persona + 热路径） | 热路径块由脚本生成，禁止手改 |
| `code/sidecars/` | Python sidecar（embed-server） | 独立进程，不挂 DSH 生命周期 |
| `code/scripts/` | 生成/计时/冒烟脚本 | — |
| `doc/gernalarrange/` | 领域编排通用方案 + dshctl 设计 | 跨领域复用资产 |
| `deepseek-harness/` | 上游 DSH 源码副本（编排试验田） | **对上游源码净改动 = 0**（见 §6） |
| 共享 BKN | `/hdd/demo/public/i2stream-bkn/bkn` | 与 Hermes 工作区共用一份，只读消费 |

## 2. 工作流规则（每阶段通用 Definition of Done）

1. **实施顺序**：逐阶段实施 → self-test 全绿 → 重启 `pnpm dsh web` → HTTP 契约逐条验证 → **回填 plan 文档**（§验收 / 回填记录）。
2. self-test 必须**存量断言不破 + 新增段全绿**；bench-4q 无回归（无新 header 时行为与改动前完全一致）。
3. **踩坑必须沉淀**：实施中发现的坑写进对应 plan 文档（格式：症状/根因/修复），协议类知识写成"协议要点"小节。
4. 验收只认 live 实测数据（curl/脚本输出回填表格），不认"代码写完即验收"。
5. 计划文档状态流转：`待评审 → 已评审，开始实施 → ✅ 已实施 + 验收结果回填`。

## 3. 对齐与设计原则

- **与 Hermes 行为 1:1 优先**：schema、阈值、超时、熔断/背压数值、错误形状均以 Hermes 实现为准；共用同一份 BKN 时同题必须同答。存在偏差（如 BM25 分词器）要显式记录为"已知偏差"。
- **降级铁律（H-15）**：记忆、检索等**非关键路径**失败绝不让请求失败——失败路径返回空值/静默 + warn 日志，绝不抛错。
- **BKN 边界**：BKN 只给语义、分析方向、风险上下文与 Skill 指针，**绝不返回可执行命令串**；工具输出经 `_filterCommandFields` 清洗。
- **约定优先于配置**：能从 BKN 推导的不进配置（防双源漂移）；脚本生成物（hotpath.md）只接受重新生成，不接受手改。
- **回退只有一层**：配置缺失 → 内置常量（= i2Stream 当前行为）。
- **诚实原则**：无对应 API 的能力显式 405/400 说明，不造假、不静默忽略。

## 4. DSH/Cordis 编码规则

- 注册工具：`ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`；不发明新机制。
- 护栏挂 `ctx.on('tools/pre-execute', ...)` waterfall；**waterfall 事件用 `ctx.on` 注册**，`ctx.waterfall(...)` 是调用方入口。
- 未在 `inject` 声明的属性访问会被上下文代理拒绝；缺失服务用 `ctx.get('xxx')` 兜底（返回 undefined）。
- per-request 上下文（如 memoryKey）用 **AsyncLocalStorage** 穿透工具注册链；无 store 的路径（GUI 会话）给空结果 + 提示语。
- 类型限制：联合类型用 `type`（esbuild 不支持 `interface A | B`）；`Schema.union().of()` 在当前 schemastery 版本不可用——枚举配置用 `Schema.string()` + normalize。
- **preset 组合（agent.cordis.yml）只放会话级插件**（persona/skills 等）；进程级服务（compaction/mcp/storage）一律走 host 层或 bundle 默认——preset 挂 process-global 服务会触发 DSH 隔离约束导致全请求 500。
- **config-only HMR**：改配置（cordis.patch.yml）保存即热重载；**改插件源码必须重启** `pnpm dsh web` 才生效。
- **新增 config 段时两处都要改**：schema default + `cordis.patch.yml`（只改 schema 不会自动启用）。
- `dsh-host-webserver` 的 `webServer` 是 `super(ctx,'webServer')` **单例 Service**——禁止 mount 第二个实例；多端口用自建 `node:http` server。

## 5. ops-api 会话协议要点（bridge 维护必读）

- **follow 必须在 prompt 之前打开**：晚开错过 attempt start → revision 校验抛错 → abandoned。
- follow 帧序：`snapshot{records}`（含历史 durable 事件）→ 交错的 `event{event}` 与 `assistant-stream{frame}`。
- **`eventType=assistant/message` 不代表 turn 终局**——带文本+工具调用的中间步也结算为 assistant/message；turn 终局唯一定位是 **`turn/end` durable 事件**（命中立即 return，否则拖到超时）。
- durable assistant/message 的真实形状是 `{turn, step, message:{content:[{type:'text'}...]}}`（嵌套），提取走 `extractMessageText` 递归。
- resume 场景用 **armed 首帧武装**启发式防污染：prompt 后第一帧才计入本轮，旧回合 snapshot/event 文本与 stale turn/end 全部忽略。
- 最终答案语义：保留最近一次非空 committed 文本；全无文本且 abandoned → `TurnAbandonedError`。

## 6. 对上游 harness 的编排规则（deepseek-harness）

- **不 fork、不改不删上游任何行**：编排 = 新增增量 bundle 层（`dsh-ops-app`），按 id `disabled: true` 裁剪，不引用上游行内容。
- 资产分层：L0 纯增量声明（自动跟随）/ L1 外部插件（按公开契约面跟随，self-test 守护）/ L2 源码直改（**禁止出现**）。
- 升级 5 步：install → `--dump-config` diff 组合面（核对 disable 的 id 是否仍存在/上游新增行）→ self-test 契约面 → 管理面校验 → 回填版本记录到 plan §8。
- 试验实例用独立 `DSH_HOME`（`.dsh-home`）与独立端口（api :8643，headless），与现网完全隔离。

## 7. 风险护栏（RiskGuard）规则

- blockable 口径：仅 `severity=critical && errorCode 非空` 才阻断；非 blockable 命中记 warn 放行（advisory）。
- `mutatingTools` 默认只含命令执行类（`bash/run_code/terminal/execute_code/shell`）；**write/edit/patch 不参与指纹识别**（对源码/文档编辑必然误伤）。
- 测试/脚本中的命令载荷沿用**运行时字符串拼接**规避护栏误伤的惯例。

## 8. 验证命令速查

```sh
# self-test（在 /hdd/agent/deepseek-harness 下运行）
node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts
node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-api/self-test.ts

# 计时与联调
bash /hdd/demo/public/dsh-info/code/scripts/bench-tools.ts   # 工具层 <100ms/次
bash /hdd/demo/public/dsh-info/code/scripts/bench-4q.sh http://127.0.0.1:3080 i2stream-ops
bash /hdd/demo/public/dsh-info/code/scripts/api-smoke.sh

# dshctl（自带 tsx，任意目录可跑，无需 cd）
dshctl check ops --ci
dshctl plugin list   # 插件库一览（core 必须件 + extension）
dshctl-selftest   # 或 bash /hdd/demo/public/dsh-info/code/dshctl/ci.sh（五环节一键）

# embed sidecar
HF_HOME=/hdd/demo/public/chunk/HuggingFace HF_HUB_OFFLINE=1 \
  /hdd/demo/public/venv/bin/python /hdd/demo/public/dsh-info/code/sidecars/embed-server.py --port 8096 &
curl http://127.0.0.1:8096/health
```

## 9. 服务端口约定

| 服务 | 端口 | 说明 |
|---|---|---|
| DSH web GUI（现网） | 3080 | loopback |
| DSH 试验实例（ops） | 8643 | 独立 DSH_HOME；headless（E5 后无 web 面），API + /admin 同端口 |
| api-server（试验，ops-api 自建 listener） | 8643 | 强制 Bearer；独立 node:http server |
| api-server（原规划目标） | 8642 | **已被 hermes-gateway 占用**（Hermes api_server 平台，i2agent 在用，external 基础设施）——与 DSH 无关，不登记不回收；DSH api-server 已避让至 8643 |
| Qdrant | 6333 | env `I2STREAM_QDRANT_URL` |
| embed sidecar | 8096 | env `I2STREAM_EMBED_URL` |
| MemoryCore Gateway | 8420 | 记忆；当前由现网 supervisor 托管，待转 systemd 独立 unit |
| i2agent MCP | 8090 | 远程受控执行面 |

## 10. 文档与命名惯例

- plan 文档命名：`ops-agent-<主题>-plan.md`（方案）/ `ops-agent-<主题>-design.md`（设计）。
- 验收表格用例例编号（A1/A2…）+ ✅/⚠️/❌ + 一句话证据；观察项（非阻断）标 ⚠️ 并解释归属。
- 中文行文；工具名/字段名/代码标识保持英文原样。
