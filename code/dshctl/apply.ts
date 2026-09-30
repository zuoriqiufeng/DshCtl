/**
 * apply.ts — F3 落盘：check 有 error 拒绝；写路径必须在 DSH_HOME 内；原子写；settings/.credentials
 * 不生成（环境资产，裁决见 exec-plan §v0.2）。preset 自 v0.1.7 声明式：作者源内联进 profile
 * patch 声明行，不再拷贝目录（上游 d1e22a7e24 移除目录式机制）。
 */
import { writeFileSync, chmodSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { loadPacks } from './packs.ts'
import type { DomainSpec } from './domain.ts'
import { renderOpsAppPatch, renderProfileManifest, renderProfileCordisYml, renderProfilePatch, renderUnit, renderRunnerScript, extractPluginConfigBlocks } from './render.ts'
import { loadPresetDeclaration, presetIdOf } from './preset.ts'
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

export function applyDomain(spec: DomainSpec, packsDir: string, opts: { unitOut?: string; domainYmlRaw?: string } = {}): ApplyResult {
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

  // preset：作者源（preset.yml + agent.cordis.yml）内联进 profile patch 声明行，不再拷贝目录
  let presetDecl
  if (spec.preset?.source) {
    const loaded = loadPresetDeclaration(spec.preset.source, presetIdOf(spec))
    if (loaded.error) errors.push(loaded.error)
    else presetDecl = loaded.decl
  }
  const pluginConfigRaw = opts.domainYmlRaw ? extractPluginConfigBlocks(opts.domainYmlRaw) : undefined
  const patch = renderProfilePatch(spec, presetDecl, pluginConfigRaw)
  if (patch.error) errors.push(patch.error)
  else atomicWriteIn(home, join(home, 'profiles', spec.domain, 'cordis.patch.yml'), patch.content, written)
  if (spec.preset?.source && !errors.some((e) => e.includes('preset'))) {
    skipped.push(`preset: 作者源 ${spec.preset.source}（声明式内联进 profile patch，改源后需 re-apply）`)
  }

  // ⑥ 实例专属 runner（自治唯一管理入口；v1.7 起为 apply 生成物）
  const runnerPath = join(home, `run-${spec.domain}.sh`)
  atomicWriteIn(home, runnerPath, renderRunnerScript(spec, { port: spec.ports?.api }), written)
  chmodSync(runnerPath, 0o755)

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
