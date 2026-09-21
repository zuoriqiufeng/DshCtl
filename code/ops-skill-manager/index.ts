/**
 * index.ts — ops-skill-manager：技能自管理插件（Hermes skill_manager_tool + curator 复刻）
 *
 * 能力：
 *   1. skill_manage 工具（agent 侧 create / patch / write_file / archive / restore）
 *   2. usage 台账 bump（skill 工具读取 + skill_manage 动作均计入）
 *   3. 变更 ledger（before/after sha + 内容寻址备份 blob）
 *   4. curator 定时迁移（active→stale→archived，pinned/预置豁免，绝不删除）
 *
 * 挂载（cordis.patch.yml）：
 *   - id: ops-skill-manager
 *     name: '/hdd/demo/public/dsh-info/code/ops-skill-manager/index.ts'
 *     config:
 *       intervalHours: 168        # curator 周期（默认 7 天，对齐 Hermes interval_hours）
 *       staleAfterDays: 30
 *       archiveAfterDays: 90
 *       firstRunDelaySec: 120
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveSkill, createSkill, patchSkill, restoreSkill, skillExists, syncSkill, writeFile } from './ops.ts'
import { bump, readUsage, seedIfMissing, type UsageTable } from './store.ts'
import { runTransitions, unarchive, type CuratorReport } from './curator.ts'
import { readEntries, type LedgerEntry } from './ledger.ts'

export const name = 'ops-skill-manager'
// tools: skill_manage registration requires the service at apply time.
// timer: curator scheduling via ctx.setTimeout/setInterval (both dsh-base guaranteed).
export const inject = ['tools', 'timer']

export interface Config {
  /** skills 根目录（默认 $DSH_HOME/skills） */
  skillsDir?: string
  /** 上游共享技能源目录（C1 整改：sync 动作的拉取源；只读消费） */
  upstreamDir?: string
  /** curator 周期（小时，默认 168 = 7 天，对齐 Hermes interval_hours） */
  intervalHours?: number
  /** 不活动阈值（天，默认 30） */
  staleAfterDays?: number
  /** 归档阈值（天，默认 90） */
  archiveAfterDays?: number
  /** 启动后首轮延迟（秒，默认 120，避开启动高峰） */
  firstRunDelaySec?: number
  /** 工具与定时器总开关（默认 true） */
  enabled?: boolean
}

export const Config: Schema<Config> = Schema.object({
  skillsDir: Schema.string().description('skills 根目录；默认 $DSH_HOME/skills'),
  upstreamDir: Schema.string().description('上游共享技能源目录（sync 动作拉取源）'),
  intervalHours: Schema.natural().min(1).default(168).description('curator 周期（小时）'),
  staleAfterDays: Schema.natural().min(1).default(30).description('不活动转 stale 阈值（天）'),
  archiveAfterDays: Schema.natural().min(1).default(90).description('stale 转 archived 阈值（天）'),
  firstRunDelaySec: Schema.natural().default(120).description('启动后首轮 curator 延迟（秒）'),
  enabled: Schema.boolean().default(true).description('总开关'),
})

const MANAGE_PARAMS = {
  action: {
    type: 'string' as const,
    required: true,
    description: 'create | patch | write_file | archive | restore | unarchive | list | pin | unpin | sync',
  },
  name: { type: 'string' as const, description: '技能名（list 时可省）' },
  description: { type: 'string' as const, description: 'create：技能描述（SKILL.md frontmatter）' },
  content: { type: 'string' as const, description: 'create/patch：SKILL.md 正文；write_file：文件内容' },
  file_path: { type: 'string' as const, description: 'write_file：技能目录内相对路径（如 references/errors.md）' },
}

export async function apply(ctx: Context, config?: Config): Promise<void> {
  const cfg = {
    skillsDir: config?.skillsDir || join(process.env.DSH_HOME ?? join(process.cwd(), '.dsh'), 'skills'),
    upstreamDir: config?.upstreamDir || '',
    intervalHours: config?.intervalHours ?? 168,
    staleAfterDays: config?.staleAfterDays ?? 30,
    archiveAfterDays: config?.archiveAfterDays ?? 90,
    firstRunDelaySec: config?.firstRunDelaySec ?? 120,
    enabled: config?.enabled ?? true,
  }
  const log = ctx.logger('skill-manager')
  if (!cfg.enabled) {
    log.info('[skill-manager] disabled by config')
    return
  }

  // ── skill_manage 工具（Hermes skill_manager_tool 同构）──
  const tools = ctx.get('tools') as unknown as { register?(t: unknown): unknown } | undefined
  if (tools?.register) {
    tools.register(defineTool({
      name: 'skill_manage',
      description:
        'Create, update, or archive SKILL.md skills from proven workflows. '
        + 'Use after repeated task patterns to distill reusable guidance; '
        + 'patch existing skills when new evidence contradicts or extends them. '
        + 'Preset skills are read-only; archive (never delete) is the safe removal path.',
      parameters: MANAGE_PARAMS as never,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (rawArgs: unknown) => {
        const a = (rawArgs ?? {}) as Record<string, string | undefined>
        const action = a.action ?? ''
        const name = a.name ?? ''
        try {
          switch (action) {
            case 'list': {
              const usage = readUsage(cfg.skillsDir)
              const rows = Object.entries(usage)
                .sort((x, y) => y[1].use_count - x[1].use_count)
                .map(([n, u]) => `${n} [${u.state}${u.pinned ? ',pinned' : ''}] uses=${u.use_count} last=${u.last_activity_at.slice(0, 10)}`)
              bump(cfg.skillsDir, name || '(list)')
              return rows.length ? rows.join('\n') : 'no tracked skills yet'
            }
            case 'create': {
              if (!name || !a.content) return 'create requires name and content'
              const res = createSkill(cfg.skillsDir, name, a.description ?? '', a.content)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            case 'patch': {
              if (!name || !a.content) return 'patch requires name and content'
              const res = patchSkill(cfg.skillsDir, name, a.content)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            case 'write_file': {
              if (!name || !a.file_path || a.content === undefined) return 'write_file requires name, file_path, content'
              const res = writeFile(cfg.skillsDir, name, a.file_path, a.content)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            case 'archive': {
              if (!name) return 'archive requires name'
              const res = archiveSkill(cfg.skillsDir, name)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            case 'restore': {
              if (!name) return 'restore requires name'
              const res = restoreSkill(cfg.skillsDir, name)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            case 'unarchive': {
              if (!name) return 'unarchive requires name'
              const res = unarchive(cfg.skillsDir, name)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            case 'pin':
            case 'unpin': {
              if (!name) return `${action} requires name`
              seedIfMissing(cfg.skillsDir, name)
              const { writeUsage } = await import('./store.ts')
              const table: UsageTable = readUsage(cfg.skillsDir)
              if (table[name]) {
                if (action === 'pin') table[name].pinned = true
                else delete table[name].pinned
                writeUsage(cfg.skillsDir, table)
              }
              return `skill ${name} ${action === 'pin' ? 'pinned' : 'unpinned'} (curator 豁免${action === 'pin' ? '已启用' : '已解除'})`
            }
            case 'sync': {
              if (!name) return 'sync requires name'
              if (!cfg.upstreamDir) return 'ERROR: upstreamDir not configured'
              const res = syncSkill(cfg.upstreamDir, cfg.skillsDir, name)
              return res.ok ? res.message : `ERROR: ${res.message}`
            }
            default:
              return `unknown action: ${action} (expected create|patch|write_file|archive|restore|unarchive|list|pin|unpin|sync)`
          }
        } catch (e) {
          log.warn(`[skill-manager] action ${action} failed: ${String(e)}`)
          return `ERROR: ${String(e)}`
        }
      },
    }))
    log.info('[skill-manager] skill_manage tool registered')
  }

  // ── usage bump：读取 skill 工具 + skill_manage 动作均计入（Hermes usage 语义）──
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'skill') {
      const skillName = (exec.arguments as { name?: string } | undefined)?.name
      if (skillName && skillExists(cfg.skillsDir, skillName)) bump(cfg.skillsDir, skillName)
    } else if (exec.name === 'skill_manage') {
      const n = (exec.arguments as { name?: string } | undefined)?.name
      if (n) bump(cfg.skillsDir, n)
    }
    return next()
  })

  // ── curator 定时（timer 插件生命周期作用域；重启自动重排）──
  const curatorTick = (): void => {
    try {
      const report = runTransitions(cfg.skillsDir, {
        staleAfterDays: cfg.staleAfterDays,
        archiveAfterDays: cfg.archiveAfterDays,
      })
      if (report.transitions.length) {
        log.info(`[skill-manager] curator: ${report.transitions.map((t) => `${t.skill} ${t.from}->${t.to}`).join(', ')}`)
      } else {
        log.debug(`[skill-manager] curator: scanned=${report.scanned} no transitions`)
      }
    } catch (e) {
      log.warn(`[skill-manager] curator failed: ${String(e)}`)
    }
  }
  ctx.setTimeout(() => {
    curatorTick()
    ctx.setInterval(curatorTick, cfg.intervalHours * 60 * 60 * 1000)
  }, cfg.firstRunDelaySec * 1000)
  log.info(`[skill-manager] curator armed: interval=${cfg.intervalHours}h stale=${cfg.staleAfterDays}d archive=${cfg.archiveAfterDays}d dir=${cfg.skillsDir}`)

  // ── admin 面板桥：暴露只读查询服务（ops-api /admin/api/skills 扩展消费）──
  // ctx.provide(name, value, check?)：value 即服务对象，方法闭包持有 cfg。
  ctx.provide('skillManagerAdmin', {
    usage: (): UsageTable => readUsage(cfg.skillsDir),
    ledger: (limit = 20): LedgerEntry[] => readEntries(cfg.skillsDir).slice(-limit),
    curatorRun: (dryRun: boolean): CuratorReport => runTransitions(cfg.skillsDir, {
      staleAfterDays: cfg.staleAfterDays,
      archiveAfterDays: cfg.archiveAfterDays,
      dryRun,
    }),
    skillsDir: (): string => cfg.skillsDir,
    content: (name: string): string | null => {
      const file = join(cfg.skillsDir, name, 'SKILL.md')
      return existsSync(file) ? readFileSync(file, 'utf8') : null
    },
  })
}
