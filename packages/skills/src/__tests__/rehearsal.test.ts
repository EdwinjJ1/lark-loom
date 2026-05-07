import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  rehearsalSkill,
  loadRehearsalSession,
  isSatisfactionSignal,
  isFreshTrigger,
  REHEARSAL_SESSION_KEY,
  type RehearsalSession,
} from '../rehearsal.js';
import {
  buildClarifyQuestions,
  RehearsalAnalysisSchema,
  type RehearsalAnalysis,
} from '../prompts/rehearsal.js';

// 避免重复打字 schema.parse(...)
function RehearsalAnalysisSchemaForTest(value: unknown): RehearsalAnalysis {
  return RehearsalAnalysisSchema.parse(value);
}
import { ok, err, makeError, ErrorCode } from '@seedhac/contracts';
import type {
  BotEvent,
  CardAction,
  Card,
  LLMClient,
  Message,
  MemoryRecord,
  MemoryStoreClient,
  SkillContext,
  Result,
} from '@seedhac/contracts';

// ── 测试 fixtures ─────────────────────────────────────────────────────────────

const CHAT_ID = 'oc_chat_001';
const MOCK_CARD: Card = { templateName: 'rehearsal', content: { built: true } };

let MSG_SEQ = 0;
function makeMessage(text: string, overrides: Partial<Message> = {}): Message {
  MSG_SEQ += 1;
  return {
    messageId: `msg_${String(MSG_SEQ).padStart(3, '0')}`,
    chatId: CHAT_ID,
    chatType: 'group',
    sender: { userId: 'ou_user_001', name: '张三' },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: 1_700_000_000_000 + MSG_SEQ * 1000,
    ...overrides,
  };
}

function makeMessageEvent(text: string): BotEvent {
  return { type: 'message', payload: makeMessage(text) };
}

function makeCardActionEvent(action: string): BotEvent {
  const payload: CardAction = {
    chatId: CHAT_ID,
    messageId: 'card_msg_001',
    user: { userId: 'ou_user_001', name: '张三' },
    value: { action, chatId: CHAT_ID, round: 1 },
    timestamp: 1_700_000_999_000,
  };
  return { type: 'cardAction', payload };
}

const VALID_ANALYSIS = {
  summary: '演示中存在节奏与图表清晰度问题。',
  issues: [
    { text: '商业模式段节奏过快', dimension: '结构' as const, confidence: 0.9 },
    { text: '第 3 页缺少 y 轴单位', dimension: '内容' as const, confidence: 0.95 },
  ],
  suggestions: [
    { text: '商业模式拆 3 bullet 慢讲', dimension: '结构' as const, confidence: 0.8 },
    { text: '第 3 页补单位与时间区间', dimension: '内容' as const, confidence: 0.9 },
  ],
  uncertainties: ['用户提到字体可能也有问题，但未明确指向哪一页'],
  recommendedChanges: [
    { target: 'slides' as const, text: '第 3 页：补 y 轴单位' },
    { target: 'slides' as const, text: '商业模式页：拆 3 bullet' },
  ],
};

const HISTORY: readonly Message[] = [
  makeMessage('我们演练了一下，开头节奏太快', { sender: { userId: 'ou_a', name: 'A' } }),
  makeMessage('第 3 页那个图缺单位', { sender: { userId: 'ou_b', name: 'B' } }),
];

// ── Mock 工厂 ────────────────────────────────────────────────────────────────

interface MockMemoryStore {
  store: Map<string, MemoryRecord>;
  client: MemoryStoreClient;
}

function makeMemoryStore(): MockMemoryStore {
  const store = new Map<string, MemoryRecord>();
  const k = (kind: string, chatId: string, key: string): string => `${kind}::${chatId}::${key}`;

  const client: MemoryStoreClient = {
    read: vi.fn(async (kind, chatId, key) => {
      return ok(store.get(k(kind, chatId, key)) ?? null) as Result<MemoryRecord | null>;
    }),
    search: vi.fn(async () => ok([])),
    list: vi.fn(async () => ok([])),
    write: vi.fn(async (input) => {
      const now = Date.now();
      const rec: MemoryRecord = {
        id: `mem_${now}`,
        kind: input.kind,
        chat_id: input.chat_id,
        key: input.key,
        content: input.content,
        importance: input.importance ?? -1,
        last_access: now,
        created_at: now,
        source_skill: input.source_skill,
        ...(input.user_id ? { user_id: input.user_id } : {}),
      };
      store.set(k(input.kind, input.chat_id, input.key), rec);
      return ok(rec);
    }),
    delete: vi.fn(async () => ok(undefined)),
    score: vi.fn(async () => ok(5)),
  };

  return { store, client };
}

interface CtxOpts {
  readonly history?: readonly Message[];
  readonly analysis?: unknown;
  readonly memoryStore?: MockMemoryStore;
  readonly outline?: unknown;
}

function makeCtx(event: BotEvent, opts: CtxOpts = {}): SkillContext {
  const history = opts.history ?? HISTORY;
  const memStore = opts.memoryStore ?? makeMemoryStore();

  // askStructured 调用顺序：每次跑分析时先 lite 相关性预筛（≤5 条会跳过），再 pro 抽取
  // 测试历史 ≤ 5 条 → 跳过预筛，所以只需 mock 一次 pro 调用
  // 区分 prompt 用 system role 字符串 —— 这是各 prompt 唯一稳定的标识
  const askStructured = vi.fn().mockImplementation(async (prompt: string) => {
    if (prompt.includes('演示演练的复盘助手')) {
      return ok(opts.analysis ?? VALID_ANALYSIS);
    }
    if (prompt.includes('飞书原生 Slides') || prompt.includes('结构化演示文稿方案')) {
      return ok(
        opts.outline ?? {
          title: '演练复盘后新版',
          slides: [
            { type: 'cover', title: '封面' },
            { type: 'overview', title: '商业模式（已优化）', bullets: ['问题', '解法', '盈利'] },
          ],
        },
      );
    }
    if (prompt.includes('预筛选')) {
      return ok({ results: [] }); // bypass
    }
    return ok(opts.analysis ?? VALID_ANALYSIS);
  });

  const ctx = {
    event,
    runtime: {
      on: vi.fn(),
      start: vi.fn().mockResolvedValue(ok(undefined)),
      stop: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(ok({ messageId: 'txt', chatId: CHAT_ID, timestamp: 0 })),
      sendCard: vi
        .fn()
        .mockResolvedValue(ok({ messageId: 'load_msg', chatId: CHAT_ID, timestamp: 0 })),
      patchCard: vi.fn().mockResolvedValue(ok(undefined)),
      fetchHistory: vi.fn().mockResolvedValue(ok({ messages: history, hasMore: false })),
      fetchMembers: vi.fn().mockResolvedValue(ok({ members: [{ userId: 'ou_a', name: 'A' }] })),
      fetchMessage: vi.fn(),
      pinMessage: vi.fn().mockResolvedValue(ok(undefined)),
    },
    llm: {
      ask: vi.fn(),
      chat: vi.fn(),
      askStructured,
      chatWithTools: vi.fn(),
      embed: vi.fn(),
    } as unknown as LLMClient,
    bitable: {
      find: vi.fn().mockResolvedValue(ok({ records: [], hasMore: false })),
      insert: vi.fn().mockResolvedValue(ok({ tableId: 't_mem', recordId: 'r_mem' })),
      batchInsert: vi.fn().mockResolvedValue(ok([])),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      link: vi.fn().mockResolvedValue(ok(undefined)),
      readTable: vi.fn(),
    } as unknown as SkillContext['bitable'],
    docx: {
      create: vi.fn(),
      appendBlocks: vi.fn(),
      getShareLink: vi.fn(),
      createFromMarkdown: vi
        .fn()
        .mockResolvedValue(ok({ docToken: 'd1', url: 'https://feishu.cn/docx/d1' })),
      readContent: vi.fn(),
      grantMembersEdit: vi.fn().mockResolvedValue(ok(undefined)),
      appendToSection: vi.fn(),
      replaceSection: vi.fn(),
      renameTitle: vi.fn(),
    } as unknown as SkillContext['docx'],
    slides: {
      createFromOutline: vi
        .fn()
        .mockResolvedValue(ok({ slidesToken: 'slk_new', url: 'https://feishu.cn/slides/new' })),
      grantMembersEdit: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as SkillContext['slides'],
    cardBuilder: { build: vi.fn().mockReturnValue(MOCK_CARD) },
    retrievers: {},
    memoryStore: memStore.client,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return ctx as unknown as SkillContext;
}

beforeEach(() => {
  MSG_SEQ = 0;
});

// ── 触发 + 信号工具 ───────────────────────────────────────────────────────────

describe('isFreshTrigger / isSatisfactionSignal', () => {
  it('isFreshTrigger 命中触发关键词', () => {
    expect(isFreshTrigger('我们刚才演练完了')).toBe(true);
    expect(isFreshTrigger('彩排一下')).toBe(true);
    expect(isFreshTrigger('汇报复盘')).toBe(true);
    expect(isFreshTrigger('根据刚才反馈修改 PPT')).toBe(true);
  });

  it('isFreshTrigger 不命中无关消息', () => {
    expect(isFreshTrigger('今天天气不错')).toBe(false);
  });

  it('isSatisfactionSignal 命中满意类信号', () => {
    expect(isSatisfactionSignal('满意，可以了')).toBe(true);
    expect(isSatisfactionSignal('完成了')).toBe(true);
    expect(isSatisfactionSignal('OK 就这样')).toBe(true);
    expect(isSatisfactionSignal('没问题')).toBe(true);
  });

  it('isSatisfactionSignal 不把"不满意"当满意', () => {
    expect(isSatisfactionSignal('不满意，再改改')).toBe(false);
  });

  it('isSatisfactionSignal 不把"完成了项目目标"当满意（false positive 防御）', () => {
    // "完成"作为动词描述工作进度，不应触发 finalize
    expect(isSatisfactionSignal('完成了项目目标')).toBe(false);
    expect(isSatisfactionSignal('我完成了用户访谈')).toBe(false);
    expect(isSatisfactionSignal('未完成')).toBe(false);
  });

  it('isSatisfactionSignal 接受"完成"作为独立短语', () => {
    expect(isSatisfactionSignal('演练复盘完成了')).toBe(true);
    expect(isSatisfactionSignal('完成')).toBe(true);
    expect(isSatisfactionSignal('完成。')).toBe(true);
    expect(isSatisfactionSignal('完成了，没问题')).toBe(true);
  });
});

describe('RehearsalAnalysisSchema dimension 容错', () => {
  it('LLM 返回标准中文维度 → 直接通过', () => {
    const parsed = RehearsalAnalysisSchemaForTest({
      summary: '',
      issues: [{ text: 'a', dimension: '内容', confidence: 0.9 }],
      suggestions: [],
      uncertainties: [],
      recommendedChanges: [],
    });
    expect(parsed.issues[0]!.dimension).toBe('内容');
  });

  it('LLM 返回英文 alias → 自动映射到中文', () => {
    const parsed = RehearsalAnalysisSchemaForTest({
      summary: '',
      issues: [
        { text: 'a', dimension: 'content', confidence: 0.9 },
        { text: 'b', dimension: 'Structure', confidence: 0.9 },
        { text: 'c', dimension: 'TIMING', confidence: 0.9 },
        { text: 'd', dimension: 'audience', confidence: 0.9 },
        { text: 'e', dimension: 'delivery', confidence: 0.9 },
      ],
      suggestions: [],
      uncertainties: [],
      recommendedChanges: [],
    });
    expect(parsed.issues.map((i) => i.dimension)).toEqual([
      '内容',
      '结构',
      '时间',
      '受众',
      '表达',
    ]);
  });

  it('LLM 返回未知维度 → 落入"其他"，不丢条目', () => {
    const parsed = RehearsalAnalysisSchemaForTest({
      summary: '',
      issues: [{ text: 'a', dimension: '不存在的维度', confidence: 0.9 }],
      suggestions: [],
      uncertainties: [],
      recommendedChanges: [],
    });
    expect(parsed.issues[0]!.dimension).toBe('其他');
    expect(parsed.issues[0]!.text).toBe('a');
  });

  it('dimension 字段缺失 → 默认"其他"', () => {
    const parsed = RehearsalAnalysisSchemaForTest({
      summary: '',
      issues: [{ text: 'a', confidence: 0.9 }],
      suggestions: [],
      uncertainties: [],
      recommendedChanges: [],
    });
    expect(parsed.issues[0]!.dimension).toBe('其他');
  });
});

describe('buildClarifyQuestions', () => {
  it('"未指明哪一页"类 → 抽出主体重写为定位问句', () => {
    const qs = buildClarifyQuestions(['字体偏小，但用户未指明哪一页']);
    expect(qs[0]).toContain('哪一页');
    expect(qs[0]).toContain('字体偏小');
    expect(qs[0]).toMatch(/[？?]$/);
  });

  it('"未明确/未达成一致"类 → 抽出主体重写为决策问句', () => {
    const qs = buildClarifyQuestions(['配色方案未达成一致']);
    expect(qs[0]).toContain('配色方案');
    expect(qs[0]).toMatch(/[？?]$/);
  });

  it('已是问句 → 原样返回', () => {
    const qs = buildClarifyQuestions(['是否要补一个目录页？']);
    expect(qs[0]).toBe('是否要补一个目录页？');
  });

  it('普通陈述 → 兜底加"，能确认一下吗？"', () => {
    const qs = buildClarifyQuestions(['第 5 页的字号建议调到 24pt']);
    expect(qs[0]).toBe('第 5 页的字号建议调到 24pt，能确认一下吗？');
  });

  it('上限 3 个问题', () => {
    const qs = buildClarifyQuestions(['a？', 'b？', 'c？', 'd？', 'e？']);
    expect(qs.length).toBe(3);
  });

  it('空数组 → 空结果', () => {
    expect(buildClarifyQuestions([])).toEqual([]);
  });

  it('剥离"用户提到/群里反映"等冗余前缀', () => {
    const qs = buildClarifyQuestions(['用户提到字体偏小但未指明哪一页']);
    expect(qs[0]).not.toContain('用户提到');
    expect(qs[0]).toContain('字体偏小');
  });
});

describe('rehearsalSkill.match()', () => {
  it('匹配 message + 触发词', () => {
    expect(rehearsalSkill.match(makeCtx(makeMessageEvent('我们刚才演练了')))).toBe(true);
    expect(rehearsalSkill.match(makeCtx(makeMessageEvent('彩排完毕')))).toBe(true);
  });

  it('不匹配无关 message', () => {
    expect(rehearsalSkill.match(makeCtx(makeMessageEvent('今天天气真好')))).toBe(false);
  });

  it('匹配 cardAction rehearsal.satisfied / rehearsal.iterate', () => {
    expect(rehearsalSkill.match(makeCtx(makeCardActionEvent('rehearsal.satisfied')))).toBe(true);
    expect(rehearsalSkill.match(makeCtx(makeCardActionEvent('rehearsal.iterate')))).toBe(true);
  });

  it('不匹配其他 cardAction', () => {
    expect(rehearsalSkill.match(makeCtx(makeCardActionEvent('activate')))).toBe(false);
  });
});

// ── happy path：fresh trigger → 第 1 轮分析卡 + clarify 卡 ──────────────────

describe('rehearsalSkill.run() — round 1（fresh trigger）', () => {
  it('发 loading 卡 → patch 分析卡 → 出反问卡 → 写 session + skill_log', async () => {
    const memStore = makeMemoryStore();
    const ctx = makeCtx(makeMessageEvent('我们演练完了，帮我分析问题'), { memoryStore: memStore });

    const result = await rehearsalSkill.run(ctx);
    expect(result.ok).toBe(true);

    // 1. loading 卡 build + send
    const build = ctx.cardBuilder.build as unknown as ReturnType<typeof vi.fn>;
    expect(build.mock.calls[0]![0]).toBe('rehearsal');
    expect(build.mock.calls[0]![1]).toMatchObject({ isLoading: true, round: 1 });
    expect(ctx.runtime.sendCard).toHaveBeenCalled();

    // 2. patch 成最终分析卡（含 issues / suggestions）
    expect(ctx.runtime.patchCard).toHaveBeenCalled();
    // 找到第二次 build（最终分析卡）
    const analysisBuild = build.mock.calls.find(
      (c, i) => i > 0 && c[0] === 'rehearsal' && !c[1].isLoading && !c[1].errorMessage,
    );
    expect(analysisBuild).toBeDefined();
    expect(analysisBuild![1]).toMatchObject({ round: 1 });
    const built = analysisBuild![1] as {
      issues: { text: string; dimension: string }[];
      suggestions: { text: string; dimension: string }[];
      uncertainties: string[];
    };
    expect(built.issues.map((i) => i.text)).toEqual(
      expect.arrayContaining(['商业模式段节奏过快']),
    );
    expect(built.suggestions.map((s) => s.text)).toEqual(
      expect.arrayContaining(['商业模式拆 3 bullet 慢讲']),
    );
    expect(built.issues.find((i) => i.text.includes('商业模式'))?.dimension).toBe('结构');
    expect(built.uncertainties.length).toBeGreaterThan(0);

    // 3. 反问卡 build（template = rehearsalClarify）
    const clarifyBuild = build.mock.calls.find((c) => c[0] === 'rehearsalClarify');
    expect(clarifyBuild).toBeDefined();
    expect((clarifyBuild![1] as { questions: string[] }).questions.length).toBeGreaterThan(0);

    // 4. session 写入
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session).not.toBeNull();
    expect(session!.round).toBe(1);
    expect(session!.phase).toBe('clarifying');
    expect(session!.recommendedChanges.length).toBe(2);

    // 5. skill_log 写入（per round）
    const logCalls = (ctx.bitable.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0].row.kind === 'skill_log',
    );
    expect(logCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('LLM 失败 → patch error 卡，return err', async () => {
    const ctx = makeCtx(makeMessageEvent('演练完了'));
    (ctx.llm.askStructured as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.LLM_INVALID_RESPONSE, 'parse fail')),
    );

    const result = await rehearsalSkill.run(ctx);
    expect(result.ok).toBe(false);
    // patch error 卡
    const build = ctx.cardBuilder.build as unknown as ReturnType<typeof vi.fn>;
    const errCall = build.mock.calls.find((c) => c[1].errorMessage);
    expect(errCall).toBeDefined();
  });

  it('sendCard loading 失败 → return err，不继续', async () => {
    const ctx = makeCtx(makeMessageEvent('演练完了'));
    (ctx.runtime.sendCard as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'send fail')),
    );

    const result = await rehearsalSkill.run(ctx);
    expect(result.ok).toBe(false);
    expect(ctx.runtime.fetchHistory).not.toHaveBeenCalled();
  });
});

// ── 多轮循环（≥ 2 轮）─────────────────────────────────────────────────────────

describe('rehearsalSkill.run() — 多轮循环（issue #102 step ④）', () => {
  it('round 1 → 用户文本反馈 → round 2 重新分析', async () => {
    const memStore = makeMemoryStore();
    // round 1
    const ctx1 = makeCtx(makeMessageEvent('我们刚才演练完了'), { memoryStore: memStore });
    const r1 = await rehearsalSkill.run(ctx1);
    expect(r1.ok).toBe(true);

    const session1 = await loadRehearsalSession(ctx1, CHAT_ID);
    expect(session1!.round).toBe(1);

    // round 2：同一 chatId，新消息（非 trigger，非满意）
    const ctx2 = makeCtx(makeMessage('再补一个：第 5 页字号也太小') as unknown as Message extends never ? never : BotEvent, { memoryStore: memStore });
    // ↑ TS 处理：直接构建 event
    const ctx2Real = makeCtx(
      { type: 'message', payload: makeMessage('再补一个：第 5 页字号也太小') },
      { memoryStore: memStore, analysis: VALID_ANALYSIS },
    );
    const r2 = await rehearsalSkill.run(ctx2Real);
    expect(r2.ok).toBe(true);

    const session2 = await loadRehearsalSession(ctx2Real, CHAT_ID);
    expect(session2!.round).toBe(2);
    expect(session2!.recommendedChanges.length).toBeGreaterThanOrEqual(2);

    // 占位避免未使用警告
    expect(ctx2).toBeDefined();
  });

  it('round 2 后用户继续不满意 → round 3', async () => {
    const memStore = makeMemoryStore();
    // 把 session 直接预置到 round 2
    const presetSession: RehearsalSession = {
      phase: 'clarifying',
      round: 2,
      analysisMessageId: 'analysis_msg_r2',
      clarifyMessageId: 'clarify_msg_r2',
      recommendedChanges: [{ target: 'slides', text: '第 3 页补单位' }],
      lastUncertainties: ['配色是否调整'],
      startedAt: Date.now() - 10_000,
      updatedAt: Date.now() - 1_000,
    };
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify(presetSession),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(
      { type: 'message', payload: makeMessage('其实节奏还可以再快一点') },
      { memoryStore: memStore, analysis: VALID_ANALYSIS },
    );
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session!.round).toBe(3);
    // 反问卡被 patch 成 acknowledged 态
    expect(ctx.runtime.patchCard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'clarify_msg_r2' }),
    );
  });
});

// ── 满意按钮 → step ⑤ ────────────────────────────────────────────────────────

describe('rehearsalSkill.run() — satisfied 按钮（step ⑤）', () => {
  it('cardAction satisfied → 调 slides 重生成 + 发完成卡 + 写 project memory', async () => {
    const memStore = makeMemoryStore();
    const presetSession: RehearsalSession = {
      phase: 'analyzing',
      round: 2,
      analysisMessageId: 'analysis_msg_r2',
      recommendedChanges: [
        { target: 'slides', text: '第 3 页补 y 轴单位' },
        { target: 'slides', text: '商业模式拆 bullet' },
        { target: 'doc', text: '汇报材料补本次复盘记录' },
      ],
      lastUncertainties: [],
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 1_000,
    };
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify(presetSession),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeCardActionEvent('rehearsal.satisfied'), { memoryStore: memStore });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    // slides.createFromOutline 被调
    expect(ctx.slides!.createFromOutline).toHaveBeenCalled();
    // doc.createFromMarkdown 被调（doc 类改动）
    expect(ctx.docx.createFromMarkdown).toHaveBeenCalled();

    // 完成态卡 build（含 isCompleted + newSlidesUrl）
    const build = ctx.cardBuilder.build as unknown as ReturnType<typeof vi.fn>;
    const completedBuild = build.mock.calls.find((c) => c[0] === 'rehearsal' && c[1].isCompleted);
    expect(completedBuild).toBeDefined();
    expect(completedBuild![1].newSlidesUrl).toBe('https://feishu.cn/slides/new');

    // patch 到原分析卡
    expect(ctx.runtime.patchCard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'analysis_msg_r2' }),
    );

    // project memory 写入（kind=project，content 含 [演练复盘]）
    const projectInsert = (ctx.bitable.insert as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].row.kind === 'project' && String(c[0].row.content).includes('[演练复盘]'),
    );
    expect(projectInsert).toBeDefined();

    // session 标 done
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session!.phase).toBe('done');
  });

  it('文本"满意"信号 → 等价于 satisfied 按钮', async () => {
    const memStore = makeMemoryStore();
    const presetSession: RehearsalSession = {
      phase: 'clarifying',
      round: 1,
      analysisMessageId: 'analysis_msg_r1',
      clarifyMessageId: 'clarify_msg_r1',
      recommendedChanges: [{ target: 'slides', text: '第 3 页补单位' }],
      lastUncertainties: ['配色'],
      startedAt: Date.now() - 30_000,
      updatedAt: Date.now() - 5_000,
    };
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify(presetSession),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(
      { type: 'message', payload: makeMessage('OK 就这样吧') },
      { memoryStore: memStore },
    );
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    // 直接 finalize：调 slides，不再发新一轮 loading 卡
    expect(ctx.slides!.createFromOutline).toHaveBeenCalled();
    const build = ctx.cardBuilder.build as unknown as ReturnType<typeof vi.fn>;
    const completedBuild = build.mock.calls.find((c) => c[0] === 'rehearsal' && c[1].isCompleted);
    expect(completedBuild).toBeDefined();
  });
});

// ── iterate 按钮 → 反问卡 ────────────────────────────────────────────────────

describe('rehearsalSkill.run() — iterate 按钮（step ④）', () => {
  it('cardAction iterate → 发反问卡（沿用 lastUncertainties）+ 更新 session.phase', async () => {
    const memStore = makeMemoryStore();
    const presetSession: RehearsalSession = {
      phase: 'analyzing',
      round: 1,
      analysisMessageId: 'analysis_msg_r1',
      recommendedChanges: [],
      lastUncertainties: ['配色是否调整', '是否补一个目录页'],
      startedAt: Date.now() - 5_000,
      updatedAt: Date.now() - 1_000,
    };
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify(presetSession),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeCardActionEvent('rehearsal.iterate'), { memoryStore: memStore });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const build = ctx.cardBuilder.build as unknown as ReturnType<typeof vi.fn>;
    const clarifyBuild = build.mock.calls.find((c) => c[0] === 'rehearsalClarify');
    expect(clarifyBuild).toBeDefined();
    expect((clarifyBuild![1] as { questions: string[] }).questions.length).toBeGreaterThan(0);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session!.phase).toBe('clarifying');
  });

  it('cardAction satisfied 但无 session → 静默 ok', async () => {
    const ctx = makeCtx(makeCardActionEvent('rehearsal.satisfied'));
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);
    expect(ctx.slides!.createFromOutline).not.toHaveBeenCalled();
  });
});

// ── metadata 验收 ────────────────────────────────────────────────────────────

describe('rehearsalSkill metadata', () => {
  it('注册元数据齐全', () => {
    expect(rehearsalSkill.name).toBe('rehearsal');
    expect(rehearsalSkill.metadata.description).toBeTruthy();
    expect(rehearsalSkill.metadata.when_to_use).toBeTruthy();
    expect(rehearsalSkill.metadata.examples.length).toBeGreaterThan(0);
  });

  it('trigger.events 同时包含 message 和 cardAction', () => {
    expect(rehearsalSkill.trigger.events).toContain('message');
    expect(rehearsalSkill.trigger.events).toContain('cardAction');
  });
});
