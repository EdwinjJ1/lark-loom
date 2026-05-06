/**
 * LLM 客户端统一接口。
 * 所有 LLM 调用必须走 LLMClient.ask / askStructured，不允许散落 fetch。
 *
 * 模型分流策略（CLAUDE.md 已定）:
 *   - lite (豆包 Lite)：缺口检测、关键词识别、轻量过滤
 *   - pro  (豆包 Pro) ：Skill Router、卡片内容生成、长上下文整合
 */

import type { Result } from './result.js';

export type LLMModel = 'lite' | 'pro';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** 仅当 role === 'assistant' 时可能存在：模型本轮发起的 tool 调用 */
  readonly toolCalls?: readonly ToolCall[];
  /** 仅当 role === 'tool' 时存在：对应的 ToolCall.id */
  readonly toolCallId?: string;
  /** 仅当 role === 'tool' 时存在：被调用的工具名（便于日志/审计） */
  readonly name?: string;
}

/**
 * OpenAI / 火山方舟兼容的工具描述。
 * parameters 用 JSON Schema（最常见子集即可：type/properties/required）。
 */
export interface LLMTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** 模型一次工具调用请求 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 模型给出的原始参数字符串（通常是 JSON），调用方负责 parse + 校验 */
  readonly argumentsRaw: string;
}

/** 调用方执行 tool 后回传给模型的结果 */
export interface ToolResult {
  readonly toolCallId: string;
  readonly name: string;
  /** 工具执行结果（字符串）。失败也返回字符串说明，让模型自行处理 */
  readonly content: string;
}

export interface AskOptions {
  readonly model?: LLMModel;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly systemPrompt?: string;
  readonly timeoutMs?: number;
  /** 可选：声明模型可调用的工具列表（function calling） */
  readonly tools?: readonly LLMTool[];
  /**
   * 可选：'auto'（默认，模型自决）/ 'none'（强制不调工具）/ 具体工具名（强制调指定工具）。
   * 注：联合中的 string 表达"具体工具名"，类型层面无法收窄字面量；
   * 实现按 OpenAI 协议透传，string 视为工具名。
   */
  readonly toolChoice?: 'auto' | 'none' | string;
}

/** chatWithTools 的最终输出 */
export interface ChatWithToolsResult {
  /** 模型最终给用户的文本（可能为空：模型只调工具不说话的极端情况） */
  readonly content: string;
  /** 中途所有 tool 调用记录（顺序），便于日志与审计 */
  readonly toolCalls: readonly ToolCall[];
  /** 实际经过的轮数（含初始 + 每次 tool 回灌） */
  readonly rounds: number;
}

/** chatWithTools 的运行参数 */
export interface ChatWithToolsOptions extends AskOptions {
  /** 单次调用允许的最大 tool-call 轮数。默认 5 */
  readonly maxToolCallRounds?: number;
  /**
   * 工具执行器：把 ToolCall 转成 ToolResult。
   * 抛错或拒绝时也应返回带 content 的 ToolResult（建议格式：JSON.stringify({ error: '...' })），
   * 由模型决定是否重试或换工具。
   */
  readonly executor: (call: ToolCall) => Promise<ToolResult>;
}

/**
 * 极简 schema 描述：实现层用 zod / valibot 都行，contracts 层不绑定具体校验库。
 * 实现 LLMClient 的 adapter 内部把 SchemaLike 转成自己用的校验器。
 */
export interface SchemaLike<T> {
  /** 解析未知值，校验失败抛错 */
  parse(value: unknown): T;
  /** （可选）输出 JSON Schema，给 LLM 做 structured output prompt */
  jsonSchema?(): Record<string, unknown>;
}

export interface LLMClient {
  /** 自由文本问答 */
  ask(prompt: string, opts?: AskOptions): Promise<Result<string>>;

  /** 多轮对话 */
  chat(messages: readonly ChatMessage[], opts?: AskOptions): Promise<Result<string>>;

  /**
   * 结构化输出。实现层应：
   *   1. 把 schema 转成 prompt 提示
   *   2. 调 LLM 拿 raw JSON
   *   3. schema.parse(JSON.parse(raw))
   *   4. 失败重试 N 次后返回 LLM_INVALID_RESPONSE
   */
  askStructured<T>(prompt: string, schema: SchemaLike<T>, opts?: AskOptions): Promise<Result<T>>;

  /**
   * 多轮对话 + Function Calling（OpenAI 兼容协议）。
   * 模型若返回 tool_calls：
   *   1. 调用方通过 opts.executor 逐个执行 → ToolResult
   *   2. 把 assistant(toolCalls) + tool(results) 追加到消息历史回灌模型
   *   3. 重复直到模型不再请求工具，或达到 maxToolCallRounds（默认 5）
   * 达到上限仍未收敛时返回最后一次 content + 所有 toolCalls，调用方决定如何处理。
   */
  chatWithTools(
    messages: readonly ChatMessage[],
    opts: ChatWithToolsOptions,
  ): Promise<Result<ChatWithToolsResult>>;

  /**
   * 向量化单条文本（Embedding）。
   * 返回浮点数组，维度由模型决定（Doubao text-embedding-3 为 2048 维）。
   * 不支持 embedding 的实现应返回 CONFIG_MISSING err，调用方据此降级。
   */
  embed(text: string): Promise<Result<readonly number[]>>;
}
