# dsh-info 审计缓解计划（2026-11-08）

> 来源：doc/audit/reports/2026-11-08-consolidated.md（lead-reviewer 汇总，去重后 C-1..C-16）
> 批划分：**批 A = P1 必攻**（数据/口径红线，行为类 A/B）· **批 B = P2**（工程契约/口径/可观测）· **批 C = P3 观察项归档**。
> 落点「建议文件:行」基于 2026-11-08 克隆行号；实施时以实际改行为准。落款区块行号为**建议表达的目标锚点**，供立项与验收定位。
> 纪律：只读复盘已完成；本计划不改被审源文件。实施阶段按 AGENTS §2 DoD 逐批实施→self-test 全绿→重启→HTTP 验证→回填验收表。

---

## 批 A · P1 必攻

### A-1（结论 C-1）别名域数据三处独立表示 + 无漂移断言
- **建议**：以 dsh-plugin/constants.ts 为唯一权威；在 intent-router/self-test.ts 新增**漂移断言**（黄金输入同结果：对一组代表性键，副本 aliases.ts 与源 constants.ts 产出同值；两源不同 exit 1）；或运行时改从 taxonomy.generated 派生、删 aliases.ts 手拷副本。
- **落点建议**：code/intent-router/aliases.ts:4（头注标注/登记断言）；code/intent-router/self-test.ts（新增「漂移断言」段）；code/intent-router/index.ts:261（buildAliasIndex 用源）。参考 S1 §4 step1 施工单（plugin-boundary-direction.md）。
- **验收标准（可测）**：a) 故意改其一表的 1 个值 → intent-router self-test 该断言 exit 1；b) 回归现状 → 121 passed 0 failed；c) grep 漂移断言关键字存在于 self-test。

### A-2（结论 C-2）外部依赖默认值跨文件字面量多源
- **建议**：默认字面量收敛为单一常量（constants.ts 或 config schema default），supplement/index/retrieval/intent-router.yml 全部改为引用该来源。
- **落点建议**：code/dsh-plugin/index.ts:53-58（EXTERNAL_DEFAULTS）；code/dsh-plugin/supplement.ts:21；code/dsh-plugin/retrieval.ts:12-16；code/intent-router/dsh.plugin.yml（embedUrl）。
- **验收标准（可测）**：全仓 grep 默认字面量（gap_log.jsonl / 6333 / 8096/embed / i2stream_collection）仅剩**单一定义处**；dsh-plugin + intent-router self-test 全绿。

### A-3（结论 C-5）H-15 降级 catch 缺 warn
- **建议**：为降级写盘捕获补 warn/warnOnce 通道，与 dsh-observability/index.ts:117 现有 warn 对齐；gap 台账轮转失败也记 warn。
- **落点建议**：code/dsh-plugin/supplement.ts:152-154（logGap catch）；:137-139；code/dsh-observability/index.ts:105-107,110-117；code/bkn-feedback/index.ts:97-101。
- **验收标准（可测）**：注入写失败（只读目录）→ 日志出现 H-15 warn；各 self-test 不破；observability 可观测测试断言 warn 通道存在。

### A-4（结论 C-6）usage 台账损坏→静默空表覆盖
- **建议**：readUsage 解析/形状非法时不静默返回空：备份损坏档（.usage.json.corrupt-<ts>）+ warn；writeUsage 在 read 失败时保留旧表/合并，绝不因「读得空」而全量覆盖既有计数。
- **落点建议**：code/ops-skill-manager/store.ts:31-47（readUsage catch 分支）；bump()/setState/curator.ts 消费侧兜底。
- **验收标准（可测）**：注入损坏 .usage.json → 触发 bump 后：a) 损坏档被备份；b) 日志有 warn；c) 若旧表可恢复则旧计数保留；d) 现有 self-test 29 passed 保住并新增损坏处理断言。

---

## 批 B · P2

### B-1（结论 C-3）env 哨兵键 I2STREAM_QDRANT_COLLECTION 未登记
- **建议**：补登记进 dsh-plugin/dsh.plugin.yml external（env 键列表，与其余 5 键同列），并在 dshctl install/pack 装配链验证透传。
- **落点建议**：code/dsh-plugin/dsh.plugin.yml external 段（env 键）；code/dshctl（pack/install env 透传检查）。
- **验收标准（可测）**：config-grep external 含 6 键；一条装配探测确认 COLLECTION 透传生效。

### B-2（结论 C-7）死代码治理 + 格式门禁缺位
- **建议**：引入根级 tsconfig（"noUnusedLocals"/"noUnusedParameters"）+ eslint/prettier 并作为 ci.sh 新环节；删除 2 个死导出与 ≥11 处未使用 import；sequenceSemantic 接线或删除（阶段D未落地则移注释）。
- **落点建议**：根 tsconfig.json / .eslintrc.js / code/dshctl/ci.sh（新增 lint/typecheck 环节）；code/dsh-plugin/errorSemantics.ts:230、mechanism.ts:201、riskGuard.ts:36/411。
- **验收标准（可测）**：tsc --noEmit + eslint 0 新错误；ci.sh 新增环节绿灯；死符号删除后全仓 0 引用（grep）。

### B-3（结论 C-8）检索链性能（主线程全量建索引 / 无整体 deadline / N+1 / 无缓存）
- **建议**：① 检索链加整体 deadline（共享 AbortSignal 贯穿多段）；② 首次 BM25 全量构建移出请求线程（worker 或启动预热，及按 chunk 惰性分批）；③ BM25 缓存加内容/时间指纹（不只 points_count）并默认开周期刷新；④ 加 per-query embed 缓存（prompt→vector）；⑤ mini_first resolveStandardBatch 限 N / 并行化，避免 N+1 scroll。
- **落点建议**：code/dsh-plugin/retrieval.ts（getBm25Index / refreshBm25IfStale / searchChunkLevel / searchFull / resolveStandardBatch）；code/dsh-plugin/index.ts:213-220（bm25RefreshSec）；code/dsh-plugin/embed.ts。
- **验收标准（可测）**：现网/full-stack bench：首查时延回落（不在请求线程全量建索引）、多段整链时延有界（< 各单段之和的硬顶）、同 query 复用 embed；bench-tools/bench-4q 无回归。绝对值需 harness 环境恢复后复核。

### B-4（结论 C-9）ops-api 前导 recall 慢且不熔断
- **建议**：memory recall 加「慢但 200」熔断/退避（按 p95 或单耗时阈值计次，超过 open），或 recall 转后台并行 + 整体 deadline，避免 runTurn 前固定拖 ~2s。
- **落点建议**：code/ops-api/memory.ts（recordFailure 增加 slow-ok 计数、timeouts.recall）；code/ops-api/index.ts:801,970（同步 await 改为并行/带 deadline）。
- **验收标准（可测）**：注入 200-slow Gateway → 请求前导不再固定 2s、熔断按慢响应 open；既有 ops-api self-test 不破。

### B-5（结论 C-11）intent-router 自测 [11] Windows 必红
- **建议**：self-test.ts:484 改用平台无关 basename（path.basename）判定列表项；保留 POSIX 语义。
- **落点建议**：code/intent-router/self-test.ts:484（f.split("/").pop() → basename）。
- **验收标准（可测）**：Windows 与 POSIX 两平台 intent-router self-test 均 121 passed 0 failed。

### B-6（结论 C-13）eval 两可注入意图零正样本
- **建议**：为 search_qdrant、process_debug 各补 ≥1 条 accept 正样本（真实问法）入 questions.json；或产品确认豁免并以注释声明。
- **落点建议**：code/intent-router/eval/questions.json（cases）；code/scripts/eval-intent.ts（覆盖率口径注释）。
- **验收标准（可测）**：覆盖比对脚本显示 2 意图各有正样本；eval hardline（零误采纳 + ≥85%）仍全绿。

### B-7（结论 C-14）非 API 级测试
- **建议**：新增一层 API/契约级黑盒：经 apply(buildTools) + 最小 ctx 校验「工具注册边界 + pre-execute 护栏 + 观测事件」整链，及 ops-api HTTP 契约桩（鉴权/404/504），并入 ci.sh。
- **落点建议**：code/dsh-plugin/self-test.ts（新增表层段）；code/ops-api/self-test.ts（HTTP 桩段）；code/dshctl/ci.sh（新环节）。
- **验收标准（可测）**：人为在 defineTool 装配注入错 name → 新黑盒环节 exit 1；HTTP 契约桩断言 401/404/504 路径。

### B-8（结论 C-15）文档口径漂移集群（工具数 / CI 环节数 / reason 注释）
- **建议**：工具数统一为 14（AGENTS.md、dsh-plugin/README 12→14、index.ts:5 头注 4→14、tools.ts 注释 10→14、dsh.plugin.yml provides 补齐 check_plan/diagnose_mechanism）；CI 环节数统一 9（AGENTS「六环节」→九环节、dshctl/README 五→九）；修正 layer2.ts/engine.ts reason 注释与 self-test 实际返回集对齐。
- **落点建议**：AGENTS.md:13；code/dsh-plugin/dsh.plugin.yml provides；code/dsh-plugin/index.ts:5；code/dsh-plugin/README.md；code/dshctl/README.md:35；code/intent-router/layer2.ts:128-129；engine.ts:39。
- **验收标准（可测）**：全仓口径一致（工具 14 / provides 14 / CI 9）；grep 规约命中 0 个旧值；reason 注释与 self-test 断言同集。

---

## 批 C · P3 观察项归档

### C-1（结论 C-4）embed 侧车 env 前缀拆裂（EMBED_* vs I2STREAM_EMBED_*）
- **建议**：统一前缀或 doc 显式声明职责差异（模型/缓存 vs 服务地址）。
- **落点建议**：code/sidecars/embed-server.py:26-27；code/dsh-plugin/dsh.plugin.yml。
- **验收标准（可测）**：两处前缀口径一致或 README 声明差异；不影响运行。

### C-2（结论 C-10）运行时资源观察组（memoryKeysSeen 只增 / 缓存按 size 失效 / 指纹弱 / sidecar 无并发上限 / decompose ×8）
- **建议**：归档并留待现网压力验证后再定方案；不做立即改动。
- **落点建议**：监控项登记：code/ops-api/index.ts:289；code/dsh-plugin/retrieval.ts；embed.ts；code/sidecars/embed-server.py。
- **验收标准（可测）**：现网压测后按实测决定是否落地；无新改动时现有 self-test 全绿。

### C-3（结论 C-12）自测恒真/弱断言
- **建议**：拆分独立断言覆盖「识别命中 ⇒ guardDecision 必然产出」与未采纳分支。
- **落点建议**：code/dsh-plugin/self-test.ts:195-213；code/intent-router/self-test.ts:336。
- **验收标准（可测）**：注入「guardDecision 返回 0 动作」→ 断言能抓到；原 121/29 断言计数不破。

### C-4（结论 C-16）方向文档死表 plugin-boundary-direction.md §2.3
- **建议**：更新/作废 §2.3 现状基线，标注「S1 step1 已消除（0 运行时 import）」，头部状态流转，删除「pack → ERR_MODULE_NOT_FOUND」已失效结论。
- **落点建议**：doc/gernalarrange/plugin-boundary-direction.md §2.2/§2.3 + 头部状态。
- **验收标准（可测）**：重读 §2.3 不再指向已不存在的问题（工具链 import 除外）。

---

## 汇总

| 批 | 结论号 | 条数 | 行为类 |
|---|---|---|---|
| A（P1 必攻） | C-1,C-2,C-5,C-6 | 4 | A/B |
| B（P2） | C-3,C-7,C-8,C-9,C-11,C-13,C-14,C-15 | 8 | B |
| C（P3 归档） | C-4,C-10,C-12,C-16 | 4 | C |

**去重后总条数：16（P1=4 / P2=8 / P3=4）**

**执行顺序建议**：批 A → 批 B → 批 C；每批内先数据/口径红线（A-1,A-2,A-4）再可观测（A-3）；批 B 先修自测门禁（B-5,B-8）为后续改动提供可回归基线。

—— lead-reviewer · 2026-11-08

---

## 实施状态（2026-11-09 · 按审批范围执行）

| 项 | 状态 | 证据 |
|---|---|---|
| 批A-1 别名单源+漂移断言 | ✅ 已实施 | intent-router/self-test.ts [13] 三断言（读 constants.ts/aliases.ts 逐键比对 + 黄金） |
| 批A-2 默认值单源 | ✅ 已实施 | constants.ts DEFAULT_* 唯一定义；index/retrieval/supplement 改引用；grep 默认字面量仅剩 constants 一处 |
| 批A-3 H-15 warn 通道 | ✅ 已实施 | supplement.ts logGap/rotate + bkn-feedback/index.ts rotate 的降级 catch 补 console.warn（验证待 harness 恢复） |
| 批A-4 usage 台账防抹除 | ✅ 已实施 | ops-skill-manager/store.ts readUsage 损坏→备份 .corrupt-<ts>+warn；self-test +3（备份/移位/读空不抛）→32 passed |
| 批B-1 self-test [11] Windows 红 | ✅ 已实施 | self-test.ts split('/')→basename；125 passed 0 failed（含 POSIX 语义） |
| 批B-2 工具/CI 口径 | ✅ 已实施 | AGENTS/README/index/dsh.plugin.yml 工具 12→14、CI 九环节；provides +check_plan/diagnose_mechanism |
| 批B-3 死导出/门禁 | ⏸ 部分：死导出已删（resetErrorSemanticsCache/resetMechanismCache）；tsconfig/eslint/CI-lint 环节登记延后（需 harness 与 deps，避免本地/CI 假红） |
| 批B-4 eval 正样本 | ⏸ 延后：补的 search_qdrant/process_debug 样本破坏硬线（搜索词触发 diagnose_error、线程栈窄裕量）——需 classifier overrides 支持后回归，勿强塞致 FAIL |
| 批B-5 API/契约黑盒层 | ⏭ 延后（需 harness 跑 self-test） |
| 批B-6 external 登记 | ✅ 已实施 | dsh.plugin.yml external 补 I2STREAM_QDRANT_COLLECTION（6 键） |
| 批B-7 检索性能 / B-8 recall 熔断 | ⏭ 延后（待 harness/现网复核绝对值） |
| 批C-3 恒真/弱断言 | ✅ 已实施 | dsh-plugin/self-test.ts 210-211 拆成两个独立真断言 |
| 批C-4 方向文档死表 | ✅ 已实施 | plugin-boundary-direction.md 头部加 2026-11-09 状态更新（§2.2/§2.3 历史沿革，S1 step1 已消除） |

**本机 gate（2026-11-09）**：intent-router 125 passed 0 failed · ops-skill-manager 32 passed 0 failed · eval-intent PASSED（37/87.5%/0 误采纳）。
**待 harness 环境恢复后补跑**：dsh-plugin / ops-api / dsh-observability / bkn-feedback self-test + ci.sh 九环节全绿（A-3 代码侧已就位）。
