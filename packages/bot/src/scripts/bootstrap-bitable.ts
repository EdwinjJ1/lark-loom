/**
 * 让 bot 自己创建一个 Bitable base + 4 张表，并打印 .env 行。
 *
 * 为什么要这么做：手动建的 base，bot 调 API 会拿到 91403 Forbidden（个人版飞书没有"应用授权"入口）。
 * Bot 自己创建的 base 默认对自己拥有完整权限，零授权。
 *
 * 跑法：pnpm --filter @seedhac/bot dev:bootstrap-bitable
 * 输出：4 行 BITABLE_* 环境变量，复制粘贴到 .env，再重启 bot。
 */

import * as lark from '@larksuiteoapi/node-sdk';

const APP_ID = process.env['LARK_APP_ID'];
const APP_SECRET = process.env['LARK_APP_SECRET'];

if (!APP_ID || !APP_SECRET) {
  console.error('LARK_APP_ID / LARK_APP_SECRET 缺失');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

interface FieldSpec {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

interface TableSpec {
  table_name: string;
  envKey: string;
  fields: FieldSpec[];
}

const TABLES: readonly TableSpec[] = [
  {
    table_name: 'memory',
    envKey: 'BITABLE_TABLE_MEMORY',
    fields: [
      { field_name: 'key', type: 1 },
      {
        field_name: 'kind',
        type: 3,
        property: {
          options: [
            { name: 'project', color: 0 },
            { name: 'chat', color: 1 },
            { name: 'user', color: 2 },
            { name: 'skill_log', color: 3 },
          ],
        },
      },
      { field_name: 'chat_id', type: 1 },
      { field_name: 'user_id', type: 1 },
      { field_name: 'content', type: 1 },
      { field_name: 'importance', type: 2, property: { formatter: '0' } },
      { field_name: 'last_access', type: 2, property: { formatter: '0' } },
      { field_name: 'created_at', type: 2, property: { formatter: '0' } },
    ],
  },
  {
    table_name: 'decision',
    envKey: 'BITABLE_TABLE_DECISION',
    fields: [
      { field_name: 'topic', type: 1 },
      { field_name: 'chat_id', type: 1 },
      { field_name: 'decision', type: 1 },
      { field_name: 'rationale', type: 1 },
      { field_name: 'decided_by', type: 1 },
      { field_name: 'decided_at', type: 2, property: { formatter: '0' } },
    ],
  },
  {
    table_name: 'todo',
    envKey: 'BITABLE_TABLE_TODO',
    fields: [
      { field_name: 'title', type: 1 },
      { field_name: 'chat_id', type: 1 },
      { field_name: 'assignee', type: 1 },
      {
        field_name: 'status',
        type: 3,
        property: {
          options: [
            { name: 'open', color: 0 },
            { name: 'in_progress', color: 1 },
            { name: 'done', color: 2 },
          ],
        },
      },
      { field_name: 'due_at', type: 2, property: { formatter: '0' } },
      { field_name: 'created_at', type: 2, property: { formatter: '0' } },
    ],
  },
  {
    table_name: 'knowledge',
    envKey: 'BITABLE_TABLE_KNOWLEDGE',
    fields: [
      { field_name: 'title', type: 1 },
      { field_name: 'chat_id', type: 1 },
      { field_name: 'content', type: 1 },
      { field_name: 'source', type: 1 },
      { field_name: 'created_at', type: 2, property: { formatter: '0' } },
    ],
  },
];

async function main(): Promise<void> {
  console.log('[1/2] 正在让 bot 创建 Bitable base...');
  const created = await client.bitable.v1.app.create({
    data: {
      name: 'Lark Loom 记忆库',
      time_zone: 'Asia/Shanghai',
    },
  });

  if (created.code !== 0 || !created.data?.app?.app_token) {
    console.error('创建 base 失败:', JSON.stringify(created, null, 2));
    process.exit(1);
  }

  const appToken = created.data.app.app_token;
  const baseUrl = created.data.app.url ?? `https://feishu.cn/base/${appToken}`;
  console.log(`     base 已创建：${baseUrl}`);
  console.log(`     app_token: ${appToken}`);

  console.log('[2/2] 正在创建 4 张业务表...');
  const tableIds: Record<string, string> = {};

  for (const spec of TABLES) {
    const res = await client.bitable.v1.appTable.create({
      path: { app_token: appToken },
      data: {
        table: {
          name: spec.table_name,
          default_view_name: 'Grid',
          fields: spec.fields,
        },
      },
    });

    if (res.code !== 0 || !res.data?.table_id) {
      console.error(`     [${spec.table_name}] 失败:`, res.msg, res.data);
      process.exit(1);
    }

    tableIds[spec.envKey] = res.data.table_id;
    console.log(`     [${spec.table_name}] -> ${res.data.table_id}`);
  }

  console.log('');
  console.log('完成。把下面这几行覆盖到 .env，然后重启 bot：');
  console.log('---');
  console.log(`BITABLE_APP_TOKEN=${appToken}`);
  for (const [k, v] of Object.entries(tableIds)) {
    console.log(`${k}=${v}`);
  }
  console.log('---');
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
