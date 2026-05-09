import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LarkBotRuntime } from '../bot-runtime.js';
import type { EventHandler, Card } from '@seedhac/contracts';

// ─── SDK mock ────────────────────────────────────────────────────────────────

const mockMessageCreate = vi.fn();
const mockMessageReply = vi.fn();
const mockMessagePatch = vi.fn();
const mockMessageList = vi.fn();
const mockChatList = vi.fn();
const mockChatMembersGet = vi.fn();
const mockWsStart = vi.fn();
const mockWsClose = vi.fn();
const mockRegister = vi.fn();
const mockDispatcherInstance = { register: mockRegister };

mockRegister.mockReturnValue(mockDispatcherInstance);

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: vi.fn(function () {
      return {
        im: {
          message: {
            create: mockMessageCreate,
            reply: mockMessageReply,
            patch: mockMessagePatch,
            list: mockMessageList,
          },
          chat: {
            list: mockChatList,
          },
          v1: {
            chatMembers: {
              get: mockChatMembersGet,
            },
          },
        },
      };
    }),
    WSClient: vi.fn(function () {
      return { start: mockWsStart, close: mockWsClose };
    }),
    EventDispatcher: vi.fn(function () {
      return mockDispatcherInstance;
    }),
    LoggerLevel: { debug: 0, info: 1, warn: 2, error: 3 },
  };
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRuntime(): LarkBotRuntime {
  return new LarkBotRuntime({ appId: 'app_id', appSecret: 'app_secret' });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('LarkBotRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockReturnValue(mockDispatcherInstance);
    mockWsStart.mockResolvedValue(undefined);
  });

  // 1. message 事件 → handler 被调用，payload 字段正确
  it('message event triggers handler with correct payload', async () => {
    const runtime = makeRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);
    await runtime.start();

    // 取出 EventDispatcher.register() 收到的 handlers map
    const registeredHandlers = mockRegister.mock.calls[0]![0] as Record<
      string,
      (data: unknown) => Promise<unknown>
    >;
    const receiveHandler = registeredHandlers['im.message.receive_v1']!;

    await receiveHandler({
      sender: { sender_id: { open_id: 'ou_abc', union_id: 'uid_1' } },
      message: {
        message_id: 'msg_1',
        chat_id: 'oc_chat1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello @_user_1' }),
        create_time: '1700000000000',
        mentions: [{ id: { open_id: 'ou_bot' }, name: 'Lark Loom', key: '@_user_1' }],
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    const event = (handler as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(event.type).toBe('message');
    expect(event.payload.chatId).toBe('oc_chat1');
    expect(event.payload.sender.userId).toBe('ou_abc');
    expect(event.payload.text).toBe('hello'); // @ 占位符被剥离
    expect(event.payload.meta?.source).toBe('ws');
    expect(event.payload.mentions).toHaveLength(1);
    expect(event.payload.mentions[0].key).toBe('@_user_1');
  });

  // 2. sendText → SDK create 被调用一次，参数正确
  it('sendText calls SDK create with correct params', async () => {
    mockMessageCreate.mockResolvedValue({ code: 0, data: { message_id: 'msg_2' } });
    const runtime = makeRuntime();

    const result = await runtime.sendText({ chatId: 'oc_chat1', text: '你好' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toBe('msg_2');
      expect(result.value.chatId).toBe('oc_chat1');
    }
    expect(mockMessageCreate).toHaveBeenCalledOnce();
    const callArgs = mockMessageCreate.mock.calls[0]![0];
    expect(callArgs.params.receive_id_type).toBe('chat_id');
    expect(callArgs.data.msg_type).toBe('text');
    expect(JSON.parse(callArgs.data.content)).toEqual({ text: '你好' });
  });

  // 3. sendCard → SDK create 被调用，msg_type = 'interactive'
  it('sendCard calls SDK create with msg_type interactive', async () => {
    mockMessageCreate.mockResolvedValue({ code: 0, data: { message_id: 'msg_3' } });
    const runtime = makeRuntime();
    const card = {
      templateName: 'slides',
      content: { schema: '2.0', header: { title: { tag: 'plain_text', content: 'test' } } },
    } as unknown as Card;

    const result = await runtime.sendCard({ chatId: 'oc_chat1', card });

    expect(result.ok).toBe(true);
    expect(mockMessageCreate).toHaveBeenCalledOnce();
    const callArgs = mockMessageCreate.mock.calls[0]![0];
    expect(callArgs.data.msg_type).toBe('interactive');
    expect(JSON.parse(callArgs.data.content)).toEqual(card.content);
    expect(JSON.parse(callArgs.data.content)).not.toHaveProperty('templateName');
  });

  // 4. fetchHistory → 返回正确的 FetchHistoryResult
  it('fetchHistory returns mapped messages', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            message_id: 'msg_h1',
            chat_id: 'oc_chat1',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '历史消息' }),
            create_time: '1700000001000',
            sender_id: 'ou_user1',
            mentions: [],
          },
        ],
      },
    });

    const runtime = makeRuntime();
    const result = await runtime.fetchHistory({ chatId: 'oc_chat1', pageSize: 20 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages).toHaveLength(1);
      expect(result.value.messages[0]!.messageId).toBe('msg_h1');
      expect(result.value.messages[0]!.text).toBe('历史消息');
      expect(result.value.hasMore).toBe(false);
    }
  });

  it('fetchMembers returns mapped chat members', async () => {
    mockChatMembersGet.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { member_id: 'ou_1', name: '张三' },
          { member_id: 'ou_2', name: '李四' },
        ],
      },
    });

    const runtime = makeRuntime();
    const result = await runtime.fetchMembers({ chatId: 'oc_chat1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.members).toEqual([
        { userId: 'ou_1', name: '张三' },
        { userId: 'ou_2', name: '李四' },
      ]);
    }
    expect(mockChatMembersGet).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { chat_id: 'oc_chat1' },
        params: expect.objectContaining({ member_id_type: 'open_id' }),
      }),
    );
  });

  // 5. SDK 报错 → sendText 返回 err，不抛异常
  it('sendText returns err when SDK throws', async () => {
    mockMessageCreate.mockRejectedValue(new Error('network error'));
    const runtime = makeRuntime();

    const result = await runtime.sendText({ chatId: 'oc_chat1', text: 'hi' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FEISHU_API_ERROR');
      expect(result.error.message).toContain('network error');
    }
  });

  // 6. patchCard 同一 messageId 连续调用，第二次等待 >= 500ms
  it('patchCard throttles to 500ms per messageId', async () => {
    mockMessagePatch.mockResolvedValue({ code: 0 });
    const runtime = makeRuntime();
    const card = {
      templateName: 'slides',
      content: { schema: '2.0', body: { elements: [] } },
    } as unknown as Card;

    const t0 = Date.now();
    await runtime.patchCard({ messageId: 'msg_p1', card });
    await runtime.patchCard({ messageId: 'msg_p1', card });
    const elapsed = Date.now() - t0;

    expect(mockMessagePatch).toHaveBeenCalledTimes(2);
    const callArgs = mockMessagePatch.mock.calls[0]![0];
    expect(JSON.parse(callArgs.data.content)).toEqual(card.content);
    expect(elapsed).toBeGreaterThanOrEqual(490); // 留 10ms 误差
  });

  // 7. on() 返回的 unregister 函数能取消监听
  it('on() unregister stops handler from receiving events', async () => {
    const runtime = makeRuntime();
    const handler: EventHandler = vi.fn();
    const unregister = runtime.on(handler);
    await runtime.start();

    const registeredHandlers = mockRegister.mock.calls[0]![0] as Record<
      string,
      (data: unknown) => Promise<unknown>
    >;
    const receiveHandler = registeredHandlers['im.message.receive_v1']!;

    unregister();

    await receiveHandler({
      sender: { sender_id: { open_id: 'ou_x' } },
      message: {
        message_id: 'msg_x',
        chat_id: 'oc_x',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'test' }),
        create_time: '1700000002000',
        mentions: [],
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  // 回归：fetchHistory / fetchMessage 不能把 SDK 方法摘下来调用，否则丢 `this`
  // 触发 TypeError（PR #97 review 抓到的真 bug）。这里用一个 strict-this mock 检查。
  it('fetchHistory preserves `this` binding when calling SDK list', async () => {
    const observed: { value: unknown } = { value: undefined };
    mockMessageList.mockImplementation(function (this: unknown, _arg: unknown) {
      observed.value = this;
      return Promise.resolve({ code: 0, data: { has_more: false, items: [] } });
    });

    const runtime = makeRuntime();
    const result = await runtime.fetchHistory({ chatId: 'oc_chat1' });

    expect(result.ok).toBe(true);
    // strict mode 下 `this` 丢失会是 undefined；正确绑定时是 mock 所在的对象
    expect(observed.value).not.toBeUndefined();
    expect(observed.value).not.toBeNull();
  });

  it('fetchMessage preserves `this` binding when calling SDK get', async () => {
    const mockGet = vi.fn();
    const observed: { value: unknown } = { value: undefined };
    mockGet.mockImplementation(function (this: unknown, _arg: unknown) {
      observed.value = this;
      return Promise.resolve({ code: 0, data: { items: [] } });
    });
    // im.message.get 没在顶层 mock 里 —— 直接给 client 临时挂上
    const runtime = makeRuntime();
    (runtime as unknown as { client: { im: { message: Record<string, unknown> } } }).client.im.message.get =
      mockGet;

    const result = await runtime.fetchMessage('msg_1');

    expect(result.ok).toBe(true);
    expect(observed.value).not.toBeUndefined();
    expect(observed.value).not.toBeNull();
  });

  // 8. 撞 99991400 → 自动 retry 一次 → 成功（issue #91 Layer A 集成）
  it('sendText auto-retries once on feishu rate limit code 99991400', async () => {
    mockMessageCreate
      .mockResolvedValueOnce({ code: 99991400, msg: 'rate limit' })
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'msg_after_retry' } });
    const runtime = makeRuntime();
    // recordRateLimited 是同步副作用 —— 在 sleep 之前打的标记，spy 进去而不走真实时间
    const tracker = runtime.getQuotaTracker();
    const recordSpy = vi.spyOn(tracker, 'recordRateLimited');

    const result = await runtime.sendText({ chatId: 'oc_chat1', text: '撞限流' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe('msg_after_retry');
    expect(mockMessageCreate).toHaveBeenCalledTimes(2);
    expect(recordSpy).toHaveBeenCalledOnce(); // QuotaTracker 被标记过节流
  });

  it('card action event triggers handler with action payload', async () => {
    const runtime = makeRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);
    await runtime.start();

    const registeredHandlers = mockRegister.mock.calls[0]![0] as Record<
      string,
      (data: unknown) => Promise<unknown>
    >;
    const actionHandler = registeredHandlers['card.action.trigger']!;

    await actionHandler({
      context: { open_message_id: 'om_card1', open_chat_id: 'oc_chat1' },
      operator: { open_id: 'ou_user1', name: '张三' },
      action: {
        tag: 'button',
        value: { action: 'qa.reanswer', questionMessageId: 'msg_1' },
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    const event = (handler as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(event.type).toBe('cardAction');
    expect(event.payload.chatId).toBe('oc_chat1');
    expect(event.payload.messageId).toBe('om_card1');
    expect(event.payload.user.userId).toBe('ou_user1');
    expect(event.payload.value).toEqual({ action: 'qa.reanswer', questionMessageId: 'msg_1' });
    await expect(actionHandler({})).resolves.toBeUndefined();
  });
});

// ─── issue #86: backfill 兜底 ────────────────────────────────────────────────

import { LRUSet, LarkBotRuntime as Runtime } from '../bot-runtime.js';

describe('LRUSet', () => {
  it('refreshes recency on re-add and evicts oldest at capacity', () => {
    const s = new LRUSet<string>(3);
    expect(s.add('a')).toBe(true);
    expect(s.add('b')).toBe(true);
    expect(s.add('c')).toBe(true);
    expect(s.size()).toBe(3);
    // re-add 'a' 刷新它的位置，下次淘汰应该淘汰 'b'
    expect(s.add('a')).toBe(false);
    expect(s.add('d')).toBe(true);
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
    expect(s.has('c')).toBe(true);
    expect(s.has('d')).toBe(true);
  });

  it('throws when capacity <= 0', () => {
    expect(() => new LRUSet(0)).toThrow();
  });
});

describe('LarkBotRuntime.backfillOnce()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockReturnValue(mockDispatcherInstance);
    mockWsStart.mockResolvedValue(undefined);
  });

  function makeBackfillRuntime(): Runtime {
    return new Runtime({
      appId: 'app_id',
      appSecret: 'app_secret',
      backfillIntervalMs: 999_999, // 不让定时器在测试里自动跑
      backfillPageSize: 10,
    });
  }

  function listItem(id: string, chatId: string, ts: number, text = 'hi'): Record<string, unknown> {
    return {
      message_id: id,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      body: { content: JSON.stringify({ text }) },
      create_time: String(ts),
      mentions: [],
      sender: { id: { open_id: 'ou_x', union_id: 'uid_x' } },
    };
  }

  it('seed mode on first sight: populates seenIds + lastSeenAt but does NOT emit', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);

    mockChatList.mockResolvedValue({
      code: 0,
      data: { items: [{ chat_id: 'oc_old' }] },
    });
    mockMessageList.mockResolvedValue({
      code: 0,
      data: { items: [listItem('msg_old_1', 'oc_old', 1700000000000)] },
    });

    await runtime.backfillOnce();

    expect(handler).not.toHaveBeenCalled();
    // 第二次拉同群应当带上 since（lastSeenAt 已写入）
    mockMessageList.mockClear();
    mockMessageList.mockResolvedValue({ code: 0, data: { items: [] } });
    await runtime.backfillOnce();
    const params = mockMessageList.mock.calls[0]![0].params;
    expect(params.start_time).toBeDefined();
  });

  it('emits messages in subsequent runs that are not in seenIds', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);

    // seed
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_a' }] },
    });
    mockMessageList.mockResolvedValueOnce({ code: 0, data: { items: [] } });
    await runtime.backfillOnce();
    expect(handler).not.toHaveBeenCalled();

    // 第二次：返回 2 条新消息
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_a' }] },
    });
    mockMessageList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          listItem('msg_1', 'oc_a', 1700000001000, 'one'),
          listItem('msg_2', 'oc_a', 1700000002000, 'two'),
        ],
      },
    });
    await runtime.backfillOnce();

    expect(handler).toHaveBeenCalledTimes(2);
    const ids = (handler as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { payload: { messageId: string } }).payload.messageId,
    );
    expect(ids).toEqual(['msg_1', 'msg_2']);
    const event = (handler as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      payload: { meta?: Record<string, unknown> };
    };
    expect(event.payload.meta?.source).toBe('backfill');
    expect(event.payload.meta?.containerChatId).toBe('oc_a');
  });

  it('backfill falls back to container chatId when list item omits chat_id', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);

    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_container' }] },
    });
    mockMessageList.mockResolvedValueOnce({ code: 0, data: { items: [] } });
    await runtime.backfillOnce();

    const item = listItem('msg_missing_chat', 'oc_container', 1700000001000);
    delete item['chat_id'];
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_container' }] },
    });
    mockMessageList.mockResolvedValueOnce({ code: 0, data: { items: [item] } });
    await runtime.backfillOnce();

    expect(handler).toHaveBeenCalledOnce();
    const event = (handler as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      payload: { chatId: string; meta?: Record<string, unknown> };
    };
    expect(event.payload.chatId).toBe('oc_container');
    expect(event.payload.meta?.source).toBe('backfill');
  });

  it('does NOT re-emit messages already pushed via WS', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);
    await runtime.start();

    // WS 推一条
    const registered = mockRegister.mock.calls[0]![0] as Record<
      string,
      (data: unknown) => Promise<unknown>
    >;
    await registered['im.message.receive_v1']!({
      sender: { sender_id: { open_id: 'ou_x' } },
      message: {
        message_id: 'msg_ws',
        chat_id: 'oc_ws',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'from ws' }),
        create_time: '1700000005000',
        mentions: [],
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    (handler as ReturnType<typeof vi.fn>).mockClear();

    // backfill 返回同一条消息 + 一条新的
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_ws' }] },
    });
    mockMessageList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          listItem('msg_ws', 'oc_ws', 1700000005000, 'from ws'),
          listItem('msg_new', 'oc_ws', 1700000006000, 'new one'),
        ],
      },
    });
    await runtime.backfillOnce();

    // 只有 msg_new 被 emit
    expect(handler).toHaveBeenCalledTimes(1);
    const event = (handler as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      payload: { messageId: string };
    };
    expect(event.payload.messageId).toBe('msg_new');

    await runtime.stop();
  });

  it('continues when one chat fails: other chats still backfill', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);

    // 把 oc_a seed 过了；oc_b 是新群
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_a' }] },
    });
    mockMessageList.mockResolvedValueOnce({ code: 0, data: { items: [] } });
    await runtime.backfillOnce();

    // 第二次：oc_a 成功（有 1 条新），oc_b 失败
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_a' }, { chat_id: 'oc_b' }] },
    });
    mockMessageList
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [listItem('msg_a1', 'oc_a', 1700000001000)] },
      })
      .mockResolvedValueOnce({ code: 99991401, msg: 'rate limited' });
    await runtime.backfillOnce();

    // oc_a 那条成功 emit，oc_b 失败但不阻断
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('chat.list failure aborts iteration but does not throw', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);

    mockChatList.mockResolvedValueOnce({ code: 99991401, msg: 'rate limited' });

    await expect(runtime.backfillOnce()).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(mockMessageList).not.toHaveBeenCalled();
  });

  it('bot-added event triggers immediate backfill', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);
    await runtime.start();

    mockChatList.mockResolvedValue({ code: 0, data: { items: [{ chat_id: 'oc_new' }] } });
    mockMessageList.mockResolvedValue({
      code: 0,
      data: { items: [listItem('msg_seed', 'oc_new', 1700000000000)] },
    });

    const registered = mockRegister.mock.calls[0]![0] as Record<
      string,
      (data: unknown) => Promise<unknown>
    >;
    await registered['im.chat.member.bot.added_v1']!({
      chat_id: 'oc_new',
      operator_id: { open_id: 'ou_inviter' },
    });

    // 让 fire-and-forget 的 backfillOnce 跑完
    await new Promise((r) => setTimeout(r, 0));

    // botJoinedChat 事件 emit 1 次（同步）；backfill seed 模式不再 emit
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockChatList).toHaveBeenCalled();

    await runtime.stop();
  });

  it('integration: seed [old, new], second run discovers 2 backfill messages in new chat (no dupe with WS)', async () => {
    const runtime = makeBackfillRuntime();
    const handler: EventHandler = vi.fn();
    runtime.on(handler);
    await runtime.start();

    // seed：两个群都已知，无新消息
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_old' }, { chat_id: 'oc_new' }] },
    });
    mockMessageList
      .mockResolvedValueOnce({ code: 0, data: { items: [] } })
      .mockResolvedValueOnce({ code: 0, data: { items: [] } });
    await runtime.backfillOnce();
    expect(handler).not.toHaveBeenCalled();

    // 模拟 WS 推一条 oc_old 的消息（已被 seen 标记）
    const registered = mockRegister.mock.calls[0]![0] as Record<
      string,
      (data: unknown) => Promise<unknown>
    >;
    await registered['im.message.receive_v1']!({
      sender: { sender_id: { open_id: 'ou_old' } },
      message: {
        message_id: 'msg_ws_dup',
        chat_id: 'oc_old',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'old via ws' }),
        create_time: '1700000010000',
        mentions: [],
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);

    // 第二次 backfill：oc_old 拉到 ws 那条 + 1 条更新的；oc_new 拉到 2 条新
    mockChatList.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_old' }, { chat_id: 'oc_new' }] },
    });
    mockMessageList
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            listItem('msg_ws_dup', 'oc_old', 1700000010000),
            listItem('msg_old_new', 'oc_old', 1700000011000),
          ],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            listItem('msg_new_1', 'oc_new', 1700000012000),
            listItem('msg_new_2', 'oc_new', 1700000013000),
          ],
        },
      });
    await runtime.backfillOnce();

    // 期望：handler 总共被调 4 次：
    //   1 次 WS 推（msg_ws_dup） + 0 次 dupe + 1 次 msg_old_new + 2 次 msg_new_*
    expect(handler).toHaveBeenCalledTimes(4);
    const ids = (handler as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { payload: { messageId: string } }).payload.messageId,
    );
    expect(ids).toEqual(['msg_ws_dup', 'msg_old_new', 'msg_new_1', 'msg_new_2']);

    await runtime.stop();
  });
});
