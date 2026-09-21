# dshctl GUI 视觉升级方案 —— 「高级感浅色控制台」（Linear/Geist DNA + antd 深度换肤）

> 状态：**已评审，开始实施**（2026-09-18 用户批准；三线调研 → 综合方案 → 默认推荐落地）
> 范围：`code/dshctl/gui` 全站（7 页 + api.tsx 底座）｜ 不换组件库、不换 React/antd 版本

---

## 0. 起因与目标

用户三点：① Web 整体风格依旧太简陋、不好看、没有高级感；② 先调研网上高 star 组件库；③ 再调研大公司产品 Web 风格，综上出优化方案。

目标画像：**浅色开发者工具控制台**（运维/对账/清单工具），观感对标 Vercel/Linear/Supabase，渐进改造、分 commit 可回滚。

## 1. 调研综合（三线，2026-09-18）

### 1.1 高 star 组件库（GitHub API 实测 star）

| 结论 | 依据 |
|---|---|
| **shadcn/ui（124,205★）是「高级感」现象级答案** | copy-paste 所有权 + Radix 地基；DNA = zinc 中性灰 + 1px 半透明边 + 10px 圆角 + **卡片零阴影** + primary 默认近黑（彩色让给点缀）——Linear/Vercel 一系的「安静精致」（ui.shadcn.com/docs/theming） |
| 控制台四事实选：Tremor（仪表盘）/ shadcn+charts / Ant Design Pro / Mantine | 运维·开发者工具明显偏向 **shadcn 系**（Vercel/Linear/Supabase/Railway 同款）；antd 系偏「企业审批 CRUD」 |
| antd（99,551★）「塑料感」三来源 | ① #1677ff 高饱和蓝全站铺；② Level1-2 多层阴影滥用（浮起塑料片）；③ 6px 圆角+32 控件+白底同质化（知乎/V2EX 社区讨论一致） |
| 不换库的标准救法 = **seed token 降饱和 + 组件级 token 杀阴影改 hairline + 两级灰背景** | ant.design/docs/react/customize-theme；`wireframe:true` 是 v4 观感开关（本方案不用） |

**三路线评估**：① antd 深度换肤+原子件（3-10 文件、低风险、天然渐进、提升 7/10）＞ ② 混合盖 shadcn 自绘（割裂感风险）＞ ③ 全站迁库（7 页全重写，1-4 周，不可渐进）。**选 ①**。

### 1.2 大厂产品「高级感浅色控制台」共性公式（Geist/Linear/Primer/Grafana/Supabase/Stripe ≥7 家归纳）

| 维度 | 规格 |
|---|---|
| 背景 | **3-4 级拉开**：canvas `#FAFAFA` / surface `#FFFFFF` / subtle `#F4F5F6` / inset `#ECEDEF`——全纯白=简陋头号来源 |
| 边框 | 全部 1px hairline，三档 subtle/default/strong（≈`#EEEFF1`/`#E3E5E8`/`#D0D3D8`）或 6-10% 黑；卡片**默认零阴影**，阴影只给弹层且必须叠 1px ring |
| 文字 | primary `#1A1D21`（禁 #000）/ secondary `#5C6470`（≥4.5:1）/ tertiary `#8A9099` 仅占位；正文与表格 **14px** |
| 字重 | 正文 400，标签/表头/卡题 **500-600**，禁 700 滥用 |
| 圆角 | **三档到底**：控件 6 / 卡片 10-12 / 弹层 12-16；同屏 ≤2 种 |
| 间距 | 4px 刻度 `4/8/12/16/24/32`；卡内 16-20、卡间 16、区块 24-32 |
| 主色纪律 | 主色只在 CTA/链接/选中/focus **每屏 ≤3 处**；侧栏卡头禁大块品牌色 |
| 状态色 | **muted 底 + 深一档同色字**成对（绿 `#E8F7EF`/`#1B7A43`），禁满饱和色块直出当文字 |
| mono | id/code/hash/时间/数字一律等宽 + `tabular-nums`（Geist/Datadog/Grafana 同款） |
| hover/动效 | 背景跳一档灰或 4-6% 黑罩，150-200ms ease-out；禁浮起弹跳 |
| 图标 | 单一线性 stroke 1.5，14/16/20 三档，currentColor；禁线性面性混用 |
| 空态/加载 | 骨架屏 + 图标 + 14 标题 + 13 副文 + 主按钮四件套 |

**廉价感反模式 TOP**：全屏纯白无层次 / 阴影乱用无边框 / 次文字 11-12px 灰对比不足 / 主色大面积铺 / 圆角混杂 / 状态色满饱和直出 / 无 mono 数字跳动 / 间距 5/7/10 随手。

### 1.3 本地诊断（10 条，file:line 已核）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **次级文字对比不达标**：`#8c96a6` 对白仅 **2.99:1**、`GRAY.faint #b0bac7` **1.96:1**——满屏 12px 灰小字发灰模糊，廉价感最大来源 | main.tsx:18、api.tsx:15 |
| 2 | 背景只有两级且太近（`#f5f7fa` ↔ 纯白），0.04 阴影在浅灰底不可见，「白纸贴白纸」 | main.tsx:20,26 |
| 3 | 阴影三处来源（token / SHADOW 常量 / App Header inline 第三套） | main.tsx:26、api.tsx:12、App.tsx:126 |
| 4 | **状态色当文字直出且过艳**：`#52c41a` 2.27:1、`#d48806` 2.87:1、`#ff4d4f` 3.27:1，verdict 大字用这些色 | Upgrade.tsx:15-18,34 |
| 5 | 无 tabular-nums，26px 大数字滚动不齐；字重几乎只有 600 一档 | api.tsx:139、Dashboard.tsx:31 |
| 6 | 图标语言单调：@antd 实心 + **渐变圆角磁贴一个套路重复三遍**（PageHead 44/StatTile 46/快捷入口 34） | api.tsx:96-103、Dashboard.tsx:23-28 |
| 7 | antd 默认味残留 + `!important` 补丁（TAB_TILE_CSS 换主色不生效、inkBar 3px 偏粗、Card 双线框感） | api.tsx:255-265、main.tsx:34 |
| 8 | 空态全是默认 Empty（灰插画+一行字），加载是纯文字「加载中…」 | Dashboard.tsx:94-97、Domains.tsx:400 |
| 9 | 微动效近乎为零且 0.15s/0.12s 两套并存，motion token 未调 | api.tsx:256-264、Domains.tsx:347 |
| 10 | **47 处 inline 硬编码灰绕过 antd 主题系统**——「改了 main.tsx 页面没变」的根因（GRAY/SEM 常量与 token 双轨） | grep 计数 47 |

**一句话根因**：设计常量（GRAY/SEM/SHADOW）绕过主题系统 + 对比度不达标的灰与状态色直出，token 换肤收益穿不透到页面。

## 2. 决策（澄清问题未获答复 → 按推荐默认，用户批准）

| 决策点 | 取值 | 备选（未选） |
|---|---|---|
| 视觉 DNA | **Linear/Vercel 极简中性灰**（卡片零阴影 + hairline + 主色纪律 + 主按钮近黑） | 蓝控制台风精修（上限低）/ Anthropic 暖纸感（改动面大） |
| 字体 | **自托管 Inter 子集**（`@fontsource/inter` 拉丁 400/500/600，~40KB，中文回落系统） | 不加字体文件（跨平台数字不一致） |
| 改工程度 | **阶段 1+2**：全局 token + api.tsx 原子件（签名不变）+ Dashboard/Upgrade/Domains 三标杆页；Plugins 等被动受益不逐页重刷 | 全量 1+2+3（+9/10 但回归靠人眼）/ 只做阶段 1（半新半旧） |
| 组件库路线 | **不换库**，antd v6 深度换肤 + 自研原子件 | 混合自绘（割裂感）/ 全站迁库（1-4 周不可渐进） |

## 3. 目标规格（token 全表）

### 3.1 全局 seed token（main.tsx `theme.token`）

```ts
algorithm: theme.defaultAlgorithm,          // 不加 compact（与 controlHeight 36 打架）
token: {
  // 背景三级拉开（Linear/Geist canvas）
  colorBgLayout:    '#fafafa',              // 原 #f5f7fa —— 页面 canvas
  colorBgContainer: '#ffffff',
  colorBgElevated:  '#ffffff',
  colorBorder:      '#e3e5e8',              // 控件边（原 #d9d9d9 太重）
  colorSplit:       '#eef0f1',              // 分割线

  // 文字三档（全部 ≥4.5:1 on #fff / #fafafa）
  colorText:            '#1a1d21',          // 禁 #000；近黑（Stripe #0A2540 同理）
  colorTextSecondary:   '#5c6470',          // 原 #8c96a6 = 2.99:1 → 5.9:1
  colorTextTertiary:    '#8a9099',          // 仅占位/时间戳
  colorTextQuaternary:  '#c2c7cd',

  // 主色纪律：#1677ff 保留为 accent（链接/选中/focus），用量靠原子件与页面管制
  colorPrimary:      '#1677ff',
  colorPrimaryHover: '#4096ff',
  colorLink:         '#1677ff',

  // 圆角三档（控件 6 / 卡 12 / 弹层 16）
  borderRadius: 6, borderRadiusSM: 4, borderRadiusLG: 12, borderRadiusXS: 2,

  fontSize: 14, fontWeightStrong: 600, controlHeight: 36,

  // 阴影：卡零影由组件/原子件落地；seed 两档只给弹层/hover 且必叠 ring（Geist 手法）
  boxShadow:         '0 0 0 1px rgba(0,0,0,.06), 0 1px 2px rgba(16,24,40,.06)',
  boxShadowSecondary:'0 8px 24px rgba(16,24,40,.10)',

  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  motionDurationFast: '0.15s', motionDurationMid: '0.2s', motionDurationSlow: '0.25s',
  wireframe: false,
}
```

### 3.2 主按钮近黑（Linear DNA 关键单点）+ 组件 token

```ts
components: {
  Button: { colorPrimary: '#18181b', colorPrimaryHover: '#27272a',   // 主按钮近黑，accent 蓝让位
            primaryShadow: 'none', fontWeight: 500, paddingInline: 16 },
  Card:   { headerHeight: 48, headerFontSize: 14, bodyPadding: 20, bodyPaddingSM: 16 },
  Table:  { headerBg: '#f4f5f6', headerColor: '#5c6470', headerSplitColor: 'transparent',
            rowHoverBg: '#f4f7fb', borderColor: '#eef0f1', cellPaddingBlock: 12, cellPaddingInline: 16 },
  Tabs:   { inkBarHeight: 2, itemSelectedColor: '#1677ff' },          // 删现有 inkBarWidth:3
  Input:  { activeShadow: '0 0 0 2px rgba(22,119,255,.12)' },
  Select: { optionSelectedBg: '#eef4ff' },
  Tag:    { defaultBg: '#f4f5f6', defaultColor: '#5c6470' },
  Layout: { siderBg: '#0e1830', headerBg: '#ffffff', bodyBg: '#fafafa', headerHeight: 56 },
  Menu:   { itemBg: 'transparent', itemSelectedBg: 'rgba(255,255,255,.08)',
            itemColor: 'rgba(255,255,255,.65)', itemSelectedColor: '#fff', itemBorderRadius: 8 },
}
```

### 3.3 原子件升级（api.tsx，**对外签名全不变，页面被动受益**）

| 原子件 | 改造 |
|---|---|
| `GRAY`/`SEM` | 值对齐 3.1（`GRAY.sub → #5c6470`、`GRAY.weak → #8a9099`、`GRAY.border → #e3e5e8`…）——**引用处自动跟随，收编 47 处 inline 大头**；SEM 状态色拆「底/字」两档（字用深档 `#1b7a43/#b8860b/#cf222e` 系） |
| `SHADOW` | 与 seed 同源导出：`card: 'none'`（hairline 承重）、`hover: 0 0 0 1px rgba(0,0,0,.06), 0 1px 2px …` |
| `cardStyle` | 阴影改 `none`，边框 `1px #e3e5e8`——全站卡片立刻去塑料感 |
| `PageHead` | 渐变磁贴 → tinted 底 + Outlined 16-18px 图标 + 去 boxShadow；渐变分隔线 → hairline |
| `StatBand`/`StatTile` | 数字 `fontVariantNumeric: 'tabular-nums'`、字色 `colorText`、标签 secondary；渐变磁贴同 PageHead 收敛 |
| `StateDot`/`StatusRow` | 伴文随 tone 用**深档**色（不再 `#52c41a` 直出） |
| `CodeBlock`/`CommandChip` | 显式 mono 栈；Chip 底 `#f4f5f6` 边 hairline |
| `EmptyState`（**新增**） | 四件套：Outlined 图标 + 14 标题 + 13 副文 + 主按钮；替换 Dashboard/Upgrade/Domains 的默认 Empty |
| `TAB_TILE_CSS` | hover 色 token 化；`tabular-nums` 全局注入；hover 时长统一 0.15s |
| 全局 | id/code/时间显式 mono 栈（`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`） |

### 3.4 字体

- `@fontsource/inter`（OFL）引入 latin 400/500/600 三档 woff2（font-display: swap）；中文回落 PingFang/雅黑。
- id/code/时间/数字：等宽栈 + `tabular-nums`。

## 4. 实施阶段（每阶段独立 commit，可 git revert 单段回滚）

### 阶段 1 —— 全局 token 落地
1. main.tsx：seed token 全表（3.1）+ 组件 token（3.2）+ **删 `inkBarWidth: 3`**。
2. api.tsx 不改签名对齐：`SHADOW`/`GRAY`/`SEM` 值与 token 同源、`TAB_TILE_CSS` hover 色 token 化 + `tabular-nums` 注入、CodeBlock/CommandChip mono 栈。
3. 引 `@fontsource/inter`（main.tsx import 三档）。
- **验收**：`pnpm build` 过；`dshctl-selftest` 150 断言零影响；清单 md5 零变化；观感三项——背景分层、灰字可读、卡边变「实」。

### 阶段 2 —— 原子件升级 + 三标杆页
1. api.tsx 按 3.3 表逐项改（PageHead/StatBand/StateDot/StatusRow + 新增 `EmptyState`）。
2. 标杆页重刷：**Dashboard**（StatTile 收敛、空态换 EmptyState、快捷入口 hover 加边）、**Upgrade**（verdict 大字改深档色）、**Domains**（Chip 三件套下沉 api.tsx、空态替换、hover 0.15s）。
3. 其余页（Plugins/Registry/Manual/画布）本轮**不逐页重刷**——原子件与 token 改完全站自动受益。
- **验收**：build + self-test + check PASS；重启 8780；观感五项自检；清单 md5 零变化；截图/点按拍板交用户；commit。

### 阶段 3（可选，待拍板）
逐页清剩余 inline 字面量灰、Plugins 869 行逐页精修、Manual 长句收纳、画布 10px 边标。**不默认执行。**

## 5. 验收清单（阶段 1+2 合并口径）

1. `pnpm build` 过；`tsc --noEmit` 过滤仅存量错误 + 标识符扫描。
2. `dshctl-selftest` **150 断言 ALL PASSED**；`dshctl check ops --ci` PASS。
3. 重启 8780 → 200；`/api/plugins/core` 61/5/5。
4. 观感五项：背景三级可辨 / 次文字 ≥4.5:1 / 卡片零阴影+1px 边 / 主按钮近黑+accent 蓝退点缀 / 数字 tabular 对齐。
5. 清单 md5 零变化（plugin-registry + capability-packs + domain.yml；排除 check 自回写两文件）。
6. 截图对比与点按拍板交用户（无浏览器后端，降级先例）。
7. commit（dshctl 仓：main.tsx / api.tsx / Dashboard.tsx / Upgrade.tsx / Domains.tsx / package.json；doc/ 仓外）。

## 6. 明确不做

- **不换组件库、不迁库**；不引 framer-motion；**不引第二图标库**（与 @antd 实心混用=两套语言更廉价；若换须整站一次换）。
- `wireframe: true` 不用；全局 `compactAlgorithm` 不用。
- 暗色模式本期不做（阶段 1 起颜色必须走 token/GRAY 常量，为暗色留后路）。
- 阶段 3 不默认执行；不动替换 Drawer 逻辑、引擎、server、self-test。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 组件级 token 覆盖不全漏改 | 验收五项自检 + 截图逐页过 |
| GRAY/SEM 改值牵动 47 处引用 | 有意的全局替换；阶段 1 单独 commit，不满意整段 revert |
| Inter 加载闪烁/包体 | font-display swap + 仅 latin 子集；失败回退系统栈 |
| 黑按钮+蓝 accent 突兀 | Linear/Geist 既定 DNA；不适则回退 `Button.colorPrimary` 一行即恢复蓝按钮 |
| GUI 无 self-test 覆盖 | 每阶段独立 commit + 五项自检 + 用户拍板后进下一阶段 |

## 8. 回填记录

- 2026-09-18：方案成稿（三线调研）→ 用户批准，状态 `已评审，开始实施`。
- 2026-09-18 **阶段 1 已实施 + 验收**（commit `7f31ff7`）：main.tsx seed+组件 token 全表（背景三级/文字三档/圆角 6-12/ring 阴影/motion 0.15-0.25）+ **Button 主按钮近黑 `#18181b`** + `@fontsource/inter` latin 400/500/600 自托管子集（build 内 3×24KB woff2 + font-display swap）；api.tsx `GRAY/SEM/SHADOW/cardStyle` 值对齐 token（SHADOW.card=`none`，卡零影）+ 新增 `SEM_TEXT` 深档 + `MONO` 等宽栈（CodeBlock/CommandChip 接入）+ `TAB_TILE_CSS` hover 走 `var(--ant-color-primary-hover)` + 全局 tabular-nums 注入。**踩坑 1 处**：症状→ Tabs token 报 `inkBarHeight 不存在`；根因→ antd v6 Tabs ComponentToken 只有 `inkBarColor/itemSelectedColor/itemHoverColor`，粗细不是 token（原 `inkBarWidth:3` 本就是无效覆盖+存量类型错）；修复→ 删粗细项只留三色 token（antd 默认 ink bar 2px 已达标）。验收：build 过、tsc 过滤 main/api 仅存量 TS5097、self-test **150 ALL PASSED**、清单 md5 零变化。
- 2026-09-18 **阶段 2 已实施 + 验收**（commit `e7163c8`）：api.tsx——PageHead 磁贴渐变+投影→ **tinted 底 `${iconColor}14` + 彩色图标**、分隔线渐变→hairline；StatBand 面板底分层+数字 `tabular-nums`；StatusRow 文字 `GRAY.text`；`card-hover:hover` 加边框加深 `#d0d3d8`；**新增 `StatusChip`**（Domains Tagish 三件套下沉复用）与 **`EmptyState`**（图标+14 标题+13 副文+主动作）。三标杆页——Dashboard：StatTile 渐变磁贴→tinted+数字 tabular、健康值 `SEM_TEXT` 深档、空态→EmptyState（带 CTA）、快捷入口/提示接 GRAY；Upgrade：verdict 大字三态改 `SEM_TEXT` 深档（#1b7a43/#cf222e/#b8860b）、空态→EmptyState（运行对账 CTA）、新增计数 tabular+深档；Domains：主从空态→EmptyState（新建领域 CTA）、行 hover 0.12→0.15s。验收（live 实测）：build 过、四文件标识符扫描零未解析（api `SKILL` 为字符串假阳性）、tsc 过滤仅存量错、self-test **150 ALL PASSED**、`check ops --ci` 0/0 PASS、重启 8780 GET / 200、`/api/plugins/core` 61/5、清单 md5 `6cb88103…`/`9cac84a2…` 零变化；bundle 五项自检——新标记 `#1b7a43/#cf222e/#b8860b`、`#18181b/#27272a`、`#fafafa`×3、ring 阴影×2、EmptyState 三标题、`tabular-nums`×4、Inter woff2×3 进构建；旧标记 `inkBarWidth`/`0 4px 14px…0.08` 归零；PageHead/StatTile 线性 gradient 归零（残留 `linear-gradient(135deg` ×2 = 替换 Drawer/核心详情头像——本轮明确不动的视觉锚点）。**遗留（=阶段 3 待拍板）**：`#8c96a6` 字面量残留 20 处（App/DomainDetail/Domains InfoItem/Manual/NewDomain/Canvas/Plugins——非标杆页，grep 中 api/main 的 2 处为注释）；Domains 页内 Tab 空态（点击运行提示）与 Plugins/Registry 未逐页重刷。观感拍板交用户（无浏览器后端降级先例）。
- 状态：**✅ 已实施 + 验收结果回填（阶段 1+2）**；阶段 3 待拍板。
