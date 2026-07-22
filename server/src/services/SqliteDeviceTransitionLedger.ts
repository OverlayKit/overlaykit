import { createHash, randomUUID } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProductionBus } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};

export const DEVICE_TRANSITION_RECORD_VERSION = 'overlaykit-device-transition/v1' as const;

const LEDGER_HEAD_SEQUENCE_KEY = 'device_transition_ledger_head_sequence';
const LEDGER_HEAD_HASH_KEY = 'device_transition_ledger_head_hash';
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_REASON_LENGTH = 200;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const DEVICE_TRANSITION_KINDS = [
  'host.started',
  'host.discontinuity.detected',
  'host.stopped',
  'device.connection.not_ready',
  'device.connection.ready',
  'device.connection.checkpoint',
  'device.connection.quiescing',
  'device.connection.closed',
] as const;

export type DeviceTransitionKind = (typeof DEVICE_TRANSITION_KINDS)[number];
export type DeviceConnectionAuditPhase = 'not_ready' | 'ready' | 'quiescing' | 'closed';

export interface DeviceTransitionAuthorityEvidence {
  readonly credentialId: string;
  readonly audienceCredentialId: string;
  readonly generation: number;
  readonly showId: string;
  readonly expiresAt: number;
  readonly authorityHash: string;
}

export interface DeviceTransitionReadyTargetEvidence {
  readonly target: ProductionBus;
  readonly targetRevision: number;
  readonly catalogGeneration: number;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly confirmedAt: number;
  readonly sentAt: number;
  readonly sendConfirmedAt: number;
  readonly appliedAt: number;
}

export interface DeviceTransitionCheckpointTargetEvidence {
  readonly target: ProductionBus;
  readonly targetRevision: number;
  readonly catalogGeneration: number;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly appliedAt: number;
}

interface HostStartedEvidence {
  readonly previousHostEpochId: string | null;
}

interface HostDiscontinuityEvidence {
  readonly previousHostEpochId: string;
}

type DeviceTransitionEvidence =
  | HostStartedEvidence
  | HostDiscontinuityEvidence
  | Record<string, never>
  | {
      readonly authority: DeviceTransitionAuthorityEvidence;
      readonly targets: ReadonlyArray<ProductionBus>;
    }
  | {
      readonly targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence>;
    }
  | {
      readonly audienceCredentialId: string;
      readonly reason: string;
      readonly targets: ReadonlyArray<DeviceTransitionCheckpointTargetEvidence>;
    }
  | {
      readonly reason: string;
    };

export interface DeviceTransitionRecordDocument {
  readonly schemaVersion: typeof DEVICE_TRANSITION_RECORD_VERSION;
  readonly globalSequence: number;
  readonly hostEpochId: string;
  readonly connectionId: string | null;
  readonly kind: DeviceTransitionKind;
  readonly occurredAt: number;
  readonly previousGlobalHash: string | null;
  readonly previousConnectionHash: string | null;
  readonly evidence: DeviceTransitionEvidence;
  readonly signature: null;
}

export interface DeviceTransitionRecord extends DeviceTransitionRecordDocument {
  readonly recordHash: string;
}

export type DeviceConnectionTransitionInput =
  | {
      readonly kind: 'device.connection.not_ready';
      readonly connectionId: string;
      readonly occurredAt: number;
      readonly authority: DeviceTransitionAuthorityEvidence;
      readonly targets: ReadonlyArray<ProductionBus>;
    }
  | {
      readonly kind: 'device.connection.ready';
      readonly connectionId: string;
      readonly occurredAt: number;
      readonly targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence>;
    }
  | {
      readonly kind: 'device.connection.checkpoint';
      readonly connectionId: string;
      readonly occurredAt: number;
      readonly audienceCredentialId: string;
      readonly reason: string;
      readonly targets: ReadonlyArray<DeviceTransitionCheckpointTargetEvidence>;
    }
  | {
      readonly kind: 'device.connection.quiescing' | 'device.connection.closed';
      readonly connectionId: string;
      readonly occurredAt: number;
      readonly reason: string;
    };

export interface DeviceTransitionLedgerState {
  readonly activeHostEpochId: string | null;
  readonly globalSequence: number;
  readonly globalHash: string | null;
  readonly failed: boolean;
  readonly connectionPhases: Readonly<Record<string, DeviceConnectionAuditPhase>>;
}

export interface DeviceTransitionLedgerPort {
  startHostEpoch(): ReadonlyArray<DeviceTransitionRecord>;
  append(input: DeviceConnectionTransitionInput): DeviceTransitionRecord;
  stopHostEpoch(occurredAt?: number): DeviceTransitionRecord;
  getState(): DeviceTransitionLedgerState;
  readRecords(): ReadonlyArray<DeviceTransitionRecord>;
}

export type DeviceTransitionLedgerErrorCode =
  | 'INVALID_DEVICE_TRANSITION_LEDGER'
  | 'DEVICE_TRANSITION_LEDGER_IO'
  | 'DEVICE_TRANSITION_LEDGER_FAILED'
  | 'DEVICE_TRANSITION_INVALID';

export class DeviceTransitionLedgerError extends Error {
  constructor(
    readonly code: DeviceTransitionLedgerErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DeviceTransitionLedgerError';
  }
}

interface DeviceTransitionRow {
  global_sequence: number;
  host_epoch_id: string;
  connection_id: string | null;
  kind: string;
  occurred_at: number;
  previous_global_hash: string | null;
  previous_connection_hash: string | null;
  payload: string;
  record_hash: string;
  signature: null;
}

export interface SqliteDeviceTransitionLedgerOptions {
  readonly database: () => DatabaseSync;
  readonly hostEpochId?: string;
  readonly now?: () => number;
  readonly beforeCommit?: (kind: DeviceTransitionKind) => void;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim();
}

function requiredIdentifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      `${label} is invalid`,
    );
  }
  return value;
}

function requiredInteger(value: unknown, label: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value)
    || (allowZero ? (value as number) < 0 : (value as number) < 1)
  ) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      `${label} is invalid`,
    );
  }
  return value as number;
}

function requiredHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      `${label} is invalid`,
    );
  }
  return value;
}

function optionalHash(value: unknown, label: string): string | null {
  return value === null ? null : requiredHash(value, label);
}

function requiredReason(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_REASON_LENGTH
    || value !== value.trim()
  ) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Transition reason is invalid',
    );
  }
  return value;
}

function normalizedNow(now: () => number): number {
  return requiredInteger(now(), 'Transition clock', true);
}

function normalizeTargets(targets: ReadonlyArray<ProductionBus>): ReadonlyArray<ProductionBus> {
  if (
    !Array.isArray(targets)
    || targets.length === 0
    || targets.some((target) => target !== 'preview' && target !== 'program')
    || new Set(targets).size !== targets.length
  ) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Transition targets are invalid',
    );
  }
  return Object.freeze(
    [...targets].sort((left, right) => left === right ? 0 : left === 'preview' ? -1 : 1),
  );
}

function normalizeAuthority(
  authority: DeviceTransitionAuthorityEvidence,
): DeviceTransitionAuthorityEvidence {
  if (!authority || typeof authority !== 'object') {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Transition authority is invalid',
    );
  }
  const normalized = Object.freeze({
    credentialId: requiredIdentifier(authority.credentialId, 'Credential identifier'),
    audienceCredentialId: requiredIdentifier(
      authority.audienceCredentialId,
      'Credential audience',
    ),
    generation: requiredInteger(authority.generation, 'Credential generation'),
    showId: requiredIdentifier(authority.showId, 'Show identifier'),
    expiresAt: requiredInteger(authority.expiresAt, 'Credential expiration'),
    authorityHash: requiredHash(authority.authorityHash, 'Credential authority hash'),
  });
  if (normalized.audienceCredentialId !== `${normalized.credentialId}.g${normalized.generation}`) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Credential audience does not match transition generation',
    );
  }
  return normalized;
}

function normalizeReadyTargets(
  targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence>,
): ReadonlyArray<DeviceTransitionReadyTargetEvidence> {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Readiness evidence requires targets',
    );
  }
  const normalized = targets.map((evidence) => {
    if (!evidence || typeof evidence !== 'object') {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Readiness target evidence is invalid',
      );
    }
    if (evidence.target !== 'preview' && evidence.target !== 'program') {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Readiness target is invalid',
      );
    }
    const confirmedAt = requiredInteger(evidence.confirmedAt, 'Snapshot confirmation time', true);
    const sentAt = requiredInteger(evidence.sentAt, 'Snapshot send time', true);
    const sendConfirmedAt = requiredInteger(
      evidence.sendConfirmedAt,
      'Snapshot send confirmation time',
      true,
    );
    const appliedAt = requiredInteger(evidence.appliedAt, 'Snapshot applied time', true);
    if (sentAt < confirmedAt || sendConfirmedAt < sentAt || appliedAt < sentAt) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Readiness evidence times are inconsistent',
      );
    }
    return Object.freeze({
      target: evidence.target,
      targetRevision: requiredInteger(evidence.targetRevision, 'Target revision', true),
      catalogGeneration: requiredInteger(
        evidence.catalogGeneration,
        'Catalog generation',
      ),
      issuerKeyId: requiredIdentifier(evidence.issuerKeyId, 'Issuer key identifier'),
      sequence: requiredInteger(evidence.sequence, 'Snapshot sequence'),
      sha256: requiredHash(evidence.sha256, 'Snapshot SHA-256'),
      confirmedAt,
      sentAt,
      sendConfirmedAt,
      appliedAt,
    });
  });
  const targetNames = normalizeTargets(normalized.map(({ target }) => target));
  if (new Set(normalized.map(({ catalogGeneration }) => catalogGeneration)).size !== 1) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Readiness targets must share one catalog generation',
    );
  }
  return Object.freeze(targetNames.map((target) => normalized.find((item) => item.target === target)!));
}

function normalizeCheckpointTargets(
  targets: ReadonlyArray<DeviceTransitionCheckpointTargetEvidence>,
): ReadonlyArray<DeviceTransitionCheckpointTargetEvidence> {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new DeviceTransitionLedgerError(
      'DEVICE_TRANSITION_INVALID',
      'Checkpoint evidence requires targets',
    );
  }
  const normalized = targets.map((evidence) => {
    if (
      !evidence
      || typeof evidence !== 'object'
      || (evidence.target !== 'preview' && evidence.target !== 'program')
    ) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Checkpoint target evidence is invalid',
      );
    }
    return Object.freeze({
      target: evidence.target,
      targetRevision: requiredInteger(evidence.targetRevision, 'Target revision', true),
      catalogGeneration: requiredInteger(
        evidence.catalogGeneration,
        'Catalog generation',
      ),
      issuerKeyId: requiredIdentifier(evidence.issuerKeyId, 'Issuer key identifier'),
      sequence: requiredInteger(evidence.sequence, 'Snapshot sequence'),
      sha256: requiredHash(evidence.sha256, 'Snapshot SHA-256'),
      appliedAt: requiredInteger(evidence.appliedAt, 'Snapshot applied time', true),
    });
  });
  const targetNames = normalizeTargets(normalized.map(({ target }) => target));
  return Object.freeze(
    targetNames.map((target) => normalized.find((item) => item.target === target)!),
  );
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEvidence(kind: DeviceTransitionKind, value: unknown): DeviceTransitionEvidence {
  if (!isRecord(value)) {
    throw new DeviceTransitionLedgerError(
      'INVALID_DEVICE_TRANSITION_LEDGER',
      'Transition evidence is malformed',
    );
  }
  switch (kind) {
    case 'host.started': {
      if (!exactKeys(value, ['previousHostEpochId'])) break;
      const previousHostEpochId = value.previousHostEpochId === null
        ? null
        : requiredIdentifier(value.previousHostEpochId, 'Previous host epoch');
      return Object.freeze({ previousHostEpochId });
    }
    case 'host.discontinuity.detected':
      if (exactKeys(value, ['previousHostEpochId'])) {
        return Object.freeze({
          previousHostEpochId: requiredIdentifier(
            value.previousHostEpochId,
            'Previous host epoch',
          ),
        });
      }
      break;
    case 'host.stopped':
      if (exactKeys(value, [])) return Object.freeze({});
      break;
    case 'device.connection.not_ready':
      if (exactKeys(value, ['authority', 'targets'])) {
        return Object.freeze({
          authority: normalizeAuthority(value.authority as DeviceTransitionAuthorityEvidence),
          targets: normalizeTargets(value.targets as ProductionBus[]),
        });
      }
      break;
    case 'device.connection.ready':
      if (exactKeys(value, ['targets'])) {
        return Object.freeze({
          targets: normalizeReadyTargets(
            value.targets as DeviceTransitionReadyTargetEvidence[],
          ),
        });
      }
      break;
    case 'device.connection.checkpoint':
      if (exactKeys(value, ['audienceCredentialId', 'reason', 'targets'])) {
        return Object.freeze({
          audienceCredentialId: requiredIdentifier(
            value.audienceCredentialId,
            'Checkpoint audience',
          ),
          reason: requiredReason(value.reason),
          targets: normalizeCheckpointTargets(
            value.targets as DeviceTransitionCheckpointTargetEvidence[],
          ),
        });
      }
      break;
    case 'device.connection.quiescing':
    case 'device.connection.closed':
      if (exactKeys(value, ['reason'])) {
        return Object.freeze({ reason: requiredReason(value.reason) });
      }
      break;
  }
  throw new DeviceTransitionLedgerError(
    'INVALID_DEVICE_TRANSITION_LEDGER',
    `Transition evidence for ${kind} is malformed`,
  );
}

function canonicalDocument(
  value: Omit<DeviceTransitionRecordDocument, 'schemaVersion' | 'signature'>,
): DeviceTransitionRecordDocument {
  return Object.freeze({
    schemaVersion: DEVICE_TRANSITION_RECORD_VERSION,
    globalSequence: value.globalSequence,
    hostEpochId: value.hostEpochId,
    connectionId: value.connectionId,
    kind: value.kind,
    occurredAt: value.occurredAt,
    previousGlobalHash: value.previousGlobalHash,
    previousConnectionHash: value.previousConnectionHash,
    evidence: value.evidence,
    signature: null,
  });
}

function recordHash(document: DeviceTransitionRecordDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function frozenRecord(
  document: DeviceTransitionRecordDocument,
  hash: string,
): DeviceTransitionRecord {
  return Object.freeze({ ...document, recordHash: hash });
}

function sqliteFailure(message: string, cause: unknown): DeviceTransitionLedgerError {
  return cause instanceof DeviceTransitionLedgerError
    ? cause
    : new DeviceTransitionLedgerError('DEVICE_TRANSITION_LEDGER_IO', message, cause);
}

function phaseAfter(
  current: DeviceConnectionAuditPhase | undefined,
  kind: DeviceTransitionKind,
): DeviceConnectionAuditPhase | undefined {
  if (kind === 'device.connection.not_ready' && current === undefined) return 'not_ready';
  if (kind === 'device.connection.ready' && current === 'not_ready') return 'ready';
  if (kind === 'device.connection.checkpoint' && current === 'ready') return 'ready';
  if (kind === 'device.connection.quiescing' && current === 'ready') return 'quiescing';
  if (kind === 'device.connection.closed' && (current === 'not_ready' || current === 'quiescing')) {
    return 'closed';
  }
  if (!kind.startsWith('device.connection.')) return current;
  throw new DeviceTransitionLedgerError(
    'DEVICE_TRANSITION_INVALID',
    `Transition ${kind} is invalid from ${current ?? 'absent'}`,
  );
}

export function initializeDeviceTransitionLedgerSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS device_transition_ledger (
      global_sequence INTEGER PRIMARY KEY NOT NULL CHECK (global_sequence > 0),
      host_epoch_id TEXT NOT NULL,
      connection_id TEXT,
      kind TEXT NOT NULL,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      previous_global_hash TEXT,
      previous_connection_hash TEXT,
      payload TEXT NOT NULL,
      record_hash TEXT NOT NULL UNIQUE,
      signature TEXT
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS device_transition_ledger_no_update
    BEFORE UPDATE ON device_transition_ledger
    BEGIN
      SELECT RAISE(ABORT, 'device transition ledger is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS device_transition_ledger_no_delete
    BEFORE DELETE ON device_transition_ledger
    BEGIN
      SELECT RAISE(ABORT, 'device transition ledger is append-only');
    END;
  `);
}

export class SqliteDeviceTransitionLedger implements DeviceTransitionLedgerPort {
  private readonly database: () => DatabaseSync;
  private readonly hostEpochId: string;
  private readonly now: () => number;
  private readonly beforeCommit: (kind: DeviceTransitionKind) => void;
  private globalSequence = 0;
  private globalHash: string | null = null;
  private activeHostEpochId: string | null = null;
  private failed = false;
  private readonly connectionHashes = new Map<string, string>();
  private readonly connectionPhases = new Map<string, DeviceConnectionAuditPhase>();
  private readonly connectionTargets = new Map<string, ReadonlyArray<ProductionBus>>();
  private readonly connectionAudiences = new Map<string, string>();
  private readonly checkpointedConnections = new Set<string>();
  private records: DeviceTransitionRecord[] = [];

  constructor(options: SqliteDeviceTransitionLedgerOptions) {
    if (!options || typeof options.database !== 'function') {
      throw new DeviceTransitionLedgerError(
        'INVALID_DEVICE_TRANSITION_LEDGER',
        'SQLite transition ledger database is required',
      );
    }
    this.database = options.database;
    this.hostEpochId = requiredIdentifier(options.hostEpochId ?? randomUUID(), 'Host epoch');
    this.now = options.now ?? Date.now;
    this.beforeCommit = options.beforeCommit ?? (() => undefined);
    if (typeof this.beforeCommit !== 'function') {
      throw new DeviceTransitionLedgerError(
        'INVALID_DEVICE_TRANSITION_LEDGER',
        'Transition ledger commit hook is invalid',
      );
    }
    normalizedNow(this.now);
    this.verifyPersistedHistory();
  }

  startHostEpoch(): ReadonlyArray<DeviceTransitionRecord> {
    this.assertUsable();
    if (this.activeHostEpochId !== null) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Host epoch is already active',
      );
    }
    const previousHostEpochId = this.latestUnsealedHostEpoch();
    this.activeHostEpochId = this.hostEpochId;
    const appended: DeviceTransitionRecord[] = [];
    const started = this.appendInternal(
      'host.started',
      null,
      normalizedNow(this.now),
      Object.freeze({ previousHostEpochId }),
    );
    appended.push(started);
    if (!previousHostEpochId) return Object.freeze(appended);
    const discontinuity = this.appendInternal(
      'host.discontinuity.detected',
      null,
      normalizedNow(this.now),
      Object.freeze({ previousHostEpochId }),
    );
    appended.push(discontinuity);
    for (const [connectionId, phase] of [...this.connectionPhases]) {
      if (phase === 'closed') continue;
      if (phase === 'ready') {
        appended.push(this.appendInternal(
          'device.connection.quiescing',
          connectionId,
          normalizedNow(this.now),
          Object.freeze({ reason: 'host.discontinuity' }),
        ));
      }
      appended.push(this.appendInternal(
        'device.connection.closed',
        connectionId,
        normalizedNow(this.now),
        Object.freeze({ reason: 'host.discontinuity' }),
      ));
    }
    return Object.freeze(appended);
  }

  append(input: DeviceConnectionTransitionInput): DeviceTransitionRecord {
    this.assertUsable();
    if (!input || typeof input !== 'object' || this.activeHostEpochId !== this.hostEpochId) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'An active host epoch and transition input are required',
      );
    }
    const connectionId = requiredIdentifier(input.connectionId, 'Connection identifier');
    const occurredAt = requiredInteger(input.occurredAt, 'Transition time', true);
    phaseAfter(this.connectionPhases.get(connectionId), input.kind);
    let evidence: DeviceTransitionEvidence;
    if (input.kind === 'device.connection.not_ready') {
      evidence = Object.freeze({
        authority: normalizeAuthority(input.authority),
        targets: normalizeTargets(input.targets),
      });
    } else if (input.kind === 'device.connection.ready') {
      evidence = Object.freeze({ targets: normalizeReadyTargets(input.targets) });
      const readyTargets = (evidence as { targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence> })
        .targets;
      if (readyTargets.some((target) => (
        target.confirmedAt > occurredAt
        || target.sentAt > occurredAt
        || target.sendConfirmedAt > occurredAt
        || target.appliedAt > occurredAt
      ))) {
        throw new DeviceTransitionLedgerError(
          'DEVICE_TRANSITION_INVALID',
          'Readiness evidence cannot postdate its transition',
        );
      }
      this.assertExactConnectionTargets(
        connectionId,
        readyTargets.map(({ target }) => target),
      );
    } else if (input.kind === 'device.connection.checkpoint') {
      if (this.checkpointedConnections.has(connectionId)) {
        throw new DeviceTransitionLedgerError(
          'DEVICE_TRANSITION_INVALID',
          'Device connection checkpoint already exists',
        );
      }
      const targets = normalizeCheckpointTargets(input.targets);
      const audienceCredentialId = requiredIdentifier(
        input.audienceCredentialId,
        'Checkpoint audience',
      );
      if (this.connectionAudiences.get(connectionId) !== audienceCredentialId) {
        throw new DeviceTransitionLedgerError(
          'DEVICE_TRANSITION_INVALID',
          'Checkpoint audience does not match connection authority',
        );
      }
      if (targets.some(({ appliedAt }) => appliedAt > occurredAt)) {
        throw new DeviceTransitionLedgerError(
          'DEVICE_TRANSITION_INVALID',
          'Checkpoint evidence cannot postdate its transition',
        );
      }
      this.assertExactConnectionTargets(
        connectionId,
        targets.map(({ target }) => target),
      );
      evidence = Object.freeze({
        audienceCredentialId,
        reason: requiredReason(input.reason),
        targets,
      });
    } else {
      evidence = Object.freeze({ reason: requiredReason(input.reason) });
    }
    return this.appendInternal(input.kind, connectionId, occurredAt, evidence);
  }

  stopHostEpoch(occurredAt = normalizedNow(this.now)): DeviceTransitionRecord {
    this.assertUsable();
    if (this.activeHostEpochId !== this.hostEpochId) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Host epoch is not active',
      );
    }
    const openConnection = [...this.connectionPhases.values()].some((phase) => phase !== 'closed');
    if (openConnection) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Host epoch cannot stop with open device connections',
      );
    }
    const record = this.appendInternal('host.stopped', null, occurredAt, Object.freeze({}));
    this.activeHostEpochId = null;
    return record;
  }

  getState(): DeviceTransitionLedgerState {
    return Object.freeze({
      activeHostEpochId: this.activeHostEpochId,
      globalSequence: this.globalSequence,
      globalHash: this.globalHash,
      failed: this.failed,
      connectionPhases: Object.freeze(Object.fromEntries(this.connectionPhases)),
    });
  }

  readRecords(): ReadonlyArray<DeviceTransitionRecord> {
    return Object.freeze([...this.records]);
  }

  private appendInternal(
    kind: DeviceTransitionKind,
    connectionId: string | null,
    occurredAt: number,
    evidence: DeviceTransitionEvidence,
  ): DeviceTransitionRecord {
    this.assertUsable();
    const globalSequence = this.globalSequence + 1;
    if (!Number.isSafeInteger(globalSequence)) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Transition global sequence is exhausted',
      );
    }
    const previousConnectionHash = connectionId
      ? this.connectionHashes.get(connectionId) ?? null
      : null;
    const document = canonicalDocument({
      globalSequence,
      hostEpochId: this.hostEpochId,
      connectionId,
      kind,
      occurredAt,
      previousGlobalHash: this.globalHash,
      previousConnectionHash,
      evidence,
    });
    const payload = JSON.stringify(document);
    const hash = recordHash(document);
    const database = this.database();
    try {
      database.exec('BEGIN IMMEDIATE');
      this.assertPersistedHead(database);
      database.prepare(`
        INSERT INTO device_transition_ledger (
          global_sequence, host_epoch_id, connection_id, kind, occurred_at,
          previous_global_hash, previous_connection_hash, payload, record_hash, signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        globalSequence,
        this.hostEpochId,
        connectionId,
        kind,
        occurredAt,
        this.globalHash,
        previousConnectionHash,
        payload,
        hash,
      );
      const upsert = database.prepare(`
        INSERT INTO authority_metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      upsert.run(LEDGER_HEAD_SEQUENCE_KEY, String(globalSequence));
      upsert.run(LEDGER_HEAD_HASH_KEY, hash);
      this.beforeCommit(kind);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The original persistence failure remains authoritative.
      }
      this.failed = true;
      throw sqliteFailure('Failed to commit device transition evidence', error);
    }

    const record = frozenRecord(document, hash);
    this.globalSequence = globalSequence;
    this.globalHash = hash;
    this.records.push(record);
    if (connectionId) {
      this.connectionHashes.set(connectionId, hash);
      this.connectionPhases.set(
        connectionId,
        phaseAfter(this.connectionPhases.get(connectionId), kind)!,
      );
      if (kind === 'device.connection.not_ready') {
        const notReadyEvidence = evidence as {
          authority: DeviceTransitionAuthorityEvidence;
          targets: ReadonlyArray<ProductionBus>;
        };
        this.connectionTargets.set(
          connectionId,
          notReadyEvidence.targets,
        );
        this.connectionAudiences.set(
          connectionId,
          notReadyEvidence.authority.audienceCredentialId,
        );
      } else if (kind === 'device.connection.checkpoint') {
        this.checkpointedConnections.add(connectionId);
      }
    }
    return record;
  }

  private verifyPersistedHistory(): void {
    const database = this.database();
    try {
      const triggerRows = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'device_transition_ledger_no_update',
          'device_transition_ledger_no_delete'
        )
        ORDER BY name
      `).all() as Array<{ name?: string }>;
      if (triggerRows.length !== 2) {
        throw new DeviceTransitionLedgerError(
          'INVALID_DEVICE_TRANSITION_LEDGER',
          'Device transition append-only triggers are missing',
        );
      }
      const rows = database.prepare(`
        SELECT global_sequence, host_epoch_id, connection_id, kind, occurred_at,
               previous_global_hash, previous_connection_hash, payload, record_hash, signature
        FROM device_transition_ledger
        ORDER BY global_sequence
      `).all() as unknown as DeviceTransitionRow[];
      let previousGlobalHash: string | null = null;
      const connectionHashes = new Map<string, string>();
      const connectionPhases = new Map<string, DeviceConnectionAuditPhase>();
      const connectionTargets = new Map<string, ReadonlyArray<ProductionBus>>();
      const connectionAudiences = new Map<string, string>();
      const checkpointedConnections = new Set<string>();
      const records: DeviceTransitionRecord[] = [];
      rows.forEach((row, index) => {
        const expectedSequence = index + 1;
        if (
          row.global_sequence !== expectedSequence
          || row.signature !== null
          || !DEVICE_TRANSITION_KINDS.includes(row.kind as DeviceTransitionKind)
        ) {
          throw new DeviceTransitionLedgerError(
            'INVALID_DEVICE_TRANSITION_LEDGER',
            'Device transition sequence or kind is invalid',
          );
        }
        const kind = row.kind as DeviceTransitionKind;
        const connectionId = row.connection_id === null
          ? null
          : requiredIdentifier(row.connection_id, 'Persisted connection identifier');
        const expectedConnectionHash = connectionId
          ? connectionHashes.get(connectionId) ?? null
          : null;
        if (
          optionalHash(row.previous_global_hash, 'Previous global hash') !== previousGlobalHash
          || optionalHash(row.previous_connection_hash, 'Previous connection hash')
            !== expectedConnectionHash
        ) {
          throw new DeviceTransitionLedgerError(
            'INVALID_DEVICE_TRANSITION_LEDGER',
            'Device transition hash predecessor is invalid',
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload) as unknown;
        } catch (error) {
          throw new DeviceTransitionLedgerError(
            'INVALID_DEVICE_TRANSITION_LEDGER',
            'Device transition payload is not valid JSON',
            error,
          );
        }
        if (!isRecord(parsed) || !exactKeys(parsed, [
          'schemaVersion',
          'globalSequence',
          'hostEpochId',
          'connectionId',
          'kind',
          'occurredAt',
          'previousGlobalHash',
          'previousConnectionHash',
          'evidence',
          'signature',
        ])) {
          throw new DeviceTransitionLedgerError(
            'INVALID_DEVICE_TRANSITION_LEDGER',
            'Device transition canonical payload shape is invalid',
          );
        }
        const document = canonicalDocument({
          globalSequence: requiredInteger(parsed.globalSequence, 'Persisted global sequence'),
          hostEpochId: requiredIdentifier(parsed.hostEpochId, 'Persisted host epoch'),
          connectionId: parsed.connectionId === null
            ? null
            : requiredIdentifier(parsed.connectionId, 'Persisted connection identifier'),
          kind: parsed.kind as DeviceTransitionKind,
          occurredAt: requiredInteger(parsed.occurredAt, 'Persisted transition time', true),
          previousGlobalHash: optionalHash(parsed.previousGlobalHash, 'Previous global hash'),
          previousConnectionHash: optionalHash(
            parsed.previousConnectionHash,
            'Previous connection hash',
          ),
          evidence: normalizeEvidence(kind, parsed.evidence),
        });
        if (
          parsed.schemaVersion !== DEVICE_TRANSITION_RECORD_VERSION
          || parsed.signature !== null
          || document.globalSequence !== row.global_sequence
          || document.hostEpochId !== row.host_epoch_id
          || document.connectionId !== connectionId
          || document.kind !== kind
          || document.occurredAt !== row.occurred_at
          || JSON.stringify(document) !== row.payload
          || recordHash(document) !== requiredHash(row.record_hash, 'Record hash')
        ) {
          throw new DeviceTransitionLedgerError(
            'INVALID_DEVICE_TRANSITION_LEDGER',
            'Device transition canonical payload or hash is invalid',
          );
        }
        const record = frozenRecord(document, row.record_hash);
        records.push(record);
        previousGlobalHash = row.record_hash;
        if (connectionId) {
          if (kind === 'device.connection.ready') {
            const readyTargets = (
              document.evidence as { targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence> }
            ).targets;
            if (readyTargets.some((target) => (
              target.confirmedAt > document.occurredAt
              || target.sentAt > document.occurredAt
              || target.sendConfirmedAt > document.occurredAt
              || target.appliedAt > document.occurredAt
            ))) {
              throw new DeviceTransitionLedgerError(
                'INVALID_DEVICE_TRANSITION_LEDGER',
                'Persisted readiness evidence postdates its transition',
              );
            }
            const expected = connectionTargets.get(connectionId);
            const actual = readyTargets.map(({ target }) => target);
            if (
              !expected
              || expected.length !== actual.length
              || expected.some((target, index) => target !== actual[index])
            ) {
              throw new DeviceTransitionLedgerError(
                'INVALID_DEVICE_TRANSITION_LEDGER',
                'Persisted readiness targets do not match connection authority',
              );
            }
          } else if (kind === 'device.connection.checkpoint') {
            if (checkpointedConnections.has(connectionId)) {
              throw new DeviceTransitionLedgerError(
                'INVALID_DEVICE_TRANSITION_LEDGER',
                'Persisted device connection has duplicate checkpoints',
              );
            }
            const checkpoint = document.evidence as {
              audienceCredentialId: string;
              reason: string;
              targets: ReadonlyArray<DeviceTransitionCheckpointTargetEvidence>;
            };
            const expected = connectionTargets.get(connectionId);
            const actual = checkpoint.targets.map(({ target }) => target);
            if (
              connectionAudiences.get(connectionId) !== checkpoint.audienceCredentialId
              || !expected
              || expected.length !== actual.length
              || expected.some((target, index) => target !== actual[index])
              || checkpoint.targets.some(({ appliedAt }) => appliedAt > document.occurredAt)
            ) {
              throw new DeviceTransitionLedgerError(
                'INVALID_DEVICE_TRANSITION_LEDGER',
                'Persisted checkpoint does not match connection evidence',
              );
            }
            checkpointedConnections.add(connectionId);
          }
          connectionHashes.set(connectionId, row.record_hash);
          connectionPhases.set(
            connectionId,
            phaseAfter(connectionPhases.get(connectionId), kind)!,
          );
          if (kind === 'device.connection.not_ready') {
            const notReadyEvidence = document.evidence as {
              authority: DeviceTransitionAuthorityEvidence;
              targets: ReadonlyArray<ProductionBus>;
            };
            connectionTargets.set(
              connectionId,
              notReadyEvidence.targets,
            );
            connectionAudiences.set(
              connectionId,
              notReadyEvidence.authority.audienceCredentialId,
            );
          }
        }
      });
      this.assertMetadataHead(database, rows.length, previousGlobalHash);
      this.records = records;
      this.globalSequence = rows.length;
      this.globalHash = previousGlobalHash;
      this.connectionHashes.clear();
      this.connectionPhases.clear();
      this.connectionTargets.clear();
      this.connectionAudiences.clear();
      this.checkpointedConnections.clear();
      for (const [connectionId, hash] of connectionHashes) this.connectionHashes.set(connectionId, hash);
      for (const [connectionId, phase] of connectionPhases) this.connectionPhases.set(connectionId, phase);
      for (const [connectionId, targets] of connectionTargets) {
        this.connectionTargets.set(connectionId, targets);
      }
      for (const [connectionId, audience] of connectionAudiences) {
        this.connectionAudiences.set(connectionId, audience);
      }
      for (const connectionId of checkpointedConnections) {
        this.checkpointedConnections.add(connectionId);
      }
    } catch (error) {
      this.failed = true;
      throw sqliteFailure('Failed to verify device transition history', error);
    }
  }

  private latestUnsealedHostEpoch(): string | null {
    const states = new Map<string, 'started' | 'stopped'>();
    let latest: string | null = null;
    for (const record of this.records) {
      if (record.kind === 'host.started') {
        states.set(record.hostEpochId, 'started');
        latest = record.hostEpochId;
      } else if (record.kind === 'host.stopped') {
        states.set(record.hostEpochId, 'stopped');
      }
    }
    return latest && states.get(latest) === 'started' ? latest : null;
  }

  private assertMetadataHead(
    database: DatabaseSync,
    sequence: number,
    hash: string | null,
  ): void {
    const rows = database.prepare(`
      SELECT key, value FROM authority_metadata
      WHERE key IN (?, ?)
      ORDER BY key
    `).all(LEDGER_HEAD_HASH_KEY, LEDGER_HEAD_SEQUENCE_KEY) as Array<{
      key?: string;
      value?: string;
    }>;
    if (sequence === 0 && rows.length === 0) return;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    if (
      rows.length !== 2
      || values.get(LEDGER_HEAD_SEQUENCE_KEY) !== String(sequence)
      || values.get(LEDGER_HEAD_HASH_KEY) !== hash
    ) {
      throw new DeviceTransitionLedgerError(
        'INVALID_DEVICE_TRANSITION_LEDGER',
        'Device transition durable head does not match history',
      );
    }
  }

  private assertPersistedHead(database: DatabaseSync): void {
    this.assertMetadataHead(database, this.globalSequence, this.globalHash);
  }

  private assertExactConnectionTargets(
    connectionId: string,
    actual: ReadonlyArray<ProductionBus>,
  ): void {
    const expected = this.connectionTargets.get(connectionId);
    if (
      !expected
      || expected.length !== actual.length
      || expected.some((target, index) => target !== actual[index])
    ) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_INVALID',
        'Readiness targets do not match connection authority',
      );
    }
  }

  private assertUsable(): void {
    if (this.failed) {
      throw new DeviceTransitionLedgerError(
        'DEVICE_TRANSITION_LEDGER_FAILED',
        'Device transition ledger is failed',
      );
    }
  }
}
