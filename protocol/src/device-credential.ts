import type { ControlFeedbackAuthorityContext } from './control-feedback-authority.js';
import type { ProductionBus } from './production.js';

export const DEVICE_CREDENTIAL_TOKEN_PREFIX = 'ok_device_' as const;
export const DEVICE_CREDENTIAL_SCOPES = [
  'feedback:read',
  'component.visibility:write',
  'cue:execute',
  'production:take',
] as const;

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_CREDENTIAL_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 80;
const MAX_SECRET_LENGTH = 512;
const MAX_SEALED_SECRET_LENGTH = 4_096;

export type DeviceCredentialScope = typeof DEVICE_CREDENTIAL_SCOPES[number];

export interface DeviceCredentialOwner {
  readonly principalId: string;
  readonly roles: ReadonlyArray<string>;
}

export interface DeviceCredentialIssueInput {
  readonly label: string;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<DeviceCredentialScope>;
  readonly expiresAt: number;
}

export interface DeviceCredentialRotationInput {
  readonly targets?: ReadonlyArray<ProductionBus>;
  readonly controlIds?: ReadonlyArray<string>;
  readonly scopes?: ReadonlyArray<DeviceCredentialScope>;
  readonly expiresAt?: number;
}

export interface StoredDeviceCredential {
  readonly credentialId: string;
  readonly label: string;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<DeviceCredentialScope>;
  readonly generation: number;
  readonly sealedSecret: string;
  readonly issuedBy: string;
  readonly issuedAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export type DeviceCredential = Omit<StoredDeviceCredential, 'sealedSecret'>;

export interface IssuedDeviceCredential {
  readonly credential: DeviceCredential;
  readonly token: string;
}

export interface DeviceCredentialAuthority {
  readonly credentialId: string;
  readonly audienceCredentialId: string;
  readonly generation: number;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<DeviceCredentialScope>;
  readonly expiresAt: number;
}

export interface DeviceAuthorizationRequest {
  readonly showId: string;
  readonly scope: DeviceCredentialScope;
  readonly target: ProductionBus;
  readonly controlId: string;
}

export interface DeviceCredentialStore {
  get(credentialId: string): Promise<StoredDeviceCredential | null>;
  create(record: StoredDeviceCredential): Promise<boolean>;
  replace(record: StoredDeviceCredential, expectedGeneration: number): Promise<boolean>;
}

export interface DeviceCredentialSecretCodec {
  seal(token: string): string | Promise<string>;
  matches(token: string, sealedSecret: string): boolean | Promise<boolean>;
}

export interface DeviceCredentialLifecycleOptions {
  readonly now: () => number;
  readonly generateCredentialId: () => string;
  readonly generateSecret: () => string;
  readonly secretCodec: DeviceCredentialSecretCodec;
}

export type DeviceCredentialErrorCode =
  | 'OWNER_REQUIRED'
  | 'INVALID_DEVICE_CREDENTIAL'
  | 'DEVICE_CREDENTIAL_NOT_FOUND'
  | 'DEVICE_CREDENTIAL_REVOKED'
  | 'DEVICE_CREDENTIAL_EXPIRED'
  | 'DEVICE_CREDENTIAL_CONFLICT'
  | 'DEVICE_CREDENTIAL_COLLISION'
  | 'DEVICE_CREDENTIAL_FORBIDDEN';

export class DeviceCredentialError extends Error {
  constructor(
    public readonly code: DeviceCredentialErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function cloneRecord(record: StoredDeviceCredential): StoredDeviceCredential {
  return {
    ...record,
    targets: [...record.targets],
    controlIds: [...record.controlIds],
    scopes: [...record.scopes],
  };
}

function publicCredential(record: StoredDeviceCredential): DeviceCredential {
  const { sealedSecret: _sealedSecret, ...credential } = cloneRecord(record);
  return credential;
}

function authorityFrom(record: StoredDeviceCredential): DeviceCredentialAuthority {
  return {
    credentialId: record.credentialId,
    audienceCredentialId: `${record.credentialId}.g${record.generation}`,
    generation: record.generation,
    showId: record.showId,
    targets: [...record.targets],
    controlIds: [...record.controlIds],
    scopes: [...record.scopes],
    expiresAt: record.expiresAt,
  };
}

export function effectiveDeviceCredentialAuthority(
  record: StoredDeviceCredential | null,
  now: number,
): DeviceCredentialAuthority | null {
  if (!record || record.revokedAt !== null || record.expiresAt <= now) return null;
  return authorityFrom(record);
}

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', `${field} is invalid`);
  }
  return normalized;
}

function tokenPart(value: unknown, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  const normalized = typeof value === 'string' ? value : '';
  if (!normalized || normalized.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', `${field} is invalid`);
  }
  return normalized;
}

function normalizedLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length < 2 || label.length > MAX_LABEL_LENGTH) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device label is invalid');
  }
  return label;
}

function normalizedTargets(value: unknown): ProductionBus[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device targets are invalid');
  }
  const targets = [...new Set(value)];
  if (targets.length !== value.length || targets.some((target) => target !== 'preview' && target !== 'program')) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device targets are invalid');
  }
  return (['preview', 'program'] as const).filter((target) => targets.includes(target));
}

function normalizedControlIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device controls are invalid');
  }
  const controls = value.map((controlId) => requiredIdentifier(controlId, 'Control identifier'));
  if (new Set(controls).size !== controls.length) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device controls are invalid');
  }
  return controls.sort((left, right) => left.localeCompare(right));
}

function isDeviceCredentialScope(value: unknown): value is DeviceCredentialScope {
  return typeof value === 'string' && DEVICE_CREDENTIAL_SCOPES.some((scope) => scope === value);
}

function normalizedScopes(value: unknown): DeviceCredentialScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEVICE_CREDENTIAL_SCOPES.length) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device scopes are invalid');
  }
  if (value.some((scope) => !isDeviceCredentialScope(scope)) || new Set(value).size !== value.length) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device scopes are invalid');
  }
  return DEVICE_CREDENTIAL_SCOPES.filter((scope) => value.includes(scope));
}

function normalizedExpiration(value: unknown, now: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= now) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device expiration is invalid');
  }
  return value as number;
}

function normalizedIssue(input: DeviceCredentialIssueInput, now: number): DeviceCredentialIssueInput {
  return {
    label: normalizedLabel(input?.label),
    showId: requiredIdentifier(input?.showId, 'Show identifier'),
    targets: normalizedTargets(input?.targets),
    controlIds: normalizedControlIds(input?.controlIds),
    scopes: normalizedScopes(input?.scopes),
    expiresAt: normalizedExpiration(input?.expiresAt, now),
  };
}

function normalizedRotation(
  input: DeviceCredentialRotationInput,
  current: StoredDeviceCredential,
  now: number,
): Pick<StoredDeviceCredential, 'targets' | 'controlIds' | 'scopes' | 'expiresAt'> {
  return {
    targets: input.targets === undefined ? [...current.targets] : normalizedTargets(input.targets),
    controlIds: input.controlIds === undefined
      ? [...current.controlIds]
      : normalizedControlIds(input.controlIds),
    scopes: input.scopes === undefined ? [...current.scopes] : normalizedScopes(input.scopes),
    expiresAt: input.expiresAt === undefined
      ? normalizedExpiration(current.expiresAt, now)
      : normalizedExpiration(input.expiresAt, now),
  };
}

function ownerPrincipal(owner: DeviceCredentialOwner): string {
  if (!owner || !owner.roles?.includes('owner')) {
    throw new DeviceCredentialError('OWNER_REQUIRED', 'Owner authority is required');
  }
  return requiredIdentifier(owner.principalId, 'Owner principal');
}

function parseToken(token: unknown): { credentialId: string } | null {
  if (typeof token !== 'string' || !token.startsWith(DEVICE_CREDENTIAL_TOKEN_PREFIX)) return null;
  const body = token.slice(DEVICE_CREDENTIAL_TOKEN_PREFIX.length);
  const separator = body.indexOf('.');
  if (separator <= 0 || separator !== body.lastIndexOf('.')) return null;
  try {
    const credentialId = tokenPart(
      body.slice(0, separator),
      'Credential identifier',
      MAX_CREDENTIAL_ID_LENGTH,
    );
    tokenPart(body.slice(separator + 1), 'Credential secret', MAX_SECRET_LENGTH);
    return { credentialId };
  } catch {
    return null;
  }
}

export class MemoryDeviceCredentialStore implements DeviceCredentialStore {
  private readonly records = new Map<string, StoredDeviceCredential>();

  async get(credentialId: string): Promise<StoredDeviceCredential | null> {
    const record = this.records.get(credentialId);
    return record ? cloneRecord(record) : null;
  }

  async create(record: StoredDeviceCredential): Promise<boolean> {
    if (this.records.has(record.credentialId)) return false;
    this.records.set(record.credentialId, cloneRecord(record));
    return true;
  }

  async replace(record: StoredDeviceCredential, expectedGeneration: number): Promise<boolean> {
    const current = this.records.get(record.credentialId);
    if (!current || current.generation !== expectedGeneration) return false;
    this.records.set(record.credentialId, cloneRecord(record));
    return true;
  }
}

export class DeviceCredentialLifecycle {
  constructor(
    private readonly store: DeviceCredentialStore,
    private readonly options: DeviceCredentialLifecycleOptions,
  ) {}

  async issue(
    owner: DeviceCredentialOwner,
    input: DeviceCredentialIssueInput,
  ): Promise<IssuedDeviceCredential> {
    const issuedBy = ownerPrincipal(owner);
    const now = this.options.now();
    const normalized = normalizedIssue(input, now);
    const credentialId = tokenPart(
      this.options.generateCredentialId(),
      'Credential identifier',
      MAX_CREDENTIAL_ID_LENGTH,
    );
    const token = await this.newToken(credentialId);
    const sealedSecret = await this.sealedSecret(token);
    const record: StoredDeviceCredential = {
      credentialId,
      ...normalized,
      generation: 1,
      sealedSecret,
      issuedBy,
      issuedAt: now,
      updatedAt: now,
      revokedAt: null,
    };
    if (!(await this.store.create(record))) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_COLLISION', 'Credential identifier already exists');
    }
    return { credential: publicCredential(record), token };
  }

  async rotate(
    owner: DeviceCredentialOwner,
    credentialId: string,
    input: DeviceCredentialRotationInput = {},
  ): Promise<IssuedDeviceCredential> {
    ownerPrincipal(owner);
    const normalizedId = tokenPart(
      credentialId,
      'Credential identifier',
      MAX_CREDENTIAL_ID_LENGTH,
    );
    const current = await this.requiredRecord(normalizedId);
    const now = this.options.now();
    if (current.revokedAt !== null) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_REVOKED', 'Revoked credentials cannot rotate');
    }
    if (current.expiresAt <= now) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_EXPIRED', 'Expired credentials cannot rotate');
    }
    const authority = normalizedRotation(input ?? {}, current, now);
    const token = await this.newToken(normalizedId);
    const next: StoredDeviceCredential = {
      ...current,
      ...authority,
      generation: current.generation + 1,
      sealedSecret: await this.sealedSecret(token),
      updatedAt: now,
    };
    if (!(await this.store.replace(next, current.generation))) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_CONFLICT', 'Credential changed during rotation');
    }
    return { credential: publicCredential(next), token };
  }

  async revoke(owner: DeviceCredentialOwner, credentialId: string): Promise<DeviceCredential> {
    ownerPrincipal(owner);
    const current = await this.requiredRecord(tokenPart(
      credentialId,
      'Credential identifier',
      MAX_CREDENTIAL_ID_LENGTH,
    ));
    if (current.revokedAt !== null) return publicCredential(current);
    const now = this.options.now();
    const next: StoredDeviceCredential = {
      ...current,
      generation: current.generation + 1,
      updatedAt: now,
      revokedAt: now,
    };
    if (!(await this.store.replace(next, current.generation))) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_CONFLICT', 'Credential changed during revocation');
    }
    return publicCredential(next);
  }

  async authenticate(token: unknown): Promise<DeviceCredentialAuthority | null> {
    const parsed = parseToken(token);
    if (!parsed || typeof token !== 'string') return null;
    const record = await this.store.get(parsed.credentialId);
    if (!record || record.sealedSecret.length > MAX_SEALED_SECRET_LENGTH) return null;
    let matches = false;
    try {
      matches = await this.options.secretCodec.matches(token, record.sealedSecret);
    } catch {
      matches = false;
    }
    if (!matches) return null;
    return effectiveDeviceCredentialAuthority(record, this.options.now());
  }

  async resolveAuthority(credentialId: string): Promise<DeviceCredentialAuthority | null> {
    const normalizedId = tokenPart(
      credentialId,
      'Credential identifier',
      MAX_CREDENTIAL_ID_LENGTH,
    );
    return effectiveDeviceCredentialAuthority(
      await this.store.get(normalizedId),
      this.options.now(),
    );
  }

  async authorize(
    token: unknown,
    request: DeviceAuthorizationRequest,
  ): Promise<DeviceCredentialAuthority> {
    const authority = await this.authenticate(token);
    if (!authority) {
      throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device credential is invalid');
    }
    const showId = requiredIdentifier(request?.showId, 'Show identifier');
    if (!isDeviceCredentialScope(request?.scope)) {
      throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device scope is invalid');
    }
    const target = request.target;
    const controlId = requiredIdentifier(request.controlId, 'Control identifier');
    if (target !== 'preview' && target !== 'program') {
      throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device target is invalid');
    }
    if (
      authority.showId !== showId
      || !authority.scopes.includes(request.scope)
      || !authority.targets.includes(target)
      || !authority.controlIds.includes(controlId)
    ) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_FORBIDDEN', 'Device authority does not grant this action');
    }
    return authority;
  }

  async feedbackAuthority(
    token: unknown,
    issuerKeyId: string,
    lastAcceptedSequence: number,
  ): Promise<ControlFeedbackAuthorityContext> {
    const authority = await this.authenticate(token);
    if (!authority) {
      throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Device credential is invalid');
    }
    return controlFeedbackAuthorityForDevice(authority, issuerKeyId, lastAcceptedSequence);
  }

  private async requiredRecord(credentialId: string): Promise<StoredDeviceCredential> {
    const record = await this.store.get(credentialId);
    if (!record) {
      throw new DeviceCredentialError('DEVICE_CREDENTIAL_NOT_FOUND', 'Device credential was not found');
    }
    return record;
  }

  private async newToken(credentialId: string): Promise<string> {
    const secret = tokenPart(this.options.generateSecret(), 'Credential secret', MAX_SECRET_LENGTH);
    if (secret.length < 32) {
      throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Credential secret is too short');
    }
    return `${DEVICE_CREDENTIAL_TOKEN_PREFIX}${credentialId}.${secret}`;
  }

  private async sealedSecret(token: string): Promise<string> {
    const sealedSecret = await this.options.secretCodec.seal(token);
    if (!sealedSecret || sealedSecret.length > MAX_SEALED_SECRET_LENGTH) {
      throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Sealed credential secret is invalid');
    }
    return sealedSecret;
  }
}

function controlFeedbackAuthorityForDevice(
  authority: DeviceCredentialAuthority,
  issuerKeyId: string,
  lastAcceptedSequence: number,
): ControlFeedbackAuthorityContext {
  if (!Number.isSafeInteger(lastAcceptedSequence) || lastAcceptedSequence < 0) {
    throw new DeviceCredentialError('INVALID_DEVICE_CREDENTIAL', 'Feedback sequence is invalid');
  }
  return {
    issuerKeyId: requiredIdentifier(issuerKeyId, 'Issuer key'),
    audienceCredentialId: authority.audienceCredentialId,
    showId: authority.showId,
    targets: [...authority.targets],
    controlIds: [...authority.controlIds],
    scopes: authority.scopes.includes('feedback:read') ? ['feedback:read'] : [],
    lastAcceptedSequence,
  };
}
