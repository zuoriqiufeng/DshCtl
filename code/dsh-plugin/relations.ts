/**
 * relations.ts — bkn/relations/*.bkn 图遍历器（DSH 版）
 *
 * 移植自 plugin/relations.py：解析 KWeaver 段落格式的关系文件，
 * 构建有向图并提供遍历/路径/路由查询。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const RELATION_TYPES = [
  'requires', 'implements', 'constrains', 'constrained_by',
  'prerequisite', 'risks_of', 'has_action',
  'references', 'runs_on', 'registered_on', 'supports',
  'implements_skill',
] as const

export type RelType = (typeof RELATION_TYPES)[number]

type Graph = Map<string, Map<string, string[]>>

export interface ExpandResult {
  entity: string
  relations: Record<string, Record<string, string[]>>
}

/** 解析段头部 `- **key**: value` 行（key 去粗体星号，支持中文 key）。 */
function parseKv(head: string): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const raw of head.split('\n')) {
    const line = raw.trim()
    const m = line.match(/^-?[ \t]*([^:\n>|# \t][^:\n]*?)[ \t]*:[ \t]*(.+)/)
    if (m) {
      kv[m[1].trim().replace(/\*/g, '').trim()] = m[2].trim()
    }
  }
  return kv
}

/** 把段切成 (头部, 映射规则区)；映射规则区以 `- **映射规则**:` 起始。 */
function splitMappingBlock(block: string): [string, string] {
  const m = block.match(/^[ \t]*-[ \t]*\*\*映射规则\*\*[ \t]*:[ \t]*$/m)
  if (!m) return [block, '']
  return [block.slice(0, m.index), block.slice(m.index! + m[0].length)]
}

/** 从映射规则区逐行抓取 `src` → `tgt`（# 后注释忽略；`(abstract)` 后缀剥离）。 */
function* iterMappingLines(mapping: string): Generator<[string, string]> {
  const pat = /`([^`]+)`[ \t]*→[ \t]*`([^`]+)`/
  for (const raw of mapping.split('\n')) {
    const line = raw.split('#', 1)[0]
    const m = pat.exec(line)
    if (m) {
      let tgt = m[2].trim()
      if (tgt.endsWith('(abstract)')) tgt = tgt.slice(0, -'(abstract)'.length).trim()
      yield [m[1].trim(), tgt]
    }
  }
}

export class RelationTraverser {
  readonly root: string
  /** {source_id: {rel_type: [target_id]}} */
  readonly graph: Graph = new Map()

  constructor(bknRoot: string) {
    this.root = bknRoot
    const relDir = join(this.root, 'relations')
    this.#parseRelationsDir(relDir)
  }

  #parseRelationsDir(relDir: string): void {
    let files: string[]
    try {
      files = readdirSync(relDir).filter((f) => f.endsWith('.bkn')).sort()
    } catch {
      return
    }
    for (const file of files) {
      const text = readFileSync(join(relDir, file), 'utf8')
      for (const block of text.split(/\n(?=## Relation: )/)) {
        if (!block.includes('## Relation: ')) continue
        const [head, mapping] = splitMappingBlock(block)
        const kv = parseKv(head)
        const rel = (kv['关系类型'] ?? '').trim().toLowerCase()
        if (!(RELATION_TYPES as readonly string[]).includes(rel)) continue
        if (mapping) {
          for (const [src, tgt] of iterMappingLines(mapping)) {
            this.#addEdge(src, rel, tgt)
          }
        } else {
          const src = (kv['源对象'] ?? '').trim()
          const tgt = (kv['目标对象'] ?? '').trim()
          if (src && tgt && !src.includes('*') && !tgt.includes('*')) {
            this.#addEdge(src, rel, tgt)
          }
        }
      }
    }
  }

  #addEdge(src: string, rel: string, tgt: string): void {
    let byRel = this.graph.get(src)
    if (!byRel) {
      byRel = new Map()
      this.graph.set(src, byRel)
    }
    let targets = byRel.get(rel)
    if (!targets) {
      targets = []
      byRel.set(rel, targets)
    }
    targets.push(tgt)
  }

  /** 返回 source 的出边目标（可指定关系类型）。 */
  getTargets(sourceId: string, relType?: string): string[] {
    const byRel = this.graph.get(sourceId)
    if (!byRel) return []
    if (relType) return byRel.get(relType) ?? []
    const all: string[] = []
    for (const targets of byRel.values()) all.push(...targets)
    return all
  }

  /** 返回指向 target 的入边源。 */
  getSources(targetId: string, relType?: string): string[] {
    const result: string[] = []
    for (const [src, byRel] of this.graph) {
      for (const [rel, targets] of byRel) {
        if (relType && rel !== relType) continue
        if (targets.includes(targetId)) result.push(src)
      }
    }
    return result
  }

  /** 从实体出发 BFS 展开 N 层。 */
  expand(entityId: string, depth = 3): ExpandResult {
    const visited = new Set<string>()
    const relations: Record<string, Record<string, string[]>> = {}
    const queue: Array<[string, number]> = [[entityId, 0]]
    while (queue.length) {
      const [current, d] = queue.shift()!
      if (d >= depth || visited.has(current)) continue
      visited.add(current)
      if (!relations[current]) relations[current] = {}
      const byRel = this.graph.get(current)
      if (!byRel) continue
      for (const [relType, targets] of byRel) {
        if (!relations[current][relType]) relations[current][relType] = []
        relations[current][relType].push(...targets)
        for (const t of targets) {
          if (!visited.has(t) && d + 1 < depth) queue.push([t, d + 1])
        }
      }
    }
    return { entity: entityId, relations }
  }

  /** A→B 最短路径（BFS），路径上以 `--rel-->` 标记关系。 */
  findPath(sourceId: string, targetId: string, maxDepth = 5): string[] | null {
    const queue: string[][] = [[sourceId]]
    const visited = new Set([sourceId])
    while (queue.length) {
      const path = queue.shift()!
      const node = path[path.length - 1]
      if (node === targetId) return path
      if (path.length >= maxDepth) continue
      const byRel = this.graph.get(node)
      if (!byRel) continue
      for (const [relType, targets] of byRel) {
        for (const t of targets) {
          if (!visited.has(t)) {
            visited.add(t)
            queue.push([...path, `--${relType}-->`, t])
          }
        }
      }
    }
    return null
  }

  /** 兼容查询：归一化 `action:` 前缀后同时匹配带前缀与裸键（不同关系块的书写约定不同）。 */
  #edges(id: string, rel: string): string[] {
    const bare = id.replace(/^action:/, '')
    const prefixed = this.graph.get(`action:${bare}`)?.get(rel) ?? []
    const plain = this.graph.get(bare)?.get(rel) ?? []
    return [...new Set([...prefixed, ...plain])]
  }

  /** 查 action capability 绑定的所有 Skill（去重）。 */
  getSkillsForAction(capability: string): string[] {
    const bare = capability.replace(/^action:/, '')
    const seen = new Set<string>()
    const result: string[] = []
    const targets = this.graph.get(`action:${bare}`)?.get('implements_skill') ?? []
    for (const tgt of targets) {
      const name = tgt.replace(/^skill:/, '')
      if (name && !seen.has(name)) {
        seen.add(name)
        result.push(name)
      }
    }
    return result
  }

  /** 查 action capability 绑定的 Skill（兼容入口，返回第一个）。 */
  getSkillForAction(capability: string): string | null {
    return this.getSkillsForAction(capability)[0] ?? null
  }

  /** 查 Object 关联的所有 Action。 */
  getActionsForObject(objectId: string): string[] {
    return this.graph.get(objectId)?.get('has_action') ?? []
  }

  /** 查 Action 的操作约束。 */
  getConstraintsForAction(actionId: string): string[] {
    return this.#edges(actionId, 'constrained_by')
  }

  /** 查 Action 的风险。 */
  getRisksForAction(actionId: string): string[] {
    return this.#edges(actionId, 'risks_of')
  }
}
