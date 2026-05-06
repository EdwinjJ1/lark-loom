/**
 * 字段长度截断 — 防止 LLM 幻觉 / prompt-injected 长串直写 Bitable
 *
 * 分级阈值（与 Bitable / memory schema 用途对齐）：
 *   - SHORT：用作 row key 的拼接片段（owner / chatId 名等），保短可索引
 *   - MEDIUM：负责人 / 任务标题 / 交付物 / 验收标准等"短描述"
 *   - LONG：memory.content / 摘要等较长内容
 *
 * 截断时附加省略符让下游能识别已被截断；不破坏 UTF-8 单字符。
 */

export const CLAMP_LIMITS = {
  SHORT: 64,
  MEDIUM: 500,
  LONG: 2000,
} as const;

export type ClampLevel = keyof typeof CLAMP_LIMITS;

/**
 * 按指定级别硬截断字符串。
 *   - undefined / null → ''
 *   - 长度未超限 → 原样返回
 *   - 超限 → 截断到 limit-1 后追加 '…'，避免在边界破坏宽字符
 */
export function clamp(value: string | undefined | null, level: ClampLevel = 'MEDIUM'): string {
  if (!value) return '';
  const limit = CLAMP_LIMITS[level];
  if (value.length <= limit) return value;
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  return `${chars.slice(0, limit - 1).join('')}…`;
}

// 替换：所有空白（含换行/tab）、pipe、ASCII 控制字符 → _
// eslint-disable-next-line no-control-regex
const KEY_REPLACE_RE = /[\s|\x00-\x1F\x7F]/g;

/** 为 memory key 拼接生成清洗后的片段：去除控制字符、换行，硬截断到 SHORT */
export function clampKeyPart(value: string | undefined | null): string {
  if (!value || !value.trim()) return 'unknown';
  const sanitized = value.replace(KEY_REPLACE_RE, '_');
  if (!sanitized.replace(/_/g, '')) return 'unknown';
  return clamp(sanitized, 'SHORT');
}
