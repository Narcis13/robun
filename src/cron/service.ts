import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import { CronStoreSchema, type CronJob, type CronSchedule, type CronStore } from "./types";

const logger = pino({ name: "cron" });

function nowMs(): number {
  return Date.now();
}

function computeNextRun(schedule: CronSchedule, now: number): number | null {
  if (schedule.kind === "at") {
    return schedule.atMs && schedule.atMs > now ? schedule.atMs : null;
  }
  if (schedule.kind === "every") {
    return schedule.everyMs && schedule.everyMs > 0 ? now + schedule.everyMs : null;
  }
  if (schedule.kind === "cron" && schedule.expr) {
    try {
      // Dynamic import to avoid top-level require
      const CronParser = require("cron-parser");
      const interval = CronParser.parseExpression(schedule.expr, {
        tz: schedule.tz ?? undefined,
      });
      return interval.next().getTime();
    } catch {
      return null;
    }
  }
  return null;
}

export class CronService {
  private storePath: string;
  private store: CronStore | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  onJob: ((job: CronJob) => Promise<string | null>) | null = null;

  constructor(storePath: string, onJob?: (job: CronJob) => Promise<string | null>) {
    this.storePath = storePath;
    this.onJob = onJob ?? null;
  }

  private loadStore(): CronStore {
    if (this.store) return this.store;

    if (existsSync(this.storePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.storePath, "utf-8"));
        this.store = CronStoreSchema.parse(raw);
      } catch (e) {
        logger.warn({ err: e }, "Failed to load cron store");
        this.store = CronStoreSchema.parse({});
      }
    } else {
      this.store = CronStoreSchema.parse({});
    }

    return this.store;
  }

  private saveStore(): void {
    if (!this.store) return;

    mkdirSync(dirname(this.storePath), { recursive: true });

    const data = {
      version: this.store.version,
      jobs: this.store.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        schedule: {
          kind: j.schedule.kind,
          atMs: j.schedule.atMs,
          everyMs: j.schedule.everyMs,
          expr: j.schedule.expr,
          tz: j.schedule.tz,
        },
        payload: {
          kind: j.payload.kind,
          message: j.payload.message,
          deliver: j.payload.deliver,
          channel: j.payload.channel,
          to: j.payload.to,
        },
        state: {
          nextRunAtMs: j.state.nextRunAtMs,
          lastRunAtMs: j.state.lastRunAtMs,
          lastStatus: j.state.lastStatus,
          lastError: j.state.lastError,
        },
        createdAtMs: j.createdAtMs,
        updatedAtMs: j.updatedAtMs,
        deleteAfterRun: j.deleteAfterRun,
      })),
    };

    writeFileSync(this.storePath, JSON.stringify(data, null, 2));
  }

  async start(): Promise<void> {
    this.running = true;
    this.loadStore();
    this.recomputeNextRuns();
    this.saveStore();
    this.armTimer();
    logger.info({ jobCount: this.store?.jobs.length ?? 0 }, "Cron service started");
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private recomputeNextRuns(): void {
    if (!this.store) return;
    const now = nowMs();
    for (const job of this.store.jobs) {
      if (job.enabled) {
        job.state.nextRunAtMs = computeNextRun(job.schedule, now);
      }
    }
  }

  private getNextWakeMs(): number | null {
    if (!this.store) return null;
    const times = this.store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs != null)
      .map((j) => j.state.nextRunAtMs!);
    return times.length > 0 ? Math.min(...times) : null;
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextWake = this.getNextWakeMs();
    if (!nextWake || !this.running) return;

    const delayMs = Math.max(0, nextWake - nowMs());
    this.timer = setTimeout(() => this.onTimer(), delayMs);
  }

  private async onTimer(): Promise<void> {
    if (!this.store) return;

    const now = nowMs();
    const dueJobs = this.store.jobs.filter(
      (j) => j.enabled && j.state.nextRunAtMs != null && now >= j.state.nextRunAtMs!,
    );

    for (const job of dueJobs) {
      await this.executeJob(job);
    }

    this.saveStore();
    this.armTimer();
  }

  private async executeJob(job: CronJob): Promise<void> {
    const startMs = nowMs();
    logger.info({ jobName: job.name, jobId: job.id }, "Executing cron job");

    try {
      if (this.onJob) {
        await this.onJob(job);
      }
      job.state.lastStatus = "ok";
      job.state.lastError = null;
      logger.info({ jobName: job.name }, "Cron job completed");
    } catch (e) {
      job.state.lastStatus = "error";
      job.state.lastError = String(e);
      logger.error({ jobName: job.name, err: e }, "Cron job failed");
    }

    job.state.lastRunAtMs = startMs;
    job.updatedAtMs = nowMs();

    // Handle one-shot jobs
    if (job.schedule.kind === "at") {
      if (job.deleteAfterRun) {
        this.store!.jobs = this.store!.jobs.filter((j) => j.id !== job.id);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = null;
      }
    } else {
      job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs());
    }
  }

  // ========== Public API ==========

  listJobs(includeDisabled = false): CronJob[] {
    const store = this.loadStore();
    const jobs = includeDisabled ? store.jobs : store.jobs.filter((j) => j.enabled);
    return jobs.sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  addJob(options: {
    name: string;
    schedule: CronSchedule;
    message: string;
    deliver?: boolean;
    channel?: string | null;
    to?: string | null;
    deleteAfterRun?: boolean;
  }): CronJob {
    const store = this.loadStore();
    const now = nowMs();

    const job: CronJob = {
      id: crypto.randomUUID().slice(0, 8),
      name: options.name,
      enabled: true,
      schedule: options.schedule,
      payload: {
        kind: "agent_turn",
        message: options.message,
        deliver: options.deliver ?? false,
        channel: options.channel ?? null,
        to: options.to ?? null,
      },
      state: {
        nextRunAtMs: computeNextRun(options.schedule, now),
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
      },
      createdAtMs: now,
      updatedAtMs: now,
      deleteAfterRun: options.deleteAfterRun ?? false,
    };

    store.jobs.push(job);
    this.saveStore();
    this.armTimer();

    logger.info({ jobName: options.name, jobId: job.id }, "Added cron job");
    return job;
  }

  removeJob(jobId: string): boolean {
    const store = this.loadStore();
    const before = store.jobs.length;
    store.jobs = store.jobs.filter((j) => j.id !== jobId);
    const removed = store.jobs.length < before;

    if (removed) {
      this.saveStore();
      this.armTimer();
      logger.info({ jobId }, "Removed cron job");
    }

    return removed;
  }

  enableJob(jobId: string, enabled = true): CronJob | null {
    const store = this.loadStore();
    for (const job of store.jobs) {
      if (job.id === jobId) {
        job.enabled = enabled;
        job.updatedAtMs = nowMs();
        if (enabled) {
          job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs());
        } else {
          job.state.nextRunAtMs = null;
        }
        this.saveStore();
        this.armTimer();
        return job;
      }
    }
    return null;
  }

  async runJob(jobId: string, force = false): Promise<boolean> {
    const store = this.loadStore();
    for (const job of store.jobs) {
      if (job.id === jobId) {
        if (!force && !job.enabled) return false;
        await this.executeJob(job);
        this.saveStore();
        this.armTimer();
        return true;
      }
    }
    return false;
  }

  status(): { enabled: boolean; jobs: number; nextWakeAtMs: number | null } {
    const store = this.loadStore();
    return {
      enabled: this.running,
      jobs: store.jobs.length,
      nextWakeAtMs: this.getNextWakeMs(),
    };
  }
}
