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

    it('includes extraFields in the fields param when provided', async () => {
      // Regression test: ACC-44 appeared in "no estimate" because story point
      // fields were missing from the API request. Field IDs are now passed by
      // the caller via extraFields — verify they appear in the outbound URL.
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.getSprintIssues('42', '7', 0, [
        'story_points',
        'customfield_10016',
        'customfield_10028',
      ]);

      const calledUrl: string = globalFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('story_points');
      expect(calledUrl).toContain('customfield_10016');
      expect(calledUrl).toContain('customfield_10028');
    });

    it('omits extra custom fields from the fields param when extraFields is empty', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.getSprintIssues('42', '7');

      const calledUrl: string = globalFetch.mock.calls[0][0] as string;
      // Without extraFields the URL must not contain story-point field IDs
      expect(calledUrl).not.toContain('customfield_10016');
      expect(calledUrl).not.toContain('customfield_10028');
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

    it('includes extraFields in the fields param when provided', async () => {
      // Regression test: Kanban issues also had story points missing because
      // searchIssues (used for Kanban sync) lacked the custom field names.
      // Field IDs are now passed by the caller via extraFields.
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.searchIssues('project = ACC', 0, 100, undefined, [
        'story_points',
        'customfield_10016',
        'customfield_10028',
      ]);

      const calledUrl: string = globalFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('story_points');
      expect(calledUrl).toContain('customfield_10016');
      expect(calledUrl).toContain('customfield_10028');
    });

    it('omits extra custom fields from the fields param when extraFields is empty', async () => {
      const payload = { issues: [], total: 0 };
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => payload,
      }));

      await service.searchIssues('project = ACC');

      const calledUrl: string = globalFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('customfield_10016');
      expect(calledUrl).not.toContain('customfield_10028');
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
          return {
            status: 429, ok: false,
            json: async () => ({}), text: async () => '',
            headers: { get: () => null },
          };
        }
        return {
          status: 200, ok: true,
          json: async () => successPayload, text: async () => '',
          headers: { get: () => null },
        };
      });

      // Override sleep to avoid actual delay
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const result = await service.getSprints('1');
      expect(result).toEqual(successPayload);
      expect(globalFetch).toHaveBeenCalledTimes(2);
    });

    it('throws after MAX_RETRIES (5) consecutive 429s', async () => {
      globalFetch.mockImplementation(async () => ({
        status: 429,
        ok: false,
        json: async () => ({}),
        text: async () => '',
        headers: { get: () => null },
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await expect(service.getSprints('1')).rejects.toThrow(
        /rate limit exceeded after 5 retries/,
      );
      // 1 initial + 5 retries = 6 calls total
      expect(globalFetch).toHaveBeenCalledTimes(6);
    });

    it('uses Retry-After header delay when present on 429', async () => {
      const successPayload = { issues: [] };
      let callCount = 0;
      globalFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 429, ok: false,
            json: async () => ({}), text: async () => '',
            headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '30' : null },
          };
        }
        return {
          status: 200, ok: true,
          json: async () => successPayload, text: async () => '',
          headers: { get: () => null },
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const result = await service.getSprints('1');
      expect(result).toEqual(successPayload);

      // sleep should have been called with 30_000 ms (30 seconds from header)
      const sleepCalls = sleepSpy.mock.calls.filter((args) => (args[0] as number) >= 30000);
      expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
      expect(sleepCalls[0][0]).toBe(30000);
    });

    it('falls back to exponential backoff when Retry-After header is absent', async () => {
      const successPayload = { issues: [] };
      let callCount = 0;
      globalFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 429, ok: false,
            json: async () => ({}), text: async () => '',
            headers: { get: () => null },
          };
        }
        return {
          status: 200, ok: true,
          json: async () => successPayload, text: async () => '',
          headers: { get: () => null },
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getSprints('1');

      // For attempt=0 the exponential backoff delay is BASE_DELAY_MS * 2^0 = 1000 ms
      const rateLimitSleeps = sleepSpy.mock.calls.filter((args) => (args[0] as number) === 1000);
      expect(rateLimitSleeps.length).toBeGreaterThanOrEqual(1);
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
        headers: { get: () => null },
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
        headers: { get: () => null },
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
        return {
          status: 200, ok: true,
          json: async () => ({ issues: [] }), text: async () => '',
          headers: { get: () => null },
        };
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
      // 1 initial + 5 retries = 6 calls total
      expect(globalFetch).toHaveBeenCalledTimes(6);
    });

    it('re-throws non-TypeError errors immediately without retry', async () => {
      globalFetch.mockImplementation(async () => {
        throw new Error('Some other error');
      });

      await expect(service.getSprints('1')).rejects.toThrow('Some other error');
      expect(globalFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency semaphore — MAX_CONCURRENT_REQUESTS = 5
  // -------------------------------------------------------------------------

  describe('concurrency semaphore', () => {
    it('never exceeds MAX_CONCURRENT_REQUESTS (5) simultaneous in-flight requests', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'enforceMinInterval').mockResolvedValue(undefined);

      let maxObservedInFlight = 0;
      let currentInFlight = 0;

      // Each fetch increments a counter, records the peak, then resolves.
      globalFetch.mockImplementation(
        () =>
          new Promise<object>((resolve) => {
            currentInFlight++;
            if (currentInFlight > maxObservedInFlight) {
              maxObservedInFlight = currentInFlight;
            }
            // Resolve on the next microtask so all promises have time to queue.
            Promise.resolve().then(() => {
              currentInFlight--;
              resolve({
                status: 200,
                ok: true,
                json: async () => ({ values: [] }),
                text: async () => '',
                headers: { get: () => null },
              });
            });
          }),
      );

      // Fire 10 concurrent requests (> MAX_CONCURRENT_REQUESTS).
      const requests = Array.from({ length: 10 }, (_, i) =>
        service.getSprints(String(i)),
      );
      await Promise.all(requests);

      expect(maxObservedInFlight).toBeLessThanOrEqual(5);
      expect(globalFetch).toHaveBeenCalledTimes(10);
    });

    it('queued requests are eventually served after in-flight ones complete', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(service as any, 'enforceMinInterval').mockResolvedValue(undefined);

      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ values: [] }),
        text: async () => '',
        headers: { get: () => null },
      }));

      // 8 requests: 5 will run immediately, 3 will queue.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => service.getSprints(String(i))),
      );

      expect(results).toHaveLength(8);
      expect(globalFetch).toHaveBeenCalledTimes(8);
    });
  });

  // -------------------------------------------------------------------------
  // Inter-request interval — MIN_REQUEST_INTERVAL_MS = 100
  // -------------------------------------------------------------------------

  describe('inter-request interval', () => {
    it('calls sleep when consecutive requests arrive faster than MIN_REQUEST_INTERVAL_MS', async () => {
      globalFetch.mockImplementation(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ values: [] }),
        text: async () => '',
        headers: { get: () => null },
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      // Force lastRequestAt to be "now" so the second request arrives too soon.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).lastRequestAt = Date.now();

      await service.getSprints('1');

      // sleep should have been called at least once with a positive value ≤ 100
      const intervalSleeps = sleepSpy.mock.calls.filter(
        (args) => (args[0] as number) > 0 && (args[0] as number) <= 100,
      );
      expect(intervalSleeps.length).toBeGreaterThanOrEqual(1);
    });
  });
});
