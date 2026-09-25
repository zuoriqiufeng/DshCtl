import { useMemo, useState, useCallback, useEffect } from 'react'
import { Drawer, Button, Space, Typography, Tag, Tooltip } from 'antd'
import { LockOutlined, UnlockOutlined, SaveOutlined, NodeIndexOutlined } from '@ant-design/icons'
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, type Node, type Edge, type NodeProps, type NodeChange, applyNodeChanges } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GRAY, api, CommandChip, Hint, type Spec } from '../api.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */

type NodeKind = 'pack' | 'plugin' | 'api' | 'dep'
type FlowData = { kind: NodeKind; label: string; sub?: string; badge?: string }

const KIND_STYLE: Record<NodeKind, { color: string; bg: string }> = {
  pack: { color: '#722ed1', bg: '#f9f0ff' },
  plugin: { color: '#1677ff', bg: '#eef4ff' },
  api: { color: '#eb2f96', bg: '#fff0f6' },
  dep: { color: '#fa8c16', bg: '#fff7e6' },
}

function FlowNode({ data }: NodeProps<Node<FlowData>>) {
  const s = KIND_STYLE[data.kind]
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e9f0', borderRadius: 10, padding: '10px 14px', minWidth: 170,
      boxShadow: '0 1px 3px rgba(16,24,40,0.08)', borderLeft: `4px solid ${s.color}`, cursor: 'grab',
    }}>
      <Handle type="target" position={Position.Left} style={{ background: s.color, width: 8, height: 8, border: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{data.label}</span>
        {data.badge && <span style={{ fontSize: 11.5, padding: '0 6px', borderRadius: 6, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{data.badge}</span>}
      </div>
      {data.sub && <div style={{ fontSize: 11.5, color: GRAY.weak, marginTop: 2, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.sub}</div>}
      <Handle type="source" position={Position.Right} style={{ background: s.color, width: 8, height: 8, border: 'none' }} />
    </div>
  )
}
const nodeTypes = { dsh: FlowNode }

type LibEntry = { id: string; trusted: boolean; source?: string; depends_on?: string[]; path?: string }

const COL = 300; const ROW = 110; const TOP = 30

/** 四层推导：能力包 → 领域插件 → domain-api → 外部依赖（单向无环）；depends_on 声明加虚线边 */
function deriveGraph(spec: Spec, lib: LibEntry[], order: string[], pos: Record<string, { x: number; y: number }>, locked: boolean) {
  const packs = ['core', ...((spec.capabilities ?? []) as string[]).filter((c: string) => c !== 'core')]
  const plugins = (spec.plugins ?? []) as Array<{ id: string; path: string }>
  const apiId = spec.api_server?.plugin_id as string | undefined
  const deps = (spec.shared_deps ?? []) as Array<{ name: string; url: string }>

  const nodes: Node<FlowData>[] = []
  const edges: Edge[] = []
  packs.forEach((p, i) => nodes.push({ id: `pack:${p}`, type: 'dsh', position: { x: 0, y: TOP + i * ROW }, data: { kind: 'pack', label: p, badge: p === 'core' ? '隐含' : '能力包' } }))
  order.forEach((id, i) => {
    const p = plugins.find((x) => x.id === id)
    if (!p) return
    const e = lib.find((l) => l.id === id)
    nodes.push({
      id: `plug:${id}`, type: 'dsh',
      position: pos[`plug:${id}`] ?? { x: COL, y: TOP + i * ROW },
      draggable: !locked,
      data: { kind: 'plugin', label: id, badge: e ? (e.trusted ? (e.source ?? 'local') : 'untrusted') : '未入库', sub: p.path },
    })
  })
  const apiY = TOP + Math.max(0, (order.length - 1) / 2) * ROW
  if (apiId) nodes.push({ id: `api:${apiId}`, type: 'dsh', position: { x: COL * 2, y: apiY }, data: { kind: 'api', label: apiId, badge: 'domain-api', sub: spec.api_server?.plugin_path } })
  deps.forEach((d, i) => nodes.push({ id: `dep:${d.name}`, type: 'dsh', position: { x: COL * 3, y: TOP + i * ROW }, data: { kind: 'dep', label: d.name, sub: d.url } }))

  for (const id of order) for (const pk of packs) edges.push({ id: `e:${pk}->${id}`, source: `pack:${pk}`, target: `plug:${id}`, style: { stroke: '#e0e4ea' } })
  if (apiId) {
    for (const id of order) edges.push({ id: `e:api-${id}`, source: `api:${apiId}`, target: `plug:${id}`, style: { stroke: '#91caff' }, animated: true })
    for (const d of deps) edges.push({ id: `e:api-dep-${d.name}`, source: `api:${apiId}`, target: `dep:${d.name}`, style: { stroke: '#ffd591' } })
  }
  for (const id of order) {
    const e = lib.find((l) => l.id === id)
    for (const dep of e?.depends_on ?? []) {
      const target = nodes.find((n) => n.id === `plug:${dep}`) ? `plug:${dep}` : nodes.find((n) => n.id === `dep:${dep}`) ? `dep:${dep}` : null
      if (target && target !== `plug:${id}`) edges.push({ id: `e:decl-${id}-${dep}`, source: `plug:${id}`, target, style: { stroke: '#b37feb', strokeDasharray: '5 5' }, label: 'depends_on', labelStyle: { fontSize: 10, fill: '#b37feb' } })
    }
  }
  return { nodes, edges }
}

export default function OrchestrationCanvas({ domain, spec, onSpecChange }: { domain: string; spec: Spec; onSpecChange: (s: Spec) => void }) {
  const [lib, setLib] = useState<LibEntry[]>([])
  const [order, setOrder] = useState<string[]>(((spec.plugins ?? []) as any[]).map((p: any) => p.id))
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({})
  const [locked, setLocked] = useState(false)
  const [detail, setDetail] = useState<{ id: string; kind: NodeKind; path?: string; sub?: string; depends_on?: string[] } | null>(null)
  const [nodes, setNodes] = useState<Node<FlowData>[]>([])

  useEffect(() => { void api<LibEntry[]>('/api/plugins').then((r) => setLib(r.data ?? [])) }, [])
  // spec.plugins 身份变化（切域/外部保存）→ 重置画布顺序与位置
  const idsKey = ((spec.plugins ?? []) as any[]).map((p: any) => p.id).join(',')
  useEffect(() => { setOrder(((spec.plugins ?? []) as any[]).map((p: any) => p.id)); setPos({}) }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const graph = useMemo(() => deriveGraph(spec, lib, order, pos, locked), [spec, lib, order, pos, locked])
  useEffect(() => { setNodes(graph.nodes) }, [graph])

  const onNodesChange = useCallback((changes: NodeChange[]) => { setNodes((nds) => applyNodeChanges(changes, nds)) }, [])
  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const pluginNodes = nodes.filter((n) => n.id.startsWith('plug:'))
    if (!pluginNodes.length) return
    const withY = pluginNodes.map((n) => ({ id: n.id, y: n.id === node.id ? node.position!.y : n.position!.y }))
    withY.sort((a, b) => a.y - b.y)
    setOrder(withY.map((n) => n.id.replace('plug:', '')))
    setPos({}) // 吸附回规范网格
  }, [nodes])

  const dirty = order.join(',') !== idsKey
  const save = async () => {
    const plugins = order.map((id) => ((spec.plugins ?? []) as any[]).find((p: any) => p.id === id)).filter(Boolean)
    const next = { ...spec, plugins }
    const r = await fetch(`/api/domain/${domain}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: next }) }).then((x) => x.json())
    if (r.error) { window.alert(r.error); return }
    onSpecChange(next)
  }

  return (
    <div style={{ position: 'relative', height: 580, border: '1px solid #e5e9f0', borderRadius: 12, overflow: 'hidden', background: '#fbfcfe' }}>
      <div style={{ position: 'absolute', top: 10, left: 12, zIndex: 5 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <NodeIndexOutlined /> 拖拽插件节点排序 · 双击看详情
          <Hint title="上下拖动插件节点 = 调整注册顺序（写回 domain.yml 的 plugins[]，影响 patch insert 注册序）；「保存顺序」后生效" />
        </Typography.Text>
      </div>
      <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 5, display: 'flex', gap: 8 }}>
        <Tooltip title={locked ? '解锁后可拖拽排序' : '锁定后节点不可拖动'}>
          <Button size="small" icon={locked ? <LockOutlined /> : <UnlockOutlined />} onClick={() => setLocked(!locked)}>{locked ? '已锁定' : '锁定布局'}</Button>
        </Tooltip>
        {dirty && <Button size="small" type="primary" icon={<SaveOutlined />} onClick={save}>保存顺序</Button>}
      </div>
      <div style={{ position: 'absolute', bottom: 10, left: 12, zIndex: 5, display: 'flex', gap: 10, fontSize: 12, color: GRAY.weak, background: '#ffffffe6', padding: '4px 10px', borderRadius: 8, alignItems: 'center' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: '#91caff', verticalAlign: 'middle' }} /> 依赖</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #b37feb', verticalAlign: 'middle' }} /> 声明</span>
        <Hint title="四层：能力包（紫）→ 领域插件（蓝）→ domain-api（粉）→ 外部依赖（橙）；实线=自动推导依赖，虚线=插件库 depends_on 声明" />
      </div>
      <ReactFlow
        nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(_, n) => {
          const d = n.data as FlowData
          const e = lib.find((l) => l.id === d.label)
          setDetail({ id: d.label, kind: d.kind, path: e?.path ?? (d.kind === 'plugin' ? undefined : d.sub), sub: d.sub, depends_on: e?.depends_on })
        }}
        fitView minZoom={0.3} maxZoom={1.6}
        nodesDraggable={!locked} nodesConnectable={false} edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e5e9f0" gap={22} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => KIND_STYLE[(n.data as FlowData).kind]?.color ?? '#d9d9d9'} maskColor="#f0f2f5cc" style={{ borderRadius: 8 }} />
      </ReactFlow>
      <Drawer open={!!detail} onClose={() => setDetail(null)} width={400} title={detail ? detail.id : ''}>
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <div><Typography.Text type="secondary">类型</Typography.Text><div><Tag color={KIND_STYLE[detail.kind].color}>{detail.kind}</Tag></div></div>
            {detail.path && <div><Typography.Text type="secondary">path</Typography.Text><div style={{ fontSize: 12, wordBreak: 'break-all' }}>{detail.path}</div></div>}
            {detail.sub && detail.sub !== detail.path && <div><Typography.Text type="secondary">说明</Typography.Text><div style={{ fontSize: 12 }}>{detail.sub}</div></div>}
            {!!detail.depends_on?.length && <div><Typography.Text type="secondary">depends_on（声明）</Typography.Text><div><Space wrap>{detail.depends_on.map((d) => <Tag key={d} color="purple">{d}</Tag>)}</Space></div></div>}
            {detail.kind === 'plugin' && <CommandChip cmd={`dshctl plugin show ${detail.id}`} />}
            {detail.kind === 'pack' && <CommandChip cmd={`cat code/capability-packs/${detail.id}.yml`} />}
            {detail.kind === 'dep' && <CommandChip cmd={`curl -s ${detail.sub}/health`} />}
            {detail.kind === 'api' && <CommandChip cmd={`dshctl check ${domain} --json`} />}
          </Space>
        )}
      </Drawer>
    </div>
  )
}
