/**
 * BitableRetriever — 实现 Retriever 接口，Bitable 时序查询。
 *
 * source = 'bitable'
 * retrieve() 按 timestamp 倒序返回最近 topK 条消息。
 */

import {
  type Retriever,
  type RetrieverSource,
  type RetrieveQuery,
  type RetrieveHit,
  type Result,
  type BitableClient,
  ok,
  err,
} from '@seedhac/contracts';

export class BitableRetriever implements Retriever {
  readonly source: RetrieverSource = 'bitable';

  constructor(private readonly bitable: BitableClient) {}

  async retrieve(query: RetrieveQuery): Promise<Result<readonly RetrieveHit[]>> {
    const topK = query.topK ?? 10;

    const result = await this.bitable.find({
      table: 'memory',
      ...(query.chatId ? { filter: `AND(CurrentValue.[chat_id] = "${query.chatId}")` } : {}),
      pageSize: topK,
    });

    if (!result.ok) return err(result.error);

    const hits: RetrieveHit[] = result.value.records.map((r) => ({
      source: 'bitable' as RetrieverSource,
      id: String(r['messageId'] ?? r['recordId']),
      title: String(r['content'] ?? '').slice(0, 30),
      snippet: String(r['content'] ?? '').slice(0, 200),
      score: 1,
      timestamp: Number(r['timestamp'] ?? 0),
      meta: {
        chatId: r['chatId'],
        userId: r['userId'],
      },
    }));

    return ok(hits);
  }
}
