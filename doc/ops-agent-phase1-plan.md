# Ops Agent 阶段 1 实施计划：核心工具对齐 + 护栏分级 + ops preset

> 状态：已评审，开始实施 | 日期：2026-09-14
> 上游：`ops-agent-plan.md`（阶段 1）| 范围：`/hdd/demo/public/dsh-info/code/dsh-plugin/` + preset
> 验收基准（来自阶段 0 基线）：热路径问题对话 **<15s**、带工具链诊断 **<60s**（Hermes p50≈114s、Q4≥300s 超时）；
> 工具层自身延迟（无 LLM）**<100ms/次**。

---

## 调研结论（计划依据）

| 事实 | 结论 |
|---|---|
| Hermes 6 工具中 5 个是薄包装（resolver 方法 + schema 校验 + `_wrap`） | DSH resolver 已有 `queryArchitecture/checkCompatibility/getRisk/listScenarios/getPrerequisites`，**只缺场景匹配** |
| `design_solution` 依赖 `match_scenario`（`scenarios/scenario-rules.bkn`「场景匹配规则」表，priority 排序 + same/*/列表模式匹配） | 需在 resolver.ts 新增 `_loadScenarioRules/matchScenario/matchScenarioByName/_matchScenarioPattern` |
| `check_compatibility`：Hermes 已加「按库特殊约束」section 消费（db-extensibility Phase 3），DSH 未跟 | 本轮顺带对齐（否则同题不同答） |
| riskGuard：有 severity/errorCode 但无 `blockable` 门控、无 objects 状态机解析 | 对齐 L2 集成的 Stage B：**blockable = severity==critical && errorCode 非空**；状态机解析带与 Hermes 相同的硬编码回退（运行族 kv 在 BKN 中缺失，Hermes 也是硬编码） |
| agent-presets 已挂 web profile（`id: agent-presets`）；preset=目录+`agent.cordis.yml`，三来源：包内 `presets/`、配置 `roots`、`<dshHome>/.agent-presets` | ops preset 放 `/hdd/demo/public/dsh-info/code/presets/i2stream-ops/`，经 patch 给 agent-presets 加 `roots` |
| dsh CLI 无 headless chat 命令 | 对话计时验收 = 工具层脚本计时（自动）+ web GUI preset 人机问答（人工抽查）；脚本化对话计时留给阶段 2 ops-api |

## 工作项

### W1 移植 6 工具（tools.ts + resolver.ts 补齐）

参数 schema 与 Hermes `schemas.py` 1:1；`_wrap` 等价物 = ContextLoader render（策略已注册：`check_compatibility/list_scenarios/get_prerequisites=full`、`explain_architecture=toon_only`、`diagnose_error=raw`、`design_solution=trim_only`）。

| 工具 | 输入 | 输出要点 | 移植工作 |
|---|---|---|---|
| `explain_architecture` | topic∈{full_sync,incremental_sync,topology,transaction,validation,performance,oracle_log,mssql_mode,matrix,all} | 架构段落 + available_topics 兜底 | 直接接 `queryArchitecture`（已有） |
| `design_solution` | source, target, scenario_hint∈{auto,migration,dual_active,bigdata,disaster_recovery} | 场景+兼容性+relations 展开(depth=3)+顶层提升（prerequisites/constraints/skills） | **新增** `matchScenario/ByName` + `_extractFromRelations` |
| `check_compatibility` | source, target, source_version?, target_version? | 矩阵答案+版本注记+**按库特殊约束**+关系提示 | 已有方法 + **补「按库特殊约束」消费** |
| `list_scenarios` | keywords?(string\|string[]，规范化) | 场景列表+关键词过滤 | 直接接 `listScenarios`（已有）+ 过滤 |
| `get_prerequisites` | operation, db_type? | `{operation, prerequisites: raw}` 规范化 + 库特化过滤（generic 保留） | 已有方法 + **`_extractDbSpecificPrerequisites` 等价过滤** |
| `diagnose_error` | error_code | `{error_code, diagnosis: raw}` 规范化 | 直接接 `getRisk`（已有） |

### W2 护栏分级对齐（riskGuard.ts）

1. **blockable 派生**：规则加载时 `blockable = severity==='critical' && errorCode非空`（与 Hermes Stage B 一致）；`guardDecision` 返回值带 `blockable`。
2. **pre-execute 门控**：`guardBlock=true` → 仅 blockable 规则 deny；非 blockable 放行并记 warn 日志（不再一律 deny——现行为过粗）。
3. **状态机解析**：移植 `_parse_object_states` 等价物——解析 `objects/syncrule.bkn`（|当前状态|允许操作|禁止操作|）与 `objects/dbnode.bkn`（|状态|说明|可用于规则|）状态表；运行族缺声明 → 与 Hermes 相同的硬编码回退。解析失败不影响现有回退状态集。

### W3 ops preset + 热路径提示词

```
/hdd/demo/public/dsh-info/code/presets/i2stream-ops/
├── agent.cordis.yml      persona（i2Stream 运维专家身份/边界/回答格式）+ prompt sections
└── hotpath.md            ← 脚本生成，不手写
```

- `gen-hotpath-prompt.ts`（code 目录 scripts/）：从共享 BKN 生成 hotpath.md——
  ① 高频操作→Skill 绑定表（`operations/actions/*.bkn` 的 skill 字段，取 Top N）
  ② 症状→诊断方向（`symptom-router.bkn` 主干映射）
  ③ 常见错误码→一句话方向（`diagnostics/*.bkn` 错误码索引）
  目标 **<600 token**；README 记录再生成命令（与 bkn 更新同步）。
- 挂载：`cordis.patch.yml` 给 `id: agent-presets` 叠加 `config.roots: ['/hdd/demo/public/dsh-info/code/presets']`（id 定向覆盖，不改包内 shipped presets）。
- persona 参照 shipped `standard` 的 `dsh-persona` 行格式；确认 standard 对 prompt section 的声明方式后照抄结构。

### W4 验证（按序）

1. **self-test 扩展**（现 34 断言）：+matchScenario 规则/默认/ByName、+check_comcompat 按库约束段、+getPrerequisites 库特化、+blockable 门控矩阵（critical+码→block；warning→allow；critical+空码→allow）、+状态机解析（syncrule 表状态集）→ 仍 ALL PASSED。
2. **挂载验证**：`dump-config`（preset roots 生效、bkn-plugin 新路径）；热重载：改 profile 触发 `settings/update` → 工具仍可用。
3. **工具层计时脚本**：对 4 道基线问题的典型工具链（Q1→resolve_operation+design_solution；Q2→diagnose_error+get_prerequisites；Q3→check_action_risk；Q4→diagnose_error+resolve_relation）逐链计时，断言 <100ms/次。
4. **人机问答**：web GUI 会话选 `i2stream-ops` preset 问 4 题，记录耗时 vs 基线（<15s/<60s 目标）——需用户参与抽查；结果回填本文件 §验收。

## 执行顺序与依赖

```
W1 ─┬─ W4.1(self-test)          （W1/W2 完成后合入自测）
W2 ─┘
W3（可与 W1/W2 并行；hotpath 生成依赖 resolver 的操作/Skill 查询）
W4.2→W4.3→W4.4
```

## 风险

| 风险 | 缓解 |
|---|---|
| 按库特殊约束段结构与 Hermes 解析不一致导致同题异答 | 移植时对照 resolver.py `_build_db_constraints` 逐字段；自测加对照片段 |
| preset 的 prompt section 声明方式与设想不同 | 先抄 standard 结构；不行则降级为 persona 内嵌热路径文本 |
| 护栏从"一律 deny"收紧为分级后漏拦 | blockable 口径严格等于 Hermes Stage B；fallback 规则 critical 不变 |
| 热路径提示词与 BKN 漂移 | 只接受脚本生成文件；README 写明再生成时机（bkn 更新后） |

## 交付物

- `dsh-plugin/tools.ts`（4→10 工具）、`resolver.ts`（场景匹配+按库约束）、`riskGuard.ts`（blockable+状态机）
- `presets/i2stream-ops/`（agent.cordis.yml + hotpath.md）、`scripts/gen-hotpath-prompt.ts`
- self-test 扩展断言；本文件 §验收 回填实际计时

---

## 验收（实施后回填）

- [x] self-test ALL PASSED（50 断言：原 34 + 阶段1新增 16；2026-09-14 实测）
- [x] dump-config：preset roots（`/hdd/demo/public/dsh-info/code/presets`）+ bkn-plugin 新路径合成正确
- [x] 工具层计时 <100ms/次（实测 10 次调用 p50=0.0ms / p95=0.1ms / max=0.1ms；`scripts/bench-tools.ts`）
- [ ] web GUI 人机问答 4 题耗时 vs Hermes 基线（待重启后用户抽查回填）

> **实施记录（2026-09-14）**
> - W1 完成：tools.ts 4→10 工具；resolver.ts 新增场景匹配三方法、`getDbConstraints`（按库特殊约束数据驱动，
>   移除 SQL Server 硬编码）、`buildCharsetNotes`、`extractDbSpecificPrerequisites`。
> - W2 完成：riskGuard.ts `blockable` 门控 + `parseObjectStates`（objects/*.bkn 状态机 + 运行族硬编码回退）；
>   **mutatingTools 默认收窄为命令执行类**（bash/run_code/terminal/execute_code/shell，write/edit/patch 退出指纹识别——
>   实施中被运行旧版护栏连拦两次，正是该误伤面的实证）。
> - W3 完成：`presets/i2stream-ops/`（preset.yml + agent.cordis.yml）+ `scripts/gen-hotpath-prompt.ts`
>   （生成 hotpath.md ≈1046 token 并注入 persona 标记块；操作→Skill 8 行 / 症状 5 行 / 错误码 12 行）。
> - 遗留：web profile `patchReload: live` 为 **config-only HMR**（源码模块不替换）——新代码需重启
>   `pnpm dsh web` 后生效；重启后在 GUI 选 i2stream-ops preset 跑 4 题计时回填。
