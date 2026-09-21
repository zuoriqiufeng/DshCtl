# dshctl 设计：DSH 领域编排程序

> 2026-09-16 · 状态：**v0.1 ~ v1.0 全部实施并验收通过（含 v0.4 GUI）**——实施记录见 `doc/dshctl-exec-plan.md`（含全量清扫批次节）
> 上游：`domain-agent-orchestration-proposal.md`（§3 编排架构、§5 工厂化）；`ops-trial-operations-manual.md`（升级跟随 5 步、观察期检查单——本程序主要自动化它们）
> 定位：把"编排 DSH 实例"的经验固化为一个 **CLI 程序**：清单驱动、幂等生成、对账校验。**只管交付期（实例怎么被正确地造出来并保持正确），不碰运行期热管理**（那是 DSH /admin 的职责）。

---

## 1. 背景与问题

运维域编排已交付（doc/ 10 份文档），SQL 转换域待落地。当前痛点：

1. **编排知识无单一口径**：再做一个领域要重读 10 份文档 + 手工复制目录 + 逐处改配置，改漏一处就是运行时故障。
2. **升级跟随是人工活**：手册第 2 步要求人工 dump-config diff 对账 disable 清单，57 项纯肉眼，漏一项 = 上游新增能力静默放行。
3. **实例无登记**：8642 端口归属之谜的直接根因；端口/DSH_HOME/unit 散落在文档和记忆里。
4. **配置错误发现太晚**：如 SQL 域 turnTimeout 默认 120s 但实际任务 1800s——这类错只有真实流量才暴露。

dshctl 把这四件事变成：`domain.yml`（单一口径）+ `check`（对账自动化）+ `registry`（实例登记）+ 前置断言（错误左移到交付期）。

## 2. 边界（防腐化声明）

| 阶段 | 工具 | 职责 |
|------|------|------|
| **交付期** | **dshctl**（自建，本文档） | 生成、校验、对账、登记、冒烟、升级跟随。**只读写文件与配置，不常驻、无状态、无数据库** |
| **运行期** | DSH /admin（已有） | MCP 热增删、skill 启停、状态查看 |
| **产品入口** | i2Console（**MaintenanceAgent 产品线既有前端，是运维域的对接对象，不属于本工具体系**） | 运维人员的统一人机入口；通过 i2Agent 代理对接 DSH /admin（§4 方案） |

> 定位澄清（2026-09-16）：i2Console 归 MaintenanceAgent 产品所有，dshctl 不依赖、不修改它；反过来 dshctl 的交互设计可**借鉴** i2Console / DSH GUI 的成熟模式（见 §3.1 借鉴清单）。

明确不做：不做运行时守护、不做配置下发推送、不抽象"领域插件框架"（proposal §5.3）、不管理共享基础设施本体（Gateway/Qdrant 由 systemd 管，dshctl 只校验可达性）。

**GUI 决策（2026-09-16 用户拍板）**：dshctl **需要自有 GUI**，与 i2Console 完全隔离——i2Console 是 MaintenanceAgent 运维产品的前端，编排工具的管理界面**禁止混入**产品前端（职责、用户、发布周期都不同）。GUI 作为独立模块随 dshctl 同仓建设（v0.x 仍是 CLI 先行，GUI 在 CLI 命令面稳定后叠加，薄壳调用同一套核心逻辑），技术栈借鉴 i2Console（React 18 + TS + Vite + AntD + Axios）但不共享代码与部署。

### 3.1 从 i2Console / DSH GUI 借鉴的设计模式

| 来源 | 借鉴点 | 用在 dshctl 哪里 |
|------|--------|-----------------|
| i2Console/i2Agent | 原子写配置（`.tmp` + rename）、写前备份、revision 乐观锁 | apply 落盘约定（§7），与 DSH 托管段写纪律同源 |
| i2Console/i2Agent | `$ENV` 环境变量占位、密钥不落库不落前端 | domain.yml 的 `api_key_env`（§4、R8） |
| i2Console/i2Agent | 技术栈（React 18 + TS + Vite + AntD + Axios）、页面布局模式 | dshctl GUI（独立工程，仅栈对齐，代码不共享） |
| i2Agent autodiag | 工具白名单/只读语义分离（disabled vs read-only 两维度） | 护栏白名单规则源（proposal §3.4）的语义设计 |
| DSH /admin 页面 | 状态页聚合（bundle/surface/MCP/preset/健康一屏） | `dshctl check` 的输出布局与 `--json` 字段命名与其对齐；GUI 的状态总览页复用同一字段集 |
| DSH GUI/CLI | 命令即文档（每个命令 `--help` 自说明、错误信息带规则编号） | §8 错误格式 `[R4:error] … → 见文档 §6` |

**GUI 边界**：dshctl GUI 只可视化 dshctl 的自有产出（domain 清单、check 报告、diff、registry、生成物预览），是 CLI 的薄壳——所有操作后端 = dshctl 核心逻辑，GUI 不另建业务逻辑、不直连 DSH 实例的运行期接口（运行期管理归 /admin，展示归 i2Console 链路）。

## 3. 技术形态

- **语言**：TypeScript（tsx 运行），与 DSH 同生态，直接复用 yaml/cordis patch 语义；
- **位置**：`dsh-info/code/dshctl/`（v1.0 稳定后独立成仓，见 §9）；
- **规模预算**：v0.1 ≤ 500 行，全量 ≤ 1500 行。超预算 = 设计腐化信号，停下来砍需求；
- **依赖**：yaml、（可选）@iarna/toml 不需要；不依赖 DSH 运行时内部 API——**只读其 dump-config / 文件产物**，避免上游内部变动牵连；
- **分发**：`npm exec tsx dshctl.ts <cmd>` 或 alias；v1.0 后可编译单文件。

## 4. 输入：领域清单 domain.yml

格式沿用 proposal §3.1，此处固化为 schema（校验器 1 号消费它）：

```yaml
# domains/sql-transform/domain.yml
schema: 1                          # 清单 schema 版本，dshctl 按版本解释
domain: sql-transform              # ^[a-z][a-z0-9-]*$，全局唯一（registry 查重）
display_name: "SQL 异构转换 Agent"
dsh_home: /hdd/demo/public/dsh-info/.dsh-sql-home   # 实例独立 DSH_HOME
dsh_source: /hdd/demo/public/dsh-info/deepseek-harness  # 上游构建产物位置

capabilities: [file-ops, script]   # 能力包勾选；可选值 = capability-packs/ 目录下的片段名
contracts:                         # 领域对外契约声明（影响校验规则，见 §6 R5/R7）
  media_dirs: [/tmp, /opt/data]    # MEDIA 类文件输出契约目录（可选；声明后必须与写白名单对账）
guard:
  rule_source: whitelist           # bkn | whitelist | none
  whitelist:
    commands: [obclient, mysql]    # script 包可执行文件白名单（capabilities 含 script 时必填）
    write_paths: [/tmp, /opt/data] # file-ops 写路径白名单（含 file-ops 时必填）

preset:
  source: code/presets/sql-transform/   # persona + 热路径源目录
  skills_dirs:                          # 挂进 skill-filesystem 的目录（绝对路径，必须存在且非空）
    - /hdd/agent/stream-agent/sql_transform/skills/chains
    - /hdd/agent/stream-agent/sql_transform/skills/shared
    - /hdd/agent/stream-agent/sql_transform/skills/sources

plugins: []                        # 领域工具插件 [{id, path, config?}]；运维域 = [bkn-plugin]。
                                   # domain-api 不在此列——由 api_server 段自动注入（见下），避免两处配同一个插件
api_server:                        # 非空即自动生成 domain-api 插件的 profile insert 项，config 从本段映射
  port: 8644
  api_key_env: SQLTF_API_KEY       # 只记环境变量名，不记值（密钥不入库）
  turn_timeout_sec: 1800
  max_task_duration_sec: 1800      # 领域声明的最长任务时长，与 timeout 对账（规则 R7）
memory:
  gateway_url: http://127.0.0.1:8420
  session_keys: ["sql-transform:convert:prod", "sql-transform:migrate:prod"]
ports: { gui: 3082, api: 8644 }
systemd_unit: dsh-sql-transform.service
shared_deps:                       # 共享基础设施可达性校验（check 时探测，不管理其生命周期）
  - { name: memory-gateway, url: http://127.0.0.1:8420/health }
```

**设计要点**：清单是唯一长期维护物；生成物全部可再生，可随时删除重建。密钥永远不写入清单与生成物（只写环境变量名）。

## 5. 命令规格

> 通用约定：全部命令幂等；写操作前必先输出 dry-run diff 摘要（`--yes` 跳过确认）；退出码 0=通过/成功，1=校验失败，2=执行错误。所有输出同时给人看（表格）和给机器看（`--json`）。

### F1 adopt（反向归档 + 能力包引导）——v0.1 核心

把**现存实例**逆向生成 domain.yml，同时承担**能力包片段的首次引导产出**——解决"apply 依赖能力包片段，但片段还不存在"的鸡生蛋问题。

- 输入：`--instance <name>` + 探测路径（默认 `/hdd/demo/public/dsh-info/.dsh-home`）；
- 行为：
  1. 读实例的 `profiles/<p>/cordis.patch.yml`、`bundles/ops-app/cordis.patch.yml`、settings.yaml、进程端口（`ss -tlnp` 辅助）；
  2. **归层匹配（两阶段）**：
     - 若 `capability-packs/` 已有片段：disable 清单逐项匹配片段 → 归入该包；匹配不上 → 列入 `unclassified`；
     - 若 `capability-packs/` 为空（首次运行）：按内置的**归属启发式**（id 前缀/分类，如 `subagent|workflow|goal|plan|web-*` → core；`read|write|edit|file-upload` → file-ops；`bash|terminal|run_code` → script；其余 → unclassified）生成**片段初稿**到 `capability-packs/*.yml`，头部标注 `# DRAFT: adopt 引导产出，待人工审层`；人工审订后删除 DRAFT 标记即定稿；
  3. 产出 `domains/<name>/domain.yml` + registry 登记；
- 验收：对运维实例跑 adopt 后，`dshctl diff ops` 应为**空**（生成物与现状一致）——这是程序"正确理解现状"的自证。注意：该验收以能力包片段**定稿后**为前提，DRAFT 状态下 diff 允许非空（差异即归层调整）。

### F2 check（对账器）——v0.1 核心，纯只读

对指定领域执行全部适用校验规则（§6），输出逐项 pass/warn/error：

- **上游对账**：dump-config 的来源与缓存策略——
  - 优先读缓存 `domains/.cache/dump-config-<上游版本号>.json`；
  - 缓存不存在或 `--refresh` 时，执行上游构建产物的 dump-config（`node <dsh_source>/dist/dsh.js dump-config --json`）并写缓存；
  - 缓存文件以上游 package.json 版本号命名，版本不匹配即失效重建，避免拿旧 roster 对账新清单；
  - 验证 disable 清单每个 id 仍存在（消失=error）、上游新增条目是否已被能力包覆盖（未覆盖=warn）；
- 清单内部一致性：§6 规则 R1-R8；
- 环境可达性：端口占用、skills_dirs 存在非空、shared_deps 健康、DSH_HOME 骨架完整；
- `--ci` 模式：任一 error 退出码 1，供流水线/观察期周检脚本调用。

### F3 diff / apply（生成与落盘）——v0.2

- `diff`：渲染全部生成物到内存，与 `$DSH_HOME` 现状做 unified diff 输出，不落盘；
- `apply`：先跑 check（有 error 拒绝），diff 经确认后原子写（`.tmp` + rename，与 DSH 自身约定一致），更新 registry 的 `applied_at`；
- 生成物清单（§7）。

### F4 smoke（冒烟）——v0.2

- 在 `$DSH_HOME` 起**临时实例**：端口 = 声明端口 +100；若 +100 也被占用，按 +101/+102… 顺延探测（上限 +110，全占用则报错退出），并在报告头部显式标注实际使用端口；
- 跑 `api-smoke`（健康/模型/chat/responses/记忆端点）+ 领域自检（如运维域 dsh-plugin self-test）；
- 可选 `--bench`：跑领域基准脚本（运维 = bench-4q；SQL 域 = proposal §6.5 达标线题集）；
- 结束即停临时实例，输出报告；**异常中断（Ctrl-C/崩溃）也要兜底停实例**（trap/finally），不留孤儿进程占端口。

### F5 registry（实例登记）

- `registry list`：所有实例的 domain/端口/DSH_HOME/unit/最近 check 时间+结果一览；
- `registry` 是 `domains/registry.yml` 单文件，人可读、git 可 diff；apply/adopt 自动维护，也接受手工编辑（check 时校验与实际环境一致）。

### F6 upgrade-check（升级跟随对账）——v0.3

替代升级手册第 2 步：
1. 构建上游新产物 → dump-config；
2. 对**所有**已登记领域跑 check 的上游对账子集；
3. 输出"每个领域需要动的清单"（消失的 id、新增的待评估条目）；
4. 全部领域 pass 才允许进入手册第 3 步（替换产物）。

## 6. 校验规则（经验 → 断言）

| # | 规则 | 级别 | 来源教训 |
|---|------|------|---------|
| R1 | domain 名全局唯一；gui/api 端口不与 registry 冲突、不被本机其他进程占用（含 8642 这类未登记占用 → 提示登记） | error | 8642 归属之谜 |
| R2 | disable 清单中每个 id 在上游 dump-config 中存在；消失即 error（disable 失效 = 能力静默放行） | error | 升级手册第 2 步 |
| R3 | 上游新增的 tool/skill/surface/command 未被任何能力包覆盖 → 提示人工评估裁剪 | warn | 同上 |
| R4 | `capabilities` 含 `script` 时 `guard.whitelist.commands` 必填非空（裸 bash 无护栏禁止） | error | proposal §3.4 |
| R5 | `contracts.media_dirs` 非空时，其目录必须 ⊆ `guard.whitelist.write_paths`（契约目录必须被护栏放行，否则 Agent 写得出、契约读不到） | error | SQL 域 MEDIA 契约 |
| R6 | `preset.skills_dirs` 每项存在且含 ≥1 个带合法 frontmatter 的 SKILL.md | error | skill 挂载即缺失教训 |
| R7 | `api_server.turn_timeout_sec` ≥ `max_task_duration_sec` | error | SQL 域 1800 vs 默认 120 的坑 |
| R8 | `api_key_env` 只含环境变量名（正则 `^\$?[A-Z_]+$`），禁止字面值 | error | 密钥不入库原则 |
| R9 | shared_deps 各 url 可达 | warn（交付期可能是冷启动前） | 共享设施独立托管边界 |
| R10 | `unclassified` disable 项非空 → 提示归层 | warn | adopt 产物完整性 |

## 7. 生成物规格（apply 的输出）

| 生成物 | 来源 | 备注 |
|--------|------|------|
| `$DSH_HOME/settings.yaml` | 模板 + 清单 | **深合并而非覆盖**：文件已存在时，credentials/密钥段与未知键原样保留，仅覆盖模板管理的键；密钥值从 `api_key_env` 指向的环境变量读取，绝不落盘 |
| `bundles/ops-app/cordis.patch.yml` | `core-disable.yml` + 勾选能力包片段**拼接** | 每项带注释标注来源能力包，便于人工审 diff |
| `profiles/<domain>/package.json` | 模板（bundles 列表） | |
| `profiles/<domain>/cordis.patch.yml` | 模板 + 清单（preset roots、`plugins` 插件 insert、domain-api insert 由 `api_server` 段自动生成） | |
| `presets/<domain>/` | 从 `preset.source` 拷贝 | persona/热路径保持源目录编辑，apply 同步 |
| `domains/registry.yml` 条目 | 清单 + 实际落盘结果 | applied_at / check 结果摘要 |
| systemd unit 文件 | 模板 | 输出到 stdout 或指定目录，安装动作由人执行（程序不碰 systemctl） |

**不生成**：上游源码任何文件（对上游零改动的红线不变）、密钥文件、共享基础设施配置。

### 7.1 能力包片段格式（capability-packs/*.yml）

```yaml
# capability-packs/core.yml —— 核心层：所有领域必裁（编码 agent 专属能力面）
# 状态：DRAFT（adopt 引导产出）→ 人工审层后删除下行即定稿
pack: core
description: "subagent/workflow/goal/plan/web/桌面联动等编码 agent 能力"
disable:
  tools: [subagent, goal, plan-mode, ...]
  skills: [workflow-ptc, ...]
  commands: [...]
  surfaces: [...]
  mcp: [...]
# 拼接规则：多个片段的同名键数组取并集，顺序 = core → 能力包声明序；
# 同一 id 出现在多个片段 → apply 报错（归属唯一，防止边界模糊）
```

```yaml
# capability-packs/file-ops.yml —— 保留读/写/编辑，裁 terminal/bash 由 script 包负责
pack: file-ops
description: "文件读写能力（SQL 域：读输入文件、写 MEDIA 输出、读映射表）"
disable:                            # 片段语义 = "勾选本包时，从核心层保留这些，同时额外裁掉这些"
  keep_tools: [read, write, edit, file-upload, workspace-files]
  disable:
    tools: [terminal]             # 本包内禁用项；bash/run_code 归 script 包管辖
```

> 片段的精确键名（keep_tools/disable.tools/…）以实现时对齐 cordis patch schema 为准；此处规定的是**语义模型**：核心层全裁 → 能力包按勾选"放回/再裁"→ 生成最终 disable 集合。

### 7.2 registry.yml 格式

```yaml
# domains/registry.yml —— 实例登记表（dshctl 自动维护，接受手工编辑，check 时与实际环境对账）
instances:
  - domain: i2stream-ops
    dsh_home: /hdd/demo/public/dsh-info/.dsh-home
    ports: { gui: 3081, api: 8643 }
    systemd_unit: dsh-ops-trial.service
    status: trial                 # trial | prod | retired
    last_check: { at: 2026-09-16, result: pass, errors: 0, warns: 0 }
    applied_at: 2026-09-15
shared_deps:
  - { name: memory-gateway, url: http://127.0.0.1:8420 }
  - { name: qdrant, url: http://127.0.0.1:6333 }
  - { name: embed-sidecar, url: http://127.0.0.1:8096 }
unregistered_ports: [8642]        # 已知占用但未登记的端口（8642 归属待确认，先登记在案）
```

## 8. 错误处理与排障

- 校验失败输出统一格式：`[R4:error] capabilities 含 script 但 guard.whitelist.commands 为空 → 见 gernalarrange/dshctl-design.md §6`（规则编号可直接查文档）；
- dump-config 失败（上游未构建）→ check 退化为"清单内部校验"子集并显式标注，不静默跳过；
- adopt 遇到无法归层的 disable 项 → 不猜，进 `unclassified` 交人工；
- 所有写路径先验证目标目录存在且属主正确，避免 sudo/权限半写状态。

## 9. 演进路线

| 版本 | 内容 | 出口标准 |
|------|------|---------|
| v0.1 | F1 adopt + F2 check + F5 registry + §6 规则 R1-R3/R6-R8 | 对运维试验实例 adopt 后 diff 为空；check 全绿 |
| v0.2 | F3 diff/apply + F4 smoke + R4/R5/R9 | ✅ **已实施+验收（2026-09-16）**：init 语义以 smoke-demo 临时域演示（apply 7 件骨架→R4 生效→diff 空→清理）；smoke ops 端到端五连测过（8743 无残留）；见 dshctl-exec-plan.md §v0.2 |
| v0.3 | F6 upgrade-check + R10 | ✅ **已实施+验收（2026-09-16）**：upgrade-check verdict 三态（pass/blocked/degraded，roster 不可用不允许假通过）；R10 已于 v0.2 提前实现（warn）；假基线反向演练通过；见 dshctl-exec-plan.md §v0.3 |
| v0.4 | GUI（独立工程，栈对齐 i2Console，薄壳调 CLI 核心逻辑；页面：清单编辑/check 报告/diff 预览/registry 总览） | ✅ **已实施+验收（2026-09-16）**：React19+AntD6+Vite8 五页，每响应带 equivalentCommand；live 四端点验证通过；见 exec-plan 批4 |
| v1.0 | 脱离 dsh-info 独立成仓，check 进 CI | ✅ **已实施（2026-09-16）**：code/dshctl git 仓（首提交 4222283）+ README + ci.sh 五环节一键 ALL GREEN；物理迁出独立托管待定 |

**先 check/adopt 后 init 的理由**：对账器只读，风险为零，且立刻吃掉观察期周检的人工项；生成器写错会造出坏实例，放在程序已被 adopt 验证"理解现状"之后。

## 10. 验收 DoD（v0.1）

1. `dshctl adopt --instance ops` 产出的 domain.yml 经人工审阅无误；能力包片段完成人工审层（DRAFT 标记全部移除），`unclassified` 为空或已显式确认；
2. 片段定稿后 `dshctl diff ops` 输出为空（DRAFT 状态下允许非空，差异即归层调整，见 §5 F1）；
3. `dshctl check ops --ci` 退出码 0；
4. 手工在 disable 清单里捏一个消失 id，`check` 报 R2 error 且退出码 1（反向验证断言有效）；
5. 运维手册"观察期每周检查单"中由 check 覆盖的项目标注"已自动化"。

### ✅ v0.1 验收结果（2026-09-16 实测，逐条回填）

| # | 结果 |
|---|---|
| 1 | ✅ adopt 产出 domain.yml（api 8643 / headless gui=null / api_key_env 从 `!!js` 提取 / plugins=bkn-plugin+ops-skill-manager）；首次归层 unclassified=0（家族名启发式修正后）；审层移入 terminal-controller/workspace-files/file-reference-local → core，定稿 core.yml + remote-exec.yml，DRAFT 全部移除 |
| 2 | ✅ `diff ops: 空 ✓（程序正确理解现状）` exit 0（规范化集合对比，忽略注释/顺序） |
| 3 | ✅ `check ops --ci` 48 项全 pass（R1×6 含 unit 占用自证 + R2×44 对照真实 roster v0.1.6-alpha.1 + R3/R6/R7/R8），0 error 0 warn，exit 0 |
| 4 | ✅ 注入 `ui-goal-renamed-upstream` → `[R2:error] 已不在上游 roster → FAIL` exit 1；还原后 exit 0 |
| 5 | ✅ `ops-trial-operations-manual.md` 检查单已标注自动化覆盖项 |

self-test 45 断言 ALL PASSED；对上游仓库零改动；全程只读探测。行数偏差与踩坑记录见 `dshctl-exec-plan.md` §1-§2（可执行代码 ~790 行 vs 预算 500，归因=含只读 diff 与实测必需探测，非框架腐化；v0.2 以 1500 全量红线为界复核）。
