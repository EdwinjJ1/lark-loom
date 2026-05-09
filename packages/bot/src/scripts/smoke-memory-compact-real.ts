/**
 * smoke-memory-compact-real.ts
 *
 * Real smoke test for MemoryStore compaction:
 *   - uses real .env credentials
 *   - writes 100 synthetic group-chat memory records into the real Bitable memory table
 *   - uses the real LLM during compact summarization
 *   - reports whether 100 records compact into exactly 50 originals + 1 summary
 *
 * Run:
 *   pnpm --filter @seedhac/bot dev:smoke-memory-compact-real
 *
 * Useful env overrides:
 *   SMOKE_MEMORY_COMPACT_COUNT=100
 *   SMOKE_MEMORY_COMPACT_CHAT_ID=oc_smoke_memory_compact_manual
 *   SMOKE_MEMORY_COMPACT_KEEP=1        # keep test rows for manual inspection
 *   SMOKE_MEMORY_COMPACT_TIMEOUT_MS=180000
 *   SMOKE_MEMORY_COMPACT_CLEAN_ONLY=1  # delete rows for chat_id and exit
 */

import type { Logger, MemoryKind, MemoryRecord } from '@seedhac/contracts';

import { LarkBitableClient } from '../bitable-client.js';
import { VolcanoLLMClient } from '../llm-client.js';
import {
  MEMORY_COMPACT_BATCH,
  MEMORY_COMPACT_THRESHOLD,
  MemoryStore,
} from '../memory/memory-store.js';

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function envTrim(name: string): string {
  return (process.env[name] ?? '').trim();
}

function requireEnv(name: string, fallbackName?: string): string {
  const value = envTrim(name) || (fallbackName ? envTrim(fallbackName) : '');
  if (!value) {
    console.error(c.red(`Missing env var: ${name}${fallbackName ? ` or ${fallbackName}` : ''}`));
    process.exit(1);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = envTrim(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const logger: Logger = {
  debug: (msg, meta) => console.debug(c.dim(`[compact-smoke] ${msg}`), meta ?? ''),
  info: (msg, meta) => console.info(`[compact-smoke] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(c.yellow(`[compact-smoke] ${msg}`), meta ?? ''),
  error: (msg, meta) => console.error(c.red(`[compact-smoke] ${msg}`), meta ?? ''),
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeSyntheticMessage(i: number, runId: string): string {
  const owners = ['小明', '小红', '徐坤', 'Alice', 'Bob'];
  const owner = owners[i % owners.length]!;
  const day = String((i % 28) + 1).padStart(2, '0');
  return [
    `[${runId}] 群聊第 ${i + 1} 条：${owner} 更新项目进展。`,
    `本轮要完成模块 ${i + 1} 的需求梳理、接口联调和演示验收。`,
    `截止时间是 2026-05-${day}，风险点是素材缺失和接口返回不稳定。`,
  ].join('');
}

async function listAll(store: MemoryStore, chatId: string, kind: MemoryKind): Promise<MemoryRecord[]> {
  const result = await store.list({ chatId, kind, limit: 500 });
  if (!result.ok) {
    throw new Error(`list memory failed: ${result.error.message}`);
  }
  return [...result.value];
}

async function deleteAll(store: MemoryStore, records: readonly MemoryRecord[]): Promise<void> {
  for (const record of records) {
    const result = await store.delete(record);
    if (!result.ok) {
      logger.warn('cleanup delete failed', {
        recordId: record.id,
        key: record.key,
        message: result.error.message,
      });
    }
  }
}

function summarizeRecords(records: readonly MemoryRecord[]): {
  total: number;
  summaries: MemoryRecord[];
  originals: MemoryRecord[];
  coveredCount: number;
} {
  const summaries = records.filter((r) => r.is_summary === true);
  const originals = records.filter((r) => r.is_summary !== true);
  const coveredCount = summaries.reduce((sum, r) => sum + (r.covered_count ?? 0), 0);
  return { total: records.length, summaries, originals, coveredCount };
}

async function waitForCompact(params: {
  store: MemoryStore;
  chatId: string;
  kind: MemoryKind;
  expectedTotal: number;
  timeoutMs: number;
}): Promise<MemoryRecord[]> {
  const started = Date.now();
  let last: MemoryRecord[] = [];

  while (Date.now() - started < params.timeoutMs) {
    last = await listAll(params.store, params.chatId, params.kind);
    const summary = summarizeRecords(last);
    if (
      summary.summaries.length > 0 &&
      summary.coveredCount >= MEMORY_COMPACT_BATCH &&
      summary.total <= params.expectedTotal
    ) {
      return last;
    }
    await sleep(2_000);
  }

  return last;
}

async function main(): Promise<void> {
  const messageCount = numberEnv('SMOKE_MEMORY_COMPACT_COUNT', MEMORY_COMPACT_THRESHOLD);
  const timeoutMs = numberEnv('SMOKE_MEMORY_COMPACT_TIMEOUT_MS', 180_000);
  const keepRows = envTrim('SMOKE_MEMORY_COMPACT_KEEP') === '1';
  const cleanOnly = envTrim('SMOKE_MEMORY_COMPACT_CLEAN_ONLY') === '1';
  const kind = (envTrim('SMOKE_MEMORY_COMPACT_KIND') || 'chat') as MemoryKind;
  const runId = `compact_${Date.now()}`;
  const chatId = envTrim('SMOKE_MEMORY_COMPACT_CHAT_ID') || `oc_smoke_memory_${runId}`;

  if (messageCount < MEMORY_COMPACT_THRESHOLD) {
    console.error(
      c.red(
        `SMOKE_MEMORY_COMPACT_COUNT must be >= ${MEMORY_COMPACT_THRESHOLD} to trigger compact`,
      ),
    );
    process.exit(1);
  }

  const appId = requireEnv('LARK_APP_ID');
  const appSecret = requireEnv('LARK_APP_SECRET');
  const appToken = requireEnv('LARK_BITABLE_APP_TOKEN', 'BITABLE_APP_TOKEN');
  const memoryTableId = requireEnv('LARK_BITABLE_MEMORY_TABLE_ID', 'BITABLE_TABLE_MEMORY');
  const apiKey = requireEnv('ARK_API_KEY');
  const modelLite = requireEnv('ARK_MODEL_LITE', 'ARK_MODEL_PRO');
  const modelPro = requireEnv('ARK_MODEL_PRO', 'ARK_MODEL_LITE');
  const embeddingModel = envTrim('ARK_MODEL_EMBEDDING');

  const llm = new VolcanoLLMClient({
    apiKey,
    modelIds: {
      lite: modelLite,
      pro: modelPro,
      ...(embeddingModel ? { embedding: embeddingModel } : {}),
    },
  });

  const bitable = new LarkBitableClient({
    appId,
    appSecret,
    appToken,
    tableIds: {
      memory: memoryTableId,
      decision: envTrim('BITABLE_TABLE_DECISION'),
      todo: envTrim('BITABLE_TABLE_TODO'),
      knowledge: envTrim('BITABLE_TABLE_KNOWLEDGE'),
    },
  });

  const store = new MemoryStore({
    bitable,
    llm,
    logger,
    scoreFlushMs: 30_000,
  });

  console.log(c.bold(c.cyan('\nMemory Compact Real Smoke')));
  console.log(`chat_id: ${chatId}`);
  console.log(`kind: ${kind}`);
  console.log(`messages: ${messageCount}`);
  console.log(`keep rows: ${keepRows ? 'yes' : 'no, cleanup after report'}`);
  console.log(`clean only: ${cleanOnly ? 'yes' : 'no'}`);
  console.log(`compact threshold/batch: ${MEMORY_COMPACT_THRESHOLD}/${MEMORY_COMPACT_BATCH}`);

  let recordsToClean: MemoryRecord[] = [];
  try {
    const existing = await listAll(store, chatId, kind);
    if (cleanOnly) {
      console.log(c.bold(`\nClean-only mode: deleting ${existing.length} rows for chat_id=${chatId}`));
      await deleteAll(store, existing);
      return;
    }
    if (existing.length > 0) {
      console.log(c.yellow(`Found ${existing.length} existing smoke rows for chat_id, deleting first...`));
      await deleteAll(store, existing);
    }

    console.log(c.bold('\nWriting synthetic memory records...'));
    const writeStarted = Date.now();
    for (let i = 0; i < messageCount; i++) {
      const result = await store.write({
        kind,
        chat_id: chatId,
        key: `${runId}:msg:${String(i + 1).padStart(3, '0')}`,
        content: makeSyntheticMessage(i, runId),
        source_skill: 'smoke.memory_compact',
        importance: 5,
      });
      if (!result.ok) {
        throw new Error(`write #${i + 1} failed: ${result.error.message}`);
      }
      if ((i + 1) % 10 === 0 || i === messageCount - 1) {
        console.log(c.dim(`  wrote ${i + 1}/${messageCount}`));
      }
    }
    console.log(`write elapsed: ${Date.now() - writeStarted}ms`);

    console.log(c.bold('\nWaiting for async compact maintenance...'));
    const expectedTotal = messageCount - MEMORY_COMPACT_BATCH + 1;
    const after = await waitForCompact({ store, chatId, kind, expectedTotal, timeoutMs });
    recordsToClean = after;
    const summary = summarizeRecords(after);

    console.log(c.bold('\nCompact report'));
    console.log(`total records: ${summary.total}`);
    console.log(`summary records: ${summary.summaries.length}`);
    console.log(`original records: ${summary.originals.length}`);
    console.log(`covered_count total: ${summary.coveredCount}`);
    console.log(`expected total after one compact: ${expectedTotal}`);

    for (const record of summary.summaries.slice(0, 3)) {
      console.log(c.dim('\n--- summary preview ---'));
      console.log(`key: ${record.key}`);
      console.log(`covered_count: ${record.covered_count ?? 'n/a'}`);
      console.log(record.content.slice(0, 800));
    }

    const assertions = [
      {
        name: 'created at least one summary record',
        pass: summary.summaries.length >= 1,
      },
      {
        name: `summary covers at least ${MEMORY_COMPACT_BATCH} originals`,
        pass: summary.coveredCount >= MEMORY_COMPACT_BATCH,
      },
      {
        name: `record count reduced below original ${messageCount}`,
        pass: summary.total < messageCount,
      },
      {
        name: `record count reached expected ${expectedTotal}`,
        pass: summary.total === expectedTotal,
      },
    ];

    console.log(c.bold('\nAssertions'));
    for (const assertion of assertions) {
      console.log(`${assertion.pass ? c.green('PASS') : c.red('FAIL')} ${assertion.name}`);
    }

    if (assertions.some((a) => !a.pass)) {
      process.exitCode = 1;
    }
  } finally {
    if (!keepRows) {
      const latest = await listAll(store, chatId, kind).catch(() => recordsToClean);
      if (latest.length > 0) {
        console.log(c.bold('\nCleaning up smoke rows...'));
        await deleteAll(store, latest);
        console.log(`deleted rows: ${latest.length}`);
      }
    } else {
      console.log(c.yellow(`\nKeeping smoke rows for inspection: chat_id=${chatId}`));
    }
  }
}

main().catch((e) => {
  console.error(c.red('fatal:'), e);
  process.exit(1);
});
