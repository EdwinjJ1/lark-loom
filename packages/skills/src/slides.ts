/**
 * 🅳 slides — 幻灯片生成
 *
 * 触发：被动监听，群里出现 PPT/演示/汇报相关讨论后自动生成
 * 数据流：群聊上下文 + Bitable 快照 → LLM 生成大纲 → 飞书演示文稿 → slides 卡片
 */

import type { ChatMember, Message, Skill } from '@seedhac/contracts';
import type { SlideDraft } from '@seedhac/contracts';
import { ErrorCode, err, makeError, ok } from '@seedhac/contracts';
import { appendRecentActivity, rewriteDeliverables } from './core-doc.js';
import { extractLinksFromMemory } from './archive.js';
import { OutlineSchema, SLIDES_PROMPT } from './prompts/slides.js';

/** chatId 正在生成中的锁，防止同一群短时间内重复触发 */
const generating = new Set<string>();

const SLIDES_NEGATION_PATTERNS: readonly RegExp[] = [
  /(?:先别|别|不要|不用|无需|不需要|暂时不).{0,12}(?:ppt|幻灯片|演示文稿|演示|汇报)/i,
];

const SLIDES_REQUEST_PATTERNS: readonly RegExp[] = [
  /向上级汇报|给老板汇报|做.{0,10}汇报|准备.{0,10}汇报|整理.{0,10}汇报/,
  /给老板做.{0,4}演示|做.{0,4}演示/,
  /(?:帮|请|需要|要|得|麻烦|可以|能不能|生成|创建|做|准备|整理|产出|写|弄|交).{0,12}(?:ppt|幻灯片|演示文稿)/i,
  /(?:ppt|幻灯片|演示文稿).{0,12}(?:生成|创建|做|准备|整理|产出|写|弄|交|汇报|给老板|给.*看)/i,
];

const ASSIGNMENT_FALLBACK = {
  assignments: [
    {
      memberName: '待定成员',
      pages: [] as Array<{ pageIndex: number; heading: string; talkingPoints: string[] }>,
    },
  ],
};

interface AssignmentPage {
  readonly pageIndex: number;
  readonly heading: string;
  readonly talkingPoints: readonly string[];
}

interface AssignmentItem {
  readonly memberName: string;
  readonly pages: readonly AssignmentPage[];
}

interface Assignment {
  readonly assignments: readonly AssignmentItem[];
}

export const slidesSkill: Skill = {
  name: 'slides',
  metadata: {
    description: '基于群聊上下文和项目记忆生成飞书演示文稿。',
    when_to_use: '用户提到 PPT、幻灯片、演示、汇报，或明确要求生成展示材料时使用。',
    examples: ['帮我做个 PPT', '下周要向老师汇报', '@bot 根据项目进度生成演示稿'],
  },
  trigger: {
    events: ['message'],
    requireMention: false,
    keywords: ['ppt', 'PPT', '幻灯片', '演示文稿', '汇报', '演示'],
    description: '检测到 PPT/演示需求时自动生成演示文稿',
  },
  match: (ctx) => {
    if (ctx.event.type !== 'message') return false;
    const text = (ctx.event.payload as Message).text;
    if (SLIDES_NEGATION_PATTERNS.some((pattern) => pattern.test(text))) return false;
    return SLIDES_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
  },
  run: async (ctx) => {
    const msg = ctx.event.payload as Message;
    const chatId = msg.chatId;

    if (!ctx.slides) {
      return err(makeError(ErrorCode.CONFIG_MISSING, 'slides client is not configured'));
    }

    if (generating.has(chatId)) {
      ctx.logger.info('slides: generation already in progress, skipping', { chatId });
      return ok({ text: '' });
    }
    generating.add(chatId);
    try {
      return await runSlides(ctx, msg);
    } catch (e) {
      // 守住 Skill.run 契约：失败必须返回 err，不允许向上抛
      const message = e instanceof Error ? e.message : String(e);
      ctx.logger.error('slides: runSlides threw unexpectedly', { chatId, message });
      return err(makeError(ErrorCode.UNKNOWN, `slides crashed: ${message}`, e));
    } finally {
      generating.delete(chatId);
    }
  },
};

async function runSlides(ctx: Parameters<Skill['run']>[0], msg: Message): ReturnType<Skill['run']> {
  const chatId = msg.chatId;
  // slides client is guaranteed by the caller (checked before generating.add)
  const slidesClient = ctx.slides!;

  const loadingCard = ctx.cardBuilder.build('slides', {
    title: '文件生成中…',
    presentationUrl: '',
    pageCount: 0,
    isLoading: true,
  });
  const sentResult = await ctx.runtime.sendCard({ chatId, card: loadingCard });
  if (!sentResult.ok) return err(sentResult.error);
  const loadingMessageId = sentResult.value.messageId;

  // ── Parallel batch 1: fetchHistory + fetchMembers + fetchBitable ─────────────
  ctx.logger.info('slides: fetching history, members, and bitable snapshots in parallel', {
    chatId,
  });

  const [historyResult, membersResult, snapshotResult] = await Promise.all([
    ctx.runtime.fetchHistory({ chatId, pageSize: 20 }),
    ctx.runtime.fetchMembers({ chatId }),
    ctx.bitable.find({ table: 'memory', where: { chatId }, pageSize: 2 }),
  ]);

  // a. process fetchHistory
  if (!historyResult.ok) {
    await patchErrorCard(ctx, loadingMessageId, '幻灯片生成', historyResult.error.message);
    return err(historyResult.error);
  }
  const history = historyResult.value.messages;

  // d. process fetchMembers
  const members = membersResult.ok ? membersResult.value.members : [];
  if (!membersResult.ok) {
    ctx.logger.warn('slides: members skipped', {
      code: membersResult.error.code,
      message: membersResult.error.message,
    });
  }

  // b. process fetchBitable
  const snapshots = snapshotResult.ok ? snapshotResult.value.records : [];
  if (!snapshotResult.ok) {
    ctx.logger.warn('slides: bitable snapshots skipped', {
      code: snapshotResult.error.code,
      message: snapshotResult.error.message,
    });
  }

  // c. LLM 生成大纲
  ctx.logger.info('slides: asking LLM for outline', {
    historyCount: history.length,
    snapshotCount: snapshots.length,
  });
  const outlineResult = await ctx.llm.askStructured(
    SLIDES_PROMPT(history, snapshots, members),
    OutlineSchema,
    { model: 'pro', timeoutMs: 90_000, maxTokens: 2600, temperature: 0.2 },
  );
  if (!outlineResult.ok) {
    await patchErrorCard(ctx, loadingMessageId, '幻灯片生成', outlineResult.error.message);
    return err(outlineResult.error);
  }
  const outline = outlineResult.value;

  // e. 汇报分工从 outline.presenterName 生成；LLM 在一次大纲调用里已根据聊天贡献分配负责人。
  ctx.logger.info('slides: building assignment locally', { memberCount: members.length });
  const assignment = buildAssignment(outline.slides, members);

  // ── Parallel batch 2: createFromOutline + createFromMarkdown ─────────────────
  ctx.logger.info('slides: creating native presentation and assignment doc in parallel', {
    title: outline.title,
    pageCount: outline.slides.length,
  });

  const assignmentTitle = `${outline.title} — 汇报分工`;
  const assignmentMd = renderAssignmentMarkdown(assignmentTitle, assignment);

  const [slidesResult, assignmentDocResult] = await Promise.all([
    slidesClient.createFromOutline(outline.title, outline),
    ctx.docx.createFromMarkdown(assignmentTitle, assignmentMd),
  ]);

  // f. handle slides creation result
  if (!slidesResult.ok) {
    await patchErrorCard(ctx, loadingMessageId, outline.title, slidesResult.error.message);
    return err(slidesResult.error);
  }

  // g. handle assignment doc creation result
  if (!assignmentDocResult.ok) {
    await patchErrorCard(ctx, loadingMessageId, assignmentTitle, assignmentDocResult.error.message);
    return err(assignmentDocResult.error);
  }

  // g2. 授予团队成员访问权限。
  // - slides：lark-cli `--as bot` 创建 → bot 是 owner → bot 自己逐成员 openid 授权。
  // - 分工文档：bot 用 SDK 创建并 own，可直接 grantMembersEdit。
  const memberIds = members.map((m) => m.userId);
  const [slidesMembersEditResult, docEditResult] = await Promise.all([
    memberIds.length > 0
      ? slidesClient.grantMembersEdit(slidesResult.value.slidesToken, memberIds)
      : ok(undefined),
    memberIds.length > 0
      ? ctx.docx.grantMembersEdit(assignmentDocResult.value.docToken, 'docx', memberIds)
      : ok(undefined),
  ]);
  if (memberIds.length > 0) {
    if (!slidesMembersEditResult.ok) {
      ctx.logger.warn('slides: grant slides members edit failed', {
        code: slidesMembersEditResult.error.code,
        message: slidesMembersEditResult.error.message,
      });
    } else {
      ctx.logger.info('slides: granted slides members edit', { memberCount: memberIds.length });
    }
    if (!docEditResult.ok) {
      ctx.logger.warn('slides: grant assignment doc edit failed', {
        code: docEditResult.error.code,
        message: docEditResult.error.message,
      });
    }
  } else {
    ctx.logger.warn('slides: no chat members fetched, skip granting slides permissions', { chatId });
  }

  // h. patch loading 卡片为最终演示文稿卡片
  ctx.logger.info('slides: presentation created', { url: slidesResult.value.url });
  const finalSlidesCard = ctx.cardBuilder.build('slides', {
    title: outline.title,
    presentationUrl: slidesResult.value.url,
    pageCount: outline.slides.length,
    preview: outline.slides.slice(0, 2).map((s) => ({
      title: getSlideTitle(s),
      bullets: getSlideTalkingPoints(s),
    })),
  });
  const patchResult = await ctx.runtime.patchCard({
    messageId: loadingMessageId,
    card: finalSlidesCard,
  });
  if (!patchResult.ok) {
    ctx.logger.warn('slides: patch loading card failed', {
      code: patchResult.error.code,
      message: patchResult.error.message,
    });
  }

  // i. 返回汇报分工文稿卡片，由 wiring 发第二条卡片
  const assignmentCard = ctx.cardBuilder.build('docPush', {
    docTitle: assignmentTitle,
    docUrl: assignmentDocResult.value.url,
    docType: 'report',
    summary: `共 ${assignment.assignments.length} 位成员，${outline.slides.length} 页幻灯片`,
  });

  // 写两条 memory，让 archive skill 在最终交付卡能列出这次产出（issue #104）
  // [slides] 前缀 → 演示 PPT；[汇报分工] 前缀 → 汇报分工文稿
  // fire-and-forget：失败仅 warn，不阻断卡片回复
  const now = Date.now();
  // [slides_outline] 是 v2 rehearsal preview 用的 — 持久化 outline JSON 让 AI 听众能读到每页内容
  // 只挑下游 preview 真正用得到的字段，避免 content 越过 LONG (2KB) 上限
  const outlineForPreview = JSON.stringify({
    title: outline.title,
    slides: outline.slides.slice(0, 30).map((s) => ({
      title: s.title,
      bullets: (s.bullets ?? []).slice(0, 6),
      ...(s.subtitle ? { subtitle: s.subtitle } : {}),
    })),
  });
  void Promise.all([
    ctx.bitable.insert({
      table: 'memory',
      row: {
        key: `slides-${chatId}-${now}`,
        kind: 'project',
        chat_id: chatId,
        content: `[slides] ${outline.title}\n${slidesResult.value.url}`,
        importance: 6,
        last_access: now,
        created_at: now,
        source_skill: 'slides',
      },
    }),
    ctx.bitable.insert({
      table: 'memory',
      row: {
        key: `slides-assignment-${chatId}-${now}`,
        kind: 'project',
        chat_id: chatId,
        content: `[汇报分工] ${assignmentTitle}\n${assignmentDocResult.value.url}`,
        importance: 5,
        last_access: now,
        created_at: now,
        source_skill: 'slides',
      },
    }),
    ctx.bitable.insert({
      table: 'memory',
      row: {
        key: `slides-outline-${chatId}-${now}`,
        kind: 'project',
        chat_id: chatId,
        content: `[slides_outline] ${outlineForPreview}`,
        importance: 4,
        last_access: now,
        created_at: now,
        source_skill: 'slides',
      },
    }),
  ])
    .then(([s1, s2, s3]) => {
      if (!s1.ok)
        ctx.logger.warn('slides: insert slides memory failed', { error: s1.error.message });
      if (!s2.ok)
        ctx.logger.warn('slides: insert assignment memory failed', { error: s2.error.message });
      if (!s3.ok)
        ctx.logger.warn('slides: insert outline memory failed', { error: s3.error.message });
    })
    .catch((e: unknown) => {
      ctx.logger.warn('slides: memory insert threw', {
        error: e instanceof Error ? e.message : String(e),
      });
    });

  // 同步到项目核心文档（issue #120 v2）
  //   - 已交付产出 ← 重新拉所有 [前缀] memory 渲染列表（含本次新加 2 条）
  //   - 最近动态 ← append 2 条
  // fire-and-forget，失败仅 warn
  void (async () => {
    const memRes = await ctx.bitable.find({
      table: 'memory',
      filter: `AND(CurrentValue.[chat_id]="${chatId}")`,
      pageSize: 100,
    });
    const links = memRes.ok ? extractLinksFromMemory(memRes.value.records) : [];
    await Promise.all([
      rewriteDeliverables(ctx, chatId, links),
      appendRecentActivity(ctx, chatId, '完成', `演示 PPT 已生成（${outline.title}）`),
      appendRecentActivity(ctx, chatId, '完成', '汇报分工文稿已生成'),
    ]);
  })().catch((e: unknown) => {
    ctx.logger.warn('slides: core-doc updates threw', {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  return ok({
    card: assignmentCard,
    reasoning: `检测到 PPT 需求，基于 ${history.length} 条群聊记录生成 ${outline.slides.length} 页大纲与汇报分工`,
  });
}

function getSlideTitle(slide: SlideDraft): string {
  return slide.title;
}

function getSlideTalkingPoints(slide: SlideDraft): readonly string[] {
  if (slide.bullets?.length) return slide.bullets;
  if (slide.cards?.length) {
    return slide.cards
      .slice(0, 4)
      .map((card) => [card.value, card.title, card.detail].filter(Boolean).join(' · '));
  }
  if (slide.milestones?.length) {
    return slide.milestones
      .slice(0, 4)
      .map((m) => [m.date, m.label, m.status].filter(Boolean).join(' · '));
  }
  if (slide.risks?.length) {
    return slide.risks.slice(0, 4).map((r) => `${r.risk}：${r.mitigation}`);
  }
  if (slide.tasks?.length) {
    return slide.tasks
      .slice(0, 4)
      .map((t) => `${t.owner}：${t.task}${t.due ? `（${t.due}）` : ''}`);
  }
  return slide.subtitle ? [slide.subtitle] : [];
}

function renderAssignmentMarkdown(title: string, assignment: Assignment): string {
  const effectiveAssignments =
    assignment.assignments.length > 0 ? assignment.assignments : ASSIGNMENT_FALLBACK.assignments;
  return `# ${title}\n\n${effectiveAssignments
    .map(
      (a) =>
        `## ${a.memberName}\n${a.pages
          .map(
            (p) =>
              `### 第 ${p.pageIndex + 1} 页：${p.heading}\n${p.talkingPoints
                .map((point) => `- ${point}`)
                .join('\n')}`,
          )
          .join('\n\n')}`,
    )
    .join('\n\n')}`;
}

function buildAssignment(
  slides: readonly SlideDraft[],
  members: readonly ChatMember[],
): Assignment {
  const assignees = members.length > 0 ? members : [{ userId: 'pending', name: '待定成员' }];
  const assignments = assignees.map((member) => ({
    memberName: member.name,
    pages: [] as AssignmentPage[],
  }));
  const reportSlides = slides
    .map((slide, pageIndex) => ({ slide, pageIndex }))
    .filter(({ slide }) => slide.type !== 'cover' && slide.type !== 'closing');
  const effectiveSlides =
    reportSlides.length > 0
      ? reportSlides
      : slides.map((slide, pageIndex) => ({ slide, pageIndex }));

  effectiveSlides.forEach(({ slide, pageIndex }, index) => {
    const target =
      findAssignmentByPresenter(assignments, slide.presenterName) ??
      assignments[index % assignments.length]!;
    target.pages.push({
      pageIndex,
      heading: getSlideTitle(slide),
      talkingPoints: getSlideTalkingPoints(slide).slice(0, 3),
    });
  });

  return { assignments };
}

function findAssignmentByPresenter(
  assignments: readonly { memberName: string; pages: AssignmentPage[] }[],
  presenterName: string | undefined,
): { memberName: string; pages: AssignmentPage[] } | undefined {
  if (!presenterName) return undefined;
  const normalizedPresenter = normalizeName(presenterName);
  return assignments.find(
    (assignment) => normalizeName(assignment.memberName) === normalizedPresenter,
  );
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

async function patchErrorCard(
  ctx: Parameters<Skill['run']>[0],
  messageId: string,
  title: string,
  message: string,
): Promise<void> {
  const errorCard = ctx.cardBuilder.build('slides', {
    title,
    presentationUrl: '',
    pageCount: 0,
    errorMessage: `文件生成失败：${message}`,
  });
  const patchResult = await ctx.runtime.patchCard({ messageId, card: errorCard });
  if (!patchResult.ok) {
    ctx.logger.warn('slides: patch error card failed', {
      code: patchResult.error.code,
      message: patchResult.error.message,
    });
  }
}
