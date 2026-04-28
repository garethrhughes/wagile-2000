import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGapsTools } from '../../src/tools/gaps.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerGapsTools(server);
  return server;
}

describe('Gaps tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_hygiene_gaps', () => {
    it('returns hygiene gaps for all boards', async () => {
      const data = [{ boardId: 'ACC', missingEpic: ['ACC-101'], missingPoints: ['ACC-102'] }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_hygiene_gaps', {});

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/gaps');
    });
  });

  describe('get_unplanned_done', () => {
    it('returns unplanned done issues', async () => {
      const data = [{ boardId: 'ACC', issues: ['ACC-99'] }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_unplanned_done', { boardId: 'ACC', quarter: '2026-Q1' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/gaps/unplanned-done', {
        boardId: 'ACC',
        quarter: '2026-Q1',
      });
    });

    it('omits optional params when not provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess([]));
      const server = makeServer();
      await callTool(server, 'get_unplanned_done', {});
      expect(mockApiGet).toHaveBeenCalledWith('/api/gaps/unplanned-done', {});
    });
  });
});
