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

export interface ComponentVisibilityCueStep {
  readonly id: string;
  readonly kind: 'component.visibility';
  readonly componentId: string;
  readonly visible: boolean;
}

export interface ProductionCue {
  readonly id: string;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly steps: ReadonlyArray<ComponentVisibilityCueStep>;
}

export interface ProductionCueExecution {
  readonly cue: ProductionCue;
  readonly operationId: string;
  readonly expectedRevision: number;
}

export interface CompletedCueStepReceipt {
  id: string;
  index: number;
  status: 'completed';
  receipt: ComponentVisibilityReceipt;
}

export interface FailedCueStepReceipt {
  id: string;
  index: number;
  status: 'failed';
  error: {
    code: string;
    message: string;
    status: number;
  };
}

export type ProductionCueStepReceipt = CompletedCueStepReceipt | FailedCueStepReceipt;

export interface ProductionCueReceipt {
  cueId: string;
  showId: string;
  target: ProductionBus;
  operationId: string;
  status: 'completed' | 'failed';
  completedSteps: number;
  failedStepId?: string;
  targetRevision: number;
  steps: ReadonlyArray<ProductionCueStepReceipt>;
  startedAt: number;
  completedAt: number;
}

export interface ProductionCueResult {
  receipt: ProductionCueReceipt;
  state: ProductionState;
}
