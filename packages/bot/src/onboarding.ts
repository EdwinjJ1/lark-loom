/**
 * Onboarding 流程（issue #98）
 *
 * 三个能力：
 *   1. handleBotJoinedChat：bot 加群事件 → 发 activation 卡（数据使用告知 + 启用按钮）
 *   2. handleOnboardingAction：cardAction 'activate' → patch 成"已启用"态 + 写 audit
 *   3. handleOnboardingAction：cardAction 'dismiss' → patch 成"已忽略"态 + 写 audit
 *
 * 范围限定（issue #98 轻方案）：
 *   - 不做强制开关，点 dismiss 后 bot 不退群、其它 skill 该跑还跑
 *   - 不做去重，每次入群都发卡
 *   - 谁点都算群代表，不限定 inviter
 */

import type { CardAction, SkillContext } from '@seedhac/contracts';

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
 * activation 卡片按钮被点击时调用。
 * action: 'activate' | 'dismiss'
 *
 * 行为：
 *   - patch 卡片成对应终态（已启用 / 已忽略）
 *   - 写一条 memory 记录作为 audit trail
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

  logger.info(`onboarding: ${action} confirmed`, {
    chatId: payload.chatId,
    user: payload.user.userId,
    userName,
  });
}
