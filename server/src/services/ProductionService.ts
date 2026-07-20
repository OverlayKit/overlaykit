import type { Scene } from '../types/scene';
import type { ServerMessage } from '../types/messages';
import type {
  ProductionBus,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '../types/production';
import { validateElementNode } from '../validation/validator';
import { preserveTemplatesInElements } from '../utils/templatePreserver';
import { hoistCountdownTriggers } from '../utils/normalizeTriggers';
import { ChannelManager, channelManager, type VariableBag } from './ChannelManager';

interface InternalProductionState extends ProductionState {
  operations: Map<string, TakeReceipt>;
}

export class ProductionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptySnapshot(showId: string, bus: ProductionBus): ProductionSnapshot {
  return {
    showId,
    bus,
    revision: 0,
    scene: null,
    elements: [],
    variables: {},
    orientation: 'landscape',
    updatedAt: null,
  };
}

export function productionRouteKey(showId: string, bus: ProductionBus): string {
  return `production:${showId}:${bus}`;
}

export class ProductionService {
  private readonly shows = new Map<string, InternalProductionState>();

  constructor(private readonly channels: ChannelManager = channelManager) {}

  getState(showId: string): ProductionState {
    const state = this.getOrCreate(showId);
    return this.publicState(state);
  }

  getSnapshot(showId: string, bus: ProductionBus): ProductionSnapshot {
    const state = this.getOrCreate(showId);
    return clone(state[bus]);
  }

  loadPreview(
    showId: string,
    sourceScene: Scene,
    variables: VariableBag = {},
  ): ProductionState {
    const scene = this.prepareScene(sourceScene);
    const state = this.getOrCreate(showId);
    state.preview = {
      showId,
      bus: 'preview',
      revision: state.preview.revision + 1,
      scene,
      elements: clone(scene.elements),
      variables: clone(variables),
      orientation: scene.orientation ?? 'landscape',
      updatedAt: Date.now(),
    };
    this.publishSnapshot(state.preview);
    return this.publicState(state);
  }

  take(showId: string, expectedPreviewRevision: number, operationId: string): ProductionState {
    const state = this.getOrCreate(showId);
    const previousReceipt = state.operations.get(operationId);
    if (previousReceipt) return this.publicState(state);
    if (state.preview.revision === 0 || !state.preview.scene) {
      throw new ProductionError('PREVIEW_EMPTY', 'Load a Scene into Preview before Take', 409);
    }
    if (state.preview.revision !== expectedPreviewRevision) {
      throw new ProductionError(
        'PREVIEW_REVISION_CONFLICT',
        'Preview changed before Take',
        409,
        { expectedPreviewRevision, actualPreviewRevision: state.preview.revision },
      );
    }
    if (!operationId || operationId.length > 100) {
      throw new ProductionError('INVALID_OPERATION_ID', 'operationId must be 1 to 100 characters', 400);
    }

    const takenAt = Date.now();
    state.program = {
      ...clone(state.preview),
      bus: 'program',
      revision: state.program.revision + 1,
      updatedAt: takenAt,
    };
    const receipt: TakeReceipt = {
      operationId,
      previewRevision: state.preview.revision,
      programRevision: state.program.revision,
      takenAt,
    };
    state.lastTake = receipt;
    state.operations.set(operationId, receipt);
    if (state.operations.size > 100) {
      const firstOperation = state.operations.keys().next().value as string | undefined;
      if (firstOperation) state.operations.delete(firstOperation);
    }

    this.publishSnapshot(state.program);
    const acknowledgement: ServerMessage = {
      type: 'production.taken',
      showId,
      receipt: clone(receipt),
    };
    this.channels.broadcast(productionRouteKey(showId, 'preview'), acknowledgement);
    this.channels.broadcast(productionRouteKey(showId, 'program'), acknowledgement);
    return this.publicState(state);
  }

  private getOrCreate(showId: string): InternalProductionState {
    let state = this.shows.get(showId);
    if (!state) {
      state = {
        showId,
        preview: emptySnapshot(showId, 'preview'),
        program: emptySnapshot(showId, 'program'),
        lastTake: null,
        operations: new Map(),
      };
      this.shows.set(showId, state);
    }
    return state;
  }

  private prepareScene(sourceScene: Scene): Scene {
    const source = clone(sourceScene);
    if (!source.id || !source.name || !Array.isArray(source.elements)) {
      throw new ProductionError('INVALID_SCENE', 'Scene must have id, name, and elements', 400);
    }
    for (const element of source.elements) {
      const validationError = validateElementNode(element);
      if (validationError) {
        throw new ProductionError(
          validationError.code,
          validationError.message,
          400,
          validationError.details as Record<string, unknown> | undefined,
        );
      }
    }
    source.elements = preserveTemplatesInElements(hoistCountdownTriggers(source.elements));
    return source;
  }

  private publishSnapshot(snapshot: ProductionSnapshot): void {
    const key = productionRouteKey(snapshot.showId, snapshot.bus);
    this.channels.replaceVariables(key, clone(snapshot.variables));
    this.channels.clearElements(key);
    for (const element of clone(snapshot.elements)) this.channels.addElement(key, element);
    if (snapshot.scene) this.channels.setActiveScene(key, clone(snapshot.scene));
    this.channels.setOrientation(key, snapshot.orientation);
    this.channels.clearDesignSystem(key);
    this.channels.broadcast(key, {
      type: 'production.snapshot',
      showId: snapshot.showId,
      bus: snapshot.bus,
      snapshot: clone(snapshot),
    });
  }

  private publicState(state: InternalProductionState): ProductionState {
    return {
      showId: state.showId,
      preview: clone(state.preview),
      program: clone(state.program),
      lastTake: state.lastTake ? clone(state.lastTake) : null,
    };
  }
}

export const productionService = new ProductionService();

export type {
  ProductionBus,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '../types/production';
