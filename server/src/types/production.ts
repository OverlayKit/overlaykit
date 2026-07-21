import type { ControlDefinition, ControlValue, ElementNode } from './element';
import type { Orientation, Scene } from './scene';

// Structural server boundary mirroring @overlaykit/protocol/production. The
// server remains CommonJS with classic Node resolution, while the public package
// exposes TypeScript source through package exports for bundler consumers.
export type ProductionBus = 'preview' | 'program';

export interface ProductionControl extends ControlDefinition {
  componentId: string;
  componentLabel: string;
  value: ControlValue;
}

export interface ProductionSnapshot {
  showId: string;
  bus: ProductionBus;
  revision: number;
  scene: Scene | null;
  elements: ElementNode[];
  variables: Record<string, unknown>;
  controls: ProductionControl[];
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

export interface ComponentVisibilityIntent {
  kind: 'component.visibility';
  showId: string;
  target: ProductionBus;
  componentId: string;
  visible: boolean;
  operationId: string;
  expectedRevision: number;
}

export interface ComponentVisibilityReceipt {
  kind: 'component.visibility';
  showId: string;
  target: ProductionBus;
  componentId: string;
  visible: boolean;
  resultingState: 'active' | 'inactive';
  operationId: string;
  targetRevision: number;
  executedAt: number;
}

export interface ComponentVisibilityResult {
  receipt: ComponentVisibilityReceipt;
  state: ProductionState;
}
