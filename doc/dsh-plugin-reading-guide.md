# 官方插件文档阅读指南

> 用途：把 `deepseek-harness/docs/` 里与「插件机制 / 怎么写插件 / 怎么加插件」相关的官方文档，按**认知顺序**串成一条可执行的阅读路线。
> 面向：要写或改 dsh 插件、但被官方 176 篇文档绕晕的人。
> 定位：**索引与导读**，不重述内容。事实一律链到官方原文；源码级证据链到 `doc/dsh-plugin-internals.md`。

---

## 0. 先解决最大的困惑：`cordis.yml` 为什么一处要写、一处是空的

官方文档有**两条并行的教学线**，都用 `cordis.yml` 这个名字，但装配机制完全不同。不知道这一点，读文档会持续撞墙。

| | **Cordis 教程线** | **Harness 产品线** |
|---|---|---|
| 入口 | `docs/cordis-tutorial/index.zh.md` | `docs/user/develop/basic/index.zh.md` |
| 启动方式 | `node --import tsx ../../vendor/cordis/bin.js` | `pnpm dsh web --patch ./xxx/cordis.yml` |
| 谁读配置 | 独立启动器 `vendor/cordis/bin.js`（16 行，自己 `ctx.loader.create({ path: './cordis.yml' })`） | 产品启动器 `apps/cli`，走 profile 装配 |
| `cordis.yml` 身份 | **真·入口列表**，必须写 `- name: './hello.ts'` | profile 里是**空数组 `[]`**，树由 patch 层合成 |
| 要改的文件 | 那个 `cordis.yml` 本身 | 同目录的 **`cordis.patch.yml`**（或 `--patch` overlay） |
| 目的 | 脱离产品，纯学 Cordis 运行时 | 写能进真实 dsh 的插件 |
| 文档站路由 | `/develop/cordis-tutorial/` | `/develop/basic/`、`/develop/framework/`、`/develop/practice/` |

产品线的空根是硬约定：`apps/cli/src/profile-boot.ts:80` 把 `PROFILE_ROOT_CONFIG`（内容就是 `[]` 加一段注释）写死，应用自有 profile 每次启动还会重写它。所以你工作区 `.dsh-home/profiles/ops/cordis.yml` 里那个 `[]` 是**生成物，改它无效**。

**结论：教程线教概念，产品线教落地，两条都要读，但别把教程线的写法搬到产品线。**

---

## 1. 阅读路线（四站，前三站约 4 小时）

### 第一站 · 概念（约 40 分钟）

先建立词汇表，否则后面每页都要停下来猜词。

| 文档 | 行数 | 读它是为了 |
|---|---|---|
| [docs/cordis-primer.zh.md](../deepseek-harness/docs/cordis-primer.zh.md) | 51 | **全仓密度最高的一页**：插件是 Service、上下文是容器、inject 声明依赖、五种事件分发模式、注册是可逆副作用、loader 配置 |
| [docs/architecture.zh.md](../deepseek-harness/docs/architecture.zh.md) | 168 | profile / bundle 分工、四层层叠顺序、核心包地图、"不存在需要打补丁的特权内核" |

### 第二站 · Cordis 教程七章（约 2 小时，建议动手跑）

在 [docs/cordis-tutorial/](../deepseek-harness/docs/cordis-tutorial/index.zh.md)。每章都是可运行的最小例子，写进 `tmp/cordis-tutorial/`（已被 git 忽略）。**跟着敲一遍比读十遍有用。**

| 章 | 行数 | 你会学到 |
|---|---|---|
| [01-first-plugin](../deepseek-harness/docs/cordis-tutorial/01-first-plugin.zh.md) | 95 | 插件 = 导出 `apply(ctx)`；`cordis.yml` 是入口列表；三种插件形态；模块拼错为什么静默 |
| [02-lifecycle-and-effects](../deepseek-harness/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md) | 98 | 卸载时注册怎么回卷；`ctx.effect()` 返回 disposer |
| [03-services](../deepseek-harness/docs/cordis-tutorial/03-services.zh.md) | 98 | `ctx.xxx` 怎么提供/消费；**为什么加载顺序与文件位置无关**；PENDING 静默 |
| [04-events](../deepseek-harness/docs/cordis-tutorial/04-events.zh.md) | 144 | 声明合并补事件类型；waterfall 短路 |
| [05-config](../deepseek-harness/docs/cordis-tutorial/05-config.zh.md) | 111 | Config 接口 + schema 同导出；`!!js` 表达式；volatile 字段 |
| [06-composition-and-hmr](../deepseek-harness/docs/cordis-tutorial/06-composition-and-hmr.zh.md) | 113 | **最该细读的一章**：条目元数据（`id`/`disabled`/`group`）、HMR、PENDING 诊断法 |
| [07-into-the-harness](../deepseek-harness/docs/cordis-tutorial/07-into-the-harness.zh.md) | 108 | 用真实 `ctx.tools` 注册模型可调用的工具，观察 `tools/result` |

### 第三站 · 产品线：写真正进 dsh 的插件（约 1.5 小时）

在 [docs/user/develop/](../deepseek-harness/docs/user/develop/basic/index.zh.md)。**`code/` 下那三个自研插件走的就是这条路径。**

| 文档 | 行数 | 读它是为了 |
|---|---|---|
| [basic/index.zh.md](../deepseek-harness/docs/user/develop/basic/index.zh.md) | 144 | 第一个 Harness 插件：`--patch` overlay 挂进 Web UI；**插件路径必须绝对路径** |
| [basic/tool.zh.md](../deepseek-harness/docs/user/develop/basic/tool.zh.md) | 52 | 最短路径加一个工具 |
| [basic/config.zh.md](../deepseek-harness/docs/user/develop/basic/config.zh.md) | 106 | Config 设计原则：**不同部署可能取不同值的参数必须做成配置字段** |
| [basic/publish.zh.md](../deepseek-harness/docs/user/develop/basic/publish.zh.md) | 189 | 打成组合包、`dsh plugin add`、**四层层叠顺序讲得最系统的一篇** |
| [framework/index.zh.md](../deepseek-harness/docs/user/develop/framework/index.zh.md) | 137 | Fiber 六状态机、依赖驱动加载、自动清理清单 |
| [framework/service.zh.md](../deepseek-harness/docs/user/develop/framework/service.zh.md) | 150 | 服务深入：provide/inject、可选依赖用 `ctx.get` |
| [framework/events.zh.md](../deepseek-harness/docs/user/develop/framework/events.zh.md) | 143 | 事件深入 |
| [practice/index.zh.md](../deepseek-harness/docs/user/develop/practice/index.zh.md) | 155 | **能力三层拆分**（Definition / Provider / Consumer）——本工作区 L0/L1/L2 资产分层的理论依据 |
| [practice/dynamic-cordis.zh.md](../deepseek-harness/docs/user/develop/practice/dynamic-cordis.zh.md) | 15 | 让 agent 自己装插件（plugin_manager） |

### 第四站 · 参考手册（按需查，不要通读）

| 文档 | 行数 | 什么时候查 |
|---|---|---|
| [cookbook/adding-a-tool.zh.md](../deepseek-harness/docs/cookbook/adding-a-tool.zh.md) | 103 | **工具定义的真源**：execute 约定、规范值、后台任务、策略与观测、UI 卡片 |
| [cookbook/extension-cookbook.zh.md](../deepseek-harness/docs/cookbook/extension-cookbook.zh.md) | 136 | 各类扩展形态 + **「功能→机制映射表」**（每个产品功能对应哪个扩展点） |
| [tool-execution-pipeline.zh.md](../deepseek-harness/docs/tool-execution-pipeline.zh.md) | 67 | 一次工具调用从 pre-execute 到 result 的完整时序（含 mermaid 图） |
| [capability-seams.zh.md](../deepseek-harness/docs/capability-seams.zh.md) | 662 | 所有服务/提供方/消费方的依赖图——想知道 `ctx.xxx` 有哪些、谁提供的 |
| [subsystems/tools.zh.md](../deepseek-harness/docs/subsystems/tools.zh.md) | 746 | 工具子系统完整契约，查细节 |
| [cookbook/adding-a-package.zh.md](../deepseek-harness/docs/cookbook/adding-a-package.zh.md) | 172 | **只有往 harness 仓里加包才用**（本工作区净改动=0，用不上） |

---

## 2. 官方文档地图与计数

`deepseek-harness/docs/` 当前共 **176 篇英文**（171 篇配 `.zh.md` 中文对侧；无配对的 5 篇是 `AGENTS.md`、`cordis-api/inherited.md` 与 `i18n/` 下 3 篇维护规范）。

| 分类 | 篇数 | 说明 |
|---|---|---|
| 顶层 `docs/*.md` | 21 | 总纲 `architecture`、`cordis-primer`、生成式目录（`config-catalog` / `tool-catalog` / `persistence-catalog`）、事故复盘入口等 |
| `docs/subsystems/` | 63 | 一页一子系统：`core` / `session` / `tools` / `web-server` / `sandbox` / `mcp` …（每页带生成的 `cordis-surface` 区块） |
| `docs/persistence-changes/` | 39 | 持久化类型变更记录（`releases/` 27、`historical-formats/` 5、本体 7）——只在动 session 格式时查 |
| `docs/user/` | 18 | 产品向：`guide/` 7（入门、模型配置、代理、SDK…）、`develop/` 10、`user/index.md` 1 |
| `docs/cookbook/` | 11 | 动手配方：adding-a-package / adding-a-tool / adding-an-llm-adapter / adding-a-remote-api … |
| `docs/cordis-tutorial/` | 8 | 教程线（index + 7 章） |
| `docs/cordis-api/` | 6 | 生成式 API：context / fiber / service / registry / events / inherited |
| `docs/postmortem/` | 5 | 事故复盘（改代码前读） |
| `docs/i18n/` | 5 | 双语维护规范 |
| 合计 | **176** | |

**查法口诀**：概念 → primer；做事 → cookbook；某子系统不熟 → subsystems；改代码前 → postmortem。**不要在新文档里重新定义术语**——官方 `docs/AGENTS.md:15` 的原则是 "one home per fact"（一个事实只有一个家）。

---

## 3. 三个阅读技巧

**中英对照**：每篇都有 `.md`（英）与 `.zh.md`（中）配对，中文是"经评审的对侧"，偶有滞后。术语拿不准时对英文原版。

**看渲染版**：文档带 mermaid 图，终端看不到。仓库自带文档站：

```sh
cd deepseek-harness && pnpm docs:dev     # → http://127.0.0.1:5173
```

路由由 `website/docs.ts` 定义：教程线 `/develop/cordis-tutorial/`，产品线 `/develop/basic/`、`/develop/framework/`、`/develop/practice/`，参考线 `/reference/`。只起开发服务器、不写源码，不违反净改动=0 规则。

**按关键词定位而非行号**：上游升级后行号会漂移（见 §5），用函数名/注释关键词 grep 比记行号可靠。例如找 patch 语义：`grep -rn "THE patch semantics" vendor/include/src/`。

---

## 4. 与本工作区已有文档的分工

| 想干什么 | 看哪 |
|---|---|
| **读官方插件文档**（本篇） | 本文件 |
| **学** DSH/Cordis 整体心智模型 | `doc/dsh-guide/` 01→06（中文导读系列） |
| **挖** 源码行号级证据 | `doc/dsh-plugin-internals.md`（loader/patch/inventory/服务/工具/HMR 七主题） |
| **懂** 工作区编排规则与红线 | 工作区 `AGENTS.md`（R1-R12、降级铁律、协议要点） |
| **用** dshctl/GUI | `doc/dshctl-user-manual.md` · `doc/dshctl-manual.md` |

分工原则：官方文档讲「应该怎么用」，`dsh-guide` 讲「怎么串起来学」，`internals` 讲「实际怎么实现的」——**一个事实只在官方文档有一个家，本工作区文档只做索引与源码证据，不重新定义术语**。

---

## 5. 版本锚点与漂移警告

⚠️ **本工作区的 harness 副本已升级，现有导读文档中的版本锚点与计数已过期。**

| | 旧锚点（文档中现存） | 当前实际 |
|---|---|---|
| git revision | `0d1f50007f`（clone 于 2026-09-15） | `00102833df`（`release-dsh-0.1.7-alpha.2`，pull 于 2026-09-23 17:31） |
| 版本 | `0.1.6-alpha.1` | `0.1.7-alpha.2` |
| 距旧锚点 | — | **2343 个提交** |
| 官方文档数 | 167 篇 | **176 篇** |
| subsystems | 58 篇 | **63 篇** |

**行号漂移实测**（旧引用 → 当前实际；已回填进 `dsh-guide/` 各篇）：

| 引用位置 | 旧行号 | 现行号 |
|---|---|---|
| `apps/cli/src/profile-boot.ts` 空根常量 `PROFILE_ROOT_CONFIG` | 88-92 | 80 |
| `apps/cli/src/profile-boot.ts` 层序 JSDoc | 212-219 | 183-190 |
| `apps/cli/src/profile-boot.ts` `appReady.commit()` | 407-412 | 315 |
| `apps/cli/src/bin.ts` `import.meta.main` | 64-66 | 78-79 |
| `packages/boot/app-boot/src/index.ts` `new Context()` | 867 | 961 |
| `packages/boot/app-boot/src/index.ts` `auditStartupEntries` | 818-835 | 907 |
| `packages/boot/app-boot/src/index.ts` `requiredStartupEntryIds` | 711-719 | 728-736 |
| `vendor/loader/src/index.ts` `class Loader` | 65 | 77 |
| `vendor/loader/src/config/entry.ts` `get disabled()` | 72-82 | 74 |
| `vendor/loader/src/config/entry.ts` `disabledOf()` | 84-92 | 89 |
| `vendor/include/src/index.ts` `applyEntryPatches` | 57-127 | 57 |
| `vendor/cordis/src/reflect.ts` `provide()` | 267-305 | 277 |
| `vendor/cordis/src/fiber.ts` `Fiber` 类 | 178-183 | 184（JSDoc 179） |
| `packages/core/tools/src/index.ts` pre-execute 调用点 | 1482-1486 | 1505 |
| `packages/core/tools/src/index.ts` `tools/execute` | 1583 | 1605 |
| `packages/core/tools/src/index.ts` `tools/post-execute` | 1741 | 1781 |
| `packages/core/tools/src/index.ts` `register()` | 1043-1068 | 1062 |
| `packages/core/tools/src/schema.ts` `defineTool` | 545 | 554 |
| `packages/core/agent-loop/src/agent.ts` `turn()` | 270 | 295 |
| `packages/host/webserver/src/index.ts` `createServer` / `listen` | 242 / 294 | 243 / 295 |

普遍漂移 **10~25 行**，结论与语义未变。**唯一的结构性迁移**：配置监视器从 `packages/boot/app-boot/src/watch-config.ts` 搬到 `packages/boot/hmr/src/watch-config.ts`（旧锚点整个路径失效，不是行号漂移）。

**⚠️ 一个被移除的配置键（影响本工作区）**：v0.1.6 的 profile manifest 有 `dsh.profile.patchReload: 'live' | 'startup'` 控制是否监视 patch 文件；v0.1.7 的 `DshProfileManifest` 只剩 `bundles?: string[]`（`packages/util/package-manifest/src/types.ts:75-78`），源码中已无代码读取 `patchReload`（`grep -rn patchReload --include="*.ts" packages/*/*/src apps/*/src` 为空；`packages/boot/app-boot/lib/` 下的命中是 gitignore 的陈旧编译产物）。行为改由 bundle 行表达：base 层 `disabled: !!js "!ctx.get('profileContext')"` 启用 hmr（`packages/bundle/base/cordis.patch.yml:28-32`），headless/sdk-app/acp-app 各自 `- id: hmr / disabled: true`（如 `packages/bundle/headless/cordis.patch.yml:33-34`）。

**本工作区需跟进**：`code/dshctl/render.ts:33` 生成的 profile manifest 仍写 `patchReload: 'live'`，`.dsh-home/profiles/ops/package.json` 里也有——在新版本下是**死键**（不报错、不生效，config 监视改由 base 的 hmr 行默认提供）。行为上仍等价（web 面继续热重载配置），但生成物应清理该键，否则后续 dshctl 版本核对会误判。这属 `AGENTS.md §6` 升级 5 步里「组合面 diff」应捕获的项。

已回填范围：`dsh-guide/` 的 01、02、04、05 篇主要行号已按 v0.1.7-alpha.2 实测更新（旧值一并保留）；03、06 篇只更新了交叉引用与计数，正文行号未逐一复核。`dsh-plugin-internals.md` 保留原行号并在头部加了过期警告（它的价值在源码结论，不在行号）。

**连带影响**：`domains/.cache/dump-config-0.1.6-alpha.1.json`（dshctl 的 R2 roster 缓存，版本号命名）对应旧版本，上游升级后该缓存已失效；按 `AGENTS.md §6` 升级 5 步，还需完成 `--dump-config` 组合面 diff、self-test 契约面核对与管理面校验并回填 plan §8。

**⚠️ 升级尚未生效到运行实例**：`git pull` 只更新了磁盘上的源码，运行中的进程仍持有旧模块（tsx 在启动时加载）。实测：

| 实例 | 端口 | 工作目录 | 版本 | 启动时间 |
|---|---|---|---|---|
| 现网 web GUI | 3080 | `/hdd/agent/deepseek-harness`（**另一棵树**，v0.1.5-rc.1） | 0.1.5-rc.1 | 2026-09-15 |
| ops 试验实例 | 8643 | `/hdd/demo/public/dsh-info/deepseek-harness` | 0.1.6-alpha.1（内存中） | 2026-09-17 |

所以：**3080 用的是 `/hdd/agent` 那棵树，重启它也不会用上工作区的 0.1.7-alpha.2**；工作区升级只影响 8643 试验实例，且必须重启（`run-ops-trial.sh restart` 或 systemd）才会生效。重启前不要按本篇的新行号去比对运行中实例的行为。

**升级后还要留意**：试验实例一旦重启到 0.1.7-alpha.2，`dshctl` 的 R2 roster 缓存（`domains/.cache/dump-config-0.1.6-alpha.1.json`）会与新实例对不上，`check ops --ci` 会重建缓存（约 180s）并可能报出上游新增/消失的 id——这正是 `AGENTS.md §6` 升级 5 步要处理的事。

---

## 延伸阅读

- 官方总纲：[docs/architecture.zh.md](../deepseek-harness/docs/architecture.zh.md)、[docs/AGENTS.md](../deepseek-harness/docs/AGENTS.md)（文档标准）
- 概念精要：[docs/cordis-primer.zh.md](../deepseek-harness/docs/cordis-primer.zh.md)
- 源码级深挖：`doc/dsh-plugin-internals.md`
- 中文导读系列：`doc/dsh-guide/README.md`
