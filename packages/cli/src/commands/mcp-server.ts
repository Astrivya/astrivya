import { runHttpServer, runStdioServer } from "@astrivya/mcp-server";
import type { Command } from "commander";

export function registerMcpServer(program: Command): void {
  program
    .command("mcp-server")
    .description("Run the Astrivya MCP server (stdio or SSE)")
    .option("--sse", "Run as SSE (Server-Sent Events) server instead of stdio")
    .option("-p, --port <number>", "Port for SSE server", "3001")
    .action(async (options) => {
      if (options.sse) {
        await runHttpServer(Number.parseInt(options.port, 10));
      } else {
        await runStdioServer();
      }
    });
}
