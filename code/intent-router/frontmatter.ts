/**
 * frontmatter.ts — SKILL.md / .bkn 风格 YAML frontmatter 的容错逐行解析（纯模块）
 *
 * 只为取三样东西：name / description / triggers。项目口径是「不依赖 yaml 库」
 * （参见 dsh-plugin/resolver.ts 的 parseManifestYaml），这里沿用同一策略：
 * 支持 `key: value`、`key: |` 多行块、`key:` + `- item` 列表、以及引号包裹值。
 * 解析失败一律返回空结构（生成器侧降级，不抛）。
 */

export interface Frontmatter {
  [key: string]: string | string[]
}

const FENCE = /^---\s*$/

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 截取文件开头的 frontmatter 块；没有则返回 ''。 */
export function frontmatterBlock(text: string): string {
  const lines = text.split('\n')
  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) return ''
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? '')) return lines.slice(1, i).join('\n')
  }
  return ''
}

/**
 * 解析 frontmatter 文本为键值表（值：字符串或多行块/列表合成的字符串数组）。
 * @param block - frontmatter 内部文本（不含 fence）。
 */
export function parseFrontmatter(block: string): Frontmatter {
  const out: Frontmatter = {}
  if (block.trim() === '') return out
  const lines = block.split('\n')
  let key: string | null = null
  let blockIndent = -1
  let listValues: string[] = []
  let blockLines: string[] = []

  const flush = (): void => {
    if (key === null) return
    if (listValues.length > 0) out[key] = listValues
    else if (blockLines.length > 0) out[key] = blockLines.join('\n').trimEnd()
    key = null
    blockIndent = -1
    listValues = []
    blockLines = []
  }

  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length
    const stripped = raw.trim()
    const listItem = stripped.match(/^-[ \t]+(.*)$/)
    if (key !== null && blockIndent > 0 && indent >= blockIndent) {
      if (listItem) listValues.push(unquote(listItem[1]!))
      else if (listItem === null) {
        if (listValues.length === 0) blockLines.push(raw.slice(blockIndent))
        else if (stripped !== '') listValues.push(unquote(stripped))
      }
      continue
    }
    flush()
    if (stripped === '' || stripped.startsWith('#')) continue
    const match = stripped.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (!match) continue
    const name = match[1]!
    const value = match[2]!
    if (value === '' || value === '|' || value === '>' || value === '|-') {
      key = name
      blockIndent = indent + 2
      continue
    }
    out[name] = unquote(value)
  }
  flush()
  return out
}

export interface SkillMeta {
  name: string
  description: string
  triggers: string[]
}

/** 从 SKILL.md 正文抽取 name / description / triggers。 */
export function parseSkillMeta(text: string): SkillMeta {
  const fm = parseFrontmatter(frontmatterBlock(text))
  const asText = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? value.join(' ') : (value ?? '')
  const triggers = Array.isArray(fm.triggers)
    ? fm.triggers
    : typeof fm.triggers === 'string'
      ? fm.triggers.split(',').map((t) => unquote(t))
      : []
  return {
    name: asText(fm.name),
    description: asText(fm.description),
    triggers: triggers.map((t) => t.trim()).filter((t) => t !== ''),
  }
}
