import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MemoryStore,
  MEMORY_MAX_CONTENT_BYTES,
  MEMORY_MAX_PER_CHAT_KIND,
  MEMORY_MAX_TOTAL,
  evictScore,
} from '../memory/memory-store.js';
import type { BitableClient, LLMClient, Result, AppError } from '@seedhac/contracts';
import { ok } from '@seedhac/contracts';

// ────────────────────────────────────────────────────────────────────
// In-memory BitableClient mock — 模拟 Bitable 的 find/insert/update/delete
// ────────────────────────────────────────────────────────────────────

interface FakeRow {
  recordId: string;
  fields: Record<string, unknown>;
}

class FakeBitable implements BitableClient {
  private rows: FakeRow[] = [];
  private nextId = 1;
  public findCalls = 0;
  public updateCalls = 0;
  public deleteCalls = 0;
  public insertCalls = 0;

  /** 朴素 filter 解析：处理 AND(...) + CurrentValue.[字段] = "值" + .contains("...") */
  private matchesFilter(row: FakeRow, filter: string): boolean {
    if (!filter) return true;
    // 简化：抓出所有 CurrentValue.[X] = "Y" 和 .contains("Z")
    const eqMatches = [...filter.matchAll(/CurrentValue\.\[(\w+)\]\s*=\s*"([^"]*)"/g)];
    for (const [, field, expected] of eqMatches) {
      if (String(row.fields[field!]) !== expected) return false;
    }
    const gteMatches = [...filter.matchAll(/CurrentValue\.\[(\w+)\]\s*>=\s*(\d+(?:\.\d+)?)/g)];
    for (const [, field, expected] of gteMatches) {
      const actual = Number(row.fields[field!]);
      if (!Number.isFinite(actual) || actual < Number(expected)) return false;
    }
    const containsMatches = [...filter.matchAll(/CurrentValue\.\[(\w+)\]\.contains\("([^"]*)"\)/g)];
    for (const [, field, needle] of containsMatches) {
      if (!String(row.fields[field!] ?? '').includes(needle!)) return false;
    }
    return true;
  }

  async find(params: {
    table: string;
    filter?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<
    Result<{
      records: readonly (Record<string, unknown> & { tableId: string; recordId: string })[];
      hasMore: boolean;
      nextPageToken?: string;
    }>
  > {
    this.findCalls++;
    const matched = this.rows.filter((r) => this.matchesFilter(r, params.filter ?? ''));
    const limit = params.pageSize ?? 20;
    const offset = params.pageToken !== undefined ? parseInt(params.pageToken, 10) : 0;
    const records = matched.slice(offset, offset + limit).map((r) => ({
      ...r.fields,
      tableId: 'tbl_memory',
      recordId: r.recordId,
    }));
    const hasMore = offset + limit < matched.length;
    const nextPageToken = hasMore ? String(offset + limit) : undefined;
    return ok({ records, hasMore, ...(nextPageToken !== undefined && { nextPageToken }) });
  }

  async insert(params: {
    table: string;
    row: Record<string, unknown>;
  }): Promise<Result<{ tableId: string; recordId: string }>> {
    this.insertCalls++;
    const recordId = `rec_${this.nextId++}`;
    this.rows.push({ recordId, fields: { ...params.row } });
    return ok({ tableId: 'tbl_memory', recordId });
  }

  async update(params: {
    table: string;
    recordId: string;
    patch: Record<string, unknown>;
  }): Promise<Result<void>> {
    this.updateCalls++;
    const row = this.rows.find((r) => r.recordId === params.recordId);
    if (row) Object.assign(row.fields, params.patch);
    return ok(undefined);
  }

  async delete(params: { table: string; recordId: string }): Promise<Result<void>> {
    this.deleteCalls++;
    this.rows = this.rows.filter((r) => r.recordId !== params.recordId);
    return ok(undefined);
  }

  async batchInsert(): Promise<Result<readonly { tableId: string; recordId: string }[]>> {
    return ok([]);
  }

  async link(): Promise<Result<void>> {
    return ok(undefined);
  }

  async readTable(_appToken: string, _tableId: string, _maxRows?: number): Promise<Result<string>> {
    return ok('');
  }

  // ---- 测试辅助 ----
  size(): number {
    return this.rows.length;
  }

  get all(): readonly FakeRow[] {
    return this.rows;
  }

  /** 直接植入数据（绕过 insert，避免触发护栏副作用） */
  seed(rows: FakeRow[]): void {
    for (const r of rows) {
      this.rows.push({ ...r });
      const n = parseInt(r.recordId.replace('rec_', ''), 10);
      if (!isNaN(n) && n >= this.nextId) this.nextId = n + 1;
    }
  }
}

class FakeLLM implements LLMClient {
  public scoreCallCount = 0;
  /** 测试可设：默认返回 importance=7 */
  public nextScore = 7;

  async ask(): Promise<Result<string>> {
    return ok('');
  }
  async chat(): Promise<Result<string>> {
    return ok('');
  }
  async chatWithTools(): Promise<Result<{ content: string; toolCalls: never[]; rounds: number }>> {
    return ok({ content: '', toolCalls: [], rounds: 0 });
  }
  async askStructured<T>(
    _prompt: string,
    schema: { parse: (v: unknown) => T },
  ): Promise<Result<T>> {
    this.scoreCallCount++;
    try {
      return ok(schema.parse({ importance: this.nextScore }));
    } catch (e) {
      return {
        ok: false,
        error: { code: 'LLM_INVALID_RESPONSE' as const, message: String(e) } as AppError,
      };
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────────────────────────────

describe('MemoryStore.evictScore', () => {
  const NOW = Date.UTC(2026, 4, 4); // 固定时间

  it('importance 高 + 最近访问 → 高分', () => {
    const high = evictScore({ importance: 9, last_access: NOW }, NOW);
    expect(high).toBeGreaterThan(8);
  });

  it('importance 低 + 30 天前访问 → 低分', () => {
    const low = evictScore({ importance: 1, last_access: NOW - 30 * 24 * 3600 * 1000 }, NOW);
    expect(low).toBeLessThan(1);
  });

  it('未评分（importance=-1）按 5 处理，避免新记忆被立即淘汰', () => {
    const newish = evictScore({ importance: -1, last_access: NOW }, NOW);
    const scoredLow = evictScore({ importance: 0, last_access: NOW }, NOW);
    expect(newish).toBeGreaterThan(scoredLow);
  });

  it('importance=10 + 30 天前 vs importance=0 + 现在：高 importance 更稳', () => {
    const oldImportant = evictScore(
      { importance: 10, last_access: NOW - 30 * 24 * 3600 * 1000 },
      NOW,
    );
    const newTrivial = evictScore({ importance: 0, last_access: NOW }, NOW);
    expect(oldImportant).toBeGreaterThan(newTrivial);
  });
});

describe('MemoryStore.write — 大小护栏', () => {
  let bitable: FakeBitable;
  let store: MemoryStore;

  beforeEach(() => {
    bitable = new FakeBitable();
    store = new MemoryStore({ bitable, now: () => 1_000_000 });
  });

  it('单条 content 超 2KB 被硬截断', async () => {
    const huge = 'x'.repeat(MEMORY_MAX_CONTENT_BYTES * 2); // 4KB
    const result = await store.write({
      kind: 'project',
      chat_id: 'GLOBAL',
      key: 'big',
      content: huge,
      source_skill: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const bytes = new TextEncoder().encode(result.value.content).length;
      expect(bytes).toBeLessThanOrEqual(MEMORY_MAX_CONTENT_BYTES);
    }
  });

  it('UTF-8 多字节字符不被撕裂', async () => {
    // 1024 个 "你"（3 字节 each）= 3072 字节，超过 2KB
    const cn = '你'.repeat(1024);
    const result = await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'cn-test',
      content: cn,
      source_skill: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 截断后仍能正常解析（不出现替换字符 �）
      expect(result.value.content).not.toContain('�');
    }
  });
});

describe('MemoryStore.write — upsert 语义', () => {
  it('同 (kind, chat_id, key) 写两次：update 而非新增', async () => {
    const bitable = new FakeBitable();
    const store = new MemoryStore({ bitable, now: () => 1000 });

    const r1 = await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'topic',
      content: '第一版',
      source_skill: 'qa',
    });
    expect(r1.ok).toBe(true);
    expect(bitable.size()).toBe(1);

    const r2 = await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'topic',
      content: '第二版',
      source_skill: 'qa',
    });
    expect(r2.ok).toBe(true);
    expect(bitable.size()).toBe(1); // 仍只有 1 条
    expect(bitable.updateCalls).toBeGreaterThan(0);
    if (r2.ok) expect(r2.value.content).toBe('第二版');
  });

  it('显式传 importance 跳过 LLM 评分队列', async () => {
    const bitable = new FakeBitable();
    const llm = new FakeLLM();
    const store = new MemoryStore({ bitable, llm, scoreFlushMs: 1, now: () => 1000 });

    await store.write({
      kind: 'project',
      chat_id: 'GLOBAL',
      key: 'rule',
      content: '红线',
      source_skill: 'init',
      importance: 10,
    });
    await store.flushScoreQueue();
    expect(llm.scoreCallCount).toBe(0);
  });
});

describe('MemoryStore.read', () => {
  it('精确读取并刷新 last_access', async () => {
    const bitable = new FakeBitable();
    let now = 1000;
    const store = new MemoryStore({ bitable, now: () => now });

    await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'k1',
      content: 'hello',
      source_skill: 'qa',
    });

    now = 2000;
    const result = await store.read('chat', 'oc_1', 'k1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.content).toBe('hello');
    }

    // 等异步刷新完成
    await new Promise((r) => setTimeout(r, 10));
    expect(bitable.all[0]!.fields.last_access).toBe(2000);
  });

  it('未命中返回 null', async () => {
    const bitable = new FakeBitable();
    const store = new MemoryStore({ bitable, now: () => 1000 });

    const result = await store.read('chat', 'oc_1', 'nonexistent');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

describe('MemoryStore.list/delete', () => {
  it('lists records by kind/chat/minImportance and deletes compressed records', async () => {
    const bitable = new FakeBitable();
    const store = new MemoryStore({ bitable, now: () => 1000 });
    bitable.seed([
      {
        recordId: 'rec_1',
        fields: {
          kind: 'skill_log',
          chat_id: 'chat_a',
          key: 'log_1',
          content: 'important',
          importance: 8,
          last_access: 900,
          created_at: 900,
          source_skill: 'qa',
        },
      },
      {
        recordId: 'rec_2',
        fields: {
          kind: 'skill_log',
          chat_id: 'chat_a',
          key: 'log_2',
          content: 'low',
          importance: 4,
          last_access: 900,
          created_at: 900,
          source_skill: 'summary',
        },
      },
      {
        recordId: 'rec_3',
        fields: {
          kind: 'project',
          chat_id: 'chat_a',
          key: 'snapshot',
          content: 'snapshot',
          importance: 9,
          last_access: 900,
          created_at: 900,
          source_skill: 'weekly',
        },
      },
    ]);

    const listed = await store.list({ chatId: 'chat_a', kind: 'skill_log', minImportance: 7 });

    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((m) => m.key)).toEqual(['log_1']);
      const deleted = await store.delete(listed.value[0]!);
      expect(deleted.ok).toBe(true);
    }
    expect(bitable.deleteCalls).toBe(1);
    expect(bitable.size()).toBe(2);
  });
});

describe('MemoryStore.search', () => {
  it('按 chat_id + 关键词模糊匹配', async () => {
    const bitable = new FakeBitable();
    const store = new MemoryStore({ bitable, now: () => 1000 });

    await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'a',
      content: '今天讨论了产品红线',
      source_skill: 'qa',
    });
    await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'b',
      content: '会议纪要：明天交付',
      source_skill: 'summary',
    });
    await store.write({
      kind: 'chat',
      chat_id: 'oc_2',
      key: 'c',
      content: '另一群的产品红线',
      source_skill: 'qa',
    });

    const result = await store.search('oc_1', '红线');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.key).toBe('a');
    }
  });

  it('limit 默认 10，最大 50', async () => {
    const bitable = new FakeBitable();
    const store = new MemoryStore({ bitable, now: () => 1000 });

    for (let i = 0; i < 15; i++) {
      await store.write({
        kind: 'chat',
        chat_id: 'oc_1',
        key: `k${i}`,
        content: `通用内容 ${i}`,
        source_skill: 'qa',
      });
    }

    const r1 = await store.search('oc_1', '通用');
    if (r1.ok) expect(r1.value.length).toBeLessThanOrEqual(10);

    const r2 = await store.search('oc_1', '通用', { limit: 5 });
    if (r2.ok) expect(r2.value).toHaveLength(5);

    // 上限 50 防御
    const r3 = await store.search('oc_1', '通用', { limit: 999 });
    if (r3.ok) expect(r3.value.length).toBeLessThanOrEqual(50);
  });
});

describe('MemoryStore — 容量护栏', () => {
  it('单 chat+kind 超 200 → 触发淘汰', async () => {
    const bitable = new FakeBitable();
    const now = Date.now();
    const store = new MemoryStore({ bitable, now: () => now });

    // 直接 seed 200 条已存在记忆，importance/last_access 渐变
    const seedRows: FakeRow[] = [];
    for (let i = 0; i < MEMORY_MAX_PER_CHAT_KIND; i++) {
      seedRows.push({
        recordId: `rec_${i + 1}`,
        fields: {
          kind: 'chat',
          chat_id: 'oc_1',
          key: `k${i}`,
          content: `c${i}`,
          importance: i === 0 ? 0 : 8, // rec_1 是最低分
          last_access: now - (i === 0 ? 30 * 86400_000 : 0),
          created_at: now,
          source_skill: 'seed',
        },
      });
    }
    bitable.seed(seedRows);

    // 写第 201 条，触发护栏
    await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'k_new',
      content: 'new',
      source_skill: 'qa',
      importance: 9,
    });

    // 等 fire-and-forget enforceCapacity 完成
    await new Promise((r) => setTimeout(r, 50));

    expect(bitable.deleteCalls).toBeGreaterThan(0);
    // 最低分（rec_1）应被淘汰
    expect(bitable.all.find((r) => r.recordId === 'rec_1')).toBeUndefined();
    // 新记录还在
    expect(bitable.all.find((r) => r.fields.key === 'k_new')).toBeDefined();
  });

  it('全表超 2000 → 触发淘汰', async () => {
    const bitable = new FakeBitable();
    const now = Date.now();
    const store = new MemoryStore({ bitable, now: () => now });

    // seed 2000 条来自不同 chat（不会触发单 chat 护栏）
    const seedRows: FakeRow[] = [];
    for (let i = 0; i < MEMORY_MAX_TOTAL; i++) {
      seedRows.push({
        recordId: `rec_${i + 1}`,
        fields: {
          kind: 'project',
          chat_id: `oc_${i}`,
          key: `k${i}`,
          content: `c${i}`,
          importance: i === 0 ? 0 : 7,
          last_access: now,
          created_at: now,
          source_skill: 'seed',
        },
      });
    }
    bitable.seed(seedRows);

    await store.write({
      kind: 'project',
      chat_id: 'oc_NEW',
      key: 'new',
      content: 'new',
      source_skill: 'qa',
      importance: 9,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(bitable.deleteCalls).toBeGreaterThan(0);
  });
});

describe('MemoryStore — 评分队列批量化', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('30 秒窗口内多次 write 只触发一次批量评分', async () => {
    const bitable = new FakeBitable();
    const llm = new FakeLLM();
    const store = new MemoryStore({
      bitable,
      llm,
      scoreFlushMs: 30_000,
      now: () => 1000,
    });

    // 5 条新记忆，importance 不指定 → 全部入队
    for (let i = 0; i < 5; i++) {
      await store.write({
        kind: 'chat',
        chat_id: 'oc_1',
        key: `k${i}`,
        content: `第 ${i} 条`,
        source_skill: 'qa',
      });
    }

    // 时间窗口未到，评分尚未触发
    expect(llm.scoreCallCount).toBe(0);

    // 触发 flush
    await store.flushScoreQueue();

    // 5 条全部被评分
    expect(llm.scoreCallCount).toBe(5);

    // 评分写回 importance
    for (const row of bitable.all) {
      expect(row.fields.importance).toBe(7);
    }
  });

  it('upsert 写不入评分队列', async () => {
    const bitable = new FakeBitable();
    const llm = new FakeLLM();
    const store = new MemoryStore({ bitable, llm, scoreFlushMs: 1, now: () => 1000 });

    await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'topic',
      content: 'v1',
      source_skill: 'qa',
    });
    // 第 2 次（upsert）不应再入队
    await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'topic',
      content: 'v2',
      source_skill: 'qa',
    });

    await store.flushScoreQueue();
    expect(llm.scoreCallCount).toBe(1);
  });

  it('未注入 LLM 时 write 仍可用，只是不评分', async () => {
    const bitable = new FakeBitable();
    const store = new MemoryStore({ bitable, scoreFlushMs: 1, now: () => 1000 });

    const result = await store.write({
      kind: 'chat',
      chat_id: 'oc_1',
      key: 'k1',
      content: 'hi',
      source_skill: 'qa',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.importance).toBe(-1); // PENDING
  });
});
