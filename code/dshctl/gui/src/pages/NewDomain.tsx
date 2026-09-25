import { useEffect, useState } from 'react'
import { Card, Input, Button, Space, Typography, Steps, App as AntApp } from 'antd'
import { ArrowLeftOutlined, CheckOutlined, LeftOutlined, RightOutlined, PlusOutlined } from '@ant-design/icons'
import { GRAY, api, PageHead, type Spec, StepBadge } from '../api.tsx'
import { SecBasic, SecCaps, SecGuard, SecContracts, SecPreset, SecPlugins, SecApi, SecMemory, SecPorts, SecDeps, type SecProps } from './DomainForm.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
const DEFAULT_SPEC = (): Spec => ({
  display_name: '', dsh_home: '', dsh_source: '/hdd/demo/public/dsh-info/deepseek-harness',
  capabilities: ['remote-exec'], guard: { rule_source: 'bkn' },
  preset: { source: '', skills_dirs: [] }, plugins: [],
  api_server: { port: 8644, api_key_env: '', turn_timeout_sec: 120, max_task_duration_sec: 120, plugin_path: '' },
  ports: { api: 8644, gui: null }, shared_deps: [],
})

/** 向导 5 步：每步渲染哪些分区 */
const STEPS = [
  { title: '领域标识', desc: '小写 kebab-case 命名' },
  { title: '基本信息', desc: 'DSH_HOME / harness 源码树' },
  { title: '能力与护栏', desc: '能力包 / guard / 契约 / preset' },
  { title: '插件与 API', desc: '插件库选择 / api_server / memory' },
  { title: '端口与依赖', desc: '端口托管 / shared_deps → 创建' },
]

export default function NewDomain({ onCreated, onCancel }: { onCreated: (n: string) => void; onCancel: () => void }) {
  const { message } = AntApp.useApp()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [spec, setSpec] = useState<Spec>(DEFAULT_SPEC())
  const [packs, setPacks] = useState<Array<{ pack: string; description: string; draft: boolean }>>([])
  const [creating, setCreating] = useState(false)
  useEffect(() => { void api('/api/packs').then((r) => setPacks(r.data)) }, [])
  const nameValid = /^[a-z][a-z0-9-]*$/.test(name)
  const set = (patch: Spec) => setSpec({ ...spec, ...patch })
  const setSub = (key: string, patch: Spec) => setSpec({ ...spec, [key]: { ...(spec[key] ?? {}), ...patch } })
  const p: SecProps = { spec, set, setSub }

  const create = () => {
    if (!nameValid) { message.error('domain 名须匹配 ^[a-z][a-z0-9-]*$'); return }
    setCreating(true)
    void fetch('/api/domain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, spec }),
    }).then((r) => r.json()).then((r) => {
      setCreating(false)
      if (r.error) { message.error(r.error); return }
      message.success(r.hint ?? '已创建', 6)
      onCreated(name)
    })
  }

  const canNext = step === 0 ? nameValid : true
  return (
    <div style={{ paddingBottom: 80 }}>
      <PageHead title="新建编排领域" desc="向导式五步——只写 domains/<name>/domain.yml，实例骨架生成走 dshctl apply"
        cmd="dshctl check <name> && dshctl apply <name> --dry-run" icon={<PlusOutlined />} iconColor="#52c41a" />
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左：步骤锚点 */}
        <div style={{ width: 250, flexShrink: 0, background: '#fff', border: '1px solid #e5e9f0', borderRadius: 12, padding: 16, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}>
          <Steps direction="vertical" size="small" current={step}
            onChange={(s) => { if (s <= step || canNext) setStep(s) }}
            items={STEPS.map((s) => ({ title: s.title, description: <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.desc}</Typography.Text> }))} />
        </div>
        {/* 右：当前步内容 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {step === 0 && (
            <Card size="small" style={{ border: '1px solid #e5e9f0', borderRadius: 12, borderLeft: '3px solid #1677ff' }}
              title={<Space><StepBadge n={1} /><span>领域标识</span><Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>将作为 profile 目录名与 domain id</Typography.Text></Space>}>
              <Space align="start">
                <span style={{ lineHeight: '36px' }}>domain 名：</span>
                <div>
                  <Input style={{ width: 380 }} value={name} status={name && !nameValid ? 'error' : ''}
                    onChange={(e) => setName(e.target.value)} placeholder="如 sql-transform" allowClear />
                  <div>
                    <Typography.Text type={name && !nameValid ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                      须匹配 ^[a-z][a-z0-9-]*$（小写字母开头，可含数字与连字符）
                    </Typography.Text>
                  </div>
                </div>
              </Space>
            </Card>
          )}
          {step === 1 && <SecBasic {...p} />}
          {step === 2 && <><SecCaps {...p} packs={packs} /><SecGuard {...p} /><SecContracts {...p} /><SecPreset {...p} /></>}
          {step === 3 && <><SecPlugins {...p} /><SecApi {...p} /><SecMemory {...p} /></>}
          {step === 4 && <><SecPorts {...p} /><SecDeps {...p} /></>}
          {step === 4 && (
            <div style={{ marginTop: 10, fontSize: 13, color: GRAY.weak }}>
              创建后：dshctl check &lt;name&gt; → apply --dry-run → apply --yes → smoke
            </div>
          )}
        </div>
      </div>
      <div style={{
        position: 'sticky', bottom: 0, background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)', padding: '12px 24px',
        boxShadow: '0 -2px 8px rgba(0,21,41,0.06)', zIndex: 20, display: 'flex', gap: 12, justifyContent: 'flex-end', alignItems: 'center',
      }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 'auto' }}>
          第 {step + 1}/5 步 · {STEPS[step]!.title}
          {step === 0 && (nameValid ? ` —— ✓ 名称合法（domains/${name}/）` : ' —— 先填合法的 domain 名')}
        </Typography.Text>
        <Button onClick={onCancel} icon={<ArrowLeftOutlined />}>取消</Button>
        {step > 0 && <Button icon={<LeftOutlined />} onClick={() => setStep(step - 1)}>上一步</Button>}
        {step < 4 && <Button type="primary" icon={<RightOutlined />} disabled={!canNext} onClick={() => setStep(step + 1)}>下一步</Button>}
        {step === 4 && <Button type="primary" icon={<CheckOutlined />} loading={creating} onClick={create}>创建（只写 domain.yml）</Button>}
      </div>
    </div>
  )
}
