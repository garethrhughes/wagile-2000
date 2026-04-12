import { classifyCycleTime, cycleTimeBandColor } from './cycle-time-bands.js';

describe('classifyCycleTime', () => {
  it('returns "excellent" for median <= 2 days', () => {
    expect(classifyCycleTime(0)).toBe('excellent');
    expect(classifyCycleTime(1)).toBe('excellent');
    expect(classifyCycleTime(2)).toBe('excellent');
  });

  it('returns "good" for median <= 5 days (but > 2)', () => {
    expect(classifyCycleTime(2.1)).toBe('good');
    expect(classifyCycleTime(3)).toBe('good');
    expect(classifyCycleTime(5)).toBe('good');
  });

  it('returns "fair" for median <= 10 days (but > 5)', () => {
    expect(classifyCycleTime(5.1)).toBe('fair');
    expect(classifyCycleTime(7)).toBe('fair');
    expect(classifyCycleTime(10)).toBe('fair');
  });

  it('returns "poor" for median > 10 days', () => {
    expect(classifyCycleTime(10.1)).toBe('poor');
    expect(classifyCycleTime(30)).toBe('poor');
    expect(classifyCycleTime(100)).toBe('poor');
  });

  it('uses custom thresholds when provided', () => {
    // Thresholds [1, 3, 7]
    expect(classifyCycleTime(1, [1, 3, 7])).toBe('excellent');
    expect(classifyCycleTime(2, [1, 3, 7])).toBe('good');
    expect(classifyCycleTime(5, [1, 3, 7])).toBe('fair');
    expect(classifyCycleTime(8, [1, 3, 7])).toBe('poor');
  });
});

describe('cycleTimeBandColor', () => {
  it('returns correct CSS class for "excellent"', () => {
    expect(cycleTimeBandColor('excellent')).toBe('text-green-600 bg-green-50 border-green-200');
  });

  it('returns correct CSS class for "good"', () => {
    expect(cycleTimeBandColor('good')).toBe('text-blue-600 bg-blue-50 border-blue-200');
  });

  it('returns correct CSS class for "fair"', () => {
    expect(cycleTimeBandColor('fair')).toBe('text-amber-600 bg-amber-50 border-amber-200');
  });

  it('returns correct CSS class for "poor"', () => {
    expect(cycleTimeBandColor('poor')).toBe('text-red-600 bg-red-50 border-red-200');
  });
});
