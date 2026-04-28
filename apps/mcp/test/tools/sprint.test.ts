import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSprintTools } from '../../src/tools/sprint.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSprintTools(server);
  return server;
}

describe('Sprint tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_sprint_detail', () => {
    it('returns per-issue breakdown for a sprint', async () => {
      const data = [{ key: 'ACC-1', classification: 'committed', points: 3 }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_sprint_detail', { boardId: 'ACC', sprintId: '42' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/sprints/ACC/42/detail');
    });
  });

  describe('get_sprint_report', () => {
    it('returns composite sprint report', async () => {
      const data = { score: 87, band: 'high', recommendations: [] };
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_sprint_report', { boardId: 'ACC', sprintId: '42' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/sprint-report/ACC/42', {});
    });

    it('passes refresh flag when provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_sprint_report', { boardId: 'ACC', sprintId: '42', refresh: true });
      expect(mockApiGet).toHaveBeenCalledWith('/api/sprint-report/ACC/42', { refresh: true });
    });
  });
});
