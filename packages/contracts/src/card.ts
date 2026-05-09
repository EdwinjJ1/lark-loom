/**
 * 飞书卡片输出契约。
 *
 * 主链路卡片（对应用户可见的关键时刻）：
 *   activation / docPush / tablePush / qa / summary / slides / archive
 *
 * 附属链路卡片：
 *   offlineSummary / docChange / weekly
 *
 * 保留但由 Skill 以纯文本输出（不走 CardBuilder）：
 *   recall     → Skill 直接返回 SkillResult.text，更像同事随口一句话
 *
 * 实现层（CardBuilder）负责把这里定义的 Input 渲染成飞书 Card 2.0 JSON。
 */

export type CardTemplateName =
  // ── 主链路 ──────────────────────────────────
  | 'activation' // 群创建后询问是否开启助手
  | 'docPush' // 需求文档 / 报告生成后推到群里
  | 'tablePush' // 分工多维表格生成后推到群里
  | 'qa' // @bot 问答
  | 'summary' // 会议 / 阶段总结
  | 'slides' // 演示文稿生成
  | 'archive' // 项目归档
  | 'rehearsal' // 演练复盘分析（issues / suggestions / uncertainties）
  | 'rehearsalClarify' // 演练反问澄清（循环到用户满意）
  | 'rehearsalPreview' // AI 听众预演分页讲稿卡（issue #145）
  | 'rehearsalReview' // 累积改动决策透明化卡（issue #145）
  // ── 附属链路 ────────────────────────────────
  | 'offlineSummary' // 用户重连后的离线期间摘要
  | 'docChange' // 重要文档变更通知
  | 'weekly' // 周报
  // ── 保留（Skill 内部用，CardBuilder 可选实现）
  | 'recall';

export interface CardSource {
  readonly title: string;
  readonly url?: string;
  /** 来源类型：飞书文档 / Wiki / Bitable / 群历史消息 / 妙记 / Web ... */
  readonly kind: 'doc' | 'wiki' | 'slides' | 'bitable' | 'chat' | 'minutes' | 'web' | 'other';
  readonly snippet?: string;
  readonly authorName?: string;
  readonly timestamp?: number;
  readonly messageId?: string;
}

export interface CardButton {
  readonly text: string;
  /** 按钮被点时透传的业务参数；若 action==='open_url' 则 url 字段生效 */
  readonly value: Record<string, unknown>;
  readonly variant?: 'primary' | 'default' | 'danger';
}

// ── 主链路 Input ──────────────────────────────────────────────────────────────

export interface ActivationCardInput {
  readonly chatName: string;
  /** 可选：展示给管理员的一句话说明 */
  readonly description?: string;
  // 卡片三态：未确认 / 已启用 / 已忽略 —— confirmed* 与 dismissed* 互斥
  /** 启用状态：点击者 displayName 或 open_id */
  readonly confirmedBy?: string;
  readonly confirmedAt?: number;
  /** 忽略状态 */
  readonly dismissedBy?: string;
  readonly dismissedAt?: number;
}

export interface DocPushCardInput {
  readonly docTitle: string;
  /** 终态文档 URL；loading / error 态可为空字符串 */
  readonly docUrl: string;
  /** 文档类型，影响图标与措辞 */
  readonly docType: 'requirement' | 'report' | 'minutes' | 'other';
  /** 可选：一句话内容摘要 */
  readonly summary?: string;
  /** loading 占位：先发出去拿 messageId，跑完了再 patchCard 替换为终态 */
  readonly isLoading?: boolean;
  /** loading 时显示的预估时长（秒），如 30-60 渲染成「预计 30-60 秒」 */
  readonly etaSeconds?: number;
  /** error 终态：跑挂时把 loading 卡片 patch 成失败提示 */
  readonly errorMessage?: string;
}

export interface TablePushCardInput {
  readonly tableTitle: string;
  /** 终态分工表 URL；loading / error 态可为空字符串 */
  readonly bitableUrl: string;
  readonly taskCount: number;
  readonly members: readonly string[];
  /** 最近一个 DDL，格式 YYYY-MM-DD */
  readonly nearestDue?: string;
  /** loading 占位：先 sendCard 拿 messageId，跑完后 patchCard 替换为终态 */
  readonly isLoading?: boolean;
  /** error 终态：跑挂时把 loading 卡片 patch 成失败提示 */
  readonly errorMessage?: string;
}

export interface QaCardInput {
  readonly question: string;
  readonly answer: string;
  readonly sources: readonly CardSource[];
  readonly buttons?: readonly CardButton[];
}

export interface SummaryCardInput {
  readonly title: string;
  readonly topics: readonly string[];
  readonly decisions: readonly string[];
  readonly todos: readonly { text: string; assignee?: string; due?: string }[];
  readonly followUps: readonly string[];
  /** 一句话/一段话整体摘要，渲染在顶部，结构化字段为空时仍能给用户可读的输出 */
  readonly summary?: string;
  /** 完整会议纪要飞书文档链接（混合方案：卡片内嵌 + 长版文档归档）*/
  readonly docUrl?: string;
  readonly isLoading?: boolean;
  readonly errorMessage?: string;
}

export interface SlidesCardInput {
  readonly title: string;
  readonly presentationUrl: string;
  readonly pageCount: number;
  readonly preview?: readonly { title: string; bullets: readonly string[] }[];
  readonly isLoading?: boolean;
  readonly errorMessage?: string;
}

/** 一条产出物链接：需求文档 / PPT / 分工表 / 多维表格等 */
export interface ArchiveLink {
  /** 显示文案，如 "需求文档" / "演示 PPT" / "任务分工表" */
  readonly label: string;
  readonly url: string;
  /** 可选：来源 skill 名（用于卡片图标 / 排序） */
  readonly kind?: 'requirementDoc' | 'slides' | 'taskAssignment' | 'bitable' | 'other';
}

export interface ArchiveCardInput {
  readonly recordId: string;
  readonly title: string;
  /** 多维表格归档入口；为空时按钮降级为不可点击文本 */
  readonly bitableUrl: string;
  readonly tags: readonly string[];
  /** 可选：项目一句话成果摘要 */
  readonly summary?: string;
  /** 本次归档收集到的产出物链接 */
  readonly links?: readonly ArchiveLink[];
  /** 可选：任务完成情况 "8/10 已完成" */
  readonly taskStats?: string;
  /** 可选：决策数 */
  readonly decisionCount?: number;
  /** 完整归档报告飞书 doc URL（issue #114）；有则渲染"查看完整报告"按钮 */
  readonly reportDocUrl?: string;
  /** loading 占位：先发出去拿 messageId，跑完后 patchCard 替换为终态 */
  readonly isLoading?: boolean;
  /** loading 时显示的预估时长（秒） */
  readonly etaSeconds?: number;
  /** error 终态：跑挂时把 loading 卡 patch 成失败提示 */
  readonly errorMessage?: string;
}

// ── 演练复盘 Input ────────────────────────────────────────────────────────────

/** 五维评估（参考字节『坦诚清晰』 + 麦肯锡金字塔 + 飞书赛道权重） */
export type RehearsalDimensionLabel = '内容' | '结构' | '表达' | '受众' | '时间' | '其他';

/** 一条带维度的反馈条目（issue / suggestion 通用） */
export interface RehearsalDimensionedItem {
  readonly text: string;
  readonly dimension: RehearsalDimensionLabel;
}

/**
 * 演练分析卡（template: rehearsal）—— 四态：
 *   - loading：拉历史 / 跑分析中
 *   - active：列 issues / suggestions（按维度分组） / uncertainties + 满意/继续修改 按钮
 *   - completed：用户点"满意，完成"后的终态，附产出物链接
 *   - error：分析失败
 */
export interface RehearsalCardInput {
  /** 第几轮分析（从 1 开始） */
  readonly round: number;
  /** 演示中存在的问题（带维度，用于分组渲染） */
  readonly issues: readonly RehearsalDimensionedItem[];
  /** 修改建议（带维度） */
  readonly suggestions: readonly RehearsalDimensionedItem[];
  /** 信心不足 / 需要用户确认的不确定点 */
  readonly uncertainties: readonly string[];
  /** 一句话总览（80-120 字） */
  readonly summary?: string;
  readonly chatId?: string;
  /** 满意态：附产出物链接（PPT / 文档） */
  readonly newSlidesUrl?: string;
  readonly newDocUrl?: string;
  readonly noRegenReason?: 'noChanges' | 'regenFailed';
  readonly isLoading?: boolean;
  readonly isCompleted?: boolean;
  readonly errorMessage?: string;
}

// ── rehearsal v2 (issue #145) ─────────────────────────────────────────────────

/** AI 听众预演卡的一页 PPT 子项 */
export interface RehearsalPreviewPage {
  readonly page: number;
  readonly pageTitle: string;
  /** 演讲者人设 LLM 生成的三段式讲稿 */
  readonly hook: string;
  readonly core: string;
  readonly transition: string;
  /** 听众人设 LLM 给出的当页 critique（已过 attribution check） */
  readonly critiques: readonly RehearsalListenerCritique[];
}

export type RehearsalCritiqueCategory = 'audience' | 'content' | 'consistency';

export interface RehearsalListenerCritique {
  /** 跨多页时唯一 id（review 卡勾选过滤用） */
  readonly id: string;
  readonly category: RehearsalCritiqueCategory;
  readonly page: number;
  readonly text: string;
  readonly evidence: string;
  readonly cite?: string;
  readonly confidence: number;
  /** attribution 校验结果：'confirmed' / 'unsure'。'no' 整条丢，不会进卡片 */
  readonly attribution: 'confirmed' | 'unsure';
}

/**
 * AI 听众预演卡（template: rehearsalPreview）—— PPT 一存在即可跑，无需先开演练会。
 *   - active：每页 PPT 一段渲染（标题 / 三段式讲稿 / 听众点评 / 反馈按钮）
 *   - error：preview 跑挂的失败提示
 */
export interface RehearsalPreviewCardInput {
  readonly chatId: string;
  readonly totalPages: number;
  readonly pages: readonly RehearsalPreviewPage[];
  /** 风格槽位：严肃 / 路演（影响讲稿语气，仅在卡片头展示选择） */
  readonly style?: 'judges' | 'roadshow';
  readonly errorMessage?: string;
}

export type RehearsalChangeSource = 'user' | 'listener' | 'unsure';
export type RehearsalChangeTarget = 'slides' | 'doc';

/** Review 卡显示的一条累积改动 */
export interface RehearsalReviewChange {
  /** 唯一 id，按勾选过滤时使用 */
  readonly id: string;
  readonly target: RehearsalChangeTarget;
  readonly text: string;
  readonly source: RehearsalChangeSource;
  /** 默认是否勾选；user 默认 true，listener / unsure 默认 false */
  readonly defaultChecked: boolean;
}

/**
 * Review 卡（template: rehearsalReview）—— finalize 之前的决策透明化 checkpoint。
 * 三组 changes（user / listener / unsure）按 source 分组渲染，每条带勾选框。
 */
export interface RehearsalReviewCardInput {
  readonly chatId: string;
  readonly round: number;
  readonly changes: readonly RehearsalReviewChange[];
  /** 累积条数超过软上限时显示"请精简"提示（替代静默截断） */
  readonly overLimitHint?: boolean;
  readonly errorMessage?: string;
  /** 完成态：用户已点全部确认 / 取消 / 编辑 */
  readonly resolution?: 'confirmed' | 'cancelled' | 'editing';
  readonly resolvedAt?: number;
}

/**
 * 反问澄清卡（template: rehearsalClarify）—— 把 uncertainties 转成 1-3 个问题，
 * 等用户在群里直接文字回复（不是按钮）。
 *   - active：列出反问问题
 *   - acknowledged：用户回复后 patch 成"已收到反馈，重新分析中…"
 */
export interface RehearsalClarifyCardInput {
  readonly round: number;
  /** 1-3 个具体问题 */
  readonly questions: readonly string[];
  readonly chatId?: string;
  /** 已收到回答态 */
  readonly acknowledgedAt?: number;
  readonly errorMessage?: string;
}

// ── 附属链路 Input ────────────────────────────────────────────────────────────

export interface OfflineSummaryCardInput {
  /** 离线开始时间戳（Unix ms） */
  readonly offlineFrom: number;
  /** 重连时间戳（Unix ms） */
  readonly offlineTo: number;
  /** 按重要性排序的关键事件，最多展示 5 条 */
  readonly highlights: readonly string[];
  /** 离线期间群里新消息总数 */
  readonly messageCount: number;
}

export interface DocChangeCardInput {
  readonly editorName: string;
  readonly docTitle: string;
  readonly docUrl: string;
  /** 一句话变更摘要，如"修改了验收标准，新增了两个边界条件" */
  readonly changeSummary: string;
  /** 受影响的任务列表（可选） */
  readonly affectedTasks?: readonly string[];
}

export interface WeeklyCardInput {
  readonly weekRange: string; // "2026-04-22 ~ 2026-04-28"
  readonly highlights: readonly string[];
  readonly decisions: readonly string[];
  readonly todos: readonly string[];
  readonly metrics?: Record<string, number>;
}

// ── 保留类型（Skill 内部用） ───────────────────────────────────────────────────

export interface RecallCardInput {
  readonly trigger: string;
  readonly summary: string;
  readonly sources: readonly CardSource[];
  readonly buttons?: readonly CardButton[];
}

/** 模板 → 输入参数 的映射 */
export interface CardInputMap {
  activation: ActivationCardInput;
  docPush: DocPushCardInput;
  tablePush: TablePushCardInput;
  qa: QaCardInput;
  summary: SummaryCardInput;
  slides: SlidesCardInput;
  archive: ArchiveCardInput;
  rehearsal: RehearsalCardInput;
  rehearsalClarify: RehearsalClarifyCardInput;
  rehearsalPreview: RehearsalPreviewCardInput;
  rehearsalReview: RehearsalReviewCardInput;
  offlineSummary: OfflineSummaryCardInput;
  docChange: DocChangeCardInput;
  weekly: WeeklyCardInput;
  recall: RecallCardInput;
}

/** 渲染后的飞书 Card 2.0 JSON 信封 — 直接喂给 im.message.create */
export interface Card {
  readonly templateName: CardTemplateName;
  /** 飞书 Card 2.0 schema 完整 JSON */
  readonly content: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

/** 卡片渲染器 */
export interface CardBuilder {
  build<K extends CardTemplateName>(template: K, input: CardInputMap[K]): Card;
}
