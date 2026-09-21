/**
 * apply.ts — F3 落盘：check 有 error 拒绝；写路径必须在 DSH_HOME 内；原子写；settings/.credentials
 * 不生成（环境资产，裁决见 exec-plan §v0.2）；source 已在 home 内的 presets 跳过自拷。
 */
import { writeFileSync, copyFileSync, mkdirSync, existsSync, statSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { loadPacks } from './packs.ts'
import type { DomainSpec } from './domain.ts'
import { renderOpsAppPatch, renderProfileManifest, renderProfileCordisYml, renderProfilePatch, renderUnit } from './render.ts'
import { diffDomain } from './diff.ts'

export interface ApplyResult {
  written: string[]   // 实际写盘的路径
  skipped: string[]   // 跳过（settings 等）+ 说明
  unitText: string    // systemd unit 模板（stdout/可选落盘）
  errors: string[]
}

/** 路径安全：目标必须在 dsh_home 之内 */
function assertInside(home: string, target: string): void {
  const h = resolve(home)
  const t = resolve(target)
  if (t !== h && !t.startsWith(h + '/')) throw new Error(`写路径越界（必须在 DSH_HOME 内）: ${target}`)
}

function atomicWriteIn(home: string, path: string, content: string, written: string[]): void {
  assertInside(home, path)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
  written.push(path)
}

/** 递归拷贝 preset 源目录 → $DSH_HOME/presets/<domain> */
function copyPresets(home: string, src: string, domain: string, written: string[]): void {
  const dst = join(home, 'presets', domain)
  assertInside(home, dst)
  const walk = (s: string, d: string): void => {
    mkdirSync(d, { recursive: true })
    for (const name of readdirSync(s)) {
      const sp = join(s, name)
      const dp = join(d, name)
      if (statSync(sp).isDirectory()) walk(sp, dp)
      else { copyFileSync(sp, dp); written.push(dp) }
    }
  }
  if (existsSync(src)) walk(src, dst)
}

export function applyDomain(spec: DomainSpec, packsDir: string, opts: { unitOut?: string } = {}): ApplyResult {
  const written: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const home = spec.dsh_home
  if (!existsSync(home)) mkdirSync(home, { recursive: true })

  for (const f of ['settings.yaml', '.credentials.yaml']) {
    const p = join(home, f)
    if (existsSync(p)) skipped.push(`${f}: 已存在，跳过（环境资产不由 dshctl 管理）`)
    else skipped.push(`${f}: 缺失——需人工从模板实例拷贝（llm-pi-ai/凭据段）`)
  }

  const packs = loadPacks(packsDir)
  const { content: opsApp, errors: packErrs } = renderOpsAppPatch(packs, spec.capabilities ?? [])
  errors.push(...packErrs)
  if (!packErrs.length) atomicWriteIn(home, join(home, 'bundles', 'ops-app', 'cordis.patch.yml'), opsApp, written)
  atomicWriteIn(home, join(home, 'bundles', 'ops-app', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-ops-app', version: '0.1.0', private: true, type: 'module',
    exports: { './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' },
    files: ['cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n', written)

  atomicWriteIn(home, join(home, 'profiles', spec.domain, 'package.json'), renderProfileManifest(spec.domain), written)
  atomicWriteIn(home, join(home, 'profiles', spec.domain, 'cordis.yml'), renderProfileCordisYml(), written)
  const patch = renderProfilePatch(spec)
  if (patch.error) errors.push(patch.error)
  else atomicWriteIn(home, join(home, 'profiles', spec.domain, 'cordis.patch.yml'), patch.content, written)

  if (spec.preset?.source) {
    if (resolve(spec.preset.source).startsWith(resolve(home) + '/')) {
      skipped.push(`presets: source 已在 DSH_HOME 内（${spec.preset.source}），跳过自拷`)
    } else copyPresets(home, spec.preset.source, spec.domain, written)
  }

  const unitText = renderUnit(spec)
  if (opts.unitOut) {
    mkdirSync(dirname(opts.unitOut), { recursive: true })
    writeFileSync(opts.unitOut, unitText)
    written.push(opts.unitOut)
  }

  return { written, skipped, unitText, errors }
}

/** registry 回写（由 CLI 调用，保持 registry.ts 单一职责） */
export function applySummary(spec: DomainSpec, res: ApplyResult): string {
  return [
    `apply ${spec.domain}: 写入 ${res.written.length} 个文件`,
    ...res.written.map((w) => `  + ${w}`),
    ...res.skipped.map((s) => `  · ${s}`),
  ].join('\n')
}

/** dry-run：只出 diff 报告不写盘 */
export function dryRun(spec: DomainSpec, packsDir: string): { report: ReturnType<typeof diffDomain>; unitText: string } {
  return { report: diffDomain(spec, packsDir), unitText: renderUnit(spec) }
}
