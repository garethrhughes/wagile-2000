import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet } from '../client.js';

export function registerSyncTools(server: McpServer): void {
  server.tool(
    'get_sync_status',
    'Check when each board was last synced and whether any sync is in progress.',
    {},
    async () => {
      const result = await apiGet('/api/sync/status');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );
}
