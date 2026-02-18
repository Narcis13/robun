import { z } from "zod";
import type { Tool } from "./base";
import type { OutboundMessage } from "../bus/events";

type SendCallback = (msg: OutboundMessage) => Promise<void>;

export class MessageTool implements Tool {
  readonly name = "message";
  readonly description = "Send a message to a user or channel.";
  readonly parameters = z.object({
    content: z.string().describe("Message content to send"),
    channel: z.string().optional().describe("Target channel"),
    chatId: z.string().optional().describe("Target chat ID"),
  });

  private sendCallback: SendCallback | null;
  private defaultChannel: string;
  private defaultChatId: string;

  constructor(sendCallback?: SendCallback) {
    this.sendCallback = sendCallback ?? null;
    this.defaultChannel = "";
    this.defaultChatId = "";
  }

  setSendCallback(callback: SendCallback): void {
    this.sendCallback = callback;
  }

  setContext(channel: string, chatId: string): void {
    this.defaultChannel = channel;
    this.defaultChatId = chatId;
  }

  async execute(params: {
    content: string;
    channel?: string;
    chatId?: string;
  }): Promise<string> {
    const channel = params.channel ?? this.defaultChannel;
    const chatId = params.chatId ?? this.defaultChatId;

    if (!channel || !chatId) {
      return "Error: No target channel/chat specified.";
    }
    if (!this.sendCallback) {
      return "Error: Message sending not configured.";
    }

    try {
      await this.sendCallback({
        channel,
        chatId,
        content: params.content,
        replyTo: null,
        media: [],
        metadata: {},
      });
      return `Message sent to ${channel}:${chatId}`;
    } catch (err) {
      return `Error sending message: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
