import { describe, it, expect, vi, beforeEach } from 'vitest';
import { qaSkill } from '@seedhac/skills';
import { err, makeError, ErrorCode, ok } from '@seedhac/contracts';
import type {
  BotEvent,
  BotRuntime,
  Message,
  Skill,
  SkillContext,
  SkillName,
} from '@seedhac/contracts';
import { SkillRouter } from '../skill-router.js';
import { handleEvent, type HarnessConfig } from '../wiring.js';
import { NullMemoryStore } from '../memory/memory-store.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const BOT_ID = 'ou_bot_123';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'msg_1',
    chatId: 'oc_chat1',
    chatType: 'group',
    sender: { userId: 'ou_user1' },
    contentType: 'text',
    text: '这个怎么用？',
    rawContent: '',
    mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEvent(msg: Message): BotEvent {
  return { type: 'message', payload: msg };
}

function makeRuntime(): BotRuntime {
  return {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(ok({ messageId: 'r1', chatId: 'oc_chat1', timestamp: 0 })),
    sendCard: vi.fn().mockResolvedValue(ok({ messageId: 'r2', chatId: 'oc_chat1', timestamp: 0 })),
    patchCard: vi.fn().mockResolvedValue(ok(undefined)),
    fetchHistory: vi.fn().mockResolvedValue(ok({ messages: [], hasMore: false })),
  } as unknown as BotRuntime;
}

function makeCtx(event: BotEvent, runtimeOverride?: BotRuntime): SkillContext {
  return {
    event,
    runtime: runtimeOverride ?? makeRuntime(),
    llm: {
      ask: vi.fn().mockResolvedValue(ok('这是测试回答。')),
      chat: vi.fn(),
      askStructured: vi.fn(),
      chatWithTools: vi.fn(),
    } as unknown as SkillContext['llm'],
    bitable: {} as SkillContext['bitable'],
    docx: {} as SkillContext['docx'],
    slides: {} as NonNullable<SkillContext['slides']>,
    cardBuilder: {
      build: vi.fn().mockReturnValue({ templateName: 'qa', content: { built: true } }),
    } as unknown as SkillContext['cardBuilder'],
    retrievers: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function makeHarness(): HarnessConfig {
  return {
    promptCache: {
      build: vi.fn().mockReturnValue('system prompt'),
      getOverviewText: vi.fn().mockReturnValue('overview full text'),
    } as unknown as HarnessConfig['promptCache'],
    memoryStore: new NullMemoryStore(),
    docsRoot: '/fake/docs/bot-memory',
    botOpenId: BOT_ID,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('qaSkill.match()', () => {
  beforeEach(() => {
    process.env['LARK_BOT_OPEN_ID'] = BOT_ID;
  });

  // 1. @bot 但没有疑问意图 → match() 返回 false
  it('@bot without question intent → returns false', () => {
    const msg = makeMessage({
      text: '帮我查一下上周的会议记录',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg));
    expect(qaSkill.match(ctx)).toBe(false);
  });

  // 2. 无 @mention → match() 返回 false
  it('no @mention → returns false', () => {
    const msg = makeMessage({ text: '这个功能怎么用？', mentions: [] });
    const ctx = makeCtx(makeEvent(msg));
    expect(qaSkill.match(ctx)).toBe(false);
  });
});

describe('handleEvent wiring', () => {
  const router = new SkillRouter(BOT_ID);

  beforeEach(() => {
    process.env['LARK_BOT_OPEN_ID'] = BOT_ID;
  });

  // 3. @bot + 问号 → 路由到 qa → run() 被调用，sendCard 被调用
  it('@bot + ? → qaSkill.run() is called and card response is sent', async () => {
    const runSpy = vi.spyOn(qaSkill, 'run');
    // Provide a history message that bigram-matches "这是什么？" so the skill
    // doesn't bail early with "找不到相关记录".
    const runtime = {
      ...makeRuntime(),
      fetchHistory: vi.fn().mockResolvedValue(
        ok({
          messages: [
            makeMessage({
              messageId: 'hist_1',
              text: '这是飞书的问答功能',
              sender: { userId: 'ou_other' },
            }),
          ],
          hasMore: false,
        }),
      ),
    } as unknown as BotRuntime;
    const msg = makeMessage({
      text: '这是什么？',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg), runtime);

    await handleEvent(ctx, router, { qa: qaSkill } as Partial<Record<SkillName, Skill>> as Record<
      SkillName,
      Skill
    >);

    expect(runSpy).toHaveBeenCalledOnce();
    expect(runtime.sendCard).toHaveBeenCalledOnce();
    expect(runtime.sendText).not.toHaveBeenCalled();
  });

  // 4. intent 无映射（taskAssignment）→ 不触发任何 skill
  it('intent with no skill mapping → run() not called', async () => {
    const mockSkill: Skill = {
      ...qaSkill,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ text: 'x' })),
    };
    // 分工讨论触发 taskAssignment，intentToSkill 无 taskAssignment 映射
    const msg = makeMessage({ text: '张三负责前端，李四负责后端', mentions: [] });
    const ctx = makeCtx(makeEvent(msg));

    await handleEvent(ctx, router, { qa: mockSkill } as unknown as Record<SkillName, Skill>);

    expect(mockSkill.run).not.toHaveBeenCalled();
  });

  // 5. skill.run() 返回 err → 不 crash，logger.error 被调用
  it('skill.run() returns err → no crash, logger.error called', async () => {
    const failSkill: Skill = {
      ...qaSkill,
      match: () => true,
      run: vi.fn().mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'boom'))),
    };
    const runtime = makeRuntime();
    const msg = makeMessage({
      text: '这是什么？',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg), runtime);

    await expect(
      handleEvent(ctx, router, { qa: failSkill } as unknown as Record<SkillName, Skill>),
    ).resolves.toBeUndefined();

    expect(ctx.logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(runtime.sendText).not.toHaveBeenCalled();
  });

  it('sendCard returns err → logs and does not report success', async () => {
    const failRuntime = {
      ...makeRuntime(),
      sendCard: vi.fn().mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'bad card'))),
    } as unknown as BotRuntime;
    const cardSkill: Skill = {
      ...qaSkill,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ card: { templateName: 'qa', content: {} } })),
    };
    const msg = makeMessage({
      text: '这是什么？',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg), failRuntime);

    await handleEvent(ctx, router, { qa: cardSkill } as unknown as Record<SkillName, Skill>);

    expect(failRuntime.sendCard).toHaveBeenCalledOnce();
    expect(ctx.logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'send card failed',
      expect.objectContaining({ code: ErrorCode.FEISHU_API_ERROR }),
    );
    expect(ctx.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('replied'));
  });

  it('writes skill_log and qa chat memory after successful skill run', async () => {
    const memoryStore = {
      read: vi.fn(),
      search: vi.fn(),
      list: vi.fn(),
      write: vi.fn().mockResolvedValue(ok({})),
      delete: vi.fn(),
      score: vi.fn(),
    };
    const runtime = makeRuntime();
    const skill: Skill = {
      ...qaSkill,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ text: 'answer', reasoning: 'answered from context' })),
    };
    const msg = makeMessage({
      text: '这是什么？',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx: SkillContext = {
      ...makeCtx(makeEvent(msg), runtime),
      memoryStore,
    } as unknown as SkillContext;

    await handleEvent(ctx, router, { qa: skill } as unknown as Record<SkillName, Skill>);
    await vi.waitFor(() => expect(memoryStore.write).toHaveBeenCalledTimes(2));

    // skill_log + chat 并行写入；不显式传 importance（让 store 异步 LLM 评分）。
    const writeKinds = memoryStore.write.mock.calls.map(
      (call) => (call[0] as { kind: string }).kind,
    );
    expect(writeKinds.sort()).toEqual(['chat', 'skill_log']);
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'skill_log', source_skill: 'qa' }),
    );
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat', source_skill: 'qa' }),
    );
    for (const call of memoryStore.write.mock.calls) {
      expect((call[0] as { importance?: number }).importance).toBeUndefined();
    }
  });

  it('schedule event sends selected skill output to the scheduled chat', async () => {
    const runtime = makeRuntime();
    const skill: Skill = {
      ...qaSkill,
      name: 'weekly',
      match: vi.fn().mockReturnValue(true),
      run: vi
        .fn()
        .mockResolvedValue(ok({ card: { templateName: 'weekly', content: { weekly: true } } })),
    };
    const ctx = makeCtx(
      {
        type: 'schedule',
        payload: { chatId: 'oc_chat1', skillName: 'weekly', timestamp: 123 },
      },
      runtime,
    );
    const memoryStore = {
      read: vi.fn(),
      search: vi.fn(),
      list: vi.fn(),
      write: vi.fn().mockResolvedValue(ok({})),
      delete: vi.fn(),
      score: vi.fn(),
    };
    const scheduleCtx = { ...ctx, memoryStore } as unknown as SkillContext;

    await handleEvent(scheduleCtx, router, { weekly: skill } as unknown as Record<
      SkillName,
      Skill
    >);

    expect(skill.run).toHaveBeenCalledOnce();
    expect(runtime.sendCard).toHaveBeenCalledWith({
      chatId: 'oc_chat1',
      card: { templateName: 'weekly', content: { weekly: true } },
    });
    expect(memoryStore.write).not.toHaveBeenCalled();
  });

  // 6. intent='silent'（非 qa/meetingNotes 等消息）→ 不触发任何 skill
  it('silent intent → no skill triggered', async () => {
    const mockSkill: Skill = {
      ...qaSkill,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ text: 'x' })),
    };
    // 普通聊天消息不匹配任何规则 → SkillRouter 返回 'silent'
    const msg = makeMessage({ text: '好的，明白了', mentions: [] });
    const ctx = makeCtx(makeEvent(msg));

    await handleEvent(ctx, router, { qa: mockSkill } as unknown as Record<SkillName, Skill>);

    expect(mockSkill.run).not.toHaveBeenCalled();
  });

  // 7. non-message event → 直接跳过
  it('non-message event → no skill triggered', async () => {
    const mockSkill: Skill = {
      ...qaSkill,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ text: 'x' })),
    };
    const event: BotEvent = {
      type: 'botJoinedChat',
      payload: { chatId: 'c1', inviter: { userId: 'u1' }, timestamp: 0 },
    };
    const ctx = makeCtx(event);

    await handleEvent(ctx, router, { qa: mockSkill } as unknown as Record<SkillName, Skill>);

    expect(mockSkill.run).not.toHaveBeenCalled();
  });

  it('qa.reanswer card action fetches edited source message and sends a new card', async () => {
    const editedQuestion = makeMessage({
      messageId: 'msg_question',
      text: 'PPT 这期要直接生成飞书幻灯片吗？',
    });
    const runtime = {
      ...makeRuntime(),
      fetchHistory: vi.fn().mockResolvedValue(ok({ messages: [editedQuestion], hasMore: false })),
    } as unknown as BotRuntime;
    const mockSkill: Skill = {
      ...qaSkill,
      match: vi.fn(),
      run: vi.fn().mockResolvedValue(ok({ card: { templateName: 'qa', content: { mock: true } } })),
    };
    const event: BotEvent = {
      type: 'cardAction',
      payload: {
        chatId: 'oc_chat1',
        messageId: 'om_card1',
        user: { userId: 'ou_user1' },
        value: {
          action: 'qa.reanswer',
          questionMessageId: 'msg_question',
          chatId: 'oc_chat1',
        },
        timestamp: 0,
      },
    };
    const ctx = makeCtx(event, runtime);

    await handleEvent(ctx, router, { qa: mockSkill } as unknown as Record<SkillName, Skill>);

    expect(runtime.fetchHistory).toHaveBeenCalledWith({ chatId: 'oc_chat1', pageSize: 50 });
    expect(mockSkill.run).toHaveBeenCalledOnce();
    const replayCtx = (mockSkill.run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SkillContext;
    expect(replayCtx.event.type).toBe('message');
    if (replayCtx.event.type === 'message') {
      expect(replayCtx.event.payload.text).toBe('PPT 这期要直接生成飞书幻灯片吗？');
    }
    expect(runtime.sendCard).toHaveBeenCalledOnce();
  });

  it('harness mention selects a skill and runs skill.run()', async () => {
    const runtime = makeRuntime();
    const msg = makeMessage({
      text: '帮我回答这个问题',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg), runtime);
    const harness = makeHarness();
    const chatWithTools = vi.fn().mockResolvedValue(
      ok({
        content: JSON.stringify({ skill: 'qa', reason: 'user asked a question', args: {} }),
        toolCalls: [],
        rounds: 1,
      }),
    );
    ctx.llm.chatWithTools = chatWithTools;

    const skill: Skill = {
      ...qaSkill,
      run: vi.fn().mockResolvedValue(ok({ text: 'skill answer' })),
    };

    await handleEvent(ctx, router, { qa: skill } as unknown as Record<SkillName, Skill>, harness);

    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(skill.run).toHaveBeenCalledOnce();
    expect(runtime.sendText).toHaveBeenCalledWith({ chatId: 'oc_chat1', text: 'skill answer' });
  });

  it('harness decision prompt derives skill names from registered skills', async () => {
    const runtime = makeRuntime();
    const msg = makeMessage({
      text: '帮我回答这个问题',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg), runtime);
    const harness = makeHarness();
    const chatWithTools = vi.fn().mockResolvedValue(
      ok({
        content: JSON.stringify({ skill: 'qa', reason: 'user asked a question', args: {} }),
        toolCalls: [],
        rounds: 1,
      }),
    );
    ctx.llm.chatWithTools = chatWithTools;

    const skill: Skill = {
      ...qaSkill,
      run: vi.fn().mockResolvedValue(ok({ text: 'skill answer' })),
    };

    await handleEvent(ctx, router, { qa: skill } as Partial<Record<SkillName, Skill>>, harness);

    const [messages] = chatWithTools.mock.calls[0]!;
    const userMessage = (messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user',
    );
    expect(userMessage?.content).toContain('"skill":"<以下之一: qa | silent>"');
    expect(userMessage?.content).not.toContain('weekly');
    expect(userMessage?.content).not.toContain('requirementDoc');
  });

  it('harness silent decision does not reply or fallback', async () => {
    const runtime = makeRuntime();
    const ctx = makeCtx(makeEvent(makeMessage()), runtime);
    const harness = makeHarness();
    ctx.llm.chatWithTools = vi.fn().mockResolvedValue(
      ok({
        content: JSON.stringify({ skill: 'silent', reason: 'not actionable' }),
        toolCalls: [],
        rounds: 1,
      }),
    );
    const skill: Skill = {
      ...qaSkill,
      run: vi.fn().mockResolvedValue(ok({ text: 'x' })),
    };

    await handleEvent(ctx, router, { qa: skill } as unknown as Record<SkillName, Skill>, harness);

    expect(skill.run).not.toHaveBeenCalled();
    expect(runtime.sendText).not.toHaveBeenCalled();
    expect(runtime.sendCard).not.toHaveBeenCalled();
  });

  it('harness invalid JSON falls back to SkillRouter', async () => {
    const runtime = {
      ...makeRuntime(),
      fetchHistory: vi.fn().mockResolvedValue(
        ok({
          messages: [
            makeMessage({
              messageId: 'hist_1',
              text: '这是飞书的问答功能',
              sender: { userId: 'ou_other' },
            }),
          ],
          hasMore: false,
        }),
      ),
    } as unknown as BotRuntime;
    const msg = makeMessage({
      text: '这是什么？',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    });
    const ctx = makeCtx(makeEvent(msg), runtime);
    const harness = makeHarness();
    ctx.llm.chatWithTools = vi
      .fn()
      .mockResolvedValue(ok({ content: 'not-json', toolCalls: [], rounds: 1 }));
    const skill: Skill = {
      ...qaSkill,
      match: vi.fn().mockReturnValue(true),
      run: vi.fn().mockResolvedValue(ok({ text: 'fallback answer' })),
    };

    await handleEvent(ctx, router, { qa: skill } as unknown as Record<SkillName, Skill>, harness);

    expect(skill.run).toHaveBeenCalledOnce();
    expect(runtime.sendText).toHaveBeenCalledWith({ chatId: 'oc_chat1', text: 'fallback answer' });
  });
});
