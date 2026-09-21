# dsh-plugin-i2stream-bkn

i2Stream BKN（业务知识网络）的 **DSH (Cordis) 原生插件**（TS 版）。

从 Hermes 插件 `plugin/`（Python）移植，把 BKN 的"本体 + 语义图 + 风险护栏"映射到 DSH 的原生缝隙：

> **位置**：`/hdd/demo/public/dsh-info/code/dsh-plugin/`（2026-09-14 自 `i2stream-bkn/dsh-plugin` 迁入；
> 与 Hermes 工作区共用同一份 BKN：`/hdd/demo/public/i2stream-bkn/bkn`）。
> **文档目录**：`doc/`（实现设计）+ DSH 方案类文档统一在 `/hdd/demo/public/dsh-info/doc/`（如 `ops-agent-plan.md`）。
> - `doc/dsh-extensibility-design.md` — 扩展性设计（多产品 profile + Hermes 冻结后的跟进对齐）
> - 工作区级分析（Hermes+DSH 对比等）在 `/hdd/demo/public/i2stream-bkn/optimize/`。

| Hermes 概念 | DSH 对应物 | 状态 |
|---|---|---|
| `ctx.register_tool` ×12 | `ctx.tools.register(defineTool(...))` | ✅ 12/12 已移植（阶段 3 补齐 search_qdrant/diagnose_db_link） |
| `risk_guard.py` 的 `pre_tool_call` 拦截 | `tools/pre-execute` waterfall 策略 | ✅ 已接入（Stage B 分级：blockable=critical+错误码 非空才阻断） |
| `risk_guard.py` 状态机解析 | `parseObjectStates`（objects/*.bkn + 运行族回退） | ✅ 已对齐 |
| `relations.py` 图遍历 | `relations.ts` RelationTraverser | ✅ 完整移植 |
| `resolver.py` BKN 加载/查询 | `resolver.ts` BKNResolver（含场景匹配/按库约束/字符集） | ✅ 已移植 |
| `context_loader.py` Trim + Toon 管道 | `contextLoader.ts` + `output.render()` | ✅ 已接入（模型可见优化文本） |
| 检索栈（qdrant + sbert + bm25） | `retrieval.ts` + `bm25.ts` + Python embedding sidecar | ✅ 阶段 3 已移植（同模型同向量） |
| `supplement.py` 质量闭环（_wrap：置信度/gap 日志/defer 补查指令） | `supplement.ts` wrapToolResult（前 10 工具统一包装） | ✅ 已移植（defer 模式=生产同款；内部 decompose 兜底分支未启用） |

## 文件

```
dsh-plugin/
├── index.ts          插件入口：注册工具 + pre-execute 护栏 + Config
├── tools.ts          4 个 defineTool 定义（render 走 ContextLoader，含命令字段清洗）
├── contextLoader.ts  Trim + Toon 上下文优化管道（Token -30~60%）
├── relations.ts      bkn/relations/*.bkn KWeaver 段落 → 有向图（12 种关系）
├── riskGuard.ts      constraints.bkn → 代码级风险护栏（state_prerequisite 自动翻译）
├── resolver.ts       BKN 加载引擎（Section/tables/kv/同义词/操作注册/兼容性）
├── constants.ts      已知数据库与别名归一化
├── self-test.ts      独立自测（node --import tsx/esm self-test.ts）
└── package.json
```

## 挂载（源码模式 web profile）

`/root/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: bkn-plugin
      name: '/hdd/demo/public/dsh-info/code/dsh-plugin/index.ts'
      config:
        bknRoot: /hdd/demo/public/i2stream-bkn/bkn
        guardEnabled: true
        guardBlock: true
```

`patchReload: live`，保存即热重载。

## Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `bknRoot` | 共享 BKN `/hdd/demo/public/i2stream-bkn/bkn`（env `I2STREAM_BKN_ROOT` 可覆盖） | BKN 根目录 |
| `guardEnabled` | `true` | 是否启用风险护栏 |
| `guardBlock` | `true` | 命中时 deny（`false` = 灰度仅告警） |
| `mutatingTools` | `['bash','write','edit','patch','run_code']` | 参与命令指纹识别的写类工具 |

## 已移植工具（12/12）

前 4 个（首批）：
- `query_product` — 产品定位/核心能力/竞品/行业/信创
- `resolve_relation` — 关系图查询（约束/风险/Skill 路由/展开）
- `check_action_risk` — 动作+状态 → 是否违反 L0 状态前置约束（含 blockable）
- `resolve_operation` — 操作 → capability + Skill 绑定 + 约束/风险/前置

阶段 1 新增（6 个，与 Hermes schemas 1:1）：
- `explain_architecture` — 架构原理解答（9 主题）
- `design_solution` — 方案设计（场景匹配 scenarios/scenario-rules.bkn + 兼容性 + relations 展开）
- `check_compatibility` — 兼容矩阵（版本注记 + 字符集速查 + 按库特殊约束数据驱动）
- `list_scenarios` — 场景列表 + 关键词过滤
- `diagnose_error` — 错误码诊断（diagnostics.bkn）
- `get_prerequisites` — 操作前置清单（含 db_type 库特化提取）

阶段 3 新增（2 个，检索栈）：
- `search_qdrant` — Qdrant 混合检索（BGE dense + BM25 + RRF(k=60)，五 chunk_mode，批量/维度覆盖 __report__/__reset__）
- `diagnose_db_link` — 症状诊断（db_type 前缀识别 + symptom-router Skill 路由 + 5 维知识合成 + log-map 日志导航）

## 检索栈（阶段 3）

```
search_qdrant / diagnose_db_link
  ├─ retrieval.ts — Qdrant HTTP（points/query 用 query 字段 + score_threshold；scroll 建 BM25 索引）
  │                 精度保护（错误码精确项 BM25/content_exact 兜底）、维度校验、覆盖度追踪
  ├─ bm25.ts — BM25(k1=1.5,b=0.75) + 分词（中文 bigram+英文词，Hermes jieba 缺失回退同款）+ rrfFusion(k=60)
  └─ Python sidecar（与 Hermes 同模型 BAAI/bge-large-zh-v1.5 同向量）：
      HF_HOME=/hdd/demo/public/chunk/HuggingFace HF_HUB_OFFLINE=1 \
        /hdd/demo/public/venv/bin/python ../sidecars/embed-server.py --port 8096 &
      # health: curl http://127.0.0.1:8096/health
```

env 覆盖：`I2STREAM_QDRANT_URL`（默认 http://127.0.0.1:6333）、`I2STREAM_EMBED_URL`（默认 http://127.0.0.1:8096/embed）、
`I2STREAM_QDRANT_COLLECTION`（默认 i2stream_collection）。
降级链：sidecar/Qdrant 不可用 → BM25-only → 空结果 `_warning`（对齐 Hermes client/model None 行为）。

## supplement 质量闭环（阶段 3 补齐）

`supplement.ts` 1:1 移植 Hermes `tools._wrap` 层：每个 BKN 工具返回统一注入
`confidence`（full/partial/none）+ `gaps`；partial/none 时 `log_gap`（JSONL，512KB 轮转 3 备份，
路径 `/hdd/demo/public/i2stream-bkn/logs/gap_log.jsonl`，env `I2STREAM_GAP_LOG` 覆盖）
+ defer 补查提示：`_instruction`（维度菜单 + hint，Agent 自选 3-5 维 `search_qdrant`）、
`_skill_recommendation`（BKN 标记的负责 Skill，与 Qdrant 同级并列）、`_search_deferred`/`_coverage_pending`。
`diagnose_db_link` 另带 `_available_dimensions`（按 symptom 优先级 critical/suggested/optional 排序）。
常量与 config.yaml 一致：min_content_length=50、min_risk_count=5、defer_to_hermes=true。
search_qdrant/diagnose_db_link 不包 wrap（自带完整质量字段，同 Hermes 行为）。

## 风险护栏（Stage B 对齐）

- 规则：constraints.bkn `state_prerequisite` 行 → 命名约定推导禁止状态；objects/*.bkn 状态机解析
  优先，硬编码回退（运行族 BKN 缺声明，与 Hermes 相同）。
- **blockable 门控**：仅 `severity=critical && errorCode 非空` 的规则在 `guardBlock=true` 时阻断；
  非 blockable 命中记 warn 放行（advisory）。
- `mutatingTools` 默认 = `['bash','run_code','terminal','execute_code','shell']`
  （对齐 Hermes 只拦命令执行类；**write/edit/patch 不参与指纹识别**——对源码/文档编辑必然误伤）。

## ops preset（阶段 1 配套）

`../presets/i2stream-ops/` —— 运维对话 Agent preset（persona + 热路径提示词）。
热路径内容由 `../scripts/gen-hotpath-prompt.ts` 从共享 BKN 生成（bkn 更新后重新运行）；
本插件的 10 个工具由 host 级挂载提供给所有会话，preset 负责身份与速查知识。

## ContextLoader 接入方式

每个工具 `execute` 返回**完整规范 JSON**（供结果记录），`output.render` 调用
`ContextLoader.process(value, toolName)` 产出**模型可见的优化文本**：

- `query_product` / `explain_architecture` → `toon_only`（仅 Toon 紧凑化）
- `resolve_relation` / `resolve_operation` / `check_compatibility` → `full`（Trim + Toon）
- `design_solution` → `trim_only`；`diagnose_error` → `raw`（原样 JSON）

Trim 剪掉评分/UUID/空值等低价值字段；Toon 把对象数组压成对齐行、布尔→✓/✗、
长串截断（白名单知识内容字段 `_FULL_CONTENT_KEYS` 完整保留）；可选输出预算截断。

## BKN 边界（移植自 plugin/CLAUDE.md）

BKN 只给语义、分析方向、风险上下文与 Skill 指针；**不返回可执行命令串**。
工具输出经 `_filterCommandFields` 清洗（键级黑名单 + 值级 SQL/路径/端口/`--force`/命令扫描）。

## 自测与计时

```sh
cd /hdd/agent/deepseek-harness
node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts        # 50 断言
node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/bench-tools.ts        # 工具层计时
```

## 下一步

- 可选：工具域按 preset 隔离；护栏 edges 段对齐（action_routing 图边单源）
- usage_log/assess_confidence（Hermes 质量观测，检索正确性无关，搁置）
