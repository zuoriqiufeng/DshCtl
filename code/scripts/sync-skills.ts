#!/usr/bin/env node
/**
 * sync-skills.ts — 一次性脚本：把上游共享技能库同步到本机 skills 目录
 *
 * 复用 code/ops-skill-manager/ops.ts 导出的 syncSkill（单一实现源，不复制逻辑）。
 * 上游 = 只读消费（/hdd/demo/public/i2stream-bkn/skill），目标目录会新增/覆盖技能目录，
 * 并写入 ledger / store 台账（正常行为，不入库）。
 *
 * 用法（在 deepseek-harness 下运行）：
 *   node --import tsx/esm /hdd/demo/public/dsh-info/code/scripts/sync-skills.ts
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { syncSkill } from '../ops-skill-manager/ops.ts'

const UPSTREAM_DIR = '/hdd/demo/public/i2stream-bkn/skill'
const SKILLS_DIR = '/hdd/demo/public/dsh-info/.dsh-home/skills'

function main(): void {
  let names: string[] = []
  try {
    names = readdirSync(UPSTREAM_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'requirements.txt')
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    console.error(`sync-skills: 读取上游目录失败 → ${UPSTREAM_DIR}:`, error)
    process.exit(1)
  }

  console.log(`sync-skills: 待同步 ${names.length} 个技能 ← ${UPSTREAM_DIR}`)
  const failed: Array<{ name: string; message: string }> = []
  let ok = 0
  for (const name of names) {
    try {
      const result = syncSkill(UPSTREAM_DIR, SKILLS_DIR, name)
      if (result.ok) ok++
      else failed.push({ name, message: result.message })
      console.log(`  ${result.ok ? '✓' : '✗'} ${name}${result.ok ? '' : `  — ${result.message}`}`)
    } catch (error) {
      failed.push({ name, message: String(error) })
      console.log(`  ✗ ${name}  — 抛出异常: ${String(error)}`)
    }
  }

  console.log(`sync-skills: 成功 ${ok} / 失败 ${failed.length}（共 ${names.length}）`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAIL ${f.name}: ${f.message}`)
    process.exit(1)
  }
}

main()