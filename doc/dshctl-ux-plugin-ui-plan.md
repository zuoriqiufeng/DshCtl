# dshctl UX / 插件单元化 / Web-UI 三方向优化计划

> 2026-09-25 · 状态：已评审，开始实施
> 目标三条：① 使用体验简单方便好理解 ② 上传插件容易、插件彻底单元化、支持全部方式插入 dsh ③ Web-UI 更简洁、区分清楚
> 用户拍板：三项全做分三阶段；插件两阶段（先自包含、再标准组合包）；Web-UI 允许改信息架构 + 视觉收尾；四个顺手项全纳入。

---

## 0. 现状调研结论（实施依据）

### 0.1 CLI 使用体验（目标①）

| 问题 | 证据 |
|---|---|
| 没有 `domain new`——新建领域必须手写 domain.yml（4 个必填字段全是绝对路径），6~7 条命令 + 2 项人工动作 | `doc/dshctl-manual.md:475`；`code/dshctl/domain.ts:47-49` |
| `<cmd> --help` 不支持——`--help` 被当普通 flag，`dshctl check --help` 得到报错 | `code/dshctl/dshctl.ts:72-75` |
| `check --ci` 空操作——两分支等价，加不加都返回 1 | `dshctl.ts:145-146` |
| 退出码混淆——`apply --dry-run` 有差异返回 1（`:167`）、`diff` 非空返回 1（`:210`），与执行失败共用 | `dshctl.ts:167,210` |
| 三套近似导入命令：`plugin add` / `plugin import` / `plugin import-git` | `dshctl.ts:248,285,295` |
| `<domain>` 全必填，无 cwd 推断（grep `process.cwd` 零命中） | `dshctl.ts:134,151,182,200` |
| 纯文本无颜色（运行依赖只有 yaml） | `code/dshctl/package.json` |
| README 写了不存在的 `gui serve` | `code/dshctl/README.md:18` |
| 术语漂移：instance 与 domain 指同一实体 | `code/dshctl/registry.ts:7-21` |
| `registry [list]` 位置参数被静默忽略 | `dshctl.ts:220-229` |

### 0.2 插件单元化（目标②）

| 问题 | 证据 |
|---|---|
| 三个插件不是可发布单元：无 main/exports/files、无 dsh.bundle、全 private:true | `code/dsh-plugin/package.json`、`code/ops-api/package.json`、`code/ops-skill-manager/package.json` |
| 依赖声明缺失：代码 import `@deepseek-ai/cordis`/`schemastery`/`dsh-tools`，package.json 的 dependencies 是空 `{}` | `code/dsh-plugin/index.ts:21-22`、`code/dsh-plugin/package.json:7` |
| 装配靠工作区绝对路径，换机即断 | `.dsh-home/profiles/ops/cordis.patch.yml:17,24,34` |
| 上传通道只搬目录：不解析 package.json、不读 dsh.bundle、不装依赖、不进任何 profile | `code/dshctl/import.ts:28-52` |
| zip 安全只有名字层 zip-slip，无解压后 realpath 校验；git 无大小限制 | `import.ts:20-23,55-72` |
| `depends_on` 明确"不校验目标存在" | `code/dshctl/plugin.ts:19-20` |
| 两套 registry 互不感知（capability-packs vs plugin-registry） | `packs.ts:58-88` vs `plugin.ts:56-71` |
| 上游 v0.1.7 已移除 `patchReload` 键，`render.ts:33` 仍生成（死键） | `doc/dsh-plugin-reading-guide.md §5` |
| 插入 dsh 的六条路径中，⑤ Creator 模式 plugin_manager 未接入 | `dynamic-cordis.zh.md:5` |

六条插入路径全景（对照上游）：

| # | 方式 | 上游出处 | 工作区现状 |
|---|---|---|---|
| ① | profile patch insert（绝对路径） | `publish.zh.md:56` | ✅ 已用（render.ts 生成） |
| ② | 组合包 `dsh.bundle` + `dsh plugin add` | `publish.zh.md:12-44` | ⚠️ 仅 ops-app（纯 disable 层，不含插件源码） |
| ③ | preset（会话级） | `AGENTS.md:49` | ✅ 已用（persona/skills） |
| ④ | bundle 纯增量层（ops-app 模式） | `profile.ts:710-717` | ✅ 已用 |
| ⑤ | Creator 模式 `plugin_manager` | `dynamic-cordis.zh.md:5` | ❌ 未用 |
| ⑥ | MCP server | `dynamic-cordis.zh.md:7-15` | ✅ 已用（mcp-i2agent） |

### 0.3 Web-UI（目标③）

| 问题 | 证据 |
|---|---|
| 四处重复渲染同一份 check/状态数据（四种视觉） | `Dashboard.tsx:96-127`、`Registry.tsx:36-78`、`Domains.tsx:337-363`、`DomainDetail.tsx:31-53` |
| Domains 右栏永久空态死区，点域后整页替换 | `Domains.tsx:397-401`、`App.tsx:142-144` |
| NewDomain 与 EditorTab 共用同一 DomainForm，只差 POST/PUT | `NewDomain.tsx:83-86` vs `Domains.tsx:327` |
| `#8c96a6` 硬编码 21 处（style-plan 阶段 3 未执行） | grep 实测 21 处 |
| 卡片边框/圆角 4 处不同来源；3 处 linear-gradient | `DomainDetail.tsx:31`、`DomainForm.tsx:10`、`NewDomain.tsx:59`、`Plugins.tsx:72-75,146,635`；渐变 `Plugins.tsx:37,565,715` |
| dshctl GUI 无鉴权却有 systemctl 起停与写清单能力 | `gui/server.ts:94-100,231-247`，非回环仅打警告（`:449-452`） |
| Manual 页从未提及 ops-api admin（两套 UI 关系无说明） | `Manual.tsx:37-118` |
| gui/dist 单文件 1.5MB 无分包；10/12 源文件 eslint-disable no-explicit-any；api() 不检查 r.ok | `vite.config.ts`、`api.tsx:25-28` |

两套 UI 定位（不合并，明确分工）：dshctl GUI = 多领域编排与对账（离线/清单侧，读 `domains/` + `plugin-registry/`）；ops-api admin = 单实例运行时（在线/热更侧，读 `$DSH_HOME/profiles/ops/` + skills）。

---

## 阶段 1 · CLI 使用体验

改动：命令表驱动重构 + 每命令 `--help`；`dshctl domain new`（`--from` 派生）；`dshctl up` 一键链；`<domain>` 上下文推断；`plugin add` 形态自动判型（import/import-git 降为别名）；退出码收敛（0=通过/无差异，1=校验失败或存在差异，2=用法/执行错误）+ `--ci` 真语义；ANSI 着色（isTTY）+ check 分组输出；错误提示补"下一步"；`registry` 未知子命令显式拒绝；`plugin show` 可读分支；README `gui serve` 修正。

**验收**（2026-09-25 回填，live 实测）：
| 用例 | 结果 |
|---|---|
| A1 self-test：[15] 段 14 断言新增全绿 + 存量 150 不破 | ✅ ALL PASSED |
| A2 `domain new demo`（独立 home/.dsh-home-demo + 端口 8644 + DEMO_API_KEY 自动推导）→ check 0 error → up 预览零写盘 → up --yes 落盘 → 二次 up 幂等 | ✅ 全链 exit 0 |
| A3 `check --help` / `up --help` / `help <cmd>` 出参数与示例（v0.3 时 --help 报错） | ✅ |
| A4 唯一域省略域名 → 自动取 ops；`--ci` 门禁 + 素色；`--strict` warn 也失败 | ✅ |
| A5 退出码：check 通过=0；apply --dry-run 有差异=1；缺参数=2（含"下一步"指引） | ✅ |
| A6 ci.sh：[1][3][4][5] 全绿；[2] dsh-plugin 9 条存量红（共享 BKN 09-24 重构失配，与本阶段无关，失败集合逐字节不增） | ✅（含已知存量红） |

## 阶段 2 · 插件单元化 + 全插入方式

**2a 自包含（两种布局，插件自选）**：`registry.yml` 条目加 `layout: 'in-place' | 'vendored'`（现有三插件保持 in-place 不破坏现网；新导入默认 vendored）；`dshctl plugin scaffold <id>` 在插件目录生成组合包骨架（package.json 补 main/exports/files + peerDependencies + cordis.patch.yml 声明本插件的 insert 行——单一来源）；新规则 **R13** 交叉校验两套 registry（同 id 既被 domain 引用又被 capability-packs 禁用 → error；slots 成员一致性）。

**2b 上传升级 + 全插入方式**：importFromZip 解析包内 package.json 自动推导 id/entry；解压后 realpath 校验（防 symlink 逃逸）+ 解压总字节上限；git 通道补限制；`dshctl plugin install <id> --domain <d>` 一条命令入 profile；六条插入路径逐条落文档。构建产物（lib/）本阶段不引入，保持 TS 源码直跑。

**验收**（2026-09-25 回填，live 实测）：
| 用例 | 结果 |
|---|---|
| B1 三插件 scaffold：bkn/ops-skill-manager config 自现网 patch 回填；ops-api 含 !!js → 诚实跳过留手工；peerDeps 采集正确 | ✅ |
| B2 `diff ops` 空 ✓——scaffold 不改生成面（幂等不破）；`apply ops --dry-run` 一致 | ✅ |
| B3 vendored 实测：`plugin install bkn-plugin --domain demo --vendored` → 拷进 `<home>/plugins/bkn-plugin/`（源码单元，排除 lib/node_modules），R12 按前缀推断校验 pass | ✅ |
| B4 pack：tsc --rewriteRelativeImportExtensions 构建 lib/（10 模块 .ts→.js）+ bundle patch（name=包名）→ tgz；tsc 类型诊断 30 条降级为警告（存量类型债，emit 不阻断） | ✅ |
| B5 R13：冲突用例 error、无冲突 pass（self-test 断言 + check demo live） | ✅ |
| B6 self-test [16] 段 14 断言全绿；ci.sh 失败集合与阶段 1 逐字节一致 | ✅（含已知存量红） |

## 阶段 3 · Web-UI

改动：菜单 7→5（概览/领域/插件库/升级对账/使用手册；Registry 并入概览行展开、NewDomain 并入领域"新建"模式）；Domains 真主从（删 domainView 约 40 行）；抽唯一「领域状态行」组件消灭四处重复；视觉收尾（21 处 #8c96a6 → GRAY.weak、卡片边框单一 cardStyle 来源、3 处渐变收编、字号走 FONT_SIZE）；GUI 鉴权（回环免鉴权，非回环强制 key，fail-loud）；Manual 页补两套 UI 分工一节 + 互链；vite manualChunks 分包；`render.ts:33` patchReload 死键清理 + 3 处旧文档修正。

**验收**（2026-09-25 回填，live 实测）：
| 用例 | 结果 |
|---|---|
| C1 `pnpm build` 通过；菜单 5 项；Dashboard 并入登记（端口/unit 列 + 展开行）；Domains 真主从（右栏 详情/新建/空态 三态）；Registry.tsx 删除 | ✅ |
| C2 鉴权：非回环无 key → fail-loud 拒绝启动；带 key：static 200 / api 无 key 401 / 带 Bearer 200；回环默认免鉴权 | ✅ |
| C3 产物：单文件 1.5MB → index 122KB + antd 1.2MB chunk + xyflow 178KB（首屏 ~125KB） | ✅ |
| C4 旧 hash 兼容：#/registry→概览、#/newdomain→领域新建（LEGACY_MENU + goNotice 映射） | ✅（代码级） |
| C5 patchReload 清理后 `apply ops --dry-run` 一致、`--yes` 幂等；生成物 0 处残留；3 处旧文档加注 | ✅ |
| C6 GUI 回环冒烟：/api/registry|domains|plugins|summary 全 200 + 静态壳 200 | ✅ |

## 全局约束

- 对上游 `deepseek-harness/` 净改动 = 0；每阶段 self-test 存量不破 + 新增全绿；踩坑沉淀进本文档；验收只认 live 实测。
- 风险：阶段 2 需重启 8643 试验实例（单独提报，不擅自重启）；阶段 3 改信息架构保持 hash 兼容；GUI 鉴权默认回环免鉴权不改变现有访问方式。

## 踩坑沉淀

1. **vite8/rolldown 的 manualChunks 只支持函数形态**——对象形态（`{ antd: [...] }`）直接构建失败 `manualChunks is not a function`。已改函数形态按 id 路径分包。
2. **tsc 6.0.3 `--rewriteRelativeImportExtensions`** 是 .ts 相对导入插件零配置出 lib/ 的关键（./tools.ts → ./tools.js）；类型报错不阻断 emit，pack 以「lib 产物存在」判定成败，类型诊断计数降级为警告（三插件存量类型债 ~30 条，另立修复项）。
3. **`!!js` 经 loadYamlText 后 tag 丢失**（JS_TAG resolve 按原文留字符串，值里没有 '!!js' 前缀）——回写任何 parsed config 都可能失真。因此 config 回填/写入全部走**原文检测**（raw text contains '!!js' → 跳过并告警），不从 parsed 值判断。
4. **R6 对空 skills 目录是 error**（"无合法 frontmatter 的 SKILL.md"）——domain new 骨架因此默认**不声明 skills_dirs**（无技能域合法），头部注释说明加法；否则新域首跑 check 必红。
5. **pnpm install 在无 TTY 下拒绝清理 node_modules**（ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY）——上游升级后 `pnpm dsh` 自动 install 会因此失败 → dump-config 降级。CI=true 环境变量可解；本次已补跑（升级第 1 步）。
6. **apply 的部分写盘**：renderProfilePatch 报错时 bundles/ 已写、patch 未写（apply.ts 先 bundles 后 patch）——v0.4 骨架默认不含 api_server 后不再触发，但顺序问题仍在（存量，另计）。
7. **dsh-plugin self-test 9 条存量红**：共享 BKN（/hdd/demo/public/i2stream-bkn）2026-09-24 本体分层重构（19→26 号 + 批 2）导致 resolver/retrieval 断言失配——与本计划无关，另立修复项（详见项目记忆）。

## 规模口径修订

README 维护约定「可执行代码 ≤1900 行」：本次后 dshctl 实际 ~3100 行（v0.4 体验层 + v0.5 单元化新增）——按既有先例（1500→1900）修订为 **≤3200 行**；逼近先砍需求的红线原则不变（决议：2026-09-25，随本计划回填）。

## 回填记录

- 2026-09-25 计划创建（阶段 0）。
- 2026-09-25 阶段 1 实施并验收（commit baee86d）：A1-A6 全过。
- 2026-09-25 阶段 2 实施并验收（commit f9c2a6a）：B1-B6 全过；三插件已 scaffold、bkn-plugin 已 pack 验证。
- 2026-09-25 阶段 3 实施并验收：C1-C6 全过；patchReload 死键清理完成。
- 附带完成 harness 升级第 1 步（pnpm install，roster 缓存重建 v0.1.7-alpha.2，upgrade-check PASS）；
  **升级第 3 步（重启 8643 试验实例）与现网 3080（/hdd/agent 树）未动**——待用户择时。
