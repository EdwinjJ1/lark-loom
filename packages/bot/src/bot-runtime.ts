import * as lark from '@larksuiteoapi/node-sdk';
import {
  type BotRuntime,
  type BotEvent,
  type CardAction,
  type EventHandler,
  type SendTextParams,
  type SendCardParams,
  type SentMessage,
  type PatchCardParams,
  type FetchHistoryParams,
  type FetchHistoryResult,
  type FetchMembersParams,
  type FetchMembersResult,
  type Logger,
  type Message,
  type Mention,
  type UserRef,
  type MessageContentType,
  type Result,
  ok,
  err,
  makeError,
  ErrorCode,
} from '@seedhac/contracts';
import { type QuotaTracker, globalQuotaTracker, withRateLimitRetry } from './rate-limit.js';

// ─── 限流器：100 req/min + 5 req/sec ─────────────────────────────────────────
//
// Layer B（issue #91）：QuotaTracker.isThrottled() 时把 sec/min 配额减半，
// 主动收紧本地限流，配合 withRateLimitRetry 的事后退避形成双层防护。

class RateLimiter {
  private secTokens = 5;
  private minTokens = 100;
  private lastSec = Date.now();
  private lastMin = Date.now();
  private readonly queue: Array<() => void> = [];
  private processing = false;

  constructor(private readonly tracker: QuotaTracker = globalQuotaTracker) {}

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      this.refill();
      if (this.secTokens >= 1 && this.minTokens >= 1) {
        this.secTokens--;
        this.minTokens--;
        this.queue.shift()!();
      } else {
        await sleep(50);
      }
    }
    this.processing = false;
  }

  private refill(): void {
    const now = Date.now();
    const factor = this.tracker.isThrottled() ? 0.5 : 1;
    const maxSec = 5 * factor;
    const maxMin = 100 * factor;
    this.secTokens = Math.min(maxSec, this.secTokens + ((now - this.lastSec) / 1000) * maxSec);
    this.lastSec = now;
    this.minTokens = Math.min(maxMin, this.minTokens + ((now - this.lastMin) / 60000) * maxMin);
    this.lastMin = now;
  }
}

// ─── 工具 ──────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 简易 LRU Set —— 用于 backfill 去重。
 *
 * 容量满时淘汰最久未 add 的元素。Map 的插入顺序天然就是 access 顺序（每次 add 已存在
 * 元素时会 delete + set 重新插到末尾），所以 keys().next() 拿到的就是最旧的那个。
 */
export class LRUSet<T> {
  private readonly capacity: number;
  private readonly map = new Map<T, true>();

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('LRUSet capacity must be > 0');
    this.capacity = capacity;
  }

  has(item: T): boolean {
    return this.map.has(item);
  }

  /** 返回 true 表示是新加的，false 表示已存在（recency 已刷新） */
  add(item: T): boolean {
    if (this.map.has(item)) {
      this.map.delete(item);
      this.map.set(item, true);
      return false;
    }
    this.map.set(item, true);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return true;
  }

  size(): number {
    return this.map.size;
  }
}

function parseMsgType(raw: string): MessageContentType {
  const map: Record<string, MessageContentType> = {
    text: 'text',
    post: 'post',
    image: 'image',
    file: 'file',
    audio: 'audio',
    interactive: 'card',
    sticker: 'sticker',
    merge_forward: 'merge_forward',
  };
  return map[raw] ?? 'unknown';
}

/** 把飞书 im.message.receive_v1 的原始 data 转成 Message */
function parseMessage(data: Record<string, unknown>): Message {
  const msg = (data.message ?? {}) as Record<string, unknown>;
  const senderRaw = (data.sender ?? {}) as Record<string, unknown>;
  const senderId = (senderRaw.sender_id ?? {}) as Record<string, unknown>;

  const rawContent = (msg.content as string | undefined) ?? '';
  const msgType = (msg.message_type as string | undefined) ?? 'unknown';
  const mentionsRaw = (msg.mentions as Array<Record<string, unknown>> | undefined) ?? [];

  // 解析 mentions
  const mentions: Mention[] = mentionsRaw.map((m) => {
    const id = (m.id ?? {}) as Record<string, unknown>;
    const unionId = id.union_id as string | undefined;
    const name = m.name as string | undefined;
    const user: UserRef = {
      userId: (id.open_id as string | undefined) ?? '',
      ...(unionId !== undefined && { unionId }),
      ...(name !== undefined && { name }),
    };
    return { user, key: (m.key as string | undefined) ?? '' };
  });

  // 提取纯文本，剥离 @ 占位符
  let text = '';
  if (msgType === 'text') {
    try {
      const parsed = JSON.parse(rawContent) as { text?: string };
      text = parsed.text ?? rawContent;
    } catch {
      text = rawContent;
    }
    // 剥离 @ 占位符（形如 @_user_1）
    for (const m of mentions) {
      text = text.replaceAll(m.key, '').trim();
    }
  }

  const replyTo = (msg.parent_id as string | undefined) ?? undefined;
  const tsRaw = (msg.create_time as string | undefined) ?? '0';

  return {
    messageId: (msg.message_id as string | undefined) ?? '',
    chatId: (msg.chat_id as string | undefined) ?? '',
    chatType: (msg.chat_type as string | undefined) === 'p2p' ? 'p2p' : 'group',
    sender: {
      userId: (senderId.open_id as string | undefined) ?? '',
      ...((senderId.union_id as string | undefined) !== undefined && {
        unionId: senderId.union_id as string,
      }),
    },
    contentType: parseMsgType(msgType),
    text,
    rawContent,
    mentions,
    ...(replyTo !== undefined && { replyTo }),
    timestamp: Number(tsRaw),
  };
}

/**
 * 把 im.message.list / chat-history API 返回的 item 转为 Message。
 *
 * im.message.list 的 item 字段名跟 receive_v1 不同（content 在 body.content / sender.id
 * 直接挂 sender 上 / 等等），这里把它对齐到 parseMessage 期望的 receive_v1 形状。
 */
function parseListItem(item: Record<string, unknown>): Message {
  const sender = (item.sender as Record<string, unknown> | undefined) ?? {};
  const senderId = (sender.id as Record<string, unknown> | undefined) ?? {};
  return parseMessage({
    message: {
      message_id: item.message_id,
      chat_id: item.chat_id,
      chat_type: item.chat_type,
      message_type: item.message_type ?? item.msg_type,
      content: item.body ? (item.body as Record<string, unknown>).content : item.content,
      create_time: item.create_time,
      mentions: item.mentions ?? [],
      parent_id: item.parent_id,
    },
    sender: {
      sender_id: {
        open_id: senderId.open_id ?? (sender.id as string | undefined),
        union_id: senderId.union_id,
      },
    },
  });
}

function withMessageSource(
  msg: Message,
  source: 'ws' | 'backfill',
  extraMeta: Record<string, unknown> = {},
): Message {
  return {
    ...msg,
    meta: {
      ...(msg.meta ?? {}),
      ...extraMeta,
      source,
    },
  };
}

function parseCardAction(data: Record<string, unknown>): CardAction {
  const context = (data.context ?? {}) as Record<string, unknown>;
  const action = (data.action ?? {}) as Record<string, unknown>;
  const operator = (data.operator ?? {}) as Record<string, unknown>;
  const value = (action.value ?? {}) as Record<string, unknown>;
  const formValue = data.form_value as Record<string, unknown> | undefined;

  return {
    chatId:
      (context.open_chat_id as string | undefined) ??
      (data.open_chat_id as string | undefined) ??
      (data.chat_id as string | undefined) ??
      '',
    messageId:
      (context.open_message_id as string | undefined) ??
      (data.open_message_id as string | undefined) ??
      (data.message_id as string | undefined) ??
      '',
    user: {
      userId:
        (operator.open_id as string | undefined) ?? (data.open_id as string | undefined) ?? '',
      ...((operator.union_id as string | undefined) !== undefined && {
        unionId: operator.union_id as string,
      }),
      ...((operator.name as string | undefined) !== undefined && { name: operator.name as string }),
    },
    value,
    ...(formValue !== undefined && { formValue }),
    timestamp: Date.now(),
  };
}

// ─── LarkBotRuntime ────────────────────────────────────────────────────────────

export class LarkBotRuntime implements BotRuntime {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly tracker: QuotaTracker;
  private readonly limiter: RateLimiter;
  private readonly logger: Logger | undefined;
  private readonly handlers = new Set<EventHandler>();
  /** patchCard 节流：messageId → 上次 patch 完成的时间 */
  private readonly patchTimes = new Map<string, number>();

  // ─── issue #86: backfill 兜底（WSClient 长连接漏推消息时的轮询补救）
  /** 已经被 emit 过的 messageId（无论来源是 WS 还是 backfill），防止 backfill 重复 emit */
  private readonly seenMessageIds: LRUSet<string>;
  /** chatId → 该群最后已知消息时间戳（毫秒）；下次 backfill 用作 since 起点 */
  private readonly lastSeenAt = new Map<string, number>();
  private backfillTimer: NodeJS.Timeout | null = null;
  private readonly backfillIntervalMs: number;
  private readonly backfillPageSize: number;

  constructor(
    private readonly env: {
      appId: string;
      appSecret: string;
      verificationToken?: string;
      encryptKey?: string;
      logLevel?: lark.LoggerLevel;
      logger?: Logger;
      quotaTracker?: QuotaTracker;
      /** 测试 / 显式覆盖：默认从 env 读 BOT_BACKFILL_INTERVAL_MS / BOT_BACKFILL_PAGE_SIZE */
      backfillIntervalMs?: number;
      backfillPageSize?: number;
      seenIdsCapacity?: number;
    },
  ) {
    this.client = new lark.Client({
      appId: env.appId,
      appSecret: env.appSecret,
    });
    this.wsClient = new lark.WSClient({
      appId: env.appId,
      appSecret: env.appSecret,
      ...(env.logLevel !== undefined && { loggerLevel: env.logLevel }),
    });
    this.tracker = env.quotaTracker ?? globalQuotaTracker;
    this.limiter = new RateLimiter(this.tracker);
    this.logger = env.logger;
    this.backfillIntervalMs =
      env.backfillIntervalMs ?? (Number(process.env['BOT_BACKFILL_INTERVAL_MS']) || 30_000);
    this.backfillPageSize =
      env.backfillPageSize ?? (Number(process.env['BOT_BACKFILL_PAGE_SIZE']) || 20);
    this.seenMessageIds = new LRUSet<string>(env.seenIdsCapacity ?? 1000);
  }

  /** 暴露给测试 / 监控用，运行时可读取当前配额观测。 */
  getQuotaTracker(): QuotaTracker {
    return this.tracker;
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: BotEvent): void {
    for (const h of this.handlers) {
      void Promise.resolve(h(event)).catch((e) => {
        console.error('[BotRuntime] handler threw:', e);
      });
    }
  }

  async start(): Promise<Result<void>> {
    try {
      const dispatcher = new lark.EventDispatcher({
        verificationToken: this.env.verificationToken ?? '',
        encryptKey: this.env.encryptKey ?? '',
        ...(this.env.logLevel !== undefined && { loggerLevel: this.env.logLevel }),
      }).register({
        'im.message.receive_v1': async (data) => {
          const msg = withMessageSource(
            parseMessage(data as unknown as Record<string, unknown>),
            'ws',
          );
          this.markMessageSeen(msg);
          this.emit({ type: 'message', payload: msg });
          return { code: 0 };
        },
        'im.chat.member.bot.added_v1': async (data) => {
          const d = data as unknown as Record<string, unknown>;
          const operatorId = (d.operator_id ?? {}) as Record<string, unknown>;
          const chatId = (d.chat_id as string | undefined) ?? '';
          this.emit({
            type: 'botJoinedChat',
            payload: {
              chatId,
              inviter: {
                userId: (operatorId.open_id as string | undefined) ?? '',
                ...((operatorId.union_id as string | undefined) !== undefined && {
                  unionId: operatorId.union_id as string,
                }),
              },
              timestamp: Date.now(),
            },
          });
          // issue #86：bot 被拉进新群后 WS 长连接订阅集不会自动刷新，新群消息推不到
          // 客户端。立即触发一次 backfill，把这个新群的最近消息从 HTTP API 拉回来。
          // 不重连 WS（重连本身有丢事件窗口），只额外补一道 HTTP 兜底。
          if (chatId) {
            void this.backfillOnce().catch((e) => {
              this.logger?.warn('[BotRuntime] immediate backfill on bot-added failed', {
                chatId,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          }
          return { code: 0 };
        },
        p2p_chat_create: async (data) => {
          const d = data as unknown as Record<string, unknown>;
          const userId = (d.open_id as string | undefined) ?? '';
          this.emit({
            type: 'p2pChatCreated',
            payload: {
              chatId: (d.chat_id as string | undefined) ?? '',
              user: { userId },
              timestamp: Date.now(),
            },
          });
          return { code: 0 };
        },
        'card.action.trigger': async (data: unknown) => {
          const action = parseCardAction(data as unknown as Record<string, unknown>);
          this.emit({ type: 'cardAction', payload: action });
          return undefined;
        },
      });

      // WSClient.start() 是长期阻塞的，用 fire-and-forget 启动
      void this.wsClient.start({ eventDispatcher: dispatcher });
      // issue #86：开 backfill 兜底循环（WS 漏推时定时从 HTTP API 拉回来）
      this.startBackfillLoop();
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `WSClient start failed: ${msg}`, e));
    }
  }

  async stop(): Promise<void> {
    this.stopBackfillLoop();
    this.wsClient.close();
  }

  // ─── backfill (issue #86) ───────────────────────────────────────────────────

  /**
   * 标记某条消息已被 emit 过。WS 推 + backfill 拉都会调，避免后续 backfill 重复 emit。
   */
  private markMessageSeen(msg: Message): void {
    if (msg.messageId) this.seenMessageIds.add(msg.messageId);
    if (msg.chatId && msg.timestamp > 0) {
      const prev = this.lastSeenAt.get(msg.chatId) ?? 0;
      if (msg.timestamp > prev) this.lastSeenAt.set(msg.chatId, msg.timestamp);
    }
  }

  /**
   * 跑一次 backfill：列出 bot 所在的所有群，对每个群拉 lastSeenAt 之后的新消息，
   * emit 没在 seenMessageIds 里的。第一次见到某个群时进 seed 模式，只把现有消息的 id
   * 灌进去防止把历史消息当新消息 emit。
   *
   * 暴露为 public 是为了：1) 单元测试直接调；2) 在 bot 入群事件后立即触发一次。
   */
  async backfillOnce(): Promise<void> {
    let chats: Array<{ chat_id?: string }> = [];
    try {
      const res = await (
        this.client.im.chat as unknown as {
          list: (p: unknown) => Promise<{
            code?: number;
            msg?: string;
            data?: { items?: Array<{ chat_id?: string }>; has_more?: boolean };
          }>;
        }
      ).list({ params: { page_size: 100 } });
      if (res.code !== 0) {
        this.logger?.warn('[BotRuntime] backfill: chat.list failed', {
          code: res.code,
          msg: res.msg,
        });
        return;
      }
      chats = res.data?.items ?? [];
    } catch (e) {
      this.logger?.warn('[BotRuntime] backfill: chat.list threw', {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    for (const chat of chats) {
      const chatId = chat.chat_id;
      if (!chatId) continue;
      await this.backfillChat(chatId);
    }
  }

  private async backfillChat(chatId: string): Promise<void> {
    const since = this.lastSeenAt.get(chatId);
    // 第一次见这个群：seed 模式，把现有消息灌进 seenMessageIds，但不 emit
    const seedMode = since === undefined;

    let res: {
      code?: number;
      msg?: string;
      data?: { items?: Array<Record<string, unknown>>; has_more?: boolean };
    };
    try {
      await this.limiter.acquire();
      res = await (
        this.client.im.message as unknown as {
          list: (p: unknown) => Promise<typeof res>;
        }
      ).list({
        params: {
          container_id: chatId,
          container_id_type: 'chat',
          page_size: this.backfillPageSize,
          ...(since !== undefined && { start_time: String(Math.floor(since / 1000)) }),
          sort_type: 'ByCreateTimeAsc',
        },
      });
    } catch (e) {
      this.logger?.warn('[BotRuntime] backfill: message.list threw', {
        chatId,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (res.code !== 0) {
      this.logger?.warn('[BotRuntime] backfill: message.list failed', {
        chatId,
        code: res.code,
        msg: res.msg,
      });
      return;
    }

    const items = res.data?.items ?? [];
    let maxTs = since ?? 0;
    let emitted = 0;

    for (const item of items) {
      const messageId = item.message_id as string | undefined;
      if (!messageId) continue;
      if (this.seenMessageIds.has(messageId)) continue;

      let parsed: Message;
      try {
        const itemMessage = parseListItem(item);
        if (itemMessage.chatId && itemMessage.chatId !== chatId) {
          this.logger?.warn('[BotRuntime] backfill: item chatId mismatch, skip', {
            containerChatId: chatId,
            itemChatId: itemMessage.chatId,
            messageId,
          });
          continue;
        }
        parsed = withMessageSource(
          itemMessage.chatId ? itemMessage : { ...itemMessage, chatId },
          'backfill',
          { containerChatId: chatId },
        );
      } catch (e) {
        this.logger?.warn('[BotRuntime] backfill: parseListItem failed', {
          chatId,
          messageId,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      this.seenMessageIds.add(messageId);
      if (parsed.timestamp > maxTs) maxTs = parsed.timestamp;

      if (!seedMode) {
        this.emit({ type: 'message', payload: parsed });
        emitted += 1;
      }
    }

    // 即便 items 为空也要把 lastSeenAt 推进到"现在"，否则下次 seedMode 还会再触发一遍
    if (maxTs > 0) {
      this.lastSeenAt.set(chatId, maxTs);
    } else if (seedMode) {
      this.lastSeenAt.set(chatId, Date.now());
    }

    if (emitted > 0) {
      this.logger?.info('[BotRuntime] backfill recovered messages', { chatId, count: emitted });
    }
  }

  private startBackfillLoop(): void {
    if (this.backfillTimer) return;
    this.backfillTimer = setInterval(() => {
      void this.backfillOnce().catch((e) => {
        this.logger?.warn('[BotRuntime] backfill iteration failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, this.backfillIntervalMs);
    // 在 Node 里允许 process 在没有其它工作时仍然退出
    if (typeof this.backfillTimer.unref === 'function') this.backfillTimer.unref();
  }

  private stopBackfillLoop(): void {
    if (this.backfillTimer) {
      clearInterval(this.backfillTimer);
      this.backfillTimer = null;
    }
  }

  async sendText(params: SendTextParams): Promise<Result<SentMessage>> {
    await this.limiter.acquire();
    try {
      const content = JSON.stringify({ text: params.text });
      const res = await withRateLimitRetry(
        () =>
          params.replyTo
            ? this.client.im.message.reply({
                path: { message_id: params.replyTo! },
                data: { msg_type: 'text', content },
              })
            : this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: params.chatId, msg_type: 'text', content },
              }),
        { context: 'sendText', logger: this.logger, tracker: this.tracker },
      );

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `sendText failed: ${res.msg}`));
      }
      return ok({
        messageId: res.data?.message_id ?? '',
        chatId: params.chatId,
        timestamp: Date.now(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `sendText error: ${msg}`, e));
    }
  }

  async sendCard(params: SendCardParams): Promise<Result<SentMessage>> {
    await this.limiter.acquire();
    try {
      const content = JSON.stringify(params.card.content);
      const res = await withRateLimitRetry(
        () =>
          params.replyTo
            ? this.client.im.message.reply({
                path: { message_id: params.replyTo! },
                data: { msg_type: 'interactive', content },
              })
            : this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: params.chatId, msg_type: 'interactive', content },
              }),
        { context: 'sendCard', logger: this.logger, tracker: this.tracker },
      );

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `sendCard failed: ${res.msg}`));
      }
      return ok({
        messageId: res.data?.message_id ?? '',
        chatId: params.chatId,
        timestamp: Date.now(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `sendCard error: ${msg}`, e));
    }
  }

  async patchCard(params: PatchCardParams): Promise<Result<void>> {
    // 节流：同一条消息 0.5s 内不重复 patch
    const last = this.patchTimes.get(params.messageId) ?? 0;
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);

    await this.limiter.acquire();
    try {
      const res = await withRateLimitRetry(
        () =>
          this.client.im.message.patch({
            path: { message_id: params.messageId },
            data: { content: JSON.stringify(params.card.content) },
          }),
        { context: 'patchCard', logger: this.logger, tracker: this.tracker },
      );

      this.patchTimes.set(params.messageId, Date.now());

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `patchCard failed: ${res.msg}`));
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `patchCard error: ${msg}`, e));
    }
  }

  async fetchHistory(params: FetchHistoryParams): Promise<Result<FetchHistoryResult>> {
    await this.limiter.acquire();
    try {
      // 直接在 lambda 里 obj.method(...) 调用，避免摘下方法导致 this 丢失
      const res = await withRateLimitRetry(
        () =>
          (
            this.client.im.message as unknown as {
              list: (p: unknown) => Promise<{
                code?: number;
                msg?: string;
                data?: {
                  has_more?: boolean;
                  page_token?: string;
                  items?: Array<Record<string, unknown>>;
                };
              }>;
            }
          ).list({
            params: {
              container_id: params.chatId,
              container_id_type: 'chat',
              page_size: params.pageSize ?? 20,
              ...(params.pageToken && { page_token: params.pageToken }),
              ...(params.startTime && { start_time: String(Math.floor(params.startTime / 1000)) }),
              ...(params.endTime && { end_time: String(Math.floor(params.endTime / 1000)) }),
              sort_type: 'ByCreateTimeDesc',
            },
          }),
        { context: 'fetchHistory', logger: this.logger, tracker: this.tracker },
      );

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchHistory failed: ${res.msg}`));
      }

      const items = res.data?.items ?? [];
      const messages: Message[] = items.map((item) => parseListItem(item));

      const nextPageToken = res.data?.page_token;
      return ok({
        messages,
        hasMore: res.data?.has_more ?? false,
        ...(nextPageToken !== undefined && { nextPageToken }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchHistory error: ${msg}`, e));
    }
  }

  async fetchMessage(
    messageId: string,
  ): Promise<Result<{ readonly messages: readonly Message[] }>> {
    await this.limiter.acquire();
    try {
      // GET /open-apis/im/v1/messages/{message_id}
      // 返回值：data.items[] —— 普通消息只有 1 条；merge_forward 则父在前 + 全部嵌套子
      // 直接在 lambda 里 obj.method(...) 调用，避免摘下方法导致 this 丢失
      const res = await withRateLimitRetry(
        () =>
          (
            this.client.im.message as unknown as {
              get: (p: unknown) => Promise<{
                code?: number;
                msg?: string;
                data?: { items?: Array<Record<string, unknown>> };
              }>;
            }
          ).get({ path: { message_id: messageId } }),
        { context: 'fetchMessage', logger: this.logger, tracker: this.tracker },
      );

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchMessage failed: ${res.msg}`));
      }

      const items = res.data?.items ?? [];
      const messages: Message[] = items.map((item) => {
        const sender = (item['sender'] as Record<string, unknown> | undefined) ?? {};
        const senderId = (sender['id'] as Record<string, unknown> | undefined) ?? {};
        // sender.id 在这个 endpoint 是字符串 open_id，而不是 sender.id.open_id
        const senderOpenId =
          typeof sender['id'] === 'string'
            ? (sender['id'] as string)
            : (senderId['open_id'] as string | undefined);
        return parseMessage({
          message: {
            message_id: item['message_id'],
            chat_id: item['chat_id'],
            chat_type: item['chat_type'],
            message_type: item['msg_type'] ?? item['message_type'],
            content: item['body']
              ? (item['body'] as Record<string, unknown>)['content']
              : item['content'],
            create_time: item['create_time'],
            mentions: item['mentions'] ?? [],
            parent_id: item['parent_id'] ?? item['upper_message_id'],
          },
          sender: {
            sender_id: {
              open_id: senderOpenId,
              union_id: senderId['union_id'],
            },
          },
        });
      });

      return ok({ messages });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchMessage error: ${msg}`, e));
    }
  }

  async fetchMembers(params: FetchMembersParams): Promise<Result<FetchMembersResult>> {
    await this.limiter.acquire();
    try {
      const res = await withRateLimitRetry(
        () =>
          this.client.im.v1.chatMembers.get({
            path: { chat_id: params.chatId },
            params: { member_id_type: 'open_id', page_size: 100 },
          }),
        { context: 'fetchMembers', logger: this.logger, tracker: this.tracker },
      );

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchMembers failed: ${res.msg}`));
      }

      // 当前实现不分页：>100 人的群只返回前 100 个，下游授权/分工会静默截断。
      // 这里至少把信号暴露出来，调用方按需决定是否提示用户。后续 follow-up：分页循环。
      const items = res.data?.items ?? [];
      if (res.data?.has_more) {
        console.warn(
          `[bot-runtime] fetchMembers: chat ${params.chatId} has more than 100 members, only the first ${items.length} are returned`,
        );
      }

      return ok({
        members: items.map((item) => ({
          userId: item.member_id ?? '',
          name: item.name ?? item.member_id ?? '未知成员',
        })),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchMembers error: ${msg}`, e));
    }
  }

  async pinMessage(chatId: string, messageId: string): Promise<Result<void>> {
    await this.limiter.acquire();
    try {
      const res = await withRateLimitRetry(
        () =>
          (
            this.client.im.v1 as unknown as {
              chatTopNotice: {
                putTopNotice: (p: unknown) => Promise<{ code?: number; msg?: string }>;
              };
            }
          ).chatTopNotice.putTopNotice({
            path: { chat_id: chatId },
            data: {
              chat_top_notice: [{ action_type: '1', message_id: messageId }],
            },
          }),
        { context: 'pinMessage', logger: this.logger, tracker: this.tracker },
      );
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `pinMessage failed: ${res.msg}`));
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `pinMessage error: ${msg}`, e));
    }
  }
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createBotRuntime(opts: { logger?: Logger } = {}): LarkBotRuntime {
  const appId = process.env['LARK_APP_ID'];
  const appSecret = process.env['LARK_APP_SECRET'];
  if (!appId) throw new Error('Missing env var: LARK_APP_ID');
  if (!appSecret) throw new Error('Missing env var: LARK_APP_SECRET');

  const logLevelMap: Record<string, lark.LoggerLevel> = {
    debug: lark.LoggerLevel.debug,
    info: lark.LoggerLevel.info,
    warn: lark.LoggerLevel.warn,
    error: lark.LoggerLevel.error,
  };

  return new LarkBotRuntime({
    appId,
    appSecret,
    verificationToken: process.env['LARK_VERIFICATION_TOKEN'] ?? '',
    encryptKey: process.env['LARK_ENCRYPT_KEY'] ?? '',
    logLevel:
      logLevelMap[(process.env['LARK_LOG_LEVEL'] ?? 'info').toLowerCase()] ?? lark.LoggerLevel.info,
    ...(opts.logger !== undefined && { logger: opts.logger }),
  });
}
