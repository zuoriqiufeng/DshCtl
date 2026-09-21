# 05 · 运行时：会话、工具与护栏

**本篇你会学到**：turn/step 是什么；session 事件日志怎么记；`defineTool` 的完整面；工具执行的三段 waterfall 管线与护栏挂点；本工作区 RiskGuard / AsyncLocalStorage 规则在插件侧的对应。

---

## 1. turn / step：Agent 的两级节奏

- **定义**（官方 `deepseek-harness/docs/architecture.md:82-87`）：
  - **step** = 一次模型请求（含它带出的工具调用）；
  - **turn** = 用户一轮输入到最终答复，由 **0..n 个 step** 组成（模型可能连续多轮「调工具 → 看结果 → 再调」）。
- **代码坐标**：`turn()` 开轮（claim 输入→组装 prompt）在 `deepseek-harness/packages/core/agent-loop/src/agent.ts:270`；每个 step 记 `step/start`（`:303`）→ 流式回包（`:406,476`）→ `step/end`（`:313`）。
- **session 事件日志**：会话是**事件溯源**（event-sourced）的——每步都 append 到持久日志，内存态从日志重放（`deepseek-harness/packages/core/session` desc "Event-sourced session store"；官方时序图直接看 `docs/agent-lifecycle.md`，不重画）。
- **与本工作区的关系**：ops-api 会话桥的「turn 终局唯一定位是 `turn/end` durable 事件」（AGENTS.md §5）——正是因为 turn/step 是两级节奏，`assistant/message` 只是 step 中间态。

## 2. 工具 = 发给模型的 function-calling 面

- **模型只见三件套**：`name / description / parameters`（JSON-schema，`deepseek-harness/packages/llm/llm/src/types.ts:439-452` 的 `ToolSchema` "as sent to the model"；官方口径 `packages/core/tools/README.md:10-11`）。
- **`defineTool` 完整面**（`deepseek-harness/packages/core/tools/src/schema.ts:482-536`，实现 `:545-617`）：

  | 字段 | 干什么 |
  |---|---|
  | `name` / `description` | 模型可见的身份 |
  | `parameters` | 属性级 schema，编译成 JSON Schema 并生成 `validate(args)`（`:566-568`） |
  | `output { schema, render, presentationMeta? }` | 结果契约 + 渲染（**必填**，`index.ts:217-218`） |
  | `execute(args, exec)` | 工具体；**包装为「先 validate(args) 再进用户 execute」**（`:585-589`）——模型参数边界的校验铁律（AGENTS.md §138 "validate at model/tool JSON boundary"） |
  | `timeoutMs?` / `isConcurrencySafe?` | 外部 policy 使用；**timeoutMs 永不发给模型**（`index.ts:251-259`） |
  | `finalizeContent?` / `presentCall?` / `presentResult?` | 展示层钩子，软校验（过期回退默认值不抛，`:594-608`） |

- **注册**：`ctx.tools.register(def)` 做二次结构校验（output 契约、run_code 保留名）后 `layers.effect` 插入 scoped 分层表，**返回 disposer 即注销**（`packages/core/tools/src/index.ts:1043-1068`）。schema 自动喂进系统提示（`:834`）。

## 3. 工具管线：三段 waterfall + 单调 guard

官方一句话（`deepseek-harness/docs/tool-execution-pipeline.md:8`）：

> The `tools/pre-execute` waterfall runs first, monotonic guards run next, and the `tools/execute` and `tools/post-execute` waterfalls follow.

```
prepareExecution()
  ├─ ① tools/pre-execute  waterfall（默认内层 allow）
  │     packages/core/tools/src/index.ts:1482-1486
  │     决策：allow / deny / cancel / ask（ask → 接用户审批 :1487-1491）
  ├─ ② 单调 guard（any guard 可 deny，no guard 可 force-allow）
  │     index.ts:1107-1124
  └─ ③ 全过 → dispatch → tools/execute waterfall（工具体在内层跑）:1583
        → tools/post-execute :1741 → 冻结结果 tools/result :1675
```

- **阶段顺序不变量由测试强制**：pre 每个 execution 只触发一次、execute 必须跟在 pre 后、post 必须最后（`packages/core/tools/src/invariant.ts:95-111`）。
- **waterfall 默认行为**：内层 callback 是 `{ kind: 'allow' }`（`:1485`）——监听器不调 `next()` 就是否决（见 [03-cordis-concepts.md](03-cordis-concepts.md) §6）。

### 与本工作区规则的对应（AGENTS.md §7）

| 本工作区规则 | 机制依据 |
|---|---|
| RiskGuard 挂 `tools/pre-execute` 拦截高危动作 | ① 段是执行前第一道闸，返回 deny 即不进 dispatch |
| blockable 口径：仅 `severity=critical && errorCode 非空` 才阻断 | 业务约定——挡在哪一段由 RiskGuard 自己判，非 blockable 记 warn 放行（advisory） |
| `mutatingTools` 只含命令执行类，write/edit 不参与指纹 | 对 exec 的命令字段做识别；工具在哪暴露字段由 `defineTool` parameters 决定 |
| 测试里命令载荷用运行时字符串拼接规避护栏 | 护栏在**运行时**扫 exec 参数——测试代码里的字面量同样会被 ① 段看到 |

## 4. AsyncLocalStorage：harness 的用法与我们的同模式

- **harness 唯一业务用法**：`AgentRegistry` 的 initiator 因果链——两个 ALS 存「当前异步链的发起 Agent」（`deepseek-harness/packages/core/agent/src/index.ts:248-249`），`withInitiator/withoutInitiator` 建立/清除因果边界（`:324-341`）。
- **契约边界**（`:239-244` 注释）：ALS 只提供**同进程因果归属**（日志/追踪），不是活性证明也不是鉴权；身份跨 worker/进程/网络边界仍须显式传递。
- **本工作区同模式**：ops-api 的 memoryKey 用 AsyncLocalStorage 穿透工具注册链（AGENTS.md §4）——同一招：per-request 上下文跟着异步调用链走，不靠参数层层传。无 store 的路径（GUI 会话）给空结果 + 提示语，符合降级铁律 H-15。

## 5. 诚实原则与降级铁律在插件侧的落点

- **降级铁律（H-15）**：记忆/检索等非关键路径失败返回空值 + warn，绝不抛错——实现位置永远是「旁路监听者」（`emit` 类事件、或 waterfall 里先 try-catch 再 `next()`），不放在主链路上抛。
- **BKN 边界**：工具输出经 `_filterCommandFields` 清洗不返回命令串——这是对「模型可见面」（`ToolSchema`）的内容约束，发生在 `output.render`/结果事件层。
- **诚实原则**：无对应 API 的能力显式 405/400——不造假不静默忽略，与「patch 未匹配只 warn」形成对照：**配置层允许静默跳过（幂等生成的前提），API 层必须显式拒绝（薄壳的前提）**。

---

## 自测

1. 一个 turn 里模型连调三次工具，会产生几个 step、几个 step/start？（答：至少 3 个 step 各一对 start/end——step 是「一次模型请求」粒度）
2. `defineTool` 的 `timeoutMs` 会发给模型吗？（答：不会，外部 policy 用）
3. RiskGuard 挂在哪一段？deny 之后还会跑 guard 段吗？（答：pre-execute；不会，deny 直接归一结果不进 dispatch）
4. memoryKey 为什么用 AsyncLocalStorage 而不是参数传递？（答：per-request 上下文要穿工具注册链，参数层层传侵入面太大；跨进程边界它就失效了——harness 同款契约）

## 延伸阅读

- 官方：`deepseek-harness/docs/tool-execution-pipeline.md`（三 waterfall 图）、`docs/agent-lifecycle.md`（turn/step 时序）、`docs/tool-catalog.md`（工具目录）。
- 源码级：`doc/dsh-plugin-internals.md` §5 inventory、§7 工具注册全字段。
- 下一篇：[06-reading-guide.md](06-reading-guide.md)——167 篇官方文档怎么查、哪 5 个坑别踩。
