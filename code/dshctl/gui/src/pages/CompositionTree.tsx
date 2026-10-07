import { useMemo, useState } from 'react'
import { Drawer, Button, Space, Typography, Tag, Tooltip } from 'antd'
import { NodeIndexOutlined } from '@ant-design/icons'
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GRAY, CommandChip, Hint, type Spec } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** /api/graph/preview 响应（server.ts 组装） */
export interface PreviewData {
  packs: Array<{ id: string; description: string; memberIds: string[] }>
  entries: Array<{ id: string; disabled?: boolean; inject?: string[]; config?: unknown }>
  errors: string[]
  core: { schema: number; core: Array<{ id: string; slot?: string; group?: string; desc?: string }>; slots?: Record<string, { desc?: string; members: string[] }> }
  registry: Array<{ id: string; path?: string; trusted: boolean; source?: string; description?: string; category?: string; provides?: string[]; depends_on?: string[]; external?: any[] }>
  slots: Array<{ slot: string; carriers: string[]; covering: string[]; status: 'ok' | 'exempt' | 'empty' }>
  violations: string[]
}
/** 槽替换声明（建域时写 core.yml slots；carrier=被裁载体，member=补位库插件） */
export interface SlotDecl { carrier: string; member: string }

type NodeKind = 'pack' | 'slot' | 'cut' | 'plugin' | 'lib' | 'api' | 'dep'
type FlowData = {
  kind: NodeKind
  label: string
  sub?: string
  badge?: string
  badgeColor?: string
  status?: 'ok' | 'exempt' | 'empty'
  declared?: string
  libId?: string
  libPath?: string
  candidates?: Array<{ id: string; path?: string }>
  onAdd?: () => void
  onReplaceMember?: (memberId: string) => void
  onDetail?: () => void
}

const KIND_STYLE: Record<NodeKind, { color: string; bg: string }> = {
  pack: { color: '#722ed1', bg: '#f9f0ff' },
  slot: { color: '#13c2c2', bg: '#e6fffb' },
  cut: { color: '#bfbfbf', bg: '#fafafa' },
  plugin: { color: '#1677ff', bg: '#eef4ff' },
  lib: { color: '#8c8c8c', bg: '#f5f5f5' },
  api: { color: '#eb2f96', bg: '#fff0f6' },
  dep: { color: '#fa8c16', bg: '#fff7e6' },
}
const SLOT_STATUS: Record<string, { badge: string; color: string }> = {
  ok: { badge: '覆盖', color: '#52c41a' },
  exempt: { badge: '豁免', color: '#52c41a' },
  empty: { badge: '裁空', color: '#ff4d4f' },
}

function FlowNode({ data }: NodeProps<Node<FlowData>>) {
  const s = KIND_STYLE[data.kind]
  const ghost = data.kind === 'lib' || data.kind === 'cut'
  const hard = data.kind === 'cut' && data.badge === '核心被裁'
  return (
    <div style={{
      background: data.kind === 'lib' ? '#fafafa' : data.kind === 'cut' ? (hard ? '#fff1f0' : '#fafafa') : '#fff',
      border: ghost ? `1px dashed ${hard ? '#ff4d4f' : s.color}` : '1px solid #e5e9f0',
      borderRadius: 10, padding: ghost ? '5px 10px' : '8px 12px', minWidth: data.kind === 'cut' ? 150 : 168,
      boxShadow: ghost ? 'none' : '0 1px 3px rgba(16,24,40,0.08)',
      borderLeft: ghost ? undefined : `4px solid ${data.kind === 'slot' && data.status ? SLOT_STATUS[data.status].color : s.color}`,
      cursor: 'default',
    }}>
      <Handle type="target" position={Position.Left} style={{ background: s.color, width: 7, height: 7, border: 'none', opacity: ghost ? 0.5 : 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: ghost ? 500 : 600, fontSize: ghost ? 12.5 : 13.5, color: ghost ? (hard ? '#ff4d4f' : '#8c8c8c') : undefined }}>{data.label}</span>
        {data.badge && <span style={{ fontSize: 11, padding: '0 6px', borderRadius: 6, background: (data.badgeColor ?? s.bg), color: (data.badgeColor ? '#fff' : s.color), whiteSpace: 'nowrap' }}>{data.badge}</span>}
        {data.kind === 'lib' && (
          <button className="nodrag" onClick={(e) => { e.stopPropagation(); data.onAdd?.() }}
            style={{ marginLeft: 'auto', fontSize: 11, padding: '1px 8px', borderRadius: 6, border: '1px solid #d9d9d9', background: '#fff', color: '#1677ff', cursor: 'pointer' }}>+ 加入</button>
        )}
      </div>
      {data.sub && <div style={{ fontSize: 11, color: GRAY.weak, marginTop: 2, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.sub}</div>}
      {data.kind === 'slot' && data.status === 'empty' && !!data.candidates?.length && (
        <select className="nodrag" defaultValue=""
          onChange={(e) => { const v = e.target.value; e.currentTarget.value = ''; if (v) data.onReplaceMember?.(v) }}
          style={{ marginTop: 4, fontSize: 11, padding: '1px 4px', borderRadius: 6, border: '1px solid #ffccc7', color: '#ff4d4f', background: '#fff', maxWidth: 150 }}>
          <option value="">设为替换…</option>
          {data.candidates.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
      )}
      {data.declared && <div style={{ fontSize: 10.5, color: '#52c41a', marginTop: 2 }}>将声明成员: {data.declared}</div>}
      <Handle type="source" position={Position.Right} style={{ background: s.color, width: 7, height: 7, border: 'none', opacity: ghost ? 0.5 : 1 }} />
    </div>
  )
}
const nodeTypes = { dsh: FlowNode }

const COL = 285; const TOP = 24; const ROW_SLOT = 108; const ROW_CUT = 62; const ROW = 104; const ROW_LIB = 76

type LibEntry = PreviewData['registry'][number]

/** 五列组合图：能力包 → 核心槽+被裁成员 → 激活插件+API → 插件库(ghost) → 共享依赖 */
function deriveGraph(preview: PreviewData, spec: Spec, decls: SlotDecl[], lib: LibEntry[], onAdd: (id: string, path: string) => void, onReplace: (slot: string, memberId: string) => void, onDetail: (d: FlowData) => void) {
  const pluginIds = new Set(((spec.plugins ?? []) as any[]).map((p: any) => String(p.id)))
  const apiId = String(spec.api_server?.plugin_id || 'domain-api')
  const deps = ((spec.shared_deps ?? []) as Array<{ name: string; url: string }>).filter((d) => d.name)
  const addable = lib.filter((l) => !pluginIds.has(l.id) && l.id !== apiId)

  const nodes: Node<FlowData>[] = []
  const edges: Edge[] = []

  // 列0：能力包（core 恒隐含在前）
  preview.packs.forEach((pk, i) => {
    nodes.push({
      id: `pack:${pk.id}`, type: 'dsh', position: { x: 0, y: TOP + i * ROW }, draggable: false,
      data: {
        kind: 'pack', label: pk.id, sub: pk.description || undefined,
        badge: pk.id === 'core' ? '隐含' : `裁 ${pk.memberIds.length}`,
        onDetail: () => onDetail({ kind: 'pack', label: pk.id, sub: pk.description }),
      },
    })
  })

  // 列1：核心槽 + 被裁成员（非槽载体）。slot 载体被裁走 pack→slot 边；hard violation 红色 cut 节点
  const coreSlotIds = new Set<string>()
  for (const s of preview.slots) for (const c of s.carriers) coreSlotIds.add(c)
  const coreIds = new Set(preview.core.core.map((e) => e.id))
  const memberOfPack = new Map<string, string[]>() // packId → 待渲染 cut ids
  for (const pk of preview.packs) {
    memberOfPack.set(pk.id, pk.memberIds.filter((m) => !coreSlotIds.has(m)).slice(0, 6))
  }
  let y1 = TOP
  for (const s of [...preview.slots].sort((a, b) => (a.status === 'empty' ? -1 : b.status === 'empty' ? 1 : a.slot.localeCompare(b.slot)))) {
    const decl = decls.find((d) => s.carriers.includes(d.carrier))
    const status = decl ? 'exempt' : s.status // 已选替换 → 建域时自动声明，按豁免展示
    const slotCore = preview.core.slots?.[s.slot]
    nodes.push({
      id: `slot:${s.slot}`, type: 'dsh', position: { x: COL, y: y1 }, draggable: false,
      data: {
        kind: 'slot', label: s.slot, sub: s.carriers.length ? `载体 ${s.carriers.join('/')}` : (slotCore ? (slotCore.members ?? []).filter((m) => !preview.core.core.some((e) => e.id === m && e.slot === s.slot)).join('/') : undefined),
        status, badge: SLOT_STATUS[status].badge, badgeColor: SLOT_STATUS[status].color,
        declared: decl?.member,
        candidates: s.status === 'empty' && !decl ? addable.map((a) => ({ id: a.id, path: a.path })) : undefined,
        onReplaceMember: s.status === 'empty' && !decl ? (mid) => onReplace(s.slot, mid) : undefined,
        onDetail: () => onDetail({ kind: 'slot', label: s.slot, sub: slotCore?.desc, badge: `成员: ${(slotCore?.members ?? []).join(', ') || s.carriers.join('/')}` }),
      },
    })
    y1 += ROW_SLOT
  }
  for (const [packId, members] of memberOfPack) {
    for (const m of members) {
      const hard = coreIds.has(m) && !coreSlotIds.has(m)
      nodes.push({
        id: `cut:${m}`, type: 'dsh', position: { x: COL, y: y1 }, draggable: false,
        data: {
          kind: 'cut', label: m, badge: hard ? '核心被裁' : undefined,
          sub: hard ? '无槽严格红线（R11 error）' : `被 ${packId} 裁剪`,
          onDetail: () => onDetail({ kind: 'cut', label: m, sub: hard ? '核心必须件被裁——R11 error；确需替换须先在 core.yml 开槽' : `上游行，被能力包 ${packId} disable` }),
        },
      })
      edges.push({ id: `e:${packId}->cut:${m}`, source: `pack:${packId}`, target: `cut:${m}`, style: { stroke: hard ? '#ff4d4f' : '#d9d9d9' } })
      y1 += ROW_CUT
    }
  }

  // 列2：激活插件 + domain-api
  let y2 = TOP
  for (const pl of (spec.plugins ?? []) as Array<{ id: string; path: string }>) {
    const e = lib.find((l) => l.id === pl.id)
    nodes.push({
      id: `plug:${pl.id}`, type: 'dsh', position: { x: COL * 2, y: y2 }, draggable: false,
      data: {
        kind: 'plugin', label: pl.id, sub: pl.path,
        badge: e ? (e.trusted ? (e.source ?? 'local') : 'untrusted') : '未入库',
        onDetail: () => onDetail({ kind: 'plugin', label: pl.id, sub: pl.path, libId: pl.id, libPath: e?.path ?? pl.path }),
      },
    })
    y2 += ROW
  }
  const apiY = y2
  nodes.push({
    id: `api:${apiId}`, type: 'dsh', position: { x: COL * 2, y: apiY }, draggable: false,
    data: { kind: 'api', label: apiId, badge: 'domain-api', sub: spec.api_server?.plugin_path, onDetail: () => onDetail({ kind: 'api', label: apiId, sub: 'api_server 自动注入，勿在插件库选择' }) },
  })

  // 列3：插件库（ghost，未加入本域的）
  addable.forEach((l, i) => {
    const decl = decls.find((d) => d.member === l.id)
    nodes.push({
      id: `lib:${l.id}`, type: 'dsh', position: { x: COL * 3, y: TOP + i * ROW_LIB }, draggable: false,
      data: {
        kind: 'lib', label: l.id, sub: [l.category, l.description].filter(Boolean).join(' · ') || l.path,
        declared: decl ? decl.carrier : undefined,
        badge: l.trusted ? undefined : 'untrusted',
        libId: l.id, libPath: l.path,
        onAdd: () => onAdd(l.id, l.path ?? ''),
        onDetail: () => onDetail({ kind: 'lib', label: l.id, sub: l.description, libId: l.id, libPath: l.path }),
      },
    })
  })

  // 列4：共享依赖
  deps.forEach((d, i) => {
    nodes.push({ id: `dep:${d.name}`, type: 'dsh', position: { x: COL * 4, y: TOP + i * ROW }, draggable: false, data: { kind: 'dep', label: d.name, sub: d.url, onDetail: () => onDetail({ kind: 'dep', label: d.name, sub: d.url }) } })
  })

  // 边：pack → slot（真实裁剪归属）；slot → 活跃成员（替换关系）；api → plugin / dep；depends_on 声明
  for (const pk of preview.packs) {
    for (const s of preview.slots) {
      if (!s.carriers.some((c) => pk.memberIds.includes(c))) continue
      edges.push({
        id: `e:${pk.id}->slot:${s.slot}`, source: `pack:${pk.id}`, target: `slot:${s.slot}`,
        style: { stroke: s.status === 'empty' ? '#ff4d4f' : '#52c41a' },
        label: s.status === 'empty' ? '载体被裁' : undefined, labelStyle: { fontSize: 10, fill: s.status === 'empty' ? '#ff4d4f' : '#52c41a' },
      })
    }
  }
  for (const s of preview.slots) {
    if (s.status === 'ok') continue
    for (const m of s.covering) {
      if (!pluginIds.has(m)) continue
      edges.push({ id: `e:slot:${s.slot}->plug:${m}`, source: `slot:${s.slot}`, target: `plug:${m}`, style: { stroke: '#52c41a' }, label: '槽成员', labelStyle: { fontSize: 10, fill: '#52c41a' } })
    }
  }
  // 「设为替换」已收集、建域时落盘的声明边（预览 core 未写 → covering 不含，单独连）
  for (const d of decls) {
    if (!pluginIds.has(d.member)) continue
    for (const s of preview.slots) {
      if (!s.carriers.includes(d.carrier) || s.covering.includes(d.member)) continue
      edges.push({ id: `e:decl:${s.slot}->plug:${d.member}`, source: `slot:${s.slot}`, target: `plug:${d.member}`, style: { stroke: '#52c41a', strokeDasharray: '4 4' }, label: '将声明', labelStyle: { fontSize: 10, fill: '#52c41a' } })
    }
  }
  for (const pl of (spec.plugins ?? []) as Array<{ id: string }>) {
    edges.push({ id: `e:api-${pl.id}`, source: `api:${apiId}`, target: `plug:${pl.id}`, style: { stroke: '#91caff' }, animated: true })
  }
  for (const d of deps) edges.push({ id: `e:api-dep-${d.name}`, source: `api:${apiId}`, target: `dep:${d.name}`, style: { stroke: '#ffd591' } })
  for (const l of lib) {
    for (const dep of l.depends_on ?? []) {
      const target = nodes.find((n) => n.id === `plug:${dep}`) ? `plug:${dep}` : nodes.find((n) => n.id === `lib:${dep}`) ? `lib:${dep}` : nodes.find((n) => n.id === `dep:${dep}`) ? `dep:${dep}` : null
      if (target && target !== `plug:${l.id}` && target !== `lib:${l.id}`) {
        edges.push({ id: `e:decl-${l.id}-${dep}`, source: nodes.find((n) => n.id === `plug:${l.id}`) ? `plug:${l.id}` : `lib:${l.id}`, target, style: { stroke: '#b37feb', strokeDasharray: '5 5' }, label: 'depends_on', labelStyle: { fontSize: 10, fill: '#b37feb' } })
      }
    }
  }
  return { nodes, edges }
}

export default function CompositionTree({ preview, spec, set, slotDecls, setSlotDecls, height = 560 }: {
  preview: PreviewData | null
  spec: Spec
  set: (patch: Spec) => void
  slotDecls: SlotDecl[]
  setSlotDecls: (d: SlotDecl[]) => void
  height?: number
}) {
  const [detail, setDetail] = useState<FlowData | null>(null)
  const lib = preview?.registry ?? []

  const onAdd = (id: string, path: string) => {
    if (((spec.plugins ?? []) as any[]).some((p: any) => p.id === id)) return
    set({ plugins: [...((spec.plugins ?? []) as any[]), { id, path }] })
  }
  const onReplace = (slot: string, memberId: string) => {
    const s = preview?.slots.find((x) => x.slot === slot)
    const carrier = s?.carriers[0]
    if (!carrier) return
    onAdd(memberId, lib.find((l) => l.id === memberId)?.path ?? '')
    if (!slotDecls.some((d) => d.carrier === carrier && d.member === memberId)) {
      setSlotDecls([...slotDecls, { carrier, member: memberId }])
    }
  }

  const graph = useMemo(
    () => preview ? deriveGraph(preview, spec, slotDecls, lib, onAdd, onReplace, (d) => setDetail(d)) : { nodes: [], edges: [] },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preview, spec, slotDecls],
  )

  const emptyCount = preview?.slots.filter((s) => s.status === 'empty' && !slotDecls.some((d) => s.carriers.includes(d.carrier))).length ?? 0
  return (
    <div style={{ position: 'relative', height, border: '1px solid #e5e9f0', borderRadius: 12, overflow: 'hidden', background: '#fbfcfe' }}>
      <div style={{ position: 'absolute', top: 10, left: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <NodeIndexOutlined /> 组合图（实时预览）· 双击节点看详情
          <Hint title="五列：能力包 → 核心槽/被裁成员 → 激活插件+API → 插件库（虚线可加入）→ 共享依赖。裁空的槽可在槽节点上「设为替换」——建域时自动写入 core.yml slots（R11 豁免）" />
        </Typography.Text>
      </div>
      <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 5, display: 'flex', gap: 8, alignItems: 'center' }}>
        {!!preview?.violations?.length && <Tag color="red" style={{ marginInlineEnd: 0 }}>核心必须件被裁 {preview.violations.length}</Tag>}
        {emptyCount > 0 && <Tag color="volcano" style={{ marginInlineEnd: 0 }}>裁空槽 {emptyCount}</Tag>}
        {slotDecls.length > 0 && <Tag color="green" style={{ marginInlineEnd: 0 }}>将声明 {slotDecls.length} 项</Tag>}
        {preview?.errors?.length ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>归属冲突</Tag> : null}
      </div>
      <div style={{ position: 'absolute', bottom: 10, left: 12, zIndex: 5, display: 'flex', gap: 10, fontSize: 12, color: GRAY.weak, background: '#ffffffe6', padding: '4px 10px', borderRadius: 8, alignItems: 'center' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: '#91caff', verticalAlign: 'middle' }} /> api</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #b37feb', verticalAlign: 'middle' }} /> 声明</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: '#52c41a', verticalAlign: 'middle' }} /> 槽归属/成员</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: '#ff4d4f', verticalAlign: 'middle' }} /> 裁空/红线</span>
      </div>
      {preview ? (
        <ReactFlow
          nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
          onNodeDoubleClick={(_, n) => { const d = (n.data as FlowData); if (d.onDetail) d.onDetail() }}
          fitView minZoom={0.15} maxZoom={1.5}
          nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e5e9f0" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: GRAY.weak, fontSize: 13 }}>预览加载中…（勾选能力包后实时重算）</div>
      )}
      <Drawer open={!!detail} onClose={() => setDetail(null)} width={420} title={detail ? detail.label : ''}>
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <div><Typography.Text type="secondary">类型</Typography.Text><div><Tag color={KIND_STYLE[detail.kind].color}>{detail.kind}</Tag></div></div>
            {detail.sub && <div><Typography.Text type="secondary">说明</Typography.Text><div style={{ fontSize: 12.5 }}>{detail.sub}</div></div>}
            {detail.badge && <div><Typography.Text type="secondary">成员</Typography.Text><div style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{detail.badge}</div></div>}
            {detail.libId && <div><Typography.Text type="secondary">path</Typography.Text><div style={{ fontSize: 12, wordBreak: 'break-all' }}>{detail.libPath}</div></div>}
            {detail.libId && (() => {
              const e = lib.find((l) => l.id === detail.libId)
              if (!e) return null
              return <>
                {!!e.provides?.length && <div><Typography.Text type="secondary">provides</Typography.Text><div><Space wrap>{e.provides.map((t) => <Tag key={t} color="blue">{t}</Tag>)}</Space></div></div>}
                {!!e.depends_on?.length && <div><Typography.Text type="secondary">depends_on（声明）</Typography.Text><div><Space wrap>{e.depends_on.map((t) => <Tag key={t} color="purple">{t}</Tag>)}</Space></div></div>}
                {!!e.external?.length && <div><Typography.Text type="secondary">外部依赖</Typography.Text><div><Space wrap>{e.external.map((x: any, i: number) => <Tag key={i} color="orange">{x.kind ?? 'dep'}: {x.name ?? x.path ?? x.url ?? '?'}</Tag>)}</Space></div></div>}
                <div><Typography.Text type="secondary">信任</Typography.Text><div><Tag color={e.trusted ? 'green' : 'red'}>{e.trusted ? 'trusted' : 'untrusted（check R12 warn）'}</Tag></div></div>
              </>
            })()}
            {detail.kind === 'pack' && <CommandChip cmd={`cat code/capability-packs/${detail.label}.yml`} />}
            {detail.kind === 'slot' && <CommandChip cmd="cat plugin-registry/core.yml" />}
            {(detail.kind === 'lib' || detail.kind === 'plugin') && detail.libId && <CommandChip cmd={`dshctl plugin show ${detail.libId}`} />}
            {detail.kind === 'dep' && <CommandChip cmd={`curl -s ${detail.sub}/health`} />}
            {detail.kind === 'cut' && !detail.badge && <CommandChip cmd={`cat code/capability-packs/*.yml | grep -B2 -A2 ${detail.label}`} />}
          </Space>
        )}
      </Drawer>
    </div>
  )
}

export function PreviewHint({ preview }: { preview: PreviewData | null }) {
  if (!preview) return null
  const parts: string[] = []
  if (preview.errors?.length) parts.push(`归属冲突: ${preview.errors.join('；')}`)
  if (preview.violations.length) parts.push(`核心必须件被裁（不可建域）: ${preview.violations.join(', ')}`)
  const empties = preview.slots.filter((s) => s.status === 'empty')
  if (empties.length) parts.push(`裁空槽: ${empties.map((s) => s.slot).join(', ')}——在槽节点上「设为替换」后建域自动声明`)
  if (!parts.length) return null
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: '#d4380d', background: '#fff2e8', border: '1px solid #ffbb96', borderRadius: 8, padding: '6px 10px' }}>
      <Tooltip title="check R11 会拦住这些问题——组合图提前暴露，建域前解决">
        <span>⚠ {parts.join('；')}</span>
      </Tooltip>
    </div>
  )
}
