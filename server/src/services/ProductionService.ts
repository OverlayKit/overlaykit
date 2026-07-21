import type { Scene } from '../types/scene';
import type {
  ControlDefinition,
  ControlValue,
  ElementNode,
} from '../types/element';
import type { ServerMessage } from '../types/messages';
import type {
  ComponentVisibilityIntent,
  ComponentVisibilityReceipt,
  ComponentVisibilityResult,
  ProductionBus,
  ProductionControl,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '../types/production';
import { validateElementNode } from '../validation/validator';
import { preserveTemplatesInElements } from '../utils/templatePreserver';
import { hoistCountdownTriggers } from '../utils/normalizeTriggers';
import { ChannelManager, channelManager, type VariableBag } from './ChannelManager';

interface InternalProductionState extends ProductionState {
  takeOperations: Map<string, TakeReceipt>;
  controlOperations: Set<string>;
  visibilityOperations: Map<string, {
    fingerprint: string;
    receipt: ComponentVisibilityReceipt;
  }>;
}

export interface ProductionIntentAuthorization {
  directProgram: boolean;
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

const CONTROL_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPath(source: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function writePath(target: Record<string, unknown>, path: string, value: ControlValue): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

function componentLabel(element: ElementNode): string {
  const declared = element.attributes?.['aria-label'] || element.attributes?.['data-label'];
  if (declared) return declared;
  const className = element.attributes?.class?.split(/\s+/).find(Boolean);
  if (className) return className;
  const content = element.content?.trim();
  if (content && !content.includes('{{')) return content.slice(0, 60);
  return element.id;
}

function invalidControl(
  code: string,
  message: string,
  control: ControlDefinition,
  details: Record<string, unknown> = {},
): never {
  throw new ProductionError(code, message, 400, { controlId: control.id, ...details });
}

function validateControlValue(control: ControlDefinition, value: unknown): ControlValue {
  const hasNumberConstraint = control.min !== undefined || control.max !== undefined || control.step !== undefined;
  if (control.type !== 'number' && hasNumberConstraint) {
    invalidControl('INVALID_CONTROL_DEFINITION', 'Only number controls accept min, max, or step', control);
  }
  if (control.type !== 'select' && control.options !== undefined) {
    invalidControl('INVALID_CONTROL_DEFINITION', 'Only select controls accept options', control);
  }

  if (control.type === 'text') {
    if (typeof value !== 'string') invalidControl('INVALID_CONTROL_VALUE', 'Text control value must be a string', control);
    return value;
  }
  if (control.type === 'toggle') {
    if (typeof value !== 'boolean') invalidControl('INVALID_CONTROL_VALUE', 'Toggle control value must be boolean', control);
    return value;
  }
  if (control.type === 'color') {
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
      invalidControl('INVALID_CONTROL_VALUE', 'Color control value must be a 3, 6, or 8 digit hex color', control);
    }
    return value;
  }
  if (control.type === 'select') {
    if (!control.options?.length) {
      invalidControl('INVALID_CONTROL_DEFINITION', 'Select controls require at least one option', control);
    }
    const values = new Set(control.options.map((option) => option.value));
    if (values.size !== control.options.length) {
      invalidControl('INVALID_CONTROL_DEFINITION', 'Select option values must be unique', control);
    }
    if (typeof value !== 'string' || !values.has(value)) {
      invalidControl('INVALID_CONTROL_VALUE', 'Select control value must match a declared option', control);
    }
    return value;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidControl('INVALID_CONTROL_VALUE', 'Number control value must be finite', control);
  }
  if (control.min !== undefined && control.max !== undefined && control.min > control.max) {
    invalidControl('INVALID_CONTROL_DEFINITION', 'Number control min cannot exceed max', control);
  }
  if (control.step !== undefined && (!Number.isFinite(control.step) || control.step <= 0)) {
    invalidControl('INVALID_CONTROL_DEFINITION', 'Number control step must be greater than zero', control);
  }
  if (control.min !== undefined && value < control.min) {
    invalidControl('INVALID_CONTROL_VALUE', 'Number control value is below min', control, { min: control.min });
  }
  if (control.max !== undefined && value > control.max) {
    invalidControl('INVALID_CONTROL_VALUE', 'Number control value is above max', control, { max: control.max });
  }
  if (control.step !== undefined) {
    const base = control.min ?? 0;
    const steps = (value - base) / control.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      invalidControl('INVALID_CONTROL_VALUE', 'Number control value does not align to step', control, { step: control.step });
    }
  }
  return value;
}

function buildControlCatalog(
  elements: ElementNode[],
  variables: Record<string, unknown>,
): ProductionControl[] {
  const controls: ProductionControl[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();

  const visit = (element: ElementNode): void => {
    for (const control of element.controls ?? []) {
      const segments = control.path.split('.');
      if (!segments.length || segments.some((segment) => !CONTROL_PATH_SEGMENT.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
        invalidControl('INVALID_CONTROL_PATH', 'Control path is unsafe or malformed', control, { path: control.path });
      }
      if (ids.has(control.id)) {
        invalidControl('DUPLICATE_CONTROL_ID', 'Control identifiers must be unique within a Scene', control);
      }
      if (paths.has(control.path)) {
        invalidControl('DUPLICATE_CONTROL_PATH', 'A variable path may be operated by only one control', control, { path: control.path });
      }
      const current = readPath(variables, control.path);
      if (!current.found) {
        invalidControl('CONTROL_PATH_NOT_FOUND', 'Control path must resolve to a Scene variable', control, { path: control.path });
      }
      const value = validateControlValue(control, current.value);
      ids.add(control.id);
      paths.add(control.path);
      controls.push({ ...clone(control), componentId: element.id, componentLabel: componentLabel(element), value });
    }
    for (const child of element.children ?? []) visit(child);
  };

  for (const element of elements) visit(element);
  return controls;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function visibilityFingerprint(intent: ComponentVisibilityIntent): string {
  return JSON.stringify({
    kind: intent.kind,
    showId: intent.showId,
    target: intent.target,
    componentId: intent.componentId,
    visible: intent.visible,
    expectedRevision: intent.expectedRevision,
  });
}

function elementsWithVisibility(
  source: ElementNode[],
  componentId: string,
  visible: boolean,
): ElementNode[] {
  const elements = clone(source);
  let matches = 0;
  const visit = (element: ElementNode): void => {
    if (element.id === componentId) {
      matches += 1;
      element.styles = { ...element.styles, display: visible ? '' : 'none' };
    }
    for (const child of element.children ?? []) visit(child);
  };
  for (const element of elements) visit(element);
  if (matches === 0) {
    throw new ProductionError('COMPONENT_NOT_FOUND', 'Component not found in target snapshot', 404, { componentId });
  }
  if (matches > 1) {
    throw new ProductionError('AMBIGUOUS_COMPONENT', 'Component identifiers must be unique in the target snapshot', 409, { componentId });
  }
  return elements;
}

function emptySnapshot(showId: string, bus: ProductionBus): ProductionSnapshot {
  return {
    showId,
    bus,
    revision: 0,
    scene: null,
    elements: [],
    variables: {},
    controls: [],
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
    const previewVariables = clone(variables);
    const state = this.getOrCreate(showId);
    state.preview = {
      showId,
      bus: 'preview',
      revision: state.preview.revision + 1,
      scene,
      elements: clone(scene.elements),
      variables: previewVariables,
      controls: buildControlCatalog(scene.elements, previewVariables),
      orientation: scene.orientation ?? 'landscape',
      updatedAt: Date.now(),
    };
    this.publishSnapshot(state.preview);
    return this.publicState(state);
  }

  take(showId: string, expectedPreviewRevision: number, operationId: string): ProductionState {
    const state = this.getOrCreate(showId);
    const previousReceipt = state.takeOperations.get(operationId);
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
    state.takeOperations.set(operationId, receipt);
    if (state.takeOperations.size > 100) {
      const firstOperation = state.takeOperations.keys().next().value as string | undefined;
      if (firstOperation) state.takeOperations.delete(firstOperation);
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

  applyPreviewControls(
    showId: string,
    expectedPreviewRevision: number,
    operationId: string,
    values: Record<string, unknown>,
  ): ProductionState {
    const state = this.getOrCreate(showId);
    this.validateOperationId(operationId);
    if (state.controlOperations.has(operationId)) return this.publicState(state);
    if (state.preview.revision === 0 || !state.preview.scene) {
      throw new ProductionError('PREVIEW_EMPTY', 'Load a Scene into Preview before applying controls', 409);
    }
    if (state.preview.revision !== expectedPreviewRevision) {
      throw new ProductionError(
        'PREVIEW_REVISION_CONFLICT',
        'Preview changed before controls were applied',
        409,
        { expectedPreviewRevision, actualPreviewRevision: state.preview.revision },
      );
    }
    if (!isRecord(values) || Object.keys(values).length === 0 || Object.keys(values).length > 100) {
      throw new ProductionError('INVALID_CONTROL_VALUES', 'values must contain 1 to 100 declared controls', 400);
    }

    const catalog = new Map(state.preview.controls.map((control) => [control.id, control]));
    const validated = new Map<ProductionControl, ControlValue>();
    for (const [controlId, rawValue] of Object.entries(values)) {
      const control = catalog.get(controlId);
      if (!control) {
        throw new ProductionError(
          'CONTROL_NOT_DECLARED',
          'Preview may be changed only through declared controls',
          400,
          { controlId },
        );
      }
      validated.set(control, validateControlValue(control, rawValue));
    }

    const nextVariables = clone(state.preview.variables);
    for (const [control, value] of validated) writePath(nextVariables, control.path, value);
    state.preview = {
      ...state.preview,
      revision: state.preview.revision + 1,
      variables: nextVariables,
      controls: buildControlCatalog(state.preview.elements, nextVariables),
      updatedAt: Date.now(),
    };
    state.controlOperations.add(operationId);
    if (state.controlOperations.size > 100) {
      const firstOperation = state.controlOperations.values().next().value as string | undefined;
      if (firstOperation) state.controlOperations.delete(firstOperation);
    }
    this.publishSnapshot(state.preview);
    return this.publicState(state);
  }

  executeVisibilityIntent(
    intent: ComponentVisibilityIntent,
    authorization: ProductionIntentAuthorization,
  ): ComponentVisibilityResult {
    this.validateVisibilityIntent(intent);
    const state = this.getOrCreate(intent.showId);
    if (intent.target === 'program' && !authorization.directProgram) {
      throw new ProductionError(
        'DIRECT_PROGRAM_FORBIDDEN',
        'Direct Program visibility requires explicit authorization',
        403,
      );
    }
    const fingerprint = visibilityFingerprint(intent);
    const prior = state.visibilityOperations.get(intent.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new ProductionError(
          'OPERATION_ID_CONFLICT',
          'operationId was already used for a different visibility intent',
          409,
          { operationId: intent.operationId },
        );
      }
      return { receipt: clone(prior.receipt), state: this.publicState(state) };
    }
    const snapshot = state[intent.target];
    if (snapshot.revision === 0 || !snapshot.scene) {
      throw new ProductionError(
        intent.target === 'preview' ? 'PREVIEW_EMPTY' : 'PROGRAM_EMPTY',
        `Load a Scene into ${intent.target === 'preview' ? 'Preview' : 'Program'} before changing visibility`,
        409,
      );
    }
    if (snapshot.revision !== intent.expectedRevision) {
      throw new ProductionError(
        'TARGET_REVISION_CONFLICT',
        `${intent.target === 'preview' ? 'Preview' : 'Program'} changed before the visibility intent was applied`,
        409,
        {
          target: intent.target,
          expectedRevision: intent.expectedRevision,
          actualRevision: snapshot.revision,
        },
      );
    }

    const executedAt = Date.now();
    const nextSnapshot: ProductionSnapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      elements: elementsWithVisibility(snapshot.elements, intent.componentId, intent.visible),
      updatedAt: executedAt,
    };
    state[intent.target] = nextSnapshot;
    const receipt: ComponentVisibilityReceipt = {
      kind: 'component.visibility',
      showId: intent.showId,
      target: intent.target,
      componentId: intent.componentId,
      visible: intent.visible,
      resultingState: intent.visible ? 'active' : 'inactive',
      operationId: intent.operationId,
      targetRevision: nextSnapshot.revision,
      executedAt,
    };
    state.visibilityOperations.set(intent.operationId, { fingerprint, receipt });
    if (state.visibilityOperations.size > 100) {
      const firstOperation = state.visibilityOperations.keys().next().value as string | undefined;
      if (firstOperation) state.visibilityOperations.delete(firstOperation);
    }
    this.publishSnapshot(nextSnapshot);
    return { receipt: clone(receipt), state: this.publicState(state) };
  }

  private getOrCreate(showId: string): InternalProductionState {
    let state = this.shows.get(showId);
    if (!state) {
      state = {
        showId,
        preview: emptySnapshot(showId, 'preview'),
        program: emptySnapshot(showId, 'program'),
        lastTake: null,
        takeOperations: new Map(),
        controlOperations: new Set(),
        visibilityOperations: new Map(),
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

  private validateOperationId(operationId: string): void {
    if (!operationId || operationId.length > 100) {
      throw new ProductionError('INVALID_OPERATION_ID', 'operationId must be 1 to 100 characters', 400);
    }
  }

  private validateVisibilityIntent(intent: ComponentVisibilityIntent): void {
    if (!intent || typeof intent !== 'object' || intent.kind !== 'component.visibility') {
      throw new ProductionError('INVALID_VISIBILITY_INTENT', 'A component.visibility intent is required', 400);
    }
    if (!intent.showId || typeof intent.showId !== 'string') {
      throw new ProductionError('INVALID_SHOW_ID', 'Visibility intent must name a Show', 400);
    }
    if (intent.target !== 'preview' && intent.target !== 'program') {
      throw new ProductionError('INVALID_PRODUCTION_TARGET', 'Visibility intent must target Preview or Program', 400);
    }
    if (!intent.componentId || typeof intent.componentId !== 'string' || intent.componentId.length > 100) {
      throw new ProductionError('INVALID_COMPONENT_ID', 'componentId must be 1 to 100 characters', 400);
    }
    if (typeof intent.visible !== 'boolean') {
      throw new ProductionError('INVALID_VISIBILITY', 'visible must be boolean', 400);
    }
    if (!Number.isInteger(intent.expectedRevision) || intent.expectedRevision < 0) {
      throw new ProductionError('INVALID_TARGET_REVISION', 'expectedRevision must be a non-negative integer', 400);
    }
    this.validateOperationId(intent.operationId);
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
  ComponentVisibilityIntent,
  ComponentVisibilityReceipt,
  ComponentVisibilityResult,
  ProductionBus,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '../types/production';
