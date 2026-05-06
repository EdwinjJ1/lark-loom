/**
 * 项目核心文档 helper（issue #120 v2 重构）
 *
 * 设计变更：从行车记录仪式时间戳堆叠 → 中外大厂共识的项目叙述文档。
 *
 * Section 类别：
 *   - **Rewrite-from-data**：每次相关数据变了重新渲染整段（OKR / 状态 /
 *     一句话定义 / 项目背景 / 已交付产出 / 干系人 / 阻塞与风险）
 *   - **Append-only**：决策日志（按 ADR Immutability，新决策 [Supersedes Dxx]）
 *     + 最近动态（时间线辅助视图）
 *   - **Conditional**：GRAI 复盘（项目结束 archive 触发时一次性填）
 *
 * 防幻觉：
 *   - 模板渲染段（OKR / 状态 / 产出 / 干系人 / 阻塞）—— 全用 skill 已有数据
 *     拼接，不过 LLM
 *   - LLM 综合段（背景与目标 / GRAI 复盘）—— askStructured + schema enforce
 *   - 失败仅 warn —— 任何 section 写入失败都不阻塞 skill 主流程
 */

import type {
  ArchiveLink,
  BitableClient,
  BitableRow,
  DocBlock,
  DocxClient,
} from '@seedhac/contracts';

export interface CoreDocCtx {
  readonly bitable: BitableClient;
  readonly docx: DocxClient;
  readonly logger: {
    warn(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
  };
}

// ─── 找核心文档 docToken（从 memory）────────────────────────────────────────

const FEISHU_URL_RE =
  /https?:\/\/[^\s)>]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)[^\s)>]*/;

export async function findCoreDocToken(
  ctx: CoreDocCtx,
  chatId: string,
): Promise<string | null> {
  const filter = `AND(CurrentValue.[chat_id]="${chatId}")`;
  const res = await ctx.bitable.find({ table: 'memory', filter, pageSize: 100 });
  if (!res.ok) {
    ctx.logger.warn('core-doc: memory.find failed', { error: res.error.message });
    return null;
  }
  let records = res.value.records;
  let candidates = records.filter((r) =>
    /^\[核心文档\]/.test(String(r['content'] ?? '')),
  );

  if (records.length === 0) {
    const allRes = await ctx.bitable.find({ table: 'memory', pageSize: 200 });
    if (allRes.ok) {
      records = allRes.value.records.filter((r) => String(r['chat_id'] ?? '') === chatId);
      candidates = records.filter((r) => /^\[核心文档\]/.test(String(r['content'] ?? '')));
    }
  }

  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(
    (a, b) => Number(b['created_at'] ?? 0) - Number(a['created_at'] ?? 0),
  );
  const content = String(sorted[0]!['content'] ?? '');
  const url = content.match(FEISHU_URL_RE)?.[0];
  if (!url) return null;
  const tokenMatch = url.match(/\/docx\/([a-zA-Z0-9]+)/);
  return tokenMatch ? tokenMatch[1]! : null;
}

function formatTime(now: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(now));
}

function formatDate(now: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

// ─── Section 名称（与 onboarding.ts CORE_DOC_SECTIONS 必须一致）─────────────

export const SECTION = {
  OKR: '🎯 项目 OKR',
  DEFINITION: '一句话定义',
  STATUS: '项目状态',
  BACKGROUND: '项目背景与目标',
  DECISIONS: '关键决策',
  DELIVERABLES: '已交付产出',
  STAKEHOLDERS: '👥 干系人 / 团队',
  BLOCKERS: '⚠️ 阻塞与风险',
  GRAI: '📋 GRAI 复盘',
  RECENT: '最近动态',
} as const;

// ─── 通用：拿 docToken + 调对应方法（失败仅 warn）─────────────────────

async function replaceIn(
  ctx: CoreDocCtx,
  chatId: string,
  section: string,
  blocks: DocBlock[],
): Promise<void> {
  const docToken = await findCoreDocToken(ctx, chatId);
  if (!docToken) {
    ctx.logger.info(`core-doc: no core doc found, skip replace ${section}`, { chatId });
    return;
  }
  const res = await ctx.docx.replaceSection(docToken, section, blocks);
  if (!res.ok) {
    ctx.logger.warn(`core-doc: replace ${section} failed`, { error: res.error.message });
  }
}

async function appendIn(
  ctx: CoreDocCtx,
  chatId: string,
  section: string,
  blocks: DocBlock[],
): Promise<void> {
  const docToken = await findCoreDocToken(ctx, chatId);
  if (!docToken) {
    ctx.logger.info(`core-doc: no core doc found, skip append ${section}`, { chatId });
    return;
  }
  const res = await ctx.docx.appendToSection(docToken, section, blocks);
  if (!res.ok) {
    ctx.logger.warn(`core-doc: append ${section} failed`, { error: res.error.message });
  }
}

// ─── Rewrite-from-data helpers（不过 LLM，纯模板拼接）───────────────────

export async function rewriteDefinition(
  ctx: CoreDocCtx,
  chatId: string,
  oneLineSummary: string,
): Promise<void> {
  if (!oneLineSummary.trim()) return;
  await replaceIn(ctx, chatId, SECTION.DEFINITION, [
    { type: 'paragraph', text: oneLineSummary },
  ]);
}

export interface OKR {
  readonly objective: string;
  readonly keyResults: readonly string[];
}

export async function rewriteOKR(
  ctx: CoreDocCtx,
  chatId: string,
  okr: OKR,
): Promise<void> {
  if (!okr.objective.trim()) return;
  const blocks: DocBlock[] = [{ type: 'paragraph', text: `**O**：${okr.objective}` }];
  okr.keyResults.forEach((kr, i) => {
    if (kr.trim()) blocks.push({ type: 'bullet', text: `KR${i + 1}：${kr}` });
  });
  await replaceIn(ctx, chatId, SECTION.OKR, blocks);
}

export async function rewriteBackground(
  ctx: CoreDocCtx,
  chatId: string,
  background: string,
  goals: readonly string[],
): Promise<void> {
  if (!background.trim() && goals.length === 0) return;
  const blocks: DocBlock[] = [];
  if (background.trim()) {
    blocks.push({ type: 'paragraph', text: `**背景**：${background}` });
  }
  if (goals.length > 0) {
    blocks.push({ type: 'paragraph', text: '**目标**：' });
    goals.forEach((g, i) => blocks.push({ type: 'bullet', text: `${i + 1}. ${g}` }));
  }
  await replaceIn(ctx, chatId, SECTION.BACKGROUND, blocks);
}

const KIND_ICON: Record<NonNullable<ArchiveLink['kind']>, string> = {
  requirementDoc: '📋',
  slides: '🎯',
  taskAssignment: '✅',
  bitable: '📊',
  other: '📎',
};

/**
 * 已交付产出：每次有新产出时调用，重新拉所有 [前缀] memory 重新渲染列表。
 * 调用方传 links（已通过 extractLinksFromMemory 处理过的去重 + 推断结果）。
 */
export async function rewriteDeliverables(
  ctx: CoreDocCtx,
  chatId: string,
  links: readonly ArchiveLink[],
): Promise<void> {
  const blocks: DocBlock[] =
    links.length === 0
      ? [{ type: 'paragraph', text: '（暂无产出。PRD / PPT / 分工表生成后会自动列出。）' }]
      : links.map((l) => ({
          type: 'bullet' as const,
          text: `${KIND_ICON[l.kind ?? 'other'] ?? '📎'} ${l.label}：${l.url}`,
        }));
  await replaceIn(ctx, chatId, SECTION.DELIVERABLES, blocks);
}

export interface Stakeholder {
  readonly name: string;
  readonly role?: string;
}

export async function rewriteStakeholders(
  ctx: CoreDocCtx,
  chatId: string,
  members: readonly Stakeholder[],
): Promise<void> {
  const blocks: DocBlock[] =
    members.length === 0
      ? [{ type: 'paragraph', text: '（群成员列表为空。）' }]
      : members.map((m) => ({
          type: 'bullet' as const,
          text: m.role ? `${m.name} — ${m.role}` : m.name,
        }));
  await replaceIn(ctx, chatId, SECTION.STAKEHOLDERS, blocks);
}

export interface ProjectStatusInput {
  readonly blockerCount: number;
  readonly doneCount: number;
  readonly totalTaskCount: number;
  readonly thisWeekFocus?: string;
}

export async function rewriteStatus(
  ctx: CoreDocCtx,
  chatId: string,
  input: ProjectStatusInput,
): Promise<void> {
  const health =
    input.blockerCount >= 3
      ? '🚫 Off track（阻塞较多）'
      : input.blockerCount >= 1
        ? '⚠️ At risk（有阻塞）'
        : '✅ On track';
  const completion =
    input.totalTaskCount > 0 ? ` · 任务 ${input.doneCount}/${input.totalTaskCount}` : '';
  const focus = input.thisWeekFocus ? ` · 这周重点：${input.thisWeekFocus}` : '';
  await replaceIn(ctx, chatId, SECTION.STATUS, [
    {
      type: 'paragraph',
      text: `健康度：${health}${completion} · 最后更新：${formatDate(Date.now())}${focus}`,
    },
  ]);
}

export interface BlockerItem {
  readonly title: string;
  readonly source?: string;
}

export async function rewriteBlockers(
  ctx: CoreDocCtx,
  chatId: string,
  items: readonly BlockerItem[],
): Promise<void> {
  const blocks: DocBlock[] =
    items.length === 0
      ? [{ type: 'paragraph', text: '✅ 暂无阻塞与风险。' }]
      : items.map((b) => ({
          type: 'bullet' as const,
          text: b.source ? `${b.title} · 来源：${b.source}` : b.title,
        }));
  await replaceIn(ctx, chatId, SECTION.BLOCKERS, blocks);
}

// ─── Append-only helpers ───────────────────────────────────────────────

export interface DecisionEntry {
  readonly title: string;
  readonly source?: string;
  readonly supersedes?: string;
}

/** 关键决策（append-only ADR-style）。决策推翻只 append 新条目标 [Supersedes]。 */
export async function appendDecision(
  ctx: CoreDocCtx,
  chatId: string,
  entry: DecisionEntry,
): Promise<void> {
  const supersedesPart = entry.supersedes ? ` [Supersedes ${entry.supersedes}]` : '';
  const sourcePart = entry.source ? ` · 来源：${entry.source}` : '';
  const line: DocBlock = {
    type: 'bullet',
    text: `${formatTime(Date.now())} — ${entry.title}${supersedesPart}${sourcePart}`,
  };
  await appendIn(ctx, chatId, SECTION.DECISIONS, [line]);
  await appendRecentActivity(ctx, chatId, '决策', entry.title);
}

/** 最近动态时间线（append-only）。 */
export async function appendRecentActivity(
  ctx: CoreDocCtx,
  chatId: string,
  type: '决策' | '需求' | '完成' | '阻塞' | '其它',
  title: string,
): Promise<void> {
  const block: DocBlock = {
    type: 'bullet',
    text: `${formatTime(Date.now())} [${type}] ${title}`,
  };
  await appendIn(ctx, chatId, SECTION.RECENT, [block]);
}

// ─── 兼容旧 API（保留以免现有 caller 破坏）──────────────────────────────

export interface MilestoneEntry {
  readonly type: 'requirement' | 'completion';
  readonly title: string;
  readonly url?: string;
  readonly source?: string;
}

export interface BlockerEntry {
  readonly title: string;
  readonly source?: string;
}

/**
 * @deprecated 改用 rewriteDeliverables + appendRecentActivity
 * 旧 caller 仍然能调，只往最近动态记一行
 */
export async function appendMilestone(
  ctx: CoreDocCtx,
  chatId: string,
  entry: MilestoneEntry,
): Promise<void> {
  await appendRecentActivity(
    ctx,
    chatId,
    entry.type === 'requirement' ? '需求' : '完成',
    entry.title,
  );
}

/** @deprecated 改用 rewriteBlockers + appendRecentActivity */
export async function appendBlocker(
  ctx: CoreDocCtx,
  chatId: string,
  entry: BlockerEntry,
): Promise<void> {
  await appendRecentActivity(ctx, chatId, '阻塞', entry.title);
}

// re-export BitableRow 让 prompts/skills 用得方便
export type { ArchiveLink, BitableRow };
