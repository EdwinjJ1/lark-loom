import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { taskAssignmentSkill } from '../task-assignment.js';
import { ok, err, makeError, ErrorCode } from '@seedhac/contracts';
import type {
  BotEvent,
  BotRuntime,
  Card,
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
    sender: { userId: 'ou_user_001', name: '张三' },
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

const MOCK_CARD: Card = { templateName: 'tablePush', content: { built: true } };

const HISTORY: readonly Message[] = [
  makeMessage('我们分工一下', { sender: { userId: 'ou_pm', name: '产品经理' } }),
  makeMessage('A 负责用户访谈，DDL 明天下午，交付访谈纪要', {
    sender: { userId: 'ou_a', name: 'A' },
  }),
  makeMessage('B 写 PRD，验收标准是覆盖 5 个用户场景', {
    sender: { userId: 'ou_b', name: 'B' },
  }),
];

const VALID_EXTRACTION = {
  tasks: [
    {
      owner: 'A',
      task: '用户访谈',
      ddl: '2026-05-07',
      deliverable: '访谈纪要',
      acceptance: '覆盖 5 个用户',
      confidence: 0.9,
    },
    {
      owner: 'B',
      task: '写 PRD',
      acceptance: '覆盖 5 个用户场景',
      confidence: 0.85,
    },
  ],
};

function makeRuntime(history: readonly Message[]): BotRuntime {
  return {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn(),
    sendCard: vi.fn().mockResolvedValue(ok({ messageId: 'm1', chatId: 'oc_chat_001', timestamp: 0 })),
    patchCard: vi.fn().mockResolvedValue(ok(undefined)),
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
  readonly overrides?: Partial<SkillContext>;
}

function makeCtx(event: BotEvent, opts: CtxOpts = {}): SkillContext {
  const history = opts.history ?? HISTORY;
  return {
    event,
    runtime: makeRuntime(history),
    llm: makeLLM(opts.extraction ?? VALID_EXTRACTION),
    bitable: {
      find: vi.fn(),
      insert: vi.fn().mockResolvedValue(ok({ tableId: 't_mem', recordId: 'r_mem' })),
      batchInsert: vi
        .fn()
        .mockResolvedValue(ok([{ tableId: 't_todo', recordId: 'r1' }, { tableId: 't_todo', recordId: 'r2' }])),
      update: vi.fn(),
      delete: vi.fn(),
      link: vi.fn(),
      readTable: vi.fn(),
    } as unknown as SkillContext['bitable'],
    docx: {} as unknown as SkillContext['docx'],
    cardBuilder: { build: vi.fn().mockReturnValue(MOCK_CARD) },
    retrievers: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...opts.overrides,
  };
}

beforeEach(() => {
  MSG_SEQ = 0;
  process.env['BITABLE_APP_TOKEN'] = 'tbl_fake_for_test';
});

afterEach(() => {
  delete process.env['BITABLE_APP_TOKEN'];
});

describe('taskAssignmentSkill.match()', () => {
  it('matches "X 负责" pattern', () => {
    expect(taskAssignmentSkill.match(makeCtx(makeEvent('A 来负责用户访谈')))).toBe(true);
  });

  it('matches DDL / 验收标准 / 交付物 / 分工', () => {
    expect(taskAssignmentSkill.match(makeCtx(makeEvent('DDL 是明天')))).toBe(true);
    expect(taskAssignmentSkill.match(makeCtx(makeEvent('验收标准是 5 个用户')))).toBe(true);
    expect(taskAssignmentSkill.match(makeCtx(makeEvent('交付物是访谈纪要')))).toBe(true);
    expect(taskAssignmentSkill.match(makeCtx(makeEvent('我们分工一下')))).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(taskAssignmentSkill.match(makeCtx(makeEvent('今天天气真好')))).toBe(false);
  });
});

describe('taskAssignmentSkill.run() — happy path', () => {
  it('writes structured todo rows and pushes tablePush card', async () => {
    const ctx = makeCtx(makeEvent('A 负责用户访谈，DDL 明天'));
    const result = await taskAssignmentSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.card).toBe(MOCK_CARD);

    const batchInsert = ctx.bitable.batchInsert as unknown as ReturnType<typeof vi.fn>;
    expect(batchInsert).toHaveBeenCalledOnce();
    const call = batchInsert.mock.calls[0]![0];
    expect(call.table).toBe('todo');
    expect(call.rows).toHaveLength(2);
    expect(call.rows[0]).toMatchObject({
      chatId: 'oc_chat_001',
      content: '用户访谈',
      owner: 'A',
      ddl: '2026-05-07',
      status: 'pending',
      deliverable: '访谈纪要',
      source: 'taskAssignment',
    });
  });

  it('writes memory using unified MemoryRecord schema', async () => {
    const ctx = makeCtx(makeEvent('A 负责用户访谈'));
    await taskAssignmentSkill.run(ctx);

    const insert = ctx.bitable.insert as unknown as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledOnce();
    const memCall = insert.mock.calls[0]![0];
    expect(memCall.table).toBe('memory');
    const row = memCall.row;
    expect(row.kind).toBe('project');
    expect(row.chat_id).toBe('oc_chat_001');
    expect(row.source_skill).toBe('taskAssignment');
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.last_access).toBe('number');
    expect(row.key).toMatch(/^task-oc_chat_001-/);
    expect(row.content).toContain('A → 用户访谈');
  });

  it('builds tablePush card with task count + members + nearestDue', async () => {
    const ctx = makeCtx(makeEvent('A 负责用户访谈'));
    await taskAssignmentSkill.run(ctx);

    const build = ctx.cardBuilder.build as unknown as ReturnType<typeof vi.fn>;
    expect(build).toHaveBeenCalledOnce();
    const [name, input] = build.mock.calls[0]!;
    expect(name).toBe('tablePush');
    expect(input.taskCount).toBe(2);
    expect(input.members).toEqual(['A', 'B']);
    expect(input.nearestDue).toBe('2026-05-07');
    expect(input.tableTitle).toBe('项目分工表');
  });
});

describe('taskAssignmentSkill.run() — degraded paths', () => {
  it('skips card when LLM extracts no valid tasks', async () => {
    const ctx = makeCtx(makeEvent('A 负责...'), { extraction: { tasks: [] } });
    const result = await taskAssignmentSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.card).toBeUndefined();
    expect(ctx.bitable.batchInsert).not.toHaveBeenCalled();
    expect(ctx.bitable.insert).not.toHaveBeenCalled();
  });

  it('filters out low-confidence tasks', async () => {
    const ctx = makeCtx(makeEvent('A 负责...'), {
      extraction: {
        tasks: [
          { owner: 'A', task: '可能要做的事', confidence: 0.3 },
          { owner: 'B', task: '不一定', confidence: 0.4 },
        ],
      },
    });
    const result = await taskAssignmentSkill.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.bitable.batchInsert).not.toHaveBeenCalled();
  });

  it('skips card when bitable batchInsert fails', async () => {
    const ctx = makeCtx(makeEvent('A 负责用户访谈'));
    (ctx.bitable.batchInsert as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'bitable down')),
    );

    const result = await taskAssignmentSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.card).toBeUndefined();
    expect(ctx.cardBuilder.build).not.toHaveBeenCalled();
  });

  it('still builds card when memory insert fails (warn-only)', async () => {
    const ctx = makeCtx(makeEvent('A 负责用户访谈'));
    (ctx.bitable.insert as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'mem down')),
    );

    const result = await taskAssignmentSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.card).toBe(MOCK_CARD);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('returns err when fetchHistory fails', async () => {
    const ctx = makeCtx(makeEvent('A 负责...'));
    (ctx.runtime.fetchHistory as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.FEISHU_API_ERROR, 'history down')),
    );

    const result = await taskAssignmentSkill.run(ctx);
    expect(result.ok).toBe(false);
  });

  it('treats LLM extraction failure as empty (returns ok, no card)', async () => {
    const ctx = makeCtx(makeEvent('A 负责...'));
    (ctx.llm.askStructured as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err(makeError(ErrorCode.LLM_INVALID_RESPONSE, 'parse fail')),
    );

    const result = await taskAssignmentSkill.run(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.card).toBeUndefined();
  });

  it('skips card (but still writes todo + memory) when BITABLE_APP_TOKEN missing', async () => {
    delete process.env['BITABLE_APP_TOKEN'];
    const ctx = makeCtx(makeEvent('A 负责用户访谈'));

    const result = await taskAssignmentSkill.run(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.card).toBeUndefined();
    expect(ctx.bitable.batchInsert).toHaveBeenCalled();
    expect(ctx.bitable.insert).toHaveBeenCalled();
    expect(ctx.cardBuilder.build).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'taskAssignment: BITABLE_APP_TOKEN missing, skip card',
      expect.any(Object),
    );
  });
});

describe('taskAssignmentSkill.run() — defensive length handling', () => {
  it('clamps each task field to MEDIUM (500 chars) before writing todo', async () => {
    const longTask = 'task '.repeat(500);
    const longDeliv = 'd'.repeat(2000);
    const ctx = makeCtx(makeEvent('A 负责...'), {
      extraction: {
        tasks: [
          {
            owner: 'A',
            task: longTask,
            deliverable: longDeliv,
            acceptance: 'b'.repeat(2000),
            confidence: 0.9,
          },
        ],
      },
    });

    await taskAssignmentSkill.run(ctx);

    const batchInsert = ctx.bitable.batchInsert as unknown as ReturnType<typeof vi.fn>;
    const row = batchInsert.mock.calls[0]![0].rows[0];
    expect(row.content.length).toBeLessThanOrEqual(500);
    expect(row.deliverable.length).toBeLessThanOrEqual(500);
    expect(row.acceptance.length).toBeLessThanOrEqual(500);
  });

  it('clamps memory content to LONG (2000 chars) when many tasks pile up', async () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({
      owner: `member_${i}`,
      task: `任务 ${i} 的描述非常详细需要写很多字`,
      ddl: '2026-05-07',
      confidence: 0.9,
    }));
    const ctx = makeCtx(makeEvent('一堆分工'), { extraction: { tasks } });

    await taskAssignmentSkill.run(ctx);

    const insert = ctx.bitable.insert as unknown as ReturnType<typeof vi.fn>;
    const row = insert.mock.calls[0]![0].row;
    expect(row.content.length).toBeLessThanOrEqual(2000);
    expect(row.content.endsWith('…')).toBe(true);
  });
});

describe('taskAssignmentSkill metadata', () => {
  it('has required metadata fields', () => {
    expect(taskAssignmentSkill.metadata.description).toBeTruthy();
    expect(taskAssignmentSkill.metadata.when_to_use).toBeTruthy();
    expect(taskAssignmentSkill.metadata.examples.length).toBeGreaterThan(0);
  });
});
