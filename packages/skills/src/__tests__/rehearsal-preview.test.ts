/**
 * Rehearsal v2 — preview prompt + attribution 校验单测（issue #145 P1+P3）
 *
 * 关注点：
 *   - SpeakerTranscriptPageSchema 严格 enforce 三段式长度 + cite 白名单 + 禁用词
 *   - ListenerCritiqueBatchSchema page 范围 + evidence 长度 + cite 必填
 *   - AttributionResultSchema yes/no/unsure
 *   - verifyAttribution: cite 白名单外的整条直接 dropped；no → dropped；unsure → 保留
 */

import { describe, expect, it, vi } from 'vitest';
import { ok, err, makeError, ErrorCode, type LLMClient } from '@seedhac/contracts';
import {
  AttributionResultSchema,
  CrossCheckResultSchema,
  SpeakerTranscriptPageSchema,
  containsBannedPhrase,
  isCiteInWhitelist,
  makeListenerCritiqueBatchSchema,
  type ListenerCritique,
  type PreviewDocSection,
  type PreviewSlideInput,
} from '../prompts/rehearsal-preview.js';
import { crossCheckConsistency, verifyAttribution } from '../utils/attribution.js';

const SAMPLE_PAGES: readonly PreviewSlideInput[] = [
  { page: 1, title: '封面', bullets: ['项目 X 进度汇报'] },
  { page: 2, title: '商业模式', bullets: ['三年覆盖头部 20% 客户'] },
  { page: 3, title: '混合检索', bullets: ['BM25 + 向量', '准确率提升 18%'] },
];

const SAMPLE_DOC: readonly PreviewDocSection[] = [
  { section: 'OKR', content: 'KR1 年内覆盖头部 20% 客户' },
  { section: '架构', content: '采用混合检索是因为单独向量在长尾词召回低 30%' },
];

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ─── SpeakerTranscriptPageSchema ──────────────────────────────────────────────

describe('SpeakerTranscriptPageSchema', () => {
  it('合规输入 → parse 通过', () => {
    const out = SpeakerTranscriptPageSchema.parse({
      page: 3,
      hook: '为什么不只用向量检索？',
      core: '我们对比过纯向量、纯 BM25 和混合方案三种召回模式，混合在长尾词上召回提升 30%。',
      transition: '下一页讲落地。',
      cite: ['ppt.p3', 'doc.section.架构'],
      evidence: 'PPT p3 + doc 架构段',
    });
    expect(out.page).toBe(3);
    expect(out.cite).toContain('ppt.p3');
  });

  it('包含禁用词 → throw', () => {
    expect(() =>
      SpeakerTranscriptPageSchema.parse({
        page: 1,
        hook: '综上所述这就是封面',
        core: '我们要讲一个综合性故事，它涵盖了多个维度的内容。',
        transition: '继续下一页',
        cite: ['ppt.p1'],
        evidence: 'PPT p1',
      }),
    ).toThrow(/banned phrase/);
  });

  it('hook 太短 → throw', () => {
    expect(() =>
      SpeakerTranscriptPageSchema.parse({
        page: 1,
        hook: '太短',
        core: '我们要讲的内容。这是一个长度足够的核心段落，描述了一些细节。',
        transition: '继续下一页',
        cite: ['ppt.p1'],
        evidence: 'PPT p1',
      }),
    ).toThrow(/hook too short/);
  });

  it('cite 为空 → throw', () => {
    expect(() =>
      SpeakerTranscriptPageSchema.parse({
        page: 1,
        hook: '一个合规长度的钩子句子',
        core: '我们要讲的内容。这是一个长度足够的核心段落，描述了一些细节。',
        transition: '继续下一页',
        cite: [],
        evidence: 'evidence here',
      }),
    ).toThrow(/cite/);
  });
});

// ─── containsBannedPhrase ────────────────────────────────────────────────────

describe('containsBannedPhrase', () => {
  it.each([
    ['综上所述这是结尾', '综上所述'],
    ['接下来让我们看看', '接下来让我们'],
    ['由此可见这事', '由此可见'],
  ])('%s → 匹配 %s', (input, expected) => {
    expect(containsBannedPhrase(input)).toBe(expected);
  });

  it('真人讲稿 → null', () => {
    expect(containsBannedPhrase('我们的混合检索召回提升了 30%。')).toBeNull();
  });
});

// ─── ListenerCritiqueBatchSchema ─────────────────────────────────────────────

describe('makeListenerCritiqueBatchSchema(totalPages)', () => {
  const schema = makeListenerCritiqueBatchSchema(3);

  it('合规批量 → parse 通过', () => {
    const out = schema.parse({
      critiques: [
        {
          category: 'consistency',
          page: 2,
          text: 'PPT 与 doc 数字不一致：ppt 说 50% 而 doc OKR 说 20%',
          evidence: 'ppt.p2: 50% / doc.OKR: 20%',
          cite: 'ppt.p2',
          confidence: 0.9,
        },
      ],
    });
    expect(out.critiques.length).toBe(1);
    expect(out.critiques[0]!.category).toBe('consistency');
  });

  it('page 超过 totalPages 的条目 → 静默丢弃', () => {
    const out = schema.parse({
      critiques: [
        {
          category: 'audience',
          page: 99,
          text: '这条超出页码会被丢',
          evidence: '随便贴一段超过 10 字的原文片段',
          cite: 'ppt.p99',
          confidence: 0.8,
        },
        {
          category: 'audience',
          page: 1,
          text: '这条 page 在范围内会保留',
          evidence: '随便贴一段超过 10 字的原文片段',
          cite: 'ppt.p1',
          confidence: 0.7,
        },
      ],
    });
    expect(out.critiques.length).toBe(1);
    expect(out.critiques[0]!.page).toBe(1);
  });

  it('evidence 太短 → 丢', () => {
    const out = schema.parse({
      critiques: [
        {
          category: 'audience',
          page: 1,
          text: '一个长度合规的 critique 文本',
          evidence: '太短',
          cite: 'ppt.p1',
          confidence: 0.7,
        },
      ],
    });
    expect(out.critiques.length).toBe(0);
  });

  it('未知 category → 丢', () => {
    const out = schema.parse({
      critiques: [
        {
          category: 'random_unknown',
          page: 1,
          text: '一个长度合规的 critique 文本',
          evidence: '随便贴一段超过 10 字的原文片段',
          cite: 'ppt.p1',
          confidence: 0.7,
        },
      ],
    });
    expect(out.critiques.length).toBe(0);
  });
});

// ─── isCiteInWhitelist ───────────────────────────────────────────────────────

describe('isCiteInWhitelist', () => {
  it('ppt.p<N> 在范围内 → true', () => {
    expect(isCiteInWhitelist('ppt.p2', 3, ['OKR'])).toBe(true);
  });

  it('ppt.p<N> 越界 → false', () => {
    expect(isCiteInWhitelist('ppt.p99', 3, ['OKR'])).toBe(false);
  });

  it('doc.section.X 命中 → true', () => {
    expect(isCiteInWhitelist('doc.section.OKR', 3, ['OKR', '架构'])).toBe(true);
  });

  it('doc.section.X 找不到 → false', () => {
    expect(isCiteInWhitelist('doc.section.bgmoke', 3, ['OKR'])).toBe(false);
  });

  it('完全乱写 → false', () => {
    expect(isCiteInWhitelist('whatever', 3, ['OKR'])).toBe(false);
  });
});

// ─── AttributionResultSchema ─────────────────────────────────────────────────

describe('AttributionResultSchema', () => {
  it('verdict yes / no / unsure 都通过', () => {
    expect(AttributionResultSchema.parse({ verdict: 'yes' }).verdict).toBe('yes');
    expect(AttributionResultSchema.parse({ verdict: 'no' }).verdict).toBe('no');
    expect(AttributionResultSchema.parse({ verdict: 'unsure' }).verdict).toBe('unsure');
  });

  it('verdict 大小写容错', () => {
    expect(AttributionResultSchema.parse({ verdict: 'YES' }).verdict).toBe('yes');
  });

  it('verdict 无效 → throw', () => {
    expect(() => AttributionResultSchema.parse({ verdict: 'maybe' })).toThrow();
  });
});

// ─── CrossCheckResultSchema ─────────────────────────────────────────────────

describe('CrossCheckResultSchema', () => {
  it('合规输入', () => {
    const out = CrossCheckResultSchema.parse({
      verdict: 'inconsistent',
      note: 'PPT 50% vs doc 20% 不一致',
    });
    expect(out.verdict).toBe('inconsistent');
  });

  it('verdict 无效 → throw', () => {
    expect(() => CrossCheckResultSchema.parse({ verdict: 'whatever', note: 'x' })).toThrow();
  });
});

// ─── verifyAttribution ──────────────────────────────────────────────────────

function makeCritique(overrides: Partial<ListenerCritique>): ListenerCritique {
  return {
    category: 'audience',
    page: 1,
    text: '一个 critique',
    evidence: '原文片段超过 10 字符的占位',
    cite: 'ppt.p1',
    confidence: 0.8,
    ...overrides,
  };
}

function makeLLM(verdicts: readonly ('yes' | 'no' | 'unsure' | 'fail')[]): LLMClient {
  let i = 0;
  const askStructured = vi.fn(async () => {
    const v = verdicts[i++];
    if (v === 'fail') {
      return err(makeError(ErrorCode.LLM_INVALID_RESPONSE, 'mock fail'));
    }
    return ok({ verdict: v });
  });
  return {
    ask: vi.fn(),
    chat: vi.fn(),
    askStructured,
    chatWithTools: vi.fn(),
    embed: vi.fn(),
  } as unknown as LLMClient;
}

describe('verifyAttribution', () => {
  it('cite 不在白名单 → 直接 dropped，不调 LLM', async () => {
    const llm = makeLLM([]);
    const out = await verifyAttribution(
      { llm, logger },
      [makeCritique({ cite: 'ppt.p99' })],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(0);
    expect(llm.askStructured).not.toHaveBeenCalled();
  });

  it('verdict yes → confirmed', async () => {
    const llm = makeLLM(['yes']);
    const out = await verifyAttribution(
      { llm, logger },
      [makeCritique({})],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.attribution).toBe('confirmed');
  });

  it('verdict no → 整条 dropped', async () => {
    const llm = makeLLM(['no']);
    const out = await verifyAttribution(
      { llm, logger },
      [makeCritique({})],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(0);
  });

  it('verdict unsure → 保留为 unsure（进 review 卡 ⚠️ 类）', async () => {
    const llm = makeLLM(['unsure']);
    const out = await verifyAttribution(
      { llm, logger },
      [makeCritique({})],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.attribution).toBe('unsure');
  });

  it('LLM 失败 → fail-open, 标 unsure 让用户最终判断', async () => {
    const llm = makeLLM(['fail']);
    const out = await verifyAttribution(
      { llm, logger },
      [makeCritique({})],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.attribution).toBe('unsure');
  });

  it('cite 在白名单内但 LLM 多次失败 → 全部 unsure（fail-open）', async () => {
    const llm = makeLLM(['fail', 'fail', 'fail']);
    const out = await verifyAttribution(
      { llm, logger },
      [
        makeCritique({ page: 1, cite: 'ppt.p1' }),
        makeCritique({ page: 2, cite: 'ppt.p2' }),
        makeCritique({ page: 3, cite: 'ppt.p3' }),
      ],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(3);
    expect(out.every((c) => c.attribution === 'unsure')).toBe(true);
  });

  it('混合输入：白名单外 + yes + no + unsure', async () => {
    const llm = makeLLM(['yes', 'no', 'unsure']);
    const out = await verifyAttribution(
      { llm, logger },
      [
        makeCritique({ cite: 'ppt.p99' }), // dropped (whitelist)
        makeCritique({ page: 1, cite: 'ppt.p1' }), // yes
        makeCritique({ page: 2, cite: 'ppt.p2' }), // no
        makeCritique({ page: 3, cite: 'ppt.p3' }), // unsure
      ],
      SAMPLE_PAGES,
      SAMPLE_DOC,
    );
    expect(out.length).toBe(2);
    const map = Object.fromEntries(out.map((c) => [c.critique.page, c.attribution]));
    expect(map[1]).toBe('confirmed');
    expect(map[3]).toBe('unsure');
    expect(map[2]).toBeUndefined();
  });
});

// ─── crossCheckConsistency ──────────────────────────────────────────────────

function makeCrossCheckLLM(
  verdicts: readonly ('consistent' | 'inconsistent' | 'unclear' | 'fail')[],
): LLMClient {
  let i = 0;
  const askStructured = vi.fn(async () => {
    const v = verdicts[i++];
    if (v === 'fail') return err(makeError(ErrorCode.LLM_INVALID_RESPONSE, 'mock fail'));
    return ok({ verdict: v, note: `${v} note` });
  });
  return {
    ask: vi.fn(),
    chat: vi.fn(),
    askStructured,
    chatWithTools: vi.fn(),
    embed: vi.fn(),
  } as unknown as LLMClient;
}

describe('crossCheckConsistency', () => {
  it('空 pairs → 不调 LLM，返回空', async () => {
    const llm = makeCrossCheckLLM([]);
    const out = await crossCheckConsistency({ llm, logger }, []);
    expect(out.length).toBe(0);
    expect(llm.askStructured).not.toHaveBeenCalled();
  });

  it('全部 consistent → 不返回任何 finding（reduce noise）', async () => {
    const llm = makeCrossCheckLLM(['consistent', 'consistent']);
    const out = await crossCheckConsistency(
      { llm, logger },
      [
        { page: SAMPLE_PAGES[0]!, section: SAMPLE_DOC[0]! },
        { page: SAMPLE_PAGES[1]!, section: SAMPLE_DOC[0]! },
      ],
    );
    expect(out.length).toBe(0);
  });

  it('inconsistent + unclear 都返回，consistent 过滤掉', async () => {
    const llm = makeCrossCheckLLM(['inconsistent', 'consistent', 'unclear']);
    const out = await crossCheckConsistency(
      { llm, logger },
      [
        { page: SAMPLE_PAGES[0]!, section: SAMPLE_DOC[0]! },
        { page: SAMPLE_PAGES[1]!, section: SAMPLE_DOC[0]! },
        { page: SAMPLE_PAGES[2]!, section: SAMPLE_DOC[1]! },
      ],
    );
    expect(out.length).toBe(2);
    expect(out.find((f) => f.verdict === 'inconsistent')).toBeDefined();
    expect(out.find((f) => f.verdict === 'unclear')).toBeDefined();
  });

  it('LLM 失败 → 该对忽略（fail-safe），不挂整链路', async () => {
    const llm = makeCrossCheckLLM(['fail', 'inconsistent']);
    const out = await crossCheckConsistency(
      { llm, logger },
      [
        { page: SAMPLE_PAGES[0]!, section: SAMPLE_DOC[0]! },
        { page: SAMPLE_PAGES[1]!, section: SAMPLE_DOC[0]! },
      ],
    );
    expect(out.length).toBe(1);
    expect(out[0]!.verdict).toBe('inconsistent');
  });
});

// ─── 完整链路：speaker → listener → attribution 顺序 ───────────────────────

describe('speaker prompt 输出格式', () => {
  it('SPEAKER_PROMPT roadshow 风格包含轻盈语气提示', async () => {
    const { SPEAKER_PROMPT } = await import('../prompts/rehearsal-preview.js');
    const prompt = SPEAKER_PROMPT(
      { page: 1, title: 't', bullets: ['x'] },
      [{ section: 's', content: 'c' }],
      'roadshow',
    );
    expect(prompt).toContain('路演');
    expect(prompt).toContain('节奏轻盈');
  });

  it('SPEAKER_PROMPT judges 风格包含学术严谨提示', async () => {
    const { SPEAKER_PROMPT } = await import('../prompts/rehearsal-preview.js');
    const prompt = SPEAKER_PROMPT(
      { page: 1, title: 't', bullets: ['x'] },
      [{ section: 's', content: 'c' }],
      'judges',
    );
    expect(prompt).toContain('评委答辩');
    expect(prompt).toContain('学术严谨');
  });

  it('SPEAKER_PROMPT 显式列出禁用词', async () => {
    const { SPEAKER_PROMPT, BANNED_PHRASES } = await import('../prompts/rehearsal-preview.js');
    const prompt = SPEAKER_PROMPT(
      { page: 1, title: 't', bullets: [] },
      [],
      'judges',
    );
    expect(prompt).toContain('禁用词');
    for (const phrase of BANNED_PHRASES) {
      expect(prompt).toContain(phrase);
    }
  });
});
