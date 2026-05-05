/**
 * M3 — LLM 工具处理器
 *
 * 4 个供 chatWithTools 调用的工具：
 *   memory.read   按 (kind, key) 精确读取单条记忆
 *   memory.search 按 chat_id + 关键词模糊检索记忆
 *   skill.list    列出所有 Skill 名称与一句话描述
 *   skill.read    返回指定 Skill 的 docs/bot-memory/skills/<name>.md 全文
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LLMTool, Skill, ToolCall, ToolResult } from '@seedhac/contracts';
import type { MemoryKind } from '@seedhac/contracts';
import { skills as defaultSkills } from '@seedhac/skills';

import type { IMemoryStore } from './memory-store.js';
import { truncateToBytes } from './text-utils.js';

// ─── 工具描述（JSON Schema 子集）────────────────────────────────────────────────

const TOOLS: readonly LLMTool[] = [
  {
    name: 'memory.read',
    description: '按 kind + key 精确读取当前群组的一条记忆记录',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['project', 'chat', 'user', 'skill_log'],
          description: '记忆类型',
        },
        key: { type: 'string', description: '幂等键，同 (kind, key) 唯一定位一条记忆' },
      },
      required: ['kind', 'key'],
    },
  },
  {
    name: 'memory.search',
    description: '在当前群组记忆中按关键词模糊检索，返回最相关的若干条记录',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言描述' },
        limit: { type: 'number', minimum: 1, maximum: 10, description: '返回条数，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory.write',
    description:
      '把一条记忆写入当前群。当用户消息包含可记忆的事实（项目名/目标/用户群体/deadline/文档链接/关键决策/分工等）时，应主动调用。同一 (kind, key) 已存在时会 upsert 更新。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['project', 'chat', 'user', 'skill_log'],
          description: '记忆类型；项目背景/需求用 project，群级偏好用 chat，单人偏好用 user',
        },
        key: {
          type: 'string',
          description: '幂等键（A-Za-z0-9_:.- 内），同 (kind, key) 唯一定位一条记忆，例：project:overview',
        },
        content: { type: 'string', description: '要记录的事实，简洁不要超过 500 字' },
        importance: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: '可选，1-10 重要度；不传则后台 LLM 评分',
        },
      },
      required: ['kind', 'key', 'content'],
    },
  },
  {
    name: 'skill.list',
    description: '列出所有已注册 Skill 的名称和一句话描述',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'skill.read',
    description: '获取指定 Skill 的完整行为规范文档（≤ 2KB）',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称，如 recall / summary / archive' },
      },
      required: ['name'],
    },
  },
];

/** 返回供 chatWithTools 使用的工具列表 */
export function getLLMTools(): LLMTool[] {
  return [...TOOLS];
}

// ─── 日志接口（与 SkillContext.logger 对齐）──────────────────────────────────────

export interface ToolLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

// ─── 工具执行器 ─────────────────────────────────────────────────────────────────

export interface ExecutorDeps {
  readonly store: IMemoryStore;
  /** 当前 runtime 实际启用的 Skill 集合；不传时使用默认全量注册表。 */
  readonly skills?: readonly Skill[];
  /** 当前群组 ID，memory.read 的隐式上下文 */
  readonly chatId: string;
  readonly logger: ToolLogger;
  /** docs/bot-memory 目录绝对路径 */
  readonly docsRoot: string;
  /** memory.write 写入时落到 source_skill 列；区分 harness 主动 / 被动监听 / 具体 skill */
  readonly sourceSkill?: string;
  /** 可注入的文件读取函数，便于测试 mock */
  readonly readFileFn?: (path: string) => Promise<string>;
}

/**
 * 工厂：返回 chatWithTools 的 executor 函数。
 * 每次工具调用都打 info 日志（tool name + args + 耗时）。
 */
export function makeExecutor(deps: ExecutorDeps): (call: ToolCall) => Promise<ToolResult> {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFile(p, 'utf-8'));

  return async (call: ToolCall): Promise<ToolResult> => {
    const start = Date.now();

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.argumentsRaw) as Record<string, unknown>;
    } catch {
      return result(call, JSON.stringify({ error: 'invalid JSON in tool arguments' }));
    }

    const content = await dispatch(call.name, args, deps, readFileFn);
    const ms = Date.now() - start;

    deps.logger.info('tool called', { tool: call.name, args, ms });
    return result(call, content);
  };
}

function result(call: ToolCall, content: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content };
}

// ─── 分发 ──────────────────────────────────────────────────────────────────────

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  deps: ExecutorDeps,
  readFileFn: (path: string) => Promise<string>,
): Promise<string> {
  switch (name) {
    case 'memory.read':
      return handleMemoryRead(args, deps);
    case 'memory.search':
      return handleMemorySearch(args, deps);
    case 'memory.write':
      return handleMemoryWrite(args, deps);
    case 'skill.list':
      return handleSkillList(deps.skills ?? defaultSkills);
    case 'skill.read':
      return handleSkillRead(args, deps.docsRoot, readFileFn);
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}

// ─── 各 handler ────────────────────────────────────────────────────────────────

async function handleMemoryRead(
  args: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<string> {
  const kind = String(args['kind'] ?? '') as MemoryKind;
  const key = String(args['key'] ?? '');

  if (!kind || !key) return JSON.stringify({ error: 'kind and key are required' });

  const r = await deps.store.read(kind, deps.chatId, key);
  if (!r.ok) return JSON.stringify({ error: r.error.message });
  if (r.value === null) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, record: r.value });
}

async function handleMemorySearch(
  args: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<string> {
  const chatId = deps.chatId; // 不信任 LLM 传入的 chat_id，强制用会话上下文（R2）
  const query = String(args['query'] ?? '');
  const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'], 10) : 5;

  if (!query) return JSON.stringify({ error: 'query is required' });

  const r = await deps.store.search(chatId, query, { limit });
  if (!r.ok) return JSON.stringify({ error: r.error.message });
  return JSON.stringify({ records: r.value });
}

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set(['project', 'chat', 'user', 'skill_log']);

async function handleMemoryWrite(
  args: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<string> {
  const kindRaw = String(args['kind'] ?? '');
  const key = String(args['key'] ?? '');
  const content = String(args['content'] ?? '');

  if (!VALID_KINDS.has(kindRaw as MemoryKind)) {
    return JSON.stringify({ error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` });
  }
  if (!key || !content) return JSON.stringify({ error: 'key and content are required' });

  const importance =
    typeof args['importance'] === 'number'
      ? Math.min(Math.max(args['importance'], 1), 10)
      : undefined;

  const r = await deps.store.write({
    kind: kindRaw as MemoryKind,
    chat_id: deps.chatId, // 强制会话上下文，不信任 LLM 传入
    key,
    content,
    source_skill: deps.sourceSkill ?? 'harness',
    ...(importance !== undefined && { importance }),
  });
  if (!r.ok) return JSON.stringify({ error: r.error.message });
  return JSON.stringify({
    ok: true,
    recordId: r.value.id,
    kind: r.value.kind,
    key: r.value.key,
  });
}

function handleSkillList(skills: readonly Skill[]): string {
  const list = skills.map((s) => ({
    name: s.name,
    description: s.metadata.description,
    when_to_use: s.metadata.when_to_use,
    examples: s.metadata.examples,
  }));
  return JSON.stringify({ skills: list });
}

const SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const MAX_SKILL_DOC_BYTES = 2 * 1024;

async function handleSkillRead(
  args: Record<string, unknown>,
  docsRoot: string,
  readFileFn: (path: string) => Promise<string>,
): Promise<string> {
  const name = String(args['name'] ?? '');

  if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'invalid skill name' });

  const filePath = resolve(docsRoot, 'skills', `${name}.md`);
  // 防止路径穿越：确认在 docsRoot 内
  if (!filePath.startsWith(resolve(docsRoot))) {
    return JSON.stringify({ error: 'access denied' });
  }

  let content: string;
  try {
    content = await readFileFn(filePath);
  } catch {
    return JSON.stringify({ error: `skill "${name}" document not found` });
  }

  // 控制在 2KB 内，避免撑爆上下文；truncateToBytes 保证不撕裂多字节字符
  return truncateToBytes(content, MAX_SKILL_DOC_BYTES);
}
