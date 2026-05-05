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

// ─── 限流器：100 req/min + 5 req/sec ─────────────────────────────────────────

class RateLimiter {
  private secTokens = 5;
  private minTokens = 100;
  private lastSec = Date.now();
  private lastMin = Date.now();
  private readonly queue: Array<() => void> = [];
  private processing = false;

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
    this.secTokens = Math.min(5, this.secTokens + ((now - this.lastSec) / 1000) * 5);
    this.lastSec = now;
    this.minTokens = Math.min(100, this.minTokens + ((now - this.lastMin) / 60000) * 100);
    this.lastMin = now;
  }
}

// ─── 工具 ──────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  private readonly limiter = new RateLimiter();
  private readonly handlers = new Set<EventHandler>();
  /** patchCard 节流：messageId → 上次 patch 完成的时间 */
  private readonly patchTimes = new Map<string, number>();

  constructor(
    private readonly env: {
      appId: string;
      appSecret: string;
      verificationToken?: string;
      encryptKey?: string;
      logLevel?: lark.LoggerLevel;
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
          const msg = parseMessage(data as unknown as Record<string, unknown>);
          this.emit({ type: 'message', payload: msg });
          return { code: 0 };
        },
        'im.chat.member.bot.added_v1': async (data) => {
          const d = data as unknown as Record<string, unknown>;
          const operatorId = (d.operator_id ?? {}) as Record<string, unknown>;
          this.emit({
            type: 'botJoinedChat',
            payload: {
              chatId: (d.chat_id as string | undefined) ?? '',
              inviter: {
                userId: (operatorId.open_id as string | undefined) ?? '',
                ...((operatorId.union_id as string | undefined) !== undefined && {
                  unionId: operatorId.union_id as string,
                }),
              },
              timestamp: Date.now(),
            },
          });
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
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `WSClient start failed: ${msg}`, e));
    }
  }

  async stop(): Promise<void> {
    this.wsClient.close();
  }

  async sendText(params: SendTextParams): Promise<Result<SentMessage>> {
    await this.limiter.acquire();
    try {
      const content = JSON.stringify({ text: params.text });
      const res = params.replyTo
        ? await this.client.im.message.reply({
            path: { message_id: params.replyTo },
            data: { msg_type: 'text', content },
          })
        : await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: params.chatId, msg_type: 'text', content },
          });

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
      const res = params.replyTo
        ? await this.client.im.message.reply({
            path: { message_id: params.replyTo },
            data: { msg_type: 'interactive', content },
          })
        : await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: params.chatId, msg_type: 'interactive', content },
          });

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
      const res = await this.client.im.message.patch({
        path: { message_id: params.messageId },
        data: { content: JSON.stringify(params.card.content) },
      });

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
      const res = await (
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
      });

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `fetchHistory failed: ${res.msg}`));
      }

      const items = res.data?.items ?? [];
      const messages: Message[] = items.map((item) => {
        // im.message.list 的 item 字段名与 receive_v1 不同，手动对齐
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
      });

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
      const res = await (
        this.client.im.message as unknown as {
          get: (p: unknown) => Promise<{
            code?: number;
            msg?: string;
            data?: { items?: Array<Record<string, unknown>> };
          }>;
        }
      ).get({ path: { message_id: messageId } });

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
      const res = await this.client.im.v1.chatMembers.get({
        path: { chat_id: params.chatId },
        params: { member_id_type: 'open_id', page_size: 100 },
      });

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
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createBotRuntime(): LarkBotRuntime {
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
  });
}
