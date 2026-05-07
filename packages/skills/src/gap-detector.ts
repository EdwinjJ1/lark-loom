/**
 * GapDetector — 信息缺口检测（recall skill 前哨）
 *
 * 两层判断：
 *   Layer 1 · 规则正则（0 成本，确定性）：4 类触发器关键词，命中任一即触发
 *   Layer 2 · LLM 兜底（豆包 Lite，模糊场景）：规则不命中时再调
 *
 * 注意：@seedhac/skills 不依赖 @seedhac/bot，故在此包内维护一份副本。
 * 两份文件需保持同步，prompt 或逻辑变更时记得同步修改 bot/src/gap-detector.ts。
 */

import type { LLMClient, Message, Result } from '@seedhac/contracts';
import { ok } from '@seedhac/contracts';

export interface GapDetection {
  readonly shouldRecall: boolean;
  readonly reason: string;
  /** 给 Retriever 的检索 query；shouldRecall=false 时为空串 */
  readonly query: string;
  /** 触发来源：rule（正则命中）/ llm（LLM 兜底命中）/ none */
  readonly source: 'rule' | 'llm' | 'none';
}

const NO_GAP: GapDetection = {
  shouldRecall: false,
  reason: '',
  query: '',
  source: 'none',
};

interface TriggerRule {
  readonly kind: '模糊指代' | '记忆型' | '疑问无人答' | '决策追溯';
  readonly patterns: readonly RegExp[];
}

export const TRIGGER_RULES: readonly TriggerRule[] = [
  {
    kind: '模糊指代',
    patterns: [
      /那个\s*[^\s,，。.?？]{1,8}/,
      /上次\s*[^\s,，。.?？]{0,10}/,
      /上回/,
      /之前\s*(讨论|说|聊|定|的|那)/,
      /当时(决定|定的|说的|讨论)/,
    ],
  },
  {
    kind: '记忆型',
    patterns: [
      /(是)?多少来着/,
      /我记得/,
      /好像\s*(是|有|挺|在|不|也)/,
      /是不是\s*(.*[?？]|.*\d|.{0,8}的?$)/,
      /[^\s]{1,6}来着[?？]?/,
    ],
  },
  {
    kind: '决策追溯',
    patterns: [/(当时|之前|上次).*(决定|定了|定的|定下)/, /决定用\s*\S+\s*还是/],
  },
  {
    kind: '项目信息查询',
    patterns: [
      /[^\s]{1,8}.{0,6}(?:负责什么|做什么|的工作是什么)/,
      /谁.{0,8}(?:负责|来做|来搞)/,
      /(?:DDL|截止时间|deadline).{0,12}[？?是]/i,
    ],
  },
];

function ruleMatch(messages: readonly Message[]): {
  matched: TriggerRule;
  hitText: string;
} | null {
  for (const msg of messages) {
    for (const rule of TRIGGER_RULES) {
      if (rule.patterns.some((re) => re.test(msg.text))) {
        return { matched: rule, hitText: msg.text };
      }
    }
  }
  return null;
}

const VAGUE_ANSWER_RE =
  /(好像|大概|大约|约莫|可能|应该|记得|忘了|想不起来|不确定|也许|或许|几个|多少|哪个|哪些|是不是|啥|来着|找不到|在跑|还没|稍等)/;

function isSubstantiveAnswer(text: string): boolean {
  if (VAGUE_ANSWER_RE.test(text)) return false;

  return (
    /\d/.test(text) ||
    /https?:\/\//.test(text) ||
    /(叫|名叫|叫做)\s*[^\s,，。.?？!！]{2,12}/.test(text) ||
    /(是|为|等于)\s*[^\s,，。.?？!！]{2,12}/.test(text) ||
    /(决定|定了|选|采用|用)\s*[A-Za-z0-9\u4e00-\u9fff_.+#-]{2,20}/.test(text)
  );
}

function hasSubstantiveAnswer(messages: readonly Message[]): boolean {
  if (messages.length < 2) return false;
  return messages.slice(1).some((m) => isSubstantiveAnswer(m.text));
}

function detectUnansweredQuestion(messages: readonly Message[]): string | null {
  if (messages.length < 2) return null;
  const first = messages[0]!;
  const isQuestion =
    /[?？]/.test(first.text) || /(多少|怎么|哪个|哪些|几个|是不是|何时|什么时候)/.test(first.text);
  if (!isQuestion) return null;

  if (hasSubstantiveAnswer(messages)) return null;
  return first.text;
}

const LLM_PROMPT = `你是群聊助手的"主动召回"兜底判断器。前置规则没命中关键词，请你判断当前对话是否仍含"信息缺口"——即：用户**模糊指向过去的某个数据/决策/文档**，但当前对话没给出答案，主动帮查比让用户翻找更有价值。

【不要触发】
- 纯闲聊（吃饭 / 天气 / 玩笑 / 表情 / 请假 / 工作汇报）
- 当前对话里已经有数字 / 链接 / 明确答案
- 简单确认（"收到" "ok"）

【输出】严格 JSON，无任何额外文字、无 markdown 代码块：
{"shouldRecall": <true|false>, "reason": "<≤30 字>", "query": "<≤20 字；不触发时空串>"}

群消息：
{{MESSAGES}}`;

export class GapDetector {
  constructor(private readonly llm: LLMClient) {}

  async detect(messages: readonly Message[]): Promise<Result<GapDetection>> {
    if (messages.length === 0) return ok(NO_GAP);

    if (hasSubstantiveAnswer(messages)) return ok(NO_GAP);

    const hit = ruleMatch(messages);
    if (hit !== null) {
      return ok({
        shouldRecall: true,
        reason: `规则命中：${hit.matched.kind}`,
        query: extractQuery(hit.hitText),
        source: 'rule',
      });
    }

    const unanswered = detectUnansweredQuestion(messages);
    if (unanswered !== null) {
      return ok({
        shouldRecall: true,
        reason: '规则命中：疑问无人答',
        query: extractQuery(unanswered),
        source: 'rule',
      });
    }

    const formatted = messages
      .map((m) => `[${m.sender.name ?? m.sender.userId}] ${m.text}`)
      .join('\n');
    const prompt = LLM_PROMPT.replace('{{MESSAGES}}', formatted);

    const llmResult = await this.llm.ask(prompt, {
      model: 'lite',
      temperature: 0,
      maxTokens: 200,
    });

    if (!llmResult.ok) return ok(NO_GAP);

    const parsed = parseDetection(llmResult.value);
    return ok(parsed);
  }
}

function extractQuery(text: string): string {
  const decision =
    /(?:当时|之前|上次)?.*?(?:决定|定了|定的|定下|决定用)\s*([^\s,，。.?？!！]{1,20}\s*还是\s*[^\s,，。.?？!！]{1,20})/.exec(
      text,
    );
  if (decision && decision[1]) return `决定用 ${decision[1].trim()}`;

  const namedRefs = [
    /(?:那个)?([^\s,，。.?？!！]{1,12})\s*是多少来着/,
    /那个\s*([^\s,，。.?？!！]{1,12})/,
    /上次\s*(?:那个)?([^\s,，。.?？!！]{1,12})/,
    /上回\s*(?:那个)?([^\s,，。.?？!！]{1,12})/,
    /之前\s*(?:那个|那次|的)?\s*([^\s,，。.?？!！]{1,12})/,
    /([^\s,，。.?？!！]{1,12})\s*来着/,
  ];
  for (const re of namedRefs) {
    const m = re.exec(text);
    if (m && m[1]) return m[1].trim();
  }
  return text.slice(0, 20).trim();
}

function parseDetection(raw: string): GapDetection {
  const cleaned = raw.replace(/```json|```/g, '').trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return NO_GAP;
  }

  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return NO_GAP;
  }

  if (typeof obj !== 'object' || obj === null) return NO_GAP;
  const o = obj as Record<string, unknown>;

  const shouldRecall = o['shouldRecall'] === true;
  const reason = typeof o['reason'] === 'string' ? o['reason'] : '';
  const query = typeof o['query'] === 'string' ? o['query'] : '';

  if (!shouldRecall) return NO_GAP;
  if (query.trim() === '') return NO_GAP;

  return { shouldRecall: true, reason, query, source: 'llm' };
}
