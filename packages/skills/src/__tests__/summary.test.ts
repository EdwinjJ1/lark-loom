import { describe, it, expect, vi, beforeEach } from 'vitest';
import { summarySkill } from '../summary.js';
import type { SkillContext, BotEvent, Message } from '@seedhac/contracts';

const mockAskStructured = vi.fn();
const mockFetchHistory = vi.fn();
const mockFetchMessage = vi.fn();
const mockFetchMembers = vi.fn();
const mockSendCard = vi.fn();
const mockPatchCard = vi.fn();
const mockBitableBatchInsert = vi.fn();
const mockBitableInsert = vi.fn();
const mockDocxCreateFromMarkdown = vi.fn();
const mockDocxGrantMembersEdit = vi.fn();
const mockCardBuilderBuild = vi
  .fn()
  .mockReturnValue({ templateName: 'summary', content: { built: true } });

function makeMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'msg_1',
    chatId: 'chat_1',
    chatType: 'group',
    sender: { userId: 'u1', name: 'Alice' },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEvent(text: string): BotEvent {
  return { type: 'message', payload: makeMessage(text) };
}

function makeCtx(event: BotEvent): SkillContext {
  return {
    event,
    runtime: {
      fetchHistory: mockFetchHistory,
      fetchMessage: mockFetchMessage,
      fetchMembers: mockFetchMembers,
      sendText: vi.fn(),
      sendCard: mockSendCard,
      patchCard: mockPatchCard,
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    llm: { ask: vi.fn(), chat: vi.fn(), askStructured: mockAskStructured, chatWithTools: vi.fn() },
    bitable: {
      find: vi.fn(),
      insert: mockBitableInsert,
      batchInsert: mockBitableBatchInsert,
      update: vi.fn(),
      delete: vi.fn(),
      link: vi.fn(),
    },
    docx: {
      create: vi.fn(),
      appendBlocks: vi.fn(),
      getShareLink: vi.fn(),
      createFromMarkdown: mockDocxCreateFromMarkdown,
      readContent: vi.fn(),
      grantMembersEdit: mockDocxGrantMembersEdit,
    },
    cardBuilder: { build: mockCardBuilderBuild },
    retrievers: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as SkillContext;
}

const VALID_EXTRACTION = {
  summary: '本次会议决定采用方案 A。',
  decisions: ['采用方案A'],
  actionItems: [{ owner: 'Alice', content: '完成前端开发', ddl: '2026-05-10' }],
  issues: ['后端接口未确认'],
  nextSteps: ['下周召开评审会'],
};

const EMPTY_EXTRACTION_VALUE = {
  summary: '本次群聊未识别到决策。',
  decisions: [],
  actionItems: [],
  issues: [],
  nextSteps: [],
};

describe('summarySkill.match', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches 会议纪要', () => {
    expect(summarySkill.match(makeCtx(makeEvent('会议纪要已发，请大家查看')))).toBe(true);
  });

  it('matches 妙记', () => {
    expect(summarySkill.match(makeCtx(makeEvent('妙记链接来了')))).toBe(true);
  });

  it('does not match unrelated message', () => {
    expect(summarySkill.match(makeCtx(makeEvent('今天需要完成前端开发')))).toBe(false);
  });

  it('does not match non-message event', () => {
    const ctx = makeCtx({
      type: 'botJoinedChat',
      payload: { chatId: 'c', inviter: { userId: 'u' }, timestamp: 0 },
    });
    expect(summarySkill.match(ctx)).toBe(false);
  });
});

describe('summarySkill.run pipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: sends loading card, creates feishu doc, patches final with docUrl, writes side effects', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [makeMessage('会议纪要如下')], hasMore: false },
    });
    mockAskStructured.mockResolvedValueOnce({ ok: true, value: VALID_EXTRACTION });
    mockDocxCreateFromMarkdown.mockResolvedValueOnce({
      ok: true,
      value: { docToken: 'doc_abc', url: 'https://feishu.cn/docx/doc_abc' },
    });
    mockFetchMembers.mockResolvedValueOnce({
      ok: true,
      value: { members: [{ userId: 'ou_1' }, { userId: 'ou_2' }] },
    });
    mockDocxGrantMembersEdit.mockResolvedValueOnce({ ok: true, value: undefined });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });
    mockBitableBatchInsert.mockResolvedValue({ ok: true, value: [] });
    mockBitableInsert.mockResolvedValueOnce({
      ok: true,
      value: { tableId: 't', recordId: 'r' },
    });

    const result = await summarySkill.run(makeCtx(makeEvent('本次会议总结')));

    expect(result.ok).toBe(true);
    // 第 1 次 build：loading 卡（isLoading: true）
    expect(mockCardBuilderBuild).toHaveBeenNthCalledWith(
      1,
      'summary',
      expect.objectContaining({ isLoading: true }),
    );
    // 第 2 次 build：最终卡（带 decisions / todos / summary prose / docUrl）
    expect(mockCardBuilderBuild).toHaveBeenNthCalledWith(
      2,
      'summary',
      expect.objectContaining({
        decisions: ['采用方案A'],
        summary: expect.stringContaining('方案 A'),
        docUrl: 'https://feishu.cn/docx/doc_abc',
      }),
    );
    expect(mockSendCard).toHaveBeenCalledOnce();
    expect(mockDocxCreateFromMarkdown).toHaveBeenCalledOnce();
    expect(mockDocxGrantMembersEdit).toHaveBeenCalledWith('doc_abc', 'docx', ['ou_1', 'ou_2']);
    expect(mockPatchCard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'load_msg' }),
    );
    expect(mockBitableBatchInsert).toHaveBeenCalledTimes(2); // decision + todo
    // memory content 含 [会议纪要] 前缀 + docUrl，archive 后续可识别
    expect(mockBitableInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          content: expect.stringContaining('[会议纪要]'),
        }),
      }),
    );
  });

  it('doc creation failure: degrades to card-only (no docUrl)', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [makeMessage('会议纪要如下')], hasMore: false },
    });
    mockAskStructured.mockResolvedValueOnce({ ok: true, value: VALID_EXTRACTION });
    mockDocxCreateFromMarkdown.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'docx creation failed' },
    });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });
    mockBitableBatchInsert.mockResolvedValue({ ok: true, value: [] });
    mockBitableInsert.mockResolvedValueOnce({
      ok: true,
      value: { tableId: 't', recordId: 'r' },
    });

    const result = await summarySkill.run(makeCtx(makeEvent('本次会议总结')));

    expect(result.ok).toBe(true);
    // 最终卡片不带 docUrl
    const finalCallArgs = mockCardBuilderBuild.mock.calls[1]?.[1] as { docUrl?: string };
    expect(finalCallArgs?.docUrl).toBeUndefined();
    // 但卡片仍 patch 出去（不能因为 doc 失败就让用户什么都看不到）
    expect(mockPatchCard).toHaveBeenCalledOnce();
    expect(mockDocxGrantMembersEdit).not.toHaveBeenCalled();
  });

  it('empty extraction: skips doc creation entirely', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [], hasMore: false },
    });
    mockAskStructured.mockResolvedValueOnce({ ok: true, value: EMPTY_EXTRACTION_VALUE });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });
    mockBitableInsert.mockResolvedValueOnce({
      ok: true,
      value: { tableId: 't', recordId: 'r' },
    });

    const result = await summarySkill.run(makeCtx(makeEvent('会议纪要')));

    expect(result.ok).toBe(true);
    // 全空时不应该建空文档
    expect(mockDocxCreateFromMarkdown).not.toHaveBeenCalled();
    expect(mockBitableBatchInsert).not.toHaveBeenCalled();
  });

  it('LLM failure: patches error card and returns err', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [], hasMore: false },
    });
    mockAskStructured.mockResolvedValueOnce({
      ok: false,
      error: { code: 'LLM_TIMEOUT', message: 'timeout' },
    });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });

    const result = await summarySkill.run(makeCtx(makeEvent('会议总结')));

    expect(result.ok).toBe(false);
    expect(mockBitableBatchInsert).not.toHaveBeenCalled();
    // patch 出去的是 error 卡
    expect(mockCardBuilderBuild).toHaveBeenCalledWith(
      'summary',
      expect.objectContaining({ errorMessage: expect.stringContaining('LLM 提取失败') }),
    );
    expect(mockPatchCard).toHaveBeenCalledOnce();
  });

  it('fetchHistory failure: patches error card and returns err', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'fail' },
    });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });

    const result = await summarySkill.run(makeCtx(makeEvent('会议纪要')));

    expect(result.ok).toBe(false);
    expect(mockAskStructured).not.toHaveBeenCalled();
    expect(mockCardBuilderBuild).toHaveBeenCalledWith(
      'summary',
      expect.objectContaining({ errorMessage: expect.stringContaining('拉群历史失败') }),
    );
  });

  it('loading card send failure: returns err without further work', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'send fail' },
    });

    const result = await summarySkill.run(makeCtx(makeEvent('会议纪要')));

    expect(result.ok).toBe(false);
    expect(mockFetchHistory).not.toHaveBeenCalled();
    expect(mockAskStructured).not.toHaveBeenCalled();
    expect(mockPatchCard).not.toHaveBeenCalled();
  });

  it('bitable write failure: still patches final card and returns ok', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [], hasMore: false },
    });
    mockAskStructured.mockResolvedValueOnce({ ok: true, value: VALID_EXTRACTION });
    mockDocxCreateFromMarkdown.mockResolvedValueOnce({
      ok: true,
      value: { docToken: 'doc_x', url: 'https://feishu.cn/docx/doc_x' },
    });
    mockFetchMembers.mockResolvedValueOnce({ ok: true, value: { members: [] } });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });
    mockBitableBatchInsert.mockResolvedValue({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'bitable down' },
    });
    mockBitableInsert.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'bitable down' },
    });

    const result = await summarySkill.run(makeCtx(makeEvent('本次会议')));

    expect(result.ok).toBe(true);
    expect(mockPatchCard).toHaveBeenCalled();
  });

  it('empty extraction: still patches final card with prose fallback', async () => {
    mockSendCard.mockResolvedValueOnce({
      ok: true,
      value: { messageId: 'load_msg', chatId: 'chat_1', timestamp: 0 },
    });
    mockFetchHistory.mockResolvedValueOnce({
      ok: true,
      value: { messages: [], hasMore: false },
    });
    mockAskStructured.mockResolvedValueOnce({ ok: true, value: EMPTY_EXTRACTION_VALUE });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });
    mockBitableInsert.mockResolvedValueOnce({
      ok: true,
      value: { tableId: 't', recordId: 'r' },
    });

    const result = await summarySkill.run(makeCtx(makeEvent('会议纪要')));

    expect(result.ok).toBe(true);
    expect(mockBitableBatchInsert).not.toHaveBeenCalled();
    expect(mockCardBuilderBuild).toHaveBeenCalledWith(
      'summary',
      expect.objectContaining({
        decisions: [],
        summary: expect.stringContaining('未识别到'),
      }),
    );
  });
});
