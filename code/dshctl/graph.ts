/**
 * graph.ts — 域构造组合预览（GUI 向导 /api/graph/preview 的纯推导 + 建域槽声明落盘）。
 * 归属（pack→被裁成员）与 core 槽状态（ok/exempt/empty）全部从既有数据推导，不新增事实源。
 * 向导 isActive 口径比 roster-less check 更严：成员须「合并面未禁 ∪ spec.plugins」才算覆盖
 * （向导阶段无 roster，声明了但未插入实现的不算——裁空如实暴露，建域前解决）。
 */
import { coreIds, coreViolations, saveSlotMember, type CoreList } from './core.ts'
import { mergePacks, type CapabilityPack } from './packs.ts'

export interface PreviewPack { id: string; description: string; memberIds: string[] }
export interface PreviewSlot { slot: string; carriers: string[]; covering: string[]; status: 'ok' | 'exempt' | 'empty' }
export interface GraphPreview {
  packs: PreviewPack[]
  entries: Array<{ id: string; disabled?: boolean; inject?: string[]; config?: unknown }>
  errors: string[]
  core: CoreList
  slots: PreviewSlot[]
  violations: string[]
}

export function previewComposition(packs: CapabilityPack[], picked: string[], pluginIds: string[], coreList: CoreList): GraphPreview {
  const pick = picked.filter((x) => x !== 'core')
  const merged = mergePacks(packs, pick)
  const disabledIds = new Set(merged.entries.filter((e) => e.disabled).map((e) => e.id))
  const active = new Set(pluginIds)
  const isActive = (m: string): boolean => !disabledIds.has(m) || active.has(m)
  // 归属：各片段原始 disable id ∩ 最终 disable 集（keep_tools 放回的不算该包成员）
  const outPacks: PreviewPack[] = ['core', ...pick].map((id) => {
    const pk = packs.find((x) => x.pack === id)
    const raw = (pk?.disable ?? {}) as Record<string, unknown>
    const ids = new Set<string>()
    for (const key of ['tools', 'skills', 'commands', 'surfaces', 'mcp'] as const) {
      for (const v of (raw[key] as unknown[] | undefined) ?? []) ids.add(String(v))
    }
    return {
      id,
      description: pk?.description ?? (id === 'core' ? '核心层（恒隐含必裁）' : ''),
      memberIds: [...ids].filter((x) => disabledIds.has(x)),
    }
  })
  // 槽聚合：slots 记录 ∪ core 条目 slot 标记（标记无 slots 段 → 虚拟槽，防漏报）
  const groups = new Map<string, Set<string>>()
  for (const [name, s] of Object.entries(coreList.slots ?? {})) groups.set(name, new Set(s.members))
  for (const e of coreList.core) {
    if (!e.slot) continue
    const g = groups.get(e.slot) ?? new Set<string>()
    g.add(e.id)
    groups.set(e.slot, g)
  }
  const slots: PreviewSlot[] = [...groups.entries()].map(([slot, members]) => {
    const carriers = coreList.core.filter((e) => e.slot === slot && disabledIds.has(e.id)).map((e) => e.id)
    const covering = [...members].filter((m) => isActive(m) && !carriers.includes(m))
    return { slot, carriers, covering, status: carriers.length === 0 ? 'ok' : covering.length ? 'exempt' : 'empty' }
  })
  const declaredSlotIds = new Set(coreList.core.filter((e) => e.slot && coreList.slots?.[e.slot]).map((e) => e.id))
  const violations = coreViolations([...disabledIds], coreIds(coreList.core)).filter((id) => !declaredSlotIds.has(id))
  return { packs: outPacks, entries: merged.entries, errors: merged.errors, core: coreList, slots, violations }
}

/**
 * 建域时的槽声明落盘：逐条 saveSlotMember 写 core.yml slots；已声明跳过（幂等）；
 * 参数不合法抛错——调用方（GUI /api/domain）负责回滚刚写的 domain.yml 保持两清单一致。
 * decls 兼容 {carrier, member}（组合图收集形态）与 {slot, member}（按槽名解析首载体）。
 */
export function applySlotDeclarations(corePath: string, decls: Array<{ carrier?: string; slot?: string; member?: string }>, coreList: CoreList): Array<{ slot: string; carrier: string; member: string }> {
  const declared: Array<{ slot: string; carrier: string; member: string }> = []
  const batchSeen = new Set<string>()
  for (const d of decls) {
    const member = String(d.member ?? '')
    let carrier = String(d.carrier ?? '')
    if (!carrier && d.slot) carrier = coreList.core.find((e) => e.slot === String(d.slot))?.id ?? ''
    if (!carrier || !member) throw new Error(`槽声明缺 carrier/member：${JSON.stringify(d)}`)
    if (carrier === member) throw new Error(`槽声明 carrier 与 member 相同（${carrier}）`)
    const slotName = coreList.core.find((e) => e.id === carrier)?.slot ?? carrier
    if (coreList.slots?.[slotName]?.members?.includes(member) || batchSeen.has(`${slotName}:${member}`)) continue
    const used = saveSlotMember(corePath, carrier, member)
    declared.push({ slot: used, carrier, member })
    batchSeen.add(`${used}:${member}`)
  }
  return declared
}
