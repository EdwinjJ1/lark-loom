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
import {
  handleEvent,
  shouldConsiderProactive,
  shouldObservePassively,
  PASSIVE_MIN_TEXT_LENGTH,
  type HarnessConfig,
} from '../wiring.js';
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

function makeCtx(
  event: BotEvent,
  runtimeOverride?: BotRuntime,
  llmOverride?: Partial<SkillContext['llm']>,
): SkillContext {
  return {
    event,
    runtime: runtimeOverride ?? makeRuntime(),
    llm: {
      ask: vi.fn().mockResolvedValue(ok('这是测试回答。')),
      chat: vi.fn(),
      askStructured: vi.fn(),
      chatWithTools: vi.fn(),
      embed: vi.fn(),
      ...llmOverride,
    } as unknown as SkillContext['llm'],
    bitable: {
      insert: vi.fn().mockResolvedValue(ok({ tableId: 't', recordId: 'r' })),
    } as unknown as SkillContext['bitable'],
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
    // 普通闲聊，router 返回 silent，不应触发任何 skill
    const msg = makeMessage({ text: '今天天气真好啊', mentions: [] });
    const ctx = makeCtx(makeEvent(msg));

    await handleEvent(ctx, router, { qa: mockSkill } as unknown as Record<SkillName, Skill>);

    expect(mockSkill.run).not.toHaveBeenCalled();
  });

  // 4a. taskAssignment intent → 调对应 skill.run（不再走 fire-and-forget memory 副作用）
  it('taskAssignment intent → taskAssignment skill.run called', async () => {
    const taskSkill: Skill = {
      ...qaSkill,
      name: 'taskAssignment' as SkillName,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ reasoning: 'task picked up' })),
    };
    const msg = makeMessage({ text: '我来负责前端，李四来负责后端', mentions: [] });
    const ctx = makeCtx(makeEvent(msg));

    await handleEvent(ctx, router, {
      taskAssignment: taskSkill,
    } as unknown as Record<SkillName, Skill>);

    expect(taskSkill.run).toHaveBeenCalledOnce();
  });

  // 4b. progressUpdate intent → 调对应 skill.run
  it('progressUpdate intent → progressUpdate skill.run called', async () => {
    const progressSkill: Skill = {
      ...qaSkill,
      name: 'progressUpdate' as SkillName,
      match: () => true,
      run: vi.fn().mockResolvedValue(ok({ reasoning: 'progress picked up' })),
    };
    const msg = makeMessage({ text: '前端模块已完成，下周联调', mentions: [] });
    const ctx = makeCtx(makeEvent(msg));

    await handleEvent(ctx, router, {
      progressUpdate: progressSkill,
    } as unknown as Record<SkillName, Skill>);

    expect(progressSkill.run).toHaveBeenCalledOnce();
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

// ─── Onboarding（issue #98 数据使用告知）─────────────────────────────────────

describe('onboarding flow', () => {
  const router = new SkillRouter(BOT_ID);

  it('botJoinedChat → sends activation card', async () => {
    const runtime = makeRuntime();
    const event: BotEvent = {
      type: 'botJoinedChat',
      payload: {
        chatId: 'oc_new_chat',
        inviter: { userId: 'ou_admin', name: '管理员' },
        timestamp: Date.now(),
      },
    };
    const ctx = makeCtx(event, runtime);
    (ctx.cardBuilder.build as ReturnType<typeof vi.fn>).mockReturnValue({
      templateName: 'activation',
      content: { built: true },
    });

    await handleEvent(ctx, router, {} as unknown as Record<SkillName, Skill>);

    expect(ctx.cardBuilder.build).toHaveBeenCalledWith(
      'activation',
      expect.objectContaining({ chatName: expect.any(String) }),
    );
    expect(runtime.sendCard).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'oc_new_chat' }),
    );
    // 不应当发普通文本（onboarding 只发卡片）
    expect(runtime.sendText).not.toHaveBeenCalled();
  });

  it('cardAction "activate" patches card to confirmed state + writes audit memory', async () => {
    const runtime = makeRuntime();
    const event: BotEvent = {
      type: 'cardAction',
      payload: {
        chatId: 'oc_chat1',
        messageId: 'msg_activation',
        user: { userId: 'ou_admin', name: '张三' },
        value: { action: 'activate', chatName: '测试群' },
        timestamp: Date.now(),
      },
    };
    const ctx = makeCtx(event, runtime);
    (ctx.cardBuilder.build as ReturnType<typeof vi.fn>).mockReturnValue({
      templateName: 'activation',
      content: { built: true },
    });

    await handleEvent(ctx, router, {} as unknown as Record<SkillName, Skill>);

    // patch 卡片成 confirmed 态
    expect(ctx.cardBuilder.build).toHaveBeenCalledWith(
      'activation',
      expect.objectContaining({
        chatName: '测试群',
        confirmedBy: '张三',
        confirmedAt: expect.any(Number),
      }),
    );
    expect(runtime.patchCard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg_activation' }),
    );
    // audit memory 写入
    expect(ctx.bitable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'memory',
        row: expect.objectContaining({
          kind: 'project',
          chat_id: 'oc_chat1',
          source_skill: 'onboarding',
          content: expect.stringContaining('activate'),
        }),
      }),
    );
  });

  it('cardAction "dismiss" patches to dismissed state', async () => {
    const runtime = makeRuntime();
    const event: BotEvent = {
      type: 'cardAction',
      payload: {
        chatId: 'oc_chat1',
        messageId: 'msg_activation',
        user: { userId: 'ou_user', name: '李四' },
        value: { action: 'dismiss' },
        timestamp: Date.now(),
      },
    };
    const ctx = makeCtx(event, runtime);
    (ctx.cardBuilder.build as ReturnType<typeof vi.fn>).mockReturnValue({
      templateName: 'activation',
      content: { built: true },
    });

    await handleEvent(ctx, router, {} as unknown as Record<SkillName, Skill>);

    expect(ctx.cardBuilder.build).toHaveBeenCalledWith(
      'activation',
      expect.objectContaining({
        dismissedBy: '李四',
        dismissedAt: expect.any(Number),
      }),
    );
    expect(runtime.patchCard).toHaveBeenCalledOnce();
    expect(ctx.bitable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          source_skill: 'onboarding',
          content: expect.stringContaining('dismiss'),
        }),
      }),
    );
  });

  // 隐私回归：飞书 cardAction 不传 user.name 时，patch 卡片绝不能 fallback 到 userId
  // （PR #99 第一版上线后实战发现 open_id 露出，issue #98 review fix）
  it('cardAction without user.name uses generic placeholder, never leaks userId', async () => {
    const runtime = makeRuntime();
    const event: BotEvent = {
      type: 'cardAction',
      payload: {
        chatId: 'oc_chat1',
        messageId: 'msg_activation',
        // user.name 缺失（飞书在 cardAction 中常见情况）
        user: { userId: 'ou_702fcccb0dc6807c067a885ff71b03f1' },
        value: { action: 'activate', chatName: '测试群' },
        timestamp: Date.now(),
      },
    };
    const ctx = makeCtx(event, runtime);
    (ctx.cardBuilder.build as ReturnType<typeof vi.fn>).mockReturnValue({
      templateName: 'activation',
      content: { built: true },
    });

    await handleEvent(ctx, router, {} as unknown as Record<SkillName, Skill>);

    // 调用 cardBuilder.build 时 confirmedBy 应该是通用占位，**不是** open_id
    const buildCalls = (ctx.cardBuilder.build as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = buildCalls[buildCalls.length - 1];
    expect(lastCall![1]).toMatchObject({ confirmedBy: '管理员' });
    expect(lastCall![1].confirmedBy).not.toContain('ou_'); // 永远不能 fallback 到 open_id
  });

  it('audit memory still written even when patchCard fails', async () => {
    const runtime = makeRuntime();
    runtime.patchCard = vi
      .fn()
      .mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'patch failed')));
    const event: BotEvent = {
      type: 'cardAction',
      payload: {
        chatId: 'oc_chat1',
        messageId: 'msg_activation',
        user: { userId: 'ou_admin', name: '张三' },
        value: { action: 'activate', chatName: '测试群' },
        timestamp: Date.now(),
      },
    };
    const ctx = makeCtx(event, runtime);
    (ctx.cardBuilder.build as ReturnType<typeof vi.fn>).mockReturnValue({
      templateName: 'activation',
      content: { built: true },
    });

    await handleEvent(ctx, router, {} as unknown as Record<SkillName, Skill>);

    // patchCard 挂了，但 audit memory 仍然写入
    expect(ctx.bitable.insert).toHaveBeenCalledOnce();
  });
});

// ─── shouldObservePassively ───────────────────────────────────────────────────

describe('shouldObservePassively', () => {
  it('长度达标的普通对话消息应被观察', () => {
    expect(shouldObservePassively('我们明天把这个功能做完吧')).toBe(true);
  });

  it('不含关键字但有事实信息的消息也应被观察', () => {
    expect(shouldObservePassively('小明你来写登录页，小红负责接口')).toBe(true);
  });

  it('恰好等于最小长度的消息应被观察', () => {
    const text = 'a'.repeat(PASSIVE_MIN_TEXT_LENGTH);
    expect(shouldObservePassively(text)).toBe(true);
  });

  it('过短的消息（闲聊/表情）应被跳过', () => {
    expect(shouldObservePassively('好的')).toBe(false);
    expect(shouldObservePassively('👍')).toBe(false);
    expect(shouldObservePassively('ok')).toBe(false);
  });

  it('纯空白消息应被跳过', () => {
    expect(shouldObservePassively('   ')).toBe(false);
  });

  it('trim 后长度不足的消息应被跳过', () => {
    const padded = '   ' + 'a'.repeat(PASSIVE_MIN_TEXT_LENGTH - 1) + '   ';
    expect(shouldObservePassively(padded)).toBe(false);
  });
});

// ─── shouldConsiderProactive ─────────────────────────────────────────────────

describe('shouldConsiderProactive', () => {
  it('明显需要资料/澄清的消息应进入主动层候选', () => {
    expect(shouldConsiderProactive('这个资料在哪里？')).toBe(true);
    expect(shouldConsiderProactive('下一步我们先做什么')).toBe(true);
  });

  it('短闲聊或无工作信号的消息不进入主动层', () => {
    expect(shouldConsiderProactive('好的')).toBe(false);
    expect(shouldConsiderProactive('今天大家辛苦了')).toBe(false);
  });
});

// ─── handlePassiveObserve（通过 handleEvent 集成） ────────────────────────────

describe('handleEvent — passive observe', () => {
  const router = new SkillRouter(BOT_ID);

  it('非 @mention 长消息触发 LLM 判断', async () => {
    const msg = makeMessage({ text: '我们决定下周五提交MVP，前端由小明负责', mentions: [] });
    const chatWithTools = vi.fn().mockResolvedValue(ok({ content: 'SKIP', toolCalls: [], rounds: 1 }));
    const ctx = makeCtx(makeEvent(msg), undefined, { chatWithTools });

    await handleEvent(ctx, router, {}, makeHarness());
    await new Promise((r) => setTimeout(r, 0)); // flush fire-and-forget

    expect(chatWithTools).toHaveBeenCalledOnce();
  });

  it('非 @mention 短消息不触发 LLM 判断', async () => {
    const msg = makeMessage({ text: '好的', mentions: [] });
    const chatWithTools = vi.fn().mockResolvedValue(ok({ content: '', toolCalls: [], rounds: 0 }));
    const ctx = makeCtx(makeEvent(msg), undefined, { chatWithTools });

    await handleEvent(ctx, router, {}, makeHarness());
    await new Promise((r) => setTimeout(r, 0));

    expect(chatWithTools).not.toHaveBeenCalled();
  });

  it('LLM 决定调 memory.write 时写入 store', async () => {
    const msg = makeMessage({ text: '项目截止日期确定是5月15日，请各位注意', mentions: [] });

    const memoryStore = new NullMemoryStore();
    const writeSpy = vi.spyOn(memoryStore, 'write').mockResolvedValue(
      ok({ id: 'r1', kind: 'chat', chat_id: 'oc_chat1', key: 'project_deadline',
           content: '截止5月15日', importance: -1, last_access: 0, created_at: 0, source_skill: 'passive_observe' }),
    );

    const chatWithTools = vi.fn().mockImplementation(
      async (_msgs: unknown, opts: { executor: (c: { id: string; name: string; argumentsRaw: string }) => Promise<unknown> }) => {
        await opts.executor({ id: 'tc1', name: 'memory.write',
          argumentsRaw: JSON.stringify({ kind: 'chat', key: 'project_deadline', content: '截止5月15日' }) });
        return ok({ content: '', toolCalls: [{ id: 'tc1', name: 'memory.write', argumentsRaw: '{}' }], rounds: 1 });
      },
    );

    const ctx = makeCtx(makeEvent(msg), undefined, { chatWithTools });
    const harness = { ...makeHarness(), memoryStore };

    await handleEvent(ctx, router, {}, harness);
    await new Promise((r) => setTimeout(r, 0));

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'chat',
      key: 'project_deadline',
      source_skill: 'passive_observe',
    }));
  });

  it('@mention 消息不走 passive observe 路径', async () => {
    // @mention 走 Harness，不走 passive observe；chatWithTools 被 Harness 调，不是 passive observe
    const msg = makeMessage({ text: '我们决定下周五提交MVP，前端由小明负责',
      mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }] });
    const chatWithTools = vi.fn().mockResolvedValue(
      ok({ content: JSON.stringify({ skill: 'silent' }), toolCalls: [], rounds: 1 }),
    );
    const ctx = makeCtx(makeEvent(msg), undefined, { chatWithTools });

    await handleEvent(ctx, router, {}, makeHarness());
    await new Promise((r) => setTimeout(r, 0));

    // Harness 可能调 chatWithTools，但 passive observe 不应额外再调一次
    // 每条 @mention 消息 chatWithTools 调用次数 ≤ 1（只有 Harness，没有 passive observe）
    expect(chatWithTools.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ─── handleEvent — proactive layer ───────────────────────────────────────────

describe('handleEvent — proactive layer', () => {
  const router = new SkillRouter(BOT_ID);

  it('非 @mention 且无 skill 接管时，可主动发送资料提示', async () => {
    const msg = makeMessage({ text: '这个资料在哪里？', mentions: [] });
    const runtime = makeRuntime();
    const chatWithTools = vi.fn().mockResolvedValue(
      ok({
        content: JSON.stringify({
          action: 'share',
          text: '我找到一条相关资料：项目 PRD 在飞书文档里，先看“验收标准”那节。',
          reason: '用户在找资料',
        }),
        toolCalls: [{ id: 'tc1', name: 'memory.search', argumentsRaw: '{}' }],
        rounds: 1,
      }),
    );
    const ctx = makeCtx(makeEvent(msg), runtime, { chatWithTools });

    await handleEvent(ctx, router, {}, makeHarness());
    await vi.waitFor(() => expect(runtime.sendText).toHaveBeenCalledOnce());

    expect(chatWithTools).toHaveBeenCalledOnce();
    const [, opts] = chatWithTools.mock.calls[0]!;
    const toolNames = (opts as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames.sort()).toEqual(['memory.search', 'skill.list', 'skill.read']);
    expect(toolNames).not.toContain('memory.write');
    expect(toolNames).not.toContain('decision.write');
    expect(runtime.sendText).toHaveBeenCalledWith({
      chatId: 'oc_chat1',
      text: '我找到一条相关资料：项目 PRD 在飞书文档里，先看“验收标准”那节。',
    });
  });

  it('非 @mention 且 skill 已接管时，不额外触发主动层', async () => {
    const msg = makeMessage({ text: '我来负责资料吗？', mentions: [] });
    const runtime = makeRuntime();
    const chatWithTools = vi.fn().mockResolvedValue(
      ok({ content: JSON.stringify({ action: 'clarify', text: 'x' }), toolCalls: [], rounds: 1 }),
    );
    const ctx = makeCtx(makeEvent(msg), runtime, { chatWithTools });
    const taskSkill: Skill = {
      ...qaSkill,
      name: 'taskAssignment' as SkillName,
      match: vi.fn().mockReturnValue(true),
      run: vi.fn().mockResolvedValue(ok({ reasoning: 'assignment captured' })),
    };

    await handleEvent(ctx, router, { taskAssignment: taskSkill }, makeHarness());
    await new Promise((r) => setTimeout(r, 0));

    expect(taskSkill.run).toHaveBeenCalledOnce();
    expect(chatWithTools).not.toHaveBeenCalled();
  });

  it('share 没有实际检索工具调用时不发送，避免编造资料', async () => {
    const msg = makeMessage({ text: '这个资料在哪里？', mentions: [] });
    const runtime = makeRuntime();
    const chatWithTools = vi.fn().mockResolvedValue(
      ok({
        content: JSON.stringify({
          action: 'share',
          text: '资料在这里。',
          reason: '用户在找资料',
        }),
        toolCalls: [],
        rounds: 1,
      }),
    );
    const ctx = makeCtx(makeEvent(msg), runtime, { chatWithTools });

    await handleEvent(ctx, router, {}, makeHarness());
    await new Promise((r) => setTimeout(r, 0));

    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(runtime.sendText).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'proactive layer share without grounding tool call',
      expect.objectContaining({ reason: '用户在找资料' }),
    );
  });
});
