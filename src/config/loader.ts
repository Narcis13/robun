import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { ConfigSchema, type Config } from "./schema";

export function getConfigPath(): string {
  return join(homedir(), ".robun", "config.json");
}

export function getDataDir(): string {
  return join(homedir(), ".robun");
}

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? getConfigPath();
  let config: Config;
  if (!existsSync(path)) {
    config = ConfigSchema.parse({});
  } else {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    config = ConfigSchema.parse(raw);
  }
  return applyEnvOverrides(config);
}

export function saveConfig(config: Config, configPath?: string): void {
  const path = configPath ?? getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: string): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  current[lastKey] = value;
}

export function applyEnvOverrides(config: Config): Config {
  const mutable = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ROBUN_") || value === undefined) continue;
    const path = key.slice(6).toLowerCase().split("__");
    setNestedValue(mutable, path, value);
  }
  return ConfigSchema.parse(mutable);
}
