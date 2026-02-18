import { z } from "zod";

export const CronScheduleSchema = z.object({
  kind: z.enum(["at", "every", "cron"]),
  atMs: z.number().nullable().default(null),
  everyMs: z.number().nullable().default(null),
  expr: z.string().nullable().default(null),
  tz: z.string().nullable().default(null),
});
export type CronSchedule = z.infer<typeof CronScheduleSchema>;

export const CronPayloadSchema = z.object({
  kind: z.enum(["system_event", "agent_turn"]).default("agent_turn"),
  message: z.string().default(""),
  deliver: z.boolean().default(false),
  channel: z.string().nullable().default(null),
  to: z.string().nullable().default(null),
});
export type CronPayload = z.infer<typeof CronPayloadSchema>;

export const CronJobStateSchema = z.object({
  nextRunAtMs: z.number().nullable().default(null),
  lastRunAtMs: z.number().nullable().default(null),
  lastStatus: z.enum(["ok", "error", "skipped"]).nullable().default(null),
  lastError: z.string().nullable().default(null),
});
export type CronJobState = z.infer<typeof CronJobStateSchema>;

export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  schedule: CronScheduleSchema,
  payload: CronPayloadSchema,
  state: CronJobStateSchema,
  createdAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
  deleteAfterRun: z.boolean().default(false),
});
export type CronJob = z.infer<typeof CronJobSchema>;

export const CronStoreSchema = z.object({
  version: z.number().default(1),
  jobs: z.array(CronJobSchema).default([]),
});
export type CronStore = z.infer<typeof CronStoreSchema>;
