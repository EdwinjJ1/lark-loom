# Lark Loom

字节跳动飞书 AI 校园挑战赛 · 参赛项目

## 参赛赛道

**飞书 AI 产品创新赛道**

志愿课题（按优先级）：

1. 基于 IM 的办公协同智能助手（第一志愿）
2. Multi-Agent Network · 多维表格上的多智能体虚拟组织（第二志愿）
3. 基于 AI 驱动的需求交付流程引擎（第三志愿）
4. 基于 Agent 的服务自动化修复系统（备选）

## 产品简介

**Lark Loom** —— 住在飞书群聊里的项目协作 Agent。

Agent 持续监听群聊，自动感知用户意图，无需 @ 触发，将碎片化的 IM 对话织成结构化的产出：需求文档、分工表格、演示文稿。

## 核心能力

- **需求整理** —— 自动将群里的项目讨论整理成文档，实时录入 Memory
- **分工管理** —— 识别群里的分工讨论，自动生成并维护多维表格，动态追踪 DDL 和进度
- **智能问答** —— 从历史记录和文档中检索答案，直接在群里回复信息缺口
- **演示文稿生成** —— 检测到汇报需求后自动生成 PPT 初稿，支持飞书会议演练与迭代
- **多端协同** —— 文档/表格/PPT 手机端与桌面端同步可见，文档变更通过 Webhook 实时通知群组
- **成果归档** —— 项目结束后自动打包完整流程与产出物

## 时间节点

| 节点     | 日期       |
| -------- | ---------- |
| 报名截止 | 2026-04-17 |
| 入营公布 | 2026-04-22 |
| 复赛     | 2026-05-06 |
| 决赛答辩 | 2026-05-14 |

## 资源

- 火山方舟 Coding 豪华套餐
- 飞书 OpenAPI 无限调用额度

---

## 工程结构

pnpm monorepo，三个 package：

```
packages/
├── contracts/    # 跨包接口契约（Message/Card/BotRuntime/BitableClient/CardBuilder/LLMClient/Retriever/Skill）
├── bot/          # 飞书 bot 进程入口（WSClient + Skill Router + 限流）
└── skills/       # 7 条业务主线 Skill 实现（qa/recall/summary/slides/archive/crossChat/weekly）
```

> 改 `packages/contracts` 必须 PR + 三人 review（CLAUDE.md 硬约束）。

## 跑起来（四步）

```bash
# 1. clone
git clone git@github.com:EdwinjJ1/seedhac.git
cd seedhac

# 2. install
pnpm install

# 3. build
pnpm build

# 4. dev（启动 bot 进程，v0.1 仅打印加载到的 skill 清单）
pnpm dev
```

辅助命令：

```bash
pnpm lint            # ESLint 全包
pnpm typecheck       # 全包 tsc --noEmit
pnpm format          # Prettier 全包格式化
pnpm clean           # 清掉 dist / .tsbuildinfo
```

环境要求：Node ≥ 20、pnpm ≥ 8。

## Memory 多维表格配置

M6 起生产启动会校验 memory 表是否可访问。先在飞书多维表格手动创建 `memory` 表，字段名和顺序按 [`docs/bot-memory/MEMORY-SCHEMA.md`](docs/bot-memory/MEMORY-SCHEMA.md)。

`.env` 至少需要：

```bash
LARK_BITABLE_APP_TOKEN=base_xxxxxxxxxxxxxxxx
LARK_BITABLE_MEMORY_TABLE_ID=tblxxxxxxxxxxxxxxxx
```

旧变量 `BITABLE_APP_TOKEN` / `BITABLE_TABLE_MEMORY` 仍作为兼容 fallback，但新配置请使用 `LARK_BITABLE_*`。

## 文档地图

读懂这个项目从这四份开始：

1. [`README.md`](README.md) — 你正在看的这份
2. [`docs/Q&A-产品方向.md`](docs/Q&A-产品方向.md) — 产品定位、红线（不能监听员工 1v1 私聊）
3. [`docs/飞书权限与能力边界.md`](docs/飞书权限与能力边界.md) — 5 个 UI 入口、API 频控、合规边界
4. [`docs/技术栈与可复用能力.md`](docs/技术栈与可复用能力.md) — 技术选型 + 架构图 + Skill Router

会议纪要：[`docs/MEETING-NOTES.md`](docs/MEETING-NOTES.md)
个人阶段成果（每 3 天一份）：[`docs/REPORTS/`](docs/REPORTS/)

## 给 Claude Code

仓库根目录的 [`CLAUDE.md`](CLAUDE.md) 写明了项目背景、技术约束、Git 协作规范、`lark-cli` 用法。新会话或 agent 都从这里读起。
