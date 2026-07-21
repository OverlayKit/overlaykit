import type { ProductionState } from './api';

export type ProductionBus = 'preview' | 'program';
const OVERLAY_URL = import.meta.env.VITE_OVERLAY_URL || 'http://localhost:5183';

export function productionMonitorUrl(showId: string, bus: ProductionBus): string {
  const query = new URLSearchParams({
    show: showId,
    bus,
    transparent: 'true',
    hideStatus: 'true',
    hideWatermark: 'true',
    readOnly: 'true',
  });
  return `${OVERLAY_URL}/production?${query.toString()}`;
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
  return `${OVERLAY_URL}/production?${query.toString()}`;
}

export function canTake(state: ProductionState | null): boolean {
  if (!state || state.preview.revision === 0) return false;
  return state.lastTake?.previewRevision !== state.preview.revision;
}
