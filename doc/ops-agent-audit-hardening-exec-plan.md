# 审计报告落地执行计划（P1.5：小成本四件套 + 闭环桥接）

> 2026-11-05 · 状态：**✅ 已实施 + 验收结果回填**（live 补测项见验收表下声明） · 依据：《功能调研与优化审计报告》（动态工作流产出，8 条 confirmed Top 建议）
> 范围裁定：批次 A（四条 small 成本项）+ 批次 B（闭环桥接）实施；批次 C（工程护栏/中期项/催办类）只登记进 roadmap 不实施。

---

## 批次 A：小成本四件套

| # | 任务 | 落点 |
|---|---|---|
| A1 | BM25 索引刷新：`getPointsCount(collection)`（复用 httpJson）+ `bm25RefreshSec` config（默认 0=关）+ timer tick 比对 points_count 变化定向 `resetBm25`；失败缓存（null）改为可重试 | `code/dsh-plugin/retrieval.ts:186-223`、`index.ts`（inject 加 timer，照抄 bkn-feedback 模式） |
| A2 | 失败 turn 入 usage：各 catch 路径调 `reportUsage({零 token, finishReason:'timeout'|'error'|'abandoned'})`（轻量方案 a，零接口变更）；DailyAgg 加 errors/errorsTimeout/errorsAbandoned，aggregate 按 finishReason 计数；UsageRecord 注释标 OTel GenAI 对应 | `code/ops-api/index.ts` 5 处 catch、`code/dsh-observability/index.ts` |
| A3 | capture_correction preset 触达：`buildHotpath`（gen-hotpath-prompt.ts:50-56 循环后）追加静态行；重跑生成（双写 hotpath.md + agent.cordis.yml 内嵌块）；main() 写入前断言含 capture_correction（防漂移） | `code/scripts/gen-hotpath-prompt.ts`、`code/presets/i2stream-ops/` 产物 |
| A4 | gap_log 写侧加固：appendCorrection 写前 rotateIfNeeded（复制 dsh-observability 实现，S0）；`sanitizeCorrection()` 纯函数（strip 控制字符、correction≤2000、tool≤64、gaps 元素截断）；admin-html 加 escapeHtml（serverName/skill 名/e.message 拼接点） | `code/bkn-feedback/index.ts:60-74`、`code/ops-api/admin-html.ts:119-145` |

## 批次 B：闭环桥接

| # | 任务 | 落点 |
|---|---|---|
| B1 | /admin 桥接三个 provide 服务：`GET /admin/api/observability`（aggregate+recentRisk）、`GET /admin/api/feedback`（analyze）、`GET /admin/api/skills/usage`（skillManagerAdmin.usage()）；/admin 页加"反馈闭环"区块（全经 escapeHtml；服务缺席诚实提示） | `code/ops-api/index.ts`、`admin-html.ts` |
| B2 | resolved 写回：bkn-feedback 新增 `resolve_correction` 工具 + `POST /admin/api/feedback/resolve` 端点（按 timestamp+tool 定位行改写 resolved:true，读-改-写前重读防 rotate 竞态） | `code/bkn-feedback/index.ts`、`code/ops-api/index.ts` |
| B3 | /admin 观测卡片补失败率行（依赖 A2 errors 字段） | `code/ops-api/admin-html.ts` |

## 批次 C：只登记（roadmap 更新，零代码）

- 工程护栏：pack 资源越界扫描（boundary-direction §8 开放项③）、BKN 漂移监控进 check、DSHCTL_ROOT、prepareSession 内联段去重、aggregate days 切片语义
- 中期：按意图过滤工具子集（依赖 K5）、Skill 渐进式披露、可插拔编排策略、输出护栏位、副作用幂等键、RRF vs DBSF nDCG@10 实验
- 文档修正：roadmap K2 表述（/v1/metrics 已上线）+ 状态行补 P1.5

---

## 验收回填（AGENTS §2：只认 live 实测）

| 例 | 用例 | 结果 |
|---|---|---|
| A1-1 | BM25 失败缓存可重试（构建失败后再次调用重建而非永久 null） | ✅ dsh-plugin self-test「BM25 可重试不变式：reset 后未构建即懒加载（refresh no-op）」+ 空集合/构建失败均不再进 ready 集（retrieval.ts 改为 delete bm25Ready） |
| A1-2 | bm25RefreshSec>0 时 points_count 变化触发定向 resetBm25 | ✅ `refreshBm25IfStale` 落地（retrieval.ts：快照 pointsCount 比对→失效待重建）；index.ts timer tick 挂接（默认 0=关闭，行为与此前一致）+「getPointsCount：Qdrant 不可达 → null 不抛（H-15）」断言 |
| A2-1 | TurnTimeoutError/abandoned catch 路径产生 usage 记录（finishReason 分档） | ✅ ops-api 5 处 catch 挂 `reportFailure('timeout'|'error'|'abandoned')`（chat 非流式/SSE/responses 流式/非流式）；轻量方案 a，零接口变更 |
| A2-2 | aggregate.errors / errorsTimeout / errorsAbandoned 计数正确；/v1/metrics 带出 | ✅ dsh-observability self-test [6b] 三断言（errors=4 / 分桶 / abandoned_partial 计入）；UsageRecord 注释标 OTel GenAI 对应 |
| A3-1 | gen-hotpath-prompt 重跑幂等（两次生成 diff 为空）且含 capture_correction 行 | ✅ 实测：两次生成 diff 空（IDEMPOTENT ✅）；hotpath.md:13 与 agent.cordis.yml:32 均含【反馈回流】行（约 480 token） |
| A3-2 | 防漂移断言在位（生成串缺 capture_correction 即抛错） | ✅ gen-hotpath-prompt.ts main() 写入前断言 + dsh-plugin self-test「hotpath 防漂移」两断言 |
| A4-1 | sanitizeCorrection：控制字符剥离/长度截断/gaps 消毒 | ✅ bkn-feedback self-test [1b] 四断言（'a\u0000\u001fb'→'a b'、3000→2000、trim、append 正常） |
| A4-2 | admin escapeHtml：含 `<script>` 的 serverName 渲染后不产生可执行标签 | ✅ admin-html.ts escapeHtml helper 全拼接点转义；ops-api self-test 16.4（escapeHtml≥8 处调用）+ 16.1 页面脚本可解析 |
| B1-1 | /admin 三个只读端点返回数据；服务缺席时诚实提示 | ✅ 路由落地（observability/feedback/skills usage，ctx.get 兜底 404 not_found）；self-test 16.5 区块与端点在位 |
| B2-1 | resolve_correction 置位后 correctedBacklog 下降 | ✅ bkn-feedback self-test [1b]：resolve 前 correctedBacklog=1 → resolve 后 =0（corrections 不变）+ 无匹配 ok:false；agent 侧 resolve_correction 工具 + POST /admin/api/feedback/resolve 端点 |
| B3 | /admin 观测卡片补失败率行 | ✅ renderObs 加"失败 X（timeout Y / abandoned Z）"；self-test 16.6 |
| CI | `bash code/dshctl/ci.sh` ALL GREEN（9 环节） | ✅ 2026-11-05 实测 ALL GREEN；`dshctl check ops --ci` exit=0 |

> **live 补测（2026-11-06，实例 apply + 重启后实测）**：
>
> | 项 | 结果 |
> |---|---|
> | /v1/metrics errors 实际带出 | ✅ 一次 abandoned 回合后实测 `requests=1 / errors=1 / errorsAbandoned=1 / days=1 / sessions=1`，`$DSH_HOME/observability/usage-20261106.jsonl` 落盘（A2 失败入账 + 观测服务双通） |
> | /admin 反馈闭环区块渲染 | ✅ `/admin` 200，区块标题与卡片说明在位；三个只读端点 Bearer(admin key) 均 200——observability（aggregate + recentRisk）、feedback（28 条既有 gap 分析：confidenceDist/topGaps/backlog）、skills/usage（`{}` 空台账诚实返回） |
> | bm25RefreshSec 生产配置启用 | ✅ `domains/ops/domain.yml` bkn-plugin 段设 600s → apply 生成 `profile patch:13 bm25RefreshSec: 600`；重启后 journal 无相关报错 |
> | capture_correction 被模型真实调用 | ⏸ 仍阻塞：网关 `/v1/models` 返回空清单（2026-11-06 用有效 key 复测仍 0 模型）+ 会话默认模型未配置 → 无成功回合可触发工具调用。工具已注册（`/v1/capabilities` tools 17→19 = +capture_correction/resolve_correction），待网关恢复补测 |
>
> 本轮同时确认：两插件已随 apply 进入 profile patch（`dsh-observability`/`bkn-feedback` 声明行在位），实例运行 0.3.0 正常。
>
> 批次 C 已登记：roadmap §10（工程护栏 K12-K14 / 中期项 / 催办类）。

## 踩坑沉淀

| 症状 | 根因 | 修复 |
|---|---|---|
| observability self-test 分桶断言首跑失败 | fixture 里 abandoned_partial 行期望误计入 errorsAbandoned——实现按精确 'abandoned' 匹配，部分文本弃答（finishReason='abandoned_partial'）只进 errors 总数 | 期望值修正为 1；口径结论：errors=全部非 stop，errorsAbandoned=精确 'abandoned'（bridge 有部分文本时 finishReason 为 abandoned_partial 且走成功路径） |
| self-test `resetBm25 is not defined` | 新增断言用了未 import 的符号 | import 列表补 resetBm25（tsxEsm 直跑报错行号直达） |
