/**
 * 端到端跑一次 requirementDoc 完整流程，对一个真实的 chatId：
 *   - fetchHistory（拉真实群历史）
 *   - expandMergeForward（展开真实合并转发卡）
 *   - fetchLinkedDocs（读真实 wiki 正文）
 *   - 跳过 lite 预筛，直接把 historyExpanded + linkedDocs 喂 pro
 *   - 打印 PRD JSON
 *   - 自动检测 K12 / 测试 PRD / 补充内容 三组关键词是否都在
 *
 * 用法: pnpm --filter @seedhac/bot exec node --env-file=../../.env --import tsx/esm src/scripts/smoke-req-doc-full.ts <chat_id>
 */

import { createBotRuntime } from '../bot-runtime.js';
import { createDocxClient } from '../docx-client.js';
import { VolcanoLLMClient } from '../llm-client.js';
import {
  REQ_PROMPT,
  RequirementDocSchema,
  parseFeishuDocUrls,
} from '../../../skills/dist/prompts/requirement-doc.js';
import type { Message } from '@seedhac/contracts';

const argChat = process.argv[2];
if (!argChat) {
  console.error('Usage: smoke-req-doc-full.ts <chat_id>');
  process.exit(1);
}
const TARGET_CHAT: string = argChat;

async function main(): Promise<void> {
  const runtime = createBotRuntime();
  const docx = createDocxClient();
  const llm = new VolcanoLLMClient({
    apiKey: process.env['ARK_API_KEY'] ?? '',
    modelIds: {
      lite: process.env['ARK_MODEL_LITE'] ?? '',
      pro: process.env['ARK_MODEL_PRO'] ?? '',
    },
  });

  console.log(`=== fetchHistory(${TARGET_CHAT}) ===`);
  const histResult = await runtime.fetchHistory({ chatId: TARGET_CHAT, pageSize: 20 });
  if (!histResult.ok) {
    console.error('fetchHistory failed:', histResult.error);
    process.exit(1);
  }

  console.log(`got ${histResult.value.messages.length} raw messages`);
  for (const m of histResult.value.messages) {
    console.log(
      `  [${m.contentType}] mid=${m.messageId.slice(-12)} text="${m.text.slice(0, 60)}"`,
    );
  }

  console.log('\n=== expandMergeForward ===');
  const expanded: Message[] = [];
  const forwardedIds = new Set<string>();
  for (const m of histResult.value.messages) {
    if ((m.contentType as string) !== 'merge_forward') {
      expanded.push(m);
      continue;
    }
    console.log(`expanding merge_forward ${m.messageId.slice(-12)}`);
    const fetched = await runtime.fetchMessage(m.messageId);
    if (!fetched.ok) {
      console.log(`  fail: ${fetched.error.message}`);
      expanded.push(m);
      continue;
    }
    const children = fetched.value.messages.filter(
      (c) => (c.contentType as string) === 'text' && c.text.trim().length > 0,
    );
    console.log(`  expanded into ${children.length} text children:`);
    for (const c of children) {
      console.log(`    - "${c.text.slice(0, 80)}"`);
      expanded.push(c);
      forwardedIds.add(c.messageId);
    }
  }

  console.log(`\nforwardedIds (${forwardedIds.size} entries): ${[...forwardedIds].map((id) => id.slice(-8)).join(', ')}`);

  console.log('\n=== parseFeishuDocUrls + readContent ===');
  const urls = parseFeishuDocUrls(expanded);
  const linkedDocs: Array<{ kind: 'doc' | 'wiki'; url: string; content: string }> = [];
  for (const u of urls) {
    const r = await docx.readContent(u.token, u.kind);
    if (!r.ok) {
      console.log(`  ${u.kind} ${u.token}: ERR ${r.error.message}`);
      continue;
    }
    console.log(`  ${u.kind} ${u.token}: ${r.value.length} chars`);
    linkedDocs.push({ kind: u.kind, url: u.url, content: r.value });
  }

  console.log('\n=== pro 主提取（跳过 lite 预筛模拟最佳情况，所有 expanded + linkedDocs 都进 prompt）===');
  const result = await llm.askStructured(REQ_PROMPT(expanded, linkedDocs), RequirementDocSchema, {
    model: 'pro',
    timeoutMs: 90_000,
  });
  if (!result.ok) {
    console.error('LLM failed:', result.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.value, null, 2));

  const json = JSON.stringify(result.value);
  const checks = [
    { name: 'K12 备课助手 (转发文本)', re: /K12|教师|备课|教材|教学目标|知识点|课堂|课后练习|数学.{0,5}语文/ },
    { name: '测试 PRD wiki', re: /1v1|私聊|分工|PPT/ },
    { name: '补充内容 wiki', re: /海外|语音|印尼|泰国|越南|SDK|甲方|下个月|一号/ },
  ];
  console.log('\n=== 来源覆盖检测 ===');
  for (const c of checks) {
    console.log(`${c.re.test(json) ? '✓' : '✗'} ${c.name}: ${c.re.test(json)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
