import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { z } from "zod";
import { safeFilename } from "../utils/helpers";
import { getSessionsPath } from "../utils/helpers";

export const SessionMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  timestamp: z.string().optional(),
  toolsUsed: z.array(z.string()).optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.unknown().optional(),
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

export class Session {
  key: string;
  messages: SessionMessage[] = [];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown> = {};
  lastConsolidated = 0;

  constructor(key: string) {
    this.key = key;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  addMessage(role: string, content: string, extra?: Record<string, unknown>): void {
    this.messages.push(
      SessionMessageSchema.parse({
        role,
        content,
        timestamp: new Date().toISOString(),
        ...extra,
      }),
    );
    this.updatedAt = new Date();
  }

  getHistory(maxMessages?: number): Array<{ role: string; content: string }> {
    const msgs = maxMessages ? this.messages.slice(-maxMessages) : this.messages;
    return msgs.map((m) => ({ role: m.role, content: m.content }));
  }

  clear(): void {
    this.messages = [];
    this.lastConsolidated = 0;
    this.updatedAt = new Date();
  }
}

export class SessionManager {
  private sessionsDir: string;
  private cache = new Map<string, Session>();

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? getSessionsPath();
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private getSessionPath(key: string): string {
    return join(this.sessionsDir, safeFilename(key) + ".jsonl");
  }

  getOrCreate(key: string): Session {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const loaded = this.load(key);
    if (loaded) {
      this.cache.set(key, loaded);
      return loaded;
    }

    const session = new Session(key);
    this.cache.set(key, session);
    return session;
  }

  private load(key: string): Session | null {
    const path = this.getSessionPath(key);
    if (!existsSync(path)) return null;

    const session = new Session(key);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed._type === "metadata") {
          session.createdAt = new Date(parsed.createdAt);
          session.updatedAt = new Date(parsed.updatedAt);
          session.metadata = parsed.metadata ?? {};
          session.lastConsolidated = parsed.lastConsolidated ?? 0;
        } else {
          session.messages.push(SessionMessageSchema.parse(parsed));
        }
      } catch {
        // Skip malformed lines
      }
    }
    return session;
  }

  save(session: Session): void {
    const path = this.getSessionPath(session.key);
    const lines: string[] = [];

    lines.push(
      JSON.stringify({
        _type: "metadata",
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        metadata: session.metadata,
        lastConsolidated: session.lastConsolidated,
      }),
    );

    for (const msg of session.messages) {
      lines.push(JSON.stringify(msg));
    }

    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  listSessions(): Array<{ key: string; messageCount: number; updatedAt: string }> {
    const results: Array<{ key: string; messageCount: number; updatedAt: string }> = [];
    if (!existsSync(this.sessionsDir)) return results;

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(this.sessionsDir, file);
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      let key = file.replace(".jsonl", "");
      let messageCount = 0;
      let updatedAt = statSync(path).mtime.toISOString();

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed._type === "metadata") {
            updatedAt = parsed.updatedAt ?? updatedAt;
          } else {
            messageCount++;
          }
        } catch {
          // skip
        }
      }

      results.push({ key, messageCount, updatedAt });
    }
    return results;
  }
}
