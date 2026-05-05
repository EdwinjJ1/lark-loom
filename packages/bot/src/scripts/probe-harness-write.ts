/**
 * A 计划：探测 harness 决策路径会不会主动调 memory.write
 *
 * 不走 ws，直接构造一条"含项目背景的 @bot 消息"，喂给跟生产一样的 chatWithTools 路径。
 * 关键：在 tools 列表里**额外注入**一个虚假的 memory.write 工具描述，看模型会不会调它。
 *
 * 输出：
 *   - 模型每一轮发起的 tool 调用名 + 参数
 *   - 最终 content
 * 解读：
 *   - 如果模型调了 memory.write → 改 tool-handlers.ts 加上真实实现就行
 *   - 如果没调 → 决策 prompt 需要改造（C 计划）
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChatMessage, LLMTool, ToolCall, ToolResult } from '@seedhac/contracts';

import { VolcanoLLMClient } from '../llm-client.js';
import { SystemPromptCache } from '../memory/system-prompt.js';
import { getLLMTools } from '../memory/tool-handlers.js';

const DOCS_ROOT =
  process.env['BOT_DOCS_ROOT'] ??
  resolve(fileURLToPath(import.meta.url), '../../../../../docs/bot-memory');

// ─── 注入一个假的 memory.write 工具 ─────────────────────────────────────────────

const FAKE_WRITE_TOOL: LLMTool = {
  name: 'memory.write',
  description:
    '把一条记忆写入当前群。当用户消息包含可记忆的事实（项目名、目标、用户群体、deadline、文档链接、关键决策等）时，应主动调用。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['project', 'chat', 'user', 'skill_log'],
        description: '记忆类型；项目背景/需求用 project',
      },
      key: { type: 'string', description: '幂等键，同 (kind, key) 唯一定位一条记忆' },
      content: { type: 'string', description: '要记录的事实文本，简洁不要超过 500 字' },
      importance: { type: 'number', minimum: 1, maximum: 10, description: '重要度 1-10' },
    },
    required: ['kind', 'key', 'content'],
  },
};

// ─── 测试消息 ──────────────────────────────────────────────────────────────────

const TEST_MESSAGE = `@Lark Loom 你记忆一下，这是项目的：基于 IM 的办公协同智能助手（公开版）

赛道定位与能力考察重点：
- AI Native 思考者，能将 Agent 思维融入产品设计
- 多端复杂环境下的工程落地能力
- 客户端基础（移动端/桌面端一致性）
- 工程与产品能力，端到端高质量交付

具体命题：Agent-Pilot · 从 IM 对话到演示稿的一键智能闭环
背景：在快节奏的团队协作中，一个需求往往始于一次 IM 对话。
目标用户：项目经理。MVP 本月内交付。`;

// ─── 主流程：模拟生产 wiring 的 handleWithHarness 关键步骤 ───────────────────

async function main(): Promise<void> {
  const apiKey = process.env['ARK_API_KEY'];
  const modelLite = process.env['ARK_MODEL_LITE'];
  const modelPro = process.env['ARK_MODEL_PRO'];
  if (!apiKey || !modelLite || !modelPro) {
    console.error('缺 ARK_API_KEY / ARK_MODEL_LITE / ARK_MODEL_PRO');
    process.exit(1);
  }

  const llm = new VolcanoLLMClient({
    apiKey,
    modelIds: { lite: modelLite, pro: modelPro },
  });

  const promptCache = await SystemPromptCache.load(DOCS_ROOT, { strict: false });
  const systemPrompt = promptCache.build({ chatId: 'oc_probe', mention: true });

  // tools = 真实 4 个 + 假的 memory.write
  const tools: LLMTool[] = [...getLLMTools(), FAKE_WRITE_TOOL];

  const skillChoices = ['qa', 'recall', 'summary', 'slides', 'requirementDoc', 'silent'].join('|');
  const decisionInstruction =
    '请按需调用 skill.list / skill.read / memory.search / memory.write，然后只输出 JSON：' +
    `{"skill":"${skillChoices}","reason":"一句话原因","args":{}}。` +
    '如果不应处理，skill 必须是 "silent"。不要输出 JSON 以外的文字。';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${TEST_MESSAGE}\n\n${decisionInstruction}` },
  ];

  const toolCallLog: Array<{ name: string; args: unknown }> = [];

  const executor = async (call: ToolCall): Promise<ToolResult> => {
    let args: unknown = {};
    try {
      args = JSON.parse(call.argumentsRaw);
    } catch {
      // ignore
    }
    toolCallLog.push({ name: call.name, args });
    console.log(`  → tool call: ${call.name}`);
    console.log(`    args: ${JSON.stringify(args)}`);

    if (call.name === 'memory.write') {
      console.log('    [stub] 假装写入成功');
      return { toolCallId: call.id, name: call.name, content: JSON.stringify({ ok: true, recordId: 'fake-id' }) };
    }
    if (call.name === 'memory.search' || call.name === 'memory.read') {
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({ records: [], found: false }),
      };
    }
    if (call.name === 'skill.list') {
      return {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({
          skills: [
            { name: 'qa', description: '直接问答' },
            { name: 'recall', description: '查找历史记忆并回答' },
            { name: 'summary', description: '总结会议' },
            { name: 'slides', description: '生成演示稿' },
            { name: 'requirementDoc', description: '把项目需求整理成飞书文档' },
          ],
        }),
      };
    }
    return { toolCallId: call.id, name: call.name, content: JSON.stringify({}) };
  };

  console.log('=== Probe: 是否会主动调 memory.write ===');
  console.log(`系统提示长度: ${systemPrompt.length} 字符`);
  console.log(`用户消息长度: ${TEST_MESSAGE.length} 字符`);
  console.log('');
  console.log('开始调用 chatWithTools (model=pro)...');
  const start = Date.now();

  const result = await llm.chatWithTools(messages, {
    tools,
    executor,
    maxToolCallRounds: 5,
    model: 'lite',
    timeoutMs: 60_000,
  });

  const elapsed = Date.now() - start;
  console.log('');
  console.log(`=== 完成 (${elapsed}ms) ===`);

  if (!result.ok) {
    console.error('chatWithTools 失败:', result.error);
    process.exit(1);
  }

  console.log(`轮数: ${result.value.rounds}`);
  console.log(`工具调用次数: ${result.value.toolCalls.length}`);
  console.log('');
  console.log('调用过的工具:');
  for (const c of toolCallLog) {
    console.log(`  - ${c.name}`);
  }
  console.log('');
  console.log('最终 content:');
  console.log(result.value.content);
  console.log('');

  const wroteMemory = toolCallLog.some((c) => c.name === 'memory.write');
  console.log('=== 结论 ===');
  if (wroteMemory) {
    console.log('✅ 模型主动调了 memory.write — 只需在 tool-handlers.ts 注册真实 write 工具即可');
  } else {
    console.log('❌ 模型没主动调 memory.write — 决策 prompt 需要改造（C 计划）');
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
