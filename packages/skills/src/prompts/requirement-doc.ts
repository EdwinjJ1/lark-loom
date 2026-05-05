import type { Message, SchemaLike } from '@seedhac/contracts';

// ─── PRD Schema（13 字段，对齐业界共识：Atlassian / Notion / 字节 / KEP / RFC）────

export interface ScopeSpec {
  /** 本期包含的功能 / 范围项 */
  readonly included: string[];
  /** 本期不做的事（Non-Goals）—— 显式写出来避免 scope creep */
  readonly excluded: string[];
}

export interface Milestone {
  readonly name: string;
  /** 不强制要日期；豆包对编日期容易幻觉，无明确日期就留空 */
  readonly date?: string;
}

export interface RequirementDoc {
  /** 项目标题，10 字内 */
  readonly title: string;
  /** 一句话摘要（业界共识：6/6 必备）*/
  readonly summary: string;
  /** 项目背景 / 问题陈述 */
  readonly background: string;
  /** 目标用户（5/6 共识；多角色时分主要 / 次要）*/
  readonly targetUsers: string[];
  /** 项目目标 / Why now */
  readonly goals: string[];
  /** 成功指标（5/6 共识；优先量化 KPI）*/
  readonly successMetrics: string[];
  /** 用户故事 / 使用场景（5/6 共识）*/
  readonly userStories: string[];
  /** 产品方案 / 实现思路（6/6 共识）*/
  readonly solution: string;
  /** 范围（包含 + 不包含）—— 拆开比 scope 一句更清晰 */
  readonly scope: ScopeSpec;
  /** 里程碑（关键节点）*/
  readonly milestones: Milestone[];
  /** 假设 & 风险与依赖 */
  readonly risks: string[];
  /** 待澄清问题 —— 反幻觉关键字段：信息缺失 / 冲突时往这里塞，不许编造 */
  readonly openQuestions: string[];
  /** 交付物 */
  readonly deliverables: string[];
}

/**
 * 群里被同步过来的关联文档（doc / wiki）正文片段。
 */
export interface LinkedDocSnippet {
  readonly kind: 'doc' | 'wiki';
  readonly title?: string;
  readonly url: string;
  readonly content: string;
}

const MAX_DOC_CHARS_EACH = 4000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断 ${value.length - max} 字）`;
}

// ─── 5 个 Few-Shot 示例 ───────────────────────────────────────────────────────
// 顺序遵循 recency bias：最简单的放最前，最贴近真实输入（多源融合）的放最后
//   1. HR 员工入职管理系统（B2B 内部工具，全信息，单 wiki）
//   2. 城市骑行打卡 App（B2C 消费，部分 openQuestions）
//   3. 数据看板（信息完全缺失，演示「不编造」）
//   4. KPI 算薪工具（信息冲突，演示决策日志）
//   5. 法律咨询 AI 助手（三源融合：群聊 + wiki + 合并转发，最贴近真实）
//
// 设计参考真实公开 PRD：财务报销 OA / 工友 APP / KEP-3766 / ADR Database。
// 领域故意避开 K12 / 协作 Bot / 海外语音，避免 LLM 抄当前用户测试场景。

const FEW_SHOT_EXAMPLES = `
### 示例 1：B2B 内部工具（HR 员工入职管理系统）

输入：
[李娜(HR总监)]: 我们入职流程太混乱，每次新员工要 HR / 直属上级 / IT 三边跑
[张伟(IT经理)]: IT 收到入职通知经常滞后，开账号要等好几天
[小王(产品)]: 整理下需求文档我们做个系统

关联文档（wiki：入职现状）：
公司每月入职 10-20 人，全靠 HR 邮件 + Excel 跟踪。HR 发起、上级填表、IT 开账号、行政发设备、培训部排培训 5 个环节，常出现遗漏。本期目标：把这 5 环节系统化，HR 仍是主控。

输出：
{
  "title": "员工入职管理系统",
  "summary": "把 HR 主导的入职流程从邮件+Excel 升级为系统化协同平台，覆盖 HR/上级/IT/行政/培训 5 个环节",
  "background": "公司每月入职 10-20 人，目前全靠 HR 邮件 + Excel 跟踪。流程涉及 HR 发起、直属上级填表、IT 开账号、行政发设备、培训部排培训 5 个环节。常出现 IT 通知滞后导致账号开通延迟、设备未到位、培训漏排。HR 是主控但缺工具。",
  "targetUsers": [
    "HR (主要用户)：发起并跟进入职任务",
    "直属上级 (次要用户)：填写岗位说明 + 试用期目标",
    "IT (次要用户)：接收账号开通任务",
    "行政 (次要用户)：处理设备发放",
    "培训部 (次要用户)：安排新人培训"
  ],
  "goals": ["把 5 环节系统化，避免邮件/Excel 漏跟", "新员工入职准备时长由 5 个工作日缩短至 ≤ 2 个工作日", "HR 单次入职操作时间由 30 分钟降至 ≤ 10 分钟"],
  "successMetrics": ["入职准备完成时长 ≤ 2 个工作日", "首日完整可用率（账号/设备/培训均到位）≥ 95%", "HR 月均处理入职数：基线 15 → 30 不增 HR 头寸", "环节滞后率 ≤ 5%"],
  "userStories": [
    "作为 HR，我希望发起入职任务时系统自动通知所有相关方",
    "作为直属上级，我希望在系统里填岗位说明 + 试用期目标",
    "作为 IT，我希望提前 3 天收到入职名单预留账号开通时间",
    "作为新员工，我希望首日就有完整账号/设备/培训日程"
  ],
  "solution": "Web 系统 + 邮件/IM 双通道。HR 端发起入职任务 → 系统按角色拆解任务 → 各环节负责人在系统中完成 → 状态实时同步 HR 看板。状态机：待发起 → HR 已发起 → 上级填写中 → 各环节并行执行 → 全部完成。每步骤超 SLA 自动提醒。",
  "scope": {
    "included": ["HR 入职任务发起 + 看板", "直属上级岗位说明填写", "IT 账号开通任务派单", "行政设备发放任务", "培训部新人培训排期", "邮件 + 飞书机器人提醒"],
    "excluded": ["员工合同电子签 (走法务系统)", "薪资/社保发放 (走 HR 薪资系统)", "试用期考核 (考核系统二期)", "离职流程 (本期不做)"]
  },
  "milestones": [
    {"name": "需求评审 + 原型设计", "date": "Q2 W1-W2"},
    {"name": "MVP 内测 (2 个部门)", "date": "Q2 W6"},
    {"name": "全公司试运行", "date": "Q3 W2"}
  ],
  "risks": [
    "各环节负责人对新系统抵触：试运行期保留邮件兜底",
    "数据从老 Excel 迁移：需 HR 配合做一次性导入",
    "IT 已有自有工单系统：需 API 集成而非取代"
  ],
  "openQuestions": [],
  "deliverables": ["HR 入职管理 Web 系统", "飞书机器人通知集成", "HR 操作手册", "上级/IT/行政/培训部用户指南"]
}

### 示例 2：B2C 消费产品（城市骑行打卡 App）

输入：
[陈帆(PM)]: 我们想做个 App, 鼓励城市居民骑行，结合打卡和社区
[何丽(设计师)]: 是按路线打卡还是按里程？
[陈帆]: 按路线，每个城市运营选 10-20 条经典路线，骑完打卡得徽章
[周宇(运营)]: 用户能分享路线照片到社区, 互相点赞评论

输出：
{
  "title": "城市骑行打卡 App",
  "summary": "面向城市居民的骑行打卡 + 社区互动 App，骑完运营精选路线获徽章，可分享照片到社区",
  "background": "城市骑行群体不断扩大，但缺少系统化激励 + 内容沉淀工具。运营团队希望通过精选路线 + 打卡徽章激励用户日常骑行，同时形成本地骑行社区文化。",
  "targetUsers": [
    "城市骑行爱好者 (主要)：日常通勤/周末骑行的 18-40 岁居民",
    "城市运营 (次要)：在各城市策划路线、组织骑行活动"
  ],
  "goals": [
    "MVP 上线 3 个月内完成 5 个一线城市路线运营",
    "首版本完成路线打卡 + 社区两个核心闭环",
    "通过徽章 + 社区互动建立日常骑行习惯"
  ],
  "successMetrics": [
    "DAU/MAU ≥ 30% (打卡是高频行为)",
    "次月留存 ≥ 40%",
    "路线打卡完成率 ≥ 60%",
    "用户人均月分享数 ≥ 1 条"
  ],
  "userStories": [
    "作为城市居民，我希望按家附近能筛选 5 公里以内路线",
    "作为骑行爱好者，我希望沿路实时显示打卡进度激励完成",
    "作为运营，我希望管理后台可批量上传路线 + GPX",
    "作为用户，我希望分享照片到社区获得反馈"
  ],
  "solution": "iOS + Android 双端 App + 后台运营系统。核心闭环：选路线 → GPS 跟踪打卡 → 完成获徽章 → 拍照分享 → 社区互动。GPS 后台运行需考虑电量。社区采用 Feed + 城市标签 + 路线标签三维分类。",
  "scope": {
    "included": ["城市路线浏览 + 收藏", "GPS 实时打卡 (后台运行)", "徽章系统 + 等级", "拍照分享到社区", "社区 Feed + 点赞评论", "运营后台路线管理"],
    "excluded": ["实时多人骑行 (二期)", "内置 IM (走分享转飞书/微信)", "电商/装备售卖 (二期)", "运动数据深度分析 (本期只记里程 + 时长)"]
  },
  "milestones": [
    {"name": "MVP 设计 + 路线 GPX 收集"},
    {"name": "Beta 内测"},
    {"name": "5 城市公测"}
  ],
  "risks": [
    "GPS 持续运行耗电：客户端做后台采样优化 + 用户教育",
    "路线 GPX 数据来源：与运营约定数据源 + 手工采集预算",
    "社区 UGC 内容审核：上线前接入第三方审核 SDK"
  ],
  "openQuestions": [
    "用户位置数据合规处理：需法务对齐个保法存储 + 共享策略",
    "跨城市运营策略：用户从一个城市去另一个城市骑行时，徽章 / 排行榜归属规则未定，需运营负责人确认"
  ],
  "deliverables": ["iOS App", "Android App", "运营后台 Web 系统", "用户隐私政策 + 数据处理协议"]
}

### 示例 3：信息完全缺失（演示「不编造」）

输入：
[周经理(产品)]: 我们想做个数据看板，整理一下需求

输出：
{
  "title": "数据看板（待明确具体业务领域）",
  "summary": "群聊中提到要做一个数据看板，但业务领域、目标用户、核心指标均未明确，本 PRD 仅记录已知信息并列出待澄清问题",
  "background": "群里仅有一条「想做个数据看板」的描述，未提供业务背景、当前痛点、决策上下文。建议与发起人对齐后补充。",
  "targetUsers": [],
  "goals": [],
  "successMetrics": [],
  "userStories": [],
  "solution": "[待补充：未提供任何方案描述]",
  "scope": {"included": [], "excluded": []},
  "milestones": [],
  "risks": [],
  "openQuestions": [
    "数据看板服务于什么业务？销售/运营/产品/财务/其他？",
    "目标用户是谁？管理层/一线员工/客户？",
    "需要展示哪些核心指标？数据来源是什么？",
    "更新频次（实时/日/周）？",
    "首期范围与排期？预算？"
  ],
  "deliverables": []
}

### 示例 4：信息冲突（演示决策日志）

输入：
[王总(业务负责人)]: 算薪工具按月结算才合适，业务方反馈每月就要看数据
[王总]: 而且要支持多档阶梯 + 复杂规则
[李工(技术负责人)]: 已经有方案文档了见 wiki

关联文档（wiki：技术方案）：
KPI 算薪工具 v1：按季度结算，简单线性公式（KPI 完成率 × 系数）。
理由：月度数据波动大易引发争议，季度更稳定；线性公式开发周期 2 周，复杂规则需 6 周。

输出：
{
  "title": "KPI 自动算薪工具",
  "summary": "根据员工 KPI 完成率自动计算绩效薪资，覆盖业务团队月度/季度核算需求",
  "background": "目前 HR 用 Excel 手算 KPI 薪资，月初耗时 3 天且易出错。业务负责人要求按月看数据并支持多档阶梯规则；技术方案文档则建议按季度 + 简单线性公式。两方对结算频率与规则复杂度存在明确分歧。",
  "targetUsers": [
    "业务负责人 (主要)：审批 KPI 薪资结果",
    "HR (主要)：发起结算并发放薪资",
    "员工 (次要)：查看本人 KPI 与对应薪资"
  ],
  "goals": [
    "替换手算 Excel，把月初 3 天耗时降至 1 天内",
    "支持业务方要求的月度结算节奏",
    "为复杂阶梯规则预留扩展空间"
  ],
  "successMetrics": [
    "结算耗时 ≤ 1 天",
    "结算准确率 ≥ 99%",
    "争议申诉率 < 5%"
  ],
  "userStories": [
    "作为 HR，我希望月底自动跑算薪并出明细表",
    "作为业务负责人，我希望看到部门 KPI 完成率分布",
    "作为员工，我希望查询本月 KPI 来源数据"
  ],
  "solution": "决策日志：业务方主张「月度 + 复杂阶梯」，技术方案主张「季度 + 简单线性」。考虑到业务方诉求是核心驱动且月度更贴合管理节奏，第一期选择「月度结算 + 简单线性公式」作为折中：满足业务方频率诉求 + 技术方实现周期诉求；复杂阶梯规则放二期。Web 系统月底定时跑批 → HR 审核 → 业务方确认 → 发放。",
  "scope": {
    "included": [
      "按月结算（与业务方意见一致，覆盖文档「按季度」方案）",
      "简单线性公式 KPI × 系数（与技术方案一致）",
      "HR 审核 + 业务方确认双签",
      "员工本人 KPI 查询"
    ],
    "excluded": [
      "复杂阶梯规则 (二期，与业务方完整需求有出入)",
      "跨部门 KPI 共享 (本期不做)",
      "薪资发放 (走现有薪资系统)"
    ]
  },
  "milestones": [
    {"name": "需求评审 + 公式确认"},
    {"name": "MVP 上线 + 与 HR 平台对接"},
    {"name": "全公司试运行"}
  ],
  "risks": [
    "结算频率冲突：本期按月与文档「季度」不一致，需业务方 + 技术方书面确认折中方案",
    "数据波动可能引发争议：上线后建立月度对账例会"
  ],
  "openQuestions": [
    "结算频率最终定夺人是谁？业务负责人 vs CTO？需明确决策权",
    "二期复杂阶梯规则上线时机：与业务方商定能接受的等待时长"
  ],
  "deliverables": [
    "KPI 自动算薪 Web 系统",
    "HR / 业务方 / 员工三端用户指南",
    "决策记录文档（结算频率折中方案的来龙去脉）"
  ]
}

### 示例 5：三源融合（最贴近真实场景；群聊 + wiki + 合并转发）

输入：
[孙婷(产品总监)]: 我们想做个面向中小企业的法律咨询 AI
[赵峰(法务VP)]: 主要场景是合同审查 + 劳动法咨询，准确率要求很高

关联文档（wiki：产品方向）：
中小企业法律支出高，专业律师不可负担。AI 可解决高频低复杂度问题，如合同模板审查、劳动合同条款合规、税务咨询基础知识。准确率门槛 ≥ 85%（相比通用 GPT 的 60%）。订阅模式月费 99/199/399 三档。

合并转发文本（用户调研访谈记录）：
[访谈员]: 您最常遇到的法律问题？
[小企业主A]: 合同条款看不懂，请律师又贵
[小企业主B]: 月费 100 以内可以接受，但准确率不能差
[小企业主A]: 哪类合同最多？劳动合同、租赁合同、采购合同

输出：
{
  "title": "中小企业法律咨询 AI",
  "summary": "面向中小企业的法律咨询 AI 助手，覆盖合同审查 + 劳动法 + 税务三大高频场景，订阅制收费",
  "background": "中小企业法律支出高（专业律师月费 5000+），但日常法律问题多为高频低复杂度的合同条款看不懂、劳动法合规、税务基础知识。用户调研显示 100% 受访者反馈合同条款理解困难，月费 100 以内可接受。AI 在合同审查类任务上准确率可达 85%，远超通用 GPT 的 60%。",
  "targetUsers": [
    "中小企业主 (主要)：日常合同 + 劳动法 + 税务咨询",
    "中小企业 HR (次要)：劳动合同审查与员工纠纷处理",
    "中小企业财务 (次要)：基础税务咨询"
  ],
  "goals": [
    "首版覆盖合同审查 / 劳动法 / 基础税务三大场景",
    "维持准确率 ≥ 85%（相对通用 GPT 60% 的明显领先）",
    "建立月费 99/199/399 三档订阅模式"
  ],
  "successMetrics": [
    "准确率（专业法务复审）≥ 85%",
    "月活用户付费转化率 ≥ 15%",
    "首月留存 ≥ 50%",
    "高频场景（合同审查）单次咨询完成时长 ≤ 5 分钟"
  ],
  "userStories": [
    "作为小企业主，我希望上传合同 PDF 后 AI 标注出风险条款",
    "作为小企业主，我希望针对劳动合同问询 AI 给出法条 + 案例",
    "作为 HR，我希望 AI 帮审查员工劳动合同的常见雷区",
    "作为财务，我希望 AI 解释新颁布的税务规定"
  ],
  "solution": "Web + 微信小程序双端。核心模块：(1) 合同上传 + 段级风险标注（OCR + 法律领域 LLM）；(2) 对话式 Q&A（劳动法 + 税务知识库）。准确率提升靠「领域微调 + RAG（最高法判例库 + 国家立法库）」+ 用户反馈学习。订阅 99（个人）/199（企业 5 人）/399（企业 20 人）三档。",
  "scope": {
    "included": [
      "劳动合同 / 租赁合同 / 采购合同 三类合同审查",
      "劳动法 + 基础税务 Q&A",
      "Web + 微信小程序双端",
      "月度订阅制（99/199/399）",
      "用户反馈打分 → 改进数据回流"
    ],
    "excluded": [
      "诉讼代理 / 律师对接服务（本期不做）",
      "刑事 / 婚姻家庭等领域（本期聚焦商事）",
      "纸质合同扫描以外的特殊文档格式（本期 PDF 为主）",
      "国际法 / 跨境合规（本期不做）"
    ]
  },
  "milestones": [
    {"name": "领域语料收集 + 微调"},
    {"name": "MVP 内测（合同审查模块）"},
    {"name": "Beta 公测 + 订阅闸门上线"},
    {"name": "三大场景全量上线"}
  ],
  "risks": [
    "AI 法律建议合规性：免责声明 + 「建议咨询专业律师」兜底文案，所有输出含此提示",
    "判例库数据来源 + 版权：与官方司法数据源对接，避免抓取风险",
    "月费 100 内的价格敏感：MVP 期 99 档保留 7 天免费试用"
  ],
  "openQuestions": [
    "首版本上线时具体的法律免责声明措辞需法务 VP 终审",
    "用户上传合同的隐私存储期：与法务 + 安全团队确认（90 天还是即时删除）",
    "AI 给出错误建议导致用户损失的赔付边界，需保险方案确认"
  ],
  "deliverables": [
    "Web 端 + 微信小程序",
    "合同审查领域 LLM（微调版）",
    "法律知识库（劳动法 + 税务）",
    "订阅与支付集成",
    "免责声明 + 用户协议"
  ]
}
`.trim();

// ─── REQ_PROMPT 主函数 ────────────────────────────────────────────────────────

export const REQ_PROMPT = (
  history: readonly Message[],
  linkedDocs: readonly LinkedDocSnippet[] = [],
  forwardedTexts: readonly string[] = [],
): string => {
  const forwardedSet = new Set(forwardedTexts);
  const nativeHistory = history.filter((m) => !forwardedSet.has(m.text));

  const historyBlock = nativeHistory.length
    ? nativeHistory.map((m) => `[${m.sender.name ?? m.sender.userId}]: ${m.text}`).join('\n')
    : '（无群聊记录）';

  const forwardedBlock = forwardedTexts.length
    ? forwardedTexts.map((t, i) => `[转发文本 ${i + 1}] ${t}`).join('\n')
    : '';

  const docsBlock = linkedDocs.length
    ? linkedDocs
        .map((d, i) => {
          const head = `--- 文档 ${i + 1}（${d.kind}${d.title ? `：${d.title}` : ''}） ${d.url} ---`;
          return `${head}\n${truncate(d.content, MAX_DOC_CHARS_EACH)}`;
        })
        .join('\n\n')
    : '';

  const tier1Count = linkedDocs.length + forwardedTexts.length;

  return `
# 任务：根据下方输入，提取并整理为结构化项目需求文档（PRD）

## 🚨 反幻觉硬约束（违反将作废输出）

1. **输入中没有明确出现的具体数字 / 日期 / 用户人数 / KPI / 业务规模 / 价格 / 百分比，绝对不许出现在输出 PRD 任何字段里**。即使示例 1-5 里有具体数字，也只是示例，**不要往当前任务里搬运**。
2. 信息缺失字段处理（参考下方示例 3 演示的写法）：
   - 字符串字段：写「[待补充：原因]」或简短说明缺失原因
   - 数组字段：返回空数组 \`[]\`
   - **把所有「缺信息无法填」的问题写进 \`openQuestions\`**
3. 信息冲突处理（参考下方示例 4 演示的「决策日志」写法）：
   - 在 \`solution\` 字段里写明 Considered Options + Decision + Rationale
   - 在 \`scope\` 里标明决策结果（如「按月结算（与业务方一致，覆盖文档"季度"方案）」）
   - 在 \`risks\` 里记录冲突本身
   - 在 \`openQuestions\` 里列「最终决策权归属」
4. **Tier-1 输入必须 100% 融合**：linkedDocs + forwardedTexts 是用户主动提供的显式输入，主题即使看起来不一致也要全部吸收（参考示例 5 三源融合）；不许擅自判定「无关」丢掉。

## 字段说明

输出严格按以下 13 字段 JSON：

- **title**: 项目标题，10 字内（多领域时取抽象统称）
- **summary**: 一句话摘要
- **background**: 项目背景 / 问题陈述，2-3 段
- **targetUsers**: 目标用户列表，多角色分主要 / 次要
- **goals**: 项目目标列表，每条单一目标
- **successMetrics**: 成功指标 / KPI（**只用输入里出现过的数字**）
- **userStories**: 用户故事 / 使用场景，「作为 X，我希望 Y」格式
- **solution**: 产品方案 / 实现思路，1-2 段
- **scope**: \`{ included: string[], excluded: string[] }\` 对象，包含与不包含拆开
- **milestones**: 里程碑列表，\`{ name: string, date?: string }\`，**没明确日期就不写 date 字段**
- **risks**: 假设 & 风险与依赖
- **openQuestions**: 待澄清问题（反幻觉关键字段）
- **deliverables**: 交付物列表

## 5 个示例

${FEW_SHOT_EXAMPLES}

---

## 当前任务输入
${forwardedBlock ? `\n合并转发文本（**Tier-1，必须吸收**）：\n${forwardedBlock}\n` : ''}${docsBlock ? `\n关联文档（**Tier-1，必须吸收**）：\n${docsBlock}\n` : ''}
群聊记录${tier1Count > 0 ? '（Tier-2 仅作上下文参考）' : ''}：
${historyBlock}

---

只返回符合上述 13 字段 schema 的 JSON，不要有任何额外文字 / 注释 / 代码块标记。
`.trim();
};

// ─── Schema 验证 ──────────────────────────────────────────────────────────────

function asStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be array`);
  return raw.map((v) => {
    if (typeof v !== 'string') throw new Error(`${field}[] must be string`);
    return v;
  });
}

function parseScope(raw: unknown): ScopeSpec {
  if (typeof raw === 'string') {
    // 老 schema 是 scope: string；兼容性容错：把整段当成 included 一项
    return { included: [raw], excluded: [] };
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('scope must be object { included, excluded }');
  }
  const o = raw as Record<string, unknown>;
  return {
    included: asStringArray(o['included'] ?? [], 'scope.included'),
    excluded: asStringArray(o['excluded'] ?? [], 'scope.excluded'),
  };
}

function parseMilestones(raw: unknown): Milestone[] {
  if (!Array.isArray(raw)) throw new Error('milestones must be array');
  return raw.map((v, i) => {
    if (typeof v === 'string') {
      // 容错：LLM 偶尔返回字符串数组
      return { name: v };
    }
    if (typeof v !== 'object' || v === null) {
      throw new Error(`milestones[${i}] must be object { name, date? }`);
    }
    const o = v as Record<string, unknown>;
    if (typeof o['name'] !== 'string') {
      throw new Error(`milestones[${i}].name must be string`);
    }
    const m: Milestone = { name: o['name'] };
    if (typeof o['date'] === 'string' && o['date'].trim().length > 0) {
      return { ...m, date: o['date'] };
    }
    return m;
  });
}

export const RequirementDocSchema: SchemaLike<RequirementDoc> = {
  parse(value: unknown): RequirementDoc {
    if (typeof value !== 'object' || value === null) throw new Error('requirement doc must be object');
    const o = value as Record<string, unknown>;
    if (typeof o['title'] !== 'string') throw new Error('title must be string');
    if (typeof o['summary'] !== 'string') throw new Error('summary must be string');
    if (typeof o['background'] !== 'string') throw new Error('background must be string');
    if (typeof o['solution'] !== 'string') throw new Error('solution must be string');
    return {
      title: o['title'],
      summary: o['summary'],
      background: o['background'],
      targetUsers: asStringArray(o['targetUsers'] ?? [], 'targetUsers'),
      goals: asStringArray(o['goals'] ?? [], 'goals'),
      successMetrics: asStringArray(o['successMetrics'] ?? [], 'successMetrics'),
      userStories: asStringArray(o['userStories'] ?? [], 'userStories'),
      solution: o['solution'],
      scope: parseScope(o['scope']),
      milestones: parseMilestones(o['milestones'] ?? []),
      risks: asStringArray(o['risks'] ?? [], 'risks'),
      openQuestions: asStringArray(o['openQuestions'] ?? [], 'openQuestions'),
      deliverables: asStringArray(o['deliverables'] ?? [], 'deliverables'),
    };
  },
  jsonSchema(): Record<string, unknown> {
    const stringArray = { type: 'array', items: { type: 'string' } };
    return {
      type: 'object',
      required: [
        'title',
        'summary',
        'background',
        'targetUsers',
        'goals',
        'successMetrics',
        'userStories',
        'solution',
        'scope',
        'milestones',
        'risks',
        'openQuestions',
        'deliverables',
      ],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        background: { type: 'string' },
        targetUsers: stringArray,
        goals: stringArray,
        successMetrics: stringArray,
        userStories: stringArray,
        solution: { type: 'string' },
        scope: {
          type: 'object',
          required: ['included', 'excluded'],
          properties: { included: stringArray, excluded: stringArray },
        },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, date: { type: 'string' } },
          },
        },
        risks: stringArray,
        openQuestions: stringArray,
        deliverables: stringArray,
      },
    };
  },
};

// ─── Markdown 渲染 ────────────────────────────────────────────────────────────

export function renderRequirementDocMarkdown(doc: RequirementDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title}`, '');

  if (doc.summary) {
    lines.push(`> ${doc.summary}`, '');
  }

  lines.push('## 项目背景', doc.background, '');

  if (doc.targetUsers.length) {
    lines.push('## 目标用户', ...doc.targetUsers.map((u) => `- ${u}`), '');
  }

  if (doc.goals.length) {
    lines.push('## 目标', ...doc.goals.map((g) => `- ${g}`), '');
  }

  if (doc.successMetrics.length) {
    lines.push('## 成功指标', ...doc.successMetrics.map((m) => `- ${m}`), '');
  }

  if (doc.userStories.length) {
    lines.push('## 用户故事 / 使用场景', ...doc.userStories.map((s) => `- ${s}`), '');
  }

  lines.push('## 产品方案', doc.solution, '');

  lines.push('## 范围');
  if (doc.scope.included.length) {
    lines.push('### 包含', ...doc.scope.included.map((s) => `- ${s}`), '');
  }
  if (doc.scope.excluded.length) {
    lines.push('### 不包含（Non-Goals）', ...doc.scope.excluded.map((s) => `- ${s}`), '');
  }
  if (!doc.scope.included.length && !doc.scope.excluded.length) {
    lines.push('（待补充）', '');
  }

  if (doc.milestones.length) {
    lines.push(
      '## 里程碑',
      ...doc.milestones.map((m) => (m.date ? `- ${m.name}（${m.date}）` : `- ${m.name}`)),
      '',
    );
  }

  if (doc.risks.length) {
    lines.push('## 风险与依赖', ...doc.risks.map((r) => `- ${r}`), '');
  }

  if (doc.openQuestions.length) {
    lines.push('## 待澄清问题', ...doc.openQuestions.map((q) => `- ${q}`), '');
  }

  if (doc.deliverables.length) {
    lines.push('## 交付物', ...doc.deliverables.map((d) => `- ${d}`), '');
  }

  return lines.join('\n');
}

// ─── Feishu URL parsing ───────────────────────────────────────────────────────

const FEISHU_DOC_RE =
  /https?:\/\/[^/\s)\]]*(?:feishu\.cn|lark\.cn|larkoffice\.com)\/(docx?|wiki)\/([A-Za-z0-9_-]{5,})/g;

export interface ParsedDocUrl {
  readonly kind: 'doc' | 'wiki';
  readonly token: string;
  readonly url: string;
}

export function parseFeishuDocUrls(messages: readonly Message[]): ParsedDocUrl[] {
  const seen = new Set<string>();
  const out: ParsedDocUrl[] = [];

  for (const msg of messages) {
    const haystacks = [msg.text];
    if (msg.rawContent && msg.rawContent !== msg.text) haystacks.push(msg.rawContent);

    for (const haystack of haystacks) {
      const normalized = haystack.replaceAll('\\/', '/');
      FEISHU_DOC_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FEISHU_DOC_RE.exec(normalized)) !== null) {
        const type = m[1] ?? '';
        const token = m[2] ?? '';
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push({
          kind: type === 'wiki' ? 'wiki' : 'doc',
          token,
          url: m[0],
        });
        if (out.length >= 5) return out;
      }
    }
  }

  return out;
}

// ─── Relevance pre-filter ─────────────────────────────────────────────────────

export interface RelevanceCandidate {
  readonly id: string;
  readonly kind: 'message';
  readonly excerpt: string;
}

export interface RelevanceJudgment {
  readonly results: readonly { readonly id: string; readonly keep: boolean }[];
}

export const RELEVANCE_PROMPT = (
  triggerText: string,
  candidates: readonly RelevanceCandidate[],
): string => `
你是一个项目需求整理助手的预筛选模块。
当前用户在群里发了一条消息触发"整理项目需求"技能，触发消息是：

[trigger]
${triggerText}

下面有 ${candidates.length} 条候选群聊历史。
判断**每条**是否与触发消息指向的需求项目相关：
- 直接讨论同一项目 / 同一需求场景 / 同一目标用户 → keep: true
- 完全无关的闲聊、其他项目讨论、机器人诊断噪音、重复触发消息 → keep: false
- 不确定时**倾向 keep: true**，宁可多带一点上下文

只返回如下 JSON，不要有额外文字：
{"results":[{"id":"<候选 id>","keep":true},...]}

候选列表：
${candidates.map((c) => `[${c.id}] ${c.excerpt}`).join('\n')}
`.trim();

export const RelevanceJudgmentSchema: SchemaLike<RelevanceJudgment> = {
  parse(value: unknown): RelevanceJudgment {
    if (typeof value !== 'object' || value === null) throw new Error('relevance must be object');
    const o = value as Record<string, unknown>;
    if (!Array.isArray(o['results'])) throw new Error('relevance.results must be array');
    return {
      results: (o['results'] as unknown[]).map((r, i) => {
        if (typeof r !== 'object' || r === null) throw new Error(`results[${i}] must be object`);
        const obj = r as Record<string, unknown>;
        if (typeof obj['id'] !== 'string') throw new Error(`results[${i}].id must be string`);
        if (typeof obj['keep'] !== 'boolean') throw new Error(`results[${i}].keep must be boolean`);
        return { id: obj['id'], keep: obj['keep'] };
      }),
    };
  },
  jsonSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'keep'],
            properties: { id: { type: 'string' }, keep: { type: 'boolean' } },
          },
        },
      },
    };
  },
};
