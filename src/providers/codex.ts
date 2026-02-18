import type { LLMProvider, LLMResponse, ToolCallRequest } from "./base";
import { getCodexToken } from "./codex-auth";
import { createHash } from "crypto";

const DEFAULT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_ORIGINATOR = "robun";

export class OpenAICodexProvider implements LLMProvider {
  private defaultModel: string;

  constructor(defaultModel = "openai-codex/gpt-5.1-codex") {
    this.defaultModel = defaultModel;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    options: {
      model?: string;
      tools?: unknown[];
      maxTokens?: number;
      temperature?: number;
    } = {},
  ): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    const { systemPrompt, inputItems } = convertMessages(messages);

    const token = await getCodexToken();
    const headers = buildHeaders(token.accountId, token.access);

    const body: Record<string, unknown> = {
      model: stripModelPrefix(model),
      store: false,
      stream: false,
      instructions: systemPrompt,
      input: inputItems,
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: promptCacheKey(messages),
      tool_choice: "auto",
      parallel_tool_calls: true,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = convertTools(options.tools as Array<Record<string, unknown>>);
    }

    try {
      const { content, toolCalls, finishReason } = await requestCodex(
        DEFAULT_CODEX_URL,
        headers,
        body,
      );
      return {
        content,
        toolCalls,
        finishReason: finishReason as LLMResponse["finishReason"],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        reasoningContent: null,
      };
    } catch (err) {
      return {
        content: `Error calling Codex: ${err instanceof Error ? err.message : String(err)}`,
        toolCalls: [],
        finishReason: "error",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        reasoningContent: null,
      };
    }
  }
}

function stripModelPrefix(model: string): string {
  if (model.startsWith("openai-codex/")) {
    return model.split("/", 2)[1]!;
  }
  return model;
}

function buildHeaders(accountId: string, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: DEFAULT_ORIGINATOR,
    "User-Agent": "robun (typescript)",
    accept: "application/json",
    "content-type": "application/json",
  };
}

function convertTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    const fn =
      tool.type === "function" ? (tool.function as Record<string, unknown>) ?? {} : tool;
    const name = fn.name as string | undefined;
    if (!name) continue;
    const params = fn.parameters ?? {};
    converted.push({
      type: "function",
      name,
      description: (fn.description as string) ?? "",
      parameters: typeof params === "object" ? params : {},
    });
  }
  return converted;
}

function convertMessages(messages: Array<{ role: string; content: string }>): {
  systemPrompt: string;
  inputItems: Array<Record<string, unknown>>;
} {
  let systemPrompt = "";
  const inputItems: Array<Record<string, unknown>> = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]!;
    const role = msg.role;
    const content = msg.content;

    if (role === "system") {
      systemPrompt = typeof content === "string" ? content : "";
      continue;
    }

    if (role === "user") {
      inputItems.push({
        role: "user",
        content: [{ type: "input_text", text: typeof content === "string" ? content : "" }],
      });
      continue;
    }

    if (role === "assistant") {
      if (typeof content === "string" && content) {
        inputItems.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: content }],
          status: "completed",
          id: `msg_${idx}`,
        });
      }
      // Tool calls in assistant messages would need additional handling
      // for the full (msg as any).tool_calls array - see Python source
      continue;
    }

    if (role === "tool") {
      const raw = msg as Record<string, unknown>;
      const callId = splitToolCallId(raw.tool_call_id as string | undefined)[0];
      inputItems.push({
        type: "function_call_output",
        call_id: callId,
        output: typeof content === "string" ? content : JSON.stringify(content),
      });
      continue;
    }
  }

  return { systemPrompt, inputItems };
}

function splitToolCallId(toolCallId?: string): [string, string | null] {
  if (toolCallId) {
    if (toolCallId.includes("|")) {
      const [callId, itemId] = toolCallId.split("|", 2);
      return [callId!, itemId || null];
    }
    return [toolCallId, null];
  }
  return ["call_0", null];
}

function promptCacheKey(messages: Array<{ role: string; content: string }>): string {
  const raw = JSON.stringify(messages);
  return createHash("sha256").update(raw).digest("hex");
}

async function requestCodex(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ content: string; toolCalls: ToolCallRequest[]; finishReason: string }> {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(friendlyError(resp.status, text));
  }

  const json = (await resp.json()) as Record<string, unknown>;
  return parseResponseJSON(json);
}

function parseResponseJSON(
  json: Record<string, unknown>,
): { content: string; toolCalls: ToolCallRequest[]; finishReason: string } {
  let content = "";
  const toolCalls: ToolCallRequest[] = [];
  const finishReason = mapFinishReason(json.status as string | undefined);

  const output = json.output as Array<Record<string, unknown>> | undefined;
  if (!output) return { content, toolCalls, finishReason };

  for (const item of output) {
    if (item.type === "message") {
      const parts = item.content as Array<Record<string, unknown>> | undefined;
      if (parts) {
        for (const part of parts) {
          if (part.type === "output_text") {
            content += (part.text as string) ?? "";
          }
        }
      }
    } else if (item.type === "function_call") {
      const callId = item.call_id as string;
      const itemId = (item.id as string) ?? "fc_0";
      const argsRaw = (item.arguments as string) ?? "{}";
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = { raw: argsRaw };
      }
      toolCalls.push({
        id: `${callId}|${itemId}`,
        name: item.name as string,
        arguments: args,
      });
    }
  }

  return { content, toolCalls, finishReason };
}

const FINISH_REASON_MAP: Record<string, string> = {
  completed: "stop",
  incomplete: "length",
  failed: "error",
  cancelled: "error",
};

function mapFinishReason(status?: string): string {
  return FINISH_REASON_MAP[status ?? "completed"] ?? "stop";
}

function friendlyError(statusCode: number, raw: string): string {
  if (statusCode === 429) {
    return "ChatGPT usage quota exceeded or rate limit triggered. Please try again later.";
  }
  return `HTTP ${statusCode}: ${raw}`;
}
