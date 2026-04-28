import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';

export function registerDoraTools(server: McpServer): void {
  server.tool(
    'get_dora_metrics',
    'Get aggregated org-level or per-board DORA metrics for a calendar quarter.',
    {
      boardId: z.string().optional().describe('Comma-separated board IDs, e.g. "ACC,BPT"'),
      quarter: z.string().optional().describe('Target quarter in YYYY-QN format, e.g. "2026-Q2"'),
    },
    async ({ boardId, quarter }) => {
      const params: Record<string, string | undefined> = {};
      if (boardId) params['boardId'] = boardId;
      if (quarter) params['quarter'] = quarter;

      const result = await apiGet('/api/metrics/dora/aggregate', params);

      if (result.status === 202) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'DORA snapshot is still being computed. Please try again in a few moments.',
            },
          ],
        };
      }

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
    'get_dora_trend',
    'Get DORA metrics across multiple consecutive quarters to show trajectory.',
    {
      boardId: z.string().optional().describe('Comma-separated board IDs'),
      limit: z.number().int().positive().optional().default(6).describe('Number of quarters to return (default 6)'),
    },
    async ({ boardId, limit }) => {
      const params: Record<string, string | number | undefined> = {};
      if (boardId) params['boardId'] = boardId;
      if (limit !== undefined) params['limit'] = limit;

      const result = await apiGet('/api/metrics/dora/trend', params);
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
    'get_snapshot_status',
    'Check whether DORA snapshots have been computed for each board.',
    {},
    async () => {
      const result = await apiGet('/api/metrics/dora/snapshot/status');
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
