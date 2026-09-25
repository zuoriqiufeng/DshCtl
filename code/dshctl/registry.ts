/**
 * registry.ts — domains/registry.yml 读写/upsert/端口冲突查重。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { relative } from 'node:path'
import { loadYamlText, dumpYaml, atomicWrite } from './yml.ts'

export interface RegistryEntry {
  domain: string
  dsh_home: string
  ports: { gui?: number | null; api?: number }
  systemd_unit?: string
  status?: string
  last_check?: { at: string; result: string; errors: number; warns: number }
  applied_at?: string
}

export interface Registry {
  instances: RegistryEntry[]
  shared_deps: Array<{ name: string; url: string }>
  unregistered_ports: number[]
}

export function emptyRegistry(): Registry {
  return { instances: [], shared_deps: [], unregistered_ports: [] }
}

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return emptyRegistry()
  const raw = loadYamlText(readFileSync(path, 'utf8')) as Partial<Registry> | null
  return {
    instances: raw?.instances ?? [],
    shared_deps: raw?.shared_deps ?? [],
    unregistered_ports: raw?.unregistered_ports ?? [],
  }
}

export function saveRegistry(path: string, reg: Registry): void {
  atomicWrite(path, dumpYaml(reg))
}

/** 查重：domain 名唯一；返回冲突说明（无冲突返回 []） */
export function findDomainConflicts(reg: Registry, spec: { domain: string; ports?: { gui?: number | null; api?: number } }): string[] {
  const out: string[] = []
  for (const inst of reg.instances) {
    if (inst.domain === spec.domain) continue
    for (const p of [spec.ports?.api, spec.ports?.gui]) {
      if (p && [inst.ports.api, inst.ports.gui].includes(p)) out.push(`端口 ${p} 与已登记实例 ${inst.domain} 冲突`)
    }
  }
  return out
}

export function upsertInstance(reg: Registry, entry: RegistryEntry): void {
  const i = reg.instances.findIndex((x) => x.domain === entry.domain)
  if (i >= 0) reg.instances[i] = { ...reg.instances[i]!, ...entry }
  else reg.instances.push(entry)
}

/** domains/ 下有 domain.yml 的领域名（排序）。目录缺失/为空返回 []。 */
export function listDomainNames(domainsDir: string): string[] {
  if (!existsSync(domainsDir)) return []
  return readdirSync(domainsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${domainsDir}/${d.name}/domain.yml`))
    .map((d) => d.name)
    .sort()
}

/**
 * <domain> 上下文推断（纯函数，供 CLI 与 self-test 共用）：
 * 显式给出 > cwd 落在 domains/<name>/（或其子目录）内 > 仅一个域时自动取；否则返回候选列表。
 */
export function pickDomain(cwd: string, domainsDir: string, explicit: string, names: string[]): { name: string } | { candidates: string[] } {
  if (explicit) return { name: explicit }
  const rel = relative(domainsDir, cwd)
  const top = rel && !rel.startsWith('..') ? rel.split('/')[0]! : ''
  if (top && names.includes(top)) return { name: top }
  if (names.length === 1) return { name: names[0]! }
  return { candidates: names }
}
