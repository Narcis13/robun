import chalk from "chalk";
import Table from "cli-table3";
import * as readline from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VERSION = "1.0.0";

import { loadConfig, saveConfig, getConfigPath, getDataDir } from "./config/loader";
import { ConfigSchema, type Config } from "./config/schema";
import { getWorkspacePath } from "./utils/helpers";
import { PROVIDERS, findByModel, findByName } from "./providers/registry";
import { MultiProvider } from "./providers/litellm";
import { OpenAICodexProvider } from "./providers/codex";
import type { LLMProvider } from "./providers/base";

const LOGO = "\u{1F916}";
const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q"]);

// ---------- Provider Factory ----------

function getProviderForModel(
  config: Config,
  model: string,
): { providerName: string; providerConfig: { apiKey: string; apiBase: string | null; extraHeaders: Record<string, string> | null } | null } {
  // Determine provider by model prefix or keyword
  const spec = findByModel(model);
  const providerName = spec?.name ?? "custom";

  // Index into config.providers by name
  const providers = config.providers as Record<string, { apiKey: string; apiBase: string | null; extraHeaders: Record<string, string> | null }>;
  const providerConfig = providers[providerName] ?? null;

  // If direct provider has no API key, fall back to a configured gateway (e.g. OpenRouter)
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

function getApiBase(config: Config, providerName: string): string | null {
  const providers = config.providers as Record<string, { apiKey: string; apiBase: string | null }>;
  const p = providers[providerName];
  if (p?.apiBase) return p.apiBase;

  const spec = findByName(providerName);
  if (spec?.defaultApiBase) return spec.defaultApiBase;
  return null;
}

function makeProvider(config: Config): LLMProvider {
  const model = config.agents.defaults.model;
  const { providerName, providerConfig } = getProviderForModel(config, model);

  // OpenAI Codex uses dedicated OAuth-based provider
  if (providerName === "openaiCodex" || model.startsWith("openai-codex/")) {
    return new OpenAICodexProvider(model);
  }

  // Check for API key (skip for bedrock/ models and local providers)
  const spec = findByName(providerName);
  if (!model.startsWith("bedrock/") && !spec?.isLocal && !providerConfig?.apiKey) {
    console.error(chalk.red("Error: No API key configured."));
    console.error("Set one in ~/.robun/config.json under providers section");
    process.exit(1);
  }

  return new MultiProvider({
    apiKey: providerConfig?.apiKey,
    apiBase: getApiBase(config, providerName),
    defaultModel: model,
    extraHeaders: providerConfig?.extraHeaders,
    providerName,
  });
}

// ---------- Arg Parsing Helpers ----------

function parseFlag(args: string[], flag: string, alias?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag || (alias && args[i] === alias)) {
      return args[i + 1];
    }
  }
  return undefined;
}

function hasFlag(args: string[], flag: string, alias?: string): boolean {
  return args.includes(flag) || (alias ? args.includes(alias) : false);
}

// ============================================================================
// Onboard / Setup
// ============================================================================

const WORKSPACE_TEMPLATES: Record<string, string> = {
  "AGENTS.md": `# Agent Instructions

You are a helpful AI assistant. Be concise, accurate, and friendly.

## Guidelines

- Always explain what you're doing before taking actions
- Ask for clarification when the request is ambiguous
- Use tools to help accomplish tasks
- Remember important information in memory/MEMORY.md; past events are logged in memory/HISTORY.md
`,
  "SOUL.md": `# Soul

I am robun, a lightweight AI assistant.

## Personality

- Helpful and friendly
- Concise and to the point
- Curious and eager to learn

## Values

- Accuracy over speed
- User privacy and safety
- Transparency in actions
`,
  "USER.md": `# User

Information about the user goes here.

## Preferences

- Communication style: (casual/formal)
- Timezone: (your timezone)
- Language: (your preferred language)
`,
  "TOOLS.md": `# Tools

These are the tools available to the agent.

## File Operations

- **read_file** \`path\` - Read file contents
- **write_file** \`path\` \`content\` - Write content to a file
- **edit_file** \`path\` \`old\` \`new\` - Replace text in a file
- **list_dir** \`path\` - List directory contents

## Execution

- **exec** \`command\` - Run a shell command
  - Timeout: configurable (default 30s)
  - Dangerous commands are blocked
  - Output is truncated at 10,000 characters
  - Restricted to workspace when configured

## Web

- **web_search** \`query\` - Search the web (requires Brave API key)
- **web_fetch** \`url\` - Fetch and extract content from a URL

## Communication

- **message** \`channel\` \`to\` \`content\` - Send a message to a channel

## Scheduling

- Use \`robun cron add\` to schedule recurring tasks
- Jobs run through the agent and can use all tools

## Custom Tools

To add custom tools, extend the Tool class and register in the AgentLoop.
`,
  "HEARTBEAT.md": `# Heartbeat Tasks

This file is checked periodically (every 30 minutes) by the agent.
Add tasks below that should be executed on the next heartbeat.
Remove or check off tasks after they are completed.

## Tasks

<!-- Add tasks here. Example: -->
<!-- - [ ] Check for new messages and summarize -->
<!-- - [ ] Update memory with recent learnings -->
`,
};

export async function onboard(): Promise<void> {
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    console.log(chalk.yellow(`Config already exists at ${configPath}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Overwrite with defaults? [y/N] ");
    rl.close();

    if (answer.trim().toLowerCase() === "y") {
      saveConfig(ConfigSchema.parse({}));
      console.log(chalk.green("v") + ` Config reset to defaults at ${configPath}`);
    } else {
      const config = loadConfig();
      saveConfig(config);
      console.log(chalk.green("v") + ` Config refreshed at ${configPath} (existing values preserved)`);
    }
  } else {
    saveConfig(ConfigSchema.parse({}));
    console.log(chalk.green("v") + ` Created config at ${configPath}`);
  }

  // Create workspace
  const workspace = getWorkspacePath();

  // Create workspace templates
  for (const [filename, content] of Object.entries(WORKSPACE_TEMPLATES)) {
    const filePath = join(workspace, filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content);
      console.log(chalk.dim(`  Created ${filename}`));
    }
  }

  // Create memory directory
  const memoryDir = join(workspace, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const memoryFile = join(memoryDir, "MEMORY.md");
  if (!existsSync(memoryFile)) {
    writeFileSync(
      memoryFile,
      `# Long-term Memory

This file stores important information that should persist across sessions.

## User Information

(Important facts about the user)

## Preferences

(User preferences learned over time)

## Important Notes

(Things to remember)
`,
    );
    console.log(chalk.dim("  Created memory/MEMORY.md"));
  }

  const historyFile = join(memoryDir, "HISTORY.md");
  if (!existsSync(historyFile)) {
    writeFileSync(historyFile, "");
    console.log(chalk.dim("  Created memory/HISTORY.md"));
  }

  // Create skills directory
  mkdirSync(join(workspace, "skills"), { recursive: true });

  console.log(`\n${LOGO} robun is ready!`);
  console.log("\nNext steps:");
  console.log(`  1. Add your API key to ${chalk.cyan("~/.robun/config.json")}`);
  console.log("     Get one at: https://openrouter.ai/keys");
  console.log(`  2. Chat: ${chalk.cyan('robun agent -m "Hello!"')}`);
  console.log(chalk.dim("\nWant Telegram/WhatsApp? See: https://github.com/HKUDS/robun#-chat-apps"));
}

// ============================================================================
// Gateway / Server
// ============================================================================

export async function gateway(args: string[]): Promise<void> {
  const port = parseInt(parseFlag(args, "--port", "-p") ?? "18790", 10);
  const verbose = hasFlag(args, "--verbose", "-v");

  // Dynamic imports to avoid loading everything at startup
  const { MessageBus } = await import("./bus/queue");
  const { AgentLoop } = await import("./agent/loop");
  const { ChannelManager } = await import("./channels/manager");
  const { SessionManager } = await import("./session/manager");
  const { CronService } = await import("./cron/service");
  const { HeartbeatService } = await import("./heartbeat/service");
  const { startServer } = await import("./server");

  if (verbose) {
    // pino respects LOG_LEVEL env
    process.env.LOG_LEVEL = "debug";
  }

  console.log(`${LOGO} Starting robun gateway on port ${port}...`);

  const config = loadConfig();
  const bus = new MessageBus();
  const provider = makeProvider(config);
  const workspace = getWorkspacePath(config.agents.defaults.workspace);
  const sessionManager = new SessionManager();

  const cronStorePath = join(getDataDir(), "cron.json");
  const cronService = new CronService(cronStorePath);

  const agentLoop = new AgentLoop({
    bus,
    provider,
    workspace,
    model: config.agents.defaults.model,
    temperature: config.agents.defaults.temperature,
    maxTokens: config.agents.defaults.maxTokens,
    maxIterations: config.agents.defaults.maxToolIterations,
    memoryWindow: config.agents.defaults.memoryWindow,
    braveApiKey: config.tools.web.search.apiKey || null,
    execTimeout: config.tools.exec.timeout,
    restrictToWorkspace: config.tools.restrictToWorkspace,
    sessionManager,
    cronService,
    mcpServers: config.tools.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string>; url: string }>,
  });

  cronService.onJob = async (job) => {
    const result = await agentLoop.processDirect(job.payload.message, `cron:${job.id}`, job.payload.channel ?? undefined, job.payload.to ?? undefined);
    return result.content;
  };

  const heartbeatService = new HeartbeatService({
    workspace,
    onHeartbeat: async (prompt) => (await agentLoop.processDirect(prompt, "heartbeat:system")).content,
  });

  const channelManager = await ChannelManager.create(config, bus);

  if (channelManager.enabledChannels.length > 0) {
    console.log(chalk.green("v") + ` Channels enabled: ${channelManager.enabledChannels.join(", ")}`);
  } else {
    console.log(chalk.yellow("Warning: No channels enabled"));
  }

  // Start HTTP server
  const server = startServer(port, {
    agentLoop,
    sessionManager,
    cronService,
    channelManager,
    config,
  });
  console.log(chalk.green("v") + ` HTTP server listening on port ${port}`);

  // Run agent loop and channels
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    cronService.stop();
    heartbeatService.stop();
    agentLoop.stop();
    channelManager.stopAll().then(() => {
      server.stop();
      process.exit(0);
    });
  });

  try {
    await Promise.all([
      agentLoop.run(),
      channelManager.startAll(),
      cronService.start(),
      heartbeatService.start(),
    ]);
  } catch (err) {
    console.error(chalk.red(`Gateway error: ${err}`));
  } finally {
    cronService.stop();
    heartbeatService.stop();
    await agentLoop.closeMcp();
    agentLoop.stop();
    await channelManager.stopAll();
    server.stop();
  }
}

// ============================================================================
// Agent Commands
// ============================================================================

export async function agent(args: string[]): Promise<void> {
  const message = parseFlag(args, "--message", "-m");
  const sessionId = parseFlag(args, "--session", "-s") ?? "cli:direct";

  const { MessageBus } = await import("./bus/queue");
  const { AgentLoop } = await import("./agent/loop");

  const config = loadConfig();
  const bus = new MessageBus();
  const provider = makeProvider(config);
  const workspace = getWorkspacePath(config.agents.defaults.workspace);

  const agentLoop = new AgentLoop({
    bus,
    provider,
    workspace,
    model: config.agents.defaults.model,
    temperature: config.agents.defaults.temperature,
    maxTokens: config.agents.defaults.maxTokens,
    maxIterations: config.agents.defaults.maxToolIterations,
    memoryWindow: config.agents.defaults.memoryWindow,
    braveApiKey: config.tools.web.search.apiKey || null,
    execTimeout: config.tools.exec.timeout,
    restrictToWorkspace: config.tools.restrictToWorkspace,
    mcpServers: config.tools.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string>; url: string }>,
  });

  if (message) {
    // Single message mode
    const result = await agentLoop.processDirect(message, sessionId);
    console.log(`\n${LOGO} robun`);
    console.log(result.content);
    console.log();
    await agentLoop.closeMcp();
  } else {
    // Interactive mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`${LOGO} Interactive mode (type ${chalk.bold("exit")} or ${chalk.bold("Ctrl+C")} to quit)\n`);

    process.on("SIGINT", () => {
      console.log("\nGoodbye!");
      rl.close();
      agentLoop.closeMcp().then(() => process.exit(0));
    });

    try {
      while (true) {
        const input = await rl.question(chalk.blue.bold("You: "));
        const trimmed = input.trim();
        if (!trimmed) continue;
        if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
          console.log("\nGoodbye!");
          break;
        }

        const result = await agentLoop.processDirect(trimmed, sessionId);
        console.log(`\n${LOGO} robun`);
        console.log(result.content);
        console.log();
      }
    } catch {
      console.log("\nGoodbye!");
    } finally {
      rl.close();
      await agentLoop.closeMcp();
    }
  }
}

// ============================================================================
// Status Command
// ============================================================================

export async function status(): Promise<void> {
  const configPath = getConfigPath();
  const config = loadConfig();
  const workspace = getWorkspacePath(config.agents.defaults.workspace);

  console.log(`${LOGO} robun Status\n`);

  const configExists = existsSync(configPath);
  console.log(`Config: ${configPath} ${configExists ? chalk.green("v") : chalk.red("x")}`);
  console.log(`Workspace: ${workspace} ${existsSync(workspace) ? chalk.green("v") : chalk.red("x")}`);

  if (configExists) {
    console.log(`Model: ${config.agents.defaults.model}`);

    // Show provider key status
    const providers = config.providers as Record<string, { apiKey?: string; apiBase?: string | null }>;
    for (const spec of PROVIDERS) {
      const p = providers[spec.name];
      if (!p) continue;

      if (spec.isLocal) {
        if (p.apiBase) {
          console.log(`${spec.displayName}: ${chalk.green("v " + p.apiBase)}`);
        } else {
          console.log(`${spec.displayName}: ${chalk.dim("not set")}`);
        }
      } else {
        const hasKey = Boolean(p.apiKey);
        console.log(`${spec.displayName}: ${hasKey ? chalk.green("v") : chalk.dim("not set")}`);
      }
    }
  }
}

// ============================================================================
// Channel Commands
// ============================================================================

export async function channelsCmd(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "status") {
    const config = loadConfig();

    const table = new Table({
      head: [chalk.cyan("Channel"), chalk.green("Enabled"), chalk.yellow("Configuration")],
    });

    const ch = config.channels;

    table.push(
      ["WhatsApp", ch.whatsapp.enabled ? "v" : "x", ch.whatsapp.authDir || chalk.dim("default")],
      ["Telegram", ch.telegram.enabled ? "v" : "x", ch.telegram.token ? `token: ${ch.telegram.token.slice(0, 10)}...` : chalk.dim("not configured")],
      ["Discord", ch.discord.enabled ? "v" : "x", ch.discord.token ? `token: ${ch.discord.token.slice(0, 10)}...` : chalk.dim("not configured")],
      ["Slack", ch.slack.enabled ? "v" : "x", ch.slack.appToken && ch.slack.botToken ? "socket" : chalk.dim("not configured")],
      ["Email", ch.email.enabled ? "v" : "x", ch.email.imapHost || chalk.dim("not configured")],
      ["Feishu", ch.feishu.enabled ? "v" : "x", ch.feishu.appId ? `app_id: ${ch.feishu.appId.slice(0, 10)}...` : chalk.dim("not configured")],
      ["DingTalk", ch.dingtalk.enabled ? "v" : "x", ch.dingtalk.clientId ? `client: ${ch.dingtalk.clientId.slice(0, 10)}...` : chalk.dim("not configured")],
      ["Mochat", ch.mochat.enabled ? "v" : "x", ch.mochat.baseUrl || chalk.dim("not configured")],
      ["QQ", ch.qq.enabled ? "v" : "x", ch.qq.appId ? `app: ${ch.qq.appId.slice(0, 10)}...` : chalk.dim("not configured")],
    );

    console.log(table.toString());
  } else if (sub === "login") {
    console.log(`${LOGO} WhatsApp Login`);
    console.log("\nWhatsApp uses direct Baileys integration.");
    console.log("To link your device:");
    console.log(`  1. Enable WhatsApp in ${chalk.cyan("~/.robun/config.json")}`);
    console.log("  2. Start the gateway: " + chalk.cyan("robun gateway"));
    console.log("  3. Scan the QR code displayed in the terminal\n");
  } else {
    console.log("Usage: robun channels <status|login>");
  }
}

// ============================================================================
// Cron Commands
// ============================================================================

export async function cronCmd(args: string[]): Promise<void> {
  const sub = args[0];
  const { CronService } = await import("./cron/service");
  const cronStorePath = join(getDataDir(), "cron.json");
  const service = new CronService(cronStorePath);

  if (sub === "list") {
    const includeDisabled = hasFlag(args, "--all", "-a");
    const jobs = service.listJobs(includeDisabled);

    if (jobs.length === 0) {
      console.log("No scheduled jobs.");
      return;
    }

    const table = new Table({
      head: [chalk.cyan("ID"), "Name", "Schedule", "Status", "Next Run"],
    });

    for (const job of jobs) {
      let sched: string;
      if (job.schedule.kind === "every") {
        sched = `every ${((job.schedule.everyMs ?? 0) / 1000).toFixed(0)}s`;
      } else if (job.schedule.kind === "cron") {
        sched = job.schedule.expr ?? "";
      } else {
        sched = "one-time";
      }

      const nextRun = job.state.nextRunAtMs
        ? new Date(job.state.nextRunAtMs).toLocaleString()
        : "";

      const status = job.enabled ? chalk.green("enabled") : chalk.dim("disabled");

      table.push([job.id, job.name, sched, status, nextRun]);
    }

    console.log(table.toString());
  } else if (sub === "add") {
    const name = parseFlag(args, "--name", "-n");
    const message = parseFlag(args, "--message", "-m");
    const every = parseFlag(args, "--every", "-e");
    const cronExpr = parseFlag(args, "--cron", "-c");
    const at = parseFlag(args, "--at");
    const deliver = hasFlag(args, "--deliver", "-d");
    const to = parseFlag(args, "--to");
    const channel = parseFlag(args, "--channel");

    if (!name || !message) {
      console.error(chalk.red("Error: --name and --message are required"));
      console.log("Usage: robun cron add -n <name> -m <message> [--every <seconds> | --cron <expr> | --at <iso>]");
      process.exit(1);
    }

    if (!every && !cronExpr && !at) {
      console.error(chalk.red("Error: Must specify --every, --cron, or --at"));
      process.exit(1);
    }

    let schedule: { kind: "at" | "every" | "cron"; atMs: number | null; everyMs: number | null; expr: string | null; tz: string | null };
    if (every) {
      schedule = { kind: "every", everyMs: parseInt(every, 10) * 1000, atMs: null, expr: null, tz: null };
    } else if (cronExpr) {
      schedule = { kind: "cron", expr: cronExpr, atMs: null, everyMs: null, tz: null };
    } else {
      const dt = new Date(at!);
      schedule = { kind: "at", atMs: dt.getTime(), everyMs: null, expr: null, tz: null };
    }

    const job = service.addJob({
      name,
      schedule,
      message,
      deliver,
      channel: channel ?? null,
      to: to ?? null,
    });

    console.log(chalk.green("v") + ` Added job '${job.name}' (${job.id})`);
  } else if (sub === "remove") {
    const jobId = args[1];
    if (!jobId) {
      console.error(chalk.red("Error: Job ID required"));
      console.log("Usage: robun cron remove <job_id>");
      process.exit(1);
    }

    if (service.removeJob(jobId)) {
      console.log(chalk.green("v") + ` Removed job ${jobId}`);
    } else {
      console.error(chalk.red(`Job ${jobId} not found`));
    }
  } else if (sub === "enable") {
    const jobId = args[1];
    if (!jobId) {
      console.error(chalk.red("Error: Job ID required"));
      process.exit(1);
    }

    const disable = hasFlag(args, "--disable");
    const job = service.enableJob(jobId, !disable);
    if (job) {
      const status = disable ? "disabled" : "enabled";
      console.log(chalk.green("v") + ` Job '${job.name}' ${status}`);
    } else {
      console.error(chalk.red(`Job ${jobId} not found`));
    }
  } else if (sub === "run") {
    const jobId = args[1];
    if (!jobId) {
      console.error(chalk.red("Error: Job ID required"));
      process.exit(1);
    }

    const force = hasFlag(args, "--force", "-f");
    const result = await service.runJob(jobId, force);
    if (result) {
      console.log(chalk.green("v") + " Job executed");
    } else {
      console.error(chalk.red(`Failed to run job ${jobId}`));
    }
  } else {
    console.log("Usage: robun cron <list|add|remove|enable|run>");
  }
}

// ============================================================================
// Provider Commands
// ============================================================================

export async function providerCmd(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "login") {
    const providerName = args[1];

    if (!providerName) {
      console.error(chalk.red("Error: Provider name required"));
      console.log("Usage: robun provider login <provider>");
      console.log(chalk.dim("Supported: openai-codex"));
      process.exit(1);
    }

    if (providerName === "openai-codex") {
      console.log(`${LOGO} OAuth Login - ${providerName}\n`);

      const { getCodexToken, loginCodexInteractive } = await import("./providers/codex-auth");

      // Check for existing valid token first
      try {
        const existing = await getCodexToken();
        console.log(chalk.green("v") + " Already authenticated with OpenAI Codex.");
        console.log(chalk.dim(`Account ID: ${existing.accountId}`));

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("Re-authenticate? [y/N] ");
        rl.close();
        if (answer.trim().toLowerCase() !== "y") return;
      } catch {
        // No existing token, proceed with login
      }

      try {
        const token = await loginCodexInteractive(
          (msg) => console.log(msg),
          async (msg) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question(msg);
            rl.close();
            return answer;
          },
        );
        console.log(chalk.green("v") + " Successfully authenticated with OpenAI Codex!");
        console.log(chalk.dim(`Account ID: ${token.accountId}`));
      } catch (e) {
        console.error(chalk.red(`Authentication error: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    } else {
      console.error(chalk.red(`Unknown OAuth provider: ${providerName}`));
      console.log(chalk.yellow("Supported providers: openai-codex"));
      process.exit(1);
    }
  } else {
    console.log("Usage: robun provider <login>");
  }
}

// ============================================================================
// Help / Version
// ============================================================================

export function printVersion(): void {
  console.log(`${LOGO} robun v${VERSION}`);
}

export function printHelp(): void {
  console.log(`${LOGO} robun - Personal AI Assistant\n`);
  console.log("Usage: robun <command> [options]\n");
  console.log("Commands:");
  console.log("  onboard              Initialize configuration and workspace");
  console.log("  gateway [-p PORT]    Start the robun gateway (server + channels)");
  console.log("  agent [-m MSG]       Chat with the agent (interactive or single message)");
  console.log("  status               Show robun status");
  console.log("  channels <sub>       Manage channels (status, login)");
  console.log("  cron <sub>           Manage scheduled tasks (list, add, remove, enable, run)");
  console.log("  provider <sub>       Manage providers (login)");
  console.log("  --version, -v        Print version");
  console.log("  --help, -h           Show this help");
}
