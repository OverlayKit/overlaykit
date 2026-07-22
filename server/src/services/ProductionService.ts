import type { Scene } from '../types/scene';
import type { ControlDefinition, ControlValue, ElementNode } from '../types/element';
import type { ServerMessage } from '../types/messages';
import type { StudioRole } from '../auth/types';
import type {
  ComponentVisibilityIntent,
  ComponentVisibilityReceipt,
  ComponentVisibilityResult,
  ProductionCueExecution,
  ProductionCueReceipt,
  ProductionCueResult,
  ProductionCueStepReceipt,
  ProductionBus,
  ProductionControl,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '../types/production';
import { validateElementNode, validateSceneNode } from '../validation/validator';
import { preserveTemplatesInElements } from '../utils/templatePreserver';
import { hoistCountdownTriggers } from '../utils/normalizeTriggers';
import { ChannelManager, channelManager, type VariableBag } from './ChannelManager';
import {
  canonicalProductionJson,
  MAX_PRODUCTION_SNAPSHOT_BYTES,
  PRODUCTION_SNAPSHOT_DOCUMENT_VERSION,
  ProductionStateStoreError,
  productionSnapshotPayload,
  type ProductionMutationKind,
  type ProductionStatePersistencePort,
  type ProductionTargetQuarantine,
  type StoredProductionSnapshot,
} from './SqliteProductionStateStore';

interface InternalProductionState extends ProductionState {
  takeOperations: Map<string, TakeReceipt>;
  controlOperations: Set<string>;
  visibilityOperations: Map<
    string,
    {
      fingerprint: string;
      receipt: ComponentVisibilityReceipt;
    }
  >;
  cueOperations: Map<
    string,
    {
      fingerprint: string;
      receipt: ProductionCueReceipt;
    }
  >;
}

export interface ProductionIntentAuthorization {
  directProgram: boolean;
}

export type ProductionRecoveryMode = 'restore' | 'reset';

export interface ProductionRecoveryInput {
  readonly showId: string;
  readonly target: ProductionBus;
  readonly mode: ProductionRecoveryMode;
  readonly operationId: string;
  readonly roles: ReadonlyArray<StudioRole>;
  readonly scene?: Scene;
  readonly variables?: VariableBag;
}

export interface ProductionPersistenceMountResult {
  readonly restoredTargets: number;
  readonly quarantinedTargets: number;
}

export interface ProductionServiceOptions {
  readonly allowEphemeral?: boolean;
}

export class ProductionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>
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

function readPath(
  source: Record<string, unknown>,
  path: string
): { found: boolean; value?: unknown } {
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
  details: Record<string, unknown> = {}
): never {
  throw new ProductionError(code, message, 400, { controlId: control.id, ...details });
}

function validateControlValue(control: ControlDefinition, value: unknown): ControlValue {
  const hasNumberConstraint =
    control.min !== undefined || control.max !== undefined || control.step !== undefined;
  if (control.type !== 'number' && hasNumberConstraint) {
    invalidControl(
      'INVALID_CONTROL_DEFINITION',
      'Only number controls accept min, max, or step',
      control
    );
  }
  if (control.type !== 'select' && control.options !== undefined) {
    invalidControl('INVALID_CONTROL_DEFINITION', 'Only select controls accept options', control);
  }

  if (control.type === 'text') {
    if (typeof value !== 'string')
      invalidControl('INVALID_CONTROL_VALUE', 'Text control value must be a string', control);
    return value;
  }
  if (control.type === 'toggle') {
    if (typeof value !== 'boolean')
      invalidControl('INVALID_CONTROL_VALUE', 'Toggle control value must be boolean', control);
    return value;
  }
  if (control.type === 'color') {
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
      invalidControl(
        'INVALID_CONTROL_VALUE',
        'Color control value must be a 3, 6, or 8 digit hex color',
        control
      );
    }
    return value;
  }
  if (control.type === 'select') {
    if (!control.options?.length) {
      invalidControl(
        'INVALID_CONTROL_DEFINITION',
        'Select controls require at least one option',
        control
      );
    }
    const values = new Set(control.options.map((option) => option.value));
    if (values.size !== control.options.length) {
      invalidControl('INVALID_CONTROL_DEFINITION', 'Select option values must be unique', control);
    }
    if (typeof value !== 'string' || !values.has(value)) {
      invalidControl(
        'INVALID_CONTROL_VALUE',
        'Select control value must match a declared option',
        control
      );
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
    invalidControl(
      'INVALID_CONTROL_DEFINITION',
      'Number control step must be greater than zero',
      control
    );
  }
  if (control.min !== undefined && value < control.min) {
    invalidControl('INVALID_CONTROL_VALUE', 'Number control value is below min', control, {
      min: control.min,
    });
  }
  if (control.max !== undefined && value > control.max) {
    invalidControl('INVALID_CONTROL_VALUE', 'Number control value is above max', control, {
      max: control.max,
    });
  }
  if (control.step !== undefined) {
    const base = control.min ?? 0;
    const steps = (value - base) / control.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      invalidControl(
        'INVALID_CONTROL_VALUE',
        'Number control value does not align to step',
        control,
        { step: control.step }
      );
    }
  }
  return value;
}

function buildControlCatalog(
  elements: ElementNode[],
  variables: Record<string, unknown>
): ProductionControl[] {
  const controls: ProductionControl[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();

  const visit = (element: ElementNode): void => {
    for (const control of element.controls ?? []) {
      const segments = control.path.split('.');
      if (
        !segments.length ||
        segments.some(
          (segment) => !CONTROL_PATH_SEGMENT.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment)
        )
      ) {
        invalidControl('INVALID_CONTROL_PATH', 'Control path is unsafe or malformed', control, {
          path: control.path,
        });
      }
      if (ids.has(control.id)) {
        invalidControl(
          'DUPLICATE_CONTROL_ID',
          'Control identifiers must be unique within a Scene',
          control
        );
      }
      if (paths.has(control.path)) {
        invalidControl(
          'DUPLICATE_CONTROL_PATH',
          'A variable path may be operated by only one control',
          control,
          { path: control.path }
        );
      }
      const current = readPath(variables, control.path);
      if (!current.found) {
        invalidControl(
          'CONTROL_PATH_NOT_FOUND',
          'Control path must resolve to a Scene variable',
          control,
          { path: control.path }
        );
      }
      const value = validateControlValue(control, current.value);
      ids.add(control.id);
      paths.add(control.path);
      controls.push({
        ...clone(control),
        componentId: element.id,
        componentLabel: componentLabel(element),
        value,
      });
    }
    for (const child of element.children ?? []) visit(child);
  };

  for (const element of elements) visit(element);
  return controls;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function elementsWithoutRuntimeVisibility(elements: ElementNode[]): ElementNode[] {
  return elements.map((element) => {
    const normalized = clone(element);
    delete normalized.styles.display;
    if (normalized.children) {
      normalized.children = elementsWithoutRuntimeVisibility(normalized.children);
    }
    return normalized;
  });
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

function cueFingerprint(execution: ProductionCueExecution): string {
  return JSON.stringify({
    cue: execution.cue,
    expectedRevision: execution.expectedRevision,
  });
}

function elementsWithVisibility(
  source: ElementNode[],
  componentId: string,
  visible: boolean
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
    throw new ProductionError(
      'COMPONENT_NOT_FOUND',
      'Component not found in target snapshot',
      404,
      { componentId }
    );
  }
  if (matches > 1) {
    throw new ProductionError(
      'AMBIGUOUS_COMPONENT',
      'Component identifiers must be unique in the target snapshot',
      409,
      { componentId }
    );
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

function productionTargetKey(showId: string, target: ProductionBus): string {
  return JSON.stringify([showId, target]);
}

function structuralPersistenceError(message: string): ProductionError {
  return new ProductionError('INVALID_PERSISTED_PRODUCTION_STATE', message, 503);
}

export function productionRouteKey(showId: string, bus: ProductionBus): string {
  return `production:${showId}:${bus}`;
}

export interface ProductionStateObservation {
  readonly showId: string;
  readonly target: ProductionBus;
  readonly state: ProductionState;
}

export type ProductionStateObserver = (observation: ProductionStateObservation) => void;

export class ProductionService {
  private readonly shows = new Map<string, InternalProductionState>();
  private readonly observers = new Map<string, Set<ProductionStateObserver>>();
  private readonly quarantines = new Map<string, ProductionTargetQuarantine>();
  private persistence: ProductionStatePersistencePort | null = null;
  private persistenceMounted = false;
  private authorityFailure: unknown | null = null;
  private onFatal: (error: unknown) => void = () => undefined;
  private readonly allowEphemeral: boolean;
  private readonly pendingPublications: Array<{
    snapshot: ProductionSnapshot;
    state: ProductionState;
  }> = [];
  private publishing = false;

  constructor(
    private readonly channels: ChannelManager = channelManager,
    options: ProductionServiceOptions = {}
  ) {
    this.allowEphemeral = options.allowEphemeral === true;
  }

  mountPersistence(
    persistence: ProductionStatePersistencePort,
    onFatal: (error: unknown) => void = () => undefined
  ): ProductionPersistenceMountResult {
    if (this.persistenceMounted || this.shows.size > 0 || this.observers.size > 0) {
      throw new ProductionError(
        'PRODUCTION_AUTHORITY_ALREADY_EXPOSED',
        'Production persistence must be mounted once before production state is exposed',
        500
      );
    }

    const loaded = persistence.load();
    const stagedShows = new Map<string, InternalProductionState>();
    const stagedQuarantines = new Map<string, ProductionTargetQuarantine>();
    for (const quarantine of loaded.quarantines) {
      stagedQuarantines.set(
        productionTargetKey(quarantine.showId, quarantine.target),
        Object.freeze({ ...quarantine })
      );
    }

    const restored: ProductionSnapshot[] = [];
    for (const record of loaded.snapshots) {
      const key = productionTargetKey(record.showId, record.target);
      if (stagedQuarantines.has(key)) continue;
      try {
        const snapshot = this.parseStoredSnapshot(record);
        let state = stagedShows.get(record.showId);
        if (!state) {
          state = this.newInternalState(record.showId);
          stagedShows.set(record.showId, state);
        }
        state[record.target] = snapshot;
        restored.push(snapshot);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown structural failure';
        const quarantine: ProductionTargetQuarantine = Object.freeze({
          showId: record.showId,
          target: record.target,
          revision: record.revision,
          rejectedSnapshotHash: record.snapshotHash,
          reason: `Persisted production snapshot is structurally invalid: ${detail}`.slice(0, 400),
          detectedAt: Date.now(),
        });
        persistence.quarantine(quarantine);
        stagedQuarantines.set(key, quarantine);
      }
    }

    this.persistence = persistence;
    this.persistenceMounted = true;
    this.onFatal = onFatal;
    for (const [showId, state] of stagedShows) this.shows.set(showId, state);
    for (const [key, quarantine] of stagedQuarantines) {
      this.quarantines.set(key, quarantine);
    }
    try {
      for (const snapshot of restored) this.publishSnapshot(snapshot);
    } catch (error) {
      this.failAuthority(error);
      throw error;
    }
    return Object.freeze({
      restoredTargets: restored.length,
      quarantinedTargets: stagedQuarantines.size,
    });
  }

  getState(showId: string): ProductionState {
    this.assertAuthorityUsable();
    this.assertTargetAvailable(showId, 'preview');
    this.assertTargetAvailable(showId, 'program');
    const state = this.getOrCreate(showId);
    return this.publicState(state);
  }

  getSnapshot(showId: string, bus: ProductionBus): ProductionSnapshot {
    this.assertAuthorityUsable();
    this.validateTarget(bus);
    this.assertTargetAvailable(showId, bus);
    const state = this.getOrCreate(showId);
    return clone(state[bus]);
  }

  listQuarantines(showId?: string): ReadonlyArray<ProductionTargetQuarantine> {
    this.assertAuthorityUsable();
    if (showId !== undefined) this.validateShowId(showId);
    return Object.freeze(
      [...this.quarantines.values()]
        .filter((quarantine) => showId === undefined || quarantine.showId === showId)
        .map((quarantine) => Object.freeze({ ...quarantine }))
    );
  }

  recoverTarget(input: ProductionRecoveryInput): ProductionSnapshot {
    this.assertAuthorityUsable();
    if (!input || typeof input !== 'object') {
      throw new ProductionError('INVALID_PRODUCTION_RECOVERY', 'Recovery input is required', 400);
    }
    if (!input.showId || typeof input.showId !== 'string') {
      throw new ProductionError('INVALID_SHOW_ID', 'Recovery must name a Show', 400);
    }
    this.validateShowId(input.showId);
    if (input.target !== 'preview' && input.target !== 'program') {
      throw new ProductionError(
        'INVALID_PRODUCTION_TARGET',
        'Recovery must target Preview or Program',
        400
      );
    }
    this.validateOperationId(input.operationId);
    const roles = Array.isArray(input.roles) ? input.roles : [];
    const owner = roles.includes('owner');
    const producer = roles.includes('producer');
    if (!owner && !producer) {
      throw new ProductionError(
        'PRODUCTION_RECOVERY_FORBIDDEN',
        'Production recovery requires Owner or Producer authority',
        403
      );
    }
    if (input.mode !== 'restore' && input.mode !== 'reset') {
      throw new ProductionError(
        'INVALID_PRODUCTION_RECOVERY_MODE',
        'Recovery mode must be restore or reset',
        400
      );
    }
    if (input.mode === 'reset' && !owner) {
      throw new ProductionError(
        'PRODUCTION_RESET_FORBIDDEN',
        'Only the Owner may reset a quarantined target empty',
        403
      );
    }
    const key = productionTargetKey(input.showId, input.target);
    const quarantine = this.quarantines.get(key);
    if (!quarantine) {
      throw new ProductionError(
        'PRODUCTION_TARGET_NOT_QUARANTINED',
        'Production target is not quarantined',
        409
      );
    }
    if (!this.persistence) {
      throw new ProductionError(
        'PRODUCTION_RECOVERY_UNAVAILABLE',
        'Durable production authority is unavailable',
        503
      );
    }

    const occurredAt = Date.now();
    let candidate: ProductionSnapshot;
    let mutationKind: ProductionMutationKind;
    if (input.mode === 'reset') {
      candidate = {
        ...emptySnapshot(input.showId, input.target),
        revision: quarantine.revision + 1,
        updatedAt: occurredAt,
      };
      mutationKind = 'quarantine.reset';
    } else {
      if (!input.scene) {
        throw new ProductionError(
          'INVALID_PRODUCTION_RECOVERY',
          'Restore recovery requires a Scene',
          400
        );
      }
      if (input.variables !== undefined && !isRecord(input.variables)) {
        throw new ProductionError('INVALID_VARIABLES', 'Recovery variables must be an object', 400);
      }
      const scene = this.prepareScene(input.scene);
      const variables = clone(input.variables ?? {});
      candidate = {
        showId: input.showId,
        bus: input.target,
        revision: quarantine.revision + 1,
        scene,
        elements: clone(scene.elements),
        variables,
        controls: buildControlCatalog(scene.elements, variables),
        orientation: scene.orientation ?? 'landscape',
        updatedAt: occurredAt,
      };
      mutationKind = 'quarantine.restore';
    }

    const state = this.getOrCreate(input.showId);
    this.commitSnapshot(
      state,
      candidate,
      mutationKind,
      input.operationId,
      quarantine.revision,
      quarantine.rejectedSnapshotHash
    );
    this.quarantines.delete(key);
    this.publishCommittedSnapshot(candidate);
    return clone(candidate);
  }

  subscribe(showId: string, observer: ProductionStateObserver): () => void {
    this.assertAuthorityUsable();
    this.assertTargetAvailable(showId, 'preview');
    this.assertTargetAvailable(showId, 'program');
    if (typeof observer !== 'function') {
      throw new ProductionError(
        'INVALID_PRODUCTION_OBSERVER',
        'A Show and production observer are required',
        400
      );
    }
    this.validateShowId(showId);
    let observers = this.observers.get(showId);
    if (!observers) {
      observers = new Set();
      this.observers.set(showId, observers);
    }
    observers.add(observer);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      observers?.delete(observer);
      if (observers?.size === 0) this.observers.delete(showId);
    };
  }

  loadPreview(showId: string, sourceScene: Scene, variables: VariableBag = {}): ProductionState {
    this.assertAuthorityUsable();
    this.assertTargetAvailable(showId, 'preview');
    if (!isRecord(variables)) {
      throw new ProductionError('INVALID_VARIABLES', 'Scene variables must be an object', 400);
    }
    const scene = this.prepareScene(sourceScene);
    const previewVariables = clone(variables);
    const state = this.getOrCreate(showId);
    const candidate: ProductionSnapshot = {
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
    this.commitSnapshot(state, candidate, 'preview.load');
    this.publishCommittedSnapshot(candidate);
    return this.publicState(state);
  }

  take(showId: string, expectedPreviewRevision: number, operationId: string): ProductionState {
    this.assertAuthorityUsable();
    this.assertTargetAvailable(showId, 'preview');
    this.assertTargetAvailable(showId, 'program');
    const state = this.getOrCreate(showId);
    this.validateOperationId(operationId);
    const previousReceipt = state.takeOperations.get(operationId);
    if (previousReceipt) return this.publicState(state);
    if (state.preview.revision === 0 || !state.preview.scene) {
      throw new ProductionError('PREVIEW_EMPTY', 'Load a Scene into Preview before Take', 409);
    }
    if (state.preview.revision !== expectedPreviewRevision) {
      throw new ProductionError('PREVIEW_REVISION_CONFLICT', 'Preview changed before Take', 409, {
        expectedPreviewRevision,
        actualPreviewRevision: state.preview.revision,
      });
    }
    const takenAt = Date.now();
    const candidate: ProductionSnapshot = {
      ...clone(state.preview),
      bus: 'program',
      revision: state.program.revision + 1,
      updatedAt: takenAt,
    };
    this.commitSnapshot(state, candidate, 'program.take', operationId);
    const receipt: TakeReceipt = {
      operationId,
      previewRevision: state.preview.revision,
      programRevision: candidate.revision,
      takenAt,
    };
    state.lastTake = receipt;
    state.takeOperations.set(operationId, receipt);
    if (state.takeOperations.size > 100) {
      const firstOperation = state.takeOperations.keys().next().value as string | undefined;
      if (firstOperation) state.takeOperations.delete(firstOperation);
    }

    this.publishCommittedSnapshot(candidate);
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
    values: Record<string, unknown>
  ): ProductionState {
    this.assertAuthorityUsable();
    this.assertTargetAvailable(showId, 'preview');
    const state = this.getOrCreate(showId);
    this.validateOperationId(operationId);
    if (state.controlOperations.has(operationId)) return this.publicState(state);
    if (state.preview.revision === 0 || !state.preview.scene) {
      throw new ProductionError(
        'PREVIEW_EMPTY',
        'Load a Scene into Preview before applying controls',
        409
      );
    }
    if (state.preview.revision !== expectedPreviewRevision) {
      throw new ProductionError(
        'PREVIEW_REVISION_CONFLICT',
        'Preview changed before controls were applied',
        409,
        { expectedPreviewRevision, actualPreviewRevision: state.preview.revision }
      );
    }
    if (!isRecord(values) || Object.keys(values).length === 0 || Object.keys(values).length > 100) {
      throw new ProductionError(
        'INVALID_CONTROL_VALUES',
        'values must contain 1 to 100 declared controls',
        400
      );
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
          { controlId }
        );
      }
      validated.set(control, validateControlValue(control, rawValue));
    }

    const nextVariables = clone(state.preview.variables);
    for (const [control, value] of validated) writePath(nextVariables, control.path, value);
    const candidate: ProductionSnapshot = {
      ...state.preview,
      revision: state.preview.revision + 1,
      variables: nextVariables,
      controls: buildControlCatalog(state.preview.elements, nextVariables),
      updatedAt: Date.now(),
    };
    this.commitSnapshot(state, candidate, 'preview.controls', operationId);
    state.controlOperations.add(operationId);
    if (state.controlOperations.size > 100) {
      const firstOperation = state.controlOperations.values().next().value as string | undefined;
      if (firstOperation) state.controlOperations.delete(firstOperation);
    }
    this.publishCommittedSnapshot(candidate);
    return this.publicState(state);
  }

  executeVisibilityIntent(
    intent: ComponentVisibilityIntent,
    authorization: ProductionIntentAuthorization,
    mutationKind: 'component.visibility' | 'cue.step' = 'component.visibility'
  ): ComponentVisibilityResult {
    this.assertAuthorityUsable();
    this.validateVisibilityIntent(intent);
    if (intent.target === 'program' && !authorization.directProgram) {
      throw new ProductionError(
        'DIRECT_PROGRAM_FORBIDDEN',
        'Direct Program visibility requires explicit authorization',
        403
      );
    }
    this.assertTargetAvailable(intent.showId, intent.target);
    const state = this.getOrCreate(intent.showId);
    const fingerprint = visibilityFingerprint(intent);
    const prior = state.visibilityOperations.get(intent.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new ProductionError(
          'OPERATION_ID_CONFLICT',
          'operationId was already used for a different visibility intent',
          409,
          { operationId: intent.operationId }
        );
      }
      return { receipt: clone(prior.receipt), state: this.publicState(state) };
    }
    const snapshot = state[intent.target];
    if (snapshot.revision === 0 || !snapshot.scene) {
      throw new ProductionError(
        intent.target === 'preview' ? 'PREVIEW_EMPTY' : 'PROGRAM_EMPTY',
        `Load a Scene into ${intent.target === 'preview' ? 'Preview' : 'Program'} before changing visibility`,
        409
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
        }
      );
    }

    const executedAt = Date.now();
    const nextSnapshot: ProductionSnapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      elements: elementsWithVisibility(snapshot.elements, intent.componentId, intent.visible),
      updatedAt: executedAt,
    };
    this.commitSnapshot(state, nextSnapshot, mutationKind, intent.operationId);
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
    this.publishCommittedSnapshot(nextSnapshot);
    return { receipt: clone(receipt), state: this.publicState(state) };
  }

  executeCue(
    execution: ProductionCueExecution,
    authorization: ProductionIntentAuthorization
  ): ProductionCueResult {
    this.assertAuthorityUsable();
    this.validateCueExecution(execution);
    const { cue } = execution;
    const state = this.getOrCreate(cue.showId);
    if (cue.target === 'program' && !authorization.directProgram) {
      throw new ProductionError(
        'DIRECT_PROGRAM_FORBIDDEN',
        'Direct Program cue execution requires explicit authorization',
        403
      );
    }
    this.assertTargetAvailable(cue.showId, cue.target);

    const fingerprint = cueFingerprint(execution);
    const prior = state.cueOperations.get(execution.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new ProductionError(
          'OPERATION_ID_CONFLICT',
          'operationId was already used for a different cue execution',
          409,
          { operationId: execution.operationId }
        );
      }
      return { receipt: clone(prior.receipt), state: this.publicState(state) };
    }

    const initialSnapshot = state[cue.target];
    if (initialSnapshot.revision === 0 || !initialSnapshot.scene) {
      throw new ProductionError(
        cue.target === 'preview' ? 'PREVIEW_EMPTY' : 'PROGRAM_EMPTY',
        `Load a Scene into ${cue.target === 'preview' ? 'Preview' : 'Program'} before executing a cue`,
        409
      );
    }
    if (initialSnapshot.revision !== execution.expectedRevision) {
      throw new ProductionError(
        'TARGET_REVISION_CONFLICT',
        `${cue.target === 'preview' ? 'Preview' : 'Program'} changed before cue execution`,
        409,
        {
          target: cue.target,
          expectedRevision: execution.expectedRevision,
          actualRevision: initialSnapshot.revision,
        }
      );
    }

    const startedAt = Date.now();
    const steps: ProductionCueStepReceipt[] = [];
    let failedStepId: string | undefined;
    for (const [index, step] of cue.steps.entries()) {
      try {
        const result = this.executeVisibilityIntent(
          {
            kind: 'component.visibility',
            showId: cue.showId,
            target: cue.target,
            componentId: step.componentId,
            visible: step.visible,
            operationId: `${execution.operationId}:step:${index}`,
            expectedRevision: state[cue.target].revision,
          },
          authorization,
          'cue.step'
        );
        steps.push({ id: step.id, index, status: 'completed', receipt: result.receipt });
      } catch (error) {
        if (!(error instanceof ProductionError)) throw error;
        if (
          error.code === 'PRODUCTION_AUTHORITY_FAILED' ||
          error.code === 'PRODUCTION_PUBLICATION_FAILED'
        ) {
          throw error;
        }
        failedStepId = step.id;
        steps.push({
          id: step.id,
          index,
          status: 'failed',
          error: { code: error.code, message: error.message, status: error.status },
        });
        break;
      }
    }

    const receipt: ProductionCueReceipt = {
      cueId: cue.id,
      showId: cue.showId,
      target: cue.target,
      operationId: execution.operationId,
      status: failedStepId ? 'failed' : 'completed',
      completedSteps: steps.filter((step) => step.status === 'completed').length,
      ...(failedStepId ? { failedStepId } : {}),
      targetRevision: state[cue.target].revision,
      steps,
      startedAt,
      completedAt: Date.now(),
    };
    state.cueOperations.set(execution.operationId, { fingerprint, receipt });
    if (state.cueOperations.size > 100) {
      const firstOperation = state.cueOperations.keys().next().value as string | undefined;
      if (firstOperation) state.cueOperations.delete(firstOperation);
    }
    return { receipt: clone(receipt), state: this.publicState(state) };
  }

  private parseStoredSnapshot(record: StoredProductionSnapshot): ProductionSnapshot {
    let document: unknown;
    try {
      document = JSON.parse(record.payload);
    } catch {
      throw structuralPersistenceError('Persisted production payload is not JSON');
    }
    if (
      !isRecord(document) ||
      document.schemaVersion !== PRODUCTION_SNAPSHOT_DOCUMENT_VERSION ||
      !isRecord(document.snapshot) ||
      Object.keys(document).some((key) => key !== 'schemaVersion' && key !== 'snapshot')
    ) {
      throw structuralPersistenceError('Persisted production envelope is invalid');
    }

    const raw = document.snapshot;
    const snapshotKeys = new Set([
      'showId',
      'bus',
      'revision',
      'scene',
      'elements',
      'variables',
      'controls',
      'orientation',
      'updatedAt',
    ]);
    if (
      Object.keys(raw).length !== snapshotKeys.size ||
      Object.keys(raw).some((key) => !snapshotKeys.has(key)) ||
      raw.showId !== record.showId ||
      raw.bus !== record.target ||
      raw.revision !== record.revision ||
      raw.updatedAt !== record.updatedAt ||
      !Number.isSafeInteger(raw.revision) ||
      (raw.revision as number) < 1 ||
      !Number.isSafeInteger(raw.updatedAt) ||
      (raw.updatedAt as number) < 0 ||
      (raw.orientation !== 'landscape' && raw.orientation !== 'portrait') ||
      !Array.isArray(raw.elements) ||
      !Array.isArray(raw.controls) ||
      !isRecord(raw.variables)
    ) {
      throw structuralPersistenceError('Persisted production snapshot boundary is invalid');
    }

    for (const element of raw.elements) {
      const validationError = validateElementNode(element as ElementNode);
      if (validationError) {
        throw structuralPersistenceError(
          `Persisted live element is invalid: ${validationError.message}`
        );
      }
    }

    if (raw.scene === null) {
      if (
        raw.elements.length !== 0 ||
        raw.controls.length !== 0 ||
        Object.keys(raw.variables).length !== 0 ||
        raw.orientation !== 'landscape'
      ) {
        throw structuralPersistenceError('Persisted empty target contains live state');
      }
    } else {
      if (!isRecord(raw.scene)) {
        throw structuralPersistenceError('Persisted production Scene is invalid');
      }
      const preparedScene = this.prepareScene(raw.scene as unknown as Scene);
      if (canonicalProductionJson(preparedScene) !== canonicalProductionJson(raw.scene)) {
        throw structuralPersistenceError('Persisted production Scene is not normalized');
      }
      if (raw.orientation !== (preparedScene.orientation ?? 'landscape')) {
        throw structuralPersistenceError('Persisted production orientation conflicts with Scene');
      }
      if (
        canonicalProductionJson(elementsWithoutRuntimeVisibility(preparedScene.elements)) !==
        canonicalProductionJson(elementsWithoutRuntimeVisibility(raw.elements as ElementNode[]))
      ) {
        throw structuralPersistenceError(
          'Persisted live elements do not derive from their production Scene'
        );
      }
    }

    const rebuiltControls = buildControlCatalog(raw.elements as ElementNode[], raw.variables);
    if (canonicalProductionJson(rebuiltControls) !== canonicalProductionJson(raw.controls)) {
      throw structuralPersistenceError('Persisted production control catalog is not derivable');
    }

    const snapshot = clone(raw) as unknown as ProductionSnapshot;
    if (productionSnapshotPayload(snapshot) !== record.payload) {
      throw structuralPersistenceError('Persisted production payload is not canonical');
    }
    return snapshot;
  }

  private commitSnapshot(
    state: InternalProductionState,
    snapshot: ProductionSnapshot,
    mutationKind: ProductionMutationKind,
    operationId: string | null = null,
    expectedPreviousRevision: number = state[snapshot.bus].revision,
    rejectedSnapshotHash: string | null = null
  ): void {
    let payload: string;
    try {
      payload = productionSnapshotPayload(snapshot);
    } catch {
      throw new ProductionError(
        'INVALID_PRODUCTION_SNAPSHOT',
        'Production snapshot must contain only finite JSON values',
        400
      );
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_PRODUCTION_SNAPSHOT_BYTES) {
      throw new ProductionError(
        'PRODUCTION_SNAPSHOT_TOO_LARGE',
        'Production snapshot exceeds the 10 MiB authority limit',
        413
      );
    }
    if (snapshot.revision !== expectedPreviousRevision + 1) {
      const error = new Error('Production candidate did not advance exactly one revision');
      this.failAuthority(error);
      throw new ProductionError(
        'PRODUCTION_AUTHORITY_FAILED',
        'Production authority rejected a non-monotonic mutation',
        503
      );
    }
    if (this.persistence) {
      try {
        this.persistence.commit({
          snapshot,
          expectedPreviousRevision,
          mutationKind,
          operationId,
          occurredAt: snapshot.updatedAt as number,
          rejectedSnapshotHash,
        });
      } catch (error) {
        this.failAuthority(error);
        throw new ProductionError(
          'PRODUCTION_AUTHORITY_FAILED',
          'Durable production authority rejected the mutation',
          503,
          {
            cause: error instanceof ProductionStateStoreError ? error.code : 'UNKNOWN',
          }
        );
      }
    }
    state[snapshot.bus] = snapshot;
  }

  private publishCommittedSnapshot(snapshot: ProductionSnapshot): void {
    this.pendingPublications.push({
      snapshot,
      state: this.publicState(this.getOrCreate(snapshot.showId)),
    });
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.pendingPublications.length > 0) {
        const publication = this.pendingPublications.shift()!;
        this.publishSnapshot(publication.snapshot, publication.state);
      }
    } catch (error) {
      this.pendingPublications.length = 0;
      this.failAuthority(error);
      throw new ProductionError(
        'PRODUCTION_PUBLICATION_FAILED',
        'Committed production truth could not be published',
        503
      );
    } finally {
      this.publishing = false;
    }
  }

  private assertAuthorityUsable(): void {
    if (this.authorityFailure) {
      throw new ProductionError(
        'PRODUCTION_AUTHORITY_FAILED',
        'Production authority is unavailable after a fatal integrity failure',
        503
      );
    }
    if (!this.persistenceMounted && !this.allowEphemeral) {
      throw new ProductionError(
        'PRODUCTION_AUTHORITY_NOT_READY',
        'Durable production authority must be mounted before state is exposed',
        503
      );
    }
  }

  private assertTargetAvailable(showId: string, target: ProductionBus): void {
    const quarantine = this.quarantines.get(productionTargetKey(showId, target));
    if (!quarantine) return;
    throw new ProductionError(
      'PRODUCTION_TARGET_QUARANTINED',
      'Production target is quarantined pending explicit human recovery',
      503,
      {
        showId,
        target,
        revision: quarantine.revision,
        rejectedSnapshotHash: quarantine.rejectedSnapshotHash,
        reason: quarantine.reason,
      }
    );
  }

  private failAuthority(error: unknown): void {
    if (this.authorityFailure) return;
    this.authorityFailure = error;
    try {
      this.onFatal(error);
    } catch {
      // The original authority failure remains decisive.
    }
  }

  private newInternalState(showId: string): InternalProductionState {
    return {
      showId,
      preview: emptySnapshot(showId, 'preview'),
      program: emptySnapshot(showId, 'program'),
      lastTake: null,
      takeOperations: new Map(),
      controlOperations: new Set(),
      visibilityOperations: new Map(),
      cueOperations: new Map(),
    };
  }

  private getOrCreate(showId: string): InternalProductionState {
    this.validateShowId(showId);
    let state = this.shows.get(showId);
    if (!state) {
      state = this.newInternalState(showId);
      this.shows.set(showId, state);
    }
    return state;
  }

  private prepareScene(sourceScene: Scene): Scene {
    const sceneValidationError = validateSceneNode(sourceScene);
    if (sceneValidationError) {
      throw new ProductionError(
        sceneValidationError.code,
        sceneValidationError.message,
        400,
        sceneValidationError.details as Record<string, unknown>
      );
    }
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
          validationError.details as Record<string, unknown> | undefined
        );
      }
    }
    source.elements = preserveTemplatesInElements(hoistCountdownTriggers(source.elements));
    return source;
  }

  private validateOperationId(operationId: string): void {
    if (
      typeof operationId !== 'string' ||
      operationId.length === 0 ||
      operationId.length > 100 ||
      operationId !== operationId.trim()
    ) {
      throw new ProductionError(
        'INVALID_OPERATION_ID',
        'operationId must be 1 to 100 characters',
        400
      );
    }
  }

  private validateShowId(showId: string): void {
    if (
      typeof showId !== 'string' ||
      showId.length === 0 ||
      showId.length > 100 ||
      showId !== showId.trim()
    ) {
      throw new ProductionError('INVALID_SHOW_ID', 'Show id must be 1 to 100 characters', 400);
    }
  }

  private validateTarget(target: ProductionBus): void {
    if (target !== 'preview' && target !== 'program') {
      throw new ProductionError(
        'INVALID_PRODUCTION_TARGET',
        'Production target must be Preview or Program',
        400
      );
    }
  }

  private validateVisibilityIntent(intent: ComponentVisibilityIntent): void {
    if (!intent || typeof intent !== 'object' || intent.kind !== 'component.visibility') {
      throw new ProductionError(
        'INVALID_VISIBILITY_INTENT',
        'A component.visibility intent is required',
        400
      );
    }
    if (!intent.showId || typeof intent.showId !== 'string') {
      throw new ProductionError('INVALID_SHOW_ID', 'Visibility intent must name a Show', 400);
    }
    if (intent.target !== 'preview' && intent.target !== 'program') {
      throw new ProductionError(
        'INVALID_PRODUCTION_TARGET',
        'Visibility intent must target Preview or Program',
        400
      );
    }
    if (
      !intent.componentId ||
      typeof intent.componentId !== 'string' ||
      intent.componentId.length > 100
    ) {
      throw new ProductionError(
        'INVALID_COMPONENT_ID',
        'componentId must be 1 to 100 characters',
        400
      );
    }
    if (typeof intent.visible !== 'boolean') {
      throw new ProductionError('INVALID_VISIBILITY', 'visible must be boolean', 400);
    }
    if (!Number.isInteger(intent.expectedRevision) || intent.expectedRevision < 0) {
      throw new ProductionError(
        'INVALID_TARGET_REVISION',
        'expectedRevision must be a non-negative integer',
        400
      );
    }
    this.validateOperationId(intent.operationId);
  }

  private validateCueExecution(execution: ProductionCueExecution): void {
    if (
      !execution ||
      typeof execution !== 'object' ||
      !execution.cue ||
      typeof execution.cue !== 'object'
    ) {
      throw new ProductionError('INVALID_CUE', 'A production cue is required', 400);
    }
    const { cue } = execution;
    if (!cue.id || typeof cue.id !== 'string' || cue.id.length > 100) {
      throw new ProductionError('INVALID_CUE_ID', 'cue.id must be 1 to 100 characters', 400);
    }
    if (!cue.showId || typeof cue.showId !== 'string') {
      throw new ProductionError('INVALID_SHOW_ID', 'Cue must name a Show', 400);
    }
    if (cue.target !== 'preview' && cue.target !== 'program') {
      throw new ProductionError(
        'INVALID_PRODUCTION_TARGET',
        'Cue must target Preview or Program',
        400
      );
    }
    if (!Array.isArray(cue.steps) || cue.steps.length === 0 || cue.steps.length > 20) {
      throw new ProductionError('INVALID_CUE_STEPS', 'Cue must contain 1 to 20 steps', 400);
    }
    const ids = new Set<string>();
    for (const step of cue.steps) {
      if (
        !step ||
        typeof step !== 'object' ||
        !step.id ||
        typeof step.id !== 'string' ||
        step.id.length > 100
      ) {
        throw new ProductionError(
          'INVALID_CUE_STEP_ID',
          'Every cue step requires an id of 1 to 100 characters',
          400
        );
      }
      if (ids.has(step.id)) {
        throw new ProductionError(
          'DUPLICATE_CUE_STEP_ID',
          'Cue step identifiers must be unique',
          400,
          { stepId: step.id }
        );
      }
      ids.add(step.id);
      if (step.kind !== 'component.visibility') {
        throw new ProductionError(
          'INVALID_CUE_STEP_KIND',
          'Slice 1 supports only component.visibility steps',
          400
        );
      }
      if (
        !step.componentId ||
        typeof step.componentId !== 'string' ||
        step.componentId.length > 100
      ) {
        throw new ProductionError(
          'INVALID_COMPONENT_ID',
          'Every cue step requires a componentId',
          400
        );
      }
      if (typeof step.visible !== 'boolean') {
        throw new ProductionError(
          'INVALID_VISIBILITY',
          'Every cue step requires boolean visible state',
          400
        );
      }
    }
    if (!Number.isInteger(execution.expectedRevision) || execution.expectedRevision < 0) {
      throw new ProductionError(
        'INVALID_TARGET_REVISION',
        'expectedRevision must be a non-negative integer',
        400
      );
    }
    if (
      !execution.operationId ||
      typeof execution.operationId !== 'string' ||
      execution.operationId.length > 70 ||
      execution.operationId !== execution.operationId.trim()
    ) {
      throw new ProductionError(
        'INVALID_OPERATION_ID',
        'Cue operationId must be 1 to 70 characters',
        400
      );
    }
  }

  private publishSnapshot(snapshot: ProductionSnapshot, state?: ProductionState): void {
    const observedState = state ?? this.publicState(this.getOrCreate(snapshot.showId));
    for (const observer of [...(this.observers.get(snapshot.showId) ?? [])]) {
      try {
        observer(
          Object.freeze({
            showId: snapshot.showId,
            target: snapshot.bus,
            state: clone(observedState),
          })
        );
      } catch {
        // Production truth is already committed; an observer owns its fail-closed response.
      }
    }
    const key = productionRouteKey(snapshot.showId, snapshot.bus);
    this.channels.replaceVariables(key, clone(snapshot.variables));
    this.channels.clearElements(key);
    for (const element of clone(snapshot.elements)) this.channels.addElement(key, element);
    if (snapshot.scene) this.channels.setActiveScene(key, clone(snapshot.scene));
    else this.channels.clearActiveScene(key);
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
  ProductionCue,
  ProductionCueExecution,
  ProductionCueReceipt,
  ProductionCueResult,
  ProductionCueStepReceipt,
  ProductionBus,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '../types/production';
