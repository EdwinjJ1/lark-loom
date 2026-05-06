/**
 * progressUpdate — 进展汇报 → 更新对应 todo 状态
 *
 * 触发：被动监听，"X 完成了 / 搞定了 / 在做"
 * 数据流：fetchHistory → LLM 抽取 → 在 todo 表里 fuzzy 匹配 → update 状态 → 写 memory
 * 失败降级：找不到匹配 todo → 仅写 memory 留痕，不报错
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
import {
  PROGRESS_UPDATE_PROMPT,
  ProgressUpdateSchema,
  EMPTY_PROGRESS_EXTRACTION,
  type ProgressUpdateExtraction,
  type ProgressItem,
} from './prompts/task-assignment.js';

const TRIGGER_RE =
  /完成|搞定|做完|写完|弄完|忙完|已完成|已经完成|进展汇报|进度更新|汇报一下进展|更新进度/;

const MIN_CONFIDENCE = 0.5;
const HISTORY_PAGE_SIZE = 15;
const TODO_FETCH_LIMIT = 50;

interface TodoCandidate {
  readonly recordId: string;
  readonly content: string;
  readonly owner: string;
  readonly status: string;
  readonly timestamp: number;
}

async function extract(
  ctx: SkillContext,
  chatId: string,
): Promise<Result<ProgressUpdateExtraction>> {
  const histResult = await ctx.runtime.fetchHistory({ chatId, pageSize: HISTORY_PAGE_SIZE });
  if (!histResult.ok) return err(histResult.error);

  const llmResult = await ctx.llm.askStructured(
    PROGRESS_UPDATE_PROMPT(histResult.value.messages),
    ProgressUpdateSchema,
    { model: 'pro', timeoutMs: 60_000 },
  );

  if (!llmResult.ok) {
    ctx.logger.warn('progressUpdate: extraction failed', {
      chatId,
      code: llmResult.error.code,
      message: llmResult.error.message,
    });
    return ok(EMPTY_PROGRESS_EXTRACTION);
  }

  return ok(llmResult.value);
}

async function fetchOpenTodos(
  ctx: SkillContext,
  chatId: string,
  owner: string,
): Promise<readonly TodoCandidate[]> {
  // 拉这个群、这个 owner 的 pending / in_progress todo
  const res = await ctx.bitable.find({
    table: 'todo',
    where: { chatId, owner },
    pageSize: TODO_FETCH_LIMIT,
  });
  if (!res.ok) {
    ctx.logger.warn('progressUpdate: fetch todos failed', {
      chatId,
      owner,
      code: res.error.code,
      message: res.error.message,
    });
    return [];
  }
  const out: TodoCandidate[] = [];
  for (const row of res.value.records) {
    const status = String(row['status'] ?? '');
    if (status === 'done') continue;
    const ts = typeof row['timestamp'] === 'number' ? row['timestamp'] : 0;
    out.push({
      recordId: row.recordId,
      content: String(row['content'] ?? ''),
      owner: String(row['owner'] ?? ''),
      status,
      timestamp: ts,
    });
  }
  return out;
}

/** 用最长公共子串长度做 fuzzy 匹配；不达阈值视为无匹配 */
function fuzzyMatch(taskText: string, candidates: readonly TodoCandidate[]): TodoCandidate | null {
  if (candidates.length === 0) return null;
  const target = taskText.toLowerCase();
  const scored = candidates
    .map((c) => {
      const content = c.content.toLowerCase();
      // 简单评分：包含 target 关键 token → 高分；否则按重叠字符数
      const tokens = target.split(/[\s,，。、；;]+/).filter((t) => t.length >= 2);
      const tokenHit = tokens.filter((t) => content.includes(t)).length;
      const overlap = [...new Set(content)].filter((ch) => target.includes(ch)).length;
      return { candidate: c, score: tokenHit * 10 + overlap };
    })
    .sort((a, b) => b.score - a.score);
  // 至少命中 1 个 token，否则视为不匹配
  if (scored[0] && scored[0].score >= 10) return scored[0].candidate;
  // 单候选 fallback：owner 已匹配，但仍要求最低字符重叠（避免完全无关的任务被误标完成）
  if (candidates.length === 1 && scored[0] && scored[0].score >= 3) return candidates[0] ?? null;
  return null;
}

async function processUpdate(ctx: SkillContext, chatId: string, item: ProgressItem): Promise<void> {
  const candidates = await fetchOpenTodos(ctx, chatId, item.owner);
  const matched = fuzzyMatch(item.task, candidates);

  if (matched) {
    const updateRes = await ctx.bitable.update({
      table: 'todo',
      recordId: matched.recordId,
      patch: {
        status: item.status,
        timestamp: Date.now(),
      },
    });
    if (!updateRes.ok) {
      ctx.logger.warn('progressUpdate: update todo failed', {
        chatId,
        owner: item.owner,
        recordId: matched.recordId,
        code: updateRes.error.code,
        message: updateRes.error.message,
      });
    } else {
      ctx.logger.info('progressUpdate: todo status updated', {
        chatId,
        owner: item.owner,
        from: matched.status,
        to: item.status,
      });
    }
  } else {
    // 不 log task 原文（PII），仅记录有 fallback 走过 memory-only 路径
    ctx.logger.info('progressUpdate: no matching todo, memory-only', {
      chatId,
      owner: item.owner,
    });
  }

  // 不论是否匹配都写 memory（避免进展信号丢失，QA / archive 仍可读到）
  const now = Date.now();
  const memRes = await ctx.bitable.insert({
    table: 'memory',
    row: {
      kind: 'project',
      chat_id: chatId,
      key: `progress-${chatId}-${now}-${item.owner}`,
      content: `${item.owner} ${item.status === 'done' ? '完成' : '推进'} ${item.task}`,
      importance: 5,
      last_access: now,
      created_at: now,
      source_skill: 'progressUpdate',
    },
  });
  if (!memRes.ok) {
    ctx.logger.warn('progressUpdate: insert memory failed', {
      chatId,
      code: memRes.error.code,
      message: memRes.error.message,
    });
  }
}

export const progressUpdateSkill: Skill = {
  name: 'progressUpdate',
  metadata: {
    description: '识别群里进展汇报，自动更新分工表对应任务的状态。',
    when_to_use: '群里出现"X 完成了 / 搞定了 / 已完成 / 进度更新"等消息时使用。',
    examples: ['A 的用户访谈完成了', '我把 PRD 写完了', '前端那块我搞定了'],
  },
  trigger: {
    events: ['message'],
    requireMention: false,
    keywords: ['完成', '搞定', '做完', '已完成', '进展', '进度'],
    description: '检测到任务进展时自动更新分工表状态',
  },

  match(ctx: SkillContext): boolean {
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    if (ctx.event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'progressUpdate only handles message events'));
    }
    const { chatId } = ctx.event.payload;

    const extractResult = await extract(ctx, chatId);
    if (!extractResult.ok) return err(extractResult.error);

    const updates = extractResult.value.updates.filter(
      (u) => u.confidence >= MIN_CONFIDENCE && u.owner && u.task,
    );

    if (updates.length === 0) {
      ctx.logger.warn('progressUpdate: no valid progress extracted', { chatId });
      return ok({ reasoning: '未识别到明确进展，跳过' });
    }

    for (const u of updates) {
      await processUpdate(ctx, chatId, u);
    }

    return ok({
      reasoning: `处理 ${updates.length} 条进展更新`,
    });
  },
};
