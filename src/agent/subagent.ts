import pino from "pino";
import type { MessageBus } from "../bus/queue";
import type { InboundMessage } from "../bus/events";
import type { LLMProvider, LLMResponse } from "../providers/base";
import { hasToolCalls } from "../providers/base";
import { ToolRegistry } from "../tools/base";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "../tools/filesystem";
import { ExecTool } from "../tools/shell";
import { WebSearchTool, WebFetchTool } from "../tools/web";
const log = pino({ name: "subagent" });

export interface SubagentManagerOptions {
  provider: LLMProvider;
  workspace: string;
  bus: MessageBus;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  braveApiKey?: string | null;
  execTimeout?: number;
  restrictToWorkspace?: boolean;
}

export class SubagentManager {
  private provider: LLMProvider;
  private workspace: string;
  private bus: MessageBus;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private braveApiKey: string | null;
  private execTimeout: number;
  private restrictToWorkspace: boolean;
  private runningTasks = new Map<string, AbortController>();

  constructor(options: SubagentManagerOptions) {
    this.provider = options.provider;
    this.workspace = options.workspace;
    this.bus = options.bus;
    this.model = options.model ?? options.provider.getDefaultModel();
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 4096;
    this.braveApiKey = options.braveApiKey ?? null;
    this.execTimeout = options.execTimeout ?? 60;
    this.restrictToWorkspace = options.restrictToWorkspace ?? false;
  }

  async spawn(
    task: string,
    label: string,
    originChannel: string,
    originChatId: string,
  ): Promise<string> {
    const taskId = crypto.randomUUID().slice(0, 8);
    const displayLabel = label || (task.length > 30 ? task.slice(0, 30) + "..." : task);

    const controller = new AbortController();
    this.runningTasks.set(taskId, controller);

    // Fire-and-forget background execution
    this.runSubagent(taskId, task, displayLabel, originChannel, originChatId)
      .finally(() => this.runningTasks.delete(taskId));

    log.info({ taskId, label: displayLabel }, "Spawned subagent");
    return `Subagent [${displayLabel}] started (id: ${taskId}). I'll notify you when it completes.`;
  }

  private async runSubagent(
    taskId: string,
    task: string,
    label: string,
    originChannel: string,
    originChatId: string,
  ): Promise<void> {
    log.info({ taskId, label }, "Subagent starting task");

    try {
      // Build isolated tool registry (no message/spawn/cron tools)
      const tools = new ToolRegistry();
      const allowedDir = this.restrictToWorkspace ? this.workspace : undefined;
      tools.register(new ReadFileTool(allowedDir));
      tools.register(new WriteFileTool(allowedDir));
      tools.register(new EditFileTool(allowedDir));
      tools.register(new ListDirTool(allowedDir));
      tools.register(new ExecTool({
        workingDir: this.workspace,
        timeout: this.execTimeout,
        restrictToWorkspace: this.restrictToWorkspace,
      }));
      tools.register(new WebSearchTool({ apiKey: this.braveApiKey ?? undefined }));
      tools.register(new WebFetchTool());

      const systemPrompt = this.buildSubagentPrompt(task);
      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: systemPrompt },
        { role: "user", content: task },
      ];

      const maxIterations = 15;
      let iteration = 0;
      let finalResult: string | null = null;

      while (iteration < maxIterations) {
        iteration++;

        const response: LLMResponse = await this.provider.chat(
          messages as Array<{ role: string; content: string }>,
          {
            tools: tools.getDefinitions(),
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
          },
        );

        if (hasToolCalls(response)) {
          const toolCallDicts = response.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));

          messages.push({
            role: "assistant",
            content: response.content ?? "",
            tool_calls: toolCallDicts,
          });

          for (const tc of response.toolCalls) {
            log.debug({ taskId, tool: tc.name }, "Subagent executing tool");
            const result = await tools.execute(tc.name, tc.arguments);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.name,
              content: result,
            });
          }
        } else {
          finalResult = response.content;
          break;
        }
      }

      if (finalResult === null) {
        finalResult = "Task completed but no final response was generated.";
      }

      log.info({ taskId }, "Subagent completed successfully");
      await this.announceResult(taskId, label, task, finalResult, originChannel, originChatId, "done");
    } catch (err) {
      const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ taskId, err }, "Subagent failed");
      await this.announceResult(taskId, label, task, errorMsg, originChannel, originChatId, "error");
    }
  }

  private async announceResult(
    taskId: string,
    label: string,
    task: string,
    result: string,
    originChannel: string,
    originChatId: string,
    status: "done" | "error",
  ): Promise<void> {
    const statusText = status === "done" ? "completed successfully" : "failed";

    const announceContent = `[Subagent '${label}' ${statusText}]

Task: ${task}

Result:
${result}

Summarize this naturally for the user. Keep it brief (1-2 sentences). Do not mention technical details like "subagent" or task IDs.`;

    const msg: InboundMessage = {
      channel: "system",
      senderId: "subagent",
      chatId: `${originChannel}:${originChatId}`,
      content: announceContent,
      timestamp: new Date(),
      media: [],
      metadata: {},
    };

    await this.bus.publishInbound(msg);
    log.debug({ taskId, originChannel, originChatId }, "Subagent announced result");
  }

  private buildSubagentPrompt(_task: string): string {
    const now = new Date().toISOString();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    return `# Subagent

## Current Time
${now} (${tz})

You are a subagent spawned by the main agent to complete a specific task.

## Rules
1. Stay focused - complete only the assigned task, nothing else
2. Your final response will be reported back to the main agent
3. Do not initiate conversations or take on side tasks
4. Be concise but informative in your findings

## What You Can Do
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages
- Complete the task thoroughly

## What You Cannot Do
- Send messages directly to users (no message tool available)
- Spawn other subagents
- Access the main agent's conversation history

## Workspace
Your workspace is at: ${this.workspace}
Skills are available at: ${this.workspace}/skills/ (read SKILL.md files as needed)

When you have completed the task, provide a clear summary of your findings or actions.`;
  }

  get runningCount(): number {
    return this.runningTasks.size;
  }
}
