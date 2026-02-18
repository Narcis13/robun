import { z } from "zod";
import { resolve, dirname } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import type { Tool } from "./base";

function resolvePath(path: string, allowedDir?: string): string {
  const resolved = resolve(path);
  if (allowedDir) {
    const allowed = resolve(allowedDir);
    if (!resolved.startsWith(allowed + "/") && resolved !== allowed) {
      throw new Error(`Access denied: path '${path}' is outside workspace`);
    }
  }
  return resolved;
}

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description = "Read the contents of a file at the given path.";
  readonly parameters = z.object({
    path: z.string().describe("Path to the file to read"),
  });

  constructor(private allowedDir?: string) {}

  async execute(params: { path: string }): Promise<string> {
    try {
      const resolved = resolvePath(params.path, this.allowedDir);
      if (!existsSync(resolved)) return `Error: File not found: ${params.path}`;
      const stat = statSync(resolved);
      if (!stat.isFile()) return `Error: Not a file: ${params.path}`;
      return readFileSync(resolved, "utf-8");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export class WriteFileTool implements Tool {
  readonly name = "write_file";
  readonly description =
    "Write content to a file at the given path. Creates parent directories if needed.";
  readonly parameters = z.object({
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write"),
  });

  constructor(private allowedDir?: string) {}

  async execute(params: { path: string; content: string }): Promise<string> {
    try {
      const resolved = resolvePath(params.path, this.allowedDir);
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, params.content, "utf-8");
      return `Successfully wrote ${params.content.length} bytes to ${params.path}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export class EditFileTool implements Tool {
  readonly name = "edit_file";
  readonly description =
    "Edit a file by replacing old_text with new_text. The old_text must exist exactly in the file.";
  readonly parameters = z.object({
    path: z.string().describe("Path to the file to edit"),
    old_text: z.string().describe("Text to find and replace"),
    new_text: z.string().describe("Replacement text"),
  });

  constructor(private allowedDir?: string) {}

  async execute(params: {
    path: string;
    old_text: string;
    new_text: string;
  }): Promise<string> {
    try {
      const resolved = resolvePath(params.path, this.allowedDir);
      if (!existsSync(resolved)) return `Error: File not found: ${params.path}`;
      let content = readFileSync(resolved, "utf-8");

      if (!content.includes(params.old_text)) {
        return "Error: old_text not found in file. Make sure it matches exactly.";
      }

      const count = content.split(params.old_text).length - 1;
      if (count > 1) {
        return `Warning: old_text appears ${count} times. Please provide more context to make it unique.`;
      }

      content = content.replace(params.old_text, params.new_text);
      writeFileSync(resolved, content, "utf-8");
      return `Successfully edited ${params.path}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export class ListDirTool implements Tool {
  readonly name = "list_dir";
  readonly description = "List the contents of a directory.";
  readonly parameters = z.object({
    path: z.string().describe("Path to the directory to list"),
  });

  constructor(private allowedDir?: string) {}

  async execute(params: { path: string }): Promise<string> {
    try {
      const resolved = resolvePath(params.path, this.allowedDir);
      if (!existsSync(resolved)) return `Error: Directory not found: ${params.path}`;
      const stat = statSync(resolved);
      if (!stat.isDirectory()) return `Error: Not a directory: ${params.path}`;

      const entries = readdirSync(resolved).sort();
      if (entries.length === 0) return `Directory ${params.path} is empty`;

      return entries
        .map((entry) => {
          const entryStat = statSync(resolve(resolved, entry));
          const prefix = entryStat.isDirectory() ? "\u{1F4C1}" : "\u{1F4C4}";
          return `${prefix} ${entry}`;
        })
        .join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
