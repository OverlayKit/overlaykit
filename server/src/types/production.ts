import type { ElementNode } from './element';
import type { Orientation, Scene } from './scene';

export type ProductionBus = 'preview' | 'program';

export interface ProductionSnapshot {
  showId: string;
  bus: ProductionBus;
  revision: number;
  scene: Scene | null;
  elements: ElementNode[];
  variables: Record<string, unknown>;
  orientation: Orientation;
  updatedAt: number | null;
}

export interface TakeReceipt {
  operationId: string;
  previewRevision: number;
  programRevision: number;
  takenAt: number;
}

export interface ProductionState {
  showId: string;
  preview: ProductionSnapshot;
  program: ProductionSnapshot;
  lastTake: TakeReceipt | null;
}
