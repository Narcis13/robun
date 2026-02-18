import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

const logger = pino({ name: "heartbeat" });

const DEFAULT_INTERVAL_S = 30 * 60; // 30 minutes

const HEARTBEAT_PROMPT = `Read HEARTBEAT.md in your workspace (if it exists).
Follow any instructions or tasks listed there.
If nothing needs attention, reply with just: HEARTBEAT_OK`;

const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";

function isHeartbeatEmpty(content: string | null): boolean {
  if (!content) return true;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("<!--")) continue;
    // Checkboxes are actionable content
    if (/^[-*] \[[ x]\]/.test(trimmed)) return false;
    if (trimmed.length > 0) return false;
  }

  return true;
}

export class HeartbeatService {
  private workspace: string;
  private onHeartbeat: ((prompt: string) => Promise<string>) | null;
  private intervalS: number;
  private enabled: boolean;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    workspace: string;
    onHeartbeat?: (prompt: string) => Promise<string>;
    intervalS?: number;
    enabled?: boolean;
  }) {
    this.workspace = options.workspace;
    this.onHeartbeat = options.onHeartbeat ?? null;
    this.intervalS = options.intervalS ?? DEFAULT_INTERVAL_S;
    this.enabled = options.enabled ?? true;
  }

  get heartbeatFile(): string {
    return join(this.workspace, "HEARTBEAT.md");
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info("Heartbeat disabled");
      return;
    }
    this.running = true;
    this.scheduleNext();
    logger.info({ intervalS: this.intervalS }, "Heartbeat started");
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.intervalS * 1000);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const content = this.readHeartbeatFile();

    if (isHeartbeatEmpty(content)) {
      logger.debug("Heartbeat: no tasks (HEARTBEAT.md empty)");
      this.scheduleNext();
      return;
    }

    logger.info("Heartbeat: checking for tasks...");

    if (this.onHeartbeat) {
      try {
        const response = await this.onHeartbeat(HEARTBEAT_PROMPT);

        // Check if agent said "nothing to do"
        if (response.toUpperCase().replace(/_/g, "").includes(HEARTBEAT_OK_TOKEN.replace(/_/g, ""))) {
          logger.info("Heartbeat: OK (no action needed)");
        } else {
          logger.info("Heartbeat: completed task");
        }
      } catch (e) {
        logger.error({ err: e }, "Heartbeat execution failed");
      }
    }

    this.scheduleNext();
  }

  private readHeartbeatFile(): string | null {
    if (!existsSync(this.heartbeatFile)) return null;
    try {
      return readFileSync(this.heartbeatFile, "utf-8");
    } catch {
      return null;
    }
  }

  async triggerNow(): Promise<string | null> {
    if (!this.onHeartbeat) return null;
    return this.onHeartbeat(HEARTBEAT_PROMPT);
  }
}
