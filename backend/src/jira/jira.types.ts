export interface JiraSprintResponse {
  maxResults: number;
  startAt: number;
  isLast: boolean;
  values: JiraSprintValue[];
}

export interface JiraSprintValue {
  id: number;
  self: string;
  state: string;
  name: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId: number;
}

export interface JiraParentField {
  key: string;
  fields: { issuetype: { name: string } };
}

export interface JiraIssueSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssueValue[];
  nextPageToken?: string;
}

export interface JiraIssueValue {
  key: string;
  fields: {
    summary: string;
    status: { id: string; name: string };
    issuetype: { name: string };
    fixVersions: { id: string; name: string; releaseDate?: string; released?: boolean }[];
    [customField: string]: unknown;
    labels: string[];
    created: string;
    updated: string;
    issuelinks?: JiraIssueLink[];
    parent?: JiraParentField;
    priority?: { name: string };
    assignee?: { displayName: string } | null;
  };
}

export interface JiraIssueLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string; fields: { issuetype: { name: string } } };
  outwardIssue?: { key: string; fields: { issuetype: { name: string } } };
}

export interface JiraChangelogResponse {
  startAt: number;
  maxResults: number;
  total: number;
  values: JiraChangelogEntry[];
}

export interface JiraChangelogEntry {
  id: string;
  created: string;
  items: JiraChangelogItem[];
}

export interface JiraChangelogItem {
  field: string;
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface JiraVersionResponse {
  self: string;
  id: string;
  name: string;
  archived: boolean;
  released: boolean;
  releaseDate?: string;
  projectId?: number;
}

export interface JiraBoardResponse {
  maxResults: number;
  startAt: number;
  total: number;
  isLast: boolean;
  values: JiraBoardValue[];
}

export interface JiraBoardValue {
  id: number;
  self: string;
  name: string;
  type: string;
  location?: {
    projectId: number;
    projectName: string;
    projectKey: string;
    projectTypeKey: string;
  };
}

export interface JiraStoryPointField {
  fieldId: string;
  value: number | null;
}

export interface JiraBoardSprintIssuesResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssueValue[];
}
