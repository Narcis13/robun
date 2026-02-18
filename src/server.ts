import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import type { AgentLoop } from "./agent/loop";
import type { SessionManager } from "./session/manager";
import type { CronService } from "./cron/service";
import type { ChannelManager } from "./channels/manager";
import type { Config } from "./config/schema";

export interface ServerDeps {
  agentLoop: AgentLoop;
  sessionManager: SessionManager;
  cronService?: CronService;
  channelManager?: ChannelManager;
  config: Config;
}

export function createApp(deps: ServerDeps): Hono {
  const { agentLoop, sessionManager, cronService, channelManager, config } = deps;
  const app = new Hono();

  app.use("*", cors());
  app.use("*", honoLogger());

  // ---------- Health ----------
  app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

  app.get("/status", (c) => {
    return c.json({
      agent: {
        model: config.agents.defaults.model,
        workspace: config.agents.defaults.workspace,
      },
      channels: channelManager?.enabledChannels ?? [],
      cron: { jobs: cronService?.listJobs().length ?? 0 },
    });
  });

  // ---------- Agent Interaction ----------
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

  // ---------- Sessions ----------
  app.get("/sessions", (c) => {
    return c.json(sessionManager.listSessions());
  });

  app.get("/sessions/:key", (c) => {
    const session = sessionManager.getOrCreate(c.req.param("key"));
    return c.json({ key: session.key, messages: session.messages.length });
  });

  // ---------- Cron ----------
  if (cronService) {
    app.get("/cron/jobs", (c) => {
      return c.json(cronService.listJobs());
    });

    app.post("/cron/jobs", async (c) => {
      const body = (await c.req.json()) as {
        name: string;
        schedule: { kind: "at" | "every" | "cron"; atMs?: number; everyMs?: number; expr?: string };
        message: string;
        deliver?: boolean;
        channel?: string;
        to?: string;
      };
      const job = cronService.addJob({
        name: body.name,
        schedule: {
          kind: body.schedule.kind,
          atMs: body.schedule.atMs ?? null,
          everyMs: body.schedule.everyMs ?? null,
          expr: body.schedule.expr ?? null,
          tz: null,
        },
        message: body.message,
        deliver: body.deliver ?? false,
        channel: body.channel,
        to: body.to,
      });
      return c.json(job, 201);
    });

    app.post("/cron/jobs/:id/run", async (c) => {
      const force = c.req.query("force") === "true";
      const ran = await cronService.runJob(c.req.param("id"), force);
      if (!ran) return c.json({ error: "Job not found or disabled" }, 404);
      return c.json({ ok: true });
    });

    app.delete("/cron/jobs/:id", (c) => {
      const removed = cronService.removeJob(c.req.param("id"));
      return c.json({ removed });
    });
  }

  // ---------- Config (sanitized) ----------
  app.get("/config", (c) => {
    return c.json({
      agents: config.agents,
      channels: {
        telegram: { enabled: config.channels.telegram.enabled },
        discord: { enabled: config.channels.discord.enabled },
        whatsapp: { enabled: config.channels.whatsapp.enabled },
        slack: { enabled: config.channels.slack.enabled },
        email: { enabled: config.channels.email.enabled },
        feishu: { enabled: config.channels.feishu.enabled },
        dingtalk: { enabled: config.channels.dingtalk.enabled },
        mochat: { enabled: config.channels.mochat.enabled },
        qq: { enabled: config.channels.qq.enabled },
      },
      gateway: config.gateway,
    });
  });

  return app;
}

export function startServer(port: number, deps: ServerDeps) {
  const app = createApp(deps);
  return Bun.serve({ port, fetch: app.fetch });
}
