---
name: rehearsal
when_to_use: 用户在群里提到"演练 / 演示练习 / 彩排 / 汇报复盘 / 根据刚才反馈修改"，或当前群有活跃的 rehearsal session 时使用。基于群聊反馈与会议纪要分析演示问题，循环反问到用户满意后重生成 PPT / 修订文档。
triggers:
  - 演练
  - 演示练习
  - 彩排
  - 汇报复盘
  - 根据刚才反馈修改
inputs:
  - 当前消息
  - 最近 30-50 条群聊历史（演练反馈 / 妙记纪要）
  - 上一轮已采纳的改动（来自 memory session 状态）
outputs:
  - rehearsal 卡片（loading / 分析结果 / 完成 / error 四态）
  - rehearsalClarify 卡片（反问澄清，1-3 个问题）
  - slides 卡片（finalize 后的新版 PPT）
  - docPush 卡片（finalize 后的修订记录文档）
side_effects:
  - 每轮写一条 memory（kind=skill_log，source_skill=rehearsal）
  - upsert session 状态（key=rehearsal_session）
  - finalize 写一条项目记忆（kind=project，content 带 [演练复盘] 前缀，archive 后续可识别为产出物）
  - finalize 调 slides.createFromOutline 重生成 PPT
  - finalize 调 docx.createFromMarkdown 写修订记录
---

# rehearsal — 演练复盘

主链路完整闭环（issue #102）：

```
① 用户和小组用飞书会议演练
       ↓
② bot 拉群历史 + 妙记 → LLM 分析问题/建议/待确认 → 发分析卡（按五维分组）
       ↓
③ 组员讨论
       ↓
④ bot 反问待确认点（消息卡片）
   用户回复 → bot 重新分析（循环回 ④，不限轮数）
       ↓
⑤ 用户文本/按钮表达满意 → 调 slides 重生成 + 更新文档 → 完成态卡 + 链接发群
```

## 五维评估框架

每条 issue / suggestion 必须归入其一（参考字节『坦诚清晰』+ 麦肯锡金字塔 + 飞书赛道权重）：

| 维度 | 关注什么 |
|------|---------|
| 内容 | 结论先行 / SCQA 完整 / 数据有支撑 |
| 结构 | 节奏分配 / 信息密度 / 视觉一致 |
| 表达 | 语速（中文 120-150 字/分钟）/ 口头禅 / 术语解释 |
| 受众 | 创新性 / 落地性 / 可复制性（飞书赛道权重） |
| 时间 | 超时风险 / 关键页拖延 |

## SBI 反馈格式

每条 issue 必须三段齐全：[Situation] → [Behavior] → [Impact]。
缺 Impact 是"指责"不是"改进"，会被视为低质量。

## 反馈红线

1. 不许编反馈：所有 issues 必须能在群聊文本里找到支撑句
2. 不许把弱信号渲染成强结论（含糊词强制 confidence ≤ 0.6）
3. 不许飘到通用建议（"建议加目录页"等没人提过的事）
4. 不许针对人（字节『坦诚清晰』红线）
5. 不许鼓励编造数据（阿里诚信红线）
6. 不许全盘否定（用增量措辞）
7. 不许复述未公开数据
8. 不许编造没出现过的人名 / 数字 / 页码

## 入口分发

- message + router 路由到 rehearsal intent → 全新 round 1
- cardAction `rehearsal.satisfied` → 进 step ⑤ finalize
- cardAction `rehearsal.iterate` → 进 step ④ 出反问卡
- message + 当前 chat 有活跃 rehearsal session → continueLoop
  - 文本含『满意 / 完成 / OK / 没问题 / 就这样』→ 进 step ⑤
  - 否则视为追加反馈，重新跑分析（循环回 ④）

## 不要做

- 不做飞书会议自动录制
- 不强依赖原生 minutes API（先支持群聊纪要 fallback）
- 不做评分（不输出 0-100 分）
- 不保证原地编辑已有 PPT，可生成新版本链接
- 不做跨群 rehearsal
