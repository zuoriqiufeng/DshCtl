/**
 * registry.ts — domains/registry.yml 读写/upsert/端口冲突查重。
 */
import { readFileSync, existsSync } from 'node:fs'
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
