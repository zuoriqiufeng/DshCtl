# ops-agent-intent-router-plan —— 分层意图识别插件（方案 / 实施 / 验收回填）

> 2026-10-08 起 · 需求来源：用户「意图识别一律走大模型太慢、太费 token，改为 ①正则 ②算法 ③大模型 三层」。
> 边界（用户拍板）：**第 3 层不新增任何大模型调用**；v1 **只注入提示**；意图**对齐现有 12 个 BKN 工具 + skills**。
> 状态：✅ 已实施 + 验收回填（本文件 §4）。

---

## 1. 交付物

| 件 | 位置 | 说明 |
|---|---|---|
| 插件本体 | `code/intent-router/` | 13 个 TS/JSON 文件（含文件日志模块 `logfile.ts`）+ README + 实现设计（`doc/intent-router-design.md`） |
| 意图体系生成器 | `code/scripts/gen-intent-taxonomy.ts` | 从工具/skill_manifest/SKILL.md/别名表/hotpath 派生（`--check` 可做 CI 漂移守护） |
| 评测与标定工具 | `code/scripts/eval-intent.ts` | 回归（退出码）+ 门限扫描 `--sweep` + 向量对照 `--with-vector` |
| 标注集 | `code/intent-router/eval/questions.json` | 24 条（13 采纳 / 11 放弃），门限标定与回归依据 |
| 自测 | `code/intent-router/self-test.ts` | 77 项断言，含标定集分离度与性能门槛 |

三层结构：层 1 正则/精确（错误码、寒暄、显式工具名）→ 层 2 别名归一 + BM25 原型 + 置信门（+ 可选层 2c 向量）
→ 层 3 不干预（交回主模型）。落地动作为 `agent/pre-step` 追加一条带免责声明的提示消息。

## 2. 实施步骤（逐阶段自测 → 重启 → 实测 → 回填）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 插件骨架 + 意图体系生成器 + 层 1 + 层 2a/2b + 门限 + self-test | ✅ |
| P2 | 层 2c 向量（BGE sidecar + 批量预热 + 降级） | ✅ 实现并实测 → **默认关闭**（见 §5 踩坑④） |
| P3 | 观测（JSONL 决策日志 + `tools/result` 对照）+ eval 工具 + 标注集 | ✅ |
| P4 | 实例实测：registry 登记 → domain.yml → `check`/`apply` → 重启 → observe/inject 验证 | ✅ |
| P5 | 文档与登记：README/设计/plan、ci.sh、AGENTS、user-manual | ✅ |

## 3. 关键设计取舍（细节见 `code/intent-router/doc/intent-router-design.md`）

- **挂点** `agent/pre-step`：唯一能改写/注入用户消息的正式入口（上游 `tool-skill` 的确定性注入同款）；ops-api 零改动，HTTP 面与 GUI 会话都覆盖。
- **门限指标** 绝对分下限 + 相对间隔（不是份额）；语料做了词卫生（剔模态疑问词与泛化触发器）。
- **顺序补救** 向量只在 BM25 判不出时才参与，并要求"BM25 前 2 名互证"。
- **安全网三件** 门限 / 免责声明 / 默认 observe。

## 4. 验收回填

| 用例 | 结果 | 证据 |
|---|---|---|
| A1 self-test 全绿 | ✅ | `node --import tsx/esm code/intent-router/self-test.ts` → **77 passed, 0 failed, ALL PASSED** |
| A2 标注集分离度 | ✅ | 采纳组 **12/13（92.3%）**、意图错判 **0**、放弃组误采纳 **0/11**（`eval-intent.ts` PASSED，退出码 0） |
| A3 门限扫描有最优点 | ✅ | `--sweep`：(16, 0.35)=92%/0；放宽到 (16,0.20)=92%/**2 误采纳**；(8,·)=1~4 误采纳；(·,0.50)=62% 覆盖 → 当前默认落在唯一最优点 |
| A4 性能 | ✅ | 层 1+2 本地 p50 **0.66ms** / p95 **1.0ms** / max 1.4ms（自测门槛 p95<10ms、max<30ms）；bench-tools 的 <100ms 口径不受影响 |
| A5 存量断言不破 | ✅ | `dshctl-selftest` **ALL PASSED**（新增插件未破坏 dshctl 既有断言） |
| A6 CI 一键 | ✅ | `bash code/dshctl/ci.sh` → 六环节（新增 [4/6] intent-router self-test）**ALL GREEN** |
| A7 领域契约 | ✅ | `dshctl check ops --ci` → **0 error / 1 warn**（唯一 warn 是既有的上游新增行评估）；R12 对 intent-router **pass** |
| A8 apply 幂等 | ✅ | `dshctl apply ops --yes` 后 `dshctl diff ops` **空**（生成面与现状一致） |
| A9 实例观测（observe） | ✅ | 重启后发两问，`$DSH_HOME/logs/intent-router.jsonl` 落两行（**该文件形态已在 §L 迭代改为按日期命名的文本日志**）：`ORA-00942→diagnose_error(tier=rule,slot=error_code)` ms=0；`增量同步卡住不动了→diagnose_incremental_stuck(tier=alias,rule=alias:同步卡住)` ms=2；含 bm25 排名 |
| A10 实例注入（inject） | ✅ | 切 `mode=inject` 后请求，会话记录（多帧 zstd 逐帧解压）出现 `user/message` `source.kind="intent-router"`，正文为渲染后的提示（含槽位 `error_code=ORA-00942` 与免责声明）；观测日志该行 `injected:true` |
| W1 外部模型网关不可用（非本插件问题） | ⚠️ | 注入后的 `turn/end` 报 `llm-deepseek: no API key ...` / `503 model_not_found`——即既有遗留问题（见 orchestration-plan §8 遗留项），与意图识别无关；本插件的验证只依赖 pre-step 之前的链路 |
| W2 标注集规模 | ⚠️ | 仅 24 条（领域内自建）。门限按此标定，样本仍小；后续用 observe 日志的"识别 vs 主模型实际调用"对照持续校准 |
| V1 向量救回率 | ❌（结论：默认关闭） | 9 条同义改写样本向量**救回 0/9**；含向量与纯 BM25 在标注集上结果**完全一致**；逐原型取最大相似度后短问法余弦不可分（"看下日志"→0.827 错、"创建规则"→0.784 错）。故 `useVector` 默认 `false`，代码保留待复核（README §5 给了复核步骤） |

## 5. 踩坑沉淀（症状 / 根因 / 修复）

1. **门限用"份额"导致大面积误杀**。症状：8 条冒烟问句只采纳 2 条，其中 `share` 全在 0.17~0.50。
   根因：23 条意图共享大量通用词，份额天然被摊薄，0.35 的份额门限砍掉了正确结果。
   修复：换成"绝对分下限 + top1 相对第二名间隔"，并按 24 条标注集标定（16 / 0.35）；`--sweep` 可复现最优点。
2. **模态疑问词进语料 → 误采纳**。症状："能不能便宜点" 被判成 `check_action_risk`（BM25 15.5、间隔 0.52，双门限都拦不住）。
   根因：`keywords` 里放了"能不能/可以吗/支持吗"这类在任意问句都出现的词，匹配上即被当作意图证据。
   修复：生成器做**语料词卫生**——剔除模态疑问词与泛化动词（怎么/如何/准备/建议…），并把 SKILL.md 的泛化触发器
   （"看日志/看规则/规则状态"）列入拒绝表；该样本 BM25 降到 10.4，落到绝对分下限之下。
3. **向量"接管"门限反而降低准确率**。症状：含向量的采纳率从 12/13 掉到 8/13。
   根因：初版把两路分数一起 RRF 后由向量分支判定，等于让向量覆盖 BM25 的定论；BM25 有把握的样本被不足 0.62 的余弦误杀。
   修复：改为**顺序补救**（BM25 先判；只在判不出且存在重叠时才调向量，并要求 BM25 前 2 名互证）；
   自测新增"BM25 有定论时向量调用次数为 0"的行为断言，热路径保持 ~1ms。
4. **短问法上句向量无可用工作点**。症状：逐原型取最大相似度后，"看下日志"（sql_generation 0.827）、"创建规则"（get_prerequisites 0.784）这类无意图输入反而得分更高。
   根因：超短中文文本在 embedding 空间里与任何意图都近，提高召回必然抬高误报，没有任何阈值能分开。
   修复：`useVector` 默认 **false**（插件零外部依赖、热路径不受影响），并在 README/设计文档留下复核方法与判定标准。
5. **同一症状多 owner 会让别名失效**。症状：`incremental_stuck` 若同时挂在两个 skill 意图上，别名索引直接不收（歧义保护），最有价值的症状口语全部失效。
   修复：`SYMPTOM_OWNER` 只留唯一 owner（其余进 `skills[]`），并把 `connection_error` 归到**工具**意图 `diagnose_db_link`——既减少相邻意图抢票，注入的"调用某工具"也比"加载某 Skill"更可执行。
6. **插件自身的日志等于没打**。症状：实例运行正常，但 `journalctl -u dsh-ops-trial` 只有 systemd 生命周期行与一行启动命令，插件的 warn/error 一条也看不到。
   根因：cordis 的 `LoggerService` 默认只有内存 ring buffer（1000 条），ops profile 没有 console exporter，`ctx.logger` 的输出没有任何持久去向——重启即丢。
   修复：`dualLogger` 把 harness logger 与文件日志合成一条（同一条消息两边都到）；致命信息（如"意图体系加载失败，插件不生效"）改用 `error` 级；日志写入失败本身一次性报 **stderr**（此时 journalctl 是唯一还看得见的通道）。
7. **项目里只有"大小轮转"的 TS 移植，日期维度缺失**。症状：想按"文件名带日期 + 跨日自动新文件 + 按天清理"落地时，TS 侧 grep `day_file|retentionDays` 零命中，只有 `rotateIfNeeded`。
   根因：DSH 移植是"部分移植"——`log_rotate.py` 的 `day_file_path`/`rotate_day_file`/`_prune_old_days`/`iter_data_files` 从未移植，且现有调用方（`logGap`）仍写逻辑基名。
   修复：按 Python 1:1 补齐四个函数（`logfile.ts`），大小维度仍复用 dsh-plugin；两处刻意偏差（prune 频率收敛、日期正则泛化）在文件头注释里标明，避免后续被当成 bug 改回去。
8. **测试用例的日期算错会误判实现**。症状：retention 测试断言"保留期内文件不动"失败，且 `removed=4`（期望 2）。
   根因：用例里把 `2026-09-01` 当作"近期"，但基准是 `2026-10-08` 保留 30 天 → 截止 `2026-09-08`，该文件其实**已超期**，被删是正确行为。
   修复：用例日期刻意拉开（旧 2026-01-01 / 近 2026-10-05 / 当日），并在注释里写明"含时区偏移也不影响判定"——避免测试与被测语义各说各话。
。症状：无关输入（"嗯"）也会触发一次 100ms 的向量调用。
   根因：跨方法互证要求"BM25 前 K 名"，零重叠时该条件不可能成立，调用纯属浪费。
   修复：`reason === 'no-overlap'` 时不调用向量（自测有断言）。

## 5.1 日志迭代（2026-10-09）：可配置目录 + 双维轮转 + 易读格式

需求：插件的排查日志要能配置输出目录、按大小与日期轮转、文件名带日期、格式简单易懂。

**调研结论（决定了改法）**：① 项目已有可复用的轮转实现 `rotateIfNeeded`（`code/dsh-plugin/supplement.ts:126`，1:1 移植自共享 BKN），但**日期维度没有 TS 版**——规范源是 `i2stream-bkn/plugin/log_rotate.py`；
② intent-router 的日志**没有任何程序在读**（全盘 grep 只有插件自身/README/domain.yml 注释/本文件），改格式安全；
③ `ctx.logger` 在 ops 实例里**没有持久去向**（cordis 内存 ring buffer，profile 无 console exporter，`journalctl -u dsh-ops-trial` 零命中）——插件自身的 warn/error 原本等于没打。

**交付**：新增 `code/intent-router/logfile.ts`（纯模块）——`dayFilePath`/`rotateDayFile`/`pruneOldDays`/`listDataFiles` 按 `log_rotate.py` 1:1 移植，大小维度复用 dsh-plugin；`formatLine`/`formatDecision`/`formatArgs` 负责易读文本与 printf 格式化；
`createFileLog` 提供级别门（off/error/warn/info/debug）与写失败静默；`index.ts` 用 `dualLogger` 把插件自身日志与文件日志合成一条（这是"排查困难"的主因）。

**两处刻意偏差**（语义不变，注释已写明）：prune 频率从"每次写都 glob"收敛为"每进程每天一次 + 首次写入一次"；日期提取正则从硬编码 `.jsonl` 泛化到实际后缀。

| 用例 | 结果 | 证据 |
|---|---|---|
| L1 日志模块自测 | ✅ | self-test 新增 [11] 段 36 条断言（原 77 → **113 全绿**）：文件名带日期 / 跨日开新文件（注入 now）/ 超限切 `.1` 且旧内容落在 `.1` / retention 删旧留新（含分片）/ `retention=0` 不删 / 级别门（info 不写 debug 行）/ 行内关键字段与中文值 / info 截断 vs debug 全文 / 写失败静默且只报一次 / `formatArgs` 对齐 `%s %d %i %f %o %%` 与多余参数 / 换行与引号转义 |
| L2 插件自身日志落盘 | ✅ | 实例重启后文件首两行即为插件生命周期信息：`[intent-router] 意图体系已加载：22 条（跳过 0），mode=inject`、`已挂载 agent/pre-step（… 日志级别=info，日志文件=…/intent-router_2026-10-09.log）` |
| L3 决策行易读 | ✅ | `2026-10-09 10:19:57.054 +08:00 INFO  decision turn=1 sid=session-85fff276-… mode=inject accepted=yes reason=accepted intent=diagnose_error kind=tool tier=rule rule=exact:diagnose_error slots=error_code:ORA-00942 ms=0 inject=yes text="ORA-00942 是什么原因？"`（本地时间带偏移、ASCII key 便于 grep） |
| L4 debug 明细 | ✅ | 临时 `logLevel: debug` → 决策行追加 `rank=check_action_risk:67.27,resolve_operation:35.02,diagnose_incremental_stuck:11.13`；恢复 info 后不再出现 |
| L5 大小轮转 | ✅ | 临时 `logMaxBytes: 600` → 出现 `intent-router_2026-10-09.log.1`（较新）与 `.log.2`（最旧 931B），语义与 BKN 一致（`.1` 最新） |
| L6 旧 JSONL 停止增长 | ✅ | 迭代后多次请求，`.dsh-home/logs/intent-router.jsonl` 仍为 3 行（历史文件未删，`listDataFiles` 兼容旧命名） |
| L7 配置面与契约 | ✅ | `dshctl check ops --ci` 0 error；`apply` 后 `diff` 空；生成物含 `logLevel: info` 与说明注释 |

## 6. 未做 / 后续

- **observe→inject 的线上校准**：本次直接以 `inject` 做了注入验证（A10），但**长期应以观测数据抽样核对误识别率**再决定是否保持 inject；
  切换判据写在插件 README §7。
- **层 2c 向量复核**：按 README §5 的两组样本重测；只有出现"BM25 判不出、向量判对"且放弃组仍零误采纳时才值得打开。
- **按意图分流模型**（`agent/request`：简单意图走小模型）与**不经模型直答**（`llm/stream` 短路）：
  本次明确不做（用户拍板 v1 只注入），挂点已在设计文档记明。
- **提示词收窄**（只注入相关热路径段而非全量）：需要更早的时点预计算（`agent/inbox/inserted`），单独立项。
- **标注集扩容**：从 observe 日志与真实会话里持续收集，目标 ≥100 条，再复核门限。

## 7. 改动文件清单

新增：`code/intent-router/**`（插件文件 + README + doc/设计 + eval/questions.json；日志迭代新增 `logfile.ts`）、
`code/scripts/gen-intent-taxonomy.ts`、`code/scripts/eval-intent.ts`、本文件。

修改：`domains/ops/domain.yml`（plugins[] 加 intent-router，mode=inject、useVector=false）、
`plugin-registry/registry.yml`（登记，`dshctl plugin add`）、`code/dshctl/ci.sh`（加 [4/6] 自测环节）、
`AGENTS.md`（§1 表 + §8 命令）、`doc/dshctl-user-manual.md`（插件面）。

生成物（不手改）：`code/intent-router/taxonomy.generated.json`、`.dsh-home/profiles/ops/cordis.patch.yml`（`dshctl apply` 产出）。
