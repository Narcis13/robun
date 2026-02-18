# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Robun is an AI agent framework migrated from Python to TypeScript. It provides a CLI tool and HTTP gateway for running AI agents with multi-channel messaging (Telegram, Discord, WhatsApp, Slack, Email, etc.), a tool system, cron scheduling, and session persistence.

## Commands

```bash
bun run start                    # Run CLI (defaults to help)
bun run dev                      # Watch mode
bun test                         # Run all tests
bun test tests/tools.test.ts     # Run a single test file
bun run typecheck                # Type-check without emitting (tsc --noEmit)
bun run lint                     # Lint with Biome
bun run build                    # Bundle to dist/
```

## Architecture

**Entry flow:** `src/index.ts` (CLI dispatch) -> `src/cli.ts` (command handlers) -> either `src/server.ts` (gateway mode with Hono) or direct agent interaction.

**Core modules:**

- `src/agent/` - Agent loop (`loop.ts`), context builder (loads AGENTS.md/SOUL.md/USER.md/memory), and subagent spawning. The agent loop orchestrates LLM calls with tool execution in a run-until-done cycle.
- `src/bus/` - Message bus with inbound/outbound queues. Channels push to inbound; the agent loop processes and pushes responses to outbound; channels subscribe to outbound for delivery.
- `src/channels/` - 9 channel adapters extending `BaseChannel` (start/stop/send interface). `ChannelManager` dynamically loads only enabled channels from config.
- `src/providers/` - LLM provider abstraction. Single `LLMProvider` interface supporting OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, Gemini, etc.
- `src/tools/` - Tool registry with `Tool` interface (name, description, Zod parameters schema, execute). Built-in: filesystem, shell exec, web search/fetch, message, spawn, MCP client, cron.
- `src/skills/` - Domain-specific skills loaded as markdown with frontmatter (gray-matter). Skills define tool bundles and prompts for specific capabilities.
- `src/config/` - Zod-based config schema. Loaded from `~/.robun/config.json` with `ROBUN_*` env var overrides.
- `src/session/` - JSONL-based session persistence in `~/.robun/sessions/`.
- `src/cron/` and `src/heartbeat/` - Scheduled and periodic task execution services.
- `src/server.ts` - Hono HTTP API with routes: `/health`, `/status`, `/agent/message`, `/sessions`, `/cron/*`, `/config`.

**Key patterns:**
- All schemas use Zod; tool parameters are converted to JSON Schema via `zod-to-json-schema` for LLM function calling.
- Dependency injection via `ServerDeps` interface for the Hono app.
- Workspace files (`~/.robun/workspace/`) define agent personality (SOUL.md), instructions (AGENTS.md), user prefs (USER.md), and memory.

## Conventions

- **Runtime:** Bun (not Node.js)
- **Style:** TypeScript strict mode, ESM modules, double quotes, semicolons, 2-space indent, 100-char line width (Biome)
- **Logging:** pino, one logger per module
- **Validation:** Zod for all runtime schemas
