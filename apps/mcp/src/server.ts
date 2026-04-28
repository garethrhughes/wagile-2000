import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerDoraTools } from './tools/dora.js';
import { registerPlanningTools } from './tools/planning.js';
import { registerCycleTimeTools } from './tools/cycle-time.js';
import { registerRoadmapTools } from './tools/roadmap.js';
import { registerBoardsTools } from './tools/boards.js';
import { registerSyncTools } from './tools/sync.js';
import { registerSprintTools } from './tools/sprint.js';
import { registerGapsTools } from './tools/gaps.js';
import { registerBoardsResource } from './resources/boards.js';
import { registerPrompts } from './prompts/index.js';

const MCP_SERVER_VERSION = process.env['npm_package_version'] ?? '0.0.0';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'fragile',
    version: MCP_SERVER_VERSION,
  });

  // Register all tools
  registerDoraTools(server);
  registerPlanningTools(server);
  registerCycleTimeTools(server);
  registerRoadmapTools(server);
  registerBoardsTools(server);
  registerSyncTools(server);
  registerSprintTools(server);
  registerGapsTools(server);

  // Register resources
  registerBoardsResource(server, ResourceTemplate);

  // Register prompt templates
  registerPrompts(server);

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
