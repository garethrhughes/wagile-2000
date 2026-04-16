import { describe, it, expect } from 'vitest'
import { getQuarterKey, getCurrentQuarterKey } from './quarter-utils'

describe('getQuarterKey', () => {
  it('returns null for null input', () => {
    expect(getQuarterKey(null, 'UTC')).toBeNull()
  })

  it('returns null for an invalid ISO date string', () => {
    expect(getQuarterKey('not-a-date', 'UTC')).toBeNull()
    expect(getQuarterKey('', 'UTC')).toBeNull()
  })

  it('returns Q1 for January', () => {
    expect(getQuarterKey('2025-01-15', 'UTC')).toBe('2025-Q1')
  })

  it('returns Q1 for March (boundary)', () => {
    expect(getQuarterKey('2025-03-31', 'UTC')).toBe('2025-Q1')
  })

  it('returns Q2 for April (boundary)', () => {
    expect(getQuarterKey('2025-04-01', 'UTC')).toBe('2025-Q2')
  })

  it('returns Q3 for July', () => {
    expect(getQuarterKey('2025-07-04', 'UTC')).toBe('2025-Q3')
  })

  it('returns Q4 for December', () => {
    expect(getQuarterKey('2025-12-31', 'UTC')).toBe('2025-Q4')
  })

  it('does not throw for an invalid timezone — falls back to UTC', () => {
    expect(() => getQuarterKey('2025-04-01', 'Not/A/Timezone')).not.toThrow()
    // April is Q2 in UTC as well, so result should still be deterministic
    expect(getQuarterKey('2025-04-01', 'Not/A/Timezone')).toBe('2025-Q2')
  })

  it('handles a valid named timezone without throwing', () => {
    expect(() => getQuarterKey('2025-01-01', 'America/New_York')).not.toThrow()
    // Jan 1 at midnight UTC is still Jan 1 in New York (offset is negative)
    expect(getQuarterKey('2025-01-01T12:00:00Z', 'America/New_York')).toBe('2025-Q1')
  })
})

describe('getCurrentQuarterKey', () => {
  it('returns a string matching YYYY-QN format', () => {
    const result = getCurrentQuarterKey('UTC')
    expect(result).toMatch(/^\d{4}-Q[1-4]$/)
  })

  it('does not throw for an invalid timezone — falls back to UTC', () => {
    expect(() => getCurrentQuarterKey('Invalid/Zone')).not.toThrow()
    expect(getCurrentQuarterKey('Invalid/Zone')).toMatch(/^\d{4}-Q[1-4]$/)
  })
})
