/**
 * 走真实 MemoryStore + 真实 LLM + 真实 Bitable，端到端验证 memory.write 工具能不能写入。
 * 不模拟、不打 stub。
 *
 * 注意：本脚本会在 BITABLE_TABLE_MEMORY 表里**真实**插入记录，仅用于本地冒烟。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChatMessage, Logger } from '@seedhac/contracts';

import { LarkBitableClient } from '../bitable-client.js';
import { VolcanoLLMClient } from '../llm-client.js';
import { MemoryStore } from '../memory/memory-store.js';
import { SystemPromptCache } from '../memory/system-prompt.js';
import { getLLMTools, makeExecutor } from '../memory/tool-handlers.js';

const DOCS_ROOT =
  process.env['BOT_DOCS_ROOT'] ??
  resolve(fileURLToPath(import.meta.url), '../../../../../docs/bot-memory');

const TEST_MESSAGE =
  'Probe 测试消息：项目代号 ProbeTest-2026，目标用户是中小学教师，' +
  '本季度内交付 MVP 网页版，核心能力是上传教材 PDF 自动生成教学目标。';

const TEST_CHAT_ID = 'oc_probe_real_write_test';

async function main(): Promise<void> {
  const apiKey = process.env['ARK_API_KEY']!;
  const modelLite = process.env['ARK_MODEL_LITE']!;
  const modelPro = process.env['ARK_MODEL_PRO']!;
  const appId = process.env['LARK_APP_ID']!;
  const appSecret = process.env['LARK_APP_SECRET']!;
  const appToken = process.env['BITABLE_APP_TOKEN']!;

  if (!apiKey || !modelLite || !modelPro || !appId || !appSecret || !appToken) {
    console.error('缺关键 env');
    process.exit(1);
  }

  const logger: Logger = {
    debug: (msg, meta) => console.debug(`[probe] ${msg}`, meta ?? ''),
    info: (msg, meta) => console.info(`[probe] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[probe] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[probe] ${msg}`, meta ?? ''),
  };

  const llm = new VolcanoLLMClient({
    apiKey,
    modelIds: { lite: modelLite, pro: modelPro },
  });

  const bitable = new LarkBitableClient({
    appId,
    appSecret,
    appToken,
    tableIds: {
      memory: process.env['BITABLE_TABLE_MEMORY'] ?? '',
      decision: process.env['BITABLE_TABLE_DECISION'] ?? '',
      todo: process.env['BITABLE_TABLE_TODO'] ?? '',
      knowledge: process.env['BITABLE_TABLE_KNOWLEDGE'] ?? '',
    },
  });

  const memoryStore = new MemoryStore({ bitable, llm, logger });

  const promptCache = await SystemPromptCache.load(DOCS_ROOT, { strict: false });
  const systemPrompt = promptCache.build({ chatId: TEST_CHAT_ID, mention: true });

  const executor = makeExecutor({
    store: memoryStore,
    chatId: TEST_CHAT_ID,
    logger,
    docsRoot: DOCS_ROOT,
    sourceSkill: 'probe_real_write',
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        `${TEST_MESSAGE}\n\n请使用 memory.write 把这条项目信息写入。完成后回复一句"已记录"。`,
    },
  ];

  console.log('=== Real End-to-End Write Probe ===');
  console.log(`chat_id: ${TEST_CHAT_ID}`);
  console.log(`message: ${TEST_MESSAGE}`);
  console.log('开始 chatWithTools...');

  const start = Date.now();
  const result = await llm.chatWithTools(messages, {
    tools: getLLMTools(),
    executor,
    maxToolCallRounds: 3,
    model: 'lite',
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - start;

  if (!result.ok) {
    console.error(`❌ chatWithTools 失败 (${elapsed}ms):`, result.error);
    process.exit(1);
  }

  console.log(`✅ 完成 (${elapsed}ms) — rounds=${result.value.rounds} toolCalls=${result.value.toolCalls.length}`);
  console.log(`final content: ${result.value.content.slice(0, 200)}`);

  // 直查 Bitable 验证
  console.log('\n=== 验证 Bitable 真实写入 ===');
  const findRes = await bitable.find({
    table: 'memory',
    filter: `AND(CurrentValue.[chat_id] = "${TEST_CHAT_ID}")`,
    pageSize: 10,
  });
  if (!findRes.ok) {
    console.error('查询失败:', findRes.error);
    process.exit(1);
  }
  console.log(`记录数: ${findRes.value.records.length}`);
  for (const rec of findRes.value.records) {
    console.log('-', JSON.stringify(rec.fields, null, 2).slice(0, 500));
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
