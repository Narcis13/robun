# Robun: Complete Request-to-Response Flow

This document traces **every line of code** that executes from the moment a user types a message until Robun delivers the response. Three entry paths exist: **CLI mode**, **HTTP API**, and **Channel** (Telegram, Discord, etc.). All three converge into the same agent processing pipeline.

---

## Table of Contents

1. [High-Level Flow Diagram](#1-high-level-flow-diagram)
2. [Entry Path A: CLI Mode](#2-entry-path-a-cli-mode)
3. [Entry Path B: HTTP API](#3-entry-path-b-http-api)
4. [Entry Path C: Channel Message](#4-entry-path-c-channel-message)
5. [Stage 1: Configuration Loading](#5-stage-1-configuration-loading)
6. [Stage 2: Provider Resolution](#6-stage-2-provider-resolution)
7. [Stage 3: AgentLoop Construction & Tool Registration](#7-stage-3-agentloop-construction--tool-registration)
8. [Stage 4: Message Bus — Inbound Queueing](#8-stage-4-message-bus--inbound-queueing)
9. [Stage 5: AgentLoop.run() — The Event Loop](#9-stage-5-agentlooprun--the-event-loop)
10. [Stage 6: processMessage() — Routing & Session](#10-stage-6-processmessage--routing--session)
11. [Stage 7: ContextBuilder.buildMessages() — LLM Prompt Assembly](#11-stage-7-contextbuilderbuildmessages--llm-prompt-assembly)
12. [Stage 8: runAgentLoop() — The LLM Tool-Use Cycle](#12-stage-8-runagentloop--the-llm-tool-use-cycle)
13. [Stage 9: Provider.chat() — The HTTP Call to the LLM](#13-stage-9-providerchat--the-http-call-to-the-llm)
14. [Stage 10: Tool Execution](#14-stage-10-tool-execution)
15. [Stage 11: Response Finalization & Session Persistence](#15-stage-11-response-finalization--session-persistence)
16. [Stage 12: Outbound Delivery](#16-stage-12-outbound-delivery)
17. [Stage 13: Memory Consolidation (Background)](#17-stage-13-memory-consolidation-background)
18. [Stage 14: Subagent Flow (When Spawn Tool Is Used)](#18-stage-14-subagent-flow-when-spawn-tool-is-used)
19. [Error Paths](#19-error-paths)
20. [Key Constants & Defaults](#20-key-constants--defaults)

---

## 1. High-Level Flow Diagram

```
USER INPUT
  │
  ├─ CLI:     `robun agent -m "Hello"`     ─── src/index.ts:30 ─── src/cli.ts:383
  ├─ HTTP:    POST /agent/message           ─── src/server.ts:40
  └─ Channel: Telegram/Discord/etc message  ─── src/channels/base.ts:38
  │
  ▼
┌─────────────────────────────────┐
│  InboundMessage constructed     │  src/bus/events.ts:3-12
│  { channel, senderId, chatId,   │
│    content, timestamp, media }   │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  MessageBus.publishInbound()    │  src/bus/queue.ts:15-22
│  → either wakes waiter or       │
│    enqueues to inboundQueue     │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  AgentLoop.run()                │  src/agent/loop.ts:202-230
│  → consumeInbound(1000ms)       │
│  → processMessage(msg)          │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  processMessage()               │  src/agent/loop.ts:237-328
│  1. Session lookup/create       │
│  2. Slash command check         │
│  3. Memory consolidation check  │
│  4. Set tool context            │
│  5. Build LLM messages          │
│  6. Run agent loop              │
│  7. Save session                │
│  8. Return OutboundMessage      │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  ContextBuilder.buildMessages() │  src/agent/context.ts:61-84
│  → System prompt assembly       │
│  → History injection            │
│  → User message formatting      │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  runAgentLoop()                 │  src/agent/loop.ts:146-200
│  WHILE iteration < 20:         │
│    → provider.chat(messages)    │
│    → IF tool_calls:             │
│        execute each tool        │
│        append results           │
│        "Reflect on results..."  │
│    → ELSE: break with content   │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  Response delivered             │
│  → CLI: printed to console      │
│  → HTTP: JSON response          │
│  → Channel: bus.publishOutbound │
│    → dispatchOutbound()         │
│    → channel.send()             │
└─────────────────────────────────┘
```

---

## 2. Entry Path A: CLI Mode

### Step 1: Process starts at `src/index.ts`

```
src/index.ts:20-31
```

The Bun process starts. `process.argv` is parsed. When the user runs:
```bash
robun agent -m "What is 2+2?"
```

`command` resolves to `"agent"`, and execution enters `case "agent"` which calls `agent(args.slice(1))`.

### Step 2: `agent()` function in `src/cli.ts:383-454`

**Single-message mode** (when `-m` flag is present):

```typescript
// src/cli.ts:384-385
const message = parseFlag(args, "--message", "-m");  // "What is 2+2?"
const sessionId = parseFlag(args, "--session", "-s") ?? "cli:direct";
```

1. **Load config** (line 390): `loadConfig()` — see [Stage 1](#5-stage-1-configuration-loading)
2. **Create MessageBus** (line 391): `new MessageBus()` — empty bus, no channels
3. **Create provider** (line 392): `makeProvider(config)` — see [Stage 2](#6-stage-2-provider-resolution)
4. **Resolve workspace** (line 393): `getWorkspacePath()` → typically `~/.robun/workspace/`
5. **Construct AgentLoop** (lines 395-408): see [Stage 3](#7-stage-3-agentloop-construction--tool-registration)

Then for single-message mode (line 410-416):
```typescript
// src/cli.ts:411-415
const result = await agentLoop.processDirect(message, sessionId);
console.log(`\n🤖 robun`);
console.log(result.content);
```

`processDirect()` bypasses the event loop entirely — it constructs a synthetic `InboundMessage` and calls `processMessage()` directly.

**Interactive REPL mode** (no `-m` flag, lines 417-453):

A readline interface is created. Each line the user types:
```typescript
// src/cli.ts:442
const result = await agentLoop.processDirect(trimmed, sessionId);
```

The `processDirect` method is called for each input. Exit commands (`exit`, `quit`, `/exit`, `/quit`, `:q`) break the loop.

### `processDirect()` — The CLI Bridge

```typescript
// src/agent/loop.ts:487-510
async processDirect(
  content: string,
  sessionKey = "cli:direct",
  channel = "cli",
  chatId = "direct",
): Promise<{ content: string; sessionKey: string }> {
  await this.connectMcp();  // Connect MCP servers on first call

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
```

This creates a synthetic `InboundMessage` with `channel="cli"`, `senderId="user"`, `chatId="direct"`, then calls `processMessage()` directly (not through the bus). The `sessionKeyOverride` parameter ensures the session key is `"cli:direct"` rather than being computed from channel+chatId.

---

## 3. Entry Path B: HTTP API

### Step 1: Gateway startup

When the user runs `robun gateway`, the `gateway()` function at `src/cli.ts:274-377` is called. It:

1. Loads config, creates bus, provider, workspace, session manager, cron service
2. Constructs `AgentLoop` (lines 303-318)
3. Starts the HTTP server (lines 339-346):

```typescript
// src/cli.ts:339-340
const server = startServer(port, { agentLoop, sessionManager, cronService, channelManager, config });
```

4. Starts the agent event loop and channels in parallel (line 361):

```typescript
await Promise.all([
  agentLoop.run(),          // Event loop consuming from bus
  channelManager.startAll(),
  cronService.start(),
  heartbeatService.start(),
]);
```

### Step 2: HTTP request arrives

```typescript
// src/server.ts:40-54
app.post("/agent/message", async (c) => {
  const body = (await c.req.json()) as {
    content: string;
    sessionKey?: string;
    channel?: string;
    chatId?: string;
  };
  const result = await agentLoop.processDirect(
    body.content,
    body.sessionKey,
    body.channel,
    body.chatId,
  );
  return c.json({ response: result.content, sessionKey: result.sessionKey });
});
```

The HTTP handler calls `processDirect()` exactly like CLI mode. This means HTTP requests **bypass the message bus** — they don't go through `publishInbound()`/`consumeInbound()`. They call `processMessage()` directly and return the result synchronously in the HTTP response.

**Important debugging note:** HTTP requests and CLI requests share session state. If the same `sessionKey` is used, they share conversation history.

---

## 4. Entry Path C: Channel Message

### Step 1: Channel receives external message

Each channel adapter (e.g., `TelegramChannel`) listens for external messages using its SDK. When a message arrives, the channel calls:

```typescript
// src/channels/base.ts:38-61
protected async handleMessage(
  senderId: string,
  chatId: string,
  content: string,
  media?: string[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  // STEP C.1: Access control check
  if (!this.isAllowed(senderId)) {
    logger.warn(`Access denied for ${senderId} on ${this.name}...`);
    return;  // MESSAGE SILENTLY DROPPED
  }

  // STEP C.2: Publish to inbound bus
  await this.bus.publishInbound({
    channel: this.name,        // e.g., "telegram"
    senderId: String(senderId),
    chatId: String(chatId),
    content,
    timestamp: new Date(),
    media: media ?? [],
    metadata: metadata ?? {},
  });
}
```

### Step 2: Access control — `isAllowed()`

```typescript
// src/channels/base.ts:23-36
isAllowed(senderId: string): boolean {
  const allowList: string[] = this.config.allowFrom ?? [];
  if (allowList.length === 0) return true;  // Empty = allow all

  const senderStr = String(senderId);
  if (allowList.includes(senderStr)) return true;

  // Support pipe-separated compound IDs (e.g., "userId|groupId")
  if (senderStr.includes("|")) {
    for (const part of senderStr.split("|")) {
      if (part && allowList.includes(part)) return true;
    }
  }
  return false;
}
```

If the sender is not in the `allowFrom` list (and the list is non-empty), the message is **silently dropped** with only a log warning. This is a common debugging gotcha.

### Step 3: Message enters the bus

The `publishInbound()` call at `src/bus/queue.ts:15-22` either:
- **Wakes a waiting consumer** (if `agentLoop.run()` is blocked on `consumeInbound()`), or
- **Queues the message** for later consumption

This is where channel messages diverge from CLI/HTTP: they go through the bus and are consumed by the event loop.

---

## 5. Stage 1: Configuration Loading

```typescript
// src/config/loader.ts:14-24
export function loadConfig(configPath?: string): Config {
  const path = configPath ?? getConfigPath();  // ~/.robun/config.json
  let config: Config;
  if (!existsSync(path)) {
    config = ConfigSchema.parse({});  // All defaults
  } else {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    config = ConfigSchema.parse(raw);  // Zod validation + defaults
  }
  return applyEnvOverrides(config);
}
```

### Environment variable overrides

```typescript
// src/config/loader.ts:45-53
export function applyEnvOverrides(config: Config): Config {
  const mutable = JSON.parse(JSON.stringify(config));  // Deep clone
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ROBUN_") || value === undefined) continue;
    // ROBUN_PROVIDERS__ANTHROPIC__API_KEY → ["providers", "anthropic", "api_key"]
    const path = key.slice(6).toLowerCase().split("__");
    setNestedValue(mutable, path, value);
  }
  return ConfigSchema.parse(mutable);  // Re-validate after overrides
}
```

Any `ROBUN_` prefixed env var overrides the config. Double underscore `__` represents nesting. The config is re-validated through Zod after applying overrides.

**Debugging tip:** If your config values seem wrong, check for `ROBUN_*` environment variables.

---

## 6. Stage 2: Provider Resolution

```typescript
// src/cli.ts:58-82
function makeProvider(config: Config): LLMProvider {
  const model = config.agents.defaults.model;  // e.g., "anthropic/claude-opus-4-5"
  const { providerName, providerConfig } = getProviderForModel(config, model);
```

### Provider lookup chain (`getProviderForModel`)

```typescript
// src/cli.ts:22-46
function getProviderForModel(config, model) {
  // 1. Find provider spec by model keywords
  const spec = findByModel(model);  // src/providers/registry.ts:260-265
  const providerName = spec?.name ?? "custom";

  // 2. Look up provider config in config.providers
  const providerConfig = providers[providerName] ?? null;

  // 3. FALLBACK: If no API key, try gateway providers (OpenRouter, etc.)
  if (!providerConfig?.apiKey && !spec?.isLocal) {
    for (const gw of PROVIDERS) {
      if (!gw.isGateway || gw.name === "custom") continue;
      const gwConfig = providers[gw.name];
      if (gwConfig?.apiKey) {
        return { providerName: gw.name, providerConfig: gwConfig };
      }
    }
  }

  return { providerName, providerConfig };
}
```

**`findByModel()` logic** (`src/providers/registry.ts:260-265`):
```typescript
export function findByModel(model: string): ProviderSpec | undefined {
  const lower = model.toLowerCase();
  return PROVIDERS.find(
    (s) => !s.isGateway && !s.isLocal && s.keywords.some((kw) => lower.includes(kw)),
  );
}
```

This matches model names by keyword. `"anthropic/claude-opus-4-5"` matches `keywords: ["anthropic", "claude"]` → provider = `"anthropic"`.

### Provider instantiation

```typescript
// src/cli.ts:75-82
return new MultiProvider({
  apiKey: providerConfig?.apiKey,
  apiBase: getApiBase(config, providerName),
  defaultModel: model,
  extraHeaders: providerConfig?.extraHeaders,
  providerName,
});
```

Special case: if `providerName === "openaiCodex"`, an `OpenAICodexProvider` is used instead (OAuth-based).

### MultiProvider constructor

```typescript
// src/providers/litellm.ts:11-30
constructor(options) {
  this.apiKey = options.apiKey ?? "";
  this.apiBase = options.apiBase ?? null;
  this.defaultModel = options.defaultModel ?? "anthropic/claude-opus-4-5";
  this.extraHeaders = options.extraHeaders ?? null;
  this.gatewaySpec = findGateway({
    providerName: options.providerName,
    apiKey: this.apiKey,
    apiBase: this.apiBase ?? undefined,
  }) ?? null;

  this.applyEnvExtras();  // Set provider-specific env vars
}
```

`findGateway()` checks if the provider is a gateway/proxy (like OpenRouter) by looking at the API key prefix or base URL keyword.

---

## 7. Stage 3: AgentLoop Construction & Tool Registration

```typescript
// src/agent/loop.ts:59-86
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
  this.subagents = new SubagentManager({...});

  this.registerDefaultTools(options);
}
```

### Tool Registration

```typescript
// src/agent/loop.ts:88-121
private registerDefaultTools(options: AgentLoopOptions): void {
  const allowedDir = options.restrictToWorkspace ? this.workspace : undefined;

  // File tools (4)
  this.tools.register(new ReadFileTool(allowedDir));
  this.tools.register(new WriteFileTool(allowedDir));
  this.tools.register(new EditFileTool(allowedDir));
  this.tools.register(new ListDirTool(allowedDir));

  // Shell tool (1)
  this.tools.register(new ExecTool({
    workingDir: this.workspace,
    timeout: options.execTimeout,
    restrictToWorkspace: options.restrictToWorkspace,
  }));

  // Web tools (2)
  this.tools.register(new WebSearchTool({ apiKey: options.braveApiKey ?? undefined }));
  this.tools.register(new WebFetchTool());

  // Message tool (1) — sends messages through the bus
  const messageTool = new MessageTool(
    (msg: OutboundMessage) => this.bus.publishOutbound(msg),
  );
  this.tools.register(messageTool);

  // Spawn tool (1) — spawns background subagents
  this.tools.register(new SpawnTool(this.subagents));

  // Cron tool (1, conditional) — only if CronService is provided
  if (options.cronService) {
    this.tools.register(new CronTool(options.cronService));
  }
}
```

Total: 10-11 built-in tools, plus any MCP tools connected later.

### MCP Tool Connection (lazy)

```typescript
// src/agent/loop.ts:123-127
private async connectMcp(): Promise<void> {
  if (this.mcpConnected || Object.keys(this.mcpServers).length === 0) return;
  this.mcpConnected = true;
  this.mcpCleanups = await connectMcpServers(this.mcpServers, this.tools);
}
```

MCP servers are connected **lazily** — on the first `processDirect()` call or when `run()` starts. Each MCP tool is wrapped as a `MCPToolWrapper` and registered in the same `ToolRegistry`.

---

## 8. Stage 4: Message Bus — Inbound Queueing

This stage only applies to **channel messages** (not CLI/HTTP which bypass the bus).

### `MessageBus.publishInbound()`

```typescript
// src/bus/queue.ts:15-22
async publishInbound(msg: InboundMessage): Promise<void> {
  if (this.inboundWaiters.length > 0) {
    // Someone is waiting (agentLoop.run() blocked on consumeInbound)
    const waiter = this.inboundWaiters.shift()!;
    waiter(msg);  // Resolve the promise immediately
  } else {
    // No one waiting, queue for later
    this.inboundQueue.push(msg);
  }
}
```

### `MessageBus.consumeInbound()`

```typescript
// src/bus/queue.ts:24-41
async consumeInbound(timeoutMs = 1000): Promise<InboundMessage> {
  // If there's already a message in the queue, return it immediately
  if (this.inboundQueue.length > 0) {
    return this.inboundQueue.shift()!;
  }

  // Otherwise, wait for a message (or timeout)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove this waiter and reject with timeout
      const idx = this.inboundWaiters.indexOf(wrappedResolve);
      if (idx >= 0) this.inboundWaiters.splice(idx, 1);
      reject(new Error("timeout"));
    }, timeoutMs);

    const wrappedResolve = (msg: InboundMessage) => {
      clearTimeout(timer);
      resolve(msg);
    };
    this.inboundWaiters.push(wrappedResolve);
  });
}
```

**Key detail:** The 1000ms timeout means the event loop polls once per second when idle. The timeout rejection is caught silently in `AgentLoop.run()` (the outer `catch` at line 226 just continues the loop).

---

## 9. Stage 5: AgentLoop.run() — The Event Loop

This is the **gateway mode** event loop. It runs continuously, consuming messages from the bus.

```typescript
// src/agent/loop.ts:202-230
async run(): Promise<void> {
  this.running = true;
  await this.connectMcp();  // Lazy MCP connection
  log.info("Agent loop started");

  while (this.running) {
    try {
      // Block for up to 1 second waiting for a message
      const msg = await this.bus.consumeInbound(1000);

      try {
        // Process the message → get response
        const response = await this.processMessage(msg);

        if (response) {
          // Publish response to outbound bus for channel delivery
          await this.bus.publishOutbound(response);
        }
      } catch (err) {
        // Error during processing → send error message back
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
      // Timeout — no message available, loop back
    }
  }
}
```

**Critical behavior:**
- One message is processed at a time. No parallelism.
- If processing takes 30 seconds, incoming messages queue up in the bus.
- Errors during processing send an error message back to the originating channel.
- Timeout exceptions (when no message is available) are silently swallowed.

---

## 10. Stage 6: processMessage() — Routing & Session

```typescript
// src/agent/loop.ts:237-328
private async processMessage(
  msg: InboundMessage,
  sessionKeyOverride?: string,
): Promise<OutboundMessage | null> {
```

### Step 6.1: System message routing

```typescript
// line 242-244
if (msg.channel === "system") {
  return this.processSystemMessage(msg);
}
```

System messages come from subagents (see [Stage 14](#18-stage-14-subagent-flow-when-spawn-tool-is-used)). They are routed to `processSystemMessage()` which parses the origin channel/chatId from `msg.chatId` (format `"channel:chatId"`).

### Step 6.2: Logging

```typescript
// line 246-247
const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + "..." : msg.content;
log.info({ channel: msg.channel, sender: msg.senderId, preview }, "Processing message");
```

### Step 6.3: Session lookup

```typescript
// line 249-250
const key = sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
const session = this.sessions.getOrCreate(key);
```

Session key format: `"telegram:123456"` or `"cli:direct"` (CLI default).

**SessionManager.getOrCreate()** (`src/session/manager.ts:75-88`):
```typescript
getOrCreate(key: string): Session {
  // 1. Check in-memory cache
  const cached = this.cache.get(key);
  if (cached) return cached;

  // 2. Try loading from disk (~/.robun/sessions/{safeFilename}.jsonl)
  const loaded = this.load(key);
  if (loaded) {
    this.cache.set(key, loaded);
    return loaded;
  }

  // 3. Create new empty session
  const session = new Session(key);
  this.cache.set(key, session);
  return session;
}
```

**Session.load()** reads a JSONL file where:
- Line 1: `{ _type: "metadata", createdAt, updatedAt, metadata, lastConsolidated }`
- Lines 2+: `{ role, content, timestamp, toolsUsed?, toolCallId?, toolCalls? }`

### Step 6.4: Slash command handling

```typescript
// line 253-286
const cmd = msg.content.trim().toLowerCase();

if (cmd === "/new") {
  // Archive current messages for memory consolidation
  const messagesToArchive = [...session.messages];
  session.clear();
  this.sessions.save(session);
  this.sessions.invalidate(session.key);  // Remove from cache

  // Background memory consolidation of archived messages
  const tempSession = new Session(session.key);
  tempSession.messages = messagesToArchive;
  this.consolidateMemory(tempSession, true).catch(...);

  return {
    channel: msg.channel,
    chatId: msg.chatId,
    content: "New session started. Memory consolidation in progress.",
    ...
  };
}

if (cmd === "/help") {
  return {
    content: "robun commands:\n/new - Start a new conversation\n/help - Show available commands",
    ...
  };
}
```

**`/new`** clears the session, saves the empty session to disk, invalidates the cache, and triggers **background** memory consolidation of the old messages.

### Step 6.5: Memory consolidation trigger

```typescript
// line 289-293
if (session.messages.length > this.memoryWindow) {
  this.consolidateMemory(session).catch((err) =>
    log.error({ err }, "Background consolidation failed"),
  );
}
```

When the session grows beyond `memoryWindow` (default 50 messages), background memory consolidation runs. This is **fire-and-forget** — it doesn't block the current request. See [Stage 13](#17-stage-13-memory-consolidation-background).

### Step 6.6: Set tool context

```typescript
// line 295
this.setToolContext(msg.channel, msg.chatId);
```

```typescript
// src/agent/loop.ts:129-144
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
```

This injects the current channel and chatId into the `message`, `spawn`, and `cron` tools so they know where to route their output. Without this, the agent's tool calls wouldn't know which channel/chat to target.

### Step 6.7: Build messages for LLM

```typescript
// line 297-303
const initialMessages = this.context.buildMessages({
  history: session.getHistory(this.memoryWindow),
  currentMessage: msg.content,
  media: msg.media.length > 0 ? msg.media : null,
  channel: msg.channel,
  chatId: msg.chatId,
});
```

See [Stage 7](#11-stage-7-contextbuilderbuildmessages--llm-prompt-assembly) for full details.

### Step 6.8: Run the LLM tool-use loop

```typescript
// line 305
const [finalContent, toolsUsed] = await this.runAgentLoop(initialMessages);
```

See [Stage 8](#12-stage-8-runagentloop--the-llm-tool-use-cycle).

### Step 6.9: Save to session and return

```typescript
// line 307-327
const responseContent = finalContent ?? "I've completed processing but have no response to give.";

// Log response preview
const responsePreview = responseContent.length > 120
  ? responseContent.slice(0, 120) + "..."
  : responseContent;
log.info({ channel: msg.channel, sender: msg.senderId, preview: responsePreview }, "Response");

// Save both user message and assistant response to session
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
```

**Important:** Messages are saved to the session **after** the LLM finishes. If the process crashes mid-response, neither the user message nor the response will be persisted.

---

## 11. Stage 7: ContextBuilder.buildMessages() — LLM Prompt Assembly

This is where the full prompt sent to the LLM is constructed.

```typescript
// src/agent/context.ts:61-84
buildMessages(options: {
  history: Array<{ role: string; content: string }>;
  currentMessage: string;
  skillNames?: string[];
  media?: string[] | null;
  channel?: string;
  chatId?: string;
}): Array<{ role: string; content: string | unknown[] }> {
  const messages = [];

  // [1] SYSTEM PROMPT — the big one
  messages.push({
    role: "system",
    content: this.buildSystemPrompt(options.skillNames),
  });

  // [2] CONVERSATION HISTORY — last N messages from session
  for (const msg of options.history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // [3] CURRENT USER MESSAGE — with optional image attachments
  const userContent = this.buildUserContent(options.currentMessage, options.media);
  messages.push({ role: "user", content: userContent });

  return messages;
}
```

### The System Prompt (`buildSystemPrompt`)

```typescript
// src/agent/context.ts:20-42
buildSystemPrompt(skillNames?: string[]): string {
  const sections: string[] = [];

  // SECTION 1: Identity
  sections.push(this.getIdentity());
  // Output: "## Identity\n\nYou are robun, an AI assistant.\nTimestamp: ...\nOS: ...\nWorkspace: ..."

  // SECTION 2: Bootstrap files (AGENTS.md, SOUL.md, USER.md, TOOLS.md, IDENTITY.md)
  const bootstrap = this.loadBootstrapFiles();
  if (bootstrap) sections.push(bootstrap);

  // SECTION 3: Long-term memory (MEMORY.md content)
  const memoryCtx = this.memory.getMemoryContext();
  if (memoryCtx) sections.push(memoryCtx);
  // Output: "## Long-term Memory\n\n{content of MEMORY.md}"

  // SECTION 4: Active skills (always-loaded + requested)
  const alwaysSkills = this.skills.getAlwaysSkills();
  const allSkillNames = [...new Set([...alwaysSkills, ...(skillNames ?? [])])];
  if (allSkillNames.length > 0) {
    const skillContent = this.skills.loadSkillsForContext(allSkillNames);
    if (skillContent) sections.push(`## Active Skills\n\n${skillContent}`);
  }

  // SECTION 5: Available skills summary (XML listing)
  const summary = this.skills.buildSkillsSummary();
  if (summary) sections.push(`## Available Skills\n\n${summary}`);
  // Output: "<skills>\n  <skill available="true">\n    <name>...</name>..."

  // Join all sections with horizontal rule separators
  return sections.join("\n\n---\n\n");
}
```

### Bootstrap Files Loading

```typescript
// src/agent/context.ts:50-59
private loadBootstrapFiles(): string {
  const parts: string[] = [];
  for (const filename of ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"]) {
    const filePath = join(this.workspace, filename);
    if (!existsSync(filePath)) continue;  // Skip missing files
    const content = readFileSync(filePath, "utf-8").trim();
    if (content) parts.push(`## ${filename}\n\n${content}`);
  }
  return parts.join("\n\n");
}
```

Each file is read from the workspace directory (`~/.robun/workspace/` by default). Missing files are silently skipped.

### Media Processing (Images)

```typescript
// src/agent/context.ts:86-112
private buildUserContent(text: string, media?: string[] | null): string | unknown[] {
  if (!media || media.length === 0) return text;  // Plain text, no media

  // Multi-part content (text + images)
  const parts: unknown[] = [{ type: "text", text }];
  for (const mediaPath of media) {
    try {
      const data = readFileSync(mediaPath);
      const base64 = data.toString("base64");
      const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "png";
      const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
                     gif: "image/gif", webp: "image/webp" }[ext] ?? "image/png";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${base64}` },
      });
    } catch {
      // Skip unreadable media silently
    }
  }
  return parts;
}
```

When media (images) is attached, the user message becomes a multi-part array following the OpenAI vision API format. Images are read from disk and base64-encoded inline.

### History Retrieval

```typescript
// src/session/manager.ts:50-53
getHistory(maxMessages?: number): Array<{ role: string; content: string }> {
  const msgs = maxMessages ? this.messages.slice(-maxMessages) : this.messages;
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}
```

Returns the last `memoryWindow` (default 50) messages as `{role, content}` pairs. Only `role` and `content` are kept — timestamps, toolsUsed, etc. are stripped.

### Final message array structure

```
[
  { role: "system",    content: "<identity>\n---\n<AGENTS.md>\n<SOUL.md>...\n---\n<memory>\n---\n<skills>" },
  { role: "user",      content: "Hello" },           // ← from session history
  { role: "assistant", content: "Hi! How can I..." }, // ← from session history
  { role: "user",      content: "What is 2+2?" },    // ← from session history
  { role: "assistant", content: "2+2 = 4" },          // ← from session history
  ...
  { role: "user",      content: "What is 2+2?" },    // ← current message
]
```

---

## 12. Stage 8: runAgentLoop() — The LLM Tool-Use Cycle

This is the **core orchestration loop** that calls the LLM repeatedly until it produces a final text response.

```typescript
// src/agent/loop.ts:146-200
private async runAgentLoop(
  initialMessages: Array<{ role: string; content: string | unknown[] }>,
): Promise<[string | null, string[]]> {
  const messages: Array<Record<string, unknown>> = [...initialMessages];
  let iteration = 0;
  let finalContent: string | null = null;
  const toolsUsed: string[] = [];

  while (iteration < this.maxIterations) {  // default: 20
    iteration++;

    // ── STEP 8.1: Call the LLM ──
    const response: LLMResponse = await this.provider.chat(
      messages as Array<{ role: string; content: string }>,
      {
        tools: this.tools.getDefinitions(),  // All registered tools as JSON Schema
        model: this.model,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      },
    );

    // ── STEP 8.2: Check if LLM wants to use tools ──
    if (hasToolCalls(response)) {
      // Convert tool calls to OpenAI message format
      const toolCallDicts = response.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));

      // Add assistant's message (with tool calls) to conversation
      ContextBuilder.addAssistantMessage(
        messages,
        response.content,       // May contain text alongside tool calls
        toolCallDicts,
        response.reasoningContent,  // For reasoning models (o1, etc.)
      );

      // ── STEP 8.3: Execute each tool ──
      for (const tc of response.toolCalls) {
        toolsUsed.push(tc.name);
        const argsStr = JSON.stringify(tc.arguments);
        log.info({ tool: tc.name, args: argsStr.slice(0, 200) }, "Tool call");

        const result = await this.tools.execute(tc.name, tc.arguments);

        // Add tool result to conversation
        ContextBuilder.addToolResult(messages, tc.id, tc.name, result);
      }

      // ── STEP 8.4: Add reflection prompt ──
      messages.push({
        role: "user",
        content: "Reflect on the results and decide next steps.",
      });

      // Loop back to STEP 8.1 for next LLM call

    } else {
      // ── STEP 8.5: No tool calls → final response ──
      finalContent = response.content;
      break;
    }
  }

  return [finalContent, toolsUsed];
}
```

### How the loop terminates

The loop ends when **either**:
1. The LLM returns a response **without tool calls** → `finalContent` is set, `break`
2. The iteration count reaches `maxIterations` (default 20) → `finalContent` stays `null`, returns `[null, toolsUsed]`

When `finalContent` is null, `processMessage()` at line 307 uses the fallback: `"I've completed processing but have no response to give."`

### Message array growth during the loop

After 3 tool call iterations, the messages array looks like:

```
[system prompt]
[history messages...]
[current user message]
                                    ← iteration 1:
[assistant + tool_calls: [read_file]]
[tool result: "file contents..."]
[user: "Reflect on the results and decide next steps."]
                                    ← iteration 2:
[assistant + tool_calls: [exec]]
[tool result: "command output..."]
[user: "Reflect on the results and decide next steps."]
                                    ← iteration 3:
[assistant: "Here is what I found..."]  ← final response, loop breaks
```

### Static helper methods for message formatting

```typescript
// src/agent/context.ts:114-126
static addToolResult(messages, toolCallId, _toolName, result): unknown[] {
  messages.push({
    role: "tool",
    content: result,
    tool_call_id: toolCallId,
  });
  return messages;
}

// src/agent/context.ts:128-140
static addAssistantMessage(messages, content, toolCalls?, reasoningContent?): unknown[] {
  const msg: Record<string, unknown> = { role: "assistant" };
  if (content !== null) msg.content = content;
  if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
  if (reasoningContent) msg.reasoning_content = reasoningContent;
  messages.push(msg);
  return messages;
}
```

---

## 13. Stage 9: Provider.chat() — The HTTP Call to the LLM

```typescript
// src/providers/litellm.ts:68-136
async chat(messages, options = {}): Promise<LLMResponse> {
  const model = options.model ?? this.defaultModel;
  const { resolvedModel, spec } = this.resolveModel(model);
```

### Step 9.1: Model resolution

```typescript
// src/providers/litellm.ts:50-66
private resolveModel(model: string) {
  if (this.gatewaySpec) {
    let m = model;
    // Strip provider prefix for gateways (e.g., "anthropic/claude-3" → "claude-3")
    if (this.gatewaySpec.stripModelPrefix && m.includes("/")) {
      m = m.split("/").slice(1).join("/");
    }
    return { resolvedModel: m, spec: this.gatewaySpec };
  }

  const spec = findByModel(model);
  if (spec?.litellmPrefix) {
    // Prepend litellm prefix if needed
    if (!spec.skipPrefixes.some((sp) => model.startsWith(sp))) {
      return { resolvedModel: `${spec.litellmPrefix}/${model}`, spec };
    }
  }
  return { resolvedModel: model, spec };
}
```

### Step 9.2: Build request body

```typescript
// line 83-101
const baseUrl = this.apiBase ?? spec?.defaultApiBase ?? this.getDefaultBaseUrl(spec);

const body = {
  model: resolvedModel,
  messages,
  max_tokens: Math.max(1, options.maxTokens ?? 4096),
  temperature: options.temperature ?? 0.7,
};

// Add tools if provided
if (options.tools && options.tools.length > 0) {
  body.tools = options.tools;
  body.tool_choice = "auto";
}

// Apply model-specific overrides (e.g., special params for reasoning models)
if (spec?.modelOverrides) {
  for (const [pattern, overrides] of spec.modelOverrides) {
    if (model.toLowerCase().includes(pattern)) {
      Object.assign(body, overrides);
    }
  }
}
```

### Step 9.3: Make the HTTP request

```typescript
// line 103-112
const resp = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(this.extraHeaders ?? {}),
  },
  body: JSON.stringify(body),
});
```

All providers use the OpenAI-compatible `/chat/completions` endpoint.

### Step 9.4: Error handling

```typescript
// line 114-123
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
```

HTTP errors are **not thrown** — they're returned as an `LLMResponse` with `finishReason: "error"` and the error in `content`. This means the agent loop will treat the error message as the LLM's final response and break out of the loop.

Network/fetch errors (line 127-135) are also caught and returned as error responses, not thrown.

### Step 9.5: Response parsing

```typescript
// src/providers/litellm.ts:151-194
private async parseResponse(data): Promise<LLMResponse> {
  const choices = data.choices;
  const choice = choices?.[0];
  const message = choice?.message;
  const toolCalls: ToolCallRequest[] = [];

  // Parse tool calls
  const rawToolCalls = message?.tool_calls;
  if (rawToolCalls) {
    for (const tc of rawToolCalls) {
      const fn = tc.function;
      let args = {};
      const rawArgs = fn.arguments ?? "{}";
      try {
        // Try jsonrepair first (handles malformed JSON from LLMs)
        const { jsonrepair } = await import("jsonrepair");
        args = JSON.parse(jsonrepair(rawArgs));
      } catch {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};  // Fallback: empty args
        }
      }
      toolCalls.push({ id: tc.id, name: fn.name, arguments: args });
    }
  }

  return {
    content: message?.content ?? null,
    toolCalls,
    finishReason: (choice?.finish_reason ?? "stop"),
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
    reasoningContent: message?.reasoning_content ?? null,
  };
}
```

**Debugging note:** The `jsonrepair` library is used to handle malformed JSON in tool call arguments, which LLMs sometimes produce. If both `jsonrepair` and `JSON.parse` fail, args default to `{}`.

---

## 14. Stage 10: Tool Execution

### `ToolRegistry.execute()`

```typescript
// src/tools/base.ts:48-61
async execute(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = this.tools.get(name);
  if (!tool) return `Error: Tool '${name}' not found.`;

  try {
    // Validate parameters against the tool's Zod schema
    const validated = tool.parameters.parse(params);
    return await tool.execute(validated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return `Invalid parameters: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
    }
    return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

**Critical behavior:** Tool errors are **never thrown**. They are always returned as error strings. This means:
- A tool name typo → `"Error: Tool 'rea_file' not found."`
- Invalid params → `"Invalid parameters: path: Required"`
- Runtime error → `"Error executing exec: Command timed out"`

All of these become the tool result string that's fed back to the LLM.

### Tool JSON Schema Generation

```typescript
// src/tools/base.ts:11-23
export function toolToSchema(tool: Tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters, { target: "openAi" }),
    },
  };
}
```

```typescript
// src/tools/base.ts:44-46
getDefinitions(): unknown[] {
  return Array.from(this.tools.values()).map(toolToSchema);
}
```

Each tool's Zod schema is converted to JSON Schema using `zod-to-json-schema` with `target: "openAi"` for compatibility with the OpenAI function calling format.

---

## 15. Stage 11: Response Finalization & Session Persistence

Back in `processMessage()` after `runAgentLoop()` returns:

```typescript
// src/agent/loop.ts:307-327
const responseContent = finalContent ?? "I've completed processing but have no response to give.";

// Log a preview (truncated to 120 chars)
const responsePreview = responseContent.length > 120
  ? responseContent.slice(0, 120) + "..."
  : responseContent;
log.info({ channel: msg.channel, sender: msg.senderId, preview: responsePreview }, "Response");

// Save BOTH messages to session
session.addMessage("user", msg.content);
session.addMessage("assistant", responseContent,
  toolsUsed.length > 0 ? { toolsUsed } : undefined,
);
this.sessions.save(session);
```

### Session.addMessage()

```typescript
// src/session/manager.ts:38-48
addMessage(role: string, content: string, extra?: Record<string, unknown>): void {
  this.messages.push(
    SessionMessageSchema.parse({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,  // e.g., { toolsUsed: ["exec", "read_file"] }
    }),
  );
  this.updatedAt = new Date();
}
```

### SessionManager.save()

```typescript
// src/session/manager.ts:115-134
save(session: Session): void {
  const path = this.getSessionPath(session.key);  // ~/.robun/sessions/{key}.jsonl
  const lines: string[] = [];

  // Line 1: metadata
  lines.push(JSON.stringify({
    _type: "metadata",
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    metadata: session.metadata,
    lastConsolidated: session.lastConsolidated,
  }));

  // Remaining lines: messages
  for (const msg of session.messages) {
    lines.push(JSON.stringify(msg));
  }

  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}
```

The entire session is **rewritten** on every save (not appended). The JSONL file is atomic — if the write fails, you lose the entire session file.

### Return the OutboundMessage

```typescript
// line 320-327
return {
  channel: msg.channel,
  chatId: msg.chatId,
  content: responseContent,
  replyTo: null,
  media: [],
  metadata: msg.metadata ?? {},
};
```

---

## 16. Stage 12: Outbound Delivery

### Path A: CLI/HTTP — Direct return

For CLI mode, `processDirect()` returns the response directly:
```typescript
// src/agent/loop.ts:506-509
return {
  content: response?.content ?? "",
  sessionKey,
};
```

CLI prints it. HTTP returns it as JSON. No bus involvement.

### Path B: Channel — Bus outbound delivery

For channel messages, `run()` publishes to the outbound bus:
```typescript
// src/agent/loop.ts:213
await this.bus.publishOutbound(response);
```

```typescript
// src/bus/queue.ts:43-45
async publishOutbound(msg: OutboundMessage): Promise<void> {
  this.outboundQueue.push(msg);
}
```

### Outbound dispatcher loop

```typescript
// src/bus/queue.ts:53-70
async dispatchOutbound(): Promise<void> {
  while (this.running) {
    if (this.outboundQueue.length === 0) {
      await new Promise((r) => setTimeout(r, 50));  // Poll every 50ms
      continue;
    }

    const msg = this.outboundQueue.shift()!;
    // Find subscribers for this channel name
    const subscribers = this.outboundSubscribers.get(msg.channel) ?? [];
    for (const cb of subscribers) {
      try {
        await cb(msg);  // Call channel.send(msg)
      } catch (err) {
        log.error({ err, channel: msg.channel }, "outbound dispatch error");
      }
    }
  }
}
```

This loop runs in the background (started by `channelManager.startAll()` at `src/channels/manager.ts:78`). It polls the outbound queue every 50ms and dispatches messages to the appropriate channel's `send()` method.

### Channel subscription setup

```typescript
// src/channels/manager.ts:73-74
for (const [name, channel] of this.channels) {
  this.bus.subscribeOutbound(name, (msg) => channel.send(msg));
}
```

Each channel subscribes to outbound messages matching its name. When a message with `channel: "telegram"` is dispatched, the `TelegramChannel.send()` method is called.

---

## 17. Stage 13: Memory Consolidation (Background)

Memory consolidation runs **asynchronously** in two scenarios:
1. **Session too long:** When `session.messages.length > memoryWindow` (line 289)
2. **`/new` command:** Archives all messages before clearing (line 263)

```typescript
// src/agent/loop.ts:374-485
private async consolidateMemory(session: Session, archiveAll = false): Promise<void> {
  const memory = new MemoryStore(this.workspace);

  let oldMessages: Array<Record<string, unknown>>;
  let keepCount: number;

  if (archiveAll) {
    // /new command: process ALL messages
    oldMessages = session.messages;
    keepCount = 0;
  } else {
    // Regular consolidation: keep recent half, process older half
    keepCount = Math.floor(this.memoryWindow / 2);  // 25 messages
    if (session.messages.length <= keepCount) return;

    const messagesToProcess = session.messages.length - session.lastConsolidated;
    if (messagesToProcess <= 0) return;

    oldMessages = session.messages.slice(
      session.lastConsolidated,
      -keepCount,
    );
    if (oldMessages.length === 0) return;
  }
```

### Build consolidation prompt

The old messages are formatted into a text block:
```
[2026-03-15T10:00] USER: What is 2+2?
[2026-03-15T10:00] ASSISTANT [tools: exec]: 2+2 equals 4.
```

Then sent to the LLM with a prompt asking for:
1. `history_entry` — A 2-5 sentence summary for HISTORY.md
2. `memory_update` — Updated MEMORY.md content (add new facts, keep existing)

### Parse and save

```typescript
// line 453-476
let result = JSON.parse(text);  // or jsonrepair(text)

const entry = result.history_entry;
if (entry) memory.appendHistory(entry);  // Append to HISTORY.md

const update = result.memory_update;
if (update && update !== currentMemory) {
  memory.writeLongTerm(update);  // Overwrite MEMORY.md
}

// Update consolidation pointer
if (archiveAll) {
  session.lastConsolidated = 0;
} else {
  session.lastConsolidated = session.messages.length - keepCount;
}
```

### MemoryStore operations

```typescript
// src/agent/memory.ts:16-19
readLongTerm(): string {
  if (!existsSync(this.memoryFile)) return "";
  return readFileSync(this.memoryFile, "utf-8");
}

// src/agent/memory.ts:21-23
writeLongTerm(content: string): void {
  writeFileSync(this.memoryFile, content, "utf-8");
}

// src/agent/memory.ts:25-27
appendHistory(entry: string): void {
  appendFileSync(this.historyFile, entry + "\n\n", "utf-8");
}
```

MEMORY.md is **overwritten** each time. HISTORY.md is **appended** to.

---

## 18. Stage 14: Subagent Flow (When Spawn Tool Is Used)

If the LLM calls the `spawn` tool during the agent loop, a background subagent is created.

### Spawn initiation

```typescript
// src/agent/subagent.ts:48-66
async spawn(task, label, originChannel, originChatId): Promise<string> {
  const taskId = crypto.randomUUID().slice(0, 8);

  // Fire-and-forget background execution
  this.runSubagent(taskId, task, label, originChannel, originChatId)
    .finally(() => this.runningTasks.delete(taskId));

  return `Subagent [${label}] started (id: ${taskId}). I'll notify you when it completes.`;
}
```

The return value becomes the tool result in the main agent loop. The subagent runs independently.

### Subagent execution

```typescript
// src/agent/subagent.ts:68-159
private async runSubagent(taskId, task, label, originChannel, originChatId): Promise<void> {
  // Build ISOLATED tool registry (NO message/spawn/cron tools)
  const tools = new ToolRegistry();
  tools.register(new ReadFileTool(allowedDir));
  tools.register(new WriteFileTool(allowedDir));
  tools.register(new EditFileTool(allowedDir));
  tools.register(new ListDirTool(allowedDir));
  tools.register(new ExecTool({...}));
  tools.register(new WebSearchTool({...}));
  tools.register(new WebFetchTool());

  // Run its own agent loop (max 15 iterations, not 20)
  const messages = [
    { role: "system", content: subagentSystemPrompt },
    { role: "user", content: task },
  ];

  while (iteration < 15) {
    const response = await this.provider.chat(messages, { tools: tools.getDefinitions(), ... });
    if (hasToolCalls(response)) {
      // Execute tools, append results, continue
    } else {
      finalResult = response.content;
      break;
    }
  }

  // Announce result back to main agent
  await this.announceResult(taskId, label, task, finalResult, originChannel, originChatId, "done");
}
```

### Result announcement

```typescript
// src/agent/subagent.ts:161-193
private async announceResult(taskId, label, task, result, originChannel, originChatId, status) {
  const msg: InboundMessage = {
    channel: "system",                           // Special system channel
    senderId: "subagent",
    chatId: `${originChannel}:${originChatId}`,  // Encodes origin for routing
    content: `[Subagent '${label}' completed]\n\nTask: ${task}\n\nResult:\n${result}\n\nSummarize...`,
    timestamp: new Date(),
    media: [],
    metadata: {},
  };

  await this.bus.publishInbound(msg);  // Goes back into the inbound queue
}
```

The result is published as a **system message** to the inbound bus. The main `AgentLoop.run()` picks it up, sees `channel === "system"`, and routes it to `processSystemMessage()`:

```typescript
// src/agent/loop.ts:330-372
private async processSystemMessage(msg: InboundMessage): Promise<OutboundMessage | null> {
  // Parse origin from chatId (format: "channel:chatId")
  let originChannel, originChatId;
  if (msg.chatId.includes(":")) {
    const sepIdx = msg.chatId.indexOf(":");
    originChannel = msg.chatId.slice(0, sepIdx);
    originChatId = msg.chatId.slice(sepIdx + 1);
  } else {
    originChannel = "cli";
    originChatId = msg.chatId;
  }

  // Run through the full agent loop to summarize
  const initialMessages = this.context.buildMessages({
    history: session.getHistory(this.memoryWindow),
    currentMessage: msg.content,
    ...
  });

  const [finalContent] = await this.runAgentLoop(initialMessages);
  // The LLM summarizes the subagent result for the user

  return {
    channel: originChannel,
    chatId: originChatId,
    content: responseContent,
    ...
  };
}
```

The subagent result triggers **another full LLM call** in the main agent, which summarizes the result and delivers it to the original channel.

---

## 19. Error Paths

### LLM API errors

- **HTTP 4xx/5xx:** Returned as `LLMResponse` with `content: "Error: 429 Rate limit exceeded"`, `finishReason: "error"`. The agent loop treats this as a final response — no tool calls, so it breaks out. The user sees the error as the response.
- **Network error:** Same treatment — returned as error response, not thrown.

### Tool execution errors

- **Unknown tool:** `"Error: Tool 'xxx' not found."` — returned to LLM as tool result
- **Zod validation failure:** `"Invalid parameters: path: Required"` — returned to LLM
- **Runtime error:** `"Error executing exec: Command timed out"` — returned to LLM

In all cases, the LLM sees the error and can decide to retry or respond to the user.

### Message processing errors

```typescript
// src/agent/loop.ts:215-225
} catch (err) {
  log.error({ err }, "Error processing message");
  await this.bus.publishOutbound({
    channel: msg.channel,
    chatId: msg.chatId,
    content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : String(err)}`,
    ...
  });
}
```

Uncaught errors during `processMessage()` send an error message to the user and the loop continues.

### Memory consolidation errors

```typescript
// line 290-292
this.consolidateMemory(session).catch((err) =>
  log.error({ err }, "Background consolidation failed"),
);
```

Memory consolidation errors are logged but never affect the main flow.

### Channel start errors

```typescript
// src/channels/manager.ts:84-88
try {
  await channel.start();
} catch (e) {
  logger.error(`Failed to start channel ${name}: ${e}`);
}
```

Individual channel failures don't crash the system.

---

## 20. Key Constants & Defaults

| Constant | Default | Location | Description |
|---|---|---|---|
| `maxIterations` | 20 | `loop.ts:64` | Max LLM calls per request |
| `temperature` | 0.7 | `loop.ts:65` | LLM temperature |
| `maxTokens` | 4096 | `loop.ts:66` | Max response tokens |
| `memoryWindow` | 50 | `loop.ts:67` | Messages kept in context |
| `model` | `anthropic/claude-opus-4-5` | `litellm.ts:20` | Default model |
| `execTimeout` | 60s | `shell.ts` | Shell command timeout |
| `consumeInbound timeout` | 1000ms | `loop.ts:209` | Bus poll interval |
| `dispatchOutbound poll` | 50ms | `queue.ts:56` | Outbound dispatch interval |
| `subagent maxIterations` | 15 | `subagent.ts:99` | Max LLM calls per subagent |
| `consolidation keepCount` | `memoryWindow/2` (25) | `loop.ts:385` | Messages kept after consolidation |
| Gateway port | 18790 | `cli.ts:275` | HTTP server port |
| Session file format | JSONL | `manager.ts:72` | `~/.robun/sessions/{key}.jsonl` |
| Session key format | `channel:chatId` | `loop.ts:249` | e.g., `telegram:123456` |

---

## Quick Reference: File-to-Stage Mapping

| File | Stage(s) | Purpose |
|---|---|---|
| `src/index.ts` | Entry | CLI dispatch |
| `src/cli.ts` | Entry, 1, 2, 3 | Command handlers, config, provider factory |
| `src/server.ts` | Entry (HTTP) | Hono HTTP API |
| `src/config/loader.ts` | 1 | Config loading & env overrides |
| `src/config/schema.ts` | 1 | Zod config schemas |
| `src/providers/registry.ts` | 2 | Provider spec database |
| `src/providers/litellm.ts` | 9 | LLM HTTP client |
| `src/providers/base.ts` | 9 | LLMResponse schema |
| `src/bus/events.ts` | 4 | Message type definitions |
| `src/bus/queue.ts` | 4, 12 | Inbound/outbound queuing |
| `src/channels/base.ts` | Entry (Channel) | Base channel + access control |
| `src/channels/manager.ts` | 3, 12 | Channel lifecycle + outbound subscription |
| `src/agent/loop.ts` | 5, 6, 8, 13, 14 | Core agent loop & processing |
| `src/agent/context.ts` | 7 | System prompt & message assembly |
| `src/agent/memory.ts` | 7, 13 | MEMORY.md / HISTORY.md I/O |
| `src/agent/skills.ts` | 7 | Skill loading & summaries |
| `src/agent/subagent.ts` | 14 | Background subagent execution |
| `src/tools/base.ts` | 3, 10 | Tool interface, registry, execution |
| `src/session/manager.ts` | 6, 11 | Session CRUD & JSONL persistence |
