---
name: progressUpdate
when_to_use: 群里出现进展汇报（X 完成了 / 搞定了 / 已完成 / 进度更新），更新对应 todo 状态。
triggers:
  - 完成了
  - 做完了
  - 搞定了
  - 已完成
  - 已经完成
  - 进展汇报
  - 进度更新
  - 汇报一下进展
  - 更新进度
inputs:
  - 当前消息
  - 近期群聊历史（用于 LLM 抽取 owner / done_task）
  - 同 owner 的 pending todos（做 fuzzy 匹配）
outputs:
  - （可选）进展更新提示
side_effects:
  - 更新 Bitable todo 表的 status（pending → done）
  - 写入 memory 留痕（无论是否命中 todo）
---

# progressUpdate — 进展汇报 → 更新分工表状态

把群里"X 完成了 Y"这类汇报，映射到分工表里对应的 pending todo，把 status 改为 done。

判定流程：

1. router 命中进展词 → 进 skill
2. LLM 从消息+历史里抽取 (owner, done_task)
3. 在该 owner 的 pending todos 里 fuzzy 匹配 task 文本
4. 命中 → update status = done；未命中 → 仅写 memory 留痕，不报错

示例：

- “前端那块我搞定了”
- “汇报一下进展：访谈我已经完成”
- “已完成需求评审”

不要用于分工分配（taskAssignment）；那是 router 优先级更高的意图。
