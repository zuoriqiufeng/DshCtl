/**
 * upgrade-check.ts — F6 升级跟随对账（手册第 2 步自动化）：registry 全领域 × 同一 roster 跑 R2/R3
 * 子集 → 每领域"需要动的清单"；verdict: pass(进第3步)/blocked(消失id)/degraded(无roster禁假通过)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistry, type Registry } from './registry.ts'
import { loadPacks, type CapabilityPack } from './packs.ts'
import { parseDomain } from './domain.ts'
import { loadRoster, loadPrevRoster, reconcileUpstream } from './check.ts'

export interface UpgradeDomainReport {
  domain: string
  dsh_source: string
  roster_version?: string
  errors: number
  warns: number
  disappeared: string[]
  addedUncovered: string[]
  degraded?: string
}

export interface UpgradeReport {
  sources: string[]
  domains: UpgradeDomainReport[]
  /** pass=可进入手册第 3 步；blocked=有领域需跟进；degraded=roster 不可用（不允许假通过） */
  verdict: 'pass' | 'blocked' | 'degraded'
}

export function runUpgradeCheck(opts: {
  registryPath: string
  domainsDir: string
  packsDir: string
  cacheDir: string
  refresh?: boolean
}): UpgradeReport {
  const reg: Registry = loadRegistry(opts.registryPath)
  const packs: CapabilityPack[] = loadPacks(opts.packsDir)
  const domains: UpgradeDomainReport[] = []
  const sources = new Set<string>()
  /** 同一 dsh_source 只取一次 roster；prev 基线按源缓存（版本对比语义） */
  const rosterBySource = new Map<string, { ids: string[]; version: string } | null>()

  for (const inst of reg.instances) {
    const { spec } = parseDomain(join(opts.domainsDir, inst.domain, 'domain.yml'))
    if (!spec) {
      domains.push({ domain: inst.domain, dsh_source: '-', errors: 1, warns: 0, disappeared: [], addedUncovered: [], degraded: 'domain.yml 解析失败' })
      continue
    }
    sources.add(spec.dsh_source)
    let roster = rosterBySource.get(spec.dsh_source)
    if (roster === undefined) {
      roster = loadRoster(spec.dsh_source, inst.domain, opts.cacheDir, opts.refresh ?? false, spec.dsh_home)
      rosterBySource.set(spec.dsh_source, roster ? { ids: roster.ids, version: roster.version } : null)
    }
    if (!roster) {
      domains.push({ domain: inst.domain, dsh_source: spec.dsh_source, errors: 0, warns: 0, disappeared: [], addedUncovered: [], degraded: 'dump-config 不可用（上游未构建或超时）——对账退化，升级不允许假通过' })
      continue
    }
    const prev = loadPrevRoster(opts.cacheDir, roster.version)
    const rec = reconcileUpstream(spec, packs, roster.ids, prev, `v${roster.version}`)
    domains.push({
      domain: inst.domain,
      dsh_source: spec.dsh_source,
      roster_version: roster.version,
      errors: rec.items.filter((i) => i.level === 'error').length,
      warns: rec.items.filter((i) => i.level === 'warn').length,
      disappeared: rec.disappeared,
      addedUncovered: rec.addedUncovered,
    })
  }

  const verdict: UpgradeReport['verdict'] =
    domains.some((d) => d.degraded) ? 'degraded'
    : domains.some((d) => d.errors > 0) ? 'blocked'
    : 'pass'
  return { sources: [...sources], domains, verdict }
}

export function printUpgradeReport(r: UpgradeReport): void {
  console.log('\n== upgrade-check（升级跟随对账：手册第 2 步自动化）==')
  console.log(` sources: ${r.sources.join(', ') || '(无)'}`)
  for (const d of r.domains) {
    const mark = d.degraded ? '✗' : d.errors ? '✗' : d.warns ? '⚠' : '✓'
    console.log(`\n ${mark} ${d.domain}（roster ${d.roster_version ?? '-'}）`)
    if (d.degraded) { console.log(`   [degraded] ${d.degraded}`); continue }
    for (const id of d.disappeared) console.log(`   ✗ 消失 id '${id}' —— 上游改名/删除，ops-app 清单需跟进删除或改名`)
    for (const id of d.addedUncovered) console.log(`   ⚠ 新增行 '${id}' —— 人工评估：该裁剪（入能力包）还是保留`)
    if (!d.disappeared.length && !d.addedUncovered.length) console.log('   无需动清单（无消失 id；新增评估如无基线则跳过）')
  }
  const v = r.verdict === 'pass' ? 'PASS ✓ 可进入升级手册第 3 步（替换产物）'
    : r.verdict === 'blocked' ? 'BLOCKED ✗ 有领域需先跟进消失 id（见上清单）'
    : 'DEGRADED ✗ roster 不可用——先构建上游产物再跑（不允许假通过）'
  console.log(`\n verdict: ${v}`)
}
