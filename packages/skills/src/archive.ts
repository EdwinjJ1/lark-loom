/**
 * archive — 项目交付归档（issue #104 / #114）
 *
 * 触发：群里出现 复盘 / 归档 / 项目结束 / 收尾 / 准备交付（被动监听，无需 @bot）
 *
 * 数据流（issue #114 升级为 loading→doc→final 三阶段）：
 *   1. sendCard loading 占位（让用户知道 bot 在工作）
 *   2. 并行拉 memory / decision / todo 三张表
 *   3. extractLinksFromMemory 收集产出物链接
 *   4. askStructured + ArchiveSummarySchema → 5 字段摘要
 *   5. verifyArchiveSummary（decompose-then-verify）过滤幻觉
 *   6. renderArchiveDocMarkdown → 创建飞书归档 doc + 给群成员授权
 *   7. patchCard 成 final 态：摘要 + 链接 + "查看完整报告"按钮
 *   8. 任一中间失败 → patchCard 成 error 态，不阻塞
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
  renderArchiveDocMarkdown,
  renderArchiveSummary,
  verifyArchiveSummary,
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

const KIND_ORDER: Record<NonNullable<ArchiveLink['kind']>, number> = {
  requirementDoc: 0,
  slides: 1,
  taskAssignment: 2,
  bitable: 3,
  other: 9,
};

/**
 * 把 URL 规范化用作去重 key：去掉 query / fragment / 末尾斜杠，转小写。
 * 飞书同一文档的多种链接形式（带 from 参数 / 不带）都能匹配。
 */
function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

/**
 * 没前缀的 memory 条目走这里：根据 URL 路径推断 kind / label。
 * 这样"群聊里贴的 PPT 链接"也能被正确归类，不再统称"相关文档"。
 */
function inferFromUrl(url: string): { kind: NonNullable<ArchiveLink['kind']>; label: string } {
  if (/\/slides\//i.test(url)) return { kind: 'slides', label: '演示 PPT' };
  if (/\/(sheets|base)\//i.test(url)) return { kind: 'bitable', label: '飞书表格' };
  if (/\/(docx|doc|wiki|file)\//i.test(url)) return { kind: 'other', label: '飞书文档' };
  return { kind: 'other', label: '相关链接' };
}

interface CandidateLink extends ExtractedLink {
  /** 是否来自 [前缀] 显式标注（vs 从 URL 路径推断） */
  readonly fromPrefix: boolean;
}

/**
 * 从 memory records 提取产出物链接。
 *
 * 防重复策略（实测发现 3 个链接全是同一个 PPT URL 的 bug）：
 *   1. 按规范化 URL 去重 —— 同 URL 只保留一条；同 URL 多个候选取 kind 高优先 +
 *      显式标注优先 + recordedAt 最新
 *   2. 显式标注（prefix 匹配的 named entry）：每个 (kind, label) 保留最新一条
 *      — 避免出现"两次生成的 PRD 同时列出"
 *   3. URL 推断（没前缀）：直接按 URL 路径推断 label，最多保留 2 条 — 避免群
 *      聊里乱贴的链接刷屏卡片
 *
 * 总数上限 6 避免卡片爆掉。
 */
export function extractLinksFromMemory(memories: readonly BitableRow[]): readonly ArchiveLink[] {
  const byUrl = new Map<string, CandidateLink>();

  for (const m of memories) {
    const content = String(m['content'] ?? '');
    if (!content) continue;
    const recordedAt = Number(m['created_at'] ?? m['timestamp'] ?? 0);

    const urls = content.match(FEISHU_URL_RE);
    if (!urls || urls.length === 0) continue;
    const rawUrl = urls[0]!;
    const canonUrl = canonicalizeUrl(rawUrl);

    const matched = PREFIX_TABLE.find((p) => p.re.test(content));
    const candidate: CandidateLink = matched
      ? { kind: matched.kind, label: matched.label, url: rawUrl, recordedAt, fromPrefix: true }
      : { ...inferFromUrl(rawUrl), url: rawUrl, recordedAt, fromPrefix: false };

    const existing = byUrl.get(canonUrl);
    if (!existing) {
      byUrl.set(canonUrl, candidate);
      continue;
    }

    // 同 URL 已存在 → 选更优的：显式标注 > kind 等级高 > recordedAt 新
    const candBetter =
      (candidate.fromPrefix && !existing.fromPrefix) ||
      (candidate.fromPrefix === existing.fromPrefix &&
        KIND_ORDER[candidate.kind ?? 'other'] < KIND_ORDER[existing.kind ?? 'other']) ||
      (candidate.fromPrefix === existing.fromPrefix &&
        candidate.kind === existing.kind &&
        candidate.recordedAt > existing.recordedAt);
    if (candBetter) byUrl.set(canonUrl, candidate);
  }

  const candidates = [...byUrl.values()];

  // 显式标注：每个 (kind, label) 保留 recordedAt 最新 —— 避免重复列出同类
  const named = new Map<string, CandidateLink>();
  for (const c of candidates.filter((c) => c.fromPrefix)) {
    const k = `${c.kind}|${c.label}`;
    const ex = named.get(k);
    if (!ex || ex.recordedAt < c.recordedAt) named.set(k, c);
  }
  const namedList = [...named.values()];

  // 推断的"其它"：最多 2 条，按 recordedAt 倒序
  const inferredList = candidates
    .filter((c) => !c.fromPrefix)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, 2);

  // 排序：先 named 按 kind 优先级，再 inferred 按 recordedAt
  const ordered: ArchiveLink[] = [
    ...namedList.sort((a, b) => {
      const ka = KIND_ORDER[a.kind ?? 'other'];
      const kb = KIND_ORDER[b.kind ?? 'other'];
      if (ka !== kb) return ka - kb;
      return b.recordedAt - a.recordedAt;
    }),
    ...inferredList,
  ].map((l) => ({ kind: l.kind ?? ('other' as const), label: l.label, url: l.url }));

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

    // 0. loading 占位卡（issue #114）—— bot 收到指令立刻给反馈
    const loadingCard = ctx.cardBuilder.build('archive', {
      recordId: '',
      title: '归档进行中',
      bitableUrl: '',
      tags: [],
      isLoading: true,
      etaSeconds: 30,
    });
    const loadingSent = await ctx.runtime.sendCard({ chatId, card: loadingCard });
    if (!loadingSent.ok) return err(loadingSent.error);
    const loadingMessageId = loadingSent.value.messageId;

    // 设计：archive 全程降级路径，没有真正的"硬失败"需要 patch error 卡：
    //   - bitable.find 失败 → 用空数据继续
    //   - LLM 失败 → fallback summary
    //   - doc 创建失败 → 卡片少一个按钮，仍然 patch final
    //   - patch final 失败 → audit memory 仍然写入

    // 1. 拉三张表（任一失败用空数据继续）
    // memory schema 用 chat_id（PR #96 后），decision/todo 仍是旧 chatId
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

    // 2. LLM 摘要（< 3 条记录直接跳过，避免空数据幻觉）
    const totalRecords = memories.length + decisions.length + todos.length;
    let summary = EMPTY_SUMMARY;
    if (totalRecords >= 3) {
      const llmResult = await ctx.llm.askStructured(
        ARCHIVE_SUMMARY_PROMPT(memories, decisions, todos),
        ArchiveSummarySchema,
        { model: 'pro', timeoutMs: 60_000 },
      );
      if (llmResult.ok) {
        summary = llmResult.value;
        // 3. decompose-then-verify：把 outcomes / openIssues 跟 source 做 grounding 校验
        const verifyRes = verifyArchiveSummary(summary, memories, decisions, todos, ctx.logger);
        summary = verifyRes.verified;
        if (verifyRes.droppedCount > 0) {
          ctx.logger.info('archive: verify dropped unverifiable claims', {
            droppedCount: verifyRes.droppedCount,
          });
        }
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

    const summaryText = renderArchiveSummary(summary, computed);

    // 4. 创建飞书归档 doc（issue #114）
    const now = Date.now();
    const recordId = `archive_${chatId}_${now}`;
    const docTitle = `项目交付报告 - ${new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now))}`;
    const docMarkdown = renderArchiveDocMarkdown({
      chatName: '本群',
      summary,
      summaryText,
      links,
      decisions,
      todos,
      generatedAt: now,
    });

    let reportDocUrl: string | undefined;
    let reportDocToken: string | undefined;
    const docResult = await ctx.docx.createFromMarkdown(docTitle, docMarkdown);
    if (!docResult.ok) {
      ctx.logger.warn('archive: create feishu doc failed, fall back to card without doc', {
        error: docResult.error.message,
      });
    } else {
      reportDocUrl = docResult.value.url;
      reportDocToken = docResult.value.docToken;

      // 给群成员授 edit 权限（复用 slides / requirementDoc 的模式）
      const membersRes = await ctx.runtime.fetchMembers({ chatId });
      if (membersRes.ok && membersRes.value.members.length > 0) {
        const memberIds = membersRes.value.members.map((m) => m.userId);
        const grantRes = await ctx.docx.grantMembersEdit(reportDocToken, 'docx', memberIds);
        if (!grantRes.ok) {
          ctx.logger.warn('archive: grant members edit failed', {
            code: grantRes.error.code,
            message: grantRes.error.message,
          });
        } else {
          ctx.logger.info('archive: granted members edit', { memberCount: memberIds.length });
        }
      }
    }

    // 5. patchCard 成 final 态
    const bitableUrl = process.env['BITABLE_ARCHIVE_URL']?.trim() ?? '';
    const finalCard = ctx.cardBuilder.build('archive', {
      recordId,
      title: '项目已交付',
      bitableUrl,
      tags: [],
      summary: summaryText,
      links,
      decisionCount: computed.decisionCount,
      ...(computed.taskCompletion ? { taskStats: `${computed.taskCompletion} 已完成` } : {}),
      ...(reportDocUrl ? { reportDocUrl } : {}),
    });
    const patchRes = await ctx.runtime.patchCard({
      messageId: loadingMessageId,
      card: finalCard,
    });
    if (!patchRes.ok) {
      ctx.logger.warn('archive: patch final card failed', {
        code: patchRes.error.code,
        message: patchRes.error.message,
      });
      // patch 失败不阻塞 audit memory 写入；用户至少能在 memory 里看到归档
    }

    // 6. 写归档 memory（含 doc URL）— 失败不阻断
    const auditContent = [
      `[archive] ${summaryText}`,
      ...(reportDocUrl ? [`完整报告: ${reportDocUrl}`] : []),
      ...links.map((l) => `${l.label}: ${l.url}`),
    ].join('\n');
    const memInsert = await ctx.bitable.insert({
      table: 'memory',
      row: {
        key: recordId,
        kind: 'project',
        chat_id: chatId,
        content: auditContent,
        importance: 8,
        last_access: now,
        created_at: now,
        source_skill: 'archive',
      },
    });
    if (!memInsert.ok)
      ctx.logger.warn('archive: insert audit memory failed', { error: memInsert.error.message });

    // 不返回 card —— 上面已经 patchCard 完成。返回空 SkillResult 防止 wiring 重发
    return ok({
      reasoning: `归档 ${decisions.length} 条决策，${todos.length} 条任务（${doneCount} 完成），收集 ${links.length} 条产出物链接${reportDocUrl ? '，已生成报告 doc' : ''}`,
    });
  },
};
