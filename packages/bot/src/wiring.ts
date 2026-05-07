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
import {
  isFreshTrigger as isRehearsalFreshTrigger,
  isAwaitingUserResponse as isRehearsalAwaiting,
  isSatisfactionSignal as isRehearsalSatisfied,
  loadRehearsalSession,
} from '@seedhac/skills';

export const intentToSkill: Partial<Record<RouteIntent, SkillName>> = {
  qa: 'qa',
  meetingNotes: 'summary',
  slides: 'slides',
  requirementDoc: 'requirementDoc',
  taskAssignment: 'taskAssignment',
  progressUpdate: 'progressUpdate',
  archive: 'archive',
  rehearsal: 'rehearsal',
};

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

  // rehearsal 循环检测（issue #102）—— 路由前优先：当前 chat 有活跃 rehearsal session
  // 且本条消息既不是新一轮 rehearsal trigger 也不是别的高优 intent，就把消息当作
  // 反馈/满意信号交给 rehearsal skill。
  const rehearsalHandled = await maybeContinueRehearsal(ctx, msg, skills);
  if (rehearsalHandled) return;

  const handledBySkill = await handleWithSkillRouter(ctx, router, skills);
  if (!handledBySkill && harness && shouldConsiderProactive(msg.text)) {
    void handleProactiveLayer(ctx, msg, skills, harness).catch((e) => {
      logger.warn('proactive layer threw', {
        chatId: msg.chatId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }
}

/**
 * Rehearsal 循环检测（issue #102 step ④）：
 *
 * 当前 chat 有活跃 rehearsal session 时，把后续消息视为反馈或满意信号交给 rehearsal skill。
 *
 * 关键语义（用户实测反馈，2026-05-06）：
 *   - phase=clarifying（已发反问卡）：bot 明确说"请在群里回复"，用户任何文本（含
 *     极短回答如『第三页啊』）都必须当反馈。**不允许过滤**，否则 UX 撕裂。
 *   - phase=analyzing（已分析，等用户判断）：保留极弱过滤，防『嗯』『哈哈』等
 *     纯反应触发昂贵的 pro 重分析。门槛降到 3 字。
 *
 * 排除项：
 *   - 包含 rehearsal 触发词的消息让 router 兜底
 *   - 非文本 / 富文本不处理
 */
const REHEARSAL_ANALYZING_MIN_LENGTH = 3;

async function maybeContinueRehearsal(
  ctx: SkillContext,
  msg: Message,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): Promise<boolean> {
  const rehearsal = skills.rehearsal;
  if (!rehearsal) return false;
  if (isRehearsalFreshTrigger(msg.text)) return false;
  if (msg.contentType !== 'text' && msg.contentType !== 'post') return false;

  const session = await loadRehearsalSession(ctx, msg.chatId);
  if (!isRehearsalAwaiting(session)) return false;

  const trimmed = msg.text.trim();
  const looksSatisfied = isRehearsalSatisfied(trimmed);

  // analyzing 阶段：极短的纯反应（"嗯"/"哈"）跳过；满意信号永远接管
  // clarifying 阶段：bot 已让用户回复，不做长度过滤
  if (
    session?.phase === 'analyzing' &&
    trimmed.length < REHEARSAL_ANALYZING_MIN_LENGTH &&
    !looksSatisfied
  ) {
    ctx.logger.debug('rehearsal: skip ultra-short msg in analyzing phase', {
      chatId: msg.chatId,
      length: trimmed.length,
    });
    return false;
  }

  ctx.logger.info('rehearsal: continuing active session via wiring', {
    chatId: msg.chatId,
    phase: session?.phase,
    round: session?.round,
    isSatisfied: looksSatisfied,
  });
  await runSkill(ctx, rehearsal);
  return true;
}

async function handleWithSkillRouter(
  ctx: SkillContext,
  router: SkillRouter,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
): Promise<boolean> {
  const { event } = ctx;
  if (event.type !== 'message') return false;
  const msg = event.payload;
  const intent = router.route(msg);
  const skillName = intentToSkill[intent];
  if (!skillName) return false;
  const skill = skills[skillName];
  if (!skill) return false;
  if (!(await skill.match(ctx))) return false;
  await runSkill(ctx, skill);
  return true;
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
    bitable: ctx.bitable,
    skills: registeredSkillValues(skills),
    chatId,
    logger,
    docsRoot: harness.docsRoot,
  });

  const skillChoices = [...registeredSkillNames(skills), 'silent'].join(' | ');
  const decisionInstruction =
    '可调用工具：skill.list / skill.read / memory.search 用于检索，' +
    'memory.write 用于把消息中的可记忆事实（项目目标/用户群体/截止日期/分工/文档链接）写入记忆，' +
    'decision.write 用于记录明确决策（"我们决定…""最终确认…""不做…""验收标准是…"）。' +
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

  // rehearsal（issue #102）：分析卡的"满意，完成" / "继续修改"按钮
  if (action === 'rehearsal.satisfied' || action === 'rehearsal.iterate') {
    const rehearsal = skills.rehearsal;
    if (!rehearsal) {
      logger.warn('rehearsal cardAction received but skill not registered');
      return;
    }
    await runSkill(ctx, rehearsal);
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
const DECISION_WRITE_TOOL_NAME = 'decision.write';

export function shouldObservePassively(text: string): boolean {
  return text.trim().length >= PASSIVE_MIN_TEXT_LENGTH;
}

const PROACTIVE_MIN_TEXT_LENGTH = 8;
export const PROACTIVE_TIMEOUT_MS = 30_000;
const PROACTIVE_SIGNAL_RE =
  /(?:怎么|如何|有没有|哪里|找不到|不确定|不清楚|缺|需要什么|先做什么|下一步|资料|文档|链接|方案|规则|标准|口径|背景|参考|帮忙看看|卡住|blocked)/i;

export function shouldConsiderProactive(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < PROACTIVE_MIN_TEXT_LENGTH) return false;
  return PROACTIVE_SIGNAL_RE.test(trimmed);
}

async function handlePassiveObserve(
  ctx: SkillContext,
  msg: Message,
  harness: HarnessConfig,
): Promise<void> {
  const { llm, logger } = ctx;
  const chatId = msg.chatId;

  // 只暴露 memory.write + decision.write，不暴露 search/read/skill.* — 避免模型走偏
  const allTools = getLLMTools();
  const writeTool = allTools.find((t) => t.name === MEMORY_WRITE_TOOL_NAME);
  const decisionTool = allTools.find((t) => t.name === DECISION_WRITE_TOOL_NAME);
  if (!writeTool || !decisionTool) {
    logger.warn('passive observe: required tools missing', { chatId });
    return;
  }

  const executor = makeExecutor({
    store: harness.memoryStore,
    bitable: ctx.bitable,
    chatId,
    logger,
    docsRoot: harness.docsRoot,
    sourceSkill: 'passive_observe',
  });

  const systemPrompt =
    '你是一个静默的记忆观察者。读到的消息**不要回复用户**。\n' +
    '如果消息包含值得群组长期记住的事实（项目目标/用户群体/截止日期/分工/关键文档），' +
    '调用 memory.write 写入；importance 只在很重要时（≥7）才指定。\n' +
    '如果消息包含明确决策（"我们决定…""最终确认…""不做…""验收标准是…"），调用 decision.write 记录。\n' +
    'key 命名规范：用稳定的语义英文短语（snake_case），相同主题复用同一 key 实现覆盖更新，避免写重复条目。\n' +
    '示例：截止日期 → "project_deadline"；分工 → "task_owner_<姓名拼音>"；项目目标 → "project_goal"。\n' +
    '若消息是闲聊/重复/没有事实信息，什么都不调，直接输出 SKIP。';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: msg.text },
  ];

  const result = await observeWithTimeout(
    llm,
    messages,
    [writeTool, decisionTool],
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

type ProactiveDecision =
  | { readonly action: 'silent'; readonly reason?: string }
  | { readonly action: 'share' | 'clarify'; readonly text: string; readonly reason?: string };

const PROACTIVE_TOOL_NAMES = new Set(['memory.search', 'skill.list', 'skill.read']);

async function handleProactiveLayer(
  ctx: SkillContext,
  msg: Message,
  skills: Readonly<Partial<Record<SkillName, Skill>>>,
  harness: HarnessConfig,
): Promise<void> {
  const { llm, logger, runtime } = ctx;
  const chatId = msg.chatId;

  const tools = getLLMTools().filter((tool) => PROACTIVE_TOOL_NAMES.has(tool.name));
  if (tools.length === 0) {
    logger.warn('proactive layer: no tools available', { chatId });
    return;
  }

  const executor = makeExecutor({
    store: harness.memoryStore,
    bitable: ctx.bitable,
    skills: registeredSkillValues(skills),
    chatId,
    logger,
    docsRoot: harness.docsRoot,
    sourceSkill: 'proactive_layer',
  });

  const systemPrompt =
    '你是 Lark Loom 的主动协作层。你只在群聊当前消息明显需要帮助时短暂介入。\n' +
    '可做两件事：1) 主动给资料：先调用 memory.search 或 skill.read 查到相关信息，再用 1-3 句话给出链接/事实/下一步；' +
    '2) 主动澄清：当信息不足且继续执行会误导时，只问一个具体澄清问题。\n' +
    '不要主动推送未被触发的完整 skill 结果；不要编造资料；没有把握就 silent。\n' +
    '输出必须是 JSON：{"action":"silent|share|clarify","text":"要发送到群里的短文本","reason":"一句话原因"}。' +
    'action=silent 时可以省略 text。不要输出 JSON 以外的文字。';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: msg.text },
  ];

  const result = await llm.chatWithTools(messages, {
    tools,
    executor,
    maxToolCallRounds: 3,
    model: 'lite',
    timeoutMs: PROACTIVE_TIMEOUT_MS,
  });

  if (!result.ok) {
    logger.warn('proactive layer failed', {
      chatId,
      code: result.error.code,
      message: result.error.message,
    });
    return;
  }

  const decision = parseProactiveDecision(result.value.content);
  if (!decision) {
    logger.warn('proactive layer decision parse failed', {
      chatId,
      content: result.value.content,
    });
    return;
  }

  if (decision.action === 'silent') {
    logger.info('proactive layer selected silent', { chatId, reason: decision.reason });
    return;
  }

  if (decision.action === 'share' && !hasGroundingToolCall(result.value.toolCalls)) {
    logger.warn('proactive layer share without grounding tool call', {
      chatId,
      reason: decision.reason,
    });
    return;
  }

  const text = decision.text.trim();
  if (!text) {
    logger.warn('proactive layer selected empty text', { chatId, action: decision.action });
    return;
  }

  const sendResult = await runtime.sendText({ chatId, text });
  if (!sendResult.ok) {
    logger.error('proactive layer send text failed', {
      chatId,
      code: sendResult.error.code,
      message: sendResult.error.message,
    });
    return;
  }

  logger.info('proactive layer replied', {
    chatId,
    action: decision.action,
    reason: decision.reason,
    rounds: result.value.rounds,
    toolCallCount: result.value.toolCalls.length,
  });
}

function hasGroundingToolCall(toolCalls: readonly ToolCall[]): boolean {
  return toolCalls.some((call) => call.name === 'memory.search' || call.name === 'skill.read');
}

function parseProactiveDecision(raw: string): ProactiveDecision | null {
  const trimmed = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(trimmed) as {
      action?: unknown;
      text?: unknown;
      reason?: unknown;
    };
    if (parsed.action === 'silent') {
      return typeof parsed.reason === 'string'
        ? { action: 'silent', reason: parsed.reason }
        : { action: 'silent' };
    }
    if (parsed.action !== 'share' && parsed.action !== 'clarify') return null;
    if (typeof parsed.text !== 'string') return null;
    let decision: ProactiveDecision = { action: parsed.action, text: parsed.text };
    if (typeof parsed.reason === 'string') decision = { ...decision, reason: parsed.reason };
    return decision;
  } catch {
    return null;
  }
}
