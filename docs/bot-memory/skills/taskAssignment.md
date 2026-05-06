---
name: taskAssignment
when_to_use: 群里出现分工讨论（谁负责什么 / DDL / 验收标准 / 交付物），把分工结构化录入分工表并推送卡片。
triggers:
  - 负责
  - 分工
  - DDL
  - 截止
  - 验收标准
  - 交付物
  - 让 X 来
  - 这块给 X
  - 排期
inputs:
  - 当前消息
  - 近期群聊历史（用于 LLM 结构化抽取 owner / task / ddl / deliverable / acceptance）
outputs:
  - tablePush 卡片（分工表更新）
side_effects:
  - 写入 Bitable todo 表
  - 写入 memory（kind=project，source_skill=taskAssignment）
---

# taskAssignment — 分工识别 → 分工表

把群里讨论的分工结构化录入分工表，并推送分工表更新卡片。

判定流程：

1. router 命中分工触发词 → 进 skill
2. LLM 从最近 20 条消息里抽取 (owner, task, ddl, deliverable, acceptance, confidence)
3. 仅保留 confidence ≥ 0.5 且 owner / task 都非空的项
4. 写入 todo 表成功 → 写 memory + 推 tablePush 卡片
5. 抽不到有效项 / 写表失败 → 仅 warn，不推卡片（避免误导）

示例：

- “小李来负责前端这块，下周三前出个 demo”
- “这部分给阿杰对接设计师，月底前交付”
- “分工：前端小李，后端老王，设计交给小美”

不要用于纯进展汇报（progressUpdate）或需求整理（requirementDoc）；那两类已被 router 优先级拦截。
