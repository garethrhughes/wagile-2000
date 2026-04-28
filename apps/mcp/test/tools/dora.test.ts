import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess, mockPending } from '../client.mock.js';

// Mock client before importing tools
vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

// Import tool handlers under test
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDoraTools } from '../../src/tools/dora.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerDoraTools(server);
  return server;
}

describe('DORA tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_dora_metrics', () => {
    it('returns JSON text content from the API response', async () => {
      const data = { period: '2026-Q1', deploymentFrequency: { band: 'elite' } };
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_dora_metrics', { quarter: '2026-Q1' });

      expect(result.content[0]?.type).toBe('text');
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/metrics/dora/aggregate', { quarter: '2026-Q1' });
    });

    it('passes boardId and quarter as query params', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_dora_metrics', { boardId: 'ACC,BPT', quarter: '2026-Q2' });
      expect(mockApiGet).toHaveBeenCalledWith('/api/metrics/dora/aggregate', {
        boardId: 'ACC,BPT',
        quarter: '2026-Q2',
      });
    });

    it('returns informational text on 202 Pending response', async () => {
      mockApiGet.mockResolvedValueOnce(mockPending({ status: 'pending' }));
      const server = makeServer();
      const result = await callTool(server, 'get_dora_metrics', {});
      expect(result.content[0]?.text).toContain('still being computed');
    });

    it('omits optional params when not provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess([]));
      const server = makeServer();
      await callTool(server, 'get_dora_metrics', {});
      expect(mockApiGet).toHaveBeenCalledWith('/api/metrics/dora/aggregate', {});
    });
  });

  describe('get_dora_trend', () => {
    it('returns trend data as JSON text', async () => {
      const data = [{ period: '2026-Q1' }, { period: '2025-Q4' }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_dora_trend', { limit: 6 });

      expect(result.content[0]?.type).toBe('text');
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/metrics/dora/trend', { limit: 6 });
    });

    it('passes boardId when provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess([]));
      const server = makeServer();
      await callTool(server, 'get_dora_trend', { boardId: 'ACC', limit: 4 });
      expect(mockApiGet).toHaveBeenCalledWith('/api/metrics/dora/trend', { boardId: 'ACC', limit: 4 });
    });
  });

  describe('get_snapshot_status', () => {
    it('returns snapshot status as JSON text', async () => {
      const data = [{ boardId: 'ACC', stale: false }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_snapshot_status', {});

      expect(result.content[0]?.type).toBe('text');
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/metrics/dora/snapshot/status');
    });
  });
});
