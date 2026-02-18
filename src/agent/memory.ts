import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

export class MemoryStore {
  private memoryDir: string;
  private memoryFile: string;
  private historyFile: string;

  constructor(workspace: string) {
    this.memoryDir = join(workspace, "memory");
    mkdirSync(this.memoryDir, { recursive: true });
    this.memoryFile = join(this.memoryDir, "MEMORY.md");
    this.historyFile = join(this.memoryDir, "HISTORY.md");
  }

  readLongTerm(): string {
    if (!existsSync(this.memoryFile)) return "";
    return readFileSync(this.memoryFile, "utf-8");
  }

  writeLongTerm(content: string): void {
    writeFileSync(this.memoryFile, content, "utf-8");
  }

  appendHistory(entry: string): void {
    appendFileSync(this.historyFile, entry + "\n\n", "utf-8");
  }

  getMemoryContext(): string {
    const content = this.readLongTerm();
    if (!content.trim()) return "";
    return `## Long-term Memory\n\n${content}`;
  }
}
