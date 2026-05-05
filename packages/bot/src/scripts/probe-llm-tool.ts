/**
 * 带 1 个最简 tool 的 LLM 调用，看是否会超时
 */

import type { LLMTool } from '@seedhac/contracts';
import { VolcanoLLMClient } from '../llm-client.js';

const TOOL: LLMTool = {
  name: 'echo',
  description: '返回输入的文本',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

async function main(): Promise<void> {
  const apiKey = process.env['ARK_API_KEY']!;
  const llm = new VolcanoLLMClient({
    apiKey,
    modelIds: { lite: process.env['ARK_MODEL_LITE']!, pro: process.env['ARK_MODEL_PRO']! },
  });

  for (const model of ['lite', 'pro'] as const) {
    console.log(`\n=== ${model} with 1 tool ===`);
    const start = Date.now();
    const r = await llm.chatWithTools(
      [{ role: 'user', content: '请调用 echo 工具，参数 text="hi"' }],
      {
        tools: [TOOL],
        executor: async (call) => ({
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ text: 'hi' }),
        }),
        maxToolCallRounds: 2,
        model,
        timeoutMs: 30_000,
      },
    );
    const ms = Date.now() - start;
    if (r.ok) {
      console.log(`✅ ${ms}ms — rounds=${r.value.rounds} toolCalls=${r.value.toolCalls.length}`);
      console.log(`   content: ${r.value.content.slice(0, 80)}`);
    } else {
      console.log(`❌ ${ms}ms — ${r.error.code}: ${r.error.message}`);
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
