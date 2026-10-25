/**
 * agentsfile MCP server. Tool: check_agents_file.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "agentsfile", version: VERSION });

server.tool(
  "check_agents_file",
  "Validate a repo's AGENTS.md and CLAUDE.md (or a single agent instruction file) against the repo itself: backticked paths that do not exist, npm scripts named in the file that package.json does not define, and commands referenced that have no matching bin or script. Verdict VALID, DRIFT, or MISSING with file and line evidence.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
