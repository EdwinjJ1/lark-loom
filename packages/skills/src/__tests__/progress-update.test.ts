import { describe, it, expect, vi, beforeEach } from 'vitest';
import { progressUpdateSkill } from '../progress-update.js';
import { ok, err, makeError, ErrorCode } from '@seedhac/contracts';
import type {
  BotEvent,
  BotRuntime,
  LLMClient,
  Message,
  SkillContext,
} from '@seedhac/contracts';

let MSG_SEQ = 0;
function makeMessage(text: string, overrides: Partial<Message> = {}): Message {
  MSG_SEQ += 1;
  return {
    messageId: `msg_${String(MSG_SEQ).padStart(3, '0')}`,
    chatId: 'oc_chat_001',
    chatType: 'group',
    sender: { userId: 'ou_user_001', name: 'A' },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: 1_700_000_000_000 + MSG_SEQ * 1000,
    ...overrides,
  };
}

function makeEvent(text: string): BotEvent {
  return { type: 'message', payload: makeMessage(text) };
}

const HISTORY: readonly Message[] = [
  makeMessage('A 的用户访谈完成了', { sender: { userId: 'ou_a', name: 'A' } }),
];

const VALID_PROGRESS = {
  updates: [
    { owner: 'A', task: '用户访谈', status: 'done', confidence: 0.9 },
  ],
};

const TODO_RECORDS = [
  {
    tableId: 'tbl_todo',
    recordId: 'rec_a_interview',
    chatId: 'oc_chat_001',
    content: '用户访谈',
    owner: 'A',
    status: 'pending',
    timestamp: 1_700_000_000_000,
  },
  {
    tableId: 'tbl_todo',
    recordId: 'rec_a_other',
    chatId: 'oc_chat_001',
    content: '写 PRD',
    owner: 'A',
    status: 'pending',
    timestamp: 1_700_000_000_000,
  },
];

function makeRuntime(history: readonly Message[]): BotRuntime {
  return {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn(),
    sendCard: vi.fn(),
    patchCard: vi.fn(),
    fetchHistory: vi.fn().mockResolvedValue(ok({ messages: history, hasMore: false })),
    fetchMembers: vi.fn().mockResolvedValue(ok({ members: [] })),
    fetchMessage: vi.fn(),
  } as unknown as BotRuntime;
}

function makeLLM(extraction: unknown): LLMClient {
  return {
    ask: vi.fn(),
    chat: vi.fn(),
    askStructured: vi.fn().mockResolvedValue(ok(extraction)),
  } as unknown as LLMClient;
}

interface CtxOpts {
  readonly history?: readonly Message[];
  readonly extraction?: unknown;
  readonly todos?: readonly Record<string, unknown>[];
  readonly overrides?: Partial<SkillContext>;
}

function makeCtx(event: BotEvent, opts: CtxOpts = {}): SkillContext {
  const history = opts.history ?? HISTORY;
  const todos = opts.todos ?? TODO_RECORDS;
  return {
    event,
    runtime: makeRuntime(history),
    llm: makeLLM(opts.extraction ?? VALID_PROGRESS),
    bitable: {
      find: vi.fn().mockResolvedValue(ok({ records: todos, hasMore: false })),
      insert: vi.fn().mockResolvedValue(ok({ tableId: 'mem', recordId: 'r_mem' })),
      batchInsert: vi.fn(),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      delete: vi.fn(),
      link: vi.fn(),
      readTable: vi.fn(),
    } as unknown as SkillContext['bitable'],
    docx: {} as unknown as SkillContext['docx'],
    cardBuilder: { build: vi.fn() },
    retrievers: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...opts.overrides,
  };
}

beforeEach(() => {
  MSG_SEQ = 0;
});

describe('progressUpdateSkill.match()', () => {
  it('matches "完成 / 搞定 / 做完 / 已完成"', () => {
    expect(progressUpdateSkill.match(makeCtx(makeEvent('我把 PRD 写完了')))).toBe(true);
    expect(progressUpdateSkill.match(makeCtx(makeEvent('用户访谈搞定了')))).toBe(true);
    expect(progressUpdateSkill.match(makeCtx(makeEvent('已完成')))).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(progressUpdateSkill.match(makeCtx(makeEvent('今天天气真好')))).toBe(false);
  });
});

describe('progressUpdateSkill.run() — happy path', () => {
  it('updates matched todo to done and writes memory', async () => {
    const ctx = makeCtx(makeEvent('A 的用户访谈完成了'));
    const result = await progressUpdateSkill.run(ctx);

    expect(result.ok).toBe(true);
    const update = ctx.bitable.update as unknown as ReturnType<typeof vi.fn>;
    expect(update).toHaveBeenCalledOnce();
    const call = update.mock.calls[0]![0];
    expect(call.table).toBe('todo');
    expect(call.recordId).toBe('rec_a_interview');
    expect(call.patch.status).toBe('done');

    const insert = ctx.bitable.insert as unknown as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledOnce();
    const memRow = insert.mock.calls[0]![0].row;
    expect(memRow.kind).toBe('project');
    expect(memRow.source_skill).toBe('progressUpdate');
    expect(memRow.content).toContain('A 完成');
  });

  it('handles in_progress status', async () => {
    const ctx = makeCtx(makeEvent('A 在做用户访谈'), {
      extraction: {
        updates: [{ owner: 'A', task: '用户访谈', status: 'in_progress', confidence: 0.9 }],
      },
    });
    await progressUpdateSkill.run(ctx);

    const update = ctx.bitable.update as unknown as ReturnType<typeof vi.fn>;
    expect(update.mock.calls[0]![0].patch.status).toBe('in_progress');
  });
});

describe('progressUpdateSkill.run() — degraded paths', () => {
  it('writes memory only when no matching todo found', async () => {
    const ctx = makeCtx(makeEvent('A 完成了无关的事'), {
      extraction: {
        updates: [{ owner: 'A', task: '完全不相关的任务', status: 'done', confidence: 0.9 }],
      },
      todos: [],
    });

    const result = await progressUpdateSkill.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.bitable.update).not.toHaveBeenCalled();
    expect(ctx.bitable.insert).toHaveBeenCalledOnce();
  });

  it('skips done todos as match candidates', async () => {
    const ctx = makeCtx(makeEvent('A 用户访谈完成'), {
      todos: [
        {
          tableId: 'tbl',
          recordId: 'r_done',
          chatId: 'oc_chat_001',
          content: '用户访谈',
          owner: 'A',
          status: 'done',
          timestamp: 1,
        },
      ],
    });
    await progressUpdateSkill.run(ctx);

    expect(ctx.bitable.update).not.toHaveBeenCalled();
  });

  it('skips when LLM extracts no progress', async () => {
    const ctx = makeCtx(makeEvent('随便说说'), { extraction: { updates: [] } });
    const result = await progressUpdateSkill.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.bitable.find).not.toHaveBeenCalled();
    expect(ctx.bitable.insert).not.toHaveBeenCalled();
  });

  it('filters low-confidence updates', async () => {
    const ctx = makeCtx(makeEvent('A 完成了什么'), {
      extraction: {
        updates: [{ owner: 'A', task: 'x', status: 'done', confidence: 0.3 }],
      },
    });
    await progressUpdateSkill.run(ctx);

    expect(ctx.bitable.find).not.toHaveBeenCalled();
    expect(ctx.bitable.update).not.toHaveBeenCalled();
  });

  it('still writes memory when todo update fails', async () => {
    const ctx = makeCtx(makeEvent('A 用户访谈完成'));
    (ctx.bitable.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'update failed')),
    );

    await progressUpdateSkill.run(ctx);

    expect(ctx.bitable.insert).toHaveBeenCalledOnce();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('continues when bitable.find fails (memory-only fallback)', async () => {
    const ctx = makeCtx(makeEvent('A 用户访谈完成'));
    (ctx.bitable.find as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'find failed')),
    );

    const result = await progressUpdateSkill.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.bitable.update).not.toHaveBeenCalled();
    expect(ctx.bitable.insert).toHaveBeenCalledOnce();
  });

  it('returns err when fetchHistory fails', async () => {
    const ctx = makeCtx(makeEvent('A 完成'));
    (ctx.runtime.fetchHistory as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'history down')),
    );

    const result = await progressUpdateSkill.run(ctx);
    expect(result.ok).toBe(false);
  });
});

describe('progressUpdateSkill.run() — defensive length handling', () => {
  it('clamps super long owner / task before writing memory (防 LLM 幻觉超长)', async () => {
    const longOwner = 'A'.repeat(2000);
    const longTask = '任务'.repeat(2000);
    const ctx = makeCtx(makeEvent('A 完成'), {
      extraction: {
        updates: [{ owner: longOwner, task: longTask, status: 'done', confidence: 0.9 }],
      },
      todos: [],
    });

    await progressUpdateSkill.run(ctx);

    const insert = ctx.bitable.insert as unknown as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledOnce();
    const row = insert.mock.calls[0]![0].row;

    // key: owner 部分应被 SHORT (64) 限制，整个 key 不会无界增长
    expect(row.key.length).toBeLessThan(200);
    // content: 应在 LONG (2000) 范围内
    expect(row.content.length).toBeLessThanOrEqual(2000);
    // 确认实际触发了截断
    expect(row.content.endsWith('…')).toBe(true);
  });

  it('handles owner with control chars / pipes safely in key', async () => {
    const trickyOwner = `A|B\n${String.fromCharCode(0x07)}C`;
    const ctx = makeCtx(makeEvent('A 完成'), {
      extraction: {
        updates: [{ owner: trickyOwner, task: '任务', status: 'done', confidence: 0.9 }],
      },
      todos: [],
    });

    await progressUpdateSkill.run(ctx);

    const insert = ctx.bitable.insert as unknown as ReturnType<typeof vi.fn>;
    const row = insert.mock.calls[0]![0].row;
    expect(row.key).not.toContain('|');
    expect(row.key).not.toContain('\n');
    expect(row.key).not.toMatch(/[\x00-\x1f]/);
  });
});

describe('progressUpdateSkill metadata', () => {
  it('has required metadata fields', () => {
    expect(progressUpdateSkill.metadata.description).toBeTruthy();
    expect(progressUpdateSkill.metadata.when_to_use).toBeTruthy();
    expect(progressUpdateSkill.metadata.examples.length).toBeGreaterThan(0);
  });
});
