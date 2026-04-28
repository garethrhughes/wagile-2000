import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRoadmapTools } from '../../src/tools/roadmap.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerRoadmapTools(server);
  return server;
}

describe('Roadmap tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_roadmap_accuracy', () => {
    it('returns roadmap accuracy data', async () => {
      const data = { coverage: 72, totalIdeas: 14, delivered: 10 };
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_roadmap_accuracy', { quarter: '2026-Q1' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/roadmap/accuracy', { quarter: '2026-Q1' });
    });

    it('passes all optional params when provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_roadmap_accuracy', { boardId: 'ACC', quarter: '2026-Q1', sprintId: '5' });
      expect(mockApiGet).toHaveBeenCalledWith('/api/roadmap/accuracy', {
        boardId: 'ACC',
        quarter: '2026-Q1',
        sprintId: '5',
      });
    });

    it('omits all params when none provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_roadmap_accuracy', {});
      expect(mockApiGet).toHaveBeenCalledWith('/api/roadmap/accuracy', {});
    });
  });
});
