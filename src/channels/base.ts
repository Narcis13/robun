import type { MessageBus } from "../bus/queue";
import type { OutboundMessage } from "../bus/events";
import pino from "pino";

const logger = pino({ name: "channel" });

export abstract class BaseChannel {
  abstract readonly name: string;

  protected config: any;
  protected bus: MessageBus;
  protected running = false;

  constructor(config: any, bus: MessageBus) {
    this.config = config;
    this.bus = bus;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(msg: OutboundMessage): Promise<void>;

  isAllowed(senderId: string): boolean {
    const allowList: string[] = this.config.allowFrom ?? [];
    if (allowList.length === 0) return true;

    const senderStr = String(senderId);
    if (allowList.includes(senderStr)) return true;

    if (senderStr.includes("|")) {
      for (const part of senderStr.split("|")) {
        if (part && allowList.includes(part)) return true;
      }
    }
    return false;
  }

  protected async handleMessage(
    senderId: string,
    chatId: string,
    content: string,
    media?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isAllowed(senderId)) {
      logger.warn(
        `Access denied for ${senderId} on ${this.name}. Add them to allowFrom list in config.`,
      );
      return;
    }

    await this.bus.publishInbound({
      channel: this.name,
      senderId: String(senderId),
      chatId: String(chatId),
      content,
      timestamp: new Date(),
      media: media ?? [],
      metadata: metadata ?? {},
    });
  }

  get isRunning(): boolean {
    return this.running;
  }
}
