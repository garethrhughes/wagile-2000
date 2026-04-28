import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerBoardsTools(server: McpServer): void {
  server.tool(
    'list_boards',
    'List all configured boards with their type (scrum/kanban) and key settings.',
    {},
    async () => {
      const result = await apiGet('/api/boards');
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

  server.tool(
    'get_board_config',
    'Get the full configuration for a single board (done status names, CFR/MTTR rules, etc.).',
    {
      boardId: z.string().describe('Board identifier, e.g. "ACC"'),
    },
    async ({ boardId }) => {
      const result = await apiGet(`/api/boards/${encodeURIComponent(boardId)}/config`);
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
