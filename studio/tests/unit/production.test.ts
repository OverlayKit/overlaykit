import { describe, expect, it } from 'vitest';
import type { ProductionState } from '../../src/api';
import { canTake, outputUrl, productionMonitorUrl } from '../../src/production';

function state(previewRevision: number, takenRevision?: number): ProductionState {
  const snapshot = {
    showId: 'show-1',
    revision: 0,
    scene: null,
    elements: [],
    variables: {},
    orientation: 'landscape' as const,
    updatedAt: null,
  };
  return {
    showId: 'show-1',
    preview: { ...snapshot, bus: 'preview', revision: previewRevision },
    program: { ...snapshot, bus: 'program' },
    lastTake: takenRevision === undefined ? null : {
      operationId: 'take-1',
      previewRevision: takenRevision,
      programRevision: 1,
      takenAt: 1,
    },
  };
}

describe('production URL and Take contracts', () => {
  it('builds explicit Preview and Program monitor URLs', () => {
    expect(productionMonitorUrl('show one', 'preview')).toContain('show=show+one&bus=preview');
    expect(productionMonitorUrl('show one', 'program')).toContain('show=show+one&bus=program');
  });

  it('always binds output-token URLs to Program', () => {
    const url = new URL(outputUrl('show-1', 'secret token'));
    expect(url.searchParams.get('show')).toBe('show-1');
    expect(url.searchParams.get('bus')).toBe('program');
    expect(url.searchParams.get('token')).toBe('secret token');
    expect(url.searchParams.get('hideStatus')).toBe('true');
    expect(url.searchParams.get('hideWatermark')).toBe('true');
    expect(url.searchParams.has('channel')).toBe(false);
  });

  it('allows Take only for a new prepared Preview revision', () => {
    expect(canTake(null)).toBe(false);
    expect(canTake(state(0))).toBe(false);
    expect(canTake(state(1))).toBe(true);
    expect(canTake(state(2, 2))).toBe(false);
    expect(canTake(state(3, 2))).toBe(true);
  });
});
