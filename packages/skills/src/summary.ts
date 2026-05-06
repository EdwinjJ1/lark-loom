/**
 * summary — 会议纪要自动整理（与 requirementDoc / archive 同款防幻觉 pipeline）
 *
 * 触发：群里出现会议纪要 / 妙记 / 会议总结（被动监听，无需 @bot）
 *
 * 数据流：
 *   1. 立刻发 loading 卡片占位
 *   2. fetchHistory + 展开合并转发（妙记导出常以转发形式贴入）
 *   3. lite 模型相关性预筛（剔除 bot 噪音 / 跨项目闲聊）
 *   4. pro 模型 askStructured 提取（带 4 类 meeting 幻觉硬约束 + 4 个 few-shot）
 *   5. patchCard 替换为最终 summary 卡 / 任意失败 patch 成 error 卡
 *   6. 写 decision / todo / memory（异步副作用，失败不阻断卡片）
 */

import {
  type Message,
  type Skill,
  type SkillContext,
  type SkillResult,
  type Result,
  ok,
  err,
  ErrorCode,
  makeError,
} from '@seedhac/contracts';
import {
  SUMMARY_PROMPT,
  EMPTY_EXTRACTION,
  SummaryExtractionSchema,
  renderSummaryProse,
  type SummaryExtraction,
} from './prompts/summary.js';
import {
  RELEVANCE_PROMPT,
  RelevanceJudgmentSchema,
  type RelevanceCandidate,
} from './prompts/requirement-doc.js';

const TRIGGER_RE = /会议纪要|妙记|会议总结|本次会议/i;

/**
 * 把历史消息里的「合并转发」展开。妙记或他人会议记录常以合并转发形式贴入群。
 * 失败时保留父原样并 logger.warn。
 */
async function expandMergeForward(
  ctx: SkillContext,
  history: readonly Message[],
): Promise<readonly Message[]> {
  const out: Message[] = [];
  for (const m of history) {
    if ((m.contentType as string) !== 'merge_forward') {
      out.push(m);
      continue;
    }
    const fetched = await ctx.runtime.fetchMessage(m.messageId);
    if (!fetched.ok) {
      ctx.logger.warn('summary: fetchMessage failed for merge_forward; keeping as-is', {
        messageId: m.messageId,
        code: fetched.error.code,
        message: fetched.error.message,
      });
      out.push(m);
      continue;
    }
    const children = fetched.value.messages.filter(
      (c) => (c.contentType as string) === 'text' && c.text.trim().length > 0,
    );
    if (children.length === 0) {
      out.push(m);
      continue;
    }
    ctx.logger.info('summary: merge_forward expanded', {
      messageId: m.messageId,
      childCount: children.length,
    });
    for (const child of children) out.push(child);
  }
  return out;
}

function summarize(value: string, max = 200): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 用 lite 模型预筛历史 — 群里可能掺多个项目讨论 / bot 诊断噪音。
 * 失败时降级为原 history（不致命）。
 */
async function filterByRelevance(
  ctx: SkillContext,
  trigger: Message,
  history: readonly Message[],
): Promise<readonly Message[]> {
  if (history.length <= 5) return history;

  const candidates: RelevanceCandidate[] = history.map((m, i) => ({
    id: `m${i}`,
    kind: 'message',
    excerpt: `[${m.sender.name ?? m.sender.userId}] ${summarize(m.text, 200)}`,
  }));

  const judgmentResult = await ctx.llm.askStructured(
    RELEVANCE_PROMPT(trigger.text, candidates),
    RelevanceJudgmentSchema,
    { model: 'lite', timeoutMs: 30_000 },
  );

  if (!judgmentResult.ok) {
    ctx.logger.warn('summary: relevance filter failed, falling back to full history', {
      code: judgmentResult.error.code,
      message: judgmentResult.error.message,
    });
    return history;
  }

  if (judgmentResult.value.results.length === 0) return history;

  const keepIds = new Set(judgmentResult.value.results.filter((r) => r.keep).map((r) => r.id));
  const kept = history.filter((_, i) => keepIds.has(`m${i}`));

  ctx.logger.info('summary: relevance pre-filter done', {
    kept: `${kept.length}/${history.length}`,
  });

  // 如果筛完几乎全没了，可能是模型误判：保底退回原 history
  return kept.length >= Math.min(3, history.length) ? kept : history;
}

async function extractSummary(
  ctx: SkillContext,
  history: readonly Message[],
): Promise<Result<SummaryExtraction>> {
  // pro 默认 30s 不够：长 prompt + few-shot，35-90s 是常态（参考 requirementDoc）
  const llmResult = await ctx.llm.askStructured(
    SUMMARY_PROMPT(history),
    SummaryExtractionSchema,
    { model: 'pro', timeoutMs: 90_000 },
  );
  if (!llmResult.ok) return err(llmResult.error);
  return ok(llmResult.value);
}

export const summarySkill: Skill = {
  name: 'summary',
  metadata: {
    description: '把会议纪要或妙记内容整理为决策、行动项、问题和下一步。',
    when_to_use: '群里出现会议纪要、妙记、会议总结，或用户要求总结一次讨论时使用。',
    examples: ['会议纪要已发，请总结一下', '妙记链接来了', '@bot 帮我整理这次会议结论'],
  },
  trigger: {
    events: ['message'],
    requireMention: false,
    keywords: ['会议纪要', '妙记', '会议总结', '本次会议'],
    description: '检测到会议纪要时整理结构化决策 / 行动项 / 遗留问题',
  },

  match(ctx: SkillContext): boolean {
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    if (ctx.event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'summary only handles message events'));
    }
    const msg = ctx.event.payload;
    const { chatId } = msg;

    // 0. 立刻发 loading 卡片占位（仿 requirementDoc / slides）
    const loadingCard = ctx.cardBuilder.build('summary', {
      title: '会议纪要',
      topics: [],
      decisions: [],
      todos: [],
      followUps: [],
      isLoading: true,
    });
    const loadingSent = await ctx.runtime.sendCard({ chatId, card: loadingCard });
    if (!loadingSent.ok) return err(loadingSent.error);
    const loadingMessageId = loadingSent.value.messageId;

    const patchToError = async (message: string): Promise<void> => {
      const errCard = ctx.cardBuilder.build('summary', {
        title: '会议纪要',
        topics: [],
        decisions: [],
        todos: [],
        followUps: [],
        errorMessage: message,
      });
      const patchRes = await ctx.runtime.patchCard({ messageId: loadingMessageId, card: errCard });
      if (!patchRes.ok) {
        ctx.logger.warn('summary: patch error card failed', {
          code: patchRes.error.code,
          message: patchRes.error.message,
        });
      }
    };

    // a. 拉历史 + 展开合并转发
    const histResult = await ctx.runtime.fetchHistory({ chatId, pageSize: 50 });
    if (!histResult.ok) {
      await patchToError(`拉群历史失败：${histResult.error.message}`);
      return err(histResult.error);
    }
    const expanded = await expandMergeForward(ctx, histResult.value.messages);

    // b. lite 相关性预筛（数量较小或筛完几乎空时自动 fallback）
    const filtered = await filterByRelevance(ctx, msg, expanded);

    // c. pro 模型结构化提取
    ctx.logger.info('summary: asking LLM for structured extraction', {
      historyCount: filtered.length,
    });
    const extractResult = await extractSummary(ctx, filtered);
    if (!extractResult.ok) {
      await patchToError(`LLM 提取失败：${extractResult.error.message}`);
      return err(extractResult.error);
    }
    const summary = extractResult.value;

    // d. patch 成最终卡片 — 优先做这一步，让用户最快看到结果；后面的写入是异步副作用
    const finalCard = ctx.cardBuilder.build('summary', {
      title: '会议纪要',
      summary: renderSummaryProse(summary),
      topics: [],
      decisions: summary.decisions,
      todos: summary.actionItems.map((a) => ({
        text: a.content,
        assignee: a.owner,
        ...(a.ddl !== undefined ? { due: a.ddl } : {}),
      })),
      followUps: [...summary.issues, ...summary.nextSteps],
    });
    const patchRes = await ctx.runtime.patchCard({ messageId: loadingMessageId, card: finalCard });
    if (!patchRes.ok) {
      ctx.logger.warn('summary: patch final card failed; final card not visible', {
        code: patchRes.error.code,
        message: patchRes.error.message,
      });
    }

    // e. 副作用写入（失败不阻断卡片输出）
    if (summary.decisions.length > 0) {
      const res = await ctx.bitable.batchInsert({
        table: 'decision',
        rows: summary.decisions.map((d) => ({ chatId, content: d, timestamp: Date.now() })),
      });
      if (!res.ok) ctx.logger.warn('summary: batchInsert decision failed', { error: res.error });
    }

    if (summary.actionItems.length > 0) {
      const res = await ctx.bitable.batchInsert({
        table: 'todo',
        rows: summary.actionItems.map((a) => ({
          chatId,
          content: a.content,
          owner: a.owner,
          ddl: a.ddl ?? '',
          status: 'pending',
          timestamp: Date.now(),
        })),
      });
      if (!res.ok) ctx.logger.warn('summary: batchInsert todo failed', { error: res.error });
    }

    // memory 记一条 chat 类型 audit（PR #96 后所有 skill 字段对齐 MemoryRecord）
    const now = Date.now();
    const memRes = await ctx.bitable.insert({
      table: 'memory',
      row: {
        key: `summary-${chatId}-${now}`,
        kind: 'chat',
        chat_id: chatId,
        content: [
          summary.summary,
          summary.decisions.length ? `决策：${summary.decisions.join('；')}` : '',
          summary.actionItems.length
            ? `行动项：${summary.actionItems.map((a) => `${a.owner || '?'}: ${a.content}`).join('；')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        importance: 5,
        last_access: now,
        created_at: now,
        source_skill: 'summary',
      },
    });
    if (!memRes.ok) ctx.logger.warn('summary: insert memory failed', { error: memRes.error });

    // 不再返回 card：已通过 patchCard 替换 loading 卡，wiring 不需要再发一条
    return ok({
      reasoning: `提取到 ${summary.decisions.length} 条决策，${summary.actionItems.length} 条行动项${
        summary.issues.length ? `，${summary.issues.length} 个待澄清` : ''
      }`,
    });
  },
};

// 兼容旧 import（已迁到 prompts/summary）— 保持向后兼容
export { EMPTY_EXTRACTION };
