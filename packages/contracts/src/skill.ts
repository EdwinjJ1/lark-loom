/**
 * Skill 抽象 — 9 条业务主线（qa / recall / summary / slides / archive / crossChat / weekly / requirementDoc / docIterate）
 * 各实现一个 Skill。
 *
 * Router 流程：
 *   收到 BotEvent
 *      → 遍历 SkillRegistry 调 match()
 *      → 对所有匹配的 skill 并发调 run()
 *      → run() 返回 SkillResult，runtime 负责把 card / sideEffects 落地
 */

import type { BitableClient, MemoryStoreClient } from './bitable.js';
import type { BotRuntime } from './bot-runtime.js';
import type { Card, CardBuilder } from './card.js';
import type { LLMClient } from './llm.js';
import type { BotEvent } from './message.js';
import type { Retriever } from './retriever.js';
import type { Result } from './result.js';
import type { DocxClient } from './docx.js';
import type { SlidesClient } from './slides.js';

/** 8 条主线对应的稳定字符串 ID */
export type SkillName =
  | 'qa'
  | 'recall'
  | 'summary'
  | 'slides'
  | 'archive'
  | 'weekly'
  | 'requirementDoc' // 被动监听需求描述 → 生成结构化飞书文档
  | 'docIterate'; // 持续监听对话 → 增量更新已有需求文档

/** 触发条件描述（声明式，便于在 docs / debug UI 上展示） */
export interface TriggerSpec {
  /** 关注哪些事件类型 */
  readonly events: readonly BotEvent['type'][];
  /** 是否要求 @bot；默认 false（被动监听） */
  readonly requireMention?: boolean;
  /** 关键词命中即可触发；为空表示走 LLM 判断 */
  readonly keywords?: readonly string[];
  /** cron 表达式，仅 weekly 类用 */
  readonly cron?: string;
  /** 人类可读说明，会写进 docs 和 demo 解说 */
  readonly description: string;
}

export interface SkillMetadata {
  readonly description: string;
  readonly when_to_use: string;
  readonly examples: readonly string[];
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * 注入给 Skill 的上下文：所有外部依赖都在这里，便于测试 mock。
 */
export interface SkillContext {
  readonly event: BotEvent;
  readonly runtime: BotRuntime;
  readonly llm: LLMClient;
  readonly bitable: BitableClient;
  readonly retrievers: Readonly<Record<string, Retriever>>;
  readonly logger: Logger;
  readonly docx: DocxClient;
  readonly slides?: SlidesClient;
  readonly cardBuilder: CardBuilder;
  readonly memoryStore?: MemoryStoreClient;
}

/** Skill 副作用：写 Bitable / 调外部 webhook / 触发其他 skill 等 */
export type SideEffect =
  | {
      readonly kind: 'bitable.insert';
      readonly table: string;
      readonly row: Record<string, unknown>;
    }
  | { readonly kind: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly kind: 'custom'; readonly name: string; readonly payload: Record<string, unknown> };

export interface SkillResult {
  /** 要回群里的卡片；不发就 undefined */
  readonly card?: Card;
  /** 要回的纯文本（card 优先）*/
  readonly text?: string;
  /** 副作用：runtime 在卡片发出后执行 */
  readonly sideEffects?: readonly SideEffect[];
  /** Skill 决策原因：评委演示要看，存进 Bitable.memory */
  readonly reasoning?: string;
  readonly meta?: Record<string, unknown>;
}

export interface Skill {
  readonly name: SkillName;
  readonly trigger: TriggerSpec;
  readonly metadata: SkillMetadata;

  /** 同步快速过滤：返回 false 直接跳过，不进 run() */
  match(ctx: SkillContext): boolean | Promise<boolean>;

  /** 主逻辑；失败时返回 err Result，不要 throw */
  run(ctx: SkillContext): Promise<Result<SkillResult>>;
}
