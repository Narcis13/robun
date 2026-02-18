import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { platform, hostname } from "node:os";
import { MemoryStore } from "./memory";
import { SkillsLoader } from "./skills";

export class ContextBuilder {
  static readonly BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"];

  private workspace: string;
  private memory: MemoryStore;
  private skills: SkillsLoader;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.memory = new MemoryStore(workspace);
    this.skills = new SkillsLoader(workspace);
  }

  buildSystemPrompt(skillNames?: string[]): string {
    const sections: string[] = [];

    sections.push(this.getIdentity());

    const bootstrap = this.loadBootstrapFiles();
    if (bootstrap) sections.push(bootstrap);

    const memoryCtx = this.memory.getMemoryContext();
    if (memoryCtx) sections.push(memoryCtx);

    const alwaysSkills = this.skills.getAlwaysSkills();
    const allSkillNames = [...new Set([...alwaysSkills, ...(skillNames ?? [])])];
    if (allSkillNames.length > 0) {
      const skillContent = this.skills.loadSkillsForContext(allSkillNames);
      if (skillContent) sections.push(`## Active Skills\n\n${skillContent}`);
    }

    const summary = this.skills.buildSkillsSummary();
    if (summary) sections.push(`## Available Skills\n\n${summary}`);

    return sections.join("\n\n---\n\n");
  }

  private getIdentity(): string {
    const now = new Date().toISOString();
    const os = `${platform()} (${hostname()})`;
    return `## Identity\n\nYou are robun, an AI assistant.\nTimestamp: ${now}\nOS: ${os}\nWorkspace: ${this.workspace}`;
  }

  private loadBootstrapFiles(): string {
    const parts: string[] = [];
    for (const filename of ContextBuilder.BOOTSTRAP_FILES) {
      const filePath = join(this.workspace, filename);
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) parts.push(`## ${filename}\n\n${content}`);
    }
    return parts.join("\n\n");
  }

  buildMessages(options: {
    history: Array<{ role: string; content: string }>;
    currentMessage: string;
    skillNames?: string[];
    media?: string[] | null;
    channel?: string;
    chatId?: string;
  }): Array<{ role: string; content: string | unknown[] }> {
    const messages: Array<{ role: string; content: string | unknown[] }> = [];

    messages.push({
      role: "system",
      content: this.buildSystemPrompt(options.skillNames),
    });

    for (const msg of options.history) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const userContent = this.buildUserContent(options.currentMessage, options.media);
    messages.push({ role: "user", content: userContent });

    return messages;
  }

  private buildUserContent(text: string, media?: string[] | null): string | unknown[] {
    if (!media || media.length === 0) return text;

    const parts: unknown[] = [{ type: "text", text }];
    for (const mediaPath of media) {
      try {
        const data = readFileSync(mediaPath);
        const base64 = data.toString("base64");
        const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "png";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          webp: "image/webp",
        };
        const mime = mimeMap[ext] ?? "image/png";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${base64}` },
        });
      } catch {
        // Skip unreadable media
      }
    }
    return parts;
  }

  static addToolResult(
    messages: unknown[],
    toolCallId: string,
    _toolName: string,
    result: string,
  ): unknown[] {
    messages.push({
      role: "tool",
      content: result,
      tool_call_id: toolCallId,
    });
    return messages;
  }

  static addAssistantMessage(
    messages: unknown[],
    content: string | null,
    toolCalls?: unknown[],
    reasoningContent?: string | null,
  ): unknown[] {
    const msg: Record<string, unknown> = { role: "assistant" };
    if (content !== null) msg.content = content;
    if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    messages.push(msg);
    return messages;
  }
}
