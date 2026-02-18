/**
 * Mochat channel implementation using Socket.IO with HTTP polling fallback.
 *
 * Supports:
 * - Socket.IO real-time events (with optional msgpack serialization)
 * - HTTP long-polling fallback when WebSocket is unavailable
 * - Session and panel subscriptions with auto-discovery
 * - Delayed message batching for non-mention replies
 * - Cursor-based session event tracking with persistence
 * - Mention detection and group-level mention requirements
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { z } from "zod";

import type { OutboundMessage } from "../bus/events";
import type { MessageBus } from "../bus/queue";
import type { MochatConfigSchema, MochatGroupRuleSchema } from "../config/schema";
import { getDataPath } from "../utils/helpers";
import { BaseChannel } from "./base";

type MochatConfig = z.infer<typeof MochatConfigSchema>;
type MochatGroupRule = z.infer<typeof MochatGroupRuleSchema>;

const logger = pino({ name: "mochat" });

let io: any;
try {
  io = require("socket.io-client");
} catch {
  io = null;
}

const MAX_SEEN_MESSAGE_IDS = 2000;
const CURSOR_SAVE_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface MochatBufferedEntry {
  rawBody: string;
  author: string;
  senderName: string;
  senderUsername: string;
  timestamp: number | null;
  messageId: string;
  groupId: string;
}

interface DelayState {
  entries: MochatBufferedEntry[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface MochatTarget {
  id: string;
  isPanel: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function safeDict(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strField(src: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function makeSyntheticEvent(
  messageId: string,
  author: string,
  content: unknown,
  meta: unknown,
  groupId: string,
  converseId: string,
  timestamp?: unknown,
  authorInfo?: unknown,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    messageId,
    author,
    content,
    meta: safeDict(meta),
    groupId,
    converseId,
  };
  if (authorInfo !== undefined) {
    payload.authorInfo = safeDict(authorInfo);
  }
  return {
    type: "message.add",
    timestamp: timestamp ?? new Date().toISOString(),
    payload,
  };
}

function normalizeMochatContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function resolveMochatTarget(raw: string): MochatTarget {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { id: "", isPanel: false };

  const lowered = trimmed.toLowerCase();
  let cleaned = trimmed;
  let forcedPanel = false;

  for (const prefix of ["mochat:", "group:", "channel:", "panel:"]) {
    if (lowered.startsWith(prefix)) {
      cleaned = trimmed.slice(prefix.length).trim();
      forcedPanel = ["group:", "channel:", "panel:"].includes(prefix);
      break;
    }
  }

  if (!cleaned) return { id: "", isPanel: false };
  return {
    id: cleaned,
    isPanel: forcedPanel || !cleaned.startsWith("session_"),
  };
}

function extractMentionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      ids.push(item.trim());
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      for (const key of ["id", "userId", "_id"]) {
        const candidate = obj[key];
        if (typeof candidate === "string" && candidate.trim()) {
          ids.push(candidate.trim());
          break;
        }
      }
    }
  }
  return ids;
}

function resolveWasMentioned(
  payload: Record<string, unknown>,
  agentUserId: string,
): boolean {
  const meta = payload.meta;
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    if (m.mentioned === true || m.wasMentioned === true) return true;
    for (const f of [
      "mentions",
      "mentionIds",
      "mentionedUserIds",
      "mentionedUsers",
    ]) {
      if (agentUserId && extractMentionIds(m[f]).includes(agentUserId)) {
        return true;
      }
    }
  }
  if (!agentUserId) return false;
  const content = payload.content;
  if (typeof content !== "string" || !content) return false;
  return content.includes(`<@${agentUserId}>`) || content.includes(`@${agentUserId}`);
}

function resolveRequireMention(
  config: MochatConfig,
  sessionId: string,
  groupId: string,
): boolean {
  const groups = config.groups ?? {};
  for (const key of [groupId, sessionId, "*"]) {
    if (key && key in groups) {
      return Boolean((groups[key] as MochatGroupRule).requireMention);
    }
  }
  return Boolean(config.mention.requireInGroups);
}

function buildBufferedBody(
  entries: MochatBufferedEntry[],
  isGroup: boolean,
): string {
  if (entries.length === 0) return "";
  if (entries.length === 1) return entries[0].rawBody;
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.rawBody) continue;
    if (isGroup) {
      const label =
        entry.senderName.trim() ||
        entry.senderUsername.trim() ||
        entry.author;
      if (label) {
        lines.push(`${label}: ${entry.rawBody}`);
        continue;
      }
    }
    lines.push(entry.rawBody);
  }
  return lines.join("\n").trim();
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const d = new Date(value.replace("Z", "+00:00"));
    return Math.floor(d.getTime());
  } catch {
    return null;
  }
}

function normalizeIdList(
  values: string[],
): { ids: string[]; hasWildcard: boolean } {
  const cleaned = values.map((v) => String(v).trim()).filter(Boolean);
  return {
    ids: [...new Set(cleaned.filter((v) => v !== "*"))].sort(),
    hasWildcard: cleaned.includes("*"),
  };
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class MochatChannel extends BaseChannel {
  readonly name = "mochat";

  declare protected config: MochatConfig;
  private http: typeof fetch = fetch;
  private socket: any = null;
  private wsReady = false;

  private stateDir: string;
  private cursorPath: string;
  private sessionCursor: Record<string, number> = {};
  private cursorSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private sessionSet = new Set<string>();
  private panelSet = new Set<string>();
  private autoDiscoverSessions = false;
  private autoDiscoverPanels = false;

  private coldSessions = new Set<string>();
  private sessionByConverse = new Map<string, string>();

  private seenSet = new Map<string, Set<string>>();
  private seenQueue = new Map<string, string[]>();
  private delayStates = new Map<string, DelayState>();

  private fallbackMode = false;
  private sessionFallbackAborts = new Map<string, AbortController>();
  private panelFallbackAborts = new Map<string, AbortController>();
  private refreshAbort: AbortController | null = null;

  constructor(config: MochatConfig, bus: MessageBus) {
    super(config, bus);
    this.stateDir = join(getDataPath(), "mochat");
    this.cursorPath = join(this.stateDir, "session_cursors.json");
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (!this.config.clawToken) {
      logger.error("Mochat clawToken not configured");
      return;
    }

    this.running = true;
    mkdirSync(this.stateDir, { recursive: true });
    this.loadSessionCursors();
    this.seedTargetsFromConfig();
    await this.refreshTargets(false);

    if (!(await this.startSocketClient())) {
      this.ensureFallbackWorkers();
    }

    this.startRefreshLoop();

    // Keep running until stopped
    while (this.running) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.refreshAbort) {
      this.refreshAbort.abort();
      this.refreshAbort = null;
    }

    this.stopFallbackWorkers();
    this.cancelDelayTimers();

    if (this.socket) {
      try {
        this.socket.disconnect();
      } catch {
        // ignore
      }
      this.socket = null;
    }

    if (this.cursorSaveTimer) {
      clearTimeout(this.cursorSaveTimer);
      this.cursorSaveTimer = null;
    }
    this.saveSessionCursors();

    this.wsReady = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.config.clawToken) {
      logger.warn("Mochat clawToken missing, skip send");
      return;
    }

    const parts: string[] = [];
    if (msg.content?.trim()) parts.push(msg.content.trim());
    if (msg.media) {
      for (const m of msg.media) {
        if (typeof m === "string" && m.trim()) parts.push(m);
      }
    }
    const content = parts.join("\n").trim();
    if (!content) return;

    const target = resolveMochatTarget(msg.chatId);
    if (!target.id) {
      logger.warn("Mochat outbound target is empty");
      return;
    }

    const isPanel =
      (target.isPanel || this.panelSet.has(target.id)) &&
      !target.id.startsWith("session_");

    try {
      if (isPanel) {
        await this.apiSend(
          "/api/claw/groups/panels/send",
          "panelId",
          target.id,
          content,
          msg.replyTo ?? undefined,
          this.readGroupId(msg.metadata) ?? undefined,
        );
      } else {
        await this.apiSend(
          "/api/claw/sessions/send",
          "sessionId",
          target.id,
          content,
          msg.replyTo ?? undefined,
        );
      }
    } catch (e) {
      logger.error(`Failed to send Mochat message: ${e}`);
    }
  }

  // ---- config / init helpers -----------------------------------------------

  private seedTargetsFromConfig(): void {
    const sessions = normalizeIdList(this.config.sessions);
    const panels = normalizeIdList(this.config.panels);
    this.autoDiscoverSessions = sessions.hasWildcard;
    this.autoDiscoverPanels = panels.hasWildcard;

    for (const sid of sessions.ids) {
      this.sessionSet.add(sid);
      if (!(sid in this.sessionCursor)) {
        this.coldSessions.add(sid);
      }
    }
    for (const pid of panels.ids) {
      this.panelSet.add(pid);
    }
  }

  // ---- websocket -----------------------------------------------------------

  private async startSocketClient(): Promise<boolean> {
    if (!io) {
      logger.warn(
        "socket.io-client not installed, Mochat using polling fallback",
      );
      return false;
    }

    const socketUrl = (
      this.config.socketUrl || this.config.baseUrl
    )
      .trim()
      .replace(/\/+$/, "");
    const socketPath = (this.config.socketPath || "/socket.io")
      .trim()
      .replace(/^\/+/, "");

    try {
      const socket = io.io(socketUrl, {
        path: `/${socketPath}`,
        transports: ["websocket"],
        auth: { token: this.config.clawToken },
        reconnection: true,
        reconnectionAttempts: this.config.maxRetryAttempts || undefined,
        reconnectionDelay: Math.max(
          100,
          this.config.socketReconnectDelayMs,
        ),
        reconnectionDelayMax: Math.max(
          100,
          this.config.socketMaxReconnectDelayMs,
        ),
        timeout: Math.max(1000, this.config.socketConnectTimeoutMs),
      });

      socket.on("connect", async () => {
        this.wsReady = false;
        logger.info("Mochat websocket connected");
        const subscribed = await this.subscribeAll();
        this.wsReady = subscribed;
        if (subscribed) {
          this.stopFallbackWorkers();
        } else {
          this.ensureFallbackWorkers();
        }
      });

      socket.on("disconnect", () => {
        if (!this.running) return;
        this.wsReady = false;
        logger.warn("Mochat websocket disconnected");
        this.ensureFallbackWorkers();
      });

      socket.on("connect_error", (err: Error) => {
        logger.error(`Mochat websocket connect error: ${err.message}`);
      });

      socket.on(
        "claw.session.events",
        (payload: Record<string, unknown>) => {
          this.handleWatchPayload(payload, "session").catch((e) =>
            logger.error(`Error handling session events: ${e}`),
          );
        },
      );

      socket.on(
        "claw.panel.events",
        (payload: Record<string, unknown>) => {
          this.handleWatchPayload(payload, "panel").catch((e) =>
            logger.error(`Error handling panel events: ${e}`),
          );
        },
      );

      for (const ev of [
        "notify:chat.inbox.append",
        "notify:chat.message.add",
        "notify:chat.message.update",
        "notify:chat.message.recall",
        "notify:chat.message.delete",
      ]) {
        socket.on(ev, (payload: unknown) => {
          if (ev === "notify:chat.inbox.append") {
            this.handleNotifyInboxAppend(payload).catch((e) =>
              logger.error(`Error handling inbox append: ${e}`),
            );
          } else if (ev.startsWith("notify:chat.message.")) {
            this.handleNotifyChatMessage(payload).catch((e) =>
              logger.error(`Error handling chat message: ${e}`),
            );
          }
        });
      }

      this.socket = socket;
      // Wait for connect
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, Math.max(1000, this.config.socketConnectTimeoutMs));

        socket.once("connect", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once("connect_error", (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      return true;
    } catch (e) {
      logger.error(`Failed to connect Mochat websocket: ${e}`);
      if (this.socket) {
        try {
          this.socket.disconnect();
        } catch {
          // ignore
        }
        this.socket = null;
      }
      return false;
    }
  }

  // ---- subscribe -----------------------------------------------------------

  private async subscribeAll(): Promise<boolean> {
    let ok = await this.subscribeSessions([...this.sessionSet].sort());
    ok = (await this.subscribePanels([...this.panelSet].sort())) && ok;
    if (this.autoDiscoverSessions || this.autoDiscoverPanels) {
      await this.refreshTargets(true);
    }
    return ok;
  }

  private async subscribeSessions(sessionIds: string[]): Promise<boolean> {
    if (sessionIds.length === 0) return true;
    for (const sid of sessionIds) {
      if (!(sid in this.sessionCursor)) {
        this.coldSessions.add(sid);
      }
    }

    const ack = await this.socketCall("com.claw.im.subscribeSessions", {
      sessionIds,
      cursors: this.sessionCursor,
      limit: this.config.watchLimit,
    });

    if (!ack.result) {
      logger.error(
        `Mochat subscribeSessions failed: ${ack.message || "unknown error"}`,
      );
      return false;
    }

    const data = ack.data;
    let items: Record<string, unknown>[] = [];
    if (Array.isArray(data)) {
      items = data.filter(
        (i): i is Record<string, unknown> =>
          typeof i === "object" && i !== null,
      );
    } else if (typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      const sessions = d.sessions;
      if (Array.isArray(sessions)) {
        items = sessions.filter(
          (i): i is Record<string, unknown> =>
            typeof i === "object" && i !== null,
        );
      } else if ("sessionId" in d) {
        items = [d];
      }
    }

    for (const p of items) {
      await this.handleWatchPayload(p, "session");
    }
    return true;
  }

  private async subscribePanels(panelIds: string[]): Promise<boolean> {
    if (!this.autoDiscoverPanels && panelIds.length === 0) return true;
    const ack = await this.socketCall("com.claw.im.subscribePanels", {
      panelIds,
    });
    if (!ack.result) {
      logger.error(
        `Mochat subscribePanels failed: ${ack.message || "unknown error"}`,
      );
      return false;
    }
    return true;
  }

  private async socketCall(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<{ result: boolean; message?: string; data?: unknown }> {
    if (!this.socket) {
      return { result: false, message: "socket not connected" };
    }
    try {
      const raw: unknown = await new Promise((resolve, reject) => {
        this.socket.timeout(10000).emit(eventName, payload, (err: Error | null, response: unknown) => {
          if (err) reject(err);
          else resolve(response);
        });
      });
      if (typeof raw === "object" && raw !== null) {
        return raw as { result: boolean; message?: string; data?: unknown };
      }
      return { result: true, data: raw };
    } catch (e) {
      return { result: false, message: String(e) };
    }
  }

  // ---- refresh / discovery -------------------------------------------------

  private startRefreshLoop(): void {
    const intervalMs = Math.max(1000, this.config.refreshIntervalMs);
    this.refreshAbort = new AbortController();

    const loop = async () => {
      while (this.running) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (!this.running) break;
        try {
          await this.refreshTargets(this.wsReady);
        } catch (e) {
          logger.warn(`Mochat refresh failed: ${e}`);
        }
        if (this.fallbackMode) {
          this.ensureFallbackWorkers();
        }
      }
    };

    loop().catch((e) => {
      if (this.running) logger.error(`Refresh loop error: ${e}`);
    });
  }

  private async refreshTargets(subscribeNew: boolean): Promise<void> {
    if (this.autoDiscoverSessions) {
      await this.refreshSessionsDirectory(subscribeNew);
    }
    if (this.autoDiscoverPanels) {
      await this.refreshPanels(subscribeNew);
    }
  }

  private async refreshSessionsDirectory(
    subscribeNew: boolean,
  ): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = await this.postJson("/api/claw/sessions/list", {});
    } catch (e) {
      logger.warn(`Mochat listSessions failed: ${e}`);
      return;
    }

    const sessions = response.sessions;
    if (!Array.isArray(sessions)) return;

    const newIds: string[] = [];
    for (const s of sessions) {
      if (typeof s !== "object" || s === null) continue;
      const sd = s as Record<string, unknown>;
      const sid = strField(sd, "sessionId");
      if (!sid) continue;
      if (!this.sessionSet.has(sid)) {
        this.sessionSet.add(sid);
        newIds.push(sid);
        if (!(sid in this.sessionCursor)) {
          this.coldSessions.add(sid);
        }
      }
      const cid = strField(sd, "converseId");
      if (cid) this.sessionByConverse.set(cid, sid);
    }

    if (newIds.length === 0) return;
    if (this.wsReady && subscribeNew) {
      await this.subscribeSessions(newIds);
    }
    if (this.fallbackMode) {
      this.ensureFallbackWorkers();
    }
  }

  private async refreshPanels(subscribeNew: boolean): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = await this.postJson("/api/claw/groups/get", {});
    } catch (e) {
      logger.warn(`Mochat getWorkspaceGroup failed: ${e}`);
      return;
    }

    const rawPanels = response.panels;
    if (!Array.isArray(rawPanels)) return;

    const newIds: string[] = [];
    for (const p of rawPanels) {
      if (typeof p !== "object" || p === null) continue;
      const pd = p as Record<string, unknown>;
      const pt = pd.type;
      if (typeof pt === "number" && pt !== 0) continue;
      const pid = strField(pd, "id", "_id");
      if (pid && !this.panelSet.has(pid)) {
        this.panelSet.add(pid);
        newIds.push(pid);
      }
    }

    if (newIds.length === 0) return;
    if (this.wsReady && subscribeNew) {
      await this.subscribePanels(newIds);
    }
    if (this.fallbackMode) {
      this.ensureFallbackWorkers();
    }
  }

  // ---- fallback workers ----------------------------------------------------

  private ensureFallbackWorkers(): void {
    if (!this.running) return;
    this.fallbackMode = true;

    for (const sid of [...this.sessionSet].sort()) {
      if (!this.sessionFallbackAborts.has(sid)) {
        const abort = new AbortController();
        this.sessionFallbackAborts.set(sid, abort);
        this.sessionWatchWorker(sid, abort.signal).catch((e) => {
          if (this.running)
            logger.warn(`Session watch worker error (${sid}): ${e}`);
        });
      }
    }

    for (const pid of [...this.panelSet].sort()) {
      if (!this.panelFallbackAborts.has(pid)) {
        const abort = new AbortController();
        this.panelFallbackAborts.set(pid, abort);
        this.panelPollWorker(pid, abort.signal).catch((e) => {
          if (this.running)
            logger.warn(`Panel poll worker error (${pid}): ${e}`);
        });
      }
    }
  }

  private stopFallbackWorkers(): void {
    this.fallbackMode = false;
    for (const abort of this.sessionFallbackAborts.values()) abort.abort();
    for (const abort of this.panelFallbackAborts.values()) abort.abort();
    this.sessionFallbackAborts.clear();
    this.panelFallbackAborts.clear();
  }

  private async sessionWatchWorker(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (this.running && this.fallbackMode && !signal.aborted) {
      try {
        const payload = await this.postJson("/api/claw/sessions/watch", {
          sessionId,
          cursor: this.sessionCursor[sessionId] ?? 0,
          timeoutMs: this.config.watchTimeoutMs,
          limit: this.config.watchLimit,
        });
        await this.handleWatchPayload(payload, "session");
      } catch (e) {
        if (signal.aborted) break;
        logger.warn(`Mochat watch fallback error (${sessionId}): ${e}`);
        await new Promise((r) =>
          setTimeout(r, Math.max(100, this.config.retryDelayMs)),
        );
      }
    }
  }

  private async panelPollWorker(
    panelId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sleepMs = Math.max(1000, this.config.refreshIntervalMs);
    while (this.running && this.fallbackMode && !signal.aborted) {
      try {
        const resp = await this.postJson(
          "/api/claw/groups/panels/messages",
          {
            panelId,
            limit: Math.min(100, Math.max(1, this.config.watchLimit)),
          },
        );
        const msgs = resp.messages;
        if (Array.isArray(msgs)) {
          for (const m of [...msgs].reverse()) {
            if (typeof m !== "object" || m === null) continue;
            const md = m as Record<string, unknown>;
            const evt = makeSyntheticEvent(
              String(md.messageId || ""),
              String(md.author || ""),
              md.content,
              md.meta,
              String(resp.groupId || ""),
              panelId,
              md.createdAt,
              md.authorInfo,
            );
            await this.processInboundEvent(panelId, evt, "panel");
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        logger.warn(`Mochat panel polling error (${panelId}): ${e}`);
      }
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  // ---- inbound event processing --------------------------------------------

  private async handleWatchPayload(
    payload: Record<string, unknown>,
    targetKind: string,
  ): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const targetId = strField(payload, "sessionId");
    if (!targetId) return;

    if (
      targetKind === "session" &&
      typeof payload.cursor === "number" &&
      payload.cursor >= 0
    ) {
      this.markSessionCursor(targetId, payload.cursor as number);
    }

    const rawEvents = payload.events;
    if (!Array.isArray(rawEvents)) return;

    if (targetKind === "session" && this.coldSessions.has(targetId)) {
      this.coldSessions.delete(targetId);
      return;
    }

    for (const event of rawEvents) {
      if (typeof event !== "object" || event === null) continue;
      const evt = event as Record<string, unknown>;
      const seq = evt.seq;
      if (
        targetKind === "session" &&
        typeof seq === "number" &&
        seq > (this.sessionCursor[targetId] ?? 0)
      ) {
        this.markSessionCursor(targetId, seq);
      }
      if (evt.type === "message.add") {
        await this.processInboundEvent(targetId, evt, targetKind);
      }
    }
  }

  private async processInboundEvent(
    targetId: string,
    event: Record<string, unknown>,
    targetKind: string,
  ): Promise<void> {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;

    const author = strField(p, "author");
    if (!author) return;
    if (this.config.agentUserId && author === this.config.agentUserId) return;
    if (!this.isAllowed(author)) return;

    const messageId = strField(p, "messageId");
    const seenKey = `${targetKind}:${targetId}`;
    if (messageId && this.rememberMessageId(seenKey, messageId)) return;

    const rawBody =
      normalizeMochatContent(p.content) || "[empty message]";
    const ai = safeDict(p.authorInfo);
    const senderName = strField(ai, "nickname", "email");
    const senderUsername = strField(ai, "agentId");

    const groupId = strField(p, "groupId");
    const isGroup = Boolean(groupId);
    const wasMentioned = resolveWasMentioned(p, this.config.agentUserId);
    const requireMention =
      targetKind === "panel" &&
      isGroup &&
      resolveRequireMention(this.config, targetId, groupId);
    const useDelay =
      targetKind === "panel" &&
      this.config.replyDelayMode === "non-mention";

    if (requireMention && !wasMentioned && !useDelay) return;

    const entry: MochatBufferedEntry = {
      rawBody,
      author,
      senderName,
      senderUsername,
      timestamp: parseTimestamp(event.timestamp),
      messageId,
      groupId,
    };

    if (useDelay) {
      const delayKey = seenKey;
      if (wasMentioned) {
        await this.flushDelayedEntries(
          delayKey,
          targetId,
          targetKind,
          entry,
        );
      } else {
        this.enqueueDelayedEntry(delayKey, targetId, targetKind, entry);
      }
      return;
    }

    await this.dispatchEntries(targetId, targetKind, [entry], wasMentioned);
  }

  // ---- dedup / buffering ---------------------------------------------------

  private rememberMessageId(key: string, messageId: string): boolean {
    let seen = this.seenSet.get(key);
    let queue = this.seenQueue.get(key);
    if (!seen) {
      seen = new Set();
      this.seenSet.set(key, seen);
    }
    if (!queue) {
      queue = [];
      this.seenQueue.set(key, queue);
    }

    if (seen.has(messageId)) return true;
    seen.add(messageId);
    queue.push(messageId);
    while (queue.length > MAX_SEEN_MESSAGE_IDS) {
      const old = queue.shift()!;
      seen.delete(old);
    }
    return false;
  }

  private enqueueDelayedEntry(
    key: string,
    targetId: string,
    targetKind: string,
    entry: MochatBufferedEntry,
  ): void {
    let state = this.delayStates.get(key);
    if (!state) {
      state = { entries: [], timer: null };
      this.delayStates.set(key, state);
    }
    state.entries.push(entry);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.flushDelayedEntries(key, targetId, targetKind, null).catch(
        (e) => logger.error(`Delayed flush error: ${e}`),
      );
    }, Math.max(0, this.config.replyDelayMs));
  }

  private async flushDelayedEntries(
    key: string,
    targetId: string,
    targetKind: string,
    extraEntry: MochatBufferedEntry | null,
  ): Promise<void> {
    let state = this.delayStates.get(key);
    if (!state) {
      state = { entries: [], timer: null };
      this.delayStates.set(key, state);
    }

    if (extraEntry) state.entries.push(extraEntry);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const entries = [...state.entries];
    state.entries = [];

    if (entries.length > 0) {
      await this.dispatchEntries(
        targetId,
        targetKind,
        entries,
        extraEntry !== null,
      );
    }
  }

  private async dispatchEntries(
    targetId: string,
    targetKind: string,
    entries: MochatBufferedEntry[],
    wasMentioned: boolean,
  ): Promise<void> {
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    const isGroup = Boolean(last.groupId);
    const body = buildBufferedBody(entries, isGroup) || "[empty message]";

    await this.handleMessage(last.author, targetId, body, undefined, {
      messageId: last.messageId,
      timestamp: last.timestamp,
      isGroup,
      groupId: last.groupId,
      senderName: last.senderName,
      senderUsername: last.senderUsername,
      targetKind,
      wasMentioned,
      bufferedCount: entries.length,
    });
  }

  private cancelDelayTimers(): void {
    for (const state of this.delayStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.delayStates.clear();
  }

  // ---- notify handlers -----------------------------------------------------

  private async handleNotifyChatMessage(payload: unknown): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    const groupId = strField(p, "groupId");
    const panelId = strField(p, "converseId", "panelId");
    if (!groupId || !panelId) return;
    if (this.panelSet.size > 0 && !this.panelSet.has(panelId)) return;

    const evt = makeSyntheticEvent(
      String(p._id ?? p.messageId ?? ""),
      String(p.author ?? ""),
      p.content,
      p.meta,
      groupId,
      panelId,
      p.createdAt,
      p.authorInfo,
    );
    await this.processInboundEvent(panelId, evt, "panel");
  }

  private async handleNotifyInboxAppend(payload: unknown): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p.type !== "message") return;

    const detail = p.payload;
    if (typeof detail !== "object" || detail === null) return;
    const d = detail as Record<string, unknown>;
    if (strField(d, "groupId")) return;

    const converseId = strField(d, "converseId");
    if (!converseId) return;

    let sessionId = this.sessionByConverse.get(converseId);
    if (!sessionId) {
      await this.refreshSessionsDirectory(this.wsReady);
      sessionId = this.sessionByConverse.get(converseId);
    }
    if (!sessionId) return;

    const evt = makeSyntheticEvent(
      String(d.messageId ?? p._id ?? ""),
      String(d.messageAuthor ?? ""),
      String(d.messagePlainContent ?? d.messageSnippet ?? ""),
      {
        source: "notify:chat.inbox.append",
        converseId,
      },
      "",
      converseId,
      p.createdAt,
    );
    await this.processInboundEvent(sessionId, evt, "session");
  }

  // ---- cursor persistence --------------------------------------------------

  private markSessionCursor(sessionId: string, cursor: number): void {
    if (cursor < 0 || cursor < (this.sessionCursor[sessionId] ?? 0)) return;
    this.sessionCursor[sessionId] = cursor;
    if (!this.cursorSaveTimer) {
      this.cursorSaveTimer = setTimeout(() => {
        this.cursorSaveTimer = null;
        this.saveSessionCursors();
      }, CURSOR_SAVE_DEBOUNCE_MS);
    }
  }

  private loadSessionCursors(): void {
    if (!existsSync(this.cursorPath)) return;
    try {
      const raw = readFileSync(this.cursorPath, "utf-8");
      const data = JSON.parse(raw);
      const cursors = typeof data === "object" && data !== null ? data.cursors : null;
      if (typeof cursors === "object" && cursors !== null) {
        for (const [sid, cur] of Object.entries(cursors)) {
          if (typeof sid === "string" && typeof cur === "number" && cur >= 0) {
            this.sessionCursor[sid] = cur;
          }
        }
      }
    } catch (e) {
      logger.warn(`Failed to read Mochat cursor file: ${e}`);
    }
  }

  private saveSessionCursors(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(
        this.cursorPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            cursors: this.sessionCursor,
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
    } catch (e) {
      logger.warn(`Failed to save Mochat cursor file: ${e}`);
    }
  }

  // ---- HTTP helpers --------------------------------------------------------

  private async postJson(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl.trim().replace(/\/+$/, "")}${path}`;
    const response = await this.http(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Claw-Token": this.config.clawToken,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Mochat HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = await response.text();
    }

    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      if (typeof p.code === "number" && p.code !== 200) {
        const msg = String(p.message ?? p.name ?? "request failed");
        throw new Error(`Mochat API error: ${msg} (code=${p.code})`);
      }
      const data = p.data;
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
      if (p.code === 200) return (data ?? {}) as Record<string, unknown>;
      return p;
    }
    return {};
  }

  private async apiSend(
    path: string,
    idKey: string,
    idVal: string,
    content: string,
    replyTo?: string,
    groupId?: string | null,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { [idKey]: idVal, content };
    if (replyTo) body.replyTo = replyTo;
    if (groupId) body.groupId = groupId;
    return this.postJson(path, body);
  }

  private readGroupId(
    metadata: Record<string, unknown>,
  ): string | null {
    if (typeof metadata !== "object" || metadata === null) return null;
    const value = metadata.group_id ?? metadata.groupId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
}
