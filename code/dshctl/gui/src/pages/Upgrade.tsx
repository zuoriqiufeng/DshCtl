import { useEffect, useState } from 'react'
import { Button, Skeleton, Tag, Space, Typography, Tooltip } from 'antd'
import { RocketOutlined, CopyOutlined } from '@ant-design/icons'
import { api, PageHead, PageCard, CommandChip, StateDot, EmptyState, GRAY, SEM, SEM_TEXT } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function UpgradePage() {
  const [rep, setRep] = useState<Record<string, any> | null>(null)
  const [loading, setLoading] = useState(false)
  const run = () => { setLoading(true); api('/api/upgrade').then((r) => { setRep(r.data); setLoading(false) }) }
  useEffect(() => { void run() }, [])
  const domains = (rep?.domains as Array<Record<string, any>>) ?? []
  const verdict = String(rep?.verdict ?? '')
  // verdict 大字用深档文字色（≥4.5:1——亮档只留给状态点）
  const V = verdict === 'pass'
    ? { tone: 'success' as const, color: SEM_TEXT.success, title: 'PASS · 可进入升级第 3 步', desc: '全领域 roster 对账通过——可以替换产物 / 重启实例。' }
    : verdict === 'blocked'
      ? { tone: 'error' as const, color: SEM_TEXT.error, title: 'BLOCKED · 有领域需要跟进', desc: '存在"消失 id"（上游改名/删除导致裁剪静默失效）——先按下方清单跟进，不要进入第 3 步。' }
      : { tone: 'warning' as const, color: SEM_TEXT.warning, title: 'DEGRADED · roster 不可用', desc: '先构建上游产物再跑（pnpm build）——不允许假通过。' }
  return (
    <div>
      <PageHead title="升级对账" desc="harness 更新后的全领域对账"
        cmds={['dshctl upgrade-check --refresh']} icon={<RocketOutlined />} iconColor="#722ed1"
        extra={<Button type="primary" icon={<RocketOutlined />} loading={loading} onClick={run}>运行对账</Button>} />
      {!rep && loading ? <PageCard><Skeleton active paragraph={{ rows: 5 }} /></PageCard>
        : !rep ? <PageCard><EmptyState icon={<RocketOutlined />} title="还没有跑过升级对账"
          desc="harness 更新后跑一遍：全领域 roster 对账，给出需要跟进的清单"
          action={<Button type="primary" icon={<RocketOutlined />} loading={loading} onClick={run}>运行对账</Button>} /></PageCard>
        : <>
          {/* verdict 轻状态横条 */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 4px', marginBottom: 14 }}>
            <StateDot level={V.tone === 'success' ? 'pass' : V.tone === 'error' ? 'fail' : 'warn'} size={12} />
            <div>
              <span style={{ fontSize: 18, fontWeight: 600, color: V.color }}>{V.title}</span>
              <div style={{ fontSize: 13, color: GRAY.sub }}>{V.desc}</div>
            </div>
          </div>
          {/* 每领域一张卡 */}
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {domains.map((d) => {
              const gone = (d.disappeared as string[]) ?? []
              const added = (d.addedUncovered as string[]) ?? []
              const bad = gone.length > 0
              return (
                <PageCard key={String(d.domain)} style={{ borderLeft: `4px solid ${bad ? SEM.error : d.degraded ? SEM.warningFill : SEM.success}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                      <Space size={10} align="center">
                        <span style={{ fontSize: 18, fontWeight: 600 }}>{String(d.domain)}</span>
                        <Tag style={{ marginInlineEnd: 0 }}>{String(d.roster_version ?? '-')}</Tag>
                        {bad && <Tag color="error" style={{ marginInlineEnd: 0 }}>需跟进</Tag>}
                      </Space>
                      <div style={{ marginTop: 10 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>消失 id（必须跟进）</Typography.Text>
                        <div style={{ marginTop: 4 }}>
                          {gone.length
                            ? <Space size={6} wrap>
                              {gone.map((id) => <Tag key={id} color="red" style={{ marginInlineEnd: 0, fontSize: 12 }}>{id}</Tag>)}
                              <Tooltip title="复制清单"><Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(gone.join('\n'))} /></Tooltip>
                            </Space>
                            : <Typography.Text type="secondary" style={{ fontSize: 13 }}>无 ✓</Typography.Text>}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>新增待评估</Typography.Text>
                        <div style={{ fontSize: 22, fontWeight: 600, color: added.length ? SEM_TEXT.warning : GRAY.weak, fontVariantNumeric: 'tabular-nums' }}>{added.length}</div>
                      </div>
                      {!!d.degraded && <Tooltip title={String(d.degraded)}><Typography.Text type="warning" style={{ fontSize: 12 }}>degraded</Typography.Text></Tooltip>}
                    </div>
                  </div>
                </PageCard>
              )
            })}
          </Space>
        </>}
    </div>
  )
}
