import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recallSkill } from '../recall.js';
import type {
  SkillContext,
  BotEvent,
  Message,
  Result,
  RetrieveHit,
  SkillResult,
} from '@seedhac/contracts';

// ── mock helpers ────────────────────────────────────────────────────────────

const mockLLMAsk = vi.fn();
const mockFetchHistory = vi.fn();
const mockVectorRetrieve = vi.fn();
const mockBitableRetrieve = vi.fn();

function makeMessage(text: string, messageId = 'msg_1'): Message {
  return {
    messageId,
    chatId: 'chat_1',
    chatType: 'group',
    sender: { userId: 'u1', name: 'Alice' },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: Date.now(),
  };
}

function makeEvent(text: string, messageId = 'msg_1'): BotEvent {
  return { type: 'message', payload: makeMessage(text, messageId) };
}

function makeCtx(event: BotEvent): SkillContext {
  return {
    event,
    runtime: {
      fetchHistory: mockFetchHistory,
      sendText: vi.fn(),
      sendCard: vi.fn(),
      patchCard: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    llm: { ask: mockLLMAsk, chat: vi.fn(), askStructured: vi.fn(), chatWithTools: vi.fn() },
    bitable: {
      find: vi.fn(),
      insert: vi.fn(),
      batchInsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      link: vi.fn(),
    },
    retrievers: {
      vector: { source: 'vector', retrieve: mockVectorRetrieve },
      bitable: { source: 'bitable', retrieve: mockBitableRetrieve },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as SkillContext;
}

function makeHit(id: string, snippet: string): RetrieveHit {
  return {
    source: 'vector',
    id,
    title: snippet.slice(0, 30),
    snippet,
    score: 0.9,
    timestamp: Date.now(),
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('recallSkill', () => {
  // mockReset 而非 clearAllMocks — 后者只清 .mock.calls，不会清 mockResolvedValueOnce 的 queue，
  // 导致测试间 mock 队列泄漏（之前的 mockResolvedValueOnce 在下个测试被消费）
  beforeEach(() => {
    vi.clearAllMocks();
    mockLLMAsk.mockReset();
    mockFetchHistory.mockReset();
    mockVectorRetrieve.mockReset();
    mockBitableRetrieve.mockReset();
  });

  it('match returns false for non-message events', async () => {
    const ctx = makeCtx({
      type: 'botJoinedChat',
      payload: { chatId: 'c', inviter: { userId: 'u' }, timestamp: 0 },
    });
    expect(await recallSkill.match(ctx)).toBe(false);
    expect(mockFetchHistory).not.toHaveBeenCalled();
  });

  it('match returns false when no keyword present', async () => {
    const ctx = makeCtx(makeEvent('今天天气真好'));
    expect(await recallSkill.match(ctx)).toBe(false);
    expect(mockFetchHistory).not.toHaveBeenCalled();
  });

  it('match returns false when keyword present but current chat already answered it', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: {
        messages: [
          makeMessage('上次那个客户叫啥'),
          makeMessage('叫张总，开过两次会', 'msg_answer'),
        ],
        hasMore: false,
      },
    });

    const ctx = makeCtx(makeEvent('上次那个客户叫啥'));
    expect(await recallSkill.match(ctx)).toBe(false);
    expect(mockLLMAsk).not.toHaveBeenCalled();
  });

  it('normal path: match detects gap → run retrieves + synthesizes text', async () => {
    const messageId = 'msg_norm';
    const ctx = makeCtx(makeEvent('那个预算是多少来着', messageId));

    // match() calls
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [makeMessage('那个预算是多少来着', messageId)], hasMore: false },
    });
    const matched = await recallSkill.match(ctx);
    expect(matched).toBe(true);

    // run() calls — cache hit, no second LLM detection
    mockVectorRetrieve.mockResolvedValueOnce({ ok: true, value: [makeHit('h1', '预算是 10 万')] });
    mockBitableRetrieve.mockResolvedValueOnce({
      ok: true,
      value: [makeHit('h2', '已核定 10 万预算')],
    });
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '项目预算是 10 万，上次会议已确认。' });

    const result: Result<SkillResult> = await recallSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe('项目预算是 10 万，上次会议已确认。');
      expect(result.value.reasoning).toBe('规则命中：模糊指代');
    }
    expect(mockLLMAsk).toHaveBeenCalledTimes(1);
  });

  it('run returns empty text when both retrievers return no hits', async () => {
    const messageId = 'msg_nohits';
    const ctx = makeCtx(makeEvent('上次那个结论是啥', messageId));

    mockFetchHistory.mockResolvedValueOnce({ ok: true, value: { messages: [], hasMore: false } });
    await recallSkill.match(ctx);

    mockVectorRetrieve.mockResolvedValueOnce({ ok: true, value: [] });
    mockBitableRetrieve.mockResolvedValueOnce({ ok: true, value: [] });

    const result = await recallSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('');
    expect(mockLLMAsk).not.toHaveBeenCalled();
  });

  it('run degrades gracefully when LLM synthesis fails — returns first snippet', async () => {
    const messageId = 'msg_synthfail';
    const ctx = makeCtx(makeEvent('之前说的方案是啥', messageId));

    mockFetchHistory.mockResolvedValueOnce({ ok: true, value: { messages: [], hasMore: false } });
    await recallSkill.match(ctx);

    mockVectorRetrieve.mockResolvedValueOnce({ ok: true, value: [makeHit('h1', '采用方案A')] });
    mockBitableRetrieve.mockResolvedValueOnce({ ok: true, value: [] });
    mockLLMAsk.mockResolvedValueOnce({
      ok: false,
      error: { code: 'LLM_TIMEOUT', message: 'timeout' },
    });

    const result = await recallSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('采用方案A');
  });

  it('run merges hits from both vector and bitable retrievers', async () => {
    const messageId = 'msg_merge';
    const ctx = makeCtx(makeEvent('上回那个截止日期', messageId));

    mockFetchHistory.mockResolvedValueOnce({ ok: true, value: { messages: [], hasMore: false } });
    await recallSkill.match(ctx);

    const vectorHit = makeHit('v1', 'DDL 是 5 月 1 日');
    const bitableHit: RetrieveHit = {
      source: 'bitable',
      id: 'b1',
      title: '截止',
      snippet: '确认 DDL：2026-05-01',
      score: 1,
      timestamp: Date.now(),
    };
    mockVectorRetrieve.mockResolvedValueOnce({ ok: true, value: [vectorHit] });
    mockBitableRetrieve.mockResolvedValueOnce({ ok: true, value: [bitableHit] });
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '截止日期是 5 月 1 日，已在表格中确认。' });

    const result = await recallSkill.run(ctx);

    expect(result.ok).toBe(true);
    // verify both retrievers were called with the right query
    expect(mockVectorRetrieve).toHaveBeenCalledWith(expect.objectContaining({ query: '截止日期' }));
    expect(mockBitableRetrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: '截止日期' }),
    );
    if (result.ok) expect(result.value.text).toContain('5 月');
  });

  it('run cache miss: run() re-runs gap detection when match() was not called first', async () => {
    // Simulate run() called directly without prior match() — cache is empty
    const messageId = 'msg_cachemiss';
    const ctx = makeCtx(makeEvent('上次那个方案是什么', messageId));

    // run() will call fetchHistory and detectGap itself
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [makeMessage('上次那个方案是什么', messageId)], hasMore: false },
    });
    mockVectorRetrieve.mockResolvedValueOnce({ ok: true, value: [makeHit('h1', '采用方案A')] });
    mockBitableRetrieve.mockResolvedValueOnce({ ok: true, value: [] });
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '上次确定的是方案A。' });

    const result = await recallSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('上次确定的是方案A。');
    expect(mockLLMAsk).toHaveBeenCalledTimes(1);
  });

  it('run handles total retriever failure and returns empty text', async () => {
    const messageId = 'msg_retrieverr';
    const ctx = makeCtx(makeEvent('我记得之前讨论过这个', messageId));

    mockFetchHistory.mockResolvedValueOnce({ ok: true, value: { messages: [], hasMore: false } });
    await recallSkill.match(ctx);

    mockVectorRetrieve.mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNKNOWN', message: 'chroma down' },
    });
    mockBitableRetrieve.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'timeout' },
    });

    const result = await recallSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('');
    expect(mockLLMAsk).not.toHaveBeenCalled();
  });
});
