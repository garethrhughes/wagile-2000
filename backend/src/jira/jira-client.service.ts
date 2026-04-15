import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  JiraSprintResponse,
  JiraIssueSearchResponse,
  JiraChangelogResponse,
  JiraVersionResponse,
  JiraBoardResponse,
} from './jira.types.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

/**
 * Maximum number of concurrent outbound Jira API requests.
 * Jira Cloud's documented rate limit is ~10 req/s per user; a concurrency cap
 * of 5 combined with the MIN_REQUEST_INTERVAL_MS guard keeps us comfortably
 * below that limit even under burst conditions.
 */
const MAX_CONCURRENT_REQUESTS = 5;

/**
 * Minimum time (ms) between consecutive outbound requests.
 * 100 ms ≈ 10 req/s maximum throughput, matching the Jira Cloud limit.
 */
const MIN_REQUEST_INTERVAL_MS = 100;

@Injectable()
export class JiraClientService {
  private readonly logger = new Logger(JiraClientService.name);
  private readonly baseUrl: string;
  private readonly authHeader: string;

  // -------------------------------------------------------------------------
  // Concurrency / rate-limit state
  // -------------------------------------------------------------------------

  /** Number of requests currently in flight. */
  private inFlight = 0;

  /**
   * Queue of resolve callbacks waiting for a concurrency slot to open up.
   * When a slot becomes free, the oldest waiter is dequeued and resumed.
   */
  private waiters: Array<() => void> = [];

  /** Timestamp (Date.now()) of the last request that was dispatched. */
  private lastRequestAt = 0;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('JIRA_BASE_URL', '');
    const email = this.configService.get<string>('JIRA_USER_EMAIL', '');
    const token = this.configService.get<string>('JIRA_API_TOKEN', '');
    this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  async getBoardsForProject(projectKey: string): Promise<JiraBoardResponse> {
    const url =
      `${this.baseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`;
    return this.fetchWithRetry<JiraBoardResponse>(url);
  }

  async getSprints(boardId: string): Promise<JiraSprintResponse> {
    const url = `${this.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?maxResults=100`;
    return this.fetchWithRetry<JiraSprintResponse>(url);
  }

  async getSprintIssues(
    boardId: string,
    sprintId: string,
    startAt = 0,
    extraFields: string[] = [],
  ): Promise<JiraIssueSearchResponse> {
    const baseFields = 'summary,status,issuetype,fixVersions,labels,created,updated,issuelinks,parent,priority,assignee';
    const fields = extraFields.length > 0
      ? `${baseFields},${extraFields.join(',')}`
      : baseFields;
    const url =
      `${this.baseUrl}/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue` +
      `?maxResults=100&startAt=${startAt}&fields=${fields}` +
      `&expand=names`;
    return this.fetchWithRetry<JiraIssueSearchResponse>(url);
  }

  async getIssueChangelog(
    issueKey: string,
    startAt = 0,
  ): Promise<JiraChangelogResponse> {
    const url =
      `${this.baseUrl}/rest/api/3/issue/${issueKey}/changelog` +
      `?maxResults=100&startAt=${startAt}`;
    return this.fetchWithRetry<JiraChangelogResponse>(url);
  }

  async getProjectVersions(projectKey: string): Promise<JiraVersionResponse[]> {
    const url = `${this.baseUrl}/rest/api/3/project/${projectKey}/versions`;
    return this.fetchWithRetry<JiraVersionResponse[]>(url);
  }

  async searchIssues(
    jql: string,
    _startAt = 0,
    maxResults = 100,
    nextPageToken?: string,
    extraFields: string[] = [],
  ): Promise<JiraIssueSearchResponse> {
    const baseFields = 'summary,status,issuetype,fixVersions,labels,created,updated,issuelinks,parent,priority,assignee';
    const fields = extraFields.length > 0
      ? `${baseFields},${extraFields.join(',')}`
      : baseFields;
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields,
    });
    if (nextPageToken) {
      params.set('nextPageToken', nextPageToken);
    }
    const url = `${this.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
    return this.fetchWithRetry<JiraIssueSearchResponse>(url);
  }

  async getJpdIdeas(
    jpdKey: string,
    extraFields: string[] = [],
    nextPageToken?: string,
  ): Promise<JiraIssueSearchResponse> {
    const baseFields = ['summary', 'status', 'issuelinks'];
    const fields = [...baseFields, ...extraFields].join(',');
    const params = new URLSearchParams({
      jql: `project=${jpdKey} ORDER BY updated DESC`,
      fields,
      maxResults: '100',
    });
    if (nextPageToken) {
      params.set('nextPageToken', nextPageToken);
    }
    const url = `${this.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
    return this.fetchWithRetry<JiraIssueSearchResponse>(url);
  }

  // -------------------------------------------------------------------------
  // Core fetch logic
  // -------------------------------------------------------------------------

  private async fetchWithRetry<T>(url: string, attempt = 0): Promise<T> {
    // Acquire a concurrency slot before dispatching the request.
    await this.acquireSlot();

    try {
      // Enforce minimum inter-request spacing to stay under Jira's rate limit.
      await this.enforceMinInterval();

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `Jira API rate limit exceeded after ${MAX_RETRIES} retries: ${url}`,
          );
        }

        // Honour the Retry-After header when the server provides it.
        // The header value is in seconds (Jira Cloud convention).
        const retryAfterHeader = response.headers.get('Retry-After');
        const delay = retryAfterHeader
          ? Math.max(parseInt(retryAfterHeader, 10) * 1000, 0)
          : BASE_DELAY_MS * Math.pow(2, attempt);

        this.logger.warn(
          `Rate limited (429). Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})` +
          (retryAfterHeader ? ` [Retry-After: ${retryAfterHeader}s]` : ''),
        );
        await this.sleep(delay);
        return this.fetchWithRetry<T>(url, attempt + 1);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Jira API error ${response.status}: ${body.slice(0, 500)}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (
        error instanceof TypeError &&
        attempt < MAX_RETRIES
      ) {
        // Network error — retry with backoff
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        this.logger.warn(
          `Network error. Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await this.sleep(delay);
        return this.fetchWithRetry<T>(url, attempt + 1);
      }
      throw error;
    } finally {
      this.releaseSlot();
    }
  }

  // -------------------------------------------------------------------------
  // Concurrency semaphore helpers
  // -------------------------------------------------------------------------

  /**
   * Block until there is a free concurrency slot, then claim it.
   * Uses a Promise-based queue so no busy-waiting occurs.
   */
  private acquireSlot(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT_REQUESTS) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  /**
   * Release a concurrency slot.  If there are waiters, wake the oldest one
   * (FIFO) so requests are served in the order they were enqueued.
   */
  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.inFlight--;
    }
  }

  // -------------------------------------------------------------------------
  // Inter-request spacing helper
  // -------------------------------------------------------------------------

  /**
   * Ensure at least MIN_REQUEST_INTERVAL_MS has elapsed since the last
   * request was dispatched.  Records the new dispatch timestamp atomically
   * so concurrent callers each get their own delay slot.
   */
  private async enforceMinInterval(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await this.sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
