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
  readonly bitableUrl: string;
  readonly taskCount: number;
  readonly members: readonly string[];
  /** 最近一个 DDL，格式 YYYY-MM-DD */
  readonly nearestDue?: string;
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
}

export interface SlidesCardInput {
  readonly title: string;
  readonly presentationUrl: string;
  readonly pageCount: number;
  readonly preview?: readonly { title: string; bullets: readonly string[] }[];
  readonly isLoading?: boolean;
  readonly errorMessage?: string;
}

export interface ArchiveCardInput {
  readonly recordId: string;
  readonly title: string;
  readonly bitableUrl: string;
  readonly tags: readonly string[];
  /** 可选：项目一句话成果摘要 */
  readonly summary?: string;
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
