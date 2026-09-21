import { useEffect, useState } from 'react'
import { Card, Space, Typography, Input, Button, Tag, Checkbox, Switch, InputNumber, Collapse, Radio, Select, Tooltip, CardProps } from 'antd'
import { InfoCircleOutlined, SafetyCertificateOutlined, FileProtectOutlined, RobotOutlined, ApiOutlined, CloudServerOutlined, GlobalOutlined, LinkOutlined, AppstoreOutlined } from '@ant-design/icons'
import type { Spec } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 分区卡统一风格（左色条 + 细边框） */
const secStyle = (color: string): CardProps['style'] => ({
  marginBottom: 10, border: '1px solid #e5e9f0', borderRadius: 12,
  boxShadow: '0 1px 2px rgba(16,24,40,0.04)', borderLeft: `3px solid ${color}`,
})

function TagList({ value = [], onChange, placeholder }: { value?: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState('')
  const add = () => { const t = text.trim(); if (t && !value.includes(t)) onChange([...value, t]); setText('') }
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        {value.map((t) => <Tag key={t} closable onClose={() => onChange(value.filter((x) => x !== t))}>{t}</Tag>)}
      </Space>
      <Space>
        <Input size="small" style={{ width: 360 }} value={text} placeholder={placeholder ?? '输入后回车/点添加'}
          onChange={(e) => setText(e.target.value)} onPressEnter={add} />
        <Button size="small" onClick={add}>添加</Button>
      </Space>
    </Space>
  )
}

function Row({ label, children, tip }: { label: string; children: React.ReactNode; tip?: string }) {
  return (
    <Space align="start" style={{ marginBottom: 8 }}>
      <Typography.Text type="secondary" style={{ width: 170, display: 'inline-block' }}>
        {label}{tip && <Tooltip title={tip}><InfoCircleOutlined style={{ marginLeft: 4, fontSize: 12, cursor: 'help' }} /></Tooltip>}
      </Typography.Text>
      <div style={{ flex: 1, minWidth: 420 }}>{children}</div>
    </Space>
  )
}

function SectionTitle({ icon, num, title, desc, color }: { icon: React.ReactNode; num: string; title: string; desc: string; color: string }) {
  return (
    <Space size={8} align="center">
      <span style={{ color, fontSize: 15 }}>{icon}</span>
      <span>{num} {title}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{desc}</Typography.Text>
    </Space>
  )
}

export type SecProps = { spec: Spec; set: (patch: Spec) => void; setSub: (key: string, patch: Spec) => void }

export function SecBasic({ spec, set }: SecProps) {
  return (
    <Card size="small" style={secStyle('#1677ff')} title={<SectionTitle icon={<InfoCircleOutlined />} num="①" title="基本信息" desc="实例落在哪、被编排的 harness 源码在哪" color="#1677ff" />}>
      <Row label="display_name" tip="人类可读的显示名（可选）"><Input value={spec.display_name ?? ''} onChange={(e) => set({ display_name: e.target.value })} /></Row>
      <Row label="dsh_home" tip="该领域的独立 DSH_HOME（数据/配置/日志都在这里）"><Input value={spec.dsh_home ?? ''} onChange={(e) => set({ dsh_home: e.target.value })} placeholder="/path/to/.dsh-xxx-home" /></Row>
      <Row label="dsh_source" tip="被编排的 harness 源码树（dump-config / smoke 都从这里跑）"><Input value={spec.dsh_source ?? ''} onChange={(e) => set({ dsh_source: e.target.value })} placeholder="被编排的 harness 源码树路径" /></Row>
    </Card>
  )
}

export function SecCaps({ spec, set, packs }: SecProps & { packs: Array<{ pack: string; description: string; draft: boolean }> }) {
  const nonCore = (packs ?? []).filter((p) => p.pack !== 'core')
  return (
    <Card size="small" style={secStyle('#722ed1')} title={<SectionTitle icon={<AppstoreOutlined />} num="②" title="能力包" desc="编排裁剪面：core 恒隐含必裁，其余按领域勾选" color="#722ed1" />}>
      <Checkbox disabled checked>core（恒隐含）</Checkbox>
      <Checkbox.Group
        value={(spec.capabilities ?? []).filter((c: string) => c !== 'core')}
        onChange={(v) => set({ capabilities: [...v as string[]] })}
        options={nonCore.map((p) => ({ label: `${p.pack}${p.draft ? '（DRAFT）' : ''}`, value: p.pack }))}
        style={{ marginLeft: 12 }}
      />
      <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{nonCore.map((p) => `${p.pack}: ${p.description}`).filter((s) => !s.endsWith(': ')).join('；')}</Typography.Text></div>
    </Card>
  )
}

export function SecGuard({ spec, setSub }: SecProps) {
  const wl = spec.guard?.whitelist ?? {}
  return (
    <Card size="small" style={secStyle('#ff4d4f')} title={<SectionTitle icon={<SafetyCertificateOutlined />} num="③" title="护栏 guard" desc="风险拦截规则源——决定 Agent 的高危动作怎么处理" color="#ff4d4f" />}>
      <Row label="rule_source">
        <Radio.Group value={spec.guard?.rule_source ?? 'bkn'} onChange={(e) => setSub('guard', { rule_source: e.target.value })}>
          <Radio value="bkn">bkn（BKN 三源规则，拦高危）</Radio>
          <Radio value="whitelist">whitelist（只放行白名单）</Radio>
          <Radio value="none">none（关闭规则）</Radio>
        </Radio.Group>
      </Row>
      {spec.guard?.rule_source === 'whitelist' && <>
        <Row label="whitelist.commands" tip="字面前缀或 re:正则；script 能力包必填（R4）"><TagList value={wl.commands ?? []} onChange={(v) => setSub('guard', { whitelist: { ...wl, commands: v } })} placeholder="如 obclient（字面前缀或 re:正则）" /></Row>
        <Row label="whitelist.write_paths" tip="契约 media_dirs 必须被这里覆盖（R5）"><TagList value={wl.write_paths ?? []} onChange={(v) => setSub('guard', { whitelist: { ...wl, write_paths: v } })} placeholder="如 /tmp、/opt/data" /></Row>
      </>}
    </Card>
  )
}

export function SecContracts({ spec, set }: SecProps) {
  return (
    <Card size="small" style={secStyle('#13c2c2')} title={<SectionTitle icon={<FileProtectOutlined />} num="④" title="契约 contracts" desc="MEDIA 类输出目录——Agent 写得出、契约读得到" color="#13c2c2" />}>
      <Row label="media_dirs"><TagList value={spec.contracts?.media_dirs ?? []} onChange={(v) => set({ contracts: { media_dirs: v } })} placeholder="如 /tmp、/opt/data" /></Row>
    </Card>
  )
}

export function SecPreset({ spec, setSub }: SecProps) {
  return (
    <Card size="small" style={secStyle('#fa8c16')} title={<SectionTitle icon={<RobotOutlined />} num="⑤" title="preset" desc="persona / 热路径 / 技能从哪来" color="#fa8c16" />}>
      <Row label="source" tip="agent.cordis.yml + persona 所在目录"><Input value={spec.preset?.source ?? ''} onChange={(e) => setSub('preset', { source: e.target.value })} placeholder="persona/热路径源目录" /></Row>
      <Row label="skills_dirs" tip="每个子目录一个 SKILL.md（须有 name+description frontmatter，R6）"><TagList value={spec.preset?.skills_dirs ?? []} onChange={(v) => setSub('preset', { skills_dirs: v })} placeholder="技能目录绝对路径" /></Row>
    </Card>
  )
}

export function SecPlugins({ spec, set }: SecProps) {
  const [lib, setLib] = useState<Array<{ id: string; path: string; trusted: boolean }>>([])
  useEffect(() => { fetch('/api/plugins').then((r) => r.json()).then((j) => setLib(j.data ?? [])).catch(() => setLib([])) }, [])
  return (
    <Card size="small" style={secStyle('#2f54eb')} title={<SectionTitle icon={<ApiOutlined />} num="⑥" title="领域插件" desc="从插件库选择；domain-api 由 api_server 自动注入，勿选" color="#2f54eb" />}>
      <Select
        mode="multiple"
        style={{ width: '100%' }}
        placeholder={lib.length ? '从插件库勾选（自动写入 id+path）' : '插件库为空——先到「插件库」页收编'}
        value={(spec.plugins ?? []).map((p: Spec) => p.id)}
        options={lib.map((p) => ({ label: `${p.id}${p.trusted ? '' : '（untrusted）'}`, value: p.id }))}
        onChange={(ids: string[]) => set({
          plugins: ids.map((id) => {
            const hit = lib.find((l) => l.id === id)
            const prev = (spec.plugins ?? []).find((p: Spec) => p.id === id)
            return { id, path: hit?.path ?? prev?.path ?? '' }
          }),
        })}
      />
      {(spec.plugins ?? []).map((pl: Spec, i: number) => (
        <Space key={i} style={{ marginTop: 4 }}>
          <Typography.Text code>{pl.id}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{pl.path}</Typography.Text>
          {!lib.some((l) => l.id === pl.id) && <Tag color="red" style={{ marginInlineEnd: 0 }}>不在插件库（R12 会报错）</Tag>}
        </Space>
      ))}
      <Collapse size="small" style={{ marginTop: 8 }} items={[{
        key: 'adv', label: '高级：手工输入 id+path（未入库插件）',
        children: <>
          {(spec.plugins ?? []).map((pl: Spec, i: number) => (
            <Space key={i} style={{ marginBottom: 4 }}>
              <Input size="small" style={{ width: 180 }} value={pl.id} placeholder="id" onChange={(e) => { const ps = [...spec.plugins]; ps[i] = { ...pl, id: e.target.value }; set({ plugins: ps }) }} />
              <Input size="small" style={{ width: 420 }} value={pl.path} placeholder="/abs/path/index.ts" onChange={(e) => { const ps = [...spec.plugins]; ps[i] = { ...pl, path: e.target.value }; set({ plugins: ps }) }} />
              <Button size="small" danger onClick={() => set({ plugins: spec.plugins.filter((_: unknown, j: number) => j !== i) })}>删</Button>
            </Space>
          ))}
          <Button size="small" onClick={() => set({ plugins: [...(spec.plugins ?? []), { id: '', path: '' }] })}>+ 插件</Button>
        </>,
      }]} />
    </Card>
  )
}

export function SecApi({ spec, setSub }: SecProps) {
  return (
    <Card size="small" style={secStyle('#eb2f96')} title={<SectionTitle icon={<CloudServerOutlined />} num="⑦" title="api_server" desc="领域对外 API 面（domain-api 接入）" color="#eb2f96" />}>
      <Row label="port" tip="API 监听端口（registry 查重，R1）"><InputNumber value={spec.api_server?.port} onChange={(v) => setSub('api_server', { port: v })} style={{ width: 160 }} /></Row>
      <Row label="api_key_env" tip="只填 env 变量名；值放 ops.env/EnvironmentFile——明文会被 R8 拦下"><Input value={spec.api_server?.api_key_env ?? ''} onChange={(e) => setSub('api_server', { api_key_env: e.target.value })} style={{ width: 260 }} placeholder="如 OPS_API_KEY（禁止填明文密钥）" /></Row>
      <Row label="turn_timeout_sec" tip="单轮超时；须 ≥ max_task_duration（R7）"><InputNumber value={spec.api_server?.turn_timeout_sec} onChange={(v) => setSub('api_server', { turn_timeout_sec: v })} style={{ width: 160 }} /></Row>
      <Row label="max_task_duration_sec"><InputNumber value={spec.api_server?.max_task_duration_sec} onChange={(v) => setSub('api_server', { max_task_duration_sec: v })} style={{ width: 160 }} /></Row>
      <Row label="plugin_path" tip="domain-api 插件源码绝对路径（apply 必需）"><Input value={spec.api_server?.plugin_path ?? ''} onChange={(e) => setSub('api_server', { plugin_path: e.target.value })} placeholder="domain-api 插件源码绝对路径" /></Row>
      <Row label="plugin_id（可选）" tip="profile patch 中 domain-api insert 的 id"><Input value={spec.api_server?.plugin_id ?? ''} onChange={(e) => setSub('api_server', { plugin_id: e.target.value })} style={{ width: 260 }} placeholder="如 ops-api" /></Row>
    </Card>
  )
}

export function SecMemory({ spec, setSub }: SecProps) {
  return (
    <Collapse style={{ marginBottom: 10 }} items={[{
      key: 'mem', label: <SectionTitle icon={<GlobalOutlined />} num="⑧" title="memory" desc="记忆接入（可选）——接 MemoryCore Gateway" color="#13c2c2" />,
      children: <>
        <Row label="gateway_url"><Input value={spec.memory?.gateway_url ?? ''} onChange={(e) => setSub('memory', { gateway_url: e.target.value })} style={{ width: 360 }} placeholder="http://127.0.0.1:8420" /></Row>
        <Row label="session_keys"><TagList value={spec.memory?.session_keys ?? []} onChange={(v) => setSub('memory', { session_keys: v })} /></Row>
      </>,
    }]} />
  )
}

export function SecPorts({ spec, set, setSub }: SecProps) {
  return (
    <Card size="small" style={secStyle('#52c41a')} title={<SectionTitle icon={<GlobalOutlined />} num="⑨" title="端口与托管" desc="暴露哪些端口、由谁托管" color="#52c41a" />}>
      <Row label="ports.api"><InputNumber value={spec.ports?.api} onChange={(v) => setSub('ports', { api: v })} style={{ width: 160 }} /></Row>
      <Row label="headless（无 GUI 面）" tip="headless=开 时只暴露 API 面，gui 记 null">
        <Switch checked={spec.ports?.gui === null || (spec.ports?.gui === undefined && spec.ports?.api != null)}
          onChange={(on) => set({ ports: { ...(spec.ports ?? {}), gui: on ? null : 3081 } })} />
        <Typography.Text type="secondary" style={{ marginLeft: 8 }}>开 = 只有 API；关 = 同时开 GUI 端口</Typography.Text>
      </Row>
      <Row label="systemd_unit" tip="托管该实例的 unit 名（registry 记录 + R1 自证）"><Input value={spec.systemd_unit ?? ''} onChange={(e) => set({ systemd_unit: e.target.value })} style={{ width: 320 }} placeholder="如 dsh-sql-transform.service" /></Row>
    </Card>
  )
}

export function SecDeps({ spec, set }: SecProps) {
  return (
    <Card size="small" style={secStyle('#faad14')} title={<SectionTitle icon={<LinkOutlined />} num="⑩" title="shared_deps" desc="外部依赖——check 时逐个探活（R9）" color="#faad14" />}>
      {(spec.shared_deps ?? []).map((d: Spec, i: number) => (
        <Space key={i} style={{ marginBottom: 4 }}>
          <Input size="small" style={{ width: 180 }} value={d.name} placeholder="name" onChange={(e) => { const ds = [...spec.shared_deps]; ds[i] = { ...d, name: e.target.value }; set({ shared_deps: ds }) }} />
          <Input size="small" style={{ width: 360 }} value={d.url} placeholder="http://..." onChange={(e) => { const ds = [...spec.shared_deps]; ds[i] = { ...d, url: e.target.value }; set({ shared_deps: ds }) }} />
          <Button size="small" danger onClick={() => set({ shared_deps: spec.shared_deps.filter((_: unknown, j: number) => j !== i) })}>删</Button>
        </Space>
      ))}
      <Button size="small" onClick={() => set({ shared_deps: [...(spec.shared_deps ?? []), { name: '', url: '' }] })}>+ 依赖</Button>
    </Card>
  )
}

/** 完整表单（清单编辑页用）：十个分区顺序排列（带锚点 id，供编辑页目录跳转） */
export default function DomainForm({ spec, onChange, packs }: { spec: Spec; onChange: (s: Spec) => void; packs: Array<{ pack: string; description: string; draft: boolean }> }) {
  const set = (patch: Spec) => onChange({ ...spec, ...patch })
  const setSub = (key: string, patch: Spec) => onChange({ ...spec, [key]: { ...(spec[key] ?? {}), ...patch } })
  const p = { spec, set, setSub }
  return (
    <div>
      <div id="sec-1"><SecBasic {...p} /></div>
      <div id="sec-2"><SecCaps {...p} packs={packs} /></div>
      <div id="sec-3"><SecGuard {...p} /></div>
      <div id="sec-4"><SecContracts {...p} /></div>
      <div id="sec-5"><SecPreset {...p} /></div>
      <div id="sec-6"><SecPlugins {...p} /></div>
      <div id="sec-7"><SecApi {...p} /></div>
      <div id="sec-8"><SecMemory {...p} /></div>
      <div id="sec-9"><SecPorts {...p} /></div>
      <div id="sec-10"><SecDeps {...p} /></div>
    </div>
  )
}
