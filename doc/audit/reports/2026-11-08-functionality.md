# 功能正确性审计报告 —— 输出契约 / 金样 / 错误路径 / 断言掩盖
- 审计日期：2026-11-08
- 审计员：audit-functionality（智能审计团队 · functionality 视角）
- 被审根：C:/Users/Admin/audit/dsh-info
- 权威规则：AGENTS.md（R8/R11 红线、H-15 降级铁律、回退单层、诚实原则、msg 工作流 DoD）

## 0 方法与日志样本

### 0.1 可执行性盘点（素材约束 = GitHub 浅克隆，deepseek-harness/ 与 .dsh-home/ 被 .gitignore 排除）
- 能动态运行（不依赖 harness，node v24.14.1 原生类型剥离直跑）：
  - code/intent-router/self-test.ts —— **运行失败：121 passed, 1 failed（exit 1）（见 D-1）**；其余能力断言（层1/层2/门限/engine/inject/logfile/stack）全绿。
  - code/ops-skill-manager/self-test.ts —— **29 passed, 0 failed → ALL PASSED**（store/ledger/ops/curator/sync 全通过）。
- 待 harness 环境恢复（依赖 @deepseek-ai/* 包或 /hdd/demo/public/i2stream-bkn 共享 BKN，本站不可得，未造假跑）：
  - dsh-plugin/self-test.ts（import index.ts→@deepseek-ai/cordis+schemastery；resolver 读 /hdd BKN）
  - ops-api/self-test.ts（import index.ts；需 stub ctx + 真端口）
  - dsh-observability/self-test.ts、bkn-feedback/self-test.ts（import index.ts→@deepseek-ai/schemastery）
  - dshctl/self-test.ts（core.ts/yml.ts/replace.ts import yaml 包，dshctl 下无 node_modules）
  - code/scripts/{eval-intent,gen-intent-taxonomy,bench-tools,sync-skills,gen-hotpath-prompt}.ts（读 /hdd BKN）

### 0.2 日志样本（本次动态取证实际输出）

    $ node code\intent-router\self-test.ts
    [9] 采纳组 21/24（错误意图 0）· 放弃组误采纳 0/13   ✓
    [10] p50=0.71ms p95=1.32ms max=2.19ms（含每次重建 BM25 索引） ✓
    [11] 文件日志 ... ✗ listDataFiles 兼容日文件与分片
    ...
    121 passed, 1 failed
    FAILED ❌

    $ node code\ops-skill-manager\self-test.ts
    ...
    29 passed, 0 failed
    ALL PASSED ✅

---

## 1 发现清单（编号 D-x）

| 编号 | 性质 | 严重度 | 标题 |
|---|---|---|---|
| D-1 | observation（可复现，本次实测真失败） | 中 | intent-router 自测 [11]「listDataFiles 兼容日文件与分片」在非 POSIX 平台必失败（路径分隔符假设） |
| D-2 | observation | 低 | dsh-plugin 自测 [3]「identifyHit 与 guardDecision 一致」断言恒真（tautology），未真正校验单源一致性 |
| D-3 | observation | 低 | layer2/engine 的 reason 枚举文档注释与实际返回值漂移（low-share/no-decision 未产出、漏 low-score/vector-uncorroborated/unknown-intent） |
| D-4 | observation | 低 | 别名表（ERROR/SYMPTOM_ALIASES）在 dsh-plugin/constants.ts 与 intent-router/aliases.ts 双份手工同步，当前 0 漂移但无自动化防漂移闸门 |
| D-5 | observation | 低 | intent-router 自测 [8] 冒烟「结论合法」断言在未采纳分支恒真（弱断言，被 [9] 标定集兜底） |
| D-6 | observation | 低 | AGENTS.md §1「dsh-plugin 12 工具」口径过时（实际注册 14，registry.yml 已更新为 14） |

> confirmed 判定：D-1 有「源码一处 + 本次真实运行失败一处」双证，但属自测可移植性而非产品功能缺陷 → 归 observation；D-2~D-6 给不出运行/跨文件第二条证据 → 一律归 observation，不冒充 confirmed。**未发现任何会引发生产功能错误的独立 confirmed 缺陷。**

## 2 逐条证据

### D-1（observation）intent-router 自测 [11] 非 POSIX 平台必失败
- 源码一处：code/intent-router/logfile.ts:268-287 的 listDataFiles 以 join(dir, name) 拼路径并排序返回；Windows 上 join 产反斜杠路径。
- 测试侧一处：code/intent-router/self-test.ts:484 用 listDataFiles(base).map(f => f.split("/").pop()) 后再 startsWith("intent-router_…log") 判定——POSIX 按 / 拆得文件名成立；Windows 绝对路径 split("/") 不拆、pop() 返回整串 → 恒不 startsWith → **恒 FALSE**。
- 运行一处：本次 node self-test.ts 实测「121 passed, 1 failed」，红项仅此（§0.2 日志）。
- 影响：code/dshctl/ci.sh 第 4 环节在非 POSIX（如本审计 Windows 宿主）必红；在预期 Linux 部署下通过。属自测可移植性缺陷，非 listDataFiles 产品缺陷，且该「日文件+分片兼容枚举」断言在 Windows 上形同只跑不查并制造假红。

### D-2（observation）dsh-plugin 自测「identifyHit 与 guardDecision 一致」为恒真断言
- 源码一处：code/dsh-plugin/self-test.ts:195-213 中 h1=identifyHit(删除命令) 非 null（L207-208 已断言其 action），g1=g2=null（advisory 放行）；断言式 L211 = (h1===null)===(g1===null&&g2===null) || (h1!==null)===true 代入 = (false)===(true) || (true)===(true) = **恒 true**。
- 交叉一处：code/dsh-plugin/riskGuard.ts:518-577 证实 identifyHit 命中返回动作、guardDecision 对非 blockable 规则一律 console.warn + return null。
- 结论：该断言意在校验「识别命中 ⇒ guardDecision 必然产出」，落空恒真；两实现未来分歧也不报警。属契约型断言掩盖（对该性质只跑不查）。

### D-3（observation）reason 枚举文档注释与实现漂移
- 源码一处：code/intent-router/layer2.ts:128-129 注释列 reason 含 low-share；同文件实际返回集为 no-candidates/no-overlap/accepted/low-cos/narrow-cos-margin/vector-uncorroborated/low-score/narrow-margin——**low-share 从未产出**，且漏 low-score、vector-uncorroborated。
- 交叉一处：code/intent-router/engine.ts:39 Decision.reason 注释列 no-decision/low-share 也未返回，真实含 unknown-intent（engine.ts:108）；而 self-test.ts:167/172/200/204/213 断言 reason 为 low-score/narrow-margin/low-cos/narrow-cos-margin/vector-uncorroborated（与实现一致）→ 测试契约为准、行内注释陈旧。属输出契约文档不一致（低影响）。

### D-4（observation）别名表双源手工同步、无防漂移闸门
- 源码一处：code/dsh-plugin/constants.ts:95-149（ERROR_ALIASES 20 / SYMPTOM_ALIASES 56）与 code/intent-router/aliases.ts:9-63（S1 内联副本，注释「源表变更时人工同步本副本」）无语义级共享。
- 交叉一处：本次程序化比对（正则提取两文件映射）——ERROR_ALIASES 20=20、SYMPTOM_ALIASES 56=56，键值完全一致（0 漂移）；intent-router 自测 [2][4] 只断言自身副本可建索引，无跨文件对账。
- 风险：源表未来增改别名漏同步时层1/层2 归一与 diagnose 导航会不一致且无测试暴露。当前 0 漂移。

### D-5（observation）intent-router 冒烟「结论合法」弱断言
- 源码一处：code/intent-router/self-test.ts:336 decision.accepted ? (intent!==undefined && tier!==undefined) : true —— 未采纳分支恒真。
- 交叉一处：非孤立掩盖——[8] L341 覆盖率≥4 + [9] 标定集（采纳率≥85%、放弃组零误采纳、命中意图零误判）构成强兜底。仅记 observation。

### D-6（observation）AGENTS.md 工具数口径过时
- 源码一处：code/dsh-plugin/tools.ts:188-966 实际注册 14 工具（12 + check_plan + diagnose_mechanism）。
- 交叉一处：plugin-registry/registry.yml:7-22 provides 列 14；intent-router/self-test.ts:54 断言「14 个工具意图齐全」。而 AGENTS.md §1 写「BKN 插件（TS，12 工具 + 护栏 + 检索栈）」——文档 12 与实现 14 不一致。

## 3 结论

1. **端口/端点输出契约与文档大体一致，未发现会引发生产错误的功能缺陷。**
   - 工具注册名 ↔ plugin-registry/registry.yml provides ↔ intent-router/taxonomy.generated.json target 三者逐条对齐（同一 14 工具 id + skill 指针全命中），无 cross-file 标识符漂移。
   - HTTP 端点错误路径完备：鉴权矩阵（/health 免鉴权；/v1/* 401/501；未知路由 404；turn 超时 504 timeout_error；abandoned→失败上报+500）；/admin 托管段 revision 冲突 409；诚实原则（无能力显式 405/404 提示、modelId 未设回退会话实际模型、无观测插件 /v1/metrics 404 提示）。
   - 回退单层（config→env→内置常量）：dsh-plugin/index.ts resolveExternalDeps 及端口默认（Qdrant 6333 / embed 8096 / MemoryCore 8420）与 AGENTS.md §9 一致。
   - 错误码基系 BUG-0009：constants.ts 将 DIAG_RETRIEVAL_GUIDE 与 DIAG_EVIDENCE_COLLECTION 解耦为独立常量（自测 [2] 断言两者不等且指引主库优先）；errorSemantics.ts 官方码义走 status 统一/单源闸门、未登记码静默 unknown；检索指引单源常量。该组断言需 /hdd BKN 数据才可跑，本站标「待 harness」，仅做静态核对一致。

2. **H-15 降级语义在可实跑自测中确认不抛错。** intent-router 自测 [5] 向量 sidecar 不可达→BM25-only 不抛（本次实测通过）；logfile 写失败静默+onError 一次性（实测通过）；ops-api memory recall 网络错→空串不抛、熔断/背压（其自测内建断言双证）；无 ALS key→空结果+提示语。未发现把 H-15 上抛到请求路径的违规。

3. **断言面：一处真实红（D-1）与一处恒真掩盖（D-2）需修，其余自测为真断言。** 自测均以 check()/ok() 记失败并 exit 非 0（非只打日志）。

## 4 受限声明

- 本审核站在 Windows 宿主 + node v24 + python 3.11 等素材约束下完成。
- 无法运行者一律标「待 harness 环境恢复」未造假跑：dsh-plugin/ops-api/dsh-observability/bkn-feedback 自测、dshctl 自测（缺 pnpm install 的 yaml 依赖）、全部 code/scripts（gen-intent-taxonomy 等需 /hdd 共享 BKN 与 DSH），以及依赖真实 Qdrant/embed/sessionController 的运行期行为（SSE 实发、超时 504 实发、鉴权矩阵真端口）——仅静态核对，结论强度为「静态一致」。
- 共享 BKN 数据（/hdd/demo/public/i2stream-bkn/bkn，.gitignore 排除）不在克隆内，凡 resolver/relations/错误码编码义断言均待其复现。
- D-1~D-6 均以 observation 标定；给不出运行/跨文件第二条证据的不升级为 confirmed 功能缺陷。本报告仅代表 functionality 视角，不覆盖安全/合规/性能。