/**
 * DingTalk channel implementation using Stream Mode.
 *
 * Since there is no TypeScript equivalent of the Python `dingtalk-stream` SDK,
 * this implementation uses a custom WebSocket connection to the DingTalk
 * Stream Gateway for receiving messages, and the DingTalk REST API for
 * sending messages and obtaining OAuth access tokens.
 *
 * Currently supports private (1:1) chat. Group messages are received but
 * replies are sent as private messages to the sender.
 */

import WebSocket from "ws";
import pino from "pino";
import type { z } from "zod";

import { BaseChannel } from "./base";
import type { MessageBus } from "../bus/queue";
import type { OutboundMessage } from "../bus/events";
import type { DingTalkConfigSchema } from "../config/schema";

type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;

const logger = pino({ name: "dingtalk" });

const DINGTALK_API_BASE = "https://api.dingtalk.com";
const OAUTH_TOKEN_URL = `${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`;
const STREAM_OPEN_URL = `${DINGTALK_API_BASE}/v1.0/gateway/connections/open`;
const SEND_MESSAGE_URL = `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`;

// ---------------------------------------------------------------------------
// DingTalkChannel
// ---------------------------------------------------------------------------

export class DingTalkChannel extends BaseChannel {
  readonly name = "dingtalk" as const;

  private ws: WebSocket | null = null;
  private stopResolve: (() => void) | null = null;

  // Access token management
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(config: DingTalkConfig, bus: MessageBus) {
    super(config, bus);
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    const cfg = this.config as DingTalkConfig;

    if (!cfg.clientId || !cfg.clientSecret) {
      logger.error("DingTalk clientId and clientSecret not configured");
      return;
    }

    this.running = true;

    logger.info(
      { clientId: cfg.clientId },
      "Initializing DingTalk Stream Client...",
    );

    // Reconnect loop: restart stream if connection drops
    while (this.running) {
      try {
        await this.connectAndRun();
      } catch (err) {
        if (!this.running) break;
        logger.warn({ err }, "DingTalk stream error");
      }

      if (this.running) {
        logger.info("Reconnecting DingTalk stream in 5 seconds...");
        await this.sleep(5000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        logger.warn({ err }, "DingTalk WebSocket close failed");
      }
      this.ws = null;
    }

    if (this.stopResolve) {
      this.stopResolve();
      this.stopResolve = null;
    }
  }

  // ---- Outbound -----------------------------------------------------------

  async send(msg: OutboundMessage): Promise<void> {
    const cfg = this.config as DingTalkConfig;
    const token = await this.getAccessToken();

    if (!token) {
      logger.warn("Cannot send DingTalk message: no access token");
      return;
    }

    const payload = {
      robotCode: cfg.clientId,
      userIds: [msg.chatId],
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        text: msg.content,
        title: "Robun Reply",
      }),
    };

    try {
      const resp = await fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.error(
          { status: resp.status, body },
          "DingTalk send failed",
        );
      } else {
        logger.debug({ chatId: msg.chatId }, "DingTalk message sent");
      }
    } catch (err) {
      logger.error({ err }, "Error sending DingTalk message");
    }
  }

  // ---- Stream connection --------------------------------------------------

  /**
   * Open a stream gateway connection and run until the WebSocket closes.
   * Resolves when the connection is closed; throws on error.
   */
  private async connectAndRun(): Promise<void> {
    const endpoint = await this.openStreamConnection();
    if (!endpoint) {
      throw new Error("Failed to open DingTalk stream connection");
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      this.ws = ws;

      ws.on("open", () => {
        logger.info("DingTalk WebSocket connection opened");
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        this.handleStreamMessage(raw).catch((err) => {
          logger.error({ err }, "Error handling DingTalk stream message");
        });
      });

      ws.on("close", (code, reason) => {
        logger.debug(
          { code, reason: reason.toString() },
          "DingTalk WebSocket closed",
        );
        this.ws = null;
        resolve();
      });

      ws.on("error", (err) => {
        logger.warn({ err: err.message }, "DingTalk WebSocket error");
        this.ws = null;
        reject(err);
      });
    });
  }

  /**
   * Request a stream endpoint URL from the DingTalk gateway API.
   */
  private async openStreamConnection(): Promise<string | null> {
    const cfg = this.config as DingTalkConfig;

    try {
      const resp = await fetch(STREAM_OPEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.error(
          { status: resp.status, body },
          "Failed to open DingTalk stream connection",
        );
        return null;
      }

      const data = (await resp.json()) as {
        endpoint?: string;
        ticket?: string;
      };

      if (!data.endpoint) {
        logger.error("DingTalk stream response missing endpoint");
        return null;
      }

      // The endpoint may already be a full wss:// URL, or may need the ticket
      // appended as a query parameter
      let url = data.endpoint;
      if (data.ticket) {
        const sep = url.includes("?") ? "&" : "?";
        url = `${url}${sep}ticket=${encodeURIComponent(data.ticket)}`;
      }

      logger.debug({ url }, "DingTalk stream endpoint obtained");
      return url;
    } catch (err) {
      logger.error({ err }, "Error opening DingTalk stream connection");
      return null;
    }
  }

  // ---- Inbound handler ----------------------------------------------------

  /**
   * Parse an incoming stream message and forward valid chat messages
   * to the message bus.
   */
  private async handleStreamMessage(raw: WebSocket.RawData): Promise<void> {
    let envelope: Record<string, any>;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      logger.warn("Invalid JSON from DingTalk stream");
      return;
    }

    // The stream protocol wraps callback data in various envelope shapes.
    // Extract the inner data payload.
    const data: Record<string, any> =
      envelope.data ?? envelope.payload ?? envelope;

    // Extract text content
    const textObj = data.text as Record<string, string> | undefined;
    let content = textObj?.content?.trim() ?? "";

    if (!content) {
      // Some message types may not have text content (e.g. images)
      const msgType = data.msgtype ?? data.messageType ?? "unknown";
      logger.debug(
        { msgType },
        "Received empty or unsupported DingTalk message type",
      );
      return;
    }

    // Extract sender information
    const senderId: string =
      data.senderStaffId ?? data.senderId ?? data.sender_staff_id ?? "";
    const senderName: string =
      data.senderNick ?? data.sender_nick ?? "Unknown";

    if (!senderId) {
      logger.warn("DingTalk message missing sender ID");
      return;
    }

    logger.info(
      { sender: senderName, senderId, content: content.slice(0, 80) },
      "DingTalk message received",
    );

    // For private chat, chat_id is the sender_id
    await this.handleMessage(senderId, senderId, content, undefined, {
      dingtalk: {
        senderName,
        platform: "dingtalk",
      },
    });
  }

  // ---- OAuth token management ---------------------------------------------

  /**
   * Obtain or return a cached DingTalk access token.
   * Tokens are cached with a 60-second safety margin before expiry.
   */
  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const cfg = this.config as DingTalkConfig;

    try {
      const resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appKey: cfg.clientId,
          appSecret: cfg.clientSecret,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.error(
          { status: resp.status, body },
          "Failed to get DingTalk access token",
        );
        return null;
      }

      const data = (await resp.json()) as {
        accessToken?: string;
        expireIn?: number;
      };

      this.accessToken = data.accessToken ?? null;
      // Expire 60 seconds early to be safe
      const expiresInMs = ((data.expireIn ?? 7200) - 60) * 1000;
      this.tokenExpiry = Date.now() + expiresInMs;

      logger.debug("DingTalk access token refreshed");
      return this.accessToken;
    } catch (err) {
      logger.error({ err }, "Error refreshing DingTalk access token");
      return null;
    }
  }

  // ---- Utilities ----------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
