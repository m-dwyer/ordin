#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export type ClaudeProviderMcpEntrypoint = never;

type ToolName = "Read" | "Write" | "Edit" | "Glob" | "Grep" | "Bash" | "Skill";

const ToolNameSchema = z.enum(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"]);
const ToolListSchema = z.array(ToolNameSchema);

const toolSchemas: Record<ToolName, z.ZodRawShape> = {
  Read: { file_path: z.string().min(1) },
  Write: { file_path: z.string().min(1), content: z.string() },
  Edit: {
    file_path: z.string().min(1),
    old_string: z.string(),
    new_string: z.string(),
  },
  Glob: { pattern: z.string().min(1) },
  Grep: { pattern: z.string().min(1), path: z.string().optional() },
  Bash: { command: z.string().min(1) },
  Skill: { name: z.string().min(1) },
};

const descriptions: Record<ToolName, string> = {
  Read: "Read a UTF-8 text file from the current workspace.",
  Write: "Write a UTF-8 text file in the current workspace.",
  Edit: "Replace exactly one string occurrence in a workspace file.",
  Glob: "List workspace files matching a glob pattern.",
  Grep: "Search workspace files with a regular expression.",
  Bash: "Run a shell command in the workspace.",
  Skill: "Load a named phase skill.",
};

async function main(): Promise<void> {
  const toolsPath = parseToolsPath(process.argv);
  const tools = ToolListSchema.parse(JSON.parse(await readFile(toolsPath, "utf8")));
  const server = new McpServer({ name: "ordin", version: "0.1.0" });

  for (const tool of tools) {
    server.registerTool(
      tool,
      {
        description: descriptions[tool],
        inputSchema: toolSchemas[tool],
      },
      async () => ({
        content: [
          {
            type: "text",
            text:
              "This MCP server is schema-only. ordin intercepts Claude tool_use events " +
              "and executes tools through its own ToolDispatcher.",
          },
        ],
        isError: true,
      }),
    );
  }

  await server.connect(new StdioServerTransport());
}

function parseToolsPath(argv: readonly string[]): string {
  const ix = argv.indexOf("--tools-json");
  const path = ix >= 0 ? argv[ix + 1] : undefined;
  if (!path) throw new Error("claude-provider-mcp: --tools-json <path> required");
  return path;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[claude-provider-mcp] fatal: ${message}\n`);
  process.exit(1);
});
