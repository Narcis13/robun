import pino from "pino";
import { jsonrepair } from "jsonrepair";
import type { MessageBus } from "../bus/queue";
import type { LLMProvider, LLMResponse } from "../providers/base";
import { hasToolCalls } from "../providers/base";
import type { InboundMessage, OutboundMessage } from "../bus/events";
import { ToolRegistry } from "../tools/base";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "../tools/filesystem";
import { ExecTool } from "../tools/shell";
import { WebSearchTool, WebFetchTool } from "../tools/web";
import { MessageTool } from "../tools/message";
import { SpawnTool } from "../tools/spawn";
import { CronTool } from "../tools/cron";
import type { CronService } from "../cron/service";
import { connectMcpServers, type McpServerConfig } from "../tools/mcp";
import { ContextBuilder } from "./context";
import { MemoryStore } from "./memory";
import { SubagentManager } from "./subagent";
import { Session, SessionManager } from "../session/manager";

const log = pino({ name: "agent-loop" });

export interface AgentLoopOptions {
  bus: MessageBus;
  provider: LLMProvider;
  workspace: string;
  model?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  memoryWindow?: number;
  braveApiKey?: string | null;
  execTimeout?: number;
  cronService?: CronService | null;
  restrictToWorkspace?: boolean;
  sessionManager?: SessionManager | null;
  mcpServers?: Record<string, McpServerConfig>;
}

export class AgentLoop {
  readonly bus: MessageBus;
  readonly provider: LLMProvider;
  readonly workspace: string;
  readonly model: string;
  readonly maxIterations: number;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly memoryWindow: number;

  private context: ContextBuilder;
  private sessions: SessionManager;
  private tools: ToolRegistry;
  private subagents: SubagentManager;
  private running = false;
  private mcpServers: Record<string, McpServerConfig>;
  private mcpConnected = false;
  private mcpCleanups: Array<{ cleanup: () => Promise<void> }> = [];

  constructor(options: AgentLoopOptions) {
    this.bus = options.bus;
    this.provider = options.provider;
    this.workspace = options.workspace;
    this.model = options.model ?? options.provider.getDefaultModel();
    this.maxIterations = options.maxIterations ?? 20;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 4096;
    this.memoryWindow = options.memoryWindow ?? 50;
    this.mcpServers = options.mcpServers ?? {};

    this.context = new ContextBuilder(options.workspace);
    this.sessions = options.sessionManager ?? new SessionManager();
    this.tools = new ToolRegistry();
    this.subagents = new SubagentManager({
      provider: options.provider,
      workspace: options.workspace,
      bus: options.bus,
      model: this.model,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      braveApiKey: options.braveApiKey ?? null,
      execTimeout: options.execTimeout,
      restrictToWorkspace: options.restrictToWorkspace,
    });

    this.registerDefaultTools(options);
  }

  private registerDefaultTools(options: AgentLoopOptions): void {
    const allowedDir = options.restrictToWorkspace ? this.workspace : undefined;

    // File tools
    this.tools.register(new ReadFileTool(allowedDir));
    this.tools.register(new WriteFileTool(allowedDir));
    this.tools.register(new EditFileTool(allowedDir));
    this.tools.register(new ListDirTool(allowedDir));

    // Shell tool
    this.tools.register(new ExecTool({
      workingDir: this.workspace,
      timeout: options.execTimeout,
      restrictToWorkspace: options.restrictToWorkspace,
    }));

    // Web tools
    this.tools.register(new WebSearchTool({ apiKey: options.braveApiKey ?? undefined }));
    this.tools.register(new WebFetchTool());

    // Message tool
    const messageTool = new MessageTool(
      (msg: OutboundMessage) => this.bus.publishOutbound(msg),
    );
    this.tools.register(messageTool);

    // Spawn tool
    this.tools.register(new SpawnTool(this.subagents));

    // Cron tool
    if (options.cronService) {
      this.tools.register(new CronTool(options.cronService));
    }
  }

  private async connectMcp(): Promise<void> {
    if (this.mcpConnected || Object.keys(this.mcpServers).length === 0) return;
    this.mcpConnected = true;
    this.mcpCleanups = await connectMcpServers(this.mcpServers, this.tools);
  }

  private setToolContext(channel: string, chatId: string): void {
    const messageTool = this.tools.get("message");
    if (messageTool && "setContext" in messageTool) {
      (messageTool as MessageTool).setContext(channel, chatId);
    }

    const spawnTool = this.tools.get("spawn");
    if (spawnTool && "setContext" in spawnTool) {
      (spawnTool as SpawnTool).setContext(channel, chatId);
    }

    const cronTool = this.tools.get("cron");
    if (cronTool && "setContext" in cronTool) {
      (cronTool as CronTool).setContext(channel, chatId);
    }
  }

  private async runAgentLoop(
    initialMessages: Array<{ role: string; content: string | unknown[] }>,
  ): Promise<[string | null, string[]]> {
    const messages: Array<Record<string, unknown>> = [...initialMessages];
    let iteration = 0;
    let finalContent: string | null = null;
    const toolsUsed: string[] = [];

    while (iteration < this.maxIterations) {
      iteration++;

      const response: LLMResponse = await this.provider.chat(
        messages as Array<{ role: string; content: string }>,
        {
          tools: this.tools.getDefinitions(),
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

        ContextBuilder.addAssistantMessage(
          messages,
          response.content,
          toolCallDicts,
          response.reasoningContent,
        );

        for (const tc of response.toolCalls) {
          toolsUsed.push(tc.name);
          const argsStr = JSON.stringify(tc.arguments);
          log.info({ tool: tc.name, args: argsStr.slice(0, 200) }, "Tool call");
          const result = await this.tools.execute(tc.name, tc.arguments);
          ContextBuilder.addToolResult(messages, tc.id, tc.name, result);
        }

        messages.push({ role: "user", content: "Reflect on the results and decide next steps." });
      } else {
        finalContent = response.content;
        break;
      }
    }

    return [finalContent, toolsUsed];
  }

  async run(): Promise<void> {
    this.running = true;
    await this.connectMcp();
    log.info("Agent loop started");

    while (this.running) {
      try {
        const msg = await this.bus.consumeInbound(1000);
        try {
          const response = await this.processMessage(msg);
          if (response) {
            await this.bus.publishOutbound(response);
          }
        } catch (err) {
          log.error({ err }, "Error processing message");
          await this.bus.publishOutbound({
            channel: msg.channel,
            chatId: msg.chatId,
            content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : String(err)}`,
            replyTo: null,
            media: [],
            metadata: {},
          });
        }
      } catch {
        // Timeout — no message available, loop continues
      }
    }
  }

  stop(): void {
    this.running = false;
    log.info("Agent loop stopping");
  }

  private async processMessage(
    msg: InboundMessage,
    sessionKeyOverride?: string,
  ): Promise<OutboundMessage | null> {
    // System messages (subagent results) route differently
    if (msg.channel === "system") {
      return this.processSystemMessage(msg);
    }

    const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + "..." : msg.content;
    log.info({ channel: msg.channel, sender: msg.senderId, preview }, "Processing message");

    const key = sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
    const session = this.sessions.getOrCreate(key);

    // Handle slash commands
    const cmd = msg.content.trim().toLowerCase();
    if (cmd === "/new") {
      const messagesToArchive = [...session.messages];
      session.clear();
      this.sessions.save(session);
      this.sessions.invalidate(session.key);

      // Background memory consolidation
      const tempSession = new Session(session.key);
      tempSession.messages = messagesToArchive;
      this.consolidateMemory(tempSession, true).catch((err) =>
        log.error({ err }, "Background consolidation failed"),
      );

      return {
        channel: msg.channel,
        chatId: msg.chatId,
        content: "New session started. Memory consolidation in progress.",
        replyTo: null,
        media: [],
        metadata: {},
      };
    }

    if (cmd === "/help") {
      return {
        channel: msg.channel,
        chatId: msg.chatId,
        content: "robun commands:\n/new - Start a new conversation\n/help - Show available commands",
        replyTo: null,
        media: [],
        metadata: {},
      };
    }

    // Trigger memory consolidation if session is long
    if (session.messages.length > this.memoryWindow) {
      this.consolidateMemory(session).catch((err) =>
        log.error({ err }, "Background consolidation failed"),
      );
    }

    this.setToolContext(msg.channel, msg.chatId);

    const initialMessages = this.context.buildMessages({
      history: session.getHistory(this.memoryWindow),
      currentMessage: msg.content,
      media: msg.media.length > 0 ? msg.media : null,
      channel: msg.channel,
      chatId: msg.chatId,
    });

    const [finalContent, toolsUsed] = await this.runAgentLoop(initialMessages);

    const responseContent = finalContent ?? "I've completed processing but have no response to give.";

    const responsePreview = responseContent.length > 120
      ? responseContent.slice(0, 120) + "..."
      : responseContent;
    log.info({ channel: msg.channel, sender: msg.senderId, preview: responsePreview }, "Response");

    session.addMessage("user", msg.content);
    session.addMessage("assistant", responseContent,
      toolsUsed.length > 0 ? { toolsUsed } : undefined,
    );
    this.sessions.save(session);

    return {
      channel: msg.channel,
      chatId: msg.chatId,
      content: responseContent,
      replyTo: null,
      media: [],
      metadata: msg.metadata ?? {},
    };
  }

  private async processSystemMessage(msg: InboundMessage): Promise<OutboundMessage | null> {
    log.info({ sender: msg.senderId }, "Processing system message");

    // Parse origin from chatId (format: "channel:chatId")
    let originChannel: string;
    let originChatId: string;

    if (msg.chatId.includes(":")) {
      const sepIdx = msg.chatId.indexOf(":");
      originChannel = msg.chatId.slice(0, sepIdx);
      originChatId = msg.chatId.slice(sepIdx + 1);
    } else {
      originChannel = "cli";
      originChatId = msg.chatId;
    }

    const sessionKey = `${originChannel}:${originChatId}`;
    const session = this.sessions.getOrCreate(sessionKey);
    this.setToolContext(originChannel, originChatId);

    const initialMessages = this.context.buildMessages({
      history: session.getHistory(this.memoryWindow),
      currentMessage: msg.content,
      channel: originChannel,
      chatId: originChatId,
    });

    const [finalContent] = await this.runAgentLoop(initialMessages);
    const responseContent = finalContent ?? "Background task completed.";

    session.addMessage("user", `[System: ${msg.senderId}] ${msg.content}`);
    session.addMessage("assistant", responseContent);
    this.sessions.save(session);

    return {
      channel: originChannel,
      chatId: originChatId,
      content: responseContent,
      replyTo: null,
      media: [],
      metadata: {},
    };
  }

  private async consolidateMemory(session: Session, archiveAll = false): Promise<void> {
    const memory = new MemoryStore(this.workspace);

    let oldMessages: Array<Record<string, unknown>>;
    let keepCount: number;

    if (archiveAll) {
      oldMessages = session.messages as Array<Record<string, unknown>>;
      keepCount = 0;
      log.info({ total: session.messages.length }, "Memory consolidation (archive_all)");
    } else {
      keepCount = Math.floor(this.memoryWindow / 2);
      if (session.messages.length <= keepCount) {
        return;
      }

      const messagesToProcess = session.messages.length - session.lastConsolidated;
      if (messagesToProcess <= 0) return;

      oldMessages = session.messages.slice(
        session.lastConsolidated,
        -keepCount,
      ) as Array<Record<string, unknown>>;
      if (oldMessages.length === 0) return;

      log.info(
        { total: session.messages.length, toConsolidate: oldMessages.length, keep: keepCount },
        "Memory consolidation started",
      );
    }

    const lines: string[] = [];
    for (const m of oldMessages) {
      const content = m.content as string | undefined;
      if (!content) continue;
      const toolsUsed = m.toolsUsed as string[] | undefined;
      const toolsSuffix = toolsUsed ? ` [tools: ${toolsUsed.join(", ")}]` : "";
      const ts = ((m.timestamp as string) ?? "?").slice(0, 16);
      lines.push(`[${ts}] ${(m.role as string).toUpperCase()}${toolsSuffix}: ${content}`);
    }
    const conversation = lines.join("\n");
    const currentMemory = memory.readLongTerm();

    const prompt = `You are a memory consolidation agent. Process this conversation and return a JSON object with exactly two keys:

1. "history_entry": A paragraph (2-5 sentences) summarizing the key events/decisions/topics. Start with a timestamp like [YYYY-MM-DD HH:MM]. Include enough detail to be useful when found by grep search later.

2. "memory_update": The updated long-term memory content. Add any new facts: user location, preferences, personal info, habits, project context, technical decisions, tools/services used. If nothing new, return the existing content unchanged.

## Current Long-term Memory
${currentMemory || "(empty)"}

## Conversation to Process
${conversation}

Respond with ONLY valid JSON, no markdown fences.`;

    try {
      const response = await this.provider.chat(
        [
          { role: "system", content: "You are a memory consolidation agent. Respond only with valid JSON." },
          { role: "user", content: prompt },
        ],
        { model: this.model },
      );

      let text = (response.content ?? "").trim();
      if (!text) {
        log.warn("Memory consolidation: LLM returned empty response, skipping");
        return;
      }

      // Strip markdown fences if present
      if (text.startsWith("```")) {
        text = text.split("\n", 2)[1] ?? text;
        text = text.replace(/```\s*$/, "").trim();
      }

      let result: Record<string, unknown>;
      try {
        result = JSON.parse(text);
      } catch {
        result = JSON.parse(jsonrepair(text));
      }

      if (typeof result !== "object" || result === null) {
        log.warn({ text: text.slice(0, 200) }, "Memory consolidation: unexpected response type");
        return;
      }

      const entry = result.history_entry as string | undefined;
      if (entry) memory.appendHistory(entry);

      const update = result.memory_update as string | undefined;
      if (update && update !== currentMemory) {
        memory.writeLongTerm(update);
      }

      if (archiveAll) {
        session.lastConsolidated = 0;
      } else {
        session.lastConsolidated = session.messages.length - keepCount;
      }

      log.info(
        { total: session.messages.length, lastConsolidated: session.lastConsolidated },
        "Memory consolidation done",
      );
    } catch (err) {
      log.error({ err }, "Memory consolidation failed");
    }
  }

  async processDirect(
    content: string,
    sessionKey = "cli:direct",
    channel = "cli",
    chatId = "direct",
  ): Promise<{ content: string; sessionKey: string }> {
    await this.connectMcp();

    const msg: InboundMessage = {
      channel,
      senderId: "user",
      chatId,
      content,
      timestamp: new Date(),
      media: [],
      metadata: {},
    };

    const response = await this.processMessage(msg, sessionKey);
    return {
      content: response?.content ?? "",
      sessionKey,
    };
  }

  async closeMcp(): Promise<void> {
    for (const handle of this.mcpCleanups) {
      try {
        await handle.cleanup();
      } catch {
        // MCP cleanup can be noisy but harmless
      }
    }
    this.mcpCleanups = [];
  }
}
