import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  JiraSprintResponse,
  JiraIssueSearchResponse,
  JiraChangelogResponse,
  JiraVersionResponse,
  JiraBoardResponse,
} from './jira.types.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

@Injectable()
export class JiraClientService {
  private readonly logger = new Logger(JiraClientService.name);
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('JIRA_BASE_URL', '');
    const email = this.configService.get<string>('JIRA_USER_EMAIL', '');
    const token = this.configService.get<string>('JIRA_API_TOKEN', '');
    this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

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
  ): Promise<JiraIssueSearchResponse> {
    const url =
      `${this.baseUrl}/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue` +
      `?maxResults=100&startAt=${startAt}&fields=summary,status,issuetype,fixVersions,labels,created,updated,issuelinks,parent,priority,assignee` +
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
  ): Promise<JiraIssueSearchResponse> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: 'summary,status,issuetype,fixVersions,labels,created,updated,issuelinks,parent,priority,assignee',
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

  private async fetchWithRetry<T>(url: string, attempt = 0): Promise<T> {
    try {
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
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        this.logger.warn(
          `Rate limited (429). Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
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
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
