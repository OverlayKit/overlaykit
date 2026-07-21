import type {
  SignedControlFeedbackEnvelope,
  UnsignedControlFeedbackEnvelope,
} from '@overlaykit/protocol/control-feedback-authority' with { 'resolution-mode': 'import' };
import type { AuthorizedControlActionCatalog } from '@overlaykit/protocol/control-action-catalog' with { 'resolution-mode': 'import' };
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with { 'resolution-mode': 'import' };
import type { ProductionBus } from '@overlaykit/protocol/production' with { 'resolution-mode': 'import' };
import type { ServerVisibilityFeedbackProjection } from '@overlaykit/protocol/control-visibility-feedback' with { 'resolution-mode': 'import' };
import type { DeviceActionCatalogRuntime } from './DeviceActionCatalogRuntime';
import { buildDeviceActionInventory } from './DeviceActionCatalogRuntime';
import {
  FileFeedbackSequenceStore,
  type FeedbackSequenceStore,
} from './FileFeedbackSequenceStore';
import type { ProductionService } from './ProductionService';

type FeedbackAuthorityProtocolModule = typeof import(
  '@overlaykit/protocol/control-feedback-authority',
  { with: { 'resolution-mode': 'import' } }
);
interface VisibilityFeedbackProtocolPort {
  projectServerVisibilityFeedback(
    snapshot: ReturnType<ProductionService['getSnapshot']>,
    catalog: AuthorizedControlActionCatalog,
    observedAt: number,
  ): ServerVisibilityFeedbackProjection;
}

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 4_096;

export interface DeviceFeedbackCredentialPort {
  authenticate(token: unknown): Promise<DeviceCredentialAuthority | null>;
}

export interface DeviceFeedbackSigner {
  readonly issuerKeyId: string;
  sign(signingBytes: Uint8Array): string | Promise<string>;
}

export interface DeviceVisibilityFeedbackRequest {
  readonly token: unknown;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly observedAt: number;
}

export interface DeviceFeedbackIssuer {
  issueVisibility(
    request: DeviceVisibilityFeedbackRequest,
  ): Promise<ReadonlyArray<SignedControlFeedbackEnvelope>>;
}

export type DeviceFeedbackIssuerErrorCode =
  | 'INVALID_FEEDBACK_ISSUER'
  | 'INVALID_FEEDBACK_REQUEST'
  | 'DEVICE_FEEDBACK_AUTH_REQUIRED'
  | 'DEVICE_FEEDBACK_FORBIDDEN'
  | 'INVALID_FEEDBACK_SEQUENCE_RESERVATION'
  | 'INVALID_FEEDBACK_SIGNATURE';

export class DeviceFeedbackIssuerError extends Error {
  constructor(
    public readonly code: DeviceFeedbackIssuerErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DeviceFeedbackIssuerError';
  }
}

export interface DeviceFeedbackIssuerRuntimeOptions {
  readonly production: ProductionService;
  readonly credentials: DeviceFeedbackCredentialPort;
  readonly actionCatalog: DeviceActionCatalogRuntime;
  readonly signer: DeviceFeedbackSigner;
  readonly sequenceStore?: FeedbackSequenceStore;
  readonly sequenceFilePath?: string;
  readonly loadAuthorityProtocol?: () => Promise<FeedbackAuthorityProtocolModule>;
  readonly loadVisibilityProtocol?: () => Promise<VisibilityFeedbackProtocolPort>;
}

async function loadAuthorityProtocol(): Promise<FeedbackAuthorityProtocolModule> {
  return import('@overlaykit/protocol/control-feedback-authority');
}

async function loadVisibilityProtocol(): Promise<VisibilityFeedbackProtocolPort> {
  const protocol = await import('@overlaykit/protocol/control-visibility-feedback');
  return {
    projectServerVisibilityFeedback: (snapshot, catalog, observedAt) => (
      protocol.projectServerVisibilityFeedback(
        // The local server tree is validated at runtime by the protocol projector.
        snapshot as Parameters<typeof protocol.projectServerVisibilityFeedback>[0],
        catalog,
        observedAt,
      )
    ),
  };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim();
}

function assertRequest(request: DeviceVisibilityFeedbackRequest): void {
  if (
    !request
    || typeof request !== 'object'
    || !validIdentifier(request.showId)
    || (request.target !== 'preview' && request.target !== 'program')
    || !Number.isFinite(request.observedAt)
    || request.observedAt < 0
  ) {
    throw new DeviceFeedbackIssuerError(
      'INVALID_FEEDBACK_REQUEST',
      'Device visibility feedback request is invalid',
    );
  }
}

function assertAuthority(
  authority: DeviceCredentialAuthority,
  request: DeviceVisibilityFeedbackRequest,
): void {
  if (
    !authority
    || typeof authority !== 'object'
    || !validIdentifier(authority.audienceCredentialId)
    || !validIdentifier(authority.showId)
    || !Array.isArray(authority.targets)
    || !Array.isArray(authority.controlIds)
    || !Array.isArray(authority.scopes)
  ) {
    throw new DeviceFeedbackIssuerError(
      'DEVICE_FEEDBACK_FORBIDDEN',
      'Device feedback authority is invalid',
    );
  }
  if (
    authority.showId !== request.showId
    || !authority.targets.includes(request.target)
    || !authority.scopes.includes('feedback:read')
  ) {
    throw new DeviceFeedbackIssuerError(
      'DEVICE_FEEDBACK_FORBIDDEN',
      'Device authority does not grant this feedback target',
    );
  }
}

function snapshotAuthority(
  authority: DeviceCredentialAuthority,
): DeviceCredentialAuthority {
  return {
    credentialId: authority.credentialId,
    audienceCredentialId: authority.audienceCredentialId,
    generation: authority.generation,
    showId: authority.showId,
    targets: [...authority.targets],
    controlIds: [...authority.controlIds],
    scopes: [...authority.scopes],
    expiresAt: authority.expiresAt,
  };
}

function assertSequences(
  sequences: ReadonlyArray<number>,
  expectedCount: number,
): void {
  if (
    !Array.isArray(sequences)
    || sequences.length !== expectedCount
    || sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)
    || sequences.some((sequence, index) => index > 0 && sequence !== sequences[index - 1] + 1)
  ) {
    throw new DeviceFeedbackIssuerError(
      'INVALID_FEEDBACK_SEQUENCE_RESERVATION',
      'Feedback sequence store returned an invalid reservation',
    );
  }
}

function validSignature(signature: unknown): signature is string {
  return typeof signature === 'string'
    && signature.length > 0
    && signature.length <= MAX_SIGNATURE_LENGTH;
}

class ServerDeviceFeedbackIssuer implements DeviceFeedbackIssuer {
  private readonly issuerKeyId: string;
  private readonly signFeedback: DeviceFeedbackSigner['sign'];

  constructor(
    private readonly production: ProductionService,
    private readonly credentials: DeviceFeedbackCredentialPort,
    private readonly actionCatalog: DeviceActionCatalogRuntime,
    signer: DeviceFeedbackSigner,
    private readonly sequences: FeedbackSequenceStore,
    private readonly authorityProtocol: FeedbackAuthorityProtocolModule,
    private readonly visibilityProtocol: VisibilityFeedbackProtocolPort,
  ) {
    this.issuerKeyId = signer.issuerKeyId;
    this.signFeedback = signer.sign.bind(signer);
  }

  async issueVisibility(
    request: DeviceVisibilityFeedbackRequest,
  ): Promise<ReadonlyArray<SignedControlFeedbackEnvelope>> {
    assertRequest(request);
    const currentRequest = { ...request };
    const authenticatedAuthority = await this.credentials.authenticate(currentRequest.token);
    if (!authenticatedAuthority) {
      throw new DeviceFeedbackIssuerError(
        'DEVICE_FEEDBACK_AUTH_REQUIRED',
        'A valid device credential is required for feedback',
      );
    }
    assertAuthority(authenticatedAuthority, currentRequest);
    const authority = snapshotAuthority(authenticatedAuthority);

    const inventory = buildDeviceActionInventory(this.production, currentRequest.showId);
    const catalog = this.actionCatalog.projectAuthorizedControlActionCatalog(
      inventory,
      authority,
    );
    const snapshot = this.production.getSnapshot(currentRequest.showId, currentRequest.target);
    const projection: ServerVisibilityFeedbackProjection =
      this.visibilityProtocol.projectServerVisibilityFeedback(
        snapshot,
        catalog,
        currentRequest.observedAt,
      );
    if (projection.observations.length === 0) return [];

    const sequences = await this.sequences.reserve(
      this.issuerKeyId,
      authority.audienceCredentialId,
      projection.observations.length,
    );
    assertSequences(sequences, projection.observations.length);

    const unsigned = projection.observations.map((event, index): UnsignedControlFeedbackEnvelope => ({
      schemaVersion: this.authorityProtocol.CONTROL_FEEDBACK_ENVELOPE_VERSION,
      issuerKeyId: this.issuerKeyId,
      audienceCredentialId: authority.audienceCredentialId,
      sequence: sequences[index],
      event,
    }));
    const signatures = await Promise.all(unsigned.map(async (envelope) => {
      const signature = await this.signFeedback(
        this.authorityProtocol.controlFeedbackSigningBytes(envelope),
      );
      if (!validSignature(signature)) {
        throw new DeviceFeedbackIssuerError(
          'INVALID_FEEDBACK_SIGNATURE',
          'Feedback signer returned an invalid signature',
        );
      }
      return signature;
    }));

    return unsigned.map((envelope, index): SignedControlFeedbackEnvelope => ({
      ...envelope,
      signature: signatures[index],
    }));
  }
}

export async function createDeviceFeedbackIssuerRuntime(
  options: DeviceFeedbackIssuerRuntimeOptions,
): Promise<DeviceFeedbackIssuer> {
  if (
    !options
    || !options.production
    || !options.credentials
    || !options.actionCatalog
    || !options.signer
    || !validIdentifier(options.signer.issuerKeyId)
  ) {
    throw new DeviceFeedbackIssuerError(
      'INVALID_FEEDBACK_ISSUER',
      'Device feedback issuer dependencies are invalid',
    );
  }

  const sequenceStore = options.sequenceStore
    ?? new FileFeedbackSequenceStore(options.sequenceFilePath);
  const [authorityProtocol, visibilityProtocol] = await Promise.all([
    (options.loadAuthorityProtocol ?? loadAuthorityProtocol)(),
    (options.loadVisibilityProtocol ?? loadVisibilityProtocol)(),
    sequenceStore.init(),
  ]);

  return new ServerDeviceFeedbackIssuer(
    options.production,
    options.credentials,
    options.actionCatalog,
    options.signer,
    sequenceStore,
    authorityProtocol,
    visibilityProtocol,
  );
}
