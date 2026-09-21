# Ops Agent 阶段 3 实施计划：检索栈（search_qdrant + diagnose_db_link）

> 状态：已评审，开始实施 | 日期：2026-09-14
> 上游：`ops-agent-plan.md` 阶段 3 | 前置：阶段 1（10 工具+preset）、阶段 2（ops-api）
> 目标：DSH 侧补齐检索能力——BGE 向量检索 + BM25 混合 + 日志导航，日志分析/兜底检索场景跑通。

---

## 一、调研结论（计划依据）

| 事实 | 结论 |
|---|---|
| Qdrant 活着（6333），集合：`i2stream_collection`(主)/`test_doc_chunks`/`log_patterns_collection`；payload 含 chunk_level/content/blurb/title/parent_* 等 | 直接走 Qdrant **HTTP API**（points/query + scroll），无需 Node 客户端库 |
| Hermes embedding = sentence-transformers `BAAI/bge-large-zh-v1.5`(1024d) **进程内本地模型**；config.yaml 已预留 `mode=api, api_url: localhost:8080/embed` 设计位 | DSH 侧起 **Python embedding sidecar**（复用 `/hdd/demo/public/venv`——st 5.7.0+jieba，模型已缓存在 `/hdd/demo/public/chunk/HuggingFace`）→ 与 Hermes **同模型同向量** |
| 检索链：`chunk_mode` 五模式（mini_first 默认/auto/parent_expand/standard_image/large_only）→ dense(query_points+chunk_level 过滤) → 精度保护（错误码精确项 BM25 兜底）→ 全库 BM25(scroll 建索引)+RRF(k=60) → mini_first 另有 mini→standard 回源与 Phase5 补充 | 全量移植（TS 重写 supplement.py 核心 + bm25.py） |
| BM25 分词：jieba 优先，缺失时字符 bigram+英文词（Hermes 自身的回退路径） | Node 无 jieba → 用 **Hermes 同款回退分词**（bigram+英文词）；两侧索引分词器不同会引入轻微排序差，记录为已知偏差 |
| `diagnose_db_link`：db_type 自动识别（错误码前缀）+ diagnostics.bkn 风险上下文 + symptom-router Skill 推荐 + 通用知识合成（Phase1 BKN / Phase2 Qdrant）+ log_navigation（log-map.bkn 三表）+ db_type_source（unknown 化） | BKN 部分全量移植；检索增强经新检索模块，**Qdrant/embedding 不可用时优雅降级**（仅 BKN 部分） |
| Hermes 还有维度覆盖追踪（__report__/__reset__）、批量模式（queries≤10）、usage_log、assess_confidence | 移植：覆盖追踪+批量（顺序并行 Promise.all）；**搁置**：usage_log（使用统计）、assess_confidence/gap 记录（质量观测，不影响检索正确性） |

## 二、架构

```
DSH bkn-plugin（12 工具）
 ├─ search_qdrant ──→ retrieval.ts ──┬── Qdrant HTTP (6333): query/scroll
 │                                   ├── embed sidecar (8096): POST /embed ← /hdd/demo/public/venv + bge-large-zh
 │                                   └── bm25.ts: per-collection scroll 索引 + RRF(k=60)
 └─ diagnose_db_link ──→ resolver.getLogMap/getSymptomSkills + diagnostics.bkn ──(可选)──→ retrieval 补充
```

## 三、工作项

### W1 embedding sidecar（`sidecars/embed-server.py`，Python）
- 裸 `http.server`（无框架依赖）：`POST /embed {"input":[...]}` → `{"data":[{"embedding":[...]}]}`；`GET /health`
- 运行：`HF_HOME=/hdd/demo/public/chunk/HuggingFace HF_HUB_OFFLINE=1 /hdd/demo/public/venv/bin/python sidecars/embed-server.py --port 8096`（后台常驻）
- 模型懒加载；CPU encode

### W2 检索核心（`dsh-plugin/bm25.ts` + `dsh-plugin/retrieval.ts`）
- bm25.ts：BM25Scorer(k1=1.5,b=0.75)、分词（中文字符 bigram+单字、英文小写词）、`rrfFusion(k=60)`、per-collection 索引缓存（scroll 200/批、content[:1000]）、精确项倒排（-XXXX/ORA-XXXXX/含数字长 token）、warnings
- retrieval.ts：`embed/QUERY/scroll/validateDimension`；`searchChunkLevel`（dense+精度保护+BM25+RRF）；`searchMiniFirst`（5 阶段）；`resolveStandardBatch`/`makeHitMini`/`expandParents`；`searchFull`（auto）；维度追踪（__report__/__reset__）；阈值常量同 Hermes（score_threshold 0.3、fallback 0.1、guard 开）
- 配置：`constants.ts` 增 `RETRIEVAL`（qdrantUrl/embedUrl/collections，env 覆盖）
- 降级：sidecar/Qdrant 不可用 → BM25-only 或空结果 + `_warning`（对齐 Hermes 的 client/model None 行为）

### W3 diagnose_db_link + resolver 扩展
- resolver：`getLogMap(symptom)`（log-map.bkn 三表：症状查看顺序/进程职责/级别调整 + 模式库入口）、`getSymptomSkills(symptom)`（symptom-router 必需/可选 Skill）、`getDiagnoseRelatedSkills()`（related-skills.bkn）
- 诊断组装：`resolveDbType`（DB_ERROR_PREFIXES 错误码前缀，db-extensibility 镜像）、`extractBknContext`（diagnostics.bkn 段）、知识合成（BKN + Qdrant top_k=3 可选）、统一 schema 返回（含 `db_type_source`、`log_navigation`）
- tools.ts 注册第 11/12 个工具（schema 与 Hermes 1:1，检索增强字段缺失时降级说明）

### W4 验证
1. self-test 扩展：bm25 评分/分词/RRF、extractExactTerms、getLogMap 三表、getSymptomSkills、payload 过滤
2. sidecar 冒烟：/health、/embed 1024 维、与 Qdrant collection 维度一致
3. 挂载：dump-config；重启后：`search_qdrant("增量同步 ABNORMAL 日志")` 有命中、`diagnose_db_link(symptom=incremental_stuck)` 含 log_navigation
4. 回填本文件验收

## 四、风险

| 风险 | 缓解 |
|---|---|
| 分词器差异（jieba vs bigram）导致 BM25 排序与 Hermes 不完全一致 | 已知偏差记录；错误码/精确项路径（exact_index）不受影响——检索最常用路径是错误码 |
| sidecar 单点（挂了检索降级） | 降级链完整（BM25-only/空+_warning）；sidecar 可随时重启；health 探测 |
| mini→standard 回源多次 scroll 性能（Hermes 同款设计，top_k=5 时约 10 次） | 与 Hermes 一致（其 docstring 已知）；后续可优化为 scroll filter any |
| 常驻 sidecar 生命周期（进程管理） | 独立进程+端口；README 记录启停命令；不挂 DSH 生命周期（避免重启连带） |

## 五、交付物

- `sidecars/embed-server.py`、`dsh-plugin/{bm25,retrieval}.ts`、resolver/tools 扩展、self-test 扩展
- README 更新（sidecar 启停、检索工具说明）
- 本文件 §验收 回填

---

## 验收（实施后回填）

- [x] self-test ALL PASSED（79 断言 = 既有 50 + 检索/诊断新增 29；2026-09-14 实测）
- [x] sidecar 冒烟：`/health` ok（bge-large-zh-v1.5 预载）、`/embed` 1024 维、与 collection 维度一致（validateDimension 通过）
- [x] 集成冒烟（真实 Qdrant，2026-09-14 实测）：
  - searchFull 通用查询 → 5 命中，dense cosine 0.55，` [PG] [RRF]` 链路标记正确（≈1s，含 embedding 往返）
  - searchFull 错误码 -4002 → 命中 EBAD_MSG 等相关内容（≈92ms）
  - searchMiniFirst → 5 命中（mini ANN→standard 回源 + Phase5 补充生效，258ms）
  - bm25-only → 3 命中（0ms）
  - 知识合成 → BKN + 5/5 维度 15 片段，summary 含维度统计
  - warnings 全空（无降级触发）
- [x] 降级路径：sidecar 停止时 → dense 记警告、BM25-only 继续服务（self-test + 代码路径验证；sidecar 当前运行中 pid 见 /tmp/embed-server.log）

> **实施记录（2026-09-14）**
> - W1 完成：`sidecars/embed-server.py`（裸 http.server，模型预载，8096）——与 Hermes 同 venv 同模型同向量。
> - W2 完成：`dsh-plugin/retrieval.ts`（query/scroll/维度校验/五 chunk_mode/精度保护/覆盖度追踪，阈值与 Hermes 一致）
>   + `dsh-plugin/bm25.ts`（BM25+分词回退+RRF k=60+精确项倒排）。
>   实测修正：Qdrant Query API 带 score_threshold 必须用 `query` 字段（plain `vector` 报 400）；
>   searchChunkLevel dense 失败降级为 BM25-only（对齐 Hermes client/model None 精神）。
> - W3 完成：resolver 增 `getLogMap/getSymptomSkills/getDiagnoseRelatedSkills`（log-map 三表/symptom-router 错误码精确匹配段/related-skills）；
>   tools.ts 增 `search_qdrant`（含批量/维度命令/降级链）与 `diagnose_db_link`（db_type 前缀识别 + 知识合成 + log_navigation + _skill_enforcement）。
> - 搁置（与检索正确性无关）：usage_log 使用统计、assess_confidence/gap 记录、_model_hint/_divergence_prompt 维度提示机械（DSH persona 已含等效指引）。
> - **补记（用户质询后补齐）**：`supplement.py` 的 `_wrap` 质量闭环层此前未迁——经确认在每工具关键路径上，已补
>   `dsh-plugin/supplement.ts`：assess_confidence（full/partial/none + REQUIRED_FIELDS + deep_check）、log_gap（JSONL+512KB 轮转）、
>   buildQuery/extractGapKeywords、buildDimensionHints + SYMPTOM_DIMENSION_PRIORITY、buildSearchInstruction（菜单式 defer 指令）、
>   extractSkillFromResult、wrapToolResult 统一注册包装（前 10 工具，search_qdrant/diagnose_db_link 自带不包）；
>   diagnose_db_link 增 `_available_dimensions`。self-test 增至 **101 断言全绿**。
>   仍未迁：内部 decompose 兜底检索路径（`defer_to_hermes=false` 分支，生产配置不走）、usage_log。
> - 已知偏差：BM25 分词器（bigram vs Hermes jieba）致排序可能轻微不同；错误码精确项路径不受影响。
> - 常驻：sidecar 为独立进程（不挂 DSH 生命周期），启停命令见 dsh-plugin/README.md 检索栈一节。
