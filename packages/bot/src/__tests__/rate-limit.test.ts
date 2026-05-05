import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectRateLimit,
  globalQuotaTracker,
  QuotaTracker,
  withRateLimitRetry,
} from '../rate-limit.js';

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

describe('detectRateLimit', () => {
  it('detects HTTP 429 thrown by SDK with reset header', () => {
    const thrown = {
      response: {
        status: 429,
        headers: { 'x-ogw-ratelimit-reset': '3', 'x-ogw-ratelimit-limit': '5' },
      },
    };
    const info = detectRateLimit(thrown, undefined);
    expect(info).not.toBeNull();
    expect(info!.resetSec).toBe(3);
    expect(info!.limit).toBe('5');
  });

  it('detects feishu rate limit code 99991400 in returned response', () => {
    const res = { code: 99991400, msg: 'rate limited' };
    const info = detectRateLimit(undefined, res);
    expect(info).not.toBeNull();
    expect(info!.resetSec).toBe(0); // 无 header → 0，调用方退化为 1s
  });

  it('detects rate limit when SDK throws with body code 99991401', () => {
    const thrown = { response: { data: { code: 99991401 }, headers: {} } };
    const info = detectRateLimit(thrown, undefined);
    expect(info).not.toBeNull();
  });

  it('returns null for non-rate-limit error', () => {
    expect(detectRateLimit(new Error('network'), undefined)).toBeNull();
    expect(detectRateLimit(undefined, { code: 99991663, msg: 'app token invalid' })).toBeNull();
    expect(detectRateLimit(undefined, { code: 0 })).toBeNull();
  });

  it('handles array-valued headers', () => {
    const thrown = {
      response: { status: 429, headers: { 'X-Ogw-Ratelimit-Reset': ['7'] } },
    };
    const info = detectRateLimit(thrown, undefined);
    expect(info!.resetSec).toBe(7);
  });
});

describe('QuotaTracker', () => {
  beforeEach(() => {
    globalQuotaTracker.reset();
  });

  it('isThrottled() flips on after recordRateLimited and back off after window', async () => {
    const tracker = new QuotaTracker();
    expect(tracker.isThrottled()).toBe(false);
    tracker.recordRateLimited(1); // 1s 窗口
    expect(tracker.isThrottled()).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(tracker.isThrottled()).toBe(false);
  });

  it('recordObservation stores last quota snapshot', () => {
    const tracker = new QuotaTracker();
    tracker.recordObservation(100, 12, 30);
    const snap = tracker.getLastObservation();
    expect(snap?.limit).toBe(100);
    expect(snap?.remaining).toBe(12);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('takes the later resetAt when racing recordRateLimited calls', () => {
    const tracker = new QuotaTracker();
    tracker.recordRateLimited(1);
    const before = (tracker as unknown as { resetAtMs: number }).resetAtMs;
    tracker.recordRateLimited(60);
    const after = (tracker as unknown as { resetAtMs: number }).resetAtMs;
    expect(after).toBeGreaterThan(before);
  });
});

describe('withRateLimitRetry', () => {
  beforeEach(() => {
    globalQuotaTracker.reset();
  });

  it('returns response immediately on success — no retry', async () => {
    const fn = vi.fn().mockResolvedValue({ code: 0, data: { ok: true } });
    const res = await withRateLimitRetry(fn, { context: 'test', sleepFn: noSleep });
    expect(res).toEqual({ code: 0, data: { ok: true } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once on 99991400 then succeeds', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ code: 99991400, msg: 'rate limit' })
      .mockResolvedValueOnce({ code: 0, data: { id: 'm1' } });
    const tracker = new QuotaTracker();
    const res = await withRateLimitRetry(fn, {
      context: 'test',
      sleepFn: noSleep,
      tracker,
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ code: 0, data: { id: 'm1' } });
    expect(tracker.isThrottled()).toBe(true);
  });

  it('retries once on HTTP 429 thrown then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 429,
          headers: { 'x-ogw-ratelimit-reset': '2' },
        },
      })
      .mockResolvedValueOnce({ code: 0 });
    const sleepFn = vi.fn(noSleep);
    await withRateLimitRetry(fn, { context: 'test', sleepFn });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(2000);
  });

  it('throws original error when not rate-limited', async () => {
    const error = new Error('network failure');
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      withRateLimitRetry(fn, { context: 'test', sleepFn: noSleep }),
    ).rejects.toThrow('network failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the still-rate-limited response after exhausting retries', async () => {
    const fn = vi.fn().mockResolvedValue({ code: 99991400, msg: 'rate limit' });
    const res = await withRateLimitRetry(fn, {
      context: 'test',
      sleepFn: noSleep,
      maxRetries: 1,
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ code: 99991400, msg: 'rate limit' });
  });

  it('rethrows the last thrown 429 after exhausting retries', async () => {
    const error = { response: { status: 429, headers: { 'x-ogw-ratelimit-reset': '1' } } };
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      withRateLimitRetry(fn, { context: 'test', sleepFn: noSleep, maxRetries: 1 }),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('floors reset to 1s when header missing', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ code: 99991400, msg: 'no header' })
      .mockResolvedValueOnce({ code: 0 });
    const sleepFn = vi.fn(noSleep);
    await withRateLimitRetry(fn, { context: 'test', sleepFn });
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('caps reset to 60s if header is unreasonably large', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        response: { status: 429, headers: { 'x-ogw-ratelimit-reset': '3600' } },
      })
      .mockResolvedValueOnce({ code: 0 });
    const sleepFn = vi.fn(noSleep);
    await withRateLimitRetry(fn, { context: 'test', sleepFn });
    // > 60 → 退化为 1s（防止单次睡死整个 demo）
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('logs warn with limit/remaining context when retrying', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 429,
          headers: {
            'x-ogw-ratelimit-reset': '2',
            'x-ogw-ratelimit-limit': '5',
            'x-ogw-ratelimit-remaining': '0',
          },
        },
      })
      .mockResolvedValueOnce({ code: 0 });
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    await withRateLimitRetry(fn, { context: 'sendText', logger, sleepFn: noSleep });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('sendText');
    expect(warn.mock.calls[0]![1]).toMatchObject({ limit: '5', remaining: '0', attempt: 1 });
  });
});
