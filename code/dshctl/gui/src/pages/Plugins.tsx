import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Tabs, Tag, Space, Typography, Input, Button, Popconfirm, message, Select, Upload, Empty, Skeleton, Drawer, Segmented, Tooltip, Switch, Collapse } from 'antd'
import { ReloadOutlined, PlusOutlined, SafetyCertificateOutlined, ImportOutlined, AppstoreOutlined, CloudUploadOutlined, GithubOutlined, DeleteOutlined, SearchOutlined, DatabaseOutlined, SafetyCertificateTwoTone, FolderAddOutlined, FileZipOutlined, ExportOutlined, SwapOutlined, CheckOutlined } from '@ant-design/icons'
import { api, PageHead, PageCard, CommandChip, Hint, TabTile, StateDot, StatusRow, StepBadge, CodeBlock, SHADOW, GRAY, SEM, FONT_SIZE } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Plugin = { id: string; name?: string; description?: string; tier?: string; category?: string; source?: string; path: string; trusted: boolean; added_at?: string; depends_on?: string[]; provides?: string[] }
type CoreEntry = { id: string; slot?: string; group?: string; desc?: string }
/** /api/replace 契约（与 dshctl replace 同源引擎） */
type DiffLine = { t: 'ctx' | 'add' | 'del'; s: string }
type ReplaceChange = { file: string; label: string; action: string; hunks: { lines: DiffLine[] } }
type RepStep = { action: string; file?: string }
type RepPlanState = { steps: RepStep[]; warnings: string[]; errors: string[]; changes: ReplaceChange[]; equivalentCommand?: string }
type RepDoneState = { ok: boolean; steps: RepStep[]; r11?: string; rollbackGuide?: string; errors?: string[]; rolledBack?: boolean; equivalentCommand?: string }
type SlotsMap = Record<string, { desc?: string; members: string[] }>

/** 目录分组：已知分类有序展示，未知归「其他」 */
const CATEGORY_ORDER = ['知识网', '对外 API', '技能管理']
const CATEGORY_COLOR: Record<string, string> = { '知识网': '#13c2c2', '对外 API': '#1677ff', '技能管理': '#722ed1' }
const catColor = (c: string) => CATEGORY_COLOR[c] ?? GRAY.weak

/** 正方形层次卡：色带头像 + 单行 id/描述省略 + 分隔线底条（全文点详情看） */
function PluginTile({ p, onClick }: { p: Plugin; onClick: () => void }) {
  const color = catColor(p.category ?? '')
  const initial = (p.id[0] ?? '?').toUpperCase()
  return (
    <div title={p.description} onClick={onClick} className="card-lift" style={{
      aspectRatio: '1', overflow: 'hidden', display: 'flex', flexDirection: 'column',
      background: p.trusted ? '#fff' : '#fffbef', border: '1px solid #eef1f6',
      borderLeft: `4px solid ${p.trusted ? '#52c41a' : '#fa8c16'}`, borderRadius: 10,
      boxShadow: SHADOW.card, cursor: 'pointer', minWidth: 0, padding: 0,
    }}>
      {/* 第 1 层：分类色带头像 */}
      <div style={{
        padding: 14, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
        background: `${color}0f`,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${color}1f`, color, fontSize: 19, fontWeight: 600,
          boxShadow: '0 0 0 3px #fff, 0 2px 8px rgba(16,24,40,0.08)',
        }}>{initial}</div>
        {p.category && (
          <Tag style={{ marginInlineEnd: 0, fontSize: 11.5, color, background: '#ffffffcc', borderColor: `${color}55`, lineHeight: '18px' }}>
            {p.category}
          </Tag>
        )}
      </div>
      {/* 第 2 层：id + 描述单行省略（悬停 title 全文，点击开详情） */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '2px 14px 10px' }}>
        <Typography.Text strong style={{ fontSize: 14, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.id}</Typography.Text>
        <Typography.Text type="secondary" style={{
          fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 3,
        }}>{p.description ?? '未填描述'}</Typography.Text>
      </div>
      {/* 第 3 层：分隔线底条 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexShrink: 0,
        borderTop: '1px solid #eef1f6', padding: '8px 14px 10px',
      }}>
        <Tag style={{ marginInlineEnd: 0, fontSize: 11.5, color: '#5b6575', background: '#f7f9fc', border: '1px solid #eef1f6' }}>
          能力 ×{p.provides?.length ?? 0}
        </Tag>
        <StateDot level={p.trusted ? 'ok' : 'warn'} size={7} />
      </div>
    </div>
  )
}

/** 分节卡统一语汇：3px 左色条（DomainForm secStyle 同款） */
const secCard = (color: string): CSSProperties => ({
  border: '1px solid #e5e9f0', borderLeft: `3px solid ${color}`, borderRadius: 12,
  boxShadow: SHADOW.card, padding: '12px 14px', background: '#fff',
})

/** 平铺节标题（右详情内容区用——12/600 灰 + 微字距，替代卡中卡） */
const secTitleStyle: CSSProperties = {
  fontSize: FONT_SIZE.sm, fontWeight: 600, color: GRAY.sub, letterSpacing: '0.02em', marginBottom: 6,
}

/** 分节卡标题行：圆序号 + 标题 + 副文案 */
function SecHead({ num, title, desc, color }: { num: number; title: string; desc?: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
      <StepBadge n={num} color={color} />
      <Typography.Text strong style={{ fontSize: FONT_SIZE.base }}>{title}</Typography.Text>
      {desc && <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>{desc}</Typography.Text>}
    </div>
  )
}

/** 行级 diff 卡：每文件一张（+ 绿底 / − 红底 / ctx 灰；站内无 diff 先例，手写单 hunk 渲染） */
function DiffView({ changes }: { changes: ReplaceChange[] }) {
  if (!changes.length) return null
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {changes.map((c) => {
        const adds = c.hunks.lines.filter((l) => l.t === 'add').length
        const dels = c.hunks.lines.filter((l) => l.t === 'del').length
        return (
          <div key={c.file} style={{ border: `1px solid ${GRAY.line}`, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 10px', background: GRAY.panel, borderBottom: `1px solid ${GRAY.line}` }}>
              <span style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Typography.Text code style={{ fontSize: FONT_SIZE.xs }}>{c.label}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.action}</Typography.Text>
              </span>
              <Space size={4} styles={{ item: { flexShrink: 0 } }}>
                {!!adds && <Tag color="green" style={{ marginInlineEnd: 0, fontSize: FONT_SIZE.xs, lineHeight: '15px' }}>+{adds}</Tag>}
                {!!dels && <Tag color="red" style={{ marginInlineEnd: 0, fontSize: FONT_SIZE.xs, lineHeight: '15px' }}>−{dels}</Tag>}
              </Space>
            </div>
            <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: FONT_SIZE.xs, overflowX: 'auto' }}>
              {c.hunks.lines.map((l, i) => (
                <div key={i} style={{
                  padding: '1px 10px', whiteSpace: 'pre', lineHeight: 1.55,
                  background: l.t === 'add' ? '#f6ffed' : l.t === 'del' ? '#fff2f0' : 'transparent',
                  color: l.t === 'ctx' ? GRAY.weak : GRAY.text,
                  borderLeft: `2px solid ${l.t === 'add' ? '#b7eb8f' : l.t === 'del' ? '#ffccc7' : 'transparent'}`,
                }}>{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}{l.s || ' '}</div>
              ))}
            </div>
          </div>
        )
      })}
    </Space>
  )
}

/** 方法卡：标题 + 什么时候用 + 编号指引 + 内嵌表单 */
function MethodCard({ color, icon, title, use, steps, children }: {
  color: string; icon: React.ReactNode; title: string; use: string; steps: string[]; children: React.ReactNode
}) {
  return (
    <PageCard style={{ height: '100%' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{
          width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${color}14`, color, fontSize: 17,
        }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 15 }}>{title}</Typography.Text>
          <div style={{ fontSize: 12, color: GRAY.weak }}>{use}</div>
        </div>
      </div>
      <div style={{ background: '#f7f9fc', border: '1px solid #eef1f6', borderRadius: 8, padding: '10px 14px', margin: '16px 0' }}>
        {steps.map((s, i) => (
          <div key={i} style={{ fontSize: 12.5, color: '#5b6575', lineHeight: 1.8 }}>
            <span style={{ color, fontWeight: 600 }}>{i + 1}.</span> {s}
          </div>
        ))}
      </div>
      {children}
    </PageCard>
  )
}

/** 核心清单行：只留 id + 槽态青点，描述全文悬停披露（Tooltip 0.3s 延迟）；
 *  选中 = 蓝底 + 左竖条 + id 加粗（无描边抖动），hover 与 Domains 同源配方 */
function CoreRow({ e, active, onClick }: { e: CoreEntry; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const tip = (
    <div style={{ maxWidth: 320 }}>
      <div>{e.desc || e.id}</div>
      {e.slot && <div style={{ marginTop: 4, color: '#b0bac7' }}>功能槽 {e.slot}——同槽另一成员活跃即可禁旧（R11 豁免）</div>}
    </div>
  )
  return (
    <Tooltip title={tip} placement="right" mouseEnterDelay={0.3}>
      <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 32, minWidth: 0, marginBottom: 2,
          padding: '0 8px', borderRadius: 8, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box',
          background: active ? '#eef4ff' : hover ? '#f7f9fc' : 'transparent',
          boxShadow: active ? 'inset 3px 0 0 #1677ff' : undefined,
          transition: 'background .12s, box-shadow .12s',
        }}>
        <Typography.Text code style={{ fontSize: FONT_SIZE.base, fontWeight: active ? 600 : 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.id}</Typography.Text>
        {e.slot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: SEM.cyan, flexShrink: 0 }} />}
      </div>
    </Tooltip>
  )
}

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [core, setCore] = useState<CoreEntry[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [pubDomain, setPubDomain] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [trustFilter, setTrustFilter] = useState<string>('全部')
  const [catFilter, setCatFilter] = useState<string>('全部')
  const [form, setForm] = useState({ id: '', path: '', name: '', description: '' })
  const [detail, setDetail] = useState<Plugin | null>(null)
  // 核心功能主从：左清单点选 → 右详情（唯一「替换…」入口）
  const [coreSel, setCoreSel] = useState<string | null>(null)
  const [coreQ, setCoreQ] = useState('')
  // 替换通道（与 CLI dshctl replace 同源引擎）
  const [repFor, setRepFor] = useState<CoreEntry | null>(null)
  const [rep, setRep] = useState({ newId: '', path: '', domain: 'ops', keepOld: false })
  const [repBusy, setRepBusy] = useState(false)
  /** 当前忙的是执行（true）还是预演（false）——只给底条按钮区分 loading */
  const [repExec, setRepExec] = useState(false)
  const [repPlan, setRepPlan] = useState<RepPlanState | null>(null)
  const [repDone, setRepDone] = useState<RepDoneState | null>(null)
  const [repStale, setRepStale] = useState(false)
  const [slots, setSlots] = useState<SlotsMap>({})
  /** 请求序号：表单连打时丢弃过期 dry_run / 执行响应 */
  const seqRef = useRef(0)
  const runRef = useRef<(dryRun: boolean, auto?: boolean) => void>(() => {})

  const load = async () => {
    setLoading(true)
    const [a, b, c] = await Promise.all([api<Plugin[]>('/api/plugins'), api<{ core: CoreEntry[]; slots?: SlotsMap }>('/api/plugins/core'), api<string[]>('/api/domains')])
    setPlugins(a.data ?? [])
    setCore(b.data?.core ?? [])
    setSlots(b.data?.slots ?? {})
    setDomains(c.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  const add = async () => {
    const r = await api('/api/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (r.error) message.error(r.error)
    else { message.success(`已收编 ${form.id}`); setForm({ id: '', path: '', name: '', description: '' }); load() }
  }
  const del = async (id: string) => {
    const r = await api(`/api/plugins/${id}`, { method: 'DELETE' })
    if (r.error) message.error(r.error); else { message.success(`已移除 ${id}（源码未动）`); setDetail(null); load() }
  }
  const trust = async (id: string, trusted: boolean) => {
    const r = await api(`/api/plugins/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trusted }) })
    if (r.error) message.error(r.error); else { message.success(`${id} trusted=${trusted}`); setDetail(null); load() }
  }
  const publish = async () => {
    if (!pubDomain) { message.warning('先选领域'); return }
    const r = await api('/api/plugins/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: pubDomain }) })
    if (r.error) message.error(r.error)
    else {
      const d = r.data as { added: string[]; skipped: string[] }
      message.success(`publish ${pubDomain}：新入库 ${d.added.join(', ') || '（无）'}；跳过 ${d.skipped.join(', ') || '（无）'}`, 6)
      load()
    }
  }
  const [zipFile, setZipFile] = useState<File | null>(null)
  const uploadZip = async () => {
    if (!zipFile) { message.warning('先选 zip'); return }
    if (!form.id) { message.warning('先填 id'); return }
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
      fr.onerror = reject
      fr.readAsDataURL(zipFile)
    })
    const r = await api('/api/plugins/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: form.id, name: form.name || undefined, description: form.description || undefined, zip_base64: b64 }),
    })
    if (r.error) message.error(r.error)
    else { message.success(`zip 已导入 ${form.id}（untrusted——核实后在详情里点信任）`, 6); setZipFile(null); setForm({ id: '', path: '', name: '', description: '' }); load() }
  }
  const [git, setGit] = useState({ id: '', url: '', ref: '' })
  const importGit = async () => {
    if (!git.id || !git.url) { message.warning('先填 id 与 url'); return }
    const r = await api('/api/plugins/import-git', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: git.id, url: git.url, ref: git.ref || undefined }),
    })
    if (r.error) message.error(r.error)
    else { message.success(`git 已导入 ${git.id}（untrusted）`, 6); setGit({ id: '', url: '', ref: '' }); load() }
  }
  const closeReplace = () => {
    seqRef.current++ // 丢弃在途预演/执行响应
    setRepFor(null); setRepPlan(null); setRepDone(null); setRepStale(false); setRepBusy(false)
  }
  const openReplace = (e: CoreEntry) => {
    seqRef.current++
    setRepFor(e)
    setRep({ newId: '', path: '', domain: domains[0] ?? 'ops', keepOld: false })
    setRepPlan(null); setRepDone(null); setRepStale(false)
  }
  /** 表单任意变更：执行结果失效 + 预演标过期（debounce effect 接手重跑） */
  const setRepField = (patch: Partial<typeof rep>) => {
    setRep((r) => ({ ...r, ...patch }))
    setRepDone(null)
    setRepStale(true)
  }
  const runReplaceApi = async (dryRun: boolean, auto = false): Promise<void> => {
    if (!repFor) return
    if (!rep.newId || rep.newId === repFor.id) {
      if (!auto) message.warning(rep.newId ? '新件与旧件相同' : '先填新件 id')
      return
    }
    const my = ++seqRef.current
    setRepBusy(true)
    setRepExec(!dryRun)
    try {
      const r = await api<{ steps?: RepStep[]; warnings?: string[]; changes?: ReplaceChange[]; dryRun?: boolean; r11?: string; rollbackGuide?: string }>('/api/replace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          old_id: repFor.id, new_id: rep.newId, domain: rep.domain,
          keep_old: rep.keepOld || undefined, path: rep.path || undefined,
          dry_run: dryRun || undefined,
        }),
      })
      if (my !== seqRef.current) return // 过期响应（表单已再变更）丢弃
      if (dryRun) {
        if (r.error) {
          // 400 = 预检未通过（零写入）——内联进预演区；auto 模式不弹 toast
          setRepPlan({ steps: [], warnings: [], errors: r.errors?.length ? r.errors : [r.error], changes: [], equivalentCommand: r.equivalentCommand })
          if (!auto) message.error(`预检未通过：${r.error}`, 6)
        } else {
          const d = r.data
          setRepPlan({ steps: d.steps ?? [], warnings: d.warnings ?? [], errors: [], changes: d.changes ?? [], equivalentCommand: r.equivalentCommand })
          if (!auto) message.success('预演完成（未写入）——下方为执行计划与行级变更', 5)
        }
        setRepStale(false)
        return
      }
      // 执行
      if (r.error) {
        const errs = r.errors?.length ? r.errors : [r.error]
        setRepDone({ ok: false, steps: [], errors: errs, rolledBack: (r as { rolledBack?: boolean }).rolledBack, equivalentCommand: r.equivalentCommand })
        message.error(`${repFor.id} → ${rep.newId} 失败：${r.error}${(r as { rolledBack?: boolean }).rolledBack ? '（已自动回滚）' : ''}`, 6)
        return
      }
      const d = r.data
      setRepDone({ ok: true, steps: d.steps ?? [], r11: d.r11, rollbackGuide: d.rollbackGuide, equivalentCommand: r.equivalentCommand })
      message.success(`替换完成：${repFor.id} → ${rep.newId}`, 5)
      load() // core.yml / registry / domain 可能已变
      if (r.equivalentCommand) console.info('[equivalentCommand]', r.equivalentCommand)
    } finally {
      if (my === seqRef.current) { setRepBusy(false); setRepExec(false) }
    }
  }
  runRef.current = runReplaceApi
  // 实时自动预演：表单字段变更 → 500ms 防抖 dry_run（零写入、ms 级成本；过期响应靠序号丢弃）
  useEffect(() => {
    if (!repFor) return
    if (!rep.newId || rep.newId === repFor.id) return
    const t = setTimeout(() => { runRef.current(true, true) }, 500)
    return () => clearTimeout(t)
  }, [repFor, rep.newId, rep.domain, rep.keepOld, rep.path])

  const catMatch = (p: Plugin, cat: string) => cat === '全部' || (cat === '其他' ? !p.category : p.category === cat)
  const filtered = plugins.filter((p) =>
    (!q || p.id.includes(q) || (p.description ?? '').includes(q) || p.path.includes(q))
    && (trustFilter === '全部' || (trustFilter === '已信任' ? p.trusted : !p.trusted))
    && catMatch(p, catFilter))
  const untrustedCount = plugins.filter((p) => !p.trusted).length
  // 分类 chips：已知序 + 新分类追加 + 「其他」仅当有未分类
  const knownCats = [...CATEGORY_ORDER, ...[...new Set(plugins.map((p) => p.category).filter((c): c is string => !!c && !CATEGORY_ORDER.includes(c)))]]
  const catChips = [
    { cat: '全部', count: plugins.length },
    ...knownCats.map((c) => ({ cat: c, count: plugins.filter((p) => p.category === c).length })).filter((x) => x.count > 0),
    ...(plugins.some((p) => !p.category) ? [{ cat: '其他', count: plugins.filter((p) => !p.category).length }] : []),
  ]
  // 核心件：按 group 分区（core.yml 的 8 组序；coreQ 过滤后切段）+ 主从选中态
  const filteredCore = core.filter((e) => !coreQ || e.id.includes(coreQ) || (e.desc ?? '').includes(coreQ))
  const coreGroups = [...new Set(filteredCore.map((e) => e.group ?? '其他'))]
  const coreSections = coreGroups.map((g) => ({ group: g, items: filteredCore.filter((e) => (e.group ?? '其他') === g) }))
  const selectedEntry = core.find((e) => e.id === coreSel) ?? null
  const selMembers = selectedEntry?.slot ? (slots[selectedEntry.slot]?.members ?? []) : []
  // 替换 Drawer 派生态
  const showRepPreview = !!repFor && !!rep.newId && rep.newId !== repFor.id
  const newRegEntry = repFor && rep.newId ? plugins.find((p) => p.id === rep.newId) : undefined
  const newStatus = !repFor || !rep.newId ? null
    : newRegEntry ? { level: 'ok', text: '已入库' }
      : rep.path ? { level: 'info', text: '未入库 · 将自动登记' }
        : { level: 'warn', text: '未入库 · 需 path 或 roster 证据' }
  const execDisabled = repBusy || !showRepPreview || !repPlan || repPlan.errors.length > 0 || repStale
  const stageText = !repFor ? ''
    : repDone ? (repDone.ok ? `已执行 · ${repFor.id} → ${rep.newId}` : repDone.rolledBack ? '执行失败 · 已自动回滚' : '执行失败')
      : repStale ? '输入已变更 · 预演重新计算中…'
        : repPlan ? (repPlan.errors.length ? `预检未通过（${repPlan.errors.length} 条）· 修正后自动重演`
            : `预演完成 · 未写入（${repPlan.steps.length} 步 · ${repPlan.changes.length} 文件变更）`)
          : '就绪 · 填写新件 id 后自动预演'

  return (
    <div>
      <PageHead title="插件库" desc="编排时的插件目录"
        cmds={['dshctl plugin list --json', 'dshctl plugin add --id <id> --path <入口.ts>', 'dshctl plugin publish <domain>']}
        icon={<AppstoreOutlined />} iconColor="#13c2c2"
        extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>} />
      <Tabs size="large" items={[
        {
          key: 'dir', label: <TabTile icon={<DatabaseOutlined />} title="插件目录" sub="标签过滤 / 搜索 / 详情" />,
          children: (
            <PageCard>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <Space wrap>
                  <Input style={{ width: 280 }} prefix={<SearchOutlined style={{ color: '#b0bac7' }} />} allowClear
                    placeholder="搜索 id / 描述 / 路径" value={q} onChange={(e) => setQ(e.target.value)} />
                  <Segmented value={trustFilter} onChange={(v) => setTrustFilter(String(v))} options={['全部', '已信任', '未信任']} />
                </Space>
                <Space>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>{plugins.length} 项</Typography.Text>
                  {!!untrustedCount && <Tag color="warning" style={{ marginInlineEnd: 0 }}>{untrustedCount} 未信任</Tag>}
                </Space>
              </div>
              {/* 分类标签过滤条 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {catChips.map((c) => {
                  const active = catFilter === c.cat
                  const color = catColor(c.cat)
                  return (
                    <Tag key={c.cat} onClick={() => setCatFilter(c.cat)} style={{
                      marginInlineEnd: 0, cursor: 'pointer', userSelect: 'none', fontSize: 12, lineHeight: '20px',
                      color: active ? (c.cat === '全部' ? '#1677ff' : color) : '#5b6575',
                      background: active ? (c.cat === '全部' ? '#1677ff0f' : `${color}0f`) : '#fff',
                      borderColor: active ? (c.cat === '全部' ? '#1677ff66' : `${color}66`) : '#e5e9f0',
                      fontWeight: active ? 600 : 400,
                    }}>{c.cat} {c.count}</Tag>
                  )
                })}
              </div>
              {loading ? <Skeleton active paragraph={{ rows: 4 }} /> : !filtered.length
                ? <Empty description="没有匹配——换个标签或搜索词，或去「新建 · 导入」收编" />
                : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
                    {filtered.map((p) => <PluginTile key={p.id} p={p} onClick={() => setDetail(p)} />)}
                  </div>
                )}
            </PageCard>
          ),
        },
        {
          key: 'new', label: <TabTile icon={<PlusOutlined />} title="新建 · 导入" sub="四种入库方式" color="#fa8c16" />,
          children: (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16, alignItems: 'start' }}>
              <MethodCard color="#13c2c2" icon={<FolderAddOutlined />} title="路径收编"
                use="服务器上已有源码时用——登记引用，不拷贝文件"
                steps={[
                  '适合本工作区自研插件（code/* 下的入口文件）',
                  '只登记引用：源码改动即时生效，无需重新导入',
                  'path 必须是入口文件的绝对路径（如 /…/code/xx/index.ts）',
                  '收编后默认已信任（local 来源）',
                ]}>
                <Space wrap size={10}>
                  <Input style={{ width: 150 }} placeholder="id" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
                  <Input style={{ width: 110 }} placeholder="name（可选）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  <Input style={{ width: '100%' }} placeholder="/abs/path/index.ts" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
                  <Input style={{ width: '100%' }} placeholder="描述（可选，卡片与详情展示）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                  <Button type="primary" icon={<PlusOutlined />} onClick={add} disabled={!form.id || !form.path}>收编</Button>
                </Space>
              </MethodCard>
              <MethodCard color="#1677ff" icon={<FileZipOutlined />} title="上传 zip"
                use="打好包的插件目录——落库内 sources/，与源码隔离"
                steps={[
                  '适合外部交付/快照场景：把插件目录打成 zip',
                  '自动过滤 zip-slip，上限 50MB / 2000 条',
                  '落 plugin-registry/sources/<id>/，入口默认 index.ts',
                  '导入后 untrusted——核实源码后在详情里点信任',
                ]}>
                <Space wrap size={10}>
                  <Input style={{ width: 150 }} placeholder="id" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
                  <Upload accept=".zip" showUploadList={false} beforeUpload={(f) => { setZipFile(f); return false }}>
                    <Button icon={<CloudUploadOutlined />}>{zipFile ? zipFile.name : '选择 zip'}</Button>
                  </Upload>
                  <Button type="primary" icon={<CloudUploadOutlined />} onClick={uploadZip} disabled={!zipFile || !form.id}>上传并导入</Button>
                </Space>
              </MethodCard>
              <MethodCard color="#722ed1" icon={<GithubOutlined />} title="GitHub 导入"
                use="从 GitHub 仓库直接拉取——需网络可达"
                steps={[
                  'clone --depth 1 进 sources/<id>/，导入后 untrusted',
                  '网络前提：本环境实测 github.com HTTPS 不可达——需配代理/中转',
                  'url 填仓库地址（.git 结尾），ref 可留空走默认分支',
                  '失败不落盘——此时请改走 zip 上传',
                ]}>
                <Space wrap size={10}>
                  <Input style={{ width: 150 }} placeholder="id" value={git.id} onChange={(e) => setGit({ ...git, id: e.target.value })} />
                  <Input style={{ width: 110 }} placeholder="ref（可选）" value={git.ref} onChange={(e) => setGit({ ...git, ref: e.target.value })} />
                  <Input style={{ width: '100%' }} placeholder="https://github.com/<org>/<repo>.git" value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value })} />
                  <Button icon={<GithubOutlined />} onClick={importGit} disabled={!git.id || !git.url}>从 GitHub 导入</Button>
                </Space>
              </MethodCard>
              <MethodCard color="#fa8c16" icon={<ExportOutlined />} title="编排产出入库（publish）"
                use="领域编排定稿后，把它已用的插件一键收编"
                steps={[
                  '先选领域：扫描该领域 domain.yml 引用的 plugins + api_server 插件',
                  '已登记的自动跳过，不重复入库',
                  '适合「先编排、后入库」的工作流',
                  '入库结果（新增/跳过）会逐 id 列出',
                ]}>
                <Space size={10}>
                  <Select style={{ width: 200 }} placeholder="选择领域" value={pubDomain} onChange={setPubDomain}
                    options={domains.map((d) => ({ label: d, value: d }))} />
                  <Button type="primary" icon={<ExportOutlined />} onClick={publish} disabled={!pubDomain}>发布所选领域插件</Button>
                </Space>
              </MethodCard>
            </div>
          ),
        },
        {
          key: 'core', label: <TabTile icon={<SafetyCertificateTwoTone />} title={`核心功能 ${core.length}`} sub="不可缺 · 全部可替换（未开槽自动建槽）" color="#722ed1" />,
          children: (
            <PageCard>
              {/* 等高双栏（stretch + 定高 580，底边必齐；两栏各自内滚） */}
              <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', height: 580 }}>
                {/* 左：清单——搜索头（flexShrink）+ 滚动列表（sticky 组头 + id 行，描述悬停披露） */}
                <div style={{
                  width: 320, flexShrink: 0, boxSizing: 'border-box',
                  border: `1px solid ${GRAY.line}`, borderRadius: 10, background: '#fff',
                  display: 'flex', flexDirection: 'column', overflow: 'hidden',
                }}>
                  <div style={{ flexShrink: 0, padding: '12px 12px 10px', borderBottom: `1px solid ${GRAY.line}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Input size="small" allowClear prefix={<SearchOutlined style={{ color: GRAY.faint }} />}
                        placeholder="搜索 id / 描述" value={coreQ} onChange={(e) => setCoreQ(e.target.value)} />
                      <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.sm, flexShrink: 0 }}>
                        {core.length}{coreQ ? ` · 命中 ${filteredCore.length}` : ''}
                      </Typography.Text>
                    </div>
                  </div>
                  <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px 8px' }}>
                    {!coreSections.length && (
                      <div style={{ padding: '24px 0' }}>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配">
                          <Button size="small" onClick={() => setCoreQ('')}>清除搜索</Button>
                        </Empty>
                      </div>
                    )}
                    {coreSections.map((g) => (
                      <div key={g.group}>
                        <div style={{
                          position: 'sticky', top: 0, zIndex: 1, background: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '6px 8px', boxShadow: '0 1px 0 #eef1f6',
                        }}>
                          <Typography.Text strong type="secondary" style={{ fontSize: FONT_SIZE.sm }}>{g.group}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>{g.items.length}</Typography.Text>
                        </div>
                        {g.items.map((e) => (
                          <CoreRow key={e.id} e={e} active={coreSel === e.id} onClick={() => setCoreSel(e.id)} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                {/* 右：三层——头区带（渐变磁贴）/ 内容区（滚动）/ 底部动作条 */}
                <div style={{
                  flex: 1, minWidth: 0, boxSizing: 'border-box',
                  border: `1px solid ${GRAY.line}`, borderRadius: 10, background: '#fff',
                  display: 'flex', flexDirection: 'column', overflow: 'hidden',
                }}>
                  {!selectedEntry ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                      <Empty description={<Space direction="vertical" size={6}>
                        <Typography.Text strong style={{ fontSize: 14 }}>从左侧选择核心功能查看详情与替换入口</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 13 }}>点击清单行选中；悬停行可看描述，右侧展开全文、槽态与「替换…」入口</Typography.Text>
                      </Space>} />
                    </div>
                  ) : (
                    <>
                      {/* 头区带：分层底色 + 40px 渐变磁贴（全站详情头像谱系）+ 标题/chips */}
                      <div style={{
                        flexShrink: 0, background: '#fafbfd', borderBottom: `1px solid ${GRAY.border}`,
                        padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12,
                      }}>
                        <div style={{
                          width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: '#722ed11f', color: SEM.purple, fontSize: 20,
                          boxShadow: '0 0 0 3px #fff',
                        }}><SafetyCertificateOutlined /></div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <Typography.Text strong style={{ fontSize: 16 }}>{selectedEntry.id}</Typography.Text>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                            {selectedEntry.slot
                              ? <Tag color="cyan" style={{ marginInlineEnd: 0, fontSize: FONT_SIZE.sm, lineHeight: '20px' }}>槽 {selectedEntry.slot}</Tag>
                              : <Tag style={{ marginInlineEnd: 0, fontSize: FONT_SIZE.sm, lineHeight: '20px' }}>按需开槽</Tag>}
                            <Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>{selectedEntry.group ?? ''}</Typography.Text>
                          </div>
                        </div>
                        <Hint title="核心功能不可缺（R11）：手动禁用无槽 id 即报错；「替换」走全链引擎（声明槽成员 → 插入 → 禁旧 → check 验证），未开槽执行时自动建槽——见 user-manual 替换指南" />
                      </div>
                      {/* 内容区：平铺节（节标题 12/600）+ 独立滚动，无卡中卡 */}
                      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
                        <div style={{ marginBottom: 16 }}>
                          <div style={secTitleStyle}>作用</div>
                          <div style={{ background: '#fafbfd', border: `1px solid ${GRAY.line}`, borderRadius: 10, padding: '12px 16px', fontSize: FONT_SIZE.base, lineHeight: 1.7 }}>
                            {selectedEntry.desc || '—'}
                          </div>
                        </div>
                        <div style={{ marginBottom: 16 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 6 }}>
                            <span style={{ ...secTitleStyle, marginBottom: 0 }}>状态</span>
                            <Hint title={selectedEntry.slot
                              ? '已开槽：禁用旧件需同槽另一成员活跃（R11 槽豁免）；替换走全链引擎（声明槽成员 → 插入 → 禁旧 → check 验证），失败自动回滚。'
                              : '未开槽：执行替换时自动声明槽成员（core.yml 无需手改）→ 插入新件 → 禁旧 → check 验证，失败自动回滚；手动禁用仍报 R11。'} />
                          </div>
                          <StatusRow tone="success" text={<strong>可替换</strong>}
                            extra={<Typography.Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>{selectedEntry.slot ? '已开槽' : '未开槽 · 执行时自动建槽'}</Typography.Text>} />
                          {!!selMembers.length && (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: FONT_SIZE.sm, color: GRAY.weak, marginBottom: 4 }}>槽成员</div>
                              <Space wrap size={4}>
                                {selMembers.map((m) => (
                                  <Tag key={m} color={m === selectedEntry.id ? 'cyan' : undefined} style={{ marginInlineEnd: 0, fontSize: FONT_SIZE.sm, lineHeight: '20px' }}>{m}</Tag>
                                ))}
                              </Space>
                            </div>
                          )}
                        </div>
                        <div>
                          <div style={secTitleStyle}>等价命令</div>
                          <CommandChip cmd={`dshctl replace ${selectedEntry.id} --with <新件> --domain ops`} />
                        </div>
                      </div>
                      {/* 底部动作条：与头区同色上下呼应，唯一主动作入口 */}
                      <div style={{
                        flexShrink: 0, borderTop: `1px solid ${GRAY.border}`, background: '#fafbfd',
                        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 8,
                      }}>
                        <Button type="primary" icon={<SwapOutlined />} onClick={() => openReplace(selectedEntry)}>替换…</Button>
                        <Hint title="打开全链替换：预演（零写入 · 行级 diff）→ 执行（声明槽成员 → 插入 → 禁旧 → check 验证），失败自动回滚" />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </PageCard>
          ),
        },
      ]} />
      {/* 插件详情抽屉 */}
      <Drawer open={!!detail} onClose={() => setDetail(null)} width={480}>
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {/* 头部一体卡 */}
            <div style={{
              display: 'flex', gap: 12, alignItems: 'center', background: '#f7f9fc',
              border: '1px solid #eef1f6', borderRadius: 10, padding: 14,
            }}>
              <div style={{
                width: 46, height: 46, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${catColor(detail.category ?? '')}14`, color: catColor(detail.category ?? ''), fontSize: 20, fontWeight: 600,
              }}>{(detail.id[0] ?? '?').toUpperCase()}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Typography.Text strong style={{ fontSize: 16 }}>{detail.id}</Typography.Text>
                {detail.name && <div style={{ fontSize: 12, color: GRAY.weak, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail.name}</div>}
              </div>
              <Tag color={detail.trusted ? 'green' : 'orange'} style={{ marginInlineEnd: 0 }}>
                {detail.trusted ? '已信任' : '未信任——核实后再信任'}
              </Tag>
            </div>
            <div style={{ background: '#fafbfd', border: '1px solid #eef1f6', borderRadius: 10, padding: '12px 14px' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>作用</Typography.Text>
              <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 4 }}>{detail.description || detail.name || '—'}</div>
            </div>
            <div style={{ background: '#fafbfd', border: '1px solid #eef1f6', borderRadius: 10, padding: '12px 14px' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>能力 provides</Typography.Text>
              {!!detail.provides?.length
                ? <div><Space wrap size={4} style={{ marginTop: 6 }}>{detail.provides.map((x) => <Tag key={x} color="blue" style={{ marginInlineEnd: 0, fontSize: 12 }}>{x}</Tag>)}</Space></div>
                : <div style={{ fontSize: 12.5, color: '#b0bac7', marginTop: 4 }}>未声明 provides</div>}
            </div>
            {!!detail.depends_on?.length && (
              <div style={{ background: '#fafbfd', border: '1px solid #eef1f6', borderRadius: 10, padding: '12px 14px' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>依赖 depends_on</Typography.Text>
                <div><Space wrap size={4} style={{ marginTop: 6 }}>{detail.depends_on.map((d) => <Tag key={d} color="purple" style={{ marginInlineEnd: 0, fontSize: 12 }}>{d}</Tag>)}</Space></div>
              </div>
            )}
            <div style={{ background: '#fafbfd', border: '1px solid #eef1f6', borderRadius: 10, padding: '12px 14px' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>登记信息</Typography.Text>
              <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', rowGap: 6, marginTop: 6, fontSize: 13 }}>
                <Typography.Text type="secondary">入口</Typography.Text>
                <Tooltip title={detail.path}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail.path.split('/').pop()}</div></Tooltip>
                <Typography.Text type="secondary">来源</Typography.Text><div>{detail.source ?? 'local'}</div>
                <Typography.Text type="secondary">层级</Typography.Text><div>{detail.tier ?? 'extension'}</div>
                {!!detail.category && <><Typography.Text type="secondary">分类</Typography.Text><div>{detail.category}</div></>}
                {!!detail.added_at && <><Typography.Text type="secondary">入库</Typography.Text><div>{detail.added_at}</div></>}
              </div>
            </div>
            <Space>
              {!detail.trusted && <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => trust(detail.id, true)}>标记信任</Button>}
              <Popconfirm title={`移除 ${detail.id}？`} description="只删登记，不动源码" okText="移除" cancelText="取消" onConfirm={() => del(detail.id)}>
                <Button danger icon={<DeleteOutlined />}>移除</Button>
              </Popconfirm>
            </Space>
            <CommandChip cmd={`dshctl plugin show ${detail.id}`} />
          </Space>
        )}
      </Drawer>
      {/* 替换通道 · 600 宽三阶段 Drawer（同源引擎：dshctl replace） */}
      <Drawer open={!!repFor} onClose={closeReplace} width={600}
        styles={{
          footer: {
            padding: '12px 24px', background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)',
            boxShadow: '0 -2px 8px rgba(0,21,41,0.06)',
          },
        }}
        footer={
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 'auto' }}>
              {stageText}{repBusy && !repExec && <span> · 预演中…</span>}{repBusy && repExec && <span> · 执行中…</span>}
            </Typography.Text>
            <Button disabled={!showRepPreview || repBusy} loading={repBusy && !repExec} onClick={() => runReplaceApi(true)}>预演</Button>
            <Popconfirm title="执行替换？" description="写 core.yml / domain.yml / 能力包；check 不过自动回滚"
              okText="执行" cancelText="取消" disabled={execDisabled} onConfirm={() => runReplaceApi(false)}>
              <Button type="primary" loading={repBusy && repExec} disabled={execDisabled}>执行</Button>
            </Popconfirm>
          </div>
        }>
        {repFor && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {/* 1. 头部一体卡：渐变头像 + 替换标题 + 槽态 Tag + 旧件一句话 */}
            <div style={{
              display: 'flex', gap: 12, alignItems: 'center', background: '#f7f9fc',
              border: '1px solid #eef1f6', borderRadius: 10, padding: 14,
            }}>
              <div style={{
                width: 46, height: 46, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${SEM.cyan}1f`, color: SEM.cyan, fontSize: 20,
                boxShadow: '0 0 0 3px #fff',
              }}><SwapOutlined /></div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space size={8} align="center" wrap>
                  <Typography.Text strong style={{ fontSize: 16 }}>替换 {repFor.id}</Typography.Text>
                  {repFor.slot
                    ? <Tag color="cyan" style={{ marginInlineEnd: 0 }}>槽 {repFor.slot}</Tag>
                    : <Tag style={{ marginInlineEnd: 0 }}>按需开槽</Tag>}
                </Space>
                <div style={{ fontSize: 12, color: GRAY.weak, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {repFor.group ? `${repFor.group} · ` : ''}{repFor.desc || '—'}
                </div>
              </div>
            </div>

            {/* 2. 对比卡：旧件（槽成员谱系）→ 新件（表单实时回显 + 入库状态） */}
            <div style={secCard(SEM.cyan)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0, background: GRAY.panel, border: `1px solid ${GRAY.line}`, borderRadius: 8, padding: '8px 10px' }}>
                  <Typography.Text code style={{ fontSize: 12.5 }}>{repFor.id}</Typography.Text>
                  <div style={{ marginTop: 5 }}>
                    {repFor.slot && slots[repFor.slot]?.members?.length
                      ? <Space wrap size={4}>{slots[repFor.slot]!.members.map((m) => (
                        <Tag key={m} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }} color={m === repFor.id ? 'cyan' : undefined}>{m}</Tag>
                      ))}</Space>
                      : <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>未开槽——执行时自动建槽</Typography.Text>}
                  </div>
                </div>
                <SwapOutlined style={{ color: SEM.cyan, fontSize: 16, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, background: GRAY.panel, border: `1px solid ${GRAY.line}`, borderRadius: 8, padding: '8px 10px' }}>
                  <Typography.Text code style={{ fontSize: 12.5, color: rep.newId ? undefined : GRAY.faint }}>{rep.newId || '新件 id…'}</Typography.Text>
                  <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    {newStatus && <StateDot level={newStatus.level} size={6} text={<Typography.Text type="secondary" style={{ fontSize: 11.5 }}>{newStatus.text}</Typography.Text>} />}
                    {rep.path && <Typography.Text type="secondary" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rep.path}</Typography.Text>}
                  </div>
                </div>
              </div>
            </div>

            {/* 3. 表单分节卡：常驻可改——变更即失效执行结果并触发自动重预演 */}
            <div style={secCard(SEM.primary)}>
              <SecHead num={1} title="替换目标" desc="修改即自动重预演（500ms 防抖 · 零写入）" color={SEM.primary} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', alignItems: 'end' }}>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>新件 id *</Typography.Text>
                  <Input style={{ marginTop: 4 }} placeholder="已入库插件 id（或配合 path 自动入库）" value={rep.newId}
                    onChange={(e) => setRepField({ newId: e.target.value })} />
                </div>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>目标域</Typography.Text>
                  <Select style={{ width: '100%', marginTop: 4 }} value={rep.domain} options={domains.map((d) => ({ label: d, value: d }))}
                    onChange={(v) => setRepField({ domain: v })} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>入口 path（新件未入库时必填）</Typography.Text>
                  <Input style={{ marginTop: 4 }} placeholder="/abs/path/index.ts 或 @scope/pkg" value={rep.path}
                    onChange={(e) => setRepField({ path: e.target.value })} />
                </div>
                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>保留旧件（keep-old · M1 共存，跳过槽声明与禁用）</Typography.Text>
                  <Switch size="small" checked={rep.keepOld} onChange={(v) => setRepField({ keepOld: v })} />
                </div>
              </div>
            </div>

            {/* 4. 预演分节卡：verdict + 步骤时间线 + 行级 diff + 等价命令 */}
            {showRepPreview && (
              <div style={secCard(SEM.cyan)}>
                <SecHead num={2} title="预演" desc="零写入 · 与执行同引擎同 mutator（虚拟写 = 真实写）" color={SEM.cyan} />
                {!repPlan && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {repStale || repBusy ? '预演中…' : '填写合法新件 id 后自动预演'}
                  </Typography.Text>
                )}
                {repPlan && repPlan.errors.length > 0 && (
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <StatusRow tone="error" text={<><strong>预检未通过</strong>（{repPlan.errors.length} 条 · 零写入）</>} />
                    {repPlan.errors.map((e, i) => (
                      <div key={i} style={{ fontSize: FONT_SIZE.sm, color: GRAY.sub, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', lineHeight: 1.7 }}>{e}</div>
                    ))}
                  </Space>
                )}
                {repPlan && repPlan.errors.length === 0 && (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <StatusRow tone={repPlan.warnings.length ? 'warning' : 'success'}
                      text={<><strong>预检通过</strong> · {repPlan.steps.length} 步 · {repPlan.changes.length} 文件将变更</>}
                      extra={repPlan.warnings.length ? <Tag color="warning" style={{ marginInlineEnd: 0 }}>{repPlan.warnings.length} 警告</Tag> : undefined} />
                    {!!repPlan.warnings.length && (
                      <div style={{ background: GRAY.panel, border: `1px solid ${GRAY.line}`, borderRadius: 8, padding: '8px 10px' }}>
                        {repPlan.warnings.map((w, i) => <div key={i} style={{ fontSize: FONT_SIZE.sm, color: GRAY.sub, lineHeight: 1.7 }}>{w}</div>)}
                      </div>
                    )}
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      {repPlan.steps.map((s, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <StepBadge n={i + 1} color={SEM.cyan} />
                          <Typography.Text style={{ fontSize: 12.5, color: GRAY.sub, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.action}</Typography.Text>
                          {s.file && <Typography.Text code style={{ fontSize: 11, flexShrink: 0 }}>{s.file.split('/').pop()}</Typography.Text>}
                        </div>
                      ))}
                    </Space>
                    <DiffView changes={repPlan.changes} />
                    {repPlan.equivalentCommand && <CommandChip cmd={repPlan.equivalentCommand} />}
                    {repStale && <Typography.Text type="secondary" style={{ fontSize: 12 }}>输入已变更 · 重新预演中…</Typography.Text>}
                  </Space>
                )}
              </div>
            )}

            {/* 5. 执行结果分节卡：verdict + R11 豁免徽标 + 已执行步骤 + 回退指引折叠 + 等价命令 */}
            {repDone && (
              <div style={secCard(repDone.ok ? SEM.success : SEM.error)}>
                <SecHead num={3} title="执行结果" color={repDone.ok ? SEM.success : SEM.error}
                  desc={repDone.ok ? 'check 验证通过 · 清单已落盘' : '本次写入已按快照恢复'} />
                <StatusRow tone={repDone.ok ? 'success' : 'error'}
                  text={<><strong>{repDone.ok ? '替换成功' : repDone.rolledBack ? '执行失败 · 已自动回滚' : '执行失败'}</strong>{repDone.ok ? ` · ${repFor!.id} → ${rep.newId}` : ''}</>}
                  extra={(repDone.r11 ?? '').includes('槽豁免') ? <Tag color="green" style={{ marginInlineEnd: 0 }}>R11 槽豁免</Tag> : undefined} />
                {!!repDone.errors?.length && (
                  <div style={{ marginTop: 6 }}>
                    {repDone.errors.map((e, i) => (
                      <div key={i} style={{ fontSize: FONT_SIZE.sm, color: SEM.error, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', lineHeight: 1.7 }}>{e}</div>
                    ))}
                  </div>
                )}
                {repDone.r11 && !(repDone.r11 ?? '').includes('槽豁免') && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>R11：{repDone.r11}</Typography.Text>
                )}
                {!!repDone.steps.length && (
                  <div style={{ marginTop: 8 }}>
                    {repDone.steps.map((s, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12.5, lineHeight: 1.9 }}>
                        <CheckOutlined style={{ color: repDone.ok ? SEM.success : GRAY.faint, fontSize: 12, flexShrink: 0 }} />
                        <span style={{ color: GRAY.sub, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.action}</span>
                        {s.file && <Typography.Text code style={{ fontSize: 11, flexShrink: 0 }}>{s.file.split('/').pop()}</Typography.Text>}
                      </div>
                    ))}
                  </div>
                )}
                {repDone.rollbackGuide && (
                  <Collapse size="small" style={{ marginTop: 10 }} items={[{
                    key: 'rb',
                    label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>回退指引（清单驱动反向编辑）</Typography.Text>,
                    children: <CodeBlock>{repDone.rollbackGuide}</CodeBlock>,
                  }]} />
                )}
                {repDone.equivalentCommand && <div style={{ marginTop: 10 }}><CommandChip cmd={repDone.equivalentCommand} /></div>}
              </div>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  )
}
