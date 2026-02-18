# Provider System Guide

## Architecture Overview

The provider system has three layers:

### 1. ProviderSpec (registry.ts) — Static Metadata

Each provider is described by a `ProviderSpec` entry in the `PROVIDERS` array:

| Field | Purpose |
|---|---|
| `name` | Internal key, matches config section (e.g. `"openrouter"`) |
| `keywords` | Model-name substrings for auto-detection (e.g. `["minimax"]` matches `minimax/minimax-m2.5`) |
| `isGateway` | Proxies to other models (OpenRouter, AiHubMix, Custom) vs direct API |
| `isLocal` | No API key needed (vLLM at localhost) |
| `isOauth` | Uses OAuth flow instead of API key (only OpenAI Codex) |
| `litellmPrefix` | Legacy — was used for Python litellm routing, mostly irrelevant for direct API calls |
| `stripModelPrefix` | When true, removes first `prefix/` from model name (Custom/AiHubMix gateways strip it) |
| `defaultApiBase` | Fallback API URL (e.g. `https://openrouter.ai/api/v1`) |
| `envKey` | Environment variable fallback for API key |
| `envExtras` | Extra env vars to set (e.g. Zhipu sets `ZHIPUAI_API_KEY`) |
| `detectByKeyPrefix` | Auto-detect gateway by API key prefix (e.g. `sk-or-` -> OpenRouter) |
| `detectByBaseKeyword` | Auto-detect by apiBase URL substring |
| `modelOverrides` | Per-model body overrides (none used currently) |

### 2. MultiProvider (litellm.ts) — Main Provider Class

Handles all non-OAuth providers. A single class that talks to any OpenAI-compatible API:

```
Constructor -> findGateway() -> set this.gatewaySpec -> applyEnvExtras()
     |
   chat()  -> resolveModel() -> build request body -> POST to baseUrl/chat/completions
     |
  parseResponse() -> extract content + tool_calls -> return LLMResponse
```

Key behaviors:
- `resolveModel()` transforms the model name based on provider type (gateway vs direct)
- `parseResponse()` uses `jsonrepair` as first pass for tool call arguments — fixes malformed JSON from cheaper models, then falls back to raw `JSON.parse`
- All requests go to `{baseUrl}/chat/completions` with `Authorization: Bearer {apiKey}`
- `extraHeaders` from config are merged into every request

### 3. OpenAICodexProvider (codex.ts) — OAuth Provider

Separate provider class for OpenAI Codex. Uses a completely different API format (ChatGPT's backend-api Responses API, not OpenAI-compatible chat/completions). Calls `chatgpt.com/backend-api/codex/responses`.

## Provider Selection Flow (cli.ts)

When you run `robun agent -m "Hello"`:

```
makeProvider(config)
  |
model = config.agents.defaults.model     // e.g. "minimax/minimax-m2.5"
  |
getProviderForModel(config, model)
  |
findByModel("minimax/minimax-m2.5")      // Scans keywords, skips gateways/local
  -> matches "minimax" provider           // keywords: ["minimax"]
  |
Check config.providers.minimax.apiKey     // empty string ""
  |
No key -> GATEWAY FALLBACK
  -> scans all gateway providers for one with apiKey
  -> finds config.providers.openrouter has a key
  -> returns { providerName: "openrouter", providerConfig: openrouter config }
  |
new MultiProvider({
  apiKey: "sk-or-v1-...",
  apiBase: "https://openrouter.ai/api/v1",
  defaultModel: "minimax/minimax-m2.5",
  providerName: "openrouter"
})
```

Special case: if providerName is `"openaiCodex"` or model starts with `"openai-codex/"`, it creates an `OpenAICodexProvider` instead.

## Model Name Resolution (resolveModel)

When `chat()` is called, the model name may need transformation:

**Gateway path** (e.g. OpenRouter):
- `stripModelPrefix` is `false` -> model stays as-is (e.g. `minimax/minimax-m2.5`)
- Sent directly to OpenRouter's API

**Gateway with stripModelPrefix** (e.g. Custom, AiHubMix):
- `stripModelPrefix` is `true` -> `openai/gpt-4` becomes `gpt-4`
- Useful when the gateway doesn't expect a vendor prefix

**Direct provider path** (e.g. with a MiniMax API key):
- `findByModel` returns the provider spec
- If model already starts with a `skipPrefixes` entry, no prefix is added
- Otherwise `litellmPrefix` is prepended (e.g. `gpt-4` -> `openai/gpt-4`)

## OAuth Support

### Currently Available: OpenAI Codex Only

OpenAI Codex is the only provider with `isOauth: true`.

**Login command:**
```bash
robun provider login openai-codex
```

**OAuth Authorization Code flow:**
1. Starts a local HTTP server on `localhost:18791`
2. Opens browser to `auth0.openai.com/authorize` with ChatGPT's public client ID
3. You log in with your OpenAI/ChatGPT account
4. Browser redirects back to `localhost:18791/callback` with an auth code
5. Code is exchanged for an access token via `auth0.openai.com/oauth/token`
6. Token + account ID stored in `~/.robun/codex-token.json`

**Fallback:** If the browser flow fails, it prompts you to manually paste a token from ChatGPT DevTools (Application > Cookies or Network tab).

**Important:** This uses your ChatGPT subscription, not an API key. The Codex provider calls `chatgpt.com/backend-api/codex/responses`.

### No Other OAuth Providers

All other providers use static API keys in config. To add OAuth for another provider, you would need to create a new provider class (like `codex.ts`) and a corresponding auth module (like `codex-auth.ts`).

## Configuration Options

All config lives in `~/.robun/config.json`.

### Config Schema (config/schema.ts)

```typescript
// Per-provider config
{
  apiKey: string,       // API key (empty string = not set)
  apiBase: string|null, // Custom API base URL (null = use default)
  extraHeaders: Record<string,string>|null  // Extra HTTP headers per request
}

// Agent defaults
{
  model: string,           // e.g. "minimax/minimax-m2.5"
  maxTokens: number,       // Default 8192
  temperature: number,     // Default 0.7
  maxToolIterations: number, // Default 20
  memoryWindow: number     // Default 50
}
```

### Method 1: Gateway with API Key (Recommended for multi-model access)

Use OpenRouter or AiHubMix to access many models with one key:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-5-20250929"
    }
  },
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-v1-...",
      "apiBase": null,
      "extraHeaders": null
    }
  }
}
```

The gateway fallback means you can set any model name — if the direct provider has no key, OpenRouter (or whichever gateway has a key) is used automatically.

### Method 2: Direct Provider API Key

For direct access to a specific vendor:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-5-20250929"
    }
  },
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-...",
      "apiBase": null,
      "extraHeaders": null
    }
  }
}
```

### Method 3: Custom API Base (Self-hosted / Proxies)

```json
{
  "providers": {
    "custom": {
      "apiKey": "your-key",
      "apiBase": "https://your-proxy.com/v1",
      "extraHeaders": null
    }
  }
}
```

The `custom` provider has `stripModelPrefix: true`, so `openai/gpt-4` becomes `gpt-4` when sent to the API.

### Method 4: vLLM (Local, No Key)

```json
{
  "agents": {
    "defaults": {
      "model": "vllm/your-model-name"
    }
  },
  "providers": {
    "vllm": {
      "apiBase": "http://localhost:8000/v1"
    }
  }
}
```

Since `isLocal: true`, no API key is needed.

### Method 5: OAuth (Codex Only)

```bash
robun provider login openai-codex
```

Then set model:
```json
{
  "agents": {
    "defaults": {
      "model": "openai-codex/gpt-5.1-codex"
    }
  }
}
```

No API key in config — reads from `~/.robun/codex-token.json`.

### Method 6: Environment Variables

Each provider has an `envKey` (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). The `applyEnvExtras()` method sets these env vars from config values. You can also set them directly in your shell:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

## Provider Categories

| Category | Providers | Auth | Notes |
|---|---|---|---|
| **Gateways** | OpenRouter, AiHubMix, Custom | API key | Route to any model. Auto-fallback when direct provider has no key |
| **Direct** | Anthropic, OpenAI, DeepSeek, Gemini, Groq, Zhipu, DashScope, Moonshot, MiniMax | API key | Direct to vendor API |
| **Local** | vLLM | None | `localhost:8000` default |
| **OAuth** | OpenAI Codex | Browser OAuth | Uses ChatGPT subscription, separate provider class |

## Model Name Conventions

The model name drives provider detection. Format: `provider-hint/model-id`

| Model Name | Detected Provider | Notes |
|---|---|---|
| `minimax/minimax-m2.5` | minimax (or gateway fallback) | keyword "minimax" |
| `anthropic/claude-opus-4-5` | anthropic | keywords "anthropic", "claude" |
| `deepseek/deepseek-chat` | deepseek | keyword "deepseek" |
| `openai-codex/gpt-5.1-codex` | openaiCodex | special-cased to `OpenAICodexProvider` |
| `vllm/my-local-model` | vllm | keyword "vllm", no key needed |
| `unknown-model` | custom (fallback) | no keyword match |

## Key Source Files

| File | Purpose |
|---|---|
| `src/providers/registry.ts` | `ProviderSpec` definitions, `findByModel()`, `findGateway()`, `findByName()` |
| `src/providers/litellm.ts` | `MultiProvider` class — main provider for all API-key-based providers |
| `src/providers/codex.ts` | `OpenAICodexProvider` — OAuth-based Codex provider |
| `src/providers/codex-auth.ts` | OAuth login flow, token storage for Codex |
| `src/providers/base.ts` | `LLMProvider` interface, `LLMResponse` schema |
| `src/providers/transcription.ts` | `GroqTranscriptionProvider` — audio transcription via Groq Whisper |
| `src/config/schema.ts` | Zod schemas for provider config |
| `src/cli.ts` | `makeProvider()`, `getProviderForModel()`, `providerCmd()`, `onboard()` |
