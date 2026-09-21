# dshctl v0.1 实施计划与验收回填

> 2026-09-16 · 依据 `gernalarrange/dshctl-design.md`（v0.1 范围：adopt + check + registry + 最小只读 diff）
> 执行模式：逐模块实施 → self-test 全绿 → live 验收 DoD 五条 → 回填本文档 + 设计文档 §10
> 交付物：`code/dshctl/`（TS，tsx 运行）+ `domains/`（清单/登记/roster 缓存）+ `code/capability-packs/`（审层定稿片段）

---

## 0. 范围裁决（计划期确定）

- **版本**：v0.1 + **最小只读 diff**——设计文档 §9 把 diff/apply 放 v0.2，但 §10 DoD 第 2 条「adopt 后 diff 为空」依赖只读 diff；裁决 = v0.1 含只读 diff，写盘 apply 留 v0.2。
- **规则集**：R1/R2/R3/R6/R7/R8（设计 §9 v0.1 清单）；R4/R5/R9/R10 随 v0.2/v0.3。
- **红线全程遵守**：不常驻/无状态；只消费 DSH 文件产物（dump-config/patch 文件），不 import 运行时与 ops-api 代码；`deepseek-harness/` 零改动；密钥只记 env 名不落盘。

## 1. 模块与行数

| 文件 | 行数 | 职责 |
|---|---|---|
| yml.ts | 36 | `!!js` 标量原文保留（customTags 收集、绝不求值）+ 原子写 |
| domain.ts | 61 | domain.yml schema:1 解析/校验/渲染（R7/R8 内嵌） |
| registry.ts | 57 | registry.yml 读写/upsert/端口冲突查重 |
| packs.ts | ~100 | 能力包片段加载、归属启发式、拼接（core 隐含必裁）、DRAFT 渲染 |
| adopt.ts | 170 | 反向归档：profile patch/ops-app patch/preset → domain.yml + DRAFT 片段 + registry |
| check.ts | 164 | 规则引擎 + dump-config roster（版本缓存）+ 降级子集 |
| diff.ts | 48 | 只读 diff：片段拼接 vs ops-app patch（规范化集合对比，忽略注释/顺序） |
| dshctl.ts | 154 | CLI：adopt/check/diff/registry，退出码 0/1/2，--json |
| self-test.ts | 248 | [1]-[7] 段 fixture 自测（不依赖 live） |
| **合计** | **~1030** | 其中可执行代码 ~790、self-test 248 |

> **预算偏差说明（如实记录）**：设计 §3 规定 v0.1 ≤500 行。实测可执行代码 ~790 行，超 58%。
> 归因：① v0.1 范围按 DoD 裁决扩了只读 diff（+~100）；② `!!js` 安全解析与 R1 端口/unit 自证探测为实测必需（+~80）；
> ③ 中文注释密度沿工作区惯例。无互相引用的框架抽象、无未用配置面——**不是设计腐化，是范围增量**；
> v0.2 排期时以此为基线复核（apply/smoke 预计 +250，全量 ≤1500 红线仍可守）。

## 2. 实施记录（2026-09-16）

- **yaml 依赖**：`code/dshctl/` 独立 package.json + 本地 node_modules（`pnpm --store-dir /hdd/demo/public/dsh-info/.pnpm-store` 安装 yaml@2.9.1）。运行约定（2026-09-16 独立化后）：`dshctl <cmd>`（自带 tsx，任意目录可用）；此前为 `cd deepseek-harness && node --import tsx/esm <abs>`。
- **`!!js` 处理**：`YAML.parseDocument(src, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: s => s }] })`——值按字符串原文保留，0 error；adopt 用正则从表达式提取 env 名，遇字面值 → R8 warn + 占位 `REPLACE_ME`（红线）。
- **core 隐含必裁**：domain.yml 的 `capabilities` 按设计示例不写 core（如 `[remote-exec]`）；`mergePacks` 内部恒并入 core 片段——消除"忘了勾 core → diff/check 全空转"的坑。
- **归层启发式迭代**：初版 `^(subagent|...)` 前缀锚定漏掉 `tool-subagent-* / command-goal / tool-goal / tool-workflow`（7 个 unclassified）；补**家族名任意位置**正则 `(^|[-_])(subagent|workflow|goal|plan)([-_]|$)` 后归 core。
- **人工审层（DoD #1，实施者执行）**：`terminal-controller / workspace-files / file-reference-local` 三 id 虽被启发式分入 script/file-ops，但属"被关 UI 的后端/文件引用面"——运维域不勾选这两个能力包，**移入 core.yml**；删除空的 file-ops.yml/script.yml；core/remote-exec 去 DRAFT 行定稿。这正是"程序不自作归层终判、DRAFT 交人工"的设计意图。
- **踩坑**：① `loadRoster` 初版未把 `DSH_HOME` 传给 dump-config 子进程 → `profile "ops" does not exist`；修为 `env: { ...process.env, DSH_HOME: spec.dsh_home }`。② ESM 下不得用 `require()`——两处延迟获取改顶层 import。③ 首次 adopt 的 packs 引导逻辑把"目录不存在"误判为"已有片段"（三元写反），归层池为空导致 bash 落 unclassified——修 firstRun 判定（无 *.yml 即引导模式）。

## 3. live 验收（DoD 五条，2026-09-16 实测）

| # | 项 | 结果 |
|---|---|---|
| 1 | `adopt --instance ops` → domain.yml 审阅 + DRAFT 审层 + unclassified 空 | ✅ 产出 domain.yml（api 8643/headless/gui=null/plugins 2 个/api_key_env 提取正确）；首次归层 core 41 + file-ops 2 + script 1 + unclassified 0；审层后定稿 core.yml（43 disable + connection 覆写）+ remote-exec.yml |
| 2 | 片段定稿后 `diff ops` 为空 | ✅ `diff ops: 空 ✓（程序正确理解现状）` exit 0 |
| 3 | `check ops --ci` 退出码 0 | ✅ 48 项全 pass：R1×6（含 8643 被本实例 unit 占用自证）+ R2×44（对照真实上游 roster v0.1.6-alpha.1，缓存落 `domains/.cache/`）+ R3/R6/R7/R8；0 error 0 warn |
| 4 | 反向验证：捏消失 id → R2 error 退出码 1 | ✅ 注入 `ui-goal-renamed-upstream` → `✗ [R2:error] …已不在上游 roster` FAIL exit 1；还原后 exit 0 |
| 5 | 观察期检查单标注"已自动化" | ✅ `ops-trial-operations-manual.md` 检查单已标注（见该文件） |
| 附 | self-test | ✅ [1]-[7] 段 45 断言 ALL PASSED（fixture 驱动，不依赖 live） |
| 附 | 对上游零改动 / 不打扰运行实例 | ✅ deepseek-harness git status 无新增改动；全程只读探测（dump-config 不起服务） |

## 4. 产出物清单（全部可再生）

```
domains/ops/domain.yml               领域清单（schema:1）
domains/registry.yml                 实例登记（ops: trial, api 8643, gui headless, unit dsh-ops-trial）
domains/.cache/dump-config-0.1.6-alpha.1.json   上游 roster 缓存（版本号命名，升级即失效重建）
code/capability-packs/core.yml       核心层（定稿；43 disabled + connection 覆写）
code/capability-packs/remote-exec.yml 能力包（定稿；空 disable——运维域=不挂本机 bash/fs 的现状）
code/dshctl/                         源码（9 文件，含 self-test）
```

## 5. 命令速查

```sh
# 独立化后（自带 tsx，任意目录可用；PATH 软链 /usr/local/bin/dshctl）
dshctl adopt --instance ops --unit dsh-ops-trial.service   # 反向归档（幂等）
dshctl check ops [--refresh] [--ci] [--json]               # 对账（--refresh 强刷 roster）
dshctl diff ops                                            # 只读 diff（空=理解现状）
dshctl registry                                            # 登记表一览
dshctl upgrade-check [--refresh]                           # 升级跟随对账
dshctl-selftest                                            # 自测（bin/dshctl-selftest）
dshctl-gui [--port 8780]                                   # GUI server（bin/dshctl-gui）
```

## 6. v0.2 衔接（待排期，不在本次范围）

- F3 写盘 `apply`（check 有 error 拒绝 → dry-run diff → 原子写 + registry.applied_at）；
- F4 `smoke`（临时实例端口 +100 顺延探测，复用 `scripts/api-smoke.sh`，trap 兜底停实例）；
- R4（script 包命令白名单必填）/ R5（MEDIA 契约目录 ⊆ 写白名单）/ R9（shared_deps 探活——registry 的 shared_deps 段现为空，adopt 建议后续回填）/ R10（unclassified → warn，v0.1 已在 adopt warns 中提示，正式入 check 规则集）；
- R1 增强：`unregistered_ports` 命中占用端口时输出登记提示（现状仅人工维护该清单）。

---

# dshctl v0.2 实施计划与验收回填（apply + smoke + R4/R5/R9）

> 2026-09-16 · 依据设计 §9 v0.2；范围裁决：含 R10（归层缺口 warn）与 R1 增强（unregistered_ports 提示）。

## 1. 范围与关键裁决（计划期源码核实后确定）

- **apply 不生成 settings.yaml/.credentials.yaml**（对设计 §7 的显式偏离）：模型 provider/凭据属环境资产而非编排声明面，深合并凭据文件风险大于收益——已存在则跳过，缺失则 warn 提示人工拷贝；生成物只覆盖编排五件（ops-app patch、profile manifest+patch、presets 拷贝、registry、systemd unit 模板输出不安装）。
- **config 整体替换语义**（`vendor/include/src/index.ts:120-122` 核实：`target.config = value` 无递归合并）→ 两条工程结论：① smoke 的端口隔离 overlay 必须携带**完整** domain-api config 仅改 port；② apply 生成 profile patch 必须产出完整 config。
- **`--patch` overlay 顺序**（`profile-boot.ts:212-219` 核实）：bundle → profile patch → home patch → --patch overlays——smoke 用它实现零改动端口隔离。
- **同 DSH_HOME 并发安全**（核实：无 home 级单例锁，仅 per-session flock + boot 短锁）→ smoke 临时实例可与现网实例共存。
- **diff/apply 子集语义**：只对账 apply 管理面（能力包集合/manifest bundles/profile patch id 存在性/presets 文件清单）；现状多余项（MCP 托管段、运维演化配置）记 note 不记差异。
- **preset.source 已在 DSH_HOME 内**（adopt 记录的实例自用目录）→ diff 自源自比、apply 跳过自拷。

## 2. 实施记录（2026-09-16）

- 新模块：`render.ts`（五件生成物纯渲染器，apply/diff 共用）、`apply.ts`（原子写 + `assertInside` 越界防护）、`smoke.ts`（overlay/端口顺延/env 文件解析/detached spawn/health 轮询/api-smoke/领域自检/进程组兜底清理）。
- check 增量：R4（script 包命令白名单必填）、R5（media_dirs ⊆ write_paths）、R9（shared_deps HTTP 探活，任何响应=可达）、R10（现状 patch vs 能力包渲染差集 warn）、R1 增强（占用端口命中 unregistered_ports 时提示登记）；`runChecks` 改 async（R9 需 fetch）。
- **keep_tools 语义修正**：初版把 keep 当"预留防重名"，与设计 §7.1"从核心层放回"不符——重构为两段式（先收集全部 disable/override，再用 keep_tools 从结果移除）。为此在 `capability-packs/` 落地 **file-ops.yml / script.yml** 两个真实能力包（keep_tools 语义，SQL 域首个用户；ops 未勾选故对运维实例零影响）。
- domain 扩展：`api_server.plugin_path/plugin_id`（adopt 从实例回填 domain-api 插件源码与 insert id——保证对现存实例 diff 可为空；新域缺省 id=domain-api、path 必填否则 apply 报错）。
- **踩坑**：① alias 化的交互 cp/rm 阻断脚本——脚本内改用 python shutil/`rm -f`；② 首版 diffDomain presets 组用 `home/presets/<domain>` 作目标目录，与 adopt 记录的 `presets/i2stream-ops`（preset 名≠域名）错位——修为"source 已在 home 内则自源自比"。

## 3. live 验收（2026-09-16 实测）

| # | 项 | 结果 |
|---|---|---|
| 1 | `check ops --ci` 含新规则全绿 | ✅ 0 error 0 warn exit 0；R9 双项可达（i2agent:8090 / Gateway:8420）；R10 无归层缺口；存量 48 项不破 |
| 2 | `diff ops` 回归 | ✅ 空 exit 0（子集语义；mcp-i2agent 记 note 忽略） |
| 3 | `apply ops --dry-run` 幂等 | ✅ "生成物与现状一致（零写盘）" exit 0——对现网实例零扰动 |
| 4 | 临时域 init 演示（smoke-demo，SQL 形状） | ✅ R4 反例：清空白名单 → `[R4:error] 裸 bash 无护栏禁止` FAIL exit 1；补 whitelist 后 `apply --yes` 写 7 件骨架（keep 生效：workspace-files/terminal/bash/run_code 已放回，disable 43 项）；`diff smoke-demo` 空（apply→diff 幂等）；**验收后已清理**（/tmp/dshctl-demo、domains/smoke-demo、registry 条目） |
| 5 | `smoke ops` 端到端 | ✅ 端口 8743（8643+100 顺延）→ overlay 整段替换 config → temp 实例 health ✓ → api-smoke 五连测 exit 0 → 领域自检 dsh-plugin + ops-skill-manager exit 0,0 → cleaned ✓；**残留核查：8743 无监听、无孤儿进程**（存活的 3104755 系为 systemd 托管的现网试验实例本体） |
| 6 | self-test | ✅ [1]-[10] 段 **71 断言 ALL PASSED**（新增 26：apply 9 / 规则 7 / smoke 7 / keep 语义 3） |
| 7 | 上游零改动 | ✅ deepseek-harness 无新增改动 |

## 4. 规模复核（红线触碰，如实记录）

- 全量 **1734 行**（可执行 1392 + self-test 342），超设计 §3 "全量 ≤1500" 红线 **+234 行**。
- 归因：v0.2 范围含 apply/smoke/render 三个实质模块 + 四条新规则 + overlay/端口/env 等实测必需探测；无未用配置面、无重复抽象。
- 处置建议（v0.3 排期时定）：upgrade-check（F6）预计 +100 内可控；若届时逼近 1500+，优先把 self-test 移出规模口径（设计原文的预算直觉指向产品代码），或砍 smoke 的 `--bench` 预留等冗余。**触线事实已记录，不默认滑过。**

## 5. v0.3 衔接（未排期）

- F6 upgrade-check（多领域 roster 对账 + "每个领域需要动的清单"）+ R10 转正（现为 check warn）；
- smoke `--bench` 真实接线（ops=bench-4q.sh 指临时端口）；
- apply 的 preset 源目录版本漂移检测（拷贝后 source 改动提示 re-sync）。

---

# dshctl v0.3 实施计划与验收回填（upgrade-check）

> 2026-09-16 · 依据设计 §5 F6 与 §9 v0.3 行（"F6 upgrade-check + R10"）。
> **R10 说明**：已在 v0.2 提前实现为 check 的 warn 条目（与设计 §6 表级别一致），本阶段无代码改动，转正记录以本节为准。

## 1. 命令语义（`dshctl upgrade-check [--refresh] [--json]`）

替代升级跟随手册第 2 步的人工肉眼 diff：registry 全领域 × 上游 roster（按 dsh_source 分组、版本缓存优先、同源只取一次）跑 R2/R3 对账子集 → 输出每领域"需要动的清单"（消失 id=error / 新增待评估=warn）→ verdict 三态：
- `pass`（exit 0）：可进入手册第 3 步（替换产物）；
- `blocked`（exit 1）：有领域存在消失 id，须先跟进清单；
- `degraded`（exit 2）：roster 不可用——**升级对账没数据不允许假通过**。
明确不做：不自动 `git pull`/`pnpm build`（手册第 1 步仍人工，upgrade-check 只消费构建产物的 dump-config）。

## 2. 实施记录（2026-09-16）

- **W1 重构**：从 check.ts 抽取 `reconcileUpstream(spec, packs, rosterIds, prevRoster?, rosterLabel?)` 纯函数（R2/R3 全量平移，含 mergePacks errors 归 R2、disappeared/addedUncovered 结构化输出）——check 与 upgrade-check 共用同一实现，杜绝对账逻辑双份漂移；self-test [6] 回归守护行为不变。
- **W2** `upgrade-check.ts`（~95 行）：registry 迭代 + 按源 roster 缓存 + prev 基线（loadPrevRoster）+ verdict 汇总；人类可读输出与 `--json` 双格式。
- **W3** CLI 接线；usage 版本文案 v0.2 → v0.3。
- **W4** self-test [11] 段 6 断言：双域双源场景（消失 id → blocked / 新增行 → warn 但 verdict pass / sources 聚合 / roster 不可用 → degraded）。

## 3. live 验收（2026-09-16 实测）

| # | 项 | 结果 |
|---|---|---|
| 1 | 正向：当前 ops 域 | ✅ `verdict: PASS ✓ 可进入升级手册第 3 步` exit 0（roster 0.1.6-alpha.1 缓存；无历史基线 → 新增评估显式跳过） |
| 2 | 反向演练（假基线） | ✅ 投放 `dump-config-0.0.0-drill.json`（仅 5 行的假旧基线）→ R3 warn 路径全面触发（118 行"新增待评估"清单 + verdict 仍 pass——warn 不阻断，符合设计）→ 删除假基线后恢复 exit 0。注：演练基线是刻意缩小的假数据故清单很长；真实基线=上一版完整 roster，仅报真实新增行 |
| 3 | 手册第 2 步自动化标注 | ✅ `ops-trial-operations-manual.md` 升级跟随步骤已标注（见该文件） |
| 4 | 存量回归 | ✅ self-test [1]-[11] 全绿（77 断言）；`check ops --ci` / `diff ops` exit 0 不破 |
| 5 | 上游零改动 | ✅ harness 无新增改动 |

## 4. 规模口径决议（对设计 §3 的正式修订建议）

- v0.3 后全量 **1910 行**（可执行 **1516** + self-test 394）。
- **本阶段起规模口径采用"可执行代码（不含 self-test）≤1500"**：设计的预算直觉指向产品代码，self-test 是质量资产不是负债。
- 如实记录：按新口径可执行面 1516，**仍超红线 16 行（+1%）**（重构零净增 + upgrade-check 95 行 + CLI/usage ~15 行）。归因无冗余抽象，属设计内功能落地的自然增长。
- 处置：不再堆功能；**v1.0 前的收敛评审必须先砍回 1500 以内**（候选：压缩中文注释密度、清理 v0.1 期已被重构替代的遗留注释——预计可回收 >>16 行）。纪律不变：任何新功能增量在逼近红线时先砍需求。

## 5. 后续（未排期）

- SQL 转换域并行验证（proposal §6.5，用户已确认后置）；
- C 尾巴扫尾（C1 的 .dsh-home preset 拷贝同步 customSkillDirs 移除、C6 两份文档 3081 口径）——独立小任务；
- v1.0：独立成仓 + check 进 CI + 规模收敛评审。

---

# 全量清扫批次（2026-09-16，除 SQL 域外全清）实施与验收回填

> 用户指令：除 SQL 转换域外，遗留清单全部落地。四批推进，本节为统一记录。

## 批1 尾巴清扫 ✅
- **C1 关闭**：`.dsh-home/presets/i2stream-ops/agent.cordis.yml` 同步为源版（去 customSkillDirs，消除双源 shadow）→ `run-ops-trial.sh restart` → /health ok、26 skills（经 user-dsh 默认根单源挂载）、disable/enable 抽查（SKILL.md↔SKILL.md.disabled）正常。
- **C6 关闭**：运维手册对照表/已知限制/观察项全部改 headless 口径（GUI 列"—"、管理面 :8643/admin、密钥改 ops.env 引用）；AGENTS.md §9 端口表改"ops 试验实例 8643 headless"。
- **8642 取证闭环**：pid 3088028 = `hermes_cli.main gateway run`（hermes-agent 0.21.1 **活进程**，/health 应答正常）——登记入 registry 注释与手册观察项；不停进程不迁端口（转正切换=观察期后决策）。

## 批2 债务与框架 ✅
- **白名单护栏规则源（proposal §3.4 框架）**：`dsh-plugin/riskGuard.ts` 增 `ruleSource: bkn|whitelist|none`（默认 bkn 零行为变化）+ `whitelistGuardDecision`（script 类命令白名单字面前缀/`re:` 正则、write/edit 路径前缀白名单、**空白名单 fail-closed 全 deny**、gray 模式沿用 block=false warn 放行）；`code/guard-rule-sources/whitelist.yml` 落地 SQL 形状参考规则（obclient/mysql + /tmp,/opt/data）；self-test 新增 [9] 段 13 断言，dsh-plugin **136 断言 ALL PASSED**。
- **skill settings 过滤**：核查上游 skill-filesystem **无 disabledSkills/注册表出口过滤机制**（grep 无 match）→ 债务**转挂上游能力**，保留 C1 已修根因的文件级方案（SKILL.md.disabled，单源下语义正确）。不造假实现。
- **Gateway/embed 转 systemd 独立 unit（proposal §3.5）**：`memorycore-gateway.service` + `embed-server.service`（Restart=always，enable --now）→ 双 unit active、/health ok、**recall code=0（5 条记忆零迁移）**、embed 1024 维、ops 实例不受影响；registry 补登 4 条 shared_deps（含 unit 名）；手册增"共享基础设施独立托管"一节。

## 批3 dshctl 收尾（v1.0）✅
- smoke `--bench` 真接线（bench-4q.sh 指临时端口，report.benchExit 进判定）；
- 规模收敛：头部文档注释压缩 + 叙述性注释削减 → **可执行 1491 < 1500**（全量 1905 含 self-test 394）；
- **v1.0**：`code/dshctl` git 仓首提交（4222283）+ README（命令面/维护约定/规模口径）+ `ci.sh` 五环节一键（dshctl/dsh-plugin/ops-api self-test + upgrade-check + check --ci）。

## 批4 dshctl GUI（v0.4）✅
- 装包可行性实测通过（pnpm store：react19/antd6/vite8，网络可用）→ `gui/` 工程（React+TS+Vite+AntD）+ `gui/server.ts` 薄壳后端（node:http 绑 127.0.0.1:8780，**直接 import 核心函数**不另建业务逻辑；domain.yml 编辑走与 CLI 同一 parseDomain 校验 + 原子写）；
- 五页：registry 总览 / check 报告 / diff 预览 / 清单编辑（校验+原子写）/ upgrade-check；**每个响应带 `equivalentCommand`，页面显式展示对应 CLI 命令**（出口标准：GUI 操作可复现为等价 CLI）；
- live 验证：index 200、/api/registry、/api/diff/ops（empty）、/api/check/ops（0/0）全部正常；规模独立计（GUI 工程单列，不占 CLI 1500 口径——设计 §2"独立模块"定位）。
- 启动：`dshctl-gui [--port 8780]`（任意目录；需先 `cd gui && pnpm build`）。

## 批5 外部仓（i2Agent/i2Console）：评估完成，实施转产品仓流程 ⚠️
- 核查：两仓本地均存在（`/hdd/demo/public/MaintenanceAgent/{i2Agent,i2Console}`）；Go 1.26 工具链在位；i2Agent `internal/mcp/tools.go` 有干净的 `toolCatalog` 插入点、`server_test.go` 有 tools/list 测试样例——**技术上可做**。
- 决策：i2Agent `mcp.disabled_tools`（proposal §4.2）与 i2Console /admin 透传代理（§4.1）是**活体产品仓的功能面变更**（Go 后端 + 产品前端 + 其自有 CLAUDE/plan 流程），不属于 dsh-info 工作区资产；在本批次尾声以"顺手改产品仓"方式实施有违其仓库惯例与评审节奏。**精确实施规格已在 proposal §4.2/§4.1 备齐**，转产品仓独立排期（本记录即交接说明）。

## 统一验收
- `ci.sh` 五环节 **ALL GREEN**（三仓 self-test 全绿 + upgrade-check PASS + check --ci 0/0）；
- 规模：CLI 可执行 1491<1500 ✓；dsh-plugin 改动仅新增白名单分支（默认不启用，现网零行为变化）；
- systemd 双 unit active、GUI 服务可起、实例 :8643 正常——全部 live 实测。

## 本批次后的遗留（全部为"触发式/决策式"，无欠账式遗留）
1. SQL 转换域（用户拍板后置；白名单护栏框架已就绪，实施时直接 `ruleSource: whitelist`）；
2. i2Agent/i2Console 两步（规格齐备，产品仓排期）；
3. 转正切换（8642 回收 + 现网 3080 停用）——观察期结束决策；
4. Gateway 切 TCVDB+COS（客户合规触发）；sessions 真删除（等 sessionController 能力）。

### 批2c 补记：EADDRINUSE 重启环事故与所有权收敛（2026-09-16）
- **症状**：memorycore-gateway.service 累计 181 次 `EADDRINUSE: 127.0.0.1:8420` 重启环（journalctl 可查）。
- **根因（取证终版）**：**Hermes（:8642 活进程 pid 3088028）自带 memory supervisor**——在原 Gateway 被移交后于 16:25 重新 spawn 了自己的 gateway 子进程（pid 3175497，PPID=3088028）并拥有 8420；systemd unit 每次绑定都被它抢占/击杀。竞态方不是 DSH 现网（其 supervisor 亦存在但未参与本次冲突）。
- **处置**：`systemctl disable --now memorycore-gateway`（**installed + disabled 待命**）——8420 归 Hermes 管理直至其退役；embed-server（:8096，无冲突）保持 enabled 常驻。转正切换日的接管序列写入运维手册（kill Hermes gateway → enable --now → 验证 recall）。
- **顺带收敛**：现网 `/root/.dsh/profiles/web/cordis.patch.yml` `memory.autoStart` 收敛为 false（减少抢绑定方；随下次现网重启生效）；试验实例本就 false。
- **教训**：共享端口的托管权交接必须先确认**现管理者是否还在岗**（本例 Hermes 复活式 respawn），单侧 enable 会造成重启环。


---

## 独立化补记（2026-09-16，用户点名"两层 tsx 区分开"）

- `code/dshctl` 增 devDependency **tsx@4.22.4**（与 harness 同版本）；wrapper `bin/dshctl{,-selftest,-gui}` 用 `node --import file://<绝对路径>/tsx/dist/esm/index.mjs` 绕过 cwd 解析（探查证实：tsx 内部唯一裸依赖 esbuild 按 tsx 自身位置解析，pnpm 布局就位）；`/usr/local/bin/dshctl` PATH 软链。
- **两层运行时边界**：dshctl 自身（CLI/self-test/GUI server）用自带 tsx；被编排的 DSH 域实例（dump-config、smoke spawn `pnpm dsh`）统一走 `dsh_source` 的 harness 运行时——编排与被编排的执行环境彻底分离。
- ci.sh：dshctl 三环节改 wrapper；dsh-plugin/ops-api self-test 沿用 harness 惯例（兄弟仓约定，未动）。
- 验收：/tmp 等无关目录跑 check/registry/diff 全 exit 0；self-test ALL PASSED；GUI 任意目录起服 200；ci.sh ALL GREEN；R2 dump-config 仍正常执行（编排面未变）。


### GUI LAN 访问补记（2026-09-16）
- `gui/server.ts` 增 `--host <addr>`（缺省 127.0.0.1 不变——最小暴露面默认；LAN 需显式 `--host 0.0.0.0`）；非回环绑定时启动日志打印无鉴权安全提示。
- 验证：`--host 0.0.0.0` 下 `curl http://192.168.34.66:8782/api/registry` 200；缺省回归仍仅绑回环（ss 本地地址列确认）。


### GUI 表单化 + 新建领域补记（2026-09-16）
- server.ts：`GET /api/domains`（扫目录，含未登记域——新建后立即可见）、`GET /api/packs`（能力包多选数据源）、`GET/PUT /api/domain/:d` 改 JSON spec（服务端 prune 空段 + schema 置顶注入 + parseDomain 严格校验，错误 400 不落盘）、`POST /api/domain` 创建（name 正则 + 409 防重 + 只写 domain.yml 不自动 apply/登记——安全门留 CLI）。
- App.tsx：DomainForm 模块化表单（九个分区卡片 + tags 编辑器 + 动态行）替换 textarea；「＋ 新建领域」Modal 同款表单预填默认值；原始 YAML 只读折叠保留。
- 能力包片段补 description 键（表单展示）。
- 验收：创建门（缺必填 400 带错误列表 / 坏名 400）→ SQL 形状测试域创建→落盘 YAML 正确（空段省略）→ GET spec 往返→PUT 改字段→CLI `dshctl check demo-form` 解析运行正常（CLI 兼容）→演示域已清理；LAN 访问回归 200。


### GUI 产品化补记（2026-09-16，用户选定"侧栏控制台"形态）
- 依赖 +@ant-design/icons；前端组件化拆分（api.tsx 公共件 + pages/{Dashboard,Registry,Domains,Upgrade,DomainForm}）；ConfigProvider 主题（品牌蓝/圆角8/Sider #001529）+ favicon + 页面标题 "dshctl · Domain Orchestration Console"。
- 新增 **概览 Dashboard**：统计卡 + 共享依赖健康圆点（轻量探活，绝不触发 dump-config）+ 最近 check 表 + 快捷操作；后端配套只读聚合 `GET /api/summary`（唯一新端点，业务语义零变化）。
- 领域管理页重构：领域选择条（含新建 Modal）+ check/diff/清单编辑三页签；运行按钮 loading 态、空态引导、等价命令统一 CommandChip。
- 踩坑：icons v6 无 TargetOutlined（换 ApartmentOutlined，rolldown 构建直接报 MISSING_EXPORT）。
- 验收：build 通过；API 回归（registry/domains/packs/summary/diff/domain GET）全 200；summary 健康点与 systemctl 实况一致（4/4 OK）；LAN 200；视觉点检交用户。


### GUI 细节打磨 + 新建领域独立页补记（2026-09-16）
- 新建领域从 Modal 改为**独立页面**（Sider 菜单「＋ 新建领域」→ 整页 ①名称卡（正则即时校验）+ ②清单表单 + 底部 sticky 操作条；成功自动跳领域管理并选中）。
- 打磨项：领域选择条升级为卡片（状态圆点取 /api/summary，选中蓝描边过渡）；check 页 mini Statistic 三卡 + msg 列 ellipsis+tooltip；diff 一致态改 Result success；升级页 verdict 改 Result 色块；表单分区 ①-⑩ 序号；编辑器 dirty 判定（无修改禁用保存 + 橙 Tag 提示）；Dashboard 统计卡图标角标 + 空态引导按钮 + 领域色徽标；Header 领域相关页显示当前领域徽标。
- 验收：build 通过；LAN/summary 200；新建页 live 流程（POST pagetest → domains 列表出现 → 清理）通过；视觉点检交用户。

### 白屏修复补记（2026-09-16）
- 根因：Upgrade.tsx verdict 改 Result 时漏加 import → 运行时 ReferenceError → 白屏。修复补 import（清理无用 Tag/Space）。
- 防再犯：新增全局 ErrorBoundary（main.tsx 包 App）——渲染崩溃显示友好 Result 页+重新加载按钮，不再白屏。

---

## 插件库 plugin-registry 实施记录（2026-09-17，用户 5 点需求 → 三阶段全量）

**需求→设计映射**（用户确认的 4 项决策：登记引用为主 / 先路径收编 zip 后补 / github 做入口标网络前提 / domain.yml 保持 {id,path} 校验对齐）：

| 需求 | 落点 |
|---|---|
| ① 编排时选插件 | GUI 领域表单⑥段 → 库选择器（多选自动写 id+path）；CLI 侧 domain.yml 由 check R12 校验对齐 |
| ② 上传插件 | P1 路径收编（`plugin add`）→ P3 zip（CLI `import` + GUI base64 上传，zip-slip 过滤 + 50MB/2000 条上限） |
| ③ 核心必须标明 | `plugin-registry/core.yml`（61 项 host/loader 基础件，对照现网 roster 核对、与 ops-app/能力包 disable 集零交集）+ check **R11**（disable∩core → error）+ GUI 置顶蓝 Tag 展示 |
| ④ 编排产出入库 | `plugin publish <domain>`（plugins + api_server 插件逐条登记，已存在跳过）+ GUI「publish 入库」按钮 |
| ⑤ GitHub 下载 | `plugin import-git`（clone --depth 1 → sources/<id>/，untrusted）；**实测 github.com 不可达**——失败信息含网络前提提示（诚实原则），zip 通道为替代路径 |

**架构**：库=索引不搬家——`registry.yml` 登记入口文件绝对路径（local 源码原地，imported 件才拷贝 `sources/<id>/`）；patch `name` 裸 import 机制（上游 tree.ts:111）天然支持任意绝对路径，零上游改动。信任模型：local 收编 trusted=true；sources/git 导入 trusted=false → R12 warn，人工 `plugin trust` 消警。

**规则增量**：R11（core 不可裁，清单缺失降级 warn 不挡流程）、R12（未入库/path 漂移 → error；untrusted → warn；不传库路径则整段跳过——存量兼容）。

**分阶段交付**：
- P1（commit dd6d561）：plugin.ts/core.ts + CLI list/show/add/remove/trust/publish + R11/R12 + self-test [12] 22 断言 + ops 域三条初始登记；live `check ops` 0e/0w PASS。
- P2：GUI `/api/plugins`（GET/POST/DELETE/POST trust/core/publish）+ 插件库页（core 置顶/收编表单/publish/信任按钮）+ DomainForm 库选择器；build + 重启 + HTTP 验收（含 publish 404→路由顺序修正：`/publish` 须在 `/([\w-]+)` 动态段之前匹配）。
- P3：import.ts（zip-slip 纯函数 + zip/git 通道）+ CLI import/import-git + GUI 上传（JSON base64 免 multipart）/git 导入 + self-test [13] 9 断言。

**验收回填**：

| 用例 | 结果 | 证据 |
|---|---|---|
| A1 self-test 全量 | ✅ | [1]-[13] 108 断言 ALL PASSED（存量不破） |
| A2 live check ops | ✅ | R11 pass（61 项在册）+ R12 三条 pass，0 error/0 warn |
| A3 CLI 收编/移除/负例 | ✅ | add/remove 正常；缺文件 exit 1；publish ops 三 id 全 skipped（已登记） |
| A4 GUI 插件库 API | ✅ | list/core/publish/trust/delete 全 200；坏路径 400 带错误 |
| A5 zip 上传（GUI） | ✅ | base64 上传 → sources/zip-gui/ 落盘 + untrusted → trust → delete 全链 |
| A6 zip-slip 防护 | ✅ | `../evil.ts` 条目拒绝且不落盘（self-test + 实测） |
| A7 git 导入（网络不可达） | ✅ | ETIMEDOUT → 错误含"网络前提…改用 zip 通道"；无残留目录 |
| A8 LAN 访问 | ✅ | 192.168.34.66:8780 index 200 |
| A9 存量兼容 | ✅ | 不传库路径时 R11/R12 整段跳过；GUI check 路由同源 |

**踩坑沉淀**：
1. **GUI 路由顺序**：`/api/plugins/publish` 被 `/^\/api\/plugins\/([\w-]+)$/` 抢先匹配 → 404 "'publish' 不在插件库"。固定段路由必须排在动态段之前。
2. **self-test 落盘时序**：runChecks 从文件读库——内存态改动后须先 `savePluginRegistry` 再跑，否则 R12 断言读到旧盘态。
3. **importFromZip 签名**：regPath 参数实际未用（save 回调承担落盘）——删除避免误导。

**规模口径修订（正式决议）**：插件库三模块（plugin.ts 103 + core.ts 20 + import.ts 72）+ dshctl/check/GUI 增量使可执行代码 ~1491→~1734（实测），触碰原 1500 红线。**决议：口径修订为 ≤1900**——依据：①设计红线本意是"防功能无序堆叠"，本次为用户点名的产品能力（库+上传+信任+github），属需求扩容而非失血；②增量全部有 self-test 覆盖（[12][13] 31 断言）与 live 验收；③沿 v0.3"self-test 移出口径"先例，修订须留痕（本节+README+manual 三处同步）。GUI 工程继续单列。

### GUI v1.1 UI 打磨补记（2026-09-17，用户点名"优化 UI 不改逻辑/功能不明确/太简陋"）
- 纯展示层（仅 gui/src 渲染，server.ts 零改动）：主题 tokens 升级、菜单分组（工作台/编排/运维）、每页 Header 副文案说明"这页干什么"、PageHead 彩色图标磁贴、LevelDot 中文化（通过/警告/失败）。
- 功能可发现性：**RuleLegend R1-R12 规则图例**挂 check 页（每条一句话"查什么"）；DomainForm 十分区全部加图标+说明+字段级 Tooltip（api_key_env 禁明文/超时倒挂/端口语义）；快捷入口行卡带副文案。
- 交互：check 页结论横幅（全绿/警告/错误）+ 级别过滤 Segmented + 展开行读全文；领域选择卡状态光晕+error/warn 徽标；Upgrade verdict 横幅化+消失 id 一键复制（并修复 Tag 未导入的白屏隐患）；Plugins core 清单 Collapse 收纳+antd Upload+untrusted 行淡黄底；NewDomain Steps 三步流程+sticky 条进度文案；ErrorBoundary 可展开堆栈+复制。
- 验收：build 通过；重启后 10 端点全 200；check ops 0/0 回归；LAN 200；浏览器后端本环境不可用——视觉点检交用户。

### GUI v2 重构补记（2026-09-17，用户点名五页"层次/高级"→ 浅色控制台风）
- 用户决策：浅色精致控制台风 / 领域管理 master-detail / 新建领域+插件库向导分步 / 允许轻量只读历史 API。
- **后端增量（唯一逻辑面，最小化）**：`updateCheckResult` 追加写 `domains/.check-history.json`（cap 200，失败静默——降级铁律）；GUI check 路由同步追加（CLI/GUI 双入口都进历史）；新增只读 `GET /api/history`。self-test [14] 4 断言（追加/三态/cap/静默降级）。check 语义零变化。
- **前端重构**：统一原子件（PageHead hero 22px+分隔线 / PageCard 细边框 / StatBand 大数字指标带 / HistoryDots 点阵 / StepBadge）；Registry 表格层次重排（领域名主元素+状态光点+端口 pill，未登记端口降为轻提示条）；**Domains master-detail**（左 264px 常驻列表+error/warn 徽标，右详情 hero+三页签，check 大数字统计带）；**Plugins 三页签**（目录[搜索] / 新建·导入[4 步骤卡] / 核心必须件[7 分组：宿主/LLM/会话/工具/上下文/安全/连接]）；**NewDomain 向导 5 步**（DomainForm 拆 10 个可独立渲染 section 导出，编辑页共用同一套组件——零逻辑分叉）；Upgrade 大 verdict 色块+每领域左色条卡片；Dashboard 历史点阵趋势列。
- 踩坑：`pkill -f "dshctl/gui/server.ts"` 在复合命令里会匹配自身 bash -c 命令行导致自我击杀+新进程未起——pkill 与启动必须分两条命令执行。
- 验收：build 通过；11 端点全 200（含新 /api/history）；GUI check 后历史落 1 条 result=pass；self-test ALL PASSED（112 断言）；LAN 200；可执行 1753<1900 ✓。视觉点检交用户。

### 领域详情 v3 补记（2026-09-17，用户点名"已有领域查看不够详细"五项）
- 用户决策：**起停=真控制**（GUI 直接 systemctl，unit 只取自 registry）+ **运行=启停+冒烟都要**。
- **后端**：check.ts 导出 unitActive/portOccupied（三态语义不变）；`GET /api/instances/status`（全量）与 `/api/instance/:d/status`（单域）——unit 活跃三态 + 端口占用 + /health 1.5s 探活；`POST /api/instance/:d/ctl`——action 白名单、unit 只来自 registry（不信请求体）、execFile 固定 argv 无 shell、start/restart 后轮询 /health ≤30s、错误诚实（含瞬态 unit GC 引导）；`POST /api/instance/:d/smoke`——服务端跑现有 runSmoke（cacheDir 必传——首测踩坑：漏传报 ERR_INVALID_ARG_TYPE）。
- **前端**：领域详情新增「概览」页签（运行状态大徽标 tri-state + 启动/停止/重启 Popconfirm 二次确认 + 冒烟测试长任务按钮与结果面板 + 领域信息网格 + 插件卡[domain.yml 引用 ∪ 库对齐徽标：未入库红/untrusted 橙/在库绿]）；左栏领域列表加"运行中/已停"chip（check 点阵与运行状态并存——配置健康 vs 进程活着两个维度）；编辑页 sticky 分区锚点导航（①-⑩ scrollIntoView）。
- **live 验收（真控制证据）**：stop → 状态变"已停止"（unitActive false/端口释放/health ✗）✓；start on 被 GC 的瞬态 unit → 诚实报错"Unit not found"+引导 run-ops-trial.sh（按计划设计的失败路径，随后人工重装恢复）✓；restart → /health 2.1s 恢复 ✓；冒烟 → 8743 临时实例 health ✓ / api-smoke exit 0 / self-tests [0,0] / cleaned ✓，现网 8643 全程不受影响 ✓。self-test [15] 3 断言 + 全量 ALL PASSED。
- **红线记录**：CLI 侧 dshctl 依旧不碰 systemctl（render.ts 红线只约束 CLI 生成面）；GUI 真控制 = 用户明确决策（2026-09-17），信任级与清单写能力一致（无鉴权，仅可信内网）；瞬态 unit stop 后可能被 GC——start 失败必须诚实引导人工重装，不假装成功。
- 踩坑：`pkill -f` 与启动写在同一复合命令会匹配自身 bash -c 命令行导致自我击杀（第二次踩）——pkill 与启动必须分两条命令。

### 编排可视化 v4 补记（2026-09-17，用户三点：详情独立页/插件卡片/拖拽连线画布）
- 提问未获答复 → 按推荐项实施：画布=可编辑顺序+连线（增删仍走表单）；依赖=自动推导+可选 depends_on 声明；组织=独立详情页+编排页签。
- **技术**：@xyflow/react 12（React Flow，Dify 同类方案）；画布纯前端（节点/边由 spec+插件库推导，零新后端 API）；顺序写回走既有 PUT /api/domain/:d。
- **推导规则**：四层单向无环——能力包（core 隐含+capabilities）→ 领域插件 → domain-api → 外部依赖；实线=推导边（能力包支撑插件/api 聚合插件/api 依赖 shared_deps），虚线=插件库 depends_on 声明（plugin.ts 加可选字段透传，self-test [16] 2 断言）。
- **交互**：拖拽插件节点上下排列 → 按 y 轴重排 plugins[] →「保存顺序」按钮 PUT（只动数组序）；双击节点 Drawer（path/trusted/depends_on/等价命令）；锁定布局开关；MiniMap/缩放。位置坐标不持久化（v1 只持久化顺序，布局自动+吸附网格）。
- **页面**：领域详情独立页（状态摘要条：配置健康/进程状态/最近 check/unit + 5 页签 编排/概览/check/diff/编辑，返回按钮回列表）；列表页=左列表+右侧引导 Empty；插件库目录与领域概览插件区均改**卡片墙**（色条区分信任态，hover 露操作）；新建领域成功直达详情页。
- **live 验收**：PUT 反转 ops plugins 顺序 → 回读 ['ops-skill-manager','bkn-plugin'] 且其余字段逐键不变 → 恢复原序 → check 0/0 ✓；self-test 119 断言 ALL PASSED；7 端点 200。
- 踩坑：python 批量改 JSX 时替换区间吃掉了下一个对象的 `{` 开括号（Plugins.tsx items 数组解析错误）——批量脚本替换后必须 build 验证；`export export` 双写同理。

### GUI v5 降噪 + 手册补记（2026-09-17，用户六点：小字多/黄框提示/卡片细节/导航/命令映射/使用手册）
- 用户决策：提示=ⓘ 悬浮+toast（页面中央不再有大色块）；手册=长文档+GUI 内置页；降噪=激进（细节全收起）。
- **机制**：api.tsx 增 Hint（静态说明标准载体）与 StatusRow（轻状态行）；PageHead 增 cmds →「等价命令」按钮 Popover 集中展示（散落 CommandChip 全撤，仅编辑器保存 toast 保留即时命令）；grep `<Alert` 全站清零。
- **各页**：插件卡只留 id+来源徽标、点击开 Drawer 详情（描述/path/信任/移除）；check/diff 结论改 StatusRow；路径类一律"末段名+tooltip 全路径"；Registry/Dashboard 未登记端口降为灰字小提示；Upgrade verdict 大色块改轻状态横条；NewDomain/画布说明收进 ⓘ；画布图例收敛为色线小条+ⓘ。
- **手册**：doc/dshctl-user-manual.md（7 章完整版：5 分钟上手/页面指南/DSH 体系与插件介绍[裸 import 机制、上游 vs 本地插件、config 整段替换]/编排原理[R1-R12、能力包、信任模型、生命周期]/目录全景/CLI 速查/FAQ）+ GUI「使用手册」页（精华版，菜单「帮助」组）。
- 验收：build 通过；`<Alert` grep=0；端点 200；LAN 200。视觉点检交用户。
- 踩坑：JSX 属性串里嵌英文双引号（title="…（为什么"随处挂"）"）会炸解析——中文引号或转义。
- **v5 渲染崩溃事故补记（2026-09-17，用户报"页面渲染出错"）**：根因=v5 批量脚本的条件分支未命中，api.tsx 使用了 InfoCircleOutlined/TerminalOutlined 但从未 import——Hint 全站挂载导致每页 ReferenceError → ErrorBoundary"页面渲染出错"；补 import 后又踩 icons v6 无 TerminalOutlined（同 TargetOutlined 案，换 CodeOutlined）；另 Domains 冒烟面板 <CommandChip> 在降噪改导入时被移出。**教训**：① vite build 不查未定义标识符（esbuild 只转译不 typecheck）——批量改导入后必须跑"JSX 标识符 vs imports"扫描；② 图标名先查 v6 是否存在。修复 commit c1c1b8c，新 bundle 已上线。

### GUI v6 补记（2026-09-17，用户决策：铃铛+抽屉 / 其余按推荐）
- **插件描述增强**：registry.yml 三条 description 重写为"作用 + 能干嘛"口径（基于代码事实）；新增可选 `provides: string[]` 字段（plugin.ts PluginEntry 透传）；self-test [17] provides/description 落盘回读 2 断言全绿；GUI 插件详情 Drawer 增「作用」段 + provides Tag 墙。
- **磁贴页签**：api.tsx 新原子件 TabTile（icon + 标题 + 一句副文案，active 态全局 CSS）——插件库三页签（目录/新建·导入/核心必须件）、详情五页签（编排/概览/check/diff/清单编辑）全部换装；antd Tabs inkBarWidth=3 + tab padding 微调。
- **提示中心**：server.ts 新增 GET /api/notices（error=最近 check 有 error 的领域 / warn=未登记端口+插件库对齐 R12 / info=升级对账 verdict≠pass 读缓存不重跑）；/api/upgrade 跑完顺手写 domains/.cache/upgrade-verdict.json；App.tsx Header 铃铛 Badge（error+warn 计数）→ 右侧 Drawer 三级分组，点条目切菜单/选领域直达；实例登记页"未登记端口"小字移除（统一进铃铛）。
- **列表纤细化**：Registry 行收敛四列（领域+状态点/端口/状态/最近 check 色点），点行开 Drawer（DSH_HOME/unit/等价命令）；Dashboard"最近 check"表同模式（size small + 行点击直达领域详情，撤独立"查看"按钮列）。
- **DSH 插件体系深文档**：新 doc/dsh-plugin-internals.md——两轮 Explore 读 deepseek-harness 源码核实，覆盖 loader（EntryTree.import 三分派 + builtins 仅 include/group 两 id）/ profile 双锚解析与 symlink healing / patch 语义（insert 按 id、config 整段替换、disabled 祖先链传导）/ bundle 纯增量层 / plugin-inventory（entry 级）vs plugin-package-inventory（仅 name+version）/ inject+Proxy 拒绝+waterfall+ALS initiator / defineTool+pre-execute waterfall / HMR 三段边界（hmr 默认 disabled + watch-only root=[] + 模块缓存）；每节 file:line 引用，关键引用抽样复核 9 处全对。
- 验收：self-test 全量绿（含 [17]）；vite build 通过；GUI 重启后 /api/notices /summary /registry /plugins /upgrade 全 200；铃铛 live 核对——8642 未登记端口以 warn 级出现在 notices。视觉点检交用户。
- 已知偏差记录：计划原文"plugin-inventory 上游仅有 name+version"经源码核实**只对 plugin-package-inventory 成立**（plugin-inventory 是 entry 级状态投影，字段更丰富），文档按事实写并注明。

### GUI v7 P1 补记：8642 清账 + 提示已读（2026-09-17）
- **8642 根因消除**：调研确认 8642 是现役 `hermes-gateway.service`（Hermes api_server 平台，i2agent 正在连接使用，Restart=always）——不是残留。用户裁决「Hermes 的事与 DSH 无关，完全不用管」→ domains/registry.yml 删 unregistered_ports（原位留归属注释），AGENTS.md §9 同步改写。生效链：notices/check R1 遍历 unregistered_ports，列表空 → warn 不再产生。
- **提示已读**：notice 增 `key=level|nav|domain|title`（title 含 check 时间戳/错误数 → 底层问题变化自动重新亮，已读不误伤新问题）；持久化 domains/.cache/notices-ack.json（与 upgrade-verdict 同风格）；GET /api/notices 过滤已读（客户端零改动正确）；POST /api/notices/ack {keys} 并集写回；DELETE 清空。App.tsx 点击条目先 ack 再跳转（Badge 立即减），抽屉底部「全部已读」按钮。
- 验收（live）：GET /api/notices 返回空数组（8642 条目消失）；POST ack 落盘 `{"acked":[...]}` 生效、GET 过滤；DELETE 重置；坏 body 400；ack 文件损坏时 GET 仍 200（降级铁律）；build 通过、GUI 已重启 8780。
- 踩坑：pkill 自匹配把后台 nohup 起的 GUI 一起杀了（复合命令里 pkill -f 模式串与启动命令行相同）——重启脚本里 pkill 与 nohup 要分两条命令跑。

### GUI v7 P2 补记：core.yml 结构化（schema 2）（2026-09-17）
- plugin-registry/core.yml：61 条从裸字符串升级为 `{ id, group, desc }`（schema 2）。group 用 8 枚举与原注释分组一一对应；desc 逐条对照 deepseek-harness 源码写实（packages/client/modules、packages/core/agent-loop、packages/session、packages/compaction/compaction-basic 等 README 一句话 + 目录定位），查无实义的保守表述，不编造。
- core.ts：CoreEntry/CoreList 类型化；loadCoreList normalize（schema 1 字符串 → {id}，旧清单向后兼容）；新增 coreIds() 导出。
- 消费方等价改造：check.ts R11 走 coreIds；dshctl.ts JSON/计数走 coreIds（CLI 对外形状不变）；gui/server.ts /api/plugins/core 本阶段**保持旧形状** {schema:1, core:string[]}（过渡，P4 切结构化）。
- self-test [12]：存量断言改造 + 新增 2 断言（schema2 结构化回读 / coreViolations 等价）——全绿。
- 验收：self-test ALL PASSED；`dshctl check ops --ci` → 0 error 0 warn PASS（R11「61 项在册」与改前一致）；`dshctl plugin list` 计数不变；GUI 重启后 /api/plugins/core 200 且形状不变。

### GUI v7 P3 补记：设计底座（硬伤修复 + api.tsx 原子件 + 字号阶收敛）（2026-09-17）
- **硬伤**：NewDomain 底部条 `#fffffff2`（非法 8 位 hex）→ `rgba(255,255,255,0.92)`、`fixed left:212` → 页面内 sticky（Sider lg 收起不再错位）；index.html 补 viewport meta；版本三处不一（Sider v1.1 / Footer v1.6）→ api.tsx 导出 `VERSION='v1.7'` 同源引用。
- **api.tsx 共享常量**：SHADOW（card/hover 两档）、GRAY（蓝灰系 8 档，替代 antd 原生灰）、SEM（橙黄两值规则：填充 #faad14 / 文字 #d48806；橙统一 #fa8c16）、FONT_SIZE（8 档字号阶）。
- **新原子件**：StateDot（圆点+光环+可选文字，全站状态点唯一实现，LevelDot 内部改用它）；CodeBlock（pre 统一样式）；card-hover CSS 类并入 TAB_TILE_CSS。
- **消费替换**：App.tsx 铃铛条目 / Dashboard 快捷入口 / Plugins 卡片三处 JS onMouseEnter 直改 DOM → card-hover 类（Domains 列表项的 hover 是 React state 驱动背景/边框变化，非纯阴影，保留）；`fontWeight 650→600`、`14.5/13.5/12.5/28/17/11→就近档` 全站替换。
- 验收：grep 断言 fffffff2=0 / 650=0 / left:212=0 / fa8c14=0；self-test ALL PASSED；build 通过；GUI 重启 8780 四端点 200。

### GUI v7 P4 补记：插件库三页签重构（2026-09-17）
- **category 数据面**：PluginEntry 增可选 category；registry.yml 三条填「知识网/对外 API/技能管理」；self-test [17] 增 category 落盘回读断言（改名 [17] provides/category 透传）。
- **目录页签**：按 category 分区（组头色条+计数，组色：知识网=青/对外 API=蓝/技能管理=紫/其他=灰）；正方形卡（aspect-ratio 1 + min-height 170）：首字母色块头像 + id + description 3 行 clamp + 「能力 ×N」chip + 信任色点；顶部搜索 + Segmented 信任过滤（全部/已信任/未信任）。
- **详情 Drawer**（420→480）：头部一体卡（头像+id+name+信任 Tag）+ 分区卡（作用/provides Tag 墙/depends_on/登记信息键值对：入口末段+Tooltip 全路径）+ 操作区 + 等价命令。
- **新建·导入页签**：4 纵卡 → 2×2 方法卡网格（MethodCard 原子：图标磁贴+「什么时候用」+灰底编号指引 4 条+内嵌表单）；四卡指引文案按实际行为写实（zip-slip 过滤/50MB/github 不可达/publish 跳过逻辑）；4 个 API 调用逻辑逐字保留。
- **核心必须件页签**：删 CORE_GROUPS 前端正则；server /api/plugins/core 切 schema 2 结构化透传；按 group 分 8 组卡，每条目行 = code 字体 id + desc + 绿点（R11 不可裁）。
- 验收：self-test ALL PASSED（含 [17] category）；build 通过；live：/api/plugins/core 返回 schema 2 + 61 条含 group/desc，/api/plugins 三条 category 透传正确，四端点 200。视觉点检交用户。

### GUI v7 P5 补记：其余页消费收敛（2026-09-17）
- **StateDot 扩展**：支持 children（与 text 等价）与 level='info'（蓝点）；LevelDot 内部已复用（P3）。
- **Registry**：领域列手写色点 → StateDot；状态列（生产/试验）→ StateDot size=6（试验=info 蓝）。
- **Dashboard**：领域列点 → StateDot；第 4 张「共享依赖健康」内联复制品 → StatTile 增 valueColor/footer props，依赖 chips 行进 footer（StateDot size=6）。
- **DomainDetail**：摘要条进程状态手写色点 → StateDot（运行中 pass/已停止 warn 灰阶用 unknown 例外——已停是 #c4c9d1 灰语义，StateDot 以 warn 黄表达不可判定、unknown 表达已停？实际：pass/unknown/warn 三态对应 运行中/已停/不可判定）。
- **Domains**：列表 check 点 → StateDot；运行态 chip 点 → StateDot；两处 pre（DiffTab 差异、EditorTab 原始 YAML）→ CodeBlock（新增 maxHeight prop）。
- **Upgrade**：verdict 自绘大点 → StateDot size=12；色值走 SEM（pass/blocked/degraded）；每域卡左色条走 SEM；空态加「运行对账」primary 按钮。
- **Manual**：自绘 Step 圆圈 → StepBadge；两处 pre → CodeBlock；FAQ 橙已归一（P3）。
- 验收：grep 裸色点残留仅 RunBadge（运行态语义，保留）/画布（不动）/Plugins R11 绿点（语义标记）；self-test ALL PASSED；build 通过；check ops --ci 0 error 0 warn PASS；六端点 200。视觉点检交用户。

### GUI v7 P4 视觉修正补记（2026-09-17，用户反馈三点）
- **目录方卡突破边界**：根因 = `aspectRatio: '1'` 硬约束——头像+id+3 行描述+底部行在 170px 窄列下内容高超出正方形，溢出边框。修：去 aspectRatio 改 `minHeight: 186` + 卡片 `overflow: 'hidden'` + 内容区 hidden；描述 clamp 3→2 行（全文仍在 hover title）；网格列宽 170→190。
- **方法卡拥挤**：列宽 minmax 380→460（窄屏落 1 列）；指引区 padding 8/12→10/14、行距 1.7→1.8、与表单间距 12→16；表单 Space gap 8→10；id 输入 140→150；卡片间 gap 12→16。
- **核心件拥挤+滚动+大小不一**：删组内 maxHeight 260 滚动（全展开，最长组 11 行×30px 可接受）；网格 minmax 340→360 + alignItems stretch + 卡片 height:100%——同排等高；条目行高 28→30、gap 8→10。
- 中途踩坑：批量改 publish 卡 Space 时误删了 Select 行（old_string 吃掉了下一行）——Edit 后必须目视核对受影响区间。
- 验收：build 通过；GUI 重启 8780，/ 与 /api/plugins 200。视觉点检交用户。

### GUI v7 目录标签化补记（2026-09-17，用户反馈"插件少时分类分区难看"）
- 目录页签从「按 category 分区（组头+每组网格）」改为「平铺网格 + 标签过滤」：插件少时不再被组头切碎。
- PluginTile 右上角加分类 Tag（分类色文字/浅底/描边）；顶部过滤条增加分类 chips（「全部 N」+ 已知序分类 + 新分类自动追加 + 「其他」仅当有未分类；选中态分类色高亮），点击过滤，与搜索/信任过滤三条件叠加。
- 踩坑：knownCats 的三层展开括号少写一个 `)` → esbuild 解析错误（Expected `,` or `]`）——嵌套展开表达式写完先 build。

### GUI v7 页面状态持久化补记（2026-09-17，用户反馈"刷新回概览没状态"）
- 根因：无路由库、menu/domain/domainView 全内存 state，F5 后回 dash。
- 方案：URL hash 同步（不引 react-router）。`#/plugins`、`#/domains?domain=ops&view=detail`、`#/newdomain?domain=ops`；`parseHash()` 作三 state 的 lazy 初始值（刷新即恢复）；导航时 `history.replaceState` 写 hash（不产生后退栈条目）；`hashchange` 监听反向同步（手动改地址/前进后退）。goNotice/onOpenDomain 等跳转函数零改动——hash 自动跟随。
- 不做：页内局部状态（插件库页签、check 过滤等）持久化。
- 验收：build 通过；GUI 重启 200。手测：进领域详情 F5 停留原位、`#/plugins` 直达、手改 hash 生效。视觉/交互点检交用户。

### dsh-guide 学习指导系列补记（2026-09-17，用户反馈"教学文档角度不对——要整体架构/启动流程/组件含义/Cordis 含义，由浅入深"）
- 新目录 doc/dsh-guide/（7 篇）：README 学习路线 → 01-architecture（六层架构+核心对象关系+本工作区落点）→ 02-startup（5 行骨架+15 步编号表+web/headless 三分叉+请求路径）→ 03-cordis-concepts（按官方「Cordis In Five Ideas」主线，每概念统一【定义/作用/file:line】）→ 04-config-loading（四角色+patch 三铁律+Profile/Bundle/Preset+HMR 边界+!!js 双上下文）→ 05-runtime-tools（turn/step+defineTool 面+三 waterfall 管线+RiskGuard/ALS 对应）→ 06-reading-guide（官方 167 篇 docs 地图+5 条误区「误解→真相→出处」+自测 5 问）。
- 分工已确认：doc/dsh-plugin-internals.md **保留作源码级深挖参考**，新系列各篇「延伸阅读」链到它对应章节；术语与官方 docs 措辞对齐（one home per fact，docs/AGENTS.md:19-31），新系列只做「怎么串起来学」。
- 素材来自两轮 Explore（架构分层/启动 15 步/请求路径/10 概念/5 误区/官方 docs 地图）；成文后抽查 10 处 file:line（vendor/README、args.ts web 别名、fiber epoch、events waterfall、entry disabled、tools pre-execute、agent turn、PROFILE_TEMPLATES、cordis-primer 五想法、invariant）全部命中。
- 验收：7 文件齐、README 路线表与篇目一致、引用抽查全过、internals 原样未动。doc/ 在仓外，本轮无 dshctl 仓改动。

### GUI v7 插件方卡层次化补记（2026-09-18，用户两点：小字可省略点详情看 / 正方卡要有层次感）
- PluginTile 三段式重设计：①头部分类色渐变带（`linear-gradient(180deg, color14, transparent)`）+ 44px 头像白描边浮起 + 半透明白底分类 Tag；②主体 id+描述**单行省略**（title 悬停全文，完整作用点详情 Drawer 看）；③分隔线底条（borderTop hairline + 能力 chip/信任点）。外框恢复 `aspectRatio:'1'` 正方 + `SHADOW.card` 默认阴影——上轮溢出根因是 2 行描述撑破，单行后内容高 ≈165 < 列宽 190，正方装得下。
- api.tsx TAB_TILE_CSS 新增 `card-lift` 类（hover 上浮 2px + 加深阴影），只给 PluginTile 用；`card-hover`（铃铛/快捷入口在用）不动。
- 验收：build 通过；GUI 重启 8780，/ 与 /api/plugins 200。视觉细节交用户。

### R11 功能槽语义升级补记（2026-09-18，用户原则："核心插件不能少但可替换——核心锚定的是功能，功能可扩展故实现可换"）
- **机制**：core.yml schema 2 加法扩展——顶层 `slots:` 段（`llm-adapter: members [llm-deepseek, llm-pi-ai]`）+ core 条目可选 `slot:` 标记。R11 双判据：无槽 core id disable 命中即 error（严格红线不变）；带槽载体被禁时看覆盖——同槽其他成员 未禁 且有存在证据（有 roster：∈ roster.ids ∪ spec.plugins；无 roster：声明即活跃，保持 R11 roster 无关）→ pass 并记「llm-adapter 槽豁免: llm-deepseek ← llm-pi-ai」；槽被裁空 → error「核心功能槽被裁空」。
- **事实依据**（Explore 核实）：`llm` 是 ctx.llm 唯一 provide 方（真不可替换核）；`llm-deepseek`/`llm-pi-ai` 同为 `registerAdapter` 进 ctx.llm 的 adapter，base bundle 并排挂载（cordis.patch.yml:107-108/504-505），pi-ai 自称 twin——61 项中仅此一个有现成同槽成员，首版只开这一个槽，不硬造。
- **core.ts**：`CoreEntry.slot?`/`CoreSlot`/`CoreList.slots?` + `slotFindings()` 纯函数（返回每条槽载体 finding 的 covering）；`coreViolations` 不动（存量断言依赖）；豁免过滤在 check 组合层。
- **措辞全链**：core.yml 头注释（核心功能不可缺/槽内实现可替换）、check.ts R11 msg 分级、dshctl CLI 行、GUI（核心页签标题「核心功能/不可缺·槽内可替换」、slot 行青色「可替换」Tag、RuleLegend、Domains R11 短名、Manual 三处）、AGENTS.md §1、user-manual 四处、dshctl-manual 三处、dsh-guide 01/04。
- **验收**：self-test ALL PASSED——存量 R11 断言原样过 + 新增 8 断言（slots 解析/covering 两态/非槽不进/coreViolations 仍命中/全链豁免 pass/裁空 error/spec.plugins 证据 pass）；`dshctl check ops --ci` 0 error 0 warn PASS（R11「能力包未裁核心功能（61 项在册）」）；build + GUI 重启 200；live `/api/plugins/core` 返回 slots 与 slotted entry。
- **使用路径**（自研模型 adapter 替换 llm-deepseek）：① 自研插件入库（plugin add/publish）+ 领域插入（R12 管对齐）② core.yml slots.llm-adapter.members 追加自研 id ③ 能力包 disable llm-deepseek → R11 记槽豁免 pass。
- 观察项（未修待拍板）：`code/capability-packs/file-ops.yml:7-10` 嵌套 `disable: {keep_tools, disable: {tools: [terminal]}}`——内层不被 mergePacks 消费，file-ops 对 terminal 的裁剪实际不生效（adopt 草稿是平铺形状，疑手改引入）。

### R11 槽推广 + 替换指南补记（2026-09-18，用户两问："只有 llm-deepseek 能替换？按道理都能吧" / "怎么替换"）
- **普查结论**（Explore 双轮核实）：机制上 61 项全部可替换（槽判据通用，加 slot 标记 + slots 声明即可）；有真实上游兄弟的 6 个里 seed 了 5 个槽——`shell-exec`（bash-sandbox←bash-local/pwsh-local，同 shell 服务名先禁后启）、`fs-impl`（fs-sandbox←fs-local/fs-ssh，fs-ssh 在 packages/ssh/fs-ssh）、`storage-backend`（storage-json←storage-sqlite，`storage.backend.*` 不同键可共存，config.backend 切换）、`bash-tool`（tool-bash←tool-bash-persistent，同工具名双开抛 already registered）+ 存量 llm-adapter；**sandbox 族不开槽**（平台正交共存非互斥，bash-sandbox vs pwsh-sandbox 是 !!js 平台表达式互斥行 base patch:214-222）。其余 55 项无上游候选（单例），自研时再声明——不预开防「假可替换」。
- **兄弟 id 写入前核实**：bash-local/pwsh-local/fs-local/fs-ssh/storage-sqlite/tool-bash-persistent 全部包存在；除 llm-pi-ai 外均**不在现网 roster 缓存**（默认 profile 未挂）——slots 段加注释「需插入实例 + `dshctl check --refresh` 后豁免才生效」（防只声明不插入的假通过：存在证据 = roster ∪ 本域插件）。
- **替换指南**（user-manual §4 新增「核心功能替换指南」）：三模式（M1 共存增补——撞键报错不覆盖 DUPLICATE_ADAPTER/同 scope 同名 provide 同步抛错 fiber FAILED；M2 先禁后启 swap；M3 纯重实现）+ 六步×把关表（写实现→入库 R12→插入 R10→声明+禁旧 R11 槽豁免→check+smoke→清单回退幂等）+ 证据规则 + deepseek 连带件说明（换 adapter 后 api-extensions/package-inventory-deepseek 空转无害可留，禁则须各自声明——上游无 neutral 等价）+ storage 切换示例。
- **报错路径提示**：check.ts R11 两类 error 尾部追加「确需替换：core.yml …slots 声明成员」；GUI 核心页签 Hint 尾句「任何核心功能都可替换」；AGENTS.md plugin-registry 行追加「任何核心 id 可经 slots 声明替代成员后替换」。
- 验收：self-test ALL PASSED（存量槽断言不破）；`check ops --ci` 0 error 0 warn PASS；`plugin list` 正常读真 core.yml；build + GUI 重启 200；live `/api/plugins/core` 返回 **5 slots / 5 slotted 条目**（llm-deepseek/bash-sandbox/fs-sandbox/storage-json/tool-bash），核心页签 5 行青 Tag。
- 观察项口径修正：此前记录「file-ops.yml 嵌套 disable 不生效」维持未修待拍板。

### 替换通道补记（2026-09-18，用户决策：CLI + GUI 按钮、独立 replace.ts 引擎、全链预检→声明→插入→禁旧→check 失败回滚）
- **引擎** `code/dshctl/replace.ts`：`planReplace()` 预检（domain 存在/old≠new/幂等跳过/new 判型 `isPackagePath`/未入库自动 add/roster 免插入/pack 不在 capabilities warn/快照语义）+ `runReplace()` 执行（① 自动入库 ② `saveSlotMember` 保注释声明槽成员 ③ editYaml 插入 domain.yml `plugins[]` ④ editYaml 禁旧 ⑤ check **delta 判据**——相对基线无新增 error 且 old∈core 时 R11 不得为 error；失败按内存快照原子恢复全部写入 3~4 文件 ⑥ `--smoke` 追加冒烟，失败不回滚）。成功判据用 delta 而非「0 error」：现网 0-error 基线下等价，历史债不替买单。
- **支撑改造**：`core.ts saveSlotMember`（YAML.parseDocument 保注释；无 slots 段建槽后搬到 core 前；已有槽复用名+并入）；`plugin.ts isPackagePath`（`@` 前缀或无分隔裸名豁免 existsSync——否则 R12 无法对齐包名式 plugins[]，addPlugin 内同豁免，source=local/trusted=true）；`yml.ts editYaml`（保注释读改写共用）；`dshctl.ts` replace 分发 + usage；`gui/server.ts POST /api/replace`（dry_run 走预演、plan.errors 透传 400）；`Plugins.tsx` 核心页签带槽行「替换」小按钮 → 420 Drawer（新件 id/path/目标域 Select/keep-old Switch + 预演/执行双键 + 步骤清单），与 CLI 同源引擎。
- **实现时核实三点（全过）**：① `renderProfilePatch` insert.name 用 `JSON.stringify(path)` 原样透传，app-boot `anchorInsertedPluginNames` 只对 `isAbsolute/./..` 开头的 name 锚成 file URL——`@scope/pkg`/裸名保持字面走 loader 裸 import，不误锚；② 四个 pack yml 只有头部注释、无正文内联注释（且引擎走 editYaml 而非 renderPackYml 重写，头注释天然保留）；③ roster 证据走 `loadRoster(refresh:false)` 版本缓存（现网 dump-config-0.1.6-alpha.1.json 在），全程不触发 180s dump-config。
- **踩坑（实施中修 3 处）**：症状→根因→修复——a) 正向替换 post-check 误报 R11 裁空回滚：`runCheckFor` 复用 plan 期 spec，`plugins[]` 插入后未回读（stale 证据）→ 改为写后 `parseDomain` 重读 domain.yml 再 check，smoke 同用 finalSpec；b) saveSlotMember 新建 slots 段搬移不生效：`doc.set` 新 key 的 pair.key 是裸 string 而非 Scalar，`p.key?.value` 取不到 → keyOf 兼容两种形态；c) check 历史双写：`updateCheckResult` 内部已 `appendCheckHistory`，runReplace 又调一次 → 删显式调用。另：planReplace 路径解析改为 库内 path > --path > plugins[] 条目自带 path 三级回落，未入库但已在 plugins[] 的也能自动补登记。
- **验收**：self-test ALL PASSED（存量 + 新 [18] 段 12 断言：判型正反/保注释回读+slots 搬移+槽复用/预演四文件零写入/回滚四文件**字节还原**/正向 R11「槽豁免」+四文件按预期变更+独立 runChecks 0 error/keep-old core+pack 零变化）；`dshctl check ops --ci` 0 error 0 warn PASS；CLI 预演 `replace llm-deepseek --with llm-pi-ai` exit 0 打印四步+等价命令零写入（git status 现网清单无新改动）；API `dry_run:true` 返回计划、`old==new` 400 透传 plan.errors；build + GUI 重启 8780：`/api/plugins/core` 5 个带槽条目（llm-deepseek/storage-json/tool-bash/bash-sandbox/fs-sandbox），bundle 含替换 Drawer（预演/执行文案 grep 命中）——本会话无浏览器后端（`agent.browsers.list()` 空），页面点按交用户。文档：user-manual 六步表后加「步骤 2-4 可 replace 一键代劳」命令示例 + CLI 速查行；dshctl-manual 新增 §4.9 replace 全链条目（原 4.9 自测顺延 4.10）+ GUI 表加「替换」行。
- **明确不做**：`--undo` 自动反向（回退=打印指引+清单幂等，v1 边界）；不动 R11 判据；不开新槽；不写 dsh-guide 篇。

### 替换通道二期补记（2026-09-18，用户两问："可替换的是不是太少了" / "替换的这个 UI 太简陋了，设计的高级一些"）
- **决策一：按钮全开·分层标签（经 AskUserQuestion 确认）**——61 行全出「替换」按钮；青「可替换」Tag 只给已开槽 5 行，未开槽行保留绿点但 title 改「未开槽——手动禁用报 R11；点『替换』执行时自动开槽」；图例行/页签 sub/Hint 全改口径（**Hint「6 项已有上游兄弟」修正为 5**）。**core.yml 一行不动**——「不预开防假可替换/不开新槽」4 处历史决策原样保持；引擎侧可行性 Explore 核实：planReplace 是零写入预检无 R11 闸门、基线 error 不中止（delta 判据）、写序「声明在禁用前」无中间态、self-test 严格 id 无槽载体全链已覆盖。
- **决策二：600 宽三阶段 Drawer（经确认）**——头部一体卡（46px cyan 渐变 Swap 头像 + 槽态 Tag：已开槽=「槽 x」/未开槽=灰「按需开槽」+ group·desc）→ 旧→新对比卡（旧件 id + 槽成员 chips 来自 `/api/plugins/core` slots 字段[前端此前只消费 core，本轮接上]；新件侧表单实时回显 + 入库状态点：已入库绿/将自动登记蓝/未入库需 path 或 roster 证据橙）→ ①表单分节卡（两列 grid：新件 id/目标域/path/keep-old）→ ②预演分节卡（StatusRow verdict + warnings 块 + StepBadge 步骤时间线[带文件名 code] + **DiffView 行级 diff 卡**[每文件一张：label+action 头 + +绿 `#f6ffed/#b7eb8f` / −红 `#fff2f0/#ffccc7` / ctx 灰，站内无先例手写 ~30 行] + CommandChip）→ ③执行结果分节卡（StateDot verdict 成功绿/已回滚红 + 「R11 槽豁免」绿 Tag + 已执行步骤 ✓ 列表 + 回退指引 Collapse 折叠 + CommandChip）→ **常驻操作条**：左阶段状态文案（就绪/预演完成·未写入（N 步·M 文件变更）/输入已变更·重新计算中/已执行/已回滚），右 [预演][执行 Popconfirm]；执行门禁 = 预演通过且未过期。分节卡统一 3px 左色条（DomainForm secStyle 语汇）。
- **决策三：预演增强双选（经确认）**——行级 diff + **实时自动预演**：表单字段变更 500ms 防抖 `POST /api/replace {dry_run:true}`，auto 模式不弹 toast（失败内联 verdict），手动「预演」按钮保留 = 立即刷新 + 成功 toast；请求序号（seqRef）丢弃过期响应；任何表单变更 → 执行结果失效 + 预演标过期。planReplace 零写入 + roster 走版本缓存 ms 级，debounce 调用无成本顾虑（Explore 已核）。
- **架构：mutator 单一来源（虚拟写 = 真实写逐字节一致）**——`yml.ts mutateYamlText(text, mutate)`（parse→mutate→toString 不落盘）成为 editYaml 的实现体；`core.ts saveSlotMember` 拆为 `mutateSlotMember(doc,…)` 纯 Document 变更 + 薄壳落盘（签名不变，[18] 断言不破）；`replace.ts` 抽出 `mutateDomainInsert`/`mutatePackDisable` 为导出纯函数，runReplace 写步骤与 planChanges 虚拟写**同一函数**。`planChanges` 只对将要写的文件做内存虚拟写（按 facts 四开关：needDeclare→core.yml / insertNeeded→domain.yml / needDisable→pack / autoAdd→registry），行级 diff = 公共前后缀裁剪单 hunk ±3 行上下文（追加型变更够用且诚实），挂 `plan.changes`；**CLI 输出格式不变**（diff 是 GUI 预演专属），server dry_run 成功体加 `changes`。
- **踩坑/观察（本轮 0 修，2 记录）**：a) **flow 序列重排版吞行**——现网 core.yml slots 段是 `members: [a, b]` flow 样式，yaml v2 toString 输出带内空格 `[ a, b ]`，声明成员后整段 slots 的 flow 序列全部重排版 → 单 hunk diff 把中间未改行吞进 del/add（两侧各一份、仅空格差，32 行 13+13）；真实写走同一 mutator 同样如此——语义/头注释/行注释均不变，diff **如实展示不特殊处理**（honest 原则）；如嫌噪音后续可加「跳过纯空白行对」的展示层过滤，本轮不做。b) **底条实现偏差**——计划写 NewDomain sticky 同款，实际用 antd Drawer `footer`（`styles.footer`：rgba 白底 + blur(4) + 上阴影）：滚动区外常驻、免 sticky 负边距出血问题，视觉语言一致（footerStyle 在 antd v6 已 deprecated → 用 styles.footer）。
- **规模口径越线（待拍板）**：可执行代码（不含 self-test）实测 **2137 行**（非空非注释）/ 2462 行（含注释），红线 ≤1900 已越（替换通道两轮累计 +~400）。manual §规模口径已改标「实测+修订待拍板」；选项：① 按 P1-P3 先例修订 1900→2600（exec-plan 此处补记即决议记录）② 回砍功能。默认倾向 ①（replace/引擎面为交付必需），**待用户拍板**。
- **验收（live 实测）**：① `dshctl-selftest` **150 断言 ALL PASSED ✅**（存量 142 不破 + [18] 新增 8：mutateYamlText 纯函数/changes 结构/预注册三卡齐/core diff add 含成员与 slot: 且头注释不在 del/domain add 含新 id/pack add 含 `- old-impl` 且头注释不在 del/autoAdd 四卡/keep-old 仅 domain 一卡）；② `dshctl check ops --ci` 0 error 0 warn **PASS**；③ CLI dry-run 回归 `replace llm-deepseek --with bkn-plugin --domain ops` exit 0、输出格式不变（四步 + 等价命令，无 diff）；④ `pnpm build` 过 → 8780 重启 GET / 200；⑤ curl `dry_run:true`（llm-deepseek→bkn-plugin）返回 **changes 2 卡 hunks 结构**（core.yml 32 行 13 add/13 del、能力包 add `- llm-deepseek`、header 均不在 del）、warnings `[]`；⑥ **现网零改动**：plugin-registry + capability-packs + domains 全量 md5 前后同 `4f29c75d…`（预演构造性验证，未真改清单）；⑦ `/api/plugins/core` = **61 core / 5 slots / 5 slotted**；⑧ bundle grep：`width:600`、`f6ffed`×4、图例「绿点 = 未开槽（替换时自动开槽）· 青 Tag = 已开槽 — 均可替换」、行渲染结构 `e.slot? Tag:dot + 无条件替换按钮`、「防抖/自动预演/按需开槽/虚拟写 = 真实写/回退指引/R11 槽豁免/预检通过/执行中…/预演中…」全命中。点按级验证仍交用户（本会话无浏览器后端，沿用上轮降级先例）。
- **文档三处（doc/ 仓外）**：user-manual 核心页签行改全行+三阶段 Drawer 口径、六步后 GUI 入口句改「全部行」、CLI 速查 142→150；dshctl-manual §4.9 GUI 同源句改全行/600/自动预演/「diff 是 GUI 预演专属」、§7 GUI 表行同改、§2.4+CI 表断言数 108→150、规模口径行更新实测数。
- **明确不做（重申）**：不动 core.yml（不预开新槽）；不动 R11 判据；`--undo` 仍不做；插件目录（extension）替换入口不做；CLI diff 输出不加；不做 Modal、不做独立整页；不引第三方 diff 库（前后缀单 hunk 手写）。

### 核心页签主从重构补记（2026-09-18，用户三点：每行挂按钮非所求要「先选择后替换」/ 结构太笨不像产品 / 要求调研成熟 Web 平台再重构）
- **调研（两轮 Explore，四类来源）**：① **Carbon** structured list 规范——单选整行可点、选择控件常驻可见；批量才升级 data table + 顶部 batch bar（替换是单选流程，不适用批量）；② **Linear**——动作平时不出现，选中态本身是动作的使能信号；③ **VS Code Marketplace**——左列表点选 → 详情原位展示 → 主按钮在详情区（Install→Manage 同位演化）；④ **antd 生态**——官方 demo「Selection and operation」= 选中→操作→完成清空、ProTable 四段式（查询+toolbar+选择+操作），ant List 组件 Deprecated 不承载选择。三候选方案（①单选列+顶部工具条 / ②左清单右详情 master-detail / ③过滤优先+行内展开）经 AskUserQuestion 用户选定 **②**；替换容器选定**保留上轮 600 Drawer**（只换触发入口）。
- **站内先例复用**：选中行三态配方抄 `Domains.tsx DomainListItem`（active `#eef4ff`+border `#b7ccff` / hover `#f7f9fc` / transparent + transition .12s）；主从布局抄 `Domains.tsx` 左 300px 列表卡 + 右 flex 面板；右详情头行/作用卡抄详情 Drawer 一体卡语汇；全部现成组件零新增依赖。
- **结构（`Plugins.tsx` 核心页签重写，仅此一文件）**：新增 `coreSel`（**按 id 存**——reload 后 `core.find` 回落 null 守卫）+ `coreQ`（清单搜索，独立于插件目录 `q`）+ 模块级 `CoreRow` 组件。左清单卡（width 320）：`Input` 搜索（id/desc 过滤，命中计数「61 · 命中 N」）→ 滚动区 maxHeight 560 内 sticky 组头（组名+count，`top:0` 白底分隔线）+ 单行行（id code + desc 省略 + **已开槽 6px 青点**[title=槽名]；未开槽无标记——默认态不占视觉）。右详情卡（flex:1 minHeight 480）：未选中 = Empty「从左侧选择核心功能查看详情与替换入口」；选中 = 头行（id 16px + Tag「槽 x/按需开槽」+ 组 + ⓘ Hint）→ desc 全文卡 → `secCard(SEM.cyan)` 状态块（StatusRow「可替换」+ 已开槽/未开槽两态豁免语义一句话 + 槽成员 chips[当前件 cyan]）→ **「替换…」primary 唯一动作入口** + Hint → CommandChip 预告等价命令。搜索过滤走 `filteredCore` 派生后按组切段。
- **删减清单（回应「太笨」）**：删 8 组分块卡 grid（minmax 360 网格）；删 61 行两种态的行内「替换」link 按钮与行内可替换 Tag/绿点；删页顶说明长句 + 图例行 Space 三件套（语汇下沉：TabTile sub 一句话总纲、详情面板按选中项解释、说明收 ⓘ Hint）；行内状态收敛为单个青点；desc 从行内主角降级为扫读省略、全文在右栏展开。**Drawer（553-732）、详情 Drawer、插件目录/新建导入两页签、替换引擎链路（openReplace/setRepField/runReplaceApi/debounce/seqRef）零改动**；无 server/引擎/契约改动 → 无 self-test 新断言。
- **验证踩坑**：`pnpm exec tsc --noEmit` 全仓存量报错（TS5097 `.tsx` 后缀 import ×20、antd token/类型若干——工程历来只跑 vite build 不 typecheck），**降级口径**：过滤 `Plugins.tsx` 行——仅 1 条存量 TS5097，无新类型错误；标识符扫描（JSX 大写标识符 vs imports/defs）——`File/JSON/Promise` 为全局、`coreSel` 等解构态为启发式假阴性（grep 确认 `const [coreSel, setCoreSel]` 在位）；孤儿 import `RightOutlined` 随图例行删除一并移除（v5 白屏教训 c1c1b8c 的同类风险）。
- **验收（live 实测）**：① `pnpm build` 过（bundle `index-DzM0yi2S.js`）；② `dshctl-selftest` **150 断言 ALL PASSED**（回归网无变化）+ `dshctl check ops --ci` 0/0 PASS；③ 重启 8780 GET / 200、`/api/plugins/core` 61 core / 5 slots / 5 slotted；④ bundle grep 新串全命中——「从左侧选择核心功能查看详情与替换入口」「点击清单行选中」「搜索 id / 描述」「按需开槽」「槽成员」「替换…」「命中」「全链替换：预演（零写入 · 行级 diff）」、三态选中色 `eef4ff`/`b7ccff`、`width:320`；旧串消失——「点『替换』执行时自动开槽」「绿点 = 未开槽」「手动禁用仍受 R11 约束」「核心功能不可缺——手动禁用」均 0（残留「同槽有活跃成员即可替换」×1 属 Manual.tsx 使用手册页描述文案，非本页签）；⑤ 清单零改动：plugin-registry + capability-packs 全量 md5 `6cb88103…`、domains/*/domain.yml md5 `9cac84a2…`（比对口径排除 `.check-history.json`/`registry.yml`——两者是验收命令 `check --ci` 自身的历史/登记回写，非本轮 UI 写入）；⑥ 点按级验证交用户（本会话无浏览器后端，降级先例）。文档：user-manual 核心页签行 + GUI 等价入口句改主从口径；dshctl-manual §4.9 GUI 同源句 + §7 GUI 表行改主从口径。
- **明确不做**：多选/批量条（单选流程，Carbon 规范亦区分）；`#/plugins?tab=core&sel=` 深链（parseHash 框架在、Tabs 保持非受控，列为后续可选）；antd Table rowSelection / 退役 List / 第三方组件库（自绘更轻，61 项无虚拟滚动压力）；插件目录与新建导入两页签、已验收 Drawer 内容不动。

### 核心页签产品化打磨 + Domains 等高对齐补记（2026-09-18，用户三点：方向对了但拥挤/太干/太简陋产品化不好看；布局要合理视觉不突兀不能高低长短不齐；密密麻麻小字要部分悬停显示）
- **诊断（两轮 Explore：全站节奏盘点 + 外部处方调研，B1-B14 偏差表）**：① 高低不齐根因 = 左 `maxHeight:560` + 右 `minHeight:480` + 父 `align flex-start` 底边永不齐；gap 14 脱离全站刻度（8/12/16）；左 padding 10/8/8 vs 右 16 不对称；框中框（PageCard 20 内再套 r10 描边框）。② 拥挤 = 行高 30 挤 id12.5+desc12 同行。③ 简陋 = 右详情无视觉锚点（全站详情均有 44-46px 渐变头像谱系，此面板为唯一例外）+ secCard 卡中卡 + 信息齐平无层级。④ 小字违规 = 组头/成员 Tag 11.5、空态 12.5 破全站字号下限 12（FONT_SIZE 无此档）；右栏两段 12px 解释句常驻（全站惯例 Hint 收纳，每页 2-7 处）。⑤ 他页快扫：Dashboard/Upgrade/Registry/DomainDetail 为成品范本；**Domains 主从同款病**（右 420/padding48 vs 左无高/padding12）；Manual 长句铺满、画布 10px 边标 = 轻度。
- **处方来源**：every-layout Sidebar（flex stretch 天然等高）；Carbon 间距刻度（2/4/8/12/16/24，off-scale 值即「突兀」来源）；antd Typography `ellipsis.tooltip` / Tooltip FAQ（0.1s 默认延迟、复杂内容用 Popover）；WCAG 1.4.13（悬停层 dismissible/hoverable/persistent，原生 title 是最弱载体）；GitHub repo header 三层公式（头区底色分隔 → 内容 → 动作）；VS Code 扩展详情（图标磁贴 = 详情视觉锚）；Linear/Carbon（动作不常驻，选中态即使能信号）。
- **决策（两个澄清问题未获答复，取推荐默认）**：范围 = 核心页签打磨 + **Domains 同类对齐修复**（Manual/画布记观察项不扩）；左侧行 = **只留 id + 悬停 Tooltip 看描述**（正合「小字放上去再显示」）。
- **落地（`Plugins.tsx` + `Domains.tsx` 两文件）**：
  - 骨架：外层 `gap:16 + alignItems:stretch + height:580`，两栏同高底边必齐；左右都改 flex column + overflow hidden——左「搜索头 flexShrink + 列表 flex1 内滚」（删 maxHeight560），右「头区带 + 内容区 flex1 内滚 + 底部动作条」（删 minHeight480）。
  - `CoreRow`：删行内常显 desc；行高 32、id 升 13/500（选中 600）；整行包 Tooltip（desc 全文 + 槽说明两行，`placement=right mouseEnterDelay=0.3`）替代原生 title；选中改「`#eef4ff` 底 + `inset 3px 0 0 #1677ff` 左竖条」无描边抖动；组头 11.5→12/600、padding 6px 8px、`boxShadow 0 1px 0` 代 borderBottom（滚动分割线不断）；左栏无匹配 Empty 加**真实动作**「清除搜索」。
  - 右栏三层：头区带（`#fafbfd` + borderBottom + **40×40 r10 紫青渐变磁贴** `linear-gradient(135deg,#722ed1,#13c2c2)` + 投影 `rgba(114,46,209,.18)` + id16/600 + 槽态 Tag/组 chips + ⓘ）→ 内容区平铺节（新 `secTitleStyle` 12/600 灰微字距；「作用」全文块 / 「状态」节**两段常驻解释句收进 Hint**只留一句副摘 / 槽成员 Tag 升 12/lineHeight20 / 「等价命令」CommandChip；**删 secCard 卡中卡**）→ **底部动作条**（`#fafbfd` + borderTop + 「替换…」primary + ⓘ，与头区同色呼应）。空态副文案升 13 对齐 Domains；**不加假动作按钮**（右栏空态无真实动作，诚实原则）。
  - `Domains.tsx:387-398`：根 `alignItems:'stretch' + height:480`、左列 `boxSizing + overflow:auto`、右占位删 `minHeight:420` 改拉伸、`padding:48 → 24`（回刻度档）。
- **验收（live 实测）**：① `pnpm build` 过（bundle `index-3FnIKfjf.js`）；`tsc --noEmit` 过滤两文件仅存量错误（Domains 6 条均在未改行：TS5097×2/health/unknown×2/PageCard loading；Plugins 仅 1 条 TS5097），标识符扫描零未解析（DomainForm 默认导入为启发式假阴性，grep 确认 import 在位）；② `dshctl-selftest` **150 断言 ALL PASSED** + `check ops --ci` 0/0 PASS（纯前端回归网零变化）；③ 重启 8780 GET / 200、`/api/plugins/core` 61/5/5；④ bundle grep——新串命中 `inset 3px 0 0` / `rgba(114,46,209` / `清除搜索` / `mouseEnterDelay` / 紫青渐变 / `height:580`、`height:480`、头区带 `16px 20px` + 动作条 `12px 20px`；旧串消失 `maxHeight:560`/`minHeight:480`/`minHeight:420`/`padding:48` = 0；常驻解释句全站仅 1 处（= 仅存 Hint title 内）；核心段 11.5/12.5 字号清零（残留命中均在 PluginTile/DiffView/Drawer——目录页签与 diff 密集场景，非本段）；⑤ 清单零改动：plugin-registry + capability-packs md5 `6cb88103…`、domain.yml md5 `9cac84a2…`（口径排除 check 自回写两文件）；⑥ 点按级验证交用户（无浏览器后端降级先例）：左行悬停浮层、右栏三层、两栏底边对齐、Domains 等高。
- **观察项（本轮不动待拍板）**：Manual 页 FAQ/体系段整段 13px 长句平铺无收纳（Manual.tsx:63-114）；OrchestrationCanvas 边标签 10px、副标 11.5 突破字号下限（画布场景可容忍）；`#/plugins?tab&sel` 深链与 antd Splitter 拖拽维持不做。
- **明确不做**：不动替换 Drawer/插件目录/新建导入/引擎/server；不加新依赖；字号不破 12 下限；不加假空态按钮。

### 视觉升级（高级感浅色控制台）补记（2026-09-18，用户三点：依旧太简陋无高级感 / 先调研高 star 组件库 / 再调研大厂风格综出方案）
- **调研三线 → 方案文档 `doc/dshctl-ui-style-plan.md`**（状态：✅ 阶段 1+2 已实施验收回填，阶段 3 待拍板）：① 高 star 组件库（GitHub API 实测：shadcn/ui 124,205★、antd 99,551★）——选定 **不换库、抄 shadcn/Linear/Geist DNA、用 antd token 落地**（三路线评估：主题+原子件 7/10 ＞ 混合自绘 ＞ 迁库）；② ≥7 家大厂共性公式（三级背景/1px 三档 hairline/卡零影/文字三色 ≥4.5:1/圆角三档/主色每屏 ≤3 处/mono+tabular/状态色 muted 成对/hover 跳一档灰 150ms）；③ 本地 10 条 file:line 诊断（根因 = GRAY/SEM/SHADOW 常量绕过主题系统 + `#8c96a6` 对白仅 2.99:1 + 渐变磁贴三连 + 47 处 inline 灰）。
- **阶段 1（commit 7f31ff7）**：main.tsx token 全表 + **主按钮近黑 `#18181b`**（Linear DNA 关键单点，不适一行回退）+ `@fontsource/inter` latin 400/500/600 自托管（font-display swap，中文回落系统）+ api.tsx GRAY/SEM/SHADOW/cardStyle 值对齐（卡零影）+ `SEM_TEXT` 深档 + `MONO` 栈 + tabular 全局注入。**踩坑**：antd v6 Tabs 无 `inkBarHeight/inkBarWidth` token（原 `inkBarWidth:3` 本就是无效覆盖+存量类型错）→ 只留 inkBarColor/itemSelected/itemHover 三色，默认 2px 已达标。
- **阶段 2（本 commit）**：api.tsx 原子件——PageHead/StatTile 渐变磁贴→tinted 底、StatBand 分层+tabular、StatusRow 文字接 GRAY、`card-hover` hover 边框加深、**新增 `EmptyState` 四件套与 `StatusChip`**（Domains Tagish 下沉）；三标杆页重刷——Dashboard（磁贴收敛/健康值深档/空态 CTA）、Upgrade（verdict 三态 `#1b7a43/#cf222e/#b8860b` 深档/空态 CTA）、Domains（主从空态 CTA/hover 0.15s）。
- **验收（live）**：build 过 + 标识符扫描零未解析 + tsc 过滤仅存量错；self-test **150 ALL PASSED** + `check ops --ci` 0/0 PASS；重启 8780 200、core API 61/5；清单 md5 `6cb88103…`/`9cac84a2…` 零变化；bundle 新标记（深档三色/近黑按钮/#fafafa/ring 阴影/EmptyState 三标题/tabular×4/Inter woff2×3）全命中，旧标记（inkBarWidth/旧弱阴影/页头渐变）归零。观感拍板交用户（无浏览器后端降级先例）。
- **遗留（阶段 3 待拍板，本轮明确不做）**：`#8c96a6` 等 inline 字面量残留 20 处（非标杆页）；Plugins/Registry 逐页重刷；Domains 页内 Tab 空态；Manual 长句/画布边标维持观察项；暗色模式（留 token 化后路）；不引 framer-motion/第二图标库。
