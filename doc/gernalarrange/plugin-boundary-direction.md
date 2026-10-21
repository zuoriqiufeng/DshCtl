# 插件与编排项目的边界方向规划

> 2026-10-09 · 状态：**方向已定（待条件触发实施）** · 归属：跨领域框架级议题，故放 `doc/gernalarrange/`
> 背景问题：「这个项目其实是编排项目，但我在里面放了很多插件，理论上插件应该和这个项目分开吧」
> 本文**只定方向**：施工单在 §4，触发条件在 §3，显式不做的在 §6。**不含实施，未动任何代码。**

---

## 0. 一句话结论

1. 本仓同时承担**三个角色**：**编排框架**（dshctl + 能力包 + 护栏框架 + registry 机制 + 本目录文档）、**i2stream-ops 方案资产**（4 个插件 + presets + domains + ops 方案文档）、**试验运行环境**（`.dsh-home` + harness 副本）。
2. 插件的正确归属是**方案侧**。所以分界线应划在 **框架 / 方案之间**，而不是「插件 / 项目之间」——这句话是把问题问对的关键。
3. 「搬出去」的路已经铺好一半（registry 引用 + `dsh.plugin.yml` 自述 + `in-place`/`vendored` + `pack`/`install`），但**"可搬移"这一步还没走通**：`plugin pack` 对跨插件依赖会**静默产出跑不起来的包**，而且没有任何校验守这条线（§2.2）。
4. 方向 = **S0 纪律 → S1 可搬移 → S2 分仓**，按 §3 的触发条件推进；**不为提前拆而拆**（`proposal §5.3` 已经就"过早抽象"踩过一次判断）。

> ⚠️ **今天不得把 `plugin pack` 的产物用于任何交付**：它会把不成立的组合判成成功（证据链见 §2.2）。这是本文最需要被记住的一条。

---

## 1. 先消歧义：「外部」在本项目有两个意思

| 说法 | 出处 | 参照物 | 含义 |
|---|---|---|---|
| **外部插件** | `AGENTS.md:13-16`（4 个插件的规则列）、`AGENTS.md:67`（L1 资产分层） | **上游 harness** | 不进上游源码仓、对上游净改动为 0——**不涉及**与本项目分离 |
| **外部来源插件** | `plugin-registry/registry.yml` 的 `source: local \| sources \| git`（类型定义 `code/dshctl/plugin.ts:15-16`） | **本项目** | 从仓库外导入的插件（zip/git），`trusted=false` 需人工信任 |

本文讨论的是后者。**现状**：4 个插件全部 `source: local` + `trusted: true` + `layout: in-place`；`plugin-registry/sources/` 只有 `.gitkeep`（零导入件）；`plugin-registry/registry.yml` 里**没有** `layout` 字段（布局只写在 `dsh.plugin.yml`，与 `doc/dshctl-ux-plugin-ui-plan.md:84` 的早期设想不一致）。

> 你这次会问，正是因为「外部插件」这个词读起来像"独立于项目"。AGENTS §1/§6 的原意是前者；本文件把它作为**已知歧义**记录在此，后续文档应避免裸用「外部插件」一词。

---

## 2. 现状基线（逐条带证据）

### 2.1 资产归属（判据：**是否随领域/实例变化**）

| 目录 / 文件 | 归类 | 判据 |
|---|---|---|
| `code/dshctl/` | **框架**（混装：3 处 ops 残留 + 仓库布局硬编码） | `AGENTS.md:17` 交付期工具；`code/dshctl/dshctl.ts:29` `ROOT = join(import.meta.dirname,'..','..')`（写死 dsh-info/）；`code/dshctl/gui/server.ts:24` 同款 |
| `code/capability-packs/` | **框架**（`remote-exec.yml` 是方案侧勾选项） | `code/capability-packs/core.yml:4`（description "（所有领域恒隐含必裁）"） |
| `code/guard-rule-sources/` | **框架**（当前空壳） | `code/guard-rule-sources/whitelist.yml:1` "首个消费方 = SQL 转换域" |
| `plugin-registry/core.yml` | **框架**（R11 判据数据） | `plugin-registry/core.yml:1-6`（R11 语义与判据口径） |
| `plugin-registry/registry.yml` | **混装**：机制=框架，内容=方案 | 4 条全是 i2stream 系插件 |
| `doc/gernalarrange/` | **框架** | `AGENTS.md:22` 原文"跨领域复用资产" |
| 4 个插件目录 | **方案** | id/描述/默认 config 全带 i2stream 语义（`dsh.plugin.yml`） |
| `code/presets/i2stream-ops/` | **方案** | `AGENTS.md:19` 运维 agent preset 作者源 |
| `domains/` | **混装**：机制=框架、`ops/`=方案、`demo-x`/`graph-smoke-bad`=空壳残留 | — |
| `code/scripts/` | **混装**：框架工具 / ops 专用 / 插件私有生成器 三档并存 | `bench-4q.sh` 与 `ops-stack.sh` vs `gen-intent-taxonomy.ts` |
| `AGENTS.md`、`doc/*.md` | **混装**：工作区治理+框架知识与 ops 方案细节同处一文件 | §1/§6 是框架规则，§5/§7/§8/§9 是 ops 细节 |

### 2.2 「可搬移」通道的真实能力

| 动作 | 今天能否做到 | 卡点 |
|---|---|---|
| `plugin pack`（自包含插件） | 能 | 见下"假成功链条" |
| `plugin pack`（**含跨插件相对 import**） | **机械上成功、产物必坏、零检测** | 同下 |
| `plugin install --in-place` | 能 | `path` 是本机绝对路径，换机即断 |
| `plugin install --vendored` | 能（同机） | 拷 `<home>/plugins/<id>/`；相对资源（`../guard-rule-sources/whitelist.yml`）**失效**，且缺失时是 fail-closed（见 §2.3） |
| zip / git 导入 → `sources/` | 能 | 整包解压 + 入口探测；`trusted=false`，`plugin trust` 只翻布尔位（`code/dshctl/plugin.ts:96-101`，无内容校验）；github HTTPS 在本环境不可达 |
| `domain export` 带走插件 | **不能** | 包内不含插件源码；README 前提第 3 条明写需自备"in-place 插件源码"（已核 `tar tzf`：`code/`、`plugins/` 命中 0） |
| `pack → 装到新 home 真跑` | **从未验证过** | self-test 对 `packPlugin` 覆盖为 0；文档只给命令（`code/dshctl/dshctl.ts:582`） |

**pack 的"假成功"链条**（逐行核实，这是本节的结论依据）：

1. staging **只递归拷贝插件自身目录**（`code/dshctl/unitize.ts:285-297`），兄弟目录一律不进入；
2. `collectPeerDeps` **明确忽略相对 import**（`code/dshctl/unitize.ts:105` `spec.startsWith('.') → continue`）；
3. tsc 类型错误**不阻断 emit**（`code/dshctl/unitize.ts:317` 注释明说"类型报错不阻断产物"）；
4. 成功判据**只有** `existsSync(staging/lib/<entry>.js)`（`code/dshctl/unitize.ts:332`）；
5. 文本模式下 `ok:true` 时连 `errors[]` 都不打印（`code/dshctl/dshctl.ts:580-582`）。

活样本：`code/intent-router` 现有 4 处 `../dsh-plugin/*` import（§2.3），今天 pack 它会**退出码 0、产出 tgz**，装进 profile 后运行时 `ERR_MODULE_NOT_FOUND`。

### 2.3 跨插件耦合清单（全仓盘点）

**运行时代码（会阻碍独立成仓）——3 处，全在 intent-router → dsh-plugin：**

| 位置 | 复用什么 |
|---|---|
| `code/intent-router/index.ts:29` | `ERROR_ALIASES, SYMPTOM_ALIASES`（口语别名表） |
| `code/intent-router/logfile.ts:23` | `rotateIfNeeded`（大小轮转，BKN Python 的 TS 移植） |
| `code/intent-router/bm25.ts:12` | 再导出 `tokenize/BM25Scorer/rrfFusion` |

**自测：** `code/intent-router/self-test.ts:15`（同别名表）。**脚本：** `gen-intent-taxonomy.ts`、`eval-intent.ts`、`bench-tools.ts`、`gen-hotpath-prompt.ts`（后两个属插件私有工具，不阻碍分发）。
**相对资源：** `code/dsh-plugin/index.ts:104` 的默认 `whitelistPath` 指向插件目录之外（`../guard-rule-sources/whitelist.yml`），`ruleSource=whitelist` 时缺文件**不报错**而是空白名单 → 表现成"所有命令被拦"（`code/dsh-plugin/riskGuard.ts:598` 注释"缺文件 → 空白名单（全 deny，fail-closed）"）。

**其余三个插件零跨插件 import**（dsh-plugin / ops-api / ops-skill-manager 内部只 import 自己 + node 内建 + `@deepseek-ai/*`）。

### 2.4 消费方现状（这条决定了"分不分"的现实压力）

- **同一份插件源码已被两个实例、两条 harness 树同时引用**：现网 `/root/.dsh/profiles/web/cordis.patch.yml:15,25,59` 与试验 `.dsh-home/profiles/ops/cordis.patch.yml` 都指向 `/hdd/demo/public/dsh-info/code/...`（重叠：bkn-plugin + ops-api + presets 根）；两条树版本分别是 **v0.1.5-rc.1**（`/hdd/agent/deepseek-harness`）与 **v0.2.1-alpha.1**（本工作区）。
  → 也就是说：插件**已经在跨 harness 版本活着**。这本身就是"插件应当有独立契约面与版本"的现实理由，而不是纸上推论。
- **下一个域不复用本仓插件**：SQL 转换域复用 dshctl / 能力包 / 护栏框架，但"领域工具插件：**不需要**"（`proposal §6.2` 对照表）。
- **Hermes 侧另有同名实现**：`/hdd/demo/public/hermes-plugin/intent-router/`（Python），与 `code/intent-router/` 理念相同、**代码不共享**。
- 迄今**没有**"两个域复用同一个插件"的实例；`domains/` 只有 ops 一个真域。

---

## 3. 目标形态：三个阶段（含完成判据与触发条件）

| 阶段 | 形态 | 完成判据 | 触发条件 |
|---|---|---|---|
| **S0 纪律** | 同仓，但插件不再新增跨目录耦合 | 新增/改造的插件零跨插件运行时 import、零越界资源 | **立即生效**（写进 AGENTS §1） |
| **S1 可搬移** | 同仓，但**任一插件一条命令可搬走** | 某插件 `pack → install --vendored → 启动真跑` 通过 + 机器校验守护自包含 | 出现第二个消费方（第二个域/第二棵树），或需要与外部交换插件 |
| **S2 分仓** | **框架仓 / 方案仓**（形态已定，见下） | 两仓各自 CI 绿；registry 以外部来源引用插件并经过 trust 审查 | S1 完成 + 框架侧根覆盖就位（§4 S2 行） |

**S2 的切法（形态已定）**：

- **框架仓** = `code/dshctl/` + `code/capability-packs/` + `code/guard-rule-sources/` + `plugin-registry/core.yml`（机制）+ `doc/gernalarrange/` + `doc/dshctl-*.md` + `doc/dsh-guide/`
- **方案仓** = 4 个插件 + `code/presets/` + `domains/` + `plugin-registry/registry.yml` + ops 方案文档 + `code/scripts/` 中插件私有的那部分

**为什么不选「每个插件各自独立仓」**：① `proposal §5.3:265` 已定 —— 「**不做"通用领域工具插件框架"**……两个相似实例就抽象框架，收益抵不上维护成本」；N 个插件 N 套版本/CI/发布链正是这种"提前抽象"的翻版；② 插件与所属域的 `domain.yml`/presets/skills/BKN 引用天然同生命周期，拆成两条流水线只增加对齐成本。

**为什么不选「不搬出去、只打通外部导入」**：那条路（`sources/` + `trusted`）确实该做实，但它解决的是"别人给我插件"，与"我的插件要跨项目复用/跨 harness 版本活着"（§2.4 的现实）是两件事，二者不互斥——S1/S2 不排斥继续完善导入通道。

---

## 4. 阶段动作表（施工单）

### S0（纪律，零改动成本，立即可生效）

| 动作 | 落点 |
|---|---|
| 插件不得 import 其它插件目录（运行时 + 自测） | 新插件评审；`AGENTS §1` 立规 |
| 跨插件复用只走两条路：**数据 → 生成物快照**、**纯原语 → 本插件内副本 + 漂移断言** | 同上 |
| 外部资源必须经 config 传入，且缺省行为必须 **fail-safe**（不得出现"缺文件即静默全禁"这类陷阱） | `dsh.plugin.yml` + 插件 config 默认值 |

### S1（可搬移）

| # | 动作 | 涉及文件 | 验收 |
|---|---|---|---|
| 1 | 断掉 intent-router 的 3 处跨插件 import：别名表进 `taxonomy.generated.json`（生成器已在读 dsh-plugin，改一处快照即可）；`bm25`/`RRF`/`rotateIfNeeded` 约 120 行复制进本插件并列明来源 | `code/intent-router/{index,bm25,logfile}.ts`、`code/scripts/gen-intent-taxonomy.ts` | `grep -rn "from '\.\./dsh-plugin" code/intent-router` 为空（运行时+自测）；self-test 全绿且新增**漂移断言**（副本与源实现同黄金输入同结果） |
| 2 | `plugin pack` 前自包含检查 **fail-loud**：相对 import 越出插件目录、或 `../` 资源未声明 → 拒绝打包并打印原因 | `code/dshctl/unitize.ts` | self-test 新增反例断言（含 intent-router 这类跨插件 import 的负例） |
| 3 | `check` 新增规则：跨插件相对 import、越界资源 → error | `code/dshctl/{check,plugin}.ts` | `dshctl check ops --ci` 覆盖；`AGENTS §8` 无需变 |
| 4 | `pack → plugin install --vendored → 启动真跑` 闭环验收（含 vendored 下 whitelist 缺省陷阱） | 脚本 + 验收文档 | 至少一个插件走通并留 live 证据 |
| 5 | （按需）外部资源清单进 manifest：`resources: [...]`，pack 拷贝 / vendored 重写 | `dsh.plugin.yml` schema + `code/dshctl/unitize.ts` | 仅当真有插件需要插件目录外的资源时启动 |

### S2（分仓）

| # | 动作 | 前置 |
|---|---|---|
| 1 | dshctl 加根覆盖（`DSHCTL_ROOT` 或等价），使框架仓能指向方案仓的 `domains/`、`plugin-registry/`、`capability-packs/` | 现在写死：`code/dshctl/dshctl.ts:29`、`code/dshctl/gui/server.ts:24`，且无 env 覆盖 |
| 2 | 按 §3 切两仓；方案仓的插件经 registry 以 `source: git|sources` 引用 + `trusted` 审查 | S1 全绿 + 上一条就位 |
| 3 | 两仓 CI 各自可跑（方案仓需要 harness 树；框架仓的 self-test 不依赖插件） | 同上 |

---

## 5. 硬规则（S0 起生效，建议同步进 `AGENTS §1`）

1. **插件不得 import 其它插件目录**（运行时代码与自测都算）。
2. **插件不得依赖插件目录之外的相对资源**；外部资源一律经 config 传入，且缺省必须 fail-safe（宁可"功能降级并 warn"，不可"静默全禁"）。
3. **跨插件复用的唯一两条合法路径**：① 数据 → 生成物快照（生成器读源、产物落在插件内）；② 纯原语 → 本插件内副本 + 漂移断言（黄金输入同结果）。
4. **外部依赖必须登记** `plugin-registry/registry.yml` 的 `external`（现有约定，见 bkn-plugin/ops-api 条目），让"插件需要什么"可被 `plugin show` 看见。
5. **`plugin pack` 的产物在 S1 验收通过前不得用于任何交付**；S1 之后必须经自包含检查才能出包。

---

## 6. 显式不做（继承既有决策 + 本次新增）

**继承（原文口径）**：
- 不做"通用领域工具插件框架"——`proposal §5.3:265`；
- 不做工具级开关的 DSH 侧实现 / 不做多实例统一 GUI 聚合面 / 不动 web-ui 命名与结构——`proposal §9` 明确不做清单；
- 不管理共享基础设施本体（dshctl 只校验可达性）、GUI 不直连运行期接口——`doc/gernalarrange/dshctl-design.md:20-32`。

**本次新增**：
- 不做插件市场 / 发布流水线 / 版本仓库；
- 不引入插件间依赖注入框架（`ctx.provide` 只用于**本进程内的能力暴露**，不作为插件间代码复用机制）；
- **不把 `dsh-plugin` 挪出本仓**：它绑死 i2stream 语义与共享 BKN，且已被两棵树共同引用（§2.4），搬它只会同时打断两个实例；
- 不为分仓而提前重构 dshctl 的仓库布局硬编码（那是 S2 的前置项，不是 S1 的动作）。

---

## 7. 风险与反制

| 风险 | 反制 |
|---|---|
| 纪律靠人守会退化（S0 无机器约束） | S1 落地 check 规则 + pack fail-loud；在那之前，插件评审把 §5 当检查单 |
| **pack 的"假成功"被当成可用产物** | 本文 §0 警示 + S1 动作 2；在 README/manual 里也应标注"pack 通道未验收" |
| vendored 的 fail-closed 空白名单（表现为"命令全被拦"） | 进 S1 动作 4 的验收清单 |
| 分仓切断 dshctl 的默认相对路径（`domains/`、`plugin-registry/`、`capability-packs/`） | S2 动作 1 先加根覆盖，再动刀 |
| 「外部」一词两种含义继续造成误解 | 本文 §1 记录歧义；后续文档裸用该词时应加限定（"相对 harness"/"外部来源"） |
| 过早拆仓导致双份 CI 维护成本 | 阶段化 + 触发条件（§3）；无触发条件不动 |

---

## 8. 待决开放项

1. S1 校验规则的编号与形态（新增 R15？还是并入 R12 的插件对齐检查？两者都做？）。
2. 是否为 dshctl 引入 `DSHCTL_ROOT` 类根覆盖（S2 前置；也可先作为通用改进做）。
3. 外部资源是否进 `dsh.plugin.yml`（`resources: [...]` 声明 + pack/vendored 的拷贝与重写规则）。
4. `domain export` 是否要补"把 in-place 插件源码一并打包"（现状导入机需自备项目目录，与"自包含可搬移"的表述有落差）。

---

## 附：本文引用复核记录（2026-10-09）

写入前已逐条核对行号与事实，包括：`code/dshctl/unitize.ts:94/105/285/332`（pack 行为）、`AGENTS.md:8/13-16/22/64/67`（§1/§6 原文）、`proposal §5.3:265` 与 `:246`（"现状不动"）、`code/dshctl/plugin.ts:60/96/128`、`code/dshctl/check.ts:249-253`（R12 挂点）、`code/dsh-plugin/riskGuard.ts:598`（fail-closed）、`code/dsh-plugin/index.ts:104`（越界资源默认值）、`code/dshctl/dshctl.ts:29` 与 `code/dshctl/gui/server.ts:24`（布局硬编码）、`code/dshctl/dshctl.ts:580-582`（pack 消费指引）、`plugin-registry/registry.yml`（无 layout 字段）、`/root/.dsh/profiles/web/cordis.patch.yml:15,25,59`（跨树共用源码）、`tar tzf` 复核 export 包不含插件源码、两条 harness 树版本（0.1.5-rc.1 / 0.2.1-alpha.1）。
