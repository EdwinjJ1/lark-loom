import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  ErrorCode,
  err,
  makeError,
  ok,
  type Result,
  type SlideCard,
  type SlidesClient,
  type SlidesOutline,
  type SlidesRef,
} from '@seedhac/contracts';

type ExecFileResult = { stdout: string; stderr: string };
type ExecFile = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; maxBuffer?: number },
) => Promise<ExecFileResult>;

const execFile = promisify(execFileCallback) as ExecFile;

export interface LarkSlidesClientOptions {
  readonly bin?: string;
  readonly as?: 'user' | 'bot';
  readonly baseUrl?: string;
  readonly execFile?: ExecFile;
}

export class LarkSlidesClient implements SlidesClient {
  private readonly bin: string;
  private readonly binArgs: readonly string[];
  private readonly as: 'user' | 'bot';
  private readonly baseUrl: string;
  private readonly execFile: ExecFile;

  constructor(options: LarkSlidesClientOptions = {}) {
    const resolvedBin = options.bin ?? 'lark-cli';
    if (resolvedBin.endsWith('.js')) {
      this.bin = process.execPath;
      this.binArgs = [resolvedBin];
    } else {
      this.bin = resolvedBin;
      this.binArgs = [];
    }
    // 默认用 bot 身份：bot 创建 = bot owns，可直接给团队成员授权，
    // 无需任何人登录 lark-cli 也无需补 user OAuth scope。lark-cli 在
    // bot 模式下还会自动把当前 cli 登录用户加为 full_access。
    this.as = options.as ?? 'bot';
    this.baseUrl = options.baseUrl ?? 'https://feishu.cn';
    this.execFile = options.execFile ?? execFile;
  }

  async createFromOutline(title: string, outline: SlidesOutline): Promise<Result<SlidesRef>> {
    const slides = outline.slides.map((slide, index) => renderSlideXml(slide, index));
    if (!slides.length) {
      return err(
        makeError(ErrorCode.INVALID_INPUT, 'slides outline must contain at least one page'),
      );
    }

    try {
      const { stdout, stderr } = await this.execFile(
        this.bin,
        [
          ...this.binArgs,
          'slides',
          '+create',
          '--as',
          this.as,
          '--title',
          title,
          '--slides',
          JSON.stringify(slides),
        ],
        { maxBuffer: 1024 * 1024 * 10 },
      );

      const ref = parseSlidesRef(stdout, this.baseUrl);
      if (!ref) {
        return err(
          makeError(
            ErrorCode.FEISHU_API_ERROR,
            'lark-cli did not return a slides url or xml_presentation_id',
            undefined,
            { stdout, stderr },
          ),
        );
      }

      return ok(ref);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return err(
        makeError(ErrorCode.FEISHU_API_ERROR, `lark-cli slides +create failed: ${message}`),
      );
    }
  }

  async grantMembersEdit(slidesToken: string, userIds: readonly string[]): Promise<Result<void>> {
    if (userIds.length === 0) return ok(undefined);

    for (const userId of userIds) {
      try {
        const { stdout, stderr } = await this.execFile(
          this.bin,
          [
            ...this.binArgs,
            'drive',
            'permission.members',
            'create',
            '--as',
            this.as,
            '--params',
            JSON.stringify({
              token: slidesToken,
              type: 'slides',
              need_notification: false,
            }),
            '--data',
            JSON.stringify({
              member_type: 'openid',
              member_id: userId,
              perm: 'edit',
            }),
            '--yes',
          ],
          { maxBuffer: 1024 * 1024 },
        );

        const parsed = parseJsonOutput(stdout);
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>;
          if (record['ok'] === false || (typeof record['code'] === 'number' && record['code'] !== 0)) {
            return err(
              makeError(
                ErrorCode.FEISHU_API_ERROR,
                `lark-cli drive permission.members create failed for ${userId}`,
                undefined,
                { stdout, stderr },
              ),
            );
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          makeError(
            ErrorCode.FEISHU_API_ERROR,
            `grant slides member permission failed for ${userId}: ${message}`,
          ),
        );
      }
    }

    return ok(undefined);
  }
}

const THEME = {
  ink: 'rgb(17,24,39)',
  slate: 'rgb(71,85,105)',
  muted: 'rgb(100,116,139)',
  line: 'rgb(215,222,232)',
  paper: 'rgb(251,252,255)',
  blue: 'rgb(36,91,255)',
  green: 'rgb(22,163,74)',
  amber: 'rgb(217,119,6)',
  red: 'rgb(220,38,38)',
  softBlue: 'rgb(238,244,255)',
  softGreen: 'rgb(236,253,245)',
  softAmber: 'rgb(255,247,237)',
  softRed: 'rgb(255,241,242)',
  white: 'rgb(255,255,255)',
} as const;

function renderSlideXml(slide: SlidesOutline['slides'][number], index: number): string {
  return [
    '<slide xmlns="http://www.larkoffice.com/sml/2.0">',
    `<style><fill><fillColor color="${THEME.paper}"/></fill></style>`,
    '<data>',
    ...renderNativeShapes(slide, index),
    '</data>',
    '</slide>',
  ].join('');
}

function renderNativeShapes(slide: SlidesOutline['slides'][number], index: number): string[] {
  const accent = accentForSlide(slide.type);
  const shapes = [
    rect(0, 0, 960, 540, THEME.paper),
    rect(0, 0, 18, 540, accent),
    rect(72, 52, 96, 8, accent),
    text(slide.title, 72, 78, 760, 76, 'title'),
    text(`第 ${index + 1} 页`, 836, 56, 72, 30, 'caption'),
  ];

  if (slide.type === 'cover') {
    return [
      ...shapes,
      text(slide.subtitle ?? slide.bullets?.[0] ?? '项目阶段性进展汇报', 76, 190, 720, 58, 'body'),
      rect(72, 308, 760, 2, THEME.line),
      text('Agent-Pilot Office Copilot', 76, 350, 520, 38, 'caption'),
    ];
  }

  if (slide.type === 'timeline') {
    const milestones = (
      slide.milestones?.length
        ? slide.milestones
        : normalizeCards(slide).map((card) => ({
            label: card.title,
            ...(card.value && { date: card.value }),
            ...(card.detail && { status: card.detail }),
          }))
    ).slice(0, 5);
    return [
      ...shapes,
      ...milestones.flatMap((item, i) => [
        rect(92, 156 + i * 70, 18, 18, accent),
        text(item.date ?? `阶段 ${i + 1}`, 132, 150 + i * 70, 120, 34, 'caption'),
        text(item.label, 268, 148 + i * 70, 360, 38, 'body'),
        text(item.status ?? '', 650, 150 + i * 70, 190, 34, 'caption'),
      ]),
    ];
  }

  if (slide.type === 'risks') {
    const risks = (
      slide.risks?.length
        ? slide.risks
        : normalizeCards(slide).map((card) => ({
            risk: card.title,
            impact: card.value ?? '影响待评估',
            mitigation: card.detail ?? '持续跟进',
          }))
    ).slice(0, 3);
    return [
      ...shapes,
      rect(72, 142, 800, 42, THEME.softRed),
      text('风险', 96, 151, 160, 26, 'caption'),
      text('影响', 360, 151, 160, 26, 'caption'),
      text('应对', 620, 151, 160, 26, 'caption'),
      ...risks.flatMap((item, i) => [
        rect(72, 210 + i * 88, 800, 58, i % 2 === 0 ? THEME.white : THEME.softRed),
        rect(72, 210 + i * 88, 8, 58, accent),
        text(item.risk, 96, 222 + i * 88, 230, 34, 'body'),
        text(item.impact, 360, 222 + i * 88, 220, 34, 'body'),
        text(item.mitigation, 620, 222 + i * 88, 230, 34, 'body'),
      ]),
    ];
  }

  if (slide.type === 'nextSteps') {
    const tasks = (
      slide.tasks?.length
        ? slide.tasks
        : normalizeCards(slide).map((card) => ({
            owner: card.value ?? slide.presenterName ?? '待定',
            task: card.title,
            ...(card.detail && { due: card.detail }),
          }))
    ).slice(0, 5);
    return [
      ...shapes,
      rect(72, 142, 800, 42, THEME.softAmber),
      text('负责人', 96, 151, 160, 26, 'caption'),
      text('行动项', 260, 151, 440, 26, 'caption'),
      text('截止', 735, 151, 120, 26, 'caption'),
      ...tasks.flatMap((item, i) => [
        rect(72, 204 + i * 62, 800, 44, i % 2 === 0 ? THEME.white : THEME.softAmber),
        rect(72, 204 + i * 62, 8, 44, accent),
        text(item.owner, 96, 214 + i * 62, 132, 28, 'caption'),
        text(item.task, 260, 212 + i * 62, 420, 30, 'body'),
        text(item.due ?? '待定', 735, 214 + i * 62, 120, 28, 'caption'),
      ]),
    ];
  }

  const cards = normalizeCards(slide).slice(0, 5);
  const bullets = slide.type === 'closing' && slide.bullets?.length ? slide.bullets : undefined;
  return [
    ...shapes,
    ...(bullets
      ? bullets.slice(0, 4).flatMap((item, i) => bullet(item, 86, 176 + i * 62, accent))
      : cards.flatMap((card, i) => cardShape(card, 76 + (i % 2) * 402, 154 + Math.floor(i / 2) * 118, accent))),
    ...(slide.presenterName ? [text(`汇报人：${slide.presenterName}`, 72, 480, 300, 28, 'caption')] : []),
  ];
}

function accentForSlide(type: SlidesOutline['slides'][number]['type']): string {
  switch (type) {
    case 'timeline':
      return THEME.green;
    case 'risks':
      return THEME.red;
    case 'nextSteps':
      return THEME.amber;
    default:
      return THEME.blue;
  }
}

function cardShape(card: SlideCard, x: number, y: number, accent: string): string[] {
  return [
    rect(x, y, 360, 82, THEME.white),
    rect(x, y, 8, 82, accent),
    text(card.value ?? '', x + 28, y + 14, 90, 26, 'caption'),
    text(card.title, x + 126, y + 12, 190, 30, 'body'),
    text(card.detail ?? '', x + 126, y + 48, 200, 24, 'caption'),
  ];
}

function bullet(value: string, x: number, y: number, accent: string): string[] {
  return [rect(x, y + 8, 10, 10, accent), text(value, x + 28, y, 700, 34, 'body')];
}

function rect(x: number, y: number, width: number, height: number, fill: string): string {
  return `<shape type="rect" topLeftX="${x}" topLeftY="${y}" width="${width}" height="${height}"><style><fill><fillColor color="${fill}"/></fill></style></shape>`;
}

function text(
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  textType: 'title' | 'body' | 'caption',
): string {
  if (!value.trim()) return '';
  return `<shape type="text" topLeftX="${x}" topLeftY="${y}" width="${width}" height="${height}"><content textType="${textType}"><p>${escapeXml(value)}</p></content></shape>`;
}

function normalizeCards(slide: SlidesOutline['slides'][number]): SlideCard[] {
  if (slide.cards?.length) return [...slide.cards];
  const bullets = slide.bullets?.length ? slide.bullets : [];
  return bullets.length
    ? bullets.map((bulletText, index) => ({ title: bulletText, value: `0${index + 1}` }))
    : [{ title: slide.subtitle ?? slide.title, value: '01' }];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseSlidesRef(output: string, baseUrl: string): SlidesRef | undefined {
  const parsed = parseJsonOutput(output);
  const url = parsed
    ? findString(parsed, (value) => /https?:\/\/\S+\/slides\//.test(value))
    : undefined;
  const xmlPresentationId = parsed ? findStringByKey(parsed, 'xml_presentation_id') : undefined;
  const tokenFromJson = parsed
    ? findString(parsed, (value) => /^[A-Za-z0-9_-]{8,}$/.test(value) && !value.startsWith('http'))
    : undefined;
  const urlFromText = output.match(/https?:\/\/\S+\/slides\/[A-Za-z0-9_-]+/)?.[0];
  const finalUrl = stripTrailingPunctuation(url ?? urlFromText);
  const slidesToken = extractTokenFromUrl(finalUrl ?? '') ?? xmlPresentationId ?? tokenFromJson;
  if (!slidesToken) return undefined;

  return {
    slidesToken,
    url: finalUrl ?? `${baseUrl.replace(/\/$/, '')}/slides/${slidesToken}`,
  };
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) return undefined;
    try {
      return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    } catch {
      return undefined;
    }
  }
}

function findString(value: unknown, predicate: (value: string) => boolean): string | undefined {
  if (typeof value === 'string') return predicate(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      const found = findString(item, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record[key] === 'string') return record[key];
    for (const item of Object.values(record)) {
      const found = findStringByKey(item, key);
      if (found) return found;
    }
  }
  return undefined;
}

function stripTrailingPunctuation(value: string | undefined): string | undefined {
  return value?.replace(/[),.;\]]+$/, '');
}

function extractTokenFromUrl(url: string): string | undefined {
  return url.match(/\/slides\/([A-Za-z0-9_-]+)/)?.[1];
}

export function resolveLarkCliBin(): string {
  const fromEnv = process.env['LARK_CLI_BIN'];
  if (fromEnv) return fromEnv;

  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@larksuite/cli/package.json');
    const binRelative = join(dirname(pkgPath), 'scripts', 'run.js');
    if (existsSync(binRelative)) return binRelative;
  } catch {
    // fall through to PATH lookup
  }

  return 'lark-cli';
}

export function createSlidesClient(): LarkSlidesClient {
  const bin = resolveLarkCliBin();
  const as = process.env['LARK_SLIDES_CLI_AS'];
  const baseUrl = process.env['LARK_SLIDES_BASE_URL'];
  return new LarkSlidesClient({
    bin,
    ...(as === 'bot' || as === 'user' ? { as } : {}),
    ...(baseUrl && { baseUrl }),
  });
}
