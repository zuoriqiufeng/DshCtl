import { useEffect, useState } from 'react'
import { Tabs, Button, Space, Typography, Skeleton } from 'antd'
import { ArrowLeftOutlined, DashboardOutlined, CheckCircleOutlined, DiffOutlined, EditOutlined, NodeIndexOutlined } from '@ant-design/icons'
import { api, PageHead, LevelDot, TabTile, StateDot, type Spec } from '../api.tsx'
import { OverviewTab, CheckTab, DiffTab, EditorTab, type InstStatus } from './Domains.tsx'
import OrchestrationCanvas from './OrchestrationCanvas.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface LastCheck { at: string; result: string; errors: number; warns: number }

export default function DomainDetail({ domain, onBack, onNav }: { domain: string; onBack: () => void; onNav?: (k: string) => void }) {
  const [lc, setLc] = useState<LastCheck | null>(null)
  const [st, setSt] = useState<InstStatus | null>(null)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [packs, setPacks] = useState<Array<{ pack: string; description: string; draft: boolean }>>([])
  const load = () => {
    void api<{ lastChecks: Array<{ domain: string; last_check: LastCheck | null }> }>('/api/summary').then((r) => {
      setLc(r.data.lastChecks.find((x) => x.domain === domain)?.last_check ?? null)
    })
    void api<InstStatus>(`/api/instance/${domain}/status`).then((r) => setSt(r.data)).catch(() => setSt(null))
    void api<{ spec: Spec | null }>(`/api/domain/${domain}`).then((r) => setSpec(r.data.spec))
  }
  useEffect(() => { load(); void api('/api/packs').then((r) => setPacks(r.data)) }, [domain]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <PageHead title={domain} desc="领域详情"
        cmds={[`dshctl check ${domain} --ci`, `dshctl diff ${domain}`, `dshctl smoke ${domain}`, `systemctl status ${st?.unit ?? '<unit>'}`]}
        icon={<DashboardOutlined />} iconColor="#1677ff"
        extra={<Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回列表</Button>} />
      {/* 领域大头：状态摘要条 */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap', background: '#fff', border: '1px solid #e5e9f0', borderRadius: 12, padding: '14px 20px', marginBottom: 14, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}>
        <Space size={20} wrap>
          <div>
            <div style={{ fontSize: 12, color: '#8c96a6' }}>配置健康（check）</div>
            {lc ? <LevelDot level={lc.result === 'pass' ? 'pass' : 'fail'} counts={`· ${lc.errors}e / ${lc.warns}w`} /> : <Typography.Text type="secondary" style={{ fontSize: 13 }}>未检查</Typography.Text>}
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#8c96a6' }}>进程状态</div>
            <Space size={6}>
              <StateDot level={st?.unitActive === true ? 'pass' : st?.unitActive === false ? 'warn' : 'unknown'} size={6} text={<span style={{ fontSize: 13 }}>{st?.unitActive === true ? '运行中' : st?.unitActive === false ? '已停止' : '不可判定'}</span>} />
              {st?.apiHealth && <Typography.Text type="success" style={{ fontSize: 12 }}>/health ✓</Typography.Text>}
            </Space>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#8c96a6' }}>最近 check</div>
            <Typography.Text style={{ fontSize: 13 }}>{lc?.at ?? '—'}</Typography.Text>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#8c96a6' }}>unit</div>
            <Typography.Text code style={{ fontSize: 12 }}>{st?.unit ?? spec?.systemd_unit ?? '—'}</Typography.Text>
          </div>
        </Space>
      </div>
      {!spec ? <Skeleton active paragraph={{ rows: 4 }} /> : (
        <Tabs size="large" items={[
          {
            key: 'orchestration', label: <TabTile icon={<NodeIndexOutlined />} title="编排" sub="画布 / 排序 / 依赖" />,
            children: <OrchestrationCanvas key={domain} domain={domain} spec={spec} onSpecChange={setSpec} />,
          },
          { key: 'overview', label: <TabTile icon={<DashboardOutlined />} title="概览" sub="状态 / 起停 / 冒烟 / 插件" color="#52c41a" />, children: <OverviewTab key={domain} domain={domain} onStatusChange={load} /> },
          { key: 'check', label: <TabTile icon={<CheckCircleOutlined />} title="check 对账" sub="R1-R12 全规则" color="#13c2c2" />, children: <CheckTab domain={domain} /> },
          { key: 'diff', label: <TabTile icon={<DiffOutlined />} title="diff 对比" sub="生成面 vs 现状" color="#722ed1" />, children: <DiffTab domain={domain} /> },
          { key: 'edit', label: <TabTile icon={<EditOutlined />} title="清单编辑" sub="表单改 domain.yml" color="#fa8c16" />, children: <EditorTab key={domain} domain={domain} packs={packs} onSaved={load} /> },
        ]} />
      )}
    </div>
  )
}
