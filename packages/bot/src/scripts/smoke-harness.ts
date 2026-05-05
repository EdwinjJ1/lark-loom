/**
 * smoke-harness.ts — local M5 harness flow check.
 *
 * Runs without Feishu or Ark credentials:
 *   message -> system prompt -> fake tool-call decision -> skill.run -> send result
 */

import { resolve } from 'node:path';

import { ok } from '@seedhac/contracts';
import type {
  BotEvent,
  BotRuntime,
  ChatMessage,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  LLMClient,
  Result,
  SchemaLike,
  SkillContext,
} from '@seedhac/contracts';
import { skillsByName } from '@seedhac/skills';

import { larkCardBuilder } from '../card-builder.js';
import { NullMemoryStore } from '../memory/memory-store.js';
import { SystemPromptCache } from '../memory/system-prompt.js';
import { SkillRouter } from '../skill-router.js';
import { handleEvent } from '../wiring.js';

const BOT_ID = 'ou_smoke_bot';
const CHAT_ID = 'oc_smoke_chat';
const docsRoot = resolve(process.cwd(), '../../docs/bot-memory');

const event: BotEvent = {
  type: 'message',
  payload: {
    messageId: 'msg_smoke_1',
    chatId: CHAT_ID,
    chatType: 'group',
    sender: { userId: 'ou_user' },
    contentType: 'text',
    text: '这是什么？',
    rawContent: '',
    mentions: [{ user: { userId: BOT_ID }, key: '@_bot' }],
    timestamp: Date.now(),
  },
};

const runtime: BotRuntime = {
  on: () => () => undefined,
  start: async () => ok(undefined),
  stop: async () => undefined,
  sendText: async (params) => {
    console.info('[sendText]', params);
    return ok({ messageId: 'reply_text', chatId: params.chatId, timestamp: Date.now() });
  },
  sendCard: async (params) => {
    console.info('[sendCard]', params.card.templateName);
    return ok({ messageId: 'reply_card', chatId: params.chatId, timestamp: Date.now() });
  },
  patchCard: async () => ok(undefined),
  fetchHistory: async () =>
    ok({
      messages: [
        event.payload,
        {
          ...event.payload,
          messageId: 'hist_1',
          text: 'Lark Loom 是飞书群聊 AI 助手，用来主动补齐项目上下文。',
          mentions: [],
        },
      ],
      hasMore: false,
    }),
  fetchMembers: async () => ok({ members: [] }),
  fetchMessage: async () => ok({ messages: [] }),
};

const llm: LLMClient = {
  ask: async () => ok('Lark Loom 是飞书群聊 AI 助手。'),
  chat: async () => ok(''),
  askStructured: async <T>(_prompt: string, schema: SchemaLike<T>): Promise<Result<T>> =>
    ok(schema.parse({})),
  chatWithTools: async (
    messages: readonly ChatMessage[],
    opts: ChatWithToolsOptions,
  ): Promise<Result<ChatWithToolsResult>> => {
    console.info(
      '[systemprompt]',
      messages.find((m) => m.role === 'system')?.content.slice(0, 180),
    );
    console.info(
      '[tools]',
      (opts.tools ?? []).map((t) => t.name),
    );
    console.info('[tool calls]', ['skill.list', 'skill.read(qa)']);
    return ok({
      content: JSON.stringify({ skill: 'qa', reason: '用户 @bot 提问，需要问答 skill', args: {} }),
      toolCalls: [
        { id: 'call_1', name: 'skill.list', argumentsRaw: '{}' },
        { id: 'call_2', name: 'skill.read', argumentsRaw: '{"name":"qa"}' },
      ],
      rounds: 1,
    });
  },
};

const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => console.info('[debug]', msg, meta ?? ''),
  info: (msg: string, meta?: Record<string, unknown>) => console.info('[info]', msg, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn('[warn]', msg, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error('[error]', msg, meta ?? ''),
};

const promptCache = await SystemPromptCache.load(docsRoot, { strict: true });
const router = new SkillRouter(BOT_ID);
const ctx: SkillContext = {
  event,
  runtime,
  llm,
  bitable: {
    find: async () => ok({ records: [], hasMore: false }),
    insert: async () => ok({ tableId: 'tbl', recordId: 'rec' }),
    batchInsert: async () => ok([]),
    update: async () => ok(undefined),
    delete: async () => ok(undefined),
    link: async () => ok(undefined),
    readTable: async () => ok(''),
  },
  docx: {
    create: async () => ok({ docToken: 'doc', url: 'https://example.test/doc' }),
    appendBlocks: async () => ok(undefined),
    getShareLink: async () => ok('https://example.test/doc'),
    createFromMarkdown: async () => ok({ docToken: 'doc', url: 'https://example.test/doc' }),
    readContent: async () => ok(''),
    grantMembersEdit: async () => ok(undefined),
  },
  cardBuilder: larkCardBuilder,
  retrievers: {},
  logger,
};

console.info('[message]', event.payload.text);
await handleEvent(ctx, router, skillsByName, {
  promptCache,
  memoryStore: new NullMemoryStore(),
  docsRoot,
  botOpenId: BOT_ID,
});
console.info('[done] harness smoke completed');
