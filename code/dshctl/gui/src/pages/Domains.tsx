import { useEffect, useMemo, useState } from 'react'
import { Tabs, Button, Empty, Skeleton, Table, Space, Typography, Collapse, Segmented, Tooltip, Badge, Popconfirm, App as AntApp } from 'antd'
import { PlayCircleOutlined, ReloadOutlined, DiffOutlined, EditOutlined, CheckCircleOutlined, PlusOutlined, FileTextOutlined, RightOutlined, FolderOpenOutlined, StopOutlined, PoweroffOutlined, RedoOutlined, ThunderboltOutlined, DashboardOutlined, ApiOutlined, AppstoreOutlined } from '@ant-design/icons'
import { api, PageHead, PageCard, LevelDot, RuleLegend, StatBand, cardStyle, Hint, StatusRow, CommandChip, StateDot, CodeBlock, EmptyState, StatusChip, type Spec } from '../api.tsx'
import DomainForm from './DomainForm.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface LastCheck { at: string; result: string; errors: number; warns: number }
export type InstStatus = { domain: string; unit: string | null; unitActive: boolean | null; portOccupied: boolean; apiHealth: boolean | null }

const RULE_ONELINE: Record<string, string> = {
  R1: '端口与登记唯一性', R2: '上游 id 存在性', R3: '上游新增行评估', R4: 'script 命令白名单',
  R5: '契约目录覆盖', R6: 'skills frontmatter', R7: '超时配置合理性', R8: '密钥 env 名红线',
  R9: '共享依赖探活', R10: '归层缺口', R11: '核心功能不可缺（槽内可替换）', R12: '插件库对齐',
}

const SECTIONS = ['基本信息', '能力包', '护栏 guard', '契约 contracts', 'preset', '领域插件', 'api_server', 'memory', '端口与托管', 'shared_deps']

/** 运行状态徽标（三态） */
function RunBadge({ s, big }: { s: InstStatus | null; big?: boolean }) {
  const { color, label } = !s || s.unitActive === null
    ? { color: '#faad14', label: '不可判定' }
    : s.unitActive
      ? { color: '#52c41a', label: '运行中' }
      : { color: '#8c96a6', label: '已停止' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: big ? 10 : 6 }}>
      <span style={{ width: big ? 12 : 8, height: big ? 12 : 8, borderRadius: '50%', background: color, boxShadow: `0 0 0 ${big ? 5 : 3}px ${color}22` }} />
      <span style={{ fontWeight: big ? 650 : 500, fontSize: big ? 20 : 13, color: big ? color : '#16202b' }}>{label}</span>
    </span>
  )
}

/** 概览页签：运行状态（起停/冒烟）+ 领域信息 + 插件 */
export function OverviewTab({ domain, onStatusChange }: { domain: string; onStatusChange: () => void }) {
  const { message } = AntApp.useApp()
  const [st, setSt] = useState<InstStatus | null>(null)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [lib, setLib] = useState<Array<{ id: string; path: string; trusted: boolean; source?: string }>>([])
  const [ctlBusy, setCtlBusy] = useState<string | null>(null)
  const [smoke, setSmoke] = useState<any | null>(null)
  const [smoking, setSmoking] = useState(false)
  const load = () => {
    void api<InstStatus>(`/api/instance/${domain}/status`).then((r) => setSt(r.data))
    void api<{ spec: Spec | null }>(`/api/domain/${domain}`).then((r) => setSpec(r.data.spec))
    void api<any[]>('/api/plugins').then((r) => setLib(r.data ?? []))
  }
  useEffect(() => { setSt(null); setSpec(null); setSmoke(null); load() }, [domain])

  const ctl = async (action: 'start' | 'stop' | 'restart') => {
    setCtlBusy(action)
    const r = await api<{ ok?: boolean; error?: string; health?: { healthy: boolean; elapsedMs: number }; equivalentCommand?: string }>(
      `/api/instance/${domain}/ctl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    setCtlBusy(null)
    if (r.error) message.error(r.error)
    else {
      const h = r.health
      message.success(`${action} 完成${h ? (h.healthy ? `——API 已就绪（${(h.elapsedMs / 1000).toFixed(1)}s）` : '——但 /health 30s 未就绪') : ''}（${r.equivalentCommand}）`, 6)
    }
    load(); onStatusChange()
  }
  const runSmoke = async () => {
    setSmoking(true); setSmoke(null)
    const r = await api<any>(`/api/instance/${domain}/smoke`, { method: 'POST' })
    setSmoking(false)
    if (r.error) message.error(r.error)
    else setSmoke(r.data)
  }

  const plugs: Array<{ id: string; path: string; via: string }> = [
    ...(spec?.plugins ?? []).map((p: any) => ({ id: p.id, path: p.path, via: 'plugins' })),
    ...(spec?.api_server?.plugin_id && spec?.api_server?.plugin_path ? [{ id: spec.api_server.plugin_id, path: spec.api_server.plugin_path, via: 'api_server' }] : []),
  ]
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={14}>
      {/* 运行状态卡 */}
      <PageCard size="small" title={<Space><PoweroffOutlined style={{ color: st?.unitActive ? '#52c41a' : '#8c96a6' }} /><span>运行状态</span></Space>}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            {st ? <RunBadge s={st} big /> : <Skeleton.Button active size="small" />}
            <div style={{ marginTop: 8, fontSize: 13, color: '#5b6575' }}>
              <div>unit：<Typography.Text code>{st?.unit ?? '—'}</Typography.Text></div>
              <div style={{ marginTop: 2 }}>
                API :{spec?.ports?.api ?? '—'} · 健康：
                {st?.apiHealth === null || st?.apiHealth === undefined ? <Typography.Text type="secondary">—</Typography.Text>
                  : st.apiHealth ? <Typography.Text type="success">/health ✓</Typography.Text> : <Typography.Text type="danger">/health ✗</Typography.Text>}
                {st?.portOccupied && <Typography.Text type="secondary"> · 端口占用</Typography.Text>}
              </div>
            </div>
          </div>
          <Space wrap>
            <Popconfirm title={`启动 ${domain}？`} description={st?.unit ? `将执行 systemctl start ${st.unit}` : '无 unit'}
              okText="启动" cancelText="取消" onConfirm={() => void ctl('start')}>
              <Button type="primary" icon={<PlayCircleOutlined />} loading={ctlBusy === 'start'} disabled={!st?.unit || st.unitActive === true}>启动</Button>
            </Popconfirm>
            <Popconfirm title={`停止 ${domain}？`} description={st?.unit ? `将执行 systemctl stop ${st.unit}（实例将下线）` : '无 unit'}
              okText="停止" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void ctl('stop')}>
              <Button danger icon={<StopOutlined />} loading={ctlBusy === 'stop'} disabled={!st?.unit || st.unitActive === false}>停止</Button>
            </Popconfirm>
            <Popconfirm title={`重启 ${domain}？`} description={st?.unit ? `将执行 systemctl restart ${st.unit}` : '无 unit'}
              okText="重启" cancelText="取消" onConfirm={() => void ctl('restart')}>
              <Button icon={<RedoOutlined />} loading={ctlBusy === 'restart'} disabled={!st?.unit}>重启</Button>
            </Popconfirm>
            <Tooltip title="临时实例冒烟（+100 端口，不碰现网）——验证配置正确性">
              <Button icon={<ThunderboltOutlined />} loading={smoking} onClick={runSmoke}>冒烟测试</Button>
            </Tooltip>
          </Space>
        </div>
        {smoking && <div style={{ marginTop: 12 }}><StatusRow tone="info" text="冒烟中：临时实例启动 → /health → api-smoke → 自动清理（约 30-60s）…" /></div>}
        {smoke && (
          <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, background: smoke.healthOk && smoke.apiSmokeExit === 0 ? '#f6ffed' : '#fff2f0', border: `1px solid ${smoke.healthOk && smoke.apiSmokeExit === 0 ? '#b7eb8f' : '#ffccc7'}` }}>
            <Space size={16} wrap>
              <span>health：{smoke.healthOk ? <Typography.Text type="success">✓</Typography.Text> : <Typography.Text type="danger">✗</Typography.Text>}</span>
              <span>api-smoke：<b>{String(smoke.apiSmokeExit)}</b></span>
              <span>self-tests：{((smoke.selfTests ?? []) as any[]).map((t) => t.exit).join(',') || '—'}</span>
              <span>端口：{String(smoke.port)}</span>
              <span>已清理：<b>{smoke.cleaned ? '✓' : '✗'}</b></span>
            </Space>
            {(smoke.notes ?? []).map((n: string) => <div key={n} style={{ fontSize: 12, color: '#5b6575', marginTop: 4 }}>· {n}</div>)}
            <div style={{ marginTop: 6 }}><CommandChip cmd={`dshctl smoke ${domain}`} /></div>
          </div>
        )}
      </PageCard>

      {/* 领域信息卡 */}
      <PageCard size="small" title={<Space><DashboardOutlined style={{ color: '#1677ff' }} /><span>领域信息</span></Space>}>
        {!spec ? <Skeleton active paragraph={{ rows: 3 }} /> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '10px 24px', fontSize: 13 }}>
            <InfoItem label="dsh_home" value={String(spec.dsh_home)} />
            <InfoItem label="dsh_source" value={String(spec.dsh_source)} />
            <InfoItem label="API 端口" value={String(spec.ports?.api ?? '—')} />
            <InfoItem label="GUI" value={spec.ports?.gui ? String(spec.ports.gui) : 'headless'} />
            <InfoItem label="systemd unit" value={String(spec.systemd_unit ?? '—')} />
            <InfoItem label="guard" value={String(spec.guard?.rule_source ?? '—')} />
            <InfoItem label="preset" value={String(spec.preset?.source ?? '—')} />
            <div>
              <div style={{ fontSize: 12, color: '#8c96a6' }}>capabilities</div>
              <Space size={4} wrap style={{ marginTop: 2 }}>
                <Tagish>core（隐含）</Tagish>
                {((spec.capabilities ?? []) as string[]).filter((c) => c !== 'core').map((c) => <Tagish key={c}>{c}</Tagish>)}
              </Space>
            </div>
          </div>
        )}
      </PageCard>

      {/* 插件卡 */}
      <PageCard size="small" title={<Space><ApiOutlined style={{ color: '#2f54eb' }} /><span>领域插件</span><Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>domain.yml 引用 + 库对齐状态（R12 同源）</Typography.Text></Space>}>
        {!spec ? <Skeleton active paragraph={{ rows: 2 }} /> : plugs.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该领域未引用插件" /> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {plugs.map((pl) => {
              const e = lib.find((l) => l.id === pl.id)
              const tone = !e ? 'red' : !e.trusted ? 'orange' : 'green'
              const bar = tone === 'red' ? '#ff4d4f' : tone === 'orange' ? '#fa8c16' : '#52c41a'
              return (
                <div key={pl.id} style={{
                  background: '#fafbfd', border: '1px solid #eef1f6', borderLeft: `4px solid ${bar}`,
                  borderRadius: 10, padding: '12px 14px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <Typography.Text strong style={{ fontSize: 14 }}>{pl.id}</Typography.Text>
                    <Tagish>{pl.via}</Tagish>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {!e ? <Tagish tone="red">未入库（R12 error）</Tagish>
                      : !e.trusted ? <Tagish tone="orange">untrusted（R12 warn）</Tagish>
                        : <Tagish tone="green">在库 · {e.source ?? 'local'}</Tagish>}
                  </div>
                  <div style={{ fontSize: 12, color: '#8c96a6', marginTop: 8, display: 'flex', alignItems: 'center' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.path.split('/').slice(-2).join('/')}</span>
                    <Hint title={pl.path} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </PageCard>
    </Space>
  )
}

/** 状态小签（三件套已下沉 api.tsx StatusChip——此处保持调用点签名） */
const Tagish: typeof import('../api.tsx').StatusChip = StatusChip

function InfoItem({ label, value }: { label: string; value: string }) {
  // 路径类显示末段名，全路径进 tooltip（激进降噪）
  const isPath = value.startsWith('/')
  const short = isPath ? value.split('/').filter(Boolean).slice(-2).join('/') : value
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: '#8c96a6' }}>{label}</div>
      <Tooltip title={isPath ? value : undefined}>
        <div style={{ marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short}</div>
      </Tooltip>
    </div>
  )
}

export function CheckTab({ domain }: { domain: string }) {
  const [rep, setRep] = useState<Record<string, any> | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const run = () => { setLoading(true); api(`/api/check/${domain}`).then((r) => { setRep(r.data); setLoading(false) }) }
  useEffect(() => { setRep(null); setFilter('all'); void run() }, [domain])
  const items = (rep?.items as Array<Record<string, any>>) ?? []
  const pass = items.filter((i) => i.level === 'pass').length
  const warn = items.filter((i) => i.level === 'warn').length
  const err = items.filter((i) => i.level === 'error').length
  const shown = useMemo(() => filter === 'all' ? items : items.filter((i) => i.level === filter), [items, filter])
  return (
    <PageCard size="small" title={<Space><CheckCircleOutlined style={{ color: '#52c41a' }} /><span>check 对账</span></Space>}
      extra={<Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={run}>运行</Button>}>
      {!rep && loading ? <Skeleton active paragraph={{ rows: 6 }} />
        : !rep ? <Empty description="点击右上角「运行」开始对账" />
        : <>
          <div style={{ marginBottom: 12 }}>
            <StatusRow tone={err ? 'error' : warn ? 'warning' : 'success'}
              text={err ? `${err} 个 error——修复后才能 apply` : warn ? `${warn} 个警告（不阻断）· ${pass} 项通过` : `全部通过（${pass} 项）—— 可以放心 apply`} />
          </div>
          <StatBand items={[
            { label: '通过', value: pass, color: '#52c41a' },
            { label: '警告', value: warn, color: warn ? '#d48806' : '#b0bac7' },
            { label: '错误', value: err, color: err ? '#ff4d4f' : '#b0bac7' },
            { label: '规则总数', value: items.length },
          ]} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <Segmented value={filter} onChange={(v) => setFilter(String(v))}
              options={[
                { label: `全部 ${items.length}`, value: 'all' },
                { label: `error ${err}`, value: 'error' },
                { label: `warn ${warn}`, value: 'warn' },
                { label: `pass ${pass}`, value: 'pass' },
              ]} />
            {(rep.degraded ?? []).map((d: string) => <span key={d} style={{ fontSize: 13, color: '#d48806' }}>degraded<Hint title={d} /></span>)}
          </div>
          <Table rowKey={(_, i) => String(i)} dataSource={shown} pagination={{ pageSize: 15, size: 'small' }} size="small"
            expandable={{
              expandedRowRender: (r) => (
                <div>
                  <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{String(r.msg)}</Typography.Paragraph>
                  {RULE_ONELINE[r.rule] && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.rule}：{RULE_ONELINE[r.rule]}</Typography.Text>}
                </div>
              ),
            }}
            columns={[
              { title: '规则', dataIndex: 'rule', width: 80, render: (r) => <Tooltip title={RULE_ONELINE[r] ?? ''}><Typography.Text code>{r}</Typography.Text></Tooltip> },
              { title: '级别', dataIndex: 'level', width: 90, render: (l) => <LevelDot level={String(l)} /> },
              { title: '说明', dataIndex: 'msg', render: (m) => <Typography.Text style={{ fontSize: 13 }}>{String(m)}</Typography.Text> },
            ]} />
          <RuleLegend />
        </>}
    </PageCard>
  )
}

export function DiffTab({ domain }: { domain: string }) {
  const [rep, setRep] = useState<{ empty?: boolean; lines?: string[]; notes?: string[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const run = () => { setLoading(true); api(`/api/diff/${domain}`).then((r) => { setRep(r.data); setLoading(false) }) }
  useEffect(() => { setRep(null); void run() }, [domain])
  return (
    <PageCard size="small" title={<Space><DiffOutlined style={{ color: '#722ed1' }} /><span>diff 对比</span></Space>}
      extra={<Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={run}>运行</Button>}>
      {!rep && loading ? <Skeleton active paragraph={{ rows: 4 }} />
        : !rep ? <Empty description="点击右上角「运行」开始对比" />
        : rep.empty
          ? <StatusRow tone="success" text="空 ✓ —— apply 生成面与现状完全一致；此时 apply 不会产生任何变更" />
          : <>
            <div style={{ marginBottom: 8 }}>
              <StatusRow tone="warning" text={`非空：${rep.lines?.length ?? 0} 项差异——每项需人工确认后 apply 才落盘`} />
            </div>
            <CodeBlock maxHeight={340}>{(rep.lines ?? []).join('\n')}</CodeBlock>
            {(rep.notes ?? []).map((n) => (
              <div key={n} style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 13, color: '#5b6575' }}>
                <RightOutlined style={{ color: '#1677ff', marginTop: 4, fontSize: 11.5 }} /><span>{n}</span>
              </div>
            ))}
          </>}
    </PageCard>
  )
}

export function EditorTab({ domain, packs, onSaved }: { domain: string; packs: Array<{ pack: string; description: string; draft: boolean }>; onSaved?: () => void }) {
  const { message } = AntApp.useApp()
  const [spec, setSpec] = useState<Spec | null>(null)
  const [initial, setInitial] = useState('')
  const [raw, setRaw] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setSpec(null)
    api<{ content: string; spec: Spec | null; specErrors?: string[] }>(`/api/domain/${domain}`).then((r) => {
      setSpec(r.data.spec); setRaw(r.data.content); setInitial(JSON.stringify(r.data.spec))
    })
  }, [domain])
  const dirty = !!spec && JSON.stringify(spec) !== initial
  const save = () => {
    setSaving(true)
    void fetch(`/api/domain/${domain}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }) })
      .then((r) => r.json()).then((r) => {
        setSaving(false)
        if (r.error) { message.error(r.error); return }
        message.success(`已保存（${r.equivalentCommand}）`)
        setInitial(JSON.stringify(spec)); setRaw('(已保存——刷新页面查看最新 YAML)')
        onSaved?.()
      })
  }
  if (!spec) return <PageCard size="small" loading><Skeleton active paragraph={{ rows: 8 }} /></PageCard>
  return (
    <PageCard size="small" title={<Space><EditOutlined style={{ color: '#fa8c16' }} /><span>清单编辑</span><Hint title={`底层文件 domains/${domain}/domain.yml——保存即 schema 校验（与 dshctl 同一规则），失败拒绝写盘；空段自动省略。改完建议回 check 复跑。`} /></Space>}
      extra={<Space>
        {dirty && <Typography.Text type="warning" style={{ fontSize: 13 }}>● 未保存</Typography.Text>}
        <Button disabled={!dirty} onClick={() => setSpec(JSON.parse(initial))}>放弃修改</Button>
        <Button type="primary" disabled={!dirty} loading={saving} onClick={save}>保存（校验 + 原子写）</Button>
      </Space>}>
      {/* 分区锚点导航 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14, position: 'sticky', top: 56, zIndex: 5, background: '#fff', padding: '6px 0' }}>
        {SECTIONS.map((s, i) => (
          <Button key={s} size="small" type="text" style={{ fontSize: 12, color: '#5b6575' }}
            onClick={() => document.getElementById(`sec-${i + 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'][i]} {s}
          </Button>
        ))}
      </div>
      <DomainForm spec={spec} onChange={setSpec} packs={packs} />
      <Collapse style={{ marginTop: 12 }} items={[{
        key: 'raw', label: <Space><FileTextOutlined />原始 YAML（只读）</Space>,
        children: <CodeBlock maxHeight={360}>{raw}</CodeBlock>,
      }]} />
    </PageCard>
  )
}

/** 左栏领域列表项（含运行状态 chip） */
function DomainListItem({ d, lc, run, active, onClick }: { d: string; lc: LastCheck | null | undefined; run: InstStatus | null | undefined; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        padding: '10px 14px', borderRadius: 10, cursor: 'pointer', userSelect: 'none', marginBottom: 6,
        background: active ? '#eef4ff' : hover ? '#f7f9fc' : 'transparent',
        border: active ? '1px solid #b7ccff' : '1px solid transparent',
        transition: 'background .15s, box-shadow .15s, border-color .15s',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StateDot level={lc ? (lc.result === 'pass' ? 'pass' : 'fail') : 'unknown'} />
        <span style={{ fontWeight: active ? 600 : 500, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d}</span>
        {lc?.errors ? <Badge count={lc.errors} color="#ff4d4f" size="small" style={{ marginRight: 0 }} /> : null}
        {lc?.warns && !lc?.errors ? <Badge count={lc.warns} color="#faad14" size="small" style={{ marginRight: 0 }} /> : null}
      </div>
      <div style={{ fontSize: 12, color: '#8c96a6', marginTop: 3, paddingLeft: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>{lc ? `${lc.at} · ${lc.errors}e/${lc.warns}w` : '未检查'}</span>
        {run && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <StateDot level={run.unitActive === true ? 'pass' : run.unitActive === false ? 'unknown' : 'warn'} size={6} text={<span style={{ fontSize: 12, color: '#8c96a6' }}>{run.unitActive === true ? '运行中' : run.unitActive === false ? '已停' : '未知'}</span>} />
          </span>
        )}
      </div>
    </div>
  )
}

export default function DomainsPage({ domain, setDomain, onOpen, onNav }: { domain: string; setDomain: (d: string) => void; onOpen: (d: string) => void; onNav?: (k: string) => void }) {
  const [domains, setDomains] = useState<string[]>([])
  const [statuses, setStatuses] = useState<Record<string, LastCheck | null>>({})
  const [runs, setRuns] = useState<Record<string, InstStatus>>({})
  const loadDomains = () => {
    void api<string[]>('/api/domains').then((r) => setDomains(r.data))
    void api<{ lastChecks: Array<{ domain: string; last_check: LastCheck | null }> }>('/api/summary').then((r) => {
      setStatuses(Object.fromEntries(r.data.lastChecks.map((x) => [x.domain, x.last_check])))
    })
    void api<InstStatus[]>('/api/instances/status').then((r) => {
      setRuns(Object.fromEntries((r.data ?? []).map((x) => [x.domain, x])))
    }).catch(() => { /* 状态面降级 */ })
  }
  useEffect(() => { void loadDomains() }, [])
  const open = (d: string) => { setDomain(d); onOpen(d) }
  return (
    <div>
      <PageHead title="领域管理" desc="选择领域进入详情——编排画布 / 概览 / 对账 / 对比 / 编辑"
        cmd="dshctl registry --json" icon={<FolderOpenOutlined />} iconColor="#1677ff"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => onNav?.('newdomain')}>新建领域</Button>} />
      {/* 等高双栏（stretch + 定高 480，底边对齐；左列表内滚） */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', height: 480 }}>
        <div style={{ width: 300, flexShrink: 0, ...cardStyle, background: '#fff', padding: 12, boxSizing: 'border-box', overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 6px 10px' }}>
            <Typography.Text strong style={{ fontSize: 14 }}>领域（{domains.length}）</Typography.Text>
            <Tooltip title="刷新列表与运行状态"><Button size="small" type="text" icon={<ReloadOutlined />} onClick={loadDomains} /></Tooltip>
          </div>
          {domains.length === 0 && <Typography.Text type="secondary" style={{ fontSize: 13, padding: '0 6px' }}>暂无领域——点右上「新建领域」开始</Typography.Text>}
          {domains.map((d) => (
            <DomainListItem key={d} d={d} lc={statuses[d]} run={runs[d]} active={domain === d} onClick={() => open(d)} />
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, ...cardStyle, background: '#fff', padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
          <EmptyState icon={<FolderOpenOutlined />} title="点击左侧领域查看详情"
            desc="详情页包含：编排画布（拖拽排序/依赖连线）· 概览（状态/起停/冒烟/插件）· check 对账 · diff 对比 · 清单编辑"
            action={<Button type="primary" icon={<PlusOutlined />} onClick={() => onNav?.('newdomain')}>新建领域</Button>} />
        </div>
      </div>
    </div>
  )
}
