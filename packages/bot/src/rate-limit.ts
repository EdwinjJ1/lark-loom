/**
 * 飞书 API 限流响应感知（issue #91）
 *
 * Layer A：withRateLimitRetry — 检测 429 / 99991400 / 99991401，读
 *   x-ogw-ratelimit-reset header，sleep 后重试 1 次。
 * Layer B：QuotaTracker — 单例，记录最近一次被限流的 reset 时刻；
 *   RateLimiter.refill() 在窗口内时速率减半，主动收紧本地限流。
 *
 * 飞书限流文档：https://open.feishu.cn/document/server-docs/api-call-guide/calling-frequency
 */

import type { Logger } from '@seedhac/contracts';

// ─── QuotaTracker ─────────────────────────────────────────────────────────────

/** 单例，记录最近一次被飞书限流的恢复时刻；用于 RateLimiter 主动收紧。 */
export class QuotaTracker {
  private resetAtMs = 0;
  private lastObserved: { limit: number; remaining: number; resetAtMs: number } | null = null;

  /** 标记进入限流窗口，windowSec 秒后自动恢复正常速率。 */
  recordRateLimited(windowSec: number): void {
    const ms = Math.max(1, windowSec) * 1000;
    this.resetAtMs = Math.max(this.resetAtMs, Date.now() + ms);
  }

  /** 记录成功响应里观测到的配额（暂时只为日志和未来扩展）。 */
  recordObservation(limit: number, remaining: number, resetSec: number): void {
    this.lastObserved = {
      limit,
      remaining,
      resetAtMs: Date.now() + Math.max(0, resetSec) * 1000,
    };
  }

  /** 当前是否处于上次限流的恢复窗口内 —— RateLimiter 据此减速。 */
  isThrottled(): boolean {
    return Date.now() < this.resetAtMs;
  }

  /** 仅供测试 / 日志：最近一次观测到的配额。 */
  getLastObservation(): { limit: number; remaining: number; resetAtMs: number } | null {
    return this.lastObserved;
  }

  /** 仅供测试：重置内部状态。 */
  reset(): void {
    this.resetAtMs = 0;
    this.lastObserved = null;
  }
}

/** 进程级单例 —— 所有 RateLimiter / withRateLimitRetry 共享。 */
export const globalQuotaTracker = new QuotaTracker();

// ─── 限流检测 ────────────────────────────────────────────────────────────────

/** 飞书 OpenAPI 已知的限流错误码。 */
const RATE_LIMIT_CODES = new Set<number>([99991400, 99991401, 99991408]);

/** 飞书限流响应头 → 解析出的恢复秒数 / 配额上下文。 */
interface RateLimitInfo {
  resetSec: number;
  limit: string | undefined;
  remaining: string | undefined;
}

function readHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k.toLowerCase()] = v[0];
    else if (v != null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function parseRateLimitInfo(headers: Record<string, string>): RateLimitInfo {
  const reset = parseInt(headers['x-ogw-ratelimit-reset'] ?? '0', 10);
  return {
    resetSec: Number.isFinite(reset) && reset > 0 ? reset : 0,
    limit: headers['x-ogw-ratelimit-limit'],
    remaining: headers['x-ogw-ratelimit-remaining'],
  };
}

/**
 * 检测一次 SDK 调用是否撞了限流。同时覆盖两条路径：
 *  1) SDK 直接 throw（多见于 axios 401/429）→ 看 e.response.status / headers
 *  2) SDK 返回 { code, msg, data } 且 code 是已知限流码（飞书绝大多数走这条）
 */
export function detectRateLimit(
  thrown: unknown,
  res: { code?: number; msg?: string } | undefined,
): RateLimitInfo | null {
  if (thrown !== undefined) {
    const e = thrown as {
      response?: { status?: number; headers?: unknown; data?: { code?: number } };
      code?: number;
    };
    const headers = readHeaders(e.response?.headers);
    const status = e.response?.status;
    const bodyCode = e.response?.data?.code;
    const errCode = typeof e.code === 'number' ? e.code : undefined;
    if (
      status === 429 ||
      (typeof bodyCode === 'number' && RATE_LIMIT_CODES.has(bodyCode)) ||
      (typeof errCode === 'number' && RATE_LIMIT_CODES.has(errCode))
    ) {
      return parseRateLimitInfo(headers);
    }
    return null;
  }
  if (res && typeof res.code === 'number' && RATE_LIMIT_CODES.has(res.code)) {
    return parseRateLimitInfo({});
  }
  return null;
}

// ─── withRateLimitRetry ──────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WithRateLimitRetryOptions {
  context: string;
  logger?: Logger | undefined;
  tracker?: QuotaTracker | undefined;
  maxRetries?: number | undefined;
  /** 测试用：注入 sleep 实现，避免真实等待。 */
  sleepFn?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * 包一个返回 `{code, msg, data}` 风格响应的飞书 API 调用：
 *  - 成功（code === 0 或非限流码）→ 直接返回
 *  - 限流（429 / 99991400 / 99991401 / 99991408）→ sleep reset 秒，重试一次
 *  - 其它错误 → 透传抛出
 *
 * `fn` 既可能 throw 也可能返回非零 code，两种路径都处理。
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: WithRateLimitRetryOptions,
): Promise<T> {
  const {
    context,
    logger,
    tracker = globalQuotaTracker,
    maxRetries = 1,
    sleepFn = sleep,
  } = options;

  let lastThrown: unknown;
  let lastRes: T | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: T | undefined;
    let thrown: unknown;
    try {
      res = await fn();
    } catch (e) {
      thrown = e;
    }

    const info = detectRateLimit(thrown, res as { code?: number; msg?: string } | undefined);
    if (!info) {
      if (thrown !== undefined) throw thrown;
      return res as T;
    }

    lastThrown = thrown;
    lastRes = res;

    if (attempt >= maxRetries) break;

    // reset 头缺失或异常时退化为 1s —— 不能 0 否则可能再撞同一个窗口
    const waitSec = info.resetSec > 0 && info.resetSec <= 60 ? info.resetSec : 1;
    tracker.recordRateLimited(waitSec);
    logger?.warn(`[${context}] hit feishu rate limit, sleeping ${waitSec}s`, {
      limit: info.limit,
      remaining: info.remaining,
      attempt: attempt + 1,
      maxRetries,
    });
    await sleepFn(waitSec * 1000);
  }

  if (lastThrown !== undefined) throw lastThrown;
  return lastRes as T;
}
