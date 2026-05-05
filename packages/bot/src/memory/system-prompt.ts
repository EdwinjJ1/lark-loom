/**
 * M3 — System Prompt 组装器（Harness 风格）
 *
 * 不在 prompt 里灌完整文档——只告诉模型"项目是什么、有哪些工具、怎么按需调"。
 * 具体 Skill 文档由模型主动调 skill.read 拉取。
 *
 * 使用方式：
 *   const cache = await SystemPromptCache.load(docsRoot);
 *   const prompt = cache.build({ chatId, mention: true });
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { skills } from '@seedhac/skills';

import { truncateToBytes } from './text-utils.js';

// ─── 工具一句话摘要（与 tool-handlers.ts 的 TOOLS 保持同步）───────────────────

const TOOL_LINES = [
  'memory.read(kind, key)                    — 精确读取当前群的一条记忆',
  'memory.search(query, limit?)              — 关键词模糊检索当前群的记忆',
  'memory.write(kind, key, content, imp?)    — 写入/更新一条记忆（项目背景/目标/分工/决策等可记忆事实，主动调用）',
  'skill.list()                              — 列出所有 Skill 名称与描述',
  'skill.read(name)                          — 获取指定 Skill 的完整文档',
];

// ─── 缓存 ───────────────────────────────────────────────────────────────────────

export interface SystemPromptLoadOptions {
  readonly strict?: boolean;
}

export class SystemPromptCache {
  private constructor(
    private readonly overviewText: string,
    private readonly overviewFirstLine: string,
    private readonly skillSummaries: readonly string[],
  ) {}

  /**
   * 启动时调用：读取 OVERVIEW.md 首行（项目定位句）和所有 skills/*.md 首行摘要。
   * 默认文件缺失时静默降级；strict=true 时缺文件启动失败。
   */
  static async load(
    docsRoot: string,
    opts: SystemPromptLoadOptions = {},
  ): Promise<SystemPromptCache> {
    const overviewPath = resolve(docsRoot, 'OVERVIEW.md');
    const overviewText = await readDoc(overviewPath, opts.strict ?? false);
    const overviewFirstLine = firstMeaningfulLine(overviewText);

    const skillSummaries = await Promise.all(
      skills.map(async (s) => {
        const content = await readDoc(
          resolve(docsRoot, 'skills', `${s.name}.md`),
          opts.strict ?? false,
        );
        const firstLine = firstMeaningfulLine(content);
        return firstLine ? `${s.name}: ${firstLine}` : `${s.name}: ${s.metadata.description}`;
      }),
    );

    return new SystemPromptCache(overviewText, overviewFirstLine, skillSummaries);
  }

  getOverviewText(): string {
    return this.overviewText;
  }

  /**
   * 组装最终 system prompt，≤ 2KB。
   * chatId 为空时（极端 case）不崩溃，用占位符代替。
   */
  build({ chatId, mention = false }: { chatId?: string; mention?: boolean }): string {
    const effectiveChatId = chatId ?? '(unknown)';
    const mentionLine = mention ? '用户 @了 Bot，请积极回应。\n' : '';

    const lines = [
      `# Lark Loom — 飞书群聊 AI 助手`,
      this.overviewFirstLine || '群聊上下文感知助手，主动介入信息缺口。',
      '',
      `当前群组：${effectiveChatId}`,
      mentionLine,
      '## 可用工具',
      ...TOOL_LINES.map((l) => `- ${l}`),
      '',
      '## 已注册 Skill',
      ...this.skillSummaries.map((l) => `- ${l}`),
      '',
      '> 需要细节请调 skill.read 或 memory.search，不要凭空推测。',
    ].join('\n');

    return truncateToBytes(lines, 2 * 1024);
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

async function readDoc(filePath: string, strict: boolean): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    if (strict) throw new Error(`Required bot-memory doc missing: ${filePath}`);
    return '';
  }
}

function firstMeaningfulLine(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return '';
}
