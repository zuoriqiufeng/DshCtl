import { useEffect, useState } from 'react'
import { Col, Row, Table, Button, Space, Typography, Collapse, Tooltip, App as AntApp } from 'antd'
import { ReloadOutlined, PlayCircleOutlined, RocketOutlined, PlusOutlined, DatabaseOutlined, AppstoreOutlined, ClusterOutlined, HeartOutlined, DashboardOutlined } from '@ant-design/icons'
import { api, PageHead, PageCard, LevelDot, CommandChip, HistoryDots, cardStyle, Hint, StateDot, EmptyState, GRAY, SEM_TEXT } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Summary {
  instances: number
  domains: number
  domainList: string[]
  packs: number
  lastChecks: Array<{ domain: string; last_check: { at: string; result: string; errors: number; warns: number } | null }>
  unregisteredPorts: number[]
  sharedDeps: Array<{ name: string; url: string; ok: boolean }>
}
type HistEntry = { domain: string; at: string; result: string; errors: number; warns: number }

/** 统计卡：tinted 图标磁贴（去渐变去投影）+ tabular 大数字（footer 可放 chips 行） */
function StatTile({ icon, color, title, value, extra, valueColor, footer }: { icon: React.ReactNode; color: string; title: string; value: React.ReactNode; extra?: React.ReactNode; valueColor?: string; footer?: React.ReactNode }) {
  return (
    <div style={{ ...cardStyle, background: '#fff', padding: '18px 20px', display: 'flex', gap: 14, alignItems: 'center' }}>
      <div style={{
        width: 46, height: 46, borderRadius: 12, flexShrink: 0,
        background: `${color}14`,
        color, fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: GRAY.sub }}>{title}{extra && typeof extra === 'string' && <Hint title={extra} />}</div>
        <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2, color: valueColor ?? GRAY.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {footer}
      </div>
    </div>
  )
}

const QUICK = [
  { key: 'domains', icon: <PlayCircleOutlined />, title: '领域管理', desc: 'check 逐规则对账 · diff 对比生成面 · 表单化编辑清单' },
  { key: 'upgrade', icon: <RocketOutlined />, title: '升级对账', desc: 'harness 更新后：全领域 roster 对账，给出需要跟进的清单' },
  { key: 'plugins', icon: <AppstoreOutlined />, title: '插件库', desc: '收编/上传插件 · 核心必须件 · 领域产出一键入库' },
  { key: 'newdomain', icon: <PlusOutlined />, title: '新建领域', desc: '向导五步创建 domain.yml（实例骨架走 apply）' },
]

export default function Dashboard({ onNav, onOpenDomain }: { onNav: (k: string) => void; onOpenDomain: (d: string) => void }) {
  const { message } = AntApp.useApp()
  const [s, setS] = useState<Summary | null>(null)
  const [hist, setHist] = useState<HistEntry[]>([])
  const load = () => {
    void api<Summary>('/api/summary').then((r) => setS(r.data))
    void api<HistEntry[]>('/api/history').then((r) => setHist(r.data ?? []))
  }
  useEffect(() => { load() }, [])
  if (!s) return <PageCard><div style={{ padding: 40, textAlign: 'center' }}><Typography.Text type="secondary">加载中…</Typography.Text></div></PageCard>
  const last = s.lastChecks.filter((x) => x.last_check)
  const depOk = s.sharedDeps.filter((d) => d.ok).length
  const recent7 = (d: string) => hist.filter((h) => h.domain === d).slice(-7).reverse()
  return (
    <div>
      <PageHead title="概览" desc="编排体系一屏总览"
        cmds={['dshctl registry --json', 'bash code/dshctl/ci.sh', 'dshctl check ops --ci', 'dshctl upgrade-check --refresh']}
        icon={<DashboardOutlined />} iconColor="#1677ff"
        extra={<Button icon={<ReloadOutlined />} onClick={() => { load(); message.success('已刷新') }}>刷新</Button>} />
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <StatTile icon={<DatabaseOutlined />} color="#1677ff" title="已登记实例" value={s.instances}
            extra={s.domainList.join(' · ') || '暂无'} />
        </Col>
        <Col xs={12} md={6}>
          <StatTile icon={<AppstoreOutlined />} color="#722ed1" title="编排领域" value={s.domains}
            extra="一个领域 = 一份 domain.yml + 一个实例" />
        </Col>
        <Col xs={12} md={6}>
          <StatTile icon={<ClusterOutlined />} color="#13c2c2" title="能力包片段" value={s.packs}
            extra="core 恒隐含必裁，其余按域勾选" />
        </Col>
        <Col xs={12} md={6}>
          <StatTile icon={<HeartOutlined />} color={depOk === s.sharedDeps.length ? SEM_TEXT.success : SEM_TEXT.error} title="共享依赖健康"
            value={<>{depOk}<span style={{ fontSize: 16, color: GRAY.weak }}>/ {s.sharedDeps.length}</span></>}
            valueColor={depOk === s.sharedDeps.length ? SEM_TEXT.success : SEM_TEXT.error}
            footer={
              <Space size={4} wrap style={{ marginTop: 2 }}>
                {s.sharedDeps.map((d) => (
                  <StateDot key={d.name} level={d.ok ? 'pass' : 'fail'} size={6} text={<span style={{ fontSize: 12, color: GRAY.sub }}>{d.name}</span>} />
                ))}
              </Space>
            } />
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={15}>
          <PageCard size="small" title="各领域最近 check" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>点阵 = 最近 7 次结果（新 → 旧）</Typography.Text>}>
            {last.length === 0 ? (
              <EmptyState title="还没有 check 记录" desc="check 会逐条对账 R1-R12，结果进历史点阵"
                action={<Button size="small" type="primary" onClick={() => onNav('domains')}>去领域管理跑一次</Button>} />
            ) : (
              <Table rowKey="domain" dataSource={last} pagination={false} size="small"
                onRow={(r) => ({ onClick: () => onOpenDomain((r as any).domain), style: { cursor: 'pointer' } })}
                columns={[
                  {
                    title: '领域', dataIndex: 'domain',
                    render: (d, r) => {
                      const lc = r.last_check as any
                      return (
                        <StateDot level={lc.result === 'pass' ? 'pass' : 'fail'}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{String(d)}</span>
                        </StateDot>
                      )
                    },
                  },
                  {
                    title: '最近结果',
                    render: (_, r) => {
                      const lc = r.last_check as any
                      return (
                        <Space size={8}>
                          <LevelDot level={lc.result === 'pass' ? 'pass' : 'fail'} />
                          {!!lc.errors && <Typography.Text type="danger" style={{ fontSize: 12 }}>{lc.errors}e</Typography.Text>}
                          {!!lc.warns && <Typography.Text type="warning" style={{ fontSize: 12 }}>{lc.warns}w</Typography.Text>}
                          {!lc.errors && !lc.warns && <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>}
                        </Space>
                      )
                    },
                  },
                  { title: '最近 7 次', render: (_, r) => <HistoryDots entries={recent7((r as any).domain)} /> },
                  { title: '日期', width: 110, render: (_, r) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{(r.last_check as any).at}</Typography.Text> },
                ]} />
            )}
          </PageCard>
        </Col>
        <Col xs={24} lg={9}>
          <PageCard size="small" title="快捷入口">
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              {QUICK.map((q) => (
                <div key={q.key} onClick={() => onNav(q.key)} className="card-hover" style={{
                  display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px',
                  border: `1px solid ${GRAY.line}`, borderRadius: 10, cursor: 'pointer', background: '#fff',
                }}>
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: '#eef4ff', color: '#1677ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>{q.icon}</div>
                  <Tooltip title={q.desc}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{q.title}</div>
                  </Tooltip>
                </div>
              ))}
            </Space>
            {!!s.unregisteredPorts.length && (
              <div style={{ marginTop: 10, fontSize: 12, color: GRAY.sub }}>
                未登记端口 {s.unregisteredPorts.join(', ')}<Hint title="归属见实例登记页；转正时回收或登记" />
              </div>
            )}
          </PageCard>
        </Col>
      </Row>
      <Collapse style={{ marginTop: 16 }} items={[{
        key: 'cli',
        label: <Typography.Text type="secondary" style={{ fontSize: 13 }}>CLI 等价命令（每周巡检 / 升级后对账）</Typography.Text>,
        children: (
          <Space direction="vertical" size={8}>
            <Space><Typography.Text type="secondary">一键五环节：</Typography.Text><CommandChip cmd="bash code/dshctl/ci.sh" /></Space>
            <Space><Typography.Text type="secondary">每周巡检：</Typography.Text><CommandChip cmd="dshctl check ops --ci" /></Space>
            <Space><Typography.Text type="secondary">升级后：</Typography.Text><CommandChip cmd="dshctl upgrade-check --refresh" /></Space>
          </Space>
        ),
      }]} />
    </div>
  )
}
