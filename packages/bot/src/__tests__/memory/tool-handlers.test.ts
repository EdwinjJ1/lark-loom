import { describe, it, expect, vi } from 'vitest';
import { ok, err, makeError, ErrorCode } from '@seedhac/contracts';
import type { Skill, ToolCall } from '@seedhac/contracts';
import { qaSkill } from '@seedhac/skills';
import { getLLMTools, makeExecutor } from '../../memory/tool-handlers.js';
import type { MemoryStore } from '../../memory/memory-store.js';
import type { MemoryRecord } from '@seedhac/contracts';

// ─── helpers ─────────────────────────────────────────────────────────────────

const CHAT_ID = 'oc_test_chat';
const DOCS_ROOT = '/fake/docs/bot-memory';

const mockRecord: MemoryRecord = {
  kind: 'project',
  chat_id: CHAT_ID,
  key: 'sprint-goal',
  content: '本 sprint 目标：完成 M3 工具层',
  importance: 8,
  last_access: 1000,
  created_at: 900,
  source_skill: 'archive',
};

function makeStore(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    read: vi.fn().mockResolvedValue(ok(mockRecord)),
    search: vi.fn().mockResolvedValue(ok([mockRecord])),
    write: vi.fn().mockResolvedValue(ok(mockRecord)),
    score: vi.fn().mockResolvedValue(ok(8)),
    ...overrides,
  } as unknown as MemoryStore;
}

const mockLogger = { info: vi.fn(), warn: vi.fn() };

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, name, argumentsRaw: JSON.stringify(args) };
}

// ─── getLLMTools ──────────────────────────────────────────────────────────────

describe('getLLMTools', () => {
  it('returns 5 tools with required fields', () => {
    // M6（PR #87 / #85）加了 memory.write，从 4 个增到 5 个
    const tools = getLLMTools();
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory.read');
    expect(names).toContain('memory.search');
    expect(names).toContain('memory.write');
    expect(names).toContain('skill.list');
    expect(names).toContain('skill.read');
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.parameters).toBe('object');
    }
  });
});

// ─── memory.read ─────────────────────────────────────────────────────────────

describe('memory.read', () => {
  it('happy path: returns found=true + record', async () => {
    const store = makeStore();
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    const toolResult = await exec(makeCall('memory.read', { kind: 'project', key: 'sprint-goal' }));

    expect(toolResult.name).toBe('memory.read');
    const data = JSON.parse(toolResult.content) as { found: boolean; record: MemoryRecord };
    expect(data.found).toBe(true);
    expect(data.record.key).toBe('sprint-goal');
    expect(store.read).toHaveBeenCalledWith('project', CHAT_ID, 'sprint-goal');
  });

  it('error case: store returns err → content has error field', async () => {
    const store = makeStore({
      read: vi.fn().mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'bitable down'))),
    });
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    const toolResult = await exec(makeCall('memory.read', { kind: 'chat', key: 'k1' }));

    const data = JSON.parse(toolResult.content) as { error: string };
    expect(data.error).toContain('bitable down');
  });
});

// ─── memory.search ───────────────────────────────────────────────────────────

describe('memory.search', () => {
  it('happy path: returns records array', async () => {
    const store = makeStore();
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    const toolResult = await exec(
      makeCall('memory.search', { chat_id: CHAT_ID, query: 'sprint', limit: 3 }),
    );

    const data = JSON.parse(toolResult.content) as { records: MemoryRecord[] };
    expect(Array.isArray(data.records)).toBe(true);
    expect(data.records[0]?.key).toBe('sprint-goal');
    expect(store.search).toHaveBeenCalledWith(CHAT_ID, 'sprint', { limit: 3 });
  });

  it('R2: LLM 传入不同 chat_id 时强制使用 deps.chatId（不泄露其他群数据）', async () => {
    const store = makeStore();
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    await exec(makeCall('memory.search', { chat_id: 'oc_attacker_group', query: 'secret' }));

    // 无论 LLM 传什么 chat_id，store.search 必须收到 deps.chatId
    expect(store.search).toHaveBeenCalledWith(CHAT_ID, 'secret', expect.anything());
  });

  it('error case: store returns err → content has error field', async () => {
    const store = makeStore({
      search: vi.fn().mockResolvedValue(err(makeError(ErrorCode.FEISHU_API_ERROR, 'timeout'))),
    });
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    const toolResult = await exec(makeCall('memory.search', { query: 'foo' }));

    const data = JSON.parse(toolResult.content) as { error: string };
    expect(data.error).toContain('timeout');
  });
});

// ─── skill.list ──────────────────────────────────────────────────────────────

describe('skill.list', () => {
  it('happy path: returns all registered skills with name + description', async () => {
    const store = makeStore();
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    const toolResult = await exec(makeCall('skill.list', {}));

    const data = JSON.parse(toolResult.content) as {
      skills: { name: string; description: string }[];
    };
    expect(Array.isArray(data.skills)).toBe(true);
    expect(data.skills.length).toBeGreaterThan(0);
    for (const s of data.skills) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
    }
  });

  it('no skill name required — invalid args still returns list', async () => {
    const store = makeStore();
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger: mockLogger, docsRoot: DOCS_ROOT });

    // Even with garbage args it should not throw
    const toolResult = await exec({ id: 'c1', name: 'skill.list', argumentsRaw: '{}' });
    expect(() => JSON.parse(toolResult.content)).not.toThrow();
  });

  it('uses the executor-injected skills instead of the global registry', async () => {
    const store = makeStore();
    const injectedSkill: Skill = {
      ...qaSkill,
      name: 'qa',
      metadata: {
        description: 'Only QA is enabled in this runtime',
        when_to_use: 'Use for injected registry tests',
        examples: ['@bot test injected skills'],
      },
    };
    const exec = makeExecutor({
      store,
      skills: [injectedSkill],
      chatId: CHAT_ID,
      logger: mockLogger,
      docsRoot: DOCS_ROOT,
    });

    const toolResult = await exec(makeCall('skill.list', {}));

    const data = JSON.parse(toolResult.content) as {
      skills: { name: string; description: string; when_to_use: string; examples: string[] }[];
    };
    expect(data.skills).toEqual([
      {
        name: 'qa',
        description: 'Only QA is enabled in this runtime',
        when_to_use: 'Use for injected registry tests',
        examples: ['@bot test injected skills'],
      },
    ]);
  });
});

// ─── skill.read ──────────────────────────────────────────────────────────────

describe('skill.read', () => {
  it('happy path: returns file content via injected readFileFn', async () => {
    const fakeContent = '# recall — 主动浮信息\n触发条件：...';
    const readFileFn = vi.fn().mockResolvedValue(fakeContent);
    const store = makeStore();
    const exec = makeExecutor({
      store,
      chatId: CHAT_ID,
      logger: mockLogger,
      docsRoot: DOCS_ROOT,
      readFileFn,
    });

    const toolResult = await exec(makeCall('skill.read', { name: 'recall' }));

    expect(toolResult.content).toBe(fakeContent);
    expect(readFileFn).toHaveBeenCalledWith(expect.stringContaining('recall.md'));
  });

  it('error case: file not found → returns error JSON', async () => {
    const readFileFn = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const store = makeStore();
    const exec = makeExecutor({
      store,
      chatId: CHAT_ID,
      logger: mockLogger,
      docsRoot: DOCS_ROOT,
      readFileFn,
    });

    const toolResult = await exec(makeCall('skill.read', { name: 'nonexistent' }));

    const data = JSON.parse(toolResult.content) as { error: string };
    expect(data.error).toContain('nonexistent');
  });
});

// ─── 日志 ────────────────────────────────────────────────────────────────────

describe('executor logging', () => {
  it('logs info on each tool call with tool name and ms', async () => {
    const store = makeStore();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const exec = makeExecutor({ store, chatId: CHAT_ID, logger, docsRoot: DOCS_ROOT });

    await exec(makeCall('skill.list', {}));

    expect(logger.info).toHaveBeenCalledWith(
      'tool called',
      expect.objectContaining({ tool: 'skill.list', ms: expect.any(Number) }),
    );
  });
});
