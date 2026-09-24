# 03 · Cordis 核心概念：组件含义

**本篇你会学到**：Cordis 是什么；Plugin / Fiber / Context / Service / 事件五个核心组件各自的含义与协作方式。每个概念统一格式：**一句话定义 → 在 DSH 里的作用 → 关键位置**。

主线对齐官方「Cordis In Five Ideas」（`deepseek-harness/docs/cordis-primer.md:7`）：插件是实现 Service 协议的对象 / context 是服务仓库 / inject 声明依赖 / typed events 五种分发 / registrations are reversible effects。

> ⚠️ **版本锚点**：本篇 file:line 核实于 `0d1f50007f`（v0.1.6-alpha.1）；上游已升级至 `00102833df`（v0.1.7-alpha.2，2026-09-23），行号普遍漂移 10~25 行。本轮未逐一复核本篇行号（抽查显示仍在 10~25 行漂移区间内，语义未变）；漂移对照表见 [dsh-plugin-reading-guide.md §5](../dsh-plugin-reading-guide.md#5-版本锚点与漂移警告)。

---

## 1. Cordis 是什么

- **一句话定义**：TypeScript 插件（元）框架——显式依赖注入、作用域服务、生命周期托管的清理、可选的配置驱动加载（`deepseek-harness/vendor/cordis/README.md:3-7`；package desc "Meta-Framework for Modern JavaScript Applications"，`vendor/cordis/package.json`）。
- **在 DSH 里的作用**：DSH 的框架层就是它。`packages/*` 全部业务能力都以插件形式挂在同一个 Context 上，**从配置即可替换；没有需要打补丁的特权内核**（官方措辞 `docs/architecture.md:11`）。每个 harness 包都以 `@deepseek-ai/cordis` 为 peerDependency（`packages/AGENTS.md`）。
- **为什么叫 vendored**：框架源码随仓放 `vendor/`，"the harness fully owns its framework layer (auditable, patchable, pinned)"（`vendor/README.md:3`）。

## 2. Plugin（插件）

- **一句话定义**：实现插件协议的对象，三种形态之一——① 函数 `(ctx, config)`；② 带 `apply(ctx, config)` 的对象；③ `Service` 子类（`deepseek-harness/vendor/cordis/src/registry.ts:92-98` 类型定义；对象判据 `:8-10` 的 `isApplicable`；官方示例 `docs/cordis-tutorial/01-first-plugin.zh.md` 的「其他两种插件形态」节）。
- **在 DSH 里的作用**：每个 `packages/*` 包默认导出一个插件（约定见 `packages/AGENTS.md:5`（Plugin exports 条）：service 包 default-export 服务类；函数插件 named-export `name`/`inject`/`Config`/`apply`）。Loader 从配置行 import 后 `ctx.plugin()` 启动。
- **defineXxx 约定**：构造带类型的定义对象、由调用方注册——`defineTool`（`packages/core/tools/src/schema.ts:554`，旧 545）、`defineStore`（`packages/client/store/src/index.ts:217`）等同款风格。
- **关键**：`ctx.plugin()` 校验形态、建/复用 runtime、创建 Fiber（`registry.ts:316` 的 `plugin()`）。

## 3. Fiber（插件运行实例）

- **一句话定义**：一个插件被装载后产生的运行时实例，持有生命周期状态、校验后的 config、依赖服务快照与全部注册 effects（JSDoc "Runtime instance of one plugin application"，`deepseek-harness/vendor/cordis/src/fiber.ts:179`）。
- **在 DSH 里的作用**：配置行的 `disabled`、HMR 重启、配置热更新都以 fiber 为单位生效。`ctx.fiber` 即当前 context 所属实例（`fiber.ts:10-14` 声明合并）。
- **状态机**（`fiber.ts:140-152` JSDoc、`:147` `FiberState` 枚举）：

  ```
  PENDING（等 inject 的服务）→ LOADING（跑插件体）→ ACTIVE
       ↑____________ 服务又没了 / config 变更 ____________|
  任意态 → FAILED / UNLOADING → DISPOSED
  ```
- **epoch 机制一段话**：每个 fiber 有一个「epoch 串」= 全部 inject 服务的实现指纹（`fiber.ts:612-623`）。任一依赖缺失 → epoch=INACTIVE，fiber 停在 PENDING **不跑插件体**；服务出现/消失 → `_setEpoch()` 检测变化 → `_reload()` 或 `_unload()`（`:625`）；装载时还会复查 epoch 防过期装载。
  **记忆：依赖齐了才跑，依赖走了就卸——这就是「为什么我的插件没输出」的第一答案。**
- 词源：官方未解释命名（grep 无果）；功能性定义见 `docs/cordis-api/fiber.md`。

## 4. Context（共享容器 + Proxy）

- **一句话定义**：Cordis 的核心对象与根/子依赖容器，运行时被 Proxy 包裹（构造即 `new Proxy(this, ReflectService.handler)`，`deepseek-harness/vendor/cordis/src/context.ts:74`；类 JSDoc `:36-41`）。
- **在 DSH 里的作用**：插件只拿 `ctx`；`ctx.tools` 这类读取是**拓扑敏感**的（按 inject 与隔离域解析）；`extend/isolate/intercept` 派生不改父级的子上下文（`context.ts:99 / :121 / :141`）。
- **Proxy 拒绝的精确语义**（`reflect.ts:135` 的 `static handler`，读代码顺序）：
  1. 特殊属性放行：symbol、`prototype`/`then`、纯数字、`_` 前缀（`reflect.ts:80-91`）；
  2. 自有属性直读（`reflect.ts:140-142`）；
  3. 进入 `internal/get` waterfall（`reflect.ts:153`），**沿祖先 fiber 链在 `fiber.store` 里按 isolate 标签找**（`reflect.ts:155-166`）；
  4. 找不到时分两种报错：名字在自己 `inject` 里但服务未就绪 → `cannot get required service "X" in inactive context`（`reflect.ts:160`）；根本没声明 → `cannot get property "X" without inject`（`reflect.ts:144`）。
- **绕过口**：`ctx.get(name)` = 不带 inject 要求读服务（`reflect.ts:19` 声明、`:233` 实现）。官方规则：**可选依赖用 `ctx.get`，`ctx.<name>` 留给已声明的 inject**（`packages/AGENTS.md:6` 的 Optional services 条）。
- set 同理：无 provide 声明抛 `cannot set property "X" without provide`（`reflect.ts:178`）。

## 5. Service（服务）与 provide/inject

- **一句话定义**："A named capability one plugin provides and other plugins consume through `ctx`"（官方 `docs/cordis-tutorial/03-services.zh.md` 开头定义）。`provide` 登记实现，`inject` 声明依赖。
- **在 DSH 里的作用**：`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.loader` 都是服务——消费者只按名字要能力、不 import 实现，配置可换 Provider。这就是 harness 说的 **capability-seam**（三角色 Service Definition / Provider / Consumer，`docs/glossary.zh.md` 的 capability-seam 条）。
- **关键位置**：
  - `provide()` 实现：`deepseek-harness/vendor/cordis/src/reflect.ts:277`（重名报错、写 fiber.store、ACTIVE 时 notify、disposer 注销）；
  - `inject` 归一化：`registry.ts:71` 的 `Plugin.resolve()`；JSDoc "it only loads while all are available"（`registry.ts:105`）；
  - 服务就绪 → `notify()` 重估所有依赖方并 `_refresh()`（`reflect.ts:314`）——Fiber 从 PENDING 醒来的触发链。
- **注册皆 effect**：`ctx.on` / `provide` / `tools.register` 返回的 disposer 随 fiber 卸载自动回卷（根 `AGENTS.md` 的 `!!js` 条；`docs/cordis-primer.md` 五个核心概念第 5 条）。

## 6. 事件系统

- **五种分发模式**（`deepseek-harness/vendor/cordis/src/events.ts:32` 的 `DispatchMode`，官方表 `docs/cordis-primer.md:19-24`；**dispatch mode 是事件公开契约的一部分**）：

  | 模式 | 语义 | 位置 |
  |---|---|---|
  | `emit` | 同步、不 await、不收集返回值 | `events.ts:194` |
  | `parallel` | 并发全部跑 | `events.ts:183` |
  | `serial` | 顺序跑 | `events.ts:204` |
  | `bail` | 某个返回非 undefined 即短路 | `events.ts:217` |
  | `waterfall` | around-middleware 串联回调链 | `events.ts:234` |

- **waterfall 语义**（必背）：监听器签名 `(...args, next)`，**调 `next()` 才委托给下一个/内置行为；不调即短路 veto**（JSDoc `events.ts:228` "a listener that does not call `next()` vetoes the rest of the chain, including the built-in behavior"）。注册用 `ctx.on(name, fn)`（`events.ts:288`，本身是 effect），发起用 `ctx.waterfall(name, ...args, next)`——混入出处 `reflect.ts:222`。
- **内置 `internal/*` 一览**（`events.ts:329-352` 的 `interface Events`）：`internal/plugin`（fiber 生死）、`internal/status`（状态变迁）、`internal/config`（waterfall，本次激活的 raw config）、`internal/service`（服务绑定）、`internal/update`（waterfall，**配置更新可被 veto**——config-only HMR 的关键）、`internal/get`/`internal/set`（经代理读写服务的拦截点）、`internal/listener`（bail，注册拦截）、`internal/dispatch`（诊断）。
- 工具管线的 `tools/pre-execute` 就是这样一个 waterfall（见 [05-runtime-tools.md](05-runtime-tools.md)）。

---

## 协作关系一张图

```
配置行(Entry) ──ctx.plugin()──▶ Fiber ──装载成功──▶ 注册 effects：
                                │                    ├─ provide(service)
                 inject 依赖图   │                    ├─ ctx.on(event)
                 驱动 PENDING↔  │                    └─ tools.register(...)
                 ACTIVE 的 epoch │
                                ▼
                        Context（Proxy 客厅）
                     读 ctx.xxx → 沿 fiber 链查 store
```

---

## 自测

1. 插件体没执行、日志没动静，第一反应查什么？（答：fiber 处于 PENDING——inject 的服务没齐，看 epoch）
2. `ctx.foo` 报 `without inject` 和报 `inactive context` 区别是什么？（答：前者没声明过，后者声明了但服务当前不活跃）
3. waterfall 忘调 `next()` 会发生什么？（答：静默短路，连内置默认行为一起 veto——包括 `internal/update`、`tools/pre-execute`）

## 延伸阅读

- 官方入门：`deepseek-harness/docs/cordis-primer.md`（五想法 + 五模式 + waterfall + loader 配置 + 实用规则，45 行精华）。
- 官方教程：`deepseek-harness/docs/cordis-tutorial/01-…05-`（first-plugin / lifecycle / services / events / config）。
- 源码级深挖（file:line 全量证据）：`doc/dsh-plugin-internals.md` §6 服务体系、§7 工具注册。
- 下一篇：[04-config-loading.md](04-config-loading.md)——配置怎么把这套东西装起来。
