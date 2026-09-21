/**
 * core.ts — DSH 核心功能清单（plugin-registry/core.yml）：check R11 共用。
 * 语义：核心「功能」不可缺，非「实现」不可换——
 *   · 无 slot 的 id = 严格红线（disable 命中即违规）；
 *   · 带 slot 的 id = 功能槽载体——禁用它需同槽其他成员活跃（槽成员可不在本清单）。
 * schema 2（加法扩展）：core 为 { id, slot?, group?, desc? }[]，顶层 slots 声明功能槽；
 * schema 1（纯字符串数组）读入时 normalize 为 { id } 条目——旧清单向后兼容。
 */
import { readFileSync, existsSync } from 'node:fs'
import type YAML from 'yaml'
import { loadYamlText, editYaml } from './yml.ts'

export interface CoreEntry { id: string; slot?: string; group?: string; desc?: string }
/** 功能槽：成员任一活跃即视为槽覆盖（成员可含非 core 的上游 twin / 自研插件） */
export interface CoreSlot { desc?: string; members: string[] }
export interface CoreList { schema: number; core: CoreEntry[]; slots?: Record<string, CoreSlot> }

/** 读核心清单；缺失 → 空（R11 降级为 pass，不挡流程）；旧格式字符串条目归一化为 { id } */
export function loadCoreList(path: string): CoreList {
  if (!existsSync(path)) return { schema: 2, core: [] }
  const raw = loadYamlText(readFileSync(path, 'utf8')) as {
    schema?: number; core?: Array<string | CoreEntry>; slots?: Record<string, { desc?: string; members?: unknown }>
  } | null
  const core: CoreEntry[] = (raw?.core ?? []).map((e) => (typeof e === 'string' ? { id: e } : e))
  let slots: Record<string, CoreSlot> | undefined
  if (raw?.slots && typeof raw.slots === 'object') {
    const norm: Record<string, CoreSlot> = {}
    for (const [name, v] of Object.entries(raw.slots)) {
      if (Array.isArray(v?.members)) norm[name] = { ...(v.desc ? { desc: String(v.desc) } : {}), members: v.members.map(String) }
    }
    if (Object.keys(norm).length) slots = norm
  }
  return { schema: raw?.schema ?? 2, core, ...(slots ? { slots } : {}) }
}

/** CoreEntry[] → id[]（R11/计数等只关心 id 的消费方用） */
export function coreIds(core: CoreEntry[]): string[] {
  return core.map((e) => e.id)
}

/** R11 严格判据：disable 集合 ∩ core 清单 → 违规 id（空 = 无违规）；overrides 不算裁剪 */
export function coreViolations(disabledIds: string[], core: string[]): string[] {
  const s = new Set(core)
  return disabledIds.filter((id) => s.has(id))
}

export interface SlotFinding {
  /** 被禁的槽载体 id */
  id: string
  slot: string
  /** 禁用后仍活跃的其他槽成员（空 = 槽被裁空，违规） */
  covering: string[]
}

/**
 * 替换通道：给载体声明功能槽成员（纯 Document 变更，返回实际使用的槽名）。
 * - 载体条目已有 slot → 复用其名；无 → 以载体 id 建槽并补 `slot:` 标记。
 * - slots 已有该槽 → members ∪= member（含载体自身入列，幂等）。
 * 真实写（saveSlotMember）与预演 diff（虚拟写）共用本函数，保证两边逐字节一致。
 */
export function mutateSlotMember(doc: YAML.Document.Parsed, carrierId: string, memberId: string): string {
  if (carrierId === memberId) throw new Error(`saveSlotMember: 载体与成员相同（${carrierId}）`)
  let slotName = ''
  {
    const coreSeq = doc.get('core')
    const items = coreSeq && typeof (coreSeq as { items?: unknown[] }).items === 'object' ? (coreSeq as { items: unknown[] }).items : []
    let carrier: { get: (k: string) => unknown; set: (k: string, v: unknown) => void } | undefined
    for (const it of items as Array<{ get: (k: string) => unknown; set: (k: string, v: unknown) => void }>) {
      if (typeof it?.get === 'function' && it.get('id') === carrierId) { carrier = it; break }
    }
    if (!carrier) throw new Error(`saveSlotMember: core 清单无此载体 ${carrierId}`)
    const existing = carrier.get('slot')
    slotName = typeof existing === 'string' && existing ? existing : carrierId
    if (!existing) carrier.set('slot', slotName)

    let slots = doc.get('slots') as { get: (k: string) => unknown; set: (k: string, v: unknown) => void } | undefined
    if (!slots) {
      // 新建 slots 节（doc.set 追加到末尾，再搬到 core 之前——避免落到 61 条清单后面）
      // 注意：doc.set 新 key 的 pair.key 是裸 string（既有键是 Scalar）——两种形态都要能匹配
      doc.set('slots', { [slotName]: { desc: `由 dshctl replace 自动声明（${carrierId} → ${memberId}）`, members: [carrierId, memberId] } })
      const contents = doc.contents as { items: unknown[] }
      const keyOf = (p: unknown): string => {
        const k = (p as { key?: unknown }).key
        return typeof k === 'string' ? k : String((k as { value?: unknown })?.value ?? '')
      }
      const idx = contents.items.findIndex((p) => keyOf(p) === 'slots')
      const coreI = contents.items.findIndex((p) => keyOf(p) === 'core')
      if (idx >= 0 && coreI >= 0 && idx > coreI) {
        const [pair] = contents.items.splice(idx, 1)
        contents.items.splice(coreI, 0, pair)
      }
      return slotName
    }
    const slotVal = slots.get(slotName) as { get?: (k: string) => unknown; set?: (k: string, v: unknown) => void } | undefined
    if (!slotVal) {
      slots.set(slotName, { desc: `由 dshctl replace 自动声明（${carrierId} → ${memberId}）`, members: [carrierId, memberId] })
      return slotName
    }
    const members = slotVal.get?.('members') as { items?: unknown[]; add?: (v: unknown) => void } | undefined
    const list = Array.isArray(members?.items) ? members!.items!.map((n) => String((n as { value?: unknown })?.value ?? n)) : []
    if (!list.includes(memberId)) {
      if (members?.add) members.add(memberId)
      else slotVal.set?.('members', [...list, memberId])
    }
    if (!list.includes(carrierId)) {
      const m2 = slotVal.get?.('members') as { add?: (v: unknown) => void } | undefined
      if (m2?.add) m2.add(carrierId)
    }
  }
  return slotName
}

/** 声明槽成员并原子写回 core.yml（保注释）；返回实际使用的槽名。 */
export function saveSlotMember(corePath: string, carrierId: string, memberId: string): string {
  let slotName = ''
  editYaml(corePath, (doc) => { slotName = mutateSlotMember(doc, carrierId, memberId) })
  return slotName
}

/**
 * R11 槽判据：只看「带 slot 标记且被 disable」的核心 id。
 * 覆盖判定 = ∃ 其他成员 未被 disable 且 isActive(member)；isActive 由调用方注入
 * （check.ts：有 roster 时 ∈ roster.ids ∪ spec.plugins，无 roster 时声明即活跃）。
 */
export function slotFindings(
  disabledIds: string[], core: CoreEntry[], slots: Record<string, CoreSlot> | undefined,
  isActive: (member: string) => boolean,
): SlotFinding[] {
  if (!slots) return []
  const disabled = new Set(disabledIds)
  const findings: SlotFinding[] = []
  for (const e of core) {
    if (!e.slot || !disabled.has(e.id)) continue
    const slot = slots[e.slot]
    if (!slot) continue // 槽未声明 → 不按槽豁免（由 coreViolations 走硬红线）
    const covering = slot.members.filter((m) => m !== e.id && !disabled.has(m) && isActive(m))
    findings.push({ id: e.id, slot: e.slot, covering })
  }
  return findings
}
