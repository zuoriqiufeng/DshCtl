# 运维 Agent 增强执行计划（roadmap P0+P1）

> 2026-11-03 · 状态：**✅ 已实施 + 验收结果回填**（live 补测遗留见验收表下"遗留与顺延"） · 上游方案：`ops-agent-future-roadmap-plan.md`（§5 优先级）
> 范围：P0 = dshctl S1 三件套 + 文档漂移清理；P1 = dsh-observability / bkn-feedback 两新插件 + ops-api 取消端点与 /admin 增强。
> P2（SQL 第二域）与 P3（触发条件保留项）不在本期。
> 开放问题裁定（可推翻）：Q1 metrics=JSON · Q2 check 规则并入 R12 · Q3 capture_correction 独立插件 · Q4 usage 落盘 `$DSH_HOME/observability/`。

---

## 阶段 A（P0）：dshctl S1 三件套 + 漂移清理

| # | 任务 | 落点 |
|---|---|---|
| A1 | pack fail-loud：staging 后 tsc 前扫 `.ts` 相对 import 越界（`path.relative` 以 `..` 开头即跨插件），命中拒绝打包 | `code/dshctl/unitize.ts`（packPlugin，复用 collectPeerDeps 的 import 正则） |
| A2 | check R12 扩展：域内 in-place 插件同款检测，命中 = error | `code/dshctl/plugin.ts`（checkDomainPlugins） |
| A3 | packPlugin self-test 补断言（合规包成功 / 跨插件包被拒）+ pack→install --vendored→smoke 真跑闭环 | `code/dshctl/self-test.ts` §16 模式 |
| A4 | 漂移清理：responses.ts:8 过期注释、gap-design.md:104 口径、render.ts 死键 `patchReload:'live'`（先确认无消费方） | 对应三文件 |

## 阶段 B（P1a）：dsh-observability 插件

| # | 任务 | 落点 |
|---|---|---|
| B1 | 插件骨架（index.ts + dsh.plugin.yml + self-test.ts，模板 = ops-skill-manager） | `code/dsh-observability/` |
| B2 | usage 流：ops-api afterTurn → `ctx.get('observability')` 可选上报 | `code/ops-api/index.ts` |
| B3 | 护栏审计流：dsh-plugin decision 分支加 `ctx.emit('bkn/risk-hit', …)`（含 advisory）；观测插件订阅落盘（blockable/advisory 分档 JSONL） | `code/dsh-plugin/index.ts` + 新插件 |
| B4 | `GET /v1/metrics`（JSON 聚合；观测插件缺席 → 404 + 提示语） | `code/ops-api/index.ts` |
| B5 | 轮转复制实现（512KB×3，不 import dsh-plugin）；采集失败静默 + warn（H-15 推广） | 新插件 |

## 阶段 C（P1b）：bkn-feedback 插件

| # | 任务 | 落点 |
|---|---|---|
| C1 | `capture_correction` 工具：gap_log 追加 `{…, correction, user_supplied: <text>, resolved: false}`（只增不破） | `code/bkn-feedback/` |
| C2 | curator 式周期报告：扫描 gap_log → 置信度分布/高频 gap/积压 → `reportDir/gap-report-<date>.md`；文件缺失 → "无数据"不报错 | 新插件 |
| C3 | gapLogPath 同名同 resolve 链（config → env `I2STREAM_GAP_LOG` → default），指向同一文件防漂移；不 import dsh-plugin | 新插件 |

## 阶段 D（P1c）：ops-api 增强

| # | 任务 | 落点 |
|---|---|---|
| D1 | `POST /api/sessions/{id}/cancel`：走 sc.cancel（harness sessionController:514 已有命令）；幂等语义 | `code/ops-api/index.ts` |
| D2 | /admin：MCP 单项启停按钮（PUT API 已有）+ MCP 连通性三态探测 + 观测卡片（缺席显示"未挂载"） | `code/ops-api/admin-html.ts` |

## 阶段 E：收尾

| # | 任务 |
|---|---|
| E1 | registry.yml 登记两新插件；domain.yml plugins[] 加 config；`dshctl check ops --ci` 过 |
| E2 | ci.sh 追加两行 self-test |
| E3 | 全量 self-test + 回填下方验收表 + roadmap 状态行更新 |

---

## 验收回填（AGENTS §2：只认 live 实测）

| 例 | 用例 | 结果 |
|---|---|---|
| A-1 | fixture 跨插件包 pack 被拒（退出码 1 + 明确报错） | ✅ self-test [17]「pack：跨插件相对 import → 拒绝（ok=false + S1 语义点名）」+「拒绝时不产出 tgz」全绿 |
| A-2 | 合规包 pack 成功且产物含 lib/ | ✅ self-test [17]「pack：自包含合规包 → 成功产出 tgz」全绿（真 tsc + pnpm pack 端到端） |
| A-3 | pack→install --vendored→smoke 真跑通过 | ⚠️ 部分完成：findCrossPluginImports/installIntoDomain/R12 vendored 断言全绿（self-test §16/[17]）；**全链 smoke 真跑未执行**——需现网 DSH spawn，受模型网关 503 阻塞，与 bench-4q 一并顺延（登记为遗留，见下） |
| B-1 | /v1/metrics 返回 JSON 聚合（usage/护栏分档计数） | ✅ 契约级：dsh-observability self-test 12 项全绿（usage 聚合/riskHits 分档计数/recentRisk/坏行容错）；ops-api 路由已挂（缺席 404 + 提示语）。live curl 待实例重启后补测 |
| B-2 | 观测插件缺席时 /v1/metrics 404 + 提示语 | ✅ 代码路径在位（ctx.get 兜底 → 404 not_found + 挂载提示）；同上待 live 补测 |
| B-3 | dsh-plugin 存量断言不破（emit 不改返回形状） | ✅ dsh-plugin self-test ALL PASSED（新增 emitAdvisoryHit 纯 try/catch，不影响 deny 返回） |
| C-1 | capture_correction 写入 gap_log 且 user_supplied 非空 | ✅ bkn-feedback self-test [1]「user_supplied 非空（不再硬编码 null）」+「schema 只增不破」全绿 |
| C-2 | 周期报告生成；gap_log 缺失场景"无数据"不报错 | ✅ self-test [4]「报告落盘（首轮即生成）」+ [2]「文件缺失 → 全零不抛（H-15）」全绿 |
| D-1 | POST cancel 对在途会话生效、对已结束会话幂等 ok | ✅ 契约级：POST /api/sessions/{id}/cancel 已挂（走 sc.cancel，幂等吞错）；live 待实例重启补测 |
| D-2 | /admin 启停按钮与观测卡片渲染正常 | ✅ self-test 15.6（disabled 序列化/回读/缺省活跃）+ 16.1/16.3（页面脚本可解析 + toggleMcp/probeMcp/观测卡片区块在位）全绿 |
| E-1 | `bash code/dshctl/ci.sh` 全绿（7→9 环节） | ✅ 2026-11-03 实测：== ci: ALL GREEN ==（9 环节含两新插件 self-test） |
| E-2 | `dshctl check ops --ci` 通过 | ✅ 2026-11-03 实测 exit=0：6 插件 R12 全 pass（含两新插件，零跨插件 import error） |

## 遗留与顺延

| 项 | 原因 | 去向 |
|---|---|---|
| A-3 全链 smoke 真跑 / B-1/B-2/D-1 live curl / bench-4q | 需实例重启 + 外部模型网关 503（orchestration-plan §8 挂账） | 实例重启窗口按本表逐项补测回填 |
| 意图覆盖补全 + observe→inject 校准 + 标注集扩容（roadmap P2） | 不在本期范围 | roadmap §5 P2 |
| SQL 第二域 | 不在本期范围 | roadmap §5 P2 |

## 踩坑沉淀

| 症状 | 根因 | 修复 |
|---|---|---|
| self-test 断言标签打印成 `✓ true` | ok(cond, tag) 与 ok(tag, cond) 参数序不一致（新文件笔误，且早期版本 `✗ ${tag}` 把条件误当标签打印） | 统一为 ops-skill-manager 同款 `ok(cond, tag, detail?)` + `✗ FAIL:` 前缀；脚本化参数序交换时误伤模板字符串，最终整文件重写确认 |
| ops-api self-test `Expected "}" but found ")"` | /v1/metrics handler 三元展开 `...(x as object))` 多一层括号 | 修正括号配对；esbuild 报错行号直达（index.ts:425） |
| bkn-feedback self-test apply() 静默失败 | ctx stub 的 logger 形状错：cordis `ctx.logger(name)` 返回 logger 对象（info/warn 方法），不是返回函数 | stub 改为 `logger: () => ({ info/warn/debug })`——新插件 stub 一律先对齐 ops-skill-manager 的真实调用形状 |

> 端到端 bench-4q / 观察期检查单受外部模型网关 503 阻塞（orchestration-plan §8 挂账），按 roadmap §5 声明顺延，不在本表口径内。

---

## 加固批次（2026-11-05）：P0+P1 实施后复核修复

复核（三档：小修/健壮性/性能）裁定全做。验收回填：

| 例 | 用例 | 结果 |
|---|---|---|
| F-1 | 观测轮转分片（`.jsonl.1/.2`）计入聚合与 recentRisk（修复数据失真 bug） | ✅ dsh-observability self-test [5] 三断言：分片聚合 7 条分档正确 / usage 分片计入 / recentRisk 同日"主文件新→分片旧"序正确 |
| F-2 | recentRisk 分片序 + 只取必要文件 | ✅ 同 [5] recentRisk 两断言 |
| F-3 | aggregate 行缓存（mtime+size 指纹失效） | ✅ self-test [6]：二次聚合一致 + 文件变更后缓存失效重读 |
| F-4 | retentionDays 留存上限（默认 30d，惰性清理含分片） | ✅ self-test [7]：超期文件（含分片）清理 / 未超期保留 / 聚合只含留存数据 |
| F-5 | 护栏识别单源化：riskGuard.identifyHit 提取，guardDecision 与 emitAdvisoryHit 共用 | ✅ dsh-plugin self-test 4 断言（命令文本/显式参数/与 guardDecision 一致/无害 null）+ 存量断言不破 ALL PASSED |
| F-6 | bkn-feedback gapLogPath 相对路径 resolve（$DSH_HOME → cwd，对齐 dsh-plugin 同链） | ✅ 代码在位；绝对路径行为不变（存量断言全绿） |
| F-7 | 报告原子写（tmp+rename）+ backlog 口径拆分 | ✅ self-test：correctedBacklog=1 与 backlog=1 分离断言；报告落盘断言走新原子写路径 |
| F-8 | ops-api cancel 吞错 log.warn + 成功 log.info | ✅ 代码在位；self-test 存量断言不破 |
| F-9 | admin probe 并发防护（btn.disabled）+ api() 结构化 status + renderObs 404 判定结构化 | ✅ self-test 16.1 页面脚本可解析 + 16.3 区块在位全绿 |
| F-10 | 文档收尾：exec-plan 重复"踩坑沉淀"标题删除；boundary-direction §8 开放项①回写"已拍板并实施" | ✅ 完成 |

### 本批踩坑沉淀

| 症状 | 根因 | 修复 |
|---|---|---|
| 观测聚合漏读轮转分片 | readDays 只匹配 `.jsonl` 结尾，`.jsonl.N` 分片被过滤——单日超 512KB 后 /v1/metrics 静默失真 | listBaseFiles 正则覆盖分片，序为"同日主文件最新优先"（shard 降序） |
| recentRisk 首修后断言仍失败 | 误判 rotate 语义：shard 升序把分片排主文件前=最新在左，与"从最右倒序取最新"矛盾 | 分片序改降序（b.shard - a.shard），主文件回到最右；断言期望同步修正（advisory 而非 shadow） |
| index.ts:34 esbuild `Unexpected "-"` | JSDoc 注释里写 `usage-*/risk-*`，`*/` 提前闭合块注释 | 注释改写避免 `*/` 字面量 |
| correctedBacklog 断言失败 | fixture 第 4 条本身是 correction+resolved=false，期望值写 0 实为 1 | 修正期望值——恰验证了拆分口径生效 |
