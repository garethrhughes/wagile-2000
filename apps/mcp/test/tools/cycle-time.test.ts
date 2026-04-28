import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCycleTimeTools } from '../../src/tools/cycle-time.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCycleTimeTools(server);
  return server;
}

describe('Cycle-time tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_cycle_time', () => {
    it('returns cycle time percentiles for a board', async () => {
      const data = { median: 3.5, p95: 12, band: 'high' };
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_cycle_time', { boardId: 'ACC', quarter: '2026-Q1' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/cycle-time/ACC', { quarter: '2026-Q1' });
    });

    it('includes issueType filter when provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_cycle_time', { boardId: 'BPT', issueType: 'Story' });
      expect(mockApiGet).toHaveBeenCalledWith('/api/cycle-time/BPT', { issueType: 'Story' });
    });
  });

  describe('get_cycle_time_trend', () => {
    it('returns cycle time trend data', async () => {
      const data = [{ quarter: '2026-Q1', median: 3 }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_cycle_time_trend', { boardId: 'ACC', mode: 'quarters', limit: 4 });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/cycle-time/trend', {
        boardId: 'ACC',
        mode: 'quarters',
        limit: 4,
      });
    });

    it('omits optional params when not provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess([]));
      const server = makeServer();
      await callTool(server, 'get_cycle_time_trend', {});
      expect(mockApiGet).toHaveBeenCalledWith('/api/cycle-time/trend', {});
    });
  });
});
