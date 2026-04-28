import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

function getBaseUrl(): string {
  const url = process.env['API_BASE_URL'];
  if (!url) {
    throw new McpError(
      ErrorCode.InternalError,
      'API_BASE_URL environment variable is not set',
    );
  }
  return url.replace(/\/$/, '');
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const apiKey = process.env['API_KEY'];
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const base = getBaseUrl();
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function apiGet<T = unknown>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<ApiResponse<T>> {
  const url = buildUrl(path, params);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, `Network error calling ${path}: ${message}`);
  }

  if (response.status === 202) {
    const data = await response.json() as T;
    return { status: 202, data };
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { message?: string };
      if (body.message) {
        message = `HTTP ${response.status}: ${body.message}`;
      }
    } catch {
      // ignore JSON parse errors for error bodies
    }
    throw new McpError(ErrorCode.InternalError, message);
  }

  const data = await response.json() as T;
  return { status: response.status, data };
}
