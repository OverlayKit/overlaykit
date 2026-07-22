import { createHash } from 'crypto';
import type {
  AuthorizedControlActionCatalog,
  ControlActionInventory,
} from '@overlaykit/protocol/control-action-catalog' with { 'resolution-mode': 'import' };
import type {
  DeviceControlFrame,
  DeviceControlFrameIdentity,
  DeviceControlFrameInput,
  DeviceControlFrameState,
  UnsignedDeviceControlFrameEnvelope,
} from '@overlaykit/protocol/device-control-frame' with { 'resolution-mode': 'import' };
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import type { ServerVisibilityFeedbackProjection } from '@overlaykit/protocol/control-visibility-feedback' with {
  'resolution-mode': 'import',
};
import type {
  ProductionBus,
  ProductionSnapshot,
  ProductionState,
} from '@overlaykit/protocol/production' with { 'resolution-mode': 'import' };
import type {
  CatalogGenerationAuthority,
  CatalogGenerationToken,
} from './FileCatalogGenerationStore';
import type { FeedbackSequenceStore } from './FileFeedbackSequenceStore';
import { buildDeviceActionInventoryFromState } from './DeviceActionCatalogRuntime';

type DeviceControlFrameProtocolModule = typeof import('@overlaykit/protocol/device-control-frame', {
  with: { 'resolution-mode': 'import' },
});
type VisibilityFeedbackProtocolModule = typeof import(
  '@overlaykit/protocol/control-visibility-feedback',
  { with: { 'resolution-mode': 'import' } }
);

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 4_096;
const DEFAULT_SNAPSHOT_FRESHNESS_MS = 3_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface DeviceBootstrapProductionPort {
  getState(showId: string): ProductionState;
}

export interface DeviceBootstrapCatalogProjector {
  projectAuthorizedControlActionCatalog(
    inventory: ControlActionInventory,
    authority: DeviceCredentialAuthority
  ): AuthorizedControlActionCatalog;
}

export interface DeviceBootstrapSigner {
  readonly issuerKeyId: string;
  sign(payloadBytes: Uint8Array): string | Promise<string>;
}

export interface DeviceBootstrapSigningAuthority {
  current(): DeviceBootstrapSigner;
}

export interface DeviceBootstrapFreshnessToken {
  readonly target: ProductionBus;
  readonly targetRevision: number;
  readonly confirmedAt: number;
  readonly issuerKeyId: string;
  readonly catalog: CatalogGenerationToken;
}

export interface IssuedDeviceBootstrapSnapshot {
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly signature: string;
  readonly freshness: DeviceBootstrapFreshnessToken;
  readonly state: DeviceControlFrameState;
}

export interface ConfirmedDeviceControlFrameBase {
  readonly identity: DeviceControlFrameIdentity;
  readonly state: DeviceControlFrameState;
}

export interface IssuedDeviceControlDelta extends IssuedDeviceBootstrapSnapshot {
  readonly base: ConfirmedDeviceControlFrameBase;
}

interface DeviceBootstrapFrameProtocolPort {
  readonly DEVICE_CONTROL_FRAME_ENVELOPE_VERSION: DeviceControlFrameProtocolModule['DEVICE_CONTROL_FRAME_ENVELOPE_VERSION'];
  buildDeviceControlBootstrapFrame(input: DeviceControlFrameInput): Promise<DeviceControlFrame>;
  buildDeviceControlDeltaFrame(
    current: DeviceControlFrameState,
    input: DeviceControlFrameInput
  ): Promise<DeviceControlFrame>;
  deviceControlFramePayloadBytes(envelope: UnsignedDeviceControlFrameEnvelope): Uint8Array;
  reduceDeviceControlFrame(
    current: DeviceControlFrameState | null,
    input: DeviceControlFrame
  ): Promise<DeviceControlFrameState>;
}

interface DeviceBootstrapVisibilityProtocolPort {
  projectServerVisibilityFeedback(
    snapshot: ProductionSnapshot,
    catalog: AuthorizedControlActionCatalog,
    observedAt: number
  ): ServerVisibilityFeedbackProjection;
}

interface DeviceBootstrapSnapshotIssuerOptions {
  readonly authority: DeviceCredentialAuthority;
  readonly production: DeviceBootstrapProductionPort;
  readonly actionCatalog: DeviceBootstrapCatalogProjector;
  readonly catalogGenerations: CatalogGenerationAuthority;
  readonly sequences: FeedbackSequenceStore;
  readonly signing: DeviceBootstrapSigningAuthority;
  readonly frameProtocol: DeviceBootstrapFrameProtocolPort;
  readonly visibilityProtocol: DeviceBootstrapVisibilityProtocolPort;
  readonly now?: () => number;
  readonly freshnessMs?: number;
}

export interface DeviceBootstrapSnapshotIssuerRuntimeOptions extends Omit<
  DeviceBootstrapSnapshotIssuerOptions,
  'frameProtocol' | 'visibilityProtocol'
> {
  readonly loadFrameProtocol?: () => Promise<DeviceControlFrameProtocolModule>;
  readonly loadVisibilityProtocol?: () => Promise<VisibilityFeedbackProtocolModule>;
}

export type DeviceBootstrapSnapshotIssuerErrorCode =
  | 'INVALID_DEVICE_BOOTSTRAP_ISSUER'
  | 'DEVICE_BOOTSTRAP_TARGET_FORBIDDEN'
  | 'DEVICE_BOOTSTRAP_CLOCK_INVALID'
  | 'DEVICE_BOOTSTRAP_SIGNING_FAILED'
  | 'DEVICE_CONTROL_ISSUER_ROTATED';

export class DeviceBootstrapSnapshotIssuerError extends Error {
  constructor(
    public readonly code: DeviceBootstrapSnapshotIssuerErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DeviceBootstrapSnapshotIssuerError';
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim()
  );
}

function snapshotAuthority(authority: DeviceCredentialAuthority): DeviceCredentialAuthority {
  if (
    !authority ||
    typeof authority !== 'object' ||
    !validIdentifier(authority.credentialId) ||
    !validIdentifier(authority.audienceCredentialId) ||
    !Number.isSafeInteger(authority.generation) ||
    authority.generation < 1 ||
    !validIdentifier(authority.showId) ||
    !Array.isArray(authority.targets) ||
    authority.targets.length === 0 ||
    authority.targets.some((target) => target !== 'preview' && target !== 'program') ||
    new Set(authority.targets).size !== authority.targets.length ||
    !Array.isArray(authority.controlIds) ||
    authority.controlIds.some((controlId) => !validIdentifier(controlId)) ||
    !Array.isArray(authority.scopes) ||
    !Number.isFinite(authority.expiresAt)
  ) {
    throw new DeviceBootstrapSnapshotIssuerError(
      'INVALID_DEVICE_BOOTSTRAP_ISSUER',
      'Device bootstrap credential authority is invalid'
    );
  }
  return Object.freeze({
    ...authority,
    targets: Object.freeze([...authority.targets]),
    controlIds: Object.freeze([...authority.controlIds]),
    scopes: Object.freeze([...authority.scopes]),
  });
}

function normalizedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeviceBootstrapSnapshotIssuerError(
      'DEVICE_BOOTSTRAP_CLOCK_INVALID',
      'Device bootstrap clock must return a non-negative safe integer'
    );
  }
  return value;
}

function validSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SIGNATURE_LENGTH;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function catalogHash(catalog: AuthorizedControlActionCatalog): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

function assertProductionState(state: ProductionState, showId: string): void {
  if (
    !state ||
    typeof state !== 'object' ||
    state.showId !== showId ||
    state.preview?.showId !== showId ||
    state.preview?.bus !== 'preview' ||
    state.program?.showId !== showId ||
    state.program?.bus !== 'program'
  ) {
    throw new DeviceBootstrapSnapshotIssuerError(
      'INVALID_DEVICE_BOOTSTRAP_ISSUER',
      'Production state does not match bootstrap authority'
    );
  }
}

async function loadFrameProtocol(): Promise<DeviceControlFrameProtocolModule> {
  return import('@overlaykit/protocol/device-control-frame');
}

async function loadVisibilityProtocol(): Promise<VisibilityFeedbackProtocolModule> {
  return import('@overlaykit/protocol/control-visibility-feedback');
}

export class DeviceBootstrapSnapshotIssuer {
  private readonly authority: DeviceCredentialAuthority;
  private readonly now: () => number;
  private readonly freshnessMs: number;

  constructor(private readonly options: DeviceBootstrapSnapshotIssuerOptions) {
    if (
      !options ||
      !options.production ||
      typeof options.production.getState !== 'function' ||
      !options.actionCatalog ||
      typeof options.actionCatalog.projectAuthorizedControlActionCatalog !== 'function' ||
      !options.catalogGenerations ||
      typeof options.catalogGenerations.observe !== 'function' ||
      typeof options.catalogGenerations.confirm !== 'function' ||
      typeof options.catalogGenerations.isCurrent !== 'function' ||
      !options.sequences ||
      typeof options.sequences.reserve !== 'function' ||
      !options.signing ||
      typeof options.signing.current !== 'function' ||
      !options.frameProtocol ||
      typeof options.frameProtocol.buildDeviceControlBootstrapFrame !== 'function' ||
      typeof options.frameProtocol.buildDeviceControlDeltaFrame !== 'function' ||
      typeof options.frameProtocol.deviceControlFramePayloadBytes !== 'function' ||
      typeof options.frameProtocol.reduceDeviceControlFrame !== 'function' ||
      !options.visibilityProtocol ||
      typeof options.visibilityProtocol.projectServerVisibilityFeedback !== 'function'
    ) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'INVALID_DEVICE_BOOTSTRAP_ISSUER',
        'Device bootstrap issuer dependencies are invalid'
      );
    }
    this.authority = snapshotAuthority(options.authority);
    this.now = options.now ?? Date.now;
    this.freshnessMs = options.freshnessMs ?? DEFAULT_SNAPSHOT_FRESHNESS_MS;
    if (!Number.isSafeInteger(this.freshnessMs) || this.freshnessMs < 1) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'INVALID_DEVICE_BOOTSTRAP_ISSUER',
        'Device bootstrap freshness window is invalid'
      );
    }
    normalizedNow(this.now);
    this.captureSigner();
  }

  observeProductionState(state: ProductionState): CatalogGenerationToken {
    assertProductionState(state, this.authority.showId);
    const catalog = this.authorizedCatalog(state);
    return this.options.catalogGenerations.observe(catalogHash(catalog));
  }

  observeCurrentProductionState(): CatalogGenerationToken {
    return this.observeProductionState(this.captureProductionState());
  }

  currentIssuerKeyId(): string {
    return this.captureSigner().issuerKeyId;
  }

  async create(target: ProductionBus): Promise<IssuedDeviceBootstrapSnapshot> {
    if (!this.authority.targets.includes(target)) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_TARGET_FORBIDDEN',
        'Bootstrap target is outside credential authority'
      );
    }
    let recapture = true;
    while (recapture) {
      recapture = false;
      try {
        return await this.createAttempt(target);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'STALE_CATALOG_GENERATION'
        ) {
          recapture = true;
          continue;
        }
        throw error;
      }
    }
    throw new DeviceBootstrapSnapshotIssuerError(
      'INVALID_DEVICE_BOOTSTRAP_ISSUER',
      'Device bootstrap recapture ended without a snapshot'
    );
  }

  async createDelta(base: ConfirmedDeviceControlFrameBase): Promise<IssuedDeviceControlDelta> {
    if (
      !base ||
      typeof base !== 'object' ||
      !base.identity ||
      !validIdentifier(base.identity.issuerKeyId) ||
      !Number.isSafeInteger(base.identity.sequence) ||
      base.identity.sequence < 1 ||
      !SHA256_PATTERN.test(base.identity.sha256) ||
      !base.state ||
      base.state.showId !== this.authority.showId ||
      !this.authority.targets.includes(base.state.target)
    ) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'INVALID_DEVICE_BOOTSTRAP_ISSUER',
        'Confirmed device control base is invalid'
      );
    }
    let recapture = true;
    while (recapture) {
      recapture = false;
      try {
        return await this.createDeltaAttempt(base);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'STALE_CATALOG_GENERATION'
        ) {
          recapture = true;
          continue;
        }
        throw error;
      }
    }
    throw new DeviceBootstrapSnapshotIssuerError(
      'INVALID_DEVICE_BOOTSTRAP_ISSUER',
      'Device delta recapture ended without a frame'
    );
  }

  private async createDeltaAttempt(
    base: ConfirmedDeviceControlFrameBase
  ): Promise<IssuedDeviceControlDelta> {
    const signer = this.captureSigner();
    if (signer.issuerKeyId !== base.identity.issuerKeyId) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_CONTROL_ISSUER_ROTATED',
        'Device control issuer changed after the confirmed base'
      );
    }
    const state = this.captureProductionState();
    const confirmedAt = normalizedNow(this.now);
    const target = base.state.target;
    const targetSnapshot = state[target];
    if (targetSnapshot.updatedAt !== null && confirmedAt < targetSnapshot.updatedAt) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_CLOCK_INVALID',
        'Delta confirmation time predates its production snapshot'
      );
    }
    const catalog = this.authorizedCatalog(state);
    const catalogToken = this.options.catalogGenerations.observe(catalogHash(catalog));
    await this.options.catalogGenerations.confirm(catalogToken);
    const projection = this.options.visibilityProtocol.projectServerVisibilityFeedback(
      targetSnapshot,
      catalog,
      confirmedAt
    );
    const frame = await this.options.frameProtocol.buildDeviceControlDeltaFrame(base.state, {
      showId: this.authority.showId,
      target,
      revision: targetSnapshot.revision,
      catalogGeneration: catalogToken.generation,
      confirmedAt,
      catalog,
      observations: projection.observations,
    });
    const frameState = await this.options.frameProtocol.reduceDeviceControlFrame(base.state, frame);
    const reserved = await this.options.sequences.reserve(
      signer.issuerKeyId,
      this.authority.audienceCredentialId,
      1
    );
    const sequence = reserved[0];
    if (
      reserved.length !== 1 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence <= base.identity.sequence
    ) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'INVALID_DEVICE_BOOTSTRAP_ISSUER',
        'Sequence authority returned an invalid delta reservation'
      );
    }
    const envelope: UnsignedDeviceControlFrameEnvelope = {
      schemaVersion: this.options.frameProtocol.DEVICE_CONTROL_FRAME_ENVELOPE_VERSION,
      issuerKeyId: signer.issuerKeyId,
      audienceCredentialId: this.authority.audienceCredentialId,
      sequence,
      baseIssuerKeyId: base.identity.issuerKeyId,
      baseSequence: base.identity.sequence,
      baseSha256: base.identity.sha256,
      frame,
    };
    const payloadBytes = this.options.frameProtocol.deviceControlFramePayloadBytes(envelope);
    const signingBytes = payloadBytes.slice();
    let signature: string;
    try {
      signature = await signer.sign(signingBytes);
    } catch (error) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_SIGNING_FAILED',
        'Device delta signer failed',
        error
      );
    }
    if (!validSignature(signature) || !sameBytes(signingBytes, payloadBytes)) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_SIGNING_FAILED',
        'Device delta signer returned invalid evidence'
      );
    }
    return Object.freeze({
      issuerKeyId: signer.issuerKeyId,
      sequence,
      bytes: payloadBytes.slice(),
      signature,
      freshness: Object.freeze({
        target,
        targetRevision: targetSnapshot.revision,
        confirmedAt,
        issuerKeyId: signer.issuerKeyId,
        catalog: catalogToken,
      }),
      state: frameState,
      base: Object.freeze({
        identity: Object.freeze({ ...base.identity }),
        state: base.state,
      }),
    });
  }

  private async createAttempt(target: ProductionBus): Promise<IssuedDeviceBootstrapSnapshot> {
    const signer = this.captureSigner();
    const state = this.captureProductionState();
    const confirmedAt = normalizedNow(this.now);
    const targetSnapshot = state[target];
    if (targetSnapshot.updatedAt !== null && confirmedAt < targetSnapshot.updatedAt) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_CLOCK_INVALID',
        'Bootstrap confirmation time predates its production snapshot'
      );
    }

    const catalog = this.authorizedCatalog(state);
    const catalogToken = this.options.catalogGenerations.observe(catalogHash(catalog));
    await this.options.catalogGenerations.confirm(catalogToken);
    const projection = this.options.visibilityProtocol.projectServerVisibilityFeedback(
      targetSnapshot,
      catalog,
      confirmedAt
    );
    const frame = await this.options.frameProtocol.buildDeviceControlBootstrapFrame({
      showId: this.authority.showId,
      target,
      revision: targetSnapshot.revision,
      catalogGeneration: catalogToken.generation,
      confirmedAt,
      catalog,
      observations: projection.observations,
    });
    const frameState = await this.options.frameProtocol.reduceDeviceControlFrame(null, frame);

    const reserved = await this.options.sequences.reserve(
      signer.issuerKeyId,
      this.authority.audienceCredentialId,
      1
    );
    const sequence = reserved[0];
    if (reserved.length !== 1 || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'INVALID_DEVICE_BOOTSTRAP_ISSUER',
        'Sequence authority returned an invalid bootstrap reservation'
      );
    }
    const envelope: UnsignedDeviceControlFrameEnvelope = {
      schemaVersion: this.options.frameProtocol.DEVICE_CONTROL_FRAME_ENVELOPE_VERSION,
      issuerKeyId: signer.issuerKeyId,
      audienceCredentialId: this.authority.audienceCredentialId,
      sequence,
      baseIssuerKeyId: null,
      baseSequence: null,
      baseSha256: null,
      frame,
    };
    const payloadBytes = this.options.frameProtocol.deviceControlFramePayloadBytes(envelope);
    const signingBytes = payloadBytes.slice();
    let signature: string;
    try {
      signature = await signer.sign(signingBytes);
    } catch (error) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_SIGNING_FAILED',
        'Device bootstrap signer failed',
        error
      );
    }
    if (!validSignature(signature) || !sameBytes(signingBytes, payloadBytes)) {
      throw new DeviceBootstrapSnapshotIssuerError(
        'DEVICE_BOOTSTRAP_SIGNING_FAILED',
        'Device bootstrap signer returned invalid evidence'
      );
    }

    return Object.freeze({
      issuerKeyId: signer.issuerKeyId,
      sequence,
      bytes: payloadBytes.slice(),
      signature,
      freshness: Object.freeze({
        target,
        targetRevision: targetSnapshot.revision,
        confirmedAt,
        issuerKeyId: signer.issuerKeyId,
        catalog: catalogToken,
      }),
      state: frameState,
    });
  }

  isCurrent(snapshot: IssuedDeviceBootstrapSnapshot): boolean {
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !snapshot.freshness ||
      (snapshot.freshness.target !== 'preview' && snapshot.freshness.target !== 'program') ||
      snapshot.freshness.catalog.audienceCredentialId !== this.authority.audienceCredentialId
    )
      return false;
    const currentSigner = this.captureSigner();
    if (currentSigner.issuerKeyId !== snapshot.freshness.issuerKeyId) return false;
    const state = this.captureProductionState();
    const currentCatalog = this.observeProductionState(state);
    if (!this.options.catalogGenerations.isCurrent(currentCatalog)) return false;
    if (!this.options.catalogGenerations.isCurrent(snapshot.freshness.catalog)) return false;
    if (state[snapshot.freshness.target].revision !== snapshot.freshness.targetRevision)
      return false;
    const now = normalizedNow(this.now);
    return (
      now >= snapshot.freshness.confirmedAt &&
      now - snapshot.freshness.confirmedAt < this.freshnessMs
    );
  }

  private captureProductionState(): ProductionState {
    const state = this.options.production.getState(this.authority.showId);
    assertProductionState(state, this.authority.showId);
    return state;
  }

  private authorizedCatalog(state: ProductionState): AuthorizedControlActionCatalog {
    return this.options.actionCatalog.projectAuthorizedControlActionCatalog(
      buildDeviceActionInventoryFromState(state),
      this.authority
    );
  }

  private captureSigner(): DeviceBootstrapSigner {
    const signer = this.options.signing.current();
    if (!signer || !validIdentifier(signer.issuerKeyId) || typeof signer.sign !== 'function') {
      throw new DeviceBootstrapSnapshotIssuerError(
        'INVALID_DEVICE_BOOTSTRAP_ISSUER',
        'Device bootstrap signing authority is invalid'
      );
    }
    return Object.freeze({
      issuerKeyId: signer.issuerKeyId,
      sign: signer.sign.bind(signer),
    });
  }
}

export async function createDeviceBootstrapSnapshotIssuer(
  options: DeviceBootstrapSnapshotIssuerRuntimeOptions
): Promise<DeviceBootstrapSnapshotIssuer> {
  const [frameProtocol, visibilityProtocol] = await Promise.all([
    (options.loadFrameProtocol ?? loadFrameProtocol)(),
    (options.loadVisibilityProtocol ?? loadVisibilityProtocol)(),
  ]);
  await options.catalogGenerations.init();
  await options.sequences.init();
  return new DeviceBootstrapSnapshotIssuer({
    ...options,
    frameProtocol,
    visibilityProtocol,
  });
}
