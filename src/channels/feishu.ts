/**
 * Feishu/Lark channel implementation using WebSocket long connection.
 *
 * Uses the @larksuiteoapi/node-sdk for API calls (sending messages, reactions)
 * and WebSocket event subscriptions (receiving messages). No public IP or
 * webhook is required.
 *
 * The SDK is loaded dynamically so the channel can be disabled when the
 * dependency is not installed.
 */

import pino from "pino";
import type { z } from "zod";

import type { OutboundMessage } from "../bus/events";
import type { MessageBus } from "../bus/queue";
import type { FeishuConfigSchema } from "../config/schema";
import { BaseChannel } from "./base";

type FeishuConfig = z.infer<typeof FeishuConfigSchema>;

const logger = pino({ name: "feishu" });

// ---------------------------------------------------------------------------
// Optional SDK import
// ---------------------------------------------------------------------------

let lark: any;
try {
  lark = require("@larksuiteoapi/node-sdk");
} catch {
  lark = null;
}

// ---------------------------------------------------------------------------
// Message type display mapping
// ---------------------------------------------------------------------------

const MSG_TYPE_MAP: Record<string, string> = {
  image: "[image]",
  audio: "[audio]",
  file: "[file]",
  sticker: "[sticker]",
};

// ---------------------------------------------------------------------------
// Rich text (post) extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a single language block of a Feishu post message.
 */
function extractFromLang(langContent: unknown): string | null {
  if (!langContent || typeof langContent !== "object") return null;

  const lc = langContent as Record<string, unknown>;
  const title = (lc.title as string) ?? "";
  const contentBlocks = lc.content;
  if (!Array.isArray(contentBlocks)) return null;

  const textParts: string[] = [];
  if (title) textParts.push(title);

  for (const block of contentBlocks) {
    if (!Array.isArray(block)) continue;
    for (const element of block) {
      if (element && typeof element === "object") {
        const el = element as Record<string, unknown>;
        const tag = el.tag as string | undefined;
        if (tag === "text") {
          textParts.push((el.text as string) ?? "");
        } else if (tag === "a") {
          textParts.push((el.text as string) ?? "");
        } else if (tag === "at") {
          textParts.push(`@${(el.user_name as string) ?? "user"}`);
        }
      }
    }
  }

  return textParts.length > 0 ? textParts.join(" ").trim() : null;
}

/**
 * Extract plain text from Feishu post (rich text) message content.
 *
 * Supports two formats:
 * 1. Direct format: `{ title, content: [[...]] }`
 * 2. Localized format: `{ zh_cn: { title, content }, en_us: ... }`
 */
function extractPostText(contentJson: Record<string, unknown>): string {
  // Try direct format first
  if ("content" in contentJson) {
    const result = extractFromLang(contentJson);
    if (result) return result;
  }

  // Try localized format
  for (const langKey of ["zh_cn", "en_us", "ja_jp"]) {
    const result = extractFromLang(contentJson[langKey]);
    if (result) return result;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Markdown-to-Feishu-card helpers
// ---------------------------------------------------------------------------

/** Matches a complete markdown table (header + separator + data rows). */
const TABLE_RE =
  /((?:^[ \t]*\|.+\|[ \t]*\n)(?:^[ \t]*\|[-:\s|]+\|[ \t]*\n)(?:^[ \t]*\|.+\|[ \t]*\n?)+)/gm;

/** Matches markdown headings (# through ######). */
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

/** Matches fenced code blocks. */
const CODE_BLOCK_RE = /(```[\s\S]*?```)/gm;

/**
 * Parse a markdown table string into a Feishu table card element.
 */
function parseMdTable(
  tableText: string,
): Record<string, unknown> | null {
  const lines = tableText
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 3) return null;

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);

  const columns = headers.map((h, i) => ({
    tag: "column",
    name: `c${i}`,
    display_name: h,
    width: "auto",
  }));

  const rowData = rows.map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[`c${i}`] = i < r.length ? r[i] : "";
    }
    return obj;
  });

  return {
    tag: "table",
    page_size: rows.length + 1,
    columns,
    rows: rowData,
  };
}

/**
 * Split content by headings, converting headings to Feishu div elements
 * with bold lark_md text. Code blocks are protected from splitting.
 */
function splitHeadings(content: string): Record<string, unknown>[] {
  // Protect code blocks from heading regex
  let protected_ = content;
  const codeBlocks: string[] = [];

  for (const m of content.matchAll(CODE_BLOCK_RE)) {
    codeBlocks.push(m[1]);
    protected_ = protected_.replace(
      m[1],
      `\x00CODE${codeBlocks.length - 1}\x00`,
    );
  }

  const elements: Record<string, unknown>[] = [];
  let lastEnd = 0;

  for (const m of protected_.matchAll(HEADING_RE)) {
    const matchStart = m.index!;
    const before = protected_.slice(lastEnd, matchStart).trim();
    if (before) {
      elements.push({ tag: "markdown", content: before });
    }

    const text = m[2].trim();
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${text}**`,
      },
    });

    lastEnd = matchStart + m[0].length;
  }

  const remaining = protected_.slice(lastEnd).trim();
  if (remaining) {
    elements.push({ tag: "markdown", content: remaining });
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    for (const el of elements) {
      if (el.tag === "markdown" && typeof el.content === "string") {
        el.content = (el.content as string).replace(
          `\x00CODE${i}\x00`,
          codeBlocks[i],
        );
      }
    }
  }

  return elements.length > 0
    ? elements
    : [{ tag: "markdown", content }];
}

/**
 * Split content into div/markdown + table card elements for a Feishu
 * interactive card.
 */
function buildCardElements(content: string): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  let lastEnd = 0;

  for (const m of content.matchAll(TABLE_RE)) {
    const matchStart = m.index!;
    const before = content.slice(lastEnd, matchStart);
    if (before.trim()) {
      elements.push(...splitHeadings(before));
    }

    const tableEl = parseMdTable(m[1]);
    elements.push(
      tableEl ?? { tag: "markdown", content: m[1] },
    );

    lastEnd = matchStart + m[0].length;
  }

  const remaining = content.slice(lastEnd);
  if (remaining.trim()) {
    elements.push(...splitHeadings(remaining));
  }

  return elements.length > 0
    ? elements
    : [{ tag: "markdown", content }];
}

// ---------------------------------------------------------------------------
// FeishuChannel
// ---------------------------------------------------------------------------

/** Maximum size of the dedup cache before trimming. */
const DEDUP_MAX = 1000;
/** Size to trim the dedup cache down to. */
const DEDUP_TRIM = 500;

export class FeishuChannel extends BaseChannel {
  readonly name = "feishu" as const;

  protected declare config: FeishuConfig;

  private client: any = null;
  private wsClient: any = null;
  private stopResolve: (() => void) | null = null;

  /** OrderedMap-based dedup cache (oldest entries deleted first). */
  private processedMessageIds = new Map<string, null>();

  constructor(config: FeishuConfig, bus: MessageBus) {
    super(config, bus);
    this.config = config;
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (!lark) {
      logger.error(
        "Feishu SDK not installed. Run: bun add @larksuiteoapi/node-sdk",
      );
      return;
    }

    if (!this.config.appId || !this.config.appSecret) {
      logger.error("Feishu appId and appSecret not configured");
      return;
    }

    this.running = true;

    // Create Lark client for sending messages and reactions
    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel?.INFO ?? 2,
    });

    // Create event dispatcher for incoming messages
    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.config.encryptKey || "",
      verificationToken: this.config.verificationToken || "",
    });

    eventDispatcher["im.message.receive_v1"] = (data: any) => {
      this.onMessage(data).catch((err: unknown) => {
        logger.error({ err }, "Error processing Feishu message");
      });
    };

    // Create WebSocket client for long connection
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      eventDispatcher,
      loggerLevel: lark.LoggerLevel?.INFO ?? 2,
    });

    // Start WebSocket client with reconnect loop
    this.startWsLoop();

    logger.info("Feishu bot started with WebSocket long connection");
    logger.info("No public IP required - using WebSocket to receive events");

    // Keep running until stop() is called
    await new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.wsClient) {
      try {
        // The SDK may expose a close/stop method
        if (typeof this.wsClient.close === "function") {
          this.wsClient.close();
        } else if (typeof this.wsClient.stop === "function") {
          this.wsClient.stop();
        }
      } catch (err) {
        logger.warn({ err }, "Error stopping Feishu WebSocket client");
      }
      this.wsClient = null;
    }

    if (this.stopResolve) {
      this.stopResolve();
      this.stopResolve = null;
    }

    logger.info("Feishu bot stopped");
  }

  // ---- WebSocket reconnect loop -------------------------------------------

  private startWsLoop(): void {
    const run = async () => {
      while (this.running) {
        try {
          await this.wsClient.start();
        } catch (err) {
          logger.warn({ err }, "Feishu WebSocket error");
        }

        if (this.running) {
          logger.info("Reconnecting Feishu WebSocket in 5 seconds...");
          await this.sleep(5000);
        }
      }
    };

    // Fire-and-forget -- errors are caught inside the loop
    run().catch((err) => {
      logger.error({ err }, "Feishu WS loop crashed");
    });
  }

  // ---- Inbound message handler --------------------------------------------

  private async onMessage(data: any): Promise<void> {
    const event = data?.event ?? data;
    const message = event?.message;
    const sender = event?.sender;

    if (!message || !sender) {
      logger.debug("Feishu event missing message or sender, skipping");
      return;
    }

    // Deduplication
    const messageId: string | undefined = message.message_id;
    if (!messageId) return;

    if (this.processedMessageIds.has(messageId)) {
      return;
    }
    this.processedMessageIds.set(messageId, null);

    // Trim cache: remove oldest entries when exceeding DEDUP_MAX
    if (this.processedMessageIds.size > DEDUP_MAX) {
      const iter = this.processedMessageIds.keys();
      const toDelete = this.processedMessageIds.size - DEDUP_TRIM;
      for (let i = 0; i < toDelete; i++) {
        const key = iter.next().value;
        if (key !== undefined) {
          this.processedMessageIds.delete(key);
        }
      }
    }

    // Skip bot messages
    const senderType: string | undefined = sender.sender_type;
    if (senderType === "bot") return;

    const senderId: string =
      sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "unknown";
    const chatId: string = message.chat_id ?? "";
    const chatType: string = message.chat_type ?? ""; // "p2p" or "group"
    const msgType: string = message.message_type ?? "";

    // Add THUMBSUP reaction to indicate "seen" (best-effort)
    this.addReaction(messageId, "THUMBSUP").catch((err) => {
      logger.debug({ err }, "Failed to add Feishu reaction");
    });

    // Parse message content
    let content: string;

    if (msgType === "text") {
      try {
        const parsed = JSON.parse(message.content ?? "{}");
        content = parsed.text ?? "";
      } catch {
        content = message.content ?? "";
      }
    } else if (msgType === "post") {
      try {
        const contentJson = JSON.parse(message.content ?? "{}");
        content = extractPostText(contentJson);
      } catch {
        content = message.content ?? "";
      }
    } else {
      content = MSG_TYPE_MAP[msgType] ?? `[${msgType}]`;
    }

    if (!content) return;

    // In groups, use chat_id for replies; in DMs, use sender's open_id
    const replyTo = chatType === "group" ? chatId : senderId;

    await this.handleMessage(senderId, replyTo, content, undefined, {
      message_id: messageId,
      chat_type: chatType,
      msg_type: msgType,
    });
  }

  // ---- Reactions ----------------------------------------------------------

  private async addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<void> {
    if (!this.client) return;

    try {
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      });

      if (response?.code !== 0) {
        logger.warn(
          { code: response?.code, msg: response?.msg },
          "Failed to add Feishu reaction",
        );
      } else {
        logger.debug(
          { emojiType, messageId },
          "Added Feishu reaction",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Error adding Feishu reaction");
    }
  }

  // ---- Outbound -----------------------------------------------------------

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) {
      logger.warn("Feishu client not initialized");
      return;
    }

    try {
      // Determine receive_id_type based on chat_id prefix
      // "oc_" -> chat_id, otherwise -> open_id
      const receiveIdType = msg.chatId.startsWith("oc_")
        ? "chat_id"
        : "open_id";

      // Build interactive card with markdown + table support
      const elements = buildCardElements(msg.content);
      const card = {
        config: { wide_screen_mode: true },
        elements,
      };

      const response = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: msg.chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });

      if (response?.code !== 0) {
        logger.error(
          {
            code: response?.code,
            msg: response?.msg,
            logId: response?.log_id,
          },
          "Failed to send Feishu message",
        );
      } else {
        logger.debug({ chatId: msg.chatId }, "Feishu message sent");
      }
    } catch (err) {
      logger.error({ err }, "Error sending Feishu message");
    }
  }

  // ---- Utilities ----------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
