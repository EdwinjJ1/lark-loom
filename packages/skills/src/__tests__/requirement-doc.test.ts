import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requirementDocSkill } from '../requirement-doc.js';
import { ok, err, makeError, ErrorCode } from '@seedhac/contracts';
import type {
  BotEvent,
  BotRuntime,
  Card,
  CardBuilder,
  LLMClient,
  Message,
  SkillContext,
} from '@seedhac/contracts';

// ─── helpers ──────────────────────────────────────────────────────────────────

let MSG_SEQ = 0;
function makeMessage(text: string, overrides: Partial<Message> = {}): Message {
  MSG_SEQ += 1;
  return {
    messageId: `msg_${String(MSG_SEQ).padStart(3, '0')}`,
    chatId: 'oc_chat_001',
    chatType: 'group',
    sender: { userId: 'ou_user_001', name: '张三' },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: 1_700_000_000_000 + MSG_SEQ * 1000,
    ...overrides,
  };
}

function makeEvent(text: string): BotEvent {
  return { type: 'message', payload: makeMessage(text) };
}

const MOCK_DOC = {
  title: '飞书智能助手 PRD',
  background: '群协作信息散落，需要一个 Bot 把对话织成结构化产出。',
  goals: ['自动整理需求', '主动浮信息', '生成演示文稿'],
  scope: '只覆盖群聊场景，不监听 1v1 私聊。',
  deliverables: ['需求文档', '分工表格', 'PPT 初稿'],
};

const MOCK_DOC_REF = { docToken: 'doxcnFAKE', url: 'https://example.feishu.cn/docx/doxcnFAKE' };
const MOCK_CARD: Card = { templateName: 'docPush', content: { built: true } };

// ─── 4 种典型输入场景 ─────────────────────────────────────────────────────────

/** 场景 1：单条消息直接说出需求 */
const SCENARIO_SINGLE: readonly Message[] = [
  makeMessage(
    '以下是项目需求：要做一个住在群里的 AI Bot，自动整理对话生成需求文档与分工表格，目标用户是项目经理，本月内交付 MVP。',
    { sender: { userId: 'ou_pm', name: '产品经理' } },
  ),
];

/** 场景 2：多轮对话，逐步澄清需求 */
const SCENARIO_MULTI_TURN: readonly Message[] = [
  makeMessage('我们想做一个项目协作助手', { sender: { userId: 'ou_pm', name: '产品经理' } }),
  makeMessage('具体场景是什么？谁用？', { sender: { userId: 'ou_dev', name: '开发' } }),
  makeMessage('就在飞书群里，给项目经理用，要能自动识别群里的讨论生成 PRD 和分工', {
    sender: { userId: 'ou_pm', name: '产品经理' },
  }),
  makeMessage('要支持多端吗？需求文档落地形式是？', {
    sender: { userId: 'ou_dev', name: '开发' },
  }),
  makeMessage(
    '需求文档直接落到飞书 Docx，分工写到多维表格，手机端桌面端都要看。整理一下项目需求吧。',
    { sender: { userId: 'ou_pm', name: '产品经理' } },
  ),
];

/** 场景 3：群里只发了一个文档链接，真实需求在文档里 */
const SCENARIO_DOC_LINK: readonly Message[] = [
  makeMessage('这是项目背景文档：https://feishu.cn/docx/doxcnPRDABCDEF 大家看一下', {
    sender: { userId: 'ou_pm', name: '产品经理' },
  }),
];
const SCENARIO_DOC_LINK_DOCTOKEN = 'doxcnPRDABCDEF';
const SCENARIO_DOC_LINK_BODY = `
项目名称：飞书 AI 项目协作助手
缘由：项目沟通分散在群聊、文档、表格之间，PM 反复同步信息成本高。
目标：自动整理对话为结构化需求；自动生成分工与 DDL；推 PPT 初稿。
范围：只服务飞书群聊；不监听 1v1。
交付物：需求文档、分工表格、PPT 初稿。
`.trim();

/** 场景 4：组合 —— 群里既有讨论也有文档链接 */
const SCENARIO_COMBO: readonly Message[] = [
  makeMessage('我整理了下我们想做的东西', { sender: { userId: 'ou_pm', name: '产品经理' } }),
  makeMessage('https://feishu.cn/wiki/wikiABC123 在这里', {
    sender: { userId: 'ou_pm', name: '产品经理' },
  }),
  makeMessage('@bot 能帮整理成 PRD 吗', { sender: { userId: 'ou_pm', name: '产品经理' } }),
];
const SCENARIO_COMBO_WIKITOKEN = 'wikiABC123';
const SCENARIO_COMBO_WIKI_BODY = '标题：项目方案 v3\n\n（详细需求……）';

// ─── ctx factories ────────────────────────────────────────────────────────────

function makeRuntime(history: readonly Message[]): BotRuntime {
  return {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn(),
    sendCard: vi.fn(),
    patchCard: vi.fn(),
    fetchHistory: vi.fn().mockResolvedValue(ok({ messages: history, hasMore: false })),
  } as unknown as BotRuntime;
}

function makeLLM(doc = MOCK_DOC): LLMClient {
  return {
    ask: vi.fn(),
    chat: vi.fn(),
    askStructured: vi.fn().mockResolvedValue(ok(doc)),
  } as unknown as LLMClient;
}

function makeCardBuilder(): CardBuilder {
  return { build: vi.fn().mockReturnValue(MOCK_CARD) };
}

interface CtxOpts {
  readonly history?: readonly Message[];
  readonly readContentByToken?: Record<string, string>;
  readonly overrides?: Partial<SkillContext>;
}

function makeCtx(event: BotEvent, opts: CtxOpts = {}): SkillContext {
  const history = opts.history ?? [];
  const readContentByToken = opts.readContentByToken ?? {};
  const readContent = vi.fn().mockImplementation(async (token: string) => {
    if (token in readContentByToken) return ok(readContentByToken[token]!);
    return err(makeError(ErrorCode.FEISHU_API_ERROR, `unknown token in test: ${token}`));
  });
  return {
    event,
    runtime: makeRuntime(history),
    llm: makeLLM(),
    bitable: {
      find: vi.fn(),
      insert: vi.fn().mockResolvedValue(ok({ tableId: 't', recordId: 'r' })),
      batchInsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      link: vi.fn(),
    } as unknown as SkillContext['bitable'],
    docx: {
      create: vi.fn(),
      appendBlocks: vi.fn(),
      getShareLink: vi.fn(),
      createFromMarkdown: vi.fn().mockResolvedValue(ok(MOCK_DOC_REF)),
      grantMembersEdit: vi.fn(),
      readContent,
    } as unknown as SkillContext['docx'],
    cardBuilder: makeCardBuilder(),
    retrievers: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...opts.overrides,
  };
}

// ─── match() ──────────────────────────────────────────────────────────────────

describe('requirementDocSkill.match()', () => {
  it('returns true for "以下是.*需求" pattern', () => {
    expect(
      requirementDocSkill.match(makeCtx(makeEvent('以下是我们本次项目的需求，请大家看看'))),
    ).toBe(true);
  });

  it('returns true for explicit "项目需求" / "PRD" / "需求文档"', () => {
    expect(requirementDocSkill.match(makeCtx(makeEvent('整理下项目需求')))).toBe(true);
    expect(requirementDocSkill.match(makeCtx(makeEvent('PRD 初稿在这里')))).toBe(true);
    expect(requirementDocSkill.match(makeCtx(makeEvent('该写需求文档了')))).toBe(true);
  });

  it('returns false for unrelated message (eg 会议纪要)', () => {
    expect(requirementDocSkill.match(makeCtx(makeEvent('今天会议纪要发一下')))).toBe(false);
  });

  it('returns false for non-message event', () => {
    const ctx = makeCtx({
      type: 'botJoinedChat',
      payload: { chatId: 'c1', inviter: { userId: 'u1' }, timestamp: 0 },
    });
    expect(requirementDocSkill.match(ctx)).toBe(false);
  });
});

// ─── run() — 输入形态 1：单条消息 ───────────────────────────────────────────

describe('requirementDocSkill.run() — single message scenario', () => {
  let ctx: SkillContext;
  beforeEach(() => {
    ctx = makeCtx(makeEvent('整理下项目需求'), { history: SCENARIO_SINGLE });
  });

  it('returns docPush card with docType=requirement', async () => {
    const result = await requirementDocSkill.run(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.card?.templateName).toBe('docPush');
    expect(ctx.cardBuilder.build).toHaveBeenCalledWith(
      'docPush',
      expect.objectContaining({
        docType: 'requirement',
        docUrl: MOCK_DOC_REF.url,
        summary: expect.not.stringContaining('参考了'),
      }),
    );
  });

  it('does NOT call docx.readContent when no Feishu URLs in history', async () => {
    await requirementDocSkill.run(ctx);
    expect(ctx.docx.readContent).not.toHaveBeenCalled();
  });

  it('writes memory with type=requirement and docToken', async () => {
    await requirementDocSkill.run(ctx);
    expect(ctx.bitable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'memory',
        row: expect.objectContaining({ type: 'requirement', docToken: MOCK_DOC_REF.docToken }),
      }),
    );
  });
});

// ─── run() — 输入形态 2：多轮对话 ───────────────────────────────────────────

describe('requirementDocSkill.run() — multi-turn conversation scenario', () => {
  it('feeds full multi-turn history into the LLM prompt', async () => {
    const ctx = makeCtx(makeEvent('整理一下项目需求吧'), { history: SCENARIO_MULTI_TURN });
    await requirementDocSkill.run(ctx);

    const [prompt] = (ctx.llm.askStructured as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // 五轮对话的发言人 + 关键内容都进了 prompt
    expect(prompt).toContain('[产品经理]:');
    expect(prompt).toContain('[开发]:');
    expect(prompt).toContain('项目协作助手');
    expect(prompt).toContain('飞书 Docx');
    expect(prompt).toContain('多端');
    // 多轮场景下不包含「关联文档」section
    expect(prompt).not.toContain('关联文档：');
  });
});

// ─── run() — 输入形态 3：仅文档链接 ────────────────────────────────────────

describe('requirementDocSkill.run() — single doc link scenario', () => {
  it('reads the linked doc and includes its body in the LLM prompt', async () => {
    const ctx = makeCtx(makeEvent('这是项目背景文档：https://feishu.cn/docx/doxcnPRDABCDEF'), {
      history: SCENARIO_DOC_LINK,
      readContentByToken: { [SCENARIO_DOC_LINK_DOCTOKEN]: SCENARIO_DOC_LINK_BODY },
    });

    await requirementDocSkill.run(ctx);

    expect(ctx.docx.readContent).toHaveBeenCalledWith(SCENARIO_DOC_LINK_DOCTOKEN, 'doc');

    const [prompt] = (ctx.llm.askStructured as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(prompt).toContain('关联文档：');
    expect(prompt).toContain(SCENARIO_DOC_LINK_BODY.split('\n')[0]!); // 「项目名称：飞书 AI 项目协作助手」
    expect(prompt).toContain('https://feishu.cn/docx/doxcnPRDABCDEF');
  });

  it('docPush summary mentions reference doc count when linked docs were used', async () => {
    const ctx = makeCtx(makeEvent('这是项目背景文档：https://feishu.cn/docx/doxcnPRDABCDEF'), {
      history: SCENARIO_DOC_LINK,
      readContentByToken: { [SCENARIO_DOC_LINK_DOCTOKEN]: SCENARIO_DOC_LINK_BODY },
    });

    await requirementDocSkill.run(ctx);

    expect(ctx.cardBuilder.build).toHaveBeenCalledWith(
      'docPush',
      expect.objectContaining({
        summary: expect.stringContaining('参考了 1 篇关联文档'),
      }),
    );
  });

  it('continues without crashing when a linked doc fails to read', async () => {
    const ctx = makeCtx(makeEvent('这是项目背景文档：https://feishu.cn/docx/doxcnPRDABCDEF'), {
      history: SCENARIO_DOC_LINK,
      // 不在 token map 里 → readContent 返回 err
      readContentByToken: {},
    });

    const result = await requirementDocSkill.run(ctx);
    expect(result.ok).toBe(true);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'requirementDoc: linked doc read failed',
      expect.objectContaining({ token: SCENARIO_DOC_LINK_DOCTOKEN }),
    );
    // LLM 仍被调用（只是没有 linkedDocs）
    expect(ctx.llm.askStructured).toHaveBeenCalled();
  });
});

// ─── run() — 输入形态 4：聊天 + 文档链接 组合 ──────────────────────────────

describe('requirementDocSkill.run() — combo (chat + linked wiki) scenario', () => {
  it('feeds both chat history and wiki body into the prompt', async () => {
    const ctx = makeCtx(makeEvent('@bot 能帮整理成 PRD 吗'), {
      history: SCENARIO_COMBO,
      readContentByToken: { [SCENARIO_COMBO_WIKITOKEN]: SCENARIO_COMBO_WIKI_BODY },
    });

    await requirementDocSkill.run(ctx);

    expect(ctx.docx.readContent).toHaveBeenCalledWith(SCENARIO_COMBO_WIKITOKEN, 'wiki');

    const [prompt] = (ctx.llm.askStructured as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // 聊天部分
    expect(prompt).toContain('我整理了下我们想做的东西');
    expect(prompt).toContain('@bot 能帮整理成 PRD 吗');
    // wiki 正文
    expect(prompt).toContain('关联文档：');
    expect(prompt).toContain('项目方案 v3');
  });
});

// ─── run() — 错误路径 ───────────────────────────────────────────────────────

describe('requirementDocSkill.run() — error paths', () => {
  it('returns err when fetchHistory fails; LLM and docx not called', async () => {
    const ctx = makeCtx(makeEvent('整理下项目需求'), {
      overrides: {
        runtime: {
          on: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          sendText: vi.fn(),
          sendCard: vi.fn(),
          patchCard: vi.fn(),
          fetchHistory: vi
            .fn()
            .mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'history fetch failed'))),
        } as unknown as BotRuntime,
      },
    });

    const result = await requirementDocSkill.run(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.FEISHU_API_ERROR);
    expect(ctx.llm.askStructured).not.toHaveBeenCalled();
    expect(ctx.docx.createFromMarkdown).not.toHaveBeenCalled();
  });

  it('returns err when LLM fails; docx.createFromMarkdown not called', async () => {
    const ctx = makeCtx(makeEvent('整理下项目需求'), {
      history: SCENARIO_SINGLE,
      overrides: {
        llm: {
          ask: vi.fn(),
          chat: vi.fn(),
          askStructured: vi
            .fn()
            .mockResolvedValue(err(makeError(ErrorCode.LLM_TIMEOUT, 'llm timed out'))),
        } as unknown as LLMClient,
      },
    });

    const result = await requirementDocSkill.run(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.LLM_TIMEOUT);
    expect(ctx.docx.createFromMarkdown).not.toHaveBeenCalled();
    expect(ctx.bitable.insert).not.toHaveBeenCalled();
    expect(ctx.cardBuilder.build).not.toHaveBeenCalled();
  });

  it('returns err when docx.createFromMarkdown fails; memory not written, card not built', async () => {
    const ctx = makeCtx(makeEvent('整理下项目需求'), {
      history: SCENARIO_SINGLE,
      overrides: {
        docx: {
          create: vi.fn(),
          appendBlocks: vi.fn(),
          getShareLink: vi.fn(),
          readContent: vi.fn(),
          createFromMarkdown: vi
            .fn()
            .mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'docx create failed'))),
          grantMembersEdit: vi.fn(),
        } as unknown as SkillContext['docx'],
      },
    });

    const result = await requirementDocSkill.run(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.FEISHU_API_ERROR);
    expect(ctx.bitable.insert).not.toHaveBeenCalled();
    expect(ctx.cardBuilder.build).not.toHaveBeenCalled();
  });

  it('still returns ok when bitable.insert fails (degrades gracefully)', async () => {
    const ctx = makeCtx(makeEvent('整理下项目需求'), {
      history: SCENARIO_SINGLE,
      overrides: {
        bitable: {
          find: vi.fn(),
          insert: vi
            .fn()
            .mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'bitable down'))),
          batchInsert: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          link: vi.fn(),
        } as unknown as SkillContext['bitable'],
      },
    });

    const result = await requirementDocSkill.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'requirementDoc: insert memory failed',
      expect.objectContaining({ code: ErrorCode.FEISHU_API_ERROR }),
    );
  });
});
