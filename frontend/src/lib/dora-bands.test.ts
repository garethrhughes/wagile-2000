import { describe, it, expect } from 'vitest';
import {
  classifyDeploymentFrequency,
  classifyLeadTime,
  classifyChangeFailureRate,
  classifyMTTR,
  bandColor,
  type DoraBand,
} from './dora-bands';

describe('classifyDeploymentFrequency', () => {
  it('returns elite for >= 1 deploy/day', () => {
    expect(classifyDeploymentFrequency(1)).toBe('elite');
    expect(classifyDeploymentFrequency(5)).toBe('elite');
  });

  it('returns high for >= 1/7 deploy/day', () => {
    expect(classifyDeploymentFrequency(1 / 7)).toBe('high');
    expect(classifyDeploymentFrequency(0.5)).toBe('high');
  });

  it('returns medium for >= 1/30 deploy/day', () => {
    expect(classifyDeploymentFrequency(1 / 30)).toBe('medium');
    expect(classifyDeploymentFrequency(0.1)).toBe('medium');
  });

  it('returns low for < 1/30 deploy/day', () => {
    expect(classifyDeploymentFrequency(0.01)).toBe('low');
    expect(classifyDeploymentFrequency(0)).toBe('low');
  });
});

describe('classifyLeadTime', () => {
  it('returns elite for < 1 day', () => {
    expect(classifyLeadTime(0.5)).toBe('elite');
    expect(classifyLeadTime(0)).toBe('elite');
  });

  it('returns high at exactly 1 day (boundary — not elite)', () => {
    expect(classifyLeadTime(1)).toBe('high');
  });

  it('returns high for < 7 days', () => {
    expect(classifyLeadTime(3)).toBe('high');
  });

  it('returns medium for <= 30 days', () => {
    expect(classifyLeadTime(15)).toBe('medium');
    expect(classifyLeadTime(30)).toBe('medium');
  });

  it('returns low for > 30 days', () => {
    expect(classifyLeadTime(31)).toBe('low');
    expect(classifyLeadTime(90)).toBe('low');
  });
});

describe('classifyChangeFailureRate', () => {
  it('returns elite for < 5%', () => {
    expect(classifyChangeFailureRate(2)).toBe('elite');
  });

  it('returns high for < 10%', () => {
    expect(classifyChangeFailureRate(7)).toBe('high');
  });

  it('returns medium for < 15%', () => {
    expect(classifyChangeFailureRate(12)).toBe('medium');
  });

  it('returns low for >= 15%', () => {
    expect(classifyChangeFailureRate(20)).toBe('low');
  });
});

describe('classifyMTTR', () => {
  it('returns elite for < 1 hour', () => {
    expect(classifyMTTR(0.5)).toBe('elite');
  });

  it('returns high for < 24 hours', () => {
    expect(classifyMTTR(12)).toBe('high');
  });

  it('returns medium for < 168 hours', () => {
    expect(classifyMTTR(72)).toBe('medium');
  });

  it('returns low for >= 168 hours', () => {
    expect(classifyMTTR(200)).toBe('low');
  });
});

describe('bandColor', () => {
  it('returns green classes for elite', () => {
    expect(bandColor('elite')).toContain('green');
  });

  it('returns blue classes for high', () => {
    expect(bandColor('high')).toContain('blue');
  });

  it('returns amber classes for medium', () => {
    expect(bandColor('medium')).toContain('amber');
  });

  it('returns red classes for low', () => {
    expect(bandColor('low')).toContain('red');
  });

  it('returns bg, text, and border classes for each band', () => {
    const bands: DoraBand[] = ['elite', 'high', 'medium', 'low'];
    for (const band of bands) {
      const classes = bandColor(band);
      expect(classes).toMatch(/text-/);
      expect(classes).toMatch(/bg-/);
      expect(classes).toMatch(/border-/);
    }
  });
});
