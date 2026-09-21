# dshctl — DSH 领域编排 CLI（v1.0）

清单驱动、幂等生成、对账校验。**只管交付期**（实例怎么被正确地造出来并保持正确），不碰运行期热管理（那是 DSH /admin 的职责）。
设计：`doc/gernalarrange/dshctl-design.md`；实施与验收：`doc/dshctl-exec-plan.md`；
**完整使用手册（安装/构建/运行/命令/规则/排障）：`doc/dshctl-manual.md`**。

## 命令

| 命令 | 职责 |
|---|---|
| `adopt --instance <name>` | 反向归档现存实例 → domain.yml + 能力包 DRAFT（首次）+ registry 登记 |
| `check <domain> [--ci] [--refresh]` | 对账器：R1 端口/登记 · R2/R3 上游 roster · R4 script 白名单 · R5 契约目录 · R6 skills · R7 超时 · R8 密钥 env · R9 依赖探活 · R10 归层缺口 |
| `diff <domain>` | 只读 diff：apply 生成面对账（子集语义，空=理解现状） |
| `apply <domain> [--dry-run] [--yes]` | 落盘编排五件生成物（check 有 error 拒绝；settings 不生成） |
| `smoke <domain> [--bench]` | 临时实例冒烟（api+100 端口顺延 + overlay 隔离 + api-smoke + 领域自检 + 兜底清理） |
| `upgrade-check [--refresh]` | 升级跟随对账（手册第 2 步自动化）：verdict pass/blocked/degraded |
| `registry` | 实例登记表一览 |
| `gui serve` | GUI 薄壳（v0.4，`gui/` 工程）：只可视化本工具产出，操作可复现为等价 CLI 命令 |

运行：**`dshctl <cmd>`**（PATH 软链 → `bin/dshctl`；自带 tsx，**任意目录可用**，无需 cd）；退出码 0/1/2 = 通过/校验失败/执行错误。

## 两层运行时边界（独立化，2026-09-16）

- **dshctl 自身运行时**：自带 tsx@4.22.4（devDependency），wrapper 以 `node --import file://<绝对路径>/tsx/dist/esm/index.mjs` 加载——不依赖 cwd，与 harness 解耦；
- **被编排对象运行时**：所有 DSH 域实例（check 的 dump-config、smoke 的 `pnpm dsh` spawn）统一走 `dsh_source`（harness）的运行时——dshctl 编排它们，但不用自己的 tsx 跑它们。

入口：`bin/dshctl`（CLI）/ `bin/dshctl-selftest` / `bin/dshctl-gui`（GUI server，`--port` 透传）；`/usr/local/bin/dshctl` 为 PATH 软链。
CI：`bash ci.sh`（五环节：本工具 + dsh-plugin + ops-api self-test + upgrade-check + check --ci）。

## 维护约定

- 密钥永不落盘（domain.yml 只记 env 变量名；R8 校验字面值）；
- 对上游 harness 净改动 = 0（只消费 dump-config/文件产物，不 import 运行时）；
- 规模口径：**可执行代码（不含 self-test）≤1900 行**（当前 ~1734；v1.1 插件库后由 1500 修订——决议见 doc/dshctl-exec-plan.md §4）——逼近红线先砍需求；
- 能力包片段同 id 归属唯一；core 隐含必裁；keep_tools 从 core 放回；
- 升级 5 步手册第 2 步已由 `upgrade-check` 自动化。
