/**
 * 真实端到端验证：
 *   1) 用 docx-client 读两份 wiki 的真实正文
 *   2) 喂给主提取 prompt 跑 pro 模型
 *   3) 打印 LLM 返回的 PRD JSON
 * 目的：在让用户群测之前，先在本地确认 LLM 在新 prompt + 两份文档下能正确融合内容。
 *
 * 用法: pnpm --filter @seedhac/bot exec node --env-file=../../.env --import tsx/esm src/scripts/smoke-req-doc-merge.ts
 */

import { createDocxClient } from '../docx-client.js';
import { VolcanoLLMClient } from '../llm-client.js';
// 直接读 dist 文件（绕过 package "exports" 限制）
import { REQ_PROMPT, RequirementDocSchema } from '../../../skills/dist/prompts/requirement-doc.js';

const WIKI_TOKENS = ['Fgowwu23ciUrdAkQ77Dc4iZZnPg', 'APh5wzGsjiFY3pkScZjcJpUbnQe'];

async function main(): Promise<void> {
  const docx = createDocxClient();
  const llm = new VolcanoLLMClient({
    apiKey: process.env['ARK_API_KEY'] ?? '',
    modelIds: {
      lite: process.env['ARK_MODEL_LITE'] ?? '',
      pro: process.env['ARK_MODEL_PRO'] ?? '',
    },
  });

  const linkedDocs: Array<{ kind: 'wiki'; url: string; content: string }> = [];
  for (const token of WIKI_TOKENS) {
    const res = await docx.readContent(token, 'wiki');
    if (!res.ok) {
      console.error(`read ${token} failed:`, res.error.message);
      continue;
    }
    console.log(`--- ${token} ---`);
    console.log(res.value.trim());
    console.log('');
    linkedDocs.push({
      kind: 'wiki',
      url: `https://jcneyh7qlo8i.feishu.cn/wiki/${token}`,
      content: res.value,
    });
  }

  console.log('=== 调主提取（pro，timeoutMs=90s）===');
  const prompt = REQ_PROMPT([], linkedDocs);
  const result = await llm.askStructured(prompt, RequirementDocSchema, {
    model: 'pro',
    timeoutMs: 90_000,
  });
  if (!result.ok) {
    console.error('LLM failed:', result.error);
    process.exit(1);
  }
  console.log('=== 生成的 PRD ===');
  console.log(JSON.stringify(result.value, null, 2));

  // 关键检验：是否融合了两份文档？
  const json = JSON.stringify(result.value);
  const hasDoc1Signal = /1v1|私聊|分工|PPT/.test(json);
  const hasDoc2Signal = /海外|语音|印尼|泰国|越南|SDK|甲方|下个月|一号/.test(json);
  console.log('');
  console.log('=== 融合检测 ===');
  console.log(`包含「测试 PRD」wiki 信号 (1v1/私聊/分工/PPT): ${hasDoc1Signal ? '✓' : '✗'}`);
  console.log(`包含「补充内容」wiki 信号 (海外/语音/SDK/甲方/下月一号): ${hasDoc2Signal ? '✓' : '✗'}`);
  console.log(
    hasDoc1Signal && hasDoc2Signal ? '✅ 两份文档已融合' : '❌ 仍有文档没被吸收，需要继续调 prompt',
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
