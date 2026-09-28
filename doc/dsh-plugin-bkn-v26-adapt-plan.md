# dsh-plugin × BKN v26 适配 + 契约校验 + pack 内嵌快照

> 2026-09-28 · 状态：✅ 已实施 + 验收结果已回填（A3 一项ⓘ见 §A3 明细；另发现阻断级回归 P1 未修）
> 触发：共享 BKN 于 2026-09-24 完成「本体分层重构 19→26 号 + 批 2 移除 uses_tool 边」，
> Hermes Python 侧同批 commit 已 1:1 适配，**TS 侧未跟进** → self-test 8 ✗ + 1 崩溃（中断后续约 60 条，其中另有 11 条会失败）。
> 用户拍板：契约校验默认 **strict**（工具宁可消失不可失真）；三项全做。

---

## 0. 现状与基准（实施依据）

- **真实待修 20 条**（非 9）：8 条可观测 ✗ + `self-test.ts:287` 崩溃中断 [7][8][9] 三段，探针实测被掩盖 11 条。
- **#20 是真实安全漏拦**：`checkActionRisk('start_sync_rule','RUNNING')` 应 deny 却放行（护栏走 `riskGuard.ts` FALLBACK_RULES，不含 start 族）——本次最高优先级。
- **Python 基准**：`/hdd/demo/public/i2stream-bkn/plugin/*.py`（resolver 1655 行 / risk_guard 688 / relations 245 / tools 1334 / constants 259）为 1:1 实现基准（AGENTS.md「与 Hermes 行为 1:1」）。
- **文件映射**（0832dde 起）：`product.bkn`→`objects/product.bkn`；`operations/actions/prerequisites.bkn`→`risks/prerequisites.bkn`；`scenarios/*.bkn`→`objects/scenario-*.bkn`；`risks/diagnostics.bkn`+`error-codes.bkn`→删（`suspected_in` 边 + `constants.ERROR_ALIASES`）；`diagnostics/{log-map,symptom-router,related-skills}.bkn`+`scenarios/scenario-rules.bkn`→删（派生/常量/manifest）；`compatibility.bkn`/`objects/env_matrix.bkn`/`network.bkn`/`architecture.bkn`→删（值委托到 Skill references）。
- **关键数据锚**：`error:-4002 → process:iatrack`（process_topology.bkn:84）；`ERROR_ALIASES["REDO位点异常"]='-4002'`（constants.py:97）。

## 阶段 A · BKN 适配（20 条转绿 + 修漏拦）

- **A1 路径映射**（resolver.ts 8 处）：见上映射表。
- **A2 函数级 1:1 移植**（13 点，基准行号见 Python）：
  1. 同义词索引同址化 `_build_synonym_index`（resolver.py:308）——objects frontmatter `aliases:` + actions 段内 aliases + constants 四类别名 + 场景「关键词」
  2. `query_product`（:484）新路径 + 下延 aspect 委托指针
  3. `_build_db_constraints`→委托指针（:753）；`_build_charset_notes`→委托指针（:766）
  4. `get_risk` 常量+边（:861）：`error_code/retrieval_guide/suspected_process/dimensions/aliases/unknown_rule`
  5. `get_log_map` 本体派生（:1059）：`suspected_in`→`feeds`→进程「关键属性」；`process_duties` 全进程派生；`derived_from`
  6. `get_symptom_skills` 派生（:920）+ `_analysis_framework_for`
  7. `related_skills`→manifest（tools.py:428）
  8. 场景路由常量 `_SCENARIO_ROUTING_RULES`（resolver.py:22）
  9. `get_prerequisites` 派生（:1442）：边 × constraints 4 列 × 维度段 + 「负责 Skill」行
  10. 状态机解析兼容 KV bullet（risk_guard.py:173）
  11. 约束详情 4 列（risk_guard.py:348）+ `_assemble_rules` 对象名由 action 派生（:398）
  12. 边命名空间 `risks_of: ["error:","risk:"]`（constants.py:194）
  13. 关系类型白名单 12→24（relations.ts:9 ← relations/RELATION_TYPES.md）
- **A3 测试期望修正**（4+1 处，已先行改好）：`:196` 改委托指针断言；`:287` 容错守卫；`:309` 新结构断言（含 suspected_process 含 iatrack）；`:398` 期望 `error:-4073`。
- **A4 漏拦断言**：`:416`（start@RUNNING 应 deny 且 source=graph_edges）保持并要求转绿。

## 阶段 B · 契约校验（strict）

`validateBknContract`：目录/SCHEMA+SKILL 存在/世代号≥26/四目录各≥1 .bkn/关键 6 文件/关键区块（syncrule `## 状态机`、constraints `约束ID`、action_routing 双关系类型、product `## 产品定位`）/构造后 `operations.size>0` 且 `graph.size>0`。
`Config.contractCheck: 'strict'|'warn'|'off'`（默认 strict）：strict → logger.error + throw（fiber FAILED，工具消失、实例照常）；warn → error 日志 + 预留；off → info。顺带 `resolver.load` miss 与 `walkBkn` readdir 异常不再全静默。

## 阶段 C · pack --with-bkn 内嵌快照

`dshctl plugin pack <id> --with-bkn [dir]`：staging 快照 `bkn/` + `files` 加 `bkn` + staged patch `config.bknRoot: bkn`（相对）+ staged manifest `bknSnapshot{dir,at,source,commit,generation,files,bytes,schemaSha}`（Manifest 接口/loader/saver 三处加字段）+ `!!js` 防护 + tgz 重命名附 `-bkn<generation>-<date>`。
插件侧：`index.ts:59` bknRoot 相对解析（相对插件目录）；`whitelistPath` 同。

## 验证

| 用例 | 标准 | 结果 |
|---|---|---|
| A1 self-test | 20 条全绿 + 存量不破 + 漏拦断言过 | ✅ `node --import tsx/esm code/dsh-plugin/self-test.ts` → `ALL PASSED ✅`（146 条断言，[1]~[10] 十段全绿；[10] 为本次新增契约校验段）。原 8 ✗ + 崩溃后掩盖 11 条共 20 条全部转绿 |
| A2 ci.sh | 五环节全绿（[2/5] 转绿为核心信号） | ✅ `bash code/dshctl/ci.sh` → `[1/5] ALL PASSED` / `[2/5] ALL PASSED` / `[3/5] ALL PASSED` / `[4/5] verdict: PASS ✓` / `[5/5] 0 error(s), 1 warn(s) → PASS` / `== ci: ALL GREEN ==`（连跑 3 次一致） |
| A3 live 8643 | 重启后 check 0 error；冒烟 diagnose -4002 新结构 + start@RUNNING deny | ⚠️ 部分完成，见下 |
| B1 契约 | 篡改副本 → strict FAILED 且日志点名；warn/off 行为符合 | ✅ `/tmp/verify-bkn.ts`（库级实测）：篡改副本判定 11 项 issue（世代 19<26、objects/ 缺 .bkn…）；strict → `fatal:true` + 日志含"世代"；warn → `fatal:false` 但 1 条 error；off → 0 条日志；共享根 → `generation=26` 通过 |
| C1 pack | tgz 含 bkn/ + 元数据；挪路径仍工作 | ✅ `plugin-registry/dist/dsh-plugin-i2stream-bkn-0.1.0-bkn26-20260928.tgz`：60 条目、其中 `bkn/` 下 45 个文件；manifest `bknSnapshot{dir:bkn,commit:7e8cda9,generation:26,files:45,bytes:150821,schemaSha:63c142e8b4d7}`；staged patch `config.bknRoot: bkn`（相对）。挪到 `/tmp/bkn-moved-*` 后契约通过（世代 26）+ 护栏仍拦（`rule_must_be_STOPPED`/`graph_edges`） |
| C2 幂等 | `apply ops --dry-run` 不变 | ✅ `dshctl apply ops --dry-run` → `生成物与现状一致（零写盘）`，退出码 0 |

### A3 明细（live 8643，2026-09-28 15:14 重启后）

- ✅ `/health` → `{"status":"ok","platform":"dsh-domain-agent","version":"0.3.0","preset":"ops"}`；`NRestarts=0`
- ✅ `dshctl check ops --ci` → `0 error(s), 1 warn(s) → PASS`（warn 为 R3 上游新增 22 行未覆盖，非本次改动）
- ✅ `/v1/capabilities` → `tools.count = 16`（12 个 BKN 工具 + skill-manage + 记忆扩展），证明 v26 适配后的插件在新实例上装配成功、契约校验通过
- ✅ 漏拦修复（A4）与契约校验（B1）以库级实测为准：`checkActionRisk('start_sync_rule','RUNNING')` → `passed:false, ruleId:'rule_must_be_STOPPED', source:'graph_edges'`（非 fallback）；`start@STOPPED` → 放行。**改前该判定经由 `FALLBACK_RULES` 兜底放行，是真实安全漏拦**
- ⚠️ **宿主 LLM 侧不可用**：`/v1/chat/completions` 返回 `RemoteError: Unknown agent preset: ops`（详见下方踩坑 §P1）——与本三项交付无关的上游升级连带回归，故本次未能以"真实对话"链路端到端冒烟 diagnose_error；工具装配面已由 `tools.count=16` 与库级断言覆盖
- ⚠️ 旧的 `状态机解析不完整` / `未装配出规则` 告警在重启后计数为 0（改前存在）

## 风险与边界

- 3080 现网引用同一份插件源码——本次修复后其下次重启切新行为（含 strict），本次不重启 3080。
- 关系类型扩到 24 会新增图边（行为变化），单列观测。
- Python 侧 `relations.py` 尚有未提交改动——若基准某处半成品，按 BKN 数据实际形态取「最小正确」并记录。

## 踩坑沉淀 / 回填记录

### P1（阻断级，未修 · 需你拍板）· 上游 v0.1.7 移除「目录式 agent preset」，本域实例的 preset 引用全断

**症状**：8643 实例 `/health` 正常（`preset: ops`），但任何一次对话请求立即 500：
`RemoteError: Unknown agent preset: ops`。启动日志另有 `patch: entry "agent-presets" not found`（warn）。

**根因**（两层叠加）：
1. **上游机制替换**：commit `d1e22a7e24`（"feat(preset): declare Agent compositions in profile YAML"，v0.1.7-alpha.2 内）把 preset 从「目录 + `preset.yml`/`agent.cordis.yml` 扫描」改为「普通 Cordis 声明行」。旧包 `@deepseek-ai/dsh-agent-presets`（含 `SHIPPED_PRESET_ROOT`/`USER_PRESET_DIR`/`discovery.ts`）已被整体删除（`git ls-files` 计数 0），代之以：
   - `@deepseek-ai/dsh-agent-preset-registry`（registry 服务行，`Config` 只剩 `default`/`selectedDefault`/`modeSelectionEnabled`——**`roots`/`trust`/`includeShippedRoot`/`includeUserRoot` 四个键全部消失**）
   - `@deepseek-ai/dsh-agent-preset`（每个 preset 一行声明，`config: { id, name, description, order, plugins }`）
   - 上游自带迁移指引：`packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md` §"Migrate a legacy preset"——"Nothing reads that directory any more"。
2. **本域清单残留旧形**：`domains/ops/domain.yml` 的 `preset.source` 指向 `.dsh-home/presets/i2stream-ops`（目录名 `i2stream-ops`），而 profile patch 由 `renderProfilePatch` 写成 `preset: ops` / `default: ops`（取 `spec.domain`）。即便目录式机制还在，**id 也对不上**（目录名 vs 域名）；改用声明式后 `preset-ops` 同样不存在 → `Unknown agent preset: ops`。
   - 旁证：`dshctl` 的 fixture、`adopt.ts`、`diff.ts`、`domain.ts` 骨架注释、GUI 表单提示都仍按目录式描述（`agent.cordis.yml` + `preset.yml`）。

**实测证据**：
- 合成面：`pnpm dsh --profile ops --dump-config` 中 preset 行只有内置四套 `preset-standard/ptc/minimal/cordis`，`agent-presets` 与 `preset-ops` 均不存在；`domains/.cache/dump-config-0.1.7-alpha.2.json` 同样为 `agent-presets: False`。
- 真启动面（隔离端口 8645，不改现网）：把 `ops-api.config.preset` 临时改成内置 `standard` → 请求不再报 "Unknown agent preset"，而是推进到下一层 `waiting for goals / web / subagent`（内置 standard 需要的 host 服务被 ops-app 能力包裁掉了）。
- 声明式改写面（隔离端口 8644）：注入一条 `- insert: [{id: preset-ops, name: '@deepseek-ai/dsh-agent-preset', config: {id: ops, …, plugins: <agent.cordis.yml 原文>}}]` + `- id: agent-preset-registry` 覆写 `default: ops`，启动正常、`/health` 的 `preset` 正确回报 `ops`；对话仍返回 `abandoned`，进一步定位为宿主 LLM 侧（`mimo-x-flash-preview` 渠道不可用：`No available channel for model mimo-x-flash-preview under group vip`）——即声明式改写后 preset 解析这一层是通的。

**影响面**：8643 试验实例的 **API 面功能整体不可用**（`/v1/chat/completions`、`/v1/responses`、`/api/sessions` 全部走 preset）；`/health`、`/admin`、`check`、工具装配面（`capabilities.tools.count=16`）不受影响。3080 现网（`/hdd/agent` 树，v0.1.5）仍是目录式机制，暂不受影响；**但它引用的 `ops-api.config.preset: i2stream-ops` 在那棵树上是对的**，若将来把现网升到 v0.1.7 会同样断裂。

**修复方向（三选一，未擅自实施）**：
1. `renderProfilePatch` 生成声明式 preset 行（`@deepseek-ai/dsh-agent-preset` 一行 + `agent-preset-registry` default 覆写），id 统一用 `spec.domain`；preset 源目录内容读进 `config.plugins`。同时改 `adopt.ts`/`diff.ts`/`domain.ts`/GUI 文案与 dshctl self-test fixture。工作量最大但一次到位，且 `domain new`→`up` 链路在新版 harness 下恢复可用。
2. 仅对 ops 域手工补一条声明行（临时止血），不动 dshctl；其它域仍会踩。
3. 保持在 v0.1.6-alpha.1 语义上——即回退 harness 版本（不推荐，等于放弃升级）。

> 本 plan 的三项交付（BKN 适配 / 契约校验 / pack 快照）与 P1 无耦合，验收不受影响；P1 属 §6「升级 5 步」第 2 步（`--dump-config` 组合面 diff）应当拦下但此前漏做的项。

### P2 · 契约校验 strict 档的"工具消失"路径已实测

staging 包解出后若 `bknRoot` 指向一个契约不合格的目录，strict 会在构造期 `throw`，fiber 转 FAILED、12 个工具从工具表消失，但**实例本身照常启动**（bkn-plugin 不在 `requiredStartupEntryIds`）。逃生阀：`contractCheck: 'warn' | 'off'`。这符合用户「工具宁可消失不可失真」的拍板，但运维上要知道：**表现为"工具突然没了 + 启动日志有 error 行"，而不是实例起不来**。

### P3 · 打包后 `bknRoot` 相对路径解析差一层

`pack` 后入口是 `lib/index.js`，而 manifest 里的 `bknRoot: bkn` 是相对**包根**——`import.meta.url` 的目录是 `lib/`，直接用会解析成 `lib/bkn`。
修复：`index.ts` 取模块目录后判断是否为 `lib`，是则上跳一层（`basename(moduleDir) === 'lib' ? dirname(moduleDir) : moduleDir`），再以该目录为基准解析相对 `bknRoot` 与 `whitelistPath`。

### P4 · `--with-bkn` 的取值语义与 flag 顺序

`parseFlags` 不支持 `--flag=value`，且带值 flag 会吃掉下一个 token。所以 `--with-bkn` 必须写在 `<id>` 之后、且**后面不能再跟位置参数**（会被当成它的值）。无值时用 manifest 的 `config.bknRoot` 或共享根。已写进 `dshctl help plugin` 文案。

### P5 · `!!js` 配置在打包路径上不能丢

staged patch 的 `config` 走 `dumpYaml`，若原 config 内含 `!!js` 表达式会被求值/丢弃。`manifestConfigPlain(pluginDir, m)` 以**原文正则**检测，命中则不参与自动改写（保持手工维护），这条防护在 C1 打包实测中未触发（bkn-plugin 的 config 无 `!!js`），但已就位。

### P6 · 构建类坑（升级第 3 步连带）

- `pnpm install` 在无 TTY 下中止 → 需 `CI=true`。
- 上游删包后遗留的 5 个 orphan `lib/` 目录导致 `MISSING_EXPORT`（`SettingsProvider`）→ 删目录解决。
- 仓库根的 `@deepseek-ai/dsh-root` tsdown entry (`lib/types/{index,invariant,startup}.js`) 从不产出 → 绕过根 workspace，按包构建（`tsc -b` host/client + 逐包 tsdown，`DSH_BUILD_FACE`），注意 client 面包不都在 `packages/client/` 下（如 `packages/api/job-controller`）。
- `dsh-ops-trial.service` 是 transient unit：失败后会消失，必须用 `code/scripts/run-ops-trial.sh start` 重建（顺带重挂 EnvironmentFile）。

### 差分对照（TS vs Python，5 处差异全部判定为无害）

| # | 差异 | 判定 |
|---|---|---|
| 1 | JSON 缩进/空格 | 外观，无影响 |
| 2 | `suspected_process` 带 `process:` 前缀（Python 同值） | 逐行核对 Python `_iter_mapping_lines` 只剥 `(abstract)`、保留命名空间 → **一致**，断言按此修正 |
| 3 | `charset_notes.delegated_to` 嵌套形状 | 字段组织差异，值同源 |
| 4 | `relationKey` vs `relation_key` | TS 侧既有命名惯例，非本次引入 |
| 5 | product 返回 `kv`+`raw`；TS 的 `kv` 少 `<!-- type` 键 | 注释型元数据，Agent 不消费 |

- 2026-09-28 计划创建；self-test 期望先行修正（A3）。
- 2026-09-28 三项交付完成并回填验收；发现阻断级回归 P1（上游 preset 机制替换），未擅自修，留待拍板。
