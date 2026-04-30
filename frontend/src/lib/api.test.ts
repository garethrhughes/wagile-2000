import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError, getDoraAggregate, getDoraTrend } from './api';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('apiFetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('is a function', () => {
    expect(typeof apiFetch).toBe('function');
  });

  it('sends Content-Type header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    await apiFetch('/api/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('throws ApiError on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not found'),
    });

    try {
      await apiFetch('/api/missing');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });

  it('passes next.revalidate option through when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await apiFetch('/api/test', { next: { revalidate: 60 } } as RequestInit & { next?: { revalidate?: number } });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { next?: { revalidate?: number } }];
    expect(options.next?.revalidate).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// DORA endpoint caching options
// ---------------------------------------------------------------------------

describe('getDoraAggregate', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });

  it('passes next.revalidate: 60 to fetch for cache-friendly reads', async () => {
    await getDoraAggregate({ boardId: 'ACC' });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { next?: { revalidate?: number } }];
    expect(options.next?.revalidate).toBe(60);
  });
});

describe('getDoraTrend', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it('passes next.revalidate: 60 to fetch for cache-friendly reads', async () => {
    await getDoraTrend({ boardId: 'ACC', limit: 8 });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { next?: { revalidate?: number } }];
    expect(options.next?.revalidate).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Sprint mode params — getDoraTrend and getDoraAggregate
// ---------------------------------------------------------------------------

describe('getDoraTrend — sprint mode params', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it('includes sprintId in query string when provided', async () => {
    await getDoraTrend({ boardId: 'ACC', limit: 8, sprintId: 'sprint-42', mode: 'sprint' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('sprintId=sprint-42');
    expect(url).toContain('mode=sprint');
  });

  it('does not include sprintId in query string when omitted', async () => {
    await getDoraTrend({ boardId: 'ACC', limit: 8 });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).not.toContain('sprintId=');
    expect(url).not.toContain('mode=');
  });
});

describe('getDoraAggregate — sprint mode params', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });

  it('includes sprintId in query string when provided', async () => {
    await getDoraAggregate({ boardId: 'ACC', sprintId: 'sprint-7' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('sprintId=sprint-7');
  });

  it('does not include sprintId when omitted', async () => {
    await getDoraAggregate({ boardId: 'ACC' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).not.toContain('sprintId=');
  });
});
