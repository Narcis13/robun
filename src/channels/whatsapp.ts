/**
 * WhatsApp channel implementation using @whiskeysockets/baileys directly.
 *
 * Unlike the Python version which bridged to a separate Node.js process via
 * WebSocket, this TypeScript port integrates Baileys natively -- eliminating
 * the bridge entirely.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  getContentType,
  type WASocket,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { z } from "zod";

import type { OutboundMessage } from "../bus/events";
import type { MessageBus } from "../bus/queue";
import { BaseChannel } from "./base";
import type { WhatsAppConfigSchema } from "../config/schema";

type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;

const logger = pino({ name: "whatsapp" });

/** Pino logger configured to silence Baileys' verbose internal logging. */
const baileysLogger = pino({ name: "baileys", level: "warn" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial reconnect delay in milliseconds. */
const BASE_RECONNECT_DELAY_MS = 2_000;

/** Maximum reconnect delay in milliseconds (capped exponential backoff). */
const MAX_RECONNECT_DELAY_MS = 60_000;

/** Suffix used by WhatsApp for individual (non-group) JIDs. */
const INDIVIDUAL_JID_SUFFIX = "@s.whatsapp.net";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the user's home directory.
 */
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Extract the phone number from a WhatsApp JID.
 *
 * `5511999999999@s.whatsapp.net` -> `5511999999999`
 * `5511999999999:42@s.whatsapp.net` -> `5511999999999`
 */
function phoneFromJid(jid: string): string {
  const bare = jid.split("@")[0] ?? jid;
  // Some JIDs contain a device suffix after `:`
  return bare.split(":")[0];
}

/**
 * Determine the effective sender JID.
 *
 * In group messages the sender is in `key.participant`; in 1-on-1 chats
 * it is `key.remoteJid`.
 */
function effectiveSender(
  remoteJid: string | null | undefined,
  participant: string | null | undefined,
): string | null {
  // In groups, participant holds the actual sender JID
  if (participant) return participant;
  if (remoteJid && remoteJid.endsWith(INDIVIDUAL_JID_SUFFIX)) return remoteJid;
  return remoteJid ?? null;
}

// ---------------------------------------------------------------------------
// WhatsAppChannel
// ---------------------------------------------------------------------------

export class WhatsAppChannel extends BaseChannel {
  readonly name = "whatsapp" as const;

  protected declare config: WhatsAppConfig;
  private sock: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;

  /** Consecutive reconnect attempts (reset on successful open). */
  private reconnectAttempts = 0;

  /** Whether a reconnect loop is already scheduled. */
  private reconnecting = false;

  constructor(config: WhatsAppConfig, bus: MessageBus) {
    super(config, bus);
    this.config = config;
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.sock) {
      logger.info("Stopping WhatsApp connection...");
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore errors when ending the socket
      }
      try {
        this.sock.ws.close();
      } catch {
        // Ignore errors when closing the underlying WebSocket
      }
      this.sock = null;
    }

    this.saveCreds = null;
  }

  // ---- Outbound -----------------------------------------------------------

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.sock) {
      logger.warn("WhatsApp socket not connected, cannot send message");
      return;
    }

    const jid = msg.chatId;
    if (!jid) {
      logger.error("Missing chatId (JID) for outbound WhatsApp message");
      return;
    }

    try {
      await this.sock.sendMessage(jid, { text: msg.content });
    } catch (err) {
      logger.error({ err, jid }, "Error sending WhatsApp message");
    }
  }

  // ---- Connection ---------------------------------------------------------

  private async connect(): Promise<void> {
    const authDir = expandTilde(this.config.authDir);

    // Ensure the auth directory exists
    await mkdir(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    this.saveCreds = saveCreds;

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      printQRInTerminal: true,
    });

    // Persist credentials whenever they are updated
    this.sock.ev.on("creds.update", async () => {
      if (this.saveCreds) {
        await this.saveCreds();
      }
    });

    // Connection lifecycle events
    this.sock.ev.on("connection.update", (update) => {
      this.onConnectionUpdate(update);
    });

    // Inbound messages
    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      this.onMessagesUpsert(messages, type).catch((err) => {
        logger.error({ err }, "Error processing inbound WhatsApp messages");
      });
    });
  }

  // ---- Connection events --------------------------------------------------

  private onConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info(
        "WhatsApp QR code generated -- scan with your phone to authenticate. " +
          "The QR code has been printed to the terminal.",
      );
    }

    if (connection === "open") {
      logger.info("WhatsApp connection established");
      this.reconnectAttempts = 0;
      this.reconnecting = false;
    }

    if (connection === "close") {
      const boom = lastDisconnect?.error as Boom | undefined;
      const statusCode = boom?.output?.statusCode ?? 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && this.running) {
        logger.warn(
          { statusCode, reason: boom?.message },
          "WhatsApp connection closed, scheduling reconnect",
        );
        this.scheduleReconnect();
      } else {
        logger.info(
          "WhatsApp logged out or channel stopped -- not reconnecting",
        );
        this.sock = null;
      }
    }
  }

  // ---- Reconnect with exponential backoff ---------------------------------

  private scheduleReconnect(): void {
    if (this.reconnecting || !this.running) return;
    this.reconnecting = true;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;

    logger.info({ delayMs: delay, attempt: this.reconnectAttempts }, "Reconnecting to WhatsApp...");

    setTimeout(async () => {
      if (!this.running) {
        this.reconnecting = false;
        return;
      }

      try {
        // Clean up the old socket before creating a new one
        if (this.sock) {
          try {
            this.sock.end(undefined);
          } catch {
            // Ignore
          }
          this.sock = null;
        }

        await this.connect();
      } catch (err) {
        logger.error({ err }, "WhatsApp reconnect failed");
        this.reconnecting = false;
        // Try again
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ---- Inbound messages ---------------------------------------------------

  private async onMessagesUpsert(
    messages: any[],
    type: string,
  ): Promise<void> {
    // Only process new message notifications, not history syncs
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip messages sent by ourselves
      if (msg.key.fromMe) continue;

      // Skip messages without content
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid as string | undefined;
      if (!remoteJid) continue;

      const senderJid = effectiveSender(remoteJid, msg.key.participant);
      if (!senderJid) continue;

      const senderId = phoneFromJid(senderJid);
      const chatId = remoteJid; // Use full JID as chatId for replies

      // Extract text content
      const contentType = getContentType(msg.message);
      let textContent: string | null | undefined = null;

      if (contentType === "conversation") {
        textContent = msg.message.conversation;
      } else if (contentType === "extendedTextMessage") {
        textContent = msg.message.extendedTextMessage?.text;
      } else if (contentType === "imageMessage") {
        textContent = msg.message.imageMessage?.caption ?? "[image]";
      } else if (contentType === "videoMessage") {
        textContent = msg.message.videoMessage?.caption ?? "[video]";
      } else if (contentType === "documentMessage") {
        textContent = msg.message.documentMessage?.caption ?? "[document]";
      } else if (contentType === "audioMessage") {
        // Voice messages (PTT = push-to-talk) and regular audio messages
        // The `ptt` flag distinguishes voice notes from audio files
        // Transcription not available in this channel -- log and forward a placeholder
        const isPtt = msg.message.audioMessage?.ptt === true;
        logger.info(
          { sender: senderId, chatId, isPtt },
          "Received voice/audio message (transcription not available)",
        );
        textContent = isPtt
          ? "[voice message: transcription not available]"
          : "[audio message]";
      } else if (contentType === "stickerMessage") {
        textContent = "[sticker]";
      } else if (contentType === "contactMessage") {
        textContent = "[contact]";
      } else if (contentType === "locationMessage") {
        const loc = msg.message.locationMessage;
        textContent = loc
          ? `[location: ${loc.degreesLatitude}, ${loc.degreesLongitude}]`
          : "[location]";
      } else if (contentType === "reactionMessage") {
        // Reactions are not chat messages -- skip them
        continue;
      } else {
        textContent = `[unsupported message type: ${contentType ?? "unknown"}]`;
      }

      const content = textContent ?? "[empty message]";

      const isGroup = remoteJid.endsWith("@g.us");
      const metadata: Record<string, unknown> = {
        messageId: msg.key.id ?? null,
        isGroup,
        participant: msg.key.participant ?? null,
        pushName: msg.pushName ?? null,
      };

      logger.debug(
        { sender: senderId, chatId, contentPreview: content.slice(0, 80) },
        "WhatsApp inbound message",
      );

      await this.handleMessage(senderId, chatId, content, undefined, metadata);
    }
  }
}
