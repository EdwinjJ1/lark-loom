/**
 * summary — 会议纪要自动整理
 *
 * 触发：群里出现会议纪要 / 妙记内容（被动监听，无需 @bot）
 * 数据流：fetchHistory → LLM 结构化提取 → batchInsert Bitable → summary 卡片
 * 输出：决策 / 行动项 / 遗留问题 / 下一步 4 段
 */

import {
  type Skill,
  type SkillContext,
  type SkillResult,
  type Result,
  ok,
  err,
  ErrorCode,
  makeError,
} from '@seedhac/contracts';
import { SUMMARY_PROMPT, EMPTY_EXTRACTION, type SummaryExtraction } from './prompts/summary.js';

const TRIGGER_RE = /会议纪要|妙记|会议总结|本次会议/i;

async function extractSummary(
  ctx: SkillContext,
  chatId: string,
): Promise<Result<SummaryExtraction>> {
  const histResult = await ctx.runtime.fetchHistory({ chatId, pageSize: 50 });
  if (!histResult.ok) return err(histResult.error);

  const llmResult = await ctx.llm.ask(SUMMARY_PROMPT(histResult.value.messages), { model: 'pro' });
  if (!llmResult.ok) return err(llmResult.error);

  try {
    const cleaned = llmResult.value
      .trim()
      .replace(/```json|```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned) as SummaryExtraction;
    return ok({
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.map((a) => ({
            owner: String(a.owner ?? ''),
            content: String(a.content ?? ''),
            ...(a.ddl ? { ddl: String(a.ddl) } : {}),
          }))
        : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String) : [],
    });
  } catch {
    return ok(EMPTY_EXTRACTION);
  }
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
    description: '检测到会议纪要时自动整理并写入项目记忆',
  },

  match(ctx: SkillContext): boolean {
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    if (ctx.event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'summary only handles message events'));
    }
    const { chatId } = ctx.event.payload;

    const extractResult = await extractSummary(ctx, chatId);
    if (!extractResult.ok) return err(extractResult.error);
    const summary = extractResult.value;

    // 写 Bitable — 失败不阻断卡片输出，仅记录日志
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

    // 字段对齐 contracts/MemoryRecord schema（kind / chat_id / key / content /
    // source_skill / importance / created_at / last_access），跟 BITABLE memory 表一致
    const now = Date.now();
    const memRes = await ctx.bitable.insert({
      table: 'memory',
      row: {
        key: `summary-${chatId}-${now}`,
        kind: 'chat',
        chat_id: chatId,
        content: summary.decisions.join(' | '),
        importance: 5,
        last_access: now,
        created_at: now,
        source_skill: 'summary',
      },
    });
    if (!memRes.ok) ctx.logger.warn('summary: insert memory failed', { error: memRes.error });

    const card = ctx.cardBuilder.build('summary', {
      title: '会议纪要',
      topics: [],
      decisions: summary.decisions,
      todos: summary.actionItems.map((a) => ({
        text: a.content,
        assignee: a.owner,
        ...(a.ddl !== undefined ? { due: a.ddl } : {}),
      })),
      followUps: [...summary.issues, ...summary.nextSteps],
    });

    return ok({
      card,
      reasoning: `提取到 ${summary.decisions.length} 条决策，${summary.actionItems.length} 条行动项`,
    });
  },
};
