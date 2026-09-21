# 06 · 深入阅读指南与常见误区

**本篇你会学到**：harness 官方 167 篇 docs 的分层地图（怎么查）；本工作区文档分工再收束；5 条最容易误解的点（误解 → 真相 → 出处）；读完的 5 问自测。

---

## 1. 官方 docs 地图（`deepseek-harness/docs/`，167 篇英文均配 `.zh.md`）

```
入门/学 ── docs/architecture.md          总纲：Cordis / profiles+bundles / launch / turn flow
          docs/cordis-primer.md          框架精华 45 行（五想法+五模式+waterfall+loader+规则）
          docs/cordis-tutorial/          7 章教程：first-plugin → lifecycle → services →
                                          events → config → composition-and-hmr → into-the-harness
查（子系统）docs/subsystems/*.md         58 篇，一页一子系统（README.md:5-7 与总纲互补）：
                                          core / session / tools / web-server / sandbox / mcp / …
做（配方）  docs/cookbook/*.md           11 篇：adding-a-package / adding-a-tool /
                                          adding-an-llm-adapter / adding-a-remote-api / …
参考       docs/cordis-api/*.md          context / fiber / service / registry / events 生成式 API
          docs/glossary.md               领域词（capability-seam、agent-scope、goal、Ralph…）
          docs/event-producer-consumer.md 事件生产/消费矩阵
          docs/config-catalog.md / tool-catalog.md  配置与工具目录
血泪       docs/postmortem/*.md          4 起事故复盘
规范       docs/AGENTS.md                文档标准："one home per fact"（:19-31）——写新文档先读
```

**查法口诀**：概念 primer → 做事 cookbook → 某子系统不熟 subsystems → 改代码前 postmortem。**不要在新文档里重新定义术语**——一个事实只在官方 docs 有一个家（`docs/AGENTS.md:19-31`）。

## 2. 本工作区文档分工（收束）

| 想干什么 | 看哪 |
|---|---|
| **学** DSH/Cordis 整体（本系列） | `doc/dsh-guide/` 01→06 |
| **挖** 源码行号级证据 | `doc/dsh-plugin-internals.md`（loader/patch/inventory/服务/工具/HMR 七主题，全部 file:line） |
| **用** dshctl/GUI | `doc/dshctl-user-manual.md`（完整版）· GUI「使用手册」页（精华版） |
| **查** dshctl CLI | `doc/dshctl-manual.md` |
| **懂** 编排规则 | 工作区 `AGENTS.md`（R1-R12、红线、降级铁律、协议要点） |
| **跟** 实施历史 | `doc/dshctl-exec-plan.md`（各批次补记 + 踩坑沉淀） |

---

## 3. 五条最容易误解的点（误解 → 真相 → 出处）

### ① 「ctx 访问被拒」≠「没 provide 就报错」

- **误解**：以为 proxy 在 get 里直接查白名单，服务没 provide 立刻炸。
- **真相**：读取先放行特殊属性（symbol/`prototype`/`then`/纯数字/`_` 前缀）→ 读自有属性 → 进 `internal/get` waterfall → **沿祖先 fiber 链在 `fiber.store` 按 isolate 标签找**。分两种报错：在自己 `inject` 里但未就绪 = `cannot get required service "X" in inactive context`；根本没声明 = `cannot get property "X" without inject`。根 fiber 走宽松读。绕过口 `ctx.get(name)`（strict 默认只认 ACTIVE 提供者）。
- **出处**：`deepseek-harness/vendor/cordis/src/reflect.ts:80-91, 144, 153-166, 159-161`；规则 `packages/AGENTS.md:6`（可选依赖用 `ctx.get`）。

### ② config 是整段替换，不是深合并

- **误解**：patch 里给 config 一个字段，其余字段保留默认值。
- **真相**：`target[key] = value` 整体赋值——只写一个字段 = 其余默认全丢（smoke overlay 只改 port 也要整段复制就是这个原因）。唯一例外：Service 的 intercept config 才合并。patch 未匹配 id **只 warn 跳过不失败**——id 写错是静默失效。
- **出处**：`deepseek-harness/vendor/include/src/index.ts:109-113, 120-123`；`packages/bundle/base/cordis.patch.yml:5-6`；`docs/architecture.md:27`。

### ③ waterfall 忘调 `next()` = 静默短路

- **误解**：不调 next 只是「我不参与」。
- **真相**：不调 next 会 veto 掉链上后续一切——**包括内置默认行为**（`internal/config`、`internal/update`、`tools/pre-execute` 的默认 allow 全没）。反之 `emit` 完全不 await listener 返回的 promise，错误不冒泡给发射方。
- **出处**：`deepseek-harness/vendor/cordis/src/events.ts:194-196, 224-243`；`vendor/loader/src/index.ts:92-101`；`packages/core/tools/src/index.ts:1482-1486`；`AGENTS.md:129`。

### ④ PENDING ≠ 出错；配置行顺序 ≠ 加载顺序

- **误解**：插件没输出 = 挂了；YAML 里写在前面的先加载。
- **真相**：fiber 停 PENDING 通常只是 inject 的服务还没出现（epoch=INACTIVE）——依赖齐了自动醒；配置行顺序**没有加载语义**（"activation is service-availability driven"），顺序只为读者分组。
- **出处**：`deepseek-harness/vendor/cordis/src/fiber.ts:611-623`；`packages/bundle/base/cordis.patch.yml:11-12`；教程 `docs/cordis-tutorial/02-lifecycle-and-effects.md`（"why does my plugin print nothing?"）。

### ⑤ 同为 `!!js`，双上下文求值

- **误解**：`!!js` 到处同一种求值方式。
- **真相**：行的 `disabled: !!js` 在**每次挂载决策**对 **loader ctx** 求值；行的 `config` 内 `!!js` 在**该行 inject 激活后**对**插件自己的 ctx** 求值；Include/Group 是树载体，config 整段保持字面量（连自己的 `path` 都不插值）。`disabled` 是唯一被插值的行元数据；group 行恒不禁用。
- **出处**：`deepseek-harness/vendor/loader/src/config/entry.ts:75, 84-92`；`vendor/loader/src/index.ts:92-101`；`vendor/include/src/index.ts:162-167`；`vendor/README.md` 修改日志第 18 条。

---

## 4. 自测 5 问（全答上 = 本系列过关）

1. **架构**：DSH 和 Cordis 什么关系？为什么说「没有特权内核」？（→ 01：vendored 框架 + 全业务插件 + 配置可替换）
2. **启动**：`dsh web` 和 `dsh --profile headless` 共用哪段代码、差在哪三个分叉？（→ 02：boot()；CLI 别名 / 模板 reload 策略 / bundle 行）
3. **概念**：fiber 为什么停 PENDING？`ctx.foo` 的两种报错分别意味什么？（→ 03：epoch 依赖未齐；没声明 vs 声明了但不活跃）
4. **配置**：patch 改 config 一个字段会怎样？改 `cordis.patch.yml` 和改 `.ts` 的生效方式为何不同？（→ 04：整段替换；config-only 重放 vs 模块缓存+hmr 默认禁）
5. **运行时**：RiskGuard 挂在哪、deny 之后流程怎么走？turn 和 step 谁包含谁？（→ 05：tools/pre-execute，deny 直接归一结果；turn = 0..n step）

---

## 延伸阅读

- 官方 docs 地图入口：`deepseek-harness/docs/architecture.md`、`docs/AGENTS.md`（文档标准）。
- 源码级深挖：`doc/dsh-plugin-internals.md`。
- 回到入口：[README.md](README.md)。
