/**
 * yml.ts — YAML 读写：`!!js` 标量原文保留（customTags，绝不求值）+ 原子写。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import YAML from 'yaml'

/** `!!js <expr>` 自定义 tag：值按字符串原文保留，绝不求值 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (s: string) => s, identify: () => false }

export function loadYamlText(text: string): unknown {
  const doc = YAML.parseDocument(text, { customTags: [JS_TAG] })
  if (doc.errors.length > 0) throw new Error(`yaml parse: ${doc.errors[0]!.message}`)
  return doc.toJS()
}

export function loadYamlFile(path: string): unknown {
  return loadYamlText(readFileSync(path, 'utf8'))
}

export function dumpYaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 })
}

export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/**
 * 保注释内存变更：parseDocument（不丢注释）→ mutate → toString，不落盘。
 * 真实写（editYaml）与预演 diff（planChanges 虚拟写）共用同一入口，保证两边逐字节一致。
 */
export function mutateYamlText(text: string, mutate: (doc: YAML.Document.Parsed) => void): string {
  const doc = YAML.parseDocument(text, { customTags: [JS_TAG] })
  if (doc.errors.length > 0) throw new Error(`yaml parse: ${doc.errors[0]!.message}`)
  mutate(doc)
  return doc.toString({ lineWidth: 0 })
}

/**
 * 保注释读改写：parseDocument（不丢注释）→ mutate → 原子写回。
 * 替换通道三处写（core.yml / pack / domain.yml）共用——dumpYaml 会冲掉全部注释。
 */
export function editYaml(path: string, mutate: (doc: YAML.Document.Parsed) => void): void {
  atomicWrite(path, mutateYamlText(readFileSync(path, 'utf8'), mutate))
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}
