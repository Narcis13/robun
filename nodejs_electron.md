# Bun.js Dependency Analysis & Migration Assessment

## Codebase Overview

- **44 TypeScript source files**, ~10,500 lines
- **24 npm dependencies** — all Node.js-compatible
- **4 test files** using `bun:test`

---

## Bun-Specific Code (Surface Area is Small)

Only **5 locations** in source code use Bun-specific APIs:

| API | File | Replacement |
|-----|------|-------------|
| `Bun.spawn()` | `src/tools/shell.ts:70` | `child_process.spawn()` |
| `Bun.spawnSync()` | `src/agent/skills.ts:105` | `child_process.spawnSync()` |
| `Bun.file()` | `src/providers/transcription.ts:11` | `fs.readFile()` + `fs.existsSync()` |
| `Bun.serve()` | `src/server.ts:135` | `hono/node-server` adapter |
| `import.meta.dir` | `src/agent/skills.ts:5` | `path.dirname(import.meta.url)` or `__dirname` |

Plus infrastructure:

- **Shebang**: `#!/usr/bin/env bun` in `src/index.ts`
- **Tests**: all 4 files import from `bun:test`
- **Build script**: `bun build --target bun`
- **Dockerfile**: based on `oven/bun:1-alpine`
- **tsconfig.json**: `"types": ["@types/bun"]`
- **bunfig.toml**: Bun-specific config

---

## Step 1: Migration to Node.js

**Difficulty: Low** — estimated ~2-4 hours of work

### What needs to change

1. **`src/tools/shell.ts`** — Replace `Bun.spawn()` with `child_process.spawn()`. The API shape is similar (both return a subprocess with stdout/stderr pipes). Minor signature differences.

2. **`src/agent/skills.ts`** — Replace `Bun.spawnSync()` with `child_process.spawnSync()`. Replace `import.meta.dir` with `path.dirname(fileURLToPath(import.meta.url))`.

3. **`src/providers/transcription.ts`** — Replace `Bun.file(path)` + `.exists()` with `fs.existsSync()` + `fs.readFileSync()` (or use `fs.createReadStream()` for the FormData upload).

4. **`src/server.ts`** — Replace `Bun.serve({ port, fetch: app.fetch })` with Hono's Node.js adapter (`@hono/node-server`). Hono is multi-runtime by design, so this is a 3-line change.

5. **Config/Build:**
   - `tsconfig.json`: change `"types"` from `["@types/bun"]` to `["node"]`, add `@types/node` to devDependencies
   - `package.json` scripts: replace `bun run` with `tsx` or `ts-node`, replace `bun test` with `vitest` or `jest`
   - Replace `bun build` with `esbuild`, `tsup`, or `tsx` (esbuild is closest since Bun uses it internally)
   - Replace shebang with `#!/usr/bin/env node` (after compilation) or `#!/usr/bin/env tsx`
   - Dockerfile: switch from `oven/bun` to `node:22-alpine`
   - Delete `bunfig.toml`

6. **Tests:** Migrate from `bun:test` to Vitest (recommended — almost identical API: `describe`, `test`, `expect` work the same). Literally just change the import line in each file.

### What stays the same (no changes needed)

- All 24 npm dependencies work on Node.js
- All `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:readline` imports
- Hono routes, middleware, all business logic
- All channel adapters (Telegram, Discord, Slack, WhatsApp, etc.)
- All LLM provider code
- Config loader, session manager, cron service, memory system
- Web APIs (`fetch`, `URL`, `AbortSignal`, `FormData`) — available in Node.js 18+

---

## Step 2: Migration to Electron

**Difficulty: Medium** — the bigger challenge is architectural, not code compatibility

Once on Node.js, the code already runs on Electron's main process (Electron = Chromium + Node.js). The real work is UI and architecture.

### Easy parts

- All Node.js code runs directly in Electron's main process
- `fs`, `path`, `os`, `child_process`, `crypto` — all available
- `fetch`, `WebSocket` — available in both main and renderer
- Hono HTTP server can still run inside Electron for the gateway API
- All npm dependencies work

### Architectural decisions needed

1. **IPC Bridge** — Decide which parts run in the main process vs renderer. The agent loop, channels, tools, and file I/O should stay in main. The UI (chat interface, config panels) goes in the renderer with IPC calls.

2. **Server mode** — Currently `Bun.serve()` / Hono runs as a standalone server. In Electron, you can either:
   - Keep the HTTP server running in main process (external tools can still hit it)
   - Or route internal requests through Electron IPC directly

3. **CLI vs GUI** — The current `src/cli.ts` readline-based interface would need to be replaced with a renderer UI. The underlying logic (command dispatch, config management) stays.

4. **Packaging** — Need `electron-builder` or `electron-forge`. The WhatsApp channel (`baileys`) and email channel (`imapflow`) do heavy I/O that works fine in main process.

5. **File paths** — Currently uses `~/.robun/` for config/sessions/workspace. In Electron, use `app.getPath('userData')` instead of `os.homedir()`.

6. **Process spawning** — `child_process.spawn()` works in Electron main process, but not in renderer (need to proxy through IPC).

### What blocks Electron specifically

Nothing. Once on Node.js, Electron is purely an additive layer (UI + packaging). No code needs to be removed.

---

## Detailed Bun API Inventory

### `Bun.spawn()` — `src/tools/shell.ts:70`

```typescript
// Current (Bun)
const proc = Bun.spawn(["sh", "-c", params.command], {
  cwd,
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

// Node.js equivalent
import { spawn } from "node:child_process";
const proc = spawn("sh", ["-c", params.command], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
```

### `Bun.spawnSync()` — `src/agent/skills.ts:105`

```typescript
// Current (Bun)
const result = Bun.spawnSync(["which", bin]);

// Node.js equivalent
import { spawnSync } from "node:child_process";
const result = spawnSync("which", [bin]);
```

### `Bun.file()` — `src/providers/transcription.ts:11`

```typescript
// Current (Bun)
const file = Bun.file(filePath);
if (!(await file.exists())) { ... }

// Node.js equivalent
import { existsSync, createReadStream } from "node:fs";
if (!existsSync(filePath)) { ... }
const stream = createReadStream(filePath);
```

### `Bun.serve()` — `src/server.ts:135`

```typescript
// Current (Bun)
return Bun.serve({ port, fetch: app.fetch });

// Node.js equivalent
import { serve } from "@hono/node-server";
serve({ fetch: app.fetch, port });
```

### `import.meta.dir` — `src/agent/skills.ts:5`

```typescript
// Current (Bun)
const BUILTIN_SKILLS_DIR = join(import.meta.dir, "../skills");

// Node.js equivalent
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = join(__dirname, "../skills");
```

---

## npm Dependencies Compatibility Matrix

| Dependency | Version | Node.js Compatible | Notes |
|---|---|---|---|
| @larksuiteoapi/node-sdk | ^1.0 | Yes | Lark API |
| @modelcontextprotocol/sdk | ^1.0 | Yes | MCP client |
| @mozilla/readability | ^0.5 | Yes | Content extraction |
| @msgpack/msgpack | ^3.0 | Yes | Binary serialization |
| @slack/socket-mode | ^2.0 | Yes | Slack real-time |
| @slack/web-api | ^7.0 | Yes | Slack REST |
| @whiskeysockets/baileys | 7.0.0-rc.9 | Yes | WhatsApp Web |
| chalk | ^5.0 | Yes | Terminal colors |
| cli-table3 | ^0.6 | Yes | CLI tables |
| cron-parser | ^5.0 | Yes | Cron expressions |
| grammy | ^1.30 | Yes | Telegram bots |
| gray-matter | ^4.0 | Yes | YAML frontmatter |
| hono | ^4.0 | Yes | Multi-runtime HTTP |
| imapflow | ^1.0 | Yes | IMAP client |
| jsonrepair | ^3.10 | Yes | JSON repair |
| linkedom | ^0.18 | Yes | Lightweight DOM |
| mailparser | ^3.9.3 | Yes | Email parsing |
| nodemailer | ^6.9 | Yes | SMTP sending |
| pino | ^9.0 | Yes | Structured logging |
| slackify-markdown | ^4.0 | Yes | Markdown to Slack |
| socket.io-client | ^4.8 | Yes | WebSocket client |
| ws | ^8.18 | Yes | WebSocket impl |
| zod | ^3.23 | Yes | Schema validation |
| zod-to-json-schema | ^3.23 | Yes | Zod to JSON Schema |

### Dev Dependencies

| Dependency | Version | Node.js Compatible | Notes |
|---|---|---|---|
| @biomejs/biome | ^1.9 | Yes | Linter/formatter |
| @types/bun | ^1.0 | **Bun-only** | Replace with @types/node |
| @types/mailparser | ^3.4.6 | Yes | Type defs |
| @types/nodemailer | ^7.0.10 | Yes | Type defs |
| @types/ws | ^8.5 | Yes | Type defs |
| typescript | ^5.5 | Yes | Compiler |

---

## Summary

| Metric | Value |
|--------|-------|
| Bun-specific API calls | **5 locations** in source |
| Bun-specific infrastructure | **6 files** (tsconfig, package.json, Dockerfile, bunfig, shebang, tests) |
| npm deps needing replacement | **0** (all Node.js-compatible) |
| Node.js migration difficulty | **Low** — mechanical replacements |
| Electron migration difficulty | **Medium** — needs UI layer + IPC architecture |
| Code that stays unchanged | **~97%** |

The codebase is well-structured with Bun used only at the edges (process spawning, file API, server binding, tests). The core logic is runtime-agnostic, making both migrations straightforward.
