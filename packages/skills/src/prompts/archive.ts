/**
 * Archive 防幻觉 Prompt（issue #104 v2）
 *
 * 设计依据（基于 7 个权威模板字段交集 + 2025 LLM 幻觉研究）：
 *
 *   字段                          PMI  Atlassian  SRE  AWS-PES  GRAI  KISS  命中
 *   ──────────────────────────────────────────────────────────────────────────
 *   goal（项目目标）              ✓    ✓          ✓    ✓        ✓     —     6/6
 *   outcomes（实际产出）          ✓    ✓          —    —        ✓     —     4/6
 *   whatWorkedWell（顺利之处）    ✓    —          ✓    —        ✓     ✓     5/6
 *   whatToImprove（待改进）       ✓    ✓          ✓    ✓        ✓     ✓     6/6
 *   openIssues（遗留问题）        —    ✓          ✓    ✓        ✓     ✓     5/6
 *
 * 防幻觉框架：Microsoft Azure ICE
 *   I (Instructions)：明确任务
 *   C (Constraints)：仅引用 memory/decision/todo 数据
 *   E (Escalation)：无数据 → 空数组（不发明）
 *
 * 计算字段（decisionCount / taskCompletion）由 JS 算，不让 LLM 碰 —
 * 物理隔离防幻觉。
 *
 * 引用：
 *   - Google SRE Postmortem (sre.google/sre-book/example-postmortem)
 *   - Atlassian Project Closure (atlassian.com/.../project-closure-template)
 *   - PMI Project Closure Form
 *   - AWS US-EAST-1 PES (Dec 2021)
 *   - GRAI 复盘法（飞书模板）
 *   - Microsoft Azure: Best Practices for Mitigating LLM Hallucinations
 *   - 2025 Hallucination Survey (frontiersin.org)
 */

import type { BitableRow, SchemaLike } from '@seedhac/contracts';

// ─── ArchiveSummary Schema（5 字段）─────────────────────────────────────────

export interface ArchiveSummary {
  /** 项目目标，一句话（10-30 字）。源自 memory 中的目标陈述。*/
  readonly goal: string;
  /** 实际产出 2-4 条。每条须能在 memory 里找到对应记录。*/
  readonly outcomes: readonly string[];
  /** 顺利之处 2-3 条。源自已完成 todos / 正面 memory。*/
  readonly whatWorkedWell: readonly string[];
  /** 待改进 2-3 条。源自未完成 todos / 风险 memory。*/
  readonly whatToImprove: readonly string[];
  /** 遗留问题 2-3 条。源自 status != 'done' 的 todos。*/
  readonly openIssues: readonly string[];
}

const EMPTY_SUMMARY: ArchiveSummary = {
  goal: '',
  outcomes: [],
  whatWorkedWell: [],
  whatToImprove: [],
  openIssues: [],
};

function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be array`);
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new Error(`${name}[${i}] must be string`);
    return v;
  });
}

export const ArchiveSummarySchema: SchemaLike<ArchiveSummary> = {
  parse(value: unknown): ArchiveSummary {
    if (typeof value !== 'object' || value === null) throw new Error('archive summary must be object');
    const o = value as Record<string, unknown>;
    if (typeof o['goal'] !== 'string') throw new Error('goal must be string');
    return {
      goal: o['goal'],
      outcomes: asStringArray(o['outcomes'] ?? [], 'outcomes'),
      whatWorkedWell: asStringArray(o['whatWorkedWell'] ?? [], 'whatWorkedWell'),
      whatToImprove: asStringArray(o['whatToImprove'] ?? [], 'whatToImprove'),
      openIssues: asStringArray(o['openIssues'] ?? [], 'openIssues'),
    };
  },
  jsonSchema(): Record<string, unknown> {
    const stringArray = { type: 'array', items: { type: 'string' } };
    return {
      type: 'object',
      required: ['goal', 'outcomes', 'whatWorkedWell', 'whatToImprove', 'openIssues'],
      properties: {
        goal: { type: 'string' },
        outcomes: stringArray,
        whatWorkedWell: stringArray,
        whatToImprove: stringArray,
        openIssues: stringArray,
      },
    };
  },
};

// ─── 3-shot 示例（A 齐全 / B 空 / C 部分+失败）──────────────────────────────
//
// Microsoft ICE 三层都覆盖：
//   - A 教 I 层（正确 schema 填法）
//   - B 教 E 层（最关键：空数据 → 空数组，绝不发明）
//   - C 教 C 层（诚实承认 whatToImprove，不美化）

const FEW_SHOT_EXAMPLES = `
### 示例 A：数据齐全的成功项目（B2C 校园打卡 App）

输入数据：
- memory: [需求文档] 校园骑行打卡 App PRD\\nhttps://x.feishu.cn/req | 决定使用高德 SDK | 张三完成首页 UI | 周日 demo 完成
- decision: 用高德地图 SDK；MVP 范围限定为校园内 5 公里半径
- todo: 完成首页(done) | 集成定位(done) | 排行榜(done) | 分享卡片(pending)

正确输出：
{
  "goal": "面向大学生的校园骑行打卡 App，鼓励运动习惯",
  "outcomes": [
    "PRD 已落地，定位 5 公里半径内的骑行轨迹",
    "首页 UI + 高德定位 + 排行榜功能已上线"
  ],
  "whatWorkedWell": [
    "提前选定高德 SDK，技术栈无返工",
    "MVP 范围卡得严，按时 demo"
  ],
  "whatToImprove": [
    "分享卡片功能延期"
  ],
  "openIssues": [
    "分享卡片 pending"
  ]
}

### 示例 B：空数据 / 数据极度不足（最关键的反幻觉示例）

输入数据：
- memory: （空）
- decision: （空）
- todo: （空）

正确输出（必须全字段空数组，绝对不能发明任何内容）：
{
  "goal": "",
  "outcomes": [],
  "whatWorkedWell": [],
  "whatToImprove": [],
  "openIssues": []
}

错误示范（绝对禁止）：
❌ {"goal": "完成项目交付", "outcomes": ["代码已合并"], ...}
理由：没有任何数据支撑，编造内容是幻觉。

### 示例 C：部分数据 + 包含失败学习（B2B 内部工具，未达预期）

输入数据：
- memory: [需求文档] 报销 OA 升级\\nhttps://x.feishu.cn/req | 后端 API 联调失败 | UI 改稿 3 次
- decision: 选用 SAP 现成模块（后被推翻，改自研）
- todo: 后端 API(done) | 前端表单(done) | 审批流(pending) | 移动端(blocked)

正确输出（诚实承认问题，不美化）：
{
  "goal": "把财务报销从纸质流程升级为线上 OA 系统",
  "outcomes": [
    "后端 API 联通，前端表单完成"
  ],
  "whatWorkedWell": [
    "前端表单一次过，UX 评审 0 返工"
  ],
  "whatToImprove": [
    "技术选型反复（SAP→自研）浪费 2 周",
    "UI 改稿 3 次，需求对齐不充分"
  ],
  "openIssues": [
    "审批流 pending",
    "移动端 blocked，依赖未明确"
  ]
}
`.trim();

// ─── 主 Prompt ──────────────────────────────────────────────────────────────

const SYSTEM_RULES = `
你是项目交付归档助手。你的任务：根据下面提供的 memory / decision / todo 数据，
按 schema 输出项目交付摘要。

# 4 条硬规则（违反任何一条都算严重错误）

1. **只能引用提供数据中实际出现的事实**。不要根据"项目类型"或"常识"补全 schema。
2. **字段无对应数据 → 输出空字符串 "" 或空数组 []**。绝不发明内容。
3. **不预测未来里程碑、日期、产值数字**。这些都是幻觉重灾区。
4. **不输出任何数字（决策数 / 任务完成数）**。这些字段由代码计算，你只填文字字段。

# 输出长度

- goal：10-30 字
- outcomes / whatWorkedWell / whatToImprove / openIssues：每条 15-40 字，每个字段 2-4 条
- 总输出控制在 200 字以内（幻觉集中在长输出后段，短输出更可靠）

# 数据严重不足时

如果 memory 加 decision 加 todo 总条数 < 3，**所有字段都输出空**（goal: ""，
其它都 []）。代码会兜底成静态 fallback 文案，不要试图填充。
`.trim();

function summarizeBitableRow(r: BitableRow, maxLen = 80): string {
  const content = String(r['content'] ?? '');
  const status = r['status'] ? `(${String(r['status'])})` : '';
  const trimmed = content.length > maxLen ? content.slice(0, maxLen) + '…' : content;
  return `${trimmed}${status}`.trim();
}

export function ARCHIVE_SUMMARY_PROMPT(
  memories: readonly BitableRow[],
  decisions: readonly BitableRow[],
  todos: readonly BitableRow[],
): string {
  const memoryLines = memories.length
    ? memories.map((m) => `- ${summarizeBitableRow(m)}`).join('\n')
    : '（空）';
  const decisionLines = decisions.length
    ? decisions.map((d) => `- ${summarizeBitableRow(d)}`).join('\n')
    : '（空）';
  const todoLines = todos.length
    ? todos.map((t) => `- ${summarizeBitableRow(t)}`).join('\n')
    : '（空）';

  return [
    SYSTEM_RULES,
    '',
    '# 三个 Few-Shot 示例',
    '',
    FEW_SHOT_EXAMPLES,
    '',
    '# 现在轮到你处理',
    '',
    '## 输入数据',
    '',
    `### memory（${memories.length} 条）`,
    memoryLines,
    '',
    `### decision（${decisions.length} 条）`,
    decisionLines,
    '',
    `### todo（${todos.length} 条）`,
    todoLines,
    '',
    '## 输出',
    '',
    '只返回 JSON，不要 markdown 代码块，不要任何说明文字。',
  ].join('\n');
}

// ─── 渲染器：structured → 100-200 字自然语言 summary ────────────────────────
//
// 关键：渲染走 JS 模板，**不再过 LLM**。这样：
//   1. 避免二次幻觉（结构化数据已经过 schema 约束）
//   2. 渲染逻辑完全可控、可测试
//   3. 节省一次 LLM 调用

export function renderArchiveSummary(
  s: ArchiveSummary,
  computed: { decisionCount: number; taskCompletion: string | null },
): string {
  const parts: string[] = [];

  if (s.goal) {
    parts.push(`本项目以「${s.goal}」为目标。`);
  } else {
    return `项目已收尾，详细产出请见上方链接。如需进一步复盘可 @bot 提问。`;
  }

  if (s.outcomes.length > 0) {
    parts.push(`核心产出：${s.outcomes.join('；')}。`);
  }

  if (s.whatWorkedWell.length > 0) {
    parts.push(`顺利之处：${s.whatWorkedWell.join('；')}。`);
  }

  if (s.whatToImprove.length > 0) {
    parts.push(`待改进：${s.whatToImprove.join('；')}。`);
  }

  // 计算字段拼接 —— 这部分数字 100% 由代码算，不可能幻觉
  const stats: string[] = [];
  if (computed.decisionCount > 0) stats.push(`共形成 ${computed.decisionCount} 项决策`);
  if (computed.taskCompletion) stats.push(`任务完成 ${computed.taskCompletion}`);
  if (stats.length > 0) parts.push(`${stats.join('，')}。`);

  if (s.openIssues.length > 0) {
    parts.push(`遗留问题：${s.openIssues.slice(0, 2).join('；')}。`);
  }

  return parts.join(' ');
}

export { EMPTY_SUMMARY };
