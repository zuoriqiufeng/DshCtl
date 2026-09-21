# 04 · 配置与装配：YAML 如何变成插件树

**本篇你会学到**：Entry / EntryTree / Include / Loader 各是什么；patch 的三条铁律；Profile / Bundle / Preset 的区别与层序；HMR 为什么「改配置立即生效、改源码必须重启」；`!!js` 的双上下文。

---

## 1. 四个角色一句话

| 角色 | 一句话 | 位置 |
|---|---|---|
| **Entry** | 配置树上的一行（`EntryOptions`：id/name/config/group/disabled/inject）对应的运行时节点 | `deepseek-harness/vendor/loader/src/config/entry.ts:9-22` |
| **EntryTree** | entry 的可变树：按 id 存 Entry、执行 `import()`、create/remove/update；「持久化由子类实现」 | `vendor/loader/src/config/tree.ts:6-7` |
| **Include** | 文件（YAML）支撑的 EntryTree 子类：读文件 → 应用 patch → `root.update()` 装载；可 refresh 热更新、防抖写回 | `vendor/include/src/index.ts:159-167` |
| **Loader** | 拥有整棵 entry 树、负责 import 配置行所指插件的根服务 | `vendor/loader/src/index.ts:65`（`class Loader extends EntryTree`） |

关系：**Include 读文件产出树，Loader 把树上每行变成 Fiber**。进程里只有一个 Loader；profile 根文件是空数组 `[]`，真正的内容来自「Include 挂载时对空根应用 patch 栈」。

## 2. patch 语义三条铁律

patch 的唯一算法是 `applyEntryPatches`（`deepseek-harness/vendor/include/src/index.ts:57-127`，注释 `:43-56` 称 "THE patch semantics"；dump-config 复用同一函数保证不漂移）：

**铁律 1 — insert 按 id 合并**
- 无 id：追加到根（`:92-94`）；有 id：append 进目标 group 行的 `config` 数组，目标必须存在且是 group，否则 warn 跳过（`:79-91`）。
- 同一 patch 列表里，**后一个 patch 能寻址前一个 patch 插入的行**——插入后立即入索引（`:95-101` 注释：跨层可配置性的基础）。
- 运行时侧对应 `EntryGroup.update` 的按 id diff（`vendor/loader/src/config/group.ts:48-65`：新表有 → create，新表无 → remove）。

**铁律 2 — config 整段替换，不是深合并**
- 非 insert patch 必须带 id（`:104-107`）；其余字段**逐键整体赋值**：`for (const [key, value] of Object.entries(overrides)) target[key] = value`（`:120-123`）。
- 官方佐证：`deepseek-harness/packages/bundle/base/cordis.patch.yml:5-6` "A patch replaces the targeted row's whole `config` rather than merging into it"；`docs/architecture.md:27`。
- **推论**：想改 config 里一个字段，必须把想保留的字段全部重写。唯一例外是 Service 的 intercept config 才合并（`vendor/cordis/src/service.ts:86-102`）。

**铁律 3 — disabled 是行级开关，沿祖先链传导**
- patch 落到行上（`PatchOptions.disabled`，`vendor/include/src/index.ts:136`）；生效判定在 `Entry.disabled`（`vendor/loader/src/config/entry.ts:72-82`）：group 行恒不禁用（`:75`），沿祖先 entry 链检查——**禁组 = 禁全部子行**。
- 不匹配的 patch **只 warn 跳过，不失败**（`:109-113`）；带 name 时校验不一致也只 warn（`:115-118`）。
- dshctl 的 R11 红线就是对这行 `disabled: true` 的检查——核心功能不可缺；带 slot 标记的功能槽载体被禁时，同槽有活跃成员即可豁免替换。

## 3. Profile / Bundle / Preset

| | Profile | Bundle | Preset |
|---|---|---|---|
| **是什么** | 实例配置层目录 `$DSH_HOME/profiles/<name>` | 可复用 patch 包（npm 包） | 会话级组合目录（一份 `agent.cordis.yml`） |
| **管什么** | 声明有序 bundles + 自己的 `cordis.patch.yml` + `patchReload` 策略 | `package.json` 的 `dsh.bundle.patch` 指向自身 `cordis.patch.yml` | tools / prompt sections / skills / persona |
| **生命周期** | 进程启动级 | 被 profile 按层叠进进程 | **会话级**——挂到该 agent 的 scope context，随 agent 卸载 |
| **关键位置** | `deepseek-harness/packages/boot/app-boot/src/profile.ts:1-24, 139-160` | 各 `packages/bundle/*/package.json` 的 `dsh` 字段；模板映射 `profile.ts:139-159` | `packages/preset/README.md:12`；挂载 `agent-presets/src/mount.ts:1-14`（scope 两道守卫） |

**记忆**：profile/bundle 选「宿主组合」（进程全局一份）；preset 选「会话组合」（同进程可同时跑多种）。两者用的是**同一套 entry+patch 语义**，只是挂载层级不同。

**profile 层序**（后写覆盖先写）：`bundle 层 → profile 自己的 cordis.patch.yml → home 层（$DSH_HOME/cordis.patch.yml）→ --patch overlay`（`deepseek-harness/apps/cli/src/profile-boot.ts:212-219`；官方 `docs/architecture.md:27`）。

**dshctl 视角**：dshctl apply 生成的就是 profile 的 bundle 声明 + patch 行——「纯增量层 ops-app 模式」= 空根 + 全部条目来自 insert 层 + 用户层只按 id 覆写/禁用（见 `doc/dsh-plugin-internals.md` §2/§4）。

## 4. HMR 边界：为什么改配置立即生效、改源码必须重启

**config-only 热重载链路**（三段，全程不换模块）：

```
chokidar 监视 cordis.patch.yml 精确路径
  （packages/boot/app-boot/src/watch-config.ts:36-67）
→ refresh 重读 patch → root.update()，Include 在 internal/update waterfall 里
  「否决 fiber 重启」并就地重打 patch（vendor/include/src/index.ts:190-201）
→ 按 id 定位变化行 → diff 出 config 才 fiber.update()（vendor/loader/src/config/entry.ts:98-149）
→ Fiber.restart()：**新 config、旧模块**（vendor/cordis/src/fiber.ts:718-753）
```

**改源码为什么必须重启**（三段论）：

1. 模块热替换（hmr 插件）默认 `disabled: true`（`deepseek-harness/packages/bundle/base/cordis.patch.yml:21-25`，注释 "Module reload is opt-in per profile"）；
2. live profile 缺 hmr 时挂的是 watch-only 实例 `config: { root: [] }`——零模块监视目录（`apps/cli/src/profile-boot.ts:380-391`）；
3. 不显式清 Node 的 ESM `loadCache` / CJS `require.cache`，重 import 返回同一模块对象——清缓存逻辑只在 hmr 的 partialReload 里（`vendor/hmr/src/index.ts:296-331`）。

⚠️ 热重载**无回滚**：patch 解析失败只 warn 并保留旧树（`vendor/include/src/index.ts:274-287`）——线上改配置坏了要人工修好再存一次。

## 5. `!!js` 的双上下文（易错）

同一个 `!!js` 标记，**求值上下文不同**：

| 位置 | 何时求值 | 对谁求值 | 出处 |
|---|---|---|---|
| 行的 `disabled: !!js …` | **每次挂载决策** | **loader 上下文** | `vendor/loader/src/config/entry.ts:84-92` |
| 行的 `config` 内 `!!js …` | 该行 inject **激活后** | **该插件自己的 ctx** | `vendor/loader/src/index.ts:92-101` |

两个补充事实：Include/Group 是「树载体」，其 config 整段保持字面量不插值（`include/src/index.ts:162-167`）；`disabled` 是唯一被插值的行元数据（`vendor/README.md` 修改日志第 18 条）。且 group 行本身恒不禁用（`entry.ts:75`）。

---

## 自测

1. patch 改了 config 的一个字段，其他字段去哪了？（答：被整体替换掉了——不是深合并）
2. 为什么 patch 没匹配到 id 不报错？（答：设计如此，warn 跳过——所以 id 写错是静默失效的）
3. 改了 `cordis.patch.yml` 没重启就生效，改了插件 `.ts` 却没生效，为什么？（答：前者走 config-only 重放「新 config 旧模块」，后者被 Node 模块缓存挡住且 hmr 默认禁用）
4. profile 和 preset 的区别？（答：进程级宿主组合 vs 会话级 scope 组合，同一套 patch 语义）

## 延伸阅读

- 源码级证据：`doc/dsh-plugin-internals.md` §2 profile 双锚与 healing、§3 patch 语义、§8 HMR 三段边界。
- 官方：`deepseek-harness/docs/architecture.md:15-33`（Profiles and bundles）、`packages/bundle/base/cordis.patch.yml:1-14`（头注释是最好的 patch 教材）、`docs/cordis-tutorial/06-composition-and-hmr.md`。
- 下一篇：[05-runtime-tools.md](05-runtime-tools.md)——树跑起来之后，会话与工具怎么转。
