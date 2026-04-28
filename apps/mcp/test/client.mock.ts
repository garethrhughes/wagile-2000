import { vi } from 'vitest';
import type { ApiResponse } from '../src/client.js';

export const mockApiGet = vi.fn<
  [string, (Record<string, string | number | boolean | undefined> | undefined)?],
  Promise<ApiResponse<unknown>>
>();

export function mockSuccess<T>(data: T, status = 200): ApiResponse<T> {
  return { status, data };
}

export function mockPending<T>(data: T): ApiResponse<T> {
  return { status: 202, data };
}
