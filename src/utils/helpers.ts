import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function getDataPath(): string {
  return ensureDir(join(homedir(), ".robun"));
}

export function getWorkspacePath(workspace?: string): string {
  const path = workspace
    ? resolve(workspace.replace(/^~/, homedir()))
    : join(homedir(), ".robun", "workspace");
  return ensureDir(path);
}

export function getSessionsPath(): string {
  return ensureDir(join(getDataPath(), "sessions"));
}

export function getSkillsPath(workspace?: string): string {
  const ws = workspace ?? getWorkspacePath();
  return ensureDir(join(ws, "skills"));
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function truncateString(s: string, maxLen = 100, suffix = "..."): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - suffix.length) + suffix;
}

export function safeFilename(name: string): string {
  const unsafe = '<>:"/\\|?*';
  let result = name;
  for (const char of unsafe) {
    result = result.replaceAll(char, "_");
  }
  return result.trim();
}

export function parseSessionKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  if (idx === -1) throw new Error(`Invalid session key: ${key}`);
  return [key.slice(0, idx), key.slice(idx + 1)];
}
