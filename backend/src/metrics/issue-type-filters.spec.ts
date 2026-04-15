import { isWorkItem } from './issue-type-filters.js';

describe('isWorkItem', () => {
  it('returns true for a Story', () => {
    expect(isWorkItem('Story')).toBe(true);
  });

  it('returns true for a Task', () => {
    expect(isWorkItem('Task')).toBe(true);
  });

  it('returns true for a Bug', () => {
    expect(isWorkItem('Bug')).toBe(true);
  });

  it('returns false for Epic', () => {
    expect(isWorkItem('Epic')).toBe(false);
  });

  it('returns false for Sub-task (classic Jira)', () => {
    expect(isWorkItem('Sub-task')).toBe(false);
  });

  it('returns false for Subtask (next-gen Jira) — B-1 fix', () => {
    // Next-gen Jira uses 'Subtask' (no hyphen). Without B-1 fix this returns true.
    expect(isWorkItem('Subtask')).toBe(false);
  });
});
