/**
 * 直查 memory 表，确认记忆是否真实写入。
 */

import * as lark from '@larksuiteoapi/node-sdk';

const APP_ID = process.env['LARK_APP_ID']!;
const APP_SECRET = process.env['LARK_APP_SECRET']!;
const APP_TOKEN = process.env['BITABLE_APP_TOKEN']!;
const TABLE_ID = process.env['BITABLE_TABLE_MEMORY']!;

if (!APP_ID || !APP_SECRET || !APP_TOKEN || !TABLE_ID) {
  console.error('缺 env');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

async function main(): Promise<void> {
  const r = await client.bitable.v1.appTableRecord.list({
    path: { app_token: APP_TOKEN, table_id: TABLE_ID },
    params: { page_size: 20 },
  });
  console.log('code:', r.code, 'msg:', r.msg);
  console.log('total records:', r.data?.total ?? 0);
  console.log('items:', JSON.stringify(r.data?.items ?? [], null, 2));
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
