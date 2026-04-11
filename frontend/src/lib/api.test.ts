import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from './api';

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
});
