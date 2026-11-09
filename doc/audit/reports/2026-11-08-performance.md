# 性能 / 资源审计报告（hot path · 缓存 · 超时护栏 · deadline）

- 审计对象：`dsh-info`（intent-router / dsh-plugin 检索栈 / ops-api / sidecar）
- 审计日期：2026-11-08　视角：performance
- 审计员：audit-performance（只读审计）
- 基线权威规则：AGENTS.md（R8/R11 红线、Sci 纪律、H-15 降级铁律、诚实原则、回退单层）

## 0 方法与日志样本

方法：源码静态推理（关键模块通读）+ 可运行自包含脚本实测。
本项目为 GitHub 浅克隆，`deepseek-harness/` 与 `.dsh-home/` 不在克隆内（.gitignore），
依赖 harness 的 TS 自测（dsh-plugin/ops-api/intent-router 的 self-test.ts）**无法直接运行**。
本报告实测均用不依赖 harness 的纯模块（intent-router 的 taxonomy/layer1/layer2/bm25/engine）在
node v24.21.0（`--experimental-strip-types`）下直接 import 运行；探针放系统 temp，不落仓库。

### 实测日志样本
- intent-router 热路径（engine.classify，22 意图，索引/别名建好后复用，5000 次）：
  `intents:22 skipped:0 alias entries:69 BM25 docs:22 avgLen:288`
  `classify N=5000 avg=0.020ms p50=0.020 p95=0.044 p99=0.106 max=0.528 ms`
- BM25 全量索引构建 + 查询评分（BM25Scorer，800 字符/文档合成语料，模拟 retrieval 全库 BM25）：
  `n=1000 build=55ms score avg=0.22ms`
  `n=5000 build=259ms score avg=1.30ms`
  `n=20000 build=890ms score avg=4.41ms`
  `n=50000 build=2273ms score avg=12.4ms`
  构建开销随文档数线性增长，**全部在主线程（Node 事件循环）上同步执行**。
- 无法实测项（待 harness / 现网环境恢复）：Qdrant 实际 collection 规模、真实检索往返时延、ops-api 全链路。

## 1 发现清单

| # | 级别 | 结论 | 证据 | 定性 |
|---|---|---|---|---|
| D-1 | 确认(实测) | intent-router 热路径极快，符合设计（约 0.02ms/次，p95≈0.04ms） | 源码 + 实测 | 无缺陷(正向确认) |
| D-2 | 确认(实测+源码) | dsh-plugin 首次检索触发的 BM25 全量建索引在主线程同步、无 worker、无整体 deadline，首查放大（50k≈2.3s CPU+全库 scroll 往返） | 源码 + 实测 | 风险 |
| D-3 | 确认(源码) | 多段检索无批量整体 deadline，单调用 8s 硬超时但整链路最坏时延无界；mini_first resolveStandardBatch 为 N+1 次 scroll（注释自承 top_k=5≈10 往返） | 源码(注释自证) | 风险 |
| D-4 | 确认(源码) | ops-api 调 LLM 前同步 await memory.recall（2s）；熔断只认失败，慢但 200 的 Gateway 每请求固定加近 2s 不触发熔断 | 源码两处 | 风险 |
| D-5 | 确认(源码) | intent-router 默认 observe 在每 agent/pre-step 同步 appendFileSync 写 JSONL + 双写 | 源码两处 | 观察 |
| D-6 | 确认(源码) | BM25 缓存失效只按 points_count(size)，原位更新条数不变会留脏；周期刷新默认关闭 | 源码 | 观察 |
| D-7 | 确认(源码) | dsh-plugin 检索无 per-query embed 缓存，每次 search 重新 embed；decompose ≤8 维每请求最多 8 次独立 embed+ANN | 源码 | 观察 |
| D-8 | 确认(源码) | embed 原型指纹仅 id+语料长度（内容同长不同文误命中）；单实例内 fingerprint 恒定，reset() 是死路径 | 源码 | 观察 |
| D-9 | 观察 | embed sidecar ThreadingHTTPServer 每连接一线程无上限、encode CPU 密集，无并发/背压（仅单请求 MAX_TEXTS=64） | 源码 | 观察 |
| D-10 | 观察 | ops-api memoryKeysSeen Set 运行期只增（dispose 才 flush），长跑随唯一 session key 缓慢增长 | 源码 | 观察 |
| D-11 | 观察 | decompose 把单次工具检索放大为最多 8 个顺序子查询（密集+稀疏全套），开启时每请求成本可 ×8 | 源码 | 观察 |

确认口径：D-1~D-8 均「源码一处 + 跨文件/运行一处」（含 D-2 实测数值）；D-9~D-11 无第二证据线的关键数值支撑，归 observation。

## 2 逐条证据

### D-1 intent-router 热路径符合设计（无缺陷）
- 源码：`code/intent-router/index.ts` apply() 中 `scorer: buildScorer(intents)` 与 `aliasIndex` 仅建插件时建一次，`engine.classify` 复用 `deps.scorer ?? buildScorer(...)`（热路径命中已建 scorer）；向量默认 `useVector:false`。
- 实测：node 直跑 classify，22 意图下 avg≈0.020ms / p95 0.044ms / max 0.528ms。
- 交叉：`code/intent-router/self-test.ts` 自带断言 `p95<10ms`、`max<30ms`（其含每次重建索引代价，本实测为复用索引更严口径）。

### D-2 首次检索的 BM25 全量构建在主线程、无整体 deadline（风险）
- 源码：`code/dsh-plugin/retrieval.ts` `getBm25Index()`：`bm25Ready.add(name)` 后 do/while 用 `scrollPoints(limit:200)` 翻全 collection，逐条 `slice(0,1000)` 后 `index.indexDocuments(docs)`；在首次 `searchFull/searchChunkLevel/searchMiniFirst` 调用栈里被 `bm25Search` 触发，即首个请求承担整库建索引。
- 实测：合成 800 字符文档，indexDocuments 主线程 build：1k=55ms / 5k=259ms / 20k=890ms / 50k=2273ms（线性），期间事件循环被阻塞（无 worker）。
- 交叉：`code/dsh-plugin/index.ts` 无检索前预热/warmup；BM25 刷新默认 `bm25RefreshSec=0`（关闭）。滚动每页受 `httpJson` 的 `AbortSignal.timeout(8000)` 单调用护栏，但整轮 do/while 无批量 deadline，最坏 = 页数×8s。

### D-3 多段检索无批量整体 deadline；mini_first N+1 scroll（风险）
- 源码 1：`httpJson` 对每个 HTTP 调用 `AbortSignal.timeout(timeoutMs)`（8s），是唯一超时护栏。
- 源码 2：`searchFull` 顺序执行 validateDimension → embed → qdrant query →(fallback) precisionGuard→ bm25Search；`searchMiniFirst` 另串 resolveStandardBatch。外部依赖无共享 AbortSignal/deadline。
- 源码 3（注释自证）：`resolveStandardBatch` 注释 [暂不改] 循环单点 scroll，与 Hermes 一致（top_k=5 约 10 次往返）——每个 parent key 一次 scroll，N 个父块 = N 次网络往返。
- 交叉：ops-api 整体兜底只有 `turnTimeoutSec`（默认 120s，`code/ops-api/index.ts:137`），非检索子链专属 deadline。

### D-4 ops-api 请求路径同步 recall，慢 Gateway 不触发熔断（风险）
- 源码 1：`code/ops-api/index.ts:801` 与 `:970`：`const recalled = await memory.recall(memoryKey, ...)` 在 `runTurn` 之前同步 await。
- 源码 2：`code/ops-api/memory.ts` `post()` 用 `timeouts.recall=2000`；`recordFailure()` 只在 `!r.ok`（HTTP 非 2xx / 网络错 / 超时）时计数，slow-but-200 不计数。
- 交叉：熔断器 threshold=5 连续失败→open 60s；`shouldSkip()` 只在 open/半开探测期跳过。稳定劣化但返回 200 的 Gateway 会让 recall 每请求固定接近上限 2s 且熔断不介入。

### D-5 intent-router 默认 observe 每次 pre-step 同步写盘（观察）
- 源码 1：`code/intent-router/index.ts` 在 observe/inject 分支均 `file.decision(entry)`，apply 默认 `mode:observe`。
- 源码 2：`code/intent-router/logfile.ts` decision 走 `appendFileSync`（同步 syscall，非流式/非批量）。
- 交叉：挂钩 `ctx.on(agent/pre-step)` 每回合每步触发；分类已证 0.02ms，磁盘写在默认配置下成为热路径主要可省项。

### D-6 BM25 缓存失效口径只有 size（观察）
- 源码：`refreshBm25IfStale` 用 `getPointsCount → bundle.pointsCount !== count ? resetBm25 : keep`；原位编辑（条数不变内容变）不触发失效。
- 交叉：无 mtime/content 指纹；刷新由 `bm25RefreshSec`（默认 0）关闭时完全不跑（`index.ts:213-220`）。

### D-7 检索无 embed 缓存（观察）
- 源码：`retrieval.ts` `searchChunkLevel`(:323)、`searchFull`(:369) 每调用 `const vector = await embed(query)`，无 key→vector 存储；`decomposeQueries` 至多 8 个维度查询各自 embed+ANN。
- 影响：同 query 跨请求反复编码；decompose 模式单请求最多 ×8。

### D-8 embed 原型指纹不稳（观察）
- 源码：`embed.ts` `fingerprint` = `intent.id:embedCorpusOf(intent).length` 拼接，只含 id 与语料长度，不含内容哈希；同长变化不全失效。
- 交叉：指纹在 `createEmbedProvider` 构造时算一次为常量 `stamp`，实例内 `reset()` 比较的 `lastStamp` 恒等 → 单实例内该失效机制是死路径。
- 影响：实践影响小（提供者随插件重建），但作为缓存键不稳定。

### D-9 sidecar 无并发上限（观察）
- 源码：`code/sidecars/embed-server.py` 用 `ThreadingHTTPServer`（每连接一线程无上限），do_POST 里 `model.encode(texts)` 为 CPU 密集；无信号量/最大并发；仅 `MAX_TEXTS=64` 限单请求体量。
- 优点：启动即 `get_model()` 预载，首个请求不承担加载延迟。

### D-10 ops-api memoryKeysSeen 只增不减（观察）
- 源码：`index.ts:289` `const memoryKeysSeen = new Set<string>()`；`:800/969` 持续 `.add`；仅 `:1177-1185`（dispose）读它发 session/end，运行期不清理。
- 影响：长跑进程随唯一 session key 数线性增长（单字符串/会话），量级低，慢泄漏。

### D-11 decompose 模式放大每请求工作（观察）
- 源码：`DECOMPOSE_TEMPLATES` 为各工具声明多个维度模板；`decomposeQueries` 产 `[MIN=3, MAX=8]` 个子查询，每个聚合前各自完整检索（embed+ANN+BM25/RRF）。开启时单次工具调用成本至多 ×8，顺序执行且无整体 deadline（见 D-3）。

## 3 结论

1. **intent-router 热路径达标（无缺陷）**：实测 classify 约 0.02ms、p95≈0.04ms，与设计所述"本地路径 p95 ~1ms 量级"一致且更优；索引/别名一次构建复用、向量默认关闭，无热路径泄漏，可作基线。
2. **检索链最薄弱点 = 整体 deadline 缺失 + 首查全量建索引在主线程**（D-2/D-3）：单调用有 8s 硬超时，但整条多段链路无批量 deadline；首次 `searchXxx` 同步 scroll 全库并在主线程建 BM25（实测 50k≈2.3s+全库往返，超过 8s 单调用），窗口期（bm25RefreshSec=0）内索引一次性构建。建议后续加检索整体 deadline / 索引构建移出请求线程或预热。
3. **ops-api 慢速 memory Gateway 固定吃掉每请求 ≤2s 且熔断不介入**（D-4）：串行前导 recall（2s 超时）只对"失败"熔断、对"慢但 200"无退避。相对其余模块（熔断/背压/超时数值齐全、supervisor 有界 spawn 与 giveUp）这是唯一请求路径时间漏斗。

## 4 受限声明

- 依赖 harness 的 self-test（dsh-plugin/ops-api/intent-router）因浅克隆缺 `deepseek-harness/` 未能运行，静态结论未经 harness 内 full-stack 回归。
- Qdrant collection 真实规模 / 真实链路往返延迟 / ops-api 端到端时延未能实测（无现网环境）；D-2/D-3/D-4 绝对值需现网复核；D-2 构建耗时为纯 CPU 部分，真实另有全库 scroll 往返与 payload 传输。
- embed sidecar / qdrant 连接池与并发行为未在压力下验证；D-9/D-11 为源码推断。
- 所有结论的第二证据请按证据列核对；无第二条的已归 observation（D-9/D-10/D-11）。

—— 报告完，audit-performance，2026-11-08
