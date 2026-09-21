# i2Stream Ops 双实例并存运维手册（方案 a）

> 2026-09-15 · 用户选定切换方案 a：双实例并存。
> 现网实例继续开发用；试验实例投产验证，观察一周后再决定是否转正。

## 两个实例一览

| | 现网实例（开发） | 试验实例（投产验证） |
|---|---|---|
| DSH_HOME | /root/.dsh | /hdd/demo/public/dsh-info/.dsh-home |
| 进程托管 | （现网原方式） | systemd `dsh-ops-trial.service`（Restart=on-failure） |
| GUI | :3080 | **—（E5 后 headless，web 面下线，:3081 不监听）** |
| api-server | 无独立面（挂 GUI 进程内 :3080/v1） | :8643（Bearer `$OPS_API_KEY`，值见 `$DSH_HOME/ops.env`） |
| 管理面 | 无 | :8643/admin（`$OPS_ADMIN_KEY`，同 ops.env） |
| 编排 | web-app 原始面（含编码工具） | ops-app 三层裁剪（纯运维面） |
| preset | standard（现网 profile 内 i2stream-ops 由 ops-api 指定） | i2stream-ops（拷贝目录含 skill 挂载） |
| 技能目录 | 共享根 /hdd/demo/public/i2stream-bkn/skill | 拷贝 $DSH_HOME/skills（27 项，/admin 可启停） |
| sessions/记忆 | 现网 key 空间 | 独立 key 空间（试验期请用 i2agent:e2e:* 前缀） |

共享且不动的外部依赖：MemoryCore Gateway :8420（现网 supervisor 托管）、i2agent MCP :8090、Qdrant :6333（embedder 同实例内）。

## 日常操作

```sh
# 启停（需宿主 dbus 访问；沙箱内执行需一次全权限）
bash /hdd/demo/public/dsh-info/code/scripts/run-ops-trial.sh start|stop|restart|status|logs

# 直接用 systemd
systemctl status dsh-ops-trial
systemctl restart dsh-ops-trial
journalctl -u dsh-ops-trial -f          # 实时日志（GUI token 也在日志里）
```

## 配置变更速查

| 想改什么 | 改哪里 | 生效方式 |
|--------|-------|---------|
| 裁剪清单（增/删 disable） | $DSH_HOME/bundles/ops-app/cordis.patch.yml | systemctl restart（bundle 层变更不热更） |
| MCP 服务器（增/删/改） | /admin 页面 或 /admin/api/mcp | **热生效**（免重启，mcp-client 原地重连） |
| 技能启停 | /admin 页面 或 /admin/api/skills/<name>/enable|disable | 新会话生效 |
| api-server key/端口 | $DSH_HOME/profiles/ops/cordis.patch.yml ops-api.apiServer 段 | restart |
| 模型配置 | $DSH_HOME/settings.yaml / .credentials.yaml | restart |
| preset 组合 | $DSH_HOME/presets/i2stream-ops/agent.cordis.yml | restart |

托管段约定：profile cordis.patch.yml 内 `# >>> OPS-ADMIN MANAGED >>>` … `# <<< OPS-ADMIN MANAGED <<<` 标记区由 /admin 独占；手工改动标记区内容会让 revision 变化，/admin 侧下次写入自动读新 revision，无需干预。**标记区外的内容不要手工增删 insert 行**——那是编排层（E1 移植的三段 insert）的地盘。

## 升级跟随（harness 更新时）

1. `cd /hdd/demo/public/dsh-info/deepseek-harness && git pull && pnpm install --store-dir /hdd/demo/public/dsh-info/.pnpm-store && pnpm build && pnpm build:web`
2. ~~dump-config 存档 diff（人工肉眼对账）~~ **已自动化：`dshctl upgrade-check`**（2026-09-16，v0.3）——
   `cd /hdd/demo/public/dsh-info/deepseek-harness && node --import tsx/esm /hdd/demo/public/dsh-info/code/dshctl/dshctl.ts upgrade-check --refresh`
   全领域 R2/R3 对账：消失 id（error，必须跟进清单）/ 新增行（warn，人工评估裁剪）；verdict=pass 才进入第 3 步；
   roster 不可用时 exit 2 拒绝假通过。历史基线由 `domains/.cache/dump-config-<版本>.json` 自动管理。
3. `node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts` + `…/code/ops-api/self-test.ts`（在 /hdd/demo/public/dsh-info/deepseek-harness 根）
4. `systemctl restart dsh-ops-trial` + bench-4q（:8643 API 面；headless 后无 GUI 面）
5. 回填版本与 diff 结果到 doc/ops-agent-orchestration-plan.md §8

（E4.3 已人工演练第 2 步可发现性；v0.3 起该演练由 self-test [11] 与假基线 drill 常态化覆盖。）

## 观察期检查单（一周）

- [x] ~~浏览器打开 :3081 GUI 完整走查~~（E5 后 headless，无 web 面——本项作废，改由 :8643 HTTP 契约面覆盖，api-smoke 已自动化）
- [ ] 用真实运维问题跑 :8643（多轮 + 记忆 key + 工具调用），对比现网回答质量
- [ ] /admin 装一个真实 MCP（如官方 filesystem server）验证工具出现在对话里
- [ ] Qdrant/embedder 在新 DSH_HOME 下的行为确认（embed sidecar 自启动正常）
- [x] 8642 归属确认——**已完成（2026-09-16 取证）**：`hermes_cli.main gateway run`（hermes-agent 0.21.1，pid 3088028，活进程）。转正时动作：确认 Hermes 退役 → 停该进程 → 试验 api-server 迁回 8642（改 profile patch 端口 + restart）。已登记 `domains/registry.yml` unregistered_ports
- [ ] systemd Restart=on-failure 实测（kill 进程观察自动拉起）

> **dshctl 自动化补充（2026-09-16）**：上表之外，`dshctl check ops --ci` 每周可替代以下人工核对——
> ① 端口/实例登记一致性（R1）；② 44 项 disable 清单与上游 roster 对账（R2，升级后自动发现改名/删除）；
> ③ skills 目录存在性与 SKILL.md frontmatter（R6）；④ api 超时与密钥 env 红线（R7/R8）。
> 命令：`cd /hdd/demo/public/dsh-info/deepseek-harness && node --import tsx/esm /hdd/demo/public/dsh-info/code/dshctl/dshctl.ts check ops --ci`

### 所有权铁律（2026-09-16 事故沉淀）

- :8420 在 Hermes 退役前**唯一归属 Hermes 进程的内建 supervisor**（其会主动击杀抢占绑定的进程）——systemd unit 处于 installed+disabled 待命；
- Hermes 退役当日的接管序列：kill Hermes gateway 子进程 → `systemctl enable --now memorycore-gateway` → 验证 /health+recall → 现网 profile 的 autoStart=false 已预置（无需再改）；
- :8096（embed）无此冲突，已由 systemd 常驻（Hermes 用进程内 embedding，不碰 sidecar）。

## 已知限制

- ~~GUI token 每次重启变化~~（E5 后 headless 无 web 面，本项不再适用）。
- 技能启停只对新会话生效（skill-filesystem 每会话扫描）；已开会话不受影响。
- 试验实例未配 OPS_API_KEY 之外的 TLS——api-server 与 admin 面默认绑 127.0.0.1，生产暴露需前置反代或收紧 host。

## 共享基础设施独立托管（2026-09-16 起）

MemoryCore Gateway 与 embed sidecar 已转 **systemd 独立 unit**（proposal §3.5 债务清偿），不再依赖手工进程/supervisor 惰性拉起：

| unit | 端口 | 说明 |
|---|---|---|
| `memorycore-gateway.service` | 8420 | 四层记忆 Gateway——**已安装、当前 disabled**：Hermes（:8642 活进程）自带的 memory supervisor 拥有 8420 子进程并会击杀抢占者（2026-09-16 实证：systemd 与之抢绑定产生 181 次 EADDRINUSE 重启环）。**转正切换日**（Hermes 退役）执行 `systemctl enable --now memorycore-gateway` 即接管 |
| `embed-server.service` | 8096 | BGE embedding sidecar（HF 离线；Restart=always）——**已启用常驻** |

```sh
systemctl status|restart memorycore-gateway embed-server
journalctl -u memorycore-gateway -f
```

验收（2026-09-16 live）：双 unit active、`/health` ok、recall code=0（5 条记忆，数据零迁移）、embed 1024 维、ops 实例 :8643 不受影响。
i2agent MCP(:8090) 与 Qdrant(:6333) 为外部既有服务，不在本次托管范围（registry 已补登四条 shared_deps）。

> **所有权铁律（2026-09-16 事故沉淀）**：:8420 的进程生命周期**唯一归属 `memorycore-gateway.service`**。
> 任何 DSH 实例的 `ops-api memory.autoStart` 必须为 false（现网 /root/.dsh profile 已收敛，随下次重启生效）——
> 曾因双侧 supervisor 抢端口出现 147 次 EADDRINUSE 重启环（systemd 日志可查），最终 systemd 赢得绑定。
