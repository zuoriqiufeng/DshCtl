# dshctl 使用手册（安装 / 运行 / 命令 / 运维）

> 版本：v1.0（2026-09-16）· 适用：`code/dshctl/`（git 仓，独立成仓）
> 设计依据：`doc/gernalarrange/dshctl-design.md`；实施与验收：`doc/dshctl-exec-plan.md`
> 一句话定位：**DSH 领域实例的编排 CLI**——清单驱动、幂等生成、对账校验；只管交付期（实例怎么被正确地造出来并保持正确），不碰运行期热管理（那是 DSH `/admin` 的职责）。

---

## 目录

1. [前置条件](#1-前置条件)
2. [安装与构建](#2-安装与构建)
3. [运行机制（两层运行时）](#3-运行机制两层运行时)
4. [命令手册](#4-命令手册)
5. [校验规则 R1-R10 详解](#5-校验规则-r1-r10-详解)
6. [数据文件与格式](#6-数据文件与格式)
7. [GUI 使用手册](#7-gui-使用手册)
8. [CI 与自动化](#8-ci-与自动化)
9. [典型工作流](#9-典型工作流)
10. [故障排查](#10-故障排查)
11. [维护约定与红线](#11-维护约定与红线)

---

## 1. 前置条件

| 条件 | 要求 | 检查方式 |
|---|---|---|
| Node.js | ≥ 20（实测 24.18） | `node -v` |
| pnpm | ≥ 10（实测 11.7） | `pnpm -v` |
| dshctl 源码 | `/hdd/demo/public/dsh-info/code/dshctl/` | `ls` |
| **被编排的 harness** | 已 `pnpm install` + `pnpm build` + `pnpm build:web` 的 DSH 源码树（`dsh_source`，即 `deepseek-harness/`）——check 的上游对账与 smoke 起临时实例都要用它 | `ls deepseek-harness/node_modules/.bin/dsh` |
| 目标实例 | 一个 DSH_HOME（如 `.dsh-home`），其上有 profiles/bundles/presets 等编排产物 | — |

> dshctl **自身**运行不依赖 harness（自带 tsx，见 §3）；但"编排动作"（对账上游 roster、冒烟起实例）需要一个可用的 `dsh_source`。

## 2. 安装与构建

### 2.1 依赖安装（一次性）

```sh
cd /hdd/demo/public/dsh-info/code/dshctl
pnpm install --store-dir /hdd/demo/public/dsh-info/.pnpm-store
```

装两样东西：
- `yaml`（运行时依赖，解析 domain.yml / 片段 / dump-config 输出）；
- `tsx@4.22.4`（开发依赖，**与 harness 钉同版本**——避免两侧 TS 编译行为差异）。

### 2.2 PATH 软链（让 `dshctl` 全局可用）

```sh
ln -sf /hdd/demo/public/dsh-info/code/dshctl/bin/dshctl        /usr/local/bin/dshctl
ln -sf /hdd/demo/public/dsh-info/code/dshctl/bin/dshctl-selftest /usr/local/bin/dshctl-selftest
ln -sf /hdd/demo/public/dsh-info/code/dshctl/bin/dshctl-gui    /usr/local/bin/dshctl-gui
```

装完任意目录 `dshctl --help` 即可用。

### 2.3 GUI 前端构建（可选，用 GUI 才需要）

```sh
cd /hdd/demo/public/dsh-info/code/dshctl/gui
pnpm install --store-dir /hdd/demo/public/dsh-info/.pnpm-store
pnpm build          # 产物落 gui/dist/（server 静态托管）
```

### 2.4 验证安装

```sh
dshctl-selftest           # 期望输出 ALL PASSED ✅（150 断言，约 10-20 秒）
dshctl registry           # 期望打印已登记实例一览
```

### 2.5 卸载/重置

```sh
rm /usr/local/bin/dshctl{,-selftest,-g gui}      # 去 PATH
rm -rf code/dshctl/node_modules code/dshctl/gui/node_modules gui/dist
rm -rf domains/ registry 与 capability-packs 按需删（生成物可再生：重跑 adopt/apply 即可）
```

## 3. 运行机制（两层运行时）

**核心设计：编排者与被编排者的执行环境彻底分离。**

```
你敲 dshctl
  → /usr/local/bin/dshctl（PATH 软链）
  → code/dshctl/bin/dshctl（bash wrapper，readlink -f 解析软链）
  → node --import "file://<dshctl>/node_modules/tsx/dist/esm/index.mjs" dshctl.ts
       ▲ 用 file:// 绝对路径加载 tsx —— 与 cwd 无关，不碰 harness 的 node_modules
```

| 层 | tsx 来源 | 跑什么 |
|---|---|---|
| **dshctl 自身** | 自带 tsx@4.22.4（devDependency） | CLI、self-test、GUI server |
| **被编排的 DSH 域实例** | harness（`dsh_source`）那份 | check 的 `dump-config`、smoke 的 `pnpm dsh` spawn |

wrapper 原理（`bin/dshctl` 全文）：

```sh
SELF="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
exec node --import "file://$SELF/node_modules/tsx/dist/esm/index.mjs" "$SELF/dshctl.ts" "$@"
```

- `readlink -f`：解析 PATH 软链，保证从任何调用路径都定位到真实目录；
- `file://` 绝对加载：绕开 Node"从 cwd 向上找 node_modules"的解析规则（tsx 内部唯一的裸依赖 `esbuild` 按 tsx 自身位置解析，pnpm 布局已就位）。

**退出码约定**（所有命令通用）：`0`=通过/成功，`1`=校验失败（或 diff 非空），`2`=执行错误（文件缺失、参数错、roster 不可用等）。

**输出**：人类可读表格为主；`--json` 输出机器可读结构（供脚本/CI 消费）。

## 4. 命令手册

### 4.1 `dshctl adopt` — 反向归档现存实例

**用途**：把一个"手工演化出来的 DSH 实例"逆向生成声明式清单，是工厂化的入口。

```sh
dshctl adopt --instance <name> [--home <DSH_HOME>] [--unit <systemd-unit>] [--json]
# 例（运维试验实例）：
dshctl adopt --instance ops --unit dsh-ops-trial.service
```

| 参数 | 说明 |
|---|---|
| `--instance <name>` | 实例名 = profile 目录名（`$DSH_HOME/profiles/<name>`），也作为 domain id |
| `--home` | DSH_HOME 路径，缺省 `dsh-info/.dsh-home` |
| `--unit` | 托管该实例的 systemd unit 名（写入 registry） |

**行为**：读 profile patch / ops-app disable 层 / preset → 产出：
1. `domains/<name>/domain.yml`（含回填的 `api_server.plugin_path/plugin_id`、从 `!!js process.env.X` 提取的 env 名——字面值密钥一律忽略并 R8 告警，**绝不落盘**）；
2. registry 登记一行；
3. **首次运行**（`code/capability-packs/` 无片段时）：按归属启发式产 DRAFT 片段初稿——头部标 `# 状态：DRAFT...`，**人工审层后删除该行即定稿**；匹配不上的 id 进 `unclassified`（不猜，交人工）。

**幂等**：可重复跑；已有片段时不再产 DRAFT，只重写 domain.yml 与 registry。

**典型输出**：
```
adopt ops: domains/ops/domain.yml + registry 已登记；DRAFT 片段 4 个
  core: 41 ids
  unclassified: 3 ids
  ⚠ unclassified: ... （不猜，交人工归层）
下一步：人工审层 capability-packs/*.yml（删除 DRAFT 行定稿）→ dshctl diff ops
```

---

### 4.2 `dshctl check` — 对账器（R1-R10）

**用途**：对一个领域执行全部适用校验（详见 §5），是日常巡检与 CI 的主体。

```sh
dshctl check <domain> [--refresh] [--ci] [--json]
dshctl check ops --ci
```

| 参数 | 说明 |
|---|---|
| `--refresh` | 强刷上游 roster 缓存（重新执行 dump-config）；不带则优先读 `domains/.cache/dump-config-<版本>.json` |
| `--ci` | 任一 error → 退出码 1（流水线/周检用） |

**数据源**：上游 roster 来自 `DSH_HOME=<home> pnpm dsh --profile <domain> --dump-config`（在 `dsh_source` 执行，输出为带层注释的 YAML，解析其中全部 `id`）；按 harness `package.json` 版本号缓存，**上游换版本缓存自动失效**。dump-config 失败 → 退化为清单内部校验并显式标注（`[degraded]`，不静默）。

**成功标志**：`0 error(s), 0 warn(s) → PASS` + 退出码 0。

---

### 4.3 `dshctl diff` — 只读对账（空 = 程序正确理解现状）

```sh
dshctl diff <domain>        # 退出码 0=空，1=非空
```

四组生成面对账（**子集语义**：只比 apply 管理面，现状多余的行如 MCP 托管段记为 note 不算差异）：
1. 能力包拼接 vs 现状 `bundles/ops-app/cordis.patch.yml`（规范化集合：忽略注释/顺序）；
2. profile `package.json` 的 bundles 三层列表；
3. profile patch 中 apply 面 id 的存在性（plugins + domain-api + agent-presets）；
4. presets 目录文件清单（`preset.source` 已在 DSH_HOME 内时自源自比）。

---

### 4.4 `dshctl apply` — 生成/落盘实例骨架（新领域的 init）

```sh
dshctl apply <domain> --dry-run          # 只出 diff，零写盘（退出 0=与现状一致）
dshctl apply <domain> --yes              # 确认写盘
dshctl apply <domain> --yes --unit-out /tmp/dsh-xxx.service   # 附带落 systemd unit 模板
```

**安全门**：先跑 check，**有 error 拒绝执行**（exit 1）；所有写路径强制在 DSH_HOME 之内（越界拒绝，防写上游仓）；全部原子写（tmp+rename）。

**落盘五件**：
| # | 生成物 | 内容 |
|---|---|---|
| ① | `bundles/ops-app/{package.json,cordis.patch.yml}` | core 隐含 + 勾选能力包拼接（每项注释标来源包） |
| ② | `profiles/<domain>/{package.json,cordis.yml,cordis.patch.yml}` | bundles 三层 manifest + preset roots 覆写 + plugins insert + domain-api insert（完整 config）+ 空 OPS-ADMIN MANAGED 标记区 |
| ③ | `presets/<domain>/` | 从 `preset.source` 递归拷贝（source 已在 DSH_HOME 内则跳过自拷） |
| ④ | registry | upsert + `applied_at` |
| ⑤ | systemd unit | 模板输出（stdout 或 `--unit-out`）——**安装由人执行，程序不碰 systemctl** |

**显式不生成**：`settings.yaml` / `.credentials.yaml`（模型凭据属环境资产）——已存在跳过，缺失 warn 提示人工拷贝。

---

### 4.5 `dshctl smoke` — 临时实例冒烟（不动现网）

```sh
dshctl smoke <domain>            # 健康 + api-smoke 五连测 + 领域自检
dshctl smoke <domain> --bench    # 追加 bench-4q 四题基准（真实 LLM 调用，分钟级）
dshctl smoke <domain> --no-self-test
```

**流程**：api+100 起顺延探测空闲端口（上限 +110）→ 生成 overlay patch（**整段替换 domain-api config 仅改 port**——上游 config 是整体替换语义，只传 port 会清掉其余配置）→ `--patch` 挂临时实例（detached 进程组，`$DSH_HOME/ops.env` 合入 env）→ 轮询 `/health` ≤30s → `api-smoke.sh` 五连测（health/models/非流式/流式/鉴权）→ 领域自检（约定跑 `plugins[].path 同目录/self-test.ts`）→ 可选 bench → **finally 兜底清理**（进程组 SIGTERM → 5s → SIGKILL，Ctrl-C/异常同样覆盖，不留孤儿）。

**隔离性**：同 DSH_HOME 与现网实例并发安全（无 home 级单例锁）；端口错开，绝不碰运行中实例。

---

### 4.6 `dshctl upgrade-check` — 升级跟随对账（手册第 2 步自动化）

```sh
dshctl upgrade-check [--refresh] [--json]
```

对 **registry 中全部已登记领域**，用同一份上游 roster 跑 R2/R3 子集，输出每领域"需要动的清单"：

| verdict | 退出码 | 含义 |
|---|---|---|
| `pass` | 0 | 可进入升级手册第 3 步（替换产物/重启实例） |
| `blocked` | 1 | 有领域存在消失 id，先跟进清单（改名/删除 ops-app 条目） |
| `degraded` | 2 | roster 不可用（上游未构建/超时）——**不允许假通过** |

**基线机制**：与上一版 roster 对比找"新增行"（warn，人工评估裁剪）；历史基线即 `domains/.cache/` 里其它版本号的缓存文件，自动管理。

---

### 4.7 `dshctl registry` — 实例登记表

```sh
dshctl registry [--json]
```

一览所有实例的 domain / DSH_HOME / 端口（headless 显示 `gui=headless`）/ systemd unit / status / 最近 check 结果；附 `unregistered_ports`（已知占用但未登记的端口，如转正前的 8642）。

---

### 4.8 `dshctl plugin` — 插件库

**用途**：编排时的插件目录——登记引用为主（path 指向源码真相，不拷贝）；zip/git 导入件才落 `plugin-registry/sources/<id>/`。

```sh
dshctl plugin list [--json]                 # 目录一览（含 core 必须件计数）
dshctl plugin show <id>                     # 单条详情（--json 同文）
dshctl plugin add --id <id> --path <入口.ts> [--name --desc]   # 路径收编（local，trusted=true）
dshctl plugin remove <id>                   # 只删登记，不动源码
dshctl plugin trust <id> [--off]            # 人工信任流转（git/zip 导入件默认 untrusted）
dshctl plugin publish <domain>              # 编排产出入库：domain.yml 的 plugins + api_server 插件逐条登记（已存在跳过）
dshctl plugin import <zip> --id <id> [--name --desc --entry index.ts]
                                            # zip 导入 → sources/<id>/（zip-slip 过滤；50MB/2000 条上限；untrusted）
dshctl plugin import-git <url> --id <id> [--ref <分支/tag> --entry index.ts]
                                            # git clone --depth 1 → sources/<id>/（untrusted）
```

**信任模型**：`local` 收编默认 `trusted: true`；`sources`/`git` 导入默认 `trusted: false`——被领域引用时 check **R12 出 warn**，人工 `plugin trust <id>` 后消。**网络前提**：本环境实测 github.com HTTPS 不可达（挂起），`import-git` 会失败并给出提示；需代理/中转，或改走 zip 通道。

**数据**：`plugin-registry/registry.yml`（目录，schema:1）+ `plugin-registry/core.yml`（核心功能清单 + slots 功能槽）+ `plugin-registry/sources/`（仅导入件落盘）。

---

### 4.9 `dshctl replace` — 替换通道（全链）

**用途**：核心功能替换的一键全链——预检（零写入）→ 声明槽成员（core.yml 保注释）→ 插入新件（domain.yml `plugins[]`，R11 存在证据）→ 旧件进能力包 `disable` → `check` 验证（相对基线无新增 error，old∈core 时 R11 须记「槽豁免」）；**验证不过自动回滚本次全部写入**（3~4 文件字节还原）。

```sh
dshctl replace <old> --with <new> [--domain <域>] [--pack core] [--keep-old] [--path <入口.ts|@scope/pkg>] [--smoke] [--yes]
```

| 参数 | 语义 |
|---|---|
| `<old> --with <new>` | 必填；old==new 预检拒绝 |
| `--domain` | 缺省 `ops`；domain.yml 不存在 → 预检 error |
| `--pack` | 能力包缺省 `core`（隐含必选）；不在该域 capabilities 且非 core → 预检 warn |
| `--keep-old` | 保留旧件（M1 共存）——跳过槽声明与禁用，只插入新件 |
| `--path` | 新件未入库且不在 roster 时必填；文件入口绝对路径或包名（`@scope/pkg`/裸名豁免 existsSync，自动 `plugin add` 时 source=local/trusted） |
| `--smoke` | check 通过后追加临时实例冒烟（**失败不回滚**——运行时问题人工决策） |
| `--yes` | **无 = 预演**（打印计划零写入）；有 = 执行 |

**输出**：预检错误/警告 → 执行步骤清单 → R11 结果 → 等价命令（`equivalentCommand`）→ 回退指引（反向编辑三处 + `apply`/`check`；v1 无 `--undo`）。check 不过时附「本次写入已自动回滚」。

**幂等**：old 已禁 → 跳过禁用；槽成员已声明 → 跳过声明；new 已在 `plugins[]`/roster → 跳过插入。重复执行安全。

**GUI 同源**：插件库 → 核心功能页签 → **左清单点选组件**（搜索定位 + sticky 分组 + 点行选中，无行内按钮；青点 = 已开槽）→ **右侧面板**（desc 全文 / 槽态 Tag / 豁免语义 / 槽成员 chips）→ 唯一入口「**替换…**」→ 600 宽三阶段 Drawer（头部/旧→新对比卡 → 表单 → 预演[StatusRow verdict + 步骤时间线 + **行级 diff** + 等价命令] → 执行结果[verdict + R11 槽豁免徽标 + 回退指引折叠] + 常驻操作条；表单变更 500ms 防抖自动 `dry_run`，手动「预演」按钮保留作显式刷新）→ `POST /api/replace`，与 CLI 同一引擎。CLI 输出仍只打步骤清单 + 等价命令（**行级 diff 是 GUI 预演专属**，CLI 契约不变）。

---

### 4.10 自测与 GUI

```sh
dshctl-selftest                    # [1]-[18] 段，fixture 驱动不依赖 live
dshctl-gui [--port 8780] [--host 127.0.0.1]   # 起 GUI（见 §7）
```

## 5. 校验规则 R1-R12 详解

| # | 级别 | 检查什么 | 失败了怎么办 |
|---|---|---|---|
| **R1** | error / warn | domain 名全局唯一；gui/api 端口不与 registry 其它实例冲突；被占用端口与本实例 unit 状态自证（unit active=本实例自身，pass） | 冲突→改 domain.yml 端口；unit 未运行却占用→确认归属或登记 `unregistered_ports` |
| **R2** | error | 清单中每个 disable/override id 在上游 roster 中仍存在（消失 = 上游改名/删除 → 你的 disable 静默失效） | 跟进：ops-app 片段里删除或改名为新 id |
| **R3** | warn | 上一版 roster 有、新版没有的行之外——**新版新增且未被能力包覆盖的行**（需人工评估：该裁剪还是保留） | 评审后把该裁的 id 归入对应能力包片段 |
| **R4** | error | `capabilities` 含 `script` 时 `guard.whitelist.commands` 必填非空（裸 bash 无护栏禁止） | 补命令白名单；或去掉 script 勾选 |
| **R5** | error | `contracts.media_dirs` 每一项 ⊆ `guard.whitelist.write_paths`（契约目录必须被护栏放行，否则 Agent 写得出、契约读不到） | 把契约目录加进 write_paths |
| **R6** | error | `preset.skills_dirs` 每项存在且含 ≥1 个带合法 frontmatter（`name`+`description`）的 SKILL.md | 修目录路径或补 frontmatter |
| **R7** | error | `turn_timeout_sec ≥ max_task_duration_sec`（防"实际任务 1800s 但超时 120s"这类配置倒挂） | 调大 turn_timeout 或调小 max_task_duration |
| **R8** | error | `api_key_env` 只含环境变量名（`^\$?[A-Z_]+$`），禁止字面值密钥 | 改为 env 变量名；值放 EnvironmentFile/ops.env |
| **R9** | warn | `shared_deps` 各 url 可达（任何 HTTP 响应=可达，网络错/超时=不可达；1.5s 超时） | 冷启动前正常；持续 warn 则查依赖服务 |
| **R10** | warn | 归层缺口：现状 ops-app patch 里有、能力包渲染里无的 id（交人工归层） | 把缺口 id 归入正确能力包片段 |
| **R11** | error | 能力包 disable 命中核心功能清单（`plugin-registry/core.yml`，61 项——核心功能不可缺；清单缺失时降级 warn）。双判据：无槽 id 命中即 error；带 slot 的功能槽载体被禁时，同槽有活跃成员（roster ∪ 本域插件有存在证据）→ pass 并记「槽豁免」，槽被裁空 → error | 从能力包移除该 id，或在 core.yml `slots` 声明同槽成员（自研扩展插件入库后追加 members）；确需调整清单先改 core.yml 并记录理由 |
| **R12** | error / warn | 领域 `plugins[]`+`api_server` 插件与插件库对齐：未入库/path 漂移 → error；库中 `trusted: false`（git/zip 导入件）→ warn | `dshctl plugin add/publish` 入库；漂移则统一 path；导入件人工 `plugin trust` |

## 6. 数据文件与格式

```
dsh-info/
├── domains/
│   ├── ops/domain.yml            # 领域清单（唯一长期维护物之一）
│   ├── registry.yml              # 实例登记表（apply/adopt 自动维护，接受手工编辑）
│   └── .cache/
│       ├── dump-config-<版本>.json    # 上游 roster 缓存（版本号命名，升级自动失效）
│       └── smoke-overlay-<domain>.yml # smoke 临时 overlay（可删）
├── plugin-registry/             # 插件库（唯一长期维护物之一）
│   ├── registry.yml              # 插件目录（登记引用为主；schema:1）
│   ├── core.yml                  # DSH 核心功能清单（R11 红线，61 项，slots 功能槽可替换）
│   └── sources/                  # 仅 zip/git 导入件落这里（untrusted）
└── code/
    ├── dshctl/                   # 本工具（git 仓）
    └── capability-packs/         # 能力包片段（唯一长期维护物之一）
        ├── core.yml              # 核心层（所有领域必裁，mergePacks 恒隐含参与）
        ├── file-ops.yml          # 能力包：文件读写（keep_tools 语义）
        ├── script.yml            # 能力包：本机脚本执行（配 R4 白名单）
        └── remote-exec.yml       # 能力包：执行面只走 MCP 远程通道
```

### 6.1 domain.yml（schema:1）关键字段

```yaml
schema: 1
domain: ops                        # ^[a-z][a-z0-9-]*$，全局唯一（registry 查重）
dsh_home: /path/to/.dsh-home
dsh_source: /path/to/deepseek-harness   # 被编排的 harness 源码树
capabilities: [remote-exec]        # 能力包勾选；core 恒隐含必裁，无需声明
contracts:                         # 可选；声明后参与 R5 对账
  media_dirs: [/tmp, /opt/data]
guard:
  rule_source: bkn                 # bkn | whitelist | none
  whitelist:                       # rule_source=whitelist 时（SQL 域形態）
    commands: [obclient, mysql]    # 字面前缀或 re:正则
    write_paths: [/tmp, /opt/data]
preset:
  source: /path/to/presets/<名>    # persona/热路径源目录（在 DSH_HOME 内则自源自比）
  skills_dirs: [/path/to/skills]   # 必须存在且含合法 SKILL.md（R6）
plugins:                           # 领域工具插件；domain-api 不在此列（由 api_server 自动注入）
  - { id: bkn-plugin, path: /abs/path/index.ts }
api_server:
  port: 8643
  api_key_env: OPS_API_KEY         # 只记 env 名（R8）；值在实例的 ops.env/EnvironmentFile
  turn_timeout_sec: 120
  max_task_duration_sec: 120       # R7 对账
  plugin_path: /abs/path/ops-api/index.ts   # domain-api 插件源码（adopt 回填；apply 必需）
  plugin_id: ops-api               # profile patch 中的 insert id（adopt 回填）
memory: { gateway_url: 'http://127.0.0.1:8420', session_keys: [] }
ports: { api: 8643, gui: null }    # gui: null = headless
systemd_unit: dsh-ops-trial.service
shared_deps: [ { name: memory-gateway, url: 'http://127.0.0.1:8420' } ]   # R9 探活
```

### 6.2 能力包片段（capability-packs/*.yml）

```yaml
pack: core
description: "subagent/workflow/goal/plan/web/桌面联动等编码 agent 能力"
disable:
  tools: [ui-goal, subagent, ...]          # 纯 disable 项
  overrides:                                # 非纯 disable 的覆写条目（原样保留）
    - { id: connection, inject: [], config: { trustedHosts: [] } }
---
pack: file-ops
disable:
  keep_tools: [read, write, edit, file-upload, workspace-files]   # 从核心层"放回"
  disable: { tools: [terminal] }            # 本包额外裁的
```

**拼接语义**（mergePacks）：core 恒隐含 → 勾选包按序加入 disable/override（**同 id 出现在多片段 = error**，归属必须唯一）→ 最后用各包 `keep_tools` 从结果中"放回"（未勾选的包 keep 不生效）。

### 6.3 registry.yml

```yaml
instances:
  - domain: ops
    dsh_home: /path/.dsh-home
    ports: { api: 8643, gui: null }
    systemd_unit: dsh-ops-trial.service
    status: trial                # trial | prod | retired
    last_check: { at: 2026-09-16, result: pass, errors: 0, warns: 0 }
    applied_at: 2026-09-16
shared_deps: [ ... ]             # R9 探活对象
unregistered_ports: [8642]       # 已知占用但未登记（附归属取证注释）
```

## 7. GUI 使用手册

**启动**：`dshctl-gui [--port 8780] [--host <addr>]`（终端保持运行）→ 浏览器开 `http://127.0.0.1:8780`。

**界面形态（2026-09-16 产品化）**：侧栏控制台——左侧深色导航（概览 / 实例登记 / 领域管理 / 升级对账 / **新建领域**）+ 顶部工具条（领域相关页显示当前领域徽标）+ 页脚。领域管理页 = 领域选择条（卡片式：域名 + 最近 check 状态圆点 + 选中描边）+ 右侧 check / diff / 清单编辑 三页签（保存带 dirty 判定：无修改禁用）。**新建领域为独立整页**（① 名称 + ② 清单表单 + 底部 sticky 操作条），创建成功自动跳领域管理并选中新域。

**LAN 访问**（默认只绑 127.0.0.1，需显式放开）：
```sh
dshctl-gui --host 0.0.0.0            # 或 --host 192.168.34.66 绑定指定地址
# 局域网内浏览器访问 http://<本机LAN-IP>:8780
```
> ⚠ **安全提示**：GUI 无鉴权且具备清单**写能力**（domain.yml 编辑/保存）。`0.0.0.0` 绑定仅限可信内网或临时演示；长期开放请前置反代+鉴权，或用防火墙限制来源 IP。启动日志在非回环绑定时会打印同样的警告。
**边界**：只绑 127.0.0.1（本机）；是 CLI 的薄壳——后端 `gui/server.ts` 直接 import 核心函数，**不另建业务逻辑**；每个 API 响应带 `equivalentCommand`，页面上展示对应 CLI 命令（**GUI 每一步操作都可复现为等价 CLI**）。

| 菜单 | 能做什么 | 等价 CLI |
|---|---|---|
| **概览 Dashboard** | 统计卡（实例/领域/能力包/依赖健康圆点）+ 各领域最近 check 表 + 快捷操作（不触发重对账） | `dshctl registry --json` |
| 实例登记 | registry 表 + 未登记端口提示 | `dshctl registry` |
| 领域管理 · check | 逐规则 pass/warn/error 表 + 运行按钮（loading 态） | `dshctl check <domain>` |
| 领域管理 · diff | 差异清单/一致提示 + notes | `dshctl diff <domain>` |
| 领域管理 · 清单编辑 | **表单化模块编辑**（基本信息/能力包/护栏/契约/preset/plugins/api_server/memory/端口与托管/shared_deps 分区卡片），保存即 schema 校验 + 原子写（失败拒绝、空段自动省略）；原始 YAML 只读折叠可查 | 编辑文件 + `dshctl check` |
| 新建领域（领域选择条按钮） | 同款表单 + domain 名正则校验；创建只写 domain.yml，成功自动切到新域并提示 `check → apply --dry-run → --yes` | `dshctl apply <name> --dry-run` |
| 升级对账 | 全领域对账表 + verdict 三态徽标 | `dshctl upgrade-check` |
| **插件库** | core 必须件清单展示（蓝 Tag）+ extension 表（收编/移除/标记信任）+ 路径收编表单 + 领域 publish 入库 + zip 上传（base64，50MB 上限）+ git 导入（标注网络前提）；领域表单⑥段改为**库选择器**（多选自动写 id+path，未入库标红提示） | `dshctl plugin list/add/remove/trust/publish/import/import-git` |
| 插件库 · 核心功能「替换」 | **主从结构（先选择后替换），等高双栏 580 内滚**：左清单点选（搜索 + sticky 分组 + **行内只留 id、描述悬停披露** + 蓝底左竖条选中，无行内按钮）→ 右侧三层详情（**渐变磁贴头区带** + 内容节[豁免语义收 ⓘ] + **底部动作条**「替换…」唯一入口）→ 600 三阶段 Drawer（对比卡 + 表单 + **自动预演**[verdict / 步骤时间线 / **行级 diff** / 等价命令] + 执行结果[槽豁免徽标 / 回退指引] + 常驻操作条）；同源引擎，check 不过自动回滚 | `dshctl replace <旧> --with <新> … --yes` |

**首次使用**：需先 `cd gui && pnpm install && pnpm build`（产物 `gui/dist/`，server 自动托管；未构建时访问会提示）。

## 8. CI 与自动化

```sh
bash /hdd/demo/public/dsh-info/code/dshctl/ci.sh
```

五环节（任一失败整体非零退出）：

| # | 环节 | 说明 |
|---|---|---|
| 1 | dshctl self-test | 150 断言（自带 tsx） |
| 2 | dsh-plugin self-test | 136 断言（沿用 harness 惯例） |
| 3 | ops-api self-test | 存量回归 |
| 4 | upgrade-check | 全领域上游对账（verdict 非 pass 则失败） |
| 5 | `check ops --ci` | 目标领域全规则 |

**每周观察期巡检**：跑 `ci.sh` 一条即可（或最小化为 `dshctl upgrade-check && dshctl check ops --ci`）。

## 9. 典型工作流

### 9.1 每周巡检
```sh
dshctl check ops --ci
```

### 9.2 harness 升级跟随
```sh
cd deepseek-harness && git pull && pnpm install --store-dir .../pnpm-store && pnpm build && pnpm build:web
dshctl upgrade-check --refresh          # verdict PASS 才继续
systemctl restart dsh-ops-trial
bash code/scripts/bench-4q.sh http://127.0.0.1:8643 i2stream-ops $OPS_API_KEY   # 回归
# 回填版本与结果到 orchestration-plan §8
```

### 9.3 新建第二个领域（以 SQL 域为例）
```sh
# 1) 手写 domains/sql-transform/domain.yml（capabilities: [file-ops, script]，guard 白名单，port 8644...）
dshctl check sql-transform              # 先把 R4/R7/R8 修到 0 error
dshctl apply sql-transform --dry-run    # 审阅将写什么
dshctl apply sql-transform --yes        # 造实例骨架（空目录即 init）
dshctl smoke sql-transform              # 临时实例冒烟
dshctl check sql-transform --ci         # 复核
dshctl registry                         # 已自动登记
# 2) 拷 settings/credentials → 装 systemd unit（用 --unit-out 模板）→ 起正式实例
```

### 9.4 改动能力包/清单后的一致性确认
```sh
dshctl diff ops        # 空 = 改动与实例现状一致（或 apply 已同步）
dshctl check ops --ci
```

## 10. 故障排查

| 症状 | 原因 | 处置 |
|---|---|---|
| `dshctl: command not found` | PATH 软链未装 | §2.2 重装软链；或用完整路径 `code/dshctl/bin/dshctl` |
| `Cannot find ... tsx/dist/esm/index.mjs` | 未 `pnpm install`（自带 tsx 缺失） | §2.1 安装依赖 |
| check 报 `[degraded] dump-config 不可用` | harness 未构建 / 超时 | 先 `pnpm build`；或 `--refresh` 重试；清单内部校验部分仍有效 |
| R2 大面积 error（id 消失） | harness 升级改名/删除了行 | 按 upgrade-check 清单逐 id 跟进能力包片段 |
| apply 拒绝执行 | check 有 error | 先修 check；工具会打印具体规则 |
| apply 报"写路径越界" | 生成路径被指到 DSH_HOME 外 | 修 domain.yml 的 dsh_home/preset.source |
| smoke 起不来（端口全占 / health 超时） | +100~+110 全占 / 实例配置缺 env | 看报告头标注的实际端口与日志路径（`domains/.cache/smoke-*.log`）；确认 `$DSH_HOME/ops.env` 存在 |
| smoke 端口 overlay 报"未找到 domain-api 条目" | profile patch 里 domain-api insert id 异常 | 检查 `api_server.plugin_id/plugin_path` 与 profile patch 一致性 |
| GUI 打开是 404/提示 not built | 前端未构建 | `cd gui && pnpm build` |
| GUI check 转圈/超时 | 首次 roster 生成（真跑 dump-config）耗时 | 等待或先在 CLI 跑一次 `check <d> --refresh` 建缓存 |
| registry 里端口与实际不符 | 实例迁移/转正后未同步 | 改 domain.yml + 重跑 `adopt`（幂等 upsert）或手工编辑 registry.yml |

**日志位置**：smoke 实例日志 `domains/.cache/smoke-<domain>-<port>.log`；正式实例日志走其 systemd unit（`journalctl -u <unit>`）。

## 11. 维护约定与红线

1. **密钥永不落盘**：domain.yml / 生成物只记环境变量名（`api_key_env`），值放实例的 ops.env / systemd EnvironmentFile；R8 拦截字面值。
2. **对上游 harness 净改动 = 0**：dshctl 只消费 dump-config / 文件产物，不 import DSH 运行时、不写 harness 仓任何文件。
3. **两层运行时边界**：dshctl 自带 tsx 只跑自己；被编排实例一律走 `dsh_source` 的 harness 运行时。
4. **规模口径**：可执行代码（不含 self-test）**≤1900 行**（2026-09-18 实测 2137 行/非空非注释、2462 行/含注释——替换通道两轮已越线，**口径修订待拍板**，见 exec-plan 替换通道二期补记；原决议：插件库 P1-P3 修订 1500→1900——依据见 exec-plan §4，GUI 工程继续单列）——逼近红线先砍需求，不堆功能。
5. **能力包归属唯一**：同 id 不得多片段；core 恒隐含必裁；keep_tools 语义是"从核心层放回"。
6. **写盘三门**：check 有 error 拒绝、路径强制在 DSH_HOME 内、全部原子写；对现存实例先 `--dry-run`。
7. **git 仓纪律**：`code/dshctl` 独立 git 仓（node_modules/gui 产物已 gitignore）；改动提交附行为说明。
8. **文档回填**：行为变化同步 `dshctl-exec-plan.md` 与本手册；规则变化同步 §5 表。

---

## 附：版本记录

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-09-17 | v1.5 | **GUI v5 降噪 + 手册**：全站 Alert 清零（ⓘ 悬浮+toast+StatusRow）；等价命令集中 Popover；插件卡瘦身+Drawer 详情；路径末段名+tooltip；Upgrade verdict 轻横条；新增 GUI「使用手册」页 + doc/dshctl-user-manual.md 完整用户手册（exec-plan 有补记） |
| 2026-09-17 | v1.4 | **编排可视化 v4**：领域详情独立页 + 拖拽编排画布（React Flow 四层推导/依赖连线/插件排序写回 plugins[]/depends_on 声明虚线）+ 插件目录与领域插件卡片墙（exec-plan 有补记） |
| 2026-09-17 | v1.3 | **领域详情 v3**：概览页签（运行状态 tri-state + 真控制起停[systemctl，unit 只取自 registry]+冒烟测试+领域信息+插件库对齐卡）；左栏运行 chip；编辑页分区锚点导航；/api/instance(s) 生命周期路由（exec-plan 有补记与 live 验收证据） |
| 2026-09-17 | v1.2 | **GUI v2 重构**（浅色控制台风）：check 历史记录（.check-history.json cap 200）+ 只读 /api/history + Dashboard 趋势点阵；领域管理 master-detail；新建领域向导 5 步（DomainForm 拆 10 section 复用）；插件库三页签（目录/新建导入/核心必须件分组）；升级对账大 verdict 色块+领域卡片；Registry 层次重排（exec-plan 有补记） |
| 2026-09-17 | v1.1 | **GUI v1.1 UI 打磨**（纯展示层）：菜单分组/每页副文案/PageHead 图标磁贴/LevelDot 中文/RuleLegend R1-R12 图例/check 结论横幅+级别过滤+展开行/Upgrade verdict 横幅+Tag 白屏隐患修复/Plugins core 收纳+Upload/NewDomain Steps/字段级 Tooltip（exec-plan 有补记） |
| 2026-09-17 | v1.1 | **插件库 plugin-registry**：`plugin-registry/{registry.yml,core.yml,sources/}` + `dshctl plugin`（list/show/add/remove/trust/publish/import/import-git）+ check **R11**（core 不可裁）/**R12**（库对齐/untrusted warn）+ GUI 插件库页 + 领域表单⑥库选择器 + zip 上传（zip-slip 过滤）/git 导入（网络前提提示）；self-test [1]-[13] 108 断言；规模口径修订 1500→1900（exec-plan §4 决议；实测 1734） |
| 2026-09-16 | v1.0 | adopt/check/diff/apply/smoke/upgrade-check/registry + GUI v0.4 + CI；**独立化**：自带 tsx + bin wrapper（任意目录可用）+ 两层运行时边界 |
| 2026-09-16 | v0.3 | upgrade-check（R10 转正于 v0.2 已实现） |
| 2026-09-16 | v0.2 | apply + smoke + R4/R5/R9 |
| 2026-09-16 | v0.1 | adopt + check（R1-R3/R6-R8）+ registry + 最小只读 diff |
