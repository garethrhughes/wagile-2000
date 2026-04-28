import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerPlanningTools(server: McpServer): void {
  server.tool(
    'get_planning_accuracy',
    'Get sprint planning accuracy metrics (commitment, added, removed, completed, scope change %, completion rate) for a Scrum board sprint or quarter.',
    {
      boardId: z.string().describe('Board identifier, e.g. "ACC"'),
      sprintId: z.string().optional().describe('Sprint ID'),
      quarter: z.string().optional().describe('Quarter in YYYY-QN format'),
    },
    async ({ boardId, sprintId, quarter }) => {
      const params: Record<string, string | undefined> = { boardId };
      if (sprintId) params['sprintId'] = sprintId;
      if (quarter) params['quarter'] = quarter;

      try {
        const result = await apiGet('/api/planning/accuracy', params);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      } catch (err) {
        if (
          err instanceof McpError &&
          err.message.includes('Planning accuracy is not available for Kanban boards')
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Planning accuracy is not available for Kanban boards.',
          );
        }
        throw err;
      }
    },
  );

  server.tool(
    'list_sprints',
    'List available sprints for a board (name, state, dates).',
    {
      boardId: z.string().describe('Board identifier'),
    },
    async ({ boardId }) => {
      const result = await apiGet('/api/planning/sprints', { boardId });
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
    'list_quarters',
    'List all quarters derived from sprint data across all boards.',
    {},
    async () => {
      const result = await apiGet('/api/planning/quarters');
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
