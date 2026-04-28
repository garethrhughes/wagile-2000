import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface McpServerInternal {
  _registeredTools: Record<string, RegisteredTool>;
}

export async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const internal = server as unknown as McpServerInternal;
  const tool = internal._registeredTools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler(args) as Promise<{ content: Array<{ type: string; text: string }> }>;
}
