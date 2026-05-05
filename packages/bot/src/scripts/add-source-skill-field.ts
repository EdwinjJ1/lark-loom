/**
 * 一次性脚本：给 memory 表补 source_skill 字段（bootstrap-bitable 漏建的）。
 * MemoryStore.write 的 row 包含 source_skill，缺这列写入会失败。
 */

import * as lark from '@larksuiteoapi/node-sdk';

const APP_ID = process.env['LARK_APP_ID']!;
const APP_SECRET = process.env['LARK_APP_SECRET']!;
const APP_TOKEN = process.env['BITABLE_APP_TOKEN']!;
const TABLE_ID = process.env['BITABLE_TABLE_MEMORY']!;

if (!APP_ID || !APP_SECRET || !APP_TOKEN || !TABLE_ID) {
  console.error('缺 env (LARK_APP_ID / LARK_APP_SECRET / BITABLE_APP_TOKEN / BITABLE_TABLE_MEMORY)');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

async function main(): Promise<void> {
  const res = await client.bitable.v1.appTableField.create({
    path: { app_token: APP_TOKEN, table_id: TABLE_ID },
    data: { field_name: 'source_skill', type: 1 },
  });
  if (res.code !== 0) {
    console.error('failed:', res.code, res.msg);
    process.exit(1);
  }
  console.log('✅ source_skill field added:', res.data?.field?.field_id);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
