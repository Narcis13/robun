/**
 * Email channel implementation using IMAP polling (imapflow) + SMTP replies (nodemailer).
 *
 * Inbound: Poll IMAP mailbox for unread messages, convert each into an inbound event.
 * Outbound: Send responses via SMTP back to the sender address.
 */

import { ImapFlow } from "imapflow";
import type { SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedMail, AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import pino from "pino";
import type { z } from "zod";

import type { OutboundMessage } from "../bus/events";
import type { MessageBus } from "../bus/queue";
import type { EmailConfigSchema } from "../config/schema";
import { BaseChannel } from "./base";

type EmailConfig = z.infer<typeof EmailConfigSchema>;

const logger = pino({ name: "email" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMAP_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Format a Date for IMAP search criteria: "DD-Mon-YYYY".
 * Uses English month abbreviations regardless of locale.
 */
function formatImapDate(value: Date): string {
  const day = String(value.getDate()).padStart(2, "0");
  const month = IMAP_MONTHS[value.getMonth()];
  const year = value.getFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Convert raw HTML to plain text.
 *
 * - <br> / <br/> -> newline
 * - </p> -> newline
 * - Strip remaining tags
 * - Unescape HTML entities
 */
function htmlToText(rawHtml: string): string {
  let text = rawHtml.replace(/<\s*br\s*\/?>/gi, "\n");
  text = text.replace(/<\s*\/\s*p\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  // Unescape HTML entities using a temporary DOM-like approach
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCharCode(Number.parseInt(dec, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&nbsp;/g, " ");
  return text;
}

/**
 * Extract the readable text body from a parsed email.
 * Prefers text/plain, falls back to text/html converted to plain text.
 */
function extractTextBody(parsed: ParsedMail): string {
  // simpleParser provides .text (plain) and .html (html) directly
  if (parsed.text) {
    return parsed.text.trim();
  }
  if (parsed.html) {
    return htmlToText(parsed.html).trim();
  }
  return "";
}

/**
 * Extract the first sender email address from a parsed mail's from field.
 */
function extractSenderAddress(from: AddressObject | AddressObject[] | undefined): string {
  if (!from) return "";
  const addrObj = Array.isArray(from) ? from[0] : from;
  if (!addrObj?.value?.length) return "";
  return (addrObj.value[0].address ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Parsed message shape returned by internal fetch methods
// ---------------------------------------------------------------------------

interface ParsedEmailItem {
  sender: string;
  subject: string;
  messageId: string;
  content: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EmailChannel
// ---------------------------------------------------------------------------

export class EmailChannel extends BaseChannel {
  readonly name = "email" as const;

  private lastSubjectByChat = new Map<string, string>();
  private lastMessageIdByChat = new Map<string, string>();
  private processedUids = new Set<string>();
  private readonly MAX_PROCESSED_UIDS = 100_000;

  constructor(config: EmailConfig, bus: MessageBus) {
    super(config, bus);
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    const cfg = this.config as EmailConfig;

    if (!cfg.consentGranted) {
      logger.warn(
        "Email channel disabled: consentGranted is false. " +
          "Set channels.email.consentGranted=true after explicit user permission.",
      );
      return;
    }

    if (!this.validateConfig()) {
      return;
    }

    this.running = true;
    logger.info("Starting Email channel (IMAP polling mode)...");

    const pollSeconds = Math.max(5, cfg.pollIntervalSeconds);

    while (this.running) {
      try {
        const items = await this.fetchNewMessages();
        for (const item of items) {
          if (item.subject) {
            this.lastSubjectByChat.set(item.sender, item.subject);
          }
          if (item.messageId) {
            this.lastMessageIdByChat.set(item.sender, item.messageId);
          }

          await this.handleMessage(
            item.sender,
            item.sender,
            item.content,
            undefined,
            item.metadata,
          );
        }
      } catch (err) {
        logger.error({ err }, "Email polling error");
      }

      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  // ---- Outbound -----------------------------------------------------------

  async send(msg: OutboundMessage): Promise<void> {
    const cfg = this.config as EmailConfig;

    if (!cfg.consentGranted) {
      logger.warn("Skip email send: consentGranted is false");
      return;
    }

    const forceSend = Boolean(msg.metadata?.force_send);
    if (!cfg.autoReplyEnabled && !forceSend) {
      logger.info("Skip automatic email reply: autoReplyEnabled is false");
      return;
    }

    if (!cfg.smtpHost) {
      logger.warn("Email channel SMTP host not configured");
      return;
    }

    const toAddr = msg.chatId.trim();
    if (!toAddr) {
      logger.warn("Email channel missing recipient address");
      return;
    }

    // Determine subject line
    let subject = this.replySubject(
      this.lastSubjectByChat.get(toAddr) ?? "robun reply",
    );
    if (
      msg.metadata &&
      typeof msg.metadata.subject === "string" &&
      msg.metadata.subject.trim()
    ) {
      subject = msg.metadata.subject.trim();
    }

    const fromAddr =
      cfg.fromAddress || cfg.smtpUsername || cfg.imapUsername;

    const inReplyTo = this.lastMessageIdByChat.get(toAddr);

    const mailOptions: nodemailer.SendMailOptions = {
      from: fromAddr,
      to: toAddr,
      subject,
      text: msg.content || "",
    };

    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = inReplyTo;
    }

    try {
      await this.smtpSend(mailOptions);
    } catch (err) {
      logger.error({ err, to: toAddr }, "Error sending email");
      throw err;
    }
  }

  // ---- Config validation --------------------------------------------------

  private validateConfig(): boolean {
    const cfg = this.config as EmailConfig;
    const missing: string[] = [];

    if (!cfg.imapHost) missing.push("imapHost");
    if (!cfg.imapUsername) missing.push("imapUsername");
    if (!cfg.imapPassword) missing.push("imapPassword");
    if (!cfg.smtpHost) missing.push("smtpHost");
    if (!cfg.smtpUsername) missing.push("smtpUsername");
    if (!cfg.smtpPassword) missing.push("smtpPassword");

    if (missing.length > 0) {
      logger.error(
        `Email channel not configured, missing: ${missing.join(", ")}`,
      );
      return false;
    }
    return true;
  }

  // ---- SMTP ---------------------------------------------------------------

  private async smtpSend(
    mailOptions: nodemailer.SendMailOptions,
  ): Promise<void> {
    const cfg = this.config as EmailConfig;

    const transportOptions: nodemailer.TransportOptions & {
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
      connectionTimeout: number;
      requireTLS?: boolean;
    } = {
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpUseSsl, // true for SSL (port 465), false otherwise
      auth: {
        user: cfg.smtpUsername,
        pass: cfg.smtpPassword,
      },
      connectionTimeout: 30_000,
    };

    // If not using implicit SSL and TLS is requested, use STARTTLS
    if (!cfg.smtpUseSsl && cfg.smtpUseTls) {
      transportOptions.requireTLS = true;
    }

    const transporter: Transporter = nodemailer.createTransport(
      transportOptions as any,
    );

    await transporter.sendMail(mailOptions);
  }

  // ---- IMAP fetch methods -------------------------------------------------

  private async fetchNewMessages(): Promise<ParsedEmailItem[]> {
    return this.fetchMessages(
      { seen: false },
      (this.config as EmailConfig).markSeen,
      true,
      0,
    );
  }

  /**
   * Fetch messages in [startDate, endDate) by IMAP date search.
   * Used for historical summarization tasks (e.g. "yesterday").
   */
  async fetchMessagesBetweenDates(
    startDate: Date,
    endDate: Date,
    limit = 20,
  ): Promise<ParsedEmailItem[]> {
    if (endDate <= startDate) {
      return [];
    }

    return this.fetchMessages(
      {
        since: formatImapDate(startDate),
        before: formatImapDate(endDate),
      },
      false,
      false,
      Math.max(1, limit),
    );
  }

  /**
   * Core IMAP fetch: connect, search, parse, and return structured results.
   */
  private async fetchMessages(
    searchCriteria: SearchObject,
    markSeen: boolean,
    dedupe: boolean,
    limit: number,
  ): Promise<ParsedEmailItem[]> {
    const cfg = this.config as EmailConfig;
    const mailbox = cfg.imapMailbox || "INBOX";
    const messages: ParsedEmailItem[] = [];

    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapUseSsl,
      auth: {
        user: cfg.imapUsername,
        pass: cfg.imapPassword,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);

      try {
        // Search for matching messages
        const uids = await client.search(searchCriteria, { uid: true });

        if (!uids || uids.length === 0) {
          return messages;
        }

        // Apply limit (take the most recent N, i.e. the last N UIDs)
        let targetUids = uids;
        if (limit > 0 && uids.length > limit) {
          targetUids = uids.slice(-limit);
        }

        // Fetch full message source + UID for each matching message
        for await (const msg of client.fetch(targetUids, {
          source: true,
          uid: true,
          flags: true,
        })) {
          const uidStr = String(msg.uid);

          // Dedup by UID
          if (dedupe && this.processedUids.has(uidStr)) {
            continue;
          }

          if (!msg.source) {
            continue;
          }

          // Parse the raw email source
          let parsed: ParsedMail;
          try {
            parsed = await simpleParser(msg.source);
          } catch (parseErr) {
            logger.warn({ err: parseErr, uid: uidStr }, "Failed to parse email");
            continue;
          }

          const sender = extractSenderAddress(parsed.from);
          if (!sender) {
            continue;
          }

          const subject = parsed.subject ?? "";
          const dateValue = parsed.date
            ? parsed.date.toUTCString()
            : "";
          const messageId = (parsed.messageId ?? "").trim();

          let body = extractTextBody(parsed);
          if (!body) {
            body = "(empty email body)";
          }

          // Truncate body to configured max
          body = body.slice(0, cfg.maxBodyChars);

          const content =
            `Email received.\n` +
            `From: ${sender}\n` +
            `Subject: ${subject}\n` +
            `Date: ${dateValue}\n\n` +
            body;

          const metadata: Record<string, unknown> = {
            message_id: messageId,
            subject,
            date: dateValue,
            sender_email: sender,
            uid: uidStr,
          };

          messages.push({
            sender,
            subject,
            messageId,
            content,
            metadata,
          });

          // Track UID for dedup
          if (dedupe) {
            this.processedUids.add(uidStr);
            // Cap the set to prevent unbounded growth
            if (this.processedUids.size > this.MAX_PROCESSED_UIDS) {
              this.processedUids.clear();
            }
          }

          // Mark as seen
          if (markSeen) {
            try {
              await client.messageFlagsAdd(msg.uid, ["\\Seen"], {
                uid: true,
              });
            } catch (flagErr) {
              logger.warn(
                { err: flagErr, uid: uidStr },
                "Failed to mark message as seen",
              );
            }
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.error({ err }, "IMAP fetch error");
    } finally {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
    }

    return messages;
  }

  // ---- Subject helpers ----------------------------------------------------

  private replySubject(baseSubject: string): string {
    const subject = (baseSubject || "").trim() || "robun reply";
    const prefix = (this.config as EmailConfig).subjectPrefix || "Re: ";
    if (subject.toLowerCase().startsWith("re:")) {
      return subject;
    }
    return `${prefix}${subject}`;
  }
}
