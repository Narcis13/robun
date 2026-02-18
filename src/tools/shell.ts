import { z } from "zod";
import type { Tool } from "./base";

const DEFAULT_DENY_PATTERNS = [
  /\brm\s+-[rf]{1,2}\b/,
  /\bdel\s+\/[fq]\b/i,
  /\brmdir\s+\/s\b/i,
  /\b(format|mkfs|diskpart)\b/i,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|poweroff)\b/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
];

export class ExecTool implements Tool {
  readonly name = "exec";
  readonly description =
    "Execute a shell command and return its output. Use with caution.";
  readonly parameters = z.object({
    command: z.string().describe("Shell command to execute"),
    working_dir: z.string().optional().describe("Working directory"),
  });

  private timeout: number;
  private workingDir: string;
  private restrictToWorkspace: boolean;
  private denyPatterns: RegExp[];

  constructor(
    options: {
      timeout?: number;
      workingDir?: string;
      restrictToWorkspace?: boolean;
      denyPatterns?: RegExp[];
    } = {},
  ) {
    this.timeout = options.timeout ?? 60;
    this.workingDir = options.workingDir ?? process.cwd();
    this.restrictToWorkspace = options.restrictToWorkspace ?? false;
    this.denyPatterns = options.denyPatterns ?? DEFAULT_DENY_PATTERNS;
  }

  private guardCommand(command: string): string | null {
    const lower = command.toLowerCase();
    for (const pattern of this.denyPatterns) {
      if (pattern.test(lower)) {
        return "Error: Command blocked by safety guard (dangerous pattern detected)";
      }
    }

    if (this.restrictToWorkspace) {
      if (command.includes("../") || command.includes("..\\")) {
        return "Error: Command blocked by safety guard (path traversal detected)";
      }
    }

    return null;
  }

  async execute(params: {
    command: string;
    working_dir?: string;
  }): Promise<string> {
    const blocked = this.guardCommand(params.command);
    if (blocked) return blocked;

    const cwd = params.working_dir ?? this.workingDir;

    try {
      const proc = Bun.spawn(["sh", "-c", params.command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const timeoutId = setTimeout(() => proc.kill(), this.timeout * 1000);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timeoutId);
      const exitCode = await proc.exited;

      let output = "";
      if (stdout.trim()) output += stdout;
      if (stderr.trim()) output += (output ? "\n" : "") + `STDERR:\n${stderr}`;
      if (!output.trim()) output = `(no output, exit code ${exitCode})`;

      if (exitCode !== 0 && !output.includes("STDERR:")) {
        output += `\nExit code: ${exitCode}`;
      }

      // Truncate at 10,000 chars
      if (output.length > 10000) {
        output = output.slice(0, 10000) + "\n... (truncated)";
      }

      return output;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
