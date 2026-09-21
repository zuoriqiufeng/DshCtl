# Ops Agent 补全计划：三缺口修复（edges 图边 / operation_knowledge / skill 挂载）

> 状态：已评审，开始实施 | 日期：2026-09-14
> 上游：`ops-agent-phase3-plan.md` 补记后的三项遗留（用户质询「还有什么没补全」定位）
> 验收：self-test 新增 [8] 段全绿 + 既有回归不破 + dump-config 合成正确 + 27 个 SKILL.md 前置校验通过

---

## 一、缺口与事实（调研结论）

### 缺口 ①：action_routing.bkn 图边规则未接线（真行为差异）

Hermes `risk_guard._assemble_rules` 是**三源 join**：

| 源 | 内容 | DSH 现状 |
|---|---|---|
| 图边 `relations/action_routing.bkn` constrained_by 段 | 24 条 `` `动作` → `约束ID` `` 映射（start→rule_must_be_STOPPED、stop→must_use_stop_parse_yes、register_db→worknode_must_be_ONLINE 等） | ❌ 未解析 |
| 详情表 `risks/constraints.bkn` 全部行 | {约束ID: risk_name/类型/关联/约束文本}，不限 state_prerequisite | ⚠️ 只解析 state_prerequisite 行 |
| 状态机推导 `objects/*.bkn` | 按命名约定推导 forbidden_states（cannot_X_FAMILY → 族合并） | ✅ 已有 |

装配规则（1:1）：图边优先（空则回退硬编码 assoc 映射，assoc_source='graph_edges'/'fallback_assoc'）；
仅 `state_prerequisite/forbidden_sequence/threshold` 三类可进规则集（data_loss/param_constraint 不进）；
state_prerequisite 推导禁止态，推不出（无 _STATE 后缀）→ **保留为 sequence_semantic 规则**（DSH 现状是直接丢弃——
这就是 DSH 只有 3 条规则、点名规则全缺的原因）；错误码取文本 `(-XXXX)`。

**影响实测**：DSH 规则集 3 条 vs Hermes 约 12 条；`start_sync_rule`（-4071/-4031 点名）、
`stop_sync_rule`（parse=yes 参数约束）、`register_db`（-4016 点名）等在 DSH 侧无对应规则。

### 缺口 ②：resolve_operation 缺 prerequisite_knowledge / 图边单源 join

Hermes resolve_operation（tools.py:317-330）：`synthesize_operation_knowledge(capability, operation, bkn_caps, top_k=3)`
→ BKN 前置/约束/风险拆条 + 风险文本错误码提取 + 3 维 Qdrant 检索（前置条件/约束与注意事项/常见错误）；
另 join 规则集返回 `_op_constraints`（action==capability 的约束ID列表）+ `_constraints_source`。DSH 均缺。

### 缺口 ③：27 个 i2stream SKILL.md 未挂进 DSH 会话

`/hdd/demo/public/i2stream-bkn/skill/` 27 项（i2stream-db-diagnostics 等），SKILL.md 带 YAML frontmatter
（name/description 必备 ✓，额外 triggers/tools_used 应被容忍）。
工具输出的 `_skill_recommendation`/`skill_context` 与 persona 的「先加载 required skill」指令目前指向空 catalog。
web profile 已挂 skill/skill-filesystem——只差 `customSkillDirs` 一行配置（config-only HMR 热生效，无需重启）。

## 二、工作项

### W1 riskGuard.ts 三源 join 重构
- 新增 `parseActionEdges(bknRoot)`：`` `A` → `B` `` 边解析（constrained_by/risks_of 两段，`action:` 前缀剥离，# 注释剥离）
- 新增 `parseConstraintsDetail(bknRoot)`：constraints.bkn **全部行** → {ruleId: {riskName,riskType,assoc,text}}
- `parseConstraintsBkn` 重写为 `assembleRules(bknRoot, states)`：
  actionToRules←图边（空回退 assoc 映射）→ 逐 action/ruleId join 详情表 → 白名单类型过滤 →
  state_prerequisite 推导禁止态（推不出→sequenceSemantic=true 保留）→ 错误码/message/blockable 口径不变
- RiskRule 增 `riskType?/sequenceSemantic?/source?`；checkActionRisk 输出增 `source`（对齐 Hermes）
- FALLBACK_RULES 合并语义不变（BKN 装配优先，空则兜底）

### W2 resolve_operation 增强（tools.ts）
- `splitBknText`/`extractErrorCodes` 移植（resolver.py 1:1）
- `synthesizeOperationKnowledge({capability, operationName, prerequisites, constraints, risks}, topK=3)`：
  拆条 + common_errors + 3 维 searchFull（每维 try/catch 优雅降级为空 snippets）→ {summary, what_you_need, constraints, common_errors, dimensions, top_references}
- resolve_operation 返回增 `prerequisite_knowledge` + `_op_constraints` + `_constraints_source`
- get_prerequisites 不动（Hermes 该 handler 亦无此字段）

### W3 skill 挂载（cordis.patch.yml config-only）
- skill-filesystem override：`customSkillDirs: [/hdd/demo/public/i2stream-bkn/skill]`
- 前置校验脚本：27 个 SKILL.md frontmatter 均含 name+description

### W4 验证
1. self-test [8]：edges 解析（点名规则存在/sequenceSemantic/动作映射）、assembleRules 规则数>10、
   restart_sync_rule@FULLSYNC 命中 cannot_restart_RUNNING（新拦截面）、stop@FULLSYNC → cannot_stop_FULLSYNC
   （无 -XXXX → blockable=false 告警口径）、resolve_operation 输出新字段（Qdrant 不可达时优雅降级）、
   splitBknText/extractErrorCodes 纯函数
2. 既有 [1]-[7] 回归全绿；dump-config 含 skill-filesystem customSkillDirs；README/本文档回填

## 三、风险

| 风险 | 缓解 |
|---|---|
| 规则数 3→12 后拦截面变宽，可能误拦既有流程 | 与 Hermes 完全同源同逻辑（三源 join 1:1），blockable 口径不变（critical+错误码非空）；gray 模式可先行观察 |
| sequence_semantic 规则（无禁止态）进规则集但不触发状态拦截 | 对齐 Hermes：仅登记供阶段 D/E（数据不存在，休眠）；状态检查 `state in forbiddenStates` 天然空集不触发 |
| skill 目录多挂 i2agent-* 系列 | 属同一生态资产，一并暴露无害；不在目录内的不挂 |
| searchFull 在 resolve_operation 内联网失败 | 每维 try/catch → 空 snippets + summary 仍合成；工具不因检索挂而失败 |

## 四、交付物

- `riskGuard.ts`（三源 join）、`tools.ts`（operation knowledge）、`cordis.patch.yml`（skill 目录）、`self-test.ts` [8]
- README 迁移表更新；本文档验收回填

---

## 五、验收回填（2026-09-14 执行完毕）

### W1 图边三源 join ✅
- `parseActionEdges`（constrained_by 24 条 + risks_of 边）+ `parseConstraintsDetail`（constraints.bkn 全行）+ `assembleRules`（1:1 Hermes `_assemble_rules`：图边优先/fallback_assoc 回退、白名单类型过滤、state_prerequisite 推导、无 _STATE 后缀降级 sequenceSemantic）
- **规则集 3 条 → 14 条**，全部 `source=graph_edges`；点名规则（rule_must_be_STOPPED / must_use_stop_parse_yes / worknode_must_be_ONLINE / cannot_stop_FULLSYNC / must_dry_run_*）全部就位
- `checkActionRisk` 输出增 `source`；start@RUNNING / delete@RUNNING 拦截验证通过

### W2 resolve_operation 增强 ✅
- 端到端（4 操作）：创建同步规则 → 2 约束/724字 prereq/9片段/3维全中；启动同步规则 → 3 约束（含点名规则）；注册数据库节点 → 2 约束；激活工作节点 → 1 约束（fallback_assoc，edges 指向的约束不在详情表→正确回退）
- 途中修复 2 个真 bug：`searchFull` 对象传参（应为位置参数 `topK`）、`PREREQ_OP_MAP` 缺 `*_sync_rule` 别名 + `getPrerequisites` 增词干回退（"创建同步规则"章节吸收 create_sync_rule 族）
- `prerequisite_knowledge` 字段：{summary, what_you_need, constraints, common_errors, dimensions[3], top_references}，每维独立降级

### W3 skill 挂载 ✅（附带修复 phase-1 遗留崩溃）
- 26 个 SKILL.md frontmatter 校验：24 合规 + 2 个补写（i2stream-env-validator / i2stream-topology-visualizer，最小改写仅加 frontmatter）
- i2stream-ops 组合追加 skills 段（skill-filesystem + customSkillDirs + tool-skill）
- **修复 pre-existing `duplicate loader entry id: agent-presets` 启动崩溃**：web-app bundle 已 insert agent-presets，profile patch 再 insert 同 id 必崩；改为顶层同 id 覆写（config 整体替换语义，保留 default=standard + roots 追加 trust:user）
- dump-config exit 0；agent-presets 最终形态含自定义 roots

### V 系列验证 ✅
1. self-test 新增 **[8] 段 24 项断言全绿**（edges 解析 5 + 详情表 3 + join 结果 7 + 纯函数 4 + operation knowledge 5）；全量 [1]-[8] ALL PASSED
2. HTTP 五连测（live 3080）：/health ✓、/v1/models ✓、非流式 http=200 content 完整 finish=stop ✓、SSE 流式逐 chunk ✓、错误 key（apiKey 空=不鉴权，200 为正确行为）
3. **会话内 skill 目录生效**：模型列出 i2stream-node-manager / db-manager / rule-manager / diff-op / failover / db-diagnostics / log-analyzer——正是 BKN 工具推荐链上的关键 skill
4. 热路径计时：短问题 0.8s（含 session 创建 + persona 注入）；4 题基准对照 Hermes 基线见下表

### 最终基准（2026-09-15 11:12，bench-4q vs Hermes 基线）
| 问题 | DSH | Hermes | 加速 | 内容长度 |
|------|-----|--------|------|---------|
| Q1 创建 Oracle→MySQL 增量规则 | **39.2s** | 182.5s | 4.7x | 1634 字 |
| Q2 增量同步卡住排查 | **35.5s** | 129.2s | 3.6x | 1840 字 |
| Q3 什么情况禁止删除同步规则 | **15.6s** | 99.1s | 6.4x | 1074 字 |
| Q4 YAS-0101 错误原因 | **44.7s** | ≥300s（超时） | 6.7x+ | 947 字 |

全部 <60s 诊断目标；真实耗时（无超时兜底）、内容完整、finish=stop。

---

## 六、附带修复：ops-api bridge.ts 三层递进 bug（测试期发现）

测试中发现工具轮次 committed message 持续为 `len=0`（bench 3/4 多数），经三层排查最终定位为 bridge.ts 与 DSH sessionController follow 协议的三处失配，逐层修复：

### Bug 1: extractMessageText 不识别嵌套形状
- **症状**：durable 兜底路径返回空
- **根因**：真实 durable assistant/message 事件 data 为 `{turn, step, message:{role, content:[{type:'text',text}]}, usage, stream}`，函数只查 `d.text`/`d.content`，content 嵌套在 `message` 下
- **修复**：递归检查 `d.message.content`（仅取 `type==='text'` part）；self-test [2] 加 3 项嵌套断言

### Bug 2: follow 打开时序错误 + snapshot 帧被跳过
- **症状**：bench 快速返回（0.9-2.9s）finish=abandoned、内容空；session 文件却有完整文本
- **根因**：bridge 在 `await driver.prompt()` 之后才开 `consume()`（follow）——工具轮次长，晚开错过 attempt start → revision 校验抛错 → consume 异常退出 → abandoned；且 follow 的 snapshot 帧（含全部历史 durable 事件）被 bridge 跳过（只处理 `event`/`assistant-stream`）
- **修复**：`const consuming = consume()` 先启动再 `await prompt`；snapshot 帧遍历 `records` 提取 durable assistant/message 兜底；`turn/end` 事件作终止信号

### Bug 3: committed assistant/message ≠ turn 终局
- **症状**：修复后内容恢复但 Q1 只返回 46 字（"我来查询前置条件..."——中间步文本）
- **根因**：假设"中间步结算为 assistant/attempt、终局为 assistant/message"不成立——**带文本+工具调用的中间步也结算为 assistant/message**（eventType 只是 durable 事件类型）；bridge 第一次遇到 committed+assistant/message 就 return
- **修复**：committed end 帧（任意 eventType）只**保留最近非空文本不返回**；`turn/end` durable 事件才是终局信号，命中时立即 return；abandoned 帧有可用文本则继续等终局

### Bug 4（附带）: turnEnded 检查位置错误导致 120s 延迟
- **症状**：内容全部正确但每题耗时精确 120.0s（timeoutSec 兜底）
- **根因**：event 分支设 `turnEnded=true` 后 `continue`，检查语句在 assistant-stream 分支后——follow 生成器不结束，永远等不到下一帧
- **修复**：event 分支命中 `turn/end` 时**立即 return**

### 验证收敛
- self-test：mock 时序全部对齐新协议（snapshot 帧、turn/end 终局、mixed 中间步覆盖、durable 兜底、abandoned 全空抛错），ALL PASSED
- 最终 bench：4 题内容完整（947-1840 字）、真实耗时（15.6-44.7s）、全部达标

### 协议要点（沉淀给后续 ops-api 维护）
- `ctx.sessionController.follow()` 帧序：`snapshot{records}` → 交错的 `event{event}` 与 `assistant-stream{frame}`
- durable 事件（含 assistant/message、turn/end）经 `session/event` 监听以 `{type:'event', event:{type,data}}` 到达；data 为完整 `{turn, step, message, ...}`
- assistant-stream end 帧 `outcome.eventType` ∈ {assistant/message, assistant/attempt}，**与是否 turn 终局无关**
- turn 终局唯一定位：`turn/end` durable 事件（`data.reason.kind: completed|abandoned|...`）
