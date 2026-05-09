/**
 * SkillRouter — 飞书消息 → 业务意图分类。
 *
 * RouteIntent 是 bot 包内部类型，与 contracts/SkillName 解耦
 * （contracts 改动需三人 review，路由意图迭代频率高，先放本包）。
 *
 * 双轨制：
 *   - qa           唯一需要 @bot（避免对组员间普通问句乱插话）
 *   - recall       无需 @bot，但必须出现明确历史指代/信息缺口
 *   - 其余意图     纯被动监听，无需 @bot
 *
 * 优先级（高→低）：
 *   qa > archive > taskAssignment > progressUpdate > recall > meetingNotes > slides > requirementDoc > silent
 */

import type { Message } from '@seedhac/contracts';

/** Router 输出的意图类型（bot 包内部，不放 contracts） */
export type RouteIntent =
  | 'qa' // 信息缺口回答 — @bot + 疑问句
  | 'recall' // 主动召回 — 非 @ 消息里出现历史指代/信息缺口
  | 'taskAssignment' // 分工识别与表格生成 — 听到分工讨论
  | 'progressUpdate' // 阶段进展更新 — 听到进展汇报
  | 'meetingNotes' // 会议纪要读取 — 纪要进群
  | 'slides' // 演示文稿生成 — 听到 PPT 需求
  | 'requirementDoc' // 需求整理 — 听到项目需求/资料
  | 'archive' // 项目交付归档 — 听到归档/复盘/结束/收尾
  | 'rehearsal' // 演练复盘 — 听到 演练 / 彩排 / 汇报复盘
  | 'silent'; // 不处理

interface RouteRule {
  readonly intent: Exclude<RouteIntent, 'silent'>;
  /** 与 contracts/Skill.trigger.requireMention 同名，语义一致：是否要求 @bot */
  readonly requireMention: boolean;
  readonly patterns: readonly RegExp[];
  readonly excludePatterns?: readonly RegExp[];
}

const SLIDES_NEGATION_PATTERNS: readonly RegExp[] = [
  /(?:先别|别|不要|不用|无需|不需要|暂时不).{0,12}(?:ppt|幻灯片|演示文稿|演示|汇报)/i,
];

const SLIDES_REQUEST_PATTERNS: readonly RegExp[] = [
  /向上级汇报|给老板汇报|做.{0,10}汇报|准备.{0,10}汇报|整理.{0,10}汇报/,
  /给老板做.{0,4}演示|做.{0,4}演示/,
  /(?:帮|请|需要|要|得|麻烦|可以|能不能|生成|创建|做|准备|整理|产出|写|弄|交).{0,12}(?:ppt|幻灯片|演示文稿)/i,
  /(?:ppt|幻灯片|演示文稿).{0,12}(?:生成|创建|做|准备|整理|产出|写|弄|交|汇报|给老板|给.*看)/i,
];

/** 规则表，按优先级从高到低排列 */
const RULES: readonly RouteRule[] = [
  // ── qa 高优先级：@bot + 疑问词，优先于被动意图 ───────────────────
  {
    intent: 'qa',
    requireMention: true,
    patterns: [
      /是什么/,
      /怎么/,
      /为什么/,
      /如何/,
      /[？?]\s*$/,
      /吗[？?]?\s*$/,
      /哪个/,
      /哪些/,
      /谁负责/,
      /能不能/,
      /可以吗/,
    ],
  },

  // ── rehearsal：演练复盘（issue #102）放在 archive 之前，避免 "汇报复盘 / 演练复盘"
  // 被 archive 的 /复盘/ 抢走 ─────────────────────────────────────────
  {
    intent: 'rehearsal',
    requireMention: false,
    patterns: [/演练/, /演示练习/, /彩排/, /汇报复盘/, /根据刚才反馈修改/],
  },

  // ── archive：项目交付归档（被动）放在 progressUpdate 之前避免 "项目结束" 被
  // 误判为 progressUpdate（"完成"类信号与"结束"语义有交叠）───────────────
  {
    intent: 'archive',
    requireMention: false,
    patterns: [/复盘/, /归档/, /项目结束/, /收尾/, /准备交付/],
  },

  // ── taskAssignment（强信号）：显式"负责 / DDL / 验收标准 / 交付物 / 分工" ──
  // 这一层保持原有窄正则，确保跟 progressUpdate / requirementDoc 的优先级测试不回归
  {
    intent: 'taskAssignment',
    requireMention: false,
    patterns: [
      /你来负责/,
      /我来负责/,
      /他来负责/,
      /她来负责/,
      /负责人/,
      /DDL/i,
      /deadline/i,
      /截止日期/,
      /截止时间/,
      /验收标准/,
      /交付物/,
      /分工/,
    ],
  },

  // ── progressUpdate：进展汇报（被动）──────────────────────────────
  {
    intent: 'progressUpdate',
    requireMention: false,
    patterns: [
      /完成了/,
      /做完了/,
      /搞定了/,
      /已完成/,
      /已经完成/,
      /进展汇报/,
      /进度更新/,
      /汇报一下进展/,
      /更新进度/,
    ],
  },

  // ── recall：历史信息缺口主动召回（被动）──────────────────────────
  {
    intent: 'recall',
    requireMention: false,
    patterns: [
      /上次.{0,24}(?:什么|啥|哪|谁|多少|来着|记得|定|说|放|负责)/,
      /之前.{0,24}(?:什么|啥|哪|谁|多少|来着|记得|定|说|放|负责)/,
      /我记得.{0,24}(?:之前|上次|上回|那个)/,
      /上回.{0,24}(?:什么|啥|哪|谁|多少|来着|记得|定|说|放|负责)/,
      /那个.{0,24}(?:是什么|是啥|在哪|哪了|谁负责|怎么说|后来怎么|来着)/,
      /(?:是多少|是什么|是谁|在哪|哪了|谁负责|怎么说)来着/,
      /(?:上次|之前|上回|那个).{0,8}(?:负责什么|做什么|的工作是什么)/,
      /谁.{0,8}(?:负责|来做|来搞)/,
      /(?:DDL|截止时间|deadline).{0,12}[？?是]/i,
    ],
  },

  // ── meetingNotes：会议纪要进群（被动）────────────────────────────
  {
    intent: 'meetingNotes',
    requireMention: false,
    patterns: [/会议纪要/, /妙记/, /会议总结/, /本次会议/, /会议结论/],
  },

  // ── slides：需要做 PPT 汇报（被动）──────────────────────────────
  {
    intent: 'slides',
    requireMention: false,
    patterns: SLIDES_REQUEST_PATTERNS,
    excludePatterns: SLIDES_NEGATION_PATTERNS,
  },

  // ── requirementDoc：项目需求/资料（被动，最宽泛放最后）──────────
  {
    intent: 'requirementDoc',
    requireMention: false,
    patterns: [
      // 「项目需求」「项目的需求」「项目本次需求」等都接受（项目和需求之间最多 3 字）
      /项目.{0,3}需求/,
      /需求文档/,
      /功能需求/,
      /产品需求/,
      /PRD/,
      // 「以下是…需求」「以上是…需求」「上面是…需求」「下面是…需求」
      /(?:以下|以上|下面|上面)是?.{0,12}需求/,
      // 「这是 / 这就是 一个项目」
      /这(?:就)?是.{0,8}项目/,
      // 项目背景 / 项目目标 / 项目范围 等显式 PRD 段落标题
      /项目(?:背景|目标|范围)/,
    ],
  },

  // ── taskAssignment（弱信号兜底）：疑似分工的句式，让位给前面所有强意图后再接 ──
  // 让 X 来 / 由 X 做 / 这块给 X / 交给 X / 派给 X / 安排一下 / 排期 / 周X 前完成
  // 命中后进 skill；skill 内部还会再用 LLM 抽取，confidence < 0.5 自然 warn 静默
  {
    intent: 'taskAssignment',
    requireMention: false,
    patterns: [
      /(?:让|请|由|找).{0,8}(?:来|去|帮|搞|做|弄|写|盯|跟进|对接)/,
      /.{1,8}来(?:搞|做|弄|写|跟进|对接|处理|盯)/,
      /(?:跟进一下|跟一下|盯一下|盯着|对接一下)/,
      /(?:这块|这部分|这事|那块).{0,6}(?:给|交给|派给|分给)/,
      /(?:交给|派给|分给).{1,8}(?:来|做|搞|弄|处理|跟)/,
      /排期/,
      /安排一下/,
      /安排.{0,4}(?:做|搞|完成|交付|对接)/,
      /(?:周[一二三四五六日天]|下周|本周|这周|月底|月初|今晚|明天|后天).{0,4}(?:前|之前)(?:.{0,4}(?:交|完成|搞定|交付))?/,
    ],
  },

  // ── qa：兜底，@bot 且其他意图都不匹配时响应 ─────────────────────
  {
    intent: 'qa',
    requireMention: true,
    patterns: [/.+/],
  },
];

export class SkillRouter {
  constructor(private readonly botOpenId: string) {}

  private mentionsBot(msg: Message): boolean {
    if (!this.botOpenId) return false;
    return msg.mentions.some((m) => m.user.userId === this.botOpenId);
  }

  route(msg: Message): RouteIntent {
    // 非文本消息静默跳过
    if (msg.contentType !== 'text' && msg.contentType !== 'post') {
      return 'silent';
    }

    const { text } = msg;
    const mentioned = this.mentionsBot(msg);

    for (const rule of RULES) {
      if (rule.requireMention && !mentioned) continue;
      if (rule.excludePatterns?.some((p) => p.test(text))) continue;
      if (rule.patterns.some((p) => p.test(text))) {
        return rule.intent;
      }
    }

    return 'silent';
  }
}
