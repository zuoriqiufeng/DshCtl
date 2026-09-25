# dshctl — DSH 领域编排 CLI（v1.0）

清单驱动、幂等生成、对账校验。**只管交付期**（实例怎么被正确地造出来并保持正确），不碰运行期热管理（那是 DSH /admin 的职责）。
设计：`doc/gernalarrange/dshctl-design.md`；实施与验收：`doc/dshctl-exec-plan.md`；
**完整使用手册（安装/构建/运行/命令/规则/排障）：`doc/dshctl-manual.md`**。

## 命令

| 命令 | 职责 |
|---|---|
| `domain new <name> [--from <域>]` | 生成 domain.yml 骨架（路径/端口/env 名自动推导，不再手写绝对路径） |
| `domain list` | domains/ 全部领域清单（与 registry 登记态并排） |
| `adopt --instance <name>` | 反向归档现存实例 → domain.yml + 能力包 DRAFT（首次）+ registry 登记 |
| `check <domain> [--ci] [--refresh]` | 对账器：R1 端口/登记 · R2/R3 上游 roster · R4 script 白名单 · R5 契约目录 · R6 skills · R7 超时 · R8 密钥 env · R9 依赖探活 · R10 归层缺口 · R11 核心清单 · R12 插件库 · R13 registry 交叉 |
| `up <domain> [--yes]` | 一键链：check → dry-run 预览 →（--yes）apply 落盘 → smoke 冒烟 |
| `diff <domain>` | 只读 diff：apply 生成面对账（子集语义，空=理解现状） |
| `apply <domain> [--dry-run] [--yes]` | 落盘编排五件生成物（check 有 error 拒绝；settings 不生成） |
| `smoke <domain> [--bench]` | 临时实例冒烟（api+100 端口顺延 + overlay 隔离 + api-smoke + 领域自检 + 兜底清理） |
| `upgrade-check [--refresh]` | 升级跟随对账（手册第 2 步自动化）：verdict pass/blocked/degraded |
| `registry` | 实例登记表一览 |
| `plugin …` | 插件库：list / show / add（形态自动判型：目录·zip·git）/ **scaffold** / **pack** / **install** / remove / trust / publish / import / import-git |
|  | **scaffold** = 补全自描述单元（dsh.plugin.yml + package.json main/exports/files/peerDeps）；**pack** = tsc 构建 lib/ + 组合包 patch → tgz；**install** = 装进领域 plugins[]（layout 决定 in-place / vendored） |
| `gui` | GUI 薄壳（等价 `bin/dshctl-gui`，`--port/--host` 透传）：只可视化本工具产出，操作可复现为等价 CLI 命令 |

运行：**`dshctl <cmd>`**（PATH 软链 → `bin/dshctl`；自带 tsx，**任意目录可用**，无需 cd）。
退出码：**0**=通过/无差异；**1**=校验失败或存在待处理差异；**2**=用法/执行错误。`check --ci` 为严格模式（warn 也计失败）。
帮助：`dshctl <cmd> --help` 看单条命令的参数与示例；`<domain>` 省略时按「cwd 在 domains/<名> 内 > 唯一域」推断。

## 两层运行时边界（独立化，2026-09-16）

- **dshctl 自身运行时**：自带 tsx@4.22.4（devDependency），wrapper 以 `node --import file://<绝对路径>/tsx/dist/esm/index.mjs` 加载——不依赖 cwd，与 harness 解耦；
- **被编排对象运行时**：所有 DSH 域实例（check 的 dump-config、smoke 的 `pnpm dsh` spawn）统一走 `dsh_source`（harness）的运行时——dshctl 编排它们，但不用自己的 tsx 跑它们。

入口：`bin/dshctl`（CLI）/ `bin/dshctl-selftest` / `bin/dshctl-gui`（GUI server，`--port` 透传）；`/usr/local/bin/dshctl` 为 PATH 软链。
CI：`bash ci.sh`（五环节：本工具 + dsh-plugin + ops-api self-test + upgrade-check + check --ci）。

## 插件单元化与插入 dsh 的六条路径（v0.5）

插件目录 = 自包含单元：`dsh.plugin.yml`（自描述：id/entry/layout/config/provides）+ 完整 `package.json`（main/exports/files/peerDependencies）。`dshctl plugin scaffold <id>` 补全，`pack` 产出 tgz，`install --domain <d>` 装配。布局：`in-place`（源码原地，改即生效）/ `vendored`（拷进 `$DSH_HOME/plugins/<id>/`，随 home 整体搬移）。

| # | 插入方式 | dshctl 支持 |
|---|---|---|
| ① | profile patch insert（apply 生成） | ✅ 默认装配路径 |
| ② | 组合包 `dsh.bundle` + `dsh plugin add` | ✅ `plugin pack` 产 tgz → 上游通道 |
| ③ | preset（会话级 persona/skills） | ✅（preset 源随域管理） |
| ④ | bundle 纯增量层（ops-app 裁剪面） | ✅（apply 生成） |
| ⑤ | Creator 模式 `plugin_manager`（运行期） | ⚠️ 产出 tgz 即可被其消费；dshctl 不代管运行期 |
| ⑥ | MCP server | ✅（domain.yml shared_deps + admin 托管段） |

## 维护约定

- 密钥永不落盘（domain.yml 只记 env 变量名；R8 校验字面值）；
- 对上游 harness 净改动 = 0（只消费 dump-config/文件产物，不 import 运行时）；
- 规模口径：**可执行代码（不含 self-test）≤1900 行**（当前 ~1734；v1.1 插件库后由 1500 修订——决议见 doc/dshctl-exec-plan.md §4）——逼近红线先砍需求；
- 能力包片段同 id 归属唯一；core 隐含必裁；keep_tools 从 core 放回；
- 升级 5 步手册第 2 步已由 `upgrade-check` 自动化。
