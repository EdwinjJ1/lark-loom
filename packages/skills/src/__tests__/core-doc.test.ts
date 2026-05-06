import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@seedhac/contracts';
import {
  appendDecision,
  appendRecentActivity,
  findCoreDocToken,
  rewriteBackground,
  rewriteBlockers,
  rewriteDefinition,
  rewriteDeliverables,
  rewriteOKR,
  rewriteStakeholders,
  rewriteStatus,
  SECTION,
  type CoreDocCtx,
} from '../core-doc.js';

const findMock = vi.fn();
const insertMock = vi.fn();
const appendToSectionMock = vi.fn();
const replaceSectionMock = vi.fn();

function makeCtx(): CoreDocCtx {
  return {
    bitable: {
      find: findMock,
      insert: insertMock,
    } as unknown as CoreDocCtx['bitable'],
    docx: {
      appendToSection: appendToSectionMock,
      replaceSection: replaceSectionMock,
    } as unknown as CoreDocCtx['docx'],
    logger: { warn: vi.fn(), info: vi.fn() },
  };
}

const HAVE_CORE_DOC = ok({
  records: [
    {
      content: '[核心文档] 项目核心文档 - 测试群\nhttps://x.feishu.cn/docx/dt1',
      created_at: 100,
    },
  ],
  hasMore: false,
});

const NO_CORE_DOC = ok({ records: [], hasMore: false });

describe('findCoreDocToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns docToken when memory has [核心文档] entry', async () => {
    findMock.mockResolvedValueOnce(HAVE_CORE_DOC);
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe('dt1');
  });

  it('returns null when no [核心文档] entry exists', async () => {
    findMock.mockResolvedValueOnce(
      ok({ records: [{ content: '[需求文档] foo\nhttps://x.feishu.cn/docx/r1' }], hasMore: false }),
    );
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe(null);
  });

  it('returns null when bitable.find fails', async () => {
    findMock.mockResolvedValueOnce({ ok: false, error: { code: 'X', message: 'fail' } });
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe(null);
  });

  it('matches feishu URL without tenant subdomain (PR #131 regex bug fix)', async () => {
    findMock.mockResolvedValueOnce(
      ok({
        records: [
          {
            content: '[核心文档] doc\nhttps://feishu.cn/docx/abc123',
            created_at: 100,
          },
        ],
        hasMore: false,
      }),
    );
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe('abc123');
  });
});

// ─── Rewrite-from-data helpers ────────────────────────────────────────

describe('rewrite helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMock.mockResolvedValue(HAVE_CORE_DOC);
    replaceSectionMock.mockResolvedValue(ok(undefined));
    appendToSectionMock.mockResolvedValue(ok(undefined));
  });

  it('rewriteDefinition writes one paragraph to 一句话定义', async () => {
    await rewriteDefinition(makeCtx(), 'chat_1', '校园打卡 App，鼓励运动习惯');
    expect(replaceSectionMock).toHaveBeenCalledWith(
      'dt1',
      SECTION.DEFINITION,
      expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]),
    );
  });

  it('rewriteDefinition skips if empty input', async () => {
    await rewriteDefinition(makeCtx(), 'chat_1', '   ');
    expect(replaceSectionMock).not.toHaveBeenCalled();
  });

  it('rewriteOKR renders O paragraph + KR bullets', async () => {
    await rewriteOKR(makeCtx(), 'chat_1', {
      objective: '让大学生养成运动习惯',
      keyResults: ['MVP 上线', '100 用户 DAU'],
    });
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.OKR);
    expect(call).toBeDefined();
    const blocks = call![2] as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toContain('让大学生养成运动习惯');
    expect(blocks[1]!.text).toContain('KR1');
    expect(blocks[2]!.text).toContain('KR2');
  });

  it('rewriteBackground includes both background prose and goals bullets', async () => {
    await rewriteBackground(
      makeCtx(),
      'chat_1',
      '大学生缺乏运动激励的问题',
      ['游戏化打卡', '校园定位'],
    );
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.BACKGROUND);
    const blocks = call![2] as Array<{ type: string; text: string }>;
    expect(blocks.some((b) => b.text.includes('大学生'))).toBe(true);
    expect(blocks.some((b) => b.text.includes('游戏化'))).toBe(true);
  });

  it('rewriteDeliverables empty input → 占位段', async () => {
    await rewriteDeliverables(makeCtx(), 'chat_1', []);
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.DELIVERABLES);
    const blocks = call![2] as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toContain('暂无产出');
  });

  it('rewriteDeliverables renders icon + label + URL per link', async () => {
    await rewriteDeliverables(makeCtx(), 'chat_1', [
      { kind: 'requirementDoc', label: '需求文档', url: 'https://x.feishu.cn/docx/r' },
      { kind: 'slides', label: '演示 PPT', url: 'https://x.feishu.cn/slides/p' },
    ]);
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.DELIVERABLES);
    const blocks = call![2] as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toContain('📋');
    expect(blocks[0]!.text).toContain('需求文档');
    expect(blocks[1]!.text).toContain('🎯');
  });

  it('rewriteStakeholders renders members with optional roles', async () => {
    await rewriteStakeholders(makeCtx(), 'chat_1', [
      { name: '张三', role: '产品' },
      { name: '李四' },
    ]);
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.STAKEHOLDERS);
    const blocks = call![2] as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toBe('张三 — 产品');
    expect(blocks[1]!.text).toBe('李四');
  });

  it('rewriteStatus health = On track when no blockers', async () => {
    await rewriteStatus(makeCtx(), 'chat_1', {
      blockerCount: 0,
      doneCount: 5,
      totalTaskCount: 10,
    });
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.STATUS);
    const block = (call![2] as Array<{ text: string }>)[0]!;
    expect(block.text).toContain('On track');
    expect(block.text).toContain('5/10');
  });

  it('rewriteStatus health = At risk when 1-2 blockers', async () => {
    await rewriteStatus(makeCtx(), 'chat_1', {
      blockerCount: 2,
      doneCount: 0,
      totalTaskCount: 0,
    });
    const block = (replaceSectionMock.mock.calls[0]![2] as Array<{ text: string }>)[0]!;
    expect(block.text).toContain('At risk');
  });

  it('rewriteStatus health = Off track when 3+ blockers', async () => {
    await rewriteStatus(makeCtx(), 'chat_1', {
      blockerCount: 5,
      doneCount: 0,
      totalTaskCount: 0,
    });
    const block = (replaceSectionMock.mock.calls[0]![2] as Array<{ text: string }>)[0]!;
    expect(block.text).toContain('Off track');
  });

  it('rewriteBlockers empty → 显示 ✅ 暂无阻塞', async () => {
    await rewriteBlockers(makeCtx(), 'chat_1', []);
    const call = replaceSectionMock.mock.calls.find((c) => c[1] === SECTION.BLOCKERS);
    const block = (call![2] as Array<{ text: string }>)[0]!;
    expect(block.text).toContain('暂无阻塞');
  });

  it('rewriteBlockers renders bullets with source pointer', async () => {
    await rewriteBlockers(makeCtx(), 'chat_1', [
      { title: 'iOS 后台定位权限', source: 'msg_xxx' },
    ]);
    const block = (replaceSectionMock.mock.calls[0]![2] as Array<{ text: string }>)[0]!;
    expect(block.text).toContain('iOS 后台');
    expect(block.text).toContain('msg_xxx');
  });

  it('skips silently when no core doc found', async () => {
    findMock.mockResolvedValueOnce(NO_CORE_DOC);
    findMock.mockResolvedValueOnce(NO_CORE_DOC); // fallback also empty
    await rewriteOKR(makeCtx(), 'chat_1', { objective: 'x', keyResults: [] });
    expect(replaceSectionMock).not.toHaveBeenCalled();
  });
});

// ─── Append-only helpers ───────────────────────────────────────────────

describe('append helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMock.mockResolvedValue(HAVE_CORE_DOC);
    appendToSectionMock.mockResolvedValue(ok(undefined));
  });

  it('appendDecision writes to 关键决策 + 最近动态', async () => {
    await appendDecision(makeCtx(), 'chat_1', { title: '选用高德 SDK' });
    expect(appendToSectionMock).toHaveBeenCalledTimes(2);
    const sections = appendToSectionMock.mock.calls.map((c) => c[1]);
    expect(sections).toContain(SECTION.DECISIONS);
    expect(sections).toContain(SECTION.RECENT);
  });

  it('appendDecision includes [Supersedes Dxx] when supersedes set', async () => {
    await appendDecision(makeCtx(), 'chat_1', {
      title: '改用百度',
      supersedes: 'D1',
    });
    const decisionCall = appendToSectionMock.mock.calls.find((c) => c[1] === SECTION.DECISIONS);
    const blockText = (decisionCall![2] as Array<{ text: string }>)[0]!.text;
    expect(blockText).toContain('改用百度');
    expect(blockText).toContain('Supersedes D1');
  });

  it('appendRecentActivity prepends type tag', async () => {
    await appendRecentActivity(makeCtx(), 'chat_1', '完成', 'PRD v1 已落地');
    const block = (appendToSectionMock.mock.calls[0]![2] as Array<{ text: string }>)[0]!;
    expect(block.text).toContain('[完成]');
    expect(block.text).toContain('PRD v1');
  });

  it('warns but does not throw when appendToSection fails', async () => {
    appendToSectionMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'X', message: 'patch failed' },
    });
    await expect(
      appendDecision(makeCtx(), 'chat_1', { title: 'x' }),
    ).resolves.toBeUndefined();
  });
});
