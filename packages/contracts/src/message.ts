/**
 * 飞书消息 + 事件抽象。
 * 飞书原始事件字段繁杂，这里只暴露我们用得到的最小集。
 * 原始字段以飞书开放平台 im.message.receive_v1 文档为准。
 */

export type ChatType = 'group' | 'p2p';

export type MessageContentType =
  | 'text'
  | 'post' // 富文本
  | 'image'
  | 'file'
  | 'audio'
  | 'card'
  | 'sticker'
  | 'merge_forward' // 合并转发：rawContent="Merged and Forwarded Message"，嵌套子要走 BotRuntime.fetchMessage 展开
  | 'unknown';

export interface UserRef {
  readonly userId: string; // open_id（机器人视角的用户 ID）
  readonly unionId?: string;
  readonly name?: string;
}

export interface Mention {
  readonly user: UserRef;
  /** 文本中 @ 占位符的位置，便于剥离 */
  readonly key: string;
}

/** 飞书群消息 / 私聊消息事件 — `im.message.receive_v1` 转换后的标准化结构 */
export interface Message {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: ChatType;
  readonly sender: UserRef;
  readonly contentType: MessageContentType;
  /** 提取后的纯文本（剥离 @ 占位符）；非文本消息为 '' */
  readonly text: string;
  /** 原始 content 字符串（飞书原始 JSON），便于后续解析富内容 */
  readonly rawContent: string;
  readonly mentions: readonly Mention[];
  /** 引用的 messageId（reply_in_thread 或回复某条） */
  readonly replyTo?: string;
  /** Unix ms */
  readonly timestamp: number;
  readonly meta?: Record<string, unknown>;
}

/** 卡片按钮 / 表单提交回调 — `card.action.trigger` */
export interface CardAction {
  readonly chatId: string;
  readonly messageId: string;
  readonly user: UserRef;
  /** 按钮 / 表单组件透传的 value */
  readonly value: Record<string, unknown>;
  /** 表单组件提交时携带，按钮点击时为空 */
  readonly formValue?: Record<string, unknown>;
  readonly timestamp: number;
}

/** 用户首次私聊机器人 — `p2p_chat_create_v1` */
export interface P2PChatCreated {
  readonly chatId: string;
  readonly user: UserRef;
  readonly timestamp: number;
}

/** 机器人被拉入群 — `im.chat.member.bot.added_v1` */
export interface BotJoinedChat {
  readonly chatId: string;
  readonly inviter: UserRef;
  readonly timestamp: number;
}

/** Bot 进程对外暴露的事件 union — 主程序 router 按 type 分发 */
export type BotEvent =
  | { readonly type: 'message'; readonly payload: Message }
  | { readonly type: 'cardAction'; readonly payload: CardAction }
  | { readonly type: 'p2pChatCreated'; readonly payload: P2PChatCreated }
  | { readonly type: 'botJoinedChat'; readonly payload: BotJoinedChat };
