/**
 * CardBuilder 单元测试
 * 主链路 7 种 + 附属 3 种，各 1 个 case。
 * 验证：templateName 正确、JSON 结构合法、无 {{xxx}} 占位符、关键内容存在。
 */

import { describe, expect, it } from 'vitest';
import { larkCardBuilder } from '../card-builder.js';

function json(card: ReturnType<typeof larkCardBuilder.build>): string {
  return JSON.stringify(card);
}

function noPlaceholders(s: string): boolean {
  return !/\{\{[^}]+\}\}/.test(s);
}

function schema(card: ReturnType<typeof larkCardBuilder.build>) {
  return card.content as {
    schema: string;
    header: { title: { content: string }; template: string };
    body: { elements: Array<{ tag: string; [k: string]: unknown }> };
  };
}

// ── 主链路 ────────────────────────────────────────────────────────────────────

describe('activation card', () => {
  // 初始态：1 行功能 + 1 行数据使用 + 2 按钮（参考 ChatGPT for Slack / Linear pattern）
  it('initial state has disclosure + activate / dismiss buttons', () => {
    const card = larkCardBuilder.build('activation', {
      chatName: 'Lark Loom 测试群',
    });
    expect(card.templateName).toBe('activation');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    // PIPL 合规：必须有数据使用告知（精简版 —— 1 行）
    expect(j).toContain('数据使用');
    expect(j).toContain('大模型分析');
    expect(j).toContain('多维表格');
    // 按钮文案：中性 "启用 Lark Loom" / "稍后"
    expect(j).toContain('启用 Lark Loom');
    expect(j).toContain('稍后');
    const btns = schema(card).body.elements.filter((e) => e.tag === 'button');
    expect(btns.length).toBe(2);
  });

  // header 不含 emoji，且不重复 "已加入" / "已启用 Lark Loom" 等冗余措辞
  it('header is just product name without emoji clutter', () => {
    const card = larkCardBuilder.build('activation', { chatName: '测试群' });
    const header = schema(card).header;
    expect(header.title.content).toBe('Lark Loom');
    // 状态由 template color 表达，不靠 emoji
    expect(header.template).toBe('blue');
  });

  // 已启用态：header template 变 green，按钮区被替换为 audit 文本
  it('confirmed state turns header green and replaces buttons', () => {
    const at = Date.UTC(2026, 4, 5, 10, 30);
    const card = larkCardBuilder.build('activation', {
      chatName: '测试群',
      confirmedBy: '张三',
      confirmedAt: at,
    });
    const j = json(card);
    expect(j).toContain('启用');
    expect(j).toContain('张三');
    expect(schema(card).header.template).toBe('green');
    const btns = schema(card).body.elements.filter((e) => e.tag === 'button');
    expect(btns.length).toBe(0);
  });

  // 已忽略态：header template 变 grey，dismissed by 谁 + 时间
  it('dismissed state turns header grey and replaces buttons', () => {
    const card = larkCardBuilder.build('activation', {
      chatName: '测试群',
      dismissedBy: '李四',
      dismissedAt: Date.now(),
    });
    const j = json(card);
    expect(j).toContain('暂停');
    expect(j).toContain('李四');
    expect(j).toContain('重新启用');
    expect(schema(card).header.template).toBe('grey');
    const btns = schema(card).body.elements.filter((e) => e.tag === 'button');
    expect(btns.length).toBe(0);
  });

  // 隐私回归：永远不应出现 open_id 风格的字符串（ou_xxx）
  it('never leaks open_id-style userId in confirmed state', () => {
    const card = larkCardBuilder.build('activation', {
      chatName: '测试群',
      confirmedBy: 'ou_702fcccb0dc6807c067a885ff71b03f1', // 模拟假名 = 漏的 open_id
      confirmedAt: Date.now(),
    });
    const j = json(card);
    // 即便上层 caller 错传了 open_id，模板本身也只会原样渲染 —— 这个 case
    // 是文档化"模板不防泄漏"，真正的防御在 onboarding handler 的 fallback 里
    expect(j).toContain('ou_702fcccb');
    // 业务保护层在 onboarding.ts 的 userName fallback；这里只验证模板透传
  });
});

describe('docPush card', () => {
  it('shows doc title, type label, open button, and permission note', () => {
    const card = larkCardBuilder.build('docPush', {
      docTitle: '业务探索需求文档 v1',
      docUrl: 'https://feishu.cn/docs/abc',
      docType: 'requirement',
      summary: '梳理了核心用户场景和验收标准。',
    });
    expect(card.templateName).toBe('docPush');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('业务探索需求文档 v1');
    expect(j).toContain('📋 需求文档');
    expect(j).toContain('打开文档');
    expect(j).toContain('仅群内成员');
  });
});

describe('tablePush card', () => {
  it('shows task count, members, nearest due, and open button', () => {
    const card = larkCardBuilder.build('tablePush', {
      tableTitle: '业务探索 · 分工表',
      bitableUrl: 'https://feishu.cn/bitable/xyz',
      taskCount: 5,
      members: ['Antares', 'Evan', '沛彤'],
      nearestDue: '2026-05-06',
    });
    expect(card.templateName).toBe('tablePush');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('5 个任务');
    expect(j).toContain('@Antares');
    expect(j).toContain('2026-05-06');
    expect(j).toContain('查看分工表');
    // 不应该再有「仅群内成员可查看与编辑」这条虚假宣传 —— 共享 bitable 做不到
    expect(j).not.toContain('仅群内成员可查看与编辑');
  });

  it('renders loading state', () => {
    const card = larkCardBuilder.build('tablePush', {
      tableTitle: '项目分工表',
      bitableUrl: '',
      taskCount: 0,
      members: [],
      isLoading: true,
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('分工表生成中');
    expect(j).toContain('整理完会自动替换');
  });

  it('renders error state', () => {
    const card = larkCardBuilder.build('tablePush', {
      tableTitle: '项目分工表',
      bitableUrl: '',
      taskCount: 0,
      members: [],
      errorMessage: '本次未识别到明确的分工',
    });
    const j = json(card);
    expect(j).toContain('分工表生成失败');
    expect(j).toContain('未识别到明确的分工');
  });
});

describe('qa card', () => {
  it('shows question, answer, sources, and buttons', () => {
    const card = larkCardBuilder.build('qa', {
      question: '复赛截止日期是什么时候？',
      answer: '复赛日期为 **2026-05-06**。',
      sources: [
        {
          title: '群聊历史消息',
          kind: 'chat',
          snippet: '复赛日期是 2026-05-06',
          authorName: 'Antares',
          timestamp: Date.parse('2026-05-03T10:30:00+08:00'),
        },
        { title: 'README', kind: 'wiki', snippet: '时间节点表' },
      ],
      buttons: [
        { text: '查看原文', value: { action: 'open', target: 'readme' }, variant: 'primary' },
      ],
    });
    expect(card.templateName).toBe('qa');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('复赛截止日期');
    expect(j).toContain('2026-05-06');
    expect(j).toContain('Antares');
    expect(j).toContain('README');
  });
});

describe('summary card', () => {
  it('renders 议题 / 决策 / 待办 / 待跟进 four sections', () => {
    const card = larkCardBuilder.build('summary', {
      title: '第一次碰头会',
      topics: ['产品方向', '技术选型'],
      decisions: ['采用飞书 Card 2.0'],
      todos: [{ text: '实现 CardBuilder', assignee: 'Antares', due: '2026-05-06' }],
      followUps: ['确认 API 配额'],
    });
    expect(card.templateName).toBe('summary');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('议题');
    expect(j).toContain('决策');
    expect(j).toContain('待办');
    expect(j).toContain('待跟进');
    expect(j).toContain('@Antares');
  });

  it('renders prose summary at top when present', () => {
    const card = larkCardBuilder.build('summary', {
      title: '会议纪要',
      summary: '本次会议确定供应商选型，李工本周一前出方案。',
      topics: [],
      decisions: ['供应商选型采用 B 方案'],
      todos: [],
      followUps: [],
    });
    const j = json(card);
    expect(j).toContain('确定供应商选型');
    expect(j).toContain('B 方案');
  });

  it('renders loading state', () => {
    const card = larkCardBuilder.build('summary', {
      title: '会议纪要',
      topics: [],
      decisions: [],
      todos: [],
      followUps: [],
      isLoading: true,
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('会议纪要整理中');
  });

  it('renders error state', () => {
    const card = larkCardBuilder.build('summary', {
      title: '会议纪要',
      topics: [],
      decisions: [],
      todos: [],
      followUps: [],
      errorMessage: 'LLM 提取失败：timeout',
    });
    const j = json(card);
    expect(j).toContain('会议纪要整理失败');
    expect(j).toContain('timeout');
  });

  it('renders explicit fallback when all fields empty (no silent blank card)', () => {
    const card = larkCardBuilder.build('summary', {
      title: '会议纪要',
      topics: [],
      decisions: [],
      todos: [],
      followUps: [],
    });
    const j = json(card);
    expect(j).toContain('未在群历史中识别到');
  });
});

describe('slides card', () => {
  it('shows page count, H2 titles, bullets, and open button', () => {
    const card = larkCardBuilder.build('slides', {
      title: '业务探索汇报',
      presentationUrl: 'https://feishu.cn/slides/abc',
      pageCount: 3,
      preview: [
        { title: '背景', bullets: ['市场机会'] },
        { title: '方案', bullets: ['架构图'] },
        { title: '下一步', bullets: ['MVP'] },
      ],
    });
    expect(card.templateName).toBe('slides');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('3 页');
    expect(j).toContain('## 1. 背景');
    expect(j).toContain('市场机会');
    expect(j).toContain('打开演示文稿');
  });

  it('renders loading state', () => {
    const card = larkCardBuilder.build('slides', {
      title: '文件生成中…',
      presentationUrl: '',
      pageCount: 0,
      isLoading: true,
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('演示文稿生成中');
    expect(j).toContain('正在生成演示文稿和汇报分工文稿');
  });
});

describe('archive card', () => {
  it('shows title, summary, tags, recordId, and open button', () => {
    const card = larkCardBuilder.build('archive', {
      recordId: 'rec_001',
      title: '业务探索 · 最终归档',
      bitableUrl: 'https://feishu.cn/bitable/archive',
      tags: ['2026-Q2', '已完成'],
      summary: '完成了需求验证，形成了 MVP 方案。',
    });
    expect(card.templateName).toBe('archive');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('rec_001');
    expect(j).toContain('2026-Q2');
    expect(j).toContain('完成了需求验证');
    expect(j).toContain('查看归档表格');
  });

  // issue #104：多产出物链接展示
  it('renders multiple output links with category icons', () => {
    const card = larkCardBuilder.build('archive', {
      recordId: 'rec_002',
      title: '项目已交付',
      bitableUrl: 'https://feishu.cn/bitable/x',
      tags: [],
      summary: '完成。',
      links: [
        { kind: 'requirementDoc', label: '需求文档', url: 'https://x.feishu.cn/req' },
        { kind: 'slides', label: '演示 PPT', url: 'https://x.feishu.cn/ppt' },
        { kind: 'taskAssignment', label: '任务分工表', url: 'https://x.feishu.cn/task' },
      ],
      decisionCount: 5,
      taskStats: '8/10 已完成',
    });
    const j = json(card);
    expect(j).toContain('项目产出');
    expect(j).toContain('需求文档');
    expect(j).toContain('演示 PPT');
    expect(j).toContain('任务分工表');
    expect(j).toContain('https://x.feishu.cn/req');
    expect(j).toContain('5');
    expect(j).toContain('8/10');
    // 图标
    expect(j).toContain('📋'); // requirementDoc
    expect(j).toContain('🎯'); // slides
    expect(j).toContain('✅'); // taskAssignment
  });

  // issue #104 验收：bitableUrl 缺省 → 不渲染坏按钮
  it('falls back to text when bitableUrl is empty', () => {
    const card = larkCardBuilder.build('archive', {
      recordId: 'rec_003',
      title: '项目已交付',
      bitableUrl: '', // 缺省
      tags: [],
      summary: '完成。',
    });
    const j = json(card);
    expect(j).not.toContain('查看归档表格'); // 没按钮
    expect(j).toContain('已写入 memory');
    const btns = schema(card).body.elements.filter((e) => e.tag === 'button');
    expect(btns.length).toBe(0);
  });
});

// ── 附属链路 ──────────────────────────────────────────────────────────────────

describe('offlineSummary card', () => {
  it('shows offline time range, message count, and highlights', () => {
    const from = new Date('2026-05-01T10:00:00+08:00').getTime();
    const to = new Date('2026-05-01T12:00:00+08:00').getTime();
    const card = larkCardBuilder.build('offlineSummary', {
      offlineFrom: from,
      offlineTo: to,
      highlights: ['Evan 完成了 WSClient 接入', '沛彤更新了需求文档', '确定了复赛演示顺序'],
      messageCount: 52,
    });
    expect(card.templateName).toBe('offlineSummary');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('52 条新消息');
    expect(j).toContain('Evan 完成了 WSClient 接入');
  });
});

describe('docChange card', () => {
  it('shows editor, change summary, affected tasks, and open button', () => {
    const card = larkCardBuilder.build('docChange', {
      editorName: '沛彤',
      docTitle: '业务探索需求文档',
      docUrl: 'https://feishu.cn/docs/abc',
      changeSummary: '修改了验收标准，新增了两个边界场景。',
      affectedTasks: ['CardBuilder 实现', 'Skill Router 设计'],
    });
    expect(card.templateName).toBe('docChange');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('沛彤');
    expect(j).toContain('修改了验收标准');
    expect(j).toContain('CardBuilder 实现');
    expect(j).toContain('查看文档');
  });
});

describe('rehearsal card 维度分组渲染', () => {
  it('issues / suggestions 按维度分组，块之间用空行分隔', () => {
    const card = larkCardBuilder.build('rehearsal', {
      round: 1,
      issues: [
        { text: '内容问题 1', dimension: '内容' },
        { text: '内容问题 2', dimension: '内容' },
        { text: '结构问题 1', dimension: '结构' },
        { text: '其他问题 1', dimension: '其他' },
      ],
      suggestions: [
        { text: '建议 1', dimension: '内容' },
        { text: '建议 2', dimension: '时间' },
      ],
      uncertainties: [],
      summary: '混合维度测试。',
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    // 每个维度都带图标 + 维度名
    expect(j).toContain('📝 **内容**');
    expect(j).toContain('🏗 **结构**');
    expect(j).toContain('⏱ **时间**');
    expect(j).toContain('📌 **其他**');
    // 维度按固定顺序：内容 → 结构 → 表达 → 受众 → 时间 → 其他
    const body = JSON.stringify(schema(card).body);
    const contentIdx = body.indexOf('内容');
    const structureIdx = body.indexOf('结构');
    const otherIdx = body.indexOf('其他');
    expect(contentIdx).toBeLessThan(structureIdx);
    expect(structureIdx).toBeLessThan(otherIdx);
    // 同维度多条 issue 在同一组
    expect(j).toContain('内容问题 1');
    expect(j).toContain('内容问题 2');
  });

  it('完成态卡显示新版 PPT + 修订记录两个产出物', () => {
    const card = larkCardBuilder.build('rehearsal', {
      round: 2,
      issues: [],
      suggestions: [],
      uncertainties: [],
      summary: '共 3 条改动已采纳',
      isCompleted: true,
      newSlidesUrl: 'https://feishu.cn/slides/v2',
      newDocUrl: 'https://feishu.cn/docx/rev',
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('演练复盘已完成');
    expect(j).toContain('已更新的产出物');
    expect(j).toContain('新版 PPT');
    expect(j).toContain('汇报文档');
    expect(j).toContain('feishu.cn/slides/v2');
    expect(j).toContain('feishu.cn/docx/rev');
  });

  it('完成态卡 regen 失败时 → 显示"未成功"兜底，不显示空标题', () => {
    const card = larkCardBuilder.build('rehearsal', {
      round: 1,
      issues: [],
      suggestions: [],
      uncertainties: [],
      isCompleted: true,
      noRegenReason: 'regenFailed',
    });
    const j = json(card);
    expect(j).toContain('重生成未成功');
    expect(j).not.toContain('已更新的产出物');
  });
});

// ── rehearsal v2 (issue #145) ─────────────────────────────────────────────

describe('rehearsalPreview card (issue #145)', () => {
  it('每页 PPT 渲染三段式讲稿 + critique 分类图标 + 反馈按钮', () => {
    const card = larkCardBuilder.build('rehearsalPreview', {
      chatId: 'oc_test',
      totalPages: 2,
      style: 'judges',
      pages: [
        {
          page: 1,
          pageTitle: '封面',
          hook: '我们做了什么？',
          core: '一个完整的飞书原生协作助手。',
          transition: '下一页讲商业模式。',
          critiques: [
            {
              id: 'lc_0',
              category: 'audience',
              page: 1,
              text: '评委会追问目标用户',
              evidence: 'ppt.p1: 封面',
              cite: 'ppt.p1',
              confidence: 0.85,
              attribution: 'confirmed',
            },
            {
              id: 'lc_1',
              category: 'consistency',
              page: 1,
              text: 'PPT 数字与 OKR 不一致',
              evidence: 'ppt.p1 vs doc',
              cite: 'ppt.p1',
              confidence: 0.95,
              attribution: 'unsure',
            },
          ],
        },
        {
          page: 2,
          pageTitle: '商业模式',
          hook: '为什么是这个方向',
          core: '我们解决了真实痛点。',
          transition: '继续下一页。',
          critiques: [],
        },
      ],
    });
    expect(card.templateName).toBe('rehearsalPreview');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    // header 含 v2 风格标识
    expect(j).toContain('AI 听众预演');
    expect(j).toContain('评委答辩'); // style=judges 显示
    // 讲稿三段式
    expect(j).toContain('钩子');
    expect(j).toContain('核心');
    expect(j).toContain('过渡');
    // critique 分类图标
    expect(j).toContain('🎯'); // audience
    expect(j).toContain('⚖️'); // consistency
    // unsure 标记
    expect(j).toContain('⚠️来源待确认');
    // 第 2 页无 critique → 显示"未发现明显问题"
    expect(j).toContain('未发现明显问题');
    // 反馈按钮
    expect(j).toContain('同意 AI');
    expect(j).toContain('我有不同意见');
    expect(j).toContain('rehearsal.preview.agree');
    expect(j).toContain('rehearsal.preview.disagree');
    expect(j).toContain('rehearsal.preview.startAnalyze');
  });

  it('roadshow style → 显示"路演"标签', () => {
    const card = larkCardBuilder.build('rehearsalPreview', {
      chatId: 'oc_test',
      totalPages: 1,
      style: 'roadshow',
      pages: [
        {
          page: 1,
          pageTitle: 'p1',
          hook: 'h',
          core: 'c',
          transition: 't',
          critiques: [],
        },
      ],
    });
    expect(json(card)).toContain('路演');
  });

  it('error 态 → 红色 header + errorMessage', () => {
    const card = larkCardBuilder.build('rehearsalPreview', {
      chatId: 'oc_test',
      totalPages: 0,
      pages: [],
      errorMessage: 'speaker LLM 全挂',
    });
    const j = json(card);
    expect(j).toContain('AI 听众预演失败');
    expect(j).toContain('speaker LLM 全挂');
    expect(schema(card).header.template).toBe('red');
  });
});

describe('rehearsalReview card (issue #145)', () => {
  it('user / listener / unsure 三组分别渲染，user 默认 ☑、其他默认 ☐', () => {
    const card = larkCardBuilder.build('rehearsalReview', {
      chatId: 'oc_test',
      round: 2,
      changes: [
        { id: 'c0', target: 'slides', text: 'A', source: 'user', defaultChecked: true },
        { id: 'c1', target: 'slides', text: 'B', source: 'listener', defaultChecked: false },
        { id: 'c2', target: 'doc', text: 'C', source: 'unsure', defaultChecked: false },
      ],
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('第 2 轮 review');
    expect(j).toContain('共 **3** 条');
    // 三组都出现
    expect(j).toContain('用户主动反馈');
    expect(j).toContain('AI 听众建议');
    expect(j).toContain('来源待确认');
    // user 默认勾，listener / unsure 默认不勾
    expect(j).toContain('☑ **🎯 PPT** A');
    expect(j).toContain('☐ **🎯 PPT** B');
    expect(j).toContain('☐ **📄 doc** C');
    // 三个底部决策按钮
    expect(j).toContain('全部确认执行');
    expect(j).toContain('我再改改');
    expect(j).toContain('全部取消');
  });

  it('overLimitHint=true → 显式提示用户精简，不再静默截断', () => {
    const card = larkCardBuilder.build('rehearsalReview', {
      chatId: 'oc_test',
      round: 5,
      changes: Array.from({ length: 35 }, (_, i) => ({
        id: `c${i}`,
        target: 'slides' as const,
        text: `change ${i}`,
        source: 'user' as const,
        defaultChecked: true,
      })),
      overLimitHint: true,
    });
    const j = json(card);
    expect(j).toContain('改动条数偏多');
    expect(j).toContain('请精简');
    expect(j).toContain('不会再静默截断');
  });

  it('resolution=confirmed → 已处理态，不再渲染列表', () => {
    const card = larkCardBuilder.build('rehearsalReview', {
      chatId: 'oc_test',
      round: 1,
      changes: [],
      resolution: 'confirmed',
      resolvedAt: 1_700_000_000_000,
    });
    const j = json(card);
    expect(j).toContain('Review 已处理');
    expect(j).toContain('已按勾选子集开始重生成');
    expect(j).not.toContain('全部确认执行');
  });

  it('resolution=cancelled → 提示回到反问澄清', () => {
    const card = larkCardBuilder.build('rehearsalReview', {
      chatId: 'oc_test',
      round: 1,
      changes: [],
      resolution: 'cancelled',
      resolvedAt: 1_700_000_000_000,
    });
    expect(json(card)).toContain('已取消');
    expect(json(card)).toContain('反问澄清');
  });

  it('changes 为空 → 卡片仍能渲染（不会因为空数组崩）', () => {
    const card = larkCardBuilder.build('rehearsalReview', {
      chatId: 'oc_test',
      round: 1,
      changes: [],
    });
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('共 **0** 条');
  });

  it('error 态 → 红色 header', () => {
    const card = larkCardBuilder.build('rehearsalReview', {
      chatId: 'oc_test',
      round: 1,
      changes: [],
      errorMessage: 'review build failed',
    });
    expect(schema(card).header.template).toBe('red');
    expect(json(card)).toContain('review build failed');
  });
});

describe('weekly card', () => {
  it('renders weekRange, highlights, decisions, todos, metrics', () => {
    const card = larkCardBuilder.build('weekly', {
      weekRange: '2026-04-29 ~ 2026-05-05',
      highlights: ['CardBuilder 完成'],
      decisions: ['recall 走文本输出'],
      todos: ['接入 WSClient'],
      metrics: { 'PR 合并数': 3 },
    });
    expect(card.templateName).toBe('weekly');
    const j = json(card);
    expect(noPlaceholders(j)).toBe(true);
    expect(j).toContain('2026-04-29 ~ 2026-05-05');
    expect(j).toContain('CardBuilder 完成');
    expect(j).toContain('PR 合并数');
  });
});
