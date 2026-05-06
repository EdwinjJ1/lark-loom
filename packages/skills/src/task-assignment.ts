/**
 * taskAssignment — 分工识别 → todo 表录入 + tablePush 卡片
 *
 * 触发：被动监听，群里出现分工讨论时自动结构化抽取并写表
 * 数据流：fetchHistory → LLM 结构化提取 → batchInsert todo → 卡片
 * 失败降级：LLM 没抽出 / bitable 写失败 → 不发卡，仅 warn
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
  TASK_ASSIGNMENT_PROMPT,
  TaskAssignmentSchema,
  EMPTY_TASK_EXTRACTION,
  type TaskAssignmentExtraction,
  type TaskItem,
} from './prompts/task-assignment.js';
import { clamp } from './utils/clamp.js';

// 放宽：router 已经做过一道闸；这里只要疑似分工就交给 LLM 抽，抽不到 confidence>=0.5 自然 warn 静默
const TRIGGER_RE =
  /负责|DDL|deadline|截止|验收|交付物|分工|排期|跟进|盯一下|盯着|对接|安排一下|交给|派给|分给|让.{0,8}(?:来|去|做|搞|弄|写|盯|跟)|由.{0,8}(?:来|做|搞|负责)|.{1,8}来(?:搞|做|弄|写|跟进|对接|处理|盯|完成)|这块|这部分|那块/i;

const MIN_CONFIDENCE = 0.5;
const HISTORY_PAGE_SIZE = 20;

function bitableUrlFromEnv(): string {
  const token = process.env['BITABLE_APP_TOKEN'];
  return token ? `https://feishu.cn/base/${token}` : '';
}

async function extract(
  ctx: SkillContext,
  chatId: string,
): Promise<Result<TaskAssignmentExtraction>> {
  const histResult = await ctx.runtime.fetchHistory({ chatId, pageSize: HISTORY_PAGE_SIZE });
  if (!histResult.ok) return err(histResult.error);

  const llmResult = await ctx.llm.askStructured(
    TASK_ASSIGNMENT_PROMPT(histResult.value.messages),
    TaskAssignmentSchema,
    { model: 'pro', timeoutMs: 60_000 },
  );

  if (!llmResult.ok) {
    ctx.logger.warn('taskAssignment: extraction failed', {
      chatId,
      code: llmResult.error.code,
      message: llmResult.error.message,
    });
    return ok(EMPTY_TASK_EXTRACTION);
  }

  return ok(llmResult.value);
}

function filterValidTasks(tasks: readonly TaskItem[]): readonly TaskItem[] {
  return tasks.filter((t) => t.confidence >= MIN_CONFIDENCE && t.owner && t.task);
}

function pickNearestDue(tasks: readonly TaskItem[]): string | undefined {
  const dues = tasks
    .map((t) => t.ddl)
    .filter((d): d is string => Boolean(d) && /^\d{4}-\d{2}-\d{2}$/.test(d as string))
    .sort();
  return dues[0];
}

export const taskAssignmentSkill: Skill = {
  name: 'taskAssignment',
  metadata: {
    description: '把群里讨论的分工结构化录入分工表，并推送分工表更新卡片。',
    when_to_use: '群里出现"X 来负责 Y / 谁负责 / DDL / 验收标准 / 交付物 / 分工"等讨论时使用。',
    examples: [
      'A 负责用户访谈，DDL 明天下午，交付访谈纪要',
      '前端这一块由小李负责，下周五前完成',
      '我们分工一下：B 写 PRD，C 跟设计',
    ],
  },
  trigger: {
    events: ['message'],
    requireMention: false,
    keywords: ['负责', '分工', 'DDL', '截止', '验收标准', '交付物'],
    description: '检测到分工讨论时自动写入分工表并推送卡片',
  },

  match(ctx: SkillContext): boolean {
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    if (ctx.event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'taskAssignment only handles message events'));
    }
    const { chatId } = ctx.event.payload;

    // 0. 立刻发 loading 卡片占位（仿 summary / requirementDoc / slides）
    const loadingCard = ctx.cardBuilder.build('tablePush', {
      tableTitle: '项目分工表',
      bitableUrl: '',
      taskCount: 0,
      members: [],
      isLoading: true,
    });
    const loadingSent = await ctx.runtime.sendCard({ chatId, card: loadingCard });
    if (!loadingSent.ok) return err(loadingSent.error);
    const loadingMessageId = loadingSent.value.messageId;

    const patchToError = async (message: string): Promise<void> => {
      const errCard = ctx.cardBuilder.build('tablePush', {
        tableTitle: '项目分工表',
        bitableUrl: '',
        taskCount: 0,
        members: [],
        errorMessage: message,
      });
      const patchRes = await ctx.runtime.patchCard({ messageId: loadingMessageId, card: errCard });
      if (!patchRes.ok) {
        ctx.logger.warn('taskAssignment: patch error card failed', {
          code: patchRes.error.code,
          message: patchRes.error.message,
        });
      }
    };

    // 1. LLM 抽取
    const extractResult = await extract(ctx, chatId);
    if (!extractResult.ok) {
      await patchToError(`抽取失败：${extractResult.error.message}`);
      return err(extractResult.error);
    }

    const tasks = filterValidTasks(extractResult.value.tasks);
    if (tasks.length === 0) {
      ctx.logger.warn('taskAssignment: no valid tasks extracted', { chatId });
      await patchToError('本次未识别到明确的分工（owner / 任务都需要明确）');
      return ok({ reasoning: '未识别到明确分工' });
    }

    const now = Date.now();

    // 2. 写 todo 表（失败 patch 错误卡，告知用户表写失败）
    //    LLM 输出字段做硬截断，防止 prompt-injected 长串撑爆 Bitable 行
    const insertResult = await ctx.bitable.batchInsert({
      table: 'todo',
      rows: tasks.map((t) => ({
        chatId,
        content: clamp(t.task),
        owner: clamp(t.owner),
        ddl: t.ddl ?? '',
        status: 'pending',
        deliverable: clamp(t.deliverable),
        acceptance: clamp(t.acceptance),
        source: 'taskAssignment',
        timestamp: now,
      })),
    });

    if (!insertResult.ok) {
      ctx.logger.warn('taskAssignment: batchInsert todo failed', {
        chatId,
        code: insertResult.error.code,
        message: insertResult.error.message,
      });
      await patchToError(`写入分工表失败：${insertResult.error.message}`);
      return ok({ reasoning: '写入分工表失败' });
    }

    // 3. 写 memory（统一 MemoryRecord schema）—— content 走 LONG 截断，防多任务拼接超长
    //    失败仅 warn，不阻断卡片输出
    const memContent = clamp(
      tasks
        .map((t) => `${t.owner} → ${t.task}${t.ddl ? ` (DDL ${t.ddl})` : ''}`)
        .join(' | '),
      'LONG',
    );
    const memRes = await ctx.bitable.insert({
      table: 'memory',
      row: {
        kind: 'project',
        chat_id: chatId,
        key: `task-${chatId}-${now}`,
        content: memContent,
        importance: 6,
        last_access: now,
        created_at: now,
        source_skill: 'taskAssignment',
      },
    });
    if (!memRes.ok) {
      ctx.logger.warn('taskAssignment: insert memory failed', {
        chatId,
        code: memRes.error.code,
        message: memRes.error.message,
      });
    }

    // 4. patch 成最终卡 — 没有 BITABLE_APP_TOKEN 时按钮没有链接，patch 成 error 态
    const bitableUrl = bitableUrlFromEnv();
    if (!bitableUrl) {
      ctx.logger.warn('taskAssignment: BITABLE_APP_TOKEN missing', { chatId });
      await patchToError('Bitable URL 未配置，无法生成查看链接（已写入 todo 表）');
      return ok({
        reasoning: `抽取到 ${tasks.length} 条分工，但 Bitable URL 未配置`,
      });
    }

    const owners = Array.from(new Set(tasks.map((t) => t.owner)));
    const nearestDue = pickNearestDue(tasks);
    const finalCard = ctx.cardBuilder.build('tablePush', {
      tableTitle: '项目分工表',
      bitableUrl,
      taskCount: tasks.length,
      members: owners,
      ...(nearestDue ? { nearestDue } : {}),
    });
    const patchRes = await ctx.runtime.patchCard({
      messageId: loadingMessageId,
      card: finalCard,
    });
    if (!patchRes.ok) {
      ctx.logger.warn('taskAssignment: patch final card failed; final card not visible', {
        code: patchRes.error.code,
        message: patchRes.error.message,
      });
    }

    // 不再返回 card：已通过 patchCard 替换 loading 卡，wiring 不需要再发一条
    return ok({
      reasoning: `抽取到 ${tasks.length} 条分工，涉及 ${owners.length} 位成员`,
    });
  },
};
