/**
 * recall — 主动浮信息（核心差异化）
 *
 * 触发：群消息中出现模糊表述 → 豆包 Lite 判断是否存在信息缺口
 * 数据流：keyword 预筛 → 拉近期消息 → 缺口检测 → 并行检索（vector + bitable）→ LLM 整合 → 纯文本回复
 *
 * 注意：卡片规范里 recall 直接返回 SkillResult.text，像同事随口一句话。
 */

import {
  type Skill,
  type SkillContext,
  type SkillResult,
  type RetrieveQuery,
  type RetrieveHit,
  type LLMClient,
  type Result,
  ok,
  err,
  makeError,
  ErrorCode,
} from '@seedhac/contracts';
import { GapDetector, type GapDetection } from './gap-detector.js';

const KEYWORDS = ['上次', '之前', '我记得', '那个', '上回', '是多少来着', '负责什么', '做什么', '什么时候', '是谁', 'DDL'] as const;

async function synthesize(
  llm: LLMClient,
  query: string,
  hits: readonly RetrieveHit[],
): Promise<string> {
  const snippets = hits.map((h, i) => `[${i + 1}] ${h.snippet}`).join('\n\n');
  const prompt = `你是群聊助手，请根据历史消息帮忙回答。

查询：${query}

相关历史消息：
${snippets}

请用 1-3 句话，以自然口语化的方式回答，像熟悉项目的同事随口提醒。直接说内容，不要说"根据历史记录"。`;

  const result = await llm.ask(prompt, { model: 'pro' });
  if (!result.ok) return hits[0]?.snippet ?? '';
  return result.value;
}

class RecallSkill implements Skill {
  readonly name = 'recall' as const;
  readonly metadata = {
    description: '在群聊出现模糊指代时主动召回相关历史信息。',
    when_to_use:
      '消息里出现“上次、之前、那个、我记得”等模糊表述，需要补足上下文但用户未必 @bot 时使用。',
    examples: ['上次那个接口地址是多少？', '我记得之前定过截止时间', '那个方案后来怎么说的？'],
  } as const;
  readonly trigger = {
    events: ['message'] as const,
    requireMention: false,
    keywords: KEYWORDS,
    description: '群消息出现模糊表述 → 主动召回历史信息（事中介入）',
  };

  private readonly gapCache = new Map<string, GapDetection>();
  private static readonly GAP_CACHE_MAX = 200;

  async match(ctx: SkillContext): Promise<boolean> {
    if (ctx.event.type !== 'message') return false;
    const msg = ctx.event.payload;

    if (!KEYWORDS.some((k) => msg.text.includes(k))) return false;

    const histResult = await ctx.runtime.fetchHistory({ chatId: msg.chatId, pageSize: 10 });
    const fetched = histResult.ok ? histResult.value.messages : [];
    const hasCurrent = fetched.some((m) => m.messageId === msg.messageId);
    const messages = hasCurrent ? fetched : [msg, ...fetched];
    const detector = new GapDetector(ctx.llm);
    const gapResult = await detector.detect(messages);
    if (!gapResult.ok || !gapResult.value.shouldRecall) return false;

    const detection = gapResult.value;
    if (this.gapCache.size >= RecallSkill.GAP_CACHE_MAX) {
      const firstKey = this.gapCache.keys().next().value;
      if (firstKey !== undefined) this.gapCache.delete(firstKey);
    }
    this.gapCache.set(msg.messageId, detection);
    return true;
  }

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    if (ctx.event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'recall only handles message events'));
    }
    const msg = ctx.event.payload;

    let detection = this.gapCache.get(msg.messageId);
    this.gapCache.delete(msg.messageId);

    if (!detection) {
      const histResult = await ctx.runtime.fetchHistory({ chatId: msg.chatId, pageSize: 10 });
      const fetched = histResult.ok ? histResult.value.messages : [];
      const hasCurrent = fetched.some((m) => m.messageId === msg.messageId);
      const messages = hasCurrent ? fetched : [msg, ...fetched];
      const detector = new GapDetector(ctx.llm);
      const gapResult = await detector.detect(messages);
      if (!gapResult.ok || !gapResult.value.shouldRecall) return ok({ text: '' });
      detection = gapResult.value;
    }

    const query: RetrieveQuery = { query: detection.query, chatId: msg.chatId, topK: 5 };

    const [vectorResult, bitableResult] = await Promise.all([
      ctx.retrievers['vector']?.retrieve(query) ??
        Promise.resolve(ok([] as readonly RetrieveHit[])),
      ctx.retrievers['bitable']?.retrieve(query) ??
        Promise.resolve(ok([] as readonly RetrieveHit[])),
    ]);

    const hits: RetrieveHit[] = [
      ...(vectorResult.ok ? vectorResult.value : []),
      ...(bitableResult.ok ? bitableResult.value : []),
    ];

    if (hits.length === 0) return ok({ text: '' });

    const text = await synthesize(ctx.llm, detection.query, hits);
    return ok({ text, reasoning: detection.reason });
  }
}

export const recallSkill: Skill = new RecallSkill();
