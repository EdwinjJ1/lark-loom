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
import {
  LISTENER_PROMPT,
  SPEAKER_PROMPT,
  SpeakerTranscriptPageSchema,
  makeListenerCritiqueBatchSchema,
  type ListenerCritique,
  type PreviewDocSection,
  type PreviewSlideInput,
  type PreviewStyle,
  type SpeakerTranscriptPage,
} from './prompts/rehearsal-preview.js';
import { verifyAttribution, type ClassifiedCritique } from './utils/attribution.js';
import { clamp } from './utils/clamp.js';
import { findCoreDocToken } from './core-doc.js';
import type {
  RehearsalCritiqueCategory,
  RehearsalListenerCritique,
  RehearsalPreviewPage,
  RehearsalReviewChange,
} from '@seedhac/contracts';

const TRIGGER_RE = /演练|演示练习|彩排|汇报复盘|根据刚才反馈修改|AI\s*试讲|试讲一下/i;
// rehearsal v2 preview 风格切换（可选）
const STYLE_ROADSHOW_RE = /路演|生动|轻盈|轻一点/;
const STYLE_JUDGES_RE = /评委|严肃|学术|正式/;
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

// session JSON 写到 memory.content（2KB 上限）。每条 change ~80-150 字节，留些余地。
// v2 起不再静默截断 —— 改用 review 卡 UI 提示用户精简。仅做软上限警告。
const SOFT_LIMIT_RECOMMENDED_CHANGES = 30;

// 自动进 analyzing 的"用户反馈页数"门槛（issue #145 P1）
const PREVIEW_FEEDBACK_THRESHOLD = 3;

// embedding 语义去重的 cosine 相似度门槛
const EMBEDDING_DEDUP_THRESHOLD = 0.85;

export type RehearsalPhase =
  | 'preview'
  | 'analyzing'
  | 'clarifying'
  | 'reviewing'
  | 'done';

/**
 * 累积的一条 change。v2 加了可选的 id / source（review 卡勾选过滤用）。
 * 兼容 v1：旧 session 缺这两个字段时，parseSession 会自动补上 id_legacy_<i> + source='user'。
 */
export interface RehearsalChangeWithMeta extends RehearsalChange {
  readonly id?: string;
  readonly source?: 'user' | 'listener' | 'history';
}

export interface UserPageFeedback {
  readonly page: number;
  readonly text: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly at: number;
}

export interface RehearsalSession {
  readonly phase: RehearsalPhase;
  readonly round: number;
  /** 当前分析卡的 messageId，用于 patch 满意/完成态 */
  readonly analysisMessageId?: string;
  /** 当前反问卡的 messageId，用于 patch acknowledged 态 */
  readonly clarifyMessageId?: string;
  /** 当前 review 卡的 messageId（v2） */
  readonly reviewMessageId?: string;
  /** 当前 preview 卡的 messageId（v2） */
  readonly previewMessageId?: string;
  /** 累积的 recommendedChanges（每轮叠加，带 id + source） */
  readonly recommendedChanges: readonly RehearsalChangeWithMeta[];
  /** 上一轮 uncertainties，用于 iterate 按钮直接复用 */
  readonly lastUncertainties: readonly string[];
  /** v2: AI 听众已校验过 attribution 的 critique（confirmed + unsure） */
  readonly listenerCritiques?: readonly RehearsalListenerCritique[];
  /** v2: 用户对 preview 卡的分页反馈 */
  readonly userPageFeedback?: readonly UserPageFeedback[];
  /** v2: review 卡上用户勾选的 changeId 列表（confirm 后过滤用） */
  readonly reviewSelection?: readonly string[];
  /** v2: preview 风格 */
  readonly style?: PreviewStyle;
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
  // 拉 50 条按 created_at 取最新一条；防止 saveSession fallback 重复 insert 后旧 session 被读到
  const filter = `AND(CurrentValue.[chat_id]="${chatId}",CurrentValue.[key]="${SESSION_KEY}",CurrentValue.[kind]="skill_log")`;
  const findRes = await ctx.bitable.find({ table: 'memory', filter, pageSize: 50 });
  if (!findRes.ok || findRes.value.records.length === 0) return null;
  const newest = [...findRes.value.records].sort((a, b) => {
    const ta = Number(a['created_at'] ?? 0);
    const tb = Number(b['created_at'] ?? 0);
    return tb - ta;
  })[0]!;
  return parseSession(String(newest['content'] ?? ''));
}

function parseSession(content: string): RehearsalSession | null {
  try {
    const parsed = JSON.parse(content) as Partial<RehearsalSession>;
    if (typeof parsed.phase !== 'string' || typeof parsed.round !== 'number') return null;
    // 兼容 v1 session（旧格式 recommendedChanges 是 RehearsalChange[]，无 id / source）
    const rawChanges = Array.isArray(parsed.recommendedChanges) ? parsed.recommendedChanges : [];
    const recommendedChanges: RehearsalChangeWithMeta[] = rawChanges
      .map((c, i): RehearsalChangeWithMeta | null => {
        if (typeof c !== 'object' || c === null) return null;
        const raw = c as Record<string, unknown>;
        const target = raw['target'];
        const text = typeof raw['text'] === 'string' ? raw['text'].trim() : '';
        if (!text) return null;
        if (target !== 'slides' && target !== 'doc') return null;
        const id = typeof raw['id'] === 'string' ? raw['id'] : `c_legacy_${i}`;
        const sourceRaw = typeof raw['source'] === 'string' ? raw['source'] : 'user';
        const source: 'user' | 'listener' | 'history' =
          sourceRaw === 'listener' || sourceRaw === 'history' ? sourceRaw : 'user';
        return { id, target, text, source };
      })
      .filter((x): x is RehearsalChangeWithMeta => x !== null);

    const listenerCritiques: RehearsalListenerCritique[] = Array.isArray(parsed.listenerCritiques)
      ? (parsed.listenerCritiques as RehearsalListenerCritique[]).filter(
          (c): c is RehearsalListenerCritique =>
            !!c && typeof c === 'object' && typeof c.id === 'string',
        )
      : [];

    const userPageFeedback: UserPageFeedback[] = Array.isArray(parsed.userPageFeedback)
      ? (parsed.userPageFeedback as UserPageFeedback[]).filter(
          (f): f is UserPageFeedback =>
            !!f && typeof f === 'object' && typeof f.page === 'number' && typeof f.text === 'string',
        )
      : [];

    const reviewSelection: string[] = Array.isArray(parsed.reviewSelection)
      ? (parsed.reviewSelection as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

    const style: PreviewStyle | undefined =
      parsed.style === 'roadshow' || parsed.style === 'judges' ? parsed.style : undefined;

    return {
      phase: parsed.phase as RehearsalPhase,
      round: parsed.round,
      ...(typeof parsed.analysisMessageId === 'string'
        ? { analysisMessageId: parsed.analysisMessageId }
        : {}),
      ...(typeof parsed.clarifyMessageId === 'string'
        ? { clarifyMessageId: parsed.clarifyMessageId }
        : {}),
      ...(typeof parsed.reviewMessageId === 'string'
        ? { reviewMessageId: parsed.reviewMessageId }
        : {}),
      ...(typeof parsed.previewMessageId === 'string'
        ? { previewMessageId: parsed.previewMessageId }
        : {}),
      recommendedChanges,
      lastUncertainties: Array.isArray(parsed.lastUncertainties)
        ? (parsed.lastUncertainties as string[])
        : [],
      listenerCritiques,
      userPageFeedback,
      reviewSelection,
      ...(style ? { style } : {}),
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * 把 session JSON 控制在 ~2KB 以内时**不能用 clamp**：clamp 会在尾部加 "…" 截断，破坏 JSON。
 * v2 不再 slice changes，所以会有 30+ 条 case。我们对结构化字段做主动瘦身：
 *   - listenerCritiques.text 截断到 80 字（review 卡只显示一行）
 *   - userPageFeedback.text 截断到 100 字
 *   - 仍然超 2.5KB 才丢弃最旧的 listenerCritiques / userPageFeedback（保留 changes 完整性）
 */
function compactSessionForStorage(session: RehearsalSession): RehearsalSession {
  const compactCritique = (c: RehearsalListenerCritique): RehearsalListenerCritique => ({
    ...c,
    text: c.text.length > 80 ? `${c.text.slice(0, 79)}…` : c.text,
    evidence: c.evidence.length > 60 ? `${c.evidence.slice(0, 59)}…` : c.evidence,
  });
  const compactFeedback = (f: UserPageFeedback): UserPageFeedback => ({
    ...f,
    text: f.text.length > 100 ? `${f.text.slice(0, 99)}…` : f.text,
  });

  let compact: RehearsalSession = {
    ...session,
    listenerCritiques: (session.listenerCritiques ?? []).map(compactCritique),
    userPageFeedback: (session.userPageFeedback ?? []).map(compactFeedback),
  };

  // 如果还是超，逐步丢弃最旧的 listenerCritiques / userPageFeedback（保 recommendedChanges 不动）
  const HARD_CAP = 6_000; // 给底层 storage 留余地，超过就分批丢
  let serialized = JSON.stringify(compact);
  while (serialized.length > HARD_CAP) {
    const lc = compact.listenerCritiques ?? [];
    const ufb = compact.userPageFeedback ?? [];
    if (lc.length > 0) {
      compact = { ...compact, listenerCritiques: lc.slice(1) };
    } else if (ufb.length > 0) {
      compact = { ...compact, userPageFeedback: ufb.slice(1) };
    } else {
      // changes 不动，让底层 storage 决定 — 否则就违反"用户决策依据 ≠ 执行依据"原则
      break;
    }
    serialized = JSON.stringify(compact);
  }
  return compact;
}

async function saveSession(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<void> {
  // v2：不能用 clamp（"…"截断破坏 JSON）；改用结构化瘦身
  const content = JSON.stringify(compactSessionForStorage(session));
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
  // 兜底：bitable upsert — 先 find 现有 record，找到就 update，否则 insert
  // 之前的"粗暴 insert 容忍重复"会让 5 轮 session 留 5 行，loadRehearsalSession 可能拿到旧 row
  const now = Date.now();
  const filter = `AND(CurrentValue.[chat_id]="${chatId}",CurrentValue.[key]="${SESSION_KEY}",CurrentValue.[kind]="skill_log")`;
  const findRes = await ctx.bitable.find({ table: 'memory', filter, pageSize: 1 });
  if (findRes.ok && findRes.value.records.length > 0) {
    const recordId = findRes.value.records[0]!.recordId;
    const updateRes = await ctx.bitable.update({
      table: 'memory',
      recordId,
      patch: { content, last_access: now },
    });
    if (!updateRes.ok) {
      ctx.logger.warn('rehearsal: save session update failed', {
        chatId,
        error: updateRes.error.message,
      });
    }
    return;
  }
  const insertRes = await ctx.bitable.insert({
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
  if (!insertRes.ok) {
    ctx.logger.warn('rehearsal: save session insert failed', {
      chatId,
      error: insertRes.error.message,
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
  return (
    session.phase === 'analyzing' ||
    session.phase === 'clarifying' ||
    session.phase === 'preview' ||
    session.phase === 'reviewing'
  );
}

function detectStyle(text: string): PreviewStyle | undefined {
  if (STYLE_ROADSHOW_RE.test(text)) return 'roadshow';
  if (STYLE_JUDGES_RE.test(text)) return 'judges';
  return undefined;
}

function nextChangeId(prefix: string, existing: ReadonlySet<string>): string {
  let i = 0;
  while (i < 10_000) {
    const candidate = `${prefix}_${i}`;
    if (!existing.has(candidate)) return candidate;
    i += 1;
  }
  return `${prefix}_${Date.now()}`;
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

  // 把 listener critique + 用户分页反馈 通过合成消息塞进 history 头部，
  // 不动 REHEARSAL_PROMPT 的 schema，让既有反幻觉规则继续生效。
  const augmentedHistory: Message[] = [];
  if (prevSession?.listenerCritiques?.length) {
    const text = [
      'AI 听众预演产出（已通过 attribution 校验）：',
      ...prevSession.listenerCritiques.slice(0, 30).map((c) => {
        const unsureMark = c.attribution === 'unsure' ? '⚠️ unsure' : '';
        return `  - [${c.category}] 第 ${c.page} 页 ${unsureMark}: ${c.text}（依据：${c.evidence}）`;
      }),
    ].join('\n');
    augmentedHistory.push({
      messageId: 'rehearsal_listener',
      chatId: trigger.chatId,
      chatType: 'group',
      sender: { userId: 'rehearsal_bot', name: 'AI 听众' },
      contentType: 'text',
      text: clamp(text, 'LONG'),
      rawContent: '',
      mentions: [],
      timestamp: Date.now(),
    });
  }
  if (prevSession?.userPageFeedback?.length) {
    const text = [
      '用户分页反馈（来自 preview 卡）：',
      ...prevSession.userPageFeedback.slice(-15).map((f) => {
        const who = f.userName ?? f.userId ?? '匿名';
        return `  - 第 ${f.page} 页 [${who}]: ${f.text}`;
      }),
    ].join('\n');
    augmentedHistory.push({
      messageId: 'rehearsal_userfb',
      chatId: trigger.chatId,
      chatType: 'group',
      sender: { userId: 'rehearsal_bot', name: '用户分页反馈' },
      contentType: 'text',
      text: clamp(text, 'LONG'),
      rawContent: '',
      mentions: [],
      timestamp: Date.now(),
    });
  }

  const combinedHistory = [...augmentedHistory, ...history];

  const prevContext = prevSession
    ? {
        round: prevSession.round + 1,
        previousChanges: prevSession.recommendedChanges,
      }
    : undefined;

  const llmRes = await ctx.llm.askStructured(
    REHEARSAL_PROMPT(combinedHistory, prevContext),
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
  changes: readonly RehearsalChangeWithMeta[],
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
  changes: readonly RehearsalChangeWithMeta[],
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

  // 累积 recommendedChanges：v2 用 embedding 语义去重（issue #145）
  // 标记 source: prev 已有的保留各自 source；本轮 LLM 给的来自 history（群聊/纪要）
  const accumulated = await mergeChangesV2(
    ctx,
    prevSession?.recommendedChanges ?? [],
    analysis.recommendedChanges,
    'history',
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
    ...(prevSession?.previewMessageId ? { previewMessageId: prevSession.previewMessageId } : {}),
    recommendedChanges: accumulated,
    lastUncertainties: filtered.uncertainties,
    listenerCritiques: prevSession?.listenerCritiques ?? [],
    userPageFeedback: prevSession?.userPageFeedback ?? [],
    reviewSelection: prevSession?.reviewSelection ?? [],
    ...(prevSession?.style ? { style: prevSession.style } : {}),
    startedAt: prevSession?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await saveSession(ctx, chatId, newSession);
  await writeRoundMemory(ctx, chatId, round, analysis, args.userTextSummary);

  return ok({
    reasoning: `演练复盘第 ${round} 轮：${filtered.issues.length} 问题 / ${filtered.suggestions.length} 建议 / ${filtered.uncertainties.length} 待确认`,
  });
}

/**
 * v2 版 mergeChanges（修 issue #145 三个子 bug）：
 *   - 用户决策依据 ≠ 执行依据 → review 卡显式列累积全集（在 performReview 处）
 *   - 静默截断 → 改为返回完整集合 + 软上限信号；UI 提示用户精简，不再 slice
 *   - 去重粒度粗 → 优先 embedding 余弦相似度合并；embed 不可用回退到旧 `target::text` key
 *
 * 入参 prev 已带 id/source，next 来自 LLM analyze 输出（无 id），需要分配 id + source。
 */
async function mergeChangesV2(
  ctx: SkillContext,
  prev: readonly RehearsalChangeWithMeta[],
  next: readonly RehearsalChange[],
  defaultSource: 'user' | 'listener' | 'history',
): Promise<readonly RehearsalChangeWithMeta[]> {
  if (next.length === 0) return prev;

  const existingIds = new Set<string>(
    prev.map((c) => c.id).filter((id): id is string => typeof id === 'string'),
  );
  const out: RehearsalChangeWithMeta[] = [...prev];

  // 先做 cheap 层：完全相同 target+text 直接跳过
  const exactKeys = new Set(prev.map((c) => `${c.target}::${c.text}`));

  // 准备 embedding cache（prev 的 embedding 一次性拉，next 增量算）
  const embedCache = new Map<string, readonly number[]>();
  let embedAvailable = true;

  async function embed(text: string): Promise<readonly number[] | null> {
    if (!embedAvailable) return null;
    const cached = embedCache.get(text);
    if (cached) return cached;
    let res: Awaited<ReturnType<typeof ctx.llm.embed>> | undefined;
    try {
      res = await ctx.llm.embed(text);
    } catch {
      embedAvailable = false;
      return null;
    }
    if (!res || !res.ok) {
      // 任何一次 embed 失败就关掉 embedding 路径（多半是 CONFIG_MISSING / 测试 mock 未实现）
      ctx.logger.info('rehearsal: embedding unavailable, dedup falls back to exact key', {
        code: res?.ok === false ? res.error.code : 'embed_unimplemented',
      });
      embedAvailable = false;
      return null;
    }
    embedCache.set(text, res.value);
    return res.value;
  }

  // 预先 embed prev（小心错误）
  for (const c of prev) {
    await embed(c.text);
    if (!embedAvailable) break;
  }

  for (const c of next) {
    const exactKey = `${c.target}::${c.text}`;
    if (exactKeys.has(exactKey)) continue;

    let merged = false;
    if (embedAvailable) {
      const emb = await embed(c.text);
      if (emb) {
        for (const existing of out) {
          if (existing.target !== c.target) continue;
          const existingEmb = await embed(existing.text);
          if (!existingEmb) break;
          if (cosine(emb, existingEmb) >= EMBEDDING_DEDUP_THRESHOLD) {
            merged = true;
            ctx.logger.info('rehearsal: change merged by embedding similarity', {
              kept: existing.text.slice(0, 60),
              dropped: c.text.slice(0, 60),
            });
            break;
          }
        }
      }
    }
    if (merged) continue;

    const id = nextChangeId('c', existingIds);
    existingIds.add(id);
    exactKeys.add(exactKey);
    out.push({ ...c, id, source: defaultSource });
  }

  // 不再 slice。超过软上限只是返回，调用方在 review 卡里给提示。
  return out;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function performFinalize(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
  /** v2: review 卡用户勾选过滤后的子集；不传则用整个 session.recommendedChanges */
  selectedChanges?: readonly RehearsalChangeWithMeta[],
): Promise<Result<SkillResult>> {
  // step ⑤：调 slides + doc 重生成（v2 按用户勾选的子集执行，不再"用户决策依据 ≠ 执行依据"）
  const effectiveChanges = selectedChanges ?? session.recommendedChanges;
  const finalSession: RehearsalSession = { ...session, recommendedChanges: effectiveChanges };
  const outputs = await finalize(ctx, chatId, finalSession);

  // patch 分析卡为完成态
  if (session.analysisMessageId) {
    const hasChanges = effectiveChanges.length > 0;
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
        ? `共 ${effectiveChanges.length} 条改动已采纳`
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

  await writeFinalMemory(ctx, chatId, finalSession, outputs);

  // 标 session done（避免下条消息被当 continueLoop）
  await saveSession(ctx, chatId, {
    ...session,
    phase: 'done',
    recommendedChanges: effectiveChanges,
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

// ─── v2 reviewing phase（issue #145 P2）─────────────────────────────────────

function buildReviewChanges(session: RehearsalSession): readonly RehearsalReviewChange[] {
  // 1) 累积的 recommendedChanges（来自 analyze）— history/user 默认勾选，listener 不勾
  const fromChanges: RehearsalReviewChange[] = session.recommendedChanges.map((c, i) => {
    const rawSource = c.source ?? 'user';
    const source: RehearsalReviewChange['source'] =
      rawSource === 'history' ? 'user' : rawSource === 'listener' ? 'listener' : 'user';
    const defaultChecked = source === 'user';
    return {
      id: c.id ?? `c_${i}`,
      target: c.target,
      text: c.text,
      source,
      defaultChecked,
    };
  });

  // 2) AI 听众的 critique 也作为可选改动呈现（默认不勾，让用户自己决定要不要采纳）。
  // attribution=unsure 的进 'unsure' 组（⚠️ 来源待确认），confirmed 的进 'listener' 组。
  const fromListener: RehearsalReviewChange[] = (session.listenerCritiques ?? []).map((c) => ({
    id: c.id,
    target: 'slides',
    text: `第 ${c.page} 页 [${c.category}] ${c.text}`,
    source: c.attribution === 'unsure' ? 'unsure' : 'listener',
    defaultChecked: false,
  }));

  return [...fromChanges, ...fromListener];
}

async function performReview(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<Result<SkillResult>> {
  const reviewChanges = buildReviewChanges(session);
  const overLimit = session.recommendedChanges.length > SOFT_LIMIT_RECOMMENDED_CHANGES;

  const card = ctx.cardBuilder.build('rehearsalReview', {
    chatId,
    round: session.round,
    changes: reviewChanges,
    overLimitHint: overLimit,
  });
  const sent = await ctx.runtime.sendCard({ chatId, card });
  if (!sent.ok) return err(sent.error);

  // 默认勾选 = user 来源；用户在卡上点 toggle 会增删 reviewSelection。
  const defaultSelection = reviewChanges.filter((c) => c.defaultChecked).map((c) => c.id);

  await saveSession(ctx, chatId, {
    ...session,
    phase: 'reviewing',
    reviewMessageId: sent.value.messageId,
    reviewSelection: defaultSelection,
    updatedAt: Date.now(),
  });

  return ok({
    reasoning: `演练复盘进入 review checkpoint（${reviewChanges.length} 条累积改动待用户确认）`,
  });
}

async function patchReviewResolved(
  ctx: SkillContext,
  session: RehearsalSession,
  resolution: 'confirmed' | 'cancelled' | 'editing',
): Promise<void> {
  if (!session.reviewMessageId) return;
  const card = ctx.cardBuilder.build('rehearsalReview', {
    chatId: '',
    round: session.round,
    changes: [],
    resolution,
    resolvedAt: Date.now(),
  });
  const res = await ctx.runtime.patchCard({
    messageId: session.reviewMessageId,
    card,
  });
  if (!res.ok) {
    ctx.logger.warn('rehearsal: patch review resolved failed', { error: res.error.message });
  }
}

async function handleReviewToggle(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
  changeId: string,
  checked: boolean,
): Promise<Result<SkillResult>> {
  const current = new Set(session.reviewSelection ?? []);
  if (checked) current.add(changeId);
  else current.delete(changeId);
  await saveSession(ctx, chatId, {
    ...session,
    reviewSelection: [...current],
    updatedAt: Date.now(),
  });
  return ok({ reasoning: `review toggle ${changeId}=${checked}` });
}

async function performReviewConfirm(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<Result<SkillResult>> {
  const selectedSet = new Set(session.reviewSelection ?? []);
  const subset = session.recommendedChanges.filter((c, i) => selectedSet.has(c.id ?? `c_${i}`));
  await patchReviewResolved(ctx, session, 'confirmed');
  return performFinalize(ctx, chatId, session, subset);
}

async function performReviewCancel(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<Result<SkillResult>> {
  await patchReviewResolved(ctx, session, 'cancelled');
  return performIterateClarify(ctx, chatId, session);
}

async function performReviewEditList(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
): Promise<Result<SkillResult>> {
  await patchReviewResolved(ctx, session, 'editing');
  // 让用户在群里追加文字微调，沿用 clarify 卡，提示框稍微定制
  const card = ctx.cardBuilder.build('rehearsalClarify', {
    round: session.round,
    questions: [
      '想保留哪几条？（可以直接说"只留 3 条"或"删掉关于 OKR 的"）',
      '有没有要新增的改动？',
    ],
    chatId,
  });
  const sent = await ctx.runtime.sendCard({ chatId, card });
  if (!sent.ok) return err(sent.error);
  await saveSession(ctx, chatId, {
    ...session,
    phase: 'clarifying',
    clarifyMessageId: sent.value.messageId,
    updatedAt: Date.now(),
  });
  return ok({ reasoning: 'review editList — 回 clarifying 让用户追加/删除' });
}

// ─── v2 preview phase（issue #145 P1）──────────────────────────────────────

function findLatestSlidesOutlineFromMemory(
  records: ReadonlyArray<Record<string, unknown>>,
): { title: string; outline: { slides: PreviewSlideInput[] } } | null {
  // [slides_outline] 前缀的 memory 是 v2 由 slides skill 写入的（见 slides.ts）；
  // 内容是 JSON.stringify({title, slides[]})。
  const candidates = records.filter((r) =>
    /^\[slides_outline\]/.test(String(r['content'] ?? '')),
  );
  if (candidates.length === 0) return null;
  const newest = [...candidates].sort(
    (a, b) => Number(b['created_at'] ?? 0) - Number(a['created_at'] ?? 0),
  )[0]!;
  const content = String(newest['content'] ?? '');
  const jsonStart = content.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(jsonStart)) as {
      title?: unknown;
      slides?: unknown;
    };
    if (typeof parsed.title !== 'string' || !Array.isArray(parsed.slides)) return null;
    const slides: PreviewSlideInput[] = parsed.slides
      .map((s, i): PreviewSlideInput | null => {
        if (typeof s !== 'object' || s === null) return null;
        const o = s as Record<string, unknown>;
        const title = typeof o['title'] === 'string' ? o['title'] : '';
        if (!title.trim()) return null;
        const bullets = Array.isArray(o['bullets'])
          ? (o['bullets'] as unknown[]).filter((b): b is string => typeof b === 'string')
          : [];
        const subtitle = typeof o['subtitle'] === 'string' ? o['subtitle'] : undefined;
        return {
          page: i + 1,
          title,
          bullets,
          ...(subtitle ? { subtitle } : {}),
        };
      })
      .filter((x): x is PreviewSlideInput => x !== null);
    if (slides.length === 0) return null;
    return { title: parsed.title, outline: { slides } };
  } catch {
    return null;
  }
}

async function fetchCoreDocSections(
  ctx: SkillContext,
  chatId: string,
): Promise<readonly PreviewDocSection[]> {
  const docToken = await findCoreDocToken(ctx, chatId);
  if (!docToken) return [];
  const res = await ctx.docx.readContent(docToken, 'doc');
  if (!res.ok) {
    ctx.logger.info('rehearsal-preview: core-doc readContent failed, degrading', {
      code: res.error.code,
    });
    return [];
  }
  return parseDocIntoSections(res.value);
}

/**
 * 把 readContent 返回的纯文本按 H2 / `## ` 切段。
 * core-doc 的 SECTION 列表（见 core-doc.ts）一般是 OKR / 一句话定义 / 项目状态等。
 * 找不到结构 → 整个 doc 当一段。
 */
function parseDocIntoSections(text: string): readonly PreviewDocSection[] {
  const lines = text.split(/\r?\n/);
  const sections: { section: string; lines: string[] }[] = [];
  let current: { section: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^(?:##\s+|H2[:：]\s*)(.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { section: m[1]!.trim(), lines: [] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    return [{ section: 'core-doc', content: text.trim() }];
  }
  return sections.map((s) => ({
    section: s.section,
    content: s.lines.join('\n').trim(),
  }));
}

async function generateSpeakerTranscripts(
  ctx: SkillContext,
  pages: readonly PreviewSlideInput[],
  docContext: readonly PreviewDocSection[],
  style: PreviewStyle,
): Promise<readonly SpeakerTranscriptPage[]> {
  const transcripts: SpeakerTranscriptPage[] = [];
  // 顺序跑（不并发）：保证 LLM 能力被 attribution 校验复用 cache
  for (const page of pages) {
    const res = await ctx.llm.askStructured(
      SPEAKER_PROMPT(page, docContext, style),
      SpeakerTranscriptPageSchema,
      { model: 'pro', timeoutMs: 60_000, temperature: 0.6, maxTokens: 800 },
    );
    if (!res.ok) {
      ctx.logger.warn('rehearsal-preview: speaker LLM failed for page', {
        page: page.page,
        code: res.error.code,
      });
      // 降级：用 PPT title + 第一条 bullet 拼一个最小可用讲稿，保整链路不挂
      const fallback: SpeakerTranscriptPage = {
        page: page.page,
        hook: page.title,
        core: (page.bullets ?? []).slice(0, 3).join('；') || page.title,
        transition: '继续下一页。',
        cite: [`ppt.p${page.page}`],
        evidence: 'fallback (speaker LLM degraded)',
      };
      transcripts.push(fallback);
      continue;
    }
    transcripts.push(res.value);
  }
  return transcripts;
}

async function generateListenerCritiques(
  ctx: SkillContext,
  pages: readonly PreviewSlideInput[],
  docContext: readonly PreviewDocSection[],
  transcripts: readonly SpeakerTranscriptPage[],
): Promise<readonly ListenerCritique[]> {
  const schema = makeListenerCritiqueBatchSchema(pages.length);
  const res = await ctx.llm.askStructured(
    LISTENER_PROMPT(pages, docContext, transcripts),
    schema,
    { model: 'pro', timeoutMs: 90_000, temperature: 0.2, maxTokens: 2400 },
  );
  if (!res.ok) {
    ctx.logger.warn('rehearsal-preview: listener LLM failed', { code: res.error.code });
    return [];
  }
  return res.value.critiques;
}

function critiquesToContractShape(
  classified: readonly ClassifiedCritique[],
): readonly RehearsalListenerCritique[] {
  return classified.map((cc, i): RehearsalListenerCritique => {
    const c = cc.critique;
    return {
      id: `lc_${i}`,
      category: c.category as RehearsalCritiqueCategory,
      page: c.page,
      text: c.text,
      evidence: c.evidence,
      cite: c.cite,
      confidence: c.confidence,
      attribution: cc.attribution,
    };
  });
}

async function performPreview(
  ctx: SkillContext,
  chatId: string,
  trigger: Message,
  prevSession: RehearsalSession | null,
): Promise<Result<SkillResult>> {
  const style = detectStyle(trigger.text) ?? prevSession?.style ?? 'judges';

  // 1. 拉 PPT outline（来自 slides skill 写入的 [slides_outline] memory）
  const memRes = await ctx.bitable.find({
    table: 'memory',
    filter: `AND(CurrentValue.[chat_id]="${chatId}")`,
    pageSize: 100,
  });
  const records = memRes.ok ? memRes.value.records : [];
  const slidesData = findLatestSlidesOutlineFromMemory(records);

  if (!slidesData) {
    // 没有 PPT outline 缓存 → 退化成 v1：直接进 analyze
    ctx.logger.info('rehearsal-preview: no slides outline in memory, falling back to v1 analyze', {
      chatId,
    });
    return performAnalysisRound(
      ctx,
      { chatId, trigger, action: 'message' },
      prevSession,
    );
  }

  const pages = slidesData.outline.slides;

  // 2. 拉 core-doc
  const docContext = await fetchCoreDocSections(ctx, chatId);

  // 3. 演讲者讲稿（pro × N 页）— graceful，逐页 fallback
  const transcripts = await generateSpeakerTranscripts(ctx, pages, docContext, style);

  // 4. 听众 critique（pro 一次）
  const rawCritiques = await generateListenerCritiques(ctx, pages, docContext, transcripts);

  // 5. attribution 校验（lite × N 并发）
  const classified = await verifyAttribution(ctx, rawCritiques, pages, docContext);
  const listenerCritiques = critiquesToContractShape(classified);

  // 6. 渲染 preview 卡（每页一段）
  const critiquesByPage = new Map<number, RehearsalListenerCritique[]>();
  for (const c of listenerCritiques) {
    const list = critiquesByPage.get(c.page) ?? [];
    list.push(c);
    critiquesByPage.set(c.page, list);
  }
  const previewPages: RehearsalPreviewPage[] = pages.map((p): RehearsalPreviewPage => {
    const t = transcripts.find((tt) => tt.page === p.page);
    const critiques = critiquesByPage.get(p.page) ?? [];
    return {
      page: p.page,
      pageTitle: p.title,
      hook: t?.hook ?? p.title,
      core: t?.core ?? '',
      transition: t?.transition ?? '',
      critiques,
    };
  });

  const previewCard = ctx.cardBuilder.build('rehearsalPreview', {
    chatId,
    totalPages: pages.length,
    pages: previewPages,
    style,
  });
  const sent = await ctx.runtime.sendCard({ chatId, card: previewCard });
  if (!sent.ok) return err(sent.error);

  // 7. session 写入：phase=preview，缓存 listenerCritiques + style
  const startedAt = prevSession?.startedAt ?? Date.now();
  const newSession: RehearsalSession = {
    phase: 'preview',
    round: 0, // preview 是第 0 轮，进入 analyze 后自然变 1
    previewMessageId: sent.value.messageId,
    recommendedChanges: prevSession?.recommendedChanges ?? [],
    lastUncertainties: prevSession?.lastUncertainties ?? [],
    listenerCritiques,
    userPageFeedback: prevSession?.userPageFeedback ?? [],
    reviewSelection: prevSession?.reviewSelection ?? [],
    style,
    startedAt,
    updatedAt: Date.now(),
  };
  await saveSession(ctx, chatId, newSession);

  return ok({
    reasoning: `AI 听众预演：${pages.length} 页讲稿 + ${listenerCritiques.length} 条 critique（${classified.filter((c) => c.attribution === 'unsure').length} 待确认）`,
  });
}

async function recordPreviewFeedback(
  ctx: SkillContext,
  chatId: string,
  session: RehearsalSession,
  page: number,
  text: string,
  user?: { userId?: string | undefined; userName?: string | undefined },
): Promise<RehearsalSession> {
  const fb: UserPageFeedback = {
    page,
    text: clamp(text, 'MEDIUM'),
    at: Date.now(),
    ...(user?.userId ? { userId: user.userId } : {}),
    ...(user?.userName ? { userName: user.userName } : {}),
  };
  const updated: RehearsalSession = {
    ...session,
    userPageFeedback: [...(session.userPageFeedback ?? []), fb],
    updatedAt: Date.now(),
  };
  await saveSession(ctx, chatId, updated);
  return updated;
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
      return (
        action === 'rehearsal.satisfied' ||
        action === 'rehearsal.iterate' ||
        action === 'rehearsal.preview.agree' ||
        action === 'rehearsal.preview.disagree' ||
        action === 'rehearsal.preview.startAnalyze' ||
        action === 'rehearsal.review.toggle' ||
        action === 'rehearsal.review.confirm' ||
        action === 'rehearsal.review.cancel' ||
        action === 'rehearsal.review.editList'
      );
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
      const value = event.payload.value;

      // v1 兼容入口：satisfied → 现在先进 review 卡，不直接 finalize
      if (action === 'rehearsal.satisfied') {
        if (!session || session.phase === 'done') {
          ctx.logger.warn('rehearsal: satisfied click without active session', { chatId });
          return ok({ reasoning: '无活跃 session，忽略 satisfied 点击' });
        }
        return performReview(ctx, chatId, session);
      }
      if (action === 'rehearsal.iterate') {
        if (!session || session.phase === 'done') {
          ctx.logger.warn('rehearsal: iterate click without active session', { chatId });
          return ok({ reasoning: '无活跃 session，忽略 iterate 点击' });
        }
        return performIterateClarify(ctx, chatId, session);
      }

      // v2 preview 卡按钮
      if (action === 'rehearsal.preview.agree' || action === 'rehearsal.preview.disagree') {
        if (!session || session.phase === 'done') {
          ctx.logger.warn('rehearsal: preview click without active session', { chatId });
          return ok({ reasoning: '无活跃 preview session' });
        }
        const page = Number(value['page']);
        if (!Number.isInteger(page) || page < 1) {
          return err(makeError(ErrorCode.INVALID_INPUT, 'preview action missing page'));
        }
        // agree → 视为接受 AI 听众建议，写一条简短反馈
        const text = action === 'rehearsal.preview.agree' ? '同意 AI 听众建议（来自卡片按钮）' : '我有不同意见（来自卡片按钮，请在群里补充具体内容）';
        const updated = await recordPreviewFeedback(ctx, chatId, session, page, text, {
          userId: event.payload.user.userId,
          userName: event.payload.user.name,
        });
        const fbCount = updated.userPageFeedback?.length ?? 0;
        if (fbCount >= PREVIEW_FEEDBACK_THRESHOLD && updated.phase === 'preview') {
          return performAnalysisRound(ctx, { chatId, trigger: null, action: 'message' }, updated);
        }
        return ok({
          reasoning: `preview feedback recorded (page ${page}, ${fbCount}/${PREVIEW_FEEDBACK_THRESHOLD})`,
        });
      }
      if (action === 'rehearsal.preview.startAnalyze') {
        if (!session) {
          return ok({ reasoning: '无活跃 preview session' });
        }
        return performAnalysisRound(ctx, { chatId, trigger: null, action: 'message' }, session);
      }

      // v2 review 卡按钮
      if (action === 'rehearsal.review.toggle') {
        if (!session) return ok({ reasoning: '无活跃 session, 忽略 toggle' });
        const changeId = typeof value['changeId'] === 'string' ? value['changeId'] : '';
        const checked = value['checked'] === true;
        if (!changeId) {
          return err(makeError(ErrorCode.INVALID_INPUT, 'review.toggle missing changeId'));
        }
        return handleReviewToggle(ctx, chatId, session, changeId, checked);
      }
      if (action === 'rehearsal.review.confirm') {
        if (!session) return ok({ reasoning: '无活跃 session, 忽略 confirm' });
        return performReviewConfirm(ctx, chatId, session);
      }
      if (action === 'rehearsal.review.cancel') {
        if (!session) return ok({ reasoning: '无活跃 session, 忽略 cancel' });
        return performReviewCancel(ctx, chatId, session);
      }
      if (action === 'rehearsal.review.editList') {
        if (!session) return ok({ reasoning: '无活跃 session, 忽略 editList' });
        return performReviewEditList(ctx, chatId, session);
      }
      return err(makeError(ErrorCode.INVALID_INPUT, `rehearsal: unknown action ${action}`));
    }

    if (event.type !== 'message') {
      return err(makeError(ErrorCode.INVALID_INPUT, 'rehearsal only handles message/cardAction'));
    }

    const msg = event.payload;

    // ── 满意信号优先：v2 起进 review 卡（不直接 finalize）── ──────────────
    if (session && session.phase !== 'done' && isSatisfactionSignal(msg.text)) {
      // 已经在 reviewing 阶段又再次说"满意"→ 直接按当前勾选 confirm
      if (session.phase === 'reviewing') {
        return performReviewConfirm(ctx, chatId, session);
      }
      return performReview(ctx, chatId, session);
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
      // v2: fresh trigger 走 preview phase；preview 内部若读不到 PPT outline 会回退到 v1 analyze
      return performPreview(ctx, chatId, msg, null);
    }

    // ── 活跃 session + 用户文本 → 视为反馈，重新分析 ──
    // 先 patch 反问卡为已收到态（如有）
    if (session.phase === 'clarifying') {
      await ackClarifyCard(ctx, session);
    }

    // v2: preview phase 收到用户文本 → 视为通用反馈（page=0 表示未指定页码）。
    // 累计达阈值就自动进 analyzing。
    if (session.phase === 'preview') {
      const updated = await recordPreviewFeedback(ctx, chatId, session, 0, msg.text, {
        userId: msg.sender.userId,
        userName: msg.sender.name,
      });
      const fbCount = updated.userPageFeedback?.length ?? 0;
      if (fbCount >= PREVIEW_FEEDBACK_THRESHOLD) {
        return performAnalysisRound(
          ctx,
          {
            chatId,
            trigger: msg,
            action: 'message',
            userTextSummary: clamp(msg.text, 'MEDIUM'),
          },
          updated,
        );
      }
      return ok({
        reasoning: `preview phase 反馈累积 ${fbCount}/${PREVIEW_FEEDBACK_THRESHOLD}`,
      });
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

