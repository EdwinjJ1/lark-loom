/**
 * rehearsal E2E 模拟（issue #102）
 *
 * 用真实的 larkCardBuilder 渲染卡片，配合 in-memory bot runtime 把整条主链路
 * 跑通：fresh trigger → 多轮反问 → 满意 → step ⑤ 重生成。
 *
 * 这套测试做两件事：
 *   1. 验证 wiring + skill + card-builder 三者拼起来时的真实行为
 *   2. dump 卡片 markdown 让我（claude）能直观确认输出文案不掉链子
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rehearsalSkill, REHEARSAL_SESSION_KEY } from '@seedhac/skills';
import {
  ok,
  type BotEvent,
  type BotRuntime,
  type Card,
  type CardAction,
  type LLMClient,
  type Message,
  type MemoryRecord,
  type MemoryStoreClient,
  type Result,
  type SentMessage,
  type SkillContext,
} from '@seedhac/contracts';
import { larkCardBuilder } from '../card-builder.js';

// ── In-memory bot runtime（捕获所有 sendCard / patchCard / sendText）─────────

interface CardLog {
  readonly messageId: string;
  readonly templateName: string;
  readonly card: Card;
  readonly op: 'send' | 'patch';
}

function makeFakeRuntime(history: Message[]): {
  runtime: BotRuntime;
  cards: CardLog[];
  texts: string[];
} {
  const cards: CardLog[] = [];
  const texts: string[] = [];
  let seq = 0;

  const runtime: BotRuntime = {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn(async (params) => {
      texts.push(params.text);
      return ok({ messageId: `txt_${++seq}`, chatId: params.chatId, timestamp: Date.now() });
    }),
    sendCard: vi.fn(async (params) => {
      const messageId = `card_${++seq}`;
      cards.push({
        messageId,
        templateName: params.card.templateName,
        card: params.card,
        op: 'send',
      });
      return ok({ messageId, chatId: params.chatId, timestamp: Date.now() }) as Result<SentMessage>;
    }),
    patchCard: vi.fn(async (params) => {
      cards.push({
        messageId: params.messageId,
        templateName: params.card.templateName,
        card: params.card,
        op: 'patch',
      });
      return ok(undefined);
    }),
    fetchHistory: vi.fn().mockResolvedValue(ok({ messages: history, hasMore: false })),
    fetchMembers: vi.fn().mockResolvedValue(
      ok({
        members: [
          { userId: 'ou_a', name: 'Alice' },
          { userId: 'ou_b', name: 'Bob' },
        ],
      }),
    ),
    fetchMessage: vi.fn(),
    pinMessage: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as BotRuntime;

  return { runtime, cards, texts };
}

// ── In-memory memoryStore ───────────────────────────────────────────────────

function makeFakeMemoryStore(): {
  store: Map<string, MemoryRecord>;
  client: MemoryStoreClient;
} {
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

// ── LLM mock：rehearsal 用 system prompt 字符串当 discriminator ────────────

interface LlmFixtures {
  readonly analysisQueue: unknown[];
  readonly outline?: unknown;
  readonly relevance?: unknown;
}

function makeFakeLLM(fixtures: LlmFixtures): {
  llm: LLMClient;
  promptLog: string[];
} {
  const promptLog: string[] = [];
  const queue = [...fixtures.analysisQueue];

  const askStructured = vi.fn(async (prompt: string) => {
    promptLog.push(prompt.slice(0, 200));
    if (prompt.includes('演示演练的复盘助手')) {
      return ok(queue.shift() ?? {});
    }
    if (prompt.includes('飞书原生 Slides') || prompt.includes('结构化演示文稿方案')) {
      return ok(
        fixtures.outline ?? {
          title: '演练复盘新版',
          slides: [
            { type: 'cover', title: '封面', presenterName: 'Alice' },
            { type: 'overview', title: '商业模式（已优化）', bullets: ['问题', '解法', '盈利'], presenterName: 'Bob' },
            { type: 'closing', title: '结束', presenterName: 'Alice' },
          ],
        },
      );
    }
    if (prompt.includes('预筛选')) {
      return ok(fixtures.relevance ?? { results: [] });
    }
    return ok({});
  });

  return {
    llm: {
      ask: vi.fn(),
      chat: vi.fn(),
      askStructured,
      chatWithTools: vi.fn(),
      embed: vi.fn(),
    } as unknown as LLMClient,
    promptLog,
  };
}

// ── 完整 SkillContext 工厂 ──────────────────────────────────────────────────

const CHAT_ID = 'oc_e2e_001';
let MSG_SEQ = 0;

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

interface E2ECtx {
  readonly ctx: SkillContext;
  readonly cards: CardLog[];
  readonly texts: string[];
  readonly memStore: ReturnType<typeof makeFakeMemoryStore>;
  readonly bitableInserts: { row: Record<string, unknown> }[];
}

function makeE2ECtx(
  event: BotEvent,
  history: Message[],
  fixtures: LlmFixtures,
  reuseMemStore?: ReturnType<typeof makeFakeMemoryStore>,
): E2ECtx {
  const { runtime, cards, texts } = makeFakeRuntime(history);
  const { llm } = makeFakeLLM(fixtures);
  const memStore = reuseMemStore ?? makeFakeMemoryStore();
  const bitableInserts: { row: Record<string, unknown> }[] = [];

  const bitable = {
    find: vi.fn().mockResolvedValue(ok({ records: [], hasMore: false })),
    insert: vi.fn(async (params: { row: Record<string, unknown> }) => {
      bitableInserts.push({ row: params.row });
      return ok({ tableId: 't', recordId: `r_${bitableInserts.length}` });
    }),
    batchInsert: vi.fn().mockResolvedValue(ok([])),
    update: vi.fn().mockResolvedValue(ok(undefined)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    link: vi.fn().mockResolvedValue(ok(undefined)),
    readTable: vi.fn(),
  } as unknown as SkillContext['bitable'];

  const docx = {
    create: vi.fn(),
    appendBlocks: vi.fn(),
    getShareLink: vi.fn(),
    createFromMarkdown: vi
      .fn()
      .mockResolvedValue(ok({ docToken: 'd_e2e', url: 'https://feishu.cn/docx/d_e2e' })),
    readContent: vi.fn(),
    grantMembersEdit: vi.fn().mockResolvedValue(ok(undefined)),
    appendToSection: vi.fn(),
    replaceSection: vi.fn(),
    renameTitle: vi.fn(),
  } as unknown as SkillContext['docx'];

  const slides = {
    createFromOutline: vi.fn().mockResolvedValue(
      ok({ slidesToken: 'slk_new', url: 'https://feishu.cn/slides/new' }),
    ),
    grantMembersEdit: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as NonNullable<SkillContext['slides']>;

  const ctx = {
    event,
    runtime,
    llm,
    bitable,
    docx,
    slides,
    cardBuilder: larkCardBuilder, // ← 真实 builder，不再 mock
    retrievers: {},
    memoryStore: memStore.client,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  return { ctx: ctx as unknown as SkillContext, cards, texts, memStore, bitableInserts };
}

function makeMessageEvent(text: string, sender = 'Alice'): BotEvent {
  return { type: 'message', payload: makeMessage(text, sender) };
}

function makeCardActionEvent(action: string): BotEvent {
  const payload: CardAction = {
    chatId: CHAT_ID,
    messageId: 'card_1',
    user: { userId: 'ou_alice', name: 'Alice' },
    value: { action, chatId: CHAT_ID, round: 1 },
    timestamp: Date.now(),
  };
  return { type: 'cardAction', payload };
}

// ── Card content extractor（用于校验渲染结果）───────────────────────────────

interface CardSnapshot {
  templateName: string;
  headerTitle: string;
  bodyText: string;
  buttons: { text: string; action: string }[];
}

function snapshotCard(card: Card): CardSnapshot {
  const content = card.content as {
    header?: { title?: { content?: string } };
    body?: { elements?: unknown[] };
  };
  const headerTitle = String(content.header?.title?.content ?? '');
  const elements = (content.body?.elements ?? []) as Array<{
    tag?: string;
    content?: string;
    text?: { content?: string };
    behaviors?: Array<{ value?: { action?: string } }>;
  }>;

  const bodyText = elements
    .filter((e) => e.tag === 'markdown')
    .map((e) => e.content ?? '')
    .join('\n');

  const buttons = elements
    .filter((e) => e.tag === 'button')
    .map((e) => ({
      text: String(e.text?.content ?? ''),
      action: String(e.behaviors?.[0]?.value?.action ?? 'open_url'),
    }));

  return { templateName: card.templateName, headerTitle, bodyText, buttons };
}

function dumpCards(cards: CardLog[], label: string): void {
  if (process.env['REHEARSAL_E2E_DUMP'] !== '1') return;
  // 仅当显式打开时打印（避免污染普通测试输出）
  console.info(`\n──── ${label} ────`);
  for (const c of cards) {
    const s = snapshotCard(c.card);
    console.info(
      `[${c.op}] ${s.templateName} (${c.messageId})\n  header: ${s.headerTitle}\n  body:\n${s.bodyText
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')}\n  buttons: ${JSON.stringify(s.buttons)}\n`,
    );
  }
}

beforeEach(() => {
  MSG_SEQ = 0;
});

// ── 测试用 fixtures ─────────────────────────────────────────────────────────

const REHEARSAL_HISTORY: Message[] = [
  makeMessage('我们刚才彩排了一遍，开头节奏太快听不清', 'Alice'),
  makeMessage('对，第 3 页那张数据图缺 y 轴单位', 'Bob'),
  makeMessage('字体感觉也偏小，但具体哪页我没记', 'Alice'),
];

const ANALYSIS_R1 = {
  summary: '演示在结构、内容、时间三个维度有问题：节奏过快、图表缺单位、开头时间过长。建议结论先行 + 补标注 + 压缩开场。',
  issues: [
    {
      text: '在讲开头那段（Situation），节奏过快没有缓冲（Behavior），听众反馈跟不上（Impact）',
      dimension: '结构',
      confidence: 0.9,
    },
    {
      text: '在第 3 页数据图（Situation），缺少 y 轴单位（Behavior），听众无法判断量级（Impact）',
      dimension: '内容',
      confidence: 0.95,
    },
  ],
  suggestions: [
    { text: '开头压缩到 30 秒，留出节奏缓冲', dimension: '时间', confidence: 0.85 },
    { text: '第 3 页补 y 轴单位与时间区间', dimension: '内容', confidence: 0.9 },
  ],
  uncertainties: ['字体偏小，但用户未指明哪一页'],
  recommendedChanges: [
    { target: 'slides', text: '第 3 页：补 y 轴单位与时间区间' },
    { target: 'slides', text: '开头压缩到 30 秒' },
  ],
};

const ANALYSIS_R2 = {
  summary: '第二轮反馈聚焦字体：用户确认是第 5 页字体偏小。',
  issues: [
    {
      text: '在第 5 页（Situation），字体偏小（Behavior），后排听众看不清（Impact）',
      dimension: '结构',
      confidence: 0.85,
    },
  ],
  suggestions: [
    { text: '第 5 页字体调到 24pt 以上', dimension: '结构', confidence: 0.85 },
  ],
  uncertainties: [],
  recommendedChanges: [{ target: 'slides', text: '第 5 页：字体调到 24pt 以上' }],
};

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 A：fresh trigger → 反问回复 → 满意（文本）
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E 剧本 A：fresh trigger → 文本反馈 → 文本满意', () => {
  it('完整跑通三轮交互，最终生成新版 PPT 卡 + 完成态', async () => {
    const memStore = makeFakeMemoryStore();

    // ──— 第 1 步：用户发起演练 ─────────────────────────────────
    const step1 = makeE2ECtx(
      makeMessageEvent('我们刚才演练完了，帮我分析下问题'),
      REHEARSAL_HISTORY,
      { analysisQueue: [ANALYSIS_R1] },
      memStore,
    );
    const r1 = await rehearsalSkill.run(step1.ctx);
    expect(r1.ok).toBe(true);
    dumpCards(step1.cards, '剧本A 第1步');

    // 卡片顺序：loading（send） → final analysis（patch） → clarify（send）
    expect(step1.cards.length).toBe(3);
    const loading = step1.cards[0]!;
    expect(loading.op).toBe('send');
    expect(snapshotCard(loading.card).headerTitle).toBe('演练复盘分析中…');

    const finalAnalysis = step1.cards[1]!;
    expect(finalAnalysis.op).toBe('patch');
    expect(finalAnalysis.messageId).toBe(loading.messageId); // 同一张卡 patch
    const finalSnap = snapshotCard(finalAnalysis.card);
    expect(finalSnap.headerTitle).toBe('演练复盘分析结果');
    expect(finalSnap.bodyText).toContain('节奏过快');
    expect(finalSnap.bodyText).toContain('第 3 页');
    // 五维分组渲染：每条 issue 都归到对应维度标题下
    expect(finalSnap.bodyText).toMatch(/(?:🏗|📝)\s\*\*(?:结构|内容)\*\*/u);
    expect(finalSnap.bodyText).toContain('字体偏小'); // uncertainty 有展示
    expect(finalSnap.buttons.map((b) => b.action)).toEqual([
      'rehearsal.satisfied',
      'rehearsal.iterate',
    ]);

    const clarify = step1.cards[2]!;
    expect(clarify.op).toBe('send');
    expect(clarify.templateName).toBe('rehearsalClarify');
    const clarifySnap = snapshotCard(clarify.card);
    expect(clarifySnap.bodyText).toContain('字体偏小'); // uncertainty 转为问题

    // ──— 第 2 步：用户回复反问 ─────────────────────────────────
    const step2 = makeE2ECtx(
      makeMessageEvent('字体偏小是第 5 页那个 bullet list', 'Alice'),
      REHEARSAL_HISTORY,
      { analysisQueue: [ANALYSIS_R2] },
      memStore,
    );
    const r2 = await rehearsalSkill.run(step2.ctx);
    expect(r2.ok).toBe(true);
    dumpCards(step2.cards, '剧本A 第2步');

    // 第 2 步卡片：reply ack → loading r2 → final r2（无 uncertainty 不发反问卡）
    const ackCard = step2.cards.find((c) => c.templateName === 'rehearsalClarify');
    expect(ackCard).toBeDefined();
    expect(snapshotCard(ackCard!.card).headerTitle).toBe('已收到反馈');

    const r2Final = step2.cards.find(
      (c) => c.op === 'patch' && c.templateName === 'rehearsal' && !c.card.content,
    );
    // patch 应该到一个新的 loading messageId（round 2 的）
    const r2Loading = step2.cards.find(
      (c) => c.op === 'send' && c.templateName === 'rehearsal',
    );
    expect(r2Loading).toBeDefined();
    void r2Final;

    // session round 应该 = 2
    const sessionRec = await memStore.client.read(
      'skill_log',
      CHAT_ID,
      REHEARSAL_SESSION_KEY,
    );
    expect(sessionRec.ok).toBe(true);
    if (sessionRec.ok && sessionRec.value) {
      const session = JSON.parse(sessionRec.value.content) as {
        round: number;
        recommendedChanges: { target: string; text: string }[];
        phase: string;
      };
      expect(session.round).toBe(2);
      // 累积：r1 的 2 条 + r2 的 1 条 = 3
      expect(session.recommendedChanges.length).toBe(3);
      expect(session.phase).toBe('analyzing'); // r2 没 uncertainty
    }

    // ──— 第 3 步：用户文本"OK 就这样" → v2 走 review checkpoint（不直接 finalize）──
    const step3 = makeE2ECtx(
      makeMessageEvent('OK 就这样'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] }, // review 不调分析 LLM
      memStore,
    );
    const r3 = await rehearsalSkill.run(step3.ctx);
    expect(r3.ok).toBe(true);
    dumpCards(step3.cards, '剧本A 第3步 review');
    // v2: 发 review 卡，未生成新 PPT
    expect(step3.cards.find((c) => c.templateName === 'rehearsalReview')).toBeDefined();
    expect(step3.ctx.slides!.createFromOutline).not.toHaveBeenCalled();

    // ──— 第 4 步：用户在 review 卡点全部确认 → finalize ──────────────────
    const step4 = makeE2ECtx(
      makeCardActionEvent('rehearsal.review.confirm'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    const r4 = await rehearsalSkill.run(step4.ctx);
    expect(r4.ok).toBe(true);
    dumpCards(step4.cards, '剧本A 第4步 review.confirm');

    // 完成态：patch rehearsal 卡为 isCompleted；发新的 slides 卡
    const completedPatch = step4.cards.find(
      (c) => c.op === 'patch' && c.templateName === 'rehearsal',
    );
    expect(completedPatch).toBeDefined();
    const completedSnap = snapshotCard(completedPatch!.card);
    expect(completedSnap.headerTitle).toBe('演练复盘已完成 🎉');
    expect(completedSnap.bodyText).toContain('演练复盘已完成');
    expect(completedSnap.buttons.find((b) => b.text === '打开新版 PPT')).toBeDefined();

    const slidesCard = step4.cards.find(
      (c) => c.op === 'send' && c.templateName === 'slides',
    );
    expect(slidesCard).toBeDefined();

    // 调过 slides + docx
    expect(step4.ctx.slides!.createFromOutline).toHaveBeenCalled();
    expect(step4.ctx.docx.createFromMarkdown).not.toHaveBeenCalled(); // 这轮无 doc 类改动

    // session phase = done
    const finalSession = await memStore.client.read(
      'skill_log',
      CHAT_ID,
      REHEARSAL_SESSION_KEY,
    );
    expect(finalSession.ok).toBe(true);
    if (finalSession.ok && finalSession.value) {
      const s = JSON.parse(finalSession.value.content) as { phase: string };
      expect(s.phase).toBe('done');
    }

    // 写过 [演练复盘] project memory
    const projectMem = step4.bitableInserts.find(
      (x) =>
        x.row['kind'] === 'project' && String(x.row['content']).includes('[演练复盘]'),
    );
    expect(projectMem).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 B：fresh trigger → "继续修改"按钮 → 文本反馈 → "满意，完成"按钮
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E 剧本 B：按钮驱动的多轮循环', () => {
  it('iterate 按钮发反问卡，satisfied 按钮 finalize', async () => {
    const memStore = makeFakeMemoryStore();

    // 第 1 步
    const step1 = makeE2ECtx(
      makeMessageEvent('彩排完毕，分析问题'),
      REHEARSAL_HISTORY,
      { analysisQueue: [{ ...ANALYSIS_R1, uncertainties: [] }] }, // 不出反问卡
      memStore,
    );
    await rehearsalSkill.run(step1.ctx);

    // 第 2 步：点继续修改
    const step2 = makeE2ECtx(
      makeCardActionEvent('rehearsal.iterate'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    const r2 = await rehearsalSkill.run(step2.ctx);
    expect(r2.ok).toBe(true);
    dumpCards(step2.cards, '剧本B 第2步 iterate');
    // 应该发出反问卡（用通用问题，因 lastUncertainties 为空）
    const clarify = step2.cards.find((c) => c.templateName === 'rehearsalClarify');
    expect(clarify).toBeDefined();
    const clarifySnap = snapshotCard(clarify!.card);
    expect(clarifySnap.headerTitle).toContain('反问');
    expect(clarifySnap.bodyText).toContain('哪一页');

    // 第 3 步：用户回复反问（增量反馈）
    const step3 = makeE2ECtx(
      makeMessageEvent('第 5 页字体太小，调大一点'),
      REHEARSAL_HISTORY,
      { analysisQueue: [ANALYSIS_R2] },
      memStore,
    );
    await rehearsalSkill.run(step3.ctx);

    // 第 4 步：点满意按钮 → v2 review 卡
    const step4 = makeE2ECtx(
      makeCardActionEvent('rehearsal.satisfied'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    const r4 = await rehearsalSkill.run(step4.ctx);
    expect(r4.ok).toBe(true);
    dumpCards(step4.cards, '剧本B 第4步 review');
    expect(step4.cards.find((c) => c.templateName === 'rehearsalReview')).toBeDefined();
    expect(step4.ctx.slides!.createFromOutline).not.toHaveBeenCalled();

    // 第 5 步：review.confirm → 真正 finalize
    const step5 = makeE2ECtx(
      makeCardActionEvent('rehearsal.review.confirm'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    const r5 = await rehearsalSkill.run(step5.ctx);
    expect(r5.ok).toBe(true);
    dumpCards(step5.cards, '剧本B 第5步 review.confirm');

    // 验证最终发了完成卡 + slides 卡
    expect(step5.cards.find((c) => c.op === 'send' && c.templateName === 'slides')).toBeDefined();
    const completed = step5.cards.find(
      (c) => c.op === 'patch' && c.templateName === 'rehearsal',
    );
    expect(completed).toBeDefined();
    expect(snapshotCard(completed!.card).headerTitle).toBe('演练复盘已完成 🎉');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 C：群聊全是闲聊，分析返回空 → 不发反问，让用户判断
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E 剧本 C：闲聊场景的反幻觉降级', () => {
  it('无真实反馈时不编造问题，不发反问卡', async () => {
    const chatHistory: Message[] = [
      makeMessage('大家辛苦了', 'Alice'),
      makeMessage('走，吃饭去', 'Bob'),
      makeMessage('演练？', 'Alice'),
    ];

    const emptyAnalysis = {
      summary: '本轮群聊未识别到与演示演练相关的反馈。',
      issues: [],
      suggestions: [],
      uncertainties: [],
      recommendedChanges: [],
    };

    const e2e = makeE2ECtx(
      makeMessageEvent('演练'),
      chatHistory,
      { analysisQueue: [emptyAnalysis] },
    );
    const r = await rehearsalSkill.run(e2e.ctx);
    expect(r.ok).toBe(true);
    dumpCards(e2e.cards, '剧本C 闲聊');

    expect(e2e.cards.length).toBe(2); // loading + final，没 clarify
    const final = e2e.cards[1]!;
    const finalSnap = snapshotCard(final.card);
    // 不能说"演示表现良好"（false reassurance），改成中性引导
    expect(finalSnap.bodyText).toContain('暂未在群聊中识别到具体反馈');
    expect(finalSnap.bodyText).not.toContain('演示整体表现良好');
    // 按钮仍然挂着，让用户决定满意还是继续提
    expect(finalSnap.buttons.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 D：满意时只有 doc 类改动 → 跳过 PPT 重生成
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E 剧本 D：纯 doc 改动 finalize', () => {
  it('只有 doc 类 recommendedChanges 时不调 slides，但发汇报文档卡', async () => {
    const memStore = makeFakeMemoryStore();

    const docOnlyAnalysis = {
      summary: '主要是文案表述问题。',
      issues: [
        {
          text: '汇报文档"项目背景"那段（Situation）超过 5 段（Behavior），评委读起来失去焦点（Impact）',
          dimension: '内容',
          confidence: 0.85,
        },
      ],
      suggestions: [
        { text: '把项目背景压缩到 3 句', dimension: '内容', confidence: 0.85 },
      ],
      uncertainties: [],
      recommendedChanges: [{ target: 'doc', text: '汇报文档：项目背景压缩到 3 句' }],
    };

    const step1 = makeE2ECtx(
      makeMessageEvent('彩排完了'),
      REHEARSAL_HISTORY,
      { analysisQueue: [docOnlyAnalysis] },
      memStore,
    );
    await rehearsalSkill.run(step1.ctx);

    const step2 = makeE2ECtx(
      makeMessageEvent('OK 完成'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    const r2 = await rehearsalSkill.run(step2.ctx);
    expect(r2.ok).toBe(true);
    dumpCards(step2.cards, '剧本D 第2步 review');
    // v2: 满意先发 review，未真正调 docx
    expect(step2.cards.find((c) => c.templateName === 'rehearsalReview')).toBeDefined();
    expect(step2.ctx.docx.createFromMarkdown).not.toHaveBeenCalled();

    // 第 3 步：review.confirm → finalize
    const step3 = makeE2ECtx(
      makeCardActionEvent('rehearsal.review.confirm'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    const r3 = await rehearsalSkill.run(step3.ctx);
    expect(r3.ok).toBe(true);
    dumpCards(step3.cards, '剧本D 第3步 review.confirm');

    // slides client 不被调（无 slides 类改动）
    expect(step3.ctx.slides!.createFromOutline).not.toHaveBeenCalled();
    // docx 被调
    expect(step3.ctx.docx.createFromMarkdown).toHaveBeenCalled();
    // 完成卡里只有"打开汇报文档"按钮，没有"打开新版 PPT"
    const completed = step3.cards.find(
      (c) => c.op === 'patch' && c.templateName === 'rehearsal',
    );
    expect(completed).toBeDefined();
    const buttons = snapshotCard(completed!.card).buttons;
    expect(buttons.find((b) => b.text === '打开新版 PPT')).toBeUndefined();
    expect(buttons.find((b) => b.text === '打开汇报文档')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 E：边界 — 没活跃 session 时点 satisfied 按钮（误点）
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E 剧本 E：边界场景', () => {
  it('无 session 时 satisfied 按钮被点 → 静默 ok，不调 slides', async () => {
    const e2e = makeE2ECtx(
      makeCardActionEvent('rehearsal.satisfied'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
    );
    const r = await rehearsalSkill.run(e2e.ctx);
    expect(r.ok).toBe(true);
    expect(e2e.ctx.slides!.createFromOutline).not.toHaveBeenCalled();
    expect(e2e.cards.length).toBe(0);
  });

  it('文本"不满意"不会被当满意，而是触发 round 2 再分析', async () => {
    const memStore = makeFakeMemoryStore();
    // 预置 round 1 session
    const step1 = makeE2ECtx(
      makeMessageEvent('演练完了'),
      REHEARSAL_HISTORY,
      { analysisQueue: [{ ...ANALYSIS_R1, uncertainties: [] }] },
      memStore,
    );
    await rehearsalSkill.run(step1.ctx);

    const step2 = makeE2ECtx(
      makeMessageEvent('不满意，再改改第 3 页'),
      REHEARSAL_HISTORY,
      { analysisQueue: [ANALYSIS_R2] },
      memStore,
    );
    const r = await rehearsalSkill.run(step2.ctx);
    expect(r.ok).toBe(true);
    // slides 不应被调（这是再分析，不是 finalize）
    expect(step2.ctx.slides!.createFromOutline).not.toHaveBeenCalled();
    // 应该发了 round 2 的 loading + final
    const r2Loading = step2.cards.find(
      (c) => c.op === 'send' && c.templateName === 'rehearsal',
    );
    expect(r2Loading).toBeDefined();
  });

  it('finalize 时 slides + doc 都失败 → 完成卡显示"重生成未成功"，不是空卡', async () => {
    const memStore = makeFakeMemoryStore();
    // 预置 reviewing session（v2: review.confirm → finalize 路径）
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'reviewing',
        round: 1,
        analysisMessageId: 'analysis_msg',
        reviewMessageId: 'review_msg',
        recommendedChanges: [
          { id: 'c_0', target: 'slides', text: '第 3 页补单位', source: 'user' },
        ],
        lastUncertainties: [],
        reviewSelection: ['c_0'],
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now() - 1_000,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const e2e = makeE2ECtx(
      makeCardActionEvent('rehearsal.review.confirm'),
      REHEARSAL_HISTORY,
      { analysisQueue: [] },
      memStore,
    );
    // 让 slides + docx 都失败
    (e2e.ctx.slides!.createFromOutline as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'slides down' },
    });
    (e2e.ctx.docx.createFromMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'doc down' },
    });

    const r = await rehearsalSkill.run(e2e.ctx);
    expect(r.ok).toBe(true);

    const completed = e2e.cards.find(
      (c) => c.op === 'patch' && c.templateName === 'rehearsal',
    );
    expect(completed).toBeDefined();
    const snap = snapshotCard(completed!.card);
    expect(snap.bodyText).toContain('重生成未成功');
    expect(snap.bodyText).not.toContain('没有需要重新生成');
  });

  it('v2: mergeChanges 不再静默截断，全部保留供 review 卡上提示用户精简', async () => {
    const memStore = makeFakeMemoryStore();
    // 预置一个已经累积 30 条 changes 的 session
    const lots = Array.from({ length: 30 }, (_, i) => ({
      id: `c_${i}`,
      target: 'slides' as const,
      text: `历史改动 #${i}`,
      source: 'user' as const,
    }));
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'analyzing',
        round: 5,
        analysisMessageId: 'analysis_msg',
        recommendedChanges: lots,
        lastUncertainties: [],
        startedAt: Date.now() - 100_000,
        updatedAt: Date.now() - 5_000,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    // 用户继续提反馈 → round 6 LLM 又返回 5 条新 changes
    const fivenew = Array.from({ length: 5 }, (_, i) => ({
      target: 'slides' as const,
      text: `新改动 #${i}`,
    }));
    const e2e = makeE2ECtx(
      makeMessageEvent('再补几条改动'),
      REHEARSAL_HISTORY,
      {
        analysisQueue: [
          {
            summary: 'r6',
            issues: [],
            suggestions: [],
            uncertainties: [],
            recommendedChanges: fivenew,
          },
        ],
      },
      memStore,
    );
    const r = await rehearsalSkill.run(e2e.ctx);
    expect(r.ok).toBe(true);

    const sessionRec = await memStore.client.read('skill_log', CHAT_ID, REHEARSAL_SESSION_KEY);
    if (sessionRec.ok && sessionRec.value) {
      const s = JSON.parse(sessionRec.value.content) as {
        recommendedChanges: { text: string }[];
      };
      // v2: 不再 slice — 30 历史 + 5 新 = 35 条全部保留
      expect(s.recommendedChanges.length).toBe(35);
      // 老条目仍在
      expect(s.recommendedChanges.find((c) => c.text === '历史改动 #0')).toBeDefined();
      expect(s.recommendedChanges.find((c) => c.text === '历史改动 #29')).toBeDefined();
      // 新条目也在
      expect(s.recommendedChanges.find((c) => c.text === '新改动 #0')).toBeDefined();
      expect(s.recommendedChanges.find((c) => c.text === '新改动 #4')).toBeDefined();
    } else {
      throw new Error('session not found');
    }
  });

  it('fresh trigger 重启 done 状态的 session', async () => {
    const memStore = makeFakeMemoryStore();
    // 直接预置一个 done 状态的 session
    await memStore.client.write({
      kind: 'skill_log',
      chat_id: CHAT_ID,
      key: REHEARSAL_SESSION_KEY,
      content: JSON.stringify({
        phase: 'done',
        round: 3,
        recommendedChanges: [{ target: 'slides', text: '历史改动' }],
        lastUncertainties: [],
        startedAt: Date.now() - 100_000,
        updatedAt: Date.now() - 50_000,
      }),
      source_skill: 'rehearsal',
      importance: 6,
    });

    const e2e = makeE2ECtx(
      makeMessageEvent('我们再演练一下'),
      REHEARSAL_HISTORY,
      { analysisQueue: [ANALYSIS_R1] },
      memStore,
    );
    const r = await rehearsalSkill.run(e2e.ctx);
    expect(r.ok).toBe(true);

    const session = await memStore.client.read('skill_log', CHAT_ID, REHEARSAL_SESSION_KEY);
    expect(session.ok).toBe(true);
    if (session.ok && session.value) {
      const s = JSON.parse(session.value.content) as {
        round: number;
        recommendedChanges: unknown[];
      };
      expect(s.round).toBe(1); // 重置
      expect(s.recommendedChanges.length).toBe(2); // 不带历史 changes
    }
  });
});
