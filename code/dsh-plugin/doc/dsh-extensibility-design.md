# DSH 插件扩展性设计：多产品适配 + Hermes 冻结后的跟进对齐

> 状态：待评审 | 日期：2026-09-11 | 范围：仅 `dsh-plugin/`（TS）
> 背景：**Hermes 侧因特殊原因冻结，不再做多产品化改造**（`/hdd/demo/public/i2stream-bkn/optimize/hermes-multi-product-refactor-plan.md` 搁置）；扩展性由 DSH 版承担。
> 输入：耦合点盘点沿用 Hermes plan §1（A/B/C 三类处置，盘点结论对 DSH 代码同样成立）；跟进对齐 `db-extensibility-design.md`（Hermes 已实施 Phase 1-5）与 `l2-integration-design.md`（已实施阶段 A-E）。
> 目标：**新产品接入 = 新建 bkn/ 目录 + 一份 `profile.yaml` +（可选）产品专属工具模块**，插件代码零改动。

---

## 0. 设计原则（沿用并加一条）

1. 约定优先于配置：BKN 命名约定（`cannot_<verb>_<STATE>`）与 schema 枚举（风险类型/12 关系类型/诊断四维）保持代码常量。
2. 能从 BKN 推导的不进配置：工具参数 enum 启动时从 BKN 推导，防双源漂移。
3. 零行为变化分步：每步 `self-test.ts` 回归 + i2Stream 行为 diff 为空。
4. 回退只有一层：profile 段缺失 → 内置常量（= i2Stream 当前行为），启动日志标注来源。
5. **【新增】与 Hermes 行为对齐可验证**：共用同一份 BKN 的前提下，凡 Hermes 已实施的行为（护栏分级、db 扩展性、导航层），DSH 跟进后应在关键路径上返回等价语义。

---

## 1. 目标架构

```
dsh-plugin/
├── index.ts               入口：Config 扩展 + profile 加载 + 工具注册（通用 + 产品）
├── profile.ts             【新】产品 profile 加载器（~120 行）
├── constants.ts           只留 B 类 schema 契约 + i2Stream 内置回退常量
├── resolver.ts / relations.ts / riskGuard.ts / contextLoader.ts
├── tools.ts               通用工具壳（BKN schema 驱动）
├── products/              【新】
│   └── i2stream/
│       ├── profile.yaml   产品适配数据（A 类 6 组 + DSH 特有段）
│       └── tools_ext.ts   产品专属工具（可选，如 diagnose_db_link 移植版）
├── doc/                   本文档目录（DSH 相关文档统一放这里）
└── self-test.ts
```

### 1.1 Config 扩展（index.ts，Schemastery schema 新增）

| 字段 | 默认 | 说明 |
|---|---|---|
| `product` | `'i2stream'` | 产品 profile id，映射 `products/<id>/profile.yaml` |
| `productsDir` | 插件同级 `products/` | 产品包根目录 |
| （既有）`bknRoot` | 共享 BKN `/hdd/demo/public/i2stream-bkn/bkn` | 不变；各产品的 bkn 目录由挂载配置指向 |
| （既有）`guardEnabled/guardBlock/mutatingTools` | 不变 | `mutatingTools` 仍可被 profile `risk_guard.command_patterns` 补充 |

### 1.2 profile.yaml 结构（复用 Hermes plan §2.1 的 6 组 A 类 + DSH 特有段）

```yaml
product: {id: i2stream, name: iStream 数据复制平台}

db:                         # A1: KNOWN_DBS/DB_ALIASES/DB_NOISE_VARIANTS/DB_ERROR_PREFIXES
  known: [...]
  aliases: {...}
  noise_variants: {...}
  error_prefixes: {ORA-: Oracle, YAS-: YashanDB, ...}   # 镜像 db-extensibility Phase 1

risk_guard:                 # A2: 护栏数据
  action_aliases: {...}
  command_patterns: [...]           # 命令指纹（产品命令动词）
  fallback_rules: {...}             # BKN 解析失败兜底
  fallback_object_states: {...}     # BKN objects/*.bkn 解析失败兜底
  fallback_state_family: {...}
  severity_gate:                    # 对齐 Hermes 阶段 B：仅拦 critical+error_code 非空
    blockable_when: {severity: critical, require_error_code: true}

dimensions:                 # A3: 症状→维度优先级（检索栈接入后使用）
  symptom_priority: {...}

prereq_map: {...}           # A4

tools_ext:                  # DSH 特有段：产品专属工具模块路径（相对 products/<id>/）
  - tools_ext.ts
```

### 1.3 加载与回退链

```
Config.product → productsDir/<id>/profile.yaml（yaml 解析）
  → 段缺失/解析失败 → 该组回退 constants.ts 内置常量（WARN 日志标注 profile|fallback）
  → index.ts 启动日志：产品 id + 各段来源汇总
```

### 1.4 工具 schema 动态推导（C 类，同 Hermes plan §2.3）

- 后续移植的 `list_scenarios`/`get_prerequisites`/`explain_architecture` 参数 enum 由 resolver 启动时从 BKN 推导（`scenarios/*.bkn`/`operations/actions/*.bkn`/`architecture.bkn`）；
- 已有 4 工具的 `aspect`/`relation_type` enum 保持静态（B 类契约）；
- 单测锁死：i2Stream 推导结果 == 现静态枚举。

### 1.5 产品专属工具注册点

`buildTools(ctx, {resolver, traverser, profile, extraTools})`：`extraTools` 来自 profile `tools_ext` 段动态 import（`products/<id>/tools_ext.ts` 导出 `defineTool[]`）。无该段时跳过——**通用工具永远可用，产品工具按 profile 注册**。

---

## 2. 与 Hermes 已实施项的跟进对齐（DSH backlog）

以下均为 DSH 侧待办，Hermes 已冻结不再动；实施时逐项对照 Hermes 行为验证等价语义：

| 项 | Hermes 现状 | DSH 跟进 | 优先级 |
|---|---|---|---|
| 护栏 severity 分级 | 阶段 B：仅拦 critical+error_code 非空（`blockable`）；阶段 D/E（会话时序/时间窗） | `riskGuard.ts` 增加 severity 规则 + `severity_gate`（profile 驱动）；会话动作日志 + 时间窗判定 | 高（护栏对齐） |
| 状态机解析 | `_parse_object_states`（objects/*.bkn + 运行族 kv，硬编码兜底） | 移植到 `riskGuard.ts`/新 `objectStates.ts`，兜底走 profile | 高 |
| 导航层 | `get_log_map` → `diagnose_db_link.log_navigation` | 移植 `getLogMap()` 到 resolver；并入 `resolve_operation` 或随 `diagnose_db_link` 移植版返回 | 中（随诊断工具移植） |
| db 扩展性 Phase 1-5 | 已实施（constants.py + BKN 数据单点） | 镜像：`constants.ts` 补 `DB_ERROR_PREFIXES`（先于 profile 化，与 Hermes 同构）；`db_type` unknown 化 + `db_type_source` additive 字段；`按库特殊约束` section 消费；lint db-coverage 对账项进 self-test | 中 |
| 检索栈 | qdrant+BM25 兜底 | 决策后接 profile `dimensions.symptom_priority` | 高（先于补 8 工具，见对比文档建议 6 下调说明） |

> 注意：**§2 与 profile 化是两条正交的线**——§2 是"能力对齐"（可以先做，数据仍走内置常量），profile 化是"数据源切换"（后做，把常量搬进 yaml）。建议先能力后搬家，避免同时动行为与数据源。

---

## 3. 实施步

| 步 | 改动 | 验证 |
|---|---|---|
| 0 | §2 第一行（护栏 severity 分级 + 状态机解析），数据仍内置 | self-test 扩展：critical+error_code 拦 / 非 critical 不拦；状态机解析 == 兜底值 |
| 1 | `profile.ts` + `products/i2stream/profile.yaml`（脚本从现有常量导出，不手抄） | 单测：profile 解析 == 现常量值（零行为变化） |
| 2 | `constants.ts`/`riskGuard.ts` 数据源切 profile（一层回退） | self-test 全绿 + `guardDecision` 输出 diff 为空 |
| 3 | 动态 enum 推导（新工具移植时一并做） | 推导结果 == 旧静态枚举 |
| 4 | `tools_ext` 注册点 + `diagnose_db_link` 移植版进 `products/i2stream/tools_ext.ts` | 工具注册数与行为验证 |
| 5 | 验收演练：`products/demo/profile.yaml`（最小）+ 最小 bkn_demo/ | 通用工具可加载（空数据不报错）、产品工具不注册、护栏空转放行、无 i2Stream 符号泄漏 |

---

## 3.1 生成链路配套（承接 Hermes plan §3.1 评审补充 R1/R2）

> Hermes 侧原评审结论对 DSH 同样成立：新产品 BKN 由 `bkn-creator` Skill + lint 结构校验生成（格式契约已固化在 SCHEMA.md 与 templates/），**生成工具链两版共用**——`profile.yaml` 格式沿用 Hermes plan §2.1，导出一份两版通用。

| # | 缺口（Hermes 侧原表述） | DSH 侧处置 | 挂载步骤 |
|---|---|---|---|
| R1 | lint 从 constants 导入 A 类常量做校验，profile 化后 lint 拿 i2Stream 数据校新产品 BKN（误报/漏报），旧常量删除后 ImportError | DSH 侧对账在 `self-test.ts`：对账断言改走 `profile.ts` 加载器同一条加载/回退链（`product` id 参数化），不再 import 内置常量 | 步 2 |
| R2 | bkn-creator 只产出 BKN 不产出 profile.yaml——BKN 建好而 profile 缺配（护栏空转、DB 别名失配且无告警） | 沿用已同步的 bkn-creator「profile 配套导出」指引（两版通用格式）；步 5 验收标准补一条：**profile 各段加载日志来源为 profile，无大面积 fallback** | 步 5 演练前置 |

---

## 4. 非目标

- 不改 Hermes `plugin/` 任何代码（冻结）；
- 不改 BKN schema / 命名约定；
- 不做一实例多产品、不做 profile 热更新（与 Config 同节奏，patchReload 即可覆盖）；
- 不发明通用 DSL：profile.yaml 只承载盘点出的 A 类数据 + `tools_ext` 列表。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 与 Hermes 双实现漂移（同一 BKN 两版行为不一致） | 共用 profile.yaml 格式（Hermes 若未来解冻可直接消费）；§2 每项跟进都以 Hermes 行为为验收基准 |
| profile 与内置常量双源 | 步 1 脚本一次性生成 + 单测断言；切换后内置常量仅作回退保留 |
| 动态 import（tools_ext.ts）在 Cordis 加载链路的兼容性 | 步 4 先验证 `import()` 动态路径在 tsx/打包两种模式的行为；不行则退化为"产品工具写死在包内、按 profile 开关注册" |
| 同时动行为与数据源导致回归困难 | §2 与 profile 化分线实施（先能力后搬家） |

---

*配套：`../README.md`（插件说明）、`/hdd/demo/public/i2stream-bkn/optimize/hermes-multi-product-refactor-plan.md`（耦合点盘点，Hermes 冻结故搁置）、`/hdd/demo/public/bkn/db-extensibility-design.md`、`/hdd/demo/public/bkn/l2-integration-design.md`、`/hdd/demo/public/i2stream-bkn/optimize/bkn-utilization-comparison.md`*
> 文档位置说明：随插件从 `i2stream-bkn/dsh-plugin/doc/` 迁至 `/hdd/demo/public/dsh-info/code/dsh-plugin/doc/`（2026-09-14）；方案类文档统一在 `/hdd/demo/public/dsh-info/doc/`。
