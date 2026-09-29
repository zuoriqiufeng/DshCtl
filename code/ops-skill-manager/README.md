# ops-skill-manager — 技能自管理插件

让 Agent 自己管理技能包（SKILL.md 目录）：暴露 `skill_manage` 工具（create / patch / write_file /
archive / restore / sync / enable / disable），记 usage 台账，并由 curator 定时做
`active → stale → archived` 迁移（pinned 与预置技能豁免，**绝不删除**）。对齐 Hermes 的
`skill_manager_tool` + curator 行为。

> **位置**：`/hdd/demo/public/dsh-info/code/ops-skill-manager/`。挂载由 profile patch 的
> `ops-skill-manager` insert 行完成；config 经 `domain.yml plugins[].config` → `dshctl apply`
> 写入 patch（v1.7 起 config 走原文通道，`!!js` 表达式保真）。

## 文件

```
ops-skill-manager/
├── index.ts     插件入口：config schema + skill_manage 工具 + curator 定时器
├── ops.ts       文件操作原语：create/patch/write/archive/restore/sync（目录改名启停）
├── store.ts     usage 台账（JSON，skill 工具读取 + skill_manage 动作均 bump）
├── ledger.ts    变更 ledger：before/after sha + 内容寻址备份 blob
├── curator.ts   迁移状态机 active→stale→archived（pinned/预置豁免）
└── self-test.ts 独立自测（node --import tsx/esm self-test.ts）
```

## 外部依赖（需自行部署/提供）

| 依赖 | 用途 | 配置项 | 不可用时行为 |
|---|---|---|---|
| **skills 根目录**（可写） | 技能包实体：每个子目录一个 `SKILL.md`（含 `name`+`description` frontmatter）；启停=目录改名 | `skillsDir`（默认 `$DSH_HOME/skills`） | 目录缺失 → 工具报错（诚实的失败，不静默） |
| **上游技能源**（只读） | `sync` 动作的拉取源（共享技能仓 `i2stream-bkn/skill`，只读消费） | `upstreamDir`（**sync 前必填**；未配置时 sync 返回 `ERROR: upstreamDir not configured`） | 其余动作不受影响 |
| 计时器服务 | curator 定时调度 | `intervalHours` 等（见下） | 由 dsh-base 保证 `timer` 服务（`inject` 声明） |

无 HTTP/网络类依赖。另通过 `ctx.provide('skillManagerAdmin', ...)` 向 ops-api 的 `/admin`
暴露只读查询（进程内服务，非外部连接）。

## Config 全字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `skillsDir` | `$DSH_HOME/skills`（代码兜底 `join(DSH_HOME ?? cwd/.dsh, 'skills')`） | 被管理技能根目录（写目标） |
| `upstreamDir` | `''`（未配置） | 上游共享技能源（`sync` 拉取源，只读消费） |
| `intervalHours` | `168`（7 天） | curator 周期 |
| `staleAfterDays` | `30` | 不活动转 stale 阈值 |
| `archiveAfterDays` | `90` | stale 转 archived 阈值 |
| `firstRunDelaySec` | `120` | 启动后首轮 curator 延迟（避开启动高峰） |
| `enabled` | `true` | 工具与定时器总开关 |

## dsh.plugin.yml 示例（`dshctl plugin install` 消费）

```yaml
schema: 1
id: ops-skill-manager
entry: index.ts
layout: in-place
description: 技能自管理。暴露 skill_manage 工具让 Agent 自己安装/启停/更新技能包并记 usage 台账。
config:
  skillsDir: /hdd/demo/public/dsh-info/.dsh-home/skills
  upstreamDir: /hdd/demo/public/i2stream-bkn/skill
  intervalHours: 168
  staleAfterDays: 30
  archiveAfterDays: 90
  firstRunDelaySec: 120
provides:
  - skill_manage（安装/启用/禁用/更新技能）
  - usage 台账
  - curator 迁移
category: 技能管理
```

> `dshctl plugin install <id> --domain <域>` 会把 manifest.config 合并进
> `domains/<域>/domain.yml plugins[].config`，再由 `dshctl apply` 渲染进 profile patch。
> **改 manifest.config 或 domain.yml 后都要 re-apply** 才对运行实例生效。

## 目录语义（C1 整改结论，勿回退）

- `skillsDir` 是**唯一**被管理的技能根：catalog 只认 DSH 默认根（`$DSH_HOME/skills`，user-dsh rank 400）。
  历史上 preset 的 `skill-filesystem.customSkillDirs` 曾造成双源同名（custom rank 300 赢），
  管理面启停被 shadow → 已移除，勿再加回。
- 共享源 `/hdd/demo/public/i2stream-bkn/skill` 降为"上架源"：只由本插件的 `sync` 拉取到 `skillsDir`。

## 自测

```sh
cd /hdd/demo/public/dsh-info/deepseek-harness
node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-skill-manager/self-test.ts
```
