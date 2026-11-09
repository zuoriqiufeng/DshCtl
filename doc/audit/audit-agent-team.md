# 智能审计团队（audit agent team）定义

> 源：复刻 i2stream-bkn 项目的"多视角独立审计 + 独立复核 + 换人复审"智能审计团队。
> 产出范式：`doc/audit/reports/YYYY-MM-DD-{design|functionality|performance|quality|style}.md`
> + `YYYY-MM-DD-consolidated.md`，复审核对后落 `doc/optimize/{NN}-audit-remediation-plan-YYYY-MM-DD.md`。
> 2026-11-08 复刻落盘 · 团队固化于 `code/scripts/audit-team.preset.json`（机器可读）。

---

## 0. 团队结构（6 成员）

| 角色 | 视角 | 检查维度（对目标项目） |
|---|---|---|
| lead-reviewer | 首席审计 / 汇总复审 | 收五份独立报告 → 逐条复核 → 分类（confirmed / improved / observation）→ 输出汇总报告与缓解计划 |
| design | 设计与架构 | 模块划分与依赖、耦合度（hub/fan-in/fan-out）、分层、重构债务、单一职责、公共抽象一致 |
| functionality | 功能正确性 | 每个能力/工具的输出契约、金样一致性、错误路径、契约型断言覆盖、下沉/回退语义 |
| performance | 性能与资源 | 热路径耗时、缓存正确性（深拷贝/失效/key 指纹）、超时与护栏、批量 deadline、并发稳定性 |
| quality | 代码质量 | 死代码/装饰性产物、import 清理、静默吞错、日志可观测、测试充分性/断言型 evals |
| style | 风格一致性 | 命名与标识符一致性、跨文件常量单一来源、注释与实况一致、格式（lint/gate）达标 |

## 1. 工作流

1. **并行独立审计**：6 名 specialist（design…style）只读审计，互不引用对方结论（保独立性）。
2. **独立复核（换人复审）**：lead-reviewer 不看 specialist 草稿，先独立跑主要证据 → 再与五份对照，
   标记 confirmed（源码/日志双证）/ improved（朝向正确但缺门禁或未落地）/ observation（观察项）。
3. **汇总与缓解计划**：lead-reviewer 产出 consolidated 报告 + `{NN}-audit-remediation-plan-*.md`，
   按 P1/P2/P3 优先级分条；每条「证据 + 建议 + 行为类（A/B/C） + 验证/回归要求」。
4. **立项/回填**：通过后按批实施，每批回填验收表；未过的一律回计划不留灰。

## 2. 纪律（每个成员强制）

- **只读**：审计不改任何被审文件；探针脚本放 .dsh/ 或 /tmp，不落入仓库。
- **证据双证**：一个结论至少源码一处 + 日志/运行/测试一处；给不出双证就归 observation。
- **不猜测**：够不到的事实标「待确认」，绝不替实现编文案。
- **产出规约**：每份报告固定小节 = 方法/发现清单（编号 D-x）/逐条证据/结论/受限声明。
- **诚实**：无对应的能力/路径显式写出，不造假、不静默忽略。

## 3. 成员 prompt（spawn 模板）

见 `code/scripts/audit-team.preset.json`：每成员含 `name / description / prompt`，
可直接用 `spawn_teammate({name, description, prompt})` 拉起；`context: "fresh"` 保独立性，
lead-reviewer 用 `"fork"`（看主线程上下文）。

## 4. 消费方法

- 以 lead 身份对某项目起这支队：目标路径替换 {ROOT}，日期替换 {YYYY-MM-DD}。
- 先并行 spawn 5 名 specialist（fresh），各自写 reports/{date}-{persp}.md；
- 再 fork spawn lead-reviewer，读五份 → 交叉独立复核 → consolidated + remediation plan。

## 5. 变更记录

- 2026-11-08：复刻自 i2stream-bkn 审计工作流落盘。
