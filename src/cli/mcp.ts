import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Command } from "commander";
import { createMcpServer } from "../mcp/server";
import { RunService } from "../run-service/run-service";
import { styled } from "./tui/print";
import { PALETTE } from "./tui/theme";

/**
 * `ordin mcp` — boots the MCP server over stdio. MCP hosts (Claude
 * Code, Cursor, Claude Desktop, …) launch this as a subprocess and
 * speak JSON-RPC over stdin/stdout, so logging must go to stderr only.
 *
 * Lifecycle messages are written through `styled()` instead of the
 * `print.ts` helpers because those write to stdout, which would
 * corrupt the JSON-RPC stream. `styled()` returns ANSI-or-plain based
 * on the same NO_COLOR / TTY rules as the rest of the CLI.
 */
export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("Run the MCP server over stdio (launched as a subprocess by an MCP host)")
    .action(async () => {
      const service = new RunService();
      const server = createMcpServer(service);
      const transport = new StdioServerTransport();

      const closed = new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
      });

      const stop = async (signal: NodeJS.Signals) => {
        process.stderr.write(`\n${styled(`mcp · received ${signal}, closing`, PALETTE.hint)}\n`);
        await server.close();
        process.exit(0);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      await server.connect(transport);
      process.stderr.write(
        `${styled("✓", PALETTE.done)}  ${styled("mcp connected (stdio)", PALETTE.text)}\n`,
      );

      await closed;
    });
}
