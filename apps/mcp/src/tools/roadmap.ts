import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerRoadmapTools(server: McpServer): void {
  server.tool(
    'get_roadmap_accuracy',
    'Get roadmap coverage accuracy: how many JPD ideas had linked issues completed within their target quarter.',
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

      const result = await apiGet('/api/roadmap/accuracy', params);
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
