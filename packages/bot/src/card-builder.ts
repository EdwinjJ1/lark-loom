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
  const memberLine = input.members.map((m) => `@${m}`).join('  ');
  const dueLine = input.nearestDue ? `\n⏰ 最近截止：**${input.nearestDue}**` : '';
  return card('tablePush', {
    schema: '2.0',
    header: { title: pt('分工表已生成'), template: 'yellow' },
    body: {
      elements: [
        md(`**${input.tableTitle}**\n共 ${input.taskCount} 个任务 · 成员：${memberLine}${dueLine}`),
        hr(),
        btn('查看分工表', { action: 'open_url', url: input.bitableUrl }, 'primary'),
        md('_仅群内成员可查看与编辑_'),
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
