# 01 · 整体架构：everything-is-a-plugin

**本篇你会学到**：DSH 到底是个什么东西；六层架构怎么分；Context / Fiber / Service / Entry / Patch 这些核心对象谁管谁；本工作区（dshctl、插件库、profile）落在图的哪个位置。

> ⚠️ **版本锚点**：本篇 file:line 核实于 `0d1f50007f`（v0.1.6-alpha.1）；上游已升级至 `00102833df`（v0.1.7-alpha.2，2026-09-23），行号普遍漂移 10~25 行。本轮已复核并更新主要行号（Loader / boot()，均附旧值）；漂移对照表见 [dsh-plugin-reading-guide.md §5](../dsh-plugin-reading-guide.md#5-版本锚点与漂移警告)。

---

## 1. 一句话心智模型

> **DSH = vendored Cordis 框架 + 全部业务插件 + 配置装配层。**

官方原话（`deepseek-harness/docs/architecture.md:11`）：

> plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin … so each is replaceable from configuration.

翻译成人话：

1. **没有特权内核**——模型调用、会话日志、工具、Web 服务器……全都是插件，换掉某个插件 = 改一行配置，不碰框架源码。
2. **框架层是 vendored 的**——Cordis 框架源码直接放在 `vendor/` 里，harness 完全拥有它（可审计、可打补丁、锁版本），见 `deepseek-harness/vendor/README.md:1-3`。
3. **一切通过一个共享的 Context 协作**——插件向 Context 贡献服务（Service）、注册事件、留下可撤销的 effect。

出处：`deepseek-harness/README.md:7`（everything-is-a-plugin）、`deepseek-harness/AGENTS.md:3`（"an all-plugin Cordis agent harness"）。

---

## 2. 六层架构

```
deepseek-harness/  （pnpm workspace monorepo）
│
├─ L0 框架核心层 —— vendor/cordis
│    Service / Fiber / Context / 事件 的元框架原语
│    （vendor/cordis/package.json:2-4 "Meta-Framework for Modern JavaScript Applications"）
│    还有 cosmokit、schemastery、timer、logger-console 等基础件
│
├─ L1 装配层 —— vendor/loader、vendor/include、vendor/group、vendor/hmr
│    「YAML 配置 → 插件树」的执行者
│    Loader（vendor/loader/src/index.ts:77  class Loader extends EntryTree（现行；旧 65））
│    Include + patch 语义（vendor/include/src/index.ts:57  applyEntryPatches）
│
├─ L2 业务包层 —— packages/*（一切产品能力都是插件）
│    packages/core/*     核心执行环：session、agent、agent-loop、tools、system-prompt
│    packages/llm/*      模型适配、retry、token-meter
│    packages/host/*     宿主面：webserver、frontend-static
│    packages/api/*      远程 API 面：gateway、session-controller、settings-controller
│    packages/client/*   浏览器侧：connection、modules、ui-*
│    packages/sandbox|skill|mcp|spill|compaction|…（能力域包）
│
├─ L3 启动层 —— packages/boot/app-boot + apps/cli
│    boot() 与 profile/env/patch 基建（packages/boot/app-boot/src/index.ts:961  new Context()，现行；旧 867）
│    CLI 入口（apps/cli/package.json:14-16  "bin": {"dsh": "lib/bin.js"}）
│
├─ L4 配置层 —— packages/bundle/* + packages/preset/*
│    bundle = 可复用 patch 包（dsh-base、web-app、headless…）
│    preset = 会话级组合（agent.cordis.yml）
│    注意：顶层没有 bundles/、presets/ 目录，它们在 packages/ 下
│
└─ L5 前端层 —— packages/client/* + apps/web
     浏览器启动内核（packages/client/web）+ vite 构建壳（apps/web）
     apps/web/package.json desc："dist/ served by apps/cli's dsh web"
```

**每层一句话**：

| 层 | 职责 | 一句话 |
|---|---|---|
| L0 | 元框架 | 提供 Context/Fiber/Service/事件四件套，不含任何业务 |
| L1 | 装配 | 把配置行变成真的插件实例（import → ctx.plugin） |
| L2 | 业务 | 所有产品能力；每个包默认导出一个插件 |
| L3 | 启动 | 解析 profile、叠 patch 栈、调 boot()、审计启动结果 |
| L4 | 配置 | bundle 决定「这个 profile 挂哪些行」；preset 决定「这个会话挂哪些行」 |
| L5 | 前端 | 浏览器里的启动内核与 UI 包，dist 由 web profile 的 frontend-static 提供 |

---

## 3. 核心对象关系小图

```
Context（共享容器，运行时是 Proxy）
 │
 ├─ Fiber ──── 一个插件被装载后的运行实例（状态机：PENDING→LOADING→ACTIVE→…）
 │    ├─ 持有校验后的 config
 │    ├─ store：所需服务的实现快照
 │    └─ effects：本实例注册的全部可撤销操作
 │
 ├─ Service ── 具名能力（ctx.tools、ctx.llm…）：一个插件 provide，其他插件 inject
 │
 └─ Entry ──── 配置树上的一行（id/name/config/disabled），Fiber 的「户口」
      ├─ EntryTree：entry 的可变树（Loader 就是它）
      ├─ EntryGroup：一组子 entry（group 行的 config 是数组）
      └─ Patch：对 entry 列表的增量操作（insert / 按 id 覆写 / disabled）
           └─ Include：读 YAML 文件 → 应用 patch 栈 → root.update() 装载
```

记忆锚点：**Entry 是配置态，Fiber 是运行态，Service 是能力态，Context 是它们共享的客厅。**

---

## 4. 本工作区落在图的哪里

本工作区（`dsh-info/`）**不在 harness 里面**，而是围绕它的编排与运维层：

| 本工作区资产 | 落在架构图 | 职责 |
|---|---|---|
| `deepseek-harness/` | 整个 L0-L5 | 上游源码副本（**净改动 = 0**，只试验不 fork，见 AGENTS.md §6） |
| `plugin-registry/`（registry.yml + core.yml） | L4 旁边的数据面 | 插件目录 + R11 核心功能红线（功能不可缺、功能槽内实现可替换） |
| `code/dshctl`（CLI + GUI） | L3/L4 的**体外工具** | 清单驱动：check/diff/apply 生成 profile patch，不改 harness 源码 |
| `code/*` 自研插件（bkn-plugin、ops-api…） | L2 的本地插件 | 以绝对路径 insert 挂进 profile（本地插件形态） |
| `.dsh-home/profiles/ops` 等 | L4 | 生成物：manifest + cordis.patch.yml |

**编排的本质**（AGENTS.md §6）：dshctl 只写 L4 的配置行（insert/disable by id），从不碰 L0-L2 源码——这就是「L0 纯增量 / L1 外部插件 / L2 源码直改禁止」分层红线的架构依据。

---

## 延伸阅读

- harness 官方总纲：`deepseek-harness/docs/architecture.md`（Cordis / Profiles and bundles / Application launch / Core packages / Turn flow 各节）。
- 框架入门：`deepseek-harness/docs/cordis-primer.md`。
- 源码级分层证据（每层 file:line）：`doc/dsh-plugin-internals.md` §4「bundle / 纯增量层」。
- 下一篇：[02-startup.md](02-startup.md)——这套分层是怎么被「拉起来」的。
