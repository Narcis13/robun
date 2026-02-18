import { z } from "zod";
import type { Tool, ToolRegistry } from "./base";

export class MCPToolWrapper implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodSchema;

  private session: any; // MCP Client instance
  private originalName: string;

  constructor(session: any, serverName: string, toolDef: any) {
    this.session = session;
    this.originalName = toolDef.name;
    this.name = `mcp_${serverName}_${toolDef.name}`;
    this.description = toolDef.description || "";
    // MCP tools provide JSON Schema — use passthrough Zod schema
    this.parameters = z.object({}).passthrough();
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const result = await this.session.callTool(this.originalName, params);
    const texts: string[] = [];
    for (const block of result.content ?? []) {
      if (block.type === "text") texts.push(block.text);
    }
    return texts.join("\n") || "(no output)";
  }
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export async function connectMcpServers(
  mcpServers: Record<string, McpServerConfig>,
  registry: ToolRegistry,
): Promise<Array<{ cleanup: () => Promise<void> }>> {
  const cleanups: Array<{ cleanup: () => Promise<void> }> = [];

  for (const [serverName, config] of Object.entries(mcpServers)) {
    try {
      const { Client } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
      );
      const client = new Client({ name: "robun", version: "1.0.0" });

      let transport: any;
      if (config.url) {
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        transport = new StreamableHTTPClientTransport(new URL(config.url));
      } else if (config.command) {
        const { StdioClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/stdio.js"
        );
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...process.env, ...(config.env ?? {}) } as Record<
            string,
            string
          >,
        });
      } else {
        continue;
      }

      await client.connect(transport);
      const toolsResult = await client.listTools();

      for (const tool of toolsResult.tools ?? []) {
        registry.register(new MCPToolWrapper(client, serverName, tool));
      }

      cleanups.push({
        cleanup: async () => {
          try {
            await client.close();
          } catch {}
        },
      });
    } catch (err) {
      console.error(
        `Failed to connect MCP server '${serverName}':`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return cleanups;
}
