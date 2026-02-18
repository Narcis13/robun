import { z } from "zod";
import type { Tool } from "./base";
import type { SubagentManager } from "../agent/subagent";

export class SpawnTool implements Tool {
  readonly name = "spawn";
  readonly description = "Spawn a background subagent for a task.";
  readonly parameters = z.object({
    task: z.string().describe("Task description for the subagent"),
    label: z.string().optional().describe("Short label for the task"),
  });

  private manager: SubagentManager;
  private channel: string = "";
  private chatId: string = "";

  constructor(manager: SubagentManager) {
    this.manager = manager;
  }

  setContext(channel: string, chatId: string): void {
    this.channel = channel;
    this.chatId = chatId;
  }

  async execute(params: { task: string; label?: string }): Promise<string> {
    return this.manager.spawn(
      params.task,
      params.label ?? "background-task",
      this.channel,
      this.chatId,
    );
  }
}
