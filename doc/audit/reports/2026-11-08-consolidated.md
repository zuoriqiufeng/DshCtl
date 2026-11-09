# 2026-11-08 dsh-info 智能审计汇总报告（consolidated）

> 审计团队：lead-reviewer（首席审计 / 汇总复审）
> 被审根：C:\Users\Admin\audit\dsh-info（GitHub 浅克隆；deepseek-harness/、.dsh-home/ 被 .gitignore 排除，不在克隆内）
> 审计日期：2026-11-08 · 参照权威规则：AGENTS.md（R8/R11 红线、H-15 降级铁律、回退单层、诚实原则）+ doc/gernalarrange/plugin-boundary-direction.md（S0/S1/S2）
> 上游五视角：design / functionality / performance / quality / style（各自独立，见 doc/audit/reports/2026-11-08-{视角}.md）

---

## 【方法】

1. **独立交叉复核（先信源码，不信草稿）**：本报告**先于**读五份报告，对 target 根做只读静态取证 + 可运行证据独立复验，再逐条与五份对照。
   - 静态取证实测：
     - tools.ts 中「registerTool({」计数 = **14**，含 check_plan、diagnose_mechanism；dsh.plugin.yml provides 段 = **12** 项且**缺**这 2 个新工具；AGENTS.md = 「12 工具」。
     - dshctl/ci.sh 环节标签 [1/9]..[9/9] = **9** 环节；AGENTS.md 写「六环节一键」。
     - gap_log.jsonl 字面量在 dsh-plugin/supplement.ts:21 与 dsh-plugin/index.ts:57 **两处独立硬编码**。
     - 别名表程序化 diff：ERROR_ALIASES 20=20、SYMPTOM_ALIASES 28=28，**当前 0 漂移**（键值全等）；aliases.ts:4 头注自认「源表变更时人工同步本副本」；全仓 **0 条漂移断言**。
     - dsh-plugin/dsh.plugin.yml external 只登记 5 个 env 键，**无 I2STREAM_QDRANT_COLLECTION**，但该键在 index.ts:79、retrieval.ts:15 被读作 env 哨兵。
     - ops-skill-manager/store.ts:31-40 readUsage 对 JSON 解析/形状非法「catch { return {} }」静默空表；bump()(:52-77) 读-改-写全量覆盖。
     - 死导出：resetErrorSemanticsCache(errorSemantics.ts:230)、resetMechanismCache(mechanism.ts:201) 全仓仅声明行，**0 调用点**。
     - sequenceSemantic 在 riskGuard.ts 仅 2 处（声明+装配写入）。
     - eval 覆盖：questions.json 37 例(24 accept/13 reject) 产 19 个 distinct expect id；taxonomy 22 意图中 search_qdrant、process_debug 两个 injectable 意图**零正样本**。
     - plugin-boundary-direction.md §2.3 仍列 intent-router→dsh-plugin「3 处」（§2.2 段首另写「4 处」）历史运行时 import；实测 intent-router 各 .ts **0 处 ../dsh-plugin 运行时 import**。
   - 可运行证据复验：
     - **本机实跑 node --experimental-strip-types intent-router/self-test.ts（临时副本，落系统 temp 不落仓）：`121 passed, 1 failed`**，唯一红项 [11]「listDataFiles 兼容日文件与分片」——Windows 路径分隔符导致的平台相关失败（复现 functionality D-1 双证）。
     - 同一次运行同时产出性能/标定硬线实据：[10] 热路径 p50=0.69ms / p95=1.14ms / max=1.54ms（p95<10ms 断言过）；[9] 放弃组零误采纳 + 采纳组覆盖≥85% + 零错判（硬线过）。
2. **逐条对照五份**：去重、合并同类项、标注 cross-validated（≥2 视角撞车 = 高置信），产出【交叉复核结论】与【发现清单 C-1..C-16】。
3. **优先级与缓解计划**：落 doc/optimize/2026-11-08-audit-remediation-plan.md（批 A=P1 / 批 B=P2 / 批 C=P3）。

**标记口径**：confirmed = 本复核源码一处 + 运行/跨文件/日志一处双证成立；improved = 朝向正确但缺门禁或未落地（文档/口径漂移、缺断言、缺 gate）；observation = 给不出第二证或仅源码单证。行为类：A=数据完整性/红线，必修；B=工程契约/口径/可观测，应修；C=观察/优化，可归档。

---

## 【交叉复核结论】

**已确证的正向基线（confirmed · 值得保留）**
- **分层与边界是本仓最自律的一面**（cross-validated：design D-1 + quality Q-10 + 本复核）：6 插件顶层 **0 跨插件运行时 import、0 有向环**；跨插件协调走 ctx.provide/get（服务名，如 observability/bknFeedbackAdmin/skillManagerAdmin 消费方全命中）与 ctx.on/emit 事件（bkn/risk-hit）松契约。
- **测试为断言型、非只跑不查**（cross-validated：quality Q-9 + 本复核实跑）：ci.sh 9 环节「|| fail=1; exit $fail」；eval-intent.ts 硬线「falseAccepts>0 || wrongIntent>0 || acceptRate<0.85 → exit 1」；intent-router self-test [9][10] 本机实跑通过。
- **可观测链路已去黑盒**（confirmed：quality Q-10）：usage/risk/gap 三类台账有生产写盘路径 + 部署配置挂载（domains/ops/domain.yml）+ /v1/metrics 读接口。
- **intent-router 热路径达标**（cross-validated：performance D-1 + 本复核实跑 p50≈0.7ms）。

**已经复核定位的关键风险（按主题）**
- **多源漂移族（最高置信，≥3 视角撞车）**：别名/默认值/env 键/CI 口径四处「单一来源」违约，见 C-1、C-2、C-3、C-15。其中别名三层（constants 权威 + aliases 手拷 + 生成 taxonomy 快照）当前 0 漂移但**无一道自动化闸门**（cross-validated：design + functionality）。
- **H-15 warn 纪律大面积缺位 + 一处真实数据抹除风险**：见 C-5（catch 静默，运维黑盒）、C-6（usage 台账损坏→静默清空），后者是本仓唯一能把**既有数据**抹掉的吞错点。
- **检索链性能风险**：首次检索主线程全量建 BM25 索引、多段检索无批量整体 deadline、N+1 scroll、无 embed 缓存（C-8）；ops-api 前导 recall 慢却 200 不触发熔断（C-9）。均为「待 harness 环境恢复后全链路复核」性质。
- **测试充分性缺口**：Windows 平台必红自测（C-11）、恒真/弱断言（C-12）、eval 两个可注入意图零正样本（C-13）、非 API 级覆盖（C-14）。
- **文档口径漂移集群**：工具数（14 实际 vs 12/10/4 文字, provides 缺 2）、CI 环节数（9 vs 6/5）、reason 枚举注释陈旧、边界方向 doc 死表（C-15、C-16）。

**复核修正一处 specialist 数值**：多份报告引「SYMPTOM ×56」，本复核精确计数 constants/aliases 两处 SYMPTOM_ALIASES 均为 **28**（生成的 taxonomy.generated.json sources 元信息自身即写「×56」→ 该元信息也属于漂移证据，但 56 vs 28 的数字对结论无影响，0 漂移才是关键）。

---

## 【去重后有仲裁号的发现清单】

> 每条 = 来源视角 · 三类标记 · 证据 · 建议 · 行为类 · 验证要求。cross-validated = ≥2 视角撞车（高置信）。

### C-1 【P1 · A · confirmed · cross-validated(design+functionality+style)】别名域数据三处独立表示且无漂移断言
- **来源**：design D-4(+D-2)、functionality F-4、style（多源主题）。
- **证据**：dsh-plugin/constants.ts（ERROR 20/SYMPTOM 28，权威源）+ intent-router/aliases.ts:9-63（S1 手拷副本，头注「源表变更时人工同步本副本」）+ intent-router/taxonomy.generated.json sources（生成器从 constants 读同源的快照，元信息自身已漂移「×56」）。本复核程序化 diff：当前 **0 漂移**；但 grep 漂移|drift|黄金|同输入 于 intent-router=0，self-test.ts 不 import 任何 dsh-plugin 符号、无法对账——**无任何自动化防漂移闸门**（硬规则 3 要求的「漂移断言（黄金输入同结果）」缺失）。
- **建议**：保留 constants.ts 为唯一权威；新增 intent-router 侧漂移断言（黄金输入同结果：副本=源）进 self-test；或运行时改从 taxonomy.generated 派生、删手拷副本消除第三份冗余。
- **行为类**：A。

### C-2 【P1 · A · confirmed · cross-validated(design+style)】外部依赖默认值跨文件字面量多源
- **来源**：design D-3、style S-2。
- **证据**：dsh-plugin/supplement.ts:21 与 dsh-plugin/index.ts:57 两条独立解析链各自硬编码同一 gap_log.jsonl 字面量（本复核 line 定位）；embed/qdrant/collection 默认值另散于 index.ts:53-58 EXTERNAL_DEFAULTS、retrieval.ts:12-16 RETRIEVAL、intent-router/dsh.plugin.yml（第 4 处）——违反 AGENTS §3「约定优先于配置 / 回退只有一层」的防双源漂移。
- **建议**：默认字面量收敛为单一常量（constants.ts 或 schema default），其余各处改为引用该来源。
- **行为类**：A。

### C-3 【P2 · B · confirmed · style】env 哨兵键 I2STREAM_QDRANT_COLLECTION 未登记进 external 清单
- **来源**：style S-3。
- **证据**：index.ts:79、retrieval.ts:15 读该 env 哨兵；dsh-plugin/dsh.plugin.yml external 仅登记 5 键（URL/BKN_ROOT/SKILL_MANIFEST/GAP_LOG），无 COLLECTION。按清单装配/排障会漏该键。
- **建议**：补登记进 external（env 键列表），并在 dshctl install/pack 装配链验证透传。
- **行为类**：B。

### C-4 【P3 · C · confirmed · style】embed 侧车 env 命名空间拆裂（.py 用 EMBED_*，.yaml/TS 用 I2STREAM_EMBED_*）
- **来源**：style S-6。
- **证据**：code/sidecars/embed-server.py:26-27 EMBED_MODEL_NAME/EMBED_HF_HOME；同子系统 dsh-plugin/dsh.plugin.yml、intent-router/dsh.plugin.yml、index.ts:124、retrieval.ts:14 全用 I2STREAM_EMBED_URL。职责不同（模型/缓存 vs 服务地址），非功能断链。
- **建议**：统一前缀或文档显式声明职责差异。
- **行为类**：C。

### C-5 【P1 · B · confirmed · quality(+perf 佐证)】H-15 降级 catch 普遍缺 warn，写盘失败在日志上黑盒
- **来源**：quality Q-1（+performance P-5 佐证写路径为每步同步盘写）。
- **证据**：dsh-plugin/supplement.ts:152-154 logGap 裸「catch { /* 静默 */ }」（本复核定位）、supplement.ts:137-139 rotate 裸 catch；dsh-observability/index.ts:105-107,110-117 清理/轮转裸 catch；bkn-feedback/index.ts:97-101 轮转裸 catch。对照 AGENTS.md H-15「静默 + **warn 日志**」；同插件内 dsh-observability/index.ts:117 已有 warn 先例 → 纪律执行不对称。
- **建议**：为 H-15 降级写入补 warn 通道（与 index.ts:117 对齐），让台账「无声丢数据」可被发现。
- **行为类**：B。

### C-6 【P1 · A · confirmed · quality】usage 台账损坏后静默空表覆盖，技能计数可被抹掉
- **来源**：quality Q-2。
- **证据**：ops-skill-manager/store.ts:31-40 readUsage 对 JSON 解析/形状非法「catch { return {} }」（静默空表）；bump()(:52-77) 先读后写 writeUsage(:42-50) tmp+rename 全量覆盖 → 读得空表即写回仅含当前技能的单条；模块无 logger 通道（import 仅 node:fs）。
- **建议**：读损坏时备份坏档 + warn + 保留旧表/合并，write 在 read 失败时不覆盖。
- **行为类**：A。

### C-7 【P2 · B · confirmed · quality(+style)】死代码治理 + 格式门禁缺位
- **来源**：quality Q-3/Q-4/Q-5、style S-5。
- **证据**：死导出 resetErrorSemanticsCache(errorSemantics.ts:230)、resetMechanismCache(mechanism.ts:201) 本复核确认全仓 0 调用点；≥11 处未使用 import；只写不读字段 sequenceSemantic（riskGuard.ts:36/411，唯一读者是 self-test 回声）；仓库无根 tsconfig/.eslintrc/prettier、全部 package.json 无 scripts、ci.sh 9 环节无 lint/typecheck；源内 2 条 eslint-disable 为悬空指令。
- **建议**：引入根级 tsconfig(noUnusedLocals) + lint 并列入 ci.sh 新环节；删死代码；处理 sequenceSemantic。
- **行为类**：B。

### C-8 【P2 · B · confirmed(源码+实跑)/部分 observation · performance】检索链性能风险（主线程全量建索引 + 无整体 deadline + N+1 + 无缓存）
- **来源**：performance P-2/P-3/P-7/P-11(+P-6)。
- **证据**：retrieval.ts getBm25Index() 首次 searchXxx 调用栈内 do/while scrollPoints 翻全库、主线程 indexDocuments 同步 build；httpJson 仅 AbortSignal.timeout(8000) 单调用护栏，整轮多段无共享 deadline；resolveStandardBatch 注释自承「N 个父块 = N 次 scroll（top_k=5≈10 往返，与 Hermes 一致原则）」；searchChunkLevel/searchFull 每调用重 embed 无缓存；BM25 缓存失效只比 points_count 且 bm25RefreshSec=0 默认关闭。Run：本复核复验自测 [10] 热路径；D-2 的 50k≈2.3s 建索引数值来自 performance 专用 bench（探针落系统 temp）。**待现网复核绝对值**。
- **建议**：检索加整体 deadline（共享 AbortSignal）；索引构建移出请求线程或启动预热；缓存加内容/时间指纹；加 per-query embed 缓存；mini_first 限 N 或并行化。
- **行为类**：B。

### C-9 【P2 · B · confirmed · performance】ops-api 请求路径同步 recall（2s）且慢但 200 不触发熔断
- **来源**：performance P-4。
- **证据**：ops-api/index.ts:801,970 runTurn 前同步 await memory.recall；memory.ts timeouts.recall=2000 且 recordFailure 只在 !r.ok 计数（慢但 200 不计）；熔断 threshold=5 连续失败 open 60s。稳定劣化的 200-Gateway 每请求固定拖 ~2s 且熔断不介入。
- **建议**：加慢响应熔断/退避，或 recall 转后台并行 + 整体 deadline，不阻塞请求前导。
- **行为类**：B。

### C-10 【P3 · C · observation 组 · performance】运行时资源观察（memoryKeysSeen 只增 / BM25 缓存按 size 失效 / embed 指纹弱 / sidecar 无并发上限 / decompose 至多×8）
- **来源**：performance P-6/P-8/P-9/P-10/P-11。
- **证据**：ops-api/index.ts:289 new Set 只增（dispose 才读）；retrieval.ts refreshBm25IfStale 只比 pointsCount；embed.ts fingerprint = id+语料长度（同长不同文误命中）且单实例内 reset() 死路径；embed-server.py ThreadingHTTPServer 每连接一线程无上限；decomposeQueries [MIN=3,MAX=8] 顺序多子查询。无第二数据线 → 归 observation。
- **建议**：归档；留待现网压力验证后按需处理。
- **行为类**：C。

### C-11 【P2 · B · confirmed(本复核实跑复现) · functionality】intent-router 自测 [11] 非 POSIX 平台必失败
- **来源**：functionality D-1。
- **证据**：source：intent-router/logfile.ts:268-287 listDataFiles 用 join 拼路径；self-test.ts:484 用 [f.split("/").pop()].startsWith(...) 判定。Run：**本复核临时副本实跑 node --experimental-strip-types self-test.ts → 121 passed, 1 failed，唯一红项即 [11]**。
- **建议**：self-test 改用平台无关 basename()，或 Windows 下跳过/归一化路径分隔符。
- **行为类**：B。

### C-12 【P3 · C · confirmed(静态演算) · functionality】自测恒真/弱断言（gate 盲点）
- **来源**：functionality F-2/F-5。
- **证据**：dsh-plugin/self-test.ts:195-213 断言式代回 advisory 案为恒 true（静态演算）；intent-router/self-test.ts:336 未采纳分支恒真（有 [9] 标定集兜底）。
- **建议**：拆分独立断言并覆盖「识别命中 ⇒ guardDecision 必然产出」与未采纳分支。
- **行为类**：C。

### C-13 【P2 · B · confirmed · quality】eval 标注集对 2 个可注入意图零正样本
- **来源**：quality Q-7。
- **证据**：intent-router/eval/questions.json 37 例(24 accept) 产 19 distinct expect id（本复核实测）；taxonomy 22 意图中 search_qdrant、process_debug（均 injectable）**无任何 accept 正样本**（本复核实测）→ 既硬线全绿也可能漏掉这俩意图的失火。
- **建议**：补正样本（问法 → 该意图）入 questions.json，或产品确认豁免并注释。
- **行为类**：B。

### C-14 【P2 · B · confirmed · quality】self-test 为单元/集成级，非 API 级黑盒
- **来源**：quality Q-8。
- **证据**：dsh-plugin/self-test.ts 直接 import 纯函数、不经过 buildTools/注册边界；ops-api/self-test.ts 用注入桩驱动 runTurn、不连真 bridge/HTTP；bkn-feedback/dsh-observability self-test 用最小 ctx stub。契约破裂（装配写错）只在 live harness 暴露。
- **建议**：新增一层 API/契约级黑盒（经 apply+buildTools + HTTP 契约桩）进 ci.sh。
- **行为类**：B。

### C-15 【P2 · B · confirmed · cross-validated(style+functionality+design)】文档口径漂移集群（工具数 / CI 环节数 / reason 枚举注释）
- **来源**：style S-1/S-4、functionality F-3/F-6、design（工具注册面）。
- **证据**：工具数实测 14，dsh.plugin.yml provides=12 缺 check_plan/diagnose_mechanism，入口 index.ts:5 注释「4 个」、tools.ts:191 注释「前 10 个」、dsh-plugin/README「4/12 并存」、AGENTS.md「12 工具」；ci.sh=9 环节而 AGENTS.md「六环节」、dshctl/README「五环节」；layer2.ts:128-129 / engine.ts:39 reason 注释列 low-share/no-decision 但实现返回集另含 low-score/vector-uncorroborated/unknown-intent（本复核确认注释与 self-test 断言不符）。
- **建议**：统一口径为实际值（14 工具 / 9 环节）；provides 补齐 14；修正 reason 注释与 self-test 对齐。
- **行为类**：B。

### C-16 【P3 · C · confirmed · design】方向文档死表：plugin-boundary-direction.md §2.3 过时
- **来源**：design D-5。
- **证据**：§2.3 仍把 intent-router→dsh-plugin 的 index.ts:29 / logfile.ts:23 / bm25.ts:12 三处（§2.2 段首另写「4 处」）列为**现行**运行时 import 并得出「pack → ERR_MODULE_NOT_FOUND」结论；本复核实测 intent-router 各 .ts **0 处运行时 import**（S1 已内联/复制），头部状态未随 2026-10-21 实施流转。
- **建议**：更新/作废 §2.3 基线，标注「S1 step1 已消除」。
- **行为类**：C。

---

## 【优先级 P1/P2/P3】

**P1（必攻，行为类 A/B，数据/口径红线）**
| 编号 | 行为类 | 一句话 |
|---|---|---|
| C-1 | A | 别名 3 份 + 0 漂移断言 |
| C-2 | A | 默认值多源字面量 |
| C-5 | B | H-15 warn 大面积缺位 |
| C-6 | A | usage 台账损坏→静默清空 |

**P2（工程契约/口径/可观测）**
| 编号 | 行为类 | 一句话 |
|---|---|---|
| C-3 | B | env 哨兵键未登记 |
| C-7 | B | 死代码 + 无格式门禁 |
| C-8 | B | 检索主线程建索引/无整体 deadline/N+1/无缓存 |
| C-9 | B | ops-api 慢 recall 不熔断 |
| C-11 | B | intent-router self-test Windows 必红 |
| C-13 | B | eval 两意图零正样本 |
| C-14 | B | 非 API 级测试 |
| C-15 | B | 工具数/CI/reason 口径漂移 |

**P3（观察归档）**
| 编号 | 行为类 | 一句话 |
|---|---|---|
| C-4 | C | embed env 前缀拆裂 |
| C-10 | C | 运行时资源观察组 |
| C-12 | C | 恒真/弱断言 |
| C-16 | C | 方向文档死表 |

---

## 【受限声明】

- **运行类缺位**：deepseek-harness/、.dsh-home/、共享 BKN 数据被 .gitignore 排除，node_modules（tsx/yaml/@deepseek-ai）不在克隆内 → dsh-plugin/ops-api/dsh-observability/bkn-feedback/dshctl 的 TS self-test、ci.sh 全链、HTTP 契约、Qdrant/embed 真实链路、ops-api 端到端时延均**无法在本环境运行**，标「待 harness 环境恢复」。本复核仅动态实跑成功 intent-router/self-test.ts（纯模块、不依赖 harness）。
- **性能绝对值待现网**：C-8/C-9 的关键数值（BM25 建索引耗时、检索往返、recall 拖时）为源码推理 + bench 探针或注释自证，需现网/full-stack 复核。
- **被测克隆与现网差异**：全部分析针对 GitHub 浅克隆内容；.dsh-home 运行实例的实际配置/台账状态未纳入证。
- **专家数值修正**：别名 SYMPTOM 计数 specialist 记为 56，本复核为 28（含生成的 sources 元信息「×56」本身即漂移证据）；不影响「0 漂移、多源、无闸门」结论。
- **诚实声明**：无对应能力/不可得证据处显式标注「待确认/待 harness」，未冒充运行。

—— 报告完 · lead-reviewer · 2026-11-08
