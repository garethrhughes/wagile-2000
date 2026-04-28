import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerSprintTools(server: McpServer): void {
  server.tool(
    'get_sprint_detail',
    'Get an annotated ticket-level breakdown for a specific sprint (classification: committed, added, removed, completed, carry-over).',
    {
      boardId: z.string().describe('Board identifier'),
      sprintId: z.string().describe('Sprint ID'),
    },
    async ({ boardId, sprintId }) => {
      const result = await apiGet(
        `/api/sprints/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}/detail`,
      );
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
    'get_sprint_report',
    'Get the composite sprint report with scoring and recommendations for a sprint.',
    {
      boardId: z.string().describe('Board identifier'),
      sprintId: z.string().describe('Sprint ID'),
      refresh: z.boolean().optional().describe('Force refresh of cached report'),
    },
    async ({ boardId, sprintId, refresh }) => {
      const params: Record<string, boolean | undefined> = {};
      if (refresh !== undefined) params['refresh'] = refresh;

      const result = await apiGet(
        `/api/sprint-report/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}`,
        params,
      );
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
