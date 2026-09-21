# dsh-info

运维 agent（i2stream-ops）工作区：BKN 检索插件、OpenAI 兼容 api-server、技能自管理、领域编排 CLI，以及全部方案与验收文档。

工作区规则、编码约定与红线以 [AGENTS.md](./AGENTS.md) 为唯一权威（冲突时以其为准）；首次上手按 [doc/dsh-guide/README.md](./doc/dsh-guide/README.md) 的顺序读。

## 目录结构

| 路径 | 内容 |
|---|---|
| `code/dsh-plugin/` | BKN 插件（TS：12 工具 + RiskGuard 护栏 + 检索栈） |
| `code/ops-api/` | api-server + 会话桥 + 记忆 + supervisor 插件 |
| `code/ops-skill-manager/` | 技能自管理（`skill_manage` 工具 + usage 台账 + curator 迁移） |
| `code/dshctl/` | 领域编排 CLI + GUI（使用手册 `doc/dshctl-manual.md`） |
| `code/presets/i2stream-ops/` | 运维 agent preset（`hotpath.md` 由脚本生成，禁止手改） |
| `code/capability-packs/` | 能力包定义（core / file-ops / remote-exec / script） |
| `code/guard-rule-sources/` | RiskGuard 白名单规则源 |
| `code/sidecars/` | `embed-server.py`（BGE 向量 sidecar，独立进程） |
| `code/scripts/` | 冒烟、计时、生成脚本 |
| `doc/` | 方案/设计/验收回填文档（`dsh-guide/` 上手指南，`gernalarrange/` 通用编排方案） |
| `domains/` | 领域实例注册表与 ops 域配置（`registry.yml`、`ops/domain.yml`） |
| `plugin-registry/` | 插件库目录（`registry.yml` + `core.yml` 核心功能清单） |
| `deepseek-harness/` | 上游 DSH 源码副本 —— **不入库**（独立 git 仓，对上游净改动=0，已由 `.gitignore` 排除） |
| `.dsh-home/` | 试验实例 HOME，含密钥/会话/日志 —— **不入库** |

## 快速验证

```sh
# self-test（需 harness 的 tsx，cd 到 deepseek-harness 下运行）
node --import tsx/esm ../code/dsh-plugin/self-test.ts
node --import tsx/esm ../code/ops-api/self-test.ts

# dshctl 五环节一键 CI（自带 tsx，任意目录可跑）
bash code/dshctl/ci.sh          # 或 dshctl-selftest

# HTTP 契约与计时冒烟（需现网实例在跑）
bash code/scripts/api-smoke.sh
bash code/scripts/bench-4q.sh http://127.0.0.1:3080 i2stream-ops
```

端口约定（3080 现网 GUI / 8643 试验实例 / 6333 Qdrant / 8096 embed / 8420 Gateway / 8090 i2agent）、降级铁律、会话协议要点等完整规则见 [AGENTS.md](./AGENTS.md)。

## Git 说明

- 本仓只收录自有资产（`code/`、`doc/`、`domains/`、`plugin-registry/`、`AGENTS.md`、本 README）；运行时与构建产物（`.dsh-home/`、`.pnpm-store/`、`node_modules/`、`gui/dist/` 等）由 `.gitignore` 排除。
- `code/dshctl` 原独立仓 36 条历史已 bundle 留底于工作区外的 `dsh-info-dshctl-history.bundle`，内层 `.git` 已移除并入本仓。
- 运行 `dshctl check ops --ci` 会刷新 `domains/registry.yml` 的 `last_check` 字段，属正常可提交变更。
