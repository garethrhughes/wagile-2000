import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerGapsTools(server: McpServer): void {
  server.tool(
    'get_hygiene_gaps',
    'List issues in active sprints that are missing an epic link or story points.',
    {},
    async () => {
      const result = await apiGet('/api/gaps');
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
    'get_unplanned_done',
    'List issues resolved in a period that were never planned (never boarded, for Scrum never in a sprint).',
    {
      boardId: z.string().optional().describe('Board identifier'),
      quarter: z.string().optional().describe('Quarter in YYYY-QN format'),
      sprintId: z.string().optional().describe('Sprint ID'),
    },
    async ({ boardId, quarter, sprintId }) => {
      const params: Record<string, string | undefined> = {};
      if (boardId) params['boardId'] = boardId;
      if (quarter) params['quarter'] = quarter;
      if (sprintId) params['sprintId'] = sprintId;

      const result = await apiGet('/api/gaps/unplanned-done', params);
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
