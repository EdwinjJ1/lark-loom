import type { Result } from './result.js';

export interface DocRef {
  readonly docToken: string;
  readonly url: string;
}

export type DocBlock =
  | { type: 'heading1'; text: string }
  | { type: 'heading2'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string };

export interface DocxClient {
  create(title: string): Promise<Result<DocRef>>;
  appendBlocks(docToken: string, blocks: readonly DocBlock[]): Promise<Result<void>>;
  getShareLink(docToken: string): Promise<Result<string>>;
  /** 解析 markdown，调 create + appendBlocks，一步完成 */
  createFromMarkdown(title: string, markdown: string): Promise<Result<DocRef>>;
  /** 读取文档 / wiki / 幻灯片的纯文本内容 */
  readContent(token: string, kind?: 'doc' | 'wiki' | 'slides'): Promise<Result<string>>;
  /** 将指定用户加为 Drive 文件的编辑协作者 */
  grantMembersEdit(token: string, type: 'docx' | 'slides', userIds: readonly string[]): Promise<Result<void>>;
  /**
   * 在文档某个 H2 section 末尾追加 blocks（issue #120 项目核心文档）。
   * 找到匹配 sectionTitle 的 heading2 block，把 blocks 插入到下一个 heading2
   * 之前（即该 section 内容的末尾）。
   * - 找不到 section → 退化为 appendBlocks（追加到文档末尾）+ warn
   */
  appendToSection(
    docToken: string,
    sectionTitle: string,
    blocks: readonly DocBlock[],
  ): Promise<Result<void>>;
}
