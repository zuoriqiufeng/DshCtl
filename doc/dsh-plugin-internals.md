# DSH 插件体系深文档（源码级）

> 用途：自学/查阅用，不上 GUI 页面。
> 源码树：`deepseek-harness/`（上游 DSH harness 副本）。
> ⚠️ **版本锚点已过期**：本文 file:line 核实于 `0d1f50007f`（v0.1.6-alpha.1，2026-09-15 clone）；上游已于 2026-09-23 pull 升级至 `00102833df`（v0.1.7-alpha.2，距旧锚点 2343 个提交），行号普遍漂移 10~25 行。**按 §8 的关键词重新定位**，漂移实测见 [dsh-plugin-reading-guide.md §5](dsh-plugin-reading-guide.md#5-版本锚点与漂移警告)。
> Cordis 核心（Loader/EntryTree/Include/Fiber/Context）来自 vendored 包：`vendor/cordis`（@deepseek-ai/cordis）、`vendor/loader`（cordis-plugin-loader）、`vendor/include`（cordis-plugin-include）；harness 自身的装配层在 `packages/boot/app-boot` 与 `apps/cli`。

---

## 1. loader / EntryTree.import：插件入口怎么被解析

**一句话**：`EntryTree.import()` 对 `cordis:` 前缀查内建注册表，其余 specifier 走 Node 内部 ESM loader（相对路径按 `ctx.baseUrl` 拼 URL，裸名按 node_modules 上溯）；import 失败只记日志并留下无 fiber 的 entry，由启动审计决定是否致命。

关键代码点：

- **import 分派本体** `deepseek-harness/vendor/loader/src/config/tree.ts:112-129`
  - `:113-114` — `name.startsWith('cordis:')` → `return this.ctx.loader.builtins[name.slice(7)]`；未注册的 id 返回 `undefined`（无显式报错）。
  - `:121-122` — 有 internal loader（Node ≥22）时 `internal.import(name, ctx.baseUrl!, {})`。
  - `:123-124` — 无 internal 且 `name.startsWith('.')` 时 `import(new URL(name, ctx.baseUrl).href)`。
  - `:125-126` — 其余裸名直接 `import(name)`（Node 默认解析）。
- **错误栈拼接** `deepseek-harness/vendor/cordis/src/utils.ts:268-281`（composeError）+ `:240-265`（handleError，把 `baseUrl#id` 链拼进错误栈）。
- **内建注册表生产代码只注册两个 id**：
  - `deepseek-harness/packages/boot/app-boot/src/index.ts:536-548` — `builtins.include`：传了 `bareModuleBaseUrl` 时注册 HostResolvedRootInclude 子类，其 import override 对裸名改用宿主安装目录锚定（`:539-547`）。
  - `deepseek-harness/packages/boot/app-boot/src/index.ts:554` — `builtins.group = Group`。
- **解析锚**：`deepseek-harness/packages/boot/app-boot/src/index.ts:879` — boot 设 `ctx.baseUrl` = 配置文件所在目录的 file URL；`deepseek-harness/vendor/loader/src/config/tree.ts:16` — EntryTree 继承之。
- **失败行为**：`deepseek-harness/vendor/loader/src/config/entry.ts:175-189` — `_init()` 里 import 抛错被 catch → `logger.error` → return，entry 留 `fiber === undefined`。
- **启动审计**：`deepseek-harness/packages/boot/app-boot/src/index.ts:752-791` — `inactiveEntries` 报 `failed to import`；`:818-835` `auditStartupEntries` 把 bootstrap Include 与必需 id（`agent-loop`/`webserver`/`modules` 等，`:711-719`）的失败升级为致命，其余只警告。
- **agent preset 变体**：`deepseek-harness/packages/preset/agent-presets/src/mount.ts:93-104` — `PresetTree extends Include`，裸包名改从 `harnessBase` 解析（用户 home 下 preset 才能找到 harness 依赖）；`:122-123` `write()` 置空——preset 是输入不是持久化目标。

**与本工作区规则的对应**（AGENTS.md §4/§6）：纯增量层（ops-app 模式）之所以能在任意 profile 目录装配 in-box 插件，靠的就是 `bareModuleBaseUrl` + internal loader 覆盖裸名解析。HMR 只重放 patch、不换模块源（见 §7），因为解析锚在启动时固定。

## 2. profile / bundle 装配：双锚解析与 symlink healing

**一句话**：profile 是 `$DSH_HOME/profiles/<name>` 包目录，`package.json` 的 `dsh.profile.bundles` 列出 bundle 层；bundle 用 manifest 键 `dsh.bundle.patch`（文件普遍叫 `cordis.patch.yml`）声明 patch 列表；bundle 包目录按「安装锚优先、profile 锚其次」双锚解析；模块回退靠预先治愈 `$DSH_HOME/profiles/node_modules` 的 symlink/ESM 代理。

关键代码点：

- **概念总纲** `deepseek-harness/packages/boot/app-boot/src/profile.ts:1-24`（模块头注释，明说 "resolution is two-anchor by construction"）。
- **双锚解析** `deepseek-harness/packages/boot/app-boot/src/profile.ts:838-849` — `resolveBundleDir(binName, packageName, installAnchor, profileDir)`：按 `[installAnchor, join(profileDir,'package.json')]` 逐锚尝试，先命中即返回，全失败抛「cannot resolve profile bundle…run dsh plugin install」。
  - 底层 `:813-824` `packageDirFromAnchor`：用 `createRequire(anchor).resolve.paths()` 枚举 Node 的 node_modules 上溯路径。
  - 安装锚 = CLI 的 package.json：`deepseek-harness/apps/cli/src/profile-boot.ts:82`。
- **层装配** `deepseek-harness/packages/boot/app-boot/src/profile.ts:861-891` — `loadProfileDirectory`：每个 bundle resolveBundleDir → 读 `bundleManifest.dsh?.bundle?.patch`（`:879-881`，缺失抛错）→ `loadOverlayPatches`；`:886-890` 再读 profile 自己的 `cordis.patch.yml`。
- **层序** `deepseek-harness/apps/cli/src/profile-boot.ts:212-219` — `bundlePatches → profile.patches → homePatches（$DSH_HOME/cordis.patch.yml）→ overlays（--patch + telemetry 开关）`。
- **空根约定** `deepseek-harness/apps/cli/src/profile-boot.ts:88-92` — profile 根 `cordis.yml` 是空数组 `[]`，整棵树全部由 patch 层组成；`:191-196` 每次启动重写空根，防止 Loader 写回把合成行「烘焙」进文件导致下次启动重复 insert。
- **合成探测与挂载** `deepseek-harness/packages/boot/app-boot/src/profile.ts:933-940` — `composeEntries` = `applyEntryPatches([], layers.flat())`（与实际挂载同一算法）；`profile-boot.ts:352` 挂载前 `structuredClone(allPatches)`（`:344-351` 注释：insert 行按引用推入树，跨代复用会把用户覆写烘焙进 bundle 行）。
- **manifest 示例** `deepseek-harness/packages/bundle/base/package.json:31-34` — `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。注意 `dsh.bundle.patch` 是 manifest 键路径，不是文件名。
- **symlink healing**：
  - `deepseek-harness/packages/boot/app-boot/src/profile.ts:574-609` — `healProfilesModuleFallback`：维护共享 `$DSH_HOME/profiles/node_modules`，跨进程文件锁下治愈（`:582-587`）。
  - `:473-525` `resolveModuleFallbackEntries`：从 installAnchor BFS 依赖图（含 peerDependencies），普通 Node 落 symlink、pkg 打包可执行文件落 ESM 代理。
  - `:231-269` `ensureSymlink`：lstat 检查 → 非软链且非 dsh 托管代理则报错要求手工移除 → 目标不符 unlink 重建 → `symlinkSync(..., 'junction')`。
  - `deepseek-harness/packages/boot/app-boot/src/profile-resolution/legacy-links.ts:31-41` — canonicalLinkPath 只归一化父目录、不跟随最后一段；`:62-73` `isProfileModuleFallbackLink` 判定 dsh 托管回退链（不得算作本地优先）。

**与本工作区规则的对应**：「纯增量层 ops-app 模式」= 空根 + 全部条目来自 bundle insert 层 + 每次启动重写空根。「安装锚优先」保证 in-box bundle 永远来自运行中 dsh 同一安装。

## 3. patch 语义：insert / config 整段替换 / disabled

**一句话**：`applyEntryPatches` 是唯一的 patch 算法（挂载与 `dsh --dump-config` 共用）——insert 无 id 追加到根、有 id 则 append 进目标组的 config 数组；非 insert patch 必须带 id，其余键**逐键整体赋值**到目标行（`config` 整段替换、无深合并）；`disabled: true` 由 `Entry.disabled` 在运行时沿祖先链判定。

关键代码点：

- **算法本体** `deepseek-harness/vendor/include/src/index.ts:57-127`（已全文核实）：
  - `:63` — `structuredClone` 保证输入不被改写。
  - `:65-74` — 按 id 建索引（递归进组的 config 数组）。
  - `:79-101` — **insert**：带 id → 目标必须存在且是 group（否则 warn 跳过）→ `target.config.push(...)`；无 id → `data.push(...)` 到根；`buildMap(insert)` 让同一列表里后一个 patch 能寻址前一个 patch 插入的行（跨层可配置性）。
  - `:104-118` — 非 insert 缺 id warn 跳过；带 name 时校验与目标行一致，不一致 warn 跳过。
  - `:120-123` — **按键覆写的例外仅存在于条目顶层键**：`for (const [key, value] of Object.entries(overrides)) { if (key === 'id') continue; target[key] = value }`——`config` 的值整体赋值，**config 内部没有按键深合并**。
  - base bundle 注释佐证：`deepseek-harness/packages/bundle/base/cordis.patch.yml:2-7`（"last write winning per row" / "replaces the targeted row's whole config"）。
- **运行时按 id 合并**：`deepseek-harness/vendor/loader/src/config/group.ts:48-65` — EntryGroup.update 新旧 config 各按 id 建 map，对并集逐 id create/remove。
- **Entry.update**：`deepseek-harness/vendor/loader/src/config/entry.ts:115-149` — 逐键合并、isNullable 删键；`:133-135` 合并后 disabled → dispose fiber；`:139-148` diff 出变化键 → `_patchContext`，diff 含 config 时 `fiber.update(config, true)` 就地热更新。
- **Include 的应用与热重放**：`deepseek-harness/vendor/include/src/index.ts:245-263`（Service.init 读文件→applyPatches→root.update）；`:190-201` — `internal/update` waterfall 里**否决 fiber 重启**（不调 next），就地重放 patches——config-only HMR 的核心；`:279-287` — refresh() 文件变化重读，解析失败只 warn 保留旧树。
- **disabled 生效判定**：`deepseek-harness/vendor/loader/src/config/entry.ts:72-82` — group 行恒不算 disabled，否则沿祖先 entry 链检查（禁用可传导）；`:88-92` — `!!js` 表达式对 loader ctx 求值；`:108-112` — refresh() 对 disabled 直接 return 不 init。
- **插件自我 disable 写回**：`deepseek-harness/vendor/loader/src/index.ts:150-153` — 用户删插件被识别后写回 `options.disabled = true`。
- **telemetry 开关实例**：`deepseek-harness/apps/cli/src/profile-boot.ts:171-174` — `{ id: 'session-telemetry-otel', disabled: true }`。

**与本工作区规则的对应**：dshctl 生成的按 id 裁剪（core.yml 红线 / 领域勾选）语义即此——对 bundle insert 的行做定向 override/disable，绝不改 bundle 层本身。**踩坑提示**：patch 作用于条目顶层键，想要「合并 config 里的一个字段」必须整键重写整个 config。

## 4. bundle / 纯增量层（ops-app 模式）

**一句话**：bundle = 一个声明了 `dsh.bundle.patch` 的 npm 包，其 patch 文件全部是 insert 行，挂到空根 `[]` 上；用户层与 `--patch` overlay 只按 id 覆写/禁用。这正是本工作区 `dsh-ops-app` 的上游机制。

关键代码点：

- bundle 判定：`deepseek-harness/apps/cli/src/plugin.ts:36-45` — `manifest.dsh?.bundle?.patch !== undefined` 即 bundle；`:59-91` reconcilePlugins 按安装态回写 `dsh.profile.bundles`。
- 默认 bundle 集：`deepseek-harness/packages/boot/app-boot/src/profile.ts:168` — `DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']`；模板表 `:139-160`（acp/web/headless/sdk…）。
- insert 名锚定：`deepseek-harness/packages/boot/app-boot/src/index.ts:340-350` — patch 里 insert 行的相对/绝对 name 被锚定为 patch 文件旁的 file URL。
- dsh-base 即「ONE insert over the empty profile root」：`deepseek-harness/packages/bundle/base/cordis.patch.yml:2-3`。
- AGENTS.md §6 的 L0/L1/L2 分层对应的机制面：L0 = 纯 bundle insert 层（自动跟随上游）；L1 = 外部插件按公开契约面；L2（源码直改）在本机制下无处安放——升级即被覆盖，故禁止。

## 5. plugin-inventory / plugin-package-inventory

**一句话**：两者都以 Loader 为唯一事实源，但暴露面不同——`plugin-inventory` 返回**每条 loader entry 的生命周期状态**（远不止 name+version）；`plugin-package-inventory-deepseek` 把活动插件归约为**包级 `{name, version}`** 唯一集合附在官方请求上。计划里「上游仅有 name+version」的断言只对后者成立，前者字段更丰富，写文档/做对账时不要混淆。

- **plugin-inventory**（`@deepseek-ai/dsh-plugin-inventory`）：
  - `deepseek-harness/packages/host/plugin-inventory/src/index.ts:65-89` — `@Remote('list')` 每次直读 `ctx.loader.entries()`（无第二份缓存），每条产出 `{ entryId, moduleName, enabled, fiberPhase }`，roster 组装后附 agentPresets。
  - `deepseek-harness/packages/host/plugin-inventory/src/types.ts:16-23` — `PluginInventoryEntry`：entryId（Loader 树稳定 id）/ moduleName（精确 specifier）/ enabled（含祖先组禁用）/ fiberPhase（pending/loading/active/failed/unloading/null）。
  - preset 行 `:29-44`（含 `enabled: boolean | 'conditional'` 与 `!!js` condition 原文）、preset 组 `:47-60`（trust: system|user、broken?、rows）。
- **plugin-package-inventory**（`@deepseek-ai/dsh-plugin-package-inventory-deepseek`）：
  - `deepseek-harness/packages/llm/plugin-package-inventory-deepseek/src/types.ts:4-13` — `DeepSeekPluginPackageIdentity` **只有 name+version**，外壳 `{version:1, packages:[...]}`。
  - `deepseek-harness/packages/llm/plugin-package-inventory-deepseek/src/index.ts:138-149` — 只收「非 group、未 disabled、fiber ACTIVE」的条目；`:111-134` 包身份解析（cordis: 前缀无包身份；相对/绝对路径 nearestManifest 上溯）；`:176-185` 按 `name\0version` 去重、文本序排序（确定性）。

**与本工作区规则的对应**：dshctl 插件库对账（check R11/R12）如需上游侧清单，plugin-inventory 的 entry 级状态是更合适的数据源；「仅 name+version」的口径只用于包级去重场景。

## 6. 服务体系：inject / Context Proxy / waterfall / AsyncLocalStorage

**一句话**：插件用静态 `inject` 声明服务依赖；Context 是 Proxy，沿祖先 fiber 链找不到活跃实现的读取会抛 `cannot get property "x" without inject`；waterfall 用 `ctx.on(name, listener)` 注册（listener 必须调 `next()`）、`ctx.waterfall(name, ...args, next)` 发起；harness 内唯一 AsyncLocalStorage 用法是 `ctx.agents` 的 initiator 因果链穿透。

关键代码点：

- **inject**：`deepseek-harness/vendor/cordis/src/registry.ts:19`（Inject 类型）、`:71-88`（Inject.resolve 归一化）、`:316-330`（ctx.plugin 时传入）；Fiber 侧 `deepseek-harness/vendor/cordis/src/fiber.ts:611-623` — 全部 inject 键解析到活跃实现才离开 PENDING，`:646-657` 齐备后才执行插件体。
- **Context Proxy 拒绝未声明访问**（已核实）：`deepseek-harness/vendor/cordis/src/context.ts:74` — 构造即 `new Proxy(this, ReflectService.handler)`；`deepseek-harness/vendor/cordis/src/reflect.ts:144-167` — get 陷阱预建错误对象，解析路径为 `internal/get` waterfall → 沿「当前 fiber → 祖先 fiber」链找 `fiber.store?.[prop]`。
  - **精确语义**：拒绝条件是「沿祖先链找不到活跃实现」，不是 get 里直接查 inject 白名单——祖先 fiber 自己 inject 并解析过的服务，子 fiber 可经祖先 store 命中。
  - 绕过口：`ctx.get(name)` 显式无 inject 要求读取（`deepseek-harness/vendor/cordis/src/reflect.ts:233-235`）。
  - set 陷阱 `:178-196` — 无 provide/accessor 声明抛 `cannot set property "x" without provide`。
- **waterfall**：`deepseek-harness/vendor/cordis/src/events.ts:234-243` — 最后一个参数是内层 next，监听器依次包裹，不调用则短路；`:288-302` — `ctx.on` 注册即 fiber effect（随 fiber 卸载自动注销）；`:329-352` — 框架内置 waterfall（internal/config、internal/update、internal/get、internal/set）。`ctx.on`/`ctx.waterfall` 的混入出处：`deepseek-harness/vendor/cordis/src/reflect.ts:222`。
- **AsyncLocalStorage**：`deepseek-harness/packages/core/agent/src/index.ts:248-249` — AgentRegistry 持有 initiators/initiatorRuns 两个 ALS；`:324-341` — withInitiator/withoutInitiator 建立因果边界；`:620-650` — runWithInitiator 嵌套 run + Promise drain 追踪。
  - **契约边界**（`:239-244`）：ALS 只提供**同进程因果归属**（日志/追踪/归属），不是活性证明也不是鉴权；身份跨 worker/进程/网络边界仍须显式传递。本工作区 ops-api 的 memoryKey AsyncLocalStorage（AGENTS.md §4）是同模式的业务侧应用。

## 7. 工具注册：defineTool 与 tools/pre-execute

**一句话**：`defineTool` 产出经过 schema 编译与包装校验的 ToolDefinition；`ctx.tools.register(def)` 二次结构校验后插入 scoped 分层表（注册是 effect，返回 disposer）；每次工具调用先跑 `tools/pre-execute` waterfall（allow/deny/ask/cancel），再跑单调 guard，然后才进 `tools/execute` 包裹的工具体。

关键代码点：

- **defineTool 面**：`deepseek-harness/packages/core/tools/src/schema.ts:545-547`（定义处）；字段面 `:483-536` — name / description / parameters（属性级 schema）/ output{schema, render, presentationMeta?} / timeoutMs? / isConcurrencySafe? / execute(args, exec) / finalizeContent? / presentCall? / presentResult?。
  - 校验：`:563-565` timeoutMs 非正即抛；`:566-568` parameters/output.schema 编译为 JSON Schema 并生成 validate(args)；`:585-589` execute 包装为「先 validate(args) 再进用户 execute」（模型参数边界的校验铁律）；`:598-615` present*/isConcurrencySafe 走软校验（过期回退默认值，不抛）。
- **register**：`deepseek-harness/packages/core/tools/src/index.ts:1043-1068` — output 结构校验（`:1045-1050`）、`assertSupportedJsonSchema`（`:1051`）、run_code 保留名拒绝（`:1060-1062`）、`layers.effect(ctx, layer => layer.tools.insert(...))`（`:1063-1067`，scoped 层遮蔽全局，disposer 即注销）。
- **pre-execute 触发点**（已核实）：`deepseek-harness/packages/core/tools/src/index.ts:1470-1516` — `prepareExecution()` 里 `await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))`（`:1482-1485`）；ask 决策接用户审批（`:1486-1488`）；allow 后再跑单调 guard（`:1496-1508`），全过才进 dispatch。
- **阶段顺序不变量**：`deepseek-harness/packages/core/tools/src/invariant.ts:95-115` — pre 每个 execution 只触发一次、execute 必须跟其后、post 必须跟 pre/execute 之后。
- **真实消费示例**：`deepseek-harness/packages/jobs/tool-jobs/src/index.ts:232`、`deepseek-harness/packages/experimental/auto-review/src/index.ts:655` — `ctx.on('tools/pre-execute', ...)`。

**与本工作区规则的对应**（AGENTS.md §4/§7）：RiskGuard 挂 `tools/pre-execute` 即此 waterfall；「不调 next() 就否决整次调用」是 blockable 拦截的机制依据；`mutatingTools` 指纹识别作用在 exec 的命令字段上。

## 8. HMR 边界：config-only 热重载 vs 源码必须重启

**一句话**：配置热重载不依赖模块重导入——chokidar 精确监视 `cordis.patch.yml`，变化时重读 patch 并 `entry.update()`，Include 在 `internal/update` 里否决自身 fiber 重启、按 id 定位后仅对 diff 出的 config 调 `fiber.update()` 原地重建插件实例（新 config、旧模块）；而改插件源码需要清 Node 的 ESM loadCache / CJS require.cache 再重导入——这条路径只在默认禁用的 `@deepseek-ai/cordis-plugin-hmr` 里，默认必须重启进程。

关键代码点：

- **watcher**：`deepseek-harness/packages/boot/app-boot/src/watch-config.ts:36-67` — chokidar 逐路径监视，只有命中精确文件才 refresh，失败仅 warn（热重载无回滚）。
- **谁装 watcher**：`deepseek-harness/apps/cli/src/profile-boot.ts:375-402` — 仅 `patchReload: 'live'` 的 profile；headless/acp/sdk 是 `startup`（模板表 `deepseek-harness/packages/boot/app-boot/src/profile.ts:137-160`；自定义 profile 默认 live）。
  > ⚠️ **v0.1.7 已变更**：`patchReload` 键已从 `DshProfileManifest` 移除（只剩 `bundles`），全仓无代码读取；配置监视改由 base 层 hmr 行默认启用（`base/cordis.patch.yml:28-32`），headless/sdk/acp 各自 `disabled: true`。本工作区 `code/dshctl/render.ts:33` 仍生成该键，属待清理的死键。详见 [dsh-plugin-reading-guide.md §5](dsh-plugin-reading-guide.md#5-版本锚点与漂移警告)。
- **watch-only fallback**：`deepseek-harness/apps/cli/src/profile-boot.ts:380-391` — live profile 若无 hmr 服务，自动挂 `config: { root: [] }` 的 HMR 实例（零模块监视目录），注释逐字 "Config-only HMR for the live profile patch layer"。
- **按 id 重建链路**：`deepseek-harness/packages/boot/app-boot/src/index.ts:260-296`（watchUserPatches 重读→compose→entry.update）→ `deepseek-harness/vendor/include/src/index.ts:190-201`（否决 fiber restart，就地重放）→ `deepseek-harness/vendor/loader/src/config/entry.ts:98-149`（diff→_patchContext→fiber.update）→ `deepseek-harness/vendor/cordis/src/fiber.ts:718-753`（restart：旧模块+新 config）。
- **源码热替换为什么默认没有**（三段代码链）：
  1. `deepseek-harness/packages/bundle/base/cordis.patch.yml:19-25` — `id: hmr` 行 `disabled: true`，注释 "Module reload is opt-in per profile"。
  2. watch-only fallback 的 `root: []` 不监视任何源码目录（`profile-boot.ts:380-391`）。
  3. 清缓存逻辑只在 HMR 的 partialReload 里：`deepseek-harness/vendor/hmr/src/index.ts:296-331`（ESM loadCache Map.delete + require.cache 删除），`:353-382` 逐 fiber registry.delete 后用新模块对象重建，失败回滚。
- **失效场景**：CLI 入口依赖树（externals）变化走全量 `loader.exit()` 而非热替换（`deepseek-harness/vendor/hmr/src/index.ts:112-118`）。

**与本工作区规则的对应**（AGENTS.md §4）：「config-only HMR：改 cordis.patch.yml 保存即热重载；改插件源码必须重启 `pnpm dsh web`」逐字对应本节；`patchReload: live` 仅限 live profile，headless 实例（试验口 8643）改配置也要重启。另注意：热重载**无回滚**——patch 解析失败只 warn 并保留旧树（`vendor/include/src/index.ts:279-287`），线上改配置坏了不会自动退，要人工修复再存一次。

---

## 附：存疑与已知偏差

1. 「insert 按 id 合并」没有独立命名函数——patch 阶段是 `applyEntryPatches` 内部 entryMap，运行时按 id diff 是 `EntryGroup.update`。
2. `dsh.bundle.patch` 是 manifest 键路径（`dsh.bundle.patch`），不是文件名；bundle 实际 patch 文件普遍命名 `cordis.patch.yml`。
3. `cordis:` 内建注册表生产代码只有 `include` 与 `group` 两个 id（其余 builtins 赋值均在测试）。
4. 「AsyncLocalStorage 穿透 per-request 上下文」的**通用框架机制**不存在——harness 只有 initiator 因果链一处业务用法；各业务（如 ops-api memoryKey）是自建 ALS，模式相同但代码独立。
5. `internal/get`/`internal/set` waterfall 在 packages/ 下无业务消费者，属「可用但未用」扩展点。
6. AGENTS.md「纯增量层 ops-app 模式」未在 harness 源码逐字出现，对应关系按代码证据建立（空根 + 纯 patch 层）；「config-only HMR」一词逐字出现在 `apps/cli/src/profile-boot.ts:381` 注释。
7. 本工作区已知偏差（AGENTS.md §3）在插件侧同样成立：BM25 分词器等与 Hermes 的差异属领域实现层，不在本文档的上游机制范围内。
