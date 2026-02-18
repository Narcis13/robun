# Robun

An AI agent framework built with Bun, Hono, and Zod. Run conversational AI agents with multi-channel messaging, a tool system, cron scheduling, and session persistence.

## Features

- **Multi-channel messaging** &mdash; Telegram, Discord, WhatsApp, Slack, Email, Feishu, DingTalk, QQ, and Mochat
- **Multi-provider LLM support** &mdash; Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, and more
- **Tool system** &mdash; Built-in tools for filesystem, shell, web search/fetch, messaging, subagent spawning, and MCP client
- **Skills** &mdash; Domain-specific capabilities loaded as markdown with frontmatter (cron, GitHub, memory, weather, etc.)
- **HTTP gateway** &mdash; Hono-based API for headless operation
- **Session persistence** &mdash; JSONL-based conversation history
- **Cron & heartbeat** &mdash; Scheduled and periodic task execution
- **Agent workspace** &mdash; Personality (SOUL.md), instructions (AGENTS.md), user preferences (USER.md), and memory

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+

### Install

```bash
git clone https://github.com/Narcis13/robun.git
cd robun
bun install
```

### Setup

Run the onboarding wizard to create your config:

```bash
bun run start onboard
```

This creates `~/.robun/config.json` with your provider API keys and channel settings.

### Run

```bash
# Interactive CLI chat
bun run start agent

# HTTP gateway mode
bun run start gateway

# Check status
bun run start status
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `robun onboard` | Interactive setup wizard |
| `robun agent` | Start an interactive agent session |
| `robun gateway` | Start the HTTP gateway server |
| `robun status` | Show current configuration status |
| `robun channels` | Manage channel adapters |
| `robun cron` | Manage scheduled tasks |
| `robun provider` | Manage LLM providers |

## Configuration

Config lives at `~/.robun/config.json`. Environment variables with the `ROBUN_` prefix override config values.

```jsonc
{
  "agents": {
    "defaults": {
      "workspace": "~/.robun/workspace",
      "model": "anthropic/claude-opus-4-5",
      "maxTokens": 8192,
      "temperature": 0.7
    }
  },
  "providers": {
    "anthropic": { "apiKey": "sk-..." },
    "openrouter": { "apiKey": "sk-or-..." }
  },
  "channels": {
    "telegram": { "enabled": true, "token": "..." },
    "discord": { "enabled": true, "token": "..." }
  },
  "tools": {
    "mcpServers": {
      "my-server": { "command": "npx", "args": ["-y", "my-mcp-server"] }
    }
  }
}
```

## Architecture

```
src/
  index.ts          CLI entry point
  cli.ts            Command handlers
  server.ts         Hono HTTP gateway
  agent/            Agent loop, context builder, memory, skills, subagents
  bus/              Message bus with inbound/outbound queues
  channels/         9 channel adapters (Telegram, Discord, WhatsApp, ...)
  providers/        LLM provider abstraction (OpenAI-compatible API)
  tools/            Tool registry (filesystem, shell, web, MCP, cron, ...)
  skills/           Markdown-based skill definitions
  config/           Zod schema and config loader
  session/          JSONL session persistence
  cron/             Cron scheduling service
  heartbeat/        Periodic task runner
```

## Development

```bash
bun run dev          # Watch mode
bun test             # Run tests
bun run typecheck    # Type-check (tsc --noEmit)
bun run lint         # Lint (Biome)
bun run build        # Bundle to dist/
```

## License

MIT
