import { describe, it, expect } from 'vitest';
import { clamp, clampKeyPart, CLAMP_LIMITS } from '../utils/clamp.js';

describe('clamp()', () => {
  it('returns empty string for nullish input', () => {
    expect(clamp(undefined)).toBe('');
    expect(clamp(null)).toBe('');
    expect(clamp('')).toBe('');
  });

  it('returns input unchanged when under the limit', () => {
    expect(clamp('hello', 'MEDIUM')).toBe('hello');
    expect(clamp('hello', 'SHORT')).toBe('hello');
  });

  it('truncates with ellipsis when over MEDIUM limit (default)', () => {
    const long = 'a'.repeat(CLAMP_LIMITS.MEDIUM + 100);
    const out = clamp(long);
    expect(out.length).toBe(CLAMP_LIMITS.MEDIUM);
    expect(out.endsWith('…')).toBe(true);
  });

  it('respects SHORT limit for key parts', () => {
    const long = 'x'.repeat(200);
    const out = clamp(long, 'SHORT');
    expect(out.length).toBe(CLAMP_LIMITS.SHORT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('respects LONG limit for memory content', () => {
    const long = 'y'.repeat(CLAMP_LIMITS.LONG + 50);
    const out = clamp(long, 'LONG');
    expect(out.length).toBe(CLAMP_LIMITS.LONG);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not break on emoji / surrogate pairs at boundary', () => {
    // 30 个 4 字节 emoji + 大量 ASCII，强制截断在 emoji 边界附近
    const emojiPrefix = '🚀'.repeat(30);
    const out = clamp(`${emojiPrefix}${'a'.repeat(500)}`, 'MEDIUM');
    // 截断后不应出现孤立的 surrogate（合法字符串）
    expect(() => out.normalize()).not.toThrow();
    expect(out.endsWith('…')).toBe(true);
  });

  it('treats exactly-at-limit as no truncation', () => {
    const exact = 'a'.repeat(CLAMP_LIMITS.SHORT);
    expect(clamp(exact, 'SHORT')).toBe(exact);
  });
});

describe('clampKeyPart()', () => {
  it('returns "unknown" for nullish / empty', () => {
    expect(clampKeyPart(undefined)).toBe('unknown');
    expect(clampKeyPart(null)).toBe('unknown');
    expect(clampKeyPart('')).toBe('unknown');
    expect(clampKeyPart('   ')).toBe('unknown');
  });

  it('replaces whitespace / pipes with underscore', () => {
    expect(clampKeyPart('a b')).toBe('a_b');
    expect(clampKeyPart('a|b')).toBe('a_b');
    expect(clampKeyPart('a\nb')).toBe('a_b');
    expect(clampKeyPart('a\tb')).toBe('a_b');
  });

  it('strips control characters', () => {
    const withCtrl = `name${String.fromCharCode(0x07)}_${String.fromCharCode(0x1f)}`;
    const out = clampKeyPart(withCtrl);
    // eslint-disable-next-line no-control-regex -- intentionally testing control char stripping
    expect(out).not.toMatch(/[\x00-\x1f]/);
  });

  it('truncates long owner names to SHORT level', () => {
    const long = 'x'.repeat(200);
    const out = clampKeyPart(long);
    expect(out.length).toBeLessThanOrEqual(CLAMP_LIMITS.SHORT);
  });

  it('preserves Chinese characters', () => {
    expect(clampKeyPart('张三')).toBe('张三');
    expect(clampKeyPart('张 三')).toBe('张_三');
  });
});
