/**
 * stack.ts — P6 堆栈信号抽取（批次 D：对齐 i2stream-bkn 2026-10-30 的 P6 开放入口）
 *
 * 从用户输入识别"堆栈/异常链/线程状态"信号，命中即注入 stack_tip 指向
 * `skill:i2stream-stack-analysis`。**不路由任何工具**（守 py 54 号 C 契约：堆栈信号是
 * 语义能力，不是工具编排）。单类失败静默（H-15）。
 *
 * 观测面判据（保守，宁少不误报）：
 *  · exception：`Exception in thread` / `Caused by: …Exception` / `java.lang.*(Exception|Error)`
 *  · oom：`OutOfMemoryError` / `OOM`
 *  · thread：`jstack` / jstack 线程头（`"…" prio=`）/ 线程状态词（WAITING/BLOCKED/lock）
 */
export type StackSignalKind = 'exception' | 'oom' | 'thread'

export interface StackSignal {
  kind: StackSignalKind
  tip: string
}

export const STACK_SKILL = 'i2stream-stack-analysis'

const STACK_PATTERNS: Array<[StackSignalKind, RegExp[]]> = [
  ['exception', [
    /Exception in thread/i,
    /Caused by:\s*[\w.$]+(?:Exception|Error)/,
    /java\.lang\.[\w.$]+(?:Exception|Error)/,
    /\bat [\w.$<>]+\.\w+\([^)]*\)/,
  ]],
  ['oom', [
    /OutOfMemoryError/i,
    /\bOOM[^a-z]/i,
    /java heap space/i,
  ]],
  ['thread', [
    /\bjstack\b/i,
    /"[\w.-]+"(?:[\s\S]{0,40}?prio=\d+)/,
    /\b(?:WAITING|BLOCKED|RUNNABLE)\b[^a-z]{0,30}?\block\b/i,
  ]],
]

const DESCRIBE: Record<StackSignalKind, string> = {
  exception: '异常链/堆栈帧',
  oom: 'OOM/资源耗尽信号',
  thread: '线程状态（jstack/锁）',
}

/** 抽取堆栈信号；无命中返回 null，失败返回 null（H-15）。 */
export function extractStackSignal(text: string): StackSignal | null {
  try {
    const t = String(text ?? '')
    if (!t.trim()) return null
    for (const [kind, res] of STACK_PATTERNS) {
      if (res.some((re) => re.test(t))) return signalFor(kind)
    }
    return null
  } catch {
    return null
  }
}

function signalFor(kind: StackSignalKind): StackSignal {
  return {
    kind,
    tip:
      `[stack-signal] 输入含${DESCRIBE[kind]}——建议先加载 skill:${STACK_SKILL} 按其` +
      '堆栈解析流程取证（判根因、看沉默端），不要仅凭错误码/单行日志猜根因（unknown 是合法中间态）。',
  }
}