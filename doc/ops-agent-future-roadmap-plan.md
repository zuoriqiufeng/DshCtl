# 运维 Agent 增强路线图：新增插件 / 项目思想 / 功能缺口

> 2026-11-01 · 状态：**已评审，开始实施**（P0+P1 已由 `ops-agent-enhance-exec-plan.md` 实施并回填验收，2026-11-03；**P1.5 审计批次由 `ops-agent-audit-hardening-exec-plan.md` 实施**，2026-11-05；P2/P3 待排期）

---

## 10. 审计遗留项（2026-11-05 工作流产出，未实施）

来源：《功能调研与优化审计报告》（四视角独立审计 + 独立复核 + 换人复审）。

**工程护栏（medium）**
- K12：pack 资源越界扫描（runtime 相对资源读取无护栏）→ 并入 boundary-direction §8 开放项③
- K13：BKN 漂移监控进 check（BKN mtime/hash 快照比对，变更 warn 提示重跑 gen-intent-taxonomy + 契约面 self-test）
- K14：prepareSession/handleChat 内联段去重（renewed 头不一致）+ DSHCTL_ROOT 根覆盖
- aggregate `days` 语义修正：按文件数切片 ≠ 按自然日（dsh-observability/index.ts:143-144）

**中期（medium，需触发/依赖）**
- 按意图过滤工具子集（LangChain wrap_model_call 模式；依赖 K5 意图补全先落地）
- Skill 渐进式披露（描述常驻、SKILL.md 懒加载）→ ops-skill-manager 加描述索引表层
- 输出护栏位（OpenAI Agents SDK 三类分位；与 /admin 桥接同批做脱敏）
- 副作用幂等键（i2agent MCP 执行类 execution id 去重，与 H-15 互补）
- HITL fail-closed（护栏解析失败升级人工而非静默放行）
- RRF(k=60) vs DBSF nDCG@10 实验（与 bigram 量化同一标注集，一次建集两项产出；BM25 IDF 已核对在位——bm25.ts:71-76）
- 观测对齐 OTel GenAI（TTFT/时延分位/byModel 分桶/load_skill span；P1.5 已做字段注释级对齐）
- turnMs 填充（A2 遗留：UsageRecord.turnMs 已定义未赋值）

**催办类（roadmap 既定，非新建议）**
- K5 意图覆盖补全（§3.2 方案既定：gen-intent-taxonomy → eval-intent ≥85% 零误采纳）
- SQL 第二域（P2 既定，触发条件不变）

**外部思路映射完整清单**见审计报告 artifact（`report` 卡片）：LangChain 工具生态 / AutoGen 编排模式 / LangSmith 闭环 / Qdrant 混合检索 / OpenAI Agents SDK 护栏五方向。
> 动机：Hermes 等价性补齐（G1-G3、三缺口、C1-C7）已全部收口后，回答"还应该增加哪些插件、沉淀哪些思想、还缺哪些功能"。
> 依据：2026-11-01 三路调研（既有 plan 文档全量提取 / 插件生态配置面 / 运行期能力面），本文只做推荐与排期，不含实施。

---

## 0. 结论速览

1. **值得新建的插件只有 2 个**：`dsh-observability`（观测）与 `bkn-feedback`（BKN 反馈回流）——都是"跨切面"能力，符合"跨切面独立成插件、就近能力就近扩展"的形态律。
2. **最便宜且防大坑的是 S1 三件套**（dshctl）：`plugin pack` 目前对跨插件依赖**静默产出跑不起来的包**（`plugin-boundary-direction.md` §0 自认"今天不得把 pack 产物用于任何交付"），fail-loud 校验一天级成本，堵住的是交付级事故。
3. **最大的结构性缺口是闭环断裂**：`gap_log.jsonl` 只写不读（supplement.ts:141-149 中 `user_supplied` 硬编码 `null`、`resolved` 硬编码 `false`，全工作区无写回方），用户纠错→知识更新的链路不存在。
4. **优先级**：P0 = S1 三件套 + 文档漂移清理；P1 = 观测/回流两插件 + 取消端点；P2 = SQL 第二域；P3 = 触发条件保留项。
5. **前置阻塞**：外部模型网关 503 + 会话默认模型未配置——P1 之后所有端到端验收（bench-4q、观察期检查单）都依赖它，本文单列声明（§5）。

---

## 1. 现状盘点：等价性收口之后剩什么

### 1.1 已收口（不再重复投入）

| 主线 | 状态 | 出处 |
|---|---|---|
| Hermes 等价性 G1 多轮会话 / G2 扩展端点 / G3 记忆薄客户端 | ✅ | gap-design / gap-exec-plan |
| 三缺口（edges 图边 / operation_knowledge / skill 挂载） | ✅ | completion-plan |
| 对齐整改 C1-C7 | ✅（C3 改名随 adopt 归层顺延） | future-alignment-plan |
| 检索栈 / 意图路由 / 技能自管理 / dshctl 编排 | ✅ | phase3 / intent-router-plan / orchestration-plan |
| Gateway / embed 转 systemd 独立托管 | ✅ | proposal §3.5 |

### 1.2 规划文档之外的结构性缺口（本次调研新发现）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| K1 | **质量闭环断裂在回流**：gap 日志只写不读 | `code/dsh-plugin/supplement.ts:141-149`（`user_supplied: null`、`resolved: false` 硬编码，无任何写回方）；gapLogPath 配置存在但零消费方 | 知识短板永远沉淀不成知识更新，闭环止步于"打分→记日志→提示补查"——**P1b（bkn-feedback）+ P1.5（preset 触达 / resolve_correction / admin 桥接）已修** |
| K2 | **观测体系缺位** | ~~ops-api 路由表无 /metrics~~ **已修（P1a）：`/v1/metrics` 已上线（ops-api/index.ts:409-426）**；P1.5 补齐失败 turn 留痕（timeout/abandoned/error 分档入 usage，errors 计数进 /v1/metrics） | ~~无法回答失败率~~ 剩余缺口：TTFT/时延分位/byModel 分桶（未实施，见 §10） |
| K3 | **取消链路半成品** | index.ts:940-942 会话 DELETE 405（sessionController 无 delete/archive 出口）；无客户端主动取消端点，只能断连或等超时 | 调用方无法止损长任务——**P1c 已修：POST /api/sessions/{id}/cancel** |
| K4 | **S1 护栏未落地** | plugin-boundary-direction.md §2.2：pack 静默产出坏包；§3 五个动作仅第 1 个实际完成 | pack 产物一旦用于交付 = 静默事故——**P0 已修（pack fail-loud + R12 扩展 + 闭环断言）** |
| K5 | **意图覆盖不全** | 22 条意图 = 12 工具 + 9 技能；已装的 i2stream_report_sender、migration-designer、obora-diff-testing、multi-evidence-diagnosis、i2agent-executor 等 ~10 个技能无意图条目 | inject 模式下这些技能路由不上——2026-11-05 审计复核确认数字属实（催办，方案 §3.2 既定） |
| K6 | **备而未用** | whitelist.yml 零消费方；file-ops/script 能力包零挂载；core.yml 5 个 slot 均无可替换实物；单域现实（domains/ 仅 ops） | 编排可复制性从未被第二实例验证——审计复核修正口径：ruleSource 解析链已实现，属"配置未启用"而非"零实现" |

### 1.3 审计批次（2026-11-05 工作流）新发现

| # | 缺口 | 状态 |
|---|---|---|
| K7 | BM25 索引只在插件加载时构建，Qdrant 知识更新后稀疏检索路径永久不可见（retrieval.ts:186-223 bm25Ready 哨兵） | ✅ **P1.5 A1 已修**（getPointsCount + bm25RefreshSec 定时比对定向重建 + 失败缓存可重试） |
| K8 | 失败 turn（timeout/abandoned/error）不入 usage，/v1/metrics 答不了失败率；turnMs 定义无赋值 | ✅ **P1.5 A2 已修**（catch 路径 reportFailure + DailyAgg.errors 分桶）；turnMs 填充登记未实施 |
| K9 | capture_correction 已注册但 preset 零触达，模型不会自发调用 | ✅ **P1.5 A3 已修**（gen-hotpath 静态行 + 防漂移断言 + dsh-plugin self-test 漂移检查） |
| K10 | gap_log 写侧三无（appendCorrection 裸 append 无轮转/retention/并发保护）+ correction 文本未消毒 | ✅ **P1.5 A4 已修**（rotateIfNeeded + sanitizeCorrection + admin escapeHtml） |
| K11 | 三个 provide 服务（skillManagerAdmin/bknFeedbackAdmin/observability）零生产消费方；resolved 无写回路径 | ✅ **P1.5 B1/B2 已修**（/admin 三只读端点 + 反馈闭环区块 + resolve_correction 工具/admin 端点） |
| K12 | pack S1 只护 .ts import，runtime 相对资源读取（如默认 whitelistPath '../guard-rule-sources/…'）无护栏 | ⚠️ 未实施——并入 boundary-direction §8 开放项③ |
| K13 | 共享 BKN 上游变更→12 工具契约面/意图体系过期，无漂移监控联动 | ⚠️ 未实施——建议 check 加 BKN mtime/hash 比对（登记 §10） |
| K14 | prepareSession/handleChat 内联段重复且 renewed 头不一致；dshctl ROOT 硬编码无 DSHCTL_ROOT | ⚠️ 未实施（工程债务，登记 §10） |

---

## 2. 新增插件推荐（2 个）

### 2.1 dsh-observability（观测插件，新建）

**职责**

1. **usage 聚合留档**：按日 JSONL 记录 per-request 的 `{ts, session, model, prompt_tokens, completion_tokens, turn_ms, tool_calls}`；旧文件轮转（复用 `rotateIfNeeded` 同款策略，**复制实现不 import**）。
2. **RiskGuard 命中审计**：订阅 `tools/pre-execute` 结果侧事件（或经 ops-api 转交命中记录），分 `blockable`（critical+错误码，阻断）与 `advisory`（warn 放行）两档留档——护栏的命中史现在没有任何留存。
3. **`GET /v1/metrics`**：聚合只读端点，输出 Prometheus 文本或 JSON（格式选型见 §8-Q1），覆盖请求数/错误数/取消数/token 总量/护栏命中数/会话存活数。
4. **/admin 观测卡片**：复用 /admin 页面，加 usage 曲线摘要与护栏最近命中列表。

**挂载方式（关键设计）**

- 插件 `ctx.provide('observability', collector)` 暴露进程内服务；
- ops-api 侧 `ctx.get('observability')` 兜底注入（undefined 则不挂 /v1/metrics 路由并 warn）——**零跨插件 import**，符合 S0 纪律（plugin-boundary-direction §2.1）；
- 路由复用 ops-api 自建 listener（:8643），**不新增端口**（遵守"禁止 mount 第二个 webServer"红线）。

**纪律**

- H-15 推广：采集/写盘失败**静默丢弃 + warn**，绝不影响请求路径；
- 遵循惯例四件套：`dsh.plugin.yml` 自描述 + 独立 `self-test.ts` + registry 登记（`tier: extension, source: local`）+ config 经 `domain.yml plugins[].config` 注入。

### 2.2 bkn-feedback（BKN 反馈回流插件，新建）

**职责**

1. **gap_log 消费器**（补 K1 的"只写不读"）：周期扫描 gapLogPath，产出置信度分布 / 高频 gap 维度 / 长期 `resolved=false` 积压报告，落 `gap-report-<date>.md` 至固定目录。
2. **`capture_correction` 工具**：Agent 在被用户纠正后调用，将 `{tool, params, gaps, correction}` 追加进 gap_log 并**置位 `user_supplied` 字段**——打通 supplement.ts:146 的死字段（格式以现有 entry schema 为准，只增不破）。
3. **curator 式周期报告**：复用 ops-skill-manager 的 timer + 状态机模式（`intervalHours`、首轮延迟避开启动高峰），报告而非动作。

**纪律**

- **不自动改 BKN 数据**：BKN 是与 Hermes 共享的资产，保持只读消费；插件产出只是"建议清单"，知识更新仍走人工/生成脚本；
- gapLogPath 经 config 注入（外部资源，fail-safe：文件缺失 → 报告返回"无数据"，不报错）；**不 import dsh-plugin 任何符号**；
- 同样四件套：dsh.plugin.yml + self-test + registry + config 注入。

### 2.3 形态原则（为什么只有 2 个）

- **跨切面能力独立成插件**：观测、回流横跨所有请求/工具，塞进任何现有插件都会让职责膨胀；
- **就近能力就近扩展**：取消端点、admin 视图属于 ops-api 的既有职责，做进 ops-api（§3）；
- **尊重"显式不做"**：不抽象通用领域工具插件框架、不做插件市场/依赖注入框架（proposal §9、boundary-direction §6）——所以不为"第三个插件该不该抽框架"预留任何机制。

---

## 3. 现有插件功能扩展

### 3.1 ops-api

| 项 | 内容 | 备注 |
|---|---|---|
| 客户端主动取消端点 | 先探明 sessionController 能力面；有 cancel 命令则挂 `POST /api/sessions/{id}/cancel`，无则按 gap-design §P5 惯例记"触发条件保留" | `SessionDriver.cancel` 已存在（bridge.ts:33、index.ts:269），缺的只是面向客户端的路由 |
| /admin MCP 单项启停 UI | API 已有 `PUT /admin/api/mcp/<name>` enabled=false（index.ts:559-591），UI 未暴露按钮 | 纯 admin-html.ts 前端补齐 |
| /admin MCP 连通性验证 | 新增 MCP 后发起一次 tools/list 探测，显示"已连通/可达但无工具/不可达" | 对应观察期检查单未勾项"/admin 装真实 MCP 验证" |
| gap/审计查看视图 | /admin 加只读页：gap 报告摘要 + 护栏最近命中（数据来自 §2.1/§2.2 落盘产物） | 同样走 `ctx.get` 兜底，两插件缺席时显示"未挂载" |

### 3.2 intent-router

| 项 | 内容 |
|---|---|
| 意图覆盖补全（补 K5） | 剩余 ~10 个已装技能补意图条目，走 `gen-intent-taxonomy.ts` 重生成 + `eval-intent.ts` 回归（判据不变：零误采纳 + 采纳率 ≥85%） |
| observe→inject 线上校准 | reconcile 观测日志基础设施已有，补"抽样核对误识别率 → 决定 inject 去留"的流程化脚本与判定口径 |
| 标注集扩容 | observe 日志持续收集，目标 ≥100 条再复核门限（intent-router-plan §6 既定） |

### 3.3 dshctl（S1 三件套，规格来源 plugin-boundary-direction.md §3/§4）

1. **`plugin pack` fail-loud 自包含检查**：打包时检测跨插件相对 import / 越界资源引用，命中即拒绝打包（对应文档"最重警示"，优先级最高的一条）；
2. **`check` 新增跨插件 import 规则**：error 级（编号形态 R14 还是并入 R12，见 §8-Q2）；
3. **`pack → install --vendored → 启动真跑` 闭环验收**：packPlugin 目前 self-test 覆盖为 0、"从未验证过"——补一条端到端冒烟；
4. （另议）**check 增加模型端点探活**：domain.yml providers 声明的端点做可达性 warn，让"会话默认模型未配置"类静默故障在 check 阶段可发现。

---

## 4. 项目思想沉淀（供 AGENTS.md 后续吸收）

现有思想（§3 对齐原则、H-15、BKN 边界、约定优先、回退一层、诚实原则）全部沿用；建议**新增五条**：

1. **闭环律**：只写的日志必须找到读者——每个落盘观测产物（gap_log、usage、审计）必须有消费方，否则不落盘。K1 是这条律的反面教材。
2. **观测也是非关键路径**：H-15 推广到 metrics/审计——采集失败静默丢弃 + warn，绝不影响请求。
3. **形态律**：跨切面能力独立成插件；就近能力就近扩展；不为第三个插件预抽框架。
4. **生成物优先（推广）**：metrics 口径、审计 entry schema 等契约也走脚本生成 + self-test 守护（对齐 intent taxonomy / hotpath 惯例），防止双源漂移。
5. **护栏先 warn 后 deny**：SQL 域白名单"先 warn-only 观察一周再切 deny"的惯例，升格为一切新护栏规则的通用上线步骤。

---

## 5. 优先级与触发条件

| 级 | 内容 | 成本量级 | 触发/依赖 |
|---|---|---|---|
| **P0** | S1 三件套（pack fail-loud + check 规则 + vendored 真跑闭环）；文档漂移清理（responses.ts:8 过期头注释、render.ts:33 死键） | 天级 | 无——越早堵住越好 |
| **P1** | dsh-observability + bkn-feedback 两插件；取消端点探明 + 接线；/admin 四项增强 | 周级 | 依赖外部模型网关恢复（见下）做端到端验收 |
| **P2** | SQL 第二域落地（激活 file-ops/script 能力包与 whitelist 规则源，解除 K6）；意图覆盖补全 + 标注集扩容 | 周级 | proposal §6 既定流程（W-T1~T4、并行验证达标切 .env） |
| **P3** | 触发条件保留：Gateway 切 TCVDB+COS（合规触发）、sessions 真删除（调用方触发）、提示词收窄（单独立项）、向量层 2c 复核（BM25 判不出案例出现）、model_presets 路由、槽位备选成员实物化（需要替换成员时引入） | — | 各自触发条件见 gap-design §P5 / intent-router-plan §6 |

**前置阻塞项（单列声明）**：外部模型网关 503（mimo 通道）+ 会话默认模型未配置——orchestration-plan §8 已挂账"用户裁定先搁置"；P1 及之后所有端到端验收（bench-4q、观察期检查单真实问题演练）均依赖此解除，届时需回填 orchestration-plan 而非本文。

---

## 6. 显式不做（尊重既有边界，逐条对齐出处）

| 不做 | 出处 |
|---|---|
| 不做通用领域工具插件框架 | proposal §9 |
| 不做插件市场 / 发布流水线 / 版本仓库 / 插件间依赖注入框架 | boundary-direction §6 |
| 不做多租户、TLS 终结（交前置反代） | orchestration-plan §7 |
| 不做多实例统一 GUI 聚合面 | proposal §9 |
| 不自动改 BKN 数据（回流插件只产建议清单） | 本文 §2.2，BKN 共享资产只读消费 |
| 不动上游 harness（净改动 = 0） | AGENTS §6 |
| 不重写记忆管道 / 不自建向量库与嵌入服务 | gap-design §4 |

---

## 7. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| plugin-boundary-direction.md | §3/§4 S1 三件套的规格来源；本文 P0 是其触发条件的前置动作 |
| ops-agent-gap-design.md §P5 | sessions DELETE / TCVDB+COS 的触发条件沿用，不重复定义 |
| ops-agent-intent-router-plan.md §6 | 意图五条"未做/后续"中本文认领两条（覆盖补全、标注集扩容），其余维持原判 |
| ops-agent-orchestration-plan.md §8 | 模型网关阻塞项挂账处；本文不接管 |
| proposal §6/§7 | SQL 第二域为 P2，流程照旧走 W-T1~T4 |
| AGENTS.md | §4 思想五条待评审通过后择机吸收 |

---

## 8. 待评审开放问题

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | /v1/metrics 格式：Prometheus 文本还是 JSON？ | 倾向 JSON（运维侧现无 Prometheus 抓取器；文本格式是提前抽象） |
| Q2 | check 跨插件 import 规则编号：新增 R14 还是并入 R12（插件库） | 倾向并入 R12 语义（同属"插件库健康"），boundary-direction §8 开放项①一并拍板 |
| Q3 | `capture_correction` 归属：独立插件新工具 vs 并入 dsh-plugin | 倾向独立插件（回流是跨切面职责；dsh-plugin 保持"检索+护栏"单一职责） |
| Q4 | usage 留档路径归属 `$DSH_HOME` 下哪个目录 | 倾向 `$DSH_HOME/observability/`（与 skills/logs 平级），config 可覆盖 |

---

## 9. 后续实施与验收

- 本文评审通过后，各优先级**另立 exec-plan**（`ops-agent-<主题>-exec-plan.md`），按 AGENTS §2 工作流执行：逐阶段实施 → self-test 全绿 → 重启 → HTTP 实测验收 → 回填。
- 新增插件的 DoD 固定为四件套：`dsh.plugin.yml` 自描述 + 独立 self-test（存量断言不破 + 新增段全绿）+ registry 登记 + `dshctl check` 通过。
- 本文本身零代码改动；验收 = 文档与 AGENTS §3 原则及各既有"显式不做"清单逐条对照无冲突。
