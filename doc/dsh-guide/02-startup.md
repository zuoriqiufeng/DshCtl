# 02 · 启动流程：从命令到插件树跑起来

**本篇你会学到**：`pnpm dsh web` 之后发生的完整链路（15 步编号表）；web 和 headless 差在哪三个分叉点；启动失败时报错是怎么分级的；一次 HTTP 请求进来后怎么走到工具执行。

> ⚠️ **版本锚点**：本篇 file:line 核实于 `0d1f50007f`（v0.1.6-alpha.1）；上游已升级至 `00102833df`（v0.1.7-alpha.2，2026-09-23），行号普遍漂移 10~25 行。本轮已逐行复核并更新全表（15 步 + 请求路径，均附旧值）；漂移对照表见 [dsh-plugin-reading-guide.md §5](../dsh-plugin-reading-guide.md#5-版本锚点与漂移警告)。

---

## 1. 极简流程（先记这 5 行骨架）

```
argv ──▶ 解析成 invocation（dsh web 就是 --profile web 的别名）
    ──▶ composeProfile：按层序叠 patch（bundle → profile → home → --patch）
    ──▶ boot()：new Context → 设 baseUrl → 挂 Loader → 挂根 Include
    ──▶ applyEntryPatches：patch 栈打到空根 []，产出 entry 列表 → 逐行 import 成 Fiber
    ──▶ audit 启动审计 → live HMR 监视 → appReady.commit()，进程交给插件
```

核心思想：**profile 根配置是一个空数组 `[]`，整棵树 100% 由 patch 层合成**——所以「加插件 / 禁插件」永远是改 patch，从不改根文件。

---

## 2. 15 步详解

前置事实：`pnpm dsh` = 根 `package.json:198` 的 `node --import tsx/esm apps/cli/src/bin.ts`；发布态 bin 是 `apps/cli/package.json:14-16`。`web` 是硬编码别名（`apps/cli/src/args.ts` 头部注释：`` `dsh <name>` abbreviates `dsh --profile <name>` ``）。

| # | 步骤 | 位置 | 干什么 |
|---|---|---|---|
| 1 | 进程入口 | `deepseek-harness/apps/cli/src/bin.ts:78-79` | `import.meta.main` → `runCli()` |
| 2 | 解析 argv | `apps/cli/src/bin.ts:30-32` | `parseDshArgs` 只解析 launcher 自有 flag（profile/patch/dump），其余透传给 app |
| 3 | 分派 profile 模式 | `apps/cli/src/bin.ts:34-45` | 懒加载 `profile-boot.ts` 的 `runProfile()`，带冻结的环境快照 |
| 4 | 代理 + 组合 | `apps/cli/src/profile-boot.ts:247, :263` | 先 `installProxyFromEnvironment`（首个请求前生效），再 `composeProfile()` |
| 5 | 加载 profile、重写空根 | `apps/cli/src/profile-boot.ts:166, :202` | `prepareProfile` 读 `$DSH_HOME/profiles/<name>`；应用自有 profile 每次启动把 `PROFILE_ROOT_CONFIG`（空数组 `[]`，常量定义在 `:80`）写回 `cordis.yml`（防 Loader 写回把合成行烘焙进文件） |
| 6 | 叠 patch 栈 | `apps/cli/src/profile-boot.ts:183-190`（层序 JSDoc）、`:195-206`（`composeProfile`） | 层序：bundle 层 → profile 自己的 patch → home 层 → `--patch` overlay |
| 7 | 进程护栏 | `apps/cli/src/profile-boot.ts:280` | SIGTERM/SIGINT 处理 + `installFailLoud`（晚到的未处理 rejection → 诊断 + exit 1） |
| 8 | 调 `boot()` | `apps/cli/src/profile-boot.ts:294-312` | prepare 回调在**任何配置树挂载前**注入 launch 环境、装 PluginPackages、`provideCmdline` |
| 9 | Context + baseUrl + Loader | `deepseek-harness/packages/boot/app-boot/src/index.ts:961, :976, :983` | `new Context()` → 设 `ctx.baseUrl`（**相对路径解析的锚**）→ `ctx.plugin(Loader)` |
| 10 | 挂根 Include | `packages/boot/app-boot/src/index.ts:524`（`mountRootInclude`）、`:530, :548`（内建 `include`/`group` 注册） | 根 include 挂入，patch 栈塞进它的 config |
| 11 | 打 patch | `deepseek-harness/vendor/include/src/index.ts:57`（语义）/ `:240`（调用点） | `applyEntryPatches`：空根 + 全部层 → 最终 entry 列表（dump-config 复用同一函数保证不漂移） |
| 12 | Loader drain | `packages/boot/app-boot/src/index.ts:992` | `ctx.get('loader')?.await()` 等到没有 pending 的 import/生命周期任务——**drain 不让整棵树 reject** |
| 13 | 启动审计 | `packages/boot/app-boot/src/index.ts:994` → `:907`（`auditStartupEntries`） | 收集 import 失败/disabled 炸/FAILED/缺 inject 的 entry；required 集合失败 → throw，其余只 warn |
| 14 | live HMR（仅 web） | `packages/boot/hmr/src/watch-config.ts`（chokidar 监视 patch 精确路径） | `patchReload==='live'` 时监视用户 patch 文件（旧锚点称在 `profile-boot.ts:375-402`，v0.1.7 已重构出去） |
| 15 | Ready | `apps/cli/src/profile-boot.ts:315` | `appReady.commit()`；此后进程寿命由插件持有（如 webserver `listen`） |

> 上表为 v0.1.7-alpha.2 实测；旧锚点（v0.1.6-alpha.1）依次为 `bin.ts:64-66/28-31/31-41`、`profile-boot.ts:294-308/191-196/232-253/311-329/352-368`、`app-boot/src/index.ts:867-887/889/895/897`、`include/src/index.ts:238-240`、`profile-boot.ts:407-412`。

失败路径：boot 内任何一步 throw → dispose 半成品树（`app-boot/src/index.ts:1000` 的 `ctx.fiber.dispose()`），以 `binName: 阶段标签: …` 重抛——**报错里的 stage 名就是上面这张表的坐标**。

---

## 3. web vs headless：三个分叉点（都不在 boot() 代码里）

| 分叉 | web | headless | 位置 |
|---|---|---|---|
| 1. CLI 解析 | `dsh web`（别名） | `dsh --profile headless` | `apps/cli/src/args.ts` 头部注释（`dsh <name>` 缩写规则） |
| 2. 模板选 bundle + reload 策略 | `dsh-base + dsh-web-app` | `dsh-base + dsh-headless` | `packages/boot/app-boot/src/profile.ts:156-166`（`PROFILE_TEMPLATES`） |
| 3. bundle 行决定挂什么 | web-app patch 插 `webserver`/`modules`/`connection` | headless patch 「mounts no Host, HTTP server, Web runtime」，只插 `headless-startup`/`headless-runner` | 各 bundle 的 `cordis.patch.yml` |

审计两侧共用同一 required 集合（`app-boot/src/index.ts:728-736` 的 `requiredStartupEntryIds`：`agent-loop, webserver, modules, connection, headless-runner, acp, sdk-jsonrpc-server`），缺席即忽略——所以**同一个 boot() 能跑出两种形态**，差别全在配置。

---

## 4. 一次请求的路径（简图）

```
浏览器 fetch/SSE
  → HTTP 服务           packages/host/webserver/src/index.ts:243（createServer）/ :295（listen）
  → /api 路由桥          packages/client/connection/src/api-path.ts:7（API_PATH = '/api'）
  → Typert Gateway 分发   packages/api/gateway/src/index.ts:412（dispatchRpc）
  → Session Remote        packages/api/session-controller/src/index.ts:408（prompt）
                          → commands.ts:311（prompt）→ :373（agent.followup）
  → Agent 一轮            packages/core/agent-loop/src/agent.ts:295（turn）
                          一轮 turn = 0..n 个 step；一个 step = 一次模型请求
                          （概念出处 docs/architecture.zh.md「轮次流程」节，:88 起）
  → 工具执行              agent.ts:39（executeToolCalls，来自 tool-calls.ts）
                          三个 waterfall：pre-execute → execute → post-execute
                          （packages/core/tools/src/index.ts:1505 / :1605 / :1781）
  → 结果回 inbox，还欠工具调用则开下一 step；turn 结束发 turn/end
```

> 上列行号为 v0.1.7-alpha.2 实测；旧锚点（v0.1.6-alpha.1）为 `webserver:242/:294`、`gateway:169/:352`、`session-controller:347-349`、`commands.ts:299/:361`、`agent.ts:270/:489`、`tools/index.ts:1483/:1583/:1741`。

配套官方时序图**不要重画，直接看**：
- `deepseek-harness/docs/agent-lifecycle.md`（turn/step 时序图）
- `deepseek-harness/docs/tool-execution-pipeline.md`（三 waterfall 管线图）

---

## 自测

1. profile 根 `cordis.yml` 里为什么是空数组？（答：整树由 patch 合成，防写回烘焙）
2. `web` 和 `headless` 共用哪段代码、差在哪三层配置？（答：boot()；CLI 别名 / 模板 reload 策略 / bundle 行）
3. 启动报错里的 stage 名对应本篇哪一步？（答：15 步表的坐标）

## 延伸阅读

- 深挖（每步 file:line 证据）：`doc/dsh-plugin-internals.md` §1 loader、§2 profile 装配。
- 官方：`deepseek-harness/docs/architecture.md`（Application launch）、`docs/cordis-tutorial/06-composition-and-hmr.md`。
- 下一篇：[03-cordis-concepts.md](03-cordis-concepts.md)——启动过程里出现的 Context/Fiber/Service 到底是什么。
