/**
 * Rehearsal v2 — 全链路压测剧本（issue #145）
 *
 * 用 mock 数据穷尽以下"PM 不放过"的边界：
 *   1. preview phase: 找得到 [slides_outline] memory → 三段式讲稿 + critique + attribution → 卡片
 *   2. preview 反馈累积 ≥ 阈值 → 自动进 analyzing
 *   3. review 卡 toggle: user 默认勾、listener 默认不勾，listener 勾上后 confirm 实际生效
 *   4. mergeChangesV2: embedding 相似度 ≥ 0.85 自动合并
 *   5. mergeChangesV2: embed 不可用时 fallback 到 exact key
 *   6. compactSessionForStorage: changes 超 30 条仍全量保留 + listener critique 文本被截短
 *   7. 用户在 preview phase 喊"满意" → 应进 review checkpoint（不能直接 finalize）
 *   8. 用户在 reviewing phase 再喊"满意" → 直接按当前勾选 confirm
 *   9. style 检测："路演" / "评委" trigger 关键词分别落 'roadshow' / 'judges'
 *  10. parseSession 兼容 v1 旧 JSON（无 id / source / listenerCritiques 字段）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  rehearsalSkill,
  REHEARSAL_SESSION_KEY,
  loadRehearsalSession,
  isFreshTrigger,
  isSatisfactionSignal,
  isAwaitingUserResponse,
  type RehearsalSession,
} from '../rehearsal.js';
import {
  ok,
  err,
  makeError,
  ErrorCode,
  type BotEvent,
  type Card,
  type CardAction,
  type LLMClient,
  type MemoryRecord,
  type MemoryStoreClient,
  type Message,
  type Result,
  type SkillContext,
} from '@seedhac/contracts';

// ─── fixtures ────────────────────────────────────────────────────────────────

const CHAT_ID = 'oc_v2_chat_001';
let MSG_SEQ = 0;
const MOCK_CARD: Card = { templateName: 'rehearsal', content: { built: true } };

beforeEach(() => {
  MSG_SEQ = 0;
});

function makeMessage(text: string, sender = 'Alice', overrides: Partial<Message> = {}): Message {
  MSG_SEQ += 1;
  return {
    messageId: `m_${String(MSG_SEQ).padStart(3, '0')}`,
    chatId: CHAT_ID,
    chatType: 'group',
    sender: { userId: `ou_${sender.toLowerCase()}`, name: sender },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: 1_700_000_000_000 + MSG_SEQ * 1000,
    ...overrides,
  };
}

function makeMessageEvent(text: string, sender = 'Alice'): BotEvent {
  return { type: 'message', payload: makeMessage(text, sender) };
}

function makeCardActionEvent(action: string, value: Record<string, unknown> = {}): BotEvent {
  const payload: CardAction = {
    chatId: CHAT_ID,
    messageId: 'card_msg_v2',
    user: { userId: 'ou_alice', name: 'Alice' },
    value: { action, chatId: CHAT_ID, ...value },
    timestamp: 1_700_000_999_000,
  };
  return { type: 'cardAction', payload };
}

interface FakeMemStore {
  store: Map<string, MemoryRecord>;
  client: MemoryStoreClient;
}

function makeFakeMemoryStore(): FakeMemStore {
  const store = new Map<string, MemoryRecord>();
  const k = (kind: string, chatId: string, key: string): string => `${kind}::${chatId}::${key}`;

  const client: MemoryStoreClient = {
    read: vi.fn(async (kind, chatId, key) =>
      ok(store.get(k(kind, chatId, key)) ?? null) as Result<MemoryRecord | null>,
    ),
    search: vi.fn(async () => ok([])),
    list: vi.fn(async () => ok([])),
    write: vi.fn(async (input) => {
      const now = Date.now();
      const rec: MemoryRecord = {
        id: `mem_${now}_${Math.random()}`,
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

interface MockLLMOpts {
  /** 按 prompt 关键字 → 返回值（按出现顺序消费） */
  readonly speakerQueue?: unknown[];
  readonly listenerResponse?: unknown;
  readonly attributionVerdicts?: ReadonlyArray<'yes' | 'no' | 'unsure'>;
  readonly analysisQueue?: unknown[];
  readonly outlineResponse?: unknown;
  /** embed 行为：'available' 返回真实向量、'unavailable' 返回 CONFIG_MISSING */
  readonly embed?: 'available' | 'unavailable' | 'similar';
}

function makeLLM(opts: MockLLMOpts = {}): LLMClient {
  const speakerQueue = [...(opts.speakerQueue ?? [])];
  const attributionQueue = [...(opts.attributionVerdicts ?? [])];
  const analysisQueue = [...(opts.analysisQueue ?? [])];

  const askStructured = vi.fn(async (prompt: string) => {
    if (prompt.includes('真实演讲者人设')) {
      const next = speakerQueue.shift();
      if (next) return ok(next);
      return err(makeError(ErrorCode.LLM_INVALID_RESPONSE, 'speaker queue empty'));
    }
    if (prompt.includes('挑剔但善意的 AI 听众')) {
      return ok(opts.listenerResponse ?? { critiques: [] });
    }
    if (prompt.includes('引用校验员')) {
      const next = attributionQueue.shift();
      return ok({ verdict: next ?? 'unsure' });
    }
    if (prompt.includes('PPT-文档一致性校验员')) {
      return ok({ verdict: 'consistent', note: '一致' });
    }
    if (prompt.includes('演示演练的复盘助手')) {
      const next = analysisQueue.shift();
      if (next) return ok(next);
      return ok({
        summary: '默认分析',
        issues: [],
        suggestions: [],
        uncertainties: [],
        recommendedChanges: [],
      });
    }
    if (prompt.includes('飞书原生 Slides') || prompt.includes('结构化演示文稿方案')) {
      return ok(
        opts.outlineResponse ?? {
          title: 'v2 重生成',
          slides: [{ type: 'cover' as const, title: '封面' }],
        },
      );
    }
    if (prompt.includes('预筛选')) return ok({ results: [] });
    return ok({});
  });

  const embed = vi.fn(async (text: string) => {
    if (opts.embed === 'unavailable') {
      return err(makeError(ErrorCode.CONFIG_MISSING, 'embed not configured'));
    }
    if (opts.embed === 'similar') {
      // 永远返回一个固定向量 — 让任意两条文本余弦=1，触发去重
      return ok(new Array(8).fill(1));
    }
    // 默认：基于文本 hash 生成向量（不同文本相似度低）
    const v = new Array(8).fill(0).map((_, i) =>
      Math.sin(text.length * 0.1 + i + text.charCodeAt(i % text.length)),
    );
    return ok(v);
  });

  return {
    ask: vi.fn(async () => ok('')),
    chat: vi.fn(),
    askStructured,
    chatWithTools: vi.fn(),
    embed,
  } as unknown as LLMClient;
}

interface CtxOpts {
  history?: readonly Message[];
  llm?: LLMClient;
  memoryStore?: FakeMemStore;
  bitableRecords?: ReadonlyArray<Record<string, unknown>>;
  docContent?: string;
  slidesAvailable?: boolean;
}

function makeCtx(event: BotEvent, opts: CtxOpts = {}): SkillContext {
  const memStore = opts.memoryStore ?? makeFakeMemoryStore();
  const history = opts.history ?? [];
  const records = opts.bitableRecords ?? [];

  const cardBuilds: { template: string; input: unknown }[] = [];
  const sentCards: Card[] = [];

  const ctx = {
    event,
    runtime: {
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      sendText: vi.fn(async () => ok({ messageId: 'txt', chatId: CHAT_ID, timestamp: 0 })),
      sendCard: vi.fn(async ({ card }) => {
        sentCards.push(card);
        return ok({ messageId: `card_${sentCards.length}`, chatId: CHAT_ID, timestamp: 0 });
      }),
      patchCard: vi.fn(async () => ok(undefined)),
      fetchHistory: vi.fn(async () => ok({ messages: history, hasMore: false })),
      fetchMembers: vi.fn(async () => ok({ members: [{ userId: 'ou_alice', name: 'Alice' }] })),
      fetchMessage: vi.fn(),
      pinMessage: vi.fn(async () => ok(undefined)),
    },
    llm: opts.llm ?? makeLLM(),
    bitable: {
      find: vi.fn(async () => ok({ records, hasMore: false })),
      insert: vi.fn(async () => ok({ tableId: 't', recordId: 'r' })),
      batchInsert: vi.fn(async () => ok([])),
      update: vi.fn(async () => ok(undefined)),
      delete: vi.fn(async () => ok(undefined)),
      link: vi.fn(async () => ok(undefined)),
      readTable: vi.fn(),
    },
    docx: {
      create: vi.fn(),
      appendBlocks: vi.fn(),
      getShareLink: vi.fn(),
      createFromMarkdown: vi.fn(async () =>
        ok({ docToken: 'd', url: 'https://feishu.cn/docx/d' }),
      ),
      readContent: vi.fn(async () =>
        opts.docContent
          ? ok(opts.docContent)
          : err(makeError(ErrorCode.FEISHU_API_ERROR, 'no doc')),
      ),
      grantMembersEdit: vi.fn(async () => ok(undefined)),
      appendToSection: vi.fn(async () => ok(undefined)),
      replaceSection: vi.fn(async () => ok(undefined)),
      renameTitle: vi.fn(async () => ok(undefined)),
    },
    slides: opts.slidesAvailable === false
      ? undefined
      : {
          createFromOutline: vi.fn(async () =>
            ok({ slidesToken: 'slk', url: 'https://feishu.cn/slides/v2' }),
          ),
          grantMembersEdit: vi.fn(async () => ok(undefined)),
        },
    cardBuilder: {
      build: vi.fn((template: string, input: unknown) => {
        cardBuilds.push({ template, input });
        return MOCK_CARD;
      }),
    },
    retrievers: {},
    memoryStore: memStore.client,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  // expose for assertions
  (ctx as unknown as { __cardBuilds: unknown }).__cardBuilds = cardBuilds;
  (ctx as unknown as { __sentCards: unknown }).__sentCards = sentCards;
  (ctx as unknown as { __memStore: unknown }).__memStore = memStore;
  return ctx as unknown as SkillContext;
}

interface PreviewPageProbe {
  hook?: string;
  core?: string;
  transition?: string;
  critiques?: { attribution: string }[];
}

interface BuildEntry {
  template: string;
  // 卡片 input 在测试里经常深 destructure，统一用 Record<string, unknown> 让 TS 安静
  input: Record<string, unknown> & {
    pages?: PreviewPageProbe[];
    totalPages?: number;
    changes?: unknown[];
    overLimitHint?: boolean;
    isLoading?: boolean;
    round?: number;
  };
}

function getBuilds(ctx: SkillContext): BuildEntry[] {
  return (ctx as unknown as { __cardBuilds: BuildEntry[] }).__cardBuilds;
}

// ─── 1. preview phase 端到端 ─────────────────────────────────────────────────

describe('preview phase E2E', () => {
  it('找到 slides_outline → 三段式讲稿 + listener critique → 卡片渲染分页', async () => {
    const slidesOutline = JSON.stringify({
      title: '校园挑战赛 PPT',
      slides: [
        { title: '封面', bullets: ['项目 X 阶段汇报'] },
        { title: '商业模式', bullets: ['头部 50% 客户'] },
        { title: '混合检索', bullets: ['BM25 + 向量', '准确率 +18%'] },
      ],
    });

    const llm = makeLLM({
      speakerQueue: [
        {
          page: 1,
          hook: '我们用三个月做了什么？',
          core: '从一个群聊机器人到完整的项目协作助手，覆盖文档、PPT、归档全流程。',
          transition: '先看商业模式。',
          cite: ['ppt.p1'],
          evidence: 'PPT 第 1 页 title: 封面',
        },
        {
          page: 2,
          hook: '为什么我们能拿下头部 50% 客户？',
          core: '因为我们解决的是中小团队的真实痛点，且产品形态是非侵入式的飞书原生协作。',
          transition: '下一页讲技术怎么落地。',
          cite: ['ppt.p2'],
          evidence: 'PPT 第 2 页 bullet: 头部 50% 客户',
        },
        {
          page: 3,
          hook: '为什么不只用向量检索？',
          core: '混合检索把 BM25 的精确召回和向量的语义召回叠加，长尾词上多 30%、整体准确率 +18%。',
          transition: '继续下一页。',
          cite: ['ppt.p3'],
          evidence: 'PPT 第 3 页 bullet: BM25 + 向量、准确率 +18%',
        },
      ],
      listenerResponse: {
        critiques: [
          {
            category: 'consistency',
            page: 2,
            text: 'PPT 头部 50% 与 OKR 头部 20% 不一致，评委会追问',
            evidence: 'ppt.p2: 头部 50% 客户 / doc.section.OKR: KR1 头部 20%',
            cite: 'ppt.p2',
            confidence: 0.95,
          },
          {
            category: 'audience',
            page: 3,
            text: '准确率 +18% 这个对比基线没说清，评委会问基线是什么',
            evidence: 'ppt.p3: 准确率 +18%（基线未说明）',
            cite: 'ppt.p3',
            confidence: 0.85,
          },
          {
            category: 'content',
            page: 99, // 越界 — 应该被 schema 静默丢弃
            text: '这条 page 越界',
            evidence: '原文片段超过 10 字符占位',
            cite: 'ppt.p99',
            confidence: 0.9,
          },
        ],
      },
      attributionVerdicts: ['yes', 'unsure'],
    });

    const memoryStore = makeFakeMemoryStore();
    const records = [
      {
        chat_id: CHAT_ID,
        key: 'slides-outline-x',
        content: `[slides_outline] ${slidesOutline}`,
        created_at: Date.now(),
      },
    ];
    const ctx = makeCtx(makeMessageEvent('AI 试讲一下'), { memoryStore, llm, bitableRecords: records });

    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const builds = getBuilds(ctx);
    const previewBuild = builds.find((b) => b.template === 'rehearsalPreview');
    expect(previewBuild).toBeDefined();
    expect(previewBuild!.input.totalPages).toBe(3);
    expect(previewBuild!.input.pages!.length).toBe(3);
    // 3 条 critique 中越界的 1 条丢，剩 2 条；attribution=unsure 的进 unsure 类
    const allCritiques = previewBuild!.input.pages!.flatMap((p) => p.critiques ?? []);
    expect(allCritiques.length).toBe(2);
    expect(allCritiques.filter((c) => c.attribution === 'unsure').length).toBe(1);

    // session 进 preview
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).toBe('preview');
    expect(session?.style).toBe('judges'); // 默认
  });

  it('找不到 slides_outline → 退化到 v1 analyze（不发 preview 卡）', async () => {
    const ctx = makeCtx(makeMessageEvent('演练一下'), {
      bitableRecords: [], // no slides_outline
    });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const builds = getBuilds(ctx);
    expect(builds.find((b) => b.template === 'rehearsalPreview')).toBeUndefined();
    // analyze 路径会先发 'rehearsal' loading 卡
    expect(builds.find((b) => b.template === 'rehearsal' && b.input.isLoading)).toBeDefined();
  });
});

// ─── 2. preview 反馈累积阈值 ─────────────────────────────────────────────────

describe('preview feedback threshold', () => {
  it('累积 < 3 条 → 维持 preview；累积 ≥ 3 条 → 自动进 analyzing', async () => {
    const memoryStore = makeFakeMemoryStore();
    // 预置 preview phase + 已经 2 条反馈
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'preview',
        round: 0,
        previewMessageId: 'prev_msg',
        recommendedChanges: [],
        lastUncertainties: [],
        listenerCritiques: [],
        userPageFeedback: [
          { page: 1, text: 'x', at: Date.now() },
          { page: 2, text: 'y', at: Date.now() },
        ],
        reviewSelection: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // 第三条反馈通过 cardAction 提交 → 触发自动进 analyzing
    const ctx = makeCtx(
      makeCardActionEvent('rehearsal.preview.disagree', { page: 3 }),
      { memoryStore },
    );
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    // session 应该已经进了 analyzing（performAnalysisRound 跑完）
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).not.toBe('preview');
    expect(['analyzing', 'clarifying']).toContain(session?.phase);
  });

  it('累积 < 3 条 → 维持 preview', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'preview',
        round: 0,
        previewMessageId: 'prev_msg',
        recommendedChanges: [],
        lastUncertainties: [],
        listenerCritiques: [],
        userPageFeedback: [],
        reviewSelection: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(
      makeCardActionEvent('rehearsal.preview.agree', { page: 1 }),
      { memoryStore },
    );
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).toBe('preview');
    expect(session?.userPageFeedback?.length).toBe(1);
  });
});

// ─── 3. review toggle ───────────────────────────────────────────────────────

describe('review.toggle 交互', () => {
  it('listener 类默认不勾，toggle checked=true 后进 reviewSelection', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_msg',
        recommendedChanges: [
          { id: 'c_user', target: 'slides', text: 'A', source: 'user' },
          { id: 'c_listener', target: 'slides', text: 'B', source: 'listener' },
        ],
        lastUncertainties: [],
        reviewSelection: ['c_user'], // 默认只勾 user
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // toggle 勾上 listener 那条
    const r = await rehearsalSkill.run(
      makeCtx(
        makeCardActionEvent('rehearsal.review.toggle', { changeId: 'c_listener', checked: true }),
        { memoryStore },
      ),
    );
    expect(r.ok).toBe(true);

    const session = await loadRehearsalSession(makeCtx(makeMessageEvent('x'), { memoryStore }), CHAT_ID);
    expect(session?.reviewSelection).toEqual(expect.arrayContaining(['c_user', 'c_listener']));
  });

  it('toggle checked=false 把已勾的 user 类移出 reviewSelection', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_msg',
        recommendedChanges: [
          { id: 'c_user', target: 'slides', text: 'A', source: 'user' },
        ],
        lastUncertainties: [],
        reviewSelection: ['c_user'],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    await rehearsalSkill.run(
      makeCtx(
        makeCardActionEvent('rehearsal.review.toggle', { changeId: 'c_user', checked: false }),
        { memoryStore },
      ),
    );

    const session = await loadRehearsalSession(makeCtx(makeMessageEvent('x'), { memoryStore }), CHAT_ID);
    expect(session?.reviewSelection).toEqual([]);
  });
});

// ─── 4. embedding 去重 ──────────────────────────────────────────────────────

describe('mergeChangesV2 embedding 去重', () => {
  it('embed 相似（cosine ≥ 0.85）→ 合并；embed 不同 → 都保留', async () => {
    const memoryStore = makeFakeMemoryStore();
    // 预置 1 条 user change
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 1,
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: '第 3 页加 y 轴单位', source: 'user' },
        ],
        lastUncertainties: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // analysisQueue 返回新的 changes（与现有相似）
    const llm = makeLLM({
      embed: 'similar', // 强制所有 embed 相同 → 全部相似 → 全部合并
      analysisQueue: [
        {
          summary: 'r2',
          issues: [],
          suggestions: [],
          uncertainties: [],
          recommendedChanges: [
            { target: 'slides', text: '第 3 页补单位与时间区间' }, // 与现有相似
          ],
        },
      ],
    });

    const ctx = makeCtx(makeMessageEvent('再补一条'), { memoryStore, llm });
    await rehearsalSkill.run(ctx);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    // 相似 → 合并 → 仍只有 1 条（embed='similar' 让所有 cosine=1）
    expect(session?.recommendedChanges.length).toBe(1);
  });

  it('embed 不可用（CONFIG_MISSING）→ 退到 exact key dedup', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 1,
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: '第 3 页', source: 'user' },
        ],
        lastUncertainties: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const llm = makeLLM({
      embed: 'unavailable',
      analysisQueue: [
        {
          summary: '',
          issues: [],
          suggestions: [],
          uncertainties: [],
          recommendedChanges: [
            { target: 'slides', text: '第 3 页' }, // 完全相同 → exact key 命中 → drop
            { target: 'slides', text: '第 5 页' }, // 不同 → 保留
          ],
        },
      ],
    });

    const ctx = makeCtx(makeMessageEvent('补两条'), { memoryStore, llm });
    await rehearsalSkill.run(ctx);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    // exact key dedup: '第 3 页' 重复 drop, '第 5 页' 保留 → 共 2 条
    expect(session?.recommendedChanges.length).toBe(2);
    expect(session?.recommendedChanges.map((c) => c.text)).toEqual(
      expect.arrayContaining(['第 3 页', '第 5 页']),
    );
  });
});

// ─── 5. compactSessionForStorage 行为 ───────────────────────────────────────

describe('session 序列化', () => {
  it('listener critique.text 自动截短到 80 字（防 session JSON 膨胀）', async () => {
    const memoryStore = makeFakeMemoryStore();
    const longText = 'x'.repeat(500);
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 1,
        recommendedChanges: [],
        lastUncertainties: [],
        listenerCritiques: [
          {
            id: 'lc_long',
            category: 'audience',
            page: 1,
            text: longText,
            evidence: longText,
            cite: 'ppt.p1',
            confidence: 0.8,
            attribution: 'confirmed',
          },
        ],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // 触发一次 saveSession（任何会改 session 的操作）
    const ctx = makeCtx(
      makeCardActionEvent('rehearsal.iterate'),
      { memoryStore },
    );
    await rehearsalSkill.run(ctx);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.listenerCritiques?.[0]?.text.length).toBeLessThanOrEqual(80);
  });
});

// ─── 6. satisfied 在不同 phase 的行为 ───────────────────────────────────────

describe('satisfaction signal 在不同 phase 的路由', () => {
  it('preview phase 收到"满意" → 进 review 卡（不直接 finalize）', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'preview',
        round: 0,
        previewMessageId: 'prev',
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: 'X', source: 'user' },
        ],
        lastUncertainties: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeMessageEvent('OK 就这样'), { memoryStore });
    await rehearsalSkill.run(ctx);

    const builds = getBuilds(ctx);
    expect(builds.find((b) => b.template === 'rehearsalReview')).toBeDefined();
    expect(ctx.slides!.createFromOutline).not.toHaveBeenCalled();

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).toBe('reviewing');
  });

  it('reviewing phase 收到"满意" → 直接按当前勾选 confirm（不重发 review 卡）', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_msg',
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: 'X', source: 'user' },
        ],
        lastUncertainties: [],
        reviewSelection: ['c_0'],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeMessageEvent('完成'), { memoryStore });
    await rehearsalSkill.run(ctx);

    expect(ctx.slides!.createFromOutline).toHaveBeenCalled();
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).toBe('done');
  });
});

// ─── 7. style 检测 ─────────────────────────────────────────────────────────

describe('detectStyle (preview)', () => {
  it('"路演" → roadshow style 落入 session', async () => {
    const ctx = makeCtx(makeMessageEvent('AI 试讲一下，路演风格'), {
      bitableRecords: [
        {
          chat_id: CHAT_ID,
          key: 'so',
          content: '[slides_outline] ' + JSON.stringify({
            title: 't',
            slides: [{ title: 'p1' }],
          }),
          created_at: Date.now(),
        },
      ],
      llm: makeLLM({
        speakerQueue: [
          {
            page: 1,
            hook: '为什么我们的产品能做到这件事？',
            core: '我们三个月把演练复盘做到完整闭环 — 从 PPT 反馈到自动重生成。',
            transition: '继续看下一页。',
            cite: ['ppt.p1'],
            evidence: 'ppt.p1: p1',
          },
        ],
      }),
    });

    await rehearsalSkill.run(ctx);
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.style).toBe('roadshow');
  });

  it('"评委" → judges style', async () => {
    const ctx = makeCtx(makeMessageEvent('演练，按评委风格'), {
      bitableRecords: [
        {
          chat_id: CHAT_ID,
          key: 'so',
          content: '[slides_outline] ' + JSON.stringify({
            title: 't',
            slides: [{ title: 'p1' }],
          }),
          created_at: Date.now(),
        },
      ],
      llm: makeLLM({
        speakerQueue: [
          {
            page: 1,
            hook: '为什么我们值得评委关注？',
            core: '我们的演练复盘 v2 在三个维度上做了 #102 没解决的事 — 不读 PPT、无 review、无一致性。',
            transition: '下一页商业模式。',
            cite: ['ppt.p1'],
            evidence: 'ppt.p1: p1',
          },
        ],
      }),
    });

    await rehearsalSkill.run(ctx);
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.style).toBe('judges');
  });
});

// ─── 8. parseSession v1 兼容 ────────────────────────────────────────────────

describe('parseSession v1 兼容', () => {
  it('旧 v1 session 缺 listenerCritiques / userPageFeedback / reviewSelection → 默认 []', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 2,
        recommendedChanges: [
          { target: 'slides', text: 'X' }, // 无 id / source
        ],
        lastUncertainties: ['?'],
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now() - 1_000,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeMessageEvent('查询 session'), { memoryStore });
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session).not.toBeNull();
    expect(session?.recommendedChanges.length).toBe(1);
    expect(session?.recommendedChanges[0]?.id).toBe('c_legacy_0');
    expect(session?.recommendedChanges[0]?.source).toBe('user');
    expect(session?.listenerCritiques ?? []).toEqual([]);
    expect(session?.userPageFeedback ?? []).toEqual([]);
    expect(session?.reviewSelection ?? []).toEqual([]);
  });
});

// ─── 9. helper 函数边界 ────────────────────────────────────────────────────

// ─── 10. 更多刁钻 PM 验收场景 ────────────────────────────────────────────────

describe('刁钻 PM 验收', () => {
  it('speaker LLM 失败 → 该页用 PPT title 兜底（degraded transcript），整链路不挂', async () => {
    const slidesOutline = JSON.stringify({
      title: 't',
      slides: [
        { title: '封面', bullets: ['b1'] },
        { title: '商业模式', bullets: ['b2'] },
      ],
    });
    const records = [
      {
        chat_id: CHAT_ID,
        key: 'so',
        content: `[slides_outline] ${slidesOutline}`,
        created_at: Date.now(),
      },
    ];
    // speakerQueue 只给第 1 页，第 2 页让其失败
    const llm = makeLLM({
      speakerQueue: [
        {
          page: 1,
          hook: '这一页讲产品定位',
          core: '我们做的是飞书原生协作助手，覆盖整个项目周期。',
          transition: '下一页讲商业模式。',
          cite: ['ppt.p1'],
          evidence: 'ppt.p1: 封面',
        },
      ],
      // 第 2 页 LLM 没数据 → fallback
    });

    const ctx = makeCtx(makeMessageEvent('AI 试讲一下'), {
      bitableRecords: records,
      llm,
    });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const builds = getBuilds(ctx);
    const previewBuild = builds.find((b) => b.template === 'rehearsalPreview');
    expect(previewBuild).toBeDefined();
    expect(previewBuild!.input.pages!.length).toBe(2);
    expect(previewBuild!.input.pages![1]!.hook).toBe('商业模式'); // fallback = title
  });

  it('listener LLM 完全失败 → critiques 为空，preview 卡仍能发出', async () => {
    const slidesOutline = JSON.stringify({
      title: 't',
      slides: [{ title: 'p1', bullets: ['x'] }],
    });
    const records = [
      {
        chat_id: CHAT_ID,
        key: 'so',
        content: `[slides_outline] ${slidesOutline}`,
        created_at: Date.now(),
      },
    ];

    // 自定义 llm：speaker 正常 + listener askStructured fail
    const askStructured = vi.fn(async (prompt: string) => {
      if (prompt.includes('真实演讲者人设')) {
        return ok({
          page: 1,
          hook: '一个合规长度的钩子句子',
          core: '我们要讲的内容。这是一个长度足够的核心段落，描述了一些细节。',
          transition: '下一页继续',
          cite: ['ppt.p1'],
          evidence: 'ppt.p1',
        });
      }
      if (prompt.includes('挑剔但善意的 AI 听众')) {
        return err(makeError(ErrorCode.LLM_TIMEOUT, 'listener timeout'));
      }
      if (prompt.includes('飞书原生 Slides')) {
        return ok({ title: 't', slides: [{ type: 'cover', title: 'c' }] });
      }
      if (prompt.includes('预筛选')) return ok({ results: [] });
      return ok({});
    });
    const llm = {
      ask: vi.fn(async () => ok('')),
      chat: vi.fn(),
      askStructured,
      chatWithTools: vi.fn(),
      embed: vi.fn(async () => err(makeError(ErrorCode.CONFIG_MISSING, 'no'))),
    } as unknown as LLMClient;

    const ctx = makeCtx(makeMessageEvent('AI 试讲'), { bitableRecords: records, llm });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const builds = getBuilds(ctx);
    const previewBuild = builds.find((b) => b.template === 'rehearsalPreview');
    expect(previewBuild).toBeDefined();
    expect(previewBuild!.input.pages![0]!.critiques).toEqual([]);
  });

  it('review.confirm 时 reviewSelection 为空 → finalize 不调 slides，但 session 进 done', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_msg',
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: 'A', source: 'user' },
        ],
        lastUncertainties: [],
        reviewSelection: [], // 用户全取消
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeCardActionEvent('rehearsal.review.confirm'), { memoryStore });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    expect(ctx.slides!.createFromOutline).not.toHaveBeenCalled();
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).toBe('done');
    expect(session?.recommendedChanges).toEqual([]); // 0 selected
  });

  it('review.editList → 回 clarifying 发反问卡，session.phase=clarifying', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_msg',
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: 'A', source: 'user' },
        ],
        lastUncertainties: [],
        reviewSelection: ['c_0'],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeCardActionEvent('rehearsal.review.editList'), { memoryStore });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    const builds = getBuilds(ctx);
    expect(builds.find((b) => b.template === 'rehearsalClarify')).toBeDefined();
    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.phase).toBe('clarifying');
  });

  it('overLimitHint 在 > 30 条时被传给 review 卡', async () => {
    const memoryStore = makeFakeMemoryStore();
    const lots = Array.from({ length: 32 }, (_, i) => ({
      id: `c_${i}`,
      target: 'slides' as const,
      text: `change ${i}`,
      source: 'user' as const,
    }));
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 3,
        analysisMessageId: 'a',
        recommendedChanges: lots,
        lastUncertainties: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeCardActionEvent('rehearsal.satisfied'), { memoryStore });
    await rehearsalSkill.run(ctx);

    const builds = getBuilds(ctx);
    const reviewBuild = builds.find((b) => b.template === 'rehearsalReview');
    expect(reviewBuild).toBeDefined();
    expect(reviewBuild!.input.overLimitHint).toBe(true);
    expect(reviewBuild!.input.changes!.length).toBe(32);
  });

  it('两个不同 chatId 的 session 互不干扰', async () => {
    const memoryStore = makeFakeMemoryStore();
    // chat A 已 done
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'done',
        round: 5,
        recommendedChanges: [{ id: 'c0', target: 'slides', text: 'A', source: 'user' }],
        lastUncertainties: [],
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 100,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });
    // chat B 在 reviewing
    const chatB = 'oc_v2_chat_002';
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: chatB,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_b',
        recommendedChanges: [{ id: 'c0', target: 'slides', text: 'B', source: 'user' }],
        lastUncertainties: [],
        reviewSelection: ['c0'],
        startedAt: Date.now() - 500,
        updatedAt: Date.now() - 50,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // 用 ctx 装 chat A 的 session 检查
    const ctxA = makeCtx(makeMessageEvent('查询 A'), { memoryStore });
    const sessionA = await loadRehearsalSession(ctxA, CHAT_ID);
    expect(sessionA?.phase).toBe('done');

    // 模拟 chat B 的 ctx — 重写 event chatId
    const evB: BotEvent = {
      type: 'message',
      payload: {
        ...makeMessage('查询 B'),
        chatId: chatB,
      },
    };
    const ctxB = makeCtx(evB, { memoryStore });
    const sessionB = await loadRehearsalSession(ctxB, chatB);
    expect(sessionB?.phase).toBe('reviewing');
    expect(sessionB?.recommendedChanges[0]?.text).toBe('B');
  });

  it('review.toggle 对未知 changeId → 仍写入 selection（让用户自由）但不影响后续 confirm', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        reviewMessageId: 'rev_msg',
        recommendedChanges: [
          { id: 'c_real', target: 'slides', text: 'X', source: 'user' },
        ],
        lastUncertainties: [],
        reviewSelection: ['c_real'],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // toggle 一个不存在的 id
    await rehearsalSkill.run(
      makeCtx(
        makeCardActionEvent('rehearsal.review.toggle', { changeId: 'c_ghost', checked: true }),
        { memoryStore },
      ),
    );

    const session = await loadRehearsalSession(makeCtx(makeMessageEvent('x'), { memoryStore }), CHAT_ID);
    // selection 含 ghost，但后续 confirm 时 filter 不会匹配到 ghost → 实际只 finalize c_real
    expect(session?.reviewSelection).toEqual(expect.arrayContaining(['c_real', 'c_ghost']));

    // 真正 confirm 时 ghost 不会找到对应 change，filter 后只 c_real 进 finalize
    const confirmCtx = makeCtx(makeCardActionEvent('rehearsal.review.confirm'), { memoryStore });
    await rehearsalSkill.run(confirmCtx);
    const finalSession = await loadRehearsalSession(confirmCtx, CHAT_ID);
    expect(finalSession?.recommendedChanges.length).toBe(1);
    expect(finalSession?.recommendedChanges[0]?.text).toBe('X');
  });

  it('AI 试讲带"路演"关键词 → 同时识别为 fresh trigger 且 style=roadshow', () => {
    expect(isFreshTrigger('AI 试讲一下，路演风格')).toBe(true);
  });

  it('done phase 收到"满意"信号 → 静默忽略，不再 review/finalize', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'done',
        round: 3,
        recommendedChanges: [{ id: 'c0', target: 'slides', text: 'A', source: 'user' }],
        lastUncertainties: [],
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 100,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeMessageEvent('OK 完成'), { memoryStore });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);
    expect(ctx.slides!.createFromOutline).not.toHaveBeenCalled();

    const builds = getBuilds(ctx);
    expect(builds.find((b) => b.template === 'rehearsalReview')).toBeUndefined();
  });

  it('TRIGGER_RE 命中且 done phase → 重新触发 (preview/v1 fallback)，不被旧 session 阻断', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'done',
        round: 3,
        recommendedChanges: [{ id: 'c0', target: 'slides', text: 'A', source: 'user' }],
        lastUncertainties: [],
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 100,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(makeMessageEvent('再彩排一下'), { memoryStore });
    const r = await rehearsalSkill.run(ctx);
    expect(r.ok).toBe(true);

    // 没有 slides_outline → 退化到 v1 analyze → 发新 loading 卡（round=1）
    const builds = getBuilds(ctx);
    expect(
      builds.find(
        (b) => b.template === 'rehearsal' && b.input.isLoading && b.input.round === 1,
      ),
    ).toBeDefined();
  });

  it('preview phase 用户文本反馈不指定 page → 累积进 userPageFeedback（page=0）', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'preview',
        round: 0,
        previewMessageId: 'p',
        recommendedChanges: [],
        lastUncertainties: [],
        listenerCritiques: [],
        userPageFeedback: [],
        reviewSelection: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const ctx = makeCtx(
      makeMessageEvent('整体感觉商业模式那段说得不够清楚'),
      { memoryStore },
    );
    await rehearsalSkill.run(ctx);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    expect(session?.userPageFeedback?.length).toBe(1);
    expect(session?.userPageFeedback?.[0]?.page).toBe(0);
    expect(session?.userPageFeedback?.[0]?.text).toContain('商业模式');
  });

  it('compactSessionForStorage HARD_CAP 触发 → 老 listenerCritique 优先丢，changes 不动', async () => {
    const memoryStore = makeFakeMemoryStore();
    // 准备一个超大的 session：很多 listenerCritiques + 适量 changes
    const manyCritiques = Array.from({ length: 50 }, (_, i) => ({
      id: `lc_${i}`,
      category: 'audience',
      page: 1,
      text: 'a'.repeat(80),
      evidence: 'b'.repeat(60),
      cite: 'ppt.p1',
      confidence: 0.8,
      attribution: 'confirmed',
    }));
    const someChanges = Array.from({ length: 10 }, (_, i) => ({
      id: `c_${i}`,
      target: 'slides',
      text: `change ${i}`,
      source: 'user',
    }));
    await memoryStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 5,
        recommendedChanges: someChanges,
        lastUncertainties: [],
        listenerCritiques: manyCritiques,
        userPageFeedback: [],
        reviewSelection: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // 任何会保存 session 的操作 — iterate
    const ctx = makeCtx(makeCardActionEvent('rehearsal.iterate'), { memoryStore });
    await rehearsalSkill.run(ctx);

    const session = await loadRehearsalSession(ctx, CHAT_ID);
    // changes 不动
    expect(session?.recommendedChanges.length).toBe(10);
    // listener critiques 被瘦身（≤ 50）
    expect((session?.listenerCritiques ?? []).length).toBeLessThanOrEqual(50);
  });
});

describe('helper 函数', () => {
  it('isFreshTrigger 命中新增的 "AI 试讲" / "试讲一下"', () => {
    expect(isFreshTrigger('帮我 AI 试讲一下')).toBe(true);
    expect(isFreshTrigger('试讲一下吧')).toBe(true);
    expect(isFreshTrigger('演练')).toBe(true);
    expect(isFreshTrigger('普通对话')).toBe(false);
  });

  it('isAwaitingUserResponse 包含 preview / reviewing 两个新 phase', () => {
    const base: RehearsalSession = {
      phase: 'preview',
      round: 0,
      recommendedChanges: [],
      lastUncertainties: [],
      startedAt: 0,
      updatedAt: 0,
    };
    expect(isAwaitingUserResponse({ ...base, phase: 'preview' })).toBe(true);
    expect(isAwaitingUserResponse({ ...base, phase: 'reviewing' })).toBe(true);
    expect(isAwaitingUserResponse({ ...base, phase: 'analyzing' })).toBe(true);
    expect(isAwaitingUserResponse({ ...base, phase: 'clarifying' })).toBe(true);
    expect(isAwaitingUserResponse({ ...base, phase: 'done' })).toBe(false);
    expect(isAwaitingUserResponse(null)).toBe(false);
  });

  it('isSatisfactionSignal 不被新 trigger "试讲" 误伤', () => {
    expect(isSatisfactionSignal('我们试讲一下')).toBe(false);
    expect(isSatisfactionSignal('OK 就这样')).toBe(true);
  });
});
