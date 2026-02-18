/**
 * Telegram channel implementation using grammy (long polling mode).
 */

import { Bot, type Context } from "grammy";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { z } from "zod";

import type { OutboundMessage } from "../bus/events";
import type { MessageBus } from "../bus/queue";
import { BaseChannel } from "./base";
import type { TelegramConfigSchema } from "../config/schema";
import { GroqTranscriptionProvider } from "../providers/transcription";

type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

const logger = pino({ name: "telegram" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert markdown to Telegram-safe HTML.
 *
 * Steps:
 *  1. Extract code blocks and inline code with placeholders
 *  2. Strip headers (# Title -> Title)
 *  3. Strip blockquotes (> text -> text)
 *  4. Escape HTML special chars
 *  5. Convert links, bold, italic, strikethrough, bullet lists
 *  6. Restore code blocks / inline code
 */
function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```\w*\n?([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 4. Strip blockquotes
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 5. Escape HTML
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 6. Links [text](url) - before bold/italic to handle nested cases
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 8. Italic _text_ (avoid matching inside words like some_var_name)
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 9. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, "\u2022 ");

  // 11. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i]
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 12. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i]
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

/**
 * Split content into chunks of at most `maxLen` characters,
 * preferring line breaks, then spaces, as split points.
 */
function splitMessage(content: string, maxLen = 4000): string[] {
  if (content.length <= maxLen) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const cut = remaining.slice(0, maxLen);
    let pos = cut.lastIndexOf("\n");
    if (pos === -1) pos = cut.lastIndexOf(" ");
    if (pos === -1) pos = maxLen;

    chunks.push(remaining.slice(0, pos));
    remaining = remaining.slice(pos).trimStart();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

const MIME_EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
};

const TYPE_EXT_MAP: Record<string, string> = {
  image: ".jpg",
  voice: ".ogg",
  audio: ".mp3",
  file: "",
};

function getExtension(mediaType: string, mimeType?: string): string {
  if (mimeType && MIME_EXT_MAP[mimeType]) {
    return MIME_EXT_MAP[mimeType];
  }
  return TYPE_EXT_MAP[mediaType] ?? "";
}

// ---------------------------------------------------------------------------
// TelegramChannel
// ---------------------------------------------------------------------------

export class TelegramChannel extends BaseChannel {
  readonly name = "telegram" as const;

  private bot: Bot | null = null;
  private groqApiKey: string;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: TelegramConfig, bus: MessageBus, groqApiKey = "") {
    super(config, bus);
    this.groqApiKey = groqApiKey;
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    const token = (this.config as TelegramConfig).token;
    if (!token) {
      logger.error("Telegram bot token not configured");
      return;
    }

    this.running = true;
    this.bot = new Bot(token);

    // Error handler
    this.bot.catch((err) => {
      logger.error({ err: err.error }, "Telegram error");
    });

    // Command handlers
    this.bot.command("start", (ctx) => this.onStart(ctx));
    this.bot.command("new", (ctx) => this.forwardCommand(ctx));
    this.bot.command("help", (ctx) => this.forwardCommand(ctx));

    // Message handler for text, photos, voice, audio, documents
    this.bot.on("message", (ctx) => this.onMessage(ctx));

    logger.info("Starting Telegram bot (polling mode)...");

    // Register commands with Telegram
    try {
      await this.bot.api.setMyCommands([
        { command: "start", description: "Start the bot" },
        { command: "new", description: "Start a new conversation" },
        { command: "help", description: "Show available commands" },
      ]);
      logger.debug("Telegram bot commands registered");
    } catch (e) {
      logger.warn({ err: e }, "Failed to register bot commands");
    }

    // Get bot info
    const me = await this.bot.api.getMe();
    logger.info(`Telegram bot @${me.username} connected`);

    // Start long polling (fire-and-forget; bot.start() runs until bot.stop())
    this.bot.start({
      allowed_updates: ["message"],
      drop_pending_updates: true,
      onStart: () => {
        logger.info("Telegram polling started");
      },
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    // Cancel all typing indicators
    for (const chatId of this.typingTimers.keys()) {
      this.stopTyping(chatId);
    }

    if (this.bot) {
      logger.info("Stopping Telegram bot...");
      await this.bot.stop();
      this.bot = null;
    }
  }

  // ---- Outbound -----------------------------------------------------------

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.bot) {
      logger.warn("Telegram bot not running");
      return;
    }

    this.stopTyping(msg.chatId);

    const chatId = Number(msg.chatId);
    if (Number.isNaN(chatId)) {
      logger.error(`Invalid chat_id: ${msg.chatId}`);
      return;
    }

    for (const chunk of splitMessage(msg.content)) {
      try {
        const html = markdownToTelegramHtml(chunk);
        await this.bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
      } catch (htmlErr) {
        logger.warn({ err: htmlErr }, "HTML parse failed, falling back to plain text");
        try {
          await this.bot.api.sendMessage(chatId, chunk);
        } catch (plainErr) {
          logger.error({ err: plainErr }, "Error sending Telegram message");
        }
      }
    }
  }

  // ---- Inbound handlers ---------------------------------------------------

  private async onStart(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    await ctx.reply(
      `Hi ${ctx.from.first_name}! I'm robun.\n\n` +
        "Send me a message and I'll respond!\n" +
        "Type /help to see available commands.",
    );
  }

  private async forwardCommand(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.from) return;
    await this.handleMessage(
      this.senderId(ctx.from),
      String(ctx.message.chat.id),
      ctx.message.text ?? "",
    );
  }

  private async onMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.from) return;

    // Skip commands — they are handled by the command handlers above
    if (ctx.message.text?.startsWith("/")) return;

    const message = ctx.message;
    const user = ctx.from;
    const chatId = String(message.chat.id);
    const sid = this.senderId(user);

    const contentParts: string[] = [];
    const mediaPaths: string[] = [];

    // Text content
    if (message.text) contentParts.push(message.text);
    if (message.caption) contentParts.push(message.caption);

    // Determine media file
    let mediaFileId: string | undefined;
    let mediaType: string | undefined;
    let mimeType: string | undefined;

    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      mediaFileId = largest.file_id;
      mediaType = "image";
    } else if (message.voice) {
      mediaFileId = message.voice.file_id;
      mediaType = "voice";
      mimeType = message.voice.mime_type;
    } else if (message.audio) {
      mediaFileId = message.audio.file_id;
      mediaType = "audio";
      mimeType = message.audio.mime_type;
    } else if (message.document) {
      mediaFileId = message.document.file_id;
      mediaType = "file";
      mimeType = message.document.mime_type;
    }

    // Download media if present
    if (mediaFileId && mediaType && this.bot) {
      try {
        const file = await this.bot.api.getFile(mediaFileId);
        const ext = getExtension(mediaType, mimeType);

        const mediaDir = join(homedir(), ".robun", "media");
        await mkdir(mediaDir, { recursive: true });

        const filePath = join(mediaDir, `${mediaFileId.slice(0, 16)}${ext}`);

        // Download file via grammy file URL
        const fileUrl = `https://api.telegram.org/file/bot${(this.config as TelegramConfig).token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        if (resp.ok) {
          const buffer = await resp.arrayBuffer();
          await writeFile(filePath, Buffer.from(buffer));
          mediaPaths.push(filePath);

          // Handle voice/audio transcription
          if (mediaType === "voice" || mediaType === "audio") {
            const transcriber = new GroqTranscriptionProvider(this.groqApiKey);
            const transcription = await transcriber.transcribe(filePath);
            if (transcription) {
              logger.info(`Transcribed ${mediaType}: ${transcription.slice(0, 50)}...`);
              contentParts.push(`[transcription: ${transcription}]`);
            } else {
              contentParts.push(`[${mediaType}: ${filePath}]`);
            }
          } else {
            contentParts.push(`[${mediaType}: ${filePath}]`);
          }

          logger.debug(`Downloaded ${mediaType} to ${filePath}`);
        } else {
          contentParts.push(`[${mediaType}: download failed]`);
        }
      } catch (e) {
        logger.error({ err: e }, "Failed to download media");
        contentParts.push(`[${mediaType}: download failed]`);
      }
    }

    const content = contentParts.length > 0 ? contentParts.join("\n") : "[empty message]";
    logger.debug(`Telegram message from ${sid}: ${content.slice(0, 50)}...`);

    // Start typing indicator before processing
    this.startTyping(chatId);

    // Forward to the message bus
    await this.handleMessage(sid, chatId, content, mediaPaths, {
      message_id: message.message_id,
      user_id: user.id,
      username: user.username ?? null,
      first_name: user.first_name,
      is_group: message.chat.type !== "private",
    });
  }

  // ---- Typing indicators --------------------------------------------------

  private startTyping(chatId: string): void {
    this.stopTyping(chatId);

    const numericId = Number(chatId);
    if (Number.isNaN(numericId)) return;

    // Send immediately, then every 4 seconds
    const sendAction = () => {
      if (!this.bot) return;
      this.bot.api.sendChatAction(numericId, "typing").catch((err) => {
        logger.debug({ err }, `Typing indicator stopped for ${chatId}`);
      });
    };

    sendAction();
    const timer = setInterval(sendAction, 4000);
    this.typingTimers.set(chatId, timer);
  }

  private stopTyping(chatId: string): void {
    const timer = this.typingTimers.get(chatId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
  }

  // ---- Utilities ----------------------------------------------------------

  private senderId(user: { id: number; username?: string }): string {
    const sid = String(user.id);
    return user.username ? `${sid}|${user.username}` : sid;
  }
}
