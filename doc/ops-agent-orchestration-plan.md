# i2Stream Ops 产品化编排方案：精简 DSH + 运维 Web + 管理面

> 2026-09-15 · 上游：ops-agent-gap-exec-plan.md（G1/G2/G3 已闭环）
> 目标：把「Hermes 等价替代」升级为「独立运维产品」——精简编排的 DSH + 对话运维 Web + 工具/skill/MCP 管理面 + 对外 api-server。
> 编排试验田：/hdd/demo/public/dsh-info/deepseek-harness（工作区源码副本，v0.1.6-alpha.1）。

---

## 0. 已确认决策（用户拍板）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 编排形态 | 工作区 deepseek-harness 内新增**增量 bundle 层**（dsh-ops-app）：叠在 dsh-web-app 之上按 id disable 裁剪，**不 fork、不改不删既有 bundle 源码行**——编排全部表达为「对上游的增量」，社区更新后 rebase 成本最小（见 §2.5 上游同步策略） |
| D2 | 管理面深度 | **管理 API + 简单管理页**：/admin/* REST + 轻量 Web 管理页，写回配置热生效 |
| D3 | api-server 暴露 | **独立端口 + 强制 Bearer key**（对齐 Hermes :8642 模式）；Web GUI 留独立端口 loopback |
| D4 | 会话能力边界 | **纯运维面**：会话只挂 BKN 12 工具 + i2agent MCP + skill + 记忆工具；不给本地 bash/fs/terminal/subagent/workflow/plan/goal/ralph/web 搜索等编码 Agent 能力 |
| D5 | 试验环境 | **独立 DSH_HOME**，与现网 /root/.dsh（:3080）完全隔离，成熟后再切换 |

---

## 1. 最终形态（目标架构）

    ┌─────────────────────────────────────────────────────┐
    │  dsh --profile ops（精简编排实例）                     │
    │  DSH_HOME=/hdd/demo/public/dsh-info/.dsh-home        │
    ├─────────────────────────────────────────────────────┤
人 → Web GUI (:3081, loopback) ─┤  bundle: dsh-base(共享) + dsh-ops-app(新) │
    │  ┌────────────────────────────────────────────────┐ │
    │  │ i2stream-ops preset（纯运维会话）                │ │
    │  │  persona(热路径) + BKN 12工具 + i2agent MCP      │ │
    │  │  + skill目录(27项) + 记忆工具 + RiskGuard 护栏   │ │
    │  └────────────────────────────────────────────────┘ │
管理员 → /admin 管理页 ────────────┤  /admin REST：MCP CRUD / skill 开关       │
    │       / 工具清单 / preset 查看 / 系统状态          │
    ├─────────────────────────────────────────────────────┤
程序(i2Agent/脚本)                │  api-server（自建 :8642, 0.0.0.0, Bearer）│
──→ :8642 /v1/* ─────────────────┤   chat/completions + responses + sessions │
    └─────────────────────────────────────────────────────┘
                      │                    │
        i2agent MCP(:8090)      MemoryCore Gateway(:8420)
        （远程受控执行面）        （记忆，supervisor 托管）

- **一个进程、两个 listener**：GUI 面复用 dsh-host-webserver（:3081）；api-server 由 ops-api **自建 node:http server**（:8642）——不挂第二个 dsh-host-webserver（它是 super(ctx,'webServer') 的单例 Service，第二实例会撞名，见 §3.2）。
- **会话统一 preset**：Web 会话与 API 会话都用 i2stream-ops（agent-presets default 改为 i2stream-ops），能力面一致。
- **执行面收敛**：所有运维动作（exec_shell/query_database/autodiag）走 i2agent MCP 远程受控通道；DSH 本机不暴露 bash。

---

## 2. 源码编排（D1 的具体裁剪清单）

### 2.1 新增增量 bundle 层：packages/bundle/ops-app（叠加在 web-app 之上，不 fork）

**关键原则：不复制、不删除上游任何行**。DSH 的 patch 层语义是「按 id 寻址，后层覆写前层」（bundle README 明示 last write winning per row）——所以 ops-app 不是 web-app 的 fork，而是**第三个 bundle 层**，profile bundles 变为：

    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-ops-app']

ops-app 的内容 = 对前两层的 **disable 覆写清单 + insert 追加**。上游更新 web-app/base 时，ops-app 无需 merge：上游改的是自己的行，我们只声明「哪些 id 关掉」。上游**新增**的行默认启用——需要评审是否纳入裁剪清单（见 §2.5 同步流程）。

**disable 清单（浏览器 roster，dsh.client 行）**：

| disable 行 | 理由 |
|--------|------|
| ui-sidebar-terminal / ui-sidebar-files / ui-sidebar-documentpreview | 本机终端/文件树/预览——纯运维面不需要 |
| ui-workspace / ui-deliverables / file-upload | 工作区文件管理/交付物/上传 |
| ui-subagent / ui-workflow-run / ui-goal / ui-plan / ui-schedule / ui-jobs | 编码 Agent 协作面 |
| ui-message-feedback / ui-trajectory | 反馈与轨迹（首版关，可回滚） |
| open-in-app / ui-open-in-app / session-log-download / directory-picker | 桌面联动 |
| ui-reference / file-reference-local | @ 文件引用（ui-commands/ui-skill/ui-input-trigger 保留） |

**disable 清单（host 行，被关 UI 的后端 + 非核心）**：

| disable 行 | 理由 |
|--------|------|
| terminal-controller / workspace-files / workspace-controller | 被关 UI 的后端 |
| session-log-download / open-in-app / directory-picker（host 行） | 桌面联动 |
| message-feedback | 非核心 |

> **disable 而非删除的取舍**：disabled 行仍留在组合表里（loader 不加载，零运行时成本），换来的是「上游行内容变化不产生 merge 冲突」。代价是裁剪清单只增不减地维护——可接受，清单本身就是能力边界的显式文档。

**保留白名单**：webserver / web-runtime / modules / connection / api-remotes / cordis-client-runner / ui-theme / ui-locale / ui-layout / ui-renderer / ui-session / resources / ui-sidebar + ui-sidebar-right / ui-chat / ui-conversation / ui-approval / ui-settings 全家（general/models/plugins/plugin-inventory/unarchive-sessions）/ ui-model-selection / ui-agent-preset / ui-permission / ui-skill / ui-commands / ui-input-trigger / client-hmr / session-controller / settings-controller / plugin-inventory / typert 全家 / workspace（host 级 workspace 根服务保留——session 基建依赖，只关文件树 UI）。

### 2.2 base 层裁剪（同一 ops-app 层里对 base 行 disable）

ops-app 同时对 base 的编码能力行逐个 disable（id 以源码实际行为准，执行时逐个核对）：

    - id: subagent-spawn-in-process
      disabled: true
    - id: subagent-fork-in-process
      disabled: true
    - id: workflow-ptc
      disabled: true
    - id: tool-workflow
      disabled: true
    - id: goal / goal-round-driver / command-goal / tool-goal   # 逐行 disable
    - id: plan-mode
      disabled: true
    - id: web / web-search-deepseek / web-fetch-http / tool-web
      disabled: true   # 运维 Agent 不需要 web 搜索（如需可回滚此行）
    - id: session-log-deepseek
      disabled: true

**注意**：tool-bash/fs/terminal 等在 web-app 层已因 preset realm 被 disable——ops-app 原样继承（不 override 即默认），并且 i2stream-ops preset 组合里也不再挂它们（纯运维面 D4）。

### 2.3 ops preset（i2stream-ops）升级为「默认运维 preset」

- agent.cordis.yml 增挂：skill-filesystem（customSkillDirs: [/hdd/demo/public/i2stream-bkn/skill]，27 个 SKILL.md）+ tool-skill。
- agent-presets 配置：default: i2stream-ops（Web 新会话默认即运维面）。
- persona 已含热路径知识（gen-hotpath-prompt.ts 生成，机制保持）。

### 2.4 源码改动点汇总（工作区 deepseek-harness 内）

| 文件 | 改动 | 上游同步影响 |
|------|------|--------------|
| $DSH_HOME/bundles/ops-app/cordis.patch.yml | **新建**（纯增量：disable 清单 + insert 追加）。**落点修订（执行期发现）**：不能放 packages/bundle/——上游 tsdown 按 glob packages/*/* 枚举全部包要求构建产物，会迫使我们改 tsconfig.host.json 聚合文件；移到 DSH_HOME 后由 profile 锚点解析（bundle 双锚点，profile.ts:827） | 零 merge 且上游仓库零文件新增——不引用上游行内容，只按 id 寻址 |
| packages/bundle/ops-app/README.md | **新建**（裁剪清单、维护策略、同步 checklist） | 同上 |
| profiles/ops/profile（新 DSH_HOME 内） | package.json 手写 bundles=[dsh-base, dsh-web-app, dsh-ops-app] + cordis.patch.yml（bkn-plugin/ops-api/mcp insert） | 零源码改动——自定义 profile 本就支持任意 bundles 列表（app-boot DEFAULT_PROFILE_BUNDLES 只是无模板时的默认值，manifest 可手写覆盖） |

> **对上游源码的净改动 = 0**：不改 profile.ts 加模板（手写 profile manifest 即可，见上表第三行），不改任何 bundle 包。ops-app 是唯一长期维护物，且它只包含「我们自己的增量声明」。可选 polish（help 文案加 --profile ops 示例）可提 PR 给上游，不提也不影响功能。

### 2.5 上游同步策略（扩展性设计）

**分层原则**——按「随上游升级的成本」从低到高排列我们所有资产的归属：

| 层 | 资产 | 升级跟随意图 |
|----|------|--------------|
| L0 纯增量声明 | ops-app disable 清单、profile cordis.patch.yml 的 bkn/ops-api/mcp insert、i2stream-ops preset | **自动跟随**：上游改自己的行内容 → 我们的声明不受影响；上游改行 id → 启动校验报出（见 checklist 第 2 条） |
| L1 外部插件（不进 harness 仓） | code/dsh-plugin（BKN 12 工具）、code/ops-api（api-server + admin）、code/presets | **按契约跟随**：只依赖 DSH 公开面（ctx.tools.register / tools/pre-execute 事件 / sessionController 远程面 / webServer.register / settings 域）。这些契约面由 self-test + 冒烟守护；DSH 大版本升级时跑一遍即可确认 |
| L2 对 harness 源码的直接修改 | 无（§2.4 已归零） | —— |

**升级操作手册（社区 DSH 发新版后执行）**：

1. **拉取与安装**：工作区 deepseek-harness git pull（或重新同步上游 tag）→ pnpm install → pnpm build:web。记录新版本号到本文档 §8。
2. **组合面校验（增量层）**：`pnpm dsh --profile ops --dump-config` 与上一版 diff——重点核对：a) 我们 disable 的 id 是否仍存在（上游删行 → dump 里该 id 消失 → 清单同步删除该条目）；b) 上游新增了哪些行（评审：运维面该不该关）；c) bundle 组合有无报缺依赖。
3. **契约面校验（外部插件）**：跑 dsh-plugin self-test + ops-api self-test（纯逻辑测试，不依赖 harness 内部）；再跑一轮 bench-4q 冒烟。
4. **管理面校验**：/admin 页打开、MCP 托管段读写一轮（若上游改了 patch 层语义/热更机制，§4.2 的托管段方案需要重估——这是 L1 里唯一接触 harness 内部机制的点，见风险表）。
5. **回填**：§8 记录版本、diff 结果、清单增删。若上游把「我们靠 disable 关掉的能力」改成了默认关闭，可从清单移除对应条目（清单保持最小化）。

**为什么这套结构对扩展性友好**：

- 新增能力的管理（以后要管 schedule/job/更多 MCP）= 往 ops-app 或 /admin 加条目，不动上游；
- 上游把某行改名/合并 = checklist 第 2 步 dump-config diff 一次性暴露，修的是我们清单里的一个 id，不是 merge 一片源码；
- DSH 若未来原生支持「profile 级工具白名单」等更优雅机制 = 把 ops-app 的 disable 清单逐步替换为原生机制，渐进迁移，两层并存不冲突。

---

## 3. 独立 api-server（D3）

### 3.1 ops-api 扩展 apiServer 配置段

    - id: ops-api
      config:
        apiServer:
          enabled: true
          host: 0.0.0.0      # 生产对外；试验期 127.0.0.1
          port: 8642         # 对齐 Hermes 端口习惯
          apiKey: '!!js process.env.OPS_API_KEY'   # 空 = 拒绝启动（fail-loud）
          cors: ''           # 预留，默认不发 CORS 头

### 3.2 实现要点

- **自建 listener**：node.createServer + 复用现有 handleChat/handleResponses/handleSessions/handleCapabilities/health handler（已是 (req,res) 形态，迁移成本低）；与 GUI webserver 同进程、同路由逻辑、不同端口。
- **鉴权**：Authorization: Bearer <key>，401 errorBody('unauthorized','authentication_error')；GUI 面（3081）的 /v1/* 保持现状（loopback + 可选 key），不破坏现有 bench。
- **不撞名**：不 mount 第二个 dsh-host-webserver（Service 名 webServer 单例）；自建 server 生命周期挂 ctx.on('dispose') 关闭。
- key 来源：env OPS_API_KEY；key 轮换管理列入 P5 按需项。

### 3.3 验收

    curl -H "Authorization: Bearer $OPS_API_KEY" :8642/v1/chat/completions   # 200
    curl :8642/v1/chat/completions                                           # 401
    curl :8642/health                                                       # 200（health 不鉴权，供探活）

---

## 4. 管理面（D2）：/admin REST + 管理页

### 4.1 范围与持久化策略

| 管理对象 | v1 能力 | 持久化 | 生效方式 |
|----------|---------|--------|----------|
| **MCP server** | 列表 / 新增 / 编辑 / 启停 | profile cordis.patch.yml 托管段（§4.2） | patchReload: live 热生效（mcp-client 编辑配置即原地重连，README 已确认）（注：`patchReload` 键已在 harness v0.1.7 移除——config 监视改由 base 层 hmr 行默认提供，详见 dsh-plugin-reading-guide §5） |
| **skill** | 列表（扫 customSkillDirs）/ 按 skill 启停 | settings.yaml ops-admin 段（disabledSkills） | ops-admin 插件 hook skill 注册表过滤；新会话生效 |
| **工具** | 只读清单（名字/来源/描述） | — | 只读（v1）；开关涉及 preset realm，列入 v2 |
| **preset** | 只读列表 + agent.cordis.yml 查看 | — | 只读（v1）；编辑列入 v2（preset 是受信组合，写入需校验） |
| **系统状态** | 聚合 /health（Gateway/Qdrant/i2agent MCP/embedder） | — | 只读 |

### 4.2 MCP CRUD 的「托管段」写法

ops-admin.ts（新插件，可并入 ops-api 代码目录）以 BEGIN/END OPS-ADMIN MANAGED 标记注释圈出 cordis.patch.yml 里自己管理的 insert 区：

- 读：解析 YAML → 定位标记区间；
- 写：read-modify-write（原子写 tmp+rename）→ watcher 触发 live reload → loader 增删对应 mcp-* 行；
- 并发：写前 revision 校验（If-Match 语义），防双开覆盖；
- 风险控制：新增 MCP server 的 command/url 会进入模型工具面——管理 API 需 admin key（§4.3），写入前 schema 校验（serverName 字符集 / transport 枚举）。

### 4.3 管理页与鉴权

- 管理页：静态单页（单 HTML + 原生 JS，无构建链），挂 GUI 端口 /admin 路由（ops-admin 注册 exact 路由，优先于 SPA fallback）。
- 鉴权：独立 OPS_ADMIN_KEY（与 API key 分离）；页面首次输入后存 localStorage，请求带 Authorization: Bearer。
- /admin/* 全部注册在 GUI webserver（3081），不经 8642（管理面不出网）。

### 4.4 验收

    MCP:  POST /admin/mcp {name,url} → patch.yml 托管段出现条目 → 不重启，新会话可见 mcp__<name>__* 工具
    skill: POST /admin/skills/<name>/disable → 新会话该 skill 不在目录
    页面: /admin 可完成上述操作并显示系统状态

---

## 5. 分阶段实施

| 阶段 | 内容 | 验收 | 预估 |
|------|------|------|------|
| **E0 试验环境** | 工作区 harness pnpm install（store 热，可试 --frozen-lockfile）+ pnpm build:web（frontend dist，web-runtime 依赖）；建 DSH_HOME=.dsh-home（从 /root/.dsh 拷 settings.yaml/.credentials.yaml）；建 profiles/ops（package.json bundles=[dsh-base,dsh-ops-app]） | DSH_HOME=... pnpm dsh --profile ops 起在 :3081，GUI 可开 | 0.5 天 |
| **E1 编排落地** | §2 全部：ops-app bundle + PROFILE_TEMPLATES + preset 升级 + base disable 清单 | GUI 对话走通（BKN 工具/skill/MCP 可见）；工具清单=纯运维面；bench 4 题无回归 | 1 天 |
| **E2 api-server** | §3：apiServer 配置段 + 自建 listener + Bearer | :8642 契约全绿（401/200/stream/多轮/记忆 key）；bench 指 :8642 跑通 | 0.5-1 天 |
| **E3 管理面** | §4：ops-admin 插件 + /admin REST + 管理页 | §4.4 全部；MCP 热增删实测不重启生效 | 1.5-2 天 |
| **E4 验收与切换决策** | 端到端：「日志分析」对话（i2agent MCP 链路）+ 管理操作 + API 调用三方联测；文档回填 | 场景跑通 → 决定现网是否切 ops 编排（或保留双实例） | 0.5 天 |

每阶段通用 DoD：dsh-plugin/ops-api 存量 self-test 断言不破 + 新增段全绿；改动回填本文档。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| **上游社区更新后的编排跟随**（用户核心关切） | §2.5 同步策略：对上游源码净改动=0（ops-app 纯增量 + manifest 手写）；升级手册 5 步（install → dump-config diff 组合面 → self-test 契约面 → 管理面 → 回填）；L0/L1 分层让大部分资产自动跟随，仅行 id 变更需手工对齐 |
| 工作区 harness（0.1.6-alpha.1）与现网运行版（0.1.5-rc.1 @/hdd/agent）版本漂移 | 试验实例完全用工作区源码自洽运行；成熟后现网升级再切换；两版本差异在 E0 起步时 diff 确认 |
| 上游改变 patch 层语义 / 热更机制（影响 §4.2 托管段方案） | E3 最小验证先行；托管段只依赖「按 id 覆写 + watchUserPatches」两个已文档化行为，若真变更，降级为重启生效并更新方案 |
| pnpm install 离线失败 / build:web 耗时 | store v11 已有 1266 包，优先 frozen-lockfile；build:web 一次性成本；失败则回退「复用 /hdd/agent 已装依赖 + patch 裁剪」双轨 |
| 裁剪过狠导致依赖链断裂（client 行被删但 host 行仍 inject 其服务） | 按 client↔host 配对逐行删除；起不来用 --dump-config 定位；每删一批重启验证 |
| patch.yml 托管段被人工编辑冲突 | 标记区间 + revision 校验 + 原子写；文档声明托管段内不要手改 |
| api-server 0.0.0.0 对外暴露面 | 强制 key（空 key 拒绝启动）；生产建议前置防火墙/反代；health 不带敏感信息 |
| MCP 热增删 live reload 行为未验证 | E3 第一件事做最小验证（手改 patch 加 mcp 行→观察热生效）；不生效则降级「写入成功+提示重启」并如实标注 |
| 纯运维面误删 GUI 必要件 | §2.1 白名单思维：只删明确无用行；E1 用 GUI 完整走查（开会话/改模型/切 preset/看 settings） |

---

## 7. 明确不做（本期）

- sessions 真删除 / Gateway 切 TCVDB+COS / 工具与 preset 在线编辑（gap-exec P5 按需项，维持原判）
- 多租户、TLS 终结（交前置反代）
- Hermes 侧兼容层维护（api-server 契约已对齐，Hermes 退役）

---

## 8. 回填记录

- 2026-09-15 方案形成（决策 D1-D5 用户拍板；webserver 单例约束、patchReload live、mcp-client 原地重连等事实已核实）。
- 2026-09-15 D1 修订（用户补充「上游更新后编排需可跟随」）：fork 改为**增量 bundle 层**（disable 而非删除，不引用上游行内容）；PROFILE_TEMPLATES 源码修改取消（manifest 手写即可）→ **对 harness 源码净改动归零**；新增 §2.5 上游同步策略（L0/L1 分层 + 5 步升级手册）。
- 2026-09-15 执行期修订：ops-app 落点从 packages/bundle/ 移到 $DSH_HOME/bundles/ops-app/（上游构建聚合按 glob 枚举 workspace 包，放进去须改上游 tsconfig.host.json——净改动为零原则把它挤出仓库）；bundle 双锚点解析使 profile file: 依赖即可加载，上游仓库零文件新增。
- 2026-09-15 E0-E4 全部验收通过（细节见 exec-plan）。切换决策：**方案 a 双实例并存**——现网 :3080 不动，试验实例（.dsh-home，:3081 GUI + :8643 API + /admin 管理面）由 systemd `dsh-ops-trial.service` 托管投产验证；观察期检查单与升级跟随手册见 doc/ops-trial-operations-manual.md。转正候选动作：停现网实例 → 8642 归属确认后迁回 → sessions/记忆 key 迁移评估。
- （实施后逐阶段回填）
