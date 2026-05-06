import { describe, it, expect, vi } from 'vitest';
import { ok } from '@seedhac/contracts';
import type { MemoryRecord, SkillContext } from '@seedhac/contracts';
import { weeklySkill } from '../weekly.js';

function makeLog(id: string, sourceSkill: string, content: string): MemoryRecord {
  return {
    id,
    kind: 'skill_log',
    chat_id: 'oc_chat1',
    key: id,
    content,
    importance: 8,
    last_access: 1,
    created_at: 1,
    source_skill: sourceSkill,
  };
}

function makeCtx(logs: readonly MemoryRecord[]): SkillContext {
  return {
    event: {
      type: 'schedule',
      payload: { chatId: 'oc_chat1', skillName: 'weekly', timestamp: Date.now() },
    },
    runtime: {} as SkillContext['runtime'],
    llm: {
      ask: vi.fn().mockResolvedValue(
        ok(
          JSON.stringify({
            title: '项目周快照',
            highlights: ['完成 M6 自动写入'],
            decisions: ['memory 表作为单一持久化层'],
            todos: ['观察表容量'],
            summary: '本周完成 memory 闭环。',
          }),
        ),
      ),
      chat: vi.fn(),
      askStructured: vi.fn(),
      chatWithTools: vi.fn(),
    } as unknown as SkillContext['llm'],
    bitable: {} as SkillContext['bitable'],
    docx: {} as SkillContext['docx'],
    cardBuilder: {
      build: vi.fn().mockReturnValue({ templateName: 'weekly', content: { ok: true } }),
    } as unknown as SkillContext['cardBuilder'],
    retrievers: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    memoryStore: {
      // 默认无当周缓存 → 走 list/llm/write/delete 完整流程；去重测试用例会覆盖。
      read: vi.fn().mockResolvedValue(ok(null)),
      search: vi.fn(),
      list: vi.fn().mockResolvedValue(ok(logs)),
      write: vi.fn().mockResolvedValue(
        ok({
          id: 'project_1',
          kind: 'project',
          chat_id: 'oc_chat1',
          key: 'weekly',
          content: 'snapshot',
          importance: 9,
          last_access: 1,
          created_at: 1,
          source_skill: 'weekly',
        }),
      ),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      score: vi.fn(),
    },
  };
}

describe('weeklySkill', () => {
  it('compresses high-importance skill_log into project snapshot and deletes logs', async () => {
    const logs = [
      makeLog('log_1', 'qa', '回答了项目范围问题'),
      makeLog('log_2', 'summary', '整理了关键会议结论'),
    ];
    const ctx = makeCtx(logs);

    expect(await weeklySkill.match(ctx)).toBe(true);
    const result = await weeklySkill.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.memoryStore?.list).toHaveBeenCalledWith({
      chatId: 'oc_chat1',
      kind: 'skill_log',
      minImportance: 7,
      limit: 100,
    });
    expect(ctx.memoryStore?.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'project',
        chat_id: 'oc_chat1',
        source_skill: 'weekly',
        importance: 9,
      }),
    );
    expect(ctx.memoryStore?.delete).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.value.card?.templateName).toBe('weekly');
      expect(result.value.reasoning).toContain('压缩 2 条');
    }
  });

  it('returns cached snapshot without re-compressing if same week already exists', async () => {
    const ctx = makeCtx([makeLog('log_1', 'qa', '只是占位，真实路径不应该读 logs')]);
    // 算出当周 weekRange，构造一条已存在的 project 快照
    const today = new Date();
    const day = today.getDay() === 0 ? 7 : today.getDay();
    const start = new Date(today);
    start.setDate(today.getDate() - day + 1);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const fmt = (x: Date) => x.toISOString().slice(0, 10);
    const range = `${fmt(start)} ~ ${fmt(end)}`;

    (ctx.memoryStore!.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'project_existing',
        kind: 'project',
        chat_id: 'oc_chat1',
        key: `weekly:${range.slice(0, 10)}`,
        content: JSON.stringify({
          weekRange: range,
          title: '已有快照',
          highlights: ['existing-h'],
          decisions: ['existing-d'],
          todos: ['existing-t'],
        }),
        importance: 9,
        last_access: 1,
        created_at: 1,
        source_skill: 'weekly',
      }),
    );

    const result = await weeklySkill.run(ctx);

    expect(result.ok).toBe(true);
    // 关键断言：去重命中后不应该再 list / llm.ask / write / delete
    expect(ctx.memoryStore?.list).not.toHaveBeenCalled();
    expect(ctx.llm.ask).not.toHaveBeenCalled();
    expect(ctx.memoryStore?.write).not.toHaveBeenCalled();
    expect(ctx.memoryStore?.delete).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.value.card?.templateName).toBe('weekly');
      expect(result.value.reasoning).toContain('已存在');
    }
  });
});
