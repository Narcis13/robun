import { z } from "zod";

export const InboundMessageSchema = z.object({
  channel: z.string(),
  senderId: z.string(),
  chatId: z.string(),
  content: z.string(),
  timestamp: z.date().default(() => new Date()),
  media: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export function sessionKey(msg: InboundMessage): string {
  return `${msg.channel}:${msg.chatId}`;
}

export const OutboundMessageSchema = z.object({
  channel: z.string(),
  chatId: z.string(),
  content: z.string(),
  replyTo: z.string().nullable().default(null),
  media: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
