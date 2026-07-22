import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  CONTROL_ACTION_CATALOG_VERSION,
  type AuthorizedControlActionCatalog,
  type ComponentVisibilityActionDescriptor,
} from './control-action-catalog.js';
import {
  DEFAULT_CONTROL_FEEDBACK_TIMEOUT_MS,
  type AuthoritativeServerObservation,
  type ControlFeedbackSubject,
  type ControlFeedbackValue,
} from './control-feedback.js';
import type { ProductionBus } from './production.js';

export const DEVICE_CONTROL_FRAME_VERSION = 'overlaykit-device-control-frame/v2' as const;
export const DEVICE_CONTROL_CATALOG_VERSION = 'overlaykit-device-control-catalog/v1' as const;
export const DEVICE_CONTROL_FRAME_ENVELOPE_VERSION =
  'overlaykit-device-control-frame-envelope/v3' as const;
export const DEVICE_CONTROL_FRAME_STATE_VERSION =
  'overlaykit-device-control-frame-state/v2' as const;

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_COMPONENT_ID_LENGTH = 100;
const MAX_LABEL_LENGTH = 160;
const MAX_CONTROLS = 1_000;
const MAX_SIGNATURE_LENGTH = 4_096;
const MAX_PAYLOAD_BYTES = 1_048_576;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type DeviceControlFrameMode = 'bootstrap' | 'delta';

export interface DeviceControlFrame {
  readonly schemaVersion: typeof DEVICE_CONTROL_FRAME_VERSION;
  readonly mode: DeviceControlFrameMode;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly catalogGeneration: number;
  readonly confirmedAt: number;
  readonly catalogHash: string;
  readonly addedActions: ReadonlyArray<ComponentVisibilityActionDescriptor>;
  readonly removedControlIds: ReadonlyArray<string>;
  readonly observations: ReadonlyArray<AuthoritativeServerObservation>;
}

export interface UnsignedDeviceControlFrameEnvelope {
  readonly schemaVersion: typeof DEVICE_CONTROL_FRAME_ENVELOPE_VERSION;
  readonly issuerKeyId: string;
  readonly audienceCredentialId: string;
  readonly sequence: number;
  readonly baseIssuerKeyId: string | null;
  readonly baseSequence: number | null;
  readonly baseSha256: string | null;
  readonly frame: DeviceControlFrame;
}

export interface DeviceControlFrameIdentity {
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
}

export interface DeviceControlFrameAuthorityContext {
  readonly issuerKeyId: string;
  readonly audienceCredentialId: string;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<'feedback:read' | 'component.visibility:write'>;
  readonly lastAcceptedSequence: number;
  readonly acceptedFrameIdentities?: ReadonlyArray<DeviceControlFrameIdentity>;
}

export type DeviceControlFrameSignatureVerifier = (
  signingBytes: Uint8Array,
  signature: string,
  issuerKeyId: string
) => boolean | Promise<boolean>;

export interface AdmittedDeviceControlFrame {
  readonly frame: DeviceControlFrame;
  readonly identity: DeviceControlFrameIdentity;
  readonly base: DeviceControlFrameIdentity | null;
  readonly acceptedSequence: number;
  readonly duplicate: boolean;
}

export interface AdmittedDeviceControlFrameState {
  readonly identity: DeviceControlFrameIdentity;
  readonly state: DeviceControlFrameState;
}

export interface ReducedAdmittedDeviceControlFrame {
  readonly state: AdmittedDeviceControlFrameState;
  readonly applied: boolean;
}

export interface DeviceControlFrameEntry {
  readonly action: ComponentVisibilityActionDescriptor;
  readonly value: ControlFeedbackValue;
  readonly valueRevision: number;
  readonly valueObservedAt: number;
}

export interface DeviceControlFrameState {
  readonly schemaVersion: typeof DEVICE_CONTROL_FRAME_STATE_VERSION;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly catalogGeneration: number;
  readonly confirmedAt: number;
  readonly catalogHash: string;
  readonly controls: ReadonlyArray<DeviceControlFrameEntry>;
}

export interface DeviceControlFrameInput {
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly catalogGeneration: number;
  readonly confirmedAt: number;
  readonly catalog: AuthorizedControlActionCatalog;
  readonly observations: ReadonlyArray<AuthoritativeServerObservation>;
}

export interface AvailableDeviceControlView {
  readonly available: true;
  readonly subject: ControlFeedbackSubject;
  readonly status: 'current' | 'stale' | 'unknown';
  readonly buttonState: ControlFeedbackValue | 'unknown';
  readonly reason: 'revision-confirmed' | 'confirmation-timeout' | 'clock-skew';
  readonly lastKnownState: ControlFeedbackValue;
  readonly revision: number;
  readonly valueRevision: number;
  readonly valueObservedAt: number;
  readonly confirmedAt: number;
  readonly expiresAt: number;
}

export interface UnavailableDeviceControlView {
  readonly available: false;
  readonly subject: ControlFeedbackSubject;
  readonly status: 'unavailable';
  readonly buttonState: 'unavailable';
  readonly reason: 'not-in-authorized-catalog';
}

export type DeviceControlView = AvailableDeviceControlView | UnavailableDeviceControlView;

export type DeviceControlFrameErrorCode =
  | 'INVALID_FRAME'
  | 'INVALID_CATALOG'
  | 'INVALID_OBSERVATION'
  | 'INVALID_STATE'
  | 'INVALID_TRANSITION'
  | 'BASE_MISMATCH'
  | 'OUT_OF_ORDER_FRAME'
  | 'CATALOG_HASH_MISMATCH'
  | 'CRYPTO_UNAVAILABLE';

export class DeviceControlFrameError extends Error {
  constructor(
    public readonly code: DeviceControlFrameErrorCode,
    message: string
  ) {
    super(message);
  }
}

export type DeviceControlFrameAdmissionCode =
  | 'INVALID_ENVELOPE'
  | 'UNTRUSTED_ISSUER'
  | 'INVALID_SIGNATURE'
  | 'AUDIENCE_FORBIDDEN'
  | 'SCOPE_FORBIDDEN'
  | 'SHOW_FORBIDDEN'
  | 'TARGET_FORBIDDEN'
  | 'CONTROL_FORBIDDEN'
  | 'FRAME_REPLAYED';

export class DeviceControlFrameAdmissionError extends Error {
  constructor(
    public readonly code: DeviceControlFrameAdmissionCode,
    message: string
  ) {
    super(message);
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requiredIdentifier(
  value: unknown,
  field: string,
  code: DeviceControlFrameErrorCode = 'INVALID_FRAME',
  maxLength = MAX_IDENTIFIER_LENGTH
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    throw new DeviceControlFrameError(code, `${field} is invalid`);
  }
  return value;
}

function requiredTarget(
  value: unknown,
  code: DeviceControlFrameErrorCode = 'INVALID_FRAME'
): ProductionBus {
  if (value !== 'preview' && value !== 'program') {
    throw new DeviceControlFrameError(code, 'Production target is invalid');
  }
  return value;
}

function requiredRevision(
  value: unknown,
  field: string,
  code: DeviceControlFrameErrorCode = 'INVALID_FRAME'
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DeviceControlFrameError(code, `${field} is invalid`);
  }
  return value as number;
}

function requiredTime(
  value: unknown,
  field: string,
  code: DeviceControlFrameErrorCode = 'INVALID_FRAME'
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DeviceControlFrameError(code, `${field} is invalid`);
  }
  return value;
}

function normalizedIdentity(
  value: DeviceControlFrameIdentity,
  code: DeviceControlFrameErrorCode = 'INVALID_STATE'
): DeviceControlFrameIdentity {
  if (!value || typeof value !== 'object') {
    throw new DeviceControlFrameError(code, 'Device control frame identity is invalid');
  }
  const issuerKeyId = requiredIdentifier(value.issuerKeyId, 'Identity issuer', code);
  const sequence = requiredRevision(value.sequence, 'Identity sequence', code);
  if (sequence === 0 || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new DeviceControlFrameError(code, 'Device control frame identity is invalid');
  }
  return Object.freeze({ issuerKeyId, sequence, sha256: value.sha256 });
}

function sameIdentity(
  left: DeviceControlFrameIdentity,
  right: DeviceControlFrameIdentity
): boolean {
  return (
    left.issuerKeyId === right.issuerKeyId &&
    left.sequence === right.sequence &&
    left.sha256 === right.sha256
  );
}

function normalizedAction(
  value: ComponentVisibilityActionDescriptor,
  showId: string,
  target: ProductionBus
): ComponentVisibilityActionDescriptor {
  if (!value || typeof value !== 'object') {
    throw new DeviceControlFrameError('INVALID_CATALOG', 'Action descriptor is invalid');
  }
  const componentId = requiredIdentifier(
    value.componentId,
    'Component identifier',
    'INVALID_CATALOG',
    MAX_COMPONENT_ID_LENGTH
  );
  const controlId = requiredIdentifier(
    value.subject?.controlId,
    'Control identifier',
    'INVALID_CATALOG'
  );
  const label = requiredIdentifier(
    value.label,
    'Action label',
    'INVALID_CATALOG',
    MAX_LABEL_LENGTH
  );
  const expectedControlId = `${componentId}.visibility`;
  const expectedActionId = `${COMPONENT_VISIBILITY_ACTION_KIND}/${target}/${encodeURIComponent(componentId)}`;
  if (
    value.kind !== COMPONENT_VISIBILITY_ACTION_KIND ||
    value.actionId !== expectedActionId ||
    value.subject?.showId !== showId ||
    value.subject?.target !== target ||
    controlId !== expectedControlId ||
    value.input?.visible?.type !== 'boolean' ||
    value.input?.visible?.required !== true
  ) {
    throw new DeviceControlFrameError(
      'INVALID_CATALOG',
      'Action descriptor does not match its canonical visibility subject'
    );
  }
  return {
    actionId: expectedActionId,
    kind: COMPONENT_VISIBILITY_ACTION_KIND,
    subject: { showId, target, controlId },
    componentId,
    label,
    input: { visible: { type: 'boolean', required: true } },
  };
}

function normalizedTargetActions(
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>,
  showId: string,
  target: ProductionBus
): ReadonlyArray<ComponentVisibilityActionDescriptor> {
  if (!Array.isArray(actions) || actions.length > MAX_CONTROLS) {
    throw new DeviceControlFrameError('INVALID_CATALOG', 'Target action catalog is invalid');
  }
  const normalized = actions.map((action) => normalizedAction(action, showId, target));
  const identities = new Set<string>();
  for (const action of normalized) {
    if (identities.has(action.subject.controlId)) {
      throw new DeviceControlFrameError('INVALID_CATALOG', 'Target controls must be unique');
    }
    identities.add(action.subject.controlId);
  }
  return normalized.sort((left, right) =>
    compareText(left.subject.controlId, right.subject.controlId)
  );
}

function actionsForTarget(
  catalog: AuthorizedControlActionCatalog,
  showId: string,
  target: ProductionBus
): ReadonlyArray<ComponentVisibilityActionDescriptor> {
  if (
    !catalog ||
    typeof catalog !== 'object' ||
    catalog.schemaVersion !== CONTROL_ACTION_CATALOG_VERSION ||
    catalog.showId !== showId ||
    !Array.isArray(catalog.actions) ||
    catalog.actions.length > MAX_CONTROLS
  ) {
    throw new DeviceControlFrameError('INVALID_CATALOG', 'Authorized action catalog is invalid');
  }

  const allIdentities = new Set<string>();
  const selected: ComponentVisibilityActionDescriptor[] = [];
  for (const action of catalog.actions) {
    const actionTarget = requiredTarget(action?.subject?.target, 'INVALID_CATALOG');
    const normalized = normalizedAction(action, showId, actionTarget);
    const identity = `${actionTarget}\u0000${normalized.subject.controlId}`;
    if (allIdentities.has(identity)) {
      throw new DeviceControlFrameError('INVALID_CATALOG', 'Catalog actions must be unique');
    }
    allIdentities.add(identity);
    if (actionTarget === target) selected.push(normalized);
  }
  return selected.sort((left, right) =>
    compareText(left.subject.controlId, right.subject.controlId)
  );
}

function normalizedObservation(
  value: AuthoritativeServerObservation,
  showId: string,
  target: ProductionBus
): AuthoritativeServerObservation {
  if (
    !value ||
    typeof value !== 'object' ||
    value.kind !== 'server.state.observed' ||
    value.subject?.showId !== showId ||
    value.subject?.target !== target ||
    (value.value !== 'active' && value.value !== 'inactive')
  ) {
    throw new DeviceControlFrameError('INVALID_OBSERVATION', 'Server observation is invalid');
  }
  const controlId = requiredIdentifier(
    value.subject.controlId,
    'Observation control identifier',
    'INVALID_OBSERVATION'
  );
  return {
    kind: 'server.state.observed',
    subject: { showId, target, controlId },
    value: value.value,
    revision: requiredRevision(value.revision, 'Observation revision', 'INVALID_OBSERVATION'),
    observedAt: requiredTime(value.observedAt, 'Observation time', 'INVALID_OBSERVATION'),
  };
}

function normalizedObservations(
  observations: ReadonlyArray<AuthoritativeServerObservation>,
  showId: string,
  target: ProductionBus
): ReadonlyArray<AuthoritativeServerObservation> {
  if (!Array.isArray(observations) || observations.length > MAX_CONTROLS) {
    throw new DeviceControlFrameError('INVALID_OBSERVATION', 'Observation collection is invalid');
  }
  const normalized = observations.map((observation) =>
    normalizedObservation(observation, showId, target)
  );
  const identities = new Set<string>();
  for (const observation of normalized) {
    if (identities.has(observation.subject.controlId)) {
      throw new DeviceControlFrameError('INVALID_OBSERVATION', 'Observations must be unique');
    }
    identities.add(observation.subject.controlId);
  }
  return normalized.sort((left, right) =>
    compareText(left.subject.controlId, right.subject.controlId)
  );
}

function normalizedFrame(value: DeviceControlFrame): DeviceControlFrame {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== DEVICE_CONTROL_FRAME_VERSION ||
    (value.mode !== 'bootstrap' && value.mode !== 'delta') ||
    !Array.isArray(value.addedActions) ||
    !Array.isArray(value.removedControlIds) ||
    !Array.isArray(value.observations) ||
    value.addedActions.length > MAX_CONTROLS ||
    value.removedControlIds.length > MAX_CONTROLS ||
    value.observations.length > MAX_CONTROLS ||
    !SHA256_PATTERN.test(value.catalogHash)
  ) {
    throw new DeviceControlFrameError('INVALID_FRAME', 'Device control frame is invalid');
  }
  const showId = requiredIdentifier(value.showId, 'Frame Show identifier');
  const target = requiredTarget(value.target);
  const revision = requiredRevision(value.revision, 'Frame revision');
  const catalogGeneration = requiredRevision(value.catalogGeneration, 'Frame catalog generation');
  if (catalogGeneration === 0) {
    throw new DeviceControlFrameError('INVALID_FRAME', 'Frame catalog generation must be positive');
  }
  const confirmedAt = requiredTime(value.confirmedAt, 'Frame confirmation time');
  const addedActions = normalizedTargetActions(value.addedActions, showId, target);
  const removedControlIds = value.removedControlIds
    .map((controlId) => requiredIdentifier(controlId, 'Removed control identifier'))
    .sort(compareText);
  if (new Set(removedControlIds).size !== removedControlIds.length) {
    throw new DeviceControlFrameError('INVALID_FRAME', 'Removed controls must be unique');
  }
  const observations = normalizedObservations(value.observations, showId, target);
  const observationIds = new Set(observations.map((item) => item.subject.controlId));
  for (const action of addedActions) {
    if (!observationIds.has(action.subject.controlId)) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'Every added control requires an initial observation in the same frame'
      );
    }
  }
  for (const observation of observations) {
    if (observation.revision !== revision || observation.observedAt !== confirmedAt) {
      throw new DeviceControlFrameError(
        'INVALID_OBSERVATION',
        'Frame observations must bind its revision and confirmation time'
      );
    }
  }
  if (value.mode === 'bootstrap') {
    if (removedControlIds.length > 0 || observations.length !== addedActions.length) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'Bootstrap must contain exactly one initial observation per action and no removals'
      );
    }
  }
  return {
    schemaVersion: DEVICE_CONTROL_FRAME_VERSION,
    mode: value.mode,
    showId,
    target,
    revision,
    catalogGeneration,
    confirmedAt,
    catalogHash: value.catalogHash,
    addedActions,
    removedControlIds,
    observations,
  };
}

function normalizedState(value: DeviceControlFrameState): DeviceControlFrameState {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== DEVICE_CONTROL_FRAME_STATE_VERSION ||
    !Array.isArray(value.controls) ||
    value.controls.length > MAX_CONTROLS ||
    !SHA256_PATTERN.test(value.catalogHash)
  ) {
    throw new DeviceControlFrameError('INVALID_STATE', 'Device control state is invalid');
  }
  const showId = requiredIdentifier(value.showId, 'State Show identifier', 'INVALID_STATE');
  const target = requiredTarget(value.target, 'INVALID_STATE');
  const revision = requiredRevision(value.revision, 'State revision', 'INVALID_STATE');
  const catalogGeneration = requiredRevision(
    value.catalogGeneration,
    'State catalog generation',
    'INVALID_STATE'
  );
  if (catalogGeneration === 0) {
    throw new DeviceControlFrameError('INVALID_STATE', 'State catalog generation must be positive');
  }
  const confirmedAt = requiredTime(value.confirmedAt, 'State confirmation time', 'INVALID_STATE');
  const controls = value.controls
    .map((entry): DeviceControlFrameEntry => {
      if (!entry || typeof entry !== 'object') {
        throw new DeviceControlFrameError('INVALID_STATE', 'Device control entry is invalid');
      }
      const action = normalizedAction(entry.action, showId, target);
      const valueRevision = requiredRevision(
        entry.valueRevision,
        'Control value revision',
        'INVALID_STATE'
      );
      const valueObservedAt = requiredTime(
        entry.valueObservedAt,
        'Control value observation time',
        'INVALID_STATE'
      );
      if (
        (entry.value !== 'active' && entry.value !== 'inactive') ||
        valueRevision > revision ||
        valueObservedAt > confirmedAt
      ) {
        throw new DeviceControlFrameError('INVALID_STATE', 'Device control value is invalid');
      }
      return {
        action,
        value: entry.value,
        valueRevision,
        valueObservedAt,
      };
    })
    .sort((left, right) =>
      compareText(left.action.subject.controlId, right.action.subject.controlId)
    );
  const identities = new Set(controls.map((entry) => entry.action.subject.controlId));
  if (identities.size !== controls.length) {
    throw new DeviceControlFrameError('INVALID_STATE', 'State controls must be unique');
  }
  return {
    schemaVersion: DEVICE_CONTROL_FRAME_STATE_VERSION,
    showId,
    target,
    revision,
    catalogGeneration,
    confirmedAt,
    catalogHash: value.catalogHash,
    controls,
  };
}

function catalogDocument(
  showId: string,
  target: ProductionBus,
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>
): object {
  return {
    schemaVersion: DEVICE_CONTROL_CATALOG_VERSION,
    showId,
    target,
    actions: normalizedTargetActions(actions, showId, target),
  };
}

export function deviceControlCatalogBytes(
  showId: string,
  target: ProductionBus,
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>
): Uint8Array {
  const normalizedShowId = requiredIdentifier(showId, 'Catalog Show identifier', 'INVALID_CATALOG');
  const normalizedTarget = requiredTarget(target, 'INVALID_CATALOG');
  return new TextEncoder().encode(
    JSON.stringify(catalogDocument(normalizedShowId, normalizedTarget, actions))
  );
}

export async function deviceControlCatalogHash(
  showId: string,
  target: ProductionBus,
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new DeviceControlFrameError('CRYPTO_UNAVAILABLE', 'SHA-256 is unavailable');
  }
  const bytes = deviceControlCatalogBytes(showId, target, actions);
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function completeObservationMap(
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>,
  observations: ReadonlyArray<AuthoritativeServerObservation>
): ReadonlyMap<string, AuthoritativeServerObservation> {
  const actionIds = new Set(actions.map((action) => action.subject.controlId));
  const observationMap = new Map(
    observations.map((observation) => [observation.subject.controlId, observation])
  );
  if (
    actionIds.size !== observationMap.size ||
    [...actionIds].some((controlId) => !observationMap.has(controlId))
  ) {
    throw new DeviceControlFrameError(
      'INVALID_OBSERVATION',
      'Current observations must exactly cover the target catalog'
    );
  }
  return observationMap;
}

function normalizedInput(input: DeviceControlFrameInput): {
  showId: string;
  target: ProductionBus;
  revision: number;
  catalogGeneration: number;
  confirmedAt: number;
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>;
  observations: ReadonlyArray<AuthoritativeServerObservation>;
} {
  if (!input || typeof input !== 'object') {
    throw new DeviceControlFrameError('INVALID_FRAME', 'Frame input is invalid');
  }
  const showId = requiredIdentifier(input.showId, 'Input Show identifier');
  const target = requiredTarget(input.target);
  const revision = requiredRevision(input.revision, 'Input revision');
  const catalogGeneration = requiredRevision(input.catalogGeneration, 'Input catalog generation');
  if (catalogGeneration === 0) {
    throw new DeviceControlFrameError('INVALID_FRAME', 'Input catalog generation must be positive');
  }
  const confirmedAt = requiredTime(input.confirmedAt, 'Input confirmation time');
  const actions = actionsForTarget(input.catalog, showId, target);
  const observations = normalizedObservations(input.observations, showId, target);
  for (const observation of observations) {
    if (observation.revision !== revision || observation.observedAt !== confirmedAt) {
      throw new DeviceControlFrameError(
        'INVALID_OBSERVATION',
        'Input observations must bind its revision and confirmation time'
      );
    }
  }
  completeObservationMap(actions, observations);
  return {
    showId,
    target,
    revision,
    catalogGeneration,
    confirmedAt,
    actions,
    observations,
  };
}

export async function buildDeviceControlBootstrapFrame(
  input: DeviceControlFrameInput
): Promise<DeviceControlFrame> {
  const normalized = normalizedInput(input);
  return normalizedFrame({
    schemaVersion: DEVICE_CONTROL_FRAME_VERSION,
    mode: 'bootstrap',
    showId: normalized.showId,
    target: normalized.target,
    revision: normalized.revision,
    catalogGeneration: normalized.catalogGeneration,
    confirmedAt: normalized.confirmedAt,
    catalogHash: await deviceControlCatalogHash(
      normalized.showId,
      normalized.target,
      normalized.actions
    ),
    addedActions: normalized.actions,
    removedControlIds: [],
    observations: normalized.observations,
  });
}

function sameAction(
  left: ComponentVisibilityActionDescriptor,
  right: ComponentVisibilityActionDescriptor
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function buildDeviceControlDeltaFrame(
  current: DeviceControlFrameState,
  input: DeviceControlFrameInput
): Promise<DeviceControlFrame> {
  const state = normalizedState(current);
  const currentHash = await deviceControlCatalogHash(
    state.showId,
    state.target,
    state.controls.map((entry) => entry.action)
  );
  if (currentHash !== state.catalogHash) {
    throw new DeviceControlFrameError('INVALID_STATE', 'Current state catalog hash is invalid');
  }
  const next = normalizedInput(input);
  if (next.showId !== state.showId || next.target !== state.target) {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'A delta cannot change its Show or production target'
    );
  }
  if (next.revision < state.revision || next.confirmedAt < state.confirmedAt) {
    throw new DeviceControlFrameError('OUT_OF_ORDER_FRAME', 'Delta input predates current state');
  }
  if (next.catalogGeneration < state.catalogGeneration) {
    throw new DeviceControlFrameError(
      'OUT_OF_ORDER_FRAME',
      'Delta input predates the current catalog generation'
    );
  }

  const currentById = new Map(
    state.controls.map((entry) => [entry.action.subject.controlId, entry])
  );
  const nextById = new Map(next.actions.map((action) => [action.subject.controlId, action]));
  const observationsById = completeObservationMap(next.actions, next.observations);
  const addedActions: ComponentVisibilityActionDescriptor[] = [];
  const removedControlIds: string[] = [];
  const observations: AuthoritativeServerObservation[] = [];

  for (const entry of state.controls) {
    const controlId = entry.action.subject.controlId;
    const nextAction = nextById.get(controlId);
    if (!nextAction || !sameAction(entry.action, nextAction)) removedControlIds.push(controlId);
  }
  for (const action of next.actions) {
    const controlId = action.subject.controlId;
    const currentEntry = currentById.get(controlId);
    const replaced = currentEntry && !sameAction(currentEntry.action, action);
    if (!currentEntry || replaced) addedActions.push(action);
    const observation = observationsById.get(controlId) as AuthoritativeServerObservation;
    if (!currentEntry || replaced || observation.value !== currentEntry.value) {
      observations.push(observation);
    }
  }
  if (
    next.revision === state.revision &&
    (addedActions.length > 0 || removedControlIds.length > 0 || observations.length > 0)
  ) {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'Catalog or value changes require a newer production revision'
    );
  }
  if (
    (addedActions.length > 0 || removedControlIds.length > 0) &&
    next.catalogGeneration === state.catalogGeneration
  ) {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'Catalog changes require a newer catalog generation'
    );
  }

  return normalizedFrame({
    schemaVersion: DEVICE_CONTROL_FRAME_VERSION,
    mode: 'delta',
    showId: next.showId,
    target: next.target,
    revision: next.revision,
    catalogGeneration: next.catalogGeneration,
    confirmedAt: next.confirmedAt,
    catalogHash: await deviceControlCatalogHash(next.showId, next.target, next.actions),
    addedActions,
    removedControlIds,
    observations,
  });
}

function normalizedUnsignedEnvelope(
  envelope: UnsignedDeviceControlFrameEnvelope
): UnsignedDeviceControlFrameEnvelope {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.schemaVersion !== DEVICE_CONTROL_FRAME_ENVELOPE_VERSION ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence <= 0
  ) {
    throw new DeviceControlFrameAdmissionError(
      'INVALID_ENVELOPE',
      'Device control frame envelope is invalid'
    );
  }
  let issuerKeyId: string;
  let audienceCredentialId: string;
  let frame: DeviceControlFrame;
  try {
    issuerKeyId = requiredIdentifier(envelope.issuerKeyId, 'Issuer key identifier');
    audienceCredentialId = requiredIdentifier(
      envelope.audienceCredentialId,
      'Credential audience identifier'
    );
    frame = normalizedFrame(envelope.frame);
  } catch (error) {
    if (error instanceof DeviceControlFrameError) {
      throw new DeviceControlFrameAdmissionError('INVALID_ENVELOPE', error.message);
    }
    throw error;
  }
  const baseFieldsAreNull =
    envelope.baseIssuerKeyId === null &&
    envelope.baseSequence === null &&
    envelope.baseSha256 === null;
  let baseIssuerKeyId: string | null = null;
  let baseSequence: number | null = null;
  let baseSha256: string | null = null;
  if (frame.mode === 'bootstrap') {
    if (!baseFieldsAreNull) {
      throw new DeviceControlFrameAdmissionError(
        'INVALID_ENVELOPE',
        'Bootstrap frame cannot declare a prior base'
      );
    }
  } else {
    try {
      baseIssuerKeyId = requiredIdentifier(
        envelope.baseIssuerKeyId,
        'Delta base issuer'
      );
      baseSequence = requiredRevision(envelope.baseSequence, 'Delta base sequence');
    } catch (error) {
      if (error instanceof DeviceControlFrameError) {
        throw new DeviceControlFrameAdmissionError('INVALID_ENVELOPE', error.message);
      }
      throw error;
    }
    if (
      baseIssuerKeyId !== issuerKeyId ||
      baseSequence === 0 ||
      baseSequence >= envelope.sequence ||
      typeof envelope.baseSha256 !== 'string' ||
      !SHA256_PATTERN.test(envelope.baseSha256)
    ) {
      throw new DeviceControlFrameAdmissionError(
        'INVALID_ENVELOPE',
        'Delta frame base is invalid'
      );
    }
    baseSha256 = envelope.baseSha256;
  }
  return {
    schemaVersion: DEVICE_CONTROL_FRAME_ENVELOPE_VERSION,
    issuerKeyId,
    audienceCredentialId,
    sequence: envelope.sequence,
    baseIssuerKeyId,
    baseSequence,
    baseSha256,
    frame,
  };
}

export function deviceControlFramePayloadBytes(
  envelope: UnsignedDeviceControlFrameEnvelope
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizedUnsignedEnvelope(envelope)));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function parseCanonicalPayload(payloadBytes: Uint8Array): UnsignedDeviceControlFrameEnvelope {
  if (
    !(payloadBytes instanceof Uint8Array) ||
    payloadBytes.byteLength === 0 ||
    payloadBytes.byteLength > MAX_PAYLOAD_BYTES
  ) {
    throw new DeviceControlFrameAdmissionError(
      'INVALID_ENVELOPE',
      'Device control frame payload bytes are invalid'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    throw new DeviceControlFrameAdmissionError(
      'INVALID_ENVELOPE',
      'Device control frame payload is not valid canonical JSON'
    );
  }
  const normalized = normalizedUnsignedEnvelope(parsed as UnsignedDeviceControlFrameEnvelope);
  if (!sameBytes(payloadBytes, deviceControlFramePayloadBytes(normalized))) {
    throw new DeviceControlFrameAdmissionError(
      'INVALID_ENVELOPE',
      'Device control frame payload is not canonical'
    );
  }
  return normalized;
}

function validAuthority(authority: DeviceControlFrameAuthorityContext): boolean {
  let identitiesAreValid = true;
  try {
    const identities = authority.acceptedFrameIdentities ?? [];
    identitiesAreValid =
      Array.isArray(identities) &&
      identities.length <= MAX_CONTROLS &&
      identities.every((identity) => {
        const normalized = normalizedIdentity(identity);
        return normalized.issuerKeyId === authority.issuerKeyId
          && normalized.sequence <= authority.lastAcceptedSequence;
      });
  } catch {
    identitiesAreValid = false;
  }
  return (
    Boolean(authority && typeof authority === 'object') &&
    typeof authority.issuerKeyId === 'string' &&
    typeof authority.audienceCredentialId === 'string' &&
    typeof authority.showId === 'string' &&
    Array.isArray(authority.targets) &&
    authority.targets.every((target) => target === 'preview' || target === 'program') &&
    Array.isArray(authority.controlIds) &&
    authority.controlIds.every((controlId) => typeof controlId === 'string') &&
    Array.isArray(authority.scopes) &&
    Number.isSafeInteger(authority.lastAcceptedSequence) &&
    authority.lastAcceptedSequence >= 0 &&
    identitiesAreValid
  );
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new DeviceControlFrameAdmissionError(
      'INVALID_ENVELOPE',
      'SHA-256 is unavailable'
    );
  }
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function admitDeviceControlFrame(
  payloadBytes: Uint8Array,
  signature: string,
  authority: DeviceControlFrameAuthorityContext,
  verifySignature: DeviceControlFrameSignatureVerifier
): Promise<AdmittedDeviceControlFrame> {
  const unsigned = parseCanonicalPayload(payloadBytes);
  if (
    typeof signature !== 'string' ||
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_LENGTH ||
    !validAuthority(authority)
  ) {
    throw new DeviceControlFrameAdmissionError(
      'INVALID_ENVELOPE',
      'Frame signature or authority is invalid'
    );
  }
  if (unsigned.issuerKeyId !== authority.issuerKeyId) {
    throw new DeviceControlFrameAdmissionError('UNTRUSTED_ISSUER', 'Frame issuer is not pinned');
  }
  let verified = false;
  try {
    verified = await verifySignature(payloadBytes, signature, unsigned.issuerKeyId);
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new DeviceControlFrameAdmissionError('INVALID_SIGNATURE', 'Frame signature is invalid');
  }
  if (unsigned.audienceCredentialId !== authority.audienceCredentialId) {
    throw new DeviceControlFrameAdmissionError(
      'AUDIENCE_FORBIDDEN',
      'Frame belongs to another credential audience'
    );
  }
  if (!authority.scopes.includes('feedback:read')) {
    throw new DeviceControlFrameAdmissionError(
      'SCOPE_FORBIDDEN',
      'Credential cannot read feedback'
    );
  }
  if (unsigned.frame.showId !== authority.showId) {
    throw new DeviceControlFrameAdmissionError('SHOW_FORBIDDEN', 'Frame belongs to another Show');
  }
  if (!authority.targets.includes(unsigned.frame.target)) {
    throw new DeviceControlFrameAdmissionError(
      'TARGET_FORBIDDEN',
      'Frame target is outside credential authority'
    );
  }
  if (
    unsigned.frame.addedActions.length > 0 &&
    !authority.scopes.includes('component.visibility:write')
  ) {
    throw new DeviceControlFrameAdmissionError(
      'SCOPE_FORBIDDEN',
      'Credential cannot receive actionable catalog additions'
    );
  }
  const affectedControlIds = new Set([
    ...unsigned.frame.addedActions.map((action) => action.subject.controlId),
    ...unsigned.frame.removedControlIds,
    ...unsigned.frame.observations.map((observation) => observation.subject.controlId),
  ]);
  if ([...affectedControlIds].some((controlId) => !authority.controlIds.includes(controlId))) {
    throw new DeviceControlFrameAdmissionError(
      'CONTROL_FORBIDDEN',
      'Frame contains a control outside credential authority'
    );
  }
  const identity = Object.freeze({
    issuerKeyId: unsigned.issuerKeyId,
    sequence: unsigned.sequence,
    sha256: await sha256Bytes(payloadBytes),
  });
  const duplicate = (authority.acceptedFrameIdentities ?? []).some((accepted) =>
    sameIdentity(normalizedIdentity(accepted), identity)
  );
  if (unsigned.sequence <= authority.lastAcceptedSequence && !duplicate) {
    throw new DeviceControlFrameAdmissionError(
      'FRAME_REPLAYED',
      'Frame sequence was already admitted'
    );
  }
  const base =
    unsigned.baseIssuerKeyId === null ||
    unsigned.baseSequence === null ||
    unsigned.baseSha256 === null
      ? null
      : Object.freeze({
          issuerKeyId: unsigned.baseIssuerKeyId,
          sequence: unsigned.baseSequence,
          sha256: unsigned.baseSha256,
        });
  return Object.freeze({
    frame: unsigned.frame,
    identity,
    base,
    acceptedSequence: Math.max(authority.lastAcceptedSequence, unsigned.sequence),
    duplicate,
  });
}

async function assertStateCatalogHash(state: DeviceControlFrameState): Promise<void> {
  const actual = await deviceControlCatalogHash(
    state.showId,
    state.target,
    state.controls.map((entry) => entry.action)
  );
  if (actual !== state.catalogHash) {
    throw new DeviceControlFrameError('INVALID_STATE', 'State catalog hash is invalid');
  }
}

export async function reduceDeviceControlFrame(
  current: DeviceControlFrameState | null,
  input: DeviceControlFrame
): Promise<DeviceControlFrameState> {
  const frame = normalizedFrame(input);
  const state = current ? normalizedState(current) : null;
  if (!state && frame.mode !== 'bootstrap') {
    throw new DeviceControlFrameError('INVALID_TRANSITION', 'First frame must be bootstrap');
  }
  if (state && frame.mode !== 'delta') {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'Bootstrap cannot replace current state'
    );
  }
  if (state) {
    await assertStateCatalogHash(state);
    if (frame.showId !== state.showId || frame.target !== state.target) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'Frame cannot change state Show or target'
      );
    }
    if (frame.revision < state.revision || frame.confirmedAt < state.confirmedAt) {
      throw new DeviceControlFrameError('OUT_OF_ORDER_FRAME', 'Frame predates current state');
    }
    if (frame.catalogGeneration < state.catalogGeneration) {
      throw new DeviceControlFrameError(
        'OUT_OF_ORDER_FRAME',
        'Frame predates the current catalog generation'
      );
    }
    if (
      frame.revision === state.revision &&
      (frame.addedActions.length > 0 ||
        frame.removedControlIds.length > 0 ||
        frame.observations.length > 0)
    ) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'A frame cannot change catalog or values without a newer revision'
      );
    }
  }

  const controls = new Map<string, DeviceControlFrameEntry>(
    (state?.controls ?? []).map((entry) => [entry.action.subject.controlId, entry])
  );
  const addedIds = new Set(frame.addedActions.map((action) => action.subject.controlId));
  for (const controlId of frame.removedControlIds) {
    if (!controls.has(controlId)) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'Frame cannot remove a control that is not available'
      );
    }
    controls.delete(controlId);
  }
  for (const action of frame.addedActions) {
    const controlId = action.subject.controlId;
    if (controls.has(controlId)) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'Frame cannot add a control that is already available'
      );
    }
    controls.set(controlId, {
      action,
      value: 'inactive',
      valueRevision: frame.revision,
      valueObservedAt: frame.confirmedAt,
    });
  }
  for (const observation of frame.observations) {
    const controlId = observation.subject.controlId;
    const entry = controls.get(controlId);
    if (!entry) {
      throw new DeviceControlFrameError(
        'INVALID_TRANSITION',
        'Frame observation does not belong to its resulting catalog'
      );
    }
    controls.set(controlId, {
      action: entry.action,
      value: observation.value,
      valueRevision: observation.revision,
      valueObservedAt: observation.observedAt,
    });
  }
  if (
    [...addedIds].some(
      (controlId) =>
        !frame.observations.some((observation) => observation.subject.controlId === controlId)
    )
  ) {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'Added controls require initial observations'
    );
  }

  const nextControls = [...controls.values()].sort((left, right) =>
    compareText(left.action.subject.controlId, right.action.subject.controlId)
  );
  const actualCatalogHash = await deviceControlCatalogHash(
    frame.showId,
    frame.target,
    nextControls.map((entry) => entry.action)
  );
  if (actualCatalogHash !== frame.catalogHash) {
    throw new DeviceControlFrameError(
      'CATALOG_HASH_MISMATCH',
      'Frame catalog hash does not match its resulting catalog'
    );
  }
  if (
    state &&
    actualCatalogHash !== state.catalogHash &&
    frame.catalogGeneration === state.catalogGeneration
  ) {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'A resulting catalog change requires a newer catalog generation'
    );
  }
  return {
    schemaVersion: DEVICE_CONTROL_FRAME_STATE_VERSION,
    showId: frame.showId,
    target: frame.target,
    revision: frame.revision,
    catalogGeneration: frame.catalogGeneration,
    confirmedAt: frame.confirmedAt,
    catalogHash: frame.catalogHash,
    controls: nextControls,
  };
}

export async function reduceAdmittedDeviceControlFrame(
  current: AdmittedDeviceControlFrameState | null,
  admitted: AdmittedDeviceControlFrame
): Promise<ReducedAdmittedDeviceControlFrame> {
  if (!admitted || typeof admitted !== 'object') {
    throw new DeviceControlFrameError('INVALID_TRANSITION', 'Admitted frame is invalid');
  }
  const identity = normalizedIdentity(admitted.identity, 'INVALID_TRANSITION');
  const base = admitted.base
    ? normalizedIdentity(admitted.base, 'INVALID_TRANSITION')
    : null;
  if (current === null) {
    if (base !== null || admitted.frame.mode !== 'bootstrap') {
      throw new DeviceControlFrameError(
        'BASE_MISMATCH',
        'First admitted frame requires a base-free bootstrap'
      );
    }
    return Object.freeze({
      state: Object.freeze({
        identity,
        state: await reduceDeviceControlFrame(null, admitted.frame),
      }),
      applied: true,
    });
  }
  if (!current || typeof current !== 'object') {
    throw new DeviceControlFrameError('INVALID_STATE', 'Admitted frame state is invalid');
  }
  const currentIdentity = normalizedIdentity(current.identity);
  const currentState = normalizedState(current.state);
  if (admitted.duplicate === true) {
    return Object.freeze({
      state: Object.freeze({ identity: currentIdentity, state: currentState }),
      applied: false,
    });
  }
  if (sameIdentity(currentIdentity, identity)) {
    return Object.freeze({
      state: Object.freeze({ identity: currentIdentity, state: currentState }),
      applied: false,
    });
  }
  if (!base || !sameIdentity(base, currentIdentity)) {
    throw new DeviceControlFrameError(
      'BASE_MISMATCH',
      'Delta base does not match the last applied target frame'
    );
  }
  return Object.freeze({
    state: Object.freeze({
      identity,
      state: await reduceDeviceControlFrame(currentState, admitted.frame),
    }),
    applied: true,
  });
}

export function projectDeviceControl(
  state: DeviceControlFrameState,
  subject: ControlFeedbackSubject,
  now: number,
  timeoutMs = DEFAULT_CONTROL_FEEDBACK_TIMEOUT_MS
): DeviceControlView {
  const normalized = normalizedState(state);
  const showId = requiredIdentifier(subject?.showId, 'Projection Show identifier');
  const target = requiredTarget(subject?.target);
  const controlId = requiredIdentifier(subject?.controlId, 'Projection control identifier');
  if (showId !== normalized.showId || target !== normalized.target) {
    throw new DeviceControlFrameError(
      'INVALID_TRANSITION',
      'Projection subject belongs to another Show or target'
    );
  }
  if (!Number.isFinite(now) || now < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DeviceControlFrameError('INVALID_FRAME', 'Projection time is invalid');
  }
  const exactSubject = { showId, target, controlId };
  const entry = normalized.controls.find(
    (candidate) => candidate.action.subject.controlId === controlId
  );
  if (!entry) {
    return {
      available: false,
      subject: exactSubject,
      status: 'unavailable',
      buttonState: 'unavailable',
      reason: 'not-in-authorized-catalog',
    };
  }
  const shared = {
    available: true as const,
    subject: exactSubject,
    lastKnownState: entry.value,
    revision: normalized.revision,
    valueRevision: entry.valueRevision,
    valueObservedAt: entry.valueObservedAt,
    confirmedAt: normalized.confirmedAt,
    expiresAt: normalized.confirmedAt + timeoutMs,
  };
  if (now < normalized.confirmedAt) {
    return {
      ...shared,
      status: 'unknown',
      buttonState: 'unknown',
      reason: 'clock-skew',
    };
  }
  if (now - normalized.confirmedAt >= timeoutMs) {
    return {
      ...shared,
      status: 'stale',
      buttonState: 'unknown',
      reason: 'confirmation-timeout',
    };
  }
  return {
    ...shared,
    status: 'current',
    buttonState: entry.value,
    reason: 'revision-confirmed',
  };
}
