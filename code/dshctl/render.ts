/**
 * render.ts — apply/diff 共用渲染器（设计 §7 五件生成物）。
 * domain-api insert id 取 api_server.plugin_id（adopt 回填），保证对现存实例 dry-run diff 为空。
 * preset 面自 v0.1.7 起为声明式（上游 d1e22a7e24 移除目录式）：本模块只做文本拼装，
 * 作者源读取（preset.yml/agent.cordis.yml → PresetDecl）在 preset.ts，由 apply 调用方传入。
 */
import type { DomainSpec } from './domain.ts'
import { mergePacks, type CapabilityPack } from './packs.ts'
import { presetIdOf, type PresetDecl } from './preset.ts'
import { dumpYaml } from './yml.ts'

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
    // v0.1.7 起 DshProfileManifest 只剩 bundles（patchReload 键已移除；config 监视由 base 层 hmr 行默认提供）
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-ops-app'] } },
  }, null, 2) + '\n'
}

/** ③ profiles/<domain>/cordis.yml（组合树由 patch 层合成，本体为空） */
export function renderProfileCordisYml(): string {
  return '# 组合树由 patches 合成——请编辑 cordis.patch.yml，而非本文件（上游 initProfile 同款约定）\n[]\n'
}

/** 缩进原文块：非空行加 n 空格（空行保持），保真 `!!js`/注释/块标量相对缩进 */
function indentBlock(text: string, n: number): string[] {
  return text.split('\n').map((l) => (l.trim() === '' ? '' : ' '.repeat(n) + l))
}

/**
 * 从 domain.yml 原文抽取各插件 plugins[].config 的块文本（行数组，缩进已剥到相对 0）。
 * 与 unitize.extractInsertBlock 同款文本法：`!!js` 表达式/注释原样保真，不经 YAML 往返。
 * 契约：返回行以 config 子级为基准缩进（子级 0、孙级 2…），由 render 重缩进进 patch。
 */
export function extractPluginConfigBlocks(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const lines = text.split('\n')
  let curId: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) { curId = null; continue } // 顶层键（含 plugins: 本身）重置
    if (indent === 2) {
      const m = /^-\s+id:\s*(\S+)/.exec(trimmed)
      curId = m ? m[1]! : null
      continue
    }
    if (!curId) continue
    if (indent === 4 && /^config:\s*(#.*)?$/.test(trimmed)) {
      const id = curId
      const block: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!
        if (l.trim() === '') { block.push(''); continue }
        const li = l.length - l.trimStart().length
        if (li <= 4) break // config 块结束（同级键或下一条目）——退出后由外层继续处理该行
        block.push(l.slice(6))
        i = j
      }
      while (block.length && block[block.length - 1]!.trim() === '') block.pop()
      if (block.length) out[id] = block
      curId = null
    }
  }
  return out
}

/**
 * ④ profiles/<domain>/cordis.patch.yml：
 * plugins insert（含各自 config）+ domain-api insert + preset 声明行 + agent-preset-registry default 覆写 + 托管段标记。
 * - preset 声明输入由调用方经 loadPresetDeclaration 提供；spec.preset 存在而 preset 缺参 → fail-loud。
 * - plugins[].config：优先用 domainYmlRaw 抽出的块原文（保真 `!!js`）；无原文通道时按解析值 dumpYaml，
 *   检出 env 表达式形状即 error（防 `!!js` 被引号化成字面值静默失真）。
 */
export function renderProfilePatch(spec: DomainSpec, preset?: PresetDecl, pluginConfigRaw?: Record<string, string[]>): { content: string; error?: string } {
  const api = spec.api_server
  // api_server 段可选（v0.4 起支持无 api 的最小域）：声明了 api_server 但缺 plugin_path 仍 fail-loud
  const pluginPath = api ? (api as { plugin_path?: string }).plugin_path : undefined
  if (api && !pluginPath) return { content: '', error: 'api_server.plugin_path 缺失（adopt 回填或手工声明 domain-api 插件源码路径）' }
  if (spec.preset?.source && preset === undefined) {
    return { content: '', error: 'preset 声明输入缺失（v0.1.7 起目录式 agent preset 已移除，需经 loadPresetDeclaration 提供）' }
  }
  const pluginId = api ? ((api as { plugin_id?: string }).plugin_id ?? 'domain-api') : ''
  const presetId = preset?.id ?? presetIdOf(spec)
  const y = (v: unknown): string => JSON.stringify(v)
  const insertRows: string[] = []
  for (const p of spec.plugins ?? []) {
    insertRows.push(`    - id: ${p.id}`)
    insertRows.push(`      name: ${y(p.path)}`)
    const rawCfg = pluginConfigRaw?.[p.id]
    if (rawCfg && rawCfg.length) {
      insertRows.push('      config:')
      for (const l of rawCfg) insertRows.push(l.trim() === '' ? '' : '        ' + l)
    } else if (p.config !== undefined) {
      const dumped = dumpYaml(p.config).trimEnd()
      if (/process\.env\./.test(dumped)) {
        return {
          content: '',
          error: `插件 ${p.id}.config 含 env 表达式（!!js）——当前无 domain.yml 原文通道，dumpYaml 会将其引号化为字面值；请经 dshctl CLI 执行 apply（自带原文通道），或把该值改为字面值`,
        }
      }
      insertRows.push('      config:')
      for (const l of dumped.split('\n')) insertRows.push('        ' + l)
    }
  }
  if (api) {
    insertRows.push(`    - id: ${pluginId}`)
    insertRows.push(`      name: ${y(pluginPath)}`)
    insertRows.push('      config:')
    insertRows.push(`        preset: ${presetId}`)
    insertRows.push(`        apiKey: ''`)
    insertRows.push('        apiServer:')
    insertRows.push('          enabled: true')
    insertRows.push(`          host: '127.0.0.1'`)
    insertRows.push(`          port: ${api.port}`)
    insertRows.push(`          apiKey: !!js process.env.${api.api_key_env} ?? ''`)
    insertRows.push(`        turnTimeoutSec: ${api.turn_timeout_sec}`)
    insertRows.push(`        modelId: ${spec.domain}`)
    insertRows.push('        session:')
    insertRows.push('          enabled: true')
    insertRows.push('          headerNames: [X-Ops-Session-Id, X-Hermes-Session-Id]')
    insertRows.push('          maxTurnsPerSession: 0')
    insertRows.push("          unknownIdPolicy: reject")
    if (spec.memory?.gateway_url) {
      insertRows.push('        memory:')
      insertRows.push('          enabled: true')
      insertRows.push('          headerNames: [X-Ops-Memory-Key, X-Hermes-Session-Key]')
      insertRows.push(`          gatewayUrl: ${y(spec.memory.gateway_url)}`)
      insertRows.push("          gatewayApiKey: ''")
      insertRows.push('          toolsEnabled: true')
      insertRows.push('          autoStart: false')
    }
  }
  // 声明式 preset 行（config.plugins 原文缩进内嵌，保真 `!!js` 与注释）
  if (preset) {
    insertRows.push(`    - id: preset-${preset.id}`)
    insertRows.push(`      name: '@deepseek-ai/dsh-agent-preset'`)
    insertRows.push('      config:')
    insertRows.push(`        id: ${preset.id}`)
    if (preset.meta.name !== undefined) insertRows.push(`        name: ${y(preset.meta.name)}`)
    if (preset.meta.description !== undefined) insertRows.push(`        description: ${y(preset.meta.description)}`)
    if (preset.meta.order !== undefined) insertRows.push(`        order: ${preset.meta.order}`)
    insertRows.push('        plugins:')
    insertRows.push(...indentBlock(preset.pluginsRaw, 10))
  }
  const lines: string[] = [
    `# profiles/${spec.domain}/cordis.patch.yml —— 由 dshctl apply 生成（勿手改）`,
  ]
  // 无插件且无 api 且无 preset 时不输出 `- insert:`（空 insert 行会被 patch 引擎当 non-insert 打启动 warn）
  if (insertRows.length) { lines.push('- insert:'); lines.push(...insertRows) }
  lines.push('- id: agent-preset-registry')
  lines.push('  config:')
  lines.push(`    default: ${presetId}`)
  lines.push('# >>> OPS-ADMIN MANAGED >>>   （/admin 托管写入区——标记区外请勿手工增删 insert 行）')
  lines.push('# <<< OPS-ADMIN MANAGED <<<')
  return { content: lines.join('\n') + '\n' }
}

/** ⑤ systemd unit 模板（输出到 stdout/文件，安装由人执行——程序不碰 systemctl）；含 EnvironmentFile（实例密钥行） */
export function renderUnit(spec: DomainSpec): string {
  return [
    `[Unit]`,
    `# 由 dshctl apply 生成模板——与实例 runner（run-${spec.domain}.sh）同参数`,
    `After=network-online.target`,
    ``,
    `[Service]`,
    `Restart=on-failure`,
    `WorkingDirectory=${spec.dsh_source}`,
    `EnvironmentFile=${spec.dsh_home}/ops.env`,
    `Environment="DSH_HOME=${spec.dsh_home}"`,
    `ExecStart="/usr/bin/env" "pnpm" "dsh" "--profile" "${spec.domain}"`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join('\n')
}

/**
 * ⑥ 实例专属运行脚本（`<home>/run-<domain>.sh`，0o755）——实例自治的唯一管理入口：
 * 变量区全部由 spec 推导；动作 start（systemd-run 四件套 + health 就绪轮询）/stop/restart/status/logs。
 * 导出场景：顶部变量区在导入机可改（HOME_DIR/DSH_SOURCE/ENV_FILE）。
 */
export function renderRunnerScript(spec: DomainSpec, opts: { port?: number } = {}): string {
  const home = spec.dsh_home
  const domain = spec.domain
  const unit = spec.systemd_unit ?? `dsh-${domain}`
  const harness = spec.dsh_source
  const port = opts.port ?? spec.ports?.api ?? 0
  const envFile = `${home}/ops.env`
  return `#!/bin/bash
# run-${domain}.sh —— ${domain} 实例专属启停（由 dshctl apply 生成；换环境时改顶部变量区即可）
#
# 实例自治：本脚本即实例的唯一管理入口（不依赖任何项目侧脚本）。
# start/stop 需要宿主 systemd 权限（dbus）；status/logs 无需。
#
# 用法：bash run-${domain}.sh {start|stop|restart|status|logs}

set -u
HOME_DIR='${home}'
DSH_SOURCE='${harness}'
PROFILE='${domain}'
UNIT='${unit}'
PORT=${port}
ENV_FILE='${envFile}'

is_up() { systemctl is-active --quiet "$UNIT" 2>/dev/null; }

case "\${1:-status}" in
  start)
    if is_up; then echo already-running; exit 0; fi
    mkdir -p "$HOME_DIR/logs"
    systemd-run --unit="$UNIT" \\
      --property=Restart=on-failure \\
      --property=WorkingDirectory="$DSH_SOURCE" \\
      --property=EnvironmentFile="$ENV_FILE" \\
      --setenv=DSH_HOME="$HOME_DIR" \\
      /usr/bin/env pnpm dsh --profile "$PROFILE" || exit 1
    for _ in $(seq 1 30); do
      curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/health" && break
      sleep 1
    done
    echo started
    ;;
  stop)
    systemctl stop "$UNIT" 2>/dev/null
    echo stopped
    ;;
  restart)
    systemctl restart "$UNIT" 2>/dev/null && echo restarted
    ;;
  status)
    if is_up; then echo "unit : active ($UNIT)"; else echo "unit : inactive ($UNIT)"; fi
    curl -s -m 3 -o /dev/null -w "health :$PORT/health -> %{http_code}\\n" "http://127.0.0.1:$PORT/health"
    ;;
  logs)
    journalctl -u "$UNIT" -f
    ;;
  *)
    echo "usage: bash run-${domain}.sh {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
`
}
