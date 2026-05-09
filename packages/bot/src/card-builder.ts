/**
 * LarkCardBuilder — 飞书 Card 2.0 JSON 构造器
 *
 * 主链路（评委能看到的关键时刻，按出现顺序）：
 *   activation → docPush → tablePush → qa → summary → slides → archive
 *
 * 附属链路：
 *   offlineSummary / docChange / weekly
 *
 * 设计原则：
 *   - 每张卡片目的单一，不堆信息
 *   - 按钮只放"最重要的一个操作"，避免选择困难
 *   - recall / crossChat 由 Skill 以纯文本输出，不走 CardBuilder
 */

import type {
  ActivationCardInput,
  ArchiveCardInput,
  ArchiveLink,
  Card,
  CardBuilder,
  CardButton,
  CardInputMap,
  CardSource,
  CardTemplateName,
  DocChangeCardInput,
  DocPushCardInput,
  OfflineSummaryCardInput,
  QaCardInput,
  RecallCardInput,
  RehearsalCardInput,
  RehearsalClarifyCardInput,
  RehearsalCritiqueCategory,
  RehearsalDimensionedItem,
  RehearsalDimensionLabel,
  RehearsalPreviewCardInput,
  RehearsalReviewCardInput,
  RehearsalReviewChange,
  SlidesCardInput,
  SummaryCardInput,
  TablePushCardInput,
  WeeklyCardInput,
} from '@seedhac/contracts';

// ─── 飞书 Card 2.0 低层类型 ───────────────────────────────────────────────────

type TextTag = { tag: 'plain_text'; content: string };
type MdElement = { tag: 'markdown'; content: string };
type HrElement = { tag: 'hr' };

type BehaviorCallback = { type: 'callback'; value: Record<string, unknown> };
type BehaviorOpenUrl = { type: 'open_url'; default_url: string };
type Behavior = BehaviorCallback | BehaviorOpenUrl;

type ButtonElement = {
  tag: 'button';
  text: TextTag;
  type: 'primary' | 'default' | 'danger';
  behaviors: Behavior[];
};

type BodyElement = MdElement | HrElement | ButtonElement;

interface FeishuCard {
  schema: '2.0';
  header: { title: TextTag; template: string };
  body: { elements: BodyElement[] };
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function pt(content: string): TextTag {
  return { tag: 'plain_text', content };
}

function md(content: string): MdElement {
  return { tag: 'markdown', content };
}

function hr(): HrElement {
  return { tag: 'hr' };
}

/**
 * Card 2.0 按钮。
 * value.action === 'open_url' 时自动转为 open_url behavior，否则 callback。
 */
function btn(
  text: string,
  value: Record<string, unknown>,
  type: ButtonElement['type'] = 'default',
): ButtonElement {
  const behavior: Behavior =
    value['action'] === 'open_url' && typeof value['url'] === 'string'
      ? { type: 'open_url', default_url: value['url'] }
      : { type: 'callback', value };
  return { tag: 'button', text: pt(text), type, behaviors: [behavior] };
}

function renderSources(sources: readonly CardSource[]): string {
  if (sources.length === 0) return '';
  const kindMap: Record<CardSource['kind'], string> = {
    doc: '📄 文档',
    wiki: '📄 Wiki',
    slides: '🖼 幻灯片',
    bitable: '📊 表格',
    chat: '💬 群聊',
    minutes: '🎙 妙记',
    web: '🌐 网页',
    other: '📎 其他',
  };

  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return `**来源**\n${sources
    .map((s, i) => {
      const author = s.authorName ? s.authorName : '';
      const time = s.timestamp ? timeFormat.format(new Date(s.timestamp)) : '';
      const byline = [author, time].filter(Boolean).join(' · ');

      if (s.kind === 'chat') {
        // Format: "1. 💬 author · time — snippet" all on one line
        const label = s.url ? `[${s.title}](${s.url})` : s.title;
        const who = byline || label;
        const snippet = s.snippet ? s.snippet : label;
        return `${i + 1}. ${kindMap[s.kind]} **${who}** — ${snippet}`;
      }

      const title = s.url ? `[${s.title}](${s.url})` : s.title;
      const heading = `${i + 1}. ${kindMap[s.kind]} ${title}${byline ? `｜${byline}` : ''}`;
      return s.snippet ? `${heading}\n   ${s.snippet}` : heading;
    })
    .join('\n\n')}`;
}

function renderButtons(btns: readonly CardButton[]): ButtonElement[] {
  return btns.map((b) =>
    btn(
      b.text,
      b.value,
      b.variant === 'primary' ? 'primary' : b.variant === 'danger' ? 'danger' : 'default',
    ),
  );
}

function card(templateName: CardTemplateName, feishu: FeishuCard): Card {
  return { templateName, content: feishu as unknown as Record<string, unknown> };
}

// ─── 主链路卡片 ───────────────────────────────────────────────────────────────

/**
 * activation — bot 入群后的第一张卡
 *
 * 三态：
 *   1. 初始（默认）：自我介绍 + 数据使用告知 + [启用] / [暂不] 两按钮
 *   2. 已启用（confirmedBy/confirmedAt 给值）：替换按钮区为"✅ 已由 X 于 Y 启用"
 *   3. 已忽略（dismissedBy/dismissedAt 给值）：替换按钮区为"已忽略，需要时随时 @ 我"
 *
 * 设计意图：
 *   - 数据使用段是 PIPL 合规告知，所有群成员可见；卡本身就是留痕的 disclosure。
 *   - 已启用/已忽略态是 patchCard 的目标，audit 谁点了 + 什么时候点。
 */
function buildActivation(input: ActivationCardInput): Card {
  const isConfirmed = input.confirmedBy !== undefined && input.confirmedAt !== undefined;
  const isDismissed = input.dismissedBy !== undefined && input.dismissedAt !== undefined;

  // 状态用 template color 区分：blue 初始 / green 已启用 / grey 已暂停。
  // header 标题始终是产品名，避免 "Lark Loom 已启用 Lark Loom" 这种重复。
  const headerColor = isConfirmed ? 'green' : isDismissed ? 'grey' : 'blue';

  // 参考 ChatGPT for Slack / Linear / Notion AI 的 onboarding 模式：
  //   - 第一人称功能描述，去 "你好！" 这种对话化开头
  //   - disclosure 一句话，不 meta-描述 disclosure 本身
  //   - 中性按钮文案，无 emoji 杂质（状态用 template color 表达）
  const intro = md(
    '我会分析群聊内容，将 **项目需求 / 决策 / 行动项** 自动整理至团队飞书多维表格。',
  );
  const disclosure = md(
    '**数据使用**：群聊文本将通过大模型分析，分析结果可在多维表格中查看。',
  );

  const elements: BodyElement[] = [intro, disclosure];

  if (isConfirmed) {
    const time = formatTime(input.confirmedAt!);
    elements.push(hr(), md(`已由 **${input.confirmedBy}** 于 ${time} 启用`));
  } else if (isDismissed) {
    const time = formatTime(input.dismissedAt!);
    elements.push(hr(), md(`已由 **${input.dismissedBy}** 于 ${time} 暂停 · @ 我可重新启用`));
  } else {
    elements.push(
      btn('启用 Lark Loom', { action: 'activate', chatName: input.chatName }, 'primary'),
      btn('稍后', { action: 'dismiss' }, 'default'),
    );
  }

  return card('activation', {
    schema: '2.0',
    header: { title: pt('Lark Loom'), template: headerColor },
    body: { elements },
  });
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/**
 * docPush — 需求文档 / 报告生成后推送
 * 目的：让群成员一键打开文档，感知"文档已就绪"
 * UI：一句话说明文档内容，单个主按钮，权限说明用小字
 */
function buildDocPush(input: DocPushCardInput): Card {
  const typeLabel: Record<DocPushCardInput['docType'], string> = {
    requirement: '📋 需求文档',
    report: '📊 汇报材料',
    minutes: '🗒 会议纪要',
    other: '📄 文档',
  };

  // loading 占位：先 sendCard 拿 messageId，跑完用 patchCard 换终态
  if (input.isLoading) {
    const etaLine = input.etaSeconds
      ? `预计耗时约 ${input.etaSeconds} 秒，请稍候。`
      : '通常需要 30-60 秒，请稍候。';
    return card('docPush', {
      schema: '2.0',
      header: { title: pt('文档生成中…'), template: 'blue' },
      body: {
        elements: [
          md(`${typeLabel[input.docType]} **${input.docTitle}**\n\n${etaLine}`),
          md('_我会从群聊上下文与关联文档里提取需求，整理完会自动替换这条卡片。_'),
        ],
      },
    });
  }

  // error 终态：跑挂时把 loading 卡片 patch 成失败提示
  if (input.errorMessage) {
    return card('docPush', {
      schema: '2.0',
      header: { title: pt('文档生成失败'), template: 'red' },
      body: {
        elements: [
          md(`${typeLabel[input.docType]} **${input.docTitle}**\n\n${input.errorMessage}`),
        ],
      },
    });
  }

  const elements: BodyElement[] = [
    md(
      `${typeLabel[input.docType]} **${input.docTitle}** 已生成${input.summary ? `\n\n${input.summary}` : ''}`,
    ),
    hr(),
    btn('打开文档', { action: 'open_url', url: input.docUrl }, 'primary'),
    md('_仅群内成员可查看与编辑_'),
  ];
  return card('docPush', {
    schema: '2.0',
    header: { title: pt('文档已就绪'), template: 'turquoise' },
    body: { elements },
  });
}

/**
 * tablePush — 分工多维表格生成后推送
 * 目的：让所有人知道分工表在哪、谁负责什么、最近的 DDL 是什么时候
 * UI：列出成员和最近 DDL，突出"查看表格"入口
 */
function buildTablePush(input: TablePushCardInput): Card {
  // 三态共用同一个模板色，仅 header 标题区分；与 summary / slides 的「两态同色」对齐
  const HEADER_TEMPLATE = 'yellow' as const;

  if (input.isLoading) {
    return card('tablePush', {
      schema: '2.0',
      header: { title: pt('分工表生成中'), template: HEADER_TEMPLATE },
      body: {
        elements: [
          md(
            `**${input.tableTitle}**\n\n正在识别群里讨论的分工（owner / 任务 / DDL / 验收标准），通常需要 30-60 秒。`,
          ),
          md('_整理完会自动替换这条卡片。_'),
        ],
      },
    });
  }

  if (input.errorMessage) {
    return card('tablePush', {
      schema: '2.0',
      header: { title: pt('分工表生成失败'), template: 'red' },
      body: {
        elements: [md(`**${input.tableTitle}**\n\n${input.errorMessage}`)],
      },
    });
  }

  const memberLine = input.members.map((m) => `@${m}`).join('  ');
  const dueLine = input.nearestDue ? `\n⏰ 最近截止：**${input.nearestDue}**` : '';
  // 注：分工表是项目共享 bitable（所有群共用同一个 base），目前**无法**做到
  // "仅群内成员可查看与编辑"——按钮点开就是整张 base。要做真正的隔离需要
  // 每群独立 bitable 或 per-chat filter view，单开 issue 跟进。
  return card('tablePush', {
    schema: '2.0',
    header: { title: pt('分工表已生成'), template: HEADER_TEMPLATE },
    body: {
      elements: [
        md(`**${input.tableTitle}**\n共 ${input.taskCount} 个任务 · 成员：${memberLine}${dueLine}`),
        hr(),
        btn('查看分工表', { action: 'open_url', url: input.bitableUrl }, 'primary'),
      ],
    },
  });
}

/**
 * qa — @bot 问答
 * 目的：快速给出答案 + 来源，让提问者能追溯原始依据
 * UI：问题 / 答案 / 来源三段式，按钮可选
 */
function buildQa(input: QaCardInput): Card {
  const elements: BodyElement[] = [
    md(`**问题**\n${input.question}`),
    hr(),
    md(`**回答**\n${input.answer}`),
  ];
  const sourceText = renderSources(input.sources);
  if (sourceText) elements.push(hr(), md(sourceText));
  if (input.buttons?.length) elements.push(...renderButtons(input.buttons));
  return card('qa', {
    schema: '2.0',
    header: { title: pt('智能问答'), template: 'blue' },
    body: { elements },
  });
}

/**
 * summary — 会议 / 阶段总结
 * 目的：把散落的讨论结构化，让所有人对齐"决定了什么、谁要做什么"
 * UI：议题 / 决策 / 待办 / 待跟进四段，强制可见
 */
function buildSummary(input: SummaryCardInput): Card {
  // 三态共用同一个模板色，仅 header 标题区分；与 slides 的「两态同色」保持一致
  const HEADER_TEMPLATE = 'blue' as const;

  if (input.isLoading) {
    return card('summary', {
      schema: '2.0',
      header: { title: pt('会议纪要整理中'), template: HEADER_TEMPLATE },
      body: {
        elements: [
          md(
            `**${input.title}**\n\n正在分析群历史并提取决策 / 行动项 / 遗留问题，通常需要 30-90 秒。`,
          ),
          md('_我会从群聊上下文里提取关键信息，整理完会自动替换这条卡片。_'),
        ],
      },
    });
  }

  if (input.errorMessage) {
    return card('summary', {
      schema: '2.0',
      header: { title: pt('会议纪要整理失败'), template: 'red' },
      body: {
        elements: [md(`**${input.title}**\n\n${input.errorMessage}`)],
      },
    });
  }

  const elements: BodyElement[] = [md(`**${input.title}**`)];
  if (input.summary) elements.push(md(input.summary));
  elements.push(hr());

  if (input.topics.length)
    elements.push(md(`**📋 议题**\n${input.topics.map((t) => `- ${t}`).join('\n')}`));
  if (input.decisions.length)
    elements.push(hr(), md(`**✅ 决策**\n${input.decisions.map((d) => `- ${d}`).join('\n')}`));
  if (input.todos.length) {
    const lines = input.todos.map((t) => {
      let l = `- ${t.text}`;
      if (t.assignee) l += ` @${t.assignee}`;
      if (t.due) l += ` (截止 ${t.due})`;
      return l;
    });
    elements.push(hr(), md(`**🔲 待办**\n${lines.join('\n')}`));
  }
  if (input.followUps.length)
    elements.push(hr(), md(`**🔍 待跟进**\n${input.followUps.map((f) => `- ${f}`).join('\n')}`));

  // 全部结构化字段都空 + 也没 prose summary：给用户一个明确的"无可总结"提示，
  // 避免渲染出一张只有标题的空卡片
  if (
    !input.summary &&
    !input.topics.length &&
    !input.decisions.length &&
    !input.todos.length &&
    !input.followUps.length
  ) {
    elements.push(md('未在群历史中识别到明确的决策、行动项或会议结论，可补充后再触发。'));
  }

  // 混合方案：卡片显示决策/行动项摘要，按钮跳转完整会议纪要文档
  if (input.docUrl) {
    elements.push(
      hr(),
      btn('打开完整纪要', { action: 'open_url', url: input.docUrl }, 'primary'),
      md('_仅群内成员可查看与编辑_'),
    );
  }

  return card('summary', {
    schema: '2.0',
    header: { title: pt('会议纪要已就绪'), template: HEADER_TEMPLATE },
    body: { elements },
  });
}

/**
 * slides — 演示文稿生成
 * 目的：让群成员预览大纲、一键打开 PPT 并开始迭代
 * UI：页数 + 每页标题 + bullet 预览，唯一主按钮
 */
function buildSlides(input: SlidesCardInput): Card {
  if (input.isLoading) {
    return card('slides', {
      schema: '2.0',
      header: { title: pt('演示文稿生成中'), template: 'orange' },
      body: {
        elements: [
          md(`**${input.title}**\n正在生成演示文稿和汇报分工文稿，请稍等片刻。`),
        ],
      },
    });
  }

  if (input.errorMessage) {
    return card('slides', {
      schema: '2.0',
      header: { title: pt('演示文稿生成失败'), template: 'red' },
      body: {
        elements: [md(`**${input.title}**\n${input.errorMessage}`)],
      },
    });
  }

  const elements: BodyElement[] = [md(`**${input.title}**\n共 ${input.pageCount} 页`), hr()];
  if (input.preview?.length) {
    const previewMd = input.preview
      .map((p, i) => `## ${i + 1}. ${p.title}\n${p.bullets.map((b) => `  - ${b}`).join('\n')}`)
      .join('\n\n');
    elements.push(md(previewMd), hr());
  }
  elements.push(btn('打开演示文稿', { action: 'open_url', url: input.presentationUrl }, 'primary'));
  return card('slides', {
    schema: '2.0',
    header: { title: pt('演示文稿已生成'), template: 'orange' },
    body: { elements },
  });
}

/**
 * archive — 项目归档
 * 目的：宣告项目结束，提供完整产出物入口，方便复盘
 * UI：成果摘要 + 标签 + 查看按钮，有仪式感
 */
/** 产出物 kind → 显示图标，让评委一眼区分文档 / PPT / 表格 */
const ARCHIVE_LINK_ICONS: Record<NonNullable<ArchiveLink['kind']>, string> = {
  requirementDoc: '📋',
  slides: '🎯',
  taskAssignment: '✅',
  bitable: '📊',
  other: '📎',
};

function buildArchive(input: ArchiveCardInput): Card {
  // ── loading 态（issue #114）：先发出去拿 messageId，跑完用 patchCard 替换 ──
  if (input.isLoading) {
    const etaLine = input.etaSeconds
      ? `预计耗时约 ${input.etaSeconds} 秒，请稍候。`
      : '通常需要 30-60 秒，请稍候。';
    return card('archive', {
      schema: '2.0',
      header: { title: pt('归档进行中…'), template: 'blue' },
      body: {
        elements: [
          md(`📦 正在整理项目交付报告\n\n${etaLine}`),
          md('_我会汇总需求文档 / PPT / 会议决策 / 任务完成情况，生成一份正式归档报告。完成后这条卡片会自动更新。_'),
        ],
      },
    });
  }

  // ── error 态：归档过程挂了，patch 上失败提示 ──────────────────────────
  if (input.errorMessage) {
    return card('archive', {
      schema: '2.0',
      header: { title: pt('归档失败'), template: 'red' },
      body: {
        elements: [
          md(`⚠️ ${input.errorMessage}`),
          md('_可以稍后再试一次，或 @bot 单独询问需要归档的内容。_'),
        ],
      },
    });
  }

  // ── final 态 ────────────────────────────────────────────────────────────
  const elements: BodyElement[] = [
    md(`**${input.title}**${input.summary ? `\n\n${input.summary}` : ''}`),
  ];

  // 产出物链接列表：每条 markdown 渲染图标 + label + 可点击链接
  if (input.links && input.links.length > 0) {
    elements.push(hr());
    const linkLines = input.links.map((l) => {
      const icon = ARCHIVE_LINK_ICONS[l.kind ?? 'other'] ?? '📎';
      return `${icon} [${l.label}](${l.url})`;
    });
    elements.push(md(`**📦 项目产出**\n${linkLines.join('\n')}`));
  }

  // 关键指标（决策数 / 任务完成情况）
  if (input.decisionCount !== undefined || input.taskStats) {
    const stats: string[] = [];
    if (input.decisionCount !== undefined) stats.push(`关键决策 **${input.decisionCount}** 条`);
    if (input.taskStats) stats.push(`任务 ${input.taskStats}`);
    elements.push(md(stats.join(' · ')));
  }

  // 标签 + 归档编号
  const tagLine = input.tags.length ? input.tags.map((t) => `\`${t}\``).join(' ') : '—';
  elements.push(hr(), md(`🏷 标签：${tagLine}\n📌 归档编号：\`${input.recordId}\``));

  // 主按钮优先级：reportDocUrl（issue #114 完整报告）> bitableUrl（issue #104 表格）
  if (input.reportDocUrl) {
    elements.push(btn('查看完整报告', { action: 'open_url', url: input.reportDocUrl }, 'primary'));
    if (input.bitableUrl) {
      elements.push(btn('查看归档表格', { action: 'open_url', url: input.bitableUrl }, 'default'));
    }
  } else if (input.bitableUrl) {
    elements.push(btn('查看归档表格', { action: 'open_url', url: input.bitableUrl }, 'primary'));
  } else {
    elements.push(md('_归档详情已写入 memory，可通过 @bot 查询_'));
  }

  return card('archive', {
    schema: '2.0',
    header: { title: pt('项目已归档 🎉'), template: 'indigo' },
    body: { elements },
  });
}

// 五维 → 图标 + 中文短名（卡片头里显示，让评估维度一眼可见）
const REHEARSAL_DIM_ICON: Record<RehearsalDimensionLabel, string> = {
  内容: '📝',
  结构: '🏗',
  表达: '🎤',
  受众: '🎯',
  时间: '⏱',
  其他: '📌',
};

const REHEARSAL_DIM_ORDER: readonly RehearsalDimensionLabel[] = [
  '内容',
  '结构',
  '表达',
  '受众',
  '时间',
  '其他',
];

/**
 * 把带 dimension 的 items 按维度分组渲染。维度块之间留空行，避免挤成一团：
 *
 *   📝 **内容**
 *   - bullet 1
 *   - bullet 2
 *
 *   🏗 **结构**
 *   - bullet 1
 */
function renderDimensionedItems(items: readonly RehearsalDimensionedItem[]): string {
  const groups = new Map<RehearsalDimensionLabel, string[]>();
  for (const it of items) {
    const list = groups.get(it.dimension) ?? [];
    list.push(it.text);
    groups.set(it.dimension, list);
  }
  const blocks: string[] = [];
  for (const dim of REHEARSAL_DIM_ORDER) {
    const list = groups.get(dim);
    if (!list || list.length === 0) continue;
    const block = [`${REHEARSAL_DIM_ICON[dim]} **${dim}**`, ...list.map((t) => `- ${t}`)].join(
      '\n',
    );
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

/**
 * rehearsal — 演练复盘分析卡
 *
 * 四态：
 *   - loading：拉历史 + 跑分析中
 *   - active：列 issues / suggestions / uncertainties + 满意/继续修改 按钮
 *   - completed：用户点"满意，完成"后的终态，附产出物链接（新版 PPT / 新版文档）
 *   - error：分析失败
 *
 * 按钮 value 透传 action / chatId / round，wiring.handleCardAction 按 action 分发。
 */
function buildRehearsal(input: RehearsalCardInput): Card {
  if (input.isLoading) {
    return card('rehearsal', {
      schema: '2.0',
      header: { title: pt('演练复盘分析中…'), template: 'blue' },
      body: {
        elements: [
          md('📊 正在读取群历史与会议纪要，分析演示问题。\n\n通常需要 30-60 秒，分析完会自动替换这条卡片。'),
        ],
      },
    });
  }

  if (input.errorMessage) {
    return card('rehearsal', {
      schema: '2.0',
      header: { title: pt('演练复盘失败'), template: 'red' },
      body: {
        elements: [md(`⚠️ ${input.errorMessage}`)],
      },
    });
  }

  // 完成态：用户已确认满意 → 附产出物链接
  if (input.isCompleted) {
    const elements: BodyElement[] = [
      md(`✅ **演练复盘已完成**（共 ${input.round} 轮迭代）`),
    ];
    if (input.summary) elements.push(md(input.summary));

    if (input.newSlidesUrl || input.newDocUrl) {
      // 把产出物的人话描述跟图标放一段，按钮紧跟其后 —— 比孤立标题视觉更稳
      const outputDesc: string[] = [];
      if (input.newSlidesUrl) outputDesc.push('🎯 新版 PPT');
      if (input.newDocUrl) outputDesc.push('📄 汇报文档修订记录');
      elements.push(
        hr(),
        md(`**已更新的产出物**：${outputDesc.join(' · ')}`),
      );
      if (input.newSlidesUrl) {
        elements.push(btn('打开新版 PPT', { action: 'open_url', url: input.newSlidesUrl }, 'primary'));
      }
      if (input.newDocUrl) {
        elements.push(btn('打开汇报文档', { action: 'open_url', url: input.newDocUrl }, 'default'));
      }
    } else {
      // 无新产出物：区分"没需要改" vs "改了但重生成失败"
      elements.push(hr());
      if (input.noRegenReason === 'regenFailed') {
        elements.push(
          md(
            '_本次有改动建议但 PPT / 文档重生成未成功（可能是 LLM 或网络问题）。复盘记录已写入项目记忆，可稍后再 @bot 重新生成。_',
          ),
        );
      } else {
        elements.push(
          md(
            '_本次没有需要重新生成的 PPT 或文档；复盘记录已写入项目记忆，可在归档时回顾。_',
          ),
        );
      }
    }
    return card('rehearsal', {
      schema: '2.0',
      header: { title: pt('演练复盘已完成 🎉'), template: 'green' },
      body: { elements },
    });
  }

  // active 态：按五维分组的 issues + suggestions + uncertainties + 按钮
  const elements: BodyElement[] = [
    md(`**第 ${input.round} 轮演练复盘**`),
  ];
  if (input.summary) elements.push(md(input.summary));
  elements.push(hr());

  if (input.issues.length) {
    elements.push(md(`**🔴 存在的问题**\n${renderDimensionedItems(input.issues)}`));
  }
  if (input.suggestions.length) {
    elements.push(hr(), md(`**💡 修改建议**\n${renderDimensionedItems(input.suggestions)}`));
  }
  if (input.uncertainties.length) {
    elements.push(
      hr(),
      md(`**❓ 待确认（信心不足，需要你的判断）**\n${input.uncertainties.map((u) => `- ${u}`).join('\n')}`),
    );
  }
  // 三段都为空时给一个中性提示 —— 注意不要说"表现良好"（false reassurance：群聊
  // 没真反馈不等于演示真的没问题）。让用户决定是补反馈还是直接结束。
  if (!input.issues.length && !input.suggestions.length && !input.uncertainties.length) {
    elements.push(
      md('暂未在群聊中识别到具体反馈。可以在群里补充演练中的问题，或直接点"满意，完成"结束本次复盘。'),
    );
  }

  // 按钮：value 透传 action / round / chatId，cardAction handler 依此分发
  const baseValue = {
    chatId: input.chatId ?? '',
    round: input.round,
  };
  elements.push(
    hr(),
    btn('满意，完成', { ...baseValue, action: 'rehearsal.satisfied' }, 'primary'),
    btn('继续修改', { ...baseValue, action: 'rehearsal.iterate' }, 'default'),
  );

  return card('rehearsal', {
    schema: '2.0',
    header: { title: pt('演练复盘分析结果'), template: 'blue' },
    body: { elements },
  });
}

/**
 * rehearsalClarify — 演练反问澄清卡
 *
 * 三态：
 *   - active：列 1-3 个具体反问问题，提示用户在群里直接文字回复
 *   - acknowledged：用户已回复，patch 成"已收到反馈，重新分析中…"
 *   - error：反问构造失败
 */
function buildRehearsalClarify(input: RehearsalClarifyCardInput): Card {
  if (input.errorMessage) {
    return card('rehearsalClarify', {
      schema: '2.0',
      header: { title: pt('反问构造失败'), template: 'red' },
      body: { elements: [md(`⚠️ ${input.errorMessage}`)] },
    });
  }

  if (input.acknowledgedAt) {
    const time = formatTime(input.acknowledgedAt);
    return card('rehearsalClarify', {
      schema: '2.0',
      header: { title: pt('已收到反馈'), template: 'turquoise' },
      body: {
        elements: [
          md(`✅ ${time} 已收到反馈，正在重新分析…\n\n下一轮分析卡马上发到群里。`),
        ],
      },
    });
  }

  const lines = input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return card('rehearsalClarify', {
    schema: '2.0',
    header: { title: pt(`第 ${input.round} 轮反问 · 请在群里回复`), template: 'wathet' },
    body: {
      elements: [
        md('为了让分析更准，先请你回答下面的问题（直接在群里发消息即可，不需要点按钮）：'),
        md(lines),
        md('_回答完后我会重新跑一轮分析；如果你想结束本轮，发"满意 / 完成 / OK"。_'),
      ],
    },
  });
}

// ─── rehearsal v2 (issue #145) ────────────────────────────────────────────

const CRITIQUE_CATEGORY_ICON: Record<RehearsalCritiqueCategory, string> = {
  audience: '🎯',
  content: '📝',
  consistency: '⚖️',
};

const CRITIQUE_CATEGORY_LABEL: Record<RehearsalCritiqueCategory, string> = {
  audience: '听众',
  content: '内容',
  consistency: '一致性',
};

/**
 * rehearsalPreview — AI 听众预演分页讲稿卡（issue #145 P1）
 *
 * 每页 PPT 一段：标题 → 三段式讲稿（hook/core/transition） → AI 听众点评 → 反馈按钮。
 * 反馈按钮 value 透传 chatId / page，wiring.handleCardAction 路由到 rehearsal skill。
 */
function buildRehearsalPreview(input: RehearsalPreviewCardInput): Card {
  if (input.errorMessage) {
    return card('rehearsalPreview', {
      schema: '2.0',
      header: { title: pt('AI 听众预演失败'), template: 'red' },
      body: { elements: [md(`⚠️ ${input.errorMessage}`)] },
    });
  }

  const styleLabel = input.style === 'roadshow' ? '路演' : '评委答辩';
  const elements: BodyElement[] = [
    md(
      `🎤 **AI 听众预演**（共 ${input.totalPages} 页 · 风格：${styleLabel}）\n\n` +
        '每页有讲稿 + 三类点评（听众 / 内容 / 一致性）。看完直接给意见，不需要凑齐开会。',
    ),
  ];

  for (const page of input.pages) {
    elements.push(
      hr(),
      md(`**第 ${page.page} 页 / ${input.totalPages}** — ${page.pageTitle}`),
      md(
        [
          `**🎙️ 讲稿**`,
          `钩子：${page.hook}`,
          `核心：${page.core}`,
          `过渡：${page.transition}`,
        ].join('\n'),
      ),
    );

    if (page.critiques.length === 0) {
      elements.push(md('_👂 AI 听众：本页未发现明显问题。_'));
    } else {
      const critiqueLines = page.critiques.map((c) => {
        const icon = CRITIQUE_CATEGORY_ICON[c.category];
        const label = CRITIQUE_CATEGORY_LABEL[c.category];
        const unsureMark = c.attribution === 'unsure' ? ' ⚠️来源待确认' : '';
        return `- ${icon} **[${label}]**${unsureMark} ${c.text}`;
      });
      elements.push(md(`**👂 AI 听众点评**\n${critiqueLines.join('\n')}`));
    }

    const baseValue = { chatId: input.chatId, page: page.page };
    elements.push(
      btn(
        '👍 同意 AI',
        { ...baseValue, action: 'rehearsal.preview.agree' },
        'default',
      ),
      btn(
        '✍️ 我有不同意见',
        { ...baseValue, action: 'rehearsal.preview.disagree' },
        'primary',
      ),
    );
  }

  elements.push(
    hr(),
    btn(
      '开始排练（基于反馈跑第一轮分析）',
      { chatId: input.chatId, action: 'rehearsal.preview.startAnalyze' },
      'primary',
    ),
    md('_累计 ≥ 3 页反馈会自动进入分析。如要直接结束，群里发"满意 / 完成"即可。_'),
  );

  return card('rehearsalPreview', {
    schema: '2.0',
    header: { title: pt('AI 听众预演（rehearsal v2）'), template: 'wathet' },
    body: { elements },
  });
}

const REVIEW_SOURCE_ICON: Record<RehearsalReviewChange['source'], string> = {
  user: '🟢',
  listener: '🟦',
  unsure: '⚠️',
};

const REVIEW_SOURCE_LABEL: Record<RehearsalReviewChange['source'], string> = {
  user: '来自用户主动反馈',
  listener: 'AI 听众建议（默认不勾）',
  unsure: '来源待确认（attribution unsure）',
};

const REVIEW_SOURCE_ORDER: readonly RehearsalReviewChange['source'][] = [
  'user',
  'listener',
  'unsure',
];

/**
 * rehearsalReview — finalize 之前的累积改动决策透明化卡（issue #145 P2）
 *
 * 三组 changes（user / listener / unsure）按 source 分组。每条带 [✓ 包含] / [○ 跳过] 按钮，
 * 用户主动决定每一条。点 [全部确认执行] → finalize 仅按勾选子集跑 regenerate。
 */
function buildRehearsalReview(input: RehearsalReviewCardInput): Card {
  if (input.errorMessage) {
    return card('rehearsalReview', {
      schema: '2.0',
      header: { title: pt('Review 卡构造失败'), template: 'red' },
      body: { elements: [md(`⚠️ ${input.errorMessage}`)] },
    });
  }

  if (input.resolution) {
    const time = input.resolvedAt ? formatTime(input.resolvedAt) : '';
    const lookup: Record<NonNullable<RehearsalReviewCardInput['resolution']>, string> = {
      confirmed: `✅ ${time} 已按勾选子集开始重生成 PPT / 文档。`,
      cancelled: `↩️ ${time} 已取消，回到反问澄清继续修改。`,
      editing: `✏️ ${time} 进入编辑模式，可在群里追加/删除指定条。`,
    };
    return card('rehearsalReview', {
      schema: '2.0',
      header: { title: pt('Review 已处理'), template: 'turquoise' },
      body: { elements: [md(lookup[input.resolution])] },
    });
  }

  const elements: BodyElement[] = [
    md(
      `📋 **第 ${input.round} 轮 review** — 即将应用的累积改动共 **${input.changes.length}** 条\n\n` +
        '逐条决定要不要执行；user 默认勾选，listener / unsure 默认不勾。',
    ),
  ];

  if (input.overLimitHint) {
    elements.push(
      hr(),
      md(
        '⚠️ **改动条数偏多（> 30）**，请精简：在群里补一句"只保留 X / Y / Z 几条"或直接逐条取消勾选，' +
          '避免重生成时 LLM 顾此失彼。（不会再静默截断旧条目。）',
      ),
    );
  }

  // 按 source 分三组渲染。每条 change 一行 + 一对 [包含 / 跳过] callback 按钮（用户勾选）。
  const grouped = new Map<RehearsalReviewChange['source'], RehearsalReviewChange[]>();
  for (const c of input.changes) {
    const list = grouped.get(c.source) ?? [];
    list.push(c);
    grouped.set(c.source, list);
  }

  for (const source of REVIEW_SOURCE_ORDER) {
    const list = grouped.get(source);
    if (!list || list.length === 0) continue;
    elements.push(
      hr(),
      md(`${REVIEW_SOURCE_ICON[source]} **${REVIEW_SOURCE_LABEL[source]}（${list.length} 条）**`),
    );
    for (const c of list) {
      const targetTag = c.target === 'slides' ? '🎯 PPT' : '📄 doc';
      const checked = c.defaultChecked ? '☑' : '☐';
      elements.push(md(`${checked} **${targetTag}** ${c.text}`));
      const baseValue = { chatId: input.chatId, changeId: c.id };
      elements.push(
        btn('✓ 包含', { ...baseValue, action: 'rehearsal.review.toggle', checked: true }, 'default'),
        btn('○ 跳过', { ...baseValue, action: 'rehearsal.review.toggle', checked: false }, 'default'),
      );
    }
  }

  elements.push(
    hr(),
    btn(
      '✅ 全部确认执行（按当前勾选）',
      { chatId: input.chatId, action: 'rehearsal.review.confirm' },
      'primary',
    ),
    btn(
      '✏️ 我再改改',
      { chatId: input.chatId, action: 'rehearsal.review.editList' },
      'default',
    ),
    btn(
      '❌ 全部取消',
      { chatId: input.chatId, action: 'rehearsal.review.cancel' },
      'danger',
    ),
  );

  return card('rehearsalReview', {
    schema: '2.0',
    header: { title: pt(`第 ${input.round} 轮 review · 决策透明化`), template: 'blue' },
    body: { elements },
  });
}

// ─── 附属链路卡片 ─────────────────────────────────────────────────────────────

/**
 * offlineSummary — 用户重连后推送
 * 目的：50+ 消息不用翻，关键事项按重要性排好了
 * UI：离线时段 + 重要事项列表，轻量不打扰
 */
function buildOfflineSummary(input: OfflineSummaryCardInput): Card {
  const from = new Date(input.offlineFrom).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const to = new Date(input.offlineTo).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const highlights = input.highlights
    .slice(0, 5)
    .map((h, i) => `${i + 1}. ${h}`)
    .join('\n');
  return card('offlineSummary', {
    schema: '2.0',
    header: { title: pt('你离开期间发生了这些'), template: 'grey' },
    body: {
      elements: [
        md(`🕐 ${from} — ${to} · 共 ${input.messageCount} 条新消息`),
        hr(),
        md(`**关键事项**\n${highlights}`),
      ],
    },
  });
}

/**
 * docChange — 重要文档变更通知
 * 目的：核心需求改了，让所有人第一时间知道，不用自己去翻文档
 * UI：谁改了什么 + 影响哪些任务，一键看原文
 */
function buildDocChange(input: DocChangeCardInput): Card {
  const affectedLine = input.affectedTasks?.length
    ? `\n\n**影响任务**\n${input.affectedTasks.map((t) => `- ${t}`).join('\n')}`
    : '';
  return card('docChange', {
    schema: '2.0',
    header: { title: pt('文档已更新'), template: 'carmine' },
    body: {
      elements: [
        md(
          `**${input.editorName}** 更新了 **${input.docTitle}**\n\n${input.changeSummary}${affectedLine}`,
        ),
        hr(),
        btn('查看文档', { action: 'open_url', url: input.docUrl }, 'primary'),
      ],
    },
  });
}

/**
 * weekly — 周报
 * 目的：每周自动沉淀，不用人工整理，方便向上同步
 * UI：亮点 / 决策 / 待办 / 指标四段，结构清晰
 */
function buildWeekly(input: WeeklyCardInput): Card {
  const elements: BodyElement[] = [md(`**周报：${input.weekRange}**`), hr()];
  if (input.highlights.length)
    elements.push(md(`**🌟 本周亮点**\n${input.highlights.map((h) => `- ${h}`).join('\n')}`));
  if (input.decisions.length)
    elements.push(hr(), md(`**✅ 本周决策**\n${input.decisions.map((d) => `- ${d}`).join('\n')}`));
  if (input.todos.length)
    elements.push(hr(), md(`**🔲 下周待办**\n${input.todos.map((t) => `- ${t}`).join('\n')}`));
  if (input.metrics && Object.keys(input.metrics).length) {
    const metricLines = Object.entries(input.metrics)
      .map(([k, v]) => `- ${k}：${v}`)
      .join('\n');
    elements.push(hr(), md(`**📊 关键指标**\n${metricLines}`));
  }
  return card('weekly', {
    schema: '2.0',
    header: { title: pt('周报'), template: 'purple' },
    body: { elements },
  });
}

// ── 保留但不在主路径上（Skill 内部备用） ─────────────────────────────────────

function buildRecall(input: RecallCardInput): Card {
  const elements: BodyElement[] = [
    md(`**触发语句**\n"${input.trigger}"`),
    hr(),
    md(`**历史信息摘要**\n${input.summary}`),
  ];
  const sourceText = renderSources(input.sources);
  if (sourceText) elements.push(hr(), md(sourceText));
  elements.push(btn('这条不相关', { action: 'dismiss', trigger: input.trigger }, 'danger'));
  if (input.buttons) elements.push(...renderButtons(input.buttons));
  return card('recall', {
    schema: '2.0',
    header: { title: pt('历史信息召回'), template: 'wathet' },
    body: { elements },
  });
}

// ─── CardBuilder 实现 ─────────────────────────────────────────────────────────

const builders: { [K in CardTemplateName]: (input: CardInputMap[K]) => Card } = {
  activation: buildActivation,
  docPush: buildDocPush,
  tablePush: buildTablePush,
  qa: buildQa,
  summary: buildSummary,
  slides: buildSlides,
  archive: buildArchive,
  rehearsal: buildRehearsal,
  rehearsalClarify: buildRehearsalClarify,
  rehearsalPreview: buildRehearsalPreview,
  rehearsalReview: buildRehearsalReview,
  offlineSummary: buildOfflineSummary,
  docChange: buildDocChange,
  weekly: buildWeekly,
  recall: buildRecall,
};

export const larkCardBuilder: CardBuilder = {
  build<K extends CardTemplateName>(template: K, input: CardInputMap[K]): Card {
    const fn = builders[template] as (input: CardInputMap[K]) => Card;
    return fn(input);
  },
};
