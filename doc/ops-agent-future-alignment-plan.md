# 运维 Agent 未来方向对齐整改清单

> 2026-09-16 · 状态：待评审
> 上游：[gernalarrange/domain-agent-orchestration-proposal.md](file:///hdd/demo/public/dsh-info/doc/gernalarrange/domain-agent-orchestration-proposal.md)（§3.3 通用化、§3.5 债务、§7 路线图）、[gernalarrange/dshctl-design.md](file:///hdd/demo/public/dsh-info/doc/gernalarrange/dshctl-design.md)（R5/R8 等校验规则）
> 范围：**当前正在编排的运维 agent**（dsh-info 工作区 + .dsh-home 试验实例）对照未来方向（dshctl / 能力包 / 多领域复用）的差距整改。不含 SQL 转换域新建工作项（见 proposal §6）。
> 来源：2026-09-16 对工作区代码、配置、上游 skill-filesystem/app-boot 源码的逐项重读核查。

---

## 0. 结论速览

| # | 事项 | 类别 | 优先级 |
|---|------|------|--------|
| C1 | skills 双源同名，admin 启停/curator 可能被 shadow 失效 | 待核查（疑真坑） | **P0 先验证** |
| C2 | profile patch 明文密钥 ×3（apiKey/adminKey/i2agent Bearer） | 必改 | P1 |
| C3 | ops-api 领域残留 5 处（platform/modelId/tools 计数/i2agent 健康检查/cwd） | 必改 | P1 |
| C4 | apiServer host=0.0.0.0 全网卡监听 | 必改 | P1 |
| C5 | run-ops-trial.sh 终端回显 Bearer key | 必改 | P2 |
| C6 | headless 表述矛盾：batch 3 称"webserver 下线"，但 :3081 仍对外宣称 GUI+/admin | 待核查 | P1 |
| C7 | file-upload 保留决策（E1.2 事故教训）须随归层进入能力包 keep 语义 | 归层纪律 | 随 5a |

---

## C1 skills 双源同名（P0，先验证后动手）

**现状事实**（均已核实）：
- preset [agent.cordis.yml:56-62](file:///hdd/demo/public/dsh-info/code/presets/i2stream-ops/agent.cordis.yml#L56-L62) 的 `customSkillDirs` 指向共享源 `/hdd/demo/public/i2stream-bkn/skill`（27 个 skill）；
- `.dsh-home/skills/` 存在一份**同名拷贝**（27 个目录，逐一 diff 同名）；admin 启停（[admin.ts setSkillEnabled](file:///hdd/demo/public/dsh-info/code/ops-api/admin.ts#L189)）与 ops-skill-manager 的 curator 操作的都是**这份拷贝**；
- 上游 [skill-filesystem/src/index.ts:78](file:///hdd/demo/public/dsh-info/deepseek-harness/packages/skill/skill-filesystem/src/index.ts#L78)：`includeDefaultRoots` 默认 `true` → `$DSH_HOME/skills`（user-dsh，rank 400）与 customSkillDirs（custom，rank 300）**同时进 catalog**；rank 越小优先级越高。

**风险推论**：catalog 出现 27×2 同名 skill。若 rank 300（custom 共享源）优先，则对 `.dsh-home/skills` 的 disable（目录重命名）与 curator 迁移**不影响实际生效的 skill**——管理面操作是空转。反之若 user-dsh 优先，则共享源更新被拷贝遮蔽。两种情形都是坏的。

**验证步骤（live 实证，AGENTS.md §2 第 4 条）**：
1. `GET /admin/api/state`（Bearer <OPS_ADMIN_KEY>）记录某 skill 状态；
2. `POST /admin/api/skills/i2stream-log-analyzer/disable`；
3. 向 :8643 发一道该 skill 域的题（如"增量同步卡住怎么排查"），观察工具输出 `_skill_recommendation` 是否仍指向它；
4. 恢复 enable，回填结论到本节。

**修复方向**（验证后二选一）：
- a) preset 去掉 `customSkillDirs`，让 `.dsh-home/skills`（user-dsh 默认根）成为唯一源——管理面语义即刻正确，但脱离"共享 BKN 单一事实源"原则，拷贝需同步机制；
- b) 保留 customSkillDirs 为唯一源，admin/curator 的 skillsDir 改指共享源——符合"共享只读消费"，但启停/迁移会写共享目录，影响 Hermes 侧共用。
- **倾向 a) 的变体**：customSkillDirs 保留作"上架源"，curator 增加"从共享源同步到 .dsh-home/skills"的拉取动作，catalog 只认拷贝。待验证结果定稿。

## C2 profile patch 明文密钥（P1）

**现状**：[.dsh-home/profiles/ops/cordis.patch.yml](file:///hdd/demo/public/dsh-info/.dsh-home/profiles/ops/cordis.patch.yml) 中 `apiKey: '<OPS_API_KEY>'`、`adminKey: '<OPS_ADMIN_KEY>'`、i2agent MCP header `Bearer <I2AGENT_MCP_KEY>` 三处明文。

**已核实的上游能力**：[app-boot/src/index.ts:231-234](file:///hdd/demo/public/dsh-info/deepseek-harness/packages/boot/app-boot/src/index.ts#L231-L234) 注释明确——user patch 层共享 include 的 YAML 方言，`!!js` 标量表达式节点可引用 `process.env`。**即密钥外移不需要等 dshctl，上游原生支持**。

**修复**：
```yaml
apiKey: !!js 'process.env.OPS_API_KEY ?? ""'
adminKey: !!js '!!process.env.OPS_ADMIN_KEY || (() => { throw new Error("OPS_ADMIN_KEY required") })()'
```
（确切 `!!js` 语法以上游 loader 实现为准，实施时先看 base bundle 里现有 `!!js` 用法定型。）systemd unit 经 `EnvironmentFile=` 注入；dshctl R8 校验保持不变（字面值即 error）。

## C3 ops-api 领域残留（P1，proposal §3.3 的具体化）

[index.ts](file:///hdd/demo/public/dsh-info/code/ops-api/index.ts) 逐项：

| 位置 | 残留 | 改法 |
|---|---|---|
| L338 / L417 | `/health` 硬编码 `platform: 'dsh-ops-agent'` ×2 | 入 config（`platform` 字段，默认 `'dsh-domain-agent'`） |
| L115/L130/L176/L179 | schema 与 cfg 默认值 `preset/modelId: 'i2stream-ops'` | 去默认值，未配置 fail-loud |
| L131/L180 | `cwd` 默认 `/hdd/demo/public/i2stream-bkn` | 去默认值，未配置用 `$DSH_HOME` |
| L120/L184 | `apiServer.port` 默认 8642（恰是被占用端口） | 默认改 8643 或强制显式配置 |
| L728-747 | `/v1/capabilities` 静态位图：version `'0.2.0'`、endpoints 静态列表、**`tools` 恒为 3（只数记忆工具，BKN 12 工具未计）** | version 读 package.json；tools/skills 计数从 preset 实际组合面读取（可复用 dshctl check 的 dump-config 产物）；endpoints 按实际挂载路由生成 |
| L485 | admin 健康检查硬编码 `['i2agent', 'http://127.0.0.1:8090']` | 依赖清单入 config（`admin.healthDeps`），与 dshctl domain.yml 的 `shared_deps` 对齐 |
| L43/L211 等 | 插件名/日志前缀 `ops-api` | 重命名 `dsh-domain-api`（目录同步改名，profile patch 引用同步更新） |

同步更新：ops-api/self-test.ts 断言、api-smoke.sh、文档引用。

## C4 apiServer host=0.0.0.0（P1）

**现状**：profile patch `apiServer.host: '0.0.0.0'`，8643 监听全网卡。试验期有 Bearer 兜底，但多领域推广后每个实例一个对外端口，攻击面线性增长。

**修复**：默认 `127.0.0.1`，需要对外时显式声明并落到 dshctl 校验（新增 R11：host=0.0.0.0 时 warn 并要求清单中显式确认）。若 i2Agent 跨机调用属实，改走反代/内网白名单而非裸监听。

## C5 run-ops-trial.sh 回显密钥（P2）

**现状**：[run-ops-trial.sh](file:///hdd/demo/public/dsh-info/code/scripts/run-ops-trial.sh) start 分支 `echo "API: http://127.0.0.1:8643/v1 (Bearer <OPS_API_KEY>)"`、admin key 同。

**修复**：删除明文，改提示 `Bearer $OPS_API_KEY（见 systemd EnvironmentFile）`。

## C6 headless 表述矛盾（P1 待核查）

**矛盾点**：[ops-app/cordis.patch.yml:93-102](file:///hdd/demo/public/dsh-info/.dsh-home/bundles/ops-app/cordis.patch.yml#L93-L102) batch 3 注释称"webserver/web-runtime 下线，对外只暴露 api-server :8643"；但 run-ops-trial.sh 仍打印 `GUI: http://127.0.0.1:3081/?token=...`，AGENTS.md §9（本次已改）此前也写 3081 有 GUI+/admin。

**验证**：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/` 与 `/admin`——实证 3081 到底还有没有 web 面。

**为何重要**：dshctl 生成物形态取决于此——若 3081 已无 web 面，则领域实例模板是"纯 headless api-server"，`/admin` 必须挂自建 listener 而非 webServer（ops-api 当前是两面都挂，index.ts L328-331 mountRoute 逻辑已兼容，但文档与脚本要统一口径）。

## C7 file-upload 保留决策入能力包（随路线图 5a）

[ops-app/cordis.patch.yml:52-54](file:///hdd/demo/public/dsh-info/.dsh-home/bundles/ops-app/cordis.patch.yml#L52-L54) 注释记录：file-upload 故意保留（session-controller 硬依赖 fileUploads，E1.2 事故）。归层时这条必须写成 file-ops 能力包的 `keep_tools` + 注释（dshctl §7.1 片段格式已预留该键），否则 SQL 域勾选 file-ops 时重新踩坑。43 项 disable 归层时逐条核对类似隐性依赖。

---

## 附：本次顺带修正（已落盘）

- AGENTS.md §1 补 `code/ops-skill-manager/` 与 `doc/gernalarrange/` 行；
- AGENTS.md §9 端口表更新为现状口径（8643 试验 / 8642 归属待确认 / Gateway 托管现状）；
- proposal §1.1 资产表补 ops-skill-manager，disable 计数口径修正为"本层 43 项 + 覆写 1 项（另有上游自带 15 项）"。

## 执行顺序建议

1. **C1 验证**（只读+一次启停+一道题，十分钟内出结论）；
2. C2/C5（密钥外移，小改动）→ C4（host 收敛）；
3. C6 验证（一次 curl）；
4. C3（ops-api 通用化，即路线图第 2 步，配合 self-test 回归）；
5. C7 随 dshctl v0.1 adopt 归层时执行。

## ✅ 整改执行记录（2026-09-16 14:30 回填，live 实测）

执行顺序：C1 → C2/C5 → C4 → C6 → C3（C7 按计划随 dshctl v0.1 adopt 归层时执行）。
全部验收数据取自试验实例（systemd `dsh-ops-trial`，DSH_HOME=`.dsh-home`，api :8643）live curl/journalctl/ss 输出。

### C1 skills 双源同名（P0）——真根因比文档预判更深

| 步骤 | 结论 / 证据 |
|---|---|
| 初判验证 | 禁用拷贝 → 技能仍从共享源加载成功 → 双源 shadow 确认（E5 记录属实） |
| 修双源 | preset 拷贝与源均去掉 `customSkillDirs`（custom rank 300 遮蔽 user-dsh rank 400；`.dsh-home/skills` 与默认根同目录，双注册纯冗余） |
| 修后复测 | **disable 后技能仍加载成功**——双源不是唯一根因 |
| 真根因 | session 日志 zstd 解压实证：`Base directory: .../i2stream-db-diagnostics.disabled`——**skill-filesystem 用 frontmatter `name` 注册技能**（skill-filesystem/src/index.ts:737 `name: parsed.name`），扫描器只跳 `.system` 不跳 `.disabled`；目录改名对 frontmatter 命名技能完全无效。**E5 的 admin disable 机制从未真正生效过** |
| 修复 | disable/enable 改为**目录内 SKILL.md ↔ SKILL.md.disabled 改名**（扫描器只认精确名 `SKILL.md`，缺失即忽略——parseSkillFile 对缺失文件返回 undefined 容错确认）；archive 改为**移入 `.archive/` 子目录**（扫描器只查根下每目录的直接 SKILL.md，不递归）；新增 `sync` action（共享源→拷贝上架，copyTree + ledger sync 记录） |
| live 终验 | disable 后 chat 调 skill 工具 → **`Error: skill "i2stream-db-diagnostics" unknown or no longer available`**（真正不可用）；enable 后恢复加载 ✓ |

落地文件：`code/ops-api/admin.ts`（listSkills/setSkillEnabled SKILL.md 级）、`code/ops-skill-manager/ops.ts`（archiveSkill→`.archive/`、新增 syncSkill）、`code/ops-skill-manager/curator.ts`（archive/unarchive 同语义）、`code/ops-skill-manager/index.ts`（upstreamDir 配置 + sync action）、preset 源+拷贝（去 customSkillDirs）、profile patch（upstreamDir 配置）。
self-test：ops-skill-manager 29 断言全绿（+3 sync）；ops-api 119+ 断言全绿（§15.4 改 SKILL.md 级语义）。

### C2 明文密钥（P1）✅

- 新建 `.dsh-home/ops.env`（权限 600）：`OPS_API_KEY` / `OPS_ADMIN_KEY` / `I2AGENT_MCP_KEY`；
- profile patch 三处明文改 `!!js process.env.*`；unit 重建挂 `EnvironmentFile=`；
- live：`/health` 200、env key 鉴权 200、admin 200（key 全链路生效）。

### C5 脚本回显（P2）✅

- run-ops-trial.sh：删两行明文 key 回显（改指引 env 文件路径）；start 分支补 EnvironmentFile；headless URL 口径（admin 移 :8643）；status 分支 admin 探针同步。

### C4 host=0.0.0.0（P1）✅

- apiServer `host: '127.0.0.1'`；live `ss -ltnp`：`127.0.0.1:8643`（原 0.0.0.0）✓

### C6 headless 表述矛盾（P1）✅

- live 实证：`:3081` 无监听 + connection refused——headless 现状确认；对外唯一面 = `:8643`。脚本/文档口径已统一。

### C3 ops-api 领域残留（P1）✅

| 项 | 改法 | live 证据 |
|---|---|---|
| platform 硬编码 ×3 | 入 config（默认 `dsh-domain-agent`）+ version 入 config | `/health` → `platform:dsh-domain-agent, version:0.3.0` |
| preset/modelId 领域默认 | 去默认，未配置 fail-loud 启动拒绝 | self-test 14.1a ✓ |
| cwd 领域默认 | 空则 `$DSH_HOME` 兜底 | — |
| port 默认 8642 | 改 8643 | — |
| capabilities 静态位图 | version 读 config；**tools.count 从 `tools.schemas()` 实测**（原恒 3 漏报 BKN 12 工具）；endpoints 按 routes 记账动态生成 | `/v1/capabilities` → `tools.count: 33`，endpoints 含 /admin 四路由 |
| admin healthDeps 硬编码 i2agent | 入 config（profile patch healthDeps 清单）；gateway 恒探测 | admin state → `gateway:ok, i2agent:ok` |

插件名 ops-api→dsh-domain-api 重命名**未执行**（对外平台标识已解耦为 config；目录/标识重命名留待 dshctl adopt 时随归层一次性做，避免 mid-flight 破坏 profile patch 绝对路径引用）。

### C7 file-upload 归层（P2）——按计划推迟

维持原判定：file-upload 保留 ops-api 层，归层决策随 dshctl v0.1 adopt 一并执行（proposal 能力包 file-ops 节）。

### 整改全程踩坑（沉淀）

1. **`!!js` 表达式 YAML 约束**：表达式不得以引号开头（YAML 解析为标量后其余成非法续行）；不得含 `: ` 冒号空格（被解析为嵌套映射分隔符，实证 `"Authorization":{"[object Object]":""}`）。安全写法：`!!js ('Bearer ' + (process.env.X ?? ''))`（括号开头、无冒号）。
2. **preset 拷贝双份**：`code/presets/`（源）与 `.dsh-home/presets/`（运行实例拷贝）需同步修改，只改源重启无效。
3. **systemd transient unit**：重建时才可挂新 `EnvironmentFile=` 属性；`systemctl restart` 只重启不重建。
4. **fail-loud 改必填会破存量测试**：preset/modelId 去默认后，self-test 中历史 apply 调用需补参。

---

## 整改收口（2026-09-16 全量清扫批次）

| 项 | 终态 | 证据 |
|---|---|---|
| C1 | ✅ **关闭** | 机制修复（SKILL.md.disabled + upstreamDir 同步）+ 运行时 preset 拷贝同步（去 customSkillDirs）+ 重启后 26 skills 单源挂载、disable/enable 实测正常 |
| C2/C4/C5 | ✅ 已关闭（前次回填） | — |
| C3 | ✅ 已关闭；**唯一余项**：插件改名 ops-api→dsh-domain-api 按记录延后（adopt 的 plugin_id 机制已让清单侧兼容） | — |
| C6 | ✅ **关闭** | 手册对照表/已知限制/观察项 + AGENTS.md §9 全部改 headless 口径（与 ss 实测一致） |
| C7 | ✅ 实质完成 | file-ops 能力包 keep_tools 含 file-upload（dshctl-design §7.1 语义），E1.2 教训已固化为片段注释 |
| 附：8642 | 取证闭环 | hermes-cli 活进程（pid 3088028，0.21.1）；回收转正=观察期后决策 |
