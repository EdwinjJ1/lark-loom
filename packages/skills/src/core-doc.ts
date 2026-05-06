/**
 * 项目核心文档 helper（issue #120）
 *
 * 设计原则：
 *   1. **Append-only** —— 永远不修改已有 entry，决策推翻就 append [Supersedes Dxx]
 *   2. **Per-entry 模板拼接** —— 不过 LLM，所有 entry 字段从 skill 已有数据直接来
 *      （decision 表 content / 完成产出 URL / pending todo 内容），杜绝额外幻觉源
 *   3. **失败仅 warn** —— 找不到核心文档 / appendToSection 失败都不阻塞 skill 主流程
 *
 * Section 映射：
 *   - 决策 → "决策日志"
 *   - 里程碑 → "项目里程碑"
 *   - 阻塞 → "阻塞与风险"
 *   - 同步：每条 entry 同时往"完整时间线"末尾 append 一行
 */

import type { BitableClient, DocBlock, DocxClient } from '@seedhac/contracts';

export interface CoreDocCtx {
  readonly bitable: BitableClient;
  readonly docx: DocxClient;
  readonly logger: { warn(msg: string, meta?: Record<string, unknown>): void; info(msg: string, meta?: Record<string, unknown>): void };
}

export interface DecisionEntry {
  readonly title: string;
  readonly source?: string;
  readonly supersedes?: string;
}

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

// 注意：`[^\s)>]*`（不是 `+`）—— 必须允许域名前 0 字符，否则
// `https://feishu.cn/...`（无 tenant 子域）不会被匹配。
const FEISHU_URL_RE =
  /https?:\/\/[^\s)>]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)[^\s)>]*/;

/**
 * 从 memory 找到当前 chatId 的核心文档 docToken。找不到返回 null。
 *
 * 健壮性：先用 server-side filter 试一次，若 0 条命中则 fallback 到 client-side
 * filter（防止 feishu bitable 列名 / 大小写差异导致 server filter 不工作）。
 */
export async function findCoreDocToken(
  ctx: CoreDocCtx,
  chatId: string,
): Promise<string | null> {
  // 第一次：server-side filter，pageSize 100
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

  // Fallback：server filter 完全 0 条记录 → 怀疑 filter 失效（列名不对 / 大小写
  // 等），再拉一次不带 filter 的全量 + 客户端过滤。
  // server filter 有记录但 0 个 [核心文档] → 真的没核心文档，不 fallback。
  if (records.length === 0) {
    const allRes = await ctx.bitable.find({ table: 'memory', pageSize: 200 });
    if (allRes.ok) {
      records = allRes.value.records.filter((r) => String(r['chat_id'] ?? '') === chatId);
      candidates = records.filter((r) => /^\[核心文档\]/.test(String(r['content'] ?? '')));
      ctx.logger.info('core-doc: findCoreDocToken client fallback', {
        chatId,
        totalAllRecords: allRes.value.records.length,
        matchedChatId: records.length,
        coreDocCandidates: candidates.length,
        sampleContents: records.slice(0, 3).map((r) => String(r['content'] ?? '').slice(0, 60)),
      });
    } else {
      ctx.logger.warn('core-doc: fallback memory.find failed', {
        error: allRes.error.message,
      });
    }
  } else {
    ctx.logger.info('core-doc: findCoreDocToken server filter', {
      chatId,
      totalRecords: records.length,
      coreDocCandidates: candidates.length,
      sampleContents:
        candidates.length === 0
          ? records.slice(0, 3).map((r) => String(r['content'] ?? '').slice(0, 60))
          : undefined,
    });
  }

  if (candidates.length === 0) return null;

  // 取最新的 [核心文档]（按 created_at 倒序）
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

/**
 * 同时往 "完整时间线" 段 append 一行 timeline entry。
 * 失败仅 warn —— 时间线是辅助视图，主 section 已经记了。
 */
async function appendTimeline(
  ctx: CoreDocCtx,
  docToken: string,
  type: '决策' | '完成' | '需求' | '阻塞',
  title: string,
  now: number,
): Promise<void> {
  const block: DocBlock = {
    type: 'bullet',
    text: `${formatTime(now)} [${type}] ${title}`,
  };
  const res = await ctx.docx.appendToSection(docToken, '完整时间线', [block]);
  if (!res.ok) {
    ctx.logger.warn('core-doc: appendTimeline failed', { error: res.error.message });
  }
}

/** 决策 → "决策日志" + 时间线。失败仅 warn。 */
export async function appendDecision(
  ctx: CoreDocCtx,
  chatId: string,
  entry: DecisionEntry,
): Promise<void> {
  const docToken = await findCoreDocToken(ctx, chatId);
  if (!docToken) {
    ctx.logger.info('core-doc: no core doc found, skip appendDecision', { chatId });
    return;
  }
  const now = Date.now();
  const supersedesPart = entry.supersedes ? ` [Supersedes ${entry.supersedes}]` : '';
  const sourcePart = entry.source ? ` · 来源：${entry.source}` : '';
  const line: DocBlock = {
    type: 'bullet',
    text: `${formatTime(now)} — ${entry.title}${supersedesPart}${sourcePart}`,
  };
  const res = await ctx.docx.appendToSection(docToken, '决策日志', [line]);
  if (!res.ok) {
    ctx.logger.warn('core-doc: appendDecision failed', { error: res.error.message });
    return;
  }
  await appendTimeline(ctx, docToken, '决策', entry.title, now);
}

/** 里程碑 → "项目里程碑" + 时间线。type 区分 [需求]/[完成]。 */
export async function appendMilestone(
  ctx: CoreDocCtx,
  chatId: string,
  entry: MilestoneEntry,
): Promise<void> {
  const docToken = await findCoreDocToken(ctx, chatId);
  if (!docToken) {
    ctx.logger.info('core-doc: no core doc found, skip appendMilestone', { chatId });
    return;
  }
  const now = Date.now();
  const urlPart = entry.url ? `: ${entry.url}` : '';
  const sourcePart = entry.source ? ` · 来源：${entry.source}` : '';
  const line: DocBlock = {
    type: 'bullet',
    text: `${formatTime(now)} — ${entry.title}${urlPart}${sourcePart}`,
  };
  const res = await ctx.docx.appendToSection(docToken, '项目里程碑', [line]);
  if (!res.ok) {
    ctx.logger.warn('core-doc: appendMilestone failed', { error: res.error.message });
    return;
  }
  const tlType = entry.type === 'requirement' ? '需求' : '完成';
  await appendTimeline(ctx, docToken, tlType, entry.title, now);
}

/** 阻塞 → "阻塞与风险" + 时间线。 */
export async function appendBlocker(
  ctx: CoreDocCtx,
  chatId: string,
  entry: BlockerEntry,
): Promise<void> {
  const docToken = await findCoreDocToken(ctx, chatId);
  if (!docToken) {
    ctx.logger.info('core-doc: no core doc found, skip appendBlocker', { chatId });
    return;
  }
  const now = Date.now();
  const sourcePart = entry.source ? ` · 来源：${entry.source}` : '';
  const line: DocBlock = {
    type: 'bullet',
    text: `${formatTime(now)} — ${entry.title} [Open]${sourcePart}`,
  };
  const res = await ctx.docx.appendToSection(docToken, '阻塞与风险', [line]);
  if (!res.ok) {
    ctx.logger.warn('core-doc: appendBlocker failed', { error: res.error.message });
    return;
  }
  await appendTimeline(ctx, docToken, '阻塞', entry.title, now);
}
