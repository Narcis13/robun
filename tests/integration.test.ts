import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CronService } from "../src/cron/service";
import { HeartbeatService } from "../src/heartbeat/service";
import { MessageBus } from "../src/bus/queue";
import type { InboundMessage } from "../src/bus/events";

const TEST_DIR = resolve("/tmp/robun-test-integration");

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("Integration: CronService + HeartbeatService", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("cron job posts through message bus", async () => {
    const bus = new MessageBus();
    const cronStore = join(TEST_DIR, "cron.json");
    const received: string[] = [];

    const cron = new CronService(cronStore, async (job) => {
      const msg: InboundMessage = {
        channel: job.payload.channel ?? "cron",
        chatId: job.payload.to ?? "system",
        userId: "cron",
        text: job.payload.message,
        replyTo: null,
        attachments: [],
        raw: {},
      };
      await bus.publishInbound(msg);
      received.push(job.payload.message);
      return "delivered";
    });

    const job = cron.addJob({
      name: "integration-test",
      schedule: { kind: "every", atMs: null, everyMs: 60000, expr: null, tz: null },
      message: "Integration test message",
      deliver: true,
      channel: "test",
      to: "user1",
    });

    await cron.runJob(job.id);

    expect(received).toEqual(["Integration test message"]);

    // Verify bus received the message
    const busMsg = await bus.consumeInbound(100);
    expect(busMsg?.text).toBe("Integration test message");
    expect(busMsg?.channel).toBe("test");

    cron.stop();
  });

  test("heartbeat triggers cron-like agent action", async () => {
    writeFileSync(join(TEST_DIR, "HEARTBEAT.md"), "# Tasks\n\n- [ ] Check logs\n");

    const actions: string[] = [];

    const heartbeat = new HeartbeatService({
      workspace: TEST_DIR,
      onHeartbeat: async (prompt) => {
        actions.push("heartbeat-fired");
        return "HEARTBEAT_OK";
      },
      intervalS: 0.01,
    });

    await heartbeat.start();
    await new Promise((r) => setTimeout(r, 50));
    heartbeat.stop();

    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]).toBe("heartbeat-fired");
  });

  test("skills directory contains expected builtin skills", () => {
    const skillsDir = resolve(__dirname, "../src/skills");
    expect(existsSync(skillsDir)).toBe(true);

    const skills = readdirSync(skillsDir).filter(
      (name) => existsSync(join(skillsDir, name, "SKILL.md")),
    );

    expect(skills.length).toBeGreaterThanOrEqual(6);
    expect(skills).toContain("cron");
    expect(skills).toContain("github");
    expect(skills).toContain("memory");
    expect(skills).toContain("tmux");
    expect(skills).toContain("weather");
    expect(skills).toContain("summarize");
  });
});
