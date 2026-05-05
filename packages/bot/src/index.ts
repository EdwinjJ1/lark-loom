import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger, SkillContext } from '@seedhac/contracts';
import { skillsByName } from '@seedhac/skills';
import { createBotRuntime } from './bot-runtime.js';
import { LarkBitableClient } from './bitable-client.js';
import { larkCardBuilder } from './card-builder.js';
import { createDocxClient } from './docx-client.js';
import { VolcanoLLMClient } from './llm-client.js';
import { MemoryStore } from './memory/memory-store.js';
import { SystemPromptCache } from './memory/system-prompt.js';
import { createSlidesClient } from './slides-client.js';
import { SkillRouter } from './skill-router.js';
import { handleEvent } from './wiring.js';

const DEFAULT_DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../docs/bot-memory');

const logger: Logger = {
  debug: (msg, meta) => console.debug(`[bot] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[bot] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[bot] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[bot] ${msg}`, meta ?? ''),
};

function buildDeps() {
  const appId = process.env['LARK_APP_ID'];
  const appSecret = process.env['LARK_APP_SECRET'];
  const bitableAppToken = process.env['LARK_BITABLE_APP_TOKEN'] ?? process.env['BITABLE_APP_TOKEN'];
  const memoryTableId =
    process.env['LARK_BITABLE_MEMORY_TABLE_ID'] ?? process.env['BITABLE_TABLE_MEMORY'];
  if (!appId) throw new Error('Missing env var: LARK_APP_ID');
  if (!appSecret) throw new Error('Missing env var: LARK_APP_SECRET');
  if (!bitableAppToken) throw new Error('Missing env var: LARK_BITABLE_APP_TOKEN');
  if (!memoryTableId) throw new Error('Missing env var: LARK_BITABLE_MEMORY_TABLE_ID');

  // 旧名 BITABLE_* 仍是兼容 fallback；显式提示用户迁移到 LARK_BITABLE_*。
  if (!process.env['LARK_BITABLE_APP_TOKEN'] && process.env['BITABLE_APP_TOKEN']) {
    logger.warn(
      'env: BITABLE_APP_TOKEN is deprecated, please rename to LARK_BITABLE_APP_TOKEN in .env',
    );
  }
  if (!process.env['LARK_BITABLE_MEMORY_TABLE_ID'] && process.env['BITABLE_TABLE_MEMORY']) {
    logger.warn(
      'env: BITABLE_TABLE_MEMORY is deprecated, please rename to LARK_BITABLE_MEMORY_TABLE_ID in .env',
    );
  }

  const runtime = createBotRuntime();
  const router = new SkillRouter(process.env['LARK_BOT_OPEN_ID'] ?? '');

  const llm = new VolcanoLLMClient({
    apiKey: process.env['ARK_API_KEY'] ?? '',
    modelIds: {
      lite: process.env['ARK_MODEL_LITE'] ?? '',
      pro: process.env['ARK_MODEL_PRO'] ?? '',
    },
  });

  const bitable = new LarkBitableClient({
    appId,
    appSecret,
    appToken: bitableAppToken,
    tableIds: {
      memory: memoryTableId,
      decision: process.env['BITABLE_TABLE_DECISION'] ?? '',
      todo: process.env['BITABLE_TABLE_TODO'] ?? '',
      knowledge: process.env['BITABLE_TABLE_KNOWLEDGE'] ?? '',
    },
  });

  const docx = createDocxClient();
  const slides = createSlidesClient();

  return { runtime, router, llm, bitable, docx, slides };
}

async function main(): Promise<void> {
  logger.info('booting');

  const { runtime, router, llm, bitable, docx, slides } = buildDeps();

  const docsRoot = process.env['BOT_DOCS_ROOT'] ?? DEFAULT_DOCS_ROOT;
  const promptCache = await SystemPromptCache.load(docsRoot, { strict: true });
  const memoryTableCheck = await bitable.find({ table: 'memory', pageSize: 1 });
  if (!memoryTableCheck.ok) {
    throw new Error(`Memory table is not accessible: ${memoryTableCheck.error.message}`);
  }
  const memoryStore = new MemoryStore({ bitable, llm, logger });
  logger.info('memory store initialized', { type: 'MemoryStore' });
  const botOpenId = process.env['LARK_BOT_OPEN_ID'] ?? '';
  if (!botOpenId) {
    logger.warn('LARK_BOT_OPEN_ID 未配置 — @bot 检测会失败，所有 mention skill 不会触发');
  }
  const harness = { promptCache, memoryStore, docsRoot, botOpenId };

  logger.info('harness loaded', { docsRoot });

  runtime.on(async (event) => {
    if (event.type === 'message') {
      const msg = event.payload;
      const intent = router.route(msg);
      logger.info(
        `message received: text="${msg.text}" mentions=${JSON.stringify(msg.mentions.map((m) => m.user.userId))} → intent=${intent}`,
      );
    }
    if (event.type === 'cardAction') {
      logger.info('card action received', {
        chatId: event.payload.chatId,
        messageId: event.payload.messageId,
        value: event.payload.value,
      });
    }

    const ctx: SkillContext = {
      event,
      runtime,
      llm,
      bitable,
      docx,
      slides,
      cardBuilder: larkCardBuilder,
      memoryStore,
      retrievers: {},
      logger,
    };
    await handleEvent(ctx, router, skillsByName, harness);
  });

  const startResult = await runtime.start();
  if (!startResult.ok) {
    logger.error('runtime start failed', { message: startResult.error.message });
    process.exit(1);
  }

  logger.info('WSClient ready');

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    void runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[bot] fatal:', e);
  process.exit(1);
});
