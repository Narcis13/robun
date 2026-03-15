# Robun AI Agent Framework: iOS Portability Report

**Date:** 2026-02-26
**Subject:** Feasibility analysis for porting Robun to iOS (iPhone)
**Runtime Target:** React Native / Expo with Hermes engine

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [iOS Runtime Landscape](#2-ios-runtime-landscape)
3. [Portability Analysis — What Is Portable](#3-portability-analysis--what-is-portable)
4. [Portability Analysis — What Is NOT Portable](#4-portability-analysis--what-is-not-portable)
5. [iOS Platform Constraints](#5-ios-platform-constraints)
6. [Dependency Compatibility Matrix](#6-dependency-compatibility-matrix)
7. [Channel Portability Breakdown](#7-channel-portability-breakdown)
8. [Mitigation Solutions](#8-mitigation-solutions)
9. [Recommended Architecture](#9-recommended-architecture)
10. [Migration Roadmap](#10-migration-roadmap)
11. [iOS Use Cases](#11-ios-use-cases-for-robun)

---

## 1. Executive Summary

Robun is a TypeScript AI agent framework running on Bun with a CLI/HTTP gateway interface, multi-channel messaging (9 channels), a tool system, cron scheduling, and session persistence. This report evaluates its portability to iOS.

**Overall Assessment: Challenging but Feasible with Split Architecture**

| Category | Verdict |
|----------|---------|
| Core Agent Loop | ~70% portable — LLM orchestration, tool dispatch, and session logic work with adaptation |
| LLM Providers | ~95% portable — fetch-based HTTP calls are web-standard |
| Tool System | ~50% portable — web/message tools work; shell/spawn/MCP are blocked |
| Channel System | ~35% portable — most channels need WebSocket rewrites; WhatsApp/Email are blocked |
| Config & Storage | ~85% portable — file I/O needs iOS sandboxed path adapter |
| Entry Points (CLI/Server) | ~10% portable — must be entirely replaced with native iOS UI |

**Recommended Approach:** A hybrid architecture where the iOS app runs a local agent core (LLM calls, sandboxed tools, session management) while a companion cloud server handles channels, cron, shell execution, and MCP connections.

---

## 2. iOS Runtime Landscape

### Recommended: React Native + Expo (Hermes Engine)

| Runtime | Viability | Notes |
|---------|-----------|-------|
| **React Native + Expo** | **Best option** | Hermes engine, Expo SDK 54, rich native module ecosystem, `expo-file-system`, `expo-sqlite`, streaming `expo/fetch` |
| JavaScriptCore (native) | Possible but low-level | No module system, no npm, no fetch — would require building everything from scratch |
| NativeScript | Viable alternative | V8 engine (better `instanceof`), smaller ecosystem than Expo |
| Capacitor/Ionic | WebView-based | Performance ceiling, WebView suspended on background, not ideal for always-on agent |
| **Bun on iOS** | **Not available** | No iOS support, no roadmap, relies on POSIX syscalls incompatible with iOS sandbox |

**Key Expo Advantages:**
- `expo-file-system` for sandboxed file I/O (replaces `node:fs`)
- `expo-sqlite` for persistent storage (replaces JSONL sessions)
- `expo/fetch` supports `ReadableStream` for streaming LLM responses
- `@react-native-ai/apple` provides on-device Apple Intelligence Foundation Models (iOS 26+) — text generation, streaming, tool calling
- Vercel AI SDK has official Expo integration
- Background fetch and `BGContinuedProcessingTask` (iOS 26+) support

---

## 3. Portability Analysis — What Is Portable

### 3.1 LLM Provider Layer (~95% portable)

**Files:** `src/providers/base.ts`, `src/providers/litellm.ts`

The LLM provider interface is clean and fetch-based:
- `chat()` method makes HTTP requests using standard `fetch()` API
- JSON request/response parsing is pure JavaScript
- Zod v3 schemas for validation work on React Native
- Tool/function calling parameter conversion via `zod-to-json-schema` is pure JS

**Only change needed:** Replace `process.env` access (used for API key injection in `litellm.ts`) with a configuration object passed at initialization.

### 3.2 Message Bus (~100% portable)

**File:** `src/bus/queue.ts`

The message bus is pure JavaScript:
- In-memory arrays for inbound/outbound queues
- `Promise`/`setTimeout`-based waiter system
- `Map` for outbound subscribers
- No Node.js or Bun APIs

Works as-is on any JavaScript runtime. For iOS resilience, queues should be backed by persistent storage (SQLite) to survive app termination.

### 3.3 Web Tools (~100% portable)

**File:** `src/tools/web.ts`

Both `WebSearchTool` and `WebFetchTool` use:
- Standard `fetch()` API
- `URL` constructor and `searchParams`
- `AbortSignal.timeout()` for request timeouts
- `@mozilla/readability` and `linkedom` for HTML parsing (pure JS libraries)

No changes needed.

### 3.4 Message Tool (~100% portable)

**File:** `src/tools/message.ts`

Pure in-memory callback dispatch. No platform dependencies.

### 3.5 Configuration Schemas (~100% portable)

**File:** `src/config/schema.ts`

All Zod validation schemas are pure TypeScript. Channel configs, tool configs, and agent settings work without modification on React Native (using Zod v3).

### 3.6 Session Storage Format (~90% portable)

**File:** `src/session/manager.ts`

The JSONL format for session persistence is portable:
- Line 1: metadata (creation time, consolidation state)
- Line 2+: conversation messages with roles and timestamps

**Only change needed:** Replace `node:fs` calls (`readFileSync`, `writeFileSync`, `mkdirSync`) with `expo-file-system` equivalents. The data format itself is fully compatible.

### 3.7 Agent Memory (~95% portable)

**File:** `src/agent/memory.ts`

Memory read/write/append operations are simple file I/O on markdown files. Replace `node:fs` with `expo-file-system` and redirect from `~/.robun/memory/` to the iOS app Documents directory.

### 3.8 Context Builder (~85% portable)

**File:** `src/agent/context.ts`

Loads workspace files (AGENTS.md, SOUL.md, USER.md) and builds system prompts. Base64 image encoding for media works in JavaScript. Only needs iOS path resolution and `platform()`/`hostname()` stubbing.

### 3.9 Cron Expression Parsing (~100% portable)

**Dependency:** `cron-parser` — pure JavaScript, no native bindings. Expression parsing works on any runtime. (Execution scheduling is a different story — see constraints.)

### 3.10 Skills Loader (~80% portable)

**File:** `src/agent/skills.ts`

Skills are markdown files with YAML frontmatter parsed by `gray-matter` (pure JS). The skill loading logic works except for binary requirement checking (`Bun.spawnSync(["which", bin])`) which must be stubbed on iOS.

---

## 4. Portability Analysis — What Is NOT Portable

### 4.1 Shell Execution Tool — BLOCKED

**File:** `src/tools/shell.ts`

```typescript
// Line 70 — completely impossible on iOS
const proc = Bun.spawn(["sh", "-c", params.command], {
  cwd, stdout: "pipe", stderr: "pipe", env: process.env,
});
```

iOS does not allow process spawning, shell access, or system command execution under any circumstances. This is an App Sandbox hard restriction — no workaround exists without jailbreaking.

### 4.2 MCP STDIO Transport — BLOCKED

**File:** `src/tools/mcp.ts` (lines 57-68)

`StdioClientTransport` spawns a subprocess for the MCP server. iOS cannot spawn child processes. Only the `StreamableHTTPClientTransport` (HTTP-based MCP, lines 52-56) can work on iOS, requiring MCP servers to be hosted remotely.

### 4.3 Spawn/Subagent Tool — BLOCKED (if process-based)

**File:** `src/tools/spawn.ts`

If `SubagentManager` spawns separate processes, this is incompatible. Must be re-implemented as in-process async tasks on iOS.

### 4.4 HTTP Server (Bun.serve) — BLOCKED

**File:** `src/server.ts` (line 135)

```typescript
Bun.serve({ port, fetch: app.fetch });
```

iOS apps cannot bind to network ports and listen for incoming connections. The entire Hono HTTP gateway concept must be replaced. Hono's routing logic can still be used in-process (calling `app.fetch()` programmatically), but it cannot serve external clients.

### 4.5 CLI Interface — BLOCKED

**File:** `src/index.ts`, `src/cli.ts`

`process.argv`, `readline.createInterface()`, `process.stdin/stdout`, `process.exit()`, `process.on("SIGINT")` — none of these exist on iOS. The entire CLI must be replaced with a React Native UI.

### 4.6 WhatsApp Channel — BLOCKED

**File:** `src/channels/whatsapp.ts`

The `@whiskeysockets/baileys` library is a reverse-engineered WhatsApp Web client requiring:
- Native binary dependencies (`better-sqlite3`, crypto bindings)
- Node.js EventEmitter patterns
- File-based credential persistence
- Complex WebSocket handling

**Zero iOS portability.** Would need to be replaced entirely with WhatsApp Business API (cloud-based, requires commercial agreement with Meta).

### 4.7 Email Channel — BLOCKED

**File:** `src/channels/email.ts`

Dependencies `imapflow` (IMAP), `mailparser`, and `nodemailer` (SMTP) require native TLS socket handling and Node.js stream APIs. No React Native IMAP/SMTP client exists.

### 4.8 Home Directory Resolution — BLOCKED

Used across 6+ files via `homedir()` from `node:os`. iOS has no user home directory concept — all paths must resolve to the app's sandboxed container.

---

## 5. iOS Platform Constraints

### 5.1 Background Execution

| Mechanism | Duration | Control | Robun Impact |
|-----------|----------|---------|--------------|
| **Foreground** | Unlimited | App | Agent loop runs freely |
| **BGAppRefreshTask** | ~30 seconds | System-controlled | Can sync messages, not run full agent turns |
| **BGProcessingTask** | Minutes | Only charging + Wi-Fi | Could process queued agent tasks |
| **BGContinuedProcessingTask** (iOS 26+) | Until complete | User-initiated | Can finish an agent turn started in foreground |
| **Silent Push** | ~30 seconds | Server-triggered | Can wake app to fetch new messages |

**Impact:** The agent loop (`while (this.running)` in `loop.ts`) can only run continuously while the app is foregrounded. Background execution requires a push notification-driven architecture.

### 5.2 WebSocket Connections

WebSocket connections are terminated when the app is suspended. All channels using persistent WebSocket connections (Discord, Slack Socket Mode, DingTalk, Feishu, QQ) cannot maintain connections in the background. The architecture must shift to server-side channel management with push notification relay.

### 5.3 Memory Limits

iOS Jetsam kills apps exceeding their memory budget (~1-2GB on modern iPhones). Long conversation histories, multiple sessions, and large tool results can accumulate memory. Session windowing and aggressive garbage collection are essential.

### 5.4 App Store Review — AI-Specific Rules

Apple Guideline 5.1.2(i) requires:
- Explicit disclosure of which third-party AI providers receive user data
- User consent modal before first AI feature use
- Per-provider opt-in controls in settings
- Privacy policy listing provider, purpose, and data retention

A Robun iOS app must include these consent flows for each configured LLM provider (OpenAI, Anthropic, Groq, etc.).

---

## 6. Dependency Compatibility Matrix

| Package | iOS Compatible | Notes |
|---------|---------------|-------|
| `zod` ^3.23 | **Yes** | Pure JS. Stay on v3 — v4 has Hermes `instanceof` issues |
| `zod-to-json-schema` ^3.23 | **Yes** | Pure JS |
| `cron-parser` ^5.0 | **Yes** | Pure JS |
| `gray-matter` ^4.0 | **Yes** | Pure JS YAML parser |
| `jsonrepair` ^3.10 | **Yes** | Pure JS |
| `@mozilla/readability` ^0.5 | **Yes** | Pure JS |
| `linkedom` ^0.18 | **Yes** | Pure JS DOM |
| `@msgpack/msgpack` ^3.0 | **Yes** | Pure JS serialization |
| `hono` ^4.0 | **Partial** | Routing works in-process; cannot bind port |
| `grammy` ^1.30 | **Partial** | HTTP polling works; needs `expo-file-system` for media |
| `socket.io-client` ^4.8 | **Partial** | React Native version exists |
| `ws` ^8.18 | **No** | Node.js-specific; use `global.WebSocket` on React Native |
| `pino` ^9.0 | **No** | Depends on Node.js streams; replace with `react-native-logs` |
| `chalk` ^5.0 | **No** | Terminal-only; irrelevant on mobile |
| `cli-table3` ^0.6 | **No** | Terminal-only; irrelevant on mobile |
| `@slack/socket-mode` ^2.0 | **No** | Node.js WebSocket internals |
| `@slack/web-api` ^7.0 | **No** | Node.js HTTP stack |
| `imapflow` ^1.0 | **No** | Native TLS sockets |
| `nodemailer` ^6.9 | **No** | Native SMTP stack |
| `mailparser` ^3.9.3 | **No** | Native binary deps |
| `@whiskeysockets/baileys` 7.0 | **No** | Native crypto + sqlite bindings |
| `@larksuiteoapi/node-sdk` ^1.0 | **No** | Node.js-specific SDK |
| `@modelcontextprotocol/sdk` ^1.0 | **Partial** | HTTP transport only; STDIO blocked |

---

## 7. Channel Portability Breakdown

| Channel | Protocol | iOS Portability | Key Blockers | Effort to Port |
|---------|----------|----------------|--------------|----------------|
| **Telegram** | HTTP long-polling + REST | **70%** | `node:fs` for media, `homedir()` | Low-Medium |
| **QQ** | WebSocket + REST | **70%** | `ws` package (swap to native WS) | Low |
| **DingTalk** | WebSocket + REST | **65%** | `ws` package (swap to native WS) | Low |
| **Slack** | WebSocket + REST | **60%** | SDK incompatible (reimplement with native WS) | Medium |
| **Mochat** | Socket.IO + HTTP | **25%** | Cursor file persistence, socket.io-client | High |
| **Feishu** | WebSocket + REST | **20%** | Proprietary SDK, limited protocol docs | High |
| **Discord** | WebSocket + REST | **15%** | `ws` API incompatible, file attachments | High |
| **WhatsApp** | Baileys (reverse-eng.) | **0%** | Native binary deps, crypto — impossible | N/A |
| **Email** | IMAP + SMTP | **0%** | Native TLS sockets — impossible | N/A |

### Tier Summary

**Tier 1 — Portable with moderate effort:** Telegram, QQ, DingTalk
**Tier 2 — Portable with significant refactoring:** Slack, Mochat
**Tier 3 — Not portable (need cloud proxy):** Discord, Feishu, WhatsApp, Email

---

## 8. Mitigation Solutions

### 8.1 File System Abstraction Layer

**Problem:** 15+ files use `node:fs`, `node:path`, `node:os` for file operations.

**Solution:** Create a platform abstraction interface:

```typescript
// src/platform/filesystem.ts
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  getBaseDir(): string; // Returns ~/.robun on desktop, Documents/robun on iOS
}
```

**Desktop implementation:** Wraps `node:fs` (existing behavior).
**iOS implementation:** Wraps `expo-file-system` with sandboxed paths.

All modules (`session/manager.ts`, `agent/memory.ts`, `config/loader.ts`, `cron/service.ts`, `tools/filesystem.ts`) consume this interface instead of importing `node:fs` directly.

### 8.2 WebSocket Compatibility Layer

**Problem:** 5 channels use the `ws` npm package with its Node.js-specific `.on()` event API.

**Solution:** Create a WebSocket adapter:

```typescript
// src/platform/websocket.ts
export function createWebSocket(url: string): WebSocketAdapter {
  // On Node.js/Bun: use `ws` package
  // On React Native: use global.WebSocket (built-in)
  // Normalize the API to standard WebSocket events
}
```

React Native's native WebSocket uses the browser-standard API (`onopen`, `onmessage`, `onclose`, `onerror`) instead of Node.js EventEmitter patterns (`ws.on("open")`, `ws.on("message")`).

### 8.3 Shell Tool Replacement — Sandboxed Code Execution

**Problem:** `exec` tool is completely blocked on iOS.

**Solutions (in order of practicality):**

1. **Disable entirely:** Most practical for MVP. The agent cannot execute shell commands on iOS.
2. **Remote execution proxy:** Route shell commands to a companion server that executes them and returns results.
3. **JavaScript eval sandbox:** For agents that need code execution, provide a sandboxed JavaScript evaluator using `JSContext` (limited to pure computation, no system access).
4. **On-device Swift bridge:** Expose specific safe operations (HTTP requests, file manipulation within sandbox) as "pseudo-shell" commands via native modules.

### 8.4 Background Execution Strategy

**Problem:** iOS kills background processes. The agent loop cannot run indefinitely.

**Solution — Push-Driven Architecture:**

```
[User sends message in app]
    → App foreground: agent loop processes immediately
    → App backgrounds mid-turn: BGContinuedProcessingTask completes the turn (iOS 26+)

[External message arrives (Telegram, Slack, etc.)]
    → Cloud server receives via channel adapter
    → Server processes through agent loop
    → Server sends APNs push notification to iOS device
    → App wakes briefly, syncs response to local storage
    → User sees notification, opens app to full conversation
```

### 8.5 Channel Relay Server

**Problem:** Most channels require persistent connections that iOS cannot maintain in background.

**Solution:** Run channel adapters on a companion cloud server:

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│     iOS App (Client)     │     │     Cloud Server (Relay)      │
│                          │     │                               │
│  React Native UI         │◄───►│  Hono HTTP API                │
│  Local Agent Core        │push │  All 9 Channel Adapters       │
│  Sandboxed File Tools    │     │  Cron Service                 │
│  LLM Provider (fetch)   │     │  MCP Connections              │
│  Session Cache (SQLite)  │     │  Shell Execution Tool         │
│  expo-file-system        │     │  Full Session Storage         │
│  Push Notification RX    │     │  Push Notification TX (APNs)  │
└─────────────────────────┘     └──────────────────────────────────┘
```

The iOS app communicates with the relay server via REST API. Messages from channels flow through the server, get processed, and responses are delivered to the iOS app via push notifications.

### 8.6 Persistent Queue Replacement

**Problem:** In-memory message bus queues are lost on app termination.

**Solution:** Back the `MessageBus` with `expo-sqlite`:

```typescript
// iOS queue persistence
class PersistentMessageQueue {
  private db: SQLiteDatabase;

  async publishInbound(msg: InboundMessage): Promise<void> {
    await this.db.run(
      'INSERT INTO inbound_queue (channel, sender_id, content, timestamp) VALUES (?, ?, ?, ?)',
      [msg.channel, msg.senderId, JSON.stringify(msg), Date.now()]
    );
  }

  async consumeInbound(): Promise<InboundMessage | null> {
    const row = await this.db.get('SELECT * FROM inbound_queue ORDER BY id LIMIT 1');
    if (row) {
      await this.db.run('DELETE FROM inbound_queue WHERE id = ?', [row.id]);
      return JSON.parse(row.content);
    }
    return null;
  }
}
```

### 8.7 Logger Replacement

**Problem:** `pino` depends on Node.js streams and `sonic-boom`.

**Solution:** Replace with `react-native-logs` or a custom logger with the same interface:

```typescript
// Drop-in pino replacement for iOS
import { logger } from "react-native-logs";
const log = logger.createLogger({ /* levels, transports */ });
// log.info(), log.error(), log.warn() — same API
```

### 8.8 Environment Variable Replacement

**Problem:** `process.env` is used for API keys and configuration throughout.

**Solution:** Inject configuration at app startup via a config object. Store secrets in iOS Keychain via `expo-secure-store`.

### 8.9 On-Device LLM Fallback

**Problem:** Network-dependent LLM calls fail without connectivity.

**Solution:** Use Apple Intelligence Foundation Models (iOS 26+) via `@react-native-ai/apple` as a fallback provider. This enables:
- Text generation with tool calling
- Streaming responses
- Zero network latency
- Full privacy (on-device processing)

Add as an additional provider alongside OpenAI/Anthropic/etc.

---

## 9. Recommended Architecture

### Option A: Hybrid Split (Recommended)

**iOS App (React Native + Expo):**
- Chat UI with conversation history
- Local agent core for direct LLM interactions
- Sandboxed file tools (within app container)
- Web search/fetch tools
- Session persistence (expo-sqlite)
- Agent memory (expo-file-system)
- On-device LLM via Apple Intelligence
- Push notification receiver

**Cloud Server (Existing Robun, unchanged):**
- All 9 channel adapters
- Cron and heartbeat services
- Shell execution tool
- MCP server connections
- Full workspace and file access
- APNs push notification sender
- REST API for iOS client sync

**Pros:** Maximum feature coverage, iOS app works standalone for basic use, full power with server.
**Cons:** Requires maintaining a server; two deployment targets.
**Effort:** 6-8 weeks.

### Option B: Standalone iOS (Limited)

Run everything on-device. Disable: shell exec, MCP STDIO, WhatsApp, Email, background channels.

**Pros:** No server dependency, simpler deployment.
**Cons:** Dramatically reduced feature set. No channels unless app is foregrounded.
**Effort:** 4-6 weeks.

### Option C: Thin Client (Simplest)

iOS app is purely a chat UI. All processing happens on the cloud server.

**Pros:** Minimal iOS development, all features available.
**Cons:** Requires constant network connectivity, no offline capability, server costs.
**Effort:** 2-3 weeks.

---

## 10. Migration Roadmap

### Phase 1: Platform Abstraction (Week 1-2)

| Task | Files Affected | Effort |
|------|---------------|--------|
| Create `FileSystem` interface + Node.js impl | New: `src/platform/` | 2 days |
| Create `WebSocket` adapter | New: `src/platform/websocket.ts` | 1 day |
| Create `Environment` abstraction (replace `process.env`) | All providers, config | 1 day |
| Replace all `node:fs` imports with abstraction | 15+ files | 3 days |
| Replace `homedir()` with `getBaseDir()` | 6+ files | 1 day |
| Replace `pino` with cross-platform logger | 10+ files | 1 day |

### Phase 2: iOS Core Agent (Week 3-4)

| Task | Effort |
|------|--------|
| Create Expo project with React Native | 1 day |
| Implement iOS `FileSystem` (expo-file-system) | 2 days |
| Implement iOS `WebSocket` (native) | 1 day |
| Port agent loop (disable shell/spawn/MCP) | 3 days |
| Port LLM providers (fetch-based) | 1 day |
| Port session manager (expo-sqlite) | 2 days |
| Port config loader (iOS paths) | 1 day |
| Port web tools (already compatible) | 0.5 day |

### Phase 3: iOS UI (Week 5-6)

| Task | Effort |
|------|--------|
| Chat interface (message list, input) | 3 days |
| Settings screen (LLM provider config, API keys) | 2 days |
| Session management UI | 1 day |
| Onboarding flow (workspace setup) | 1 day |
| App Store compliance (AI consent modal, privacy) | 2 days |
| Push notification integration | 2 days |

### Phase 4: Channel Relay Server (Week 7-8)

| Task | Effort |
|------|--------|
| REST API for iOS client ↔ server sync | 2 days |
| APNs push notification sending | 2 days |
| Session sync protocol | 2 days |
| Port Telegram/Slack/DingTalk to server relay | 3 days |
| Testing and integration | 3 days |

### Phase 5: Polish and Ship (Week 9-10)

| Task | Effort |
|------|--------|
| On-device Apple Intelligence provider | 2 days |
| Background execution (BGContinuedProcessingTask) | 2 days |
| Offline mode and sync conflict resolution | 3 days |
| App Store submission and review | 3 days |

**Total Estimated Effort: 8-10 weeks**

---

## 11. iOS Use Cases for Robun

### 11.1 Personal AI Assistant on the Go

The primary use case. Robun on iOS becomes a personal AI assistant that:
- Responds to natural-language queries with tool-augmented answers
- Maintains conversation history and long-term memory across sessions
- Reads and writes notes, documents, and drafts within the app sandbox
- Searches the web and fetches information in real-time
- Remembers user preferences, past decisions, and ongoing projects

**Differentiator from ChatGPT/Claude apps:** Robun's personality system (SOUL.md), instruction layer (AGENTS.md), and user preference layer (USER.md) create a deeply personalized agent that adapts to the user's communication style, domain expertise, and workflow preferences.

### 11.2 Multi-Channel Message Hub

With the companion relay server, Robun on iOS serves as a **unified inbox and AI-powered responder**:
- Receives messages from Telegram, Slack, Discord, DingTalk, QQ, and other channels
- The AI agent can draft responses, triage messages, or auto-respond based on rules
- Push notifications alert the user to important messages across all channels
- User reviews and approves agent-drafted responses from a single iOS interface
- Conversation context is maintained per-channel, per-contact

**Use case example:** A founder managing communities on Telegram, Discord, and Slack sees all messages in one app, with the AI agent pre-drafting responses and flagging urgent items.

### 11.3 On-Device Private AI Agent

Leveraging Apple Intelligence Foundation Models (iOS 26+):
- Run the agent loop entirely on-device with zero network calls
- All data stays on the iPhone — no cloud LLM provider sees the conversation
- Ideal for sensitive personal journaling, health tracking, or financial planning
- Works in airplane mode, underground, or in areas without connectivity
- Can process local files, photos (via base64), and documents privately

**Use case example:** A health-conscious user tracks symptoms, medications, and habits through conversation with an on-device agent that never sends data off the phone.

### 11.4 Knowledge Worker Companion

For professionals who need AI assistance throughout the day:
- **Meeting prep:** Agent fetches background info on people, companies, and topics before meetings
- **Research assistant:** Web search and fetch tools gather and synthesize information
- **Writing assistant:** Draft emails, reports, and messages with agent memory of style preferences
- **Task management:** Cron-scheduled reminders and follow-ups (when foregrounded or via push)
- **Context switching:** Multiple sessions for different projects, each with its own memory

### 11.5 Developer Tool (Mobile Coding Companion)

Even without shell execution, the agent can assist developers on mobile:
- **Code review:** Read and analyze code files stored in the app sandbox
- **Architecture discussion:** Agent remembers project context and past decisions
- **Documentation:** Generate and edit markdown documentation
- **API exploration:** Web fetch tool can call and test APIs
- **Debugging discussion:** Analyze error logs and stack traces pasted into chat

### 11.6 Content Creation Pipeline

For creators and marketers:
- **Social media management:** AI drafts posts across platforms (sent via channels)
- **Content calendar:** Cron-scheduled content reminders and drafts
- **Research and curation:** Web tools gather trending topics and competitor analysis
- **Multi-language support:** LLM-powered translation and localization
- **Brand voice consistency:** SOUL.md defines the brand voice, ensuring all output matches tone

### 11.7 Education and Learning Agent

A personal tutor that lives on the student's phone:
- **Adaptive learning:** Agent memory tracks what the student knows and struggles with
- **Socratic method:** Agent personality (SOUL.md) configured for teaching, not just answering
- **Homework help:** Reads documents and provides explanations (not just answers)
- **Study scheduling:** Cron reminders for study sessions and review
- **Offline study:** On-device LLM for learning without internet (iOS 26+)

### 11.8 IoT and Smart Home Control Hub

With the relay server connected to IoT platforms:
- **Natural language home control:** "Turn off the lights and set the thermostat to 68"
- **Automated routines:** Cron-scheduled smart home actions
- **Multi-platform integration:** Channels connect to smart home APIs
- **Contextual automation:** Agent remembers preferences ("I like it cooler when sleeping")
- **Apple HomeKit bridge:** Native iOS integration via HomeKit APIs

---

## Appendix: Key Files Reference

| Module | Key File | iOS Status |
|--------|----------|------------|
| Entry point | `src/index.ts` | Replace with React Native entry |
| CLI | `src/cli.ts` | Replace with native UI |
| HTTP Server | `src/server.ts` | Replace with in-process routing |
| Agent Loop | `src/agent/loop.ts` | Port with tool restrictions |
| Context | `src/agent/context.ts` | Port with path adapter |
| Memory | `src/agent/memory.ts` | Port with expo-file-system |
| Skills | `src/agent/skills.ts` | Port; stub binary checks |
| Session | `src/session/manager.ts` | Port with expo-sqlite |
| Config | `src/config/loader.ts` | Port with iOS paths |
| Schemas | `src/config/schema.ts` | Works as-is |
| Provider | `src/providers/litellm.ts` | Port; replace process.env |
| Bus | `src/bus/queue.ts` | Works as-is |
| Shell Tool | `src/tools/shell.ts` | **Disabled on iOS** |
| File Tools | `src/tools/filesystem.ts` | Port with expo-file-system |
| Web Tools | `src/tools/web.ts` | Works as-is |
| Message Tool | `src/tools/message.ts` | Works as-is |
| MCP Tool | `src/tools/mcp.ts` | HTTP transport only |
| Cron Tool | `src/tools/cron.ts` | Foreground only |
| Cron Service | `src/cron/service.ts` | Port with iOS background limits |
| Heartbeat | `src/heartbeat/service.ts` | Port; foreground only |
| Channels | `src/channels/*.ts` | Server-side relay |

---

*Report generated by analyzing all source files across 4 parallel research agents examining: core architecture, channel/bus system, tools/skills/dependencies, and iOS runtime ecosystem.*
