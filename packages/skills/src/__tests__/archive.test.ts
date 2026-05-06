import { describe, it, expect, vi, beforeEach } from 'vitest';
import { archiveSkill, extractLinksFromMemory } from '../archive.js';
import type { SkillContext, BotEvent, Message, BitableRow } from '@seedhac/contracts';

const mockLLMAsk = vi.fn();
const mockBitableFind = vi.fn();
const mockBitableInsert = vi.fn();
const mockCardBuilderBuild = vi
  .fn()
  .mockReturnValue({ templateName: 'archive', content: { built: true } });

function makeMessage(text: string): Message {
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
  };
}

function makeEvent(text: string): BotEvent {
  return { type: 'message', payload: makeMessage(text) };
}

function makeCtx(event: BotEvent): SkillContext {
  return {
    event,
    runtime: {
      fetchHistory: vi.fn(),
      sendText: vi.fn(),
      sendCard: vi.fn(),
      patchCard: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    llm: { ask: mockLLMAsk, chat: vi.fn(), askStructured: vi.fn() },
    bitable: {
      find: mockBitableFind,
      insert: mockBitableInsert,
      batchInsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      link: vi.fn(),
    },
    docx: {} as SkillContext['docx'],
    cardBuilder: { build: mockCardBuilderBuild },
    retrievers: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as SkillContext;
}

const EMPTY_FIND = { ok: true, value: { records: [], hasMore: false } };
const OK_INSERT = { ok: true, value: { tableId: 't', recordId: 'r' } };

describe('archiveSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBitableInsert.mockResolvedValue(OK_INSERT);
  });

  it('match returns true when message contains 归档', () => {
    expect(archiveSkill.match(makeCtx(makeEvent('项目结束，我们归档一下')))).toBe(true);
  });

  it('match returns true for 复盘', () => {
    expect(archiveSkill.match(makeCtx(makeEvent('来做一个复盘')))).toBe(true);
  });

  it('match returns true for 准备交付（issue #104 新增触发词）', () => {
    expect(archiveSkill.match(makeCtx(makeEvent('@bot 准备交付吧')))).toBe(true);
  });

  it('match returns false for unrelated message', () => {
    expect(archiveSkill.match(makeCtx(makeEvent('下次会议安排')))).toBe(false);
  });

  it('match returns false for non-message event', () => {
    const ctx = makeCtx({
      type: 'botJoinedChat',
      payload: { chatId: 'c', inviter: { userId: 'u' }, timestamp: 0 },
    });
    expect(archiveSkill.match(ctx)).toBe(false);
  });

  it('run normal path: 3 finds + insert audit memory + archive card with links', async () => {
    mockBitableFind
      .mockResolvedValueOnce({
        ok: true,
        value: {
          records: [
            {
              tableId: 't',
              recordId: 'r1',
              content: '[需求文档] 业务探索 v1\nhttps://example.feishu.cn/docx/abc',
              chat_id: 'chat_1',
              created_at: 1700000000000,
            },
            {
              tableId: 't',
              recordId: 'r2',
              content: '[slides] 期末汇报\nhttps://example.feishu.cn/slides/xyz',
              chat_id: 'chat_1',
              created_at: 1700000001000,
            },
          ],
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { records: [{ recordId: 'd1', content: '采用方案A', chatId: 'chat_1' }], hasMore: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          records: [
            { recordId: 'tdo1', content: '完成登录', status: 'done', chatId: 'chat_1' },
            { recordId: 'tdo2', content: '设计 UI', status: 'pending', chatId: 'chat_1' },
          ],
          hasMore: false,
        },
      });
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '项目圆满收尾，核心 PPT 与需求文档均已交付。' });

    const result = await archiveSkill.run(makeCtx(makeEvent('项目结束，归档一下')));

    expect(result.ok).toBe(true);
    expect(mockBitableFind).toHaveBeenCalledTimes(3);

    // 卡片必须有 links（issue #104 验收：至少 2 条）
    const buildArgs = mockCardBuilderBuild.mock.calls[0]![1];
    expect(buildArgs.links).toHaveLength(2);
    expect(buildArgs.links[0]).toMatchObject({ kind: 'requirementDoc', label: '需求文档' });
    expect(buildArgs.links[1]).toMatchObject({ kind: 'slides', label: '演示 PPT' });
    expect(buildArgs.taskStats).toBe('1/2 已完成');
    expect(buildArgs.decisionCount).toBe(1);

    // 写归档 memory（audit）
    expect(mockBitableInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'memory',
        row: expect.objectContaining({
          kind: 'project',
          chat_id: 'chat_1',
          source_skill: 'archive',
          importance: 8,
          content: expect.stringContaining('[archive]'),
        }),
      }),
    );
  });

  // issue #104 验收：LLM 失败也不阻断卡片输出
  it('run: LLM failure → fallback summary, still returns archive card', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);
    mockLLMAsk.mockResolvedValueOnce({ ok: false, error: { code: 'LLM_TIMEOUT', message: 'timeout' } });

    const result = await archiveSkill.run(makeCtx(makeEvent('收尾归档')));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.card?.templateName).toBe('archive');
    const buildArgs = mockCardBuilderBuild.mock.calls[0]![1];
    expect(buildArgs.summary).toContain('已收尾');
  });

  // issue #104 验收：bitable.insert 失败不阻断卡片回复
  it('run: audit memory insert failure does not block card', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '总结' });
    mockBitableInsert.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'insert failed' },
    });

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.card?.templateName).toBe('archive');
  });

  it('run: bitable.find partial failure — uses available data, still proceeds', async () => {
    mockBitableFind
      .mockResolvedValueOnce({ ok: false, error: { code: 'FEISHU_API_ERROR', message: 'fail' } })
      .mockResolvedValueOnce(EMPTY_FIND)
      .mockResolvedValueOnce(EMPTY_FIND);
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '项目总结' });

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
  });

  it('run: bitable.find passes chatId filter (chat_id for memory, chatId for legacy)', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '总结' });

    await archiveSkill.run(makeCtx(makeEvent('复盘')));

    expect(mockBitableFind).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ table: 'memory', filter: expect.stringContaining('chat_id') }),
    );
    expect(mockBitableFind).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ table: 'decision', filter: expect.stringContaining('chatId') }),
    );
  });

  it('run: empty memory → links is empty array, card still renders', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);
    mockLLMAsk.mockResolvedValueOnce({ ok: true, value: '空项目' });

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
    const buildArgs = mockCardBuilderBuild.mock.calls[0]![1];
    expect(buildArgs.links).toEqual([]);
  });
});

// ─── extractLinksFromMemory 单元测试 ─────────────────────────────────────────

describe('extractLinksFromMemory', () => {
  it('extracts requirementDoc + slides + taskAssignment in priority order', () => {
    const memories: BitableRow[] = [
      {
        recordId: 'm3',
        content: '[任务表] 5 月分工\nhttps://example.feishu.cn/sheets/task',
        created_at: 3,
      } as unknown as BitableRow,
      {
        recordId: 'm1',
        content: '[需求文档] PRD v1\nhttps://example.feishu.cn/docx/req',
        created_at: 1,
      } as unknown as BitableRow,
      {
        recordId: 'm2',
        content: '[slides] 期末汇报\nhttps://example.feishu.cn/slides/ppt',
        created_at: 2,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    expect(links).toHaveLength(3);
    expect(links[0]!.kind).toBe('requirementDoc');
    expect(links[1]!.kind).toBe('slides');
    expect(links[2]!.kind).toBe('taskAssignment');
  });

  it('keeps only latest URL per (kind, label) pair', () => {
    const memories: BitableRow[] = [
      {
        content: '[需求文档] v1\nhttps://example.feishu.cn/old',
        created_at: 1,
      } as unknown as BitableRow,
      {
        content: '[需求文档] v2\nhttps://example.feishu.cn/new',
        created_at: 5,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe('https://example.feishu.cn/new');
  });

  it('coexists 汇报分工文稿 + 任务分工表 (both taskAssignment kind, different labels)', () => {
    const memories: BitableRow[] = [
      {
        content: '[汇报分工] 演讲分工\nhttps://example.feishu.cn/speech',
        created_at: 1,
      } as unknown as BitableRow,
      {
        content: '[任务表] 任务分工\nhttps://example.feishu.cn/task',
        created_at: 2,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.label).sort()).toEqual(['任务分工表', '汇报分工文稿']);
  });

  it('skips memory without URL', () => {
    const memories: BitableRow[] = [
      { content: '[需求文档] 没有 URL 的备忘', created_at: 1 } as unknown as BitableRow,
    ];
    expect(extractLinksFromMemory(memories)).toHaveLength(0);
  });

  it('non-prefixed memories with URLs go to "other" bucket (max 2)', () => {
    const memories: BitableRow[] = [
      { content: '随手记 https://example.feishu.cn/a', created_at: 1 } as unknown as BitableRow,
      { content: '另一个 https://example.feishu.cn/b', created_at: 2 } as unknown as BitableRow,
      { content: '第三个 https://example.feishu.cn/c', created_at: 3 } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.kind === 'other')).toBe(true);
  });

  it('caps total to 6 links', () => {
    const memories: BitableRow[] = Array.from({ length: 20 }, (_, i) => ({
      content: `note ${i} https://example.feishu.cn/p${i}`,
      created_at: i,
    })) as unknown as BitableRow[];
    expect(extractLinksFromMemory(memories).length).toBeLessThanOrEqual(6);
  });
});
