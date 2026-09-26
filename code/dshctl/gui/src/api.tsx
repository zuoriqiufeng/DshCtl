import { Tag, Typography, Collapse, Tooltip, Card, Popover, Button, Space } from 'antd'
import { InfoCircleOutlined, CodeOutlined, InboxOutlined } from '@ant-design/icons'
import type { ReactNode, CSSProperties } from 'react'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Spec = Record<string, any>

/** 版本号唯一来源（Sider Tag / Footer 同源引用） */
export const VERSION = 'v1.7'

/** 阴影两档（与 main.tsx seed token 同源；卡零影——hairline 承重，hover 叠 ring） */
export const SHADOW = { card: 'none', hover: '0 0 0 1px rgba(0,0,0,.06), 0 1px 2px rgba(16,24,40,.06)' }

/** 中性灰阶（全站唯一中性色来源；值与 main.tsx token 对齐——Linear/Geist 浅色控制台） */
export const GRAY = { text: '#1a1d21', sub: '#5c6470', weak: '#8a9099', faint: '#c2c7cd', border: '#e3e5e8', line: '#eef0f1', bg: '#fafafa', panel: '#f4f5f6' } as const

/** 语义色。规则：橙黄只此两值——填充 #faad14 / 文字-on-light #d48806；橙只留 #fa8c16；
 *  状态色作文字时用深档（SEM.text.*，≥4.5:1），亮档只做点/底 */
export const SEM = { primary: '#1677ff', success: '#52c41a', warningFill: '#faad14', warningText: '#d48806', error: '#ff4d4f', orange: '#fa8c16', purple: '#722ed1', cyan: '#13c2c2' } as const
export const SEM_TEXT = { success: '#1b7a43', warning: '#b8860b', error: '#cf222e', primary: '#155ac6' } as const

/** 字号阶（全站只用这 8 档） */
export const FONT_SIZE = { xs: 11.5, sm: 12, base: 13, md: 14, lg: 15, xl: 18, xxl: 22, num: 26 } as const

const KEY_STORE = 'dshctl-gui-key'

/** 容错粘贴：首尾空白、整行 `DSHCTL_GUI_KEY=...`、引号包裹都归一成纯 key */
function normalizeKey(k: string): string {
  let s = k.trim()
  if (s.startsWith('DSHCTL_GUI_KEY=')) s = s.slice('DSHCTL_GUI_KEY='.length).trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1).trim()
  return s
}

function authHeaders(): Record<string, string> {
  const k = localStorage.getItem(KEY_STORE)
  return k ? { Authorization: `Bearer ${k}` } : {}
}

export function setGuiKey(k: string): void { localStorage.setItem(KEY_STORE, normalizeKey(k)) }

/** 401 时引导输入 key 并重试一次（仅配置了 --key / DSHCTL_GUI_KEY 的部署会遇到）。
 * 并发请求共享同一次弹窗（页面加载会并发打多个 API，各自弹窗会形成"输不完"的假死）；
 * 重试仍 401 → 不再弹，把错误交给页面展示（key 不对就该让用户看清原因）。 */
let keyPrompt: Promise<string | null> | null = null
function promptForKey(): Promise<string | null> {
  if (!keyPrompt) {
    keyPrompt = Promise.resolve(window.prompt('GUI 鉴权：粘贴访问 Key（dshctl- 开头；整行 DSHCTL_GUI_KEY=... 也可以）') ?? '')
      .finally(() => { setTimeout(() => { keyPrompt = null }, 0) })
  }
  return keyPrompt
}

async function apiOnce<T>(path: string, opts?: RequestInit): Promise<{ data: T; equivalentCommand?: string; error?: string; errors?: string[]; hint?: string }> {
  const r = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts?.headers ?? {}) } })
  return r.json()
}

export async function api<T>(path: string, opts?: RequestInit): Promise<{ data: T; equivalentCommand?: string; error?: string; errors?: string[]; hint?: string }> {
  let r = await apiOnce<T>(path, opts)
  if (r.error?.startsWith('unauthorized')) {
    const k = await promptForKey()
    if (k) { setGuiKey(k); r = await apiOnce<T>(path, opts) }
  }
  return r
}

/** 统一卡片风格：白底 1px hairline + 零阴影（Linear/Geist 范式——层次靠边框与背景色差） */
export const cardStyle: CSSProperties = { border: '1px solid #e3e5e8', borderRadius: 12, boxShadow: 'none' }
export const cardBodyStyle: CSSProperties = { padding: 20 }

/** 统一卡片（带控制台风风格） */
export function PageCard({ children, size, title, extra, style }: { children: ReactNode; size?: 'small' | 'default'; title?: ReactNode; extra?: ReactNode; style?: CSSProperties }) {
  return (
    <Card size={size ?? 'default'} style={{ ...cardStyle, ...style }} styles={{ body: { padding: size === 'small' ? 16 : 20 } }}
      {...(title != null ? { title, extra } : {})}>{children}</Card>
  )
}

/** 等宽栈（id/代码/命令/时间统一——Geist/Datadog 同款；数字另配 tabular-nums 见 TAB_TILE_CSS） */
export const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/** 弱化样式的等价命令 chip（可复制；mono + hairline） */
export function CommandChip({ cmd }: { cmd: string }) {
  if (!cmd) return null
  return (
    <Typography.Text code copyable style={{ fontFamily: MONO, color: '#5c6470', background: '#f4f5f6', border: '1px solid #eef0f1', fontSize: 12 }}>
      {cmd}
    </Typography.Text>
  )
}

const LEVEL_META: Record<string, { color: string; label: string }> = {
  pass: { color: 'success', label: '通过' },
  ok: { color: 'success', label: '正常' },
  warn: { color: 'warning', label: '警告' },
  error: { color: 'error', label: '错误' },
  fail: { color: 'error', label: '失败' },
}

/** 状态点：圆点 + 同色光环 + 可选文字（全站状态点唯一实现；text 与 children 等价） */
export function StateDot({ level, size = 8, text, children }: { level: string; size?: number; text?: ReactNode; children?: ReactNode }) {
  const color = level === 'pass' || level === 'ok' ? SEM.success : level === 'warn' ? SEM.warningFill : level === 'error' || level === 'fail' ? SEM.error : level === 'info' ? SEM.primary : '#d9d9d9'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_SIZE.base }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: color, boxShadow: `0 0 0 3px ${color}22`, flexShrink: 0 }} />
      {text ?? children}
    </span>
  )
}

/** 级别徽章：圆点 + 中文标签（内部复用 StateDot） */
export function LevelDot({ level, counts }: { level: string; counts?: string }) {
  const label = LEVEL_META[level]?.label ?? level
  return (
    <StateDot level={level} text={<>{label}{counts && <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>{counts}</Typography.Text>}</>} />
  )
}

/** 统一代码块（pre；mono 栈显式指定） */
export function CodeBlock({ children, maxHeight }: { children: ReactNode; maxHeight?: number }) {
  return (
    <pre style={{
      fontFamily: MONO, background: GRAY.panel, border: `1px solid ${GRAY.line}`, borderRadius: 8, padding: 12,
      fontSize: FONT_SIZE.sm, margin: 0, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      ...(maxHeight ? { maxHeight } : {}),
    }}>{children}</pre>
  )
}

/** 页面 hero 头：大标题 + 描述 + 底部细分隔线 + 右侧操作区 */
export function PageHead({ title, desc, cmd, cmds, extra, icon, iconColor = '#1677ff' }: {
  title: string; desc?: string; cmd?: string; cmds?: string[]; extra?: ReactNode; icon?: ReactNode; iconColor?: string
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', minWidth: 0 }}>
          {icon && (
            <div style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: `${iconColor}14`,        // tinted 底（去渐变去投影——Linear/Geist 磁贴手法）
              color: iconColor, fontSize: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{icon}</div>
          )}
          <div style={{ minWidth: 0 }}>
            <Typography.Title level={3} style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: 0.2 }}>{title}</Typography.Title>
            {desc && <Typography.Text type="secondary" style={{ fontSize: 13 }}>{desc}</Typography.Text>}
          </div>
        </div>
        <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!!(cmds?.length || cmd) && (
            <Popover trigger="click" placement="bottomRight" content={
              <Space direction="vertical" size={6} style={{ maxWidth: 460 }}>
                {(cmds?.length ? cmds : [cmd!]).filter(Boolean).map((c) => <CommandChip key={c} cmd={c} />)}
              </Space>
            }>
              <Button size="small" icon={<CodeOutlined />}>等价命令</Button>
            </Popover>
          )}
          {extra}
        </div>
      </div>
      <div style={{ height: 1, background: GRAY.line, margin: '14px 0 0' }} />
    </div>
  )
}

/** 大数字指标带：横排若干指标（数字 26px tabular + 小灰标签；L2 面板底分层） */
export function StatBand({ items }: { items: Array<{ label: string; value: ReactNode; color?: string; sub?: ReactNode }> }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 0, background: GRAY.panel, border: `1px solid ${GRAY.border}`,
      borderRadius: 12, padding: '14px 8px', marginBottom: 16,
    }}>
      {items.map((it, i) => (
        <div key={i} style={{
          flex: '1 1 120px', minWidth: 120, padding: '0 20px',
          borderLeft: i === 0 ? 'none' : `1px solid ${GRAY.line}`,
        }}>
          <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2, color: it.color ?? GRAY.text, fontVariantNumeric: 'tabular-nums' }}>{it.value}</div>
          <div style={{ fontSize: 12, color: GRAY.sub, marginTop: 2 }}>{it.label}</div>
          {it.sub && <div style={{ fontSize: 12, color: GRAY.weak }}>{it.sub}</div>}
        </div>
      ))}
    </div>
  )
}

/** check 历史点阵：最近 n 次结果的绿/黄/红小圆点 */
export function HistoryDots({ entries }: { entries: Array<{ result: string }> }) {
  if (!entries.length) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>暂无历史</Typography.Text>
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {entries.map((e, i) => (
        <Tooltip key={i} title={`${e.result === 'pass' ? '通过' : e.result === 'warn' ? '警告' : '失败'}`}>
          <span style={{
            width: 9, height: 9, borderRadius: '50%',
            background: e.result === 'pass' ? '#52c41a' : e.result === 'warn' ? '#faad14' : '#ff4d4f',
            opacity: e.result === 'pass' ? 0.85 : 1,
          }} />
        </Tooltip>
      ))}
    </span>
  )
}

/** R1-R12 规则一句话图例（折叠） */
const RULES: Array<[string, string]> = [
  ['R1', '端口与登记：domain 唯一、api/gui 端口不冲突、被占用端口与本实例 unit 自证'],
  ['R2', '上游存在性：清单里每个 disable/override id 在新版 roster 仍存在（消失=上游改名，裁剪静默失效）'],
  ['R3', '上游新增：新版多出且未被能力包覆盖的行——人工评估该裁剪还是保留'],
  ['R4', 'script 白名单：勾了 script 能力包必须配 guard.whitelist.commands（裸 bash 禁止）'],
  ['R5', '契约覆盖：contracts.media_dirs 必须 ⊆ write_paths（Agent 写得出、契约读得到）'],
  ['R6', 'skills 合法：skills_dirs 存在且含带 name+description frontmatter 的 SKILL.md'],
  ['R7', '超时合理：turn_timeout_sec ≥ max_task_duration_sec（防任务时长被超时截断）'],
  ['R8', '密钥红线：api_key_env 只准是环境变量名，禁止明文密钥进清单'],
  ['R9', '依赖探活：shared_deps 各 url 可达（冷启动前 warn 正常）'],
  ['R10', '归层缺口：现状 patch 有、能力包清单无的 id——交人工归层'],
  ['R11', '核心功能不可缺：无槽 core id 禁用即报错；功能槽（slot）内有活跃成员可豁免替换'],
  ['R12', '插件库对齐：领域插件未入库/path 漂移报错；git/zip 导入件未信任出 warn'],
]

export function RuleLegend() {
  return (
    <Collapse size="small" style={{ marginTop: 12 }} items={[{
      key: 'legend',
      label: <Typography.Text type="secondary" style={{ fontSize: 13 }}>规则图例（R1-R12 各查什么）</Typography.Text>,
      children: (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '4px 16px' }}>
          {RULES.map(([r, d]) => (
            <div key={r} style={{ fontSize: 13 }}>
              <Typography.Text code strong>{r}</Typography.Text>{' '}
              <Typography.Text type="secondary">{d}</Typography.Text>
            </div>
          ))}
        </div>
      ),
    }]} />
  )
}

/** 步骤徽标（圆形序号） */
export function StepBadge({ n, color = '#1677ff' }: { n: number | string; color?: string }) {
  return (
    <span style={{
      width: 24, height: 24, borderRadius: '50%', background: color, color: '#fff',
      fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>{n}</span>
  )
}

export { Tag }


/** 静态说明标准载体：ⓘ 悬浮（替代大色块 Alert） */
export function Hint({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Tooltip title={<span style={{ maxWidth: 360, display: 'inline-block' }}>{children ?? title}</span>}>
      <InfoCircleOutlined style={{ color: '#b0bac7', fontSize: 13, cursor: 'help', marginLeft: 4 }} />
    </Tooltip>
  )
}

/** 轻状态行：色点 + 一句话（+右侧附加），替代 Alert 大色块 */
export function StatusRow({ tone, text, extra }: { tone: 'success' | 'warning' | 'error' | 'info'; text: ReactNode; extra?: ReactNode }) {
  const color = tone === 'success' ? SEM.success : tone === 'warning' ? SEM.warningFill : tone === 'error' ? SEM.error : SEM.primary
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '2px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 0 3px ${color}1c` }} />
      <span style={{ color: GRAY.text }}>{text}</span>
      {extra}
    </div>
  )
}

/** 状态 chip 三件套：muted 底 + 深字 + 同色细边（GitHub/Supabase 语义色成对范式；Domains Tagish 下沉复用） */
export function StatusChip({ children, tone }: { children: ReactNode; tone?: 'red' | 'orange' | 'green' }) {
  const c = tone === 'red' ? { bg: '#fff1f0', fg: '#cf1322', bd: '#ffa39e' }
    : tone === 'orange' ? { bg: '#fff7e6', fg: '#d46b08', bd: '#ffd591' }
      : tone === 'green' ? { bg: '#f6ffed', fg: '#389e0d', bd: '#b7eb8f' }
        : { bg: GRAY.panel, fg: GRAY.sub, bd: GRAY.border }
  return <span style={{ fontSize: FONT_SIZE.sm, padding: '1px 8px', borderRadius: 6, background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>{children}</span>
}

/** 空态四件套：图标 + 14 标题 + 13 副文 + 主动作（替代 antd 默认 Empty 的灰插画一行字） */
export function EmptyState({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '36px 16px', textAlign: 'center' }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, background: GRAY.panel, border: `1px solid ${GRAY.line}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: GRAY.weak, fontSize: 20,
      }}>{icon ?? <InboxOutlined />}</div>
      <Typography.Text strong style={{ fontSize: FONT_SIZE.md }}>{title}</Typography.Text>
      {desc && <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.base, maxWidth: 380 }}>{desc}</Typography.Text>}
      {action}
    </div>
  )
}

/** 统一 Tabs 视觉（card 风格圆角）——各页签共用 */
export const TABS_STYLE: CSSProperties = { borderRadius: 10 }

/** 磁贴页签 label：图标 + 标题 + 副文案（active 态由全局 CSS 提供） */
export function TabTile({ icon, title, sub, color = '#1677ff' }: { icon: ReactNode; title: string; sub?: string; color?: string }) {
  return (
    <span className="tab-tile" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '2px 6px' }}>
      <span className="tab-tile-icon" style={{
        width: 30, height: 30, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 15, color, background: `${color}14`,
      }}>{icon}</span>
      <span style={{ textAlign: 'left', lineHeight: 1.25 }}>
        <span className="tab-tile-title" style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#16202b' }}>{title}</span>
        {sub && <span className="tab-tile-sub" style={{ display: 'block', fontSize: 11.5, color: GRAY.weak }}>{sub}</span>}
      </span>
    </span>
  )
}

/** TabTile 激活态 + card-hover/card-lift 全局样式（注入一次；hover 色走 token CSS 变量 + 数字 tabular） */
export const TAB_TILE_CSS = `
.tab-tile-title, .tab-tile-sub { transition: color .15s; }
.ant-tabs-tab-active .tab-tile-title { color: var(--ant-color-primary, #1677ff) !important; }
.ant-tabs-tab:hover .tab-tile-title { color: var(--ant-color-primary-hover, #4096ff); }
.ant-tabs-top > .ant-tabs-nav { margin-bottom: 14px; }
.ant-tabs-tab { padding: 8px 4px !important; }
.card-hover { transition: box-shadow .15s, border-color .15s; }
.card-hover:hover { box-shadow: ${SHADOW.hover}; border-color: #d0d3d8; }
.card-lift { transition: box-shadow .15s, transform .15s; }
.card-lift:hover { transform: translateY(-2px); box-shadow: ${SHADOW.hover}; }
/* 数字/统计全局 tabular（Geist/Grafana 同款——大数字与计数列滚动对齐） */
.ant-statistic-content-value, [data-tabular] { font-variant-numeric: tabular-nums; }
`
