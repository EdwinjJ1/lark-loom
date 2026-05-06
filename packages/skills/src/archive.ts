/**
 * archive — 项目交付归档（issue #104 复赛 MVP）
 *
 * 触发：群里出现 复盘 / 归档 / 项目结束 / 收尾 / 准备交付（被动监听，无需 @bot）
 *
 * 数据流：
 *   1. 并行拉 memory / decision / todo 三张表（chatId 过滤）
 *   2. 从 memory.content 提取本次产出物链接：[需求文档] / [slides] / [任务表] 前缀 + URL
 *   3. LLM 生成 100-200 字交付摘要
 *   4. 渲染 archive 卡：摘要 + 多链接列表 + 决策数 + 任务完成情况
 *   5. 写一条 kind=project 的归档 memory 作为审计
 *
 * 健壮性：
 *   - 任一 bitable.find 失败 → 用空数据继续（不阻断）
 *   - LLM 失败 → 降级摘要 "项目已收尾，详细产出请见上方链接"
 *   - 归档 memory 写入失败 → warn 不阻断卡片输出
 */

import {
  type ArchiveLink,
  type Skill,
  type SkillContext,
  type SkillResult,
  type Result,
  type BitableRow,
  ok,
  err,
  ErrorCode,
  makeError,
} from '@seedhac/contracts';
import {
  ARCHIVE_SUMMARY_PROMPT,
  ArchiveSummarySchema,
  EMPTY_SUMMARY,
  renderArchiveSummary,
} from './prompts/archive.js';

const TRIGGER_RE = /复盘|归档|项目结束|收尾|准备交付/i;

// 飞书域名 URL 提取（docs / wiki / lark / sheets / bitable）
const FEISHU_URL_RE = /https?:\/\/[^\s)>]+(?:feishu\.cn|larksuite\.com|larkoffice\.com)[^\s)>]*/g;

interface ExtractedLink extends ArchiveLink {
  /** memory 写入时的 created_at，用于排序取最新 */
  readonly recordedAt: number;
}

/**
 * memory.content 前缀 → ArchiveLink kind / 显示文案 的映射表。
 * 顺序无关（前缀都是 `[xxx]` 开头不会冲突）。
 */
const PREFIX_TABLE: ReadonlyArray<{
  re: RegExp;
  kind: NonNullable<ArchiveLink['kind']>;
  label: string;
}> = [
  { re: /^\[需求文档\]/, kind: 'requirementDoc', label: '需求文档' },
  { re: /^\[(slides|PPT|演示)\]/i, kind: 'slides', label: '演示 PPT' },
  { re: /^\[(汇报分工|发言分工)\]/, kind: 'taskAssignment', label: '汇报分工文稿' },
  { re: /^\[(任务表|todo|分工)\]/i, kind: 'taskAssignment', label: '任务分工表' },
];

/**
 * 从 memory records 提取产出物链接。
 *
 * 同 kind+label 组合取最新一条；总数上限 6 条避免卡片爆掉。
 */
export function extractLinksFromMemory(memories: readonly BitableRow[]): readonly ArchiveLink[] {
  // 用 "kind|label" 作为去重 key，让"汇报分工文稿"和"任务分工表"能并存（都是 taskAssignment）
  const byKey = new Map<string, ExtractedLink>();
  const others: ExtractedLink[] = [];

  for (const m of memories) {
    const content = String(m['content'] ?? '');
    if (!content) continue;
    const recordedAt = Number(m['created_at'] ?? m['timestamp'] ?? 0);

    const urls = content.match(FEISHU_URL_RE);
    if (!urls || urls.length === 0) continue;
    const url = urls[0]!;

    const matched = PREFIX_TABLE.find((p) => p.re.test(content));
    if (!matched) {
      others.push({ kind: 'other', label: '相关文档', url, recordedAt });
      continue;
    }

    const dedupeKey = `${matched.kind}|${matched.label}`;
    const existing = byKey.get(dedupeKey);
    if (!existing || existing.recordedAt < recordedAt) {
      byKey.set(dedupeKey, { kind: matched.kind, label: matched.label, url, recordedAt });
    }
  }

  // 主分类排在前面，按 kind 优先级 + recordedAt 新→旧
  const kindOrder: Record<NonNullable<ArchiveLink['kind']>, number> = {
    requirementDoc: 0,
    slides: 1,
    taskAssignment: 2,
    bitable: 3,
    other: 9,
  };
  const ordered: ArchiveLink[] = [...byKey.values()]
    .sort((a, b) => {
      const ka = kindOrder[a.kind ?? 'other'];
      const kb = kindOrder[b.kind ?? 'other'];
      if (ka !== kb) return ka - kb;
      return b.recordedAt - a.recordedAt;
    })
    .map((l) => ({ kind: l.kind ?? ('other' as const), label: l.label, url: l.url }));

  // others 补充最近 2 条
  others
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, 2)
    .forEach((l) => ordered.push({ kind: 'other' as const, label: l.label, url: l.url }));

  return ordered.slice(0, 6);
}

export const archiveSkill: Skill = {
  name: 'archive',
  metadata: {
    description: '在项目收尾时汇总记忆、决策和任务，生成最终交付卡（含产出物链接）。',
    when_to_use:
      '群里出现复盘、归档、项目结束、收尾、准备交付等信号，需要给团队 / 评委一个清晰收束时使用。',
    examples: ['项目结束了，归档一下', '我们做个复盘', '@bot 准备交付'],
  },
  trigger: {
    events: ['message'],
    requireMention: false,
    keywords: ['复盘', '归档', '项目结束', '收尾', '准备交付'],
    description: '检测到项目交付信号时打包成果产出最终交付卡',
  },

  match(ctx: SkillContext): boolean {
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    if (ctx.event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'archive only handles message events'));
    }
    const { chatId } = ctx.event.payload;
    // memory schema 用 chat_id（PR #96 修复后），但 decision/todo 仍是旧 chatId
    // 这里 archive 三张表都查，filter 字段名按各自 schema 来。
    const memoryFilter = `AND(CurrentValue.[chat_id]="${chatId}")`;
    const legacyFilter = `AND(CurrentValue.[chatId]="${chatId}")`;

    const [memoryRes, decisionRes, todoRes] = await Promise.all([
      ctx.bitable.find({ table: 'memory', filter: memoryFilter, pageSize: 100 }),
      ctx.bitable.find({ table: 'decision', filter: legacyFilter, pageSize: 100 }),
      ctx.bitable.find({ table: 'todo', filter: legacyFilter, pageSize: 100 }),
    ]);

    const memories = memoryRes.ok ? memoryRes.value.records : [];
    const decisions = decisionRes.ok ? decisionRes.value.records : [];
    const todos = todoRes.ok ? todoRes.value.records : [];

    if (!memoryRes.ok)
      ctx.logger.warn('archive: memory.find failed', { error: memoryRes.error.message });
    if (!decisionRes.ok)
      ctx.logger.warn('archive: decision.find failed', { error: decisionRes.error.message });
    if (!todoRes.ok)
      ctx.logger.warn('archive: todo.find failed', { error: todoRes.error.message });

    const links = extractLinksFromMemory(memories);
    const doneCount = todos.filter((t) => t['status'] === 'done').length;

    // 计算字段（不让 LLM 碰，物理隔离防幻觉）
    const computed = {
      decisionCount: decisions.length,
      taskCompletion: todos.length > 0 ? `${doneCount}/${todos.length}` : null,
    };

    // 数据严重不足（< 3 条总记录）→ 跳过 LLM，走静态 fallback。
    // 既省 token 又彻底防止 LLM 在空数据上幻觉编造。
    const totalRecords = memories.length + decisions.length + todos.length;
    let summary = EMPTY_SUMMARY;
    if (totalRecords >= 3) {
      // askStructured + JSON schema 约束：豆包必须按 5 字段填，不能瞎扯
      const llmResult = await ctx.llm.askStructured(
        ARCHIVE_SUMMARY_PROMPT(memories, decisions, todos),
        ArchiveSummarySchema,
        { model: 'pro', timeoutMs: 60_000 },
      );
      if (llmResult.ok) {
        summary = llmResult.value;
      } else {
        ctx.logger.warn('archive: structured LLM failed, using fallback summary', {
          error: llmResult.error.message,
        });
      }
    } else {
      ctx.logger.info('archive: total records < 3, skip LLM, use fallback', {
        memories: memories.length,
        decisions: decisions.length,
        todos: todos.length,
      });
    }

    // 渲染：structured object → 100-200 字自然语言（JS 模板，不过二次 LLM）
    const summaryText = renderArchiveSummary(summary, computed);

    const now = Date.now();
    const recordId = `archive_${chatId}_${now}`;
    // BITABLE_ARCHIVE_URL 是个总入口（多维表格 dashboard 链接），缺省时卡片
    // 自动降级为纯文本说明，不渲染坏按钮（issue #104 验收标准）
    const bitableUrl = process.env['BITABLE_ARCHIVE_URL']?.trim() ?? '';

    const card = ctx.cardBuilder.build('archive', {
      recordId,
      title: '项目已交付',
      bitableUrl,
      tags: [],
      summary: summaryText,
      links,
      decisionCount: computed.decisionCount,
      ...(computed.taskCompletion ? { taskStats: `${computed.taskCompletion} 已完成` } : {}),
    });

    // 写归档 memory（audit + 后续 QA / recall 可检索）— 失败不阻断
    const auditContent = [
      `[archive] ${summaryText}`,
      ...links.map((l) => `${l.label}: ${l.url}`),
    ].join('\n');
    const memInsert = await ctx.bitable.insert({
      table: 'memory',
      row: {
        key: recordId,
        kind: 'project',
        chat_id: chatId,
        content: auditContent,
        importance: 8, // 交付归档：高优先级
        last_access: now,
        created_at: now,
        source_skill: 'archive',
      },
    });
    if (!memInsert.ok)
      ctx.logger.warn('archive: insert audit memory failed', { error: memInsert.error.message });

    return ok({
      card,
      reasoning: `归档 ${decisions.length} 条决策，${todos.length} 条任务（${doneCount} 完成），收集 ${links.length} 条产出物链接`,
    });
  },
};
