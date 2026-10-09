/**
 * extract.ts — 从本步消息里取出「用户在说什么」（纯模块：只用 node 内建 + 相对导入）
 *
 * 只认 `source.kind === 'user'` 的文本块，与上游 `tool-skill` 的 `invokedSkillNames`
 * 同款防伪造口径：外部注入的消息（recall 上下文、工具结果、其它插件注入）不参与意图识别，
 * 否则注入内容可以诱导路由。
 */

/** 结构化最小消息视图（避免为纯模块引入运行时依赖）。 */
export interface MiniBlock {
  type?: string
  text?: string
}

export interface MiniMessage {
  content?: readonly MiniBlock[]
  source?: { kind?: string }
}

/** 拼接一条消息里的全部文本块。 */
export function textOf(message: MiniMessage): string {
  const blocks = message.content
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 本步是否为「真实用户消息」（source 必须是 user）。 */
export function isUserMessage(message: MiniMessage): boolean {
  return (message.source as { kind?: unknown } | undefined)?.kind === 'user'
}

/**
 * 取本步最后一条真实用户消息的文本；没有则返回 ''。
 * 「最后一条」= 用户最新说的那句话，正是意图识别的对象。
 */
export function lastUserText(messages: readonly MiniMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || !isUserMessage(message)) continue
    const text = textOf(message)
    if (text.trim() !== '') return text
  }
  return ''
}

const ZERO_WIDTH = /[\u200b-\u200d\ufeff\u2060]/g

/**
 * 归一化：去零宽字符、全角字母数字/连字符转半角、折叠空白。
 * 目的：让 `ＯＲＡ－００９４２` 这类全角输入也能命中错误码正则。
 */
export function normalizeText(text: string): string {
  const stripped = text.replace(ZERO_WIDTH, '')
  let out = ''
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0
    // 全角 ！ 到 ～ 区间（U+FF01–U+FF5E）整体偏移到 ASCII
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0)
    else if (code === 0x3000) out += ' '   // 全角空格
    else out += ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

const GREETING = /^(你好|您好|hi|hello|hey|在吗|在么|早上好|下午好|晚上好|谢谢|多谢|感谢|thanks|thank you|thanks a lot|好的|收到|ok|okay)[\s!！。.~]*$/i

/** 极短问候/致谢：识别为 `none` 意图（不注入，直接放行）。 */
export function isLikelyGreeting(normalized: string): boolean {
  if (normalized.length === 0) return false
  return GREETING.test(normalized)
}

/** 去掉 `/skill-name` 手势后的正文：手势由上游 tool-skill 处理，本插件不重复接管。 */
export function stripSlashGesture(normalized: string): string {
  return normalized.replace(/(^|\s)\/[a-z0-9][a-z0-9-]*/gi, ' ').replace(/\s+/g, ' ').trim()
}
