import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { apiGet } from '../client.js';

export function registerBoardsResource(
  server: McpServer,
  _ResourceTemplate: typeof ResourceTemplate,
): void {
  // Static resource: boards://list
  server.resource(
    'boards-list',
    'boards://list',
    {
      description: 'Machine-readable summary of all configured boards (boardId, boardType, doneStatusNames).',
      mimeType: 'application/json',
    },
    async (_uri) => {
      const result = await apiGet('/api/boards');
      return {
        contents: [
          {
            uri: 'boards://list',
            mimeType: 'application/json',
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );

  // Template resource: boards://{boardId}/config
  const template = new _ResourceTemplate('boards://{boardId}/config', { list: undefined });
  server.resource(
    'board-config',
    template,
    {
      description: 'Full configuration for a single board (done status names, CFR/MTTR rules, etc.).',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const boardId = variables['boardId'];
      if (!boardId) {
        throw new McpError(ErrorCode.InvalidParams, 'boardId is required');
      }
      const result = await apiGet(`/api/boards/${encodeURIComponent(String(boardId))}/config`);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );
}
