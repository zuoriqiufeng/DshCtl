/**
 * render.ts — apply/diff 共用纯渲染器（设计 §7 五件生成物）。
 * domain-api insert id 取 api_server.plugin_id（adopt 回填），保证对现存实例 dry-run diff 为空。
 */
import type { DomainSpec } from './domain.ts'
import { mergePacks, type CapabilityPack } from './packs.ts'

export interface RenderedArtifact { path: string; content: string }

/** ① bundles/ops-app/cordis.patch.yml：core 隐含 + 勾选能力包拼接（每项标注来源包） */
export function renderOpsAppPatch(packs: CapabilityPack[], capabilities: string[]): { content: string; errors: string[] } {
  const { entries, errors } = mergePacks(packs, capabilities)
  const lines = [
    '# bundles/ops-app/cordis.patch.yml —— 由 dshctl apply 生成（勿手改；来源：capability-packs 片段拼接）',
    '# 每项注释标注来源能力包；纯增量按 id 寻址，不引用上游行内容。',
  ]
  for (const e of entries) {
    lines.push(`# src: ${(() => { const p = packs.find((pk) => (pk.disable.tools ?? []).includes(e.id) || (pk.disable.overrides ?? []).some((o) => o.id === e.id)); return p?.pack ?? '?' })()}`)
    lines.push(`- id: ${e.id}`)
    if (e.disabled) lines.push('  disabled: true')
    if (e.inject !== undefined) lines.push(`  inject: ${JSON.stringify(e.inject)}`)
    if (e.config !== undefined) lines.push(`  config: ${JSON.stringify(e.config)}`)
  }
  return { content: lines.join('\n') + '\n', errors }
}

/** ② profiles/<domain>/package.json */
export function renderProfileManifest(domain: string): string {
  return JSON.stringify({
    name: `dsh-profile-${domain}`,
    private: true,
    dependencies: { '@deepseek-ai/dsh-ops-app': 'file:../../bundles/ops-app' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-ops-app'], patchReload: 'live' } },
  }, null, 2) + '\n'
}

/** ③ profiles/<domain>/cordis.yml（组合树由 patch 层合成，本体为空） */
export function renderProfileCordisYml(): string {
  return '# 组合树由 patches 合成——请编辑 cordis.patch.yml，而非本文件（上游 initProfile 同款约定）\n[]\n'
}

/** ④ profiles/<domain>/cordis.patch.yml：plugins insert + domain-api insert + agent-presets + 托管段标记 */
export function renderProfilePatch(spec: DomainSpec): { content: string; error?: string } {
  const api = spec.api_server
  if (!api) return { content: '', error: '清单缺 api_server 段，无法生成 domain-api insert' }
  const pluginPath = (api as { plugin_path?: string }).plugin_path
  const pluginId = (api as { plugin_id?: string }).plugin_id ?? 'domain-api'
  if (!pluginPath) return { content: '', error: 'api_server.plugin_path 缺失（adopt 回填或手工声明 domain-api 插件源码路径）' }
  const y = (v: unknown): string => JSON.stringify(v)
  const lines: string[] = [
    `# profiles/${spec.domain}/cordis.patch.yml —— 由 dshctl apply 生成（勿手改）`,
    '- insert:',
  ]
  for (const p of spec.plugins ?? []) {
    lines.push(`    - id: ${p.id}`)
    lines.push(`      name: ${y(p.path)}`)
  }
  lines.push(`    - id: ${pluginId}`)
  lines.push(`      name: ${y(pluginPath)}`)
  lines.push('      config:')
  lines.push(`        preset: ${spec.domain}`)
  lines.push(`        apiKey: ''`)
  lines.push('        apiServer:')
  lines.push('          enabled: true')
  lines.push(`          host: '127.0.0.1'`)
  lines.push(`          port: ${api.port}`)
  lines.push(`          apiKey: !!js process.env.${api.api_key_env} ?? ''`)
  lines.push(`        turnTimeoutSec: ${api.turn_timeout_sec}`)
  lines.push(`        modelId: ${spec.domain}`)
  lines.push('        session:')
  lines.push('          enabled: true')
  lines.push('          headerNames: [X-Ops-Session-Id, X-Hermes-Session-Id]')
  lines.push('          maxTurnsPerSession: 0')
  lines.push("          unknownIdPolicy: reject")
  if (spec.memory?.gateway_url) {
    lines.push('        memory:')
    lines.push('          enabled: true')
    lines.push('          headerNames: [X-Ops-Memory-Key, X-Hermes-Session-Key]')
    lines.push(`          gatewayUrl: ${y(spec.memory.gateway_url)}`)
    lines.push("          gatewayApiKey: ''")
    lines.push('          toolsEnabled: true')
    lines.push('          autoStart: false')
  }
  lines.push('- id: agent-presets')
  lines.push('  config:')
  lines.push(`    default: ${spec.domain}`)
  lines.push('    roots:')
  lines.push(`      - path: ${y(`${spec.dsh_home}/presets`)}`)
  lines.push('        trust: user')
  lines.push('# >>> OPS-ADMIN MANAGED >>>   （/admin 托管写入区——标记区外请勿手工增删 insert 行）')
  lines.push('# <<< OPS-ADMIN MANAGED <<<')
  return { content: lines.join('\n') + '\n' }
}

/** ⑤ systemd unit 模板（输出到 stdout/文件，安装由人执行——程序不碰 systemctl） */
export function renderUnit(spec: DomainSpec): string {
  return [
    `[Unit]`,
    `# 由 dshctl apply 生成模板——transient unit 参照 code/scripts/run-ops-trial.sh`,
    `After=network-online.target`,
    ``,
    `[Service]`,
    `Restart=on-failure`,
    `WorkingDirectory=${spec.dsh_source}`,
    `Environment="DSH_HOME=${spec.dsh_home}"`,
    `ExecStart="/usr/bin/env" "pnpm" "dsh" "--profile" "${spec.domain}"`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join('\n')
}
