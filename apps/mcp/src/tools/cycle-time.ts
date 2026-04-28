import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerCycleTimeTools(server: McpServer): void {
  server.tool(
    'get_cycle_time',
    'Get cycle time observations and percentiles (median, p95) for a board and period.',
    {
      boardId: z.string().describe('Board identifier'),
      quarter: z.string().optional().describe('Quarter in YYYY-QN format'),
      issueType: z.string().optional().describe('Filter by issue type'),
    },
    async ({ boardId, quarter, issueType }) => {
      const params: Record<string, string | undefined> = {};
      if (quarter) params['quarter'] = quarter;
      if (issueType) params['issueType'] = issueType;

      const result = await apiGet(`/api/cycle-time/${encodeURIComponent(boardId)}`, params);
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
    'get_cycle_time_trend',
    'Get cycle time trend across multiple periods.',
    {
      boardId: z.string().optional().describe('Board identifier'),
      mode: z.enum(['quarters', 'sprints']).optional().describe('Aggregation mode'),
      limit: z.number().int().positive().optional().describe('Number of periods to return'),
    },
    async ({ boardId, mode, limit }) => {
      const params: Record<string, string | number | undefined> = {};
      if (boardId) params['boardId'] = boardId;
      if (mode) params['mode'] = mode;
      if (limit !== undefined) params['limit'] = limit;

      const result = await apiGet('/api/cycle-time/trend', params);
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
