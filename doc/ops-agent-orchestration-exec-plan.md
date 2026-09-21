# i2Stream Ops 编排执行计划（E0-E4）

> 2026-09-15 · 依据 `ops-agent-orchestration-plan.md`（方案）
> 执行模式：逐阶段实施 → 阶段验收通过 → 回填本文档 → 下一阶段
> 改动落点：工作区 `/hdd/demo/public/dsh-info/deepseek-harness`（新增 bundle 包）+ 新 DSH_HOME `/hdd/demo/public/dsh-info/.dsh-home`（profile 配置）+ `/hdd/demo/public/dsh-info/code/ops-api`（E2/E3 插件代码）

---

## 运行形态速查（执行期间反复用到）

```sh
# 工作区 harness = 实例根；DSH_HOME 独立，与现网 /root/.dsh 完全隔离
export DSH_HOME=/hdd/demo/public/dsh-info/.dsh-home
cd /hdd/demo/public/dsh-info/deepseek-harness

# 启动试验实例（GUI :3081，--no-open 无浏览器环境）
DSH_HOME=$DSH_HOME pnpm dsh --profile ops --port 3081 --no-open

# 启动前组合校验（不起服务，纯组合装配）
DSH_HOME=$DSH_HOME pnpm dsh --profile ops --dump-config

# 存量 self-test（不受实例影响，纯逻辑）
node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts
node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-api/self-test.ts

# bench（指到试验实例）
bash /hdd/demo/public/dsh-info/code/scripts/bench-4q.sh http://127.0.0.1:3081 i2stream-ops
```

**环境事实（已核实，执行时直接用）**：

| 事实 | 值 |
|------|-----|
| 启动脚本 | `pnpm dsh` = `node --import tsx/esm apps/cli/src/bin.ts`（workspace 根） |
| DSH_HOME | env `DSH_HOME`（home-paths/index.ts:87），profile 目录 = `$DSH_HOME/profiles/<name>` |
| 自定义 profile | manifest 手写 `dsh.profile.bundles` 任意列表即可，无需 PROFILE_TEMPLATES 源码修改 |
| bundle 解析 | 两锚点（installation 优先，profile 兜底）；ops-app 是 workspace 包，pnpm install 后即可解析 |
| profile node_modules | `$DSH_HOME/profiles/node_modules` 由启动时 healProfilesModuleFallback 自动维护，不用手工建 |
| 前端构建 | `pnpm build:web`（= --filter @deepseek-ai/dsh-web-frontend run build，vite → apps/web/dist）；web-runtime resolve `dist/index.html` |
| 端口参数 | web-startup 支持 `--port <port>` / `--no-open` / `--host` |
| 现网占用 | 3080（web GUI+ops-api）、8420（MemoryCore）、8090（i2agent MCP）、8096（embed sidecar）——试验实例全避开 |
| base 关键行 id | goal / goal-round-driver / command-goal / tool-goal / plan-mode / subagent / subagent-spawn-in-process / subagent-fork-in-process / tool-subagent-control / tool-subagent-list-agents / tool-subagent / tool-subagent-fork / workflow-ptc / tool-workflow / tool-ralph(默认已 disabled) / web / web-search-deepseek / web-fetch-http / tool-web |
| 现网配置样例 | /root/.dsh/settings.yaml（llm-pi-ai/agent-default-model 段）、/root/.dsh/profiles/web/cordis.patch.yml（bkn/ops-api/mcp insert 模板） |

---

## E0 试验环境（基线可启动）

### 目标
工作区 harness 能以独立 DSH_HOME 启动一个**未裁剪**的 web 实例在 :3081——先证明环境成立，再动编排。

### 步骤

**E0.1 依赖安装**
```sh
cd /hdd/demo/public/dsh-info/deepseek-harness
pnpm install --frozen-lockfile    # store v11 已有 1266 包，预期大部分硬链接
# 若 frozen 失败（lockfile 与 workspace 源码不一致）→ pnpm install（放弃 frozen）
# 若离线失败 → 记录具体包名，回退双轨方案（见风险表 R2）
```

**E0.2 前端构建**
```sh
pnpm build:web                     # 一次性；产物 apps/web/dist/index.html
# 验收：ls apps/web/dist/index.html 存在
```

**E0.3 DSH_HOME 与 profile 脚手架**
```sh
H=/hdd/demo/public/dsh-info/.dsh-home
mkdir -p $H/profiles/ops
# 1) 拷贝现网模型配置（llm-pi-ai / agent-default-model / ui-theme 段）
cp /root/.dsh/settings.yaml $H/settings.yaml
cp /root/.dsh/.credentials.yaml $H/.credentials.yaml
# 2) profile manifest（手写，bundles 先只挂两层基线）
cat > $H/profiles/ops/package.json <<'EOF'
{
  "name": "dsh-profile-ops",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "live" } }
}
EOF
# 3) 空 cordis.yml + 空 patch（initProfile 同款内容）
echo '[]' > $H/profiles/ops/cordis.yml
echo '[]' > $H/profiles/ops/cordis.patch.yml
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > $H/profiles/ops/pnpm-workspace.yaml
```

**E0.4 基线启动验证**
```sh
DSH_HOME=$H pnpm dsh --profile ops --port 3081 --no-open &
# 验收：
curl -s http://127.0.0.1:3081/health          # webserver 起（可能无 /health——那就看 GUI 静态页）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/   # 200（SPA）
# 浏览器打开 http://127.0.0.1:3081 → 登录/首会话（standard preset）→ 发一条消息 → 模型回复
```

### E0 验收
| 项 | 结果 |
|----|------|
| pnpm install 结果与耗时 | （回填） |
| build:web 结果 | （回填） |
| :3081 GUI 可开、对话可发 | （回填） |

---

## E1 编排落地（ops-app 增量层 + preset 升级）

### 目标
实例变为**纯运维面**：裁掉编码能力，BKN/skill/MCP/记忆可见可用，bench 无回归。

### 步骤

**E1.1 新建 ops-app bundle 包（唯一长期维护物）**
```
packages/bundle/ops-app/
├── package.json        name=@deepseek-ai/dsh-ops-app, dsh.bundle.patch=./cordis.patch.yml, dependencies 最小化（只声明 workspace peers）
├── cordis.patch.yml    纯增量：disable 清单 +（后续）insert 追加
└── README.md           裁剪清单、维护策略、§2.5 同步 checklist 摘要
```
- package.json 参照方案 §2.4：仅 `dsh.bundle.patch` 指向 patch 文件；无 src、无 main（bundle 层只供 patch，不需要可加载插件——**E1.1 第一件事验证这个假设**：loader 是否接受纯 patch bundle；不接受则补一个空 apply() 插件壳）
- patch 内容分两批写入（见 E1.2），每批之间重启验证
- `pnpm install`（增量，让 workspace 链接 ops-app）

**E1.2 disable 清单分两批落地（每批重启 + dump-config diff）**

批 1（UI roster，低风险）：按方案 §2.1 表格把 dsh.client 行 + 对应 host 行逐个 `- id: xxx / disabled: true` 写入 ops-app patch：
ui-sidebar-terminal / ui-sidebar-files / ui-sidebar-documentpreview / ui-workspace / ui-deliverables / file-upload / ui-subagent / ui-workflow-run / ui-goal / ui-plan / ui-schedule / ui-jobs / ui-message-feedback / ui-trajectory / open-in-app / ui-open-in-app / session-log-download / directory-picker / ui-reference / file-reference-local / terminal-controller / workspace-files / workspace-controller / message-feedback（host）

批 2（base 编码面，方案 §2.2 全部 id）：subagent-spawn-in-process / subagent-fork-in-process / subagent / tool-subagent-control / tool-subagent-list-agents / tool-subagent / tool-subagent-fork / workflow-ptc / tool-workflow / goal / goal-round-driver / command-goal / tool-goal / plan-mode / web / web-search-deepseek / web-fetch-http / tool-web / session-log-deepseek

```sh
# 每批后的校验：
DSH_HOME=$H pnpm dsh --profile ops --dump-config > /tmp/dump-batchN.txt
# 对比上一批：确认目标 id 从组合消失、无新报错（缺依赖/inject 失败）
DSH_HOME=$H pnpm dsh --profile ops --port 3081 --no-open &
# GUI 走查五项：开会话 / 发消息 / 切模型 / 看 Settings→Models / 看 Settings→Plugins
```

**E1.3 profile cordis.patch.yml 从现网移植**
把 /root/.dsh/profiles/web/cordis.patch.yml 的三段 insert（mcp-i2agent / bkn-plugin / ops-api）+ agent-presets roots 覆写抄进 $H/profiles/ops/cordis.patch.yml，差异仅两处：
- agent-presets config：`default: i2stream-ops`（现网是 standard）
- ops-api memory.autoStart：**false**（试验实例不与现网抢 Gateway 托管权；现网进程已带 supervisor）

**E1.4 ops preset 升级**
/hdd/demo/public/dsh-info/code/presets/i2stream-ops/agent.cordis.yml 追加：
```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs: [/hdd/demo/public/i2stream-bkn/skill]
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
```
（preset 是共享资产——现网 web profile 也读同一目录，此改动对现网同样生效且无害：现网本来就该挂 skill，completion-plan W3 的欠账一并补上。若想避免影响现网，先在试验 profile 里拷一份 preset 目录，验证后再切回共享路径。**默认走拷贝方案**：$H/presets/i2stream-ops/，agent-presets roots 指向它。）

**E1.5 纯运维面核对**
```sh
# 工具清单：GUI 新会话里问「列出你可用的工具」/ 或查 dump-config 里 tools 相关行
# 期望在场：BKN 12 个（query_product 等）+ mcp__i2agent__* + 记忆 3 个 + skill/ask/常规读类
# 期望缺席：bash / run_code / write / edit / subagent / workflow / goal / web_search
```

### E1 执行记录（2026-09-15）

- **R1 解除**：纯 patch bundle 合法（profile.ts:878 只要求 dsh.bundle.patch 声明）。
- **R8 新发现并处置**：新包不能放 packages/bundle/（根 tsdown.config.ts 按 glob packages/*/* 强制全部包构建 + tsconfig.host.json 逐包注册）→ ops-app 移到 $DSH_HOME/bundles/ops-app/，profile 用 file: 依赖 + 双锚点解析加载；上游仓库零文件新增。
- **R3 触发并修复（批 1）**：file-upload 裁剪 → fileUploads 服务缺失 → session-controller pending → ops-api 连锁 pending。修复 = file-upload 移出裁剪清单（运维场景上传日志反而有用）。教训：web-app host 层服务有硬依赖链，裁 client 行前查 providers。
- **硬链接陷阱**：pnpm file: 依赖是硬链接，edit 工具重写源文件断开 inode → profile 副本保留旧内容。修复 = profile node_modules 里的 cordis.patch.yml 换符号链接指向 bundle 源文件。
- **环境事实**：/tmp 每次 run_code 调用隔离（跨调用不持久）；bash 每调用新 shell，服务须用 run_in_background 托管作业；GUI 根路径有信任围栏（curl 401 正常，token 在启动日志 `?token=` 处）。
- **批 1 验收**：23/23 id disabled（file-upload 移出后）；启动无 pending 警告；ops-api 六路由全挂载（/v1/capabilities 200）。
- **批 2 验收**：19/19 id disabled（dump-config 总 57 = 23+19+上游自带 15）；ops-api /health 200。
- **E1.3/E1.4 顺利**：profile patch 移植含两处 delta（default preset=standard 保留——会话走首会话自动 preset？验证：ops-api cfg.preset=i2stream-ops；memory autoStart=false + logDir 改 DSH_HOME）；拷贝的 preset 已自带 skill-filesystem(customSkillDirs)+tool-skill（W3 已补），无需改动。

### E1 验收
| 项 | 结果 |
|----|------|
| 纯 patch bundle（无 src）被 loader 接受 | （回填；不接受则记录壳插件方案） |
| 批 1/批 2 dump-config diff 干净 | （回填） |
| GUI 五项走查 | （回填） |
| BKN 工具 + i2agent MCP + skill(27) + 记忆工具可见 | （回填） |
| 编码工具确认缺席 | （回填） |
| bench-4q 指 :3081 无回归（对比现网基线 Q1-Q4） | （回填） |

---

## E2 api-server（:8642 + Bearer）

### 目标
对外 OpenAI 兼容面独立端口、强制鉴权，与 GUI 面同进程共存。

### 步骤

**E2.1 ops-api 扩展（code/ops-api/index.ts）**
- Config 增 `apiServer` 段：{ enabled, host='127.0.0.1'（试验默认）, port=8642, apiKey='' }；Schema 校验：enabled=true 且 apiKey 为空 → apply() 抛错 fail-loud（对齐方案 §3.1）
- apply() 内：apiServer.enabled 时 `createServer((req,res)=>dispatch(req,res))`——把现有 handleChat/handleResponses/handleSessions/handleCapabilities/health 的分发逻辑抽成内部 `dispatch(req,res)` 函数（GUI webserver 路由与新 listener 共用）
- 鉴权中间件：除 /health 外全部要求 `Authorization: Bearer <apiKey>`（timing-safe 比较），失败 401 errorBody
- 生命周期：server.listen(host,port)；`ctx.on('dispose')` → server.close() + 强制断开 keep-alive socket
- 挂载日志：`[ops-api] api-server listening on <host>:<port>`

**E2.2 self-test 追加 [14] 段（mock http）**
1. enabled+key → listen 被调、路由分发到 handleChat（复用现有 mock driver）
2. enabled+空 key → apply 抛错（fail-loud）
3. 无 key / 错 key → 401；对 key → 200；/health 免鉴权
4. timing-safe 比较函数单测
5. dispose → close 被调

**E2.3 重启验收（HTTP）**
```sh
export OPS_API_KEY=<生成一个随机 key>
# cordis.patch.yml ops-api config 加 apiServer 段（apiKey: !!js process.env.OPS_API_KEY）
# 重启试验实例
curl :8642/health                                            # 200（免鉴权）
curl :8642/v1/chat/completions -d '{"messages":[{"role":"user","content":"你好"}]}'   # 401
curl -H "Authorization: Bearer $OPS_API_KEY" :8642/v1/chat/completions -d '...'            # 200 流式/非流式
curl -H "Authorization: Bearer $OPS_API_KEY" :8642/v1/capabilities                          # 位图正确
curl -H "Authorization: Bearer $OPS_API_KEY" :8642/v1/responses -d '{"input":"hi"}'        # resp_ 形状
bash bench-4q.sh http://127.0.0.1:8642 i2stream-ops <key>   # bench 脚本若不支持 key 则逐题 curl
# 多轮 + 记忆 key 回归：X-Ops-Session-Id 续接、X-Ops-Memory-Key recall
```

### E2 执行记录（2026-09-15）

- **R6 命中**：8642 被占（127.0.0.1 监听 + Hermes 对话语法应答——现网有服务在用）。不动现网：**试验 api-server 改用 8643**；切换决策阶段（E4）解决 8642 归属。
- 实现：dispatch 复用 5 个共享 handler（chat/responses/sessions/models/capabilities）；apiServer 面先用 apiServer.apiKey 强校验（fail-loud 保证非空）→ 通过后改写 authorization 头为 GUI 面 cfg.apiKey → 共享 handler 内 authorized() 无缝通过；/health 免鉴权；socket 集合跟踪 + dispose 全断开。
- **鉴权矩阵验收（8643）**：/health 免鉴权 200 ✓ / 无 key 401 ✓ / 错 key 401 ✓ / 对 key 200 ✓。
- **契约面验收（8643）**：chat 非流式 200（finish_reason=stop + usage）✓ / chat 流式 SSE（data: chunk 序列）✓ / responses 200（resp_ 形状）✓ / capabilities 位图正确 ✓ / 多轮续接（create-new 策略下 turn2 带 turn1 上下文）✓ / reject 策略 400 ✓ / :3081 GUI 面行为不变 ✓。
- **self-test [14] 段新增 7 断言**：14.1a fail-loud；14.2a-f 鉴权矩阵 + 404（真端口随机起，假 ctx）。92+7 全绿。
- unknownIdPolicy 验收后已切回 reject（与现网口径一致）。

### E2 验收
| 项 | 结果 |
|----|------|
| self-test [14] 全绿（含存量回归） | （回填） |
| :8642 401/200/health 免鉴权 | （回填） |
| 契约面（chat流式/responses/capabilities/sessions/多轮/记忆） | （回填） |
| GUI :3081 面行为不变 | （回填） |

---

## E3 管理面（ops-admin + /admin 页）

### 目标
Web 端可管理 MCP（热生效）/skill 启停，只读工具/preset 清单 + 系统状态。

### 步骤

**E3.0 前置最小验证（2026-09-15 已完成——通过）**：实验 = profile patch 插无害 mcp 行（streamable-http → 127.0.0.1:59999 死端口）+ 59999 起探针监听 → 探针收到 `POST /mcp`。chokidar watchConfig → entry.update → mcp-client 原地重连确认生效，加服务器免重启。机制：watch-config.ts 按目录 watch + 精确文件名过滤（edit 重写 inode 不影响触发）；reload 失败打 `config reload at <file> failed` 警告不崩实例。**结论：托管段方案采用热生效版本，不降级。**（原计划正文如下，保留作背景）
```sh
# 手工在 $H/profiles/ops/cordis.patch.yml insert 区加一个无害 mcp 行（或直接改现有 mcp-i2agent 的 header 值）
# 保存 → 观察日志：loader 是否 live apply？mcp-client 是否原地重连？
# 结论回填本文档；若不生效 → §4.2 托管段方案降级为「写入 + 提示重启」，E3 工作量减半
```

**E3.1 ops-admin 插件骨架（新文件 code/ops-api/admin.ts，由 index.ts 挂载）**
- `readManagedPatch()/writeManagedPatch()`：定位 `# >>> OPS-ADMIN MANAGED >>>` / `# <<< OPS-ADMIN MANAGED <<<` 标记区；解析 YAML 数组 → 在标记区内增删 mcp insert 条目 → 原子写（tmp+rename）
- revision 校验：写入前 body 带 `If-Match: <sha1(patch文件当前内容)>`，不匹配 409
- schema 校验：serverName `[A-Za-z0-9_-]{1,32}`、transport 枚举、stdio 需 command、http 需 url
- settings 域：`ops-admin:` 段（disabledSkills: []）经 ctx.settings 读写（skill 启停持久化）

**E3.2 /admin REST（挂 GUI webserver，exact 路由，全部要求 OPS_ADMIN_KEY）**
```
GET    /admin/api/state            # 聚合：mcp 列表(托管段解析) / skills 列表(扫 customSkillDirs + disabled 标记) / tools 清单 / preset 列表 / 依赖健康(Gateway/Qdrant/i2agent/embedder 探活)
POST   /admin/api/mcp              # 新增（写托管段）
PUT    /admin/api/mcp/<name>       # 编辑/启停（写托管段）
DELETE /admin/api/mcp/<name>       # 删除（写托管段）
POST   /admin/api/skills/<name>/enable|disable   # 写 settings ops-admin 段
GET    /admin                      # 静态管理页（exact，优先于 SPA fallback）
```
- 鉴权：`OPS_ADMIN_KEY`（与 OPS_API_KEY 分离）；401 语义同 E2
- skill 启停实现：ops-admin 在 skill 注册表出口过滤 disabledSkills（执行时先核实 skill 服务的过滤点——list 阶段 hook 还是注册阶段 filter；新会话生效即可，不要求热更已开会话）

**E3.3 管理页（单 HTML 原生 JS，无构建链）**
- 四个区块：MCP 服务器卡片（增删改/启停/状态点）、Skill 网格（开关）、只读清单（tools/presets）、系统状态条
- localStorage 存 OPS_ADMIN_KEY，fetch 带 Bearer；401 时弹重新输入
- 文件位置：code/ops-api/admin.html（插件内嵌，启动时读入内存注册路由）

### E3 执行记录（2026-09-15）

- **E3.1 admin.ts**：纯函数模块（托管段解析/序列化/原子写/revision 校验 + 技能目录重命名启停），11 导出；[15] 段 18 断言覆盖往返/原子写/409/幂等/非法输入/CRLF 稳定。
- **E3.2 index.ts 挂 /admin**：Config.admin 段（enabled/adminKey/patchPath/skillsDir，fail-loud：enabled 无 key 或无 patchPath 拒绝启动）；路由 = GET /admin（页面壳免鉴权）+ /admin/api/state（聚合 revision/mcp/skills/依赖健康探活）+ POST /admin/api/mcp + PUT|DELETE /admin/api/mcp/<name>（合并单 handler）+ POST /admin/api/skills/<name>/enable|disable。
- **E3.3 admin-html.ts**：原生 JS 单页（MCP 卡片/技能 chips/健康点/新增对话框），key 存 localStorage，401 弹重输，30s 轮询。
- **踩坑三连（都已修）**：① webserver 禁重复 prefix 路由 → PUT/DELETE 合并单 handler 按 method 分发；② 托管段缺 `- insert:` 父级（serializeServer 产出 4 空格缩进条目，loader 认不出）→ writeManagedState 补父级，self-test 15.3d 加断言；③ prefix 注册值带尾斜杠永不命中（match 逻辑是 startsWith(prefix+'/')，注册 '/admin/api/mcp/' 时检查双斜杠）→ 三处 path 去尾斜杠 + slice 调整。
- **技能启停**：拷贝共享 skill 目录到 $DSH_HOME/skills（27 项）+ preset customSkillDirs 指向拷贝；启停 = 目录重命名 <name> ↔ <name>.disabled（共享目录不动，新会话生效）。
- **验收全绿**：/admin 页面 200；state 鉴权矩阵（无 key 401/对 key 200 聚合正确）；技能停用→目录变 .disabled→启用恢复；MCP 新增→托管段落盘→删除→段清空标记保留；**端到端热更**：/admin API 写入 e3hot → 免重启 → 探针 59997 收到 mcp-client 5 次 POST /mcp 重连 → 删除清理。self-test 97 断言全绿。

**E3.4 self-test 追加 [15] 段**
1. 托管段读写：插入/删除/幂等/标记区外内容不动
2. 原子写与 revision 冲突 409
3. schema 校验拒绝坏输入（非法 name/缺 command）
4. skill enable/disable 写 settings 正确、过滤生效（mock skill 注册表）
5. /admin 鉴权（mock req）

### E3 验收
| 项 | 结果 |
|----|------|
| E3.0 MCP 热更最小验证结论 | （回填） |
| 通过 /admin 新增一个 MCP server → 不重启 → 新会话出现 mcp__<name>__* 工具 | （回填） |
| /admin 停用该 server → 工具消失 | （回填） |
| skill disable → 新会话 skill 目录少一项 | （回填） |
| 系统状态聚合显示正确 | （回填） |
| self-test [15] 全绿 | （回填） |

---

## E4 端到端验收与切换决策

### 步骤
1. **日志分析场景（最终目的的代表用例）**：GUI 与 :8642 各跑一遍「帮我看下 agent-01 上 i2Stream 的同步日志，最近有没有异常」→ 走 i2agent MCP（exec_shell/find 日志 → get_log_templates → 必要时 start_autodiag）→ 产出诊断结论 + Skill 指针。核对：动作全部经 MCP 远程通道，本机无 bash 调用。
2. **管理场景**：/admin 加一个测试 MCP（如官方 filesystem server）→ 对话中模型能调用 → /admin 卸载 → 工具消失。
3. **升级手册演练（§2.5 的可执行性验证）**：跑一遍 5 步手册（不真升级版本，模拟：dump-config 存档 → 人工删 ops-app 清单中一个 id → 重跑手册第 2 步看能否发现 → 恢复）。
4. **切换决策**：三选一回填——a) 试验实例转正（现网 3080 停用，DSH_HOME 切到 .dsh-home，注意 sessions 迁移评估）；b) 双实例并存（现网开发用，试验实例投产）；c) 继续试验（列出剩余 gap）。

### E4 执行记录（2026-09-15）

- **E4.1 日志分析场景（:8643 API 入口）**：「看下本机 i2Stream 同步日志有无异常」→ 模型自主调用 i2agent MCP 工具链（get_alerts 全局告警 / get_log_templates Drain 聚合 / 节点状态查询），跨节点远程诊断并诚实报告 tangxy、node223 断连节点、给出后续建议（恢复连接 / autodiag）。动作全走 MCP 远程通道，本机无 bash（已裁剪面生效）。
- **E4.2 管理闭环**：E3 已全验（新增→热更重连探针→删除→段清空；技能启停目录重命名），E4 前夕回归一次通过。
- **E4.3 升级手册演练**：存 dump 基线（57 disabled）→ 从 ops-app patch 删 ui-jobs（模拟上游改名该行）→ 重跑 dump + awk + sort → `diff` 正确输出 `39d38 < ui-jobs`（手册第 2 步发现问题）→ 恢复条目 → diff 归零。**手册可执行性确认**。
- **最终回归**：dsh-plugin self-test 全绿；ops-api self-test 97 断言全绿；三面健康（:8643 api 200 / :3081 admin 200 / :3081 GUI 信任围栏 401）。
- **切换决策建议（三选一，待用户定）**：
  - a) **双实例并存（推荐）**：现网 :3080 继续开发用，试验实例（.dsh-home，:3081 GUI + :8643 API + /admin）投产验证；观察一周后再决定转正。8642 归属（疑似现网 Hermes 复活）切换前需人工确认。**→ 用户已选定（2026-09-15）。落地：试验实例改由宿主 systemd transient unit `dsh-ops-trial.service`（Restart=on-failure）托管——bwrap 沙箱 --die-with-parent 会回收会话内进程，setsid 无效，必须 PID 1 拉起（经一次全权限升级完成 dbus 通道）；启停脚本 code/scripts/run-ops-trial.sh（systemd 版）；运维手册 doc/ops-trial-operations-manual.md（两实例对照表/配置变更速查/升级跟随 5 步/观察期检查单）。**
  - b) 试验实例转正：现网 3080 停用，DSH_HOME 切到 .dsh-home；注意 sessions/记忆 key 迁移评估。
  - c) 继续试验：列出剩余 gap（如 GUI 浏览器端人工走查、Qdrant/embedder 在新 DSH_HOME 下的行为确认）。

### E4 验收
| 项 | 结果 |
|----|------|
| 日志分析场景（GUI + API 两入口） | （回填） |
| 管理闭环（MCP 装/卸 + skill 开/关） | （回填） |
| 升级手册演练结论 | （回填） |
| 切换决策 | （回填） |

---


## E5 去 Web（Headless API-Server）+ 技能自管理（Hermes 复刻）

### 需求（2026-09-16 用户指令）
1. **去 web**：对外只暴露 api-server（:8643）；能通过 API 添加 MCP、tool、skill。
2. **技能自管理**：复刻 Hermes skill_manage 工具 + curator 生命周期（agent 自建技能、使用追踪、变更审计、自动归档）。

### E5.1 去 Web（Headless）实施记录（2026-09-16）

**依赖链分析**（关键发现）：
- `connection` 行硬注 `inject: [webRuntime]`；`web-runtime` 插件模块硬注 `inject: ['webServer']`；`webserver` 行注 `webStartup`。
- `file-upload` 硬注 `connection`；`session-controller` 硬注 `fileUploads`——但 connection 插件本身只硬注 `credentials`，webServer 是可选注入（`ctx.inject(['webServer'], ...)` deferred 块）。
- **结论**：禁 webserver 后 connection 仍可提供服务（无 web 面挂载），file-upload/session-controller 链安全。

**实施**：
1. ops-api 路由表化：统一 `routes[]` + `mountRoute()` 工厂——webServer 存在时注册 GUI 面；apiServer listener 按同一张表分发（exact 优先，最长 prefix 匹配）。
2. apiServer dispatch 重构：`/health` 免鉴权；`/admin/*` 走 adminKey（不改写 authorization 头）；其余业务路由先验 apiServer.apiKey 再改写为 cfg.apiKey。
3. ops-app patch batch3（41 to 45 disables）：
   - `webserver` disabled
   - `web-runtime` disabled
   - `client-hmr` disabled（等 webServer）
   - `connection` 覆写：`inject: []` + `config.trustedHosts: []`（applyEntryPatches 按键覆写任意行字段）
4. systemd unit 重建：去掉 `--port 3081 --no-open` web 标志。

**验收结果**：
- boot 干净（0 pending / 0 error）
- :3081 已关闭（connection refused）
- :8643 全功能：/health 200 + /admin 200 + /admin/api/state 200（26 skills）
- ops-api self-test 119 断言全绿

### E5.2 技能自管理（ops-skill-manager）实施记录（2026-09-16）

**架构**（四模块 + 插件入口）：
- `store.ts`：usage 台账（.usage.json，原子写 tmp+rename；bump 合并 created_by）
- `ledger.ts`：变更审计（.skill-ledger.jsonl + .skill-backups/ 内容寻址 blob 去重）
- `ops.ts`：写操作（create/patch/write_file/archive/restore；路径逃逸防护；预置只读守卫）
- `curator.ts`：生命周期迁移（active to stale to archived；pinned/预置豁免；归档改名不删除）
- `index.ts`：插件入口（skill_manage 工具 + tools/pre-execute usage bump + ctx.setTimeout curator 定时 + ctx.provide skillManagerAdmin 服务）

**踩坑记录**：
1. **package.json 缺失导致 CJS 回退**：外部插件目录无 package.json 时 Node 回退 CJS 解析，bare module（@deepseek-ai/schemastery）解析失败，loader 报 failed to import 无详细信息。修复：补 `"type": "module"` package.json（与 ops-api 同款）。
2. **ctx.setTimeout 需要 timer inject**：context 代理拒绝未声明 inject 的属性访问。修复：`export const inject = ['tools', 'timer']`。
3. **bump 合并 created_by bug**：pre-execute hook 的 bump 先执行（无 createdBy），createSkill 的 bump 后执行时 record 已存在（spread 不添加新字段）导致 created_by 丢失。修复：bump 函数在 record 存在时也合并 createdBy。

**验收结果**（live 实测）：
- self-test 26 断言全绿（store/ledger/ops/curator + created_by 合并回归）
- E2E chat：`skill_manage list` 返回空列表 ✓
- E2E chat：`skill_manage create fix-verify` 成功，usage.json 记录 `created_by: agent` ✓
- E2E chat：`skill_manage patch i2stream-rule-manager`（预置）正确拒绝（read-only）✓
- ledger 记录 create 动作 + before/after sha ✓
- curator armed（interval=168h stale=30d archive=90d）✓

### E5 验收
| 项 | 结果 |
|----|------|
| 去 web（headless boot + :8643 全功能） | ✅ boot 干净；:3081 拒绝；:8643 /health /admin /admin/api 全 200 |
| ops-api 路由表化（webServer 可选 + apiServer 表驱动） | ✅ self-test 119 断言全绿 |
| skill_manage 工具（create/patch/archive/list） | ✅ E2E chat 全通过；预置只读守卫生效 |
| usage 台账（created_by 合并修复） | ✅ self-test 回归覆盖；live 验证 created_by: agent |
| 变更 ledger（before/after sha + blob 备份） | ✅ create 动作记录完整 |
| curator 生命周期（armed + 迁移逻辑） | ✅ self-test 26 断言全绿（active/stale/archived + 豁免） |
| 独立插件（ops-skill-manager） | ✅ package.json + inject [tools, timer]；boot 干净 |

---

## 风险登记（执行期）

| # | 风险 | 触发阶段 | 处置 |
|---|------|---------|------|
| R1 | loader 不接受纯 patch bundle（无 src/main） | E1.1 | ~~补壳~~ **已解除**：源码核实 profile.ts:878-881 只要求 package.json 声明 dsh.bundle.patch，纯 patch 包合法 |
| R2 | pnpm install 离线缺包 / build:web 失败 | E0 | 已处置：store 改工作区（--store-dir /hdd/demo/public/dsh-info/.pnpm-store，/root 不可写）；build 依赖链 = pnpm build（全 workspace tsc+tsdown）→ pnpm build:web；webworker-runtime 需先 tsdown |
| **R8（执行期新发现）** | **新 workspace 包被上游构建聚合吞掉**：根 tsdown.config.ts 按 glob packages/*/* 枚举全部包并要求 lib/types 产物，tsconfig.host.json references 逐包显式列出——把 ops-app 放 packages/bundle/ 下必须改上游两个聚合文件（违背净改动=0） | E1.1 | **已处置**：ops-app 移出 workspace → $DSH_HOME/bundles/ops-app/，profile manifest 用 file: 依赖挂进 profile 自己的 node_modules（bundle 双锚点解析：installation 优先、profile 目录兜底，profile.ts:827）。上游仓库仍然零文件新增；代价 = profile pnpm install 需 --store-dir 指工作区 |
| R3 | 裁剪后 GUI 走查发现依赖断裂（某 client 行没了但 host 服务还被 inject） | E1.2 | dump-config 定位报错行 → 该行恢复（从清单移除）→ 记录到方案 §2.1 备注 |
| R4 | MCP 热更不生效（E3.0 验证失败） | E3.0 | 托管段降级「写入+提示重启」；管理页明确标注生效方式 |
| R5 | 现网 preset 共享目录被试验改动波及 | E1.4 | 已决策：试验 profile 用拷贝 preset 目录，验证后再评估切回共享 |
| R6 | :8642 与现网 Hermes 残留端口冲突 | E2 | 现网 Hermes 已停（gap-exec 验收过）；启动前 `ss -ltnp | grep 8642` 确认 |
| R7 | 第二个 DSH 实例与现网实例的 i2agent MCP/Qdrant 并发访问 | 全程 | 外部服务均为无状态/只读共享，可接受；Gateway 记忆 key 隔离（试验用独立 memory key 前缀 i2agent:e2e:*） |

## 每阶段通用 DoD
1. 阶段验收表全项回填（含失败项——如实记录）
2. dsh-plugin + ops-api 存量 self-test 断言不破
3. bench-4q 无回归（E0-E1 用 :3081，E2 后加 :8642 一轮）
4. 方案文档 §8 回填实施记录

## 预估与重启预算

| 阶段 | 预估 | 实例重启次数 |
|------|------|-------------|
| E0 | 0.5 天（install+build 为主） | 1 |
| E1 | 1 天 | 3-4（批1/批2/配置/走查） |
| E2 | 0.5-1 天 | 1-2 |
| E3 | 1.5-2 天 | 2-3 |
| E4 | 0.5 天 | 1 |