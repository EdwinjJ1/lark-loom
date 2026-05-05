/**
 * 飞书 Bot 运行时门面。
 *
 * 所有飞书 IM API 调用必须走 BotRuntime — 它的实现内部包了 token bucket 限流
 * (100 req/min + 5 req/sec)，确保多个 Skill 并发不会撞飞书的硬限。
 *
 * 不允许在 skill / adapter 里直接 import @larksuiteoapi/node-sdk。
 */

import type { Card } from './card.js';
import type { BotEvent, Message } from './message.js';
import type { Result } from './result.js';

export interface SendTextParams {
  readonly chatId: string;
  readonly text: string;
  /** 用 reply 还是新发一条 */
  readonly replyTo?: string;
}

export interface SendCardParams {
  readonly chatId: string;
  readonly card: Card;
  readonly replyTo?: string;
}

/** 发送结果，至少返回 messageId 便于后续流式更新 */
export interface SentMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly timestamp: number;
}

export interface FetchHistoryParams {
  readonly chatId: string;
  readonly pageSize?: number; // 默认 20，最大 100
  readonly pageToken?: string;
  /** 起始时间戳 (Unix ms)，留空表示最新往前 */
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface FetchHistoryResult {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
  readonly nextPageToken?: string;
}

export interface FetchMembersParams {
  readonly chatId: string;
}

export interface ChatMember {
  readonly userId: string;
  readonly name: string;
}

export interface FetchMembersResult {
  readonly members: readonly ChatMember[];
}

export interface PatchCardParams {
  readonly messageId: string;
  readonly card: Card;
}

export type EventHandler<E extends BotEvent = BotEvent> = (event: E) => void | Promise<void>;

export interface BotRuntime {
  /** 发送纯文本消息 */
  sendText(params: SendTextParams): Promise<Result<SentMessage>>;

  /** 发送卡片消息 */
  sendCard(params: SendCardParams): Promise<Result<SentMessage>>;

  /** 流式更新已发出的卡片（Card 2.0 streaming），节流 0.5s/次 */
  patchCard(params: PatchCardParams): Promise<Result<void>>;

  /** 拉取群历史消息（机器人必须是群成员）*/
  fetchHistory(params: FetchHistoryParams): Promise<Result<FetchHistoryResult>>;

  /** 拉取群成员列表（机器人必须是群成员）*/
  fetchMembers(params: FetchMembersParams): Promise<Result<FetchMembersResult>>;

  /**
   * 按 messageId 取单条消息。
   * 如果消息是合并转发（merge_forward），返回 parent + 平铺的所有嵌套子消息
   * （父在前；子按原始顺序在后）。普通消息只返回它自己一条。
   */
  fetchMessage(messageId: string): Promise<Result<{ readonly messages: readonly Message[] }>>;

  /** 注册事件回调；返回 unregister 函数 */
  on(handler: EventHandler): () => void;

  /** 启动长连接 */
  start(): Promise<Result<void>>;

  /** 停止长连接，清理资源 */
  stop(): Promise<void>;
}
