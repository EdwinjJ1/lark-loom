/**
 * Rehearsal v2 — AI 听众预演 prompts（issue #145）
 *
 * 两个独立人设 LLM 调用 + 一个 lite attribution 校验：
 *
 *   ① 演讲者人设（speaker, pro, temp=0.6）
 *      输入: 第 N 页 PPT outline + core-doc 对应段
 *      输出: 三段式讲稿 { hook, core, transition }
 *      约束: 每段长度卡死 + cite 在白名单内 + 禁用词列表
 *
 *   ② 听众人设（listener, pro, temp=0.2）
 *      输入: 完整 PPT outline + core-doc + 演讲者讲稿
 *      输出: critique[] { category, page, cite, evidence, text, confidence }
 *      三类 critique:
 *        - audience: 评委 / 听众视角（懂不懂、抓人不抓人）
 *        - content: 内容质量（数据、逻辑、依据）
 *        - consistency: PPT 与 core-doc 是否一致（数字、决策、口径）
 *
 *   ③ Attribution 校验（lite × N 并发, temp=0.0）
 *      对每条 critique 反向问"引用是否在 PPT/doc 中存在" → yes/no/unsure
 *      no → 整条丢；unsure → 进 review 卡的"⚠️ 来源待确认"分组
 *
 * P4 表现力优化:
 *   - 少量 few-shot（评委答辩 + 路演两种语气）
 *   - 风格槽位 style: 'judges' | 'roadshow'
 *   - 禁用词列表: '综上所述' / '接下来让我们' / 'PPT 烂词'
 *   - 2 候选 + lite 选优（pro 跑 2 次，lite 选更生动）
 */

import type { SchemaLike } from '@seedhac/contracts';
import { clamp } from '../utils/clamp.js';

// ─── 输入数据结构（不依赖 SlidesClient 接口扩展）────────────────────────────

export interface PreviewSlideInput {
  readonly page: number;
  readonly title: string;
  readonly bullets?: readonly string[];
  readonly subtitle?: string;
  readonly notes?: string;
}

export interface PreviewDocSection {
  readonly section: string;
  readonly content: string;
}

export type PreviewStyle = 'judges' | 'roadshow';

// ─── Speaker schema ──────────────────────────────────────────────────────────

export interface SpeakerTranscriptPage {
  readonly page: number;
  readonly hook: string;
  readonly core: string;
  readonly transition: string;
  /** 引用白名单：'ppt.p<N>' / 'doc.section.<X>' */
  readonly cite: readonly string[];
  readonly evidence: string;
}

export const HOOK_MIN = 8;
export const HOOK_MAX = 80;
export const CORE_MIN = 20;
export const CORE_MAX = 200;
export const TRANSITION_MIN = 5;
export const TRANSITION_MAX = 80;

export const BANNED_PHRASES = [
  '综上所述',
  '接下来让我们',
  '总而言之',
  '众所周知',
  '让我们一起',
  '不难看出',
  '由此可见',
] as const;

function containsBannedPhrase(text: string): string | null {
  for (const phrase of BANNED_PHRASES) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`${name} must be string`);
  return v;
}

function clampLen(v: string, min: number, max: number, name: string): string {
  const t = v.trim();
  if (t.length < min) throw new Error(`${name} too short (<${min})`);
  if (t.length > max) return t.slice(0, max);
  return t;
}

export const SpeakerTranscriptPageSchema: SchemaLike<SpeakerTranscriptPage> = {
  parse(value: unknown): SpeakerTranscriptPage {
    if (typeof value !== 'object' || value === null) {
      throw new Error('speaker transcript page must be object');
    }
    const o = value as Record<string, unknown>;
    const page = typeof o['page'] === 'number' ? Math.trunc(o['page']) : NaN;
    if (!Number.isInteger(page) || page < 1) throw new Error('page must be positive integer');
    const hook = clampLen(asString(o['hook'], 'hook'), HOOK_MIN, HOOK_MAX, 'hook');
    const core = clampLen(asString(o['core'], 'core'), CORE_MIN, CORE_MAX, 'core');
    const transition = clampLen(
      asString(o['transition'], 'transition'),
      TRANSITION_MIN,
      TRANSITION_MAX,
      'transition',
    );
    const banned =
      containsBannedPhrase(hook) ?? containsBannedPhrase(core) ?? containsBannedPhrase(transition);
    if (banned) throw new Error(`speaker output contains banned phrase: ${banned}`);
    const citeRaw = Array.isArray(o['cite']) ? o['cite'] : [];
    const cite = citeRaw
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c) => c.trim());
    if (cite.length === 0) throw new Error('cite must have at least one entry');
    const evidence = asString(o['evidence'], 'evidence').trim();
    if (evidence.length < 5) throw new Error('evidence too short');
    return { page, hook, core, transition, cite, evidence };
  },
  jsonSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['page', 'hook', 'core', 'transition', 'cite', 'evidence'],
      properties: {
        page: { type: 'integer', minimum: 1 },
        hook: { type: 'string', minLength: HOOK_MIN, maxLength: HOOK_MAX },
        core: { type: 'string', minLength: CORE_MIN, maxLength: CORE_MAX },
        transition: { type: 'string', minLength: TRANSITION_MIN, maxLength: TRANSITION_MAX },
        cite: { type: 'array', items: { type: 'string' }, minItems: 1 },
        evidence: { type: 'string', minLength: 5 },
      },
    };
  },
};

// ─── Listener schema ─────────────────────────────────────────────────────────

export type ListenerCategory = 'audience' | 'content' | 'consistency';

export interface ListenerCritique {
  readonly category: ListenerCategory;
  readonly page: number;
  readonly text: string;
  readonly evidence: string;
  readonly cite: string;
  readonly confidence: number;
}

export interface ListenerCritiqueBatch {
  readonly critiques: readonly ListenerCritique[];
}

const CATEGORY_SET = new Set<string>(['audience', 'content', 'consistency']);

export function makeListenerCritiqueBatchSchema(
  totalPages: number,
): SchemaLike<ListenerCritiqueBatch> {
  return {
    parse(value: unknown): ListenerCritiqueBatch {
      if (typeof value !== 'object' || value === null) {
        throw new Error('listener critique batch must be object');
      }
      const o = value as Record<string, unknown>;
      const raw = Array.isArray(o['critiques']) ? o['critiques'] : [];
      const critiques: ListenerCritique[] = [];
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (typeof item !== 'object' || item === null) continue;
        const m = item as Record<string, unknown>;
        const category = typeof m['category'] === 'string' ? m['category'] : '';
        if (!CATEGORY_SET.has(category)) continue;
        const pageVal = typeof m['page'] === 'number' ? Math.trunc(m['page']) : NaN;
        if (!Number.isInteger(pageVal) || pageVal < 1 || pageVal > totalPages) continue;
        const text = typeof m['text'] === 'string' ? m['text'].trim() : '';
        if (text.length < 10 || text.length > 300) continue;
        const evidence = typeof m['evidence'] === 'string' ? m['evidence'].trim() : '';
        if (evidence.length < 10) continue;
        const cite = typeof m['cite'] === 'string' ? m['cite'].trim() : '';
        if (!cite) continue;
        const confidenceRaw = typeof m['confidence'] === 'number' ? m['confidence'] : 0.5;
        const confidence = Math.max(0, Math.min(1, confidenceRaw));
        critiques.push({
          category: category as ListenerCategory,
          page: pageVal,
          text,
          evidence,
          cite,
          confidence,
        });
      }
      return { critiques };
    },
    jsonSchema(): Record<string, unknown> {
      return {
        type: 'object',
        required: ['critiques'],
        properties: {
          critiques: {
            type: 'array',
            items: {
              type: 'object',
              required: ['category', 'page', 'text', 'evidence', 'cite', 'confidence'],
              properties: {
                category: { type: 'string', enum: ['audience', 'content', 'consistency'] },
                page: { type: 'integer', minimum: 1, maximum: totalPages },
                text: { type: 'string', minLength: 10, maxLength: 300 },
                evidence: { type: 'string', minLength: 10 },
                cite: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      };
    },
  };
}

// ─── Attribution schema ──────────────────────────────────────────────────────

export interface AttributionResult {
  readonly verdict: 'yes' | 'no' | 'unsure';
  readonly reason?: string;
}

export const AttributionResultSchema: SchemaLike<AttributionResult> = {
  parse(value: unknown): AttributionResult {
    if (typeof value !== 'object' || value === null) {
      throw new Error('attribution result must be object');
    }
    const o = value as Record<string, unknown>;
    const verdict = typeof o['verdict'] === 'string' ? o['verdict'].toLowerCase() : '';
    if (verdict !== 'yes' && verdict !== 'no' && verdict !== 'unsure') {
      throw new Error(`attribution verdict invalid: ${String(o['verdict'])}`);
    }
    const reason = typeof o['reason'] === 'string' ? o['reason'].trim() : '';
    return reason ? { verdict, reason } : { verdict };
  },
  jsonSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['verdict'],
      properties: {
        verdict: { type: 'string', enum: ['yes', 'no', 'unsure'] },
        reason: { type: 'string' },
      },
    };
  },
};

// ─── Speaker prompt ──────────────────────────────────────────────────────────

const SPEAKER_FEW_SHOT_JUDGES = `
### 评委答辩风格示例

输入：
PPT 第 3 页:
- title: 技术方案 — 混合检索
- bullets: ['BM25 + 向量', '准确率提升 18%']

core-doc 节选: doc.section.架构 — 我们采用混合检索是因为单独向量检索在长尾词召回低 30%

正确输出：
{
  "page": 3,
  "hook": "为什么不只用向量检索？",
  "core": "我们对比过纯向量、纯 BM25 和混合方案三种召回模式，混合在长尾词上召回提升 30%，整体准确率提升 18%。这是我们做混合检索的核心动机。",
  "transition": "下一页讲这个方案在工程上怎么落地。",
  "cite": ["ppt.p3", "doc.section.架构"],
  "evidence": "PPT 第 3 页 bullet：BM25 + 向量、准确率提升 18%；core-doc 架构段：长尾词召回低 30%"
}
`.trim();

const SPEAKER_FEW_SHOT_ROADSHOW = `
### 路演风格示例（同样 PPT，更轻盈的开场）

正确输出：
{
  "page": 3,
  "hook": "我们怎么让搜索又准又抓得住长尾？",
  "core": "答案是混合检索。BM25 抓关键词、向量抓语义，两个一加，长尾召回多 30%、整体准确率多 18%。这两个数字是我们押在这条路上的根据。",
  "transition": "接下来看我们怎么让它在生产里跑起来。",
  "cite": ["ppt.p3", "doc.section.架构"],
  "evidence": "PPT 第 3 页 bullet：BM25 + 向量、准确率提升 18%；core-doc 架构段：长尾词召回低 30%"
}
`.trim();

const SPEAKER_BANNED_RULE = `
# 禁用词（出现任何一个整条作废，schema 校验会丢掉这次输出）

${BANNED_PHRASES.map((p) => `- "${p}"`).join('\n')}

理由：这些是 LLM 写作的烂词，听众一听就觉得是"AI 写的稿子"。
真人讲稿要有具体动词和数字，不要堆套话。
`.trim();

const SPEAKER_SYSTEM = `
你是一个真实演讲者人设。任务：根据指定 PPT 页 + core-doc 对应段，写出这一页的讲稿。

# 三段式（每段长度卡死）

- hook（钩子，${HOOK_MIN}-${HOOK_MAX} 字）：
  一句反问 / 反直觉数字 / 强对比，把听众注意力勾住。不要客套话。
- core（核心，${CORE_MIN}-${CORE_MAX} 字）：
  讲清这一页的关键信息。必须落到具体数字 / 决策 / 因果。
- transition（过渡，${TRANSITION_MIN}-${TRANSITION_MAX} 字）：
  一句话承接下一页，不重复 hook。

# 引用规则（cite 字段）

cite 数组里每一条必须从下面白名单里选：
- "ppt.p<N>"：当前 PPT 第 N 页
- "doc.section.<X>"：core-doc 第 X 段（直接复制 SECTION 名称）

evidence 字段：把你引用的原文片段贴出来（>= 5 字），用于反向校验。
不许引用没出现在输入里的页 / 段。

# 反幻觉

- 数字 / 名词 / 数据点必须能在 PPT 或 core-doc 里找到原文。
- 不许加 PPT 没说的"未来计划"。
- 不许吹牛（"全球第一"/"业界领先"/"颠覆"），只讲事实。

${SPEAKER_BANNED_RULE}

# 输出

只返回 JSON，不要 markdown 代码块。schema：
{"page": int, "hook": str, "core": str, "transition": str, "cite": [str], "evidence": str}
`.trim();

export function SPEAKER_PROMPT(
  slide: PreviewSlideInput,
  docContext: readonly PreviewDocSection[],
  style: PreviewStyle = 'judges',
): string {
  const slideJson = JSON.stringify({
    page: slide.page,
    title: clamp(slide.title, 'MEDIUM'),
    bullets: (slide.bullets ?? []).map((b) => clamp(b, 'MEDIUM')),
    subtitle: slide.subtitle ? clamp(slide.subtitle, 'MEDIUM') : undefined,
  });
  const docJson = JSON.stringify(
    docContext.slice(0, 6).map((d) => ({
      section: d.section,
      content: clamp(d.content, 'LONG'),
    })),
  );
  const styleHint =
    style === 'roadshow'
      ? '当前风格：路演（节奏轻盈，自信但不浮夸，数字落点要狠）'
      : '当前风格：评委答辩（学术严谨，每个论断有依据，避免营销腔）';

  const fewShot = style === 'roadshow' ? SPEAKER_FEW_SHOT_ROADSHOW : SPEAKER_FEW_SHOT_JUDGES;

  return [
    SPEAKER_SYSTEM,
    '',
    `# 风格`,
    styleHint,
    '',
    fewShot,
    '',
    '# 现在轮到你处理',
    '',
    '<ppt_page>',
    slideJson,
    '</ppt_page>',
    '',
    '<doc_context>',
    docJson,
    '</doc_context>',
    '',
    '只返回 JSON。',
  ].join('\n');
}

// ─── Listener prompt ─────────────────────────────────────────────────────────

const LISTENER_FEW_SHOT = `
### 示例：三类 critique 各一条

PPT 第 3 页 title: 商业模式
PPT bullets: 三年内覆盖头部 50% 客户
core-doc OKR 段: KR1: 年内覆盖头部 20% 客户

讲稿（speaker 输出）: 我们三年内能覆盖 50% 头部客户...

正确输出：
{
  "critiques": [
    {
      "category": "consistency",
      "page": 3,
      "text": "PPT 第 3 页"三年覆盖 50%"和 core-doc OKR 的"年内覆盖 20%"对不上，评委翻文档会发现数字打架",
      "evidence": "ppt.p3: 三年内覆盖头部 50% 客户 / doc.section.OKR: KR1 年内覆盖头部 20% 客户",
      "cite": "ppt.p3",
      "confidence": 0.95
    },
    {
      "category": "audience",
      "page": 3,
      "text": "评委大概率会追问 50% 这个数字怎么算的，目前讲稿没给出方法论",
      "evidence": "ppt.p3: 三年内覆盖头部 50% 客户（没有支撑）",
      "cite": "ppt.p3",
      "confidence": 0.85
    },
    {
      "category": "content",
      "page": 3,
      "text": "缺一个客群定义。"头部 50%"是按收入还是按活跃度？讲稿没说",
      "evidence": "ppt.p3: 头部 50%（口径未明）",
      "cite": "ppt.p3",
      "confidence": 0.8
    }
  ]
}

错误示范（绝对禁止）：
❌ {"category": "audience", "page": 99, ...} — page 超过总页数
❌ {"category": "audience", "evidence": "我觉得这个不对"} — evidence 必须是原文片段
❌ {"category": "audience", "cite": "doc.section.bgmoke"} — 引用了不存在的 section
`.trim();

const LISTENER_SYSTEM = `
你是一个挑剔但善意的 AI 听众，给即将上台的演讲者出三类 critique：

| category | 关注什么 |
|----------|----------|
| audience | 评委 / 听众视角：会怎么追问？哪里抓不住注意力？哪里没说服力？|
| content  | 内容质量：数据有支撑吗？逻辑成立吗？术语解释清楚吗？|
| consistency | PPT 与 core-doc 是否一致？数字 / 决策 / 口径 / 范围是否打架？|

# 反幻觉硬约束（违反整条丢）

1. 每条 critique 必须有 evidence 字段，evidence 必须是 PPT / doc 里的原文片段（≥10 字），
   不允许写"我觉得"/"似乎"/"可能"这种主观措辞。
2. cite 必须从白名单里选：
   - "ppt.p<N>" 其中 N 在 [1, totalPages] 内
   - "doc.section.<X>" 其中 X 是 doc_context 里出现过的 section 名
3. consistency 类 critique 必须同时引用 PPT 和 doc 两边的具体内容（在 evidence 里都贴出来）。
4. 不评价演讲者本人（不许"他不专业"/"她紧张"），只评内容。
5. 不许编没出现过的页码 / 段落 / 数字。

# 数量

每页 0-3 条 critique。同一页若有 consistency 问题，优先报。
没问题就空数组，不要硬凑。

# 输出

只返回 JSON：{"critiques": [{...}]}
`.trim();

export function LISTENER_PROMPT(
  pptPages: readonly PreviewSlideInput[],
  docContext: readonly PreviewDocSection[],
  speakerTranscripts: readonly SpeakerTranscriptPage[],
): string {
  const pptJson = JSON.stringify(
    pptPages.map((s) => ({
      page: s.page,
      title: clamp(s.title, 'MEDIUM'),
      bullets: (s.bullets ?? []).map((b) => clamp(b, 'MEDIUM')),
    })),
  );
  const docJson = JSON.stringify(
    docContext.slice(0, 8).map((d) => ({
      section: d.section,
      content: clamp(d.content, 'LONG'),
    })),
  );
  const transcriptJson = JSON.stringify(
    speakerTranscripts.map((t) => ({
      page: t.page,
      hook: t.hook,
      core: clamp(t.core, 'MEDIUM'),
      transition: t.transition,
    })),
  );

  return [
    LISTENER_SYSTEM,
    '',
    '## Few-shot',
    '',
    LISTENER_FEW_SHOT,
    '',
    '# 现在轮到你处理',
    '',
    `总页数 totalPages = ${pptPages.length}`,
    '',
    '<ppt_outline>',
    pptJson,
    '</ppt_outline>',
    '',
    '<doc_context>',
    docJson,
    '</doc_context>',
    '',
    '<speaker_transcripts>',
    transcriptJson,
    '</speaker_transcripts>',
    '',
    '只返回 JSON。',
  ].join('\n');
}

// ─── Attribution prompt ──────────────────────────────────────────────────────

export function ATTRIBUTION_PROMPT(
  critique: ListenerCritique,
  pptPages: readonly PreviewSlideInput[],
  docContext: readonly PreviewDocSection[],
): string {
  const targetPage = pptPages.find((p) => p.page === critique.page);
  const docMatch = docContext.find((d) => critique.cite.includes(d.section));

  const pptSnapshot = targetPage
    ? `PPT 第 ${targetPage.page} 页 — title: ${targetPage.title}\nbullets: ${(targetPage.bullets ?? []).join(' | ')}`
    : `PPT 第 ${critique.page} 页（在输入中未找到此页）`;
  const docSnapshot = docMatch
    ? `doc section ${docMatch.section}: ${clamp(docMatch.content, 'LONG')}`
    : '（critique 未引用 doc section，或引用的 section 不在输入里）';

  return [
    '你是引用校验员。判断下面 critique 引用的内容是否真的存在于 PPT / core-doc 中。',
    '',
    '判定准则：',
    '- yes：critique.evidence 描述的原文 / 数字 / 表述能在 PPT 或 doc 里找到（即使措辞不完全一致也算）',
    '- no：critique 引用的内容不在 PPT 或 doc 里（典型幻觉）',
    '- unsure：信息缺失 / 模糊，无法确认',
    '',
    '<critique>',
    JSON.stringify({
      category: critique.category,
      page: critique.page,
      cite: critique.cite,
      evidence: clamp(critique.evidence, 'MEDIUM'),
      text: clamp(critique.text, 'MEDIUM'),
    }),
    '</critique>',
    '',
    '<ppt_snapshot>',
    pptSnapshot,
    '</ppt_snapshot>',
    '',
    '<doc_snapshot>',
    docSnapshot,
    '</doc_snapshot>',
    '',
    '只返回 JSON: {"verdict": "yes"|"no"|"unsure", "reason": "一句话原因（可省略）"}',
  ].join('\n');
}

// ─── Cross-check (PPT vs core-doc 数字 / 决策一致性) ──────────────────────────

export interface CrossCheckResult {
  readonly verdict: 'consistent' | 'inconsistent' | 'unclear';
  readonly note: string;
}

export const CrossCheckResultSchema: SchemaLike<CrossCheckResult> = {
  parse(value: unknown): CrossCheckResult {
    if (typeof value !== 'object' || value === null) {
      throw new Error('cross-check result must be object');
    }
    const o = value as Record<string, unknown>;
    const verdict = typeof o['verdict'] === 'string' ? o['verdict'].toLowerCase() : '';
    if (verdict !== 'consistent' && verdict !== 'inconsistent' && verdict !== 'unclear') {
      throw new Error(`cross-check verdict invalid: ${String(o['verdict'])}`);
    }
    const note = asString(o['note'], 'note').trim();
    return { verdict, note };
  },
  jsonSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['verdict', 'note'],
      properties: {
        verdict: { type: 'string', enum: ['consistent', 'inconsistent', 'unclear'] },
        note: { type: 'string' },
      },
    };
  },
};

export function CROSSCHECK_PROMPT(
  page: PreviewSlideInput,
  section: PreviewDocSection,
): string {
  return [
    '你是 PPT-文档一致性校验员。判断 PPT 当页与 core-doc 该段是否描述了同一件事且数字 / 范围 / 口径一致。',
    '',
    '只看：',
    '1. 数字 / 时间 / 百分比 / 范围是否一致',
    '2. 决策 / 结论是否一致（一边说"做"另一边说"不做"是 inconsistent）',
    '3. 范围 / 口径是否一致（"头部 20%"vs"全部用户"是 inconsistent）',
    '',
    '不要扯措辞 / 排版 / 风格差异（不算 inconsistent）。',
    '',
    '<ppt_page>',
    JSON.stringify({
      page: page.page,
      title: clamp(page.title, 'MEDIUM'),
      bullets: (page.bullets ?? []).map((b) => clamp(b, 'MEDIUM')),
    }),
    '</ppt_page>',
    '',
    '<doc_section>',
    JSON.stringify({ section: section.section, content: clamp(section.content, 'LONG') }),
    '</doc_section>',
    '',
    '只返回 JSON: {"verdict": "consistent"|"inconsistent"|"unclear", "note": "一句话说明（必填）"}',
  ].join('\n');
}

// ─── 候选选优（P4 表现力优化） ─────────────────────────────────────────────

export function CANDIDATE_PICK_PROMPT(
  candidates: readonly { id: string; transcript: SpeakerTranscriptPage }[],
): string {
  return [
    '比较以下两份讲稿候选，选更生动、不啰嗦、不像 AI 写的那一份。',
    '判断准则：',
    '- 有具体动词 / 数字 / 因果链 → 加分',
    '- 出现"综上所述/不难看出"等套话 → 减分',
    '- hook 真的勾人，不是客套 → 加分',
    '',
    candidates
      .map(
        (c) =>
          `候选 ${c.id}:\n  hook: ${c.transcript.hook}\n  core: ${c.transcript.core}\n  transition: ${c.transcript.transition}`,
      )
      .join('\n\n'),
    '',
    '只输出 id，不要任何其他文本。',
  ].join('\n');
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

export function isCiteInWhitelist(
  cite: string,
  totalPages: number,
  docSections: readonly string[],
): boolean {
  const pptMatch = cite.match(/^ppt\.p(\d+)$/);
  if (pptMatch) {
    const n = Number(pptMatch[1]);
    return Number.isInteger(n) && n >= 1 && n <= totalPages;
  }
  const docMatch = cite.match(/^doc\.section\.(.+)$/);
  if (docMatch) {
    const section = docMatch[1]!;
    return docSections.includes(section);
  }
  return false;
}

export { containsBannedPhrase };
