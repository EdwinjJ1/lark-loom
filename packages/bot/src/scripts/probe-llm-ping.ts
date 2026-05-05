/**
 * 最简 LLM 健康探针：不带 tools，只问一句话，看能不能返回。
 * 用于排除"是 tools 卡住还是 LLM 整个卡住"。
 */

import { VolcanoLLMClient } from '../llm-client.js';

async function main(): Promise<void> {
  const apiKey = process.env['ARK_API_KEY'];
  const modelLite = process.env['ARK_MODEL_LITE'];
  const modelPro = process.env['ARK_MODEL_PRO'];
  if (!apiKey || !modelLite || !modelPro) {
    console.error('缺 env');
    process.exit(1);
  }

  const llm = new VolcanoLLMClient({
    apiKey,
    modelIds: { lite: modelLite, pro: modelPro },
  });

  for (const model of ['lite', 'pro'] as const) {
    console.log(`\n=== ${model} (${model === 'lite' ? modelLite : modelPro}) ===`);
    const start = Date.now();
    const r = await llm.ask('请只回答两个字：你好', { model, timeoutMs: 30_000 });
    const ms = Date.now() - start;
    if (r.ok) {
      console.log(`✅ ${ms}ms — content: ${String(r.value).slice(0, 60)}`);
    } else {
      console.log(`❌ ${ms}ms — ${r.error.code}: ${r.error.message}`);
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
