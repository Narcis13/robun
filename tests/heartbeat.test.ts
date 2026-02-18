import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { HeartbeatService } from "../src/heartbeat/service";

const TEST_DIR = resolve("/tmp/robun-test-heartbeat");

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("HeartbeatService", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("heartbeatFile points to HEARTBEAT.md in workspace", () => {
    const svc = new HeartbeatService({ workspace: TEST_DIR });
    expect(svc.heartbeatFile).toBe(join(TEST_DIR, "HEARTBEAT.md"));
  });

  test("triggerNow returns null when no callback", async () => {
    const svc = new HeartbeatService({ workspace: TEST_DIR });
    expect(await svc.triggerNow()).toBeNull();
  });

  test("triggerNow calls onHeartbeat callback", async () => {
    let received = "";
    const svc = new HeartbeatService({
      workspace: TEST_DIR,
      onHeartbeat: async (prompt) => {
        received = prompt;
        return "HEARTBEAT_OK";
      },
    });

    const result = await svc.triggerNow();
    expect(result).toBe("HEARTBEAT_OK");
    expect(received).toContain("HEARTBEAT.md");
  });

  test("start does nothing when disabled", async () => {
    const svc = new HeartbeatService({
      workspace: TEST_DIR,
      enabled: false,
    });
    await svc.start();
    // Should not throw, just returns
    svc.stop();
  });

  test("start and stop work cleanly", async () => {
    const svc = new HeartbeatService({
      workspace: TEST_DIR,
      intervalS: 3600, // long interval, won't fire during test
    });
    await svc.start();
    svc.stop();
    // Double stop is safe
    svc.stop();
  });

  test("empty HEARTBEAT.md skips callback", async () => {
    writeFileSync(join(TEST_DIR, "HEARTBEAT.md"), "# Heartbeat\n\n");

    let called = false;
    const svc = new HeartbeatService({
      workspace: TEST_DIR,
      onHeartbeat: async () => {
        called = true;
        return "done";
      },
      intervalS: 0.01, // very short for test
    });

    await svc.start();
    // Wait for tick to fire
    await new Promise((r) => setTimeout(r, 50));
    svc.stop();

    expect(called).toBe(false);
  });

  test("non-empty HEARTBEAT.md triggers callback", async () => {
    writeFileSync(join(TEST_DIR, "HEARTBEAT.md"), "# Tasks\n\n- [ ] Deploy v2\n");

    let called = false;
    const svc = new HeartbeatService({
      workspace: TEST_DIR,
      onHeartbeat: async () => {
        called = true;
        return "HEARTBEAT_OK";
      },
      intervalS: 0.01,
    });

    await svc.start();
    await new Promise((r) => setTimeout(r, 50));
    svc.stop();

    expect(called).toBe(true);
  });

  test("missing HEARTBEAT.md skips callback", async () => {
    // No HEARTBEAT.md file created

    let called = false;
    const svc = new HeartbeatService({
      workspace: TEST_DIR,
      onHeartbeat: async () => {
        called = true;
        return "done";
      },
      intervalS: 0.01,
    });

    await svc.start();
    await new Promise((r) => setTimeout(r, 50));
    svc.stop();

    expect(called).toBe(false);
  });
});
