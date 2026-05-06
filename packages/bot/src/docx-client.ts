/* eslint-disable @typescript-eslint/no-explicit-any */
import * as lark from '@larksuiteoapi/node-sdk';
import {
  ErrorCode,
  err,
  makeError,
  ok,
  type DocBlock,
  type DocRef,
  type DocxClient,
  type Result,
} from '@seedhac/contracts';

export class LarkDocxClient implements DocxClient {
  constructor(private readonly client: lark.Client) {}

  async create(title: string): Promise<Result<DocRef>> {
    try {
      const res = await this.client.docx.v1.document.create({
        data: { title },
      });

      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `create document failed: ${res.msg}`));
      }

      const docToken = res.data?.document?.document_id;
      if (!docToken) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, 'no document_id returned'));
      }

      return ok({
        docToken,
        url: `https://feishu.cn/docx/${docToken}`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `create document error: ${msg}`));
    }
  }

  async appendBlocks(docToken: string, blocks: readonly DocBlock[]): Promise<Result<void>> {
    // 飞书 documentBlockChildren.create 单次推荐 ≤ 50 blocks，超量会 400 field_violations
    // 用 30 留安全冗余 + 13 字段 PRD 通常 50-60 blocks 需要 2 批
    const BATCH_SIZE = 30;
    // 防御：跳过空文本，飞书拒绝空 text_run
    const safeBlocks = blocks.filter((b) => b.text && b.text.trim().length > 0);

    const childrenAll = safeBlocks.map((block) => {
      switch (block.type) {
        case 'heading1':
          return {
            block_type: 3,
            heading1: { elements: [{ text_run: { content: block.text } }] },
          };
        case 'heading2':
          return {
            block_type: 4,
            heading2: { elements: [{ text_run: { content: block.text } }] },
          };
        case 'paragraph':
          return { block_type: 2, text: { elements: [{ text_run: { content: block.text } }] } };
        case 'bullet':
          return {
            block_type: 12,
            bullet: { elements: [{ text_run: { content: block.text } }] },
          };
      }
    });

    for (let i = 0; i < childrenAll.length; i += BATCH_SIZE) {
      const batch = childrenAll.slice(i, i + BATCH_SIZE);
      try {
        const res = await (this.client.docx.v1.documentBlockChildren as any).create({
          path: { document_id: docToken, block_id: docToken },
          data: { children: batch },
        });

        if (res.code !== 0) {
          // 详细错误信息（含 field_violations）方便定位具体哪个 block 被拒
          const fieldViolations = (res as { field_violations?: unknown }).field_violations;
          return err(
            makeError(
              ErrorCode.FEISHU_API_ERROR,
              `append blocks failed (batch ${i / BATCH_SIZE + 1}): ${res.msg}`,
              undefined,
              { batchSize: batch.length, fieldViolations },
            ),
          );
        }
      } catch (e: unknown) {
        // axios 错误带 response.data，里面通常有 field_violations
        const err2 = e as {
          message?: string;
          response?: { data?: { msg?: string; field_violations?: unknown } };
        };
        const baseMsg = err2.message ?? String(e);
        const apiMsg = err2.response?.data?.msg;
        const fieldViolations = err2.response?.data?.field_violations;
        return err(
          makeError(
            ErrorCode.FEISHU_API_ERROR,
            `append blocks error (batch ${i / BATCH_SIZE + 1}): ${apiMsg ?? baseMsg}`,
            undefined,
            { batchIndex: i / BATCH_SIZE + 1, batchSize: batch.length, fieldViolations },
          ),
        );
      }
    }

    return ok(undefined);
  }

  async getShareLink(docToken: string): Promise<Result<string>> {
    try {
      const res = await (this.client.drive.v1.permissionPublic as any).patch({
        params: { type: 'docx' },
        path: { token: docToken },
        data: { link_share_entity: 'tenant_readable' },
      });

      if (res.code !== 0) {
        return err(
          makeError(ErrorCode.FEISHU_API_ERROR, `set share permission failed: ${res.msg}`),
        );
      }

      return ok(`https://feishu.cn/docx/${docToken}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `get share link error: ${msg}`));
    }
  }

  async grantMembersEdit(token: string, type: 'docx' | 'slides', userIds: readonly string[]): Promise<Result<void>> {
    for (const memberId of userIds) {
      try {
        const res = await (this.client.drive.v1.permissionMember as any).create({
          path: { token },
          params: { type, need_notification: false },
          data: { member_type: 'openid', member_id: memberId, perm: 'edit' },
        });
        if (res.code !== 0) {
          return err(makeError(ErrorCode.FEISHU_API_ERROR, `grantMembersEdit failed for ${memberId}: ${res.msg}`));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `grantMembersEdit error: ${msg}`, e));
      }
    }
    return ok(undefined);
  }

  private async readDocxRawContent(token: string): Promise<Result<string>> {
    try {
      const res = await (
        this.client.docx.v1.document as unknown as {
          rawContent: (
            p: unknown,
          ) => Promise<{ code?: number; msg?: string; data?: { content?: string } }>;
        }
      ).rawContent({
        path: { document_id: token },
        params: { lang: 0 },
      });
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `readContent failed: ${res.msg}`));
      }
      return ok(res.data?.content ?? '');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `readContent error: ${msg}`, e));
    }
  }

  private async resolveWikiNode(token: string): Promise<
    Result<{
      objToken: string;
      objType: 'doc' | 'docx' | 'sheet' | 'mindnote' | 'bitable' | 'file' | 'slides';
      title?: string;
    }>
  > {
    try {
      const res = await this.client.wiki.v2.space.getNode({
        params: { token, obj_type: 'wiki' },
      });
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `resolve wiki failed: ${res.msg}`));
      }
      const node = res.data?.node;
      if (!node?.obj_token || !node.obj_type) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, 'resolve wiki failed: empty node'));
      }
      return ok({
        objToken: node.obj_token,
        objType: node.obj_type,
        ...(node.title ? { title: node.title } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `resolve wiki error: ${msg}`, e));
    }
  }

  private async readDriveTitle(
    token: string,
    kind: 'doc' | 'docx' | 'wiki' | 'slides',
  ): Promise<Result<string>> {
    try {
      const res = await this.client.drive.v1.meta.batchQuery({
        data: {
          request_docs: [{ doc_token: token, doc_type: kind }],
          with_url: true,
        },
      });
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `read meta failed: ${res.msg}`));
      }
      const title = res.data?.metas?.[0]?.title;
      return ok(title ? `标题：${title}` : '');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `read meta error: ${msg}`, e));
    }
  }

  async readContent(
    token: string,
    kind: 'doc' | 'wiki' | 'slides' = 'doc',
  ): Promise<Result<string>> {
    if (kind === 'wiki') {
      const node = await this.resolveWikiNode(token);
      if (!node.ok) return node;
      if (node.value.objType === 'doc' || node.value.objType === 'docx') {
        const raw = await this.readDocxRawContent(node.value.objToken);
        if (!raw.ok) return raw;
        const title = node.value.title ? `标题：${node.value.title}\n` : '';
        return ok(`${title}${raw.value}`);
      }
      if (node.value.objType === 'slides') {
        const title = node.value.title ? `标题：${node.value.title}` : '';
        if (title) return ok(title);
        return this.readDriveTitle(node.value.objToken, 'slides');
      }
      return ok(node.value.title ? `标题：${node.value.title}` : '');
    }

    if (kind === 'slides') {
      const title = await this.readDriveTitle(token, 'slides');
      if (title.ok && title.value.trim()) return title;
      return this.readDocxRawContent(token);
    }

    return this.readDocxRawContent(token);
  }

  async createFromMarkdown(title: string, markdown: string): Promise<Result<DocRef>> {
    const lines = markdown.split('\n');
    const blocks: DocBlock[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('# ')) {
        blocks.push({ type: 'heading1', text: trimmed.substring(2) });
      } else if (trimmed.startsWith('## ')) {
        blocks.push({ type: 'heading2', text: trimmed.substring(3) });
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        blocks.push({ type: 'bullet', text: trimmed.substring(2) });
      } else {
        blocks.push({ type: 'paragraph', text: trimmed });
      }
    }

    const createRes = await this.create(title);
    if (!createRes.ok) {
      return createRes;
    }

    const docToken = createRes.value.docToken;
    const appendRes = await this.appendBlocks(docToken, blocks);

    if (!appendRes.ok) {
      return err(makeError(ErrorCode.FEISHU_API_ERROR, appendRes.error.message));
    }

    return ok(createRes.value);
  }

  /**
   * 在指定 H2 section 末尾追加 blocks（issue #120）。
   *
   * 飞书 docx 是 flat children 结构（H2 不会"包含"它后面的段落，是 sibling）。
   * 实现思路：
   *   1. 列出 doc 顶层 children
   *   2. 找到 sectionTitle 对应的 heading2 block index
   *   3. 找下一个 heading2 的 index（或 children 长度，如果是最后一段）
   *   4. 调 documentBlockChildren.create 时传 index = nextH2Index
   *      → 新 blocks 插入到下一个 H2 之前 = 当前 section 末尾
   *
   * 找不到 section → 退化为 appendBlocks（追加到文档末尾）+ warn level 不报错。
   */
  async appendToSection(
    docToken: string,
    sectionTitle: string,
    blocks: readonly DocBlock[],
  ): Promise<Result<void>> {
    if (blocks.length === 0) return ok(undefined);

    // 1. 列出 doc 顶层 children
    let children: Array<{ block_id?: string; block_type?: number; heading2?: { elements?: Array<{ text_run?: { content?: string } }> } }> = [];
    try {
      const res = await (this.client.docx.v1.documentBlockChildren as any).list({
        path: { document_id: docToken, block_id: docToken },
        params: { page_size: 200 },
      });
      if (res.code !== 0) {
        // 列表失败也别死，降级为整体 append
        return this.appendBlocks(docToken, blocks);
      }
      children = res.data?.items ?? [];
    } catch {
      return this.appendBlocks(docToken, blocks);
    }

    // 2. 找 sectionTitle 对应的 H2 index
    // block_type 4 = heading2
    let sectionIdx = -1;
    let nextH2Idx = children.length;
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.block_type === 4) {
        const txt = c.heading2?.elements?.[0]?.text_run?.content ?? '';
        if (sectionIdx < 0 && txt === sectionTitle) {
          sectionIdx = i;
        } else if (sectionIdx >= 0) {
          nextH2Idx = i;
          break;
        }
      }
    }

    if (sectionIdx < 0) {
      // 找不到 section，退化为整体 append
      return this.appendBlocks(docToken, blocks);
    }

    // 3. 构造 children payload + 调 create with index
    const safeBlocks = blocks.filter((b) => b.text && b.text.trim().length > 0);
    if (safeBlocks.length === 0) return ok(undefined);

    const childrenPayload = safeBlocks.map((block) => {
      switch (block.type) {
        case 'heading1':
          return { block_type: 3, heading1: { elements: [{ text_run: { content: block.text } }] } };
        case 'heading2':
          return { block_type: 4, heading2: { elements: [{ text_run: { content: block.text } }] } };
        case 'paragraph':
          return { block_type: 2, text: { elements: [{ text_run: { content: block.text } }] } };
        case 'bullet':
          return { block_type: 12, bullet: { elements: [{ text_run: { content: block.text } }] } };
      }
    });

    try {
      const res = await (this.client.docx.v1.documentBlockChildren as any).create({
        path: { document_id: docToken, block_id: docToken },
        data: { children: childrenPayload, index: nextH2Idx },
      });
      if (res.code !== 0) {
        return err(
          makeError(ErrorCode.FEISHU_API_ERROR, `appendToSection failed: ${res.msg}`),
        );
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `appendToSection error: ${msg}`, e));
    }
  }

  /**
   * 用新 blocks 替换某个 H2 section 下的所有内容（issue #120）。
   *
   * 步骤：
   *   1. 列出 doc 顶层 children
   *   2. 找 sectionTitle 对应的 H2 index
   *   3. 找下一个 H2 index（或 children 长度，如果是最后一段）
   *   4. 收集 [sectionIdx + 1, nextH2Idx) 之间的 block_ids
   *   5. batchDelete 这些 block
   *   6. documentBlockChildren.create with index = sectionIdx + 1 插入新 blocks
   */
  async replaceSection(
    docToken: string,
    sectionTitle: string,
    blocks: readonly DocBlock[],
  ): Promise<Result<void>> {
    // 1 + 2 + 3：列 children，找 section 边界
    let children: Array<{
      block_id?: string;
      block_type?: number;
      heading2?: { elements?: Array<{ text_run?: { content?: string } }> };
    }> = [];
    try {
      const res = await (this.client.docx.v1.documentBlockChildren as any).list({
        path: { document_id: docToken, block_id: docToken },
        params: { page_size: 200 },
      });
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `replaceSection list failed: ${res.msg}`));
      }
      children = res.data?.items ?? [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `replaceSection list error: ${msg}`, e));
    }

    let sectionIdx = -1;
    let nextH2Idx = children.length;
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.block_type === 4) {
        const txt = c.heading2?.elements?.[0]?.text_run?.content ?? '';
        if (sectionIdx < 0 && txt === sectionTitle) {
          sectionIdx = i;
        } else if (sectionIdx >= 0) {
          nextH2Idx = i;
          break;
        }
      }
    }
    if (sectionIdx < 0) {
      return err(
        makeError(ErrorCode.INVALID_INPUT, `replaceSection: section "${sectionTitle}" not found`),
      );
    }

    // 4: 收集要删除的 block_ids（section H2 之后，next H2 之前）
    const toDelete: string[] = [];
    for (let i = sectionIdx + 1; i < nextH2Idx; i++) {
      const id = children[i]?.block_id;
      if (id) toDelete.push(id);
    }

    // 5: batchDelete（如果有要删的）
    if (toDelete.length > 0) {
      try {
        const delRes = await (this.client.docx.v1.documentBlockChildren as any).batchDelete({
          path: { document_id: docToken, block_id: docToken },
          data: { start_index: sectionIdx + 1, end_index: nextH2Idx },
        });
        if (delRes.code !== 0) {
          return err(
            makeError(
              ErrorCode.FEISHU_API_ERROR,
              `replaceSection batchDelete failed: ${delRes.msg}`,
            ),
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(
          makeError(ErrorCode.FEISHU_API_ERROR, `replaceSection batchDelete error: ${msg}`, e),
        );
      }
    }

    // 6: 插入新 blocks（如果有）
    const safeBlocks = blocks.filter((b) => b.text && b.text.trim().length > 0);
    if (safeBlocks.length === 0) return ok(undefined);

    const childrenPayload = safeBlocks.map((block) => {
      switch (block.type) {
        case 'heading1':
          return { block_type: 3, heading1: { elements: [{ text_run: { content: block.text } }] } };
        case 'heading2':
          return { block_type: 4, heading2: { elements: [{ text_run: { content: block.text } }] } };
        case 'paragraph':
          return { block_type: 2, text: { elements: [{ text_run: { content: block.text } }] } };
        case 'bullet':
          return { block_type: 12, bullet: { elements: [{ text_run: { content: block.text } }] } };
      }
    });

    try {
      const res = await (this.client.docx.v1.documentBlockChildren as any).create({
        path: { document_id: docToken, block_id: docToken },
        data: { children: childrenPayload, index: sectionIdx + 1 },
      });
      if (res.code !== 0) {
        return err(
          makeError(ErrorCode.FEISHU_API_ERROR, `replaceSection insert failed: ${res.msg}`),
        );
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `replaceSection insert error: ${msg}`, e));
    }
  }

  /**
   * 改文档标题（issue #120 P6）。
   *
   * 飞书 docx：文档显示的标题来自首个 H1 block 的内容。改 H1 = 改标题。
   * 步骤：list 顶层 children → 找首个 block_type === 3 (heading1) → batchUpdate
   * 把它的 elements 改成 [{ text_run: { content: newTitle } }]。
   */
  async renameTitle(docToken: string, newTitle: string): Promise<Result<void>> {
    if (!newTitle.trim()) return ok(undefined);

    // 找首个 H1 block_id
    let h1BlockId: string | undefined;
    try {
      const res = await (this.client.docx.v1.documentBlockChildren as any).list({
        path: { document_id: docToken, block_id: docToken },
        params: { page_size: 50 },
      });
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `renameTitle list failed: ${res.msg}`));
      }
      const items =
        (res.data?.items ?? []) as Array<{ block_id?: string; block_type?: number }>;
      const h1 = items.find((c) => c.block_type === 3);
      h1BlockId = h1?.block_id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `renameTitle list error: ${msg}`, e));
    }
    if (!h1BlockId) {
      return err(makeError(ErrorCode.INVALID_INPUT, 'renameTitle: no H1 block found'));
    }

    // batchUpdate 改 H1 文本
    try {
      const res = await (this.client.docx.v1.documentBlock as any).batchUpdate({
        path: { document_id: docToken },
        data: {
          requests: [
            {
              block_id: h1BlockId,
              update_text_elements: {
                elements: [{ text_run: { content: newTitle } }],
              },
            },
          ],
        },
      });
      if (res.code !== 0) {
        return err(makeError(ErrorCode.FEISHU_API_ERROR, `renameTitle update failed: ${res.msg}`));
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(makeError(ErrorCode.FEISHU_API_ERROR, `renameTitle update error: ${msg}`, e));
    }
  }
}

export function createDocxClient(): LarkDocxClient {
  const appId = process.env['LARK_APP_ID'];
  const appSecret = process.env['LARK_APP_SECRET'];
  if (!appId) throw new Error('Missing required env var: LARK_APP_ID');
  if (!appSecret) throw new Error('Missing required env var: LARK_APP_SECRET');

  const client = new lark.Client({ appId, appSecret });
  return new LarkDocxClient(client);
}
