import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSyncTools } from '../../src/tools/sync.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSyncTools(server);
  return server;
}

describe('Sync tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_sync_status', () => {
    it('returns sync status for all boards', async () => {
      const data = [
        { boardId: 'ACC', syncedAt: '2026-04-29T08:00:00Z', status: 'success', issueCount: 120 },
      ];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_sync_status', {});

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/sync/status');
    });
  });
});
