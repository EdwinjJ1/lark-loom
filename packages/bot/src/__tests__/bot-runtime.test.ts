import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LarkBotRuntime } from '../bot-runtime.js';
import type { EventHandler, Card } from '@seedhac/contracts';

// ─── SDK mock ────────────────────────────────────────────────────────────────

const mockMessageCreate = vi.fn();
const mockMessageReply = vi.fn();
const mockMessagePatch = vi.fn();
const mockMessageList = vi.fn();
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
