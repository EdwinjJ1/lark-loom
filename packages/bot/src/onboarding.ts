/**
 * Onboarding 流程（issue #98 + #120）
 *
 * 三个能力：
 *   1. handleBotJoinedChat：bot 加群事件 → 发 activation 卡（数据使用告知 + 启用按钮）
 *   2. handleOnboardingAction：cardAction 'activate' → patch + audit + **创建项目核心文档**（issue #120）
 *   3. handleOnboardingAction：cardAction 'dismiss' → patch 成"已忽略"态 + 写 audit
 *
 * 范围限定（issue #98 轻方案）：
 *   - 不做强制开关，点 dismiss 后 bot 不退群、其它 skill 该跑还跑
 *   - 不做去重，每次入群都发卡
 *   - 谁点都算群代表，不限定 inviter
 */

import type { CardAction, DocBlock, SkillContext } from '@seedhac/contracts';

/** bot 入群事件接收到时调用：在群里发出 activation 卡片。 */
export async function handleBotJoinedChat(
  ctx: SkillContext,
  payload: { chatId: string; inviterUserId: string },
): Promise<void> {
  const { runtime, cardBuilder, logger } = ctx;
  const card = cardBuilder.build('activation', {
    chatName: '本群',
  });
  const res = await runtime.sendCard({ chatId: payload.chatId, card });
  if (!res.ok) {
    logger.warn('onboarding: send activation card failed', {
      chatId: payload.chatId,
      code: res.error.code,
      message: res.error.message,
    });
    return;
  }
  logger.info('onboarding: activation card sent', {
    chatId: payload.chatId,
    messageId: res.value.messageId,
    inviter: payload.inviterUserId,
  });
}

/**
 * 项目核心文档的 5 段固定结构（issue #120）。
 *
 * 设计依据（业界 5 个主流 living doc 模式融合）：
 *   - Atlassian Project Poster：顶部摘要 + 历史 + 约束
 *   - ADR (Michael Nygard)：决策日志（append-only + Superseded 链）
 *   - Keep a Changelog：里程碑 reverse chronological
 *   - Confluence：阻塞与风险段
 *
 * Section 顺序很关键 —— skill 后续 appendToSection 时按 H2 标题精确匹配，
 * 顺序保证完整时间线永远在最后（reverse chronological 拼接最容易）。
 */
export const CORE_DOC_SECTIONS = [
  '项目摘要',
  '决策日志',
  '项目里程碑',
  '阻塞与风险',
  '完整时间线',
] as const;

export type CoreDocSection = (typeof CORE_DOC_SECTIONS)[number];

/** 初始化的核心文档 markdown blocks —— 每个 section 一个空 placeholder paragraph。 */
function buildCoreDocInitialBlocks(chatName: string, createdAtIso: string): DocBlock[] {
  return [
    { type: 'heading1', text: '项目核心文档' },
    { type: 'paragraph', text: `${chatName} · 由 Lark Loom 自动维护 · 创建于 ${createdAtIso}` },
    { type: 'heading2', text: '项目摘要' },
    { type: 'paragraph', text: `项目：${chatName} · 状态：进行中 · 最后更新：${createdAtIso}` },
    { type: 'heading2', text: '决策日志' },
    { type: 'paragraph', text: '（暂无关键决策。当群里出现"决定 / 选用"时会自动记录。）' },
    { type: 'heading2', text: '项目里程碑' },
    { type: 'paragraph', text: '（PRD / 演示 PPT / 分工表生成后会自动追加。）' },
    { type: 'heading2', text: '阻塞与风险' },
    { type: 'paragraph', text: '（任务被标 blocked 或群里讨论风险时会自动记录。）' },
    { type: 'heading2', text: '完整时间线' },
    { type: 'paragraph', text: '（所有事件按发生时间正序排列。）' },
  ];
}

/**
 * 创建项目核心文档（issue #120 P1）—— activate 路径异步调用。
 *
 * 失败仅 warn 不阻塞 onboarding 流程：核心文档是 nice-to-have，
 * 没它 archive 仍然能从 memory/decision/todo 工作。
 */
async function bootstrapProjectDoc(
  ctx: SkillContext,
  chatId: string,
  chatName: string,
): Promise<void> {
  const { docx, runtime, bitable, logger } = ctx;
  const now = Date.now();
  const createdAtIso = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(now));

  const docTitle = `项目核心文档 - ${chatName}`;
  const created = await docx.create(docTitle);
  if (!created.ok) {
    logger.warn('onboarding: create core doc failed', { error: created.error.message });
    return;
  }

  const initBlocks = buildCoreDocInitialBlocks(chatName, createdAtIso);
  const append = await docx.appendBlocks(created.value.docToken, initBlocks);
  if (!append.ok) {
    logger.warn('onboarding: append initial blocks failed', { error: append.error.message });
    // 即便初始化失败，doc 已创建，URL 还是有用 —— 继续写 memory 指针
  }

  // 给群成员授 edit 权限（同 slides / requirementDoc 模式）
  const members = await runtime.fetchMembers({ chatId });
  if (members.ok && members.value.members.length > 0) {
    const ids = members.value.members.map((m) => m.userId);
    const grant = await docx.grantMembersEdit(created.value.docToken, 'docx', ids);
    if (!grant.ok) {
      logger.warn('onboarding: grant core doc edit failed', { error: grant.error.message });
    }
  }

  // 写 memory 指针：[核心文档] 前缀让 archive / 后续 skill 能找到
  const memInsert = await bitable.insert({
    table: 'memory',
    row: {
      key: `core-doc-${chatId}-${now}`,
      kind: 'project',
      chat_id: chatId,
      content: `[核心文档] ${docTitle}\n${created.value.url}`,
      importance: 9, // 比 archive (8) 还高 —— 核心文档是项目执行的 single source of truth
      last_access: now,
      created_at: now,
      source_skill: 'onboarding',
    },
  });
  if (!memInsert.ok) {
    logger.warn('onboarding: insert core doc memory failed', { error: memInsert.error.message });
  }

  logger.info('onboarding: core doc bootstrapped', {
    chatId,
    docToken: created.value.docToken,
    url: created.value.url,
  });
}

/**
 * activation 卡片按钮被点击时调用。
 * action: 'activate' | 'dismiss'
 *
 * 行为：
 *   - patch 卡片成对应终态（已启用 / 已忽略）
 *   - 写一条 memory 记录作为 audit trail
 *   - activate 时额外创建项目核心文档（issue #120）
 */
export async function handleOnboardingAction(
  ctx: SkillContext,
  action: 'activate' | 'dismiss',
): Promise<void> {
  const { event, runtime, cardBuilder, bitable, logger } = ctx;
  if (event.type !== 'cardAction') return;

  const payload: CardAction = event.payload;
  // 飞书 cardAction 经常不传 user.name；不能 fallback 到 userId（会泄漏 open_id）
  // 用通用占位 —— audit memory 里仍有完整 userId
  const userName = payload.user.name ?? (action === 'activate' ? '管理员' : '群成员');
  const now = Date.now();

  const chatName = String(payload.value['chatName'] ?? '本群');

  const card = cardBuilder.build(
    'activation',
    action === 'activate'
      ? { chatName, confirmedBy: userName, confirmedAt: now }
      : { chatName, dismissedBy: userName, dismissedAt: now },
  );

  const patchRes = await runtime.patchCard({ messageId: payload.messageId, card });
  if (!patchRes.ok) {
    logger.warn('onboarding: patch activation card failed', {
      messageId: payload.messageId,
      code: patchRes.error.code,
      message: patchRes.error.message,
    });
    // 即便 patch 失败也继续写 audit —— audit 比 UI 重要
  }

  // audit 写 memory 表，用 MemoryRecord schema 字段对齐
  // （PR #96 修复后所有 skill 都用这套字段）
  const insertRes = await bitable.insert({
    table: 'memory',
    row: {
      key: `onboarding-${payload.chatId}-${now}`,
      kind: 'project',
      chat_id: payload.chatId,
      content: `[onboarding] ${action} by ${userName} (${payload.user.userId})`,
      importance: 7, // 合规 audit：高优先级，不被 LRU 淘汰
      last_access: now,
      created_at: now,
      source_skill: 'onboarding',
    },
  });
  if (!insertRes.ok) {
    logger.warn('onboarding: audit memory insert failed', {
      chatId: payload.chatId,
      code: insertRes.error.code,
      message: insertRes.error.message,
    });
  }

  // activate 路径：创建项目核心文档（issue #120 P1）
  // fire-and-forget —— 即便 docx 调用慢或失败都不阻塞 onboarding 用户体验
  if (action === 'activate') {
    void bootstrapProjectDoc(ctx, payload.chatId, chatName).catch((e: unknown) => {
      logger.warn('onboarding: bootstrapProjectDoc threw', {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  logger.info(`onboarding: ${action} confirmed`, {
    chatId: payload.chatId,
    user: payload.user.userId,
    userName,
  });
}
