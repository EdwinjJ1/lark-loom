# Bitable Memory Schema

四张核心表的字段定义。代码层面对应 `BitableTableKind`（`packages/contracts/src/bitable.ts`）。

---

## memory 表

语义化记忆存储，字段对应 `MemoryRecord`（`packages/contracts/src/bitable.ts`）。
由 `MemoryStore.write()` 写入，由 `memory.read` / `memory.search` 工具读取。

M6 起生产启动会 fail fast 校验：

- `.env` 必须配置 `LARK_BITABLE_APP_TOKEN`
- `.env` 必须配置 `LARK_BITABLE_MEMORY_TABLE_ID`
- bot 启动时会读取 memory 表 1 条记录验证表可访问

建表时请按下面顺序创建字段；字段名必须完全一致，尤其是下划线字段。

| 字段           | 类型   | 说明                                                         |
| -------------- | ------ | ------------------------------------------------------------ |
| `kind`         | 单选   | `project` / `chat` / `user` / `skill_log`                    |
| `chat_id`      | 文本   | 飞书群 chat_id；全局/项目级记忆用 `'GLOBAL'`                 |
| `user_id`      | 文本   | 可选，`user` / `skill_log` 类记忆需要                        |
| `key`          | 文本   | 幂等键；`(chat_id, kind, key)` 相同视为同一条（触发 upsert） |
| `content`      | 长文本 | 正文，写入时硬截断至 2KB                                     |
| `importance`   | 数字   | 重要性 0–10；由 LLM 异步评分，未评分前为 `-1`                |
| `last_access`  | 数字   | 毫秒时间戳；read/search 命中时刷新，驱动 LRU recency         |
| `created_at`   | 数字   | 毫秒时间戳；写入时一次性写入，不可修改                       |
| `source_skill` | 文本   | 写入该条记忆的 Skill 名（审计用）                            |

### 写入来源

- `skill_log`：每个 skill 成功执行后自动写入，记录“我做了什么”
- `chat`：`qa` / `summary` 额外写入，用于保留会话上下文
- `project`：`weekly` 每周把高重要 `skill_log` 压缩成项目快照后写入
- `user`：保留给后续用户偏好记忆

---

## decision 表

由 archive Skill 从群历史中抽取的决策条目。

| 字段               | 类型     | 说明                         |
| ------------------ | -------- | ---------------------------- |
| `chatId`           | 文本     | 所在群                       |
| `archivedAt`       | 日期时间 | 归档时间                     |
| `title`            | 文本     | 决策标题（≤50 字）           |
| `content`          | 长文本   | 决策详情                     |
| `deciders`         | 文本     | 决策人（open_id 逗号分隔）   |
| `status`           | 单选     | open / closed / superseded   |
| `relatedMemory`    | 关联字段 | → memory 表（归档记录）      |
| `relatedKnowledge` | 关联字段 | → knowledge 表（1-2 跳图谱） |

---

## todo 表

由 archive Skill 从群历史中抽取的待办条目。

| 字段            | 类型     | 说明                    |
| --------------- | -------- | ----------------------- |
| `chatId`        | 文本     | 所在群                  |
| `archivedAt`    | 日期时间 | 归档时间                |
| `title`         | 文本     | 待办标题                |
| `assignee`      | 文本     | 负责人 open_id          |
| `due`           | 日期     | 截止日期（可选）        |
| `status`        | 单选     | open / done / cancelled |
| `relatedMemory` | 关联字段 | → memory 表             |

---

## knowledge 表

双向关联节点，作为知识图谱的顶点，支持 1-2 跳关系查询。

| 字段               | 类型     | 说明                                        |
| ------------------ | -------- | ------------------------------------------- |
| `chatId`           | 文本     | 所在群                                      |
| `kind`             | 单选     | project / person / metric / concept / event |
| `name`             | 文本     | 节点名称（实体名）                          |
| `description`      | 长文本   | 节点描述                                    |
| `relatedDecisions` | 关联字段 | → decision 表                               |
| `relatedMemory`    | 关联字段 | → memory 表                                 |

---

## 写入规则

- `batchInsert` 须满足原子性：全部成功或全部回滚（对应红线 R4）
- 单批上限 500 条（飞书硬上限）
- 所有写操作通过 `BitableClient` 接口，禁止直接调飞书 REST API
- `chat_id` 作为行级数据隔离边界，不允许跨群查询（对应红线 R2）
