/**
 * weekly — 定时周报 / 项目周快照
 *
 * 触发：cron 周五 17:00（runtime 推 schedule 事件）或手动 @bot 生成周报
 * 数据流：读取高重要 skill_log → LLM Pro 压缩 → 写 project 记忆 → 删除旧 skill_log
 */

import {
  type MemoryRecord,
  type Skill,
  type SkillContext,
  type SkillResult,
  type Result,
  ok,
  err,
  ErrorCode,
  makeError,
} from '@seedhac/contracts';

interface WeeklySnapshot {
  readonly title: string;
  readonly highlights: readonly string[];
  readonly decisions: readonly string[];
  readonly todos: readonly string[];
  readonly summary: string;
}

// LLM JSON 解析失败时，从原始 logs 拼凑一个简易快照——只取前 N 条避免内容溢出。
const FALLBACK_LOG_LIMIT = 6;

function weekRange(now: number): string {
  const d = new Date(now);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return `${fmt(start)} ~ ${fmt(end)}`;
}

interface WeeklyCachedSnapshot {
  readonly weekRange: string;
  readonly title?: string;
  readonly highlights?: readonly string[];
  readonly decisions?: readonly string[];
  readonly todos?: readonly string[];
}

function parseCachedSnapshot(content: string): WeeklyCachedSnapshot | null {
  try {
    const parsed = JSON.parse(content) as Partial<WeeklyCachedSnapshot>;
    if (typeof parsed.weekRange !== 'string') return null;
    return {
      weekRange: parsed.weekRange,
      ...(typeof parsed.title === 'string' && { title: parsed.title }),
      ...(Array.isArray(parsed.highlights) && { highlights: parsed.highlights.map(String) }),
      ...(Array.isArray(parsed.decisions) && { decisions: parsed.decisions.map(String) }),
      ...(Array.isArray(parsed.todos) && { todos: parsed.todos.map(String) }),
    };
  } catch {
    return null;
  }
}

function renderLogs(logs: readonly MemoryRecord[]): string {
  return logs
    .map((m, i) => `#${i + 1} [${m.source_skill}] importance=${m.importance}\n${m.content}`)
    .join('\n\n');
}

function parseSnapshot(raw: string, logs: readonly MemoryRecord[]): WeeklySnapshot {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<WeeklySnapshot>;
    const highlights = Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [];
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [];
    const todos = Array.isArray(parsed.todos) ? parsed.todos.map(String) : [];
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : [...highlights, ...decisions, ...todos].join('\n');
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : '项目周快照',
      highlights,
      decisions,
      todos,
      summary,
    };
  } catch {
    const fallback = logs
      .slice(0, FALLBACK_LOG_LIMIT)
      .map((m) => `${m.source_skill}: ${m.content.slice(0, 80)}`);
    return {
      title: '项目周快照',
      highlights: fallback,
      decisions: [],
      todos: [],
      summary: fallback.join('\n'),
    };
  }
}

function buildPrompt(logs: readonly MemoryRecord[]): string {
  return `你是项目协作助手，请把以下高重要 skill_log 压缩成一条“项目周快照”。

要求：
- 只保留本周真正重要的项目进展、决策和下周待办
- 不要逐条复述日志
- 输出严格 JSON，不要 markdown 代码块

JSON 格式：
{"title":"项目周快照标题","highlights":["亮点"],"decisions":["决策"],"todos":["待办"],"summary":"200字以内总述"}

skill_log:
${renderLogs(logs)}`;
}

function getChatId(ctx: SkillContext): string | null {
  if (ctx.event.type === 'schedule') return ctx.event.payload.chatId;
  if (ctx.event.type === 'message') return ctx.event.payload.chatId;
  return null;
}

async function deleteCompressedLogs(
  ctx: SkillContext,
  logs: readonly MemoryRecord[],
): Promise<void> {
  const memoryStore = ctx.memoryStore;
  if (!memoryStore) return;
  await Promise.all(
    logs.map(async (log) => {
      const result = await memoryStore.delete(log);
      if (!result.ok) {
        ctx.logger.warn('weekly: delete compressed skill_log failed', {
          id: log.id,
          code: result.error.code,
          message: result.error.message,
        });
      }
    }),
  );
}

export const weeklySkill: Skill = {
  name: 'weekly',
  metadata: {
    description: '定时生成项目周报，汇总本周进展、决策和待办。',
    when_to_use: '计划任务在周五触发，或后续需要手动生成周报时使用。',
    examples: ['周五 17:00 自动周报', '@bot 生成本周周报', '汇总这一周的项目进展'],
  },
  trigger: {
    events: ['schedule', 'message'],
    requireMention: false,
    cron: '0 17 * * 5',
    description: '周五 17:00 → 压缩高重要 skill_log 为项目周快照',
  },
  match: (ctx) => {
    if (ctx.event.type === 'schedule') return ctx.event.payload.skillName === 'weekly';
    if (ctx.event.type === 'message')
      return /周报|本周总结|项目周快照/i.test(ctx.event.payload.text);
    return false;
  },
  run: async (ctx): Promise<Result<SkillResult>> => {
    const memoryStore = ctx.memoryStore;
    if (!memoryStore) {
      return err(makeError(ErrorCode.CONFIG_MISSING, 'weekly: memoryStore is not configured'));
    }
    const chatId = getChatId(ctx);
    if (!chatId) {
      return err(makeError(ErrorCode.INVALID_INPUT, 'weekly requires chatId'));
    }

    const range = weekRange(Date.now());
    const weekKey = `weekly:${range.slice(0, 10)}`;

    // 当周已生成过快照 → 直接重发，避免 cron + 手动重复触发把 skill_log 删完。
    const existing = await memoryStore.read('project', chatId, weekKey);
    if (existing.ok && existing.value) {
      const cached = parseCachedSnapshot(existing.value.content);
      if (cached && cached.weekRange === range) {
        const cachedCard = ctx.cardBuilder.build('weekly', {
          weekRange: range,
          highlights: cached.highlights ?? [],
          decisions: cached.decisions ?? [],
          todos: cached.todos ?? [],
        });
        return ok({
          card: cachedCard,
          reasoning: '本周快照已存在，直接重发缓存版本',
        });
      }
    }

    const logsResult = await memoryStore.list({
      chatId,
      kind: 'skill_log',
      minImportance: 7,
      limit: 100,
    });
    if (!logsResult.ok) return err(logsResult.error);
    const logs = logsResult.value;
    if (logs.length === 0) {
      return ok({ text: '本周还没有需要压缩的高重要项目记忆。' });
    }

    const llmResult = await ctx.llm.ask(buildPrompt(logs), {
      model: 'pro',
      temperature: 0.2,
      maxTokens: 1200,
    });
    if (!llmResult.ok) return err(llmResult.error);

    const snapshot = parseSnapshot(llmResult.value, logs);
    const writeResult = await memoryStore.write({
      kind: 'project',
      chat_id: chatId,
      key: weekKey,
      source_skill: 'weekly',
      importance: 9,
      content: JSON.stringify({
        title: snapshot.title,
        weekRange: range,
        summary: snapshot.summary,
        highlights: snapshot.highlights,
        decisions: snapshot.decisions,
        todos: snapshot.todos,
        compressedLogIds: logs.flatMap((log) => (log.id ? [log.id] : [])),
      }),
    });
    if (!writeResult.ok) return err(writeResult.error);

    await deleteCompressedLogs(ctx, logs);

    const card = ctx.cardBuilder.build('weekly', {
      weekRange: range,
      highlights: snapshot.highlights,
      decisions: snapshot.decisions,
      todos: snapshot.todos,
    });

    return ok({
      card,
      reasoning: `压缩 ${logs.length} 条高重要 skill_log 为项目周快照`,
    });
  },
};
