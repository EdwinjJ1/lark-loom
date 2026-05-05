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
): string => {
  const historyBlock = history.length
    ? history.map((m) => `[${m.sender.name ?? m.sender.userId}]: ${m.text}`).join('\n')
    : '（无群聊记录）';

  const docsBlock = linkedDocs.length
    ? linkedDocs
        .map((d, i) => {
          const head = `--- 文档 ${i + 1}（${d.kind}${d.title ? `：${d.title}` : ''}） ${d.url} ---`;
          return `${head}\n${truncate(d.content, MAX_DOC_CHARS_EACH)}`;
        })
        .join('\n\n')
    : '';

  return `
根据以下群聊记录${linkedDocs.length ? '与关联文档' : ''}，提取项目需求并整理成结构化文档。

输入可能形态：
- 单条消息直接说出需求
- 多轮对话逐步澄清需求（结合上下文综合判断）
- 群里只发了一个文档链接，真实需求写在文档正文里
- 上述组合

输出要求：
- title：项目标题，简洁体现核心价值（10 字内）
- background：项目背景，1-2 段，说明缘由与上下文
- goals：项目目标列表，每条单一目标
- scope：项目范围，1 段，明确包含与不包含的内容
- deliverables：具体交付物列表（文档/接口/页面/演示等可验收物）

只返回 JSON，不要有额外文字。

群聊记录：
${historyBlock}
${docsBlock ? `\n关联文档：\n${docsBlock}\n` : ''}
`.trim();
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
