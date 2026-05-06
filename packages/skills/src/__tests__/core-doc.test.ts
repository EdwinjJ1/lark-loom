import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@seedhac/contracts';
import {
  appendBlocker,
  appendDecision,
  appendMilestone,
  findCoreDocToken,
  type CoreDocCtx,
} from '../core-doc.js';

const findMock = vi.fn();
const insertMock = vi.fn();
const appendToSectionMock = vi.fn();

function makeCtx(): CoreDocCtx {
  return {
    bitable: {
      find: findMock,
      insert: insertMock,
    } as unknown as CoreDocCtx['bitable'],
    docx: {
      appendToSection: appendToSectionMock,
    } as unknown as CoreDocCtx['docx'],
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
    },
  };
}

describe('findCoreDocToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendToSectionMock.mockResolvedValue(ok(undefined));
  });

  it('returns docToken when memory has [核心文档] entry', async () => {
    findMock.mockResolvedValueOnce(
      ok({
        records: [
          {
            content: '[核心文档] 项目核心文档 - 测试群\nhttps://x.feishu.cn/docx/abc123',
            created_at: 100,
          },
        ],
        hasMore: false,
      }),
    );
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe('abc123');
  });

  it('picks the latest entry when multiple exist', async () => {
    findMock.mockResolvedValueOnce(
      ok({
        records: [
          {
            content: '[核心文档] old\nhttps://x.feishu.cn/docx/old123',
            created_at: 100,
          },
          {
            content: '[核心文档] new\nhttps://x.feishu.cn/docx/new123',
            created_at: 200,
          },
        ],
        hasMore: false,
      }),
    );
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe('new123');
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

  it('returns null when content has no docx URL', async () => {
    findMock.mockResolvedValueOnce(
      ok({
        records: [{ content: '[核心文档] no url here', created_at: 100 }],
        hasMore: false,
      }),
    );
    const token = await findCoreDocToken(makeCtx(), 'chat_1');
    expect(token).toBe(null);
  });
});

describe('appendDecision / appendMilestone / appendBlocker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMock.mockResolvedValue(
      ok({
        records: [
          {
            content: '[核心文档] doc\nhttps://x.feishu.cn/docx/dt1',
            created_at: 100,
          },
        ],
        hasMore: false,
      }),
    );
    appendToSectionMock.mockResolvedValue(ok(undefined));
  });

  it('appendDecision writes to 决策日志 + 完整时间线', async () => {
    await appendDecision(makeCtx(), 'chat_1', { title: '选用高德 SDK' });
    // 至少 2 次：决策日志 + 时间线
    expect(appendToSectionMock).toHaveBeenCalledTimes(2);
    const sections = appendToSectionMock.mock.calls.map((c) => c[1]);
    expect(sections).toContain('决策日志');
    expect(sections).toContain('完整时间线');
  });

  it('appendDecision includes [Supersedes Dxx] when supersedes set', async () => {
    await appendDecision(makeCtx(), 'chat_1', {
      title: '改用百度',
      supersedes: 'D1',
    });
    const decisionCall = appendToSectionMock.mock.calls.find((c) => c[1] === '决策日志');
    expect(decisionCall).toBeDefined();
    const blockText = (decisionCall![2] as Array<{ text: string }>)[0]!.text;
    expect(blockText).toContain('改用百度');
    expect(blockText).toContain('Supersedes D1');
  });

  it('appendMilestone with url writes to 项目里程碑', async () => {
    await appendMilestone(makeCtx(), 'chat_1', {
      type: 'completion',
      title: '演示 PPT 已生成',
      url: 'https://x.feishu.cn/slides/abc',
    });
    const milestoneCall = appendToSectionMock.mock.calls.find((c) => c[1] === '项目里程碑');
    expect(milestoneCall).toBeDefined();
    const blockText = (milestoneCall![2] as Array<{ text: string }>)[0]!.text;
    expect(blockText).toContain('演示 PPT');
    expect(blockText).toContain('https://x.feishu.cn/slides/abc');
  });

  it('appendBlocker writes to 阻塞与风险 with [Open] tag', async () => {
    await appendBlocker(makeCtx(), 'chat_1', { title: 'iOS 后台定位权限 pending' });
    const blockerCall = appendToSectionMock.mock.calls.find((c) => c[1] === '阻塞与风险');
    expect(blockerCall).toBeDefined();
    const blockText = (blockerCall![2] as Array<{ text: string }>)[0]!.text;
    expect(blockText).toContain('iOS 后台定位');
    expect(blockText).toContain('[Open]');
  });

  it('skips silently when no core doc found (memory has no [核心文档] entry)', async () => {
    findMock.mockResolvedValueOnce(ok({ records: [], hasMore: false }));
    await appendDecision(makeCtx(), 'chat_1', { title: '选用高德' });
    expect(appendToSectionMock).not.toHaveBeenCalled();
  });

  it('warns but does not throw when appendToSection fails', async () => {
    appendToSectionMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'X', message: 'patch failed' },
    });
    await expect(
      appendDecision(makeCtx(), 'chat_1', { title: '选用高德' }),
    ).resolves.toBeUndefined();
  });
});
