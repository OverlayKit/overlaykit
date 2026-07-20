import type { ProductionState } from './api';

export type ProductionBus = 'preview' | 'program';

export function productionMonitorUrl(showId: string, bus: ProductionBus): string {
  const query = new URLSearchParams({
    show: showId,
    bus,
    transparent: 'true',
    hideStatus: 'true',
    hideWatermark: 'true',
    readOnly: 'true',
  });
  return `http://localhost:5183/production?${query.toString()}`;
}

export function outputUrl(showId: string, token: string): string {
  const query = new URLSearchParams({
    show: showId,
    bus: 'program',
    transparent: 'true',
    hideStatus: 'true',
    hideWatermark: 'true',
    token,
  });
  return `http://localhost:5183/production?${query.toString()}`;
}

export function canTake(state: ProductionState | null): boolean {
  if (!state || state.preview.revision === 0) return false;
  return state.lastTake?.previewRevision !== state.preview.revision;
}
