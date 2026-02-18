import type { Config } from "../config/schema";
import type { MessageBus } from "../bus/queue";
import type { BaseChannel } from "./base";
import pino from "pino";

const logger = pino({ name: "channel-manager" });

interface ChannelEntry {
  name: string;
  module: string;
  exportName: string;
  config: unknown;
  extraArgs?: unknown[];
}

export class ChannelManager {
  private channels = new Map<string, BaseChannel>();
  private bus: MessageBus;

  private constructor(bus: MessageBus) {
    this.bus = bus;
  }

  static async create(config: Config, bus: MessageBus): Promise<ChannelManager> {
    const manager = new ChannelManager(bus);
    await manager.initChannels(config);
    return manager;
  }

  private async initChannels(config: Config): Promise<void> {
    const ch = config.channels;

    const entries: ChannelEntry[] = [
      { name: "telegram", module: "./telegram", exportName: "TelegramChannel", config: ch.telegram, extraArgs: [config.providers.groq.apiKey] },
      { name: "discord", module: "./discord", exportName: "DiscordChannel", config: ch.discord },
      { name: "whatsapp", module: "./whatsapp", exportName: "WhatsAppChannel", config: ch.whatsapp },
      { name: "slack", module: "./slack", exportName: "SlackChannel", config: ch.slack },
      { name: "email", module: "./email", exportName: "EmailChannel", config: ch.email },
      { name: "feishu", module: "./feishu", exportName: "FeishuChannel", config: ch.feishu },
      { name: "dingtalk", module: "./dingtalk", exportName: "DingTalkChannel", config: ch.dingtalk },
      { name: "mochat", module: "./mochat", exportName: "MochatChannel", config: ch.mochat },
      { name: "qq", module: "./qq", exportName: "QQChannel", config: ch.qq },
    ];

    const enabled = entries.filter(
      (e) => (e.config as { enabled: boolean }).enabled,
    );

    await Promise.all(
      enabled.map(async (entry) => {
        try {
          const mod = await import(entry.module);
          const Channel = mod[entry.exportName];
          const args = entry.extraArgs
            ? [entry.config, this.bus, ...entry.extraArgs]
            : [entry.config, this.bus];
          this.channels.set(entry.name, new Channel(...args));
          logger.info(`${entry.name} channel enabled`);
        } catch (e) {
          logger.warn(`${entry.name} channel not available: ${e}`);
        }
      }),
    );
  }

  async startAll(): Promise<void> {
    if (this.channels.size === 0) {
      logger.warn("No channels enabled");
      return;
    }

    // Subscribe outbound for each channel
    for (const [name, channel] of this.channels) {
      this.bus.subscribeOutbound(name, (msg) => channel.send(msg));
    }

    // Start outbound dispatcher (runs in background)
    this.bus.dispatchOutbound();

    // Start all channels in parallel
    const startPromises = Array.from(this.channels.entries()).map(
      async ([name, channel]) => {
        logger.info(`Starting ${name} channel...`);
        try {
          await channel.start();
        } catch (e) {
          logger.error(`Failed to start channel ${name}: ${e}`);
        }
      },
    );

    await Promise.all(startPromises);
  }

  async stopAll(): Promise<void> {
    logger.info("Stopping all channels...");
    this.bus.stop();

    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        logger.info(`Stopped ${name} channel`);
      } catch (e) {
        logger.error(`Error stopping ${name}: ${e}`);
      }
    }
  }

  getChannel(name: string): BaseChannel | undefined {
    return this.channels.get(name);
  }

  getStatus(): Record<string, { enabled: boolean; running: boolean }> {
    const status: Record<string, { enabled: boolean; running: boolean }> = {};
    for (const [name, channel] of this.channels) {
      status[name] = { enabled: true, running: channel.isRunning };
    }
    return status;
  }

  get enabledChannels(): string[] {
    return Array.from(this.channels.keys());
  }
}
