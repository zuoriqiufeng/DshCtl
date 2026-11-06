# dsh-plugin × i2stream-bkn 对齐计划（2026-11-06）

> 2026-11-06 · 状态：**已评审，开始实施**（用户裁定「按建议做」：工具 C1+C2 都做、bkn_ask 不移植、技能全量 39+删 6 陈旧、测试取关键契约断言+抽样同比）
> 触发：共享仓 i2stream-bkn 自 2026-10-21 后又落 10 个提交（P1-P6 开放入口、机制层 Tool 13、BUG-0009 码义兜底、进程实体补缺），TS 侧未跟进 → 本次按当前状态对齐。
> 纪律：i2stream-bkn **只读**（只按它当前状态实现 dsh 侧逻辑，不提交/不修改/不代管）。

---

## 0. 现状基准（2026-11-06 实测取证）

| 维度 | i2stream-bkn（py 基准） | dsh-plugin（TS） | 判定 |
|---|---|---|---|
| BKN 数据 | `bkn-version.json` v20261030-2，47 文件 | `validateBknContract` ok、gen 26、issues 0，sha256 全匹配 | ✅ 同步 |
| 领域工具 | **15**（12 + `diagnose_mechanism` + `bkn_ask` + `check_plan`） | **12** | ⚠️ 缺 3 |
| 进程注册集 | 10：iatrack/iadumper/ialoader/iahelper/iamonitor/iadiff/iaproxy + **iamss/pgtrack/pgreplicator** | `PROCESS_IDS` **7**；三对象文件在 `bkn/objects/` 存在但 `#iterProcessIds` 不可见 | ❌ 漂移 |
| 侧车 YAML 消费 | 9：error_semantics / error_codes / aliases(空表) / code_origin / edge_semantics / mechanisms / entry_signal / intent_routes / skill_manifest | 3：error_semantics / error_codes / skill_manifest | ⚠️ 缺 6 |
| 未登记码兜底（BUG-0009 B） | `dimension:unknown` + 产品码 → `error_codes.yaml` 精确码义（`rule=code_row_exact`、`meaning_source=qdrant_code_row`、`exact_code`/`exact_meaning`） | 无该分支 | ❌ 缺 |
| 检索指引（BUG-0009 A） | `DIAG_RETRIEVAL_GUIDE`=「store:i2stream_collection#错误码 → store:log_patterns_collection#错误码」；内部兜底解耦为 `DIAG_EVIDENCE_COLLECTION` | 旧单源 `store:log_patterns_collection#错误码` | ❌ 漂移 |
| 机制层 | `diagnose_mechanism`（Tool 13）+ `mechanisms.yaml`(228 行/4 机制/判据档/反证项) + 本体边 triggers/amplifies/manifests_as | 无工具、无边消费（relations.ts 只认 8 类旧边） | ❌ 缺 |
| P6 混合输入/堆栈 | `_partition`(desc/log/stack) + `_fetch_stack`(异常类/Caused by/帧/线程状态) + `stack_tip`→`skill:i2stream-stack-analysis` | 无 | ❌ 缺 |
| RiskGuard | risk_guard.py 自 10-21 零变更 | 已含 shadow/advisory 分档 | ✅ 同步 |
| 测试 | **911** pytest 全绿 | 168 断言 ALL PASSED | ⚠️ 覆盖薄 |
| 运行时技能 | 39 个（7 个 BKN 开发参考 + 32 运维） | `$DSH_HOME/skills` **26** 个；6 个是已改名/已删旧名（`i2stream-bkn-*` 4 个 + env-validator + topology-visualizer），缺 12 个运维技能（含 `i2stream-repclient`、`i2stream-stack-analysis`） | ❌ 陈旧 |
| 意图体系 | ask_router P1-P5（信号→意图路由，1023 行） | intent-router 22 意图（生成物，语料未含新技能） | ⚠️ 需重生成 |

> 判定口径：py `ask_router` 与 TS `intent-router` 属**同一层两种实现**（开放入口路由），不计为缺口；P6 的堆栈信号与混合分段属**语义能力**，TS 无等价物，计入缺口。

## 1. 目标与成功标准

1. **语义对齐**：进程集对齐 10；检索指引与内部兜底解耦；未登记码走码义兜底 —— 与 py 同口径。
2. **能力对齐**：工具 12 → 14（`check_plan` + `diagnose_mechanism`）；`bkn_ask` 不移植（决策 2）。
3. **技能对齐**：`$DSH_HOME/skills` 与上游 39 项一致，旧名清理干净，taxonomy 重生成。
4. **回归不破**：`ci.sh` 九环节 ALL GREEN；`eval-intent` ≥85% 覆盖、0 误采纳；契约校验 PASS。
5. **只读纪律**：全程不改 i2stream-bkn。

## 2. 实施批次（顺序 A → B → D → C1 → C2）

### 批次 A · 语义漂移修正（低风险，先做）

| # | 改动 | 落点 | 要点 |
|---|---|---|---|
| A1 | `PROCESS_IDS` 7 → 10（补 iamss/pgtrack/pgreplicator） | `code/dsh-plugin/constants.ts:81` | `resolver.#iterProcessIds` 按 id 读 `objects/<id>.bkn`，补成员即自动注册；排序为字典序，新增三项会进入既有进程清单类输出 |
| A2 | 检索指引改主库优先；新增内部兜底常量 | `constants.ts`（`DIAG_RETRIEVAL_GUIDE`）、`resolver.ts`（内部兜底引用点，含 :1390 渲染文案） | Agent 指引 = `store:i2stream_collection#错误码 → store:log_patterns_collection#错误码`；内部兜底 = `DIAG_EVIDENCE_COLLECTION`（= 旧单源），两者解耦，后续手势变更不互相牵连 |
| A3 | BUG-0009 B：未登记产品码自带码义兜底 | `resolver.ts:getRisk`（`RiskInfo` 加 `semantic_rule?`/`exact_code?`/`exact_meaning?`，`meaning_source` 增 `'qdrant_code_row'`） | 触发条件：`dim === 'dimension:unknown'` 且码形为 `-?\d{3,5}`；从 `error_codes.yaml` 精确取 `meaning`；置 `rule='code_row_exact'`、`semantic_rule=<原 rule>`、`evidence='主库码表精确命中（定义侧车 error_codes.yaml）'`；任何异常静默维持 unknown |
| A4 | `UNKNOWN_RULE` 与 `needs` 文案对齐主库优先 + 码义兜底口径 | `constants.ts`、`resolver.ts` | 与 py constants.py:163-167 逐字对齐 |
| A5 | 未登记码来源提示：`code_origin.yaml` 厂商前缀表解析进 errorSemantics | `errorSemantics.ts`（新增 loader）、`resolver.ts`（needs/提示） | 失败静默（H-15）；只对 unknown 分支生效，不覆盖已识别语义 |

**验收（A）**：self-test 新增断言（三进程对象可解析、双常量、code_row 命中/未命中/静默失败）全绿；10 个未登记码与 py 同题同比一致。

### 批次 B · 技能与意图同步

| # | 改动 | 落点 | 要点 |
|---|---|---|---|
| B1 | `skill_manage` 的 `sync` 逐个拉取上游 39 个技能 | `$DSH_HOME/skills`（运行时，不入库） | `upstreamDir=/hdd/demo/public/i2stream-bkn/skill`；单条失败记录后继续 |
| B2 | 删除 6 个陈旧目录：`i2stream-bkn-plugin/-test/-updater/-i2agent-coop`（上游已改名 `bkn-*`）、`i2stream-env-validator`、`i2stream-topology-visualizer`（上游已无） | 同上 | **删前 grep**：hotpath.md / persona / taxonomy / manual / presets 是否引用旧名 |
| B3 | `gen-intent-taxonomy` 重生成 → `eval-intent` 回归（36 例）→ 必要时重跑 `gen-hotpath-prompt` | `code/scripts/`、`code/intent-router/eval/questions.json` | taxonomy 是生成物，只接受重新生成；eval 老 24 例需复核是否被新技能抢走 |
| B4 | 文档口径：手册/plan「27 项」改实际数并记录同步命令 | `doc/ops-trial-operations-manual.md`、`doc/ops-agent-orchestration-plan.md` | — |

**验收（B）**：skills 39 项且无旧名残留；`gen-intent-taxonomy --check` 通过；`eval-intent` ≥85% / 0 误采纳；manual 与实况一致。

### 批次 D · P6 堆栈 / 混合输入信号（依赖 B 的 stack-analysis 技能到位）

| # | 改动 | 落点 | 要点 |
|---|---|---|---|
| D1 | stack 信号抽取：异常类 / `Caused by` 链 / 帧（`at `）/ 线程状态 | `code/intent-router/`（新增信号抽取，注册制，单类失败静默） | 命中即注入 `stack_tip` 指 `skill:i2stream-stack-analysis`；**不路由工具**（守 py 54 号 C 契约） |
| D2 | `diagnose_error` 混合输入粗分 desc/log/stack | `resolver.ts`（message 分段）+ 工具层提示语 | 仅堆栈输入时给明确指引而非「未识别」；分段结果只影响提示，不改既有键 |

**验收（D）**：堆栈样例 3 条（Java 异常链 / OOM / 线程阻塞）注入 `stack_tip` 且指向正确 skill；非堆栈文本不改行为。

### 批次 C · 工具补齐

| # | 改动 | 规模 | 要点 |
|---|---|---|---|
| C1 | `check_plan` 移植 | 小（py `plan_check.py` 120 行） | 输入 `{action, state}`（动作串可多步）；复用 riskGuard 的约束/前置解析，输出 violations；纯函数、无状态 |
| C2 | `diagnose_mechanism` 移植 | 中（py `tools.py` ~200 行 + `mechanisms.yaml` + `mechanism_detect.py`） | 解析 mechanisms.yaml（4 机制 / 判据档 auto·sampling·cross_source·human_only / `counter_check` 反证项 / `evidence_strength` hard·soft）；候选召回优先（默认 4，上限 10）；structural 判据用 `fault_mechanism.necessary_criteria` 点名的既有关系路径核验（不给 `affected_unit` 时 `checkable=partial`）；输出「候选机制 + 判据状态 + 下一步」，不自造数据 |

**验收（C）**：`check_plan` 对「start_sync_rule@RUNNING」等 3 例给出违规；`diagnose_mechanism` 对 3 个机制样例给出候选与判据状态，与 py 同题一致。

## 3. 公共接口与数据结构变更

- **新增工具**：`check_plan{action, state}`、`diagnose_mechanism{entry, observations?, affected_unit?, max_candidates?}`。
- **RiskInfo 扩展**（可选字段，向后兼容）：`semantic_rule?`、`exact_code?`、`exact_meaning?`；`meaning_source` 枚举增加 `'qdrant_code_row'`。
- **新增常量**：`DIAG_EVIDENCE_COLLECTION`；`PROCESS_IDS` 成员 +3。
- **数据流**：机制判据读 `plugin/mechanisms.yaml`（只读）；结构判据走 `relations.ts` 既有遍历，**不新增边类型注册**，只允许判据声明的那 5 类关系。

## 4. 测试与验收总表

| 项 | 标准 |
|---|---|
| self-test | 存量 168 断言不破 + 新增：PROCESS 三对象、guide 双常量、code_row 兜底三态、check_plan 违规、diagnose_mechanism 候选/判据 |
| CI | `bash code/dshctl/ci.sh` 九环节 ALL GREEN |
| eval | `eval-intent` 覆盖 ≥85%、误采纳 0、意图错判 0 |
| 契约 | `validateBknContract` ok / issues=0 |
| 同题同比 | 16 例（10 未登记码 + 3 进程 + 3 机制），py/TS 结论与键位比对表回填本文 §6 |
| 实例 | apply + restart 后 `/v1/capabilities` tools 12→14、skills 26→39、0 pending |

## 5. 边界与失败模式

- BKN 只读：全部改动落在 dsh-info；上游再改只会让契约哈希失配发声，不静默错答。
- `mechanisms.yaml` 缺失/坏行 → 机制工具降级「无判据」（H-15），不抛错。
- `error_codes.yaml` 缺失 → code_row 兜底静默跳过，维持 unknown。
- 技能同步单条失败 → 记录继续；删除旧目录前必须有引用检查。
- Qdrant/embed 不可达 → 既有 H-15 静默降级不变。
- **外部阻塞（沿用）**：模型网关 `/v1/models` 空清单 + 会话默认模型未配置 → 端到端对话验收（bench-4q）继续挂账；本轮只做模块级与 HTTP 只读面验证。

## 6. 验收记录（实施后回填）

（待回填）

## 7. 决策记录

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| 1 | 工具补齐范围 | **C1+C2 都做** | check_plan 小且闭环；diagnose_mechanism 是上游本期主投入 |
| 2 | `bkn_ask` 是否移植 | **不移植** | 与 DSH「模型自选工具 + intent-router 注入」架构重复；依赖 ask_router 整层（1023 行）；确需另立专项 |
| 3 | 技能同步口径 | **全量 39 + 删 6 陈旧** | 与上游一致，保留 7 个 BKN 开发参考技能 |
| 4 | 测试深度 | **关键契约断言 + 抽样同比** | 不逐条镜像 py 911 条；关键路径有断言 + 同题比对即可 |

## 8. 踩坑沉淀

（实施中登记：症状 / 根因 / 修复）
