# DSH 学习指导（dsh-guide）

> 面向第一次接触 DeepSeek Harness（DSH）/ Cordis 的人：从整体视角、由浅入深建立心智模型。
> 本系列是**学习指导**，不是参考手册——查 API 去官方 docs，抠源码行号去 internals。

## 这套文档是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 学习路线：按 01→06 顺序读，每篇建立一层心智模型 | API 参考（那是 harness `docs/cordis-api/` 的事） |
| 整体图：架构分层、启动流程、组件含义、概念串联 | 源码逐行深挖（见 `doc/dsh-plugin-internals.md`） |
| 与官方 docs 措辞对齐的中文导读 | dshctl 的使用手册（见 `doc/dshctl-user-manual.md`） |
| — | 官方插件文档的阅读路线（见 `doc/dsh-plugin-reading-guide.md`） |

## 推荐阅读顺序

| # | 文档 | 你会学到什么 | 预计 |
|---|---|---|---|
| 0 | [README.md](README.md)（本篇） | 四份文档怎么分工、从哪开始 | 3 min |
| 1 | [01-architecture.md](01-architecture.md) | DSH 整体架构：everything-is-a-plugin 是什么意思、六层怎么分 | 10 min |
| 2 | [02-startup.md](02-startup.md) | 从敲下命令到插件树跑起来的完整链路，一次请求怎么走 | 15 min |
| 3 | [03-cordis-concepts.md](03-cordis-concepts.md) | Cordis 核心组件的含义：Plugin / Fiber / Context / Service / 事件 | 15 min |
| 4 | [04-config-loading.md](04-config-loading.md) | YAML 如何变成插件树：patch 语义、Profile/Bundle/Preset、HMR 边界 | 15 min |
| 5 | [05-runtime-tools.md](05-runtime-tools.md) | 运行时：turn/step、defineTool、工具护栏管线 | 10 min |
| 6 | [06-reading-guide.md](06-reading-guide.md) | 官方 176 篇 docs 地图 + 5 条最容易误解的点 + 自测 | 10 min |

> 想按**插件机制**主题读官方文档，见 [../dsh-plugin-reading-guide.md](../dsh-plugin-reading-guide.md)：讲清官方两条教学线对 `cordis.yml` 说法相反的原因、四站阅读顺序、版本漂移对照表。

## 四份文档的分工地图

```
学习（本系列 doc/dsh-guide/）
 ├─ 概念不懂 → 03-cordis-concepts、06 的误区清单
 ├─ 流程没数 → 02-startup
 └─ 整体没底 → 01-architecture

查（harness 官方 docs，deepseek-harness/docs/，176 篇英文）
 ├─ 总纲        architecture.md
 ├─ 框架入门    cordis-primer.md、cordis-tutorial/（8 篇：index + 7 章）
 ├─ 插件开发    user/develop/（10 篇：basic 4 / framework 3 / practice 3）
 ├─ 子系统细节  subsystems/*.md（63 篇，一页一子系统）
 ├─ 动手配方    cookbook/*.md（11 篇）
 └─ 术语        glossary.md（171 篇配 .zh.md 中文对侧）

读（官方插件文档路线）doc/dsh-plugin-reading-guide.md
 └─ 两条教学线的区别、四站阅读顺序、版本漂移警告

挖（doc/dsh-plugin-internals.md，源码级）
 ├─ loader / profile / patch 语义的 file:line 证据
 ├─ inventory 两兄弟的真实字段
 └─ 服务体系 / defineTool / HMR 三段论的逐行结论
```

**一个事实只在官方 docs 里有一个家**——本系列负责「怎么串起来学」，不重新定义术语；深挖证据一律链到 internals。

## 前置知识

- 会 Node.js + TypeScript（能读 `src/*.ts` 即可）。
- 懂 YAML 基本结构（配置都是 `cordis.yml` / `cordis.patch.yml`）。
- **不要求**读过 Cordis 论文或用过任何 IoC 框架——03 篇会从零讲。
- 源码树：本系列 file:line 均相对 `deepseek-harness/`（上游副本）。
  ⚠️ **版本锚点已更新到 v0.1.7-alpha.2**：原核实于 `0d1f50007f`（v0.1.6-alpha.1，2026-09-15）；上游已于 2026-09-23 升级至 `00102833df`（v0.1.7-alpha.2，距旧锚点 2343 个提交），01/02/04/05 篇主要行号已按新版本实测回填（旧值一并保留），03/06 篇仅更新了交叉引用与计数。漂移实测与未复核范围见 [dsh-plugin-reading-guide.md §5](dsh-plugin-reading-guide.md#5-版本锚点与漂移警告)。
