import { describe, it, expect, vi } from 'vitest';
import { ErrorCode } from '@seedhac/contracts';
import type { SlidesOutline } from '@seedhac/contracts';
import { LarkSlidesClient } from '../slides-client.js';

function findSlidesArg(execFile: ReturnType<typeof vi.fn>): string {
  const call = execFile.mock.calls[0];
  if (!call) throw new Error('execFile was not called');
  const args = call[1] as string[];
  const idx = args.indexOf('--slides');
  const value = args[idx + 1];
  if (!value) throw new Error('missing --slides');
  return value;
}

describe('LarkSlidesClient — edge cases', () => {
  it('escapes XML-special chars in titles and card text', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'https://example.feishu.cn/slides/sldcnXXX',
      stderr: '',
    });
    const slides = new LarkSlidesClient({ execFile });
    const outline: SlidesOutline = {
      title: 'A & B <script>',
      slides: [
        {
          type: 'cover',
          title: 'Risks & "edge" cases <hi>',
          subtitle: "user's input",
        },
        {
          type: 'overview',
          title: 'Tom & Jerry',
          cards: [{ title: '<b>bold</b>', value: '"q"', detail: "it's & fine" }],
        },
      ],
    };

    const result = await slides.createFromOutline(outline.title, outline);
    expect(result.ok).toBe(true);

    const slidesArg = findSlidesArg(execFile);
    // raw special chars must NOT leak through into the rendered XML payload
    expect(slidesArg).not.toMatch(/<script>/);
    expect(slidesArg).not.toMatch(/<b>bold<\/b>/);
    // they must appear escaped instead
    expect(slidesArg).toContain('&amp;');
    expect(slidesArg).toContain('&lt;');
    expect(slidesArg).toContain('&gt;');
    expect(slidesArg).toContain('&quot;');
    expect(slidesArg).toContain('&apos;');
  });

  it('renders timeline / risks / nextSteps / closing slide types without throwing', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'https://example.feishu.cn/slides/sldcnTYPES',
      stderr: '',
    });
    const slides = new LarkSlidesClient({ execFile });

    const outline: SlidesOutline = {
      title: '全类型演示',
      slides: [
        { type: 'cover', title: '封面', subtitle: '副标题' },
        {
          type: 'timeline',
          title: '时间线',
          milestones: [
            { label: '调研', date: '04-22', status: '完成' },
            { label: '复赛', date: '05-06', status: '进行中' },
            { label: '决赛', date: '05-14', status: '待定' },
          ],
        },
        {
          type: 'risks',
          title: '风险',
          risks: [
            { risk: 'API 限流', impact: '高', mitigation: '本地降级' },
            { risk: '权限范围', impact: '中', mitigation: 'scope check' },
          ],
        },
        {
          type: 'nextSteps',
          title: '下一步',
          tasks: [
            { owner: 'Edwin', task: '部署', due: '05-09' },
            { owner: 'Antares', task: '答辩稿' },
          ],
        },
        {
          type: 'closing',
          title: '结语',
          bullets: ['点 1', '点 2', '点 3'],
        },
      ],
    };

    const result = await slides.createFromOutline(outline.title, outline);
    expect(result.ok).toBe(true);

    const slidesArg = findSlidesArg(execFile);
    const parsed = JSON.parse(slidesArg) as string[];
    expect(parsed).toHaveLength(5);
    // each rendered slide should have well-formed open/close tags
    for (const xml of parsed) {
      expect(xml.startsWith('<slide')).toBe(true);
      expect(xml.endsWith('</slide>')).toBe(true);
    }
    // timeline labels show up
    expect(slidesArg).toContain('调研');
    expect(slidesArg).toContain('决赛');
    // risks rendered
    expect(slidesArg).toContain('API 限流');
    // nextSteps rendered
    expect(slidesArg).toContain('Edwin');
    // closing bullets rendered
    expect(slidesArg).toContain('点 1');
  });

  it('falls back gracefully when timeline/risks/nextSteps rely on cards instead of typed lists', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'https://example.feishu.cn/slides/sldcnFALLBACK',
      stderr: '',
    });
    const slides = new LarkSlidesClient({ execFile });

    const outline: SlidesOutline = {
      title: '回退渲染',
      slides: [
        {
          type: 'timeline',
          title: '时间线（用 cards 兜底）',
          cards: [
            { title: '里程碑 1', value: '04-22', detail: '完成' },
            { title: '里程碑 2', value: '05-06', detail: '进行中' },
          ],
        },
        {
          type: 'risks',
          title: '风险（用 cards 兜底）',
          cards: [{ title: '风险 1', value: '高', detail: '应对 1' }],
        },
        {
          type: 'nextSteps',
          title: '行动（用 cards 兜底）',
          cards: [{ title: '动作 1', value: 'Edwin', detail: '05-12' }],
        },
      ],
    };

    const result = await slides.createFromOutline(outline.title, outline);
    expect(result.ok).toBe(true);
    const slidesArg = findSlidesArg(execFile);
    expect(slidesArg).toContain('里程碑 1');
    expect(slidesArg).toContain('风险 1');
    expect(slidesArg).toContain('动作 1');
  });

  it('handles a long outline (40 slides) without exceeding maxBuffer', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'https://example.feishu.cn/slides/sldcnLONG',
      stderr: '',
    });
    const slides = new LarkSlidesClient({ execFile });

    const longBullet = 'x'.repeat(800);
    const slidesArr = Array.from({ length: 40 }, (_, i) => ({
      type: 'overview' as const,
      title: `第 ${i + 1} 页 ${longBullet}`,
      cards: [
        { title: longBullet, value: `0${i}`, detail: longBullet },
        { title: longBullet, value: `0${i}`, detail: longBullet },
      ],
    }));

    const outline: SlidesOutline = { title: '长 outline', slides: slidesArr };
    const result = await slides.createFromOutline(outline.title, outline);
    expect(result.ok).toBe(true);

    const slidesArg = findSlidesArg(execFile);
    const parsed = JSON.parse(slidesArg) as string[];
    expect(parsed).toHaveLength(40);
  });

  it('returns FEISHU_API_ERROR when stdout has neither URL nor token nor xml_presentation_id', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ok: true, data: { revision_id: 1 } }),
      stderr: 'something odd happened',
    });
    const slides = new LarkSlidesClient({ execFile });

    const result = await slides.createFromOutline('ghost output', {
      title: 'ghost',
      slides: [{ type: 'cover', title: 'ghost' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.FEISHU_API_ERROR);
      expect(result.error.message).toMatch(/did not return a slides url/);
    }
  });

  it('extracts the URL even when CLI prefixes garbage and a trailing period', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'INFO ready. visit https://example.feishu.cn/slides/sldcnDOT.\nbye',
      stderr: '',
    });
    const slides = new LarkSlidesClient({ execFile });

    const result = await slides.createFromOutline('punct', {
      title: 'punct',
      slides: [{ type: 'cover', title: 'punct' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slidesToken).toBe('sldcnDOT');
      expect(result.value.url).toBe('https://example.feishu.cn/slides/sldcnDOT');
    }
  });

  it('grant: stops at first failure and reports which user failed', async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true }), stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ ok: false, code: 1254000, msg: 'permission denied' }),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true }), stderr: '' });
    const slides = new LarkSlidesClient({ bin: 'lark-cli', as: 'bot', execFile });

    const result = await slides.grantMembersEdit('sldcnGRANT', ['ou_a', 'ou_b', 'ou_c']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.FEISHU_API_ERROR);
      expect(result.error.message).toContain('ou_b');
    }
    // third user must NOT be attempted after a failure
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('grant: detects ok=false even when wrapped in {data:{...}}', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ data: { ok: false }, code: 1 }),
      stderr: '',
    });
    const slides = new LarkSlidesClient({ bin: 'lark-cli', as: 'bot', execFile });

    const result = await slides.grantMembersEdit('sldcnGRANT2', ['ou_x']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.FEISHU_API_ERROR);
    }
  });

  it('uses --as bot by default (matches the production comment)', async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'https://example.feishu.cn/slides/sldcnDEFAULT',
      stderr: '',
    });
    const slides = new LarkSlidesClient({ execFile });
    const result = await slides.createFromOutline('default identity', {
      title: 'default identity',
      slides: [{ type: 'cover', title: 'cover' }],
    });
    expect(result.ok).toBe(true);
    const args = execFile.mock.calls[0]?.[1] as string[];
    const asIdx = args.indexOf('--as');
    expect(args[asIdx + 1]).toBe('bot');
  });
});
