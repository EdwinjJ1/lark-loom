/**
 * Rehearsal v2 attribution + cross-check 工具（issue #145 P3）
 *
 * 设计原则（沿用 core-doc.ts 哲学）：
 *   - 失败仅 warn，不阻塞 → 主链路必须能 graceful degradation
 *   - 能模板就不过 LLM → 引用白名单先 grep 一遍，能 reject 的 critique 不浪费 lite 调用
 *   - 过 LLM 必走 schema → askStructured + Zod-like SchemaLike
 *   - 并发但有上限 → critique 数量 ≤ 30，攒一拨直发，不分批
 */

import type { LLMClient, SkillContext } from '@seedhac/contracts';
import {
  ATTRIBUTION_PROMPT,
  AttributionResultSchema,
  CROSSCHECK_PROMPT,
  CrossCheckResultSchema,
  type AttributionResult,
  type CrossCheckResult,
  type ListenerCritique,
  type PreviewDocSection,
  type PreviewSlideInput,
  isCiteInWhitelist,
} from '../prompts/rehearsal-preview.js';

export interface ClassifiedCritique {
  readonly critique: ListenerCritique;
  readonly attribution: 'confirmed' | 'unsure';
}

const ATTRIBUTION_CONCURRENCY = 6;
const ATTRIBUTION_TIMEOUT_MS = 30_000;

/**
 * 对 listener critique 批量做 attribution 校验：
 *   - cite 不在白名单 → 直接 dropped（不调 LLM）
 *   - lite 校验 verdict === 'no' → dropped
 *   - lite 校验 verdict === 'yes' → confirmed
 *   - lite 校验 verdict === 'unsure' / LLM 失败 → unsure（进 review 卡 ⚠️ 类别）
 *
 * 注意：LLM 失败时**不 fail-close**，统一标记 unsure 让用户最终拍板。
 */
export async function verifyAttribution(
  ctx: { llm: LLMClient; logger: SkillContext['logger'] },
  critiques: readonly ListenerCritique[],
  pptPages: readonly PreviewSlideInput[],
  docContext: readonly PreviewDocSection[],
): Promise<readonly ClassifiedCritique[]> {
  if (critiques.length === 0) return [];

  const totalPages = pptPages.length;
  const docSectionNames = docContext.map((d) => d.section);

  const results: ClassifiedCritique[] = [];
  const queue: ListenerCritique[] = [];

  for (const c of critiques) {
    if (!isCiteInWhitelist(c.cite, totalPages, docSectionNames)) {
      ctx.logger.info('rehearsal-preview: critique dropped (cite not in whitelist)', {
        cite: c.cite,
        page: c.page,
      });
      continue;
    }
    queue.push(c);
  }

  // 并发 6，但小批量直接一次跑完
  const chunks: ListenerCritique[][] = [];
  for (let i = 0; i < queue.length; i += ATTRIBUTION_CONCURRENCY) {
    chunks.push(queue.slice(i, i + ATTRIBUTION_CONCURRENCY));
  }

  for (const chunk of chunks) {
    const verdicts = await Promise.all(
      chunk.map(async (c): Promise<{ critique: ListenerCritique; result: AttributionResult }> => {
        const res = await ctx.llm.askStructured(
          ATTRIBUTION_PROMPT(c, pptPages, docContext),
          AttributionResultSchema,
          { model: 'lite', timeoutMs: ATTRIBUTION_TIMEOUT_MS, temperature: 0.0 },
        );
        if (!res.ok) {
          ctx.logger.warn('rehearsal-preview: attribution call failed', {
            page: c.page,
            cite: c.cite,
            code: res.error.code,
          });
          return { critique: c, result: { verdict: 'unsure', reason: 'llm_failed' } };
        }
        return { critique: c, result: res.value };
      }),
    );

    for (const { critique, result } of verdicts) {
      if (result.verdict === 'no') {
        ctx.logger.info('rehearsal-preview: critique dropped by attribution', {
          page: critique.page,
          cite: critique.cite,
          reason: result.reason,
        });
        continue;
      }
      results.push({
        critique,
        attribution: result.verdict === 'yes' ? 'confirmed' : 'unsure',
      });
    }
  }

  return results;
}

export interface CrossCheckPair {
  readonly page: PreviewSlideInput;
  readonly section: PreviewDocSection;
}

export interface CrossCheckFinding {
  readonly page: number;
  readonly section: string;
  readonly verdict: CrossCheckResult['verdict'];
  readonly note: string;
}

const CROSSCHECK_CONCURRENCY = 4;
const CROSSCHECK_TIMEOUT_MS = 30_000;

/**
 * 让 lite 模型逐对 (page, section) 判断 PPT 与 core-doc 数字 / 决策一致性。
 * 主要抓"PPT 数字"vs"doc OKR/决策日志"对不上的常见决赛踩雷。
 *
 * 调用方负责筛对（一般传 5-10 对最相关的，避免炸调用量）。
 * 返回 inconsistent / unclear 的发现；consistent 的不返回（reduce noise）。
 */
export async function crossCheckConsistency(
  ctx: { llm: LLMClient; logger: SkillContext['logger'] },
  pairs: readonly CrossCheckPair[],
): Promise<readonly CrossCheckFinding[]> {
  if (pairs.length === 0) return [];

  const findings: CrossCheckFinding[] = [];

  for (let i = 0; i < pairs.length; i += CROSSCHECK_CONCURRENCY) {
    const chunk = pairs.slice(i, i + CROSSCHECK_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (pair): Promise<CrossCheckFinding | null> => {
        const res = await ctx.llm.askStructured(
          CROSSCHECK_PROMPT(pair.page, pair.section),
          CrossCheckResultSchema,
          { model: 'lite', timeoutMs: CROSSCHECK_TIMEOUT_MS, temperature: 0.0 },
        );
        if (!res.ok) {
          ctx.logger.warn('rehearsal-preview: cross-check call failed', {
            page: pair.page.page,
            section: pair.section.section,
            code: res.error.code,
          });
          return null;
        }
        if (res.value.verdict === 'consistent') return null;
        return {
          page: pair.page.page,
          section: pair.section.section,
          verdict: res.value.verdict,
          note: res.value.note,
        };
      }),
    );
    for (const f of results) if (f) findings.push(f);
  }

  return findings;
}
