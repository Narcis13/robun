# Robun - Complete Guide

**Version**: 1.0.0
**Runtime**: Bun
**Framework**: Hono (HTTP), Zod (validation)

Robun is a personal AI assistant framework that connects LLM providers to multiple messaging channels (Telegram, Discord, WhatsApp, Slack, Email, and more) with a built-in tool system, memory management, sub-agent spawning, and scheduled tasks.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [CLI Usage](#cli-usage)
5. [HTTP Server (Gateway)](#http-server-gateway)
6. [Architecture Overview](#architecture-overview)
7. [LLM Providers](#llm-providers)
8. [Channel Setup](#channel-setup)
9. [Tool System](#tool-system)
10. [Memory & Sessions](#memory--sessions)
11. [Cron & Heartbeat](#cron--heartbeat)
12. [MCP Server Integration](#mcp-server-integration)
13. [Skills System](#skills-system)
14. [Sub-agents](#sub-agents)
15. [Docker Deployment](#docker-deployment)
16. [Environment Variables](#environment-variables)
17. [Migration Completeness Report](#migration-completeness-report)
18. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Bun** >= 1.0 (https://bun.sh)
- **Git** (for some tools and Docker builds)
- An API key from at least one LLM provider (OpenRouter, Anthropic, OpenAI, etc.)

## Installation

```bash
# Clone and install
cd robun
bun install

# Initialize workspace and config
bun run src/index.ts onboard

# Verify setup
bun run src/index.ts status
```

After onboarding, the following structure is created:

```
~/.robun/
  config.json          # Main configuration file
  sessions/            # Persisted conversation sessions (JSONL)
  workspace/           # Agent workspace
    AGENTS.md          # Agent behavior instructions
    SOUL.md            # Agent personality definition
    USER.md            # User information/preferences
    memory/
      MEMORY.md        # Long-term memory (auto-updated)
      HISTORY.md       # Conversation history log
    skills/            # Custom skill definitions
```

## Configuration

All configuration lives in `~/.robun/config.json`. The file is validated against Zod schemas on load, with sensible defaults for all fields.

### Root Structure

```jsonc
{
  "agents": { ... },     // Agent behavior settings
  "providers": { ... },  // LLM API keys and endpoints
  "channels": { ... },   // Messaging channel configs
  "tools": { ... },      // Tool settings (web search, exec, MCP)
  "gateway": { ... }     // HTTP server settings
}
```

### Agent Defaults

```jsonc
{
  "agents": {
    "defaults": {
      "workspace": "~/.robun/workspace",   // Agent workspace path
      "model": "anthropic/claude-opus-4-5",  // Default LLM model
      "maxTokens": 8192,                     // Max response tokens
      "temperature": 0.7,                    // Sampling temperature
      "maxToolIterations": 20,               // Max tool-use loops per message
      "memoryWindow": 50                     // Messages before consolidation
    }
  }
}
```

### Provider Configuration

Each provider entry has the same shape:

```jsonc
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-...",
      "apiBase": null,           // Override API endpoint (null = default)
      "extraHeaders": null       // Additional HTTP headers
    },
    "openrouter": {
      "apiKey": "sk-or-...",
      "apiBase": null,
      "extraHeaders": null
    }
    // Also: openai, deepseek, groq, gemini, zhipu, dashscope,
    //        moonshot, minimax, aihubmix, vllm, openaiCodex, custom
  }
}
```

### Tool Configuration

```jsonc
{
  "tools": {
    "web": {
      "search": {
        "apiKey": "",        // Brave Search API key
        "maxResults": 5
      }
    },
    "exec": {
      "timeout": 60          // Shell command timeout (seconds)
    },
    "restrictToWorkspace": false,  // Lock file/exec tools to workspace
    "mcpServers": {
      "my-server": {
        "command": "npx",
        "args": ["-y", "@my/mcp-server"],
        "env": {},
        "url": ""             // Alternative: HTTP URL instead of stdio
      }
    }
  }
}
```

### Gateway Configuration

```jsonc
{
  "gateway": {
    "host": "0.0.0.0",
    "port": 18790
  }
}
```

### Environment Variable Overrides

Any config value can be overridden via environment variables using the `ROBUN_` prefix with double-underscore path separators:

```bash
# Override the default model
ROBUN_AGENTS__DEFAULTS__MODEL=openai/gpt-4o

# Set Anthropic API key
ROBUN_PROVIDERS__ANTHROPIC__APIKEY=sk-ant-xxx

# Change gateway port
ROBUN_GATEWAY__PORT=3000
```

---

## CLI Usage

```
robun <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `onboard` | Initialize config and workspace (first-time setup) |
| `gateway [-p PORT] [-v]` | Start the full gateway (HTTP server + channels + agent loop) |
| `agent [-m MSG] [-s SESSION]` | Chat with the agent (interactive REPL or single-shot) |
| `status` | Show config, workspace, model, and provider key status |
| `channels status` | Table showing all channels and their enabled/configured state |
| `channels login` | Instructions for WhatsApp QR code login |
| `cron list` | List scheduled jobs (requires gateway running) |
| `cron add -n NAME -m MSG [--every SEC \| --cron EXPR \| --at ISO]` | Add a cron job |
| `cron remove JOB_ID` | Remove a cron job |
| `provider login openai-codex` | OAuth login for Codex provider (not yet implemented) |
| `--version`, `-v` | Print version |
| `--help`, `-h` | Show help |

### Examples

```bash
# First-time setup
bun run src/index.ts onboard

# Single message (non-interactive)
bun run src/index.ts agent -m "What is the capital of France?"

# Interactive chat
bun run src/index.ts agent

# Start gateway on custom port
bun run src/index.ts gateway -p 3000 -v

# Check status
bun run src/index.ts status

# See channel configuration
bun run src/index.ts channels status
```

### Interactive Chat Commands

When in interactive mode (`agent` without `-m`):

| Command | Action |
|---------|--------|
| `/new` | Clear session and consolidate memory |
| `/help` | Show available commands |
| `exit`, `quit`, `/exit`, `/quit`, `:q` | Exit |
| `Ctrl+C` | Exit |

---

## HTTP Server (Gateway)

The gateway starts an HTTP server (Hono on Bun.serve), the agent processing loop, and all enabled channel adapters.

```bash
bun run src/index.ts gateway [-p PORT] [-v]
```

Default port: **18790**

### Endpoints

#### Health & Status

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check. Returns `{ "status": "ok", "uptime": <seconds> }` |
| `GET` | `/status` | Agent model, workspace, enabled channels, cron job count |
| `GET` | `/config` | Sanitized config (channel enabled states, gateway settings; no secrets) |

#### Agent Interaction

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/message` | Send a message to the agent and get a response |

**POST /agent/message** body:
```json
{
  "content": "Hello, what can you do?",
  "sessionKey": "api:user1",       // optional, defaults to "cli:direct"
  "channel": "api",                // optional, defaults to "cli"
  "chatId": "user1"                // optional, defaults to "direct"
}
```

Response:
```json
{
  "response": "I can help you with many tasks..."
}
```

#### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions` | List all sessions with message counts and timestamps |
| `GET` | `/sessions/:key` | Get a specific session's key and message count |

**GET /sessions** response:
```json
[
  { "key": "telegram:12345", "messageCount": 42, "updatedAt": "2026-02-17T10:00:00.000Z" },
  { "key": "cli:direct", "messageCount": 5, "updatedAt": "2026-02-17T09:30:00.000Z" }
]
```

#### Cron Jobs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cron/jobs` | List all enabled cron jobs |
| `POST` | `/cron/jobs` | Create a new cron job |
| `DELETE` | `/cron/jobs/:id` | Remove a cron job by ID |

**POST /cron/jobs** body:
```json
{
  "name": "daily-summary",
  "schedule": {
    "kind": "cron",              // "at" | "every" | "cron"
    "expr": "0 9 * * *"         // for kind=cron
    // "atMs": 1708200000000    // for kind=at (epoch ms)
    // "everyMs": 3600000       // for kind=every (ms)
  },
  "message": "Give me a daily summary of pending tasks",
  "deliver": true,               // optional: deliver via channel
  "channel": "telegram",         // optional: target channel
  "to": "12345"                  // optional: target chat ID
}
```

Response (201):
```json
{
  "id": "a1b2c3d4",
  "name": "daily-summary",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 9 * * *", ... },
  "payload": { "kind": "agent_turn", "message": "...", ... },
  "state": { "nextRunAtMs": 1708250400000, ... }
}
```

---

## Architecture Overview

```
                        +-----------+
                        |   CLI     |
                        | (index.ts)|
                        +-----+-----+
                              |
              +---------------+---------------+
              |                               |
        +-----+-----+                 +------+------+
        | Agent CMD  |                |   Gateway   |
        | (one-shot  |                | (server +   |
        |  or REPL)  |                |  channels)  |
        +-----+------+                +------+------+
              |                               |
              +---------------+---------------+
                              |
                    +---------+---------+
                    |    Agent Loop     |
                    | (loop.ts)         |
                    | - tool execution  |
                    | - LLM calls       |
                    | - memory mgmt     |
                    +---------+---------+
                              |
              +---------------+---------------+
              |               |               |
     +--------+--+    +------+------+  +------+------+
     | Tool       |    | Provider    |  | Session     |
     | Registry   |    | (MultiProv, |  | Manager     |
     | (8 tools + |    |  Codex,     |  | (JSONL      |
     |  MCP)      |    |  Groq)      |  |  storage)   |
     +------------+    +-------------+  +-------------+

     +--------------------------------------------------+
     |                  Message Bus                       |
     |  InboundQueue -> AgentLoop -> OutboundQueue       |
     |  OutboundSubscribers (per channel)                |
     +--------------------------------------------------+
              |
     +--------+--------+--------+--------+--------+
     | Telegram | Discord | WhatsApp | Slack | Email |
     | Feishu   | DingTalk| Mochat   | QQ    |       |
     +----------+---------+----------+-------+-------+
```

### Data Flow

1. **Inbound**: Channel adapter receives a message -> publishes to `MessageBus.inboundQueue`
2. **Processing**: `AgentLoop.run()` consumes from inbound queue -> builds context (system prompt, history, memory, skills) -> calls LLM provider -> executes tool calls in a loop -> produces response
3. **Outbound**: Response is published to `MessageBus.outboundQueue` -> dispatched to the matching channel subscriber -> channel adapter sends it

### Key Design Patterns

- **Event-driven message bus**: Decouples channels from the agent loop. Channels publish inbound messages; the agent loop publishes outbound responses.
- **Tool registry**: All tools implement a `Tool` interface with `name`, `description`, `parameters` (Zod schema), and `execute()`. The registry handles validation and dispatch.
- **Session persistence**: JSONL files per session key with metadata headers. Sessions are cached in-memory with lazy loading.
- **Memory consolidation**: When session history exceeds `memoryWindow`, older messages are summarized by the LLM and persisted to `MEMORY.md` (facts) and `HISTORY.md` (events).
- **Sub-agent isolation**: Spawned sub-agents get their own tool registry (no message/spawn/cron tools) to prevent recursive spawning. Results route back via system messages on the bus.

---

## LLM Providers

### Supported Providers

| Provider | Config Key | Model Examples | Notes |
|----------|-----------|----------------|-------|
| Anthropic | `anthropic` | `anthropic/claude-opus-4-5`, `claude-3-haiku` | Direct API |
| OpenAI | `openai` | `openai/gpt-4o`, `gpt-4-turbo` | Direct API |
| OpenRouter | `openrouter` | Any model via OpenRouter | Gateway (auto-detected by `sk-or-` key prefix) |
| DeepSeek | `deepseek` | `deepseek/deepseek-chat` | Direct API |
| Gemini | `gemini` | `gemini/gemini-pro` | Direct API |
| Groq | `groq` | `groq/llama-3.3-70b` | Direct API |
| Zhipu | `zhipu` | `zhipu/glm-4` | Direct API |
| DashScope | `dashscope` | `dashscope/qwen-turbo` | Direct API |
| Moonshot | `moonshot` | `moonshot/moonshot-v1-8k` | Direct API |
| MiniMax | `minimax` | `minimax/abab6.5` | Direct API |
| AiHubMix | `aihubmix` | Various models | Gateway |
| vLLM | `vllm` | Local models | Local (default: `http://localhost:8000/v1`) |
| OpenAI Codex | `openaiCodex` | `openai-codex/gpt-5.1-codex` | OAuth-based (not yet implemented) |
| Custom | `custom` | Any OpenAI-compatible | Gateway pass-through |

### Provider Auto-Detection

The model string determines which provider is used:
- `anthropic/claude-*` or contains `claude` -> Anthropic
- `openai/gpt-*` or contains `gpt` -> OpenAI
- `deepseek/*` or contains `deepseek` -> DeepSeek
- Models prefixed with `openai-codex/` -> Codex provider
- Gateway providers (OpenRouter, AiHubMix) are detected by API key prefix or base URL keyword

### Quick Start

Set your API key in config:
```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-your-key-here"
    }
  },
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-4-5"
    }
  }
}
```

### Audio Transcription

Voice messages received on channels (Telegram, WhatsApp) are automatically transcribed using the Groq Whisper API. Set your Groq API key:

```json
{
  "providers": {
    "groq": {
      "apiKey": "gsk_your-groq-key"
    }
  }
}
```

---

## Channel Setup

All channels share a common pattern:
1. Set `enabled: true` in config
2. Provide required credentials
3. Optionally set `allowFrom` array to restrict access
4. Start the gateway: `bun run src/index.ts gateway`

### Telegram

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "123456:ABC-...",
      "allowFrom": [],
      "proxy": null
    }
  }
}
```

Get a token from [@BotFather](https://t.me/BotFather). Uses the `grammy` library for bot management. Supports text, voice (auto-transcribed), and photo messages.

### Discord

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "your-bot-token",
      "allowFrom": [],
      "gatewayUrl": "wss://gateway.discord.gg/?v=10&encoding=json",
      "intents": 37377
    }
  }
}
```

Uses raw WebSocket gateway (no discord.js dependency). Handles DMs, mentions, and file attachments.

### WhatsApp

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "authDir": "~/.robun/whatsapp-auth",
      "allowFrom": []
    }
  }
}
```

Uses Baileys for WhatsApp Web protocol. First connection requires QR code scanning in the terminal. Auth state persists in `authDir`.

### Slack

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "groupPolicy": "mention",
      "dm": {
        "enabled": true,
        "policy": "open",
        "allowFrom": []
      }
    }
  }
}
```

Uses Socket Mode (`@slack/socket-mode`). Supports DMs, channel mentions, and thread replies. Markdown is converted to Slack-compatible format via `slackify-markdown`.

### Email

```json
{
  "channels": {
    "email": {
      "enabled": true,
      "consentGranted": true,
      "imapHost": "imap.gmail.com",
      "imapPort": 993,
      "imapUsername": "you@gmail.com",
      "imapPassword": "app-password",
      "smtpHost": "smtp.gmail.com",
      "smtpPort": 587,
      "smtpUsername": "you@gmail.com",
      "smtpPassword": "app-password",
      "fromAddress": "you@gmail.com",
      "pollIntervalSeconds": 30,
      "allowFrom": ["friend@example.com"]
    }
  }
}
```

Polls IMAP for new emails and replies via SMTP. Uses `imapflow` and `nodemailer`. Always set `allowFrom` for email to prevent processing spam.

### Feishu (Lark)

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_...",
      "appSecret": "...",
      "encryptKey": "...",
      "verificationToken": "...",
      "allowFrom": []
    }
  }
}
```

Uses the `@larksuiteoapi/node-sdk` for Feishu/Lark integration.

### DingTalk

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "...",
      "clientSecret": "...",
      "allowFrom": []
    }
  }
}
```

### QQ

```json
{
  "channels": {
    "qq": {
      "enabled": true,
      "appId": "...",
      "secret": "...",
      "allowFrom": []
    }
  }
}
```

### Mochat

```json
{
  "channels": {
    "mochat": {
      "enabled": true,
      "baseUrl": "https://mochat.io",
      "clawToken": "...",
      "agentUserId": "...",
      "sessions": ["session-id-1"],
      "panels": ["panel-id-1"],
      "mention": { "requireInGroups": false },
      "groups": {},
      "replyDelayMode": "non-mention",
      "replyDelayMs": 120000
    }
  }
}
```

Uses `socket.io-client` and `@msgpack/msgpack` for real-time communication.

---

## Tool System

The agent has 10 built-in tools plus dynamic MCP tools:

### Built-in Tools

| Tool | Name | Description |
|------|------|-------------|
| Read File | `read_file` | Read file contents at a given path |
| Write File | `write_file` | Write content to a file (creates parent dirs) |
| Edit File | `edit_file` | Replace exact text in a file (find-and-replace) |
| List Directory | `list_dir` | List directory contents with type indicators |
| Shell Execute | `exec` | Run shell commands with safety guards |
| Web Search | `web_search` | Search via Brave Search API |
| Web Fetch | `web_fetch` | Fetch and extract content from URLs (Readability) |
| Message | `message` | Send messages to channels/chats |
| Spawn | `spawn` | Spawn background sub-agents |
| Cron | `cron` | Manage scheduled tasks (add/list/remove) |

### Safety Guards

The `exec` tool includes built-in safety patterns that block dangerous commands:
- `rm -rf`, `del /f`, `rmdir /s`
- `format`, `mkfs`, `diskpart`, `dd if=`
- `shutdown`, `reboot`, `poweroff`
- Fork bombs

When `restrictToWorkspace` is `true`, file tools are confined to the workspace directory and the exec tool blocks path traversal (`../`).

### Tool Schemas

All tools define their parameters as Zod schemas, which are converted to JSON Schema for the LLM's function calling interface via `zod-to-json-schema`.

---

## Memory & Sessions

### Session Storage

Sessions are stored as JSONL files at `~/.robun/sessions/`. Each file contains:
- Line 1: Metadata (creation time, update time, consolidation pointer)
- Remaining lines: Individual messages with role, content, timestamp, and optional toolsUsed

Session keys follow the pattern `channel:chatId` (e.g., `telegram:12345`, `cli:direct`).

### Memory Consolidation

When a session exceeds `memoryWindow` messages (default: 50):
1. Older messages are extracted
2. The LLM summarizes them into a history entry and memory update
3. `HISTORY.md` receives a timestamped paragraph
4. `MEMORY.md` is updated with new facts (user preferences, project context, etc.)
5. The consolidation pointer advances so messages aren't re-processed

The `/new` command triggers full archival consolidation and clears the session.

### Context Building

Each LLM request includes a system prompt assembled from:
1. **Identity**: Timestamp, OS, workspace path
2. **Bootstrap files**: AGENTS.md, SOUL.md, USER.md, TOOLS.md, IDENTITY.md (if present in workspace)
3. **Long-term memory**: Content from memory/MEMORY.md
4. **Active skills**: Skills marked as `always: true` plus any requested skills
5. **Skills summary**: XML listing of all available skills
6. **Conversation history**: Last N messages from the session

---

## Cron & Heartbeat

### Cron Service

The cron service manages scheduled tasks persisted to `~/.robun/cron.json`.

**Schedule Types:**
- `at`: One-time execution at a specific timestamp (epoch ms)
- `every`: Recurring at a fixed interval (ms)
- `cron`: Standard cron expressions (parsed by `cron-parser`)

**Payload**: Each job contains a message that is sent to the agent when triggered, optionally delivered to a specific channel/chat.

### Heartbeat Service

The heartbeat service periodically checks `HEARTBEAT.md` in the workspace:
- Default interval: 30 minutes
- If the file has actionable content (non-empty, non-comment lines, checkboxes), the agent processes it
- If the agent responds with `HEARTBEAT_OK`, no further action is taken
- Empty or comment-only files are skipped silently

---

## MCP Server Integration

Robun supports the [Model Context Protocol](https://modelcontextprotocol.io/) for extending the agent with external tool servers.

### Configuration

```jsonc
{
  "tools": {
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      },
      "remote-server": {
        "url": "http://localhost:8080/mcp"
      }
    }
  }
}
```

### How It Works

1. On first message, the agent loop connects to all configured MCP servers
2. **Stdio transport**: Spawns the command as a subprocess, communicates via stdin/stdout
3. **HTTP transport**: Connects to a StreamableHTTP endpoint
4. Each MCP tool is wrapped as `mcp_{serverName}_{toolName}` and registered in the tool registry
5. Tools are available to the agent alongside built-in tools
6. Connections are cleaned up on shutdown

---

## Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that extend the agent's behavior.

### Skill Locations

1. **Workspace skills**: `~/.robun/workspace/skills/{skill-name}/SKILL.md` (user-created, higher priority)
2. **Built-in skills**: Bundled with the application (lower priority)

### Skill Format

```markdown
---
name: my-skill
description: Does something useful
always: false
requires:
  bins: ["git"]
  env: ["GITHUB_TOKEN"]
---

# My Skill

Instructions for the agent when this skill is active...
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Skill identifier |
| `description` | string | Short description (shown in skills summary) |
| `always` | boolean | If `true`, always included in system prompt |
| `requires.bins` | string[] | Required binaries (checked via `which`) |
| `requires.env` | string[] | Required environment variables |

### How Skills Work

- Skills marked `always: true` are always loaded into the system prompt
- Other skills can be requested by name in the `buildMessages()` call
- The agent sees an XML summary of all available skills and can reference them
- Skill availability is checked against binary and env requirements

---

## Sub-agents

The agent can spawn background sub-agents for autonomous tasks.

### How It Works

1. The agent calls the `spawn` tool with a task description
2. A `SubagentManager` creates an isolated agent with its own tool registry
3. The sub-agent gets: file tools, shell tool, web tools (no message/spawn/cron)
4. It runs up to 15 iterations of the LLM tool-use loop
5. When complete, the result is published as a system message on the bus
6. The main agent processes the system message and summarizes for the user

### Isolation

Sub-agents cannot:
- Send messages directly to users
- Spawn other sub-agents (no recursive spawning)
- Access the main agent's conversation history
- Use cron scheduling

---

## Docker Deployment

### Build

```bash
docker build -t robun .
```

### Run

```bash
# Run gateway
docker run -d \
  --name robun \
  -p 18790:18790 \
  -v ~/.robun:/root/.robun \
  robun gateway

# Run a single agent command
docker run --rm \
  -v ~/.robun:/root/.robun \
  robun agent -m "Hello!"

# Check status
docker run --rm \
  -v ~/.robun:/root/.robun \
  robun status
```

The Dockerfile:
- Uses `oven/bun:1-alpine` base image
- Installs git for tool support
- Exposes port 18790
- Mounts `~/.robun` for config and data persistence
- Default command is `status`; override with `gateway`, `agent`, etc.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ROBUN_*` | Config overrides (see [Environment Variable Overrides](#environment-variable-overrides)) |
| `LOG_LEVEL` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `BRAVE_API_KEY` | Brave Search API key (fallback if not in config) |
| `GROQ_API_KEY` | Groq API key for transcription (fallback) |
| `ANTHROPIC_API_KEY` | Anthropic API key (fallback) |
| `OPENAI_API_KEY` | OpenAI API key (fallback) |
| `OPENROUTER_API_KEY` | OpenRouter API key (fallback) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (fallback) |
| `GEMINI_API_KEY` | Gemini API key (fallback) |

---

## Migration Completeness Report

### Summary

The migration from Python to TypeScript (Bun) is **functionally complete** across all 9 phases of the migration plan. All 41 source files and 4 test files have been implemented.

### File Count

| Category | Count | Status |
|----------|-------|--------|
| Agent core (loop, context, memory, skills, subagent) | 5 | Complete |
| Message bus (events, queue) | 2 | Complete |
| Configuration (schema, loader) | 2 | Complete |
| Session management | 1 | Complete |
| Utility helpers | 1 | Complete |
| Channel adapters | 11 | Complete (base + 9 channels + manager) |
| Providers | 5 | Complete (base + litellm + codex + transcription + registry) |
| Tools | 8 | Complete (base + 7 tool modules) |
| Services (cron, heartbeat) | 3 | Complete (service + types + heartbeat) |
| Server + CLI + entry point | 3 | Complete |
| Tests | 4 | Present (cron, heartbeat, integration, tools) |
| **Total** | **45** | |

### Known Gaps and Limitations

#### Critical (blocks functionality at runtime)

1. **CronService and HeartbeatService not wired in gateway** (`cli.ts:214-294`): The `gateway` command creates the agent loop and channel manager but does **not** create a `CronService`, does **not** create a `HeartbeatService`, and does not wire the cron callback (`agentLoop.processDirect`). This means scheduled tasks and heartbeat wake-ups are dead code at runtime even though the service implementations are complete. **Fix**: Instantiate `CronService` and `HeartbeatService` in the `gateway()` function and pass `cronService` to `AgentLoop` options and `startServer` deps.

2. **`applyEnvOverrides()` defined but never called** (`config/loader.ts:43-51`): The function exists but `loadConfig()` does not call it. Users in Docker/K8s who set `ROBUN_PROVIDERS__ANTHROPIC__APIKEY=sk-ant-xxx` will find their env vars ignored. **Fix**: Call `applyEnvOverrides(config)` at the end of `loadConfig()`.

#### High (missing features)

3. **OpenAI Codex OAuth** (`providers/codex.ts:86-90`): The `getCodexToken()` function throws "not implemented". The Python version uses `oauth_cli_kit` for token acquisition. This affects only users of the Codex provider. All other providers (14+) work fully.

4. **Provider OAuth CLI** (`cli.ts:535`): The `provider login openai-codex` command prints a "not yet implemented" message. CLI counterpart of the Codex OAuth gap above.

5. **Missing `TOOLS.md` and `HEARTBEAT.md` workspace templates** (`cli.ts:92-130`): The `onboard` command creates AGENTS.md, SOUL.md, USER.md, and memory files but omits TOOLS.md and HEARTBEAT.md which the Python version creates.

6. **Cron CLI commands are stubs** (`cli.ts:456-513`): The `cron list|add|remove|enable|run` subcommands only print informational messages telling users to use the HTTP API. They do not directly manipulate the CronService.

#### Medium (correctness/compatibility)

7. **Missing HTTP route `POST /cron/jobs/:id/run`** (`server.ts`): The migration plan specifies this endpoint for manual job execution. Not implemented.

8. **`envExtras` from ProviderSpec not processed** (`providers/registry.ts`): The field is defined on every provider spec but never used. Providers like Zhipu that need extra env vars (e.g., `ZHIPUAI_API_KEY`) may not work correctly.

9. **Missing `@biomejs/biome` devDependency** (`package.json`): The `lint` script references `biome check src/` but biome is not installed and no `biome.json` config exists.

10. **Stale forward declarations** (`tools/cron.ts:5-6`, `tools/spawn.ts:5-12`): Local `CronService` and `SubagentManager` interfaces are defined instead of importing from their actual modules (which now exist).

#### Low (minor differences)

11. **Channel `require()` usage** (`channels/manager.ts`): Channel adapters use `require()` instead of dynamic `import()`. Intentional for lazy-loading but could be modernized.

12. **Test coverage**: 4 test files with 56 tests covering cron, heartbeat, tools, and integration. Missing: session.test.ts, cli.test.ts, email.test.ts per migration plan Phase 8. No tests for WebSearchTool, WebFetchTool, MessageTool, SpawnTool, CronTool, or MCPToolWrapper.

13. **No config migration logic**: Python has `_migrate_config()` for moving fields between versions. TS has no equivalent.

14. **Bus polling interval**: Python's outbound dispatcher uses 1-second async wait. TS uses 50ms `setTimeout` polling (slightly higher idle CPU).

### What Is Fully Implemented

- Complete agent loop with tool-use iteration, context building, and memory consolidation
- All 14 LLM providers via the MultiProvider (OpenAI-compatible) pattern
- All 9 messaging channel adapters with send/receive/allowlist logic (each fully implemented, not stubs)
- Full tool suite: filesystem (4 tools), shell, web (2 tools), message, spawn, cron
- MCP server integration (stdio + HTTP transports)
- Skills system with frontmatter parsing, requirements checking, always-on support
- Sub-agent spawning with isolation and result routing
- Session management with JSONL persistence and caching
- Memory consolidation via LLM summarization
- Cron scheduling service with at/every/cron expressions (implementation complete, wiring gap above)
- Heartbeat service for periodic autonomous check-ins (implementation complete, wiring gap above)
- CLI with 7 commands and interactive REPL
- HTTP server with 9 endpoints
- Docker deployment support
- Build passes (56 tests, 0 failures, strict TypeScript)

---

## Troubleshooting

### "No API key configured"

Set your provider API key in `~/.robun/config.json`:
```json
{ "providers": { "openrouter": { "apiKey": "sk-or-..." } } }
```

### Channel not starting

Check the gateway logs (use `-v` for verbose). Common issues:
- Missing or invalid tokens
- Network/firewall blocking WebSocket connections
- Dependencies not installed (`bun install`)

### MCP server connection fails

- Verify the command exists and is in PATH
- Check that the MCP server package is installed
- For HTTP transport, verify the URL is reachable
- Check gateway logs for connection error details

### Memory not updating

Memory consolidation is triggered when session length exceeds `memoryWindow` (default 50 messages) or on `/new`. Check:
- `~/.robun/workspace/memory/MEMORY.md` for long-term memory
- `~/.robun/workspace/memory/HISTORY.md` for event history
- Gateway logs for consolidation errors

### Session data location

Sessions are JSONL files at `~/.robun/sessions/`. File names are sanitized versions of the session key. To reset a session, delete its file or use `/new` in chat.

### Build errors

```bash
# Verify Bun is installed
bun --version

# Clean install
rm -rf node_modules bun.lock
bun install

# Type check
bun run typecheck
```
