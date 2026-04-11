/**
 * Cycle-time response DTOs.
 *
 * Issue 6: CycleTimeObservation and CycleTimeResult are defined ONCE in
 * cycle-time.service.ts and re-exported here. This file only contains
 * response type aliases and imports.
 */
export type {
  CycleTimeObservation,
  CycleTimeResult,
  CycleTimeTrendPoint,
} from '../cycle-time.service.js';

export type { CycleTimeBand } from '../cycle-time-bands.js';

export type CycleTimeResponse = import('../cycle-time.service.js').CycleTimeResult[];
export type CycleTimeTrendResponse = import('../cycle-time.service.js').CycleTimeTrendPoint[];
