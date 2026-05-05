/**
 * requirementDoc — 需求文档自动生成
 *
 * 触发：被动监听，群里出现项目需求描述时自动整理成结构化飞书文档
 * 数据流：
 *   群历史消息 → 展开合并转发 → 抽飞书 doc/wiki 正文
 *   → LLM lite 相关性预筛（仅历史；linkedDocs 100% 保留）
 *   → LLM pro 结构化提取 → 创建飞书文档 → 推 docPush 卡片 → 写 memory
 *
 * 真实输入形态都覆盖：
 *   1) 单条消息直接说需求
 *   2) 多轮对话逐步澄清
 *   3) 群里只发了一个文档链接（真实需求在文档里）
 *   4) 合并转发卡片（嵌套子消息可能含 doc URL）
 *   5) 上述组合
 */

import type { Message, Skill, SkillContext } from '@seedhac/contracts';
import { err, ok } from '@seedhac/contracts';
import {
  REQ_PROMPT,
  RELEVANCE_PROMPT,
  RelevanceJudgmentSchema,
  RequirementDocSchema,
  renderRequirementDocMarkdown,
  parseFeishuDocUrls,
  type LinkedDocSnippet,
  type RelevanceCandidate,
} from './prompts/requirement-doc.js';

// 与 packages/bot/src/skill-router.ts 的 requirementDoc 规则保持同步：
//   - 「项目」与「需求」中间最多隔 3 字，覆盖「项目的需求 / 项目本次需求」
//   - 「以下是 / 以上是 / 下面是 / 上面是 ... 需求」
//   - 「这是 / 这就是 ... 项目」
//   - 显式段落标题「项目背景 / 项目目标 / 项目范围」
const TRIGGER_RE =
  /项目.{0,3}需求|需求文档|功能需求|产品需求|PRD|(?:以下|以上|下面|上面)是?.{0,12}需求|这(?:就)?是.{0,8}项目|项目(?:背景|目标|范围)/i;

/**
 * 把历史消息里的「合并转发」展开：调 runtime.fetchMessage 拿父 + 嵌套子，
 * 用嵌套子（仅文本）替换掉父消息原位。失败时保留父原样并 logger.warn。
 *
 * 同时返回 forwardedIds —— 所有被转发进来的子消息 messageId。这些消息是
 * 用户**主动转发的显式输入**（跟贴 wiki 链接同语义），不应该被相关性预筛过滤掉。
 */
async function expandMergeForward(
  ctx: SkillContext,
  history: readonly Message[],
): Promise<{ messages: readonly Message[]; forwardedIds: Set<string> }> {
  const out: Message[] = [];
  const forwardedIds = new Set<string>();
  for (const m of history) {
    if ((m.contentType as string) !== 'merge_forward') {
      out.push(m);
      continue;
    }
    ctx.logger.info('requirementDoc: expanding merge_forward', { messageId: m.messageId });
    const fetched = await ctx.runtime.fetchMessage(m.messageId);
    if (!fetched.ok) {
      ctx.logger.warn('requirementDoc: fetchMessage failed for merge_forward; keeping as-is', {
        messageId: m.messageId,
        code: fetched.error.code,
        message: fetched.error.message,
      });
      out.push(m);
      continue;
    }
    // fetched.messages: 第 1 条是父（merge_forward 自身），后面是平铺的嵌套子
    const children = fetched.value.messages.filter(
      (c) => (c.contentType as string) === 'text' && c.text.trim().length > 0,
    );
    if (children.length === 0) {
      ctx.logger.warn('requirementDoc: merge_forward had no text children; keeping as-is', {
        messageId: m.messageId,
      });
      out.push(m);
      continue;
    }
    ctx.logger.info('requirementDoc: merge_forward expanded', {
      messageId: m.messageId,
      childCount: children.length,
    });
    for (const child of children) {
      out.push(child);
      forwardedIds.add(child.messageId);
    }
  }
  return { messages: out, forwardedIds };
}

function summarize(value: string, max = 200): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 用 lite 模型对历史消息做相关性预筛 —— 群里可能掺多个项目讨论。
 *
 * Tier-1 显式输入（用户主动提供的内容）100% 保留，不进 lite 预筛：
 *   - linkedDocs: 用户贴/转发进来的飞书文档
 *   - forwardedIds: 用户合并转发进来的聊天记录子消息（同等显式输入语义）
 *
 * 只有「群里**原本就有**的非转发消息」才走 lite 相关性筛。
 */
async function filterByRelevance(
  ctx: SkillContext,
  trigger: Message,
  history: readonly Message[],
  linkedDocs: readonly LinkedDocSnippet[],
  forwardedIds: ReadonlySet<string>,
): Promise<{ history: readonly Message[]; linkedDocs: readonly LinkedDocSnippet[] }> {
  // 拆成「转发进来必保留」和「群里原生消息走筛」两组
  const forwarded = history.filter((m) => forwardedIds.has(m.messageId));
  const natives = history.filter((m) => !forwardedIds.has(m.messageId));

  if (natives.length === 0) {
    return { history, linkedDocs };
  }

  const candidates: RelevanceCandidate[] = natives.map((m, i) => ({
    id: `m${i}`,
    kind: 'message',
    excerpt: `[${m.sender.name ?? m.sender.userId}] ${summarize(m.text, 200)}`,
  }));

  ctx.logger.info('requirementDoc: relevance pre-filter', {
    nativeCount: natives.length,
    forwardedCount: forwarded.length,
    linkedDocCount: linkedDocs.length,
    note: 'forwarded + linkedDocs are always kept; lite filter only judges native messages',
  });

  const judgmentResult = await ctx.llm.askStructured(
    RELEVANCE_PROMPT(trigger.text, candidates),
    RelevanceJudgmentSchema,
    { model: 'lite', timeoutMs: 30_000 },
  );

  if (!judgmentResult.ok) {
    // 预筛挂掉不致命，退回全量原生消息
    ctx.logger.warn('requirementDoc: relevance filter failed, falling back to full context', {
      code: judgmentResult.error.code,
      message: judgmentResult.error.message,
    });
    return { history, linkedDocs };
  }

  if (judgmentResult.value.results.length === 0) {
    ctx.logger.warn('requirementDoc: relevance filter returned empty, skipping filter');
    return { history, linkedDocs };
  }

  const keepIds = new Set(judgmentResult.value.results.filter((r) => r.keep).map((r) => r.id));
  const keptNatives = natives.filter((_, i) => keepIds.has(`m${i}`));

  // 把「保留的原生」+「全部 forwarded」按 history 原顺序组合，保证时间序正确
  const keptHistory = history.filter(
    (m) => forwardedIds.has(m.messageId) || keptNatives.includes(m),
  );

  ctx.logger.info('requirementDoc: relevance pre-filter done', {
    nativeKept: `${keptNatives.length}/${natives.length}`,
    forwardedKept: `${forwarded.length}/${forwarded.length} (always kept)`,
    linkedDocKept: `${linkedDocs.length}/${linkedDocs.length} (always kept)`,
  });

  return { history: keptHistory, linkedDocs };
}

async function fetchLinkedDocs(
  ctx: SkillContext,
  messages: readonly Message[],
): Promise<LinkedDocSnippet[]> {
  const urls = parseFeishuDocUrls(messages);
  if (urls.length === 0) return [];

  ctx.logger.info('requirementDoc: found feishu doc/wiki links in history', {
    count: urls.length,
    samples: urls.map((u) => ({ kind: u.kind, token: u.token })),
  });

  const snippets: LinkedDocSnippet[] = [];
  for (const u of urls) {
    const res = await ctx.docx.readContent(u.token, u.kind);
    if (!res.ok) {
      ctx.logger.warn('requirementDoc: linked doc read failed', {
        kind: u.kind,
        token: u.token,
        code: res.error.code,
        message: res.error.message,
      });
      continue;
    }
    const trimmed = res.value.trim();
    if (!trimmed) {
      ctx.logger.warn('requirementDoc: linked doc empty', { kind: u.kind, token: u.token });
      continue;
    }
    snippets.push({ kind: u.kind, url: u.url, content: trimmed });
  }
  return snippets;
}

export const requirementDocSkill: Skill = {
  name: 'requirementDoc',
  metadata: {
    description: '把项目需求描述整理为结构化需求文档。',
    when_to_use: '群里出现项目背景、PRD、功能需求、产品需求，且需要沉淀成文档时使用。',
    examples: ['这是项目需求，请整理', '我们要写 PRD', '@bot 根据这段背景生成需求文档'],
  },
  trigger: {
    events: ['message'],
    requireMention: false,
    keywords: ['项目需求', '需求文档', 'PRD', '产品需求', '项目背景'],
    description: '检测到需求描述时自动生成结构化飞书文档（支持单条 / 多轮 / 文档链接 / 合并转发 / 组合）',
  },
  match: (ctx) => {
    if (ctx.event.type !== 'message') return false;
    return TRIGGER_RE.test(ctx.event.payload.text);
  },
  run: async (ctx) => {
    if (ctx.event.type !== 'message') {
      return ok({ text: '' });
    }
    const msg = ctx.event.payload as Message;
    const chatId = msg.chatId;

    // 0. 立刻发一张 loading 卡片占位，让用户知道 bot 收到了 + 大约多久
    //    跑完后用 patchCard 替换成终态卡片。中途任何失败都会 patch 成 error 卡片，
    //    避免「文档生成中…」永远卡住。
    const loadingCard = ctx.cardBuilder.build('docPush', {
      docTitle: '需求文档',
      docUrl: '',
      docType: 'requirement',
      isLoading: true,
      etaSeconds: 60,
    });
    const loadingSent = await ctx.runtime.sendCard({ chatId, card: loadingCard });
    if (!loadingSent.ok) {
      // loading 卡片都发不出去，没必要继续跑后面的链路
      return err(loadingSent.error);
    }
    const loadingMessageId = loadingSent.value.messageId;

    // patchToError —— 任何中间步骤失败时把 loading 卡片替换成失败卡片
    const patchToError = async (title: string, message: string): Promise<void> => {
      const errCard = ctx.cardBuilder.build('docPush', {
        docTitle: title,
        docUrl: '',
        docType: 'requirement',
        errorMessage: message,
      });
      const patchRes = await ctx.runtime.patchCard({ messageId: loadingMessageId, card: errCard });
      if (!patchRes.ok) {
        ctx.logger.warn('requirementDoc: patch error card failed', {
          code: patchRes.error.code,
          message: patchRes.error.message,
        });
      }
    };

    // a. 拉最近 20 条历史
    ctx.logger.info('requirementDoc: fetching chat history', { chatId });
    const historyResult = await ctx.runtime.fetchHistory({ chatId, pageSize: 20 });
    if (!historyResult.ok) {
      await patchToError('需求文档', `拉群历史失败：${historyResult.error.message}`);
      return err(historyResult.error);
    }
    const historyRaw = historyResult.value.messages;

    // a2. 展开合并转发：父原位替换为嵌套子消息，同时记录哪些是转发进来的
    const { messages: historyExpanded, forwardedIds } = await expandMergeForward(ctx, historyRaw);

    // a3. 抽取并读取飞书文档（doc / wiki / 嵌套子里的 URL 也会被找到）
    const linkedDocsAll = await fetchLinkedDocs(ctx, historyExpanded);

    // b. lite 模型相关性预筛历史
    //    - linkedDocs 100% 保留（用户主动贴的）
    //    - forwarded 子消息 100% 保留（用户主动转发的，同等语义）
    //    - 仅群里原生非转发消息走 lite 筛
    const { history, linkedDocs } = await filterByRelevance(
      ctx,
      msg,
      historyExpanded,
      linkedDocsAll,
      forwardedIds,
    );

    // c. pro 模型主提取
    ctx.logger.info('requirementDoc: asking LLM for structured extraction', {
      historyCount: history.length,
      linkedDocCount: linkedDocs.length,
    });
    // 把保留下来的 forwarded 子消息抽出来，作为 Tier-1 显式输入塞进 prompt
    const forwardedTexts = history
      .filter((m) => forwardedIds.has(m.messageId))
      .map((m) => m.text);

    const docResult = await ctx.llm.askStructured(
      REQ_PROMPT(history, linkedDocs, forwardedTexts),
      RequirementDocSchema,
      // pro 模型默认超时 30s 不够：拉了多条历史 + 文档正文，prompt 偏长，35–60s 是常态
      { model: 'pro', timeoutMs: 90_000 },
    );
    if (!docResult.ok) {
      await patchToError('需求文档', `LLM 提取失败：${docResult.error.message}`);
      return err(docResult.error);
    }
    const doc = docResult.value;

    // d. 序列化 markdown + 创建飞书文档
    const markdown = renderRequirementDocMarkdown(doc);
    ctx.logger.info('requirementDoc: creating feishu doc', {
      title: doc.title,
      goalCount: doc.goals.length,
      deliverableCount: doc.deliverables.length,
    });
    const fileResult = await ctx.docx.createFromMarkdown(doc.title, markdown);
    if (!fileResult.ok) {
      await patchToError(doc.title, `创建飞书文档失败：${fileResult.error.message}`);
      return err(fileResult.error);
    }

    // d2. 给当前群成员授「可编辑」权限。
    //     bot 用 SDK 创建 docx 时默认只有 bot 自己有权限，群成员点开按钮看到的是
    //     无权限文档。补这一步对齐 slides skill 的行为。失败仅 warn 不阻断。
    const membersRes = await ctx.runtime.fetchMembers({ chatId });
    if (membersRes.ok && membersRes.value.members.length > 0) {
      const memberIds = membersRes.value.members.map((m) => m.userId);
      const grantRes = await ctx.docx.grantMembersEdit(
        fileResult.value.docToken,
        'docx',
        memberIds,
      );
      if (!grantRes.ok) {
        ctx.logger.warn('requirementDoc: grant members edit failed', {
          code: grantRes.error.code,
          message: grantRes.error.message,
        });
      } else {
        ctx.logger.info('requirementDoc: granted members edit', {
          memberCount: memberIds.length,
        });
      }
    } else if (!membersRes.ok) {
      ctx.logger.warn('requirementDoc: fetchMembers failed; skip granting edit', {
        code: membersRes.error.code,
        message: membersRes.error.message,
      });
    }

    // e. 写 memory（失败仅 warn，不阻断卡片输出）
    const memRes = await ctx.bitable.insert({
      table: 'memory',
      row: {
        chatId,
        type: 'requirement',
        docToken: fileResult.value.docToken,
        content: doc.title,
        timestamp: Date.now(),
      },
    });
    if (!memRes.ok) {
      ctx.logger.warn('requirementDoc: insert memory failed', {
        code: memRes.error.code,
        message: memRes.error.message,
      });
    }

    // f. patch loading 卡片为最终 docPush 卡片
    const finalCard = ctx.cardBuilder.build('docPush', {
      docTitle: doc.title,
      docUrl: fileResult.value.url,
      docType: 'requirement',
      summary: `已整理 ${doc.goals.length} 个目标、${doc.deliverables.length} 个交付物${
        linkedDocs.length ? `（参考了 ${linkedDocs.length} 篇关联文档）` : ''
      }`,
    });
    const patchRes = await ctx.runtime.patchCard({
      messageId: loadingMessageId,
      card: finalCard,
    });
    if (!patchRes.ok) {
      ctx.logger.warn('requirementDoc: patch final card failed; final card not visible', {
        code: patchRes.error.code,
        message: patchRes.error.message,
      });
    }

    // 不再返回 card —— 已经通过 patchCard 替换 loading 卡片，wiring 不需要再发一条
    return ok({
      reasoning: `检测到需求描述，基于 ${history.length} 条群聊记录${
        linkedDocs.length ? ` + ${linkedDocs.length} 篇关联文档` : ''
      }生成需求文档「${doc.title}」`,
    });
  },
};
