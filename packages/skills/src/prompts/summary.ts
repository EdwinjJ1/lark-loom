/**
 * Summary 防幻觉 Prompt（参照 requirementDoc + archive 同款 ICE 框架，
 * 治理业界公认的 meeting summary 四类幻觉）
 *
 * 四类 meeting-specific 幻觉（来自 2026 业界经验 / Microsoft Azure ICE 指南）：
 *   1. False attribution：把"提问的人"说成"决策的人"
 *   2. Temporal smoothing：把"或许、考虑、可能"渲染成"已敲定"
 *   3. Consensus fabrication：单方说话被写成"全体同意"
 *   4. Topic inflation：随口一句被升格成"关键议题 / 决策"
 *
 * 引用：
 *   - HackerNoon "Steal My Prompt for Automating Meeting Minutes with AI"
 *   - GoTranscript "Minutes Prompt Library: Standard Prompts for Consistent Meeting Minutes"
 *   - Microsoft Azure: Best Practices for Mitigating LLM Hallucinations (ICE)
 *   - 2025 Hallucination Survey (Frontiers / Nature)
 *   - Atlassian / Notion / Fellow / Otter.ai 公开 meeting minutes 模板字段交集
 */

import type { Message, SchemaLike } from '@seedhac/contracts';

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface ActionItem {
  /** 显式被点名负责的人，如「张三」「@李四」；输入里没指名 → 留空字符串 */
  readonly owner: string;
  /** 行动项内容 */
  readonly content: string;
  /** 截止日期；输入里没明说就别填（豆包对编日期最幻觉）*/
  readonly ddl?: string;
}

export interface SummaryExtraction {
  /** 整体一段话摘要（80-160 字），即使后面字段都空也能给用户可读输出 */
  readonly summary: string;
  /** 决策列表 — 必须基于「明确表态 / 拍板」语义，不许把疑问句当决策 */
  readonly decisions: readonly string[];
  /** 行动项 — 必须有显式责任人，否则进 issues */
  readonly actionItems: readonly ActionItem[];
  /** 遗留问题 / 待澄清 — 反幻觉关键字段：含糊不清 / 未定的统统塞这里 */
  readonly issues: readonly string[];
  /** 下一步计划 */
  readonly nextSteps: readonly string[];
}

export const EMPTY_EXTRACTION: SummaryExtraction = {
  summary: '',
  decisions: [],
  actionItems: [],
  issues: [],
  nextSteps: [],
};

function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be array`);
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new Error(`${name}[${i}] must be string`);
    return v;
  });
}

function parseActionItems(raw: unknown): ActionItem[] {
  if (!Array.isArray(raw)) throw new Error('actionItems must be array');
  return raw.map((v, i) => {
    if (typeof v !== 'object' || v === null) {
      throw new Error(`actionItems[${i}] must be object`);
    }
    const o = v as Record<string, unknown>;
    const owner = typeof o['owner'] === 'string' ? o['owner'] : '';
    const content = typeof o['content'] === 'string' ? o['content'] : '';
    if (!content) throw new Error(`actionItems[${i}].content must be non-empty string`);
    const item: ActionItem = { owner, content };
    if (typeof o['ddl'] === 'string' && o['ddl'].trim().length > 0) {
      return { ...item, ddl: o['ddl'] };
    }
    return item;
  });
}

export const SummaryExtractionSchema: SchemaLike<SummaryExtraction> = {
  parse(value: unknown): SummaryExtraction {
    if (typeof value !== 'object' || value === null) {
      throw new Error('summary extraction must be object');
    }
    const o = value as Record<string, unknown>;
    return {
      summary: typeof o['summary'] === 'string' ? o['summary'] : '',
      decisions: asStringArray(o['decisions'] ?? [], 'decisions'),
      actionItems: parseActionItems(o['actionItems'] ?? []),
      issues: asStringArray(o['issues'] ?? [], 'issues'),
      nextSteps: asStringArray(o['nextSteps'] ?? [], 'nextSteps'),
    };
  },
  jsonSchema(): Record<string, unknown> {
    const stringArray = { type: 'array', items: { type: 'string' } };
    return {
      type: 'object',
      required: ['summary', 'decisions', 'actionItems', 'issues', 'nextSteps'],
      properties: {
        summary: { type: 'string' },
        decisions: stringArray,
        actionItems: {
          type: 'array',
          items: {
            type: 'object',
            required: ['owner', 'content'],
            properties: {
              owner: { type: 'string' },
              content: { type: 'string' },
              ddl: { type: 'string' },
            },
          },
        },
        issues: stringArray,
        nextSteps: stringArray,
      },
    };
  },
};

// ─── 4 个 Few-Shot 示例（业界公认的 meeting 反幻觉教学场景）──────────────────
//
// 顺序遵循 recency bias：A 教标准用法 / B 教空数据 / C 教 false attribution +
// temporal smoothing / D 教 consensus fabrication + topic inflation
//
// 领域故意避开 K12 / 飞书机器人 / 海外语音，避免 LLM 抄当前用户测试场景。

const FEW_SHOT_EXAMPLES = `
### 示例 A：明确决策 + 显式责任人（教标准用法）

输入：
[张总(产品)]: 我们今天讨论下供应商选型，候选 A 和 B
[李工(技术)]: A 集成成本低，B 性能更稳
[张总]: 决定用 B，技术稳定性更重要
[李工]: 好的，我下周一前出对接方案
[王同学(测试)]: 我负责 5 月 20 日前完成压测报告

正确输出：
{
  "summary": "本次会议决定供应商选型采用 B 方案，理由是技术稳定性优先；李工负责下周一前产出对接方案，王同学负责 5 月 20 日前完成压测报告。",
  "decisions": ["供应商选型采用 B 方案，理由：技术稳定性优先于集成成本"],
  "actionItems": [
    {"owner": "李工", "content": "产出 B 方案对接方案", "ddl": "下周一"},
    {"owner": "王同学", "content": "完成压测报告", "ddl": "5 月 20 日"}
  ],
  "issues": [],
  "nextSteps": []
}

### 示例 B：闲聊 / 没有真正会议内容（最关键的反幻觉示例）

输入：
[Alice]: 早上好啊
[Bob]: 早，今天天气不错
[Alice]: 周末打算干嘛？
[Bob]: 看看新出的电影

正确输出（必须全部为空，绝对不能编造）：
{
  "summary": "本次群聊未识别到与项目相关的决策、行动项或会议结论，仅为日常寒暄。",
  "decisions": [],
  "actionItems": [],
  "issues": [],
  "nextSteps": []
}

错误示范（绝对禁止，这种是 topic inflation）：
❌ {"decisions": ["决定周末看电影"], ...}
理由：日常闲聊不构成项目决策。

### 示例 C：False attribution + Temporal smoothing（提问≠决策；可能≠敲定）

输入：
[周经理]: 我们要不要用 React Native 做跨端？
[周经理]: 还是分别原生开发？
[陈工程师]: 各有取舍，RN 性能可能差点
[周经理]: 嗯，再考虑下，下周开会再定

正确输出：
{
  "summary": "本次讨论了跨端方案选型（RN vs 原生），未达成结论，下周二次会议再定。",
  "decisions": [],
  "actionItems": [],
  "issues": [
    "跨端方案选型未定：RN（性能可能稍弱）vs 原生（开发成本高）",
    "下周开会前需要补充决策依据"
  ],
  "nextSteps": ["下周再开会决定跨端方案"]
}

错误示范 1（false attribution，绝对禁止）：
❌ {"decisions": ["周经理决定使用 React Native"]}
理由：周经理是在提问，不是决策。

错误示范 2（temporal smoothing，绝对禁止）：
❌ {"decisions": ["决定使用 RN（性能稍差）"]}
理由："再考虑下"是悬而未决，不是敲定。

### 示例 D：Consensus fabrication + 隐式责任人不展开（单边发言≠全员同意）

输入：
[黄总]: 我看 Q3 营销预算应该砍一半，集中投头部渠道
[赵 PM]: 嗯
[黄总]: 还有市场部要把活动数量从 10 个降到 5 个
[黄总]: 大家有意见吗？
（之后无人回复）

正确输出：
{
  "summary": "黄总提出 Q3 营销预算砍半 + 活动数量减少的建议，群里未见明确同意或反对意见，需进一步确认。",
  "decisions": [],
  "actionItems": [],
  "issues": [
    "黄总提出 Q3 营销预算砍半、活动数量从 10 个降到 5 个，未见明确反馈",
    "需补充市场部 / 财务部的明确反馈再形成决策"
  ],
  "nextSteps": ["确认 Q3 营销预算与活动数量调整方案"]
}

错误示范（consensus fabrication，绝对禁止）：
❌ {"decisions": ["全员同意 Q3 营销预算砍半"]}
理由：只有"嗯"和无人回复，不能等同于全员同意。

错误示范（编造责任人）：
❌ {"actionItems": [{"owner": "市场部负责人", "content": "调整活动数量"}]}
理由：群里没人显式承诺这个动作，不许编造执行人。
`.trim();

// ─── SUMMARY_PROMPT 主函数 ────────────────────────────────────────────────────

const SYSTEM_RULES = `
你是会议纪要整理助手。任务：把下方群聊记录里的会议内容提炼成结构化纪要。

# 5 条硬规则（违反任何一条都算严重错误）

1. **False attribution 防御**：只把「明确做出表态 / 拍板」的发言记为决策；提问、设想、
   "要不要"、"考虑一下"等疑问 / 商议语气**不是决策**。
2. **Temporal smoothing 防御**：只有出现「决定 / 定了 / OK / 那就 X / 我们 X」等明确
   敲定的语义，才能进 \`decisions\`；含糊的「可能 / 或许 / 再看看 / 下次再聊」一律进
   \`issues\`，不许私自渲染成已定。
3. **Consensus fabrication 防御**：单方发言、群里无人回应 / 只有「嗯」「ok」收到回执
   等弱响应，**不能**写成"全员同意"。这种情况进 \`issues\`，提示需要进一步确认。
4. **Action item 必须有显式责任人**：群聊里没人显式说"我做 X"或"@X 负责 X"，就**不要**
   塞进 \`actionItems\`；改成放进 \`issues\` 里描述"X 待落实，责任人未定"。
5. **没出现过的人名 / 数字 / 日期 / KPI 一律不许出现在输出里**。即使示例 A-D 里有具体
   数字，也只是示例，不要往当前任务里搬运。

# Topic inflation 防御

\`decisions\` / \`actionItems\` 字段宁缺毋滥。一句随口的话不要升格为决策，群里日常
寒暄不要硬总结。如果整段聊天没有真正的项目内容，按示例 B 全部输出空。

# summary 字段（80-160 字）

整段话用第三人称客观陈述，不许用「我们」「大家」这种主观措辞，不许把"未达成"
渲染成"达成"。decisions / actionItems 都为空时，summary 应明确说明"未识别到决策"。
`.trim();

export function SUMMARY_PROMPT(history: readonly Message[]): string {
  const lines = history.length
    ? history.map((m) => `[${m.sender.name ?? m.sender.userId}]: ${m.text}`).join('\n')
    : '（无群聊记录）';

  return [
    SYSTEM_RULES,
    '',
    '# 4 个 Few-Shot 示例',
    '',
    FEW_SHOT_EXAMPLES,
    '',
    '# 现在轮到你处理',
    '',
    '## 群聊记录',
    '',
    lines,
    '',
    '## 输出',
    '',
    '只返回符合 schema 的 JSON，不要 markdown 代码块，不要任何说明文字。',
    'JSON schema: {"summary": string, "decisions": string[], "actionItems": [{"owner": string, "content": string, "ddl"?: string}], "issues": string[], "nextSteps": string[]}',
  ].join('\n');
}

// ─── 渲染器：structured → 飞书文档 markdown ───────────────────────────────────
//
// 仿 requirementDoc 的 renderRequirementDocMarkdown，给会议纪要做长版文档归档。
// 走 JS 模板不过 LLM，避免二次幻觉。

export function renderMeetingMinutesMarkdown(
  s: SummaryExtraction,
  meta: { readonly chatTitle?: string; readonly generatedAt: number },
): string {
  const lines: string[] = [];
  const dateStr = new Date(meta.generatedAt).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const title = meta.chatTitle ? `${meta.chatTitle} 会议纪要` : '会议纪要';
  lines.push(`# ${title}（${dateStr}）`, '');

  if (s.summary && s.summary.trim()) {
    lines.push(`> ${s.summary.trim()}`, '');
  }

  if (s.decisions.length) {
    lines.push('## ✅ 决策', '', ...s.decisions.map((d) => `- ${d}`), '');
  }

  if (s.actionItems.length) {
    lines.push('## 🔲 行动项', '');
    for (const a of s.actionItems) {
      const owner = a.owner ? `**@${a.owner}**` : '*待指定*';
      const ddl = a.ddl ? `（截止 ${a.ddl}）` : '';
      lines.push(`- ${owner}: ${a.content}${ddl}`);
    }
    lines.push('');
  }

  if (s.issues.length) {
    lines.push('## 🔍 遗留问题', '', ...s.issues.map((i) => `- ${i}`), '');
  }

  if (s.nextSteps.length) {
    lines.push('## ⏭️ 下一步', '', ...s.nextSteps.map((n) => `- ${n}`), '');
  }

  if (
    !s.summary &&
    !s.decisions.length &&
    !s.actionItems.length &&
    !s.issues.length &&
    !s.nextSteps.length
  ) {
    lines.push('（未在群历史中识别到明确的决策、行动项或会议结论。）');
  }

  return lines.join('\n');
}

// ─── 渲染器：structured → 卡片 summary 字段（不再过 LLM）──────────────────────
//
// 跟 archive 一样：渲染走 JS 模板，避免二次幻觉。
// 主要让 summary 字段在 LLM 输出空时也能拼出可读的兜底文案。

export function renderSummaryProse(s: SummaryExtraction): string {
  // LLM 已经给了一段话，且结构化字段非全空 → 直接用
  if (s.summary && s.summary.trim().length > 0) {
    return s.summary.trim();
  }

  const parts: string[] = [];
  if (s.decisions.length > 0) {
    parts.push(`形成 ${s.decisions.length} 项决策`);
  }
  if (s.actionItems.length > 0) {
    parts.push(`${s.actionItems.length} 条行动项`);
  }
  if (s.issues.length > 0) {
    parts.push(`${s.issues.length} 个待澄清问题`);
  }
  if (parts.length > 0) {
    return `本次会议${parts.join('、')}，详见下方分段。`;
  }
  return '未在群历史中识别到明确的决策、行动项或会议结论。';
}
