import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBoardsTools } from '../../src/tools/boards.js';
import { callTool } from '../test-helpers.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerBoardsTools(server);
  return server;
}

describe('Boards tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_boards', () => {
    it('returns all boards', async () => {
      const data = [{ boardId: 'ACC', boardType: 'scrum' }, { boardId: 'PLAT', boardType: 'kanban' }];
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'list_boards', {});

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/boards');
    });
  });

  describe('get_board_config', () => {
    it('returns board config for a given boardId', async () => {
      const data = { boardId: 'ACC', doneStatusNames: ['Done', 'Closed'] };
      mockApiGet.mockResolvedValueOnce(mockSuccess(data));

      const server = makeServer();
      const result = await callTool(server, 'get_board_config', { boardId: 'ACC' });

      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(data);
      expect(mockApiGet).toHaveBeenCalledWith('/api/boards/ACC/config');
    });

    it('URL-encodes boardId in the path', async () => {
      mockApiGet.mockResolvedValueOnce(mockSuccess({}));
      const server = makeServer();
      await callTool(server, 'get_board_config', { boardId: 'MY BOARD' });
      expect(mockApiGet).toHaveBeenCalledWith('/api/boards/MY%20BOARD/config');
    });
  });
});
