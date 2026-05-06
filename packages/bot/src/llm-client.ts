/**
 * LLMClient 实现 — 火山方舟（Doubao）adapter。
 *
 * 约束（来自 contracts/llm.ts + issue）：
 *   - 所有 LLM 调用统一走 ask / chat / askStructured，不允许散落 fetch
 *   - 失败重试 3 次（指数退避 1s / 2s / 4s）
 *   - 单次超时 30s，超时后继续重试
 *   - 全部失败后返回 err 兜底，不崩溃
 *   - 每次调用打日志：模型名 / prompt_tokens / completion_tokens / 耗时
 *   - askStructured 第一次 schema 不符时自动追问一次
 */

import {
  type LLMClient,
  type ChatMessage,
  type AskOptions,
  type SchemaLike,
  type Result,
  type ToolCall,
  type ToolResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  ok,
  err,
  ErrorCode,
  makeError,
} from '@seedhac/contracts';

// ---------- Config ----------

export interface LLMConfig {
  readonly apiKey: string;
  readonly modelIds: {
    readonly lite: string;
    readonly pro: string;
    /** 可选：embedding 模型 ID；配置后启用语义检索，否则降级到字符串匹配 */
    readonly embedding?: string;
  };
  readonly baseUrl?: string;
}

// ---------- Internal types ----------

interface ArkToolCallWire {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ArkMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** assistant + tool_calls 时可省略，让严格 provider 接受 null/缺失语义 */
  content?: string;
  tool_calls?: ArkToolCallWire[];
  tool_call_id?: string;
  name?: string;
}

interface ArkResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ArkToolCallWire[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

interface ArkRawResult {
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
}

type ArkToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };

// ---------- Constants ----------

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MAX_TOOL_CALL_ROUNDS = 5;

// ---------- Utilities ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 剥掉 LLM 常见的 Markdown 代码块包装，再交给 JSON.parse */
function stripCodeFence(raw: string): string {
  const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return match ? match[1]!.trim() : raw.trim();
}

function toArkMessage(m: ChatMessage): ArkMessage {
  // H1/L2: 当 assistant 消息只调工具不说话时，content === ''。
  // OpenAI / Claude 等严格 provider 期望 content === null（Ark 容忍空串）。
  // 这里对 assistant 做特殊处理：有 toolCalls + content 为空 → 省略 content；
  // 其他场景保持 content 字段，避免破坏现有调用。
  const hasToolCalls = m.role === 'assistant' && !!m.toolCalls && m.toolCalls.length > 0;
  const omitContent = hasToolCalls && m.content === '';

  const base: ArkMessage = omitContent
    ? ({ role: m.role } as ArkMessage)
    : { role: m.role, content: m.content };

  if (hasToolCalls) {
    base.tool_calls = m.toolCalls!.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argumentsRaw },
    }));
  }
  if (m.role === 'tool') {
    if (m.toolCallId !== undefined) base.tool_call_id = m.toolCallId;
    if (m.name !== undefined) base.name = m.name;
  }
  return base;
}

function logCall(params: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}): void {
  console.log(
    `[LLMClient] model=${params.model} prompt_tokens=${params.promptTokens} completion_tokens=${params.completionTokens} duration=${params.durationMs}ms`,
  );
}

function toArkToolChoice(toolChoice: AskOptions['toolChoice']): ArkToolChoice {
  if (toolChoice === undefined || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none') return 'none';
  return { type: 'function', function: { name: toolChoice } };
}

// ---------- Implementation ----------

export class VolcanoLLMClient implements LLMClient {
  private readonly config: Required<LLMConfig>;

  constructor(config: LLMConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    };
  }

  private modelId(model: 'lite' | 'pro' = 'pro'): string {
    return this.config.modelIds[model];
  }

  /**
   * 核心调用：带重试（最多 3 次）+ 单次超时（30s），全部失败后返回 err 兜底。
   */
  private async callApi(
    messages: ArkMessage[],
    opts: AskOptions = {},
  ): Promise<Result<ArkRawResult>> {
    const modelId = this.modelId(opts.model ?? 'pro');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const body = JSON.stringify({
      model: modelId,
      messages,
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.tools &&
        opts.tools.length > 0 && {
          tools: opts.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          tool_choice: toArkToolChoice(opts.toolChoice),
        }),
    });

    let lastErr: unknown;
    // H2: 跨 attempt 跟踪是否出现过 AbortError，否则最后一次非 timeout 错误会
    // 把"前面其实是 timeout"的信息掩盖成 LLM_INVALID_RESPONSE，影响调用方降级策略
    let sawTimeout = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const startMs = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }

        const data = (await resp.json()) as ArkResponse;
        const choiceMessage = data.choices[0]?.message;
        const content = choiceMessage?.content ?? '';
        const toolCallsWire = choiceMessage?.tool_calls ?? [];
        const toolCalls: ToolCall[] = toolCallsWire.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          argumentsRaw: tc.function.arguments,
        }));
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;

        logCall({
          model: modelId,
          promptTokens,
          completionTokens,
          durationMs: Date.now() - startMs,
        });

        return ok({ content, toolCalls, promptTokens, completionTokens });
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (e instanceof Error && e.name === 'AbortError') sawTimeout = true;
        if (attempt < 2) await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
      }
    }

    return err(
      makeError(
        sawTimeout ? ErrorCode.LLM_TIMEOUT : ErrorCode.LLM_INVALID_RESPONSE,
        sawTimeout
          ? 'LLM request timed out (at least once) across 3 attempts'
          : 'LLM request failed after 3 attempts',
        lastErr,
      ),
    );
  }

  async ask(prompt: string, opts?: AskOptions): Promise<Result<string>> {
    const messages: ArkMessage[] = [];
    if (opts?.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const result = await this.callApi(messages, opts);
    if (!result.ok) return result;
    return ok(result.value.content);
  }

  async chat(messages: readonly ChatMessage[], opts?: AskOptions): Promise<Result<string>> {
    const arkMessages: ArkMessage[] = messages.map(toArkMessage);
    const result = await this.callApi(arkMessages, opts);
    if (!result.ok) return result;
    return ok(result.value.content);
  }

  async chatWithTools(
    messages: readonly ChatMessage[],
    opts: ChatWithToolsOptions,
  ): Promise<Result<ChatWithToolsResult>> {
    if (!opts.tools || opts.tools.length === 0) {
      return err(
        makeError(ErrorCode.INVALID_INPUT, 'chatWithTools requires opts.tools to be non-empty'),
      );
    }
    const maxRounds = Math.max(1, opts.maxToolCallRounds ?? DEFAULT_MAX_TOOL_CALL_ROUNDS);
    const conversation: ArkMessage[] = messages.map(toArkMessage);
    const allToolCalls: ToolCall[] = [];

    let lastContent = '';
    let rounds = 0;

    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;

      const apiResult = await this.callApi(conversation, opts);
      if (!apiResult.ok) return apiResult;

      const { content, toolCalls } = apiResult.value;
      lastContent = content;

      if (toolCalls.length === 0) {
        // 模型不再请求工具：完成
        return ok({ content, toolCalls: allToolCalls, rounds });
      }

      // 记录 + 把 assistant(toolCalls) 追加到对话历史
      // H1: 同时返回 content + tool_calls 的情况（"我先查一下天气" + tool_call），
      // 仅在 content 非空时回填，避免空串混入对话历史
      allToolCalls.push(...toolCalls);
      const assistantMsg: ArkMessage = {
        role: 'assistant',
        ...(content && { content }),
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsRaw },
        })),
      };
      conversation.push(assistantMsg);

      // 串行执行 tool（避免 BitableClient QPS 风暴），错误隔离到单条 ToolResult
      for (const call of toolCalls) {
        let result: ToolResult;
        const callStartMs = Date.now();
        try {
          result = await opts.executor(call);
        } catch (e) {
          result = {
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({
              error: e instanceof Error ? e.message : String(e),
            }),
          };
        }
        console.log(
          `[LLMClient] tool=${call.name} call_id=${call.id} duration=${Date.now() - callStartMs}ms`,
        );
        conversation.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          name: result.name,
          content: result.content,
        });
      }
      // 进入下一轮：把 tool 结果回灌给模型
    }

    // 达到 maxRounds 仍有 tool_calls 未处理完 → 返回最后一次 content + 历史
    console.warn(`[LLMClient] chatWithTools hit maxRounds=${maxRounds}, returning last content`);
    return ok({ content: lastContent, toolCalls: allToolCalls, rounds });
  }

  async embed(text: string): Promise<Result<readonly number[]>> {
    const embeddingModelId = this.config.modelIds.embedding;
    if (!embeddingModelId) {
      return err(makeError(ErrorCode.CONFIG_MISSING, 'embed: ARK_MODEL_EMBEDDING not configured'));
    }

    const body = JSON.stringify({ model: embeddingModelId, input: text });
    let lastErr: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const resp = await fetch(`${this.config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          const t = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${t}`);
        }
        const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
        const vector = data.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error('embed: empty or missing embedding vector in response');
        }
        return ok(vector as readonly number[]);
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < 2) await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
      }
    }

    return err(
      makeError(ErrorCode.LLM_INVALID_RESPONSE, 'embed: failed after 3 attempts', lastErr),
    );
  }

  async askStructured<T>(
    prompt: string,
    schema: SchemaLike<T>,
    opts?: AskOptions,
  ): Promise<Result<T>> {
    const schemaHint = schema.jsonSchema?.() ?? {};
    const fullPrompt =
      `${prompt}\n\nRespond with valid JSON matching this schema:\n` +
      `${JSON.stringify(schemaHint, null, 2)}\n\nOutput only the JSON, no explanation.`;

    const messages: ArkMessage[] = [];
    if (opts?.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: fullPrompt });

    const result = await this.callApi(messages, opts);
    if (!result.ok) return result;

    // First parse attempt（strip Markdown code fences before parsing）
    try {
      return ok(schema.parse(JSON.parse(stripCodeFence(result.value.content))));
    } catch {
      // Auto-retry once: append assistant reply + corrective user turn
      const retryMessages: ArkMessage[] = [
        ...messages,
        { role: 'assistant', content: result.value.content },
        {
          role: 'user',
          content:
            'Your previous response was not valid JSON matching the schema. Please try again and output only valid JSON.',
        },
      ];

      const retryResult = await this.callApi(retryMessages, opts);
      if (!retryResult.ok) return retryResult;

      try {
        return ok(schema.parse(JSON.parse(stripCodeFence(retryResult.value.content))));
      } catch (e) {
        return err(
          makeError(
            ErrorCode.LLM_INVALID_RESPONSE,
            'askStructured: schema parse failed after retry',
            e,
          ),
        );
      }
    }
  }
}

// ---------- 工厂函数（从环境变量读取配置）----------

export function createLLMClient(): VolcanoLLMClient {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return new VolcanoLLMClient({
    apiKey: required('ARK_API_KEY'),
    modelIds: {
      lite: required('ARK_MODEL_LITE'),
      pro: required('ARK_MODEL_PRO'),
    },
  });
}
