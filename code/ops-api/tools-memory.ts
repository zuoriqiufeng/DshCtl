/**
 * tools-memory.ts — TencentDB 记忆三工具（G3，gap-exec-plan P2）
 *
 * 工具名/描述/字段语义 1:1 对齐 Hermes 的 MEMORY_SEARCH_SCHEMA /
 * CONVERSATION_SEARCH_SCHEMA / READ_SCENE_SCHEMA；parameters 用 dsh 的隐式
 * property map 表达（对象根隐含，required 标在字段上），不是裸 JSON Schema。
 *
 * per-request memoryKey 传递：工具由 ctx.tools.register 全局注册（无 per-request
 * 会话上下文），ops-api 在 runTurn 外层 als.run({memoryKey}, ...)，本模块读取
 * memoryAls 当前 store；无 store（GUI 会话等非 ops-api 路径）→ 空结果 + 提示语。
 */

import type { OpsMemoryService } from './memory.ts'
import { memoryAls } from './memory.ts'

export interface MemoryToolDeps {
  memory: OpsMemoryService
}

/** DSH defineTool 最小形状（register 侧兼容；实际 import 在 index.ts 完成避免循环依赖） */
export interface MemoryToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

const NO_KEY_HINT = '当前会话未启用记忆分片（未提供 X-Ops-Memory-Key）。请在请求头添加 X-Ops-Memory-Key 以启用长期记忆检索。'
const GATEWAY_HINT = '记忆网关暂不可用（熔断或超时）。请稍后重试或联系管理员检查 memory-tencentdb Gateway 健康状态。'

export function buildMemoryTools(deps: MemoryToolDeps): MemoryToolDef[] {
  const { memory } = deps

  /** 读取当前请求 ALS 中的 memoryKey；工具运行链若脱离 ALS 上下文则返回 '' */
  const currentKey = (): string => memoryAls.getStore()?.memoryKey ?? ''

  return [
    {
      name: 'memory_tencentdb_memory_search',
      description: (
        'Search through the user\'s long-term memories. Use this when you need to '
        + 'recall specific information about the user\'s preferences, past events, '
        + 'instructions, or context from previous conversations. Returns relevant '
        + 'memory records ranked by relevance.'
      ),
      parameters: {
        query: {
          type: 'string',
          description: 'Search query describing what you want to recall about the user.',
          required: true,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 5, max: 20).',
        },
        type: {
          type: 'string',
          enum: ['persona', 'episodic', 'instruction'],
          description: 'Optional filter by memory type.',
        },
      },
      execute: async (args) => {
        const key = currentKey()
        if (!key) return NO_KEY_HINT
        const results = await memory.searchMemories(String(args.query ?? ''), {
          limit: typeof args.limit === 'number' ? Math.min(args.limit, 20) : 5,
          type: typeof args.type === 'string' ? args.type : undefined,
        })
        return results || GATEWAY_HINT
      },
    },
    {
      name: 'memory_tencentdb_conversation_search',
      description: (
        'Search through past conversation history (raw dialogue records). '
        + 'Use when memory_tencentdb_memory_search doesn\'t have the information '
        + 'you need, or when you want to find specific past conversations or '
        + 'exact words the user said before.'
      ),
      parameters: {
        query: {
          type: 'string',
          description: 'Search query describing what conversation content you want to find.',
          required: true,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 5, max: 20).',
        },
      },
      execute: async (args) => {
        const key = currentKey()
        if (!key) return NO_KEY_HINT
        const results = await memory.searchConversations(String(args.query ?? ''), {
          limit: typeof args.limit === 'number' ? Math.min(args.limit, 20) : 5,
        })
        return results || GATEWAY_HINT
      },
    },
    {
      name: 'memory_tencentdb_read_scene',
      description: (
        'Read a scene block\'s full content by its name. '
        + 'Use when you see a scene listed in the available scenes and want to '
        + 'retrieve detailed information from that scene.'
      ),
      parameters: {
        scene_id: {
          type: 'string',
          description: "Scene file name (e.g. 'travel-plan.md' or 'travel-plan').",
          required: true,
        },
      },
      execute: async (args) => {
        const key = currentKey()
        if (!key) return NO_KEY_HINT
        const results = await memory.readScene(String(args.scene_id ?? ''))
        return results || GATEWAY_HINT
      },
    },
  ]
}
