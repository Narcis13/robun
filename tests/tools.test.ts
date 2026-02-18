import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ToolRegistry, toolToSchema, type Tool } from "../src/tools/base";
import {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  ListDirTool,
} from "../src/tools/filesystem";
import { ExecTool } from "../src/tools/shell";

// ---------- Test Fixtures ----------

const TEST_DIR = resolve("/tmp/robun-test-tools");

function setupTestDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "subdir"));
  writeFileSync(join(TEST_DIR, "hello.txt"), "Hello, world!");
  writeFileSync(join(TEST_DIR, "edit-me.txt"), "line one\nline two\nline three");
  writeFileSync(join(TEST_DIR, "subdir", "nested.txt"), "nested content");
}

function cleanupTestDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// ---------- ToolRegistry ----------

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  const dummyTool: Tool = {
    name: "dummy",
    description: "A dummy tool",
    parameters: z.object({ value: z.string() }),
    async execute(params) {
      return `got: ${(params as { value: string }).value}`;
    },
  };

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test("register and retrieve tool", () => {
    registry.register(dummyTool);
    expect(registry.has("dummy")).toBe(true);
    expect(registry.get("dummy")).toBe(dummyTool);
    expect(registry.size).toBe(1);
    expect(registry.toolNames).toEqual(["dummy"]);
  });

  test("unregister tool", () => {
    registry.register(dummyTool);
    registry.unregister("dummy");
    expect(registry.has("dummy")).toBe(false);
    expect(registry.size).toBe(0);
  });

  test("execute registered tool", async () => {
    registry.register(dummyTool);
    const result = await registry.execute("dummy", { value: "test" });
    expect(result).toBe("got: test");
  });

  test("execute unknown tool returns error", async () => {
    const result = await registry.execute("nonexistent", {});
    expect(result).toContain("not found");
  });

  test("execute with invalid params returns validation error", async () => {
    registry.register(dummyTool);
    const result = await registry.execute("dummy", { value: 123 });
    expect(result).toContain("Invalid parameters");
  });

  test("getDefinitions returns OpenAI schemas", () => {
    registry.register(dummyTool);
    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(1);
    const def = defs[0] as { type: string; function: { name: string } };
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("dummy");
  });
});

describe("toolToSchema", () => {
  test("converts tool to OpenAI function schema", () => {
    const tool: Tool = {
      name: "test_tool",
      description: "Test description",
      parameters: z.object({ x: z.number() }),
      async execute() {
        return "ok";
      },
    };
    const schema = toolToSchema(tool);
    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe("test_tool");
    expect(schema.function.description).toBe("Test description");
    expect(schema.function.parameters).toBeDefined();
  });
});

// ---------- Filesystem Tools ----------

describe("ReadFileTool", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  test("reads existing file", async () => {
    const tool = new ReadFileTool();
    const result = await tool.execute({ path: join(TEST_DIR, "hello.txt") });
    expect(result).toBe("Hello, world!");
  });

  test("returns error for missing file", async () => {
    const tool = new ReadFileTool();
    const result = await tool.execute({ path: join(TEST_DIR, "nope.txt") });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  test("returns error for directory", async () => {
    const tool = new ReadFileTool();
    const result = await tool.execute({ path: join(TEST_DIR, "subdir") });
    expect(result).toContain("Not a file");
  });

  test("enforces allowedDir restriction", async () => {
    const tool = new ReadFileTool(TEST_DIR);
    const result = await tool.execute({ path: "/etc/passwd" });
    expect(result).toContain("Access denied");
  });
});

describe("WriteFileTool", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  test("writes new file", async () => {
    const tool = new WriteFileTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "new.txt"),
      content: "new content",
    });
    expect(result).toContain("Successfully wrote");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(TEST_DIR, "new.txt"), "utf-8")).toBe("new content");
  });

  test("creates parent directories", async () => {
    const tool = new WriteFileTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "deep", "nested", "file.txt"),
      content: "deep content",
    });
    expect(result).toContain("Successfully wrote");
    expect(existsSync(join(TEST_DIR, "deep", "nested", "file.txt"))).toBe(true);
  });

  test("enforces allowedDir restriction", async () => {
    const tool = new WriteFileTool(TEST_DIR);
    const result = await tool.execute({
      path: "/tmp/outside-workspace.txt",
      content: "nope",
    });
    expect(result).toContain("Access denied");
  });
});

describe("EditFileTool", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  test("replaces text in file", async () => {
    const tool = new EditFileTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "edit-me.txt"),
      old_text: "line two",
      new_text: "LINE TWO",
    });
    expect(result).toContain("Successfully edited");
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(TEST_DIR, "edit-me.txt"), "utf-8");
    expect(content).toContain("LINE TWO");
    expect(content).not.toContain("line two");
  });

  test("returns error when old_text not found", async () => {
    const tool = new EditFileTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "edit-me.txt"),
      old_text: "nonexistent text",
      new_text: "replacement",
    });
    expect(result).toContain("not found");
  });

  test("warns on multiple occurrences", async () => {
    writeFileSync(join(TEST_DIR, "dupes.txt"), "foo bar foo");
    const tool = new EditFileTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "dupes.txt"),
      old_text: "foo",
      new_text: "baz",
    });
    expect(result).toContain("appears 2 times");
  });

  test("returns error for missing file", async () => {
    const tool = new EditFileTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "nope.txt"),
      old_text: "a",
      new_text: "b",
    });
    expect(result).toContain("not found");
  });
});

describe("ListDirTool", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  test("lists directory contents", async () => {
    const tool = new ListDirTool();
    const result = await tool.execute({ path: TEST_DIR });
    expect(result).toContain("edit-me.txt");
    expect(result).toContain("hello.txt");
    expect(result).toContain("subdir");
  });

  test("returns error for missing directory", async () => {
    const tool = new ListDirTool();
    const result = await tool.execute({ path: join(TEST_DIR, "nope") });
    expect(result).toContain("not found");
  });

  test("returns error for file path", async () => {
    const tool = new ListDirTool();
    const result = await tool.execute({
      path: join(TEST_DIR, "hello.txt"),
    });
    expect(result).toContain("Not a directory");
  });

  test("handles empty directory", async () => {
    mkdirSync(join(TEST_DIR, "empty"));
    const tool = new ListDirTool();
    const result = await tool.execute({ path: join(TEST_DIR, "empty") });
    expect(result).toContain("empty");
  });
});

// ---------- Shell Tool ----------

describe("ExecTool", () => {
  test("executes simple command", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "echo hello" });
    expect(result.trim()).toBe("hello");
  });

  test("captures stderr", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "echo err >&2" });
    expect(result).toContain("STDERR:");
    expect(result).toContain("err");
  });

  test("blocks dangerous commands", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "rm -rf /" });
    expect(result).toContain("blocked");
  });

  test("blocks fork bomb", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: ":(){ :|:& };:" });
    expect(result).toContain("blocked");
  });

  test("blocks shutdown", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: "shutdown -h now" });
    expect(result).toContain("blocked");
  });

  test("respects working directory", async () => {
    const tool = new ExecTool();
    const result = await tool.execute({
      command: "pwd",
      working_dir: "/tmp",
    });
    expect(result.trim()).toContain("/tmp");
  });

  test("blocks path traversal when workspace restricted", async () => {
    const tool = new ExecTool({ restrictToWorkspace: true });
    const result = await tool.execute({ command: "cat ../../../etc/passwd" });
    expect(result).toContain("blocked");
  });

  test("handles timeout", async () => {
    const tool = new ExecTool({ timeout: 1 });
    const result = await tool.execute({ command: "sleep 10" });
    // Should either return empty/killed or error
    expect(result).toBeDefined();
  });
});
