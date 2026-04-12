import { ConfigService } from '@nestjs/config';
import { JiraClientService } from './jira-client.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfigService(): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockImplementation((key: string, defaultVal?: unknown) => {
      if (key === 'JIRA_BASE_URL') return 'https://example.atlassian.net';
      if (key === 'JIRA_USER_EMAIL') return 'test@example.com';
      if (key === 'JIRA_API_TOKEN') return 'mytoken';
      return defaultVal ?? '';
    }),
  } as unknown as jest.Mocked<ConfigService>;
}

function mockFetch(
  responses: Array<{ status: number; ok: boolean; json?: object; text?: string }>,
): jest.Mock {
  let callCount = 0;
  return jest.fn().mockImplementation(async () => {
    const resp = responses[callCount] ?? responses[responses.length - 1];
    callCount++;
    return {
      status: resp.status,
      ok: resp.ok,
      json: async () => resp.json ?? {},
      text: async () => resp.text ?? '',
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JiraClientService', () => {
  let service: JiraClientService;
  let globalFetch: jest.Mock;

  beforeEach(() => {
    service = new JiraClientService(mockConfigService());
    globalFetch = jest.fn();
    global.fetch = globalFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getBoardsForProject
  // -------------------------------------------------------------------------

  describe('getBoardsForProject', () => {
    it('calls the boards API and returns parsed JSON', async () => {
      const payload = { values: [{ id: 1, name: 'ACC board' }], total: 1 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      const result = await service.getBoardsForProject('ACC');
      expect(result).toEqual(payload);
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/agile/1.0/board?projectKeyOrId=ACC'),
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getSprints
  // -------------------------------------------------------------------------

  describe('getSprints', () => {
    it('calls the sprints API for a given boardId', async () => {
      const payload = { values: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      const result = await service.getSprints('42');
      expect(result).toEqual(payload);
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/agile/1.0/board/42/sprint'),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getSprintIssues
  // -------------------------------------------------------------------------

  describe('getSprintIssues', () => {
    it('calls sprint issues API with startAt param', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      const result = await service.getSprintIssues('42', '7', 50);
      expect(result).toEqual(payload);
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/agile/1.0/board/42/sprint/7/issue'),
        expect.anything(),
      );
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('startAt=50'),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getIssueChangelog
  // -------------------------------------------------------------------------

  describe('getIssueChangelog', () => {
    it('calls changelog API for a given issue key', async () => {
      const payload = { values: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      const result = await service.getIssueChangelog('ACC-123');
      expect(result).toEqual(payload);
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/api/3/issue/ACC-123/changelog'),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getProjectVersions
  // -------------------------------------------------------------------------

  describe('getProjectVersions', () => {
    it('returns project versions array', async () => {
      const payload = [{ id: '10000', name: 'v1.0', releaseDate: '2026-01-01' }];
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      const result = await service.getProjectVersions('ACC');
      expect(result).toEqual(payload);
    });
  });

  // -------------------------------------------------------------------------
  // searchIssues
  // -------------------------------------------------------------------------

  describe('searchIssues', () => {
    it('calls JQL search API with encoded jql param', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.searchIssues('project = ACC');
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/api/3/search/jql'),
        expect.anything(),
      );
    });

    it('includes nextPageToken when provided', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.searchIssues('project = ACC', 0, 100, 'token-abc');
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('nextPageToken=token-abc'),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getJpdIdeas
  // -------------------------------------------------------------------------

  describe('getJpdIdeas', () => {
    it('builds correct URL with base fields', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.getJpdIdeas('ROADMAP');
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('project%3DROADMAP'),
        expect.anything(),
      );
    });

    it('includes extra fields in the request', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.getJpdIdeas('ROADMAP', ['customfield_10020']);
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('customfield_10020'),
        expect.anything(),
      );
    });

    it('includes nextPageToken when provided', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.getJpdIdeas('ROADMAP', [], 'my-token');
      expect(globalFetch).toHaveBeenCalledWith(
        expect.stringContaining('nextPageToken=my-token'),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // fetchWithRetry — rate limit (429) handling
  // -------------------------------------------------------------------------

  describe('fetchWithRetry — 429 rate limit', () => {
    it('retries on 429 and succeeds on the next attempt', async () => {
      const successPayload = { issues: [] };
      let callCount = 0;
      globalFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { status: 429, ok: false, json: async () => ({}), text: async () => '' };
        }
        return { status: 200, ok: true, json: async () => successPayload, text: async () => '' };
      });

      // Override sleep to avoid actual delay
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const result = await service.getSprints('1');
      expect(result).toEqual(successPayload);
      expect(globalFetch).toHaveBeenCalledTimes(2);
    });

    it('throws after MAX_RETRIES (3) consecutive 429s', async () => {
      globalFetch.mockImplementation(async () => ({
        status: 429,
        ok: false,
        json: async () => ({}),
        text: async () => '',
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await expect(service.getSprints('1')).rejects.toThrow(
        /rate limit exceeded after 3 retries/,
      );
      // 1 initial + 3 retries = 4 calls total
      expect(globalFetch).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // fetchWithRetry — non-OK status (not 429)
  // -------------------------------------------------------------------------

  describe('fetchWithRetry — non-OK responses', () => {
    it('throws on 401 without retrying', async () => {
      globalFetch.mockImplementation(async () => ({
        status: 401,
        ok: false,
        json: async () => ({}),
        text: async () => 'Unauthorized',
      }));

      await expect(service.getSprints('1')).rejects.toThrow(/Jira API error 401/);
      expect(globalFetch).toHaveBeenCalledTimes(1);
    });

    it('throws on 500 without retrying', async () => {
      globalFetch.mockImplementation(async () => ({
        status: 500,
        ok: false,
        json: async () => ({}),
        text: async () => 'Internal Server Error',
      }));

      await expect(service.getSprints('1')).rejects.toThrow(/Jira API error 500/);
    });
  });

  // -------------------------------------------------------------------------
  // fetchWithRetry — network errors (TypeError)
  // -------------------------------------------------------------------------

  describe('fetchWithRetry — network errors', () => {
    it('retries on TypeError (network failure) and succeeds', async () => {
      let callCount = 0;
      globalFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new TypeError('Failed to fetch');
        return { status: 200, ok: true, json: async () => ({ issues: [] }), text: async () => '' };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const result = await service.getSprints('1');
      expect(result).toEqual({ issues: [] });
      expect(globalFetch).toHaveBeenCalledTimes(2);
    });

    it('throws after max retries on persistent TypeError', async () => {
      globalFetch.mockImplementation(async () => {
        throw new TypeError('Network offline');
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await expect(service.getSprints('1')).rejects.toThrow(TypeError);
      expect(globalFetch).toHaveBeenCalledTimes(4);
    });

    it('re-throws non-TypeError errors immediately without retry', async () => {
      globalFetch.mockImplementation(async () => {
        throw new Error('Some other error');
      });

      await expect(service.getSprints('1')).rejects.toThrow('Some other error');
      expect(globalFetch).toHaveBeenCalledTimes(1);
    });
  });
});
