# dshctl 用户手册

> 面向使用者的完整手册：如何使用 GUI/CLI、DSH 插件体系是什么、编排原理、常见问题。
> CLI 命令逐条参考见 `doc/dshctl-manual.md`；实施与踩坑记录见 `doc/dshctl-exec-plan.md`。
> 版本：v5（2026-09-17）

---

## 目录

1. [5 分钟上手](#1-5-分钟上手)
2. [页面操作指南](#2-页面操作指南)
3. [DSH 体系与插件介绍](#3-dsh-体系与插件介绍)
4. [dshctl 编排原理](#4-dshctl-编排原理)
5. [目录结构全景](#5-目录结构全景)
6. [CLI 速查](#6-cli-速查)
7. [FAQ 与故障排查](#7-faq-与故障排查)

---

## 1. 5 分钟上手

```sh
# 起 GUI（默认只绑回环；内网访问加 --host 0.0.0.0）
cd /hdd/demo/public/dsh-info/code/dshctl && ./bin/dshctl-gui --host 0.0.0.0
# 浏览器打开 http://<机器IP>:8780（改动没生效先 Ctrl+Shift+R 强刷）
```

三步走：

1. **看健康**：「概览」页——统计卡（实例/领域/能力包/依赖健康）+ 每领域最近 7 次 check 趋势点阵。绿点连串 = 一直健康。
2. **跑对账**：「领域管理」→ 点左侧领域 → 详情页 check 页签自动运行。全绿即可放心；有 error 点行展开看全文，底部有 R1-R12 规则图例。
3. **改 / 跑**：编辑页签表单化改 domain.yml（顶部锚点跳分区）；概览页签可**启动/停止/重启**实例（真控制 systemctl，二次确认）或**冒烟测试**（临时实例，不碰现网）。

日常巡检一条命令：`bash code/dshctl/ci.sh`（或 `dshctl check ops --ci`）。

---

## 2. 页面操作指南

### 概览
体系一屏总览（轻量聚合，不触发重对账）。最近 check 表行样式纤细化，**点行直达领域详情**。CLI 等价命令收在页面右上角「等价命令」按钮里。

### 实例登记
registry.yml 视图：哪些实例在册、API/GUI 端口、托管 unit、运行状态、最近 check（纤细四列：领域/端口/状态/最近结果）。**点行开详情抽屉**（DSH_HOME、unit、最近 check、等价命令）。未登记端口不再在页内提示——统一进 Header 铃铛「提示中心」。

### 提示中心（Header 铃铛）
Header 右侧铃铛聚合静态+动态提示，三级分组：**错误**（最近 check 有 error 的领域）/ **警告**（untrusted 插件被引用、领域插件未入库）/ **提示**（升级对账 verdict≠pass）。Badge 显示 error+warn 未读计数；**点条目直达对应页面并自动标记已读**（服务端持久化，刷新不复活）；抽屉底部有「全部已读」。底层问题变化（如新一次 check 失败）会以新条目重新亮起。

### 领域管理（核心工作区）
- **左栏**：领域列表——check 结果光点（配置健康）与运行状态（进程活着）并列两个维度。
- **点击领域 → 独立详情页**，五个页签：
  - **编排**：Dify 式画布。四层布局：能力包 → 领域插件 → domain-api → 外部依赖。**上下拖动插件节点 = 调整注册顺序**（写回 plugins[]，影响 patch insert 注册序），点「保存顺序」生效；双击节点看详情；实线=推导依赖、虚线=depends_on 声明。
  - **概览**：运行状态（启停/重启/冒烟）+ 领域信息 + 插件卡（库对齐徽标）。
  - **check**：R1-R12 全规则对账，级别过滤 + 展开行读全文。
  - **diff**：apply 生成面 vs 现状。空 = 程序正确理解现状；非空逐项人工确认。
  - **清单编辑**：表单化编辑 domain.yml（十分区 + 锚点导航），保存即 schema 校验 + 原子写。

### 插件库
- **插件目录**：按分类（知识网/对外 API/技能管理/其他）分区的正方形卡片墙——首字母头像 + id + 一句话作用 + 能力数量 + 信任色点；顶部搜索 + 信任过滤；点击开详情抽屉（作用/provides Tag 墙/depends_on/登记信息/信任与移除操作）。
- **新建 · 导入**：四张方法卡（2×2），每张自包含「什么时候用」+ 编号指引 + 表单——① 路径收编（本地源码，登记引用不拷贝）② zip 上传（落 sources/，zip-slip 过滤，50MB 上限）③ GitHub 导入（需网络可达，本环境不可达）④ publish（领域编排定稿后一键入库）。
- **核心功能**：61 项**左清单 + 右详情**主从结构（VS Code Marketplace 心智），**等高双栏（580 定高，两栏各自内滚，底边对齐）**——左侧搜索定位 + sticky 分组清单（行内只留 id + 已开槽青点，**描述全文悬停 0.3s 披露**；点行即选中 = 蓝底 + 左竖条，**无行内按钮**），右侧三层详情（**渐变磁贴头区带**[40px 紫青磁贴 + 槽态 Tag + 组 + ⓘ] → 内容区[作用全文 / 状态节[豁免语义收 ⓘ 悬停] / 槽成员 chips / 等价命令] → **底部动作条**），**唯一动作入口「替换…」**→ 600 宽三阶段 Drawer（渐变图标头部卡 + 旧→新对比卡 → 表单 → 预演[verdict 横条 + 步骤时间线 + **行级 diff** + 等价命令] → 执行结果[含 R11 槽豁免徽标 + 回退指引] + 常驻操作条；表单变更 500ms 防抖自动预演，同源 `dshctl replace` 全链引擎，check 不过自动回滚）。

### 升级对账
harness 更新后跑一遍：全领域 roster 对账。PASS 才进升级第 3 步；BLOCKED 表示有"消失 id"需跟进；消失 id 可一键复制。

### 新建领域
向导五步：标识 → 基本信息 → 能力与护栏 → 插件与 API → 端口与依赖。只写 domain.yml；实例骨架走 `dshctl apply`。

---

## 3. DSH 体系与插件介绍

### DSH 是什么

DeepSeek Harness（DSH）是一个 **everything-is-a-plugin** 的 Agent 运行时：会话、模型、工具、UI、存储、护栏……全部是插件，由 loader 按配置装配成一个实例。一个"实例" = 一个 DSH_HOME（配置/数据/日志）+ 一个 profile（装配清单）+ 一个 harness 源码树（运行时代码）。

### 插件怎么被加载

profile 的 `cordis.patch.yml` 以 **id** 为键增删改插件行：

```yaml
- insert:
    - id: bkn-plugin
      name: /hdd/demo/public/dsh-info/code/dsh-plugin/index.ts   # ← 绝对路径 = 本地插件
      config: { ... }
    - id: mcp-i2agent
      name: '@deepseek-ai/dsh-mcp-client'                        # ← 包名 = 上游插件
- id: ui-goal
  disabled: true                                                  # ← 按 id 裁剪
```

- **上游插件**（`@deepseek-ai/*`）：包名走 node_modules 解析，随 harness 版本升级。
- **本地插件**（绝对路径 TS）：loader 对 `name` 做裸 `import()`——任何磁盘上的 TS 文件都能挂。**这就是 dshctl 编排能生效的机制基础**：插件库登记的就是这种绝对路径。
- **config 整段替换语义**：patch 里给的 config 会整体替换默认值——漏字段 = 丢默认配置（所以 smoke overlay 只改 port 也要整段复制 config）。

### 本工作区的核心插件

| 插件 | 作用 |
|---|---|
| `bkn-plugin` | BKN 语义检索 12 工具 + RiskGuard 风险护栏（tools/pre-execute 策略） |
| `ops-api` | 对外面：api-server + 会话桥 + 记忆接入 + supervisor |
| `ops-skill-manager` | 技能自管理（skill_manage 工具 + usage 台账） |
| `mcp-i2agent` | 远程受控执行面（i2agent MCP，:8090） |

---

## 4. dshctl 编排原理

### 一句话

**一份 domain.yml 描述一个领域** → check 校验 → apply 幂等生成实例骨架 → 实例按 systemd 运行。

```
domain.yml ──check(R1-R12)──▶ apply ──▶ $DSH_HOME/profiles/<域>/    manifest + cordis.patch.yml
                                         $DSH_HOME/bundles/ops-app/ 纯增量裁剪层（按 id disable）
                                         $DSH_HOME/presets/          persona + 热路径
```

### 能力包（capability packs）

`code/capability-packs/*.yml`——把"该裁什么"从清单里抽象成可复用片段：

- **core 恒隐含必裁**：UI 面 / 编码 agent 面（subagent/goal/plan/web 等）——每个领域都裁；
- **keep_tools 语义**：勾选某能力包时把 core 的对应 disable"放回"（如 script 包放回 bash/terminal/run_code）；
- **归属唯一**：每个 id 只属于一个片段（同 id 多片段报错）；
- **core.yml 插件库页签的 61 个核心功能是另一条红线**：核心功能不可缺，无槽 id 任何能力包 disable 命中 → **R11 error**；带 slot 标记的功能槽（如 llm-adapter：llm-deepseek/llm-pi-ai/自研扩展）同槽有活跃成员即可替换。

### 校验规则 R1-R12（check 全量）

| # | 查什么 |
|---|---|
| R1 | 端口与登记：domain 唯一、端口不冲突、占用端口与 unit 自证 |
| R2 | 上游 id 存在性（消失 = 上游改名，你的裁剪静默失效） |
| R3 | 上游新增行评估 |
| R4 | script 包必须配命令白名单 |
| R5 | 契约目录 ⊆ 写白名单 |
| R6 | skills frontmatter 合法 |
| R7 | 超时配置不倒挂 |
| R8 | 密钥只准 env 变量名 |
| R9 | 共享依赖探活 |
| R10 | 归层缺口 |
| R11 | 核心功能不可缺（槽内可替换） |
| R12 | 插件库对齐（未入库/path 漂移 → error；untrusted → warn） |

### 插件库与信任模型

- **登记引用为主**：registry.yml 记录入口文件绝对路径，源码不搬家（改动即时生效）；
- **导入件**（zip/git）落 `plugin-registry/sources/<id>/`，默认 **untrusted**——被领域引用时 R12 出 warn，人工核实源码后"标记信任"才静默；
- **编排画布**：四层推导依赖（实线）+ 插件库 `depends_on` 声明（虚线）；拖拽插件排序写回 `plugins[]`（影响 patch insert 注册序）。

### 生命周期（起停/冒烟）

- 实例由 systemd 托管（`Restart=on-failure` 瞬态 unit，run-ops-trial.sh 模式）；GUI 概览页的启动/停止/重启是**真控制**（unit 只取自 registry，固定 argv 调 systemctl）；
- 冒烟测试永远不动现网：+100 端口起临时实例 → /health 轮询 → api-smoke 五连测 → 自动清理。

### 核心功能替换指南

**原则**：core.yml 锚定的是**核心功能**不是实现——everything-is-a-plugin，61 项机制上**全部可替换**（`slot:` 标记 + `slots:` 声明同槽成员 → 禁旧记豁免）。已开槽的 5 个是「有真实上游兄弟」的（第 6 个有兄弟的 sandbox 族是平台正交共存、非互斥槽，不开）：

| 功能槽 | 成员（载体加粗） | 替换模式 |
|---|---|---|
| llm-adapter | **llm-deepseek** / llm-pi-ai / 自研 adapter | 共存（注册键不同，撞键报错不覆盖） |
| shell-exec | **bash-sandbox** / bash-local / pwsh-local | 先禁后启（同 `shell` 服务名） |
| fs-impl | **fs-sandbox** / fs-local / fs-ssh | 先禁后启（同 `fs` 服务名） |
| storage-backend | **storage-json** / storage-sqlite | 共存切换（`storage.backend.*` 不同键，`storage-domain` 的 `config.backend` 选） |
| bash-tool | **tool-bash** / tool-bash-persistent | 先禁后启（同工具名 `bash`，双开报 already registered） |

其余 55 项无上游候选（单例函数）——自研同接口实现后按同样方式声明即可替换。

**三种替换模式**（按函数类型选）：
- **M1 共存增补**：注册键/服务键不同 → 新旧并排挂，切换靠 config，旧件可后禁；撞键时**报错不覆盖**（先注册者胜）。
- **M2 先禁后启（swap）**：同服务名/同工具名互斥——`provide` 同 scope 重名**同步抛错**（`service "x" has been registered at …`，fiber FAILED）；同名工具双开抛 `already registered in this scope`。**顺序必须先 `disabled: true` 旧件、再启用新件**。
- **M3 纯重实现**：函数插件（同类工具/事件注册）无服务名冲突，禁旧启新即可。

**六步流程 × 把关规则**：

| 步 | 动作 | 把关 |
|---|---|---|
| 1 写实现 | 按 seam 接口选模式（同 `super(ctx,'…')` 服务名 = M2；注册键不同 = M1） | 自测 |
| 2 入库 | `dshctl plugin add/publish` + 信任 | **R12**：未入库/path 漂移 error，untrusted warn |
| 3 插入实例 | 能力包/patch 插入新 id → `apply` | **R10** 归层缺口；check 有 error 拒绝 apply |
| 4 声明+禁旧 | core.yml `slots` 追加成员；能力包 `disable` 旧件 | **R11 槽豁免**：成员需**存在证据**（roster ∪ 本域插件）；裁空 error |
| 5 验证 | `dshctl check <域> --ci` + `dshctl smoke <域>`（临时实例真跑，不动现网） | 全绿才收工 |
| 6 回退 | 清单还原（去 disable/去成员声明）重跑 `apply` | 清单幂等重生成 |

> **步骤 2-4 可 `dshctl replace` 一键代劳**（预检 → 声明槽成员 → 插入 plugins[] → 禁旧 → check 验证，check 不过自动回滚三处写入；无 `--yes` = 预演零写入）：
>
> ```sh
> # 预演：打印计划不落盘
> dshctl replace llm-deepseek --with my-adapter --domain ops --path /abs/my-adapter/index.ts
> # 执行（等价步骤 2-4；--smoke 可并入步骤 5 的冒烟；--keep-old = M1 共存不禁旧）
> dshctl replace llm-deepseek --with my-adapter --domain ops --path /abs/my-adapter/index.ts --smoke --yes
> ```
>
> 执行后打印步骤清单 + 等价命令 + 回退指引（反向编辑三处 + 重跑 apply/check；v1 无 `--undo`）。GUI 等价入口：插件库 → 核心功能页签 → **左清单点选组件 → 右侧详情「替换…」**→ 600 三阶段 Drawer（表单 / 预演含行级 diff / 执行结果，输入即 500ms 防抖自动预演；未开槽的执行时自动建槽，执行同源引擎）。

**注意**：
- 成员**存在证据**：不在 roster 缓存里的新成员（如 storage-sqlite 默认不在 profile），先插入实例再 `dshctl check <域> --refresh` 刷新 roster，豁免才生效——只在 slots 声明不插入 = 裁空报错（防「假声明」）。
- **deepseek 连带件**：换掉 llm-deepseek 后 `deepseek-llm-api-extensions`、`plugin-package-inventory-deepseek` 失效**空转但无害**——默认保留不必禁；确要禁须各自声明槽成员（诚实说明：上游无 neutral 等价包）。
- storage 切换示例：profile 用户层插入 `storage-sqlite` → `storage-domain.config.backend: sqlite` → `--refresh` → 能力包禁 `storage-json` → check 记槽豁免 → smoke 验证。

---

## 5. 目录结构全景

```
dsh-info/
├── doc/                      # 全部文档（本手册/CLI 参考/方案/实施记录）
├── domains/                  # 领域清单（唯一长期维护物）
│   ├── <域>/domain.yml
│   ├── registry.yml          # 实例登记表
│   └── .cache/               # roster 缓存 + smoke overlay + check 历史
├── plugin-registry/          # 插件库
│   ├── registry.yml          # 插件目录（登记引用）
│   ├── core.yml              # 核心功能清单（R11 红线：功能不可缺、槽内可替换）
│   └── sources/              # zip/git 导入件快照
├── code/
│   ├── dshctl/               # 本工具（CLI + GUI；自带 tsx，任意目录可跑）
│   ├── capability-packs/     # 能力包片段
│   ├── dsh-plugin/           # bkn-plugin 源码
│   ├── ops-api/              # ops-api 源码
│   ├── ops-skill-manager/    # 技能自管理插件源码
│   ├── presets/              # agent preset（persona + 热路径）
│   ├── scripts/              # 运维脚本（run-ops-trial.sh / bench / smoke）
│   └── sidecars/             # embed-server 等独立进程
├── .dsh-home/                # 现网 DSH_HOME（profiles/bundles/presets/skills/ops.env）
└── deepseek-harness/         # 上游 harness 源码树（净改动=0）
```

---

## 6. CLI 速查

```sh
dshctl adopt --instance <名>        # 反向归档现存实例 → domain.yml
dshctl check <域> [--ci] [--json]   # 全规则对账（R1-R12）
dshctl diff <域>                    # 生成面对比（空=正确理解现状）
dshctl apply <域> [--dry-run] [--yes]  # 生成/落盘实例骨架
dshctl smoke <域> [--bench]         # 临时实例冒烟
dshctl upgrade-check [--refresh]    # 升级跟随对账
dshctl registry                     # 实例登记表
dshctl plugin list|add|remove|trust|publish|import|import-git   # 插件库
dshctl replace <旧> --with <新> [--domain] [--keep-old] [--path] [--smoke] [--yes]  # 替换通道全链（无 --yes=预演）
dshctl-selftest                     # 自测（[1]-[18] 段 150 断言）
dshctl-gui [--host] [--port]        # GUI
bash code/dshctl/ci.sh              # 五环节一键巡检
```

---

## 7. FAQ 与故障排查

**页面白屏 / 改动没生效？**
浏览器缓存旧 JS——Ctrl+Shift+R 强刷。

**git 导入失败？**
本环境实测 github.com HTTPS 不可达——走 zip 上传；或配代理后再试（错误信息里有提示）。

**start 报 "Unit not found"？**
systemd-run 瞬态 unit 被 systemd 回收了：`bash code/scripts/run-ops-trial.sh start` 重装（GUI 错误信息也会给出这个引导）。

**密钥怎么配？**
清单只写环境变量名（R8 强制拦明文），值放 `$DSH_HOME/ops.env`（权限 600）。

**GUI 安全边界？**
GUI 无鉴权且具备清单写入与实例起停能力——**仅限可信内网**。默认只绑 127.0.0.1；`--host 0.0.0.0` 需显式指定（启动日志会打印安全提示）。

**check 报 R2 消失 id？**
上游 harness 升级把某 id 改名/删除了——ops-app 裁剪层里对应行需要跟进（改名或删除），否则裁剪静默失效。

**8642 端口为什么不能用？**
疑似 Hermes 残留占用，归属待确认——见 registry.yml 的 unregistered_ports 注释与运维手册。

**上游升级后要做什么？**
`dshctl upgrade-check --refresh` → PASS 才按 ops-trial-operations-manual 第 3 步替换产物/重启。

---

*手册与实现同源维护：GUI「使用手册」页是本手册的精华版；两者冲突以代码行为准并回填文档。*
