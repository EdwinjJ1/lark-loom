import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger, SkillContext } from '@seedhac/contracts';
import { skillsByName } from '@seedhac/skills';
import { createBotRuntime } from './bot-runtime.js';
import { LarkBitableClient } from './bitable-client.js';
import { larkCardBuilder } from './card-builder.js';
import { createDocxClient } from './docx-client.js';
import { VolcanoLLMClient } from './llm-client.js';
import { MemoryStore, NullMemoryStore } from './memory/memory-store.js';
import { SystemPromptCache } from './memory/system-prompt.js';
import { createSlidesClient } from './slides-client.js';
import { SkillRouter } from './skill-router.js';
import { handleEvent } from './wiring.js';

const DEFAULT_DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../docs/bot-memory');

// 后台运行时 stdout 默认 block-buffered (4KB)，每条日志几十字节就会滞留好几分钟才刷盘。
// 强制 stdout/stderr 同步写，保证 nohup/script 重定向到文件时实时可读。
// 代价：每次 console.* 都同步落盘，但 bot 日志 QPS 很低，可以接受。
// 参考：https://nodejs.org/api/process.html#a-note-on-process-io
type WritableWithBlocking = NodeJS.WriteStream & { _handle?: { setBlocking?: (b: boolean) => void } };
(process.stdout as WritableWithBlocking)._handle?.setBlocking?.(true);
(process.stderr as WritableWithBlocking)._handle?.setBlocking?.(true);

const logger: Logger = {
  debug: (msg, meta) => console.debug(`[bot] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[bot] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[bot] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[bot] ${msg}`, meta ?? ''),
};

// 防御性读 env：trim 掉 trailing space / \r / \t
// 用户复制粘贴 .env 时常带尾随空白；用 token / table_id 拼到 URL 里会直接挂掉
// 飞书 API（曾导致 BITABLE 写入静默失败）。
function envTrim(name: string): string {
  return (process.env[name] ?? '').trim();
}

function buildDeps() {
  const appId = envTrim('LARK_APP_ID');
  const appSecret = envTrim('LARK_APP_SECRET');
  if (!appId) throw new Error('Missing env var: LARK_APP_ID');
  if (!appSecret) throw new Error('Missing env var: LARK_APP_SECRET');

  const runtime = createBotRuntime({ logger });
  const router = new SkillRouter(envTrim('LARK_BOT_OPEN_ID'));

  const llm = new VolcanoLLMClient({
    apiKey: envTrim('ARK_API_KEY'),
    modelIds: {
      lite: envTrim('ARK_MODEL_LITE'),
      pro: envTrim('ARK_MODEL_PRO'),
    },
  });

  const bitable = new LarkBitableClient({
    appId,
    appSecret,
    appToken: envTrim('BITABLE_APP_TOKEN'),
    tableIds: {
      memory: envTrim('BITABLE_TABLE_MEMORY'),
      decision: envTrim('BITABLE_TABLE_DECISION'),
      todo: envTrim('BITABLE_TABLE_TODO'),
      knowledge: envTrim('BITABLE_TABLE_KNOWLEDGE'),
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
  // 缺 BITABLE_APP_TOKEN 时降级为 NullMemoryStore，避免冒烟阶段被存储层 token 失败阻塞
  const memoryStore = process.env['BITABLE_APP_TOKEN']
    ? new MemoryStore({ bitable, llm, logger })
    : new NullMemoryStore();
  logger.info('memory store initialized', {
    type: process.env['BITABLE_APP_TOKEN']
      ? 'MemoryStore'
      : 'NullMemoryStore (no BITABLE_APP_TOKEN)',
  });
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
