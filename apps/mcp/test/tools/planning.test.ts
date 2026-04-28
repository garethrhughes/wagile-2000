import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPlanningTools } from '../../src/tools/planning.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerPlanningTools(server);
  return server;
}

describe('Planning tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_planning_accuracy', () => {
    it('returns planning accuracy data for a board and sprint', async () => {
      const data = { completionRate: 85, scopeChange: 10 };
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_planning_accuracy', { boardId: 'ACC', sprintId: '42' });

      expect(result.content[0]?.type).toBe('text');
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/planning/accuracy', { boardId: 'ACC', sprintId: '42' });
    });

    it('passes quarter when provided', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_planning_accuracy', { boardId: 'BPT', quarter: '2026-Q1' });
      expect(mockApiGet).toHaveBeenCalledWith('/api/planning/accuracy', { boardId: 'BPT', quarter: '2026-Q1' });
    });

    it('re-raises 400 Kanban error as descriptive McpError', async () => {
      mockApiGet.mockRejectedValueOnce(
        new McpError(-32603, 'HTTP 400: Planning accuracy is not available for Kanban boards'),
      );
      const server = makeServer();
      const result = await callTool(server, 'get_planning_accuracy', { boardId: 'PLAT' });
      // The SDK surfaces tool-thrown McpErrors as isError content rather than rejecting
      expect((result as unknown as { isError: boolean }).isError).toBe(true);
      expect(result.content[0]?.text).toContain('Planning accuracy is not available for Kanban boards');
    });

    it('does not swallow non-Kanban 400 errors', async () => {
      // A generic 400 (e.g. unknown boardId) must pass through with its original message
      mockApiGet.mockRejectedValueOnce(
        new McpError(-32603, 'HTTP 400: boardId not found'),
      );
      const server = makeServer();
      const result = await callTool(server, 'get_planning_accuracy', { boardId: 'UNKNOWN' });
      expect((result as unknown as { isError: boolean }).isError).toBe(true);
      expect(result.content[0]?.text).toContain('HTTP 400: boardId not found');
    });
  });

  describe('list_sprints', () => {
    it('returns sprint list for a board', async () => {
      const data = [{ id: 1, name: 'Sprint 1', state: 'closed' }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'list_sprints', { boardId: 'ACC' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/planning/sprints', { boardId: 'ACC' });
    });
  });

  describe('list_quarters', () => {
    it('returns available quarters', async () => {
      const data = ['2025-Q3', '2025-Q4', '2026-Q1'];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'list_quarters', {});

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/planning/quarters');
    });
  });
});
