import type { Message, SchemaLike } from '@seedhac/contracts';

export interface RequirementDoc {
  title: string;
  background: string;
  goals: string[];
  scope: string;
  deliverables: string[];
}

/**
 * 群里被同步过来的关联文档（doc / wiki）正文片段。
 * requirementDoc 把它们与聊天记录一起喂给 LLM —— 真实场景下需求往往写在
 * 共享文档里，单看群文本不够。
 */
export interface LinkedDocSnippet {
  readonly kind: 'doc' | 'wiki';
  readonly title?: string;
  readonly url: string;
  readonly content: string;
}

const MAX_DOC_CHARS_EACH = 4000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断 ${value.length - max} 字）`;
}

export const REQ_PROMPT = (
  history: readonly Message[],
  linkedDocs: readonly LinkedDocSnippet[] = [],
  forwardedTexts: readonly string[] = [],
): string => {
  // 把 history 拆成：转发进来的文本（Tier-1）+ 群原生消息（Tier-2 上下文）
  const forwardedSet = new Set(forwardedTexts);
  const nativeHistory = history.filter((m) => !forwardedSet.has(m.text));

  const historyBlock = nativeHistory.length
    ? nativeHistory.map((m) => `[${m.sender.name ?? m.sender.userId}]: ${m.text}`).join('\n')
    : '（无群聊记录）';

  const forwardedBlock = forwardedTexts.length
    ? forwardedTexts.map((t, i) => `[转发文本 ${i + 1}] ${t}`).join('\n')
    : '';

  const docsBlock = linkedDocs.length
    ? linkedDocs
        .map((d, i) => {
          const head = `--- 文档 ${i + 1}（${d.kind}${d.title ? `：${d.title}` : ''}） ${d.url} ---`;
          return `${head}\n${truncate(d.content, MAX_DOC_CHARS_EACH)}`;
        })
        .join('\n\n')
    : '';

  const hasDocs = linkedDocs.length > 0;
  const hasForwarded = forwardedTexts.length > 0;

  // Tier-1（用户主动提供的显式输入）：linkedDocs + forwardedTexts
  //   ↓ 必须 100% 融合，不许丢
  // Tier-2（群里原本就有的非转发消息）：作为补充上下文
  //
  // 这里最容易踩坑的场景：
  //   - 用户合并转发了一段聊天（含 K12 备课助手讨论）
  //   - 又贴了 2 份 wiki（讲飞书协作 Bot 项目）
  //   - LLM 看到主题对不上，把 K12 当噪音忽略了
  // 修法：明确告诉 LLM「转发文本和 wiki 都属于本次需求，主题不一致也要融合」
  const tier1Count = linkedDocs.length + forwardedTexts.length;
  const tier1Refs = [
    linkedDocs.length ? `${linkedDocs.length} 份关联文档` : '',
    forwardedTexts.length ? `${forwardedTexts.length} 条合并转发文本` : '',
  ]
    .filter(Boolean)
    .join(' + ');

  const priorityDirective = tier1Count > 0
    ? `本次输入包含 Tier-1 显式输入：${tier1Refs}。这些是**用户主动整理 / 转发提供的需求材料**。

**关键规则——所有 Tier-1 输入必须 100% 融合到 PRD，不许丢：**
- title / background / goals / scope / deliverables 必须**综合 Tier-1 所有 ${tier1Count} 个来源**。
- 即使 Tier-1 各来源**主题看起来不一致**（例如一份讲 K12 备课助手、一份讲海外语音、
  一份讲群协作 Bot），也**要全部纳入 PRD**——用户主动提供这些材料就是把它们当作
  本次需求的有效输入，不要擅自判定为「不同项目，挑一个」。
- 当 Tier-1 内容跨多个领域时，**title 应足够抽象覆盖所有领域**（如「项目需求整理工具」
  这种过于狭窄的标题就不合适，应该体现 K12 备课 + 协作 Bot 都是产品矩阵的一部分）。
- background 必须列出**每个 Tier-1 来源的独特细节**：K12 教材 PDF 解析 / 海外
  语音 SDK / 协作 Bot 自动生成分工 等都不能被泛化成「自动化工具」一句话带过。
- goals / deliverables 应**包含每个 Tier-1 来源对应的产出**（K12 教学目标生成 +
  PRD 自动整理 + PPT 初稿 + 语音二期等），不许压缩成 3-5 个抽象目标。

群聊原生记录（Tier-2，下方「群聊记录」段落）仅在 Tier-1 明确缺失某字段时作为补充。`
    : `本次输入只有群聊记录，没有 Tier-1 显式输入。结合最近的多轮上下文综合判断真实需求。`;

  return `
根据以下输入，提取项目需求并整理成结构化文档。

输入可能形态：
- 单条消息直接说出需求
- 多轮对话逐步澄清需求
- 群里只发了一个文档链接，真实需求写在文档正文里
- 用户合并转发了一段聊天记录到群里
- 上述组合

${priorityDirective}

输出要求：
- title：项目标题，简洁体现核心价值（10 字内；Tier-1 跨多领域时取更抽象的统称）
- background：项目背景，2-3 段，**列出每个 Tier-1 来源的独特细节**
- goals：项目目标列表，每条单一目标，**Tier-1 每个来源至少 1 条对应目标**
- scope：项目范围，1-2 段，明确包含与不包含的内容
- deliverables：具体交付物列表（文档/接口/页面/演示等可验收物），
  **Tier-1 各来源对应的产出都要列出**

只返回 JSON，不要有额外文字。
${forwardedBlock ? `\n合并转发文本（**Tier-1，必须吸收**）：\n${forwardedBlock}\n` : ''}${docsBlock ? `\n关联文档（**Tier-1，必须吸收**）：\n${docsBlock}\n` : ''}
群聊记录${tier1Count > 0 ? '（Tier-2 仅作上下文参考）' : ''}：
${historyBlock}
`.trim();
};

// ─── Relevance pre-filter ─────────────────────────────────────────────────────
// 群里历史消息可能掺杂多个不相关项目的讨论，不能一股脑塞给主 LLM。
// 这里跑一次 lite 模型判断每条候选历史消息是否与本次「整理项目需求」
// 触发的目标项目相关，只保留相关的再喂给主提取流程。
//
// 注意：linkedDocs 不走预筛 —— 用户主动贴的文档是显式输入信号，100% 保留。
// 否则会出现 lite 凭群历史的「主流话题」错判为本次项目，把用户当下贴的
// 文档全过滤掉，主提取看不到文档内容，PRD 完全跑偏。

export interface RelevanceCandidate {
  readonly id: string;
  readonly kind: 'message';
  /** 短摘要：消息文本前 200 字 */
  readonly excerpt: string;
}

export interface RelevanceJudgment {
  readonly results: readonly { readonly id: string; readonly keep: boolean }[];
}

export const RELEVANCE_PROMPT = (
  triggerText: string,
  candidates: readonly RelevanceCandidate[],
): string => `
你是一个项目需求整理助手的预筛选模块。
当前用户在群里发了一条消息触发"整理项目需求"技能，触发消息是：

[trigger]
${triggerText}

下面有 ${candidates.length} 条候选群聊历史。
判断**每条**是否与触发消息指向的需求项目相关：
- 直接讨论同一项目 / 同一需求场景 / 同一目标用户 → keep: true
- 完全无关的闲聊、其他项目讨论、机器人诊断噪音、重复触发消息 → keep: false
- 不确定时**倾向 keep: true**，宁可多带一点上下文

只返回如下 JSON，不要有额外文字：
{"results":[{"id":"<候选 id>","keep":true},...]}

候选列表：
${candidates.map((c) => `[${c.id}] ${c.excerpt}`).join('\n')}
`.trim();

export const RelevanceJudgmentSchema: SchemaLike<RelevanceJudgment> = {
  parse(value: unknown): RelevanceJudgment {
    if (typeof value !== 'object' || value === null) throw new Error('relevance must be object');
    const o = value as Record<string, unknown>;
    if (!Array.isArray(o['results'])) throw new Error('relevance.results must be array');
    return {
      results: (o['results'] as unknown[]).map((r, i) => {
        if (typeof r !== 'object' || r === null) throw new Error(`results[${i}] must be object`);
        const obj = r as Record<string, unknown>;
        if (typeof obj['id'] !== 'string') throw new Error(`results[${i}].id must be string`);
        if (typeof obj['keep'] !== 'boolean') throw new Error(`results[${i}].keep must be boolean`);
        return { id: obj['id'], keep: obj['keep'] };
      }),
    };
  },
  jsonSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'keep'],
            properties: { id: { type: 'string' }, keep: { type: 'boolean' } },
          },
        },
      },
    };
  },
};

function asStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be array`);
  return raw.map((v) => {
    if (typeof v !== 'string') throw new Error(`${field}[] must be string`);
    return v;
  });
}

export const RequirementDocSchema: SchemaLike<RequirementDoc> = {
  parse(value: unknown): RequirementDoc {
    if (typeof value !== 'object' || value === null) throw new Error('requirement doc must be object');
    const o = value as Record<string, unknown>;
    if (typeof o['title'] !== 'string') throw new Error('title must be string');
    if (typeof o['background'] !== 'string') throw new Error('background must be string');
    if (typeof o['scope'] !== 'string') throw new Error('scope must be string');
    return {
      title: o['title'],
      background: o['background'],
      scope: o['scope'],
      goals: asStringArray(o['goals'], 'goals'),
      deliverables: asStringArray(o['deliverables'], 'deliverables'),
    };
  },
  jsonSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['title', 'background', 'goals', 'scope', 'deliverables'],
      properties: {
        title: { type: 'string' },
        background: { type: 'string' },
        goals: { type: 'array', items: { type: 'string' } },
        scope: { type: 'string' },
        deliverables: { type: 'array', items: { type: 'string' } },
      },
    };
  },
};

export function renderRequirementDocMarkdown(doc: RequirementDoc): string {
  return [
    `# ${doc.title}`,
    '',
    '## 项目背景',
    doc.background,
    '',
    '## 目标',
    ...doc.goals.map((g) => `- ${g}`),
    '',
    '## 范围',
    doc.scope,
    '',
    '## 交付物',
    ...doc.deliverables.map((d) => `- ${d}`),
  ].join('\n');
}

// ─── Feishu URL parsing ───────────────────────────────────────────────────────

/** 仅识别 doc / docx / wiki —— slides/bitable 不作为需求来源。 */
const FEISHU_DOC_RE =
  /https?:\/\/[^/\s)\]]*(?:feishu\.cn|lark\.cn|larkoffice\.com)\/(docx?|wiki)\/([A-Za-z0-9_-]{5,})/g;

export interface ParsedDocUrl {
  readonly kind: 'doc' | 'wiki';
  readonly token: string;
  readonly url: string;
}

/** 从一组消息里抽取所有飞书 doc / wiki 链接，最多 5 条以限制下游 API 调用。 */
export function parseFeishuDocUrls(messages: readonly Message[]): ParsedDocUrl[] {
  const seen = new Set<string>();
  const out: ParsedDocUrl[] = [];

  for (const msg of messages) {
    const haystacks = [msg.text];
    if (msg.rawContent && msg.rawContent !== msg.text) haystacks.push(msg.rawContent);

    for (const haystack of haystacks) {
      const normalized = haystack.replaceAll('\\/', '/');
      FEISHU_DOC_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FEISHU_DOC_RE.exec(normalized)) !== null) {
        const type = m[1] ?? '';
        const token = m[2] ?? '';
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push({
          kind: type === 'wiki' ? 'wiki' : 'doc',
          token,
          url: m[0],
        });
        if (out.length >= 5) return out;
      }
    }
  }

  return out;
}
