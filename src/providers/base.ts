import { z } from "zod";

export const ToolCallRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const LLMResponseSchema = z.object({
  content: z.string().nullable(),
  toolCalls: z.array(ToolCallRequestSchema).default([]),
  finishReason: z.enum(["stop", "tool_calls", "length", "error"]).default("stop"),
  usage: z
    .object({
      promptTokens: z.number().default(0),
      completionTokens: z.number().default(0),
      totalTokens: z.number().default(0),
    })
    .default({}),
  reasoningContent: z.string().nullable().default(null),
});
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

export function hasToolCalls(response: LLMResponse): boolean {
  return response.toolCalls.length > 0;
}

export interface LLMProvider {
  getDefaultModel(): string;
  chat(
    messages: Array<{ role: string; content: string }>,
    options: {
      model?: string;
      tools?: unknown[];
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<LLMResponse>;
}
