import { describe, it, expect, vi } from 'vitest';
import { GapDetector } from '../gap-detector.js';
import type { Message, LLMClient } from '@seedhac/contracts';

function makeMsg(text: string, name = 'Alice'): Message {
  return {
    messageId: `msg_${name}_${text}`,
    chatId: 'chat_a',
    chatType: 'group',
    sender: { userId: `u_${name}`, name },
    contentType: 'text',
    text,
    rawContent: text,
    mentions: [],
    timestamp: 1_700_000_000_000,
  };
}

function makeLLM(askImpl: LLMClient['ask']): LLMClient {
  return {
    ask: askImpl,
    chat: vi.fn(),
    askStructured: vi.fn(),
    chatWithTools: vi.fn(),
    embed: vi.fn(),
  };
}

describe('GapDetector', () => {
  // ─── 边界 ────────────────────────────────────────────────────
  describe('boundaries', () => {
    it('returns NO_GAP for empty batch without calling LLM', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));
      const result = await detector.detect([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(false);
        expect(result.value.source).toBe('none');
      }
      expect(ask).not.toHaveBeenCalled();
    });
  });

  // ─── Layer 1 · 4 类规则触发 ──────────────────────────────────
  describe('Layer 1 · rule-based triggers (no LLM call)', () => {
    it('模糊指代：「那个 X」 triggers without calling LLM', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('那个 PRD 改完了吗')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(true);
        expect(result.value.source).toBe('rule');
        expect(result.value.reason).toContain('模糊指代');
        expect(result.value.query).toContain('PRD');
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('模糊指代：「上次 X」 triggers via rule', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('上次会议是不是定了发布日期')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('rule');
        expect(result.value.shouldRecall).toBe(true);
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('记忆型：「是多少来着」 triggers via rule', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('Q3 数据是多少来着')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('rule');
        expect(result.value.reason).toContain('记忆型');
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('记忆型：「我记得」 triggers via rule', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('我记得是个位数')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('rule');
        expect(result.value.shouldRecall).toBe(true);
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('决策追溯：「当时...决定」 triggers via rule', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('当时我们决定用 PostgreSQL 还是 MySQL 来着')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('rule');
        expect(result.value.query).toBe('决定用 PostgreSQL 还是 MySQL');
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('does NOT trigger rule recall when current chat already answered it', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([
        makeMsg('上次那个客户叫啥'),
        makeMsg('叫张总，开过两次会', 'Bob'),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(false);
        expect(result.value.source).toBe('none');
      }
      expect(ask).not.toHaveBeenCalled();
    });
  });

  // ─── Layer 1.5 · 疑问无人答（跨消息结构规则） ────────────────
  describe('Layer 1.5 · unanswered question heuristic', () => {
    it('triggers when first msg is question and no later msg has data', async () => {
      const ask = vi.fn();
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([
        makeMsg('我们的 DAU 现在多少'),
        makeMsg('在跑测试'),
        makeMsg('我也准备下班了'),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(true);
        expect(result.value.source).toBe('rule');
        expect(result.value.reason).toContain('疑问无人答');
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('does NOT trigger when later msg contains numeric answer', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '{"shouldRecall":false,"reason":"已答","query":""}',
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('Q3 转化率多少'), makeMsg('7.2%，刚拉的报表')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(false);
      }
      expect(ask).not.toHaveBeenCalled();
    });
  });

  // ─── Layer 2 · LLM 兜底 ──────────────────────────────────────
  describe('Layer 2 · LLM fallback (no rule match)', () => {
    it('calls LLM only when rules miss', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '{"shouldRecall":true,"reason":"模糊提及","query":"调研报告"}',
      });
      const detector = new GapDetector(makeLLM(ask));

      // 没有"那个/上次/我记得/来着/决定"这些关键词
      const result = await detector.detect([makeMsg('竞品的转化情况怎么样比对一下')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(true);
        expect(result.value.source).toBe('llm');
        expect(result.value.query).toBe('调研报告');
      }
      expect(ask).toHaveBeenCalledOnce();
    });

    it('strips markdown fence on LLM output', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '```json\n{"shouldRecall":true,"reason":"X","query":"竞品对比"}\n```',
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('竞品的转化情况怎么样比对一下')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.query).toBe('竞品对比');
        expect(result.value.source).toBe('llm');
      }
    });

    it('extracts JSON when LLM adds prefix/suffix prose', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '好的，分析如下：{"shouldRecall":true,"reason":"模糊","query":"调研"} 希望帮到你',
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('竞品的转化情况怎么样比对一下')]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.query).toBe('调研');
    });

    it('falls back to NO_GAP when LLM call fails', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: false,
        error: { code: 'LLM_TIMEOUT', message: 'timeout' },
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('竞品的转化情况怎么样比对一下')]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shouldRecall).toBe(false);
        expect(result.value.source).toBe('none');
      }
    });

    it('falls back to NO_GAP when LLM returns invalid JSON', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: 'not json at all',
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('竞品的转化情况怎么样比对一下')]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.shouldRecall).toBe(false);
    });

    it('downgrades to NO_GAP when LLM returns shouldRecall=true with empty query', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '{"shouldRecall":true,"reason":"x","query":""}',
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('竞品的转化情况怎么样比对一下')]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.shouldRecall).toBe(false);
    });

    it('uses lite model + temperature 0 + sender names in prompt', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '{"shouldRecall":false,"reason":"","query":""}',
      });
      const detector = new GapDetector(makeLLM(ask));

      await detector.detect([makeMsg('竞品对比情况', 'PM1'), makeMsg('行', 'PM2')]);

      expect(ask).toHaveBeenCalledOnce();
      const [prompt, opts] = ask.mock.calls[0]!;
      expect(prompt).toContain('[PM1] 竞品对比情况');
      expect(prompt).toContain('[PM2] 行');
      expect(opts).toMatchObject({ model: 'lite', temperature: 0 });
    });
  });

  // ─── 负样本（规则不命中 + LLM 也说不触发） ───────────────────
  describe('negative samples', () => {
    it('plain chitchat: no rule, LLM says false', async () => {
      const ask = vi.fn().mockResolvedValueOnce({
        ok: true,
        value: '{"shouldRecall":false,"reason":"闲聊","query":""}',
      });
      const detector = new GapDetector(makeLLM(ask));

      const result = await detector.detect([makeMsg('今天天气不错')]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.shouldRecall).toBe(false);
    });
  });
});
