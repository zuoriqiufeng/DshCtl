import { useEffect, useState } from 'react'
import { Table, Button, Empty, Skeleton, Typography, Space, Tooltip, Drawer } from 'antd'
import { ReloadOutlined, DatabaseOutlined } from '@ant-design/icons'
import { api, PageHead, PageCard, LevelDot, StatBand, CommandChip, StateDot } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function RegistryPage() {
  const [data, setData] = useState<{ instances?: Array<Record<string, unknown>>; unregistered_ports?: number[] }>({})
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [eq, setEq] = useState('')
  const [loading, setLoading] = useState(true)
  const load = () => { setLoading(true); api('/api/registry').then((r) => { setData(r.data); setEq(r.equivalentCommand ?? ''); setLoading(false) }) }
  useEffect(() => { void load() }, [])
  const rows = data.instances ?? []
  const apiPorts = rows.filter((r) => (r.ports as any)?.api).length
  const headless = rows.filter((r) => !(r.ports as any)?.gui).length
  const passed = rows.filter((r) => (r.last_check as any)?.result === 'pass').length
  return (
    <div>
      <PageHead title="实例登记" desc="在册实例总览"
        cmds={[eq].filter(Boolean)} icon={<DatabaseOutlined />} iconColor="#1677ff"
        extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>} />
      <StatBand items={[
        { label: '已登记实例', value: rows.length },
        { label: 'API 端口', value: apiPorts },
        { label: 'headless（无 GUI）', value: headless },
        { label: '最近 check 通过', value: `${passed}/${rows.length}`, color: passed === rows.length && rows.length ? '#52c41a' : undefined },
      ]} />
      <PageCard>
        {loading ? <Skeleton active paragraph={{ rows: 4 }} /> : rows.length === 0 ? (
          <Empty description={<Space direction="vertical" size={6}>
            <Typography.Text>暂无登记——registry.yml 是空的</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>CLI 跑 dshctl adopt / apply；或 GUI「新建领域」后 apply，都会产生登记</Typography.Text>
          </Space>} />
        ) : (
          <Table<any> rowKey={(r) => String(r.domain)} dataSource={rows} pagination={false} size="small"
            onRow={(r) => ({ onClick: () => setDetail(r), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: '领域', dataIndex: 'domain', width: 240,
                render: (d, r) => {
                  const lc = r.last_check as any
                  return (
                    <StateDot level={lc ? (lc.result === 'pass' ? 'pass' : 'fail') : 'unknown'}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{String(d)}</span>
                    </StateDot>
                  )
                },
              },
              {
                title: '端口', width: 170,
                render: (_, r) => {
                  const p = r.ports as any
                  return (
                    <Space size={8}>
                      <span style={{ fontSize: 13 }}>API <b>{String(p?.api ?? '-')}</b></span>
                      {p?.gui
                        ? <span style={{ fontSize: 13 }}>GUI <b>{String(p.gui)}</b></span>
                        : <Typography.Text type="secondary" style={{ fontSize: 12 }}>headless</Typography.Text>}
                    </Space>
                  )
                },
              },
              {
                title: '状态', width: 90,
                render: (_, r) => {
                  const prod = r.status === 'prod'
                  return <StateDot level={prod ? 'pass' : 'info'} size={6}>{prod ? '生产' : '试验'}</StateDot>
                },
              },
              {
                title: '最近 check', width: 130,
                render: (_, r) => {
                  const lc = r.last_check as any
                  return lc ? <LevelDot level={lc.result === 'pass' ? 'pass' : 'fail'} /> : <Typography.Text type="secondary">未检查</Typography.Text>
                },
              },
            ]} />
        )}

      </PageCard>
      <Drawer open={!!detail} onClose={() => setDetail(null)} width={400} title={detail ? String(detail.domain) : ''}>
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={14}>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>DSH_HOME</Typography.Text>
              <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{String(detail.dsh_home)}</div></div>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>端口</Typography.Text>
              <div style={{ fontSize: 13 }}>API {(detail.ports as any)?.api ?? '—'} · GUI {(detail.ports as any)?.gui ?? 'headless'}</div></div>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>systemd unit</Typography.Text>
              <div style={{ fontSize: 13 }}>{String(detail.systemd_unit ?? '未托管')}</div></div>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>状态</Typography.Text>
              <div style={{ fontSize: 13 }}>{detail.status === 'prod' ? '生产' : '试验'}</div></div>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>最近 check</Typography.Text>
              <div style={{ fontSize: 13 }}>
                {detail.last_check
                  ? <Space size={8}><LevelDot level={(detail.last_check as any).result === 'pass' ? 'pass' : 'fail'} />
                    <Typography.Text type="secondary">{(detail.last_check as any).at} · {(detail.last_check as any).errors}e/{(detail.last_check as any).warns}w</Typography.Text></Space>
                  : '未检查'}
              </div></div>
            <CommandChip cmd={`systemctl status ${String(detail.systemd_unit ?? '<unit>')} && curl 127.0.0.1:${(detail.ports as any)?.api ?? '<api>'}/health`} />
          </Space>
        )}
      </Drawer>
    </div>
  )
}
