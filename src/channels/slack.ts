/**
 * Slack channel implementation using Socket Mode.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import pino from "pino";
import type { z } from "zod";

import type { OutboundMessage } from "../bus/events";
import type { MessageBus } from "../bus/queue";
import type { SlackConfigSchema } from "../config/schema";
import { BaseChannel } from "./base";

type SlackConfig = z.infer<typeof SlackConfigSchema>;

const logger = pino({ name: "slack" });

// ---------------------------------------------------------------------------
// Markdown-to-mrkdwn helpers
// ---------------------------------------------------------------------------

const TABLE_RE = /(?:^|\n)(\|.*\|)(?:\n\|[\s:|-]*\|)(?:\n\|.*\|)*/g;

/**
 * Convert a single markdown table match into a Slack-readable list format.
 * Each data row becomes "Header: value \u00b7 Header: value".
 */
function convertTable(match: string): string {
  const lines = match
    .trim()
    .split("\n")
    .map((ln) => ln.trim())
    .filter(Boolean);

  if (lines.length < 2) return match;

  const headers = lines[0]
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((h) => h.trim());

  // Determine where data rows start (skip separator line)
  const start = /^[|\s:\-]+$/.test(lines[1]) ? 2 : 1;

  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

    // Pad cells to match header count
    const paddedCells = [...cells, ...Array(headers.length).fill("")].slice(
      0,
      headers.length,
    );

    const parts: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      if (paddedCells[i]) {
        parts.push(`**${headers[i]}**: ${paddedCells[i]}`);
      }
    }
    if (parts.length > 0) {
      rows.push(parts.join(" \u00b7 "));
    }
  }

  return rows.join("\n");
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 *
 * Slack mrkdwn differences from standard markdown:
 * - Bold: *text* instead of **text**
 * - Italic: _text_ (same)
 * - Strikethrough: ~text~ instead of ~~text~~
 * - Code blocks and inline code: same backtick syntax
 * - Links: <url|text> instead of [text](url)
 * - No heading syntax — just bold the text
 * - Tables are not supported — convert to readable list
 */
function toMrkdwn(text: string): string {
  if (!text) return "";

  // 1. Convert tables first
  let result = text.replace(TABLE_RE, convertTable);

  // 2. Protect code blocks from further transformation
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 3. Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 4. Convert links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // 5. Convert bold: **text** -> *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // 6. Convert strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // 7. Convert headers: # Heading -> *Heading*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // 8. Convert blockquotes: > text -> > text (Slack supports this natively)
  // No transformation needed.

  // 9. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00IC${i}\x00`, inlineCodes[i]);
  }

  // 10. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CB${i}\x00`, codeBlocks[i]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// SlackChannel
// ---------------------------------------------------------------------------

interface SlackEventPayload {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  envelope_id: string;
  type: string;
  body: Record<string, unknown>;
  retry_num?: number;
  retry_reason?: string;
  accepts_response_payload: boolean;
}

export class SlackChannel extends BaseChannel {
  readonly name = "slack" as const;

  private webClient: WebClient | null = null;
  private socketClient: SocketModeClient | null = null;
  private botUserId: string | null = null;
  private stopResolve: (() => void) | null = null;

  constructor(config: SlackConfig, bus: MessageBus) {
    super(config, bus);
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    const cfg = this.config as SlackConfig;

    if (!cfg.botToken || !cfg.appToken) {
      logger.error("Slack bot/app token not configured");
      return;
    }
    if (cfg.mode !== "socket") {
      logger.error({ mode: cfg.mode }, "Unsupported Slack mode");
      return;
    }

    this.running = true;

    this.webClient = new WebClient(cfg.botToken);
    this.socketClient = new SocketModeClient({ appToken: cfg.appToken });

    // Listen for all socket-mode events
    this.socketClient.on("slack_event", (evt: SlackEventPayload) => {
      this.onSlackEvent(evt).catch((err) => {
        logger.error({ err }, "Error handling Slack event");
      });
    });

    // Resolve bot user ID for mention handling
    try {
      const auth = await this.webClient.auth.test();
      this.botUserId = (auth.user_id as string) ?? null;
      logger.info({ botUserId: this.botUserId }, "Slack bot connected");
    } catch (err) {
      logger.warn({ err }, "Slack auth.test failed");
    }

    logger.info("Starting Slack Socket Mode client...");
    await this.socketClient.start();

    // Keep alive until stop() is called
    await new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.socketClient) {
      try {
        await this.socketClient.disconnect();
      } catch (err) {
        logger.warn({ err }, "Slack socket disconnect failed");
      }
      this.socketClient = null;
    }

    if (this.stopResolve) {
      this.stopResolve();
      this.stopResolve = null;
    }
  }

  // ---- Outbound -----------------------------------------------------------

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.webClient) {
      logger.warn("Slack client not running");
      return;
    }

    try {
      const slackMeta =
        (msg.metadata?.slack as Record<string, unknown>) ?? {};
      const threadTs = slackMeta.thread_ts as string | undefined;
      const channelType = slackMeta.channel_type as string | undefined;

      // Only reply in thread for channel/group messages; DMs don't use threads
      const useThread = threadTs && channelType !== "im";

      await this.webClient.chat.postMessage({
        channel: msg.chatId,
        text: toMrkdwn(msg.content),
        thread_ts: useThread ? threadTs : undefined,
      });
    } catch (err) {
      logger.error({ err }, "Error sending Slack message");
    }
  }

  // ---- Inbound handler ----------------------------------------------------

  private async onSlackEvent(evt: SlackEventPayload): Promise<void> {
    if (evt.type !== "events_api") {
      return;
    }

    // Acknowledge immediately
    await evt.ack();

    const payload = evt.body ?? {};
    const event = (payload.event as Record<string, unknown>) ?? {};
    const eventType = event.type as string | undefined;

    // Handle app mentions or plain messages only
    if (eventType !== "message" && eventType !== "app_mention") {
      return;
    }

    const senderId = event.user as string | undefined;
    const chatId = event.channel as string | undefined;

    // Ignore bot/system messages (any subtype = not a normal user message)
    if (event.subtype) {
      return;
    }
    if (this.botUserId && senderId === this.botUserId) {
      return;
    }

    // Dedup: Slack sends both `message` and `app_mention` for mentions in
    // channels. Prefer `app_mention` by skipping `message` events that
    // contain a mention of this bot.
    const text = (event.text as string) ?? "";
    if (
      eventType === "message" &&
      this.botUserId &&
      text.includes(`<@${this.botUserId}>`)
    ) {
      return;
    }

    logger.debug(
      {
        eventType,
        subtype: event.subtype,
        user: senderId,
        channel: chatId,
        channelType: event.channel_type,
        text: text.slice(0, 80),
      },
      "Slack event received",
    );

    if (!senderId || !chatId) {
      return;
    }

    const channelType = (event.channel_type as string) ?? "";

    if (!this.isAllowedSlack(senderId, chatId, channelType)) {
      return;
    }

    if (
      channelType !== "im" &&
      !this.shouldRespondInChannel(eventType, text, chatId)
    ) {
      return;
    }

    const cleanedText = this.stripBotMention(text);

    const threadTs =
      (event.thread_ts as string) ?? (event.ts as string) ?? undefined;

    // Add :eyes: reaction to the triggering message (best-effort)
    try {
      if (this.webClient && event.ts) {
        await this.webClient.reactions.add({
          channel: chatId,
          name: "eyes",
          timestamp: event.ts as string,
        });
      }
    } catch (err) {
      logger.debug({ err }, "Slack reactions.add failed");
    }

    await this.handleMessage(senderId, chatId, cleanedText, undefined, {
      slack: {
        event,
        thread_ts: threadTs,
        channel_type: channelType,
      },
    });
  }

  // ---- Access control -----------------------------------------------------

  private isAllowedSlack(
    senderId: string,
    chatId: string,
    channelType: string,
  ): boolean {
    const cfg = this.config as SlackConfig;

    if (channelType === "im") {
      if (!cfg.dm.enabled) {
        return false;
      }
      if (cfg.dm.policy === "allowlist") {
        return cfg.dm.allowFrom.includes(senderId);
      }
      return true;
    }

    // Group / channel messages
    if (cfg.groupPolicy === "allowlist") {
      return cfg.groupAllowFrom.includes(chatId);
    }
    return true;
  }

  private shouldRespondInChannel(
    eventType: string,
    text: string,
    chatId: string,
  ): boolean {
    const cfg = this.config as SlackConfig;

    if (cfg.groupPolicy === "open") {
      return true;
    }

    if (cfg.groupPolicy === "mention") {
      if (eventType === "app_mention") {
        return true;
      }
      return (
        this.botUserId !== null && text.includes(`<@${this.botUserId}>`)
      );
    }

    if (cfg.groupPolicy === "allowlist") {
      return cfg.groupAllowFrom.includes(chatId);
    }

    return false;
  }

  // ---- Text helpers -------------------------------------------------------

  private stripBotMention(text: string): string {
    if (!text || !this.botUserId) {
      return text;
    }
    const pattern = new RegExp(
      `<@${this.botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>\\s*`,
      "g",
    );
    return text.replace(pattern, "").trim();
  }
}
