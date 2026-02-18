/**
 * Discord channel implementation using the Discord Gateway WebSocket.
 *
 * Connects to the Discord Gateway for receiving events, and uses
 * the REST API for sending messages and typing indicators.
 */

import WebSocket from "ws";
import pino from "pino";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";

import { BaseChannel } from "./base";
import type { MessageBus } from "../bus/queue";
import type { OutboundMessage } from "../bus/events";
import type { DiscordConfigSchema } from "../config/schema";

type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

const logger = pino({ name: "discord" });

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

interface GatewayPayload {
  op: number;
  d: any;
  s: number | null;
  t: string | null;
}

export class DiscordChannel extends BaseChannel {
  readonly name = "discord";

  protected declare config: DiscordConfig;
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRunning = false;
  private typingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config: DiscordConfig, bus: MessageBus) {
    super(config, bus);
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.token) {
      logger.error("Discord bot token not configured");
      return;
    }

    this.running = true;

    while (this.running) {
      try {
        logger.info("Connecting to Discord gateway...");
        await this.connectAndRun();
      } catch (err) {
        if (!this.running) break;
        logger.warn(`Discord gateway error: ${err}`);
      }

      if (this.running) {
        logger.info("Reconnecting to Discord gateway in 5 seconds...");
        await this.sleep(5000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();

    for (const [, timer] of this.typingTimers) {
      clearInterval(timer);
    }
    this.typingTimers.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    const url = `${DISCORD_API_BASE}/channels/${msg.chatId}/messages`;
    const payload: Record<string, unknown> = { content: msg.content };

    if (msg.replyTo) {
      payload.message_reference = { message_id: msg.replyTo };
      payload.allowed_mentions = { replied_user: false };
    }

    const headers: Record<string, string> = {
      Authorization: `Bot ${this.config.token}`,
      "Content-Type": "application/json",
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });

          if (response.status === 429) {
            const data = (await response.json()) as { retry_after?: number };
            const retryAfter = data.retry_after ?? 1.0;
            logger.warn(`Discord rate limited, retrying in ${retryAfter}s`);
            await this.sleep(retryAfter * 1000);
            continue;
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          return;
        } catch (err) {
          if (attempt === 2) {
            logger.error(`Error sending Discord message: ${err}`);
          } else {
            await this.sleep(1000);
          }
        }
      }
    } finally {
      this.stopTyping(msg.chatId);
    }
  }

  // ---------------------------------------------------------------------------
  // Gateway connection
  // ---------------------------------------------------------------------------

  private connectAndRun(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.gatewayUrl);
      this.ws = ws;

      ws.on("open", () => {
        logger.debug("Discord WebSocket connection opened");
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        let data: GatewayPayload;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          logger.warn(`Invalid JSON from Discord gateway: ${raw.toString().slice(0, 100)}`);
          return;
        }

        this.handleGatewayMessage(data).catch((err) => {
          logger.error(`Error handling gateway message: ${err}`);
        });
      });

      ws.on("close", (code, reason) => {
        logger.debug(`Discord WebSocket closed: ${code} ${reason.toString()}`);
        this.stopHeartbeat();
        this.ws = null;
        resolve();
      });

      ws.on("error", (err) => {
        logger.warn(`Discord WebSocket error: ${err.message}`);
        this.stopHeartbeat();
        this.ws = null;
        reject(err);
      });
    });
  }

  private async handleGatewayMessage(data: GatewayPayload): Promise<void> {
    const { op, t: eventType, s: seq, d: payload } = data;

    // Track sequence number
    if (seq !== null) {
      this.seq = seq;
    }

    if (op === 10) {
      // HELLO: start heartbeat and identify
      const intervalMs: number = payload?.heartbeat_interval ?? 45000;
      this.startHeartbeat(intervalMs);
      await this.identify();
    } else if (op === 0 && eventType === "READY") {
      logger.info("Discord gateway READY");
    } else if (op === 0 && eventType === "MESSAGE_CREATE") {
      await this.handleMessageCreate(payload);
    } else if (op === 7) {
      // RECONNECT: close to trigger reconnect
      logger.info("Discord gateway requested reconnect");
      this.ws?.close();
    } else if (op === 9) {
      // INVALID_SESSION: close to trigger reconnect
      logger.warn("Discord gateway invalid session");
      this.ws?.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Identify
  // ---------------------------------------------------------------------------

  private async identify(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const identifyPayload = {
      op: 2,
      d: {
        token: this.config.token,
        intents: this.config.intents,
        properties: {
          os: "robun",
          browser: "robun",
          device: "robun",
        },
      },
    };

    this.ws.send(JSON.stringify(identifyPayload));
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatRunning = true;

    const sendHeartbeat = () => {
      if (!this.heartbeatRunning || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      const payload = { op: 1, d: this.seq };
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        logger.warn(`Discord heartbeat failed: ${err}`);
        this.stopHeartbeat();
        return;
      }

      this.heartbeatTimer = setTimeout(sendHeartbeat, intervalMs);
    };

    // Send first heartbeat after a jittered delay (Discord recommendation)
    this.heartbeatTimer = setTimeout(sendHeartbeat, intervalMs * Math.random());
  }

  private stopHeartbeat(): void {
    this.heartbeatRunning = false;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessageCreate(payload: any): Promise<void> {
    const author = payload?.author ?? {};
    if (author.bot) return;

    const senderId = String(author.id ?? "");
    const channelId = String(payload.channel_id ?? "");
    const content: string = payload.content ?? "";

    if (!senderId || !channelId) return;

    const contentParts: string[] = content ? [content] : [];
    const mediaPaths: string[] = [];
    const mediaDir = join(homedir(), ".robun", "media");

    const attachments: any[] = payload.attachments ?? [];
    for (const attachment of attachments) {
      const url: string | undefined = attachment.url;
      const filename: string = attachment.filename ?? "attachment";
      const size: number = attachment.size ?? 0;

      if (!url) continue;

      if (size && size > MAX_ATTACHMENT_BYTES) {
        contentParts.push(`[attachment: ${filename} - too large]`);
        continue;
      }

      try {
        await mkdir(mediaDir, { recursive: true });
        const safeFilename = filename.replace(/\//g, "_");
        const filePath = join(mediaDir, `${attachment.id ?? "file"}_${safeFilename}`);

        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        await writeFile(filePath, buffer);

        mediaPaths.push(filePath);
        contentParts.push(`[attachment: ${filePath}]`);
      } catch (err) {
        logger.warn(`Failed to download Discord attachment: ${err}`);
        contentParts.push(`[attachment: ${filename} - download failed]`);
      }
    }

    const replyTo: string | undefined = payload.referenced_message?.id;

    await this.startTyping(channelId);

    const finalContent =
      contentParts.filter((p) => p).join("\n") || "[empty message]";

    await this.handleMessage(senderId, channelId, finalContent, mediaPaths, {
      message_id: String(payload.id ?? ""),
      guild_id: payload.guild_id ?? null,
      reply_to: replyTo ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Typing indicator
  // ---------------------------------------------------------------------------

  private async startTyping(channelId: string): Promise<void> {
    this.stopTyping(channelId);

    const url = `${DISCORD_API_BASE}/channels/${channelId}/typing`;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.config.token}`,
    };

    // Fire-and-forget the initial typing request
    const sendTyping = () => {
      fetch(url, { method: "POST", headers }).catch(() => {
        // Silently ignore typing indicator failures
      });
    };

    // Send immediately
    sendTyping();

    // Repeat every 8 seconds
    const timer = setInterval(sendTyping, 8000);
    this.typingTimers.set(channelId, timer);
  }

  private stopTyping(channelId: string): void {
    const timer = this.typingTimers.get(channelId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(channelId);
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
