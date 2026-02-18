import { z } from "zod";
import type { Tool } from "./base";
import type { CronSchedule } from "../cron/types";
import type { CronService } from "../cron/service";

export class CronTool implements Tool {
  readonly name = "cron";
  readonly description = "Manage scheduled tasks (add, list, remove).";
  readonly parameters = z.object({
    action: z.enum(["add", "list", "remove"]).describe("Action to perform"),
    message: z.string().optional().describe("Reminder message (for add)"),
    everySeconds: z
      .number()
      .optional()
      .describe("Interval in seconds (recurring)"),
    cronExpr: z.string().optional().describe("Cron expression (scheduled)"),
    at: z.string().optional().describe("ISO datetime for one-time execution"),
    jobId: z.string().optional().describe("Job ID (for remove)"),
  });

  private service: CronService;
  private channel: string = "";
  private chatId: string = "";

  constructor(service: CronService) {
    this.service = service;
  }

  setContext(channel: string, chatId: string): void {
    this.channel = channel;
    this.chatId = chatId;
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const action = params.action as string;

    if (action === "list") {
      return this.listJobs();
    }
    if (action === "add") {
      return this.addJob(params);
    }
    if (action === "remove") {
      return this.removeJob(params.jobId as string | undefined);
    }

    return `Unknown action: ${action}`;
  }

  private listJobs(): string {
    const jobs = this.service.listJobs();
    if (jobs.length === 0) return "No scheduled jobs.";
    return jobs
      .map(
        (j) =>
          `- ${j.name} (id: ${j.id}, ${j.schedule.kind}, enabled=${j.enabled})`,
      )
      .join("\n");
  }

  private addJob(params: Record<string, unknown>): string {
    const message = params.message as string | undefined;
    if (!message) return "Error: message is required for add.";
    if (!this.channel || !this.chatId) {
      return "Error: no session context (channel/chatId).";
    }

    let schedule: CronSchedule;
    let deleteAfterRun = false;

    if (params.everySeconds) {
      schedule = {
        kind: "every",
        everyMs: (params.everySeconds as number) * 1000,
        atMs: null,
        expr: null,
        tz: null,
      };
    } else if (params.cronExpr) {
      schedule = {
        kind: "cron",
        expr: params.cronExpr as string,
        atMs: null,
        everyMs: null,
        tz: null,
      };
    } else if (params.at) {
      const atMs = new Date(params.at as string).getTime();
      schedule = { kind: "at", atMs, everyMs: null, expr: null, tz: null };
      deleteAfterRun = true;
    } else {
      return "Error: must specify everySeconds, cronExpr, or at.";
    }

    const job = this.service.addJob({
      name: message.slice(0, 50),
      schedule,
      message,
      deliver: true,
      channel: this.channel || undefined,
      to: this.chatId || undefined,
      deleteAfterRun,
    });
    return `Scheduled job '${job.name}' (${job.id})`;
  }

  private removeJob(jobId: string | undefined): string {
    if (!jobId) return "Error: jobId is required for remove.";
    return this.service.removeJob(jobId)
      ? `Removed job ${jobId}`
      : `Job ${jobId} not found.`;
  }
}
