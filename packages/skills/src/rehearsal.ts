/**
 * rehearsal — 演练复盘（issue #102）
 *
 * 流程图（按主链路 spec，见 issue 102）：
 *
 *   ① 用户和小组用飞书会议演练
 *      ↓
 *   ② bot 拉群历史 + 妙记 → 分析问题/建议/待确认 → 发分析卡（消息卡片）
 *      ↓
 *   ③ 组员讨论
 *      ↓
 *   ④ bot 反问待确认点（消息卡片）—— 用户回复后回到 ④（重新分析），不限轮数
 *      ↓
 *   ⑤ 用户文本/按钮表达满意 → 调 slides 重生成 + 更新文档 → 完成态卡 + 链接发群
 *      ↓
 *   ⑥ 小组向上级汇报
 *
 * 入口：
 *   - message + router 路由到 rehearsal intent → 全新 round 1
 *   - cardAction 'rehearsal.satisfied' → 进 step ⑤
 *   - cardAction 'rehearsal.iterate' → 进 step ④（出反问卡）
 *   - message + 当前 chat 有活跃 rehearsal session → continueLoop（参见 wiring）
 *     - 文本含 "满意/完成/OK/没问题/就这样" → 进 step ⑤
 *     - 否则 → 视为追加反馈，重新跑分析（循环回 ④）
 *
 * 状态：单条 memory（kind: skill_log, key: rehearsal_session）记每个 chat 的当前轮次、
 * messageIds、累积 recommendedChanges。完成或重新触发时 reset。
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
  REHEARSAL_PROMPT,
  RehearsalAnalysisSchema,
  applyConfidenceFilter,
  buildClarifyQuestions,
  type RehearsalAnalysis,
  type RehearsalChange,
} from './prompts/rehearsal.js';
import {
  RELEVANCE_PROMPT,
  RelevanceJudgmentSchema,
  type RelevanceCandidate,
} from './prompts/requirement-doc.js';
import { OutlineSchema, SLIDES_PROMPT } from './prompts/slides.js';
import { clamp } from './utils/clamp.js';

const TRIGGER_RE = /演练|演示练习|彩排|汇报复盘|根据刚才反馈修改/i;
// 满意信号：避开"完成了项目 / 完成了任务"等 false positive。
//   - "满意" 不接受 "不满意 / 没满意"
//   - "完成" 必须作为独立短语：句尾 / 后接终止标点 / 后接空白结束
//     （"完成了项目目标" 这种 ❌ 不算满意；"演练复盘完成了。" ✓ 算）
//   - "可以了" 不接受 "不可以了"
//   - "OK / ok / Ok" 用 ASCII 边界
//   - "没问题 / 就这样 / 不用改了 / 这样就行" 直接匹配
const SATISFACTION_RE =
  /(?<![不没])满意|(?<!未)完成(?:[了的]?)(?:$|[\s，。！？?、!])|(?<!不)可以了|没问题|就这样|不用改了|这样就行|(?:^|[^A-Za-z])(?:OK|ok|Ok)(?:[^A-Za-z]|$)/;
const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_FOR_ANALYSIS = 50;

const SESSION_KEY = 'rehearsal_session';
export const REHEARSAL_SESSION_KEY = SESSION_KEY;

// session JSON 写到 memory.content（2KB 上限）。每条 change ~80-150 字节，留些余地，
// 累计到这个上限时丢掉最旧的 — 长 rehearsal 也不会因为状态超长而 parse 失败。
const MAX_RECOMMENDED_CHANGES = 30;

export type RehearsalPhase = 'analyzing' | 'clarifying' | 'done';

export interface RehearsalSession {
  readonly phase: RehearsalPhase;
  readonly round: number;
  /** 当前分析卡的 messageId，用于 patch 满意/完成态 */
  readonly analysisMessageId?: string;
  /** 当前反问卡的 messageId，用于 patch acknowledged 态 */
  readonly clarifyMessageId?: string;
  /** 累积的 recommendedChanges（每轮叠加） */
  readonly recommendedChanges: readonly RehearsalChange[];
  /** 上一轮 uncertainties，用于 iterate 按钮直接复用 */
  readonly lastUncertainties: readonly string[];
  /** 启动时间，用于诊断 */
  readonly startedAt: number;
  readonly updatedAt: number;
}

// ─── session 读写 ────────────────────────────────────────────────────────────

export async function loadRehearsalSession(
  ctx: SkillContext,
  chatId: string,
): Promise<RehearsalSession | null> {
  if (ctx.memoryStore) {
    const res = await ctx.memoryStore.read('skill_log', chatId, SESSION_KEY);
    if (!res.ok) {
      ctx.logger.warn('rehearsal: load session failed', {
        chatId,
        code: res.error.code,
        message: res.error.message,
      });
      return null;
    }
    if (!res.value) return null;
    return parseSession(res.value.content);
  }
  // 兜底：直接 bitable.find（测试时 memoryStore 可能未注入）
  const filter = `AND(CurrentValue.[chat_id]="${chatId}",CurrentValue.[key]="${SESSION_KEY}",CurrentValue.[kind]="skill_log")`;
  const findRes = await ctx.bitable.find({ table: 'memory', filter, pageSize: 1 });
  if (!findRes.ok || findRes.value.records.length === 0) return null;
  return parseSession(String(findRes.value.records[0]!['content'] ?? ''));
}

function parseSession(content: string): RehearsalSession | null {
  try {
    const parsed = JSON.parse(content) as Partial<RehearsalSession>;
    if (typeof parsed.phase !== 'string' || typeof parsed.round !== 'number') return null;
    return {
      phase: parsed.phase as RehearsalPhase,
      round: parsed.round,
      ...(typeof parsed.analysisMessageId === 'string'
        ? { analysisMessageId: parsed.analysisMessageId }
        : {}),
      ...(typeof parsed.clarifyMessageId === 'string'
        ? { clarifyMessageId: parsed.clarifyMessageId }
        : {}),
      recommendedChanges: Array.isArray(parsed.recommendedChanges)
        ? (parsed.recommendedChanges as RehearsalChange[])
        : [],
      lastUncertainties: Array.isArray(parsed.lastUncertainties)
        ? (parsed.lastUncertainties as string[])
        : [],
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

async function saveSession(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<void> {
  const content = clamp(JSON.stringify(session), 'LONG');
  if (ctx.memoryStore) {
    const res = await ctx.memoryStore.write({
      kind: 'skill_log',
      chat_id: chatId,
      key: SESSION_KEY,
      content,
      source_skill: 'rehearsal',
      importance: 6,
    });
    if (!res.ok) {
      ctx.logger.warn('rehearsal: save session failed', {
        chatId,
        code: res.error.code,
        message: res.error.message,
      });
    }
    return;
  }
  // 兜底：直接 bitable.insert（无 upsert，靠 find + update 不优雅；先粗暴 insert 容忍重复）
  const now = Date.now();
  const res = await ctx.bitable.insert({
    table: 'memory',
    row: {
      kind: 'skill_log',
      chat_id: chatId,
      key: SESSION_KEY,
      content,
      importance: 6,
      last_access: now,
      created_at: now,
      source_skill: 'rehearsal',
    },
  });
  if (!res.ok) {
    ctx.logger.warn('rehearsal: save session insert failed', {
      chatId,
      error: res.error.message,
    });
  }
}

export function isSatisfactionSignal(text: string): boolean {
  return SATISFACTION_RE.test(text);
}

export function isFreshTrigger(text: string): boolean {
  return TRIGGER_RE.test(text);
}

/** session 是否处于"等用户继续输入反馈或满意信号"的状态 */
export function isAwaitingUserResponse(session: RehearsalSession | null): boolean {
  if (!session) return false;
  return session.phase === 'analyzing' || session.phase === 'clarifying';
}

// ─── 历史拉取 + 相关性预筛（仿 summary）──────────────────────────────────────

function summarize(value: string, max = 200): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * lite 模型预筛历史 — 群里可能掺多个项目讨论 / bot 诊断噪音。
 * 触发消息 100% 保留（不进 candidates），避免 lite 误判丢失。
 */
async function filterByRelevance(
  ctx: SkillContext,
  trigger: Message,
  history: readonly Message[],
): Promise<readonly Message[]> {
  if (history.length <= 5) return history;

  const judgable = history.filter((m) => m.messageId !== trigger.messageId);
  if (judgable.length === 0) return history;

  const candidates: RelevanceCandidate[] = judgable.map((m, i) => ({
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
    ctx.logger.warn('rehearsal: relevance filter failed, falling back to full history', {
      code: judgmentResult.error.code,
    });
    return history;
  }

  if (judgmentResult.value.results.length === 0) return history;

  const keepIds = new Set(judgmentResult.value.results.filter((r) => r.keep).map((r) => r.id));
  const keptJudgable = judgable.filter((_, i) => keepIds.has(`m${i}`));
  const keptSet = new Set<Message>([
    ...history.filter((m) => m.messageId === trigger.messageId),
    ...keptJudgable,
  ]);
  const kept = history.filter((m) => keptSet.has(m));

  ctx.logger.info('rehearsal: relevance pre-filter done', {
    kept: `${kept.length}/${history.length}`,
  });

  return kept.length >= Math.min(3, history.length) ? kept : history;
}

// ─── 分析（step ②）──────────────────────────────────────────────────────────

async function analyze(
  ctx: SkillContext,
  trigger: Message,
  prevSession: RehearsalSession | null,
): Promise<Result<RehearsalAnalysis>> {
  const histRes = await ctx.runtime.fetchHistory({
    chatId: trigger.chatId,
    pageSize: HISTORY_PAGE_SIZE,
  });
  if (!histRes.ok) return err(histRes.error);

  const filtered = await filterByRelevance(ctx, trigger, histRes.value.messages);
  const history = filtered.slice(-MAX_HISTORY_FOR_ANALYSIS);

  const prevContext = prevSession
    ? {
        round: prevSession.round + 1,
        previousChanges: prevSession.recommendedChanges,
      }
    : undefined;

  const llmRes = await ctx.llm.askStructured(
    REHEARSAL_PROMPT(history, prevContext),
    RehearsalAnalysisSchema,
    { model: 'pro', timeoutMs: 90_000 },
  );
  if (!llmRes.ok) return err(llmRes.error);
  return ok(llmRes.value);
}

// ─── step ⑤：满意后重生成 PPT / 文档 ────────────────────────────────────────

interface FinalizeOutputs {
  readonly newSlidesUrl?: string;
  readonly newSlidesPageCount?: number;
  readonly newSlidesTitle?: string;
  readonly newDocUrl?: string;
}

/**
 * 复用 slides skill 的 prompt 重生成 PPT，把 recommendedChanges 作为额外上下文塞进 history。
 *
 * 设计权衡：不直接调 slidesSkill.run（会重发 loading 卡），而是手动跑 pipeline 的子集。
 */
interface SlidesRegenResult {
  readonly url: string;
  readonly pageCount: number;
  readonly title: string;
}

async function regenerateSlides(
  ctx: SkillContext,
  chatId: string,
  changes: readonly RehearsalChange[],
): Promise<SlidesRegenResult | undefined> {
  if (!ctx.slides) {
    ctx.logger.warn('rehearsal: slides client not configured, skip regeneration', { chatId });
    return undefined;
  }
  const slidesChanges = changes.filter((c) => c.target === 'slides');
  if (slidesChanges.length === 0) {
    ctx.logger.info('rehearsal: no slides-targeted changes, skip slides regeneration', { chatId });
    return undefined;
  }

  const [historyRes, membersRes, snapshotRes] = await Promise.all([
    ctx.runtime.fetchHistory({ chatId, pageSize: 20 }),
    ctx.runtime.fetchMembers({ chatId }),
    ctx.bitable.find({ table: 'memory', where: { chatId }, pageSize: 2 }),
  ]);

  if (!historyRes.ok) {
    ctx.logger.warn('rehearsal: slides regeneration fetchHistory failed', {
      error: historyRes.error.message,
    });
    return undefined;
  }
  const baseHistory = historyRes.value.messages;
  const members = membersRes.ok ? membersRes.value.members : [];
  const snapshots = snapshotRes.ok ? snapshotRes.value.records : [];

  // 把 rehearsal 反馈以 system-style 消息的形式塞进 history 头部，让 outline 调整
  const feedbackPreamble: Message = {
    messageId: 'rehearsal_feedback',
    chatId,
    chatType: 'group',
    sender: { userId: 'rehearsal_bot', name: '演练复盘助手' },
    contentType: 'text',
    text: `演练反馈要求按以下改动重生成 PPT：\n${slidesChanges.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}`,
    rawContent: '',
    mentions: [],
    timestamp: Date.now(),
  };
  const augmented = [feedbackPreamble, ...baseHistory];

  const outlineRes = await ctx.llm.askStructured(
    SLIDES_PROMPT(augmented, snapshots, members),
    OutlineSchema,
    { model: 'pro', timeoutMs: 90_000, maxTokens: 2600, temperature: 0.2 },
  );
  if (!outlineRes.ok) {
    ctx.logger.warn('rehearsal: slides outline failed', { error: outlineRes.error.message });
    return undefined;
  }

  const outline = outlineRes.value;
  const created = await ctx.slides.createFromOutline(outline.title, outline);
  if (!created.ok) {
    ctx.logger.warn('rehearsal: slides createFromOutline failed', {
      error: created.error.message,
    });
    return undefined;
  }

  if (members.length > 0) {
    const grant = await ctx.slides.grantMembersEdit(
      created.value.slidesToken,
      members.map((m) => m.userId),
    );
    if (!grant.ok) {
      ctx.logger.warn('rehearsal: grant slides edit failed', { error: grant.error.message });
    }
  }

  // 同步写一条 [slides] memory，让 archive 后续能列出新版本
  const now = Date.now();
  void ctx.bitable
    .insert({
      table: 'memory',
      row: {
        key: `slides-rehearsal-${chatId}-${now}`,
        kind: 'project',
        chat_id: chatId,
        content: `[slides] ${outline.title}（演练复盘 v${changes.length}）\n${created.value.url}`,
        importance: 6,
        last_access: now,
        created_at: now,
        source_skill: 'rehearsal',
      },
    })
    .then((r) => {
      if (!r.ok)
        ctx.logger.warn('rehearsal: insert slides memory failed', { error: r.error.message });
    })
    .catch((e: unknown) => {
      ctx.logger.warn('rehearsal: slides memory insert threw', {
        error: e instanceof Error ? e.message : String(e),
      });
    });

  ctx.logger.info('rehearsal: slides regenerated', {
    chatId,
    title: outline.title,
    pageCount: outline.slides.length,
    url: created.value.url,
  });
  return {
    url: created.value.url,
    pageCount: outline.slides.length,
    title: outline.title,
  };
}

/** doc 类改动归档为飞书文档（轻量：单 markdown 文件） */
async function regenerateReportDoc(
  ctx: SkillContext,
  chatId: string,
  changes: readonly RehearsalChange[],
): Promise<string | undefined> {
  const docChanges = changes.filter((c) => c.target === 'doc');
  if (docChanges.length === 0) return undefined;

  const dateStr = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const title = `演练复盘修订记录 ${dateStr}`;
  const md = [
    `# ${title}`,
    '',
    '> 由 Lark Loom 演练复盘 skill 自动生成',
    '',
    '## 本次采纳的修改',
    '',
    ...docChanges.map((c, i) => `${i + 1}. ${c.text}`),
  ].join('\n');

  const created = await ctx.docx.createFromMarkdown(title, md);
  if (!created.ok) {
    ctx.logger.warn('rehearsal: createFromMarkdown failed', { error: created.error.message });
    return undefined;
  }

  // 给群成员授可编辑权限
  const membersRes = await ctx.runtime.fetchMembers({ chatId });
  if (membersRes.ok && membersRes.value.members.length > 0) {
    const grant = await ctx.docx.grantMembersEdit(
      created.value.docToken,
      'docx',
      membersRes.value.members.map((m) => m.userId),
    );
    if (!grant.ok) {
      ctx.logger.warn('rehearsal: grant doc edit failed', { error: grant.error.message });
    }
  }

  return created.value.url;
}

async function finalize(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<FinalizeOutputs> {
  const [slidesResult, newDocUrl] = await Promise.all([
    regenerateSlides(ctx, chatId, session.recommendedChanges),
    regenerateReportDoc(ctx, chatId, session.recommendedChanges),
  ]);
  return {
    ...(slidesResult
      ? {
          newSlidesUrl: slidesResult.url,
          newSlidesPageCount: slidesResult.pageCount,
          newSlidesTitle: slidesResult.title,
        }
      : {}),
    ...(newDocUrl ? { newDocUrl } : {}),
  };
}

// ─── memory 写入 ─────────────────────────────────────────────────────────────

async function writeRoundMemory(
  ctx: SkillContext,
  chatId: string,
  round: number,
  analysis: RehearsalAnalysis,
  userFeedbackSummary?: string,
): Promise<void> {
  const now = Date.now();
  const content = clamp(
    JSON.stringify({
      round,
      summary: analysis.summary,
      issueCount: analysis.issues.length,
      suggestionCount: analysis.suggestions.length,
      uncertaintyCount: analysis.uncertainties.length,
      ...(userFeedbackSummary ? { userFeedback: userFeedbackSummary } : {}),
    }),
    'LONG',
  );
  const res = await ctx.bitable.insert({
    table: 'memory',
    row: {
      key: `rehearsal-${chatId}-r${round}-${now}`,
      kind: 'skill_log',
      chat_id: chatId,
      content,
      importance: 5,
      last_access: now,
      created_at: now,
      source_skill: 'rehearsal',
    },
  });
  if (!res.ok) {
    ctx.logger.warn('rehearsal: round skill_log insert failed', { error: res.error.message });
  }
}

async function writeFinalMemory(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
  outputs: FinalizeOutputs,
): Promise<void> {
  const now = Date.now();
  const lines: string[] = [
    `[演练复盘] 已完成 ${session.round} 轮迭代`,
    `累计采纳改动 ${session.recommendedChanges.length} 条`,
  ];
  if (outputs.newSlidesUrl) lines.push(`新版 PPT：${outputs.newSlidesUrl}`);
  if (outputs.newDocUrl) lines.push(`修订记录：${outputs.newDocUrl}`);
  if (session.recommendedChanges.length > 0) {
    lines.push(
      '改动清单：',
      ...session.recommendedChanges.map((c, i) => `${i + 1}. [${c.target}] ${c.text}`),
    );
  }

  const content = clamp(lines.join('\n'), 'LONG');
  const res = await ctx.bitable.insert({
    table: 'memory',
    row: {
      key: `rehearsal-final-${chatId}-${now}`,
      kind: 'project',
      chat_id: chatId,
      content,
      importance: 7,
      last_access: now,
      created_at: now,
      source_skill: 'rehearsal',
    },
  });
  if (!res.ok) {
    ctx.logger.warn('rehearsal: final memory insert failed', { error: res.error.message });
  }
}

// ─── core run logic ──────────────────────────────────────────────────────────

interface RunArgs {
  readonly chatId: string;
  readonly trigger: Message | null;
  readonly action: 'message' | 'cardAction.satisfied' | 'cardAction.iterate';
  readonly userTextSummary?: string;
}

async function performAnalysisRound(
  ctx: SkillContext,
  args: RunArgs,
  prevSession: RehearsalSession | null,
): Promise<Result<SkillResult>> {
  const { chatId, trigger } = args;
  const round = prevSession ? prevSession.round + 1 : 1;

  const loadingCard = ctx.cardBuilder.build('rehearsal', {
    round,
    issues: [],
    suggestions: [],
    uncertainties: [],
    chatId,
    isLoading: true,
  } as const);
  // 诊断：打印 trigger chatId vs 目标 chatId，万一有 mismatch 立即可见
  const eventChatId = getChatId(ctx.event);
  ctx.logger.info('rehearsal: sending loading card', {
    targetChatId: chatId,
    eventChatId,
    eventType: ctx.event.type,
    round,
    triggerMsgId: trigger?.messageId ?? '(no trigger)',
    triggerText: trigger?.text?.slice(0, 60) ?? '',
  });
  if (eventChatId && eventChatId !== chatId) {
    ctx.logger.error('rehearsal: chatId mismatch — refusing to send to wrong chat', {
      eventChatId,
      targetChatId: chatId,
    });
    return err(makeError(ErrorCode.INVALID_INPUT, 'rehearsal chatId mismatch'));
  }
  const loadingSent = await ctx.runtime.sendCard({ chatId, card: loadingCard });
  if (!loadingSent.ok) return err(loadingSent.error);
  const loadingMessageId = loadingSent.value.messageId;

  const patchToError = async (message: string): Promise<void> => {
    const errCard = ctx.cardBuilder.build('rehearsal', {
      round,
      issues: [],
      suggestions: [],
      uncertainties: [],
      chatId,
      errorMessage: message,
    });
    const patchRes = await ctx.runtime.patchCard({ messageId: loadingMessageId, card: errCard });
    if (!patchRes.ok) {
      ctx.logger.warn('rehearsal: patch error card failed', {
        code: patchRes.error.code,
        message: patchRes.error.message,
      });
    }
  };

  // 没 trigger message 也得跑（continueLoop 可能从 cardAction 进来）—— 用合成 trigger
  const effectiveTrigger: Message =
    trigger ??
    ({
      messageId: 'synthetic_trigger',
      chatId,
      chatType: 'group',
      sender: { userId: 'system', name: 'system' },
      contentType: 'text',
      text: args.userTextSummary ?? '继续修改',
      rawContent: '',
      mentions: [],
      timestamp: Date.now(),
    } as Message);

  const analysisRes = await analyze(ctx, effectiveTrigger, prevSession);
  if (!analysisRes.ok) {
    await patchToError(`分析失败：${analysisRes.error.message}`);
    return err(analysisRes.error);
  }

  const analysis = analysisRes.value;
  const filtered = applyConfidenceFilter(analysis);

  // 累积 recommendedChanges：去重以 text+target 为 key
  const accumulated = mergeChanges(
    prevSession?.recommendedChanges ?? [],
    analysis.recommendedChanges,
  );

  // patch 分析卡
  const finalCard = ctx.cardBuilder.build('rehearsal', {
    round,
    issues: filtered.issues,
    suggestions: filtered.suggestions,
    uncertainties: filtered.uncertainties,
    summary: analysis.summary,
    chatId,
  });
  const patchRes = await ctx.runtime.patchCard({
    messageId: loadingMessageId,
    card: finalCard,
  });
  if (!patchRes.ok) {
    ctx.logger.warn('rehearsal: patch analysis card failed', {
      code: patchRes.error.code,
      message: patchRes.error.message,
    });
  }

  // 有 uncertainties → 直接跟一张反问卡
  let clarifyMessageId: string | undefined;
  if (filtered.uncertainties.length > 0) {
    const questions = buildClarifyQuestions(filtered.uncertainties);
    const clarifyCard = ctx.cardBuilder.build('rehearsalClarify', {
      round,
      questions,
      chatId,
    });
    const clarifySent = await ctx.runtime.sendCard({ chatId, card: clarifyCard });
    if (clarifySent.ok) {
      clarifyMessageId = clarifySent.value.messageId;
    } else {
      ctx.logger.warn('rehearsal: send clarify card failed', {
        error: clarifySent.error.message,
      });
    }
  }

  const newSession: RehearsalSession = {
    phase: filtered.uncertainties.length > 0 ? 'clarifying' : 'analyzing',
    round,
    analysisMessageId: loadingMessageId,
    ...(clarifyMessageId ? { clarifyMessageId } : {}),
    recommendedChanges: accumulated,
    lastUncertainties: filtered.uncertainties,
    startedAt: prevSession?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await saveSession(ctx, chatId, newSession);
  await writeRoundMemory(ctx, chatId, round, analysis, args.userTextSummary);

  return ok({
    reasoning: `演练复盘第 ${round} 轮：${filtered.issues.length} 问题 / ${filtered.suggestions.length} 建议 / ${filtered.uncertainties.length} 待确认`,
  });
}

function mergeChanges(
  prev: readonly RehearsalChange[],
  next: readonly RehearsalChange[],
): readonly RehearsalChange[] {
  const seen = new Set<string>(prev.map((c) => `${c.target}::${c.text}`));
  const out: RehearsalChange[] = [...prev];
  for (const c of next) {
    const k = `${c.target}::${c.text}`;
    if (!seen.has(k)) {
      out.push(c);
      seen.add(k);
    }
  }
  // 防 session JSON 超 2KB：超出上限保留最新的（老的多半已应用进 round 1-2 的 PPT）
  if (out.length > MAX_RECOMMENDED_CHANGES) {
    return out.slice(-MAX_RECOMMENDED_CHANGES);
  }
  return out;
}

async function performFinalize(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<Result<SkillResult>> {
  // step ⑤：调 slides + doc 重生成
  const outputs = await finalize(ctx, chatId, session);

  // patch 分析卡为完成态
  if (session.analysisMessageId) {
    const hasChanges = session.recommendedChanges.length > 0;
    const hasOutput = Boolean(outputs.newSlidesUrl || outputs.newDocUrl);
    // 兜底原因：有改动但产出物全空 → 重生成失败；无改动 → 用户没要求改
    const noRegenReason: 'noChanges' | 'regenFailed' | undefined = hasOutput
      ? undefined
      : hasChanges
        ? 'regenFailed'
        : 'noChanges';

    const completedCard = ctx.cardBuilder.build('rehearsal', {
      round: session.round,
      issues: [],
      suggestions: [],
      uncertainties: [],
      summary: hasChanges
        ? `共 ${session.recommendedChanges.length} 条改动已采纳`
        : '本次未沉淀具体改动',
      chatId,
      isCompleted: true,
      ...(outputs.newSlidesUrl ? { newSlidesUrl: outputs.newSlidesUrl } : {}),
      ...(outputs.newDocUrl ? { newDocUrl: outputs.newDocUrl } : {}),
      ...(noRegenReason ? { noRegenReason } : {}),
    });
    const patchRes = await ctx.runtime.patchCard({
      messageId: session.analysisMessageId,
      card: completedCard,
    });
    if (!patchRes.ok) {
      ctx.logger.warn('rehearsal: patch completed card failed', {
        error: patchRes.error.message,
      });
    }
  }

  // 把新版 PPT 卡作为独立卡片发出来（用户能直接点开）
  if (outputs.newSlidesUrl) {
    const slidesCard = ctx.cardBuilder.build('slides', {
      title: outputs.newSlidesTitle ?? `演练复盘后新版 PPT（v${session.round}）`,
      presentationUrl: outputs.newSlidesUrl,
      pageCount: outputs.newSlidesPageCount ?? 0,
    });
    void ctx.runtime.sendCard({ chatId, card: slidesCard });
  }

  await writeFinalMemory(ctx, chatId, session, outputs);

  // 标 session done（避免下条消息被当 continueLoop）
  await saveSession(ctx, chatId, {
    ...session,
    phase: 'done',
    updatedAt: Date.now(),
  });

  return ok({
    reasoning: `演练复盘完成（${session.round} 轮）：${outputs.newSlidesUrl ? '已生成新版 PPT' : '未重生成 PPT'}${outputs.newDocUrl ? '；已生成修订记录' : ''}`,
  });
}

async function performIterateClarify(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<Result<SkillResult>> {
  // 用户想继续修改：发反问卡（沿用 lastUncertainties；为空时给通用提示）
  const questions =
    session.lastUncertainties.length > 0
      ? buildClarifyQuestions(session.lastUncertainties)
      : ['具体哪一页 / 哪段需要修改？', '希望改成什么样？', '有没有新的内容要补？'];

  const clarifyCard = ctx.cardBuilder.build('rehearsalClarify', {
    round: session.round,
    questions,
    chatId,
  });
  const sent = await ctx.runtime.sendCard({ chatId, card: clarifyCard });
  if (!sent.ok) return err(sent.error);

  await saveSession(ctx, chatId, {
    ...session,
    phase: 'clarifying',
    clarifyMessageId: sent.value.messageId,
    updatedAt: Date.now(),
  });

  return ok({
    reasoning: `演练复盘进入第 ${session.round} 轮反问澄清`,
  });
}

async function ackClarifyCard(ctx: SkillContext, session: RehearsalSession): Promise<void> {
  if (!session.clarifyMessageId) return;
  const ack = ctx.cardBuilder.build('rehearsalClarify', {
    round: session.round,
    questions: [],
    acknowledgedAt: Date.now(),
  });
  const res = await ctx.runtime.patchCard({
    messageId: session.clarifyMessageId,
    card: ack,
  });
  if (!res.ok) {
    ctx.logger.warn('rehearsal: ack clarify card failed', { error: res.error.message });
  }
}

// ─── Skill ───────────────────────────────────────────────────────────────────

export const rehearsalSkill: Skill = {
  name: 'rehearsal',
  metadata: {
    description: '基于群聊与会议纪要分析演示问题，循环反问到用户满意后重生成 PPT / 修订文档。',
    when_to_use:
      '用户提到 演练 / 演示练习 / 彩排 / 汇报复盘 / 根据刚才反馈修改，或当前群有活跃 rehearsal session 时使用。',
    examples: [
      '我们刚才演练完了，帮我复盘一下问题',
      '彩排完毕，分析下还有什么要改的',
      '根据刚才反馈修改 PPT',
    ],
  },
  trigger: {
    events: ['message', 'cardAction'],
    requireMention: false,
    keywords: ['演练', '演示练习', '彩排', '汇报复盘', '根据刚才反馈修改'],
    description: '检测到演练复盘请求或 rehearsal 卡片按钮回调时触发',
  },

  match(ctx: SkillContext): boolean {
    if (ctx.event.type === 'cardAction') {
      const action = String(ctx.event.payload.value['action'] ?? '');
      return action === 'rehearsal.satisfied' || action === 'rehearsal.iterate';
    }
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },

  async run(ctx: SkillContext): Promise<Result<SkillResult>> {
    const event = ctx.event;
    const chatId = getChatId(event);
    if (!chatId) {
      return err(makeError(ErrorCode.INVALID_INPUT, 'rehearsal: missing chatId'));
    }

    const session = await loadRehearsalSession(ctx, chatId);

    // ── cardAction 入口 ──────────────────────────────────────────────────
    if (event.type === 'cardAction') {
      const action = String(event.payload.value['action'] ?? '');
      if (action === 'rehearsal.satisfied') {
        if (!session || session.phase === 'done') {
          ctx.logger.warn('rehearsal: satisfied click without active session', { chatId });
          return ok({ reasoning: '无活跃 session，忽略 satisfied 点击' });
        }
        return performFinalize(ctx, chatId, session);
      }
      if (action === 'rehearsal.iterate') {
        if (!session || session.phase === 'done') {
          ctx.logger.warn('rehearsal: iterate click without active session', { chatId });
          return ok({ reasoning: '无活跃 session，忽略 iterate 点击' });
        }
        return performIterateClarify(ctx, chatId, session);
      }
      return err(makeError(ErrorCode.INVALID_INPUT, `rehearsal: unknown action ${action}`));
    }

    if (event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'rehearsal only handles message/cardAction'));
    }

    const msg = event.payload;

    // ── 满意信号优先（即使 trigger 也命中，满意优先级更高，避免无限循环新启动） ──
    if (session && session.phase !== 'done' && isSatisfactionSignal(msg.text)) {
      return performFinalize(ctx, chatId, session);
    }

    // ── 全新触发（无 session 或上次 session 已 done）──
    const hasFreshTrigger = TRIGGER_RE.test(msg.text);
    if (!session || session.phase === 'done') {
      if (!hasFreshTrigger) {
        // 没 session 也没触发词 —— skill 不该被调用，warn 后静默
        ctx.logger.warn('rehearsal: run without trigger or active session', {
          chatId,
          messageId: msg.messageId,
        });
        return ok({ reasoning: '无触发词且无活跃 session' });
      }
      return performAnalysisRound(ctx, { chatId, trigger: msg, action: 'message' }, null);
    }

    // ── 活跃 session + 用户文本 → 视为反馈，重新分析 ──
    // 先 patch 反问卡为已收到态（如有）
    if (session.phase === 'clarifying') {
      await ackClarifyCard(ctx, session);
    }
    return performAnalysisRound(
      ctx,
      {
        chatId,
        trigger: msg,
        action: 'message',
        userTextSummary: clamp(msg.text, 'MEDIUM'),
      },
      session,
    );
  },
};

function getChatId(event: SkillContext['event']): string | null {
  if (event.type === 'message') return event.payload.chatId;
  if (event.type === 'cardAction') return event.payload.chatId;
  return null;
}

