import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRouter } from '../skill-router.js';
import type { Message } from '@seedhac/contracts';

// ---------- helpers ----------

const BOT_OPEN_ID = 'ou_bot_test_001';
const BOT_MENTION = { user: { userId: BOT_OPEN_ID }, key: '@_user_1' };

function makeMsg(overrides: Partial<Message> & { text: string }): Message {
  return {
    messageId: 'msg_001',
    chatId: 'chat_001',
    chatType: 'group',
    sender: { userId: 'user_001' },
    contentType: 'text',
    rawContent: overrides.text,
    mentions: [],
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function atBot(text: string, extra?: Partial<Message>): Message {
  return makeMsg({ text, mentions: [BOT_MENTION], ...extra });
}

function plain(text: string, extra?: Partial<Message>): Message {
  return makeMsg({ text, ...extra });
}

// ---------- setup ----------

let router: SkillRouter;

beforeEach(() => {
  router = new SkillRouter(BOT_OPEN_ID);
});

// ================================================================
// qa（唯一需要 @bot）
// ================================================================
describe('qa', () => {
  it('pos: @bot + "是什么" → qa', () => {
    expect(router.route(atBot('飞书多维表格是什么'))).toBe('qa');
  });

  it('pos: @bot + "怎么" → qa', () => {
    expect(router.route(atBot('怎么把文档分享给群成员'))).toBe('qa');
  });

  it('pos: @bot + "为什么" → qa', () => {
    expect(router.route(atBot('为什么这个需求要改'))).toBe('qa');
  });

  it('pos: @bot + 问号结尾 → qa', () => {
    expect(router.route(atBot('这个方案可行吗？'))).toBe('qa');
  });

  it('pos: @bot + "如何" → qa', () => {
    expect(router.route(atBot('如何配置飞书机器人'))).toBe('qa');
  });

  it('neg: 无 @bot，有疑问词 → silent', () => {
    expect(router.route(plain('这个功能是什么意思'))).toBe('silent');
  });

  it('neg: @bot + 分工关键词，taskAssignment 优先级更高 → taskAssignment', () => {
    expect(router.route(atBot('你来负责这块，截止日期下周五'))).toBe('taskAssignment');
  });
});

// ================================================================
// taskAssignment（分工识别，被动）
// ================================================================
describe('taskAssignment', () => {
  it('pos: "你来负责" → taskAssignment', () => {
    expect(router.route(plain('这块你来负责，下周五前交'))).toBe('taskAssignment');
  });

  it('pos: "截止日期" → taskAssignment', () => {
    expect(router.route(plain('截止日期是下周一，交付一个设计稿'))).toBe('taskAssignment');
  });

  it('pos: "验收标准" → taskAssignment', () => {
    expect(router.route(plain('验收标准：接口通过所有测试用例'))).toBe('taskAssignment');
  });

  it('pos: "DDL" → taskAssignment', () => {
    expect(router.route(plain('DDL 5月6号，大家注意'))).toBe('taskAssignment');
  });

  it('pos: "分工" → taskAssignment', () => {
    expect(router.route(plain('我们来说一下分工吧'))).toBe('taskAssignment');
  });

  it('neg: 普通聊天无分工词 → silent', () => {
    expect(router.route(plain('今天天气不错'))).toBe('silent');
  });

  it('neg: 含进展关键词 → progressUpdate 优先', () => {
    expect(router.route(plain('我负责的部分完成了'))).toBe('progressUpdate');
  });
});

// ================================================================
// progressUpdate（阶段进展更新，被动）
// ================================================================
describe('progressUpdate', () => {
  it('pos: "完成了" → progressUpdate', () => {
    expect(router.route(plain('前端部分完成了，可以联调'))).toBe('progressUpdate');
  });

  it('pos: "搞定了" → progressUpdate', () => {
    expect(router.route(plain('接口搞定了，文档也更新了'))).toBe('progressUpdate');
  });

  it('pos: "已完成" → progressUpdate', () => {
    expect(router.route(plain('已完成需求评审，等待排期'))).toBe('progressUpdate');
  });

  it('pos: "进度更新" → progressUpdate', () => {
    expect(router.route(plain('进度更新：UI 设计稿已出初版'))).toBe('progressUpdate');
  });

  it('pos: "汇报一下进展" → progressUpdate', () => {
    expect(router.route(plain('汇报一下进展，本周完成了核心功能开发'))).toBe('progressUpdate');
  });

  it('neg: progressUpdate 优先级高于 meetingNotes → progressUpdate', () => {
    expect(router.route(plain('完成了本次会议纪要整理'))).toBe('progressUpdate');
  });

  it('neg: 普通消息无进展词 → silent', () => {
    expect(router.route(plain('大家下午有空吗'))).toBe('silent');
  });
});

// ================================================================
// recall（历史信息缺口主动召回，被动）
// ================================================================
describe('recall', () => {
  it('pos: "上次 ... 来着" → recall', () => {
    expect(router.route(plain('上次说徐坤负责什么来着？'))).toBe('recall');
  });

  it('pos: "之前 ... 谁负责" → recall', () => {
    expect(router.route(plain('之前那个接口是谁负责来着'))).toBe('recall');
  });

  it('pos: "我记得之前 ..." → recall', () => {
    expect(router.route(plain('我记得之前定过 demo 范围，是啥来着'))).toBe('recall');
  });

  it('pos: "那个 ... 后来怎么说" → recall', () => {
    expect(router.route(plain('那个 demo 范围后来怎么说'))).toBe('recall');
  });

  it('neg: 普通非 @ 问句仍不触发 recall', () => {
    expect(router.route(plain('徐坤负责什么'))).toBe('silent');
  });
});

// ================================================================
// meetingNotes（会议纪要读取，被动）
// ================================================================
describe('meetingNotes', () => {
  it('pos: "会议纪要" → meetingNotes', () => {
    expect(router.route(plain('本次会议纪要整理如下'))).toBe('meetingNotes');
  });

  it('pos: "妙记" → meetingNotes', () => {
    expect(router.route(plain('妙记已生成，大家查看'))).toBe('meetingNotes');
  });

  it('pos: "会议总结" → meetingNotes', () => {
    expect(router.route(plain('会议总结：确定了三个核心需求'))).toBe('meetingNotes');
  });

  it('pos: "本次会议" → meetingNotes', () => {
    expect(router.route(plain('本次会议决定了技术选型'))).toBe('meetingNotes');
  });

  it('pos: "会议结论" → meetingNotes', () => {
    expect(router.route(plain('会议结论：采用方案 B'))).toBe('meetingNotes');
  });

  it('neg: meetingNotes 优先级高于 slides → meetingNotes', () => {
    expect(router.route(plain('本次会议需要做个ppt汇报'))).toBe('meetingNotes');
  });

  it('neg: 普通消息 → silent', () => {
    expect(router.route(plain('明天几点开会'))).toBe('silent');
  });
});

// ================================================================
// slides（演示文稿生成，被动）
// ================================================================
describe('slides', () => {
  it('pos: "ppt"（小写）→ slides', () => {
    expect(router.route(plain('我们需要做个ppt给老板看'))).toBe('slides');
  });

  it('pos: "PPT"（大写）→ slides', () => {
    expect(router.route(plain('下周要做PPT汇报'))).toBe('slides');
  });

  it('pos: "帮忙整理幻灯片" → slides', () => {
    expect(router.route(plain('帮忙整理一下幻灯片初稿'))).toBe('slides');
  });

  it('pos: "向上级汇报" → slides', () => {
    expect(router.route(plain('我们需要向上级汇报项目进展'))).toBe('slides');
  });

  it('pos: "生成演示文稿" → slides', () => {
    expect(router.route(plain('根据项目进展生成演示文稿'))).toBe('slides');
  });

  it('neg: 含需求关键词 → requirementDoc 优先级低，slides 先命中 → slides', () => {
    expect(router.route(plain('项目需求确认后做个ppt'))).toBe('slides');
  });

  it('neg: 普通消息 → silent', () => {
    expect(router.route(plain('今天下午有时间吗'))).toBe('silent');
  });

  it('neg: merely discussing ppt does not trigger slides', () => {
    expect(router.route(plain('这个ppt怎么样'))).toBe('silent');
    expect(router.route(plain('这个 ppt 风格太丑了'))).toBe('silent');
    expect(router.route(plain('我们先别做 ppt'))).toBe('silent');
  });

  it('recall 优先处理历史指代类 PPT 问句', () => {
    expect(router.route(plain('上次 PPT 放哪了'))).toBe('recall');
    expect(router.route(plain('我们先别做 ppt'))).toBe('silent');
  });
});

// ================================================================
// requirementDoc（需求整理，被动，优先级最低）
// ================================================================
describe('requirementDoc', () => {
  it('pos: "项目需求" → requirementDoc', () => {
    expect(router.route(plain('以下是本次项目需求，请大家查阅'))).toBe('requirementDoc');
  });

  it('pos: "需求文档" → requirementDoc', () => {
    expect(router.route(plain('需求文档已更新，v2 版本'))).toBe('requirementDoc');
  });

  it('pos: "PRD" → requirementDoc', () => {
    expect(router.route(plain('PRD 链接发一下'))).toBe('requirementDoc');
  });

  it('pos: "项目背景" → requirementDoc', () => {
    expect(router.route(plain('项目背景：公司要做一个新的 B 端产品'))).toBe('requirementDoc');
  });

  it('pos: "产品需求" → requirementDoc', () => {
    expect(router.route(plain('产品需求已经确认，可以开始排期了'))).toBe('requirementDoc');
  });

  it('neg: 含 PPT 关键词 → slides 优先', () => {
    expect(router.route(plain('产品需求确认后我们做个ppt汇报'))).toBe('slides');
  });

  it('neg: 普通消息 → silent', () => {
    expect(router.route(plain('晚上一起吃饭吗'))).toBe('silent');
  });
});

// ================================================================
// silent（≥ 5 正例）
// ================================================================
describe('silent', () => {
  it('pos: 普通闲聊 → silent', () => {
    expect(router.route(plain('今天午饭吃什么'))).toBe('silent');
  });

  it('pos: 图片消息 → silent', () => {
    expect(router.route(makeMsg({ text: '', contentType: 'image' }))).toBe('silent');
  });

  it('pos: 文件消息 → silent', () => {
    expect(router.route(makeMsg({ text: '', contentType: 'file' }))).toBe('silent');
  });

  it('pos: 音频消息 → silent', () => {
    expect(router.route(makeMsg({ text: '', contentType: 'audio' }))).toBe('silent');
  });

  it('pos: 贴纸消息 → silent', () => {
    expect(router.route(makeMsg({ text: '', contentType: 'sticker' }))).toBe('silent');
  });

  it('pos: @bot 无疑问词但有内容 → qa（兜底响应）', () => {
    expect(router.route(atBot('哈哈哈哈'))).toBe('qa');
  });

  it('pos: @其他人（非 bot）→ silent', () => {
    const other = { user: { userId: 'ou_other' }, key: '@_user_2' };
    expect(router.route(makeMsg({ text: '你好', mentions: [other] }))).toBe('silent');
  });
});

// ================================================================
// 优先级验证
// ================================================================
describe('priority', () => {
  it('qa > taskAssignment：@bot + 分工词 + 疑问词 → qa', () => {
    expect(router.route(atBot('这个分工合理吗？'))).toBe('qa');
  });

  it('taskAssignment > progressUpdate：同时含分工词和完成词 → taskAssignment', () => {
    expect(router.route(plain('你来负责，完成了记得更新'))).toBe('taskAssignment');
  });

  it('slides > requirementDoc：同时含 ppt 和需求词 → slides', () => {
    expect(router.route(plain('把产品需求做成ppt'))).toBe('slides');
  });

  it('meetingNotes > slides：同时含会议纪要和 ppt → meetingNotes', () => {
    expect(router.route(plain('本次会议纪要和ppt都整理好了'))).toBe('meetingNotes');
  });

  // archive 路由（issue #104 上线后实测发现 router 缺这个 intent）
  it('archive：项目结束了 → archive', () => {
    expect(router.route(plain('项目结束了，归档一下'))).toBe('archive');
  });

  it('archive：复盘 → archive', () => {
    expect(router.route(plain('我们做个复盘'))).toBe('archive');
  });

  it('archive：准备交付 → archive', () => {
    expect(router.route(plain('准备交付，整理一下成果'))).toBe('archive');
  });

  it('archive > progressUpdate：项目结束 优先于 已完成', () => {
    expect(router.route(plain('项目结束了，已完成所有任务'))).toBe('archive');
  });

  it('无 @bot 时 qa 规则不生效 → 按后续规则路由', () => {
    expect(router.route(plain('这个项目需求是什么'))).toBe('requirementDoc');
  });
});

// ================================================================
// 性能
// ================================================================
describe('performance', () => {
  it('单次 route() < 5ms', () => {
    const msg = plain('本次项目需求如下，大家查阅');
    const start = performance.now();
    router.route(msg);
    expect(performance.now() - start).toBeLessThan(5);
  });

  it('连续 1000 次均值 < 1ms', () => {
    const msg = atBot('这个功能怎么实现？');
    const start = performance.now();
    for (let i = 0; i < 1000; i++) router.route(msg);
    expect((performance.now() - start) / 1000).toBeLessThan(1);
  });
});
