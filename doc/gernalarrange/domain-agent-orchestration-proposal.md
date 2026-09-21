# DSH 领域 Agent 编排通用方案建议

> 2026-09-16 · 依据：运维域全部方案/执行文档（doc/ops-agent-*.md）+ SQL 转换项目实地盘点（/hdd/agent/stream-agent/sql_transform）
> 定位：把"运维 agent 编排"的一次性经验，沉淀为可复用的**领域 Agent 编排方法 + 资产结构**，并给出 MaintenanceAgent 管理面与 SQL 转换域的落地方案。
> 上游：`ops-agent-orchestration-plan.md`（运维域编排方案）、`ops-trial-operations-manual.md`（双实例运维手册）

---

## 0. 已确认决策（2026-09-16 用户拍板）

| # | 决策点 | 结论 | 影响 |
|---|--------|------|------|
| D6 | 管理面管理对象 | **两者都要**：i2Console 统一管理 DSH 侧资源（skill/MCP/工具）+ i2Agent 自身 MCP 工具暴露面 | 见 §4 |
| D7 | 多领域运行形态 | **独立实例**：每领域独立 DSH_HOME + 独立进程 + 独立端口（不同环境/需求下隔离优先） | 见 §3.1、§5 |
| D8 | SQL 转换域能力面 | **需要文件/脚本能力**（读输入文件、写 MEDIA 输出、跑 obclient 验证） | 能力包分层的首个差异化案例，见 §3.2、§6 |

---

## 1. 背景与现状盘点

### 1.1 运维域已交付资产（编排的"第一桶金"）

| 资产 | 位置 | 性质 |
|------|------|------|
| ops-app 增量 bundle（本层 disable 43 项 + connection 覆写 1 项；另有上游自带 disabled 15 项） | `$DSH_HOME/bundles/ops-app/cordis.patch.yml` | 能力面裁剪（核心层 + 运维定制，待归层） |
| i2stream-ops preset（persona + 热路径 + skill 挂载） | `.dsh-home/presets/i2stream-ops/` | 会话组合 |
| dsh-plugin（BKN 12 工具 + RiskGuard + 检索栈） | `code/dsh-plugin/` | 领域工具插件 |
| ops-skill-manager（skill_manage 工具 + usage 台账 + curator 迁移） | `code/ops-skill-manager/` | 领域技能自管理插件（2026-09-16 挂载） |
| ops-api（OpenAI 兼容面 + 多轮 + 记忆 + /admin 管理面 + api-server） | `code/ops-api/` | **通用接入/管理层**（领域无关度 90%） |
| embed sidecar | `code/sidecars/embed-server.py` | 共享基础设施 |
| 试验实例托管 | systemd `dsh-ops-trial.service` + `code/scripts/run-ops-trial.sh` | 运行形态模板 |

### 1.2 已验证的关键机制（后续领域直接继承）

- **增量 bundle 层**：disable 而非删除，对上游源码净改动 = 0，升级跟随手册 5 步（已演练，E4.3）。
- **header 别名兼容**：`X-Ops-Session-Id`/`X-Ops-Memory-Key` 兼容 `X-Hermes-Session-Id`/`X-Hermes-Session-Key`——**Hermes 调用方零代码切换**（SQL 转换 web-ui 直接受益，见 §6.4）。
- **记忆零迁移**：复用 MemoryCore Gateway（:8420）同一数据目录，Hermes 期记忆天然可回忆。
- **护栏分级**：blockable = critical + 错误码非空；规则源三源 join（图边 + 详情表 + 状态机）。
- **性能结论**：4 题基准 15.6-44.7s，对比 Hermes 基线加速 3.6-6.7x。

### 1.3 方法论缺口（"再做一个领域"时还缺什么）

1. 编排知识在 10 份文档和目录结构里，**没有声明式的单一口径**——第二个领域要靠"读懂历史 + 手工复制"。
2. 裁剪清单是平铺的 57 行，**没有按能力分层**——SQL 转换需要 file/script，无法从运维清单直接派生。
3. ops-api 名字和少量默认值带运维残留，**通用面与领域配置没有完全分离**。
4. 护栏规则源写死 BKN——SQL 转换域需要的是白名单式护栏，**规则源需可替换**。

---

## 2. 目标总览：从"项目"到"工厂"

```
                    ┌──────────── 共享基础设施（systemd 独立托管）────────────┐
                    │  MemoryCore Gateway :8420 · Qdrant :6333 · embed :8096 │
                    └──────────────────────────┬──────────────────────────────┘
        ┌──────────────────────────────────────┼──────────────────────────────┐
        │                                      │                              │
┌───────┴────────┐                    ┌────────┴───────┐             ┌────────┴───────┐
│ 领域实例 A(运维)│                    │ 领域实例 B(SQL) │             │ 领域实例 C(… ) │
│ DSH_HOME=.dsh-home                  │ DSH_HOME=.dsh-sql             │                │
│ GUI :3081 API :8643                 │ GUI :3082 API :8644           │                │
│ 能力包: remote-exec                 │ 能力包: file-ops + script     │                │
│ 领域插件: dsh-plugin(BKN)           │ 领域插件: 无(仅 preset+skill) │                │
└───────┬────────┘                    └────────┬───────┘             └────────────────┘
        │                                      │
   MaintenanceAgent(i2Agent/i2Console)    sql_transform web-ui
   · agent_api 指向 :8643                  · .env BASE_URL 指向 :8644
   · dsh_admin 代理 :3081/admin            · header 别名零改动
```

**结构原则**：
- **每领域一个实例**（D7），隔离彻底，端口/DSH_HOME/unit 登记造册（§3.5）。
- **共享基础设施不随任何领域实例生灭**（Gateway/Qdrant/embed 由 systemd 独立托管）。
- **领域差异全部收敛到一个声明式清单**（domain.yml，§3.1），实例由生成器产出（§5）。

---

## 3. 编排架构建议

### 3.1 领域清单 domain.yml：编排的声明式单一口径

每个领域一个清单文件，是该领域的**唯一权威描述**；实例骨架由生成器从清单产出，杜绝"复制目录后手工改漏"。

```yaml
# domains/sql-transform/domain.yml（示例）
domain: sql-transform
display_name: "SQL 异构转换 Agent"
capabilities: [file-ops, script]          # 能力包勾选（§3.2）；运维域 = [remote-exec]
preset:
  source: presets/sql-transform/          # persona + 热路径
  skills_dirs:                            # 挂进 skill-filesystem 的目录
    - /hdd/agent/stream-agent/sql_transform/skills/chains
    - /hdd/agent/stream-agent/sql_transform/skills/shared
    - /hdd/agent/stream-agent/sql_transform/skills/sources
plugins: []                               # 领域工具插件；运维域在此挂 dsh-plugin + ops-api 配置
api_server:
  port: 8644
  api_key_env: SQLTF_API_KEY
  turn_timeout_sec: 1800                  # 对照：运维 120；SQL 转换单请求 1800（含测试库执行迭代）
guard:
  rule_source: whitelist                  # 对照：运维 = bkn
  whitelist: [obclient, mysql]            # script 包命令白名单（§3.4）
memory:
  session_keys: ["sql-transform:convert:prod", "sql-transform:migrate:prod"]
ports: { gui: 3082, api: 8644 }
systemd_unit: dsh-sql-transform.service
```

清单同时是**注册表**：`domains/registry.yml` 汇总所有实例的端口/DSH_HOME/unit/状态，消灭"8642 归属之谜"这类问题。

### 3.2 能力包分层：裁剪清单从平铺到三层

把 ops-app 现有 57 项 disable 重新归层，形成可勾选的裁剪语义：

| 层 | 内容 | 运维域 | SQL 转换域 |
|----|------|--------|-----------|
| **核心层**（所有领域必裁） | subagent / workflow-ptc / goal / plan-mode / web 搜索族 / 桌面联动（open-in-app 等）/ trajectory / message-feedback | 裁 | 裁 |
| **能力包：remote-exec** | 不挂本机 bash/fs；执行面只走 MCP 远程通道（i2agent） | ✅ 选 | ❌ |
| **能力包：file-ops** | 保留 read/write/edit、file-upload、workspace-files；裁 terminal/bash | ❌ | ✅ 选（MEDIA 写文件、读输入文件、读映射表） |
| **能力包：script** | 保留 bash/terminal/run_code（配护栏白名单，§3.4） | ❌ | ✅ 选（obclient/mysql 测试库验证） |
| **领域层** | 领域工具插件、preset、skill 目录、领域 MCP | dsh-plugin + i2stream skill × 27 | 无插件 + 转换 skill × 16 |

落地方式：能力包各是一段独立的 patch 片段文件（`capability-packs/file-ops.yml` 等），ops-app 的 cordis.patch.yml 由生成器按 `capabilities` 勾选**拼接产出**，不再手工维护一张大表。运维域现有清单重排进层，行为不变（纯重构，dump-config diff 应为零）。

### 3.3 ops-api 通用化：把最后 10% 的领域残留挤出去

| 残留点 | 现状 | 改法 |
|--------|------|------|
| 插件名/日志前缀 | `ops-api` / `[ops-api]` | 改名 `dsh-domain-api`（或保留名但文档声明通用）；日志前缀随 config |
| `preset`/`modelId` 默认值 | `'i2stream-ops'` | 无默认，配置必填（fail-loud） |
| `/v1/capabilities` 静态位图 | tools/skills 数量硬编码 | 启动时从 preset 实际组合读取（tools 注册表 + skills 目录扫描），避免换领域后撒谎 |
| `model`→preset 路由 | 单一 preset | 保留扩展位：`model_presets: { "i2stream-ops": ..., }` map 配置。独立实例形态下非必需，但同环境跑两个轻量领域时省一个进程 |

其余（bridge 会话驱动、OpenAI/Responses 协议、多轮 resume、记忆 hook、熔断背压、supervisor、/admin、自建 listener）**已经领域无关，原样继承**。

### 3.4 护栏通用化：规则源可替换，框架不变

RiskGuard 的机制（pre-execute waterfall、severity/blockable、deny/warn 语义）是通用的；规则源因域而异：

```
guard 框架（通用）          规则源（按域注入）
├─ pre-execute 拦截链   ←   bkn      : 三源 join（运维域，现状）
├─ blockable 判定       ←   whitelist: 命令白名单 + 写目录白名单（SQL 转换域）
└─ deny/warn 输出       ←   yaml     : 静态规则文件（未来轻量领域）
```

SQL 转换域白名单语义（与运维域"拦高危"相反，是"只放行"）：
- script 类工具：仅放行 `obclient`、`mysql` 客户端命令行（正则锚定可执行文件名），其余一律 deny；
- write/edit 类工具：仅放行 `/tmp`、`/opt/data`（容器内 MEDIA 契约目录）下的路径；
- 无状态机、无错误码——规则源实现为一个 yaml + 匹配函数，复杂度远低于 BKN 源。

### 3.5 既有债务修正（随工厂化顺带还掉）

| 债务 | 现状 | 修法 |
|------|------|------|
| skill 启停靠目录重命名 | `<name>` ↔ `<name>.disabled`（实施期权宜） | 回到原设计：settings `disabledSkills` + 注册表出口过滤；多实例共享 skill 源目录时重命名方案会互相干扰，必须改 |
| 共享依赖生命周期 | MemoryCore 由现网进程 supervisor 托管 | 转 systemd 独立 unit（gap-exec P4 形态 A 已给出现成模板）；embed sidecar 同样处理 |
| 端口/实例无登记 | 靠文档和记忆 | `domains/registry.yml`（§3.1） |
| 8642 归属 | 疑似 Hermes 残留占用 | 转正/切换前人工确认后回收；新实例一律避开并在注册表留痕 |

---

## 4. MaintenanceAgent 管理面设计（D6：两侧都管）

> 定位澄清：**i2Console 是 MaintenanceAgent 产品线的既有前端（React 18 + TS + Vite + AntD），是运维域 agent 的对接对象，归产品仓所有**。涉及三个仓的分工：管理页面建在 **MaintenanceAgent 产品仓**（i2Console 页面 + i2Agent 代理/开关逻辑，产品侧工作项，本节给出其依赖的后端契约）；DSH 侧 /admin 管理面**已交付**；自建的编排工具 dshctl 与 i2Console 无关，仅在交互模式上借鉴它（见 [dshctl-design.md](file:///hdd/demo/public/dsh-info/doc/gernalarrange/dshctl-design.md) §3.1）。

原则：**i2Console 做统一入口（产品侧既有职责）；DSH /admin 做 DSH 侧的执行层；i2Agent 不重复实现 DSH 的管理逻辑（只代理，不双写）**。

### 4.1 管 DSH 侧资源：透传代理

```
运维人员 → i2Console "Agent 管理"页
        → i2Agent REST /api/agent-admin/*
        → 适配层（附加 Authorization: Bearer $OPS_ADMIN_KEY）
        → DSH :3081/admin/api/*（既有路由，零改动）
```

- **i2Agent 配置**：config.yaml 新增
  ```yaml
  dsh_admin:
    base_url: http://127.0.0.1:3081
    api_key: $OPS_ADMIN_KEY      # $ENV 语法，沿用现有约定
  ```
- **后端**：薄代理 handler 组（`/api/agent-admin/mcp`、`/skills`、`/state` 等），服务端注入 admin key——**key 不落前端、不进 i2Console localStorage**（比 DSH /admin 页面自己的 key 管理更安全）。
- **功能映射**：
  | i2Console 操作 | 落到 DSH |
  |---|---|
  | MCP 新增/编辑/启停/删除 | `/admin/api/mcp` CRUD（托管段原子写，热生效） |
  | skill 启停 | `/admin/api/skills/<name>/enable|disable` |
  | 工具清单 | `/admin/api/state` 的只读段（v1 只读；工具开关涉及 preset realm，等 DSH 侧 v2 支持后放行——**不在前端造假开关**） |
  | preset 查看 / 依赖健康 | `/admin/api/state` 同 |
- **并发一致性**：透传 DSH 侧的 If-Match revision 语义，409 时前端提示"配置已被他处修改，请刷新"。
- **纪律**：i2Agent **只代理不存储** DSH 侧状态，杜绝双写不一致。

### 4.2 管 i2Agent 自身 MCP 工具：自有功能，独立先行

i2Agent 的 18 个 MCP 工具（`internal/mcp`）目前全量暴露。加 per-tool 开关：

- **配置**：`mcp.disabled_tools: []`（默认空 = 全开，向后兼容）；
- **注册过滤**：`tools.go` 的 `toolCatalog` 注册时跳过禁用项，`tools/list` 对调用方直接不可见；
- **Console UI**：工具开关面板（`GET /api/mcp/tools` 列表 + `PUT /api/mcp/tools/{name}/enabled` 写配置，走现有原子写 + 热生效机制）；
- **语义区分**：`disabled`（对所有调用方隐藏）与既有 `read-only`（供 autodiag tool loop 的 ToolGateway 判定可执行性）是两个维度，UI 上分开呈现，不混淆。

此项与 DSH 无关，可立即独立实施（路线图第 1 步）。

### 4.3 配置整合：agent_api 与 dsh_admin 分离

i2Agent 现有 `hermes.base_url`（:8642）指向的是**对话面**。切换后建议：

```yaml
agent_api:            # 对话面（原 hermes 段改名，语义中立化）
  base_url: http://127.0.0.1:8643/v1
  api_key: $OPS_API_KEY
  model: i2stream-ops
dsh_admin:            # 管理面（新增，§4.1）
  base_url: http://127.0.0.1:3081
  api_key: $OPS_ADMIN_KEY
```

对话面与管理面分离配置——试验实例转正迁端口（8643→8642）时只改一处。

---

## 5. 领域工厂化：目录结构与生成器

> 生成器已升级为独立程序 **dshctl**（清单驱动 CLI：adopt/check/diff/apply/smoke/registry/upgrade-check），设计详见 [dshctl-design.md](file:///hdd/demo/public/dsh-info/doc/gernalarrange/dshctl-design.md)。本节目录结构不变，`new-domain-agent.sh` 由 `dshctl init/apply` 取代。

### 5.1 目标目录结构

```
dsh-info/
├── domains/                        # 领域清单（唯一长期维护物）
│   ├── registry.yml                #   实例登记：端口/DSH_HOME/unit/状态
│   ├── ops/domain.yml              #   运维（现有资产登记进来，清单反向归档）
│   └── sql-transform/domain.yml
├── code/
│   ├── dsh-domain-api/             # ops-api 通用化改名（§3.3）
│   ├── capability-packs/           # 能力包 patch 片段（§3.2）
│   │   ├── core-disable.yml        #   核心层
│   │   ├── remote-exec.yml
│   │   ├── file-ops.yml
│   │   └── script.yml
│   ├── guard-rule-sources/         # 护栏规则源（§3.4）
│   │   ├── bkn/  (现状，在 dsh-plugin 内)
│   │   └── whitelist/
│   ├── dsh-plugin/                 # 运维领域插件（现状不动）
│   └── scripts/
│       ├── new-domain-agent.sh     # 生成器（§5.2）
│       └── （既有 bench/api-smoke/run-ops-trial 泛化为模板）
└── deepseek-harness/               # 上游源码副本（所有实例共用同一份构建产物）
```

### 5.2 生成器行为（new-domain-agent.sh）

输入 `domains/<name>/domain.yml`，产出：

1. `$DSH_HOME` 骨架（settings.yaml 模板 + credentials 占位）；
2. `bundles/ops-app/cordis.patch.yml` = 核心层 + 勾选的能力包片段拼接；
3. `profiles/<name>/`（package.json manifest bundles 列表 + cordis.patch.yml：preset roots、领域插件 insert、domain-api insert 含 apiServer 段）；
4. systemd unit 文件模板（Restart=on-failure，参照 run-ops-trial.sh）；
5. registry.yml 登记一行（端口冲突校验在此把关）。

### 5.3 明确不抽象的东西

**不做"通用领域工具插件框架"**。运维的 BKN 工具与 SQL 转换的工具集差异巨大，共享的只有 dsh-domain-api、能力包片段、护栏框架和脚本——工具插件各自独立编写，参照 dsh-plugin 的 resolver/tools/self-test 三件套模式即可。两个相似实例就抽象框架，收益抵不上维护成本。

---

## 6. SQL 转换域落地专项

### 6.1 现状盘点（实地核查 /hdd/agent/stream-agent/sql_transform）

**调用契约**（web-ui/hermes/__init__.py）：
- OpenAI 兼容 `POST {BASE_URL}/chat/completions`，非流式，Bearer key；
- 单请求超时 **1800s**（大文件转换含测试库执行迭代）；
- 记忆分片 header `X-Hermes-Session-Key`，两个 key：`sql-transform:convert:prod`（转换）/ `sql-transform:migrate:prod`（迁移，engine.py:65）；
- 客户端并发闸门 `HERMES_CONCURRENCY=6`（信号量在 web-ui 侧）。

**Agent 实际职责**（SOUL.md + 提示词注入）：
1. 读输入：内联 SQL，或读"【输入文件】"路径（>128K 字符落盘模式，HERMES_INPUT_DIR）；
2. 转换：按链路加载 `chains/<src>-to-<dst>` skill 的差异要点表（Tier1/Tier2、direct-only/best-effort 模式语义在 skill 内）；
3. 验证：用 obclient/mysql client 连测试库执行，失败跳过（总则第 0 条：严禁网络排查），最多 2 轮修复迭代；
4. 输出：写文件返回 `MEDIA:/path`，web-ui 正则提取后读本机文件；
5. 参照 `.xlsx` 数据类型映射表（skills 根目录两份）。

**Skill 资产**：项目自有的只有三个子目录——`chains/`（11 条链路）、`shared/`（4 个：transform-format / obclient-oracle-connection / difftest-casegen / references）、`sources/`（1 个：sql-server-parser），共 **16 个 SKILL.md，frontmatter 规范**（name/description 齐备，DSH 可直接挂）。skills/ 根目录其余十几个目录（apple/creative/devops 等）是无关的公共 skill 库副本，configure 脚本也不拷它们。SOUL.md = 人设 + 总则 11 条；MEMORY.md = 实战积累的陷阱记忆（高质量热路径素材）。

### 6.2 与运维域对照

| 维度 | 运维域 | SQL 转换域 | 复用结论 |
|------|--------|-----------|---------|
| API 契约 | OpenAI 兼容 + Bearer | 完全相同 | domain-api 直接用 |
| 记忆 header | X-Ops-Memory-Key（别名 X-Hermes-Session-Key） | X-Hermes-Session-Key | **别名兼容已内建，web-ui 零改动** |
| 能力包 | remote-exec | **file-ops + script**（D8 已确认） | 分层机制首个差异化案例 |
| 领域工具插件 | dsh-plugin（BKN 12 工具） | **不需要** | 最小领域形态 = preset + skills + 通用面 |
| 单轮时长 | 秒级（120s 超时） | **1800s** | turnTimeoutSec 配置项已存在，改值即可 |
| 护栏 | BKN 三源规则（拦高危） | **白名单**（只放行 obclient/mysql + 限定写目录） | 规则源替换（§3.4） |
| 共享依赖 | Qdrant + embed + Gateway | 只需 Gateway（记忆）；检索栈可后补 | embed/Qdrant 不挂 |

### 6.3 本域特有的四个工作项

**W-T1 SOUL.md → preset persona 平移**
总则 11 条（连接失败不排查、2 轮修复迭代上限、MEDIA 输出格式、链路 skill 加载指令）全部是提示词层，与平台无关，直接进 `presets/sql-transform/agent.cordis.yml` 的 persona。MEMORY.md 的陷阱条目按 gen-hotpath-prompt.ts 的思路转成热路径段落（或保持走 MemoryCore 记忆，两个既有 session key 不用换）。

**W-T2 xlsx 映射表读取（隐藏风险点）**
提示词让 Agent "自行读取" .xlsx 映射表，但 xlsx 是二进制——DSH 的 file 工具读出来是乱码（Hermes 侧多半靠 python 环境解析）。
**建议：预转换为 Markdown 表**随 skill 发放（一次性脚本：xlsx → skills/shared/references/*.md），确定性最高、零运行时依赖；同时在 persona 中把映射表路径改为 .md。

**W-T3 MEDIA 共享文件系统（部署约束）**
web-ui 提取 `MEDIA:/path` 后读本机文件（远程部署走 paramiko SSH 兜底）。DSH 实例必须与 web-ui 同机/同容器/共享卷，否则 MEDIA 链路断。容器化时新镜像（替代 `nousresearch/hermes-agent` 基底）需装：obclient、mysql client、Node/DSH 运行时；entrypoint 双进程（web-ui + DSH 实例）。

**W-T4 白名单护栏（§3.4 的首个用户）**
- script：命令行正则白名单 `^(obclient|mysql)\b`，其余 deny；
- write/edit：路径前缀白名单 `/tmp/`、`/opt/data/`；
- 源库侧"只验证禁修改"靠 persona 总则约束 + 数据库账号权限（web-ui 注入的连接信息本就是只读语境），不靠工具层。

### 6.4 迁移路径：零代码切换 + 一键回滚

web-ui 侧改动收敛为 `.env` 三个值：

```diff
- BASE_URL=http://127.0.0.1:58644/v1        # Hermes 实例
+ BASE_URL=http://127.0.0.1:8644/v1         # DSH sql-transform 实例
  API_KEY=<新实例 key>
  SESSION_KEY=sql-transform:convert:prod     # 不变（记忆零迁移）
```

Python 代码零改动（OpenAI 兼容 + header 别名兼容 + 非流式 + 1800s 超时均可配）。回滚 = 改回 .env。
（可选后续：web-ui 的 `MEDIA:` 提取、`build_hermes_input` 等函数名含 hermes 字样，纯命名，不急着动。）

### 6.5 并行验证方案（不动 web-ui 的先决验证）

在切换任何流量之前，先证明 DSH 实例"转得一样好且更快"：

1. 搭实例：生成器产出 sql-transform 实例（能力包 file-ops+script、白名单护栏、turnTimeout=1800、挂 16 个 skill、persona 平移）；
2. 取 3-5 道真实转换题（覆盖 mssql→ob-oracle / mssql→ob-mysql 各一、含存储过程/触发器、含一个大文件走【输入文件】模式）；
3. 同一输入分别打 Hermes（现状）与 DSH 实例，对比：转换结果语义等价性（人工 + difftest-casegen 用例过一遍）、MEDIA 契约完整性、verify 标注真实性、墙钟耗时；
4. 达标线：结果质量不低于 Hermes，耗时显著低于 1800s 超时风险区（预期热路径转换 <60s）；
5. 达标后才进入 .env 切换与容器化（W-T3）。

---

## 7. 落地路线图

| 步 | 内容 | 依赖 | 性质 |
|----|------|------|------|
| 1 | i2Agent：`agent_api` 配置段改名 + `mcp.disabled_tools` + Console 工具开关面板（§4.2、§4.3） | 无 | ⚠️ 规格齐备；技术核查可行（Go 在位/toolCatalog 插入点明确）——**转产品仓排期**（2026-09-16 评估，见 dshctl-exec-plan 批5） |
| 2 | ops-api 通用化（capabilities 动态位图、残留配置化、改名）（§3.3） | 无 | ✅ 已完成（改名余项延后记录在案，2026-09-16） |
| 3 | i2Console → DSH /admin 透传代理 + 管理页（§4.1） | 2 | D6 落地；⚠️ 产品仓前端，转产品侧排期（同上） |
| 4 | skill 启停迁回 settings 过滤（§3.5） + Gateway/embed 转 systemd 独立托管（§3.5） | 与 3 并行 | ✅ **systemd 托管已完成（2026-09-16）**：memorycore-gateway/embed-server 双 unit active + recall 零迁移；**skill settings 过滤→债务转挂上游**（skill-filesystem 无该机制，文件级方案在单源下语义正确） |
| 5a | dshctl v0.1：adopt + check + registry（**只读，零风险**）；首次 adopt 运维实例时反向产出能力包片段初稿（人工审层后定稿）——详见 [dshctl-design.md](file:///hdd/demo/public/dsh-info/doc/gernalarrange/dshctl-design.md) | 无，可与 1-4 并行 | ✅ **已完成（2026-09-16，工厂化关键步·上）** |
| 5b | dshctl v0.2：diff/apply/smoke + 能力包分层定稿（dump-config diff 应为零） | 观察期通过 + 5a | ✅ **已完成（2026-09-16，工厂化关键步·下；另 v0.3 upgrade-check / v0.4 GUI / v1.0 仓+CI 亦同日交付）** |
| 6 | SQL 转换域并行验证（§6.5） | 5b（或手工先行） | 第二个领域的试金石 |
| 7 | SQL 转换切换（.env）+ 容器化（W-T3） | 6 达标 | 投产 |
| 8 | 运维域转正决策（观察期结论 + 8642 归属） | 独立 | 既有流程 |

---

## 8. 风险登记

| # | 风险 | 缓解 |
|---|------|------|
| R-A | SQL 转换质量回归（DSH agent loop 行为与 Hermes 细节差异，如 skill 加载时机、长文件处理） | §6.5 并行验证达标线卡住切换；difftest 用例做语义裁判；不达标不切换 |
| R-B | MEDIA 文件契约在多进程/容器内的路径可见性 | W-T3 同机/共享卷部署约束写进 domain.yml 校验项；验证题含大文件模式 |
| R-C | 能力包分层重构引入裁剪差异 | dump-config diff 归零为 DoD；bench-4q 回归 |
| R-D | 白名单护栏过严误拦 obclient 合法用法 | 先 warn-only 观察一周（gray 模式），再切 deny |
| R-E | 多实例资源占用叠加（每实例一个 DSH 进程） | 独立实例是 D7 已拍板的取舍；registry 登记端口/内存基线；轻量领域后续可用 §3.3 的 model→preset 路由合并 |
| R-F | i2Agent 代理层把 DSH admin key 泄露面扩大 | key 只存 i2Agent 服务端配置（$ENV），不下发前端；代理层挂 i2Console 既有会话鉴权之后 |

---

## 9. 明确不做（本期）

- 不抽象"通用领域工具插件框架"（§5.3）；
- 不做工具级开关的 DSH 侧实现（等 preset realm 原生支持，前端不造假开关）；
- 不做多实例统一的 GUI 聚合面（每实例自己的 /admin 已够，i2Console 代理是统一入口）；
- 不动 web-ui 内部命名与结构（hermes 字样等纯命名问题）；
- 不做 SQL 转换域的 Qdrant 检索栈（转换质量不依赖它；如未来要"相似历史转换召回"，再走 embed sidecar 复用路径）。

---

## 10. 回填记录

- 2026-09-16 方案形成：D6-D8 用户拍板；SQL 转换项目实地盘点（契约/skills/MEDIA/xlsx/部署形态）；方法论缺口四点（§1.3）与对应设计（§3）。
