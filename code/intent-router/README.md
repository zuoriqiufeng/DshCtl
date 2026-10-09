# intent-router — 分层意图识别插件

> 位置：`code/intent-router/`（外部插件，layout=in-place；不在 harness 仓内）
> 挂载：`domains/ops/domain.yml` 的 `plugins[]` → `dshctl apply ops --yes` 生成 profile patch
> 自测：`cd /hdd/demo/public/dsh-info/deepseek-harness && node --import tsx/esm /hdd/demo/public/dsh-info/code/intent-router/self-test.ts`

## 1. 它解决什么

原来"这句话是什么意图"这件事**一律交给大模型**（主模型读着热路径提示边推边选工具）：慢，而且费 token
——每次都在为"点哪个工具"做一遍推理，选错还要多轮试错。

本插件把意图识别改成**三层级联**，只在必要时才回到大模型：

| 层 | 手段 | 实测耗时 | 说明 |
|---|---|---|---|
| 1 | 正则/精确 | <0.1ms | 错误码形态、寒暄、显式点名的工具/Skill 名 |
| 2 | 别名归一 + BM25 原型打分 + 置信门 | ~1ms（p95） | 复用 `dsh-plugin/bm25.ts` 的中英混合分词与 BM25；别名表来自 `dsh-plugin/constants.ts` |
| 2c | 向量相似（**默认关闭**） | ~100ms | BGE sidecar；见 §5「向量路径为何默认关闭」 |
| 3 | 大模型 | — | **不新增任何调用**：层 1/2 不达门限时本插件完全不干预，交回主模型按既有方式处理 |

**v1 唯一的行为改动**：高置信时在 `agent/pre-step` 追加一条带免责声明的提示消息（`mode=inject`）。
主模型仍照常回答；省掉的是探索性工具调用与试错轮次。`mode=observe` 时只记录不改行为。

## 2. 文件树

```
intent-router/
├── index.ts                 插件入口：Config / apply / agent-pre-step 注入 / 观测接线
├── engine.ts                分层调度（层 1 → 层 2；向量只做补救）
├── layer1.ts                第 1 层：正则与精确规则
├── layer2.ts                第 2 层：别名索引 / BM25 / RRF / 置信门
├── extract.ts               用户消息抽取（只认 source.kind=user）与归一化
├── taxonomy.ts              意图体系数据模型：合并 / 校验 / 语料构造
├── embed.ts                 层 2c 向量提供者（BGE sidecar，失败即降级）
├── frontmatter.ts           SKILL.md frontmatter 容错解析（生成器复用）
├── inject.ts                注入文案渲染（含免责声明）
├── overrides.ts             **唯一允许手改的意图数据**：补原型/关键词、禁用条目
├── taxonomy.generated.json  生成物（禁手改；重跑 gen-intent-taxonomy.ts）
├── eval/questions.json      标注集（门限标定与回归依据）
├── self-test.ts             独立自测（77 项断言，含标定集分离度）
├── dsh.plugin.yml           插件自描述
└── doc/intent-router-design.md  实现设计（模块级取舍与实测记录）
```

生成器与评测脚本在 `code/scripts/`：`gen-intent-taxonomy.ts`（重生成意图体系）、`eval-intent.ts`（回归/门限扫描/向量对照）。

## 3. 外部依赖

| 依赖 | 用途 | 配置项 | 不可用时行为 |
|---|---|---|---|
| **意图体系生成物** | 全部匹配语料的来源 | `taxonomyPath` | 加载失败 → 插件整体不生效（warn，绝不抛） |
| `code/dsh-plugin/bm25.ts` | 分词 + BM25 + RRF（单点复用，不复制实现） | —（源码路径依赖） | 启动期 import 失败 → 插件不生效 |
| `code/dsh-plugin/constants.ts` | 口语别名表（症状/错误码） | —（同上） | 同上 |
| **BGE embedding sidecar** | 仅层 2c（默认关闭） | `embedUrl`（env `I2STREAM_EMBED_URL`） | 超时/拒绝 → 自动退化为 BM25-only，不影响识别 |

**注意**：本插件不依赖 Qdrant，也不依赖任何大模型接口——`useVector=false`（默认）时它是纯本地计算。

## 4. Config 全字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `observe` | `off` / `observe`（只记不改）/ `inject`（注入提示） |
| `taxonomyPath` | 插件目录下生成物 | 意图体系 JSON 路径 |
| `minBm25Score` | `16` | 层 2 BM25 绝对分下限 |
| `minBm25RelMargin` | `0.35` | top1 相对第二名的领先比例下限 |
| `minCos` | `0.62` | 层 2c 余弦门限 |
| `minCosMargin` | `0.06` | 层 2c 余弦间隔门限 |
| `vectorCorroborateTopK` | `2` | 向量冠军须同时落在 BM25 前 K 名内（跨方法互证） |
| `useVector` | `false` | 是否启用层 2c（见 §5） |
| `embedUrl` | `http://127.0.0.1:8096/embed` | sidecar 地址 |
| `embedTimeoutMs` | `800` | 单条查询超时（原型批量另有 30s 预算，在启动后台预热） |
| `logPath` | `$DSH_HOME/logs/intent-router.jsonl` | 观测日志 |
| `injectTemplate` | 内置模板 | 支持 `{label} {target} {slots} {advice} {tier} {evidence}` |
| `errorToolTarget` | `diagnose_error` | 错误码内建规则的落点工具 |

> 新增/修改 config 段时**两处都要改**：本插件 `Config` schema 默认值 + `domains/ops/domain.yml`（由 `dshctl apply` 渲染进 profile patch）。

## 5. 向量路径为何默认关闭（实测记录）

`useVector` 的默认值是**实测得出的**，不是保守起见：

- 标注集（24 条）上，**含向量的识别结果与纯 BM25 完全一致**（采纳 12/13、误采纳 0/11）——向量一次都没救回 BM25 判不出的样本。
- 9 条同义改写样本（"规则一直停着不动"/"同步速度慢得像蜗牛"…）：向量**救回 0/9**。
- 换成「每条原型单独向量 + 取最大相似度」后，短泛化输入的余弦反而更高：
  「看下日志」→ sql_generation **0.827**、「创建规则」→ get_prerequisites **0.784** —— 没有任何阈值能把它们和正确样本分开。
- 结论：这类**超短中文运维问法**上，句向量相似度没有可用的工作点；策划过的别名表 + BM25 明显更强。

保留代码而不删的理由：① 它是设计中的第 2 层 2c，配置打开即用；② 长描述性问法（未来场景）可能另当别论；
③ 关闭状态下插件零外部依赖、热路径完整不受影响。**重新评估前请先重跑上面的两组样本**（`eval-intent.ts --with-vector`）。

## 6. 挂载与生效

```yaml
# domains/ops/domain.yml → plugins[]
  - id: intent-router
    path: /hdd/demo/public/dsh-info/code/intent-router/index.ts
    config:
      mode: inject
      taxonomyPath: /hdd/demo/public/dsh-info/code/intent-router/taxonomy.generated.json
      useVector: false
```

```sh
dshctl check ops --ci && dshctl apply ops --yes   # 改配置后重新渲染 profile patch
bash /hdd/demo/public/dsh-info/.dsh-home/run-ops.sh restart   # 改插件源码必须重启（config-only 才 HMR）
```

改完后核对：`dshctl diff ops` 应为空；会话里应能看到 `source.kind="intent-router"` 的注入消息。

## 7. 观测与评测

```sh
# 观测日志（每步一行 JSON：识别结果 / 层级 / 排名 / 耗时 / 是否注入 / 本回合主模型实际调用了什么工具）
tail -f /hdd/demo/public/dsh-info/.dsh-home/logs/intent-router.jsonl

# 标注集回归（不达标退出码 1）；--sweep 扫门限；--with-vector 量化向量贡献
node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/eval-intent.ts
node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/eval-intent.ts --sweep
node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/eval-intent.ts --with-vector

# 意图体系重生成（BKN/别名表/Skill/热路径变了就重跑；--check 可用于 CI 守护漂移）
node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/gen-intent-taxonomy.ts
node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/gen-intent-taxonomy.ts --check
```

**从 observe 切 inject 的判据**：观测日志里 `accepted=true` 的样本抽样人工核对无误识别；
`eval-intent.ts` 保持「零误采纳 + 采纳率 ≥85%」。出现误识别 → 退回 `observe`，按 `overrides.ts` 补原型/关键词或收紧门限。
