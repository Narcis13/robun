import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CronService } from "../src/cron/service";

const TEST_DIR = resolve("/tmp/robun-test-cron");
const STORE_PATH = join(TEST_DIR, "cron-store.json");

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("CronService", () => {
  let service: CronService;

  beforeEach(() => {
    cleanup();
    service = new CronService(STORE_PATH);
  });

  afterEach(() => {
    service.stop();
    cleanup();
  });

  test("starts with empty store", () => {
    const status = service.status();
    expect(status.enabled).toBe(false);
    expect(status.jobs).toBe(0);
    expect(status.nextWakeAtMs).toBeNull();
  });

  test("addJob creates a job and persists to disk", () => {
    const job = service.addJob({
      name: "test-reminder",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Hello!",
      deliver: true,
      channel: "telegram",
      to: "user123",
    });

    expect(job.id).toHaveLength(8);
    expect(job.name).toBe("test-reminder");
    expect(job.enabled).toBe(true);
    expect(job.payload.message).toBe("Hello!");
    expect(job.payload.channel).toBe("telegram");
    expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now() - 1000);

    // Verify persistence
    expect(existsSync(STORE_PATH)).toBe(true);
    const stored = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    expect(stored.jobs).toHaveLength(1);
    expect(stored.jobs[0].id).toBe(job.id);
  });

  test("listJobs returns enabled jobs sorted by nextRunAtMs", () => {
    service.addJob({
      name: "later",
      schedule: { kind: "every", atMs: null, everyMs: 120000, expr: null, tz: null },
      message: "Later",
    });
    service.addJob({
      name: "sooner",
      schedule: { kind: "every", atMs: null, everyMs: 30000, expr: null, tz: null },
      message: "Sooner",
    });

    const jobs = service.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe("sooner");
    expect(jobs[1].name).toBe("later");
  });

  test("removeJob deletes a job", () => {
    const job = service.addJob({
      name: "to-remove",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Remove me",
    });

    expect(service.listJobs()).toHaveLength(1);
    const removed = service.removeJob(job.id);
    expect(removed).toBe(true);
    expect(service.listJobs()).toHaveLength(0);
  });

  test("removeJob returns false for unknown id", () => {
    expect(service.removeJob("nonexistent")).toBe(false);
  });

  test("enableJob disables and re-enables", () => {
    const job = service.addJob({
      name: "toggle",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Toggle",
    });

    const disabled = service.enableJob(job.id, false);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.state.nextRunAtMs).toBeNull();
    expect(service.listJobs()).toHaveLength(0); // disabled hidden by default

    const enabled = service.enableJob(job.id, true);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.state.nextRunAtMs).toBeGreaterThan(0);
    expect(service.listJobs()).toHaveLength(1);
  });

  test("enableJob returns null for unknown id", () => {
    expect(service.enableJob("nonexistent")).toBeNull();
  });

  test("listJobs with includeDisabled shows all", () => {
    const job = service.addJob({
      name: "hidden",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Hidden",
    });
    service.enableJob(job.id, false);

    expect(service.listJobs(false)).toHaveLength(0);
    expect(service.listJobs(true)).toHaveLength(1);
  });

  test("runJob executes job callback", async () => {
    const results: string[] = [];
    service.onJob = async (job) => {
      results.push(job.payload.message);
      return "done";
    };

    const job = service.addJob({
      name: "run-me",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Manual run",
    });

    const ran = await service.runJob(job.id);
    expect(ran).toBe(true);
    expect(results).toEqual(["Manual run"]);
  });

  test("runJob skips disabled job unless forced", async () => {
    const job = service.addJob({
      name: "disabled",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Skip",
    });
    service.enableJob(job.id, false);

    expect(await service.runJob(job.id)).toBe(false);
    expect(await service.runJob(job.id, true)).toBe(true);
  });

  test("at-schedule job disables after execution", async () => {
    service.onJob = async () => null;

    const futureMs = Date.now() + 999999;
    const job = service.addJob({
      name: "one-shot",
      schedule: { kind: "at", atMs: futureMs, everyMs: null, expr: null, tz: null },
      message: "Once",
      deleteAfterRun: false,
    });

    await service.runJob(job.id, true);
    const jobs = service.listJobs(true);
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.lastStatus).toBe("ok");
  });

  test("at-schedule job with deleteAfterRun removes itself", async () => {
    service.onJob = async () => null;

    const futureMs = Date.now() + 999999;
    const job = service.addJob({
      name: "delete-after",
      schedule: { kind: "at", atMs: futureMs, everyMs: null, expr: null, tz: null },
      message: "Delete",
      deleteAfterRun: true,
    });

    await service.runJob(job.id, true);
    expect(service.listJobs(true)).toHaveLength(0);
  });

  test("start and status reflect running state", async () => {
    service.addJob({
      name: "bg",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Background",
    });

    await service.start();
    const status = service.status();
    expect(status.enabled).toBe(true);
    expect(status.jobs).toBe(1);
    expect(status.nextWakeAtMs).toBeGreaterThan(0);

    service.stop();
    expect(service.status().enabled).toBe(false);
  });

  test("store persistence across instances", () => {
    service.addJob({
      name: "persist",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Persisted",
    });

    // Create new instance from same store file
    const service2 = new CronService(STORE_PATH);
    const jobs = service2.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("persist");
  });

  test("job execution records error on failure", async () => {
    service.onJob = async () => {
      throw new Error("test failure");
    };

    const job = service.addJob({
      name: "fail",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Fail",
    });

    await service.runJob(job.id);
    const jobs = service.listJobs(true);
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.state.lastStatus).toBe("error");
    expect(updated?.state.lastError).toContain("test failure");
  });
});
