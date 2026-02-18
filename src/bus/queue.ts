import type { InboundMessage, OutboundMessage } from "./events";
import pino from "pino";

const log = pino({ name: "bus" });

type OutboundSubscriber = (msg: OutboundMessage) => Promise<void>;

export class MessageBus {
  private inboundQueue: InboundMessage[] = [];
  private outboundQueue: OutboundMessage[] = [];
  private inboundWaiters: Array<(msg: InboundMessage) => void> = [];
  private outboundSubscribers = new Map<string, OutboundSubscriber[]>();
  private running = true;

  async publishInbound(msg: InboundMessage): Promise<void> {
    if (this.inboundWaiters.length > 0) {
      const waiter = this.inboundWaiters.shift()!;
      waiter(msg);
    } else {
      this.inboundQueue.push(msg);
    }
  }

  async consumeInbound(timeoutMs = 1000): Promise<InboundMessage> {
    if (this.inboundQueue.length > 0) {
      return this.inboundQueue.shift()!;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.inboundWaiters.indexOf(wrappedResolve);
        if (idx >= 0) this.inboundWaiters.splice(idx, 1);
        reject(new Error("timeout"));
      }, timeoutMs);

      const wrappedResolve = (msg: InboundMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.inboundWaiters.push(wrappedResolve);
    });
  }

  async publishOutbound(msg: OutboundMessage): Promise<void> {
    this.outboundQueue.push(msg);
  }

  subscribeOutbound(channel: string, callback: OutboundSubscriber): void {
    const existing = this.outboundSubscribers.get(channel) ?? [];
    existing.push(callback);
    this.outboundSubscribers.set(channel, existing);
  }

  async dispatchOutbound(): Promise<void> {
    while (this.running) {
      if (this.outboundQueue.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const msg = this.outboundQueue.shift()!;
      const subscribers = this.outboundSubscribers.get(msg.channel) ?? [];
      for (const cb of subscribers) {
        try {
          await cb(msg);
        } catch (err) {
          log.error({ err, channel: msg.channel }, "outbound dispatch error");
        }
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  get inboundSize(): number {
    return this.inboundQueue.length;
  }

  get outboundSize(): number {
    return this.outboundQueue.length;
  }
}
