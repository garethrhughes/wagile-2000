/** Issue types that are never counted as deliverable work items. */
export const EXCLUDED_ISSUE_TYPES = ['Epic', 'Sub-task', 'Subtask'] as const;

/** Returns true if the issue should be included in flow metrics. */
export function isWorkItem(issueType: string): boolean {
  return !EXCLUDED_ISSUE_TYPES.includes(issueType as typeof EXCLUDED_ISSUE_TYPES[number]);
}
