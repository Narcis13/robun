/**
 * QQ channel implementation using the QQ Bot API directly.
 *
 * Since there is no TypeScript equivalent of the Python botpy SDK, this
 * implementation connects to the QQ Bot Gateway via WebSocket and uses
 * the REST API for sending messages.
 *
 * Protocol overview (similar to Discord Gateway):
 *   Op 10 (Hello)       -> receive heartbeat interval
 *   Op 2  (Identify)    -> authenticate with access token + intents
 *   Op 0  (Dispatch)    -> handle C2C_MESSAGE_CREATE events
 *   Op 1  (Heartbeat)   -> periodic keep-alive
 *   Op 11 (Heartbeat ACK)
 */

import WebSocket from "ws";
import pino from "pino";
import type { z } from "zod";

import { BaseChannel } from "./base";
import type { MessageBus } from "../bus/queue";
import type { OutboundMessage } from "../bus/events";
import type { QQConfigSchema } from "../config/schema";

type QQConfig = z.infer<typeof QQConfigSchema>;

const logger = pino({ name: "qq" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QQ_AUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";

/** Maximum number of message IDs kept for deduplication. */
const DEDUP_MAX_SIZE = 1000;

/** Reconnect delay in milliseconds. */
const RECONNECT_DELAY_MS = 5_000;

// Gateway opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Intents bitmask: PUBLIC_MESSAGES (1 << 30) | DIRECT_MESSAGE (1 << 12)
const QQ_INTENTS = (1 << 30) | (1 << 12);

// ---------------------------------------------------------------------------
// Gateway payload type
// ---------------------------------------------------------------------------

interface GatewayPayload {
  op: number;
  d: any;
  s: number | null;
  t: string | null;
}

// ---------------------------------------------------------------------------
// Circular buffer for message deduplication
// ---------------------------------------------------------------------------

class CircularDedup {
  private buffer: string[];
  private index = 0;
  private set = new Set<string>();

  constructor(private maxSize: number) {
    this.buffer = new Array(maxSize).fill("");
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;

    // Evict the oldest entry if the buffer is full
    const evicted = this.buffer[this.index];
    if (evicted) {
      this.set.delete(evicted);
    }

    this.buffer[this.index] = id;
    this.set.add(id);
    this.index = (this.index + 1) % this.maxSize;
  }
}

// ---------------------------------------------------------------------------
// QQChannel
// ---------------------------------------------------------------------------

export class QQChannel extends BaseChannel {
  readonly name = "qq";

  protected declare config: QQConfig;
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRunning = false;
  private accessToken: string | null = null;
  private processedIds = new CircularDedup(DEDUP_MAX_SIZE);

  constructor(config: QQConfig, bus: MessageBus) {
    super(config, bus);
    this.config = config;
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.secret) {
      logger.error("QQ appId and secret not configured");
      return;
    }

    this.running = true;

    while (this.running) {
      try {
        logger.info("Connecting to QQ gateway...");
        await this.authenticate();
        await this.connectAndRun();
      } catch (err) {
        if (!this.running) break;
        logger.warn(`QQ gateway error: ${err}`);
      }

      if (this.running) {
        logger.info("Reconnecting to QQ gateway in 5 seconds...");
        await this.sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info("QQ bot stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.accessToken) {
      logger.warn("QQ client not authenticated, cannot send message");
      return;
    }

    const url = `${QQ_API_BASE}/v2/users/${msg.chatId}/messages`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msg_type: 0,
          content: msg.content,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      logger.error(`Error sending QQ message: ${err}`);
    }
  }

  // ---- Authentication -----------------------------------------------------

  private async authenticate(): Promise<void> {
    const response = await fetch(QQ_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: this.config.appId,
        clientSecret: this.config.secret,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `QQ auth failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    logger.info("QQ access token obtained");
  }

  // ---- Gateway connection -------------------------------------------------

  private async getGatewayUrl(): Promise<string> {
    const response = await fetch(`${QQ_API_BASE}/gateway`, {
      headers: {
        Authorization: `QQBot ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `QQ gateway lookup failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { url: string };
    return data.url;
  }

  private connectAndRun(): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      let gatewayUrl: string;
      try {
        gatewayUrl = await this.getGatewayUrl();
      } catch (err) {
        reject(err);
        return;
      }

      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      ws.on("open", () => {
        logger.debug("QQ WebSocket connection opened");
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        let data: GatewayPayload;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          logger.warn(
            `Invalid JSON from QQ gateway: ${raw.toString().slice(0, 100)}`,
          );
          return;
        }

        this.handleGatewayMessage(data).catch((err) => {
          logger.error(`Error handling QQ gateway message: ${err}`);
        });
      });

      ws.on("close", (code, reason) => {
        logger.debug(`QQ WebSocket closed: ${code} ${reason.toString()}`);
        this.stopHeartbeat();
        this.ws = null;
        resolve();
      });

      ws.on("error", (err) => {
        logger.warn(`QQ WebSocket error: ${err.message}`);
        this.stopHeartbeat();
        this.ws = null;
        reject(err);
      });
    });
  }

  // ---- Gateway message handling -------------------------------------------

  private async handleGatewayMessage(data: GatewayPayload): Promise<void> {
    const { op, t: eventType, s: seq, d: payload } = data;

    // Track sequence number
    if (seq !== null) {
      this.seq = seq;
    }

    if (op === OP_HELLO) {
      // Hello: start heartbeat and identify
      const intervalMs: number = payload?.heartbeat_interval ?? 45000;
      this.startHeartbeat(intervalMs);
      await this.identify();
    } else if (op === OP_DISPATCH && eventType === "READY") {
      logger.info("QQ gateway READY");
    } else if (op === OP_DISPATCH && eventType === "C2C_MESSAGE_CREATE") {
      await this.handleInboundMessage(payload);
    } else if (op === OP_DISPATCH && eventType === "DIRECT_MESSAGE_CREATE") {
      await this.handleInboundMessage(payload);
    } else if (op === OP_HEARTBEAT_ACK) {
      // Heartbeat acknowledged -- nothing to do
    }
  }

  // ---- Identify -----------------------------------------------------------

  private async identify(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const identifyPayload = {
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents: QQ_INTENTS,
      },
    };

    this.ws.send(JSON.stringify(identifyPayload));
  }

  // ---- Heartbeat ----------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatRunning = true;

    const sendHeartbeat = () => {
      if (
        !this.heartbeatRunning ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) {
        this.stopHeartbeat();
        return;
      }

      const payload = { op: OP_HEARTBEAT, d: this.seq };
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        logger.warn(`QQ heartbeat failed: ${err}`);
        this.stopHeartbeat();
        return;
      }

      this.heartbeatTimer = setTimeout(sendHeartbeat, intervalMs);
    };

    // Send first heartbeat after a jittered delay
    this.heartbeatTimer = setTimeout(
      sendHeartbeat,
      intervalMs * Math.random(),
    );
  }

  private stopHeartbeat(): void {
    this.heartbeatRunning = false;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---- Inbound message handling -------------------------------------------

  private async handleInboundMessage(payload: any): Promise<void> {
    try {
      const messageId: string | undefined = payload?.id;

      // Dedup by message ID
      if (messageId && this.processedIds.has(messageId)) {
        return;
      }
      if (messageId) {
        this.processedIds.add(messageId);
      }

      // Extract user ID from author
      const author = payload?.author ?? {};
      const userId = String(
        author.id ?? author.user_openid ?? "unknown",
      );

      const content = ((payload?.content as string) ?? "").trim();
      if (!content) return;

      await this.handleMessage(userId, userId, content, undefined, {
        message_id: messageId ?? null,
      });
    } catch (err) {
      logger.error(`Error handling QQ message: ${err}`);
    }
  }

  // ---- Utilities ----------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
