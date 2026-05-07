import { describe, it, expect, vi, beforeEach } from 'vitest';
import { archiveSkill, extractLinksFromMemory } from '../archive.js';
import { renderArchiveSummary, ArchiveSummarySchema } from '../prompts/archive.js';
import type { SkillContext, BotEvent, Message, BitableRow } from '@seedhac/contracts';

const mockLLMAskStructured = vi.fn();
const mockBitableFind = vi.fn();
const mockBitableInsert = vi.fn();
const mockCardBuilderBuild = vi
  .fn()
  .mockReturnValue({ templateName: 'archive', content: { built: true } });

// issue #114 三阶段 pipeline 新引入的依赖
const mockSendCard = vi.fn();
const mockPatchCard = vi.fn();
const mockFetchMembers = vi.fn();
const mockDocxCreate = vi.fn();
const mockDocxGrant = vi.fn();

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
      fetchMembers: mockFetchMembers,
      sendText: vi.fn(),
      sendCard: mockSendCard,
      patchCard: mockPatchCard,
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    llm: { ask: vi.fn(), chat: vi.fn(), askStructured: mockLLMAskStructured },
    bitable: {
      find: mockBitableFind,
      insert: mockBitableInsert,
      batchInsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      link: vi.fn(),
    },
    docx: {
      createFromMarkdown: mockDocxCreate,
      grantMembersEdit: mockDocxGrant,
    },
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
    // 默认 happy path：所有外部依赖都成功
    mockSendCard.mockResolvedValue({
      ok: true,
      value: { messageId: 'card_msg_1', chatId: 'chat_1', timestamp: 0 },
    });
    mockPatchCard.mockResolvedValue({ ok: true, value: undefined });
    mockFetchMembers.mockResolvedValue({
      ok: true,
      value: { members: [{ userId: 'u1', name: 'Alice' }] },
    });
    mockDocxCreate.mockResolvedValue({
      ok: true,
      value: { docToken: 'doc_tok_1', url: 'https://x.feishu.cn/docx/doc_tok_1' },
    });
    mockDocxGrant.mockResolvedValue({ ok: true, value: undefined });
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
    mockLLMAskStructured.mockResolvedValueOnce({
      ok: true,
      value: {
        goal: '业务探索的小项目',
        // outcomes 必须 grounded —— issue #114 verify 会 drop 不在 source 里的条目
        outcomes: ['业务探索文档已落地', '期末汇报材料已生成'],
        whatWorkedWell: ['前端表单一次过'],
        whatToImprove: ['UI 改稿次数偏多'],
        openIssues: ['设计 UI 已搞定'],
      },
    });

    const result = await archiveSkill.run(makeCtx(makeEvent('项目结束，归档一下')));

    expect(result.ok).toBe(true);
    expect(mockBitableFind).toHaveBeenCalledTimes(3);

    // 卡片必须有 links（issue #104 验收：至少 2 条）
    // 第一个 build 是 loading 卡，最后一个是 final 卡（issue #114 三阶段）
    const buildArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(buildArgs.links).toHaveLength(2);
    expect(buildArgs.links[0]).toMatchObject({ kind: 'requirementDoc', label: '需求文档' });
    expect(buildArgs.links[1]).toMatchObject({ kind: 'slides', label: '演示 PPT' });
    expect(buildArgs.taskStats).toBe('1/2 已完成');
    expect(buildArgs.decisionCount).toBe(1);
    // summary 由模板渲染：必须含 goal + grounded outcomes
    expect(buildArgs.summary).toContain('业务探索');
    expect(buildArgs.summary).toContain('期末汇报');

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

  // issue #104 验收 + 防幻觉：LLM 失败也不阻断卡片输出，summary 走静态 fallback
  it('run: LLM failure → fallback summary, still returns archive card', async () => {
    mockBitableFind.mockResolvedValue({
      ok: true,
      value: {
        records: [
          { recordId: 'r1', content: '记录 1' },
          { recordId: 'r2', content: '记录 2' },
          { recordId: 'r3', content: '记录 3' },
        ],
        hasMore: false,
      },
    });
    mockLLMAskStructured.mockResolvedValueOnce({
      ok: false,
      error: { code: 'LLM_TIMEOUT', message: 'timeout' },
    });

    const result = await archiveSkill.run(makeCtx(makeEvent('收尾归档')));

    expect(result.ok).toBe(true);
    // issue #114：archive 不再返回 card（loading + patchCard 已直接发送）
    expect(mockPatchCard).toHaveBeenCalled();
    const buildArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(buildArgs.summary).toContain('已收尾');
  });

  // 防幻觉关键路径：总记录 < 3 条直接跳过 LLM，绝不让模型在空数据上编造
  it('run: total records < 3 → skip LLM entirely, use static fallback', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
    expect(mockLLMAskStructured).not.toHaveBeenCalled(); // 完全没调 LLM
    // 第一个 build 是 loading 卡，最后一个是 final 卡（issue #114 三阶段）
    const buildArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(buildArgs.summary).toContain('已收尾');
  });

  // issue #104 验收：bitable.insert 失败不阻断卡片回复
  it('run: audit memory insert failure does not block card', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);
    mockBitableInsert.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'insert failed' },
    });

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
    // patchCard 仍然完成（cardBuilder 至少被调过 2 次：loading + final）
    expect(mockCardBuilderBuild.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('run: bitable.find partial failure — uses available data, still proceeds', async () => {
    mockBitableFind
      .mockResolvedValueOnce({ ok: false, error: { code: 'FEISHU_API_ERROR', message: 'fail' } })
      .mockResolvedValueOnce(EMPTY_FIND)
      .mockResolvedValueOnce(EMPTY_FIND);

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
  });

  it('run: bitable.find passes chatId filter (chat_id for memory, chatId for legacy)', async () => {
    mockBitableFind.mockResolvedValue(EMPTY_FIND);

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

    const result = await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(result.ok).toBe(true);
    // 第一个 build 是 loading 卡，最后一个是 final 卡（issue #114 三阶段）
    const buildArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(buildArgs.links).toEqual([]);
  });

  // 防幻觉物理隔离：decisionCount / taskStats 必须由代码算，不能从 LLM 输出来
  it('run: decisionCount + taskStats computed from records, NOT from LLM', async () => {
    mockBitableFind
      .mockResolvedValueOnce({
        ok: true,
        value: { records: [{ content: '记忆1' }, { content: '记忆2' }], hasMore: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          records: [{ content: 'd1' }, { content: 'd2' }, { content: 'd3' }],
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          records: [
            { content: 't1', status: 'done' },
            { content: 't2', status: 'done' },
            { content: 't3', status: 'pending' },
            { content: 't4', status: 'done' },
          ],
          hasMore: false,
        },
      });
    // LLM 故意试图返回错误的 number（schema 不接受 number 字段）
    mockLLMAskStructured.mockResolvedValueOnce({
      ok: true,
      value: {
        goal: 'test',
        outcomes: [],
        whatWorkedWell: [],
        whatToImprove: [],
        openIssues: [],
      },
    });

    await archiveSkill.run(makeCtx(makeEvent('归档')));

    // 第一个 build 是 loading 卡，最后一个是 final 卡（issue #114 三阶段）
    const buildArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(buildArgs.decisionCount).toBe(3); // 实际 decisions.length，不是 LLM 给的
    expect(buildArgs.taskStats).toBe('3/4 已完成'); // 3 done out of 4 todos
  });

  // ─── issue #114 新增：三阶段 pipeline + doc 生成 ──────────────────────

  it('issue #114: sendCard loading first, then patchCard final with doc URL', async () => {
    mockBitableFind.mockResolvedValue({
      ok: true,
      value: {
        records: [
          {
            recordId: 'r1',
            content: '[需求文档] 项目 PRD\nhttps://x.feishu.cn/docx/abc',
            created_at: 1,
          },
          { recordId: 'r2', content: '记录 2' },
          { recordId: 'r3', content: '记录 3' },
        ],
        hasMore: false,
      },
    });
    mockLLMAskStructured.mockResolvedValueOnce({
      ok: true,
      value: {
        goal: 'test goal',
        outcomes: ['outcome'],
        whatWorkedWell: [],
        whatToImprove: [],
        openIssues: [],
      },
    });

    await archiveSkill.run(makeCtx(makeEvent('项目结束了，归档一下')));

    // 1. sendCard 一次（loading）
    expect(mockSendCard).toHaveBeenCalledOnce();
    const loadingArgs = mockCardBuilderBuild.mock.calls[0]![1];
    expect(loadingArgs.isLoading).toBe(true);
    expect(loadingArgs.etaSeconds).toBeGreaterThan(0);

    // 2. docx.createFromMarkdown 被调（生成报告 doc）
    expect(mockDocxCreate).toHaveBeenCalledOnce();
    const [docTitle, docMarkdown] = mockDocxCreate.mock.calls[0]!;
    expect(docTitle).toContain('项目交付报告');
    expect(docMarkdown).toContain('## 摘要');
    expect(docMarkdown).toContain('## 项目产出');

    // 3. fetchMembers + grantMembersEdit 被调（给群成员授权）
    expect(mockFetchMembers).toHaveBeenCalledOnce();
    expect(mockDocxGrant).toHaveBeenCalledWith('doc_tok_1', 'docx', ['u1']);

    // 4. patchCard 一次（final）
    expect(mockPatchCard).toHaveBeenCalledOnce();
    const finalArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(finalArgs.isLoading).toBeUndefined();
    expect(finalArgs.reportDocUrl).toBe('https://x.feishu.cn/docx/doc_tok_1');
  });

  it('issue #114: docx 创建失败 → final 卡 patch 时不带 reportDocUrl', async () => {
    mockBitableFind.mockResolvedValue({
      ok: true,
      value: {
        records: [{ content: 'a' }, { content: 'b' }, { content: 'c' }],
        hasMore: false,
      },
    });
    mockLLMAskStructured.mockResolvedValueOnce({
      ok: true,
      value: { goal: 'g', outcomes: [], whatWorkedWell: [], whatToImprove: [], openIssues: [] },
    });
    mockDocxCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FEISHU_API_ERROR', message: 'doc create failed' },
    });

    await archiveSkill.run(makeCtx(makeEvent('归档')));

    expect(mockPatchCard).toHaveBeenCalledOnce(); // 仍然 patch final，不走 error
    const finalArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    expect(finalArgs.reportDocUrl).toBeUndefined(); // 没 doc URL
    expect(finalArgs.errorMessage).toBeUndefined(); // 也不是 error 态
  });

  it('issue #114 verify: outcomes 不在 source 里 → 被 drop', async () => {
    mockBitableFind
      .mockResolvedValueOnce({
        ok: true,
        value: {
          records: [{ content: '校园打卡 App 项目，决定用高德 SDK' }],
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { records: [{ content: '采用 高德 方案' }], hasMore: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { records: [{ content: '完成 定位 集成', status: 'done' }], hasMore: false },
      });
    // LLM 返回一个真实条目 + 一个完全不在 source 里的虚构条目
    mockLLMAskStructured.mockResolvedValueOnce({
      ok: true,
      value: {
        goal: '校园打卡 App',
        outcomes: [
          '完成 高德 定位 集成', // ✓ 跟 source 大量重合
          '完成了 OAuth 微信登录支付系统', // ✗ source 完全没提
        ],
        whatWorkedWell: [],
        whatToImprove: [],
        openIssues: [],
      },
    });

    await archiveSkill.run(makeCtx(makeEvent('归档')));

    const finalArgs = mockCardBuilderBuild.mock.calls.at(-1)![1];
    // 模板渲染应该只包含 grounded 那条
    expect(finalArgs.summary).toContain('高德');
    expect(finalArgs.summary).not.toContain('OAuth');
    expect(finalArgs.summary).not.toContain('微信');
  });
});

// ─── ArchiveSummarySchema 单元测试（防 LLM 输出畸形）────────────────────────

describe('ArchiveSummarySchema', () => {
  it('parses valid full structure', () => {
    const parsed = ArchiveSummarySchema.parse({
      goal: 'g',
      outcomes: ['a'],
      whatWorkedWell: ['b'],
      whatToImprove: ['c'],
      openIssues: ['d'],
    });
    expect(parsed.goal).toBe('g');
  });

  it('throws on missing goal field', () => {
    expect(() =>
      ArchiveSummarySchema.parse({ outcomes: [], whatWorkedWell: [], whatToImprove: [], openIssues: [] }),
    ).toThrow(/goal/);
  });

  it('throws on non-string array element', () => {
    expect(() =>
      ArchiveSummarySchema.parse({
        goal: 'g',
        outcomes: [123], // 不是 string
        whatWorkedWell: [],
        whatToImprove: [],
        openIssues: [],
      }),
    ).toThrow(/outcomes/);
  });

  it('jsonSchema returns 5 required fields', () => {
    const schema = ArchiveSummarySchema.jsonSchema!() as { required: string[] };
    expect(schema.required).toEqual([
      'goal',
      'outcomes',
      'whatWorkedWell',
      'whatToImprove',
      'openIssues',
    ]);
  });
});

// ─── renderArchiveSummary 单元测试（结构化 → 自然语言）──────────────────────

describe('renderArchiveSummary', () => {
  it('renders full summary in 100-200 字 range', () => {
    const text = renderArchiveSummary(
      {
        goal: '校园骑行打卡 App',
        outcomes: ['PRD 已落地', 'UI + 定位 + 排行榜上线'],
        whatWorkedWell: ['提前选定 SDK', 'MVP 范围卡得严'],
        whatToImprove: ['分享卡片延期'],
        openIssues: ['分享卡片 pending'],
      },
      { decisionCount: 5, taskCompletion: '8/10' },
    );
    expect(text).toContain('校园骑行打卡');
    expect(text).toContain('PRD 已落地');
    expect(text).toContain('5 项决策');
    expect(text).toContain('8/10');
    expect(text.length).toBeLessThan(300);
  });

  it('empty goal → static fallback (anti-hallucination escape)', () => {
    const text = renderArchiveSummary(
      { goal: '', outcomes: [], whatWorkedWell: [], whatToImprove: [], openIssues: [] },
      { decisionCount: 0, taskCompletion: null },
    );
    expect(text).toContain('已收尾');
    expect(text).toContain('@bot');
  });

  it('skips empty arrays without producing empty sentences', () => {
    const text = renderArchiveSummary(
      { goal: 'g', outcomes: ['o'], whatWorkedWell: [], whatToImprove: [], openIssues: [] },
      { decisionCount: 1, taskCompletion: null },
    );
    expect(text).not.toContain('顺利之处：。');
    expect(text).not.toContain('待改进：。');
    expect(text).toContain('1 项决策');
  });

  it('numbers in summary always come from computed argument, never from LLM', () => {
    // 即便 summary 对象的字段都是文字（无数字），渲染器也不会从 LLM 输出
    // 拼出任何数字 —— 数字唯一来源是 computed 参数
    const text = renderArchiveSummary(
      {
        goal: 'g',
        outcomes: ['claim 100% complete'], // 文字里有数字也只是文字
        whatWorkedWell: [],
        whatToImprove: [],
        openIssues: [],
      },
      { decisionCount: 7, taskCompletion: '5/9' },
    );
    expect(text).toContain('7 项决策');
    expect(text).toContain('5/9');
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

  it('recognizes [演练复盘] prefix as slides kind (issue #102)', () => {
    const memories: BitableRow[] = [
      {
        content:
          '[演练复盘] 已完成 2 轮迭代\n累计采纳改动 3 条\n新版 PPT：https://example.feishu.cn/slides/v2',
        created_at: 100,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('slides');
    expect(links[0]!.label).toBe('演练后新版 PPT');
    expect(links[0]!.url).toBe('https://example.feishu.cn/slides/v2');
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

  // ─── 实战 bug 修复回归 case（复赛实测 PR #116 后发现的）─────────────────────

  // bug：同一个 PPT URL 在 3 条 memory 里出现（slides 写一次 + 群里被动观察捕获 2 次）
  // → 原版会列 3 条（1 演示 PPT + 2 相关文档），UX 灾难
  it('dedupes same URL across multiple memory entries — keeps prefixed entry', () => {
    const sharedPptUrl = 'https://example.feishu.cn/slides/abc123';
    const memories: BitableRow[] = [
      {
        content: '今天看一下 PPT 在这 ' + sharedPptUrl,
        created_at: 1,
      } as unknown as BitableRow,
      {
        content: `[slides] 期末汇报\n${sharedPptUrl}`,
        created_at: 2,
      } as unknown as BitableRow,
      {
        content: '@bot 这个 PPT ' + sharedPptUrl + ' 帮我看一下',
        created_at: 3,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    // 同 URL 只能出现 1 次，且必须是有 [slides] 前缀的"演示 PPT"标签
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('slides');
    expect(links[0]!.label).toBe('演示 PPT');
    expect(links[0]!.url).toBe(sharedPptUrl);
  });

  // bug：没前缀的 PPT 链接被标"相关文档"，让用户失去信任
  // → 改进后按 URL 路径推断：/slides/ → 演示 PPT
  it('infers label from URL path for non-prefixed entries', () => {
    const memories: BitableRow[] = [
      {
        content: '群里贴的链接 https://x.feishu.cn/slides/abc',
        created_at: 1,
      } as unknown as BitableRow,
      {
        content: '另一个 https://x.feishu.cn/sheets/xyz',
        created_at: 2,
      } as unknown as BitableRow,
      {
        content: '文档 https://x.feishu.cn/docx/doc1',
        created_at: 3,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    // 注意：inferred 桶最多 2 条，所以 3 条里只有 2 条入选（按 recordedAt 倒序）
    expect(links.length).toBeLessThanOrEqual(2);
    // 最新两条：docx + sheets
    expect(links.find((l) => l.url.includes('/docx/'))?.label).toBe('飞书文档');
    expect(links.find((l) => l.url.includes('/sheets/'))?.label).toBe('飞书表格');
    // slides 那条因为按 recordedAt 排序排在第三位被截掉，没有任何 link 是 "相关文档"
    expect(links.every((l) => l.label !== '相关文档')).toBe(true);
  });

  // canonical URL：feishu 链接带不带 query 参数都视为同一个
  it('canonicalizes URL — same path with different query strings treated as one', () => {
    const memories: BitableRow[] = [
      {
        content: '[需求文档] PRD\nhttps://x.feishu.cn/docx/abc?from=share',
        created_at: 1,
      } as unknown as BitableRow,
      {
        content: '另一个版本 https://x.feishu.cn/docx/abc#section',
        created_at: 2,
      } as unknown as BitableRow,
    ];
    const links = extractLinksFromMemory(memories);
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('requirementDoc'); // 显式标注 win
  });
});
