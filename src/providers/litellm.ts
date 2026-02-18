import type { LLMProvider, LLMResponse, ToolCallRequest } from "./base";
import { findByModel, findGateway, type ProviderSpec } from "./registry";

export class MultiProvider implements LLMProvider {
  private apiKey: string;
  private apiBase: string | null;
  private defaultModel: string;
  private extraHeaders: Record<string, string> | null;
  private gatewaySpec: ProviderSpec | null;

  constructor(options: {
    apiKey?: string;
    apiBase?: string | null;
    defaultModel?: string;
    extraHeaders?: Record<string, string> | null;
    providerName?: string;
  }) {
    this.apiKey = options.apiKey ?? "";
    this.apiBase = options.apiBase ?? null;
    this.defaultModel = options.defaultModel ?? "anthropic/claude-opus-4-5";
    this.extraHeaders = options.extraHeaders ?? null;
    this.gatewaySpec =
      findGateway({
        providerName: options.providerName,
        apiKey: this.apiKey,
        apiBase: this.apiBase ?? undefined,
      }) ?? null;

    this.applyEnvExtras();
  }

  private applyEnvExtras(): void {
    const spec = this.gatewaySpec ?? findByModel(this.defaultModel);
    if (!spec || spec.envExtras.length === 0) return;

    const effectiveBase = this.apiBase ?? spec.defaultApiBase;
    for (const [envName, envVal] of spec.envExtras) {
      if (process.env[envName]) continue; // don't overwrite existing
      const resolved = envVal
        .replace("{api_key}", this.apiKey)
        .replace("{api_base}", effectiveBase);
      process.env[envName] = resolved;
    }
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  private resolveModel(model: string): { resolvedModel: string; spec: ProviderSpec | undefined } {
    if (this.gatewaySpec) {
      let m = model;
      if (this.gatewaySpec.stripModelPrefix && m.includes("/")) {
        m = m.split("/").slice(1).join("/");
      }
      // Don't prepend litellmPrefix for gateways — we call their API directly via apiBase
      return { resolvedModel: m, spec: this.gatewaySpec };
    }
    const spec = findByModel(model);
    if (spec?.litellmPrefix) {
      if (!spec.skipPrefixes.some((sp) => model.startsWith(sp))) {
        return { resolvedModel: `${spec.litellmPrefix}/${model}`, spec };
      }
    }
    return { resolvedModel: model, spec };
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
    const { resolvedModel, spec } = this.resolveModel(model);

    const baseUrl = this.apiBase ?? spec?.defaultApiBase ?? this.getDefaultBaseUrl(spec);
    const apiKey = this.apiKey;

    const body: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      max_tokens: Math.max(1, options.maxTokens ?? 4096),
      temperature: options.temperature ?? 0.7,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }

    if (spec?.modelOverrides) {
      for (const [pattern, overrides] of spec.modelOverrides) {
        if (model.toLowerCase().includes(pattern)) {
          Object.assign(body, overrides);
        }
      }
    }

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(this.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        return {
          content: `Error: ${resp.status} ${errorText}`,
          toolCalls: [],
          finishReason: "error",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          reasoningContent: null,
        };
      }

      const data = (await resp.json()) as Record<string, unknown>;
      return await this.parseResponse(data);
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        toolCalls: [],
        finishReason: "error",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        reasoningContent: null,
      };
    }
  }

  private getDefaultBaseUrl(spec?: ProviderSpec): string {
    const defaults: Record<string, string> = {
      anthropic: "https://api.anthropic.com/v1",
      openai: "https://api.openai.com/v1",
      deepseek: "https://api.deepseek.com/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta",
      groq: "https://api.groq.com/openai/v1",
      moonshot: "https://api.moonshot.ai/v1",
      minimax: "https://api.minimax.io/v1",
    };
    return spec?.defaultApiBase || defaults[spec?.name ?? ""] || "https://api.openai.com/v1";
  }

  private async parseResponse(data: Record<string, unknown>): Promise<LLMResponse> {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const toolCalls: ToolCallRequest[] = [];

    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        const fn = tc.function as Record<string, unknown>;
        let args: Record<string, unknown> = {};
        const rawArgs = (fn.arguments as string) ?? "{}";
        try {
          const { jsonrepair } = await import("jsonrepair");
          args = JSON.parse(jsonrepair(rawArgs));
        } catch {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }
        }
        toolCalls.push({
          id: tc.id as string,
          name: fn.name as string,
          arguments: args,
        });
      }
    }

    const usage = data.usage as Record<string, number> | undefined;

    return {
      content: (message?.content as string) ?? null,
      toolCalls,
      finishReason: ((choice?.finish_reason as string) ?? "stop") as LLMResponse["finishReason"],
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
      reasoningContent: (message?.reasoning_content as string) ?? null,
    };
  }
}
