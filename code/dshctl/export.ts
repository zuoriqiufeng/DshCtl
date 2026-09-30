/**
 * export.ts — 导出编排实例为自包含 tgz（换目录/换机可独立运行）。
 *
 * 打包内容（七类）：
 *   profiles/<domain>/ 三件 + bundles/ops-app/ 两件（re-render，确定性输出）
 *   ops.env + .credentials.yaml（密钥；--no-secrets 时占位）
 *   settings.yaml（由现存 settings.yaml.imported 还原文件名——新 home 首启走 legacy import）
 *   skills/（域清单 skills_dirs 逐目录）
 *   run-<domain>.sh（实例专属 runner：start/stop/restart/status/logs，顶部变量导入机可改）
 *   unit/<domain>.service（systemd 模板，含 EnvironmentFile）
 *   export-manifest.json + README.md（导入运行说明）
 *
 * 不打包：profiles node_modules（符号链接指 harness，导入机重建）、sessions/storages/logs。
 * 密钥警示：默认含密钥文件（开箱能跑），分发前自行脱敏或用 --no-secrets。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DomainSpec } from './domain.ts'
import { renderOpsAppPatch, renderProfileCordisYml, renderProfileManifest, renderProfilePatch, renderRunnerScript, renderUnit, extractPluginConfigBlocks } from './render.ts'
import { loadPresetDeclaration, presetIdOf } from './preset.ts'
import { loadPacks } from './packs.ts'
import { loadYamlFile } from './yml.ts'

export interface ExportResult {
  out: string
  bytes: number
  /** 保留 staging 时的目录（缺省已清理） */
  staging: string
  notes: string[]
  errors: string[]
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
const PLACEHOLDER = (what: string): string =>
  `# ${what} 未随包导出（--no-secrets）——从源实例手工拷贝后本实例方可运行\n`

function copyTree(src: string, dst: string): void {
  // lstat 不追随符号链接——防 skills 目录内自指软链成环；链接项按单层解引拷内容
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const sp = join(src, name)
    const dp = join(dst, name)
    const st = lstatSync(sp)
    if (st.isDirectory()) copyTree(sp, dp)
    else { try { copyFileSync(sp, dp) } catch { /* 悬空链接跳过 */ } }
  }
}

export function exportDomain(
  spec: DomainSpec,
  opts: { out?: string; withSecrets?: boolean; keepStaging?: boolean; dshHome?: string; packsDir?: string; domainYmlRaw?: string } = {},
): ExportResult {
  const notes: string[] = []
  const errors: string[] = []
  const withSecrets = opts.withSecrets !== false
  const home = opts.dshHome ?? spec.dsh_home
  // packsDir 缺省按本仓布局推导：<dsh_source>/../code/capability-packs（CLI 会显式传入）
  const packsDir = opts.packsDir ?? join(resolve(spec.dsh_source), '..', 'code', 'capability-packs')
  const domain = spec.domain

  const staging = join(home, 'exports', `${domain}-staging`)
  rmSync(staging, { recursive: true, force: true })
  const put = (rel: string, content: string): string => {
    const p = join(staging, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
    return p
  }

  // ①② profile 三件 + ops-app 两件（re-render，确定性输出）
  const packs = loadPacks(packsDir)
  const presetDecl = spec.preset?.source ? loadPresetDeclaration(spec.preset.source, presetIdOf(spec)).decl : undefined
  const pluginConfigRaw = opts.domainYmlRaw ? extractPluginConfigBlocks(opts.domainYmlRaw) : undefined
  put(join('profiles', domain, 'package.json'), renderProfileManifest(domain))
  put(join('profiles', domain, 'cordis.yml'), renderProfileCordisYml())
  const opsApp = renderOpsAppPatch(packs, spec.capabilities ?? [])
  errors.push(...opsApp.errors)
  put(join('bundles', 'ops-app', 'cordis.patch.yml'), opsApp.content)
  put(join('bundles', 'ops-app', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-ops-app', version: '0.1.0', private: true, type: 'module',
    exports: { './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' },
    files: ['cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  const patch = renderProfilePatch(spec, presetDecl, pluginConfigRaw)
  if (patch.error) errors.push(patch.error)
  else put(join('profiles', domain, 'cordis.patch.yml'), patch.content)

  // ③ 密钥（默认含；--no-secrets 占位）
  for (const [name, src] of [['ops.env', join(home, 'ops.env')], ['.credentials.yaml', join(home, '.credentials.yaml')]] as const) {
    if (withSecrets && existsSync(src)) copyFileSync(src, join(staging, name))
    else put(name, PLACEHOLDER(name))
    if (!withSecrets) notes.push(`${name} 未导出（--no-secrets）`)
    else if (!existsSync(src)) notes.push(`${name} 源缺失——实例运行需要（导入后自备）`)
  }

  // ④ settings.yaml（由 settings.yaml.imported 还原文件名——新 home 首启走 legacy import）
  const imported = join(home, 'settings.yaml.imported')
  if (existsSync(imported)) copyFileSync(imported, join(staging, 'settings.yaml'))
  else notes.push('settings.yaml 源缺失——LLM provider 配置需导入后自备')

  // ⑤ skills（域清单 skills_dirs）
  for (const dir of spec.preset?.skills_dirs ?? []) {
    if (!existsSync(dir)) { errors.push(`skills_dirs 不存在: ${dir}`); continue }
    copyTree(dir, join(staging, 'skills', basename(dir)))
  }

  // ⑥ runner + unit
  put(`run-${domain}.sh`, renderRunnerScript(spec, { port: spec.ports?.api }))
  put(join('unit', `${domain}.service`), renderUnit(spec))

  // ⑦ export-manifest.json（含文件 sha256 清单）
  const files: Record<string, string> = {}
  const walk = (dir: string, base = staging): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, base)
      else files[p.slice(base.length + 1)] = sha256File(p)
    }
  }
  walk(staging)
  put('export-manifest.json', JSON.stringify({
    domain, exportedAt: new Date().toISOString(),
    dshSource: { path: spec.dsh_source, note: '导入机需同版本 harness 树（pnpm install 后 pnpm dsh 可用）' },
    sharedDeps: spec.shared_deps ?? [],
    files,
  }, null, 2))

  // ⑧ README（导入与运行说明）
  put('README.md', [
    `# ${domain} 实例导出包（dshctl domain export，${new Date().toISOString().slice(0, 10)}）`,
    '',
    '## 前提（导入机）',
    '1. 同版本 DSH harness 树（dsh_source）：`pnpm install` 后 `pnpm dsh --help` 可用；',
    '2. 外部服务可达（本域声明）：',
    ...((spec.shared_deps ?? []).map((d) => `   - ${d.name} ${d.url}`)),
    `   - Qdrant/embed 等：见 profiles/${domain}/cordis.patch.yml 各插件 config 与 export-manifest.json`,
    '3. in-place 插件源码（plugins[].path 指向的项目目录）。',
    '',
    '## 导入步骤',
    '1. 解压：`tar xzf <包名>.tgz`，内容即一个 DSH_HOME（profiles/bundles/skills/settings）；',
    '2. `cd profiles/' + domain + ' && pnpm install`（重建 profile 依赖）；',
    '3. 密钥核对：ops.env / .credentials.yaml（--no-secrets 导出的包需自行补齐）；',
    `4. 起停：bash run-${domain}.sh {start|stop|restart|status|logs}（需 systemd 权限；`,
    `   常驻安装可改用 unit/${domain}.service：cp 到 /etc/systemd/system && systemctl enable --now）。`,
    '',
    '> 顶部 run 脚本变量区（HOME_DIR/DSH_SOURCE/ENV_FILE/PORT）在新环境可改。',
  ].join('\n'))

  // 打包
  const date = new Date().toISOString().slice(0, 10)
  const out = opts.out ?? join(home, 'exports', `dsh-export-${domain}-${date}.tgz`)
  mkdirSync(join(out, '..'), { recursive: true })
  execFileSync('tar', ['czf', out, '-C', staging, '.'])
  const bytes = statSync(out).size
  if (!opts.keepStaging) rmSync(staging, { recursive: true, force: true })
  return { out, bytes, staging: opts.keepStaging ? staging : '', notes, errors }
}
