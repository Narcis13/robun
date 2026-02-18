import { z, type ZodSchema } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodSchema;
  execute(params: Record<string, unknown>): Promise<string>;
}

export function toolToSchema(tool: Tool): {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters, { target: "openAi" }),
    },
  };
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getDefinitions(): unknown[] {
    return Array.from(this.tools.values()).map(toolToSchema);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: Tool '${name}' not found.`;

    try {
      const validated = tool.parameters.parse(params);
      return await tool.execute(validated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return `Invalid parameters: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
      }
      return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  get toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  get size(): number {
    return this.tools.size;
  }
}
