/**
 * admin.ts — ops-admin 管理面插件：MCP 托管段读写 + 启停 / 技能启停 / 状态聚合
 *
 * 托管段格式（profile cordis.patch.yml 内的标记区，只增不改区外内容）：
 *   # >>> OPS-ADMIN MANAGED >>>
 *   - insert:
 *       - id: mcp-<serverName>
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config: { serverName, transport, url, headers }
 *   # <<< OPS-ADMIN MANAGED <<<
 *
 * 写入路径：修订内容写临时文件 + rename 原子替换；并发保护用 sha1 revision
 * （读时计算，写时要求 If-Match 一致）。热生效由 app-boot watchUserPatches 保证（E3.0 已实测）。
 *
 * 技能启停：在 $DSH_HOME/skills 内重命名子目录 <name> ↔ <name>.disabled；
 * skill-filesystem 每会话扫描 customSkillDirs，重命名后新会话即生效（不动共享目录）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANAGED_BEGIN = '# >>> OPS-ADMIN MANAGED >>>'
export const MANAGED_END = '# <<< OPS-ADMIN MANAGED <<<'

export interface McpServerEntry {
  /** 服务名（工具前缀 mcp__<name>__ 的中段） */
  serverName: string
  /** 传输协议：streamable-http | stdio */
  transport: 'streamable-http' | 'stdio'
  /** HTTP 传输的服务地址 */
  url?: string
  /** HTTP 传输的请求头（如 Authorization Bearer） */
  headers?: Record<string, string>
  /** stdio 传输的命令 */
  command?: string
  /** stdio 传输的参数 */
  args?: string[]
}

export interface ManagedState {
  /** 文件内容 sha1（CRLF 归一化后），写时作 If-Match */
  revision: string
  /** 托管段内的 MCP 服务列表 */
  servers: McpServerEntry[]
}

export function computeRevision(content: string): string {
  return createHash('sha1').update(content.replace(/\r\n/g, '\n')).digest('hex')
}

/** 校验 MCP 服务定义；返回错误描述列表，空数组表示合法。 */
export function validateServer(entry: Partial<McpServerEntry>): string[] {
  const errors: string[] = []
  const name = entry.serverName ?? '';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) errors.push('serverName must match [A-Za-z0-9_-]{1,32}');
  if (entry.transport !== 'streamable-http' && entry.transport !== 'stdio') {
    errors.push('transport must be streamable-http or stdio');
  } else if (entry.transport === 'streamable-http') {
    if (!entry.url || !/^https?:\/\//.test(entry.url)) errors.push('url must be http(s):// for streamable-http');
  } else if (!entry.command) {
    errors.push('command is required for stdio');
  }
  return errors;
}

/** 序列化一个 MCP 服务为托管段内的 YAML 行（缩进固定，托管段由本模块独占）。 */
export function serializeServer(entry: McpServerEntry): string[] {
  const lines = [
    '    - id: mcp-' + entry.serverName,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: ' + entry.serverName,
    '        transport: ' + entry.transport,
  ]
  if (entry.transport === 'streamable-http') {
    lines.push("        url: '" + entry.url + "'");
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      lines.push('        headers:')
      for (const [k, v] of Object.entries(entry.headers)) lines.push('          ' + k + ": '" + String(v).replace(/'/g, "''") + "'");
    }
  } else {
    lines.push("        command: '" + entry.command + "'");
    if (entry.args && entry.args.length > 0) lines.push('        args: [' + entry.args.map((a) => "'" + a + "'").join(', ') + ']');
  }
  return lines;
}

/** 解析托管段内的服务列表（行扫描；标记区外内容不影响）。 */
export function parseManagedServers(content: string): McpServerEntry[] {
  const lines = content.split('\n');
  const begin = lines.findIndex((l) => l.trim() === MANAGED_BEGIN);
  const end = lines.findIndex((l) => l.trim() === MANAGED_END);
  if (begin < 0 || end < 0 || end < begin) return [];
  const servers: McpServerEntry[] = [];
  let current: McpServerEntry | undefined;
  let inConfig = false;
  let inHeaders = false;
  for (const line of lines.slice(begin + 1, end)) {
    const idMatch = /^\s*- id: mcp-(\S+)/.exec(line);
    if (idMatch) {
      current = { serverName: idMatch[1], transport: 'streamable-http' };
      servers.push(current);
      inConfig = false;
      inHeaders = false;
      continue;
    }
    if (!current) continue;
    if (/^\s{6}config:/.test(line)) { inConfig = true; inHeaders = false; continue }
    if (!inConfig) continue;
    if (/^\s{8}headers:/.test(line)) { inHeaders = true; continue }
    if (inHeaders) {
      const h = /^\s{10}([A-Za-z0-9-]+):\s*'?(.*?)'?\s*$/.exec(line);
      if (h) { current.headers = { ...current.headers, [h[1]]: h[2].replace(/''/g, "'") } } else { inHeaders = false }
      continue;
    }
    const field = /^\s{8}(serverName|transport|url|command):\s*(?:'([^']*)'|(\S+))/.exec(line);
    if (field) {
      const value = field[2] ?? field[3];
      if (field[1] === 'transport') current.transport = value as McpServerEntry['transport'];
      else if (field[1] === 'command') current.command = value;
      else if (field[1] === 'url') current.url = value;
    }
    const args = /^\s{8}args:\s*\[(.*)\]/.exec(line);
    if (args) current.args = args[1] ? args[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : [];
  }
  return servers;
}

/** 读取托管段状态；文件不存在或无标记区时返回空列表（首次写入会追加标记区）。 */
export function readManagedState(patchPath: string): ManagedState {
  const content = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  return { revision: computeRevision(content), servers: parseManagedServers(content) };
}

/**
 * 原子写入托管段：revision 冲突返回 false（调用方应重读后重试）；其他错误抛出。
 * 写入内容 = 原文件中标记区替换为新内容；无标记区则追加到末尾。
 */
export function writeManagedState(
  patchPath: string,
  expectedRevision: string,
  servers: McpServerEntry[],
): boolean {
  const content = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  if (computeRevision(content) !== expectedRevision) return false;
  // 条目缩进为 4 空格（托管段独占一个 - insert: 父级）；空列表时无需父级
  const block = servers.length > 0
    ? [MANAGED_BEGIN, '- insert:', ...servers.flatMap(serializeServer), MANAGED_END].join('\n')
    : [MANAGED_BEGIN, MANAGED_END].join('\n');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const begin = lines.findIndex((l) => l.trim() === MANAGED_BEGIN);
  const end = lines.findIndex((l) => l.trim() === MANAGED_END);
  let next: string;
  if (begin >= 0 && end >= begin) {
    lines.splice(begin, end - begin + 1, block);
    next = lines.join('\n');
  } else {
    next = content.trimEnd() + '\n\n' + block + '\n';
  }
  const tmp = patchPath + '.ops-admin.tmp';
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, patchPath);
  return true;
}

export interface SkillEntry {
  /** 技能目录名（停用时带 .disabled 后缀） */
  name: string
  /** 是否已启用（未带 .disabled 后缀） */
  enabled: boolean
}

/**
 * 扫描技能目录：每个含 SKILL.md（或 SKILL.md.disabled）的子目录一项。
 * C1 整改（2026-09-16）：启停判定从目录后缀改为 SKILL.md 级——skill-filesystem
 * 用 frontmatter name 注册技能（index.ts:737），目录改名对注册名无效（live 实证：
 * disable 目录后技能仍从 .disabled 目录加载成功）；扫描器只认精确名 SKILL.md，
 * 故改名 SKILL.md 为 SKILL.md.disabled 才真正让技能从 catalog 消失。
 */
export function listSkills(skillsDir: string): SkillEntry[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const dir = join(skillsDir, d.name);
      const active = existsSync(join(dir, 'SKILL.md'));
      const parked = existsSync(join(dir, 'SKILL.md.disabled'));
      return parked && !active
        ? { name: d.name, enabled: false }
        : { name: d.name, enabled: true };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 启停技能：目录内重命名 SKILL.md ↔ SKILL.md.disabled（C1 整改）。
 * skill-filesystem 扫描器只认精确名 SKILL.md 且用 frontmatter name 注册，
 * 故 SKILL.md 级改名才真正让技能从 catalog 出现/消失。不存在或状态已相同返回 false。
 */
export function setSkillEnabled(skillsDir: string, name: string, enabled: boolean): boolean {
  if (!/^[A-Za-z0-9_.\-一-鿿]{1,64}$/.test(name)) return false;
  const dir = join(skillsDir, name);
  if (!existsSync(dir)) return false;
  const active = join(dir, 'SKILL.md');
  const parked = join(dir, 'SKILL.md.disabled');
  if (enabled) {
    if (!existsSync(parked) || existsSync(active)) return false;
    renameSync(parked, active);
  } else {
    if (!existsSync(active)) return false;
    renameSync(active, parked);
  }
  return true;
}

/** 确保技能目录存在（插件 apply 时调用，首次创建）。 */
export function ensureSkillsDir(skillsDir: string): void {
  mkdirSync(skillsDir, { recursive: true });
}
