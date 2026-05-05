/**
 * requirementDoc — 需求文档自动生成
 *
 * 触发：被动监听，群里出现项目需求描述时自动整理成结构化飞书文档
 * 数据流：
 *   群历史消息 (+ 命中的飞书 doc/wiki 正文) → LLM 结构化提取
 *   → 创建飞书文档 → 推 docPush 卡片 → 存入 memory
 *
 * 真实输入形态都覆盖：
 *   1) 单条消息直接说需求
 *   2) 多轮对话逐步澄清
 *   3) 群里只发了一个文档链接（真实需求在文档里）
 *   4) 上述组合
 */

import type { Message, Skill, SkillContext } from '@seedhac/contracts';
import { err, ok } from '@seedhac/contracts';
import {
  REQ_PROMPT,
  RequirementDocSchema,
  renderRequirementDocMarkdown,
  parseFeishuDocUrls,
  type LinkedDocSnippet,
} from './prompts/requirement-doc.js';

const TRIGGER_RE = /项目需求|需求文档|PRD|产品需求|以下是.*需求|这是.*项目|项目背景|项目目标/i;

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
    description: '检测到需求描述时自动生成结构化飞书文档（支持单条 / 多轮 / 文档链接 / 组合）',
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

    // a. 拉取最近上下文
    ctx.logger.info('requirementDoc: fetching chat history', { chatId });
    const historyResult = await ctx.runtime.fetchHistory({ chatId, pageSize: 20 });
    if (!historyResult.ok) return err(historyResult.error);
    const history = historyResult.value.messages;

    // b. 抽取并读取群里出现的飞书文档（如果有）
    const linkedDocs = await fetchLinkedDocs(ctx, history);

    // c. LLM 结构化提取（history + linkedDocs 都喂给模型）
    ctx.logger.info('requirementDoc: asking LLM for structured extraction', {
      historyCount: history.length,
      linkedDocCount: linkedDocs.length,
    });
    const docResult = await ctx.llm.askStructured(
      REQ_PROMPT(history, linkedDocs),
      RequirementDocSchema,
      { model: 'pro' },
    );
    if (!docResult.ok) return err(docResult.error);
    const doc = docResult.value;

    // d. 序列化 markdown + 创建飞书文档
    const markdown = renderRequirementDocMarkdown(doc);
    ctx.logger.info('requirementDoc: creating feishu doc', {
      title: doc.title,
      goalCount: doc.goals.length,
      deliverableCount: doc.deliverables.length,
    });
    const fileResult = await ctx.docx.createFromMarkdown(doc.title, markdown);
    if (!fileResult.ok) return err(fileResult.error);

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

    // f. 推 docPush 卡片
    const card = ctx.cardBuilder.build('docPush', {
      docTitle: doc.title,
      docUrl: fileResult.value.url,
      docType: 'requirement',
      summary: `已整理 ${doc.goals.length} 个目标、${doc.deliverables.length} 个交付物${
        linkedDocs.length ? `（参考了 ${linkedDocs.length} 篇关联文档）` : ''
      }`,
    });

    return ok({
      card,
      reasoning: `检测到需求描述，基于 ${history.length} 条群聊记录${
        linkedDocs.length ? ` + ${linkedDocs.length} 篇关联文档` : ''
      }生成需求文档「${doc.title}」`,
    });
  },
};
