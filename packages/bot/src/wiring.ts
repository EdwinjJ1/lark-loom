import type {
  ChatMessage,
  LLMClient,
  LLMTool,
  Skill,
  SkillContext,
  SkillName,
  ToolCall,
  ToolResult,
} from '@seedhac/contracts';
import type { Message } from '@seedhac/contracts';
import type { RouteIntent } from './skill-router.js';
import type { SkillRouter } from './skill-router.js';
import type { IMemoryStore } from './memory/memory-store.js';
import { getLLMTools, makeExecutor } from './memory/tool-handlers.js';
import type { SystemPromptCache } from './memory/system-prompt.js';
import { handleBotJoinedChat, handleOnboardingAction } from './onboarding.js';

export const intentToSkill: Partial<Record<RouteIntent, SkillName>> = {
  qa: 'qa',
  meetingNotes: 'summary',
  slides: 'slides',
  requirementDoc: 'requirementDoc',
};

/**
 * 这些 intent 没有对应 skill，但仍要把消息写进 bitable.memory，
 * 供后续 qa / docIterate / recall 检索。fire-and-forget，失败仅 warn。
 */
const SIDE_EFFECT_INTENTS = new Set<RouteIntent>(['taskAssignment', 'progressUpdate']);

export interface HarnessConfig {
  readonly promptCache: SystemPromptCache;
  readonly memoryStore: IMemoryStore;
  readonly docsRoot: string;
  /** 机器人自身的 open_id，用于判断消息是否 @bot */
  readonly botOpenId: string;
}

type HarnessDecision = {
  readonly skill: SkillName | 'silent';
  readonly reason?: string;
  readonly args?: Record<string, unknown>;
};

export async function handleEvent(
  ctx: SkillContext,
  router: SkillRouter,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
  harness?: HarnessConfig,
): Promise<void> {
  const { event, logger } = ctx;
  if (event.type === 'cardAction') {
    await handleCardAction(ctx, skills);
    return;
  }
  if (event.type === 'schedule') {
    await handleSchedule(ctx, skills);
    return;
  }
  // bot 入群 → 立刻发 onboarding 卡（issue #98 数据使用告知 + 启用按钮）
  if (event.type === 'botJoinedChat') {
    await handleBotJoinedChat(ctx, {
      chatId: event.payload.chatId,
      inviterUserId: event.payload.inviter.userId,
    });
    return;
  }
  if (event.type !== 'message') return;

  const msg = event.payload;
  const isMention = msg.mentions.some((m) => m.user.userId === harness?.botOpenId);

  // @mention 消息走 Harness：chatWithTools 让模型按需调 memory/skill 工具
  if (harness && isMention) {
    const handled = await handleWithHarness(ctx, msg, skills, harness);
    if (handled) return;
    logger.warn('harness fell back to SkillRouter', { chatId: msg.chatId });
    await handleWithSkillRouter(withFallbackSystemPrompt(ctx, harness), router, skills);
    return;
  }

  // 非 @mention：原有 Skill 路由 + 被动 memory 观察（并行，不阻塞）
  if (harness && shouldObservePassively(msg.text)) {
    void handlePassiveObserve(ctx, msg, harness).catch((e) => {
      logger.warn('passive observe threw', {
        chatId: msg.chatId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }
  await handleWithSkillRouter(ctx, router, skills);
}

async function handleWithSkillRouter(
  ctx: SkillContext,
  router: SkillRouter,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): Promise<void> {
  const { event, logger } = ctx;
  if (event.type !== 'message') return;
  const msg = event.payload;
  const intent = router.route(msg);

  // taskAssignment / progressUpdate 没对应 skill，但仍把消息写进 memory 表，
  // 供后续 qa / docIterate / recall 检索。fire-and-forget。
  // 必须同时挂 .then() 和 .catch()：底层网络/认证异常时 bitable.insert
  // 可能直接 reject 而不是返回 err Result，没 .catch() 会触发
  // unhandled rejection（Node 18+ 默认 --unhandled-rejections=strict 会终止进程）。
  if (SIDE_EFFECT_INTENTS.has(intent)) {
    void ctx.bitable
      .insert({
        table: 'memory',
        row: {
          chatId: msg.chatId,
          type: intent,
          content: msg.text,
          timestamp: Date.now(),
        },
      })
      .then((res) => {
        if (!res.ok) {
          logger.warn('bitable insert failed', {
            intent,
            code: res.error.code,
            message: res.error.message,
          });
        }
      })
      .catch((e: unknown) => {
        logger.warn('bitable insert threw', {
          intent,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return;
  }

  const skillName = intentToSkill[intent];
  if (!skillName) return;
  const skill = skills[skillName];
  if (!skill) return;
  if (!(await skill.match(ctx))) return;
  await runSkill(ctx, skill);
}

async function runSkill(ctx: SkillContext, skill: Skill): Promise<void> {
  const { logger, runtime } = ctx;
  const result = await skill.run(ctx);
  if (!result.ok) {
    logger.error('skill failed', {
      skill: skill.name,
      code: result.error.code,
      message: result.error.message,
    });
    return;
  }
  writeSkillMemory(ctx, skill, result.value);
  const chatId = deliveryChatId(ctx);
  if (!chatId) return;
  const { card, text } = result.value;
  if (card) {
    const sendResult = await runtime.sendCard({ chatId, card });
    if (!sendResult.ok) {
      logger.error('send card failed', {
        code: sendResult.error.code,
        message: sendResult.error.message,
      });
      return;
    }
  }
  if (text) {
    const sendResult = await runtime.sendText({ chatId, text });
    if (!sendResult.ok) {
      logger.error('send text failed', {
        code: sendResult.error.code,
        message: sendResult.error.message,
      });
      return;
    }
  }
  logger.info(`skill=${skill.name} replied to chat=${chatId}`);
}

function writeSkillMemory(
  ctx: SkillContext,
  skill: Skill,
  result: { readonly card?: unknown; readonly text?: string; readonly reasoning?: string },
): void {
  const memoryStore = ctx.memoryStore;
  if (!memoryStore) return;
  if (skill.name === 'weekly') return;

  void writeSkillMemoryNow(ctx, skill, result);
}

// 自动写入的 skill_log / chat 记忆 input 上限：JSON.stringify 后还要嵌进 2KB content，
// 给 reason/output/skill/at 留余量后单字段最多 500 字符。
const AUTO_MEMORY_INPUT_MAX = 500;

async function writeSkillMemoryNow(
  ctx: SkillContext,
  skill: Skill,
  result: { readonly card?: unknown; readonly text?: string; readonly reasoning?: string },
): Promise<void> {
  const memoryStore = ctx.memoryStore;
  if (!memoryStore) return;
  const { chatId, userId, eventKey } = memoryEventIdentity(ctx);
  const now = Date.now();
  const summary = summarizeSkillResult(skill, result);
  const baseUserField = userId ? { user_id: safeMemoryKey(userId) } : {};

  // 不显式传 importance —— MemoryStore.write 会异步调 LLM 评分。
  const skillLogPromise = memoryStore.write({
    kind: 'skill_log',
    chat_id: chatId,
    key: safeMemoryKey(`skill:${skill.name}:${eventKey}:${now}`),
    ...baseUserField,
    source_skill: skill.name,
    content: JSON.stringify({
      skill: skill.name,
      reason: result.reasoning ?? '',
      output: summary,
      at: now,
    }),
  });

  const writeChatMemory = skill.name === 'qa' || skill.name === 'summary';
  const chatPromise = writeChatMemory
    ? memoryStore.write({
        kind: 'chat',
        chat_id: chatId,
        key: safeMemoryKey(`chat:${skill.name}:${eventKey}:${now}`),
        ...baseUserField,
        source_skill: skill.name,
        content: JSON.stringify({
          skill: skill.name,
          input:
            ctx.event.type === 'message'
              ? ctx.event.payload.text.slice(0, AUTO_MEMORY_INPUT_MAX)
              : '',
          output: summary,
          reason: result.reasoning ?? '',
          at: now,
        }),
      })
    : null;

  const [skillLog, chatWrite] = await Promise.all([skillLogPromise, chatPromise]);
  if (!skillLog.ok) {
    ctx.logger.warn('memory auto-write skill_log failed', {
      skill: skill.name,
      code: skillLog.error.code,
      message: skillLog.error.message,
    });
  }
  if (chatWrite && !chatWrite.ok) {
    ctx.logger.warn('memory auto-write chat failed', {
      skill: skill.name,
      code: chatWrite.error.code,
      message: chatWrite.error.message,
    });
  }
}

function memoryEventIdentity(ctx: SkillContext): {
  chatId: string;
  userId?: string;
  eventKey: string;
} {
  const { event } = ctx;
  if (event.type === 'message') {
    return {
      chatId: event.payload.chatId,
      userId: event.payload.sender.userId,
      eventKey: event.payload.messageId,
    };
  }
  if (event.type === 'cardAction') {
    return {
      chatId: event.payload.chatId,
      userId: event.payload.user.userId,
      eventKey: event.payload.messageId,
    };
  }
  if (event.type === 'botJoinedChat') {
    return {
      chatId: event.payload.chatId,
      userId: event.payload.inviter.userId,
      eventKey: `botJoined:${event.payload.timestamp}`,
    };
  }
  if (event.type === 'schedule') {
    return {
      chatId: event.payload.chatId,
      eventKey: `schedule:${event.payload.skillName}:${event.payload.timestamp}`,
    };
  }
  return {
    chatId: event.payload.chatId,
    userId: event.payload.user.userId,
    eventKey: `p2p:${event.payload.timestamp}`,
  };
}

function summarizeSkillResult(
  skill: Skill,
  result: { readonly card?: unknown; readonly text?: string; readonly reasoning?: string },
): string {
  const text = result.text?.trim();
  if (text) return text.slice(0, 500);
  if (result.reasoning) return result.reasoning.slice(0, 500);
  if (result.card) return `${skill.name} produced a card`;
  return `${skill.name} completed`;
}

function safeMemoryKey(raw: string): string {
  const key = raw.replace(/[^A-Za-z0-9_:.-]+/g, '_').slice(0, 120);
  return key.length > 0 ? key : 'unknown';
}

function deliveryChatId(ctx: SkillContext): string | null {
  const { event } = ctx;
  if (event.type === 'message' || event.type === 'cardAction' || event.type === 'schedule') {
    return event.payload.chatId;
  }
  if (event.type === 'botJoinedChat') return event.payload.chatId;
  return null;
}

async function handleWithHarness(
  ctx: SkillContext,
  msg: Message,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
  harness: HarnessConfig,
): Promise<boolean> {
  const { llm, logger } = ctx;
  const chatId = msg.chatId;

  const systemPrompt = harness.promptCache.build({ chatId, mention: true });
  const executor = makeExecutor({
    store: harness.memoryStore,
    skills: registeredSkillValues(skills),
    chatId,
    logger,
    docsRoot: harness.docsRoot,
  });

  const skillChoices = [...registeredSkillNames(skills), 'silent'].join(' | ');
  const decisionInstruction =
    '可调用工具：skill.list / skill.read / memory.search 用于检索，' +
    'memory.write 用于把消息中的可记忆事实（项目目标/用户群体/截止日期/分工/关键决策/文档链接）写入记忆。' +
    '工具调用完成后只输出 JSON：' +
    `{"skill":"<以下之一: ${skillChoices}>","reason":"一句话原因","args":{}}。` +
    `skill 字段必须是 ${skillChoices} 中的一个，不要输出其他值。` +
    '不要输出 JSON 以外的文字。';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${msg.text}\n\n${decisionInstruction}` },
  ];

  const result = await llm.chatWithTools(messages, {
    tools: getLLMTools(),
    executor,
    maxToolCallRounds: 5,
    model: 'lite', // 决策走 lite — pro 在长输出下经常 30s+，lite 通常 5-10s
    timeoutMs: 600_000, // 10 分钟：留够长任务（PPT 生成等）的余地，LLM 自己也会写完结束
  });

  if (!result.ok) {
    logger.error('harness chatWithTools failed', {
      code: result.error.code,
      message: result.error.message,
    });
    return false;
  }

  const { content, rounds, toolCalls } = result.value;
  logger.info('harness decision returned', { chatId, rounds, toolCallCount: toolCalls.length });

  const decision = parseHarnessDecision(content, skills);
  if (!decision) {
    logger.warn('harness decision parse failed', { chatId, content });
    return false;
  }

  if (decision.skill === 'silent') {
    logger.info('harness selected silent', { chatId, reason: decision.reason });
    return true;
  }

  const skill = skills[decision.skill];
  if (!skill) {
    logger.warn('harness selected missing skill', { chatId, skill: decision.skill });
    return false;
  }

  logger.info('harness selected skill', {
    chatId,
    skill: decision.skill,
    reason: decision.reason,
    args: decision.args ?? {},
  });
  // Intentionally skip skill.match(): the harness uses LLM + memory context to
  // select the skill, which is more flexible than keyword routing. The skills'
  // run() methods do not assume match() was called first.
  await runSkill(ctx, skill);
  return true;
}

function parseHarnessDecision(
  raw: string,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): HarnessDecision | null {
  const trimmed = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(trimmed) as { skill?: unknown; reason?: unknown; args?: unknown };
    if (parsed.skill === 'silent') {
      let d: HarnessDecision = { skill: 'silent' };
      if (typeof parsed.reason === 'string') d = { ...d, reason: parsed.reason };
      if (isRecord(parsed.args)) d = { ...d, args: parsed.args };
      return d;
    }
    if (typeof parsed.skill !== 'string' || !isSkillName(parsed.skill, skills)) return null;
    let d: HarnessDecision = { skill: parsed.skill };
    if (typeof parsed.reason === 'string') d = { ...d, reason: parsed.reason };
    if (isRecord(parsed.args)) d = { ...d, args: parsed.args };
    return d;
  } catch {
    return null;
  }
}

function stripCodeFence(raw: string): string {
  const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return match ? match[1]!.trim() : raw.trim();
}

function registeredSkillNames(
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): readonly SkillName[] {
  return Object.keys(skills).filter((name): name is SkillName => isSkillName(name, skills));
}

function registeredSkillValues(
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): readonly Skill[] {
  return registeredSkillNames(skills).map((name) => skills[name]!);
}

function isSkillName(
  value: string,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): value is SkillName {
  return Object.prototype.hasOwnProperty.call(skills, value) && Boolean(skills[value as SkillName]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withFallbackSystemPrompt(ctx: SkillContext, harness: HarnessConfig): SkillContext {
  const overview = harness.promptCache.getOverviewText();
  if (!overview) return ctx;
  const llm: LLMClient = {
    ask: (prompt, opts) =>
      ctx.llm.ask(prompt, { ...opts, systemPrompt: opts?.systemPrompt ?? overview }),
    chat: (messages, opts) => {
      if (opts?.systemPrompt) return ctx.llm.chat(messages, opts);
      return ctx.llm.chat([{ role: 'system', content: overview }, ...messages], opts);
    },
    askStructured: (prompt, schema, opts) =>
      ctx.llm.askStructured(prompt, schema, {
        ...opts,
        systemPrompt: opts?.systemPrompt ?? overview,
      }),
    chatWithTools: (messages, opts) => ctx.llm.chatWithTools(messages, opts),
    embed: (text) => ctx.llm.embed(text),
  };
  return { ...ctx, llm };
}

async function handleCardAction(
  ctx: SkillContext,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): Promise<void> {
  const { event, logger, runtime } = ctx;
  if (event.type !== 'cardAction') return;
  const action = event.payload.value['action'];

  // onboarding（issue #98）：activation 卡按钮被点击
  if (action === 'activate' || action === 'dismiss') {
    await handleOnboardingAction(ctx, action);
    return;
  }

  if (action !== 'qa.reanswer') return;

  const chatId = String(event.payload.value['chatId'] ?? event.payload.chatId);
  const questionMessageId = String(event.payload.value['questionMessageId'] ?? '');
  if (!chatId || !questionMessageId) {
    logger.warn('qa.reanswer missing chatId or questionMessageId', { chatId, questionMessageId });
    return;
  }

  const qa = skills.qa;
  if (!qa) return;

  const historyResult = await runtime.fetchHistory({ chatId, pageSize: 50 });
  if (!historyResult.ok) {
    logger.error('qa.reanswer history fetch failed', {
      code: historyResult.error.code,
      message: historyResult.error.message,
    });
    return;
  }

  const question = historyResult.value.messages.find((m) => m.messageId === questionMessageId);
  if (!question) {
    await runtime.sendText({ chatId, text: '找不到原问题了，可以重新 @ 我问一次。' });
    return;
  }

  const replayCtx: SkillContext = {
    ...ctx,
    event: { type: 'message', payload: question as Message },
  };
  await runSkill(replayCtx, qa);
  logger.info(`skill=qa reanswer requested chat=${chatId}`);
}

async function handleSchedule(
  ctx: SkillContext,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): Promise<void> {
  const { event } = ctx;
  if (event.type !== 'schedule') return;
  const skillName = event.payload.skillName as SkillName;
  const skill = skills[skillName];
  if (!skill) {
    ctx.logger.warn('schedule selected missing skill', { skill: event.payload.skillName });
    return;
  }
  if (!(await skill.match(ctx))) return;
  await runSkill(ctx, skill);
}

// ─── 被动 memory 观察 ─────────────────────────────────────────────────────────
//
// 设计：非 @mention 的消息也可能含有值得长期记忆的事实（项目背景/PRD/分工/截止日期）。
// 所有足够长的消息进 LLM Lite 判断；LLM 自主决定是否调 memory.write，不发任何回复。
// 失败/超时静默 warn，不阻塞 SkillRouter 的主路径。
//
// 历史注：曾有关键字前置过滤（PASSIVE_MEMORY_KEYWORDS_RE）降低 LLM 调用量，
// 但实测遗漏太多有价值消息（#109），故移除，改为长度门是唯一前置条件。

/** 消息至少要有这么多字符才值得进 LLM 判断（过滤"好""嗯""👍"等） */
export const PASSIVE_MIN_TEXT_LENGTH = 12;

const MEMORY_WRITE_TOOL_NAME = 'memory.write';

export function shouldObservePassively(text: string): boolean {
  return text.trim().length >= PASSIVE_MIN_TEXT_LENGTH;
}

async function handlePassiveObserve(
  ctx: SkillContext,
  msg: Message,
  harness: HarnessConfig,
): Promise<void> {
  const { llm, logger } = ctx;
  const chatId = msg.chatId;

  // 只暴露 memory.write，不暴露 search/read/skill.* — 避免模型走偏
  const writeTool = getLLMTools().find((t) => t.name === MEMORY_WRITE_TOOL_NAME);
  if (!writeTool) {
    logger.warn('passive observe: memory.write tool missing', { chatId });
    return;
  }

  const executor = makeExecutor({
    store: harness.memoryStore,
    chatId,
    logger,
    docsRoot: harness.docsRoot,
    sourceSkill: 'passive_observe',
  });

  const systemPrompt =
    '你是一个静默的记忆观察者。读到的消息**不要回复用户**。\n' +
    '如果消息包含值得群组长期记住的事实（项目目标/用户群体/截止日期/分工/关键文档/重要决策），' +
    '调用 memory.write 写入；importance 只在很重要时（≥7）才指定。\n' +
    '若消息是闲聊/重复/没有事实信息，什么都不调，直接输出 SKIP。';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: msg.text },
  ];

  const result = await observeWithTimeout(
    llm,
    messages,
    [writeTool],
    executor,
    600_000, // 10 分钟：与主动路径对齐，避免 LLM 写记忆中途被切
  );

  if (!result.ok) {
    logger.warn('passive observe failed', {
      chatId,
      code: result.error.code,
      message: result.error.message,
    });
    return;
  }

  logger.info('passive observe done', {
    chatId,
    rounds: result.value.rounds,
    toolCallCount: result.value.toolCalls.length,
  });
}

async function observeWithTimeout(
  llm: LLMClient,
  messages: readonly ChatMessage[],
  tools: readonly LLMTool[],
  executor: (call: ToolCall) => Promise<ToolResult>,
  timeoutMs: number,
): ReturnType<LLMClient['chatWithTools']> {
  return llm.chatWithTools(messages, {
    tools,
    executor,
    maxToolCallRounds: 2, // 被动观察最多 2 轮（一次调 write + 一次确认）
    model: 'lite', // 被动用便宜模型
    timeoutMs,
  });
}
