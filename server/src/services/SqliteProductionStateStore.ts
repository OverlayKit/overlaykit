import { createHash } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ComponentVisibilityIntent,
  ProductionBus,
  ProductionSnapshot,
} from '../types/production';

export const PRODUCTION_SNAPSHOT_DOCUMENT_VERSION = 'overlaykit-production-snapshot/v1' as const;
export const PRODUCTION_HISTORY_RECORD_VERSION = 'overlaykit-production-history/v1' as const;
export const PRODUCTION_COMMAND_RECORD_VERSION = 'overlaykit-production-command/v1' as const;
export const PRODUCTION_COMMAND_ORDER_VERSION = 'overlaykit-production-command-order/v1' as const;
export const PRODUCTION_COMMAND_AUTHORITY_VERSION =
  'overlaykit-production-command-authority/v1' as const;
export const PRODUCTION_COMMAND_OPERATION_VERSION =
  'overlaykit-production-command-operation/v1' as const;
export const PRODUCTION_VISIBILITY_INTENT_VERSION =
  'overlaykit-production-visibility-intent/v1' as const;

const HISTORY_HEAD_SEQUENCE_KEY = 'production_history_head_sequence';
const HISTORY_HEAD_HASH_KEY = 'production_history_head_hash';
const COMMAND_HEAD_SEQUENCE_KEY = 'production_command_head_sequence';
const COMMAND_HEAD_HASH_KEY = 'production_command_head_hash';
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_REASON_LENGTH = 400;
export const MAX_PRODUCTION_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PRODUCTION_COMMANDS_PER_SHOW = 100_000;
export const DEFAULT_MAX_PRODUCTION_COMMANDS_GLOBAL = 1_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const PRODUCTION_MUTATION_KINDS = [
  'preview.load',
  'program.take',
  'preview.controls',
  'component.visibility',
  'cue.step',
  'quarantine.restore',
  'quarantine.reset',
] as const;

export type ProductionMutationKind = (typeof PRODUCTION_MUTATION_KINDS)[number];

export interface ProductionSnapshotDocument {
  readonly schemaVersion: typeof PRODUCTION_SNAPSHOT_DOCUMENT_VERSION;
  readonly snapshot: ProductionSnapshot;
}

export interface ProductionHistoryRecordDocument {
  readonly schemaVersion: typeof PRODUCTION_HISTORY_RECORD_VERSION;
  readonly globalSequence: number;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly occurredAt: number;
  readonly mutationKind: ProductionMutationKind;
  readonly operationId: string | null;
  readonly previousGlobalHash: string | null;
  readonly previousTargetHash: string | null;
  readonly snapshotHash: string;
  readonly rejectedSnapshotHash: string | null;
}

export interface ProductionHistoryRecord extends ProductionHistoryRecordDocument {
  readonly recordHash: string;
}

export interface StoredProductionSnapshot {
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly updatedAt: number;
  readonly payload: string;
  readonly snapshotHash: string;
}

export interface ProductionTargetQuarantine {
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly rejectedSnapshotHash: string;
  readonly reason: string;
  readonly detectedAt: number;
}

export interface ProductionStateLoadResult {
  readonly snapshots: ReadonlyArray<StoredProductionSnapshot>;
  readonly quarantines: ReadonlyArray<ProductionTargetQuarantine>;
}

export interface ProductionSnapshotCommitInput {
  readonly snapshot: ProductionSnapshot;
  readonly expectedPreviousRevision: number;
  readonly mutationKind: ProductionMutationKind;
  readonly operationId?: string | null;
  readonly occurredAt: number;
  readonly rejectedSnapshotHash?: string | null;
}

export interface ProductionSnapshotCommit {
  readonly snapshotHash: string;
  readonly history: ProductionHistoryRecord;
}

export type ProductionCommandStatus = 'applied' | 'rejected';
export type ProductionCommandResultCode = 'APPLIED' | 'TARGET_REVISION_CONFLICT';

export interface ProductionDeviceCommandAuthority {
  readonly credentialId: string;
  readonly generation: number;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: number;
}

export interface ProductionVisibilityIntentDocument {
  readonly schemaVersion: typeof PRODUCTION_VISIBILITY_INTENT_VERSION;
  readonly kind: 'component.visibility';
  readonly showId: string;
  readonly target: ProductionBus;
  readonly componentId: string;
  readonly visible: boolean;
  readonly expectedRevision: number;
}

export interface ProductionCommandRecordDocument {
  readonly schemaVersion: typeof PRODUCTION_COMMAND_RECORD_VERSION;
  readonly globalSequence: number;
  readonly principalKind: 'device';
  readonly principalId: string;
  readonly operationHash: string;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly actionKind: 'component.visibility';
  readonly intentHash: string;
  readonly authorityGeneration: number;
  readonly authorityHash: string;
  readonly expectedRevision: number;
  readonly previousRevision: number;
  readonly resultingRevision: number;
  readonly resultingSnapshotHash: string;
  readonly status: ProductionCommandStatus;
  readonly resultCode: ProductionCommandResultCode;
  readonly committedAt: number;
  readonly previousShowHash: string | null;
}

export interface ProductionCommandRecord extends ProductionCommandRecordDocument {
  readonly recordHash: string;
}

export interface ProductionCommandOrderDocument {
  readonly schemaVersion: typeof PRODUCTION_COMMAND_ORDER_VERSION;
  readonly globalSequence: number;
  readonly showId: string;
  readonly commandRecordHash: string;
  readonly previousGlobalHash: string | null;
}

export interface ProductionCommandOrderRecord extends ProductionCommandOrderDocument {
  readonly recordHash: string;
}

export interface ProductionVisibilityCommandInput {
  readonly intent: ComponentVisibilityIntent;
  readonly authority: ProductionDeviceCommandAuthority;
}

export interface ProductionVisibilityCommandCommit {
  readonly command: ProductionCommandRecord;
  readonly replayed: boolean;
  readonly snapshot: ProductionSnapshot | null;
  readonly history: ProductionHistoryRecord | null;
}

export type ProductionAuthorityCommitInput =
  ProductionSnapshotCommitInput | ProductionVisibilityCommandInput;

export type ProductionVisibilityCommandCandidate = (
  current: StoredProductionSnapshot | null,
  committedAt: number
) => ProductionSnapshot;

export interface ProductionStatePersistencePort {
  load(): ProductionStateLoadResult;
  quarantine(input: ProductionTargetQuarantine): void;
  commit(input: ProductionSnapshotCommitInput): ProductionSnapshotCommit;
  readHistory(): ReadonlyArray<ProductionHistoryRecord>;
  executeVisibilityCommand?(
    input: ProductionVisibilityCommandInput,
    candidate: ProductionVisibilityCommandCandidate
  ): ProductionVisibilityCommandCommit;
  readCommandJournal?(): ReadonlyArray<ProductionCommandRecord>;
}

export type ProductionStateStoreErrorCode =
  | 'INVALID_PRODUCTION_STATE_STORE'
  | 'PRODUCTION_STATE_STORE_IO'
  | 'PRODUCTION_STATE_STORE_FAILED'
  | 'PRODUCTION_REVISION_CONFLICT'
  | 'PRODUCTION_TARGET_QUARANTINED'
  | 'PRODUCTION_COMMAND_CONFLICT'
  | 'PRODUCTION_COMMAND_AUTHORITY_STALE'
  | 'PRODUCTION_COMMAND_JOURNAL_FULL'
  | 'PRODUCTION_COMMAND_SHOW_QUARANTINED'
  | 'PRODUCTION_COMMAND_SNAPSHOT_TOO_LARGE';

export class ProductionStateStoreError extends Error {
  constructor(
    readonly code: ProductionStateStoreErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProductionStateStoreError';
  }
}

class ProductionCommandNotAdmitted extends Error {
  constructor(readonly reason: unknown) {
    super('Production command was not admitted');
    this.name = 'ProductionCommandNotAdmitted';
  }
}

interface SnapshotRow {
  show_id: string;
  target: string;
  revision: number;
  updated_at: number;
  payload: string;
  snapshot_hash: string;
}

interface HistoryRow {
  global_sequence: number;
  show_id: string;
  target: string;
  revision: number;
  occurred_at: number;
  mutation_kind: string;
  operation_id: string | null;
  previous_global_hash: string | null;
  previous_target_hash: string | null;
  snapshot_hash: string;
  rejected_snapshot_hash: string | null;
  record_hash: string;
}

interface QuarantineRow {
  show_id: string;
  target: string;
  revision: number;
  rejected_snapshot_hash: string;
  reason: string;
  detected_at: number;
}

interface CommandRow {
  global_sequence: number;
  principal_kind: string;
  principal_id: string;
  operation_hash: string;
  show_id: string;
  target: string;
  action_kind: string;
  intent_hash: string;
  authority_generation: number;
  authority_hash: string;
  expected_revision: number;
  previous_revision: number;
  resulting_revision: number;
  resulting_snapshot_hash: string;
  status: string;
  result_code: string;
  committed_at: number;
  previous_show_hash: string | null;
  record_hash: string;
}

interface CommandOrderRow {
  global_sequence: number;
  show_id: string;
  command_record_hash: string;
  previous_global_hash: string | null;
  record_hash: string;
}

interface CommandQuarantineRow {
  show_id: string;
  reason: string;
  detected_at: number;
}

interface DeviceAuthorityRow {
  credential_id: string;
  show_id: string;
  targets: string;
  control_ids: string;
  scopes: string;
  generation: number;
  expires_at: number;
  revoked_at: number | null;
}

interface TargetHead {
  readonly revision: number;
  readonly snapshotHash: string;
  readonly recordHash: string;
}

export interface SqliteProductionStateStoreOptions {
  readonly database: () => DatabaseSync;
  readonly beforeCommit?: (
    phase: 'quarantine' | 'snapshot' | 'command',
    input?: ProductionAuthorityCommitInput
  ) => void;
  readonly afterCommit?: (
    phase: 'quarantine' | 'snapshot' | 'command',
    input?: ProductionAuthorityCommitInput
  ) => void;
  readonly maxCommandsPerShow?: number;
  readonly maxCommandsGlobal?: number;
  readonly now?: () => number;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production state contains a non-finite number'
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production state contains a sparse array'
        );
      }
      entries.push(canonicalJsonValue(value[index]));
    }
    return `[${entries.join(',')}]`;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production state contains a non-JSON object'
      );
    }
    const entries: string[] = [];
    for (const key of Object.keys(source).sort(codeUnitCompare)) {
      entries.push(`${JSON.stringify(key)}:${canonicalJsonValue(source[key])}`);
    }
    return `{${entries.join(',')}}`;
  }
  throw new ProductionStateStoreError(
    'INVALID_PRODUCTION_STATE_STORE',
    'Production state contains a non-JSON value'
  );
}

export function canonicalProductionJson(value: unknown): string {
  return canonicalJsonValue(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function productionSnapshotPayload(snapshot: ProductionSnapshot): string {
  return canonicalProductionJson({
    schemaVersion: PRODUCTION_SNAPSHOT_DOCUMENT_VERSION,
    snapshot,
  } satisfies ProductionSnapshotDocument);
}

export function productionSnapshotHash(snapshot: ProductionSnapshot): string {
  return sha256(productionSnapshotPayload(snapshot));
}

function historyHash(document: ProductionHistoryRecordDocument): string {
  return sha256(canonicalProductionJson(document));
}

function commandHash(document: ProductionCommandRecordDocument): string {
  return sha256(canonicalProductionJson(document));
}

function commandOrderHash(document: ProductionCommandOrderDocument): string {
  return sha256(canonicalProductionJson(document));
}

export function productionVisibilityIntentDocument(
  intent: ComponentVisibilityIntent
): ProductionVisibilityIntentDocument {
  return Object.freeze({
    schemaVersion: PRODUCTION_VISIBILITY_INTENT_VERSION,
    kind: 'component.visibility',
    showId: intent.showId,
    target: intent.target,
    componentId: intent.componentId,
    visible: intent.visible,
    expectedRevision: intent.expectedRevision,
  });
}

export function productionVisibilityIntentHash(intent: ComponentVisibilityIntent): string {
  return sha256(canonicalProductionJson(productionVisibilityIntentDocument(intent)));
}

function productionCommandAuthorityHash(authority: ProductionDeviceCommandAuthority): string {
  return sha256(
    canonicalProductionJson({
      schemaVersion: PRODUCTION_COMMAND_AUTHORITY_VERSION,
      principalKind: 'device',
      credentialId: authority.credentialId,
      generation: authority.generation,
      showId: authority.showId,
      targets: [...authority.targets].sort(codeUnitCompare),
      controlIds: [...authority.controlIds].sort(codeUnitCompare),
      scopes: [...authority.scopes].sort(codeUnitCompare),
      expiresAt: authority.expiresAt,
    })
  );
}

export function productionCommandOperationHash(operationId: string): string {
  return sha256(
    canonicalProductionJson({
      schemaVersion: PRODUCTION_COMMAND_OPERATION_VERSION,
      operationId,
    })
  );
}

function targetKey(showId: string, target: ProductionBus): string {
  return JSON.stringify([showId, target]);
}

function targetRevisionKey(showId: string, target: ProductionBus, revision: number): string {
  return JSON.stringify([showId, target, revision]);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim()
  );
}

function requiredIdentifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) {
    throw new ProductionStateStoreError('INVALID_PRODUCTION_STATE_STORE', `${label} is invalid`);
  }
  return value;
}

function requiredTarget(value: unknown): ProductionBus {
  if (value !== 'preview' && value !== 'program') {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production target is invalid'
    );
  }
  return value;
}

function requiredSafeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ProductionStateStoreError('INVALID_PRODUCTION_STATE_STORE', `${label} is invalid`);
  }
  return value as number;
}

function requiredHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new ProductionStateStoreError('INVALID_PRODUCTION_STATE_STORE', `${label} is invalid`);
  }
  return value;
}

function optionalHash(value: unknown, label: string): string | null {
  return value === null ? null : requiredHash(value, label);
}

function requiredMutationKind(value: unknown): ProductionMutationKind {
  if (
    typeof value !== 'string' ||
    !PRODUCTION_MUTATION_KINDS.includes(value as ProductionMutationKind)
  ) {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production mutation kind is invalid'
    );
  }
  return value as ProductionMutationKind;
}

function requiredCommandStatus(value: unknown): ProductionCommandStatus {
  if (value !== 'applied' && value !== 'rejected') {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production command status is invalid'
    );
  }
  return value;
}

function requiredCommandResultCode(value: unknown): ProductionCommandResultCode {
  if (value !== 'APPLIED' && value !== 'TARGET_REVISION_CONFLICT') {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production command result code is invalid'
    );
  }
  return value;
}

function requiredDevicePrincipalKind(value: unknown): 'device' {
  if (value !== 'device') {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production command principal kind is invalid'
    );
  }
  return value;
}

function requiredVisibilityActionKind(value: unknown): 'component.visibility' {
  if (value !== 'component.visibility') {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production command action kind is invalid'
    );
  }
  return value;
}

function stringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      `${label} is malformed`,
      error
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== 'string' || !validIdentifier(entry)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new ProductionStateStoreError('INVALID_PRODUCTION_STATE_STORE', `${label} is invalid`);
  }
  return parsed;
}

function requiredReason(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REASON_LENGTH ||
    value !== value.trim()
  ) {
    throw new ProductionStateStoreError(
      'INVALID_PRODUCTION_STATE_STORE',
      'Production quarantine reason is invalid'
    );
  }
  return value;
}

function optionalOperationId(value: unknown): string | null {
  if (value === null) return null;
  return requiredIdentifier(value, 'Production operation id');
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function cloneSnapshotRecord(record: StoredProductionSnapshot): StoredProductionSnapshot {
  return Object.freeze({ ...record });
}

function cloneQuarantine(record: ProductionTargetQuarantine): ProductionTargetQuarantine {
  return Object.freeze({ ...record });
}

function cloneHistory(record: ProductionHistoryRecord): ProductionHistoryRecord {
  return Object.freeze({ ...record });
}

function cloneCommand(record: ProductionCommandRecord): ProductionCommandRecord {
  return Object.freeze({ ...record });
}

function sqliteCode(error: unknown): string | null {
  const value = (error as { code?: unknown })?.code;
  return typeof value === 'string' ? value : null;
}

function storeFailure(message: string, error: unknown): ProductionStateStoreError {
  if (error instanceof ProductionStateStoreError) return error;
  const suffix = sqliteCode(error) === 'SQLITE_BUSY' ? ' (exclusive authority is unavailable)' : '';
  return new ProductionStateStoreError('PRODUCTION_STATE_STORE_IO', `${message}${suffix}`, error);
}

export function initializeProductionStateSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS production_current_snapshots (
      show_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('preview', 'program')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      payload TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      PRIMARY KEY (show_id, target)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS production_history (
      global_sequence INTEGER PRIMARY KEY NOT NULL CHECK (global_sequence >= 1),
      show_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('preview', 'program')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      mutation_kind TEXT NOT NULL,
      operation_id TEXT,
      previous_global_hash TEXT,
      previous_target_hash TEXT,
      snapshot_hash TEXT NOT NULL,
      rejected_snapshot_hash TEXT,
      record_hash TEXT UNIQUE NOT NULL,
      UNIQUE (show_id, target, revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS production_quarantines (
      show_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('preview', 'program')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      rejected_snapshot_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      detected_at INTEGER NOT NULL CHECK (detected_at >= 0),
      PRIMARY KEY (show_id, target)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS production_commands (
      global_sequence INTEGER PRIMARY KEY NOT NULL CHECK (global_sequence >= 1),
      principal_kind TEXT NOT NULL CHECK (principal_kind = 'device'),
      principal_id TEXT NOT NULL,
      operation_hash TEXT NOT NULL,
      show_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('preview', 'program')),
      action_kind TEXT NOT NULL CHECK (action_kind = 'component.visibility'),
      intent_hash TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation >= 1),
      authority_hash TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
      previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
      resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 0),
      resulting_snapshot_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
      result_code TEXT NOT NULL CHECK (result_code IN ('APPLIED', 'TARGET_REVISION_CONFLICT')),
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      previous_show_hash TEXT,
      record_hash TEXT UNIQUE NOT NULL,
      UNIQUE (principal_kind, principal_id, operation_hash)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS production_command_order (
      global_sequence INTEGER PRIMARY KEY NOT NULL CHECK (global_sequence >= 1),
      show_id TEXT NOT NULL,
      command_record_hash TEXT UNIQUE NOT NULL,
      previous_global_hash TEXT,
      record_hash TEXT UNIQUE NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS production_command_quarantines (
      show_id TEXT PRIMARY KEY NOT NULL,
      reason TEXT NOT NULL,
      detected_at INTEGER NOT NULL CHECK (detected_at >= 0)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS production_history_no_update
    BEFORE UPDATE ON production_history
    BEGIN
      SELECT RAISE(ABORT, 'production history is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS production_history_no_delete
    BEFORE DELETE ON production_history
    BEGIN
      SELECT RAISE(ABORT, 'production history is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS production_commands_no_update
    BEFORE UPDATE ON production_commands
    BEGIN
      SELECT RAISE(ABORT, 'production command journal is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS production_commands_no_delete
    BEFORE DELETE ON production_commands
    BEGIN
      SELECT RAISE(ABORT, 'production command journal is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS production_command_order_no_update
    BEFORE UPDATE ON production_command_order
    BEGIN
      SELECT RAISE(ABORT, 'production command order is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS production_command_order_no_delete
    BEFORE DELETE ON production_command_order
    BEGIN
      SELECT RAISE(ABORT, 'production command order is append-only');
    END;
  `);
  database
    .prepare('INSERT OR IGNORE INTO authority_metadata (key, value) VALUES (?, ?)')
    .run(HISTORY_HEAD_SEQUENCE_KEY, '0');
  database
    .prepare('INSERT OR IGNORE INTO authority_metadata (key, value) VALUES (?, ?)')
    .run(HISTORY_HEAD_HASH_KEY, '');
  database
    .prepare('INSERT OR IGNORE INTO authority_metadata (key, value) VALUES (?, ?)')
    .run(COMMAND_HEAD_SEQUENCE_KEY, '0');
  database
    .prepare('INSERT OR IGNORE INTO authority_metadata (key, value) VALUES (?, ?)')
    .run(COMMAND_HEAD_HASH_KEY, '');
}

export class SqliteProductionStateStore implements ProductionStatePersistencePort {
  private readonly database: () => DatabaseSync;
  private readonly beforeCommit: NonNullable<SqliteProductionStateStoreOptions['beforeCommit']>;
  private readonly afterCommit: NonNullable<SqliteProductionStateStoreOptions['afterCommit']>;
  private readonly maxCommandsPerShow: number;
  private readonly maxCommandsGlobal: number;
  private readonly now: () => number;
  private loaded = false;
  private failed = false;
  private globalSequence = 0;
  private globalHash: string | null = null;
  private targetHeads = new Map<string, TargetHead>();
  private commandGlobalSequence = 0;
  private commandGlobalHash: string | null = null;
  private commandShowHeads = new Map<string, string>();
  private commandQuarantines = new Set<string>();

  constructor(options: SqliteProductionStateStoreOptions) {
    this.database = options.database;
    this.beforeCommit = options.beforeCommit ?? (() => undefined);
    this.afterCommit = options.afterCommit ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.maxCommandsPerShow = requiredSafeInteger(
      options.maxCommandsPerShow ?? DEFAULT_MAX_PRODUCTION_COMMANDS_PER_SHOW,
      'Maximum production commands per Show',
      1
    );
    this.maxCommandsGlobal = requiredSafeInteger(
      options.maxCommandsGlobal ?? DEFAULT_MAX_PRODUCTION_COMMANDS_GLOBAL,
      'Maximum global production commands',
      1
    );
    if (this.maxCommandsPerShow > this.maxCommandsGlobal) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Per-Show production command limit cannot exceed the global limit'
      );
    }
  }

  load(): ProductionStateLoadResult {
    this.assertUsable();
    if (this.loaded) {
      throw new ProductionStateStoreError(
        'PRODUCTION_STATE_STORE_IO',
        'SQLite production authority is already mounted'
      );
    }
    const database = this.requiredDatabase();
    const targetHeads = this.verifyHistory(database);
    this.verifyCommandJournal(database);
    const rows = database
      .prepare(
        `
      SELECT show_id, target, revision, updated_at, payload, snapshot_hash
      FROM production_current_snapshots
      ORDER BY show_id, target
    `
      )
      .all() as unknown as SnapshotRow[];
    const quarantineRows = database
      .prepare(
        `
      SELECT show_id, target, revision, rejected_snapshot_hash, reason, detected_at
      FROM production_quarantines
      ORDER BY show_id, target
    `
      )
      .all() as unknown as QuarantineRow[];

    const snapshots: StoredProductionSnapshot[] = [];
    const quarantines = new Map<string, ProductionTargetQuarantine>();
    for (const row of quarantineRows) {
      const quarantine = this.quarantineRow(row);
      quarantines.set(targetKey(quarantine.showId, quarantine.target), quarantine);
    }
    for (const [key, quarantine] of quarantines) {
      const targetHead = targetHeads.get(key);
      if (!targetHead || targetHead.revision !== quarantine.revision) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production quarantine does not match durable target history'
        );
      }
    }

    const currentKeys = new Set<string>();
    for (const row of rows) {
      const showId = requiredIdentifier(row.show_id, 'Production Show id');
      const target = requiredTarget(row.target);
      const key = targetKey(showId, target);
      currentKeys.add(key);
      const targetHead = targetHeads.get(key);
      if (!targetHead) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Persisted production snapshot has no durable history'
        );
      }
      const payload = typeof row.payload === 'string' ? row.payload : '';
      const actualHash = sha256(payload);
      let issue: string | null = null;
      const revision =
        Number.isSafeInteger(row.revision) && row.revision >= 1
          ? row.revision
          : targetHead.revision;
      const updatedAt =
        Number.isSafeInteger(row.updated_at) && row.updated_at >= 0 ? row.updated_at : 0;
      const declaredHash =
        typeof row.snapshot_hash === 'string' && SHA256_PATTERN.test(row.snapshot_hash)
          ? row.snapshot_hash
          : actualHash;
      if (revision !== row.revision) {
        issue = 'Persisted production snapshot revision is invalid';
      } else if (updatedAt !== row.updated_at) {
        issue = 'Persisted production snapshot update time is invalid';
      } else if (declaredHash !== row.snapshot_hash) {
        issue = 'Persisted production snapshot hash is invalid';
      } else if (bytes(payload) > MAX_PRODUCTION_SNAPSHOT_BYTES) {
        issue = 'Persisted production snapshot exceeds size limit';
      } else if (actualHash !== declaredHash) {
        issue = 'Persisted production snapshot hash does not match';
      } else if (targetHead.revision !== revision || targetHead.snapshotHash !== declaredHash) {
        issue = 'Persisted production snapshot does not match target history head';
      }
      if (issue) {
        if (!quarantines.has(key)) {
          const quarantine: ProductionTargetQuarantine = Object.freeze({
            showId,
            target,
            revision: targetHead.revision,
            rejectedSnapshotHash: actualHash,
            reason: issue,
            detectedAt: Date.now(),
          });
          this.persistQuarantine(database, quarantine);
          quarantines.set(key, quarantine);
        }
      }
      snapshots.push(
        Object.freeze({
          showId,
          target,
          revision: issue ? targetHead.revision : revision,
          updatedAt,
          payload,
          snapshotHash: declaredHash,
        })
      );
    }

    for (const [key, head] of targetHeads) {
      if (currentKeys.has(key)) continue;
      const [showId, target] = JSON.parse(key) as [string, ProductionBus];
      if (!quarantines.has(key)) {
        const quarantine: ProductionTargetQuarantine = Object.freeze({
          showId,
          target,
          revision: head.revision,
          rejectedSnapshotHash: head.snapshotHash,
          reason: 'Production target history has no current snapshot',
          detectedAt: Date.now(),
        });
        this.persistQuarantine(database, quarantine);
        quarantines.set(key, quarantine);
      }
    }

    this.targetHeads = targetHeads;
    this.loaded = true;
    return Object.freeze({
      snapshots: Object.freeze(snapshots.map(cloneSnapshotRecord)),
      quarantines: Object.freeze([...quarantines.values()].map(cloneQuarantine)),
    });
  }

  quarantine(input: ProductionTargetQuarantine): void {
    this.assertLoaded();
    const quarantine = this.validQuarantine(input);
    const database = this.requiredDatabase();
    this.transaction('quarantine', undefined, () => {
      this.persistQuarantine(database, quarantine);
    });
  }

  commit(input: ProductionSnapshotCommitInput): ProductionSnapshotCommit {
    this.assertLoaded();
    const snapshot = input.snapshot;
    const showId = requiredIdentifier(snapshot.showId, 'Production Show id');
    const target = requiredTarget(snapshot.bus);
    const expectedPreviousRevision = requiredSafeInteger(
      input.expectedPreviousRevision,
      'Expected production revision',
      0
    );
    const revision = requiredSafeInteger(snapshot.revision, 'Production revision', 1);
    if (revision !== expectedPreviousRevision + 1) {
      throw new ProductionStateStoreError(
        'PRODUCTION_REVISION_CONFLICT',
        'Production revision must advance exactly once'
      );
    }
    const occurredAt = requiredSafeInteger(input.occurredAt, 'Production occurrence time', 0);
    const updatedAt = requiredSafeInteger(snapshot.updatedAt, 'Production update time', 0);
    if (updatedAt !== occurredAt) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production snapshot time must equal mutation time'
      );
    }
    const mutationKind = requiredMutationKind(input.mutationKind);
    const operationId = optionalOperationId(input.operationId ?? null);
    const rejectedSnapshotHash = optionalHash(
      input.rejectedSnapshotHash ?? null,
      'Rejected production snapshot hash'
    );
    const recoveryMutation =
      mutationKind === 'quarantine.restore' || mutationKind === 'quarantine.reset';
    if (
      recoveryMutation !== (rejectedSnapshotHash !== null) ||
      (recoveryMutation && !operationId)
    ) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production recovery history must bind an operation and the rejected snapshot hash'
      );
    }
    const payload = productionSnapshotPayload(snapshot);
    if (bytes(payload) > MAX_PRODUCTION_SNAPSHOT_BYTES) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production snapshot exceeds size limit'
      );
    }
    const snapshotHash = sha256(payload);
    const key = targetKey(showId, target);
    const targetHead = this.targetHeads.get(key);
    if ((targetHead?.revision ?? 0) !== expectedPreviousRevision) {
      throw new ProductionStateStoreError(
        'PRODUCTION_REVISION_CONFLICT',
        'Production target history changed before commit'
      );
    }

    const database = this.requiredDatabase();
    const history = this.transaction('snapshot', input, () => {
      const quarantined = database
        .prepare(
          `
        SELECT rejected_snapshot_hash FROM production_quarantines
        WHERE show_id = ? AND target = ?
      `
        )
        .get(showId, target) as { rejected_snapshot_hash?: string } | undefined;
      const current = database
        .prepare(
          `
        SELECT revision FROM production_current_snapshots
        WHERE show_id = ? AND target = ?
      `
        )
        .get(showId, target) as { revision?: number } | undefined;
      if (
        !quarantined &&
        ((current && current.revision !== expectedPreviousRevision) ||
          (!current && expectedPreviousRevision !== 0))
      ) {
        throw new ProductionStateStoreError(
          'PRODUCTION_REVISION_CONFLICT',
          'Production snapshot changed before commit'
        );
      }
      if (quarantined) {
        if (!rejectedSnapshotHash || quarantined.rejected_snapshot_hash !== rejectedSnapshotHash) {
          throw new ProductionStateStoreError(
            'PRODUCTION_TARGET_QUARANTINED',
            'Production target requires explicit recovery'
          );
        }
      } else if (rejectedSnapshotHash) {
        throw new ProductionStateStoreError(
          'PRODUCTION_TARGET_QUARANTINED',
          'Production recovery evidence is stale'
        );
      }

      const globalSequence = this.globalSequence + 1;
      const document: ProductionHistoryRecordDocument = Object.freeze({
        schemaVersion: PRODUCTION_HISTORY_RECORD_VERSION,
        globalSequence,
        showId,
        target,
        revision,
        occurredAt,
        mutationKind,
        operationId,
        previousGlobalHash: this.globalHash,
        previousTargetHash: targetHead?.recordHash ?? null,
        snapshotHash,
        rejectedSnapshotHash,
      });
      const recordHash = historyHash(document);
      database
        .prepare(
          `
        INSERT INTO production_history (
          global_sequence, show_id, target, revision, occurred_at, mutation_kind,
          operation_id, previous_global_hash, previous_target_hash, snapshot_hash,
          rejected_snapshot_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          globalSequence,
          showId,
          target,
          revision,
          occurredAt,
          mutationKind,
          operationId,
          this.globalHash,
          targetHead?.recordHash ?? null,
          snapshotHash,
          rejectedSnapshotHash,
          recordHash
        );
      database
        .prepare(
          `
        INSERT INTO production_current_snapshots (
          show_id, target, revision, updated_at, payload, snapshot_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (show_id, target) DO UPDATE SET
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          payload = excluded.payload,
          snapshot_hash = excluded.snapshot_hash
      `
        )
        .run(showId, target, revision, updatedAt, payload, snapshotHash);
      if (quarantined) {
        database
          .prepare('DELETE FROM production_quarantines WHERE show_id = ? AND target = ?')
          .run(showId, target);
      }
      this.writeMetadata(database, HISTORY_HEAD_SEQUENCE_KEY, String(globalSequence));
      this.writeMetadata(database, HISTORY_HEAD_HASH_KEY, recordHash);
      return Object.freeze({ ...document, recordHash });
    });

    this.globalSequence = history.globalSequence;
    this.globalHash = history.recordHash;
    this.targetHeads.set(
      key,
      Object.freeze({
        revision,
        snapshotHash,
        recordHash: history.recordHash,
      })
    );
    return Object.freeze({ snapshotHash, history: cloneHistory(history) });
  }

  executeVisibilityCommand(
    input: ProductionVisibilityCommandInput,
    candidate: ProductionVisibilityCommandCandidate
  ): ProductionVisibilityCommandCommit {
    this.assertLoaded();
    if (!input || typeof input !== 'object' || typeof candidate !== 'function') {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production visibility command input is invalid'
      );
    }
    const intent = input.intent;
    if (!intent || intent.kind !== 'component.visibility') {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production visibility command intent is invalid'
      );
    }
    const showId = requiredIdentifier(intent.showId, 'Production command Show id');
    const target = requiredTarget(intent.target);
    const componentId = requiredIdentifier(intent.componentId, 'Production command component id');
    if (typeof intent.visible !== 'boolean') {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command visibility value is invalid'
      );
    }
    const operationId = requiredIdentifier(intent.operationId, 'Production command operation id');
    const operationHash = productionCommandOperationHash(operationId);
    const expectedRevision = requiredSafeInteger(
      intent.expectedRevision,
      'Production command expected revision',
      0
    );
    const authority = this.validDeviceAuthority(input.authority, showId, target, componentId);
    const intentHash = productionVisibilityIntentHash(intent);
    const authorityHash = productionCommandAuthorityHash(authority);
    const database = this.requiredDatabase();

    const committed = this.transaction('command', input, () => {
      const committedAt = requiredSafeInteger(this.now(), 'Production command commit time', 0);
      this.assertCurrentDeviceAuthority(database, authority, committedAt, componentId, target);
      if (this.commandQuarantines.has(showId)) {
        throw new ProductionStateStoreError(
          'PRODUCTION_COMMAND_SHOW_QUARANTINED',
          'Production command journal is quarantined for this Show'
        );
      }

      const existingRow = database
        .prepare(
          `
        SELECT global_sequence, principal_kind, principal_id, operation_hash, show_id,
               target, action_kind, intent_hash, authority_generation, authority_hash,
               expected_revision, previous_revision, resulting_revision,
               resulting_snapshot_hash, status, result_code, committed_at,
               previous_show_hash, record_hash
        FROM production_commands
        WHERE principal_kind = 'device' AND principal_id = ? AND operation_hash = ?
      `
        )
        .get(authority.credentialId, operationHash) as unknown as CommandRow | undefined;
      if (existingRow) {
        const existing = this.commandRecord(existingRow);
        if (existing.intentHash !== intentHash) {
          throw new ProductionStateStoreError(
            'PRODUCTION_COMMAND_CONFLICT',
            'Production operation id is bound to another canonical intent'
          );
        }
        return Object.freeze({
          command: existing,
          replayed: true,
          snapshot: null,
          history: null,
          commandOrder: null,
        });
      }

      this.assertCommandCapacity(database, showId);
      const currentRow = database
        .prepare(
          `
        SELECT show_id, target, revision, updated_at, payload, snapshot_hash
        FROM production_current_snapshots
        WHERE show_id = ? AND target = ?
      `
        )
        .get(showId, target) as unknown as SnapshotRow | undefined;
      const current = currentRow ? this.storedSnapshot(currentRow) : null;

      let snapshot: ProductionSnapshot | null = null;
      let history: ProductionHistoryRecord | null = null;
      let status: ProductionCommandStatus;
      let resultCode: ProductionCommandResultCode;
      let previousRevision: number;
      let resultingRevision: number;
      let resultingSnapshotHash: string;

      if (current && current.revision !== expectedRevision) {
        status = 'rejected';
        resultCode = 'TARGET_REVISION_CONFLICT';
        previousRevision = current.revision;
        resultingRevision = current.revision;
        resultingSnapshotHash = current.snapshotHash;
      } else {
        try {
          snapshot = candidate(current, committedAt);
        } catch (error) {
          throw new ProductionCommandNotAdmitted(error);
        }
        if (
          snapshot.showId !== showId ||
          snapshot.bus !== target ||
          snapshot.revision !== expectedRevision + 1 ||
          snapshot.updatedAt !== committedAt
        ) {
          throw new ProductionStateStoreError(
            'INVALID_PRODUCTION_STATE_STORE',
            'Production command candidate does not match its durable intent'
          );
        }
        const payload = productionSnapshotPayload(snapshot);
        if (bytes(payload) > MAX_PRODUCTION_SNAPSHOT_BYTES) {
          throw new ProductionCommandNotAdmitted(
            new ProductionStateStoreError(
              'PRODUCTION_COMMAND_SNAPSHOT_TOO_LARGE',
              'Production command snapshot exceeds size limit'
            )
          );
        }
        previousRevision = expectedRevision;
        history = this.appendSnapshotRows(
          database,
          snapshot,
          expectedRevision,
          'component.visibility',
          operationHash,
          committedAt
        );
        resultingRevision = snapshot.revision;
        resultingSnapshotHash = history.snapshotHash;
        status = 'applied';
        resultCode = 'APPLIED';
      }

      const globalSequence = this.commandGlobalSequence + 1;
      const document: ProductionCommandRecordDocument = Object.freeze({
        schemaVersion: PRODUCTION_COMMAND_RECORD_VERSION,
        globalSequence,
        principalKind: 'device',
        principalId: authority.credentialId,
        operationHash,
        showId,
        target,
        actionKind: 'component.visibility',
        intentHash,
        authorityGeneration: authority.generation,
        authorityHash,
        expectedRevision,
        previousRevision,
        resultingRevision,
        resultingSnapshotHash,
        status,
        resultCode,
        committedAt,
        previousShowHash: this.commandShowHeads.get(showId) ?? null,
      });
      const recordHash = commandHash(document);
      const command = Object.freeze({ ...document, recordHash });
      database
        .prepare(
          `
        INSERT INTO production_commands (
          global_sequence, principal_kind, principal_id, operation_hash, show_id,
          target, action_kind, intent_hash, authority_generation, authority_hash,
          expected_revision, previous_revision, resulting_revision,
          resulting_snapshot_hash, status, result_code, committed_at,
          previous_show_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          globalSequence,
          command.principalKind,
          command.principalId,
          command.operationHash,
          command.showId,
          command.target,
          command.actionKind,
          command.intentHash,
          command.authorityGeneration,
          command.authorityHash,
          command.expectedRevision,
          command.previousRevision,
          command.resultingRevision,
          command.resultingSnapshotHash,
          command.status,
          command.resultCode,
          command.committedAt,
          command.previousShowHash,
          command.recordHash
        );

      const orderDocument: ProductionCommandOrderDocument = Object.freeze({
        schemaVersion: PRODUCTION_COMMAND_ORDER_VERSION,
        globalSequence,
        showId,
        commandRecordHash: recordHash,
        previousGlobalHash: this.commandGlobalHash,
      });
      const orderRecordHash = commandOrderHash(orderDocument);
      database
        .prepare(
          `
        INSERT INTO production_command_order (
          global_sequence, show_id, command_record_hash, previous_global_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?)
      `
        )
        .run(globalSequence, showId, recordHash, this.commandGlobalHash, orderRecordHash);
      this.writeMetadata(database, COMMAND_HEAD_SEQUENCE_KEY, String(globalSequence));
      this.writeMetadata(database, COMMAND_HEAD_HASH_KEY, orderRecordHash);
      return Object.freeze({
        command,
        replayed: false,
        snapshot,
        history,
        commandOrder: Object.freeze({ ...orderDocument, recordHash: orderRecordHash }),
      });
    });

    if (!committed.replayed) {
      this.commandGlobalSequence = committed.command.globalSequence;
      this.commandGlobalHash = committed.commandOrder!.recordHash;
      this.commandShowHeads.set(showId, committed.command.recordHash);
      if (committed.snapshot && committed.history) {
        this.globalSequence = committed.history.globalSequence;
        this.globalHash = committed.history.recordHash;
        this.targetHeads.set(
          targetKey(showId, target),
          Object.freeze({
            revision: committed.snapshot.revision,
            snapshotHash: committed.history.snapshotHash,
            recordHash: committed.history.recordHash,
          })
        );
      }
    }
    return Object.freeze({
      command: cloneCommand(committed.command),
      replayed: committed.replayed,
      snapshot: committed.snapshot ? Object.freeze({ ...committed.snapshot }) : null,
      history: committed.history ? cloneHistory(committed.history) : null,
    });
  }

  readHistory(): ReadonlyArray<ProductionHistoryRecord> {
    this.assertLoaded();
    return Object.freeze(
      this.historyRows(this.requiredDatabase()).map((row) => cloneHistory(this.historyRecord(row)))
    );
  }

  readCommandJournal(): ReadonlyArray<ProductionCommandRecord> {
    this.assertLoaded();
    return Object.freeze(
      this.commandRows(this.requiredDatabase()).map((row) => cloneCommand(this.commandRecord(row)))
    );
  }

  private appendSnapshotRows(
    database: DatabaseSync,
    snapshot: ProductionSnapshot,
    expectedPreviousRevision: number,
    mutationKind: ProductionMutationKind,
    operationId: string | null,
    occurredAt: number
  ): ProductionHistoryRecord {
    const showId = snapshot.showId;
    const target = snapshot.bus;
    const key = targetKey(showId, target);
    const targetHead = this.targetHeads.get(key);
    if ((targetHead?.revision ?? 0) !== expectedPreviousRevision) {
      throw new ProductionStateStoreError(
        'PRODUCTION_REVISION_CONFLICT',
        'Production target history changed before command commit'
      );
    }
    const quarantined = database
      .prepare(
        `
      SELECT rejected_snapshot_hash FROM production_quarantines
      WHERE show_id = ? AND target = ?
    `
      )
      .get(showId, target) as { rejected_snapshot_hash?: string } | undefined;
    if (quarantined) {
      throw new ProductionStateStoreError(
        'PRODUCTION_TARGET_QUARANTINED',
        'Production target requires explicit recovery'
      );
    }
    const current = database
      .prepare(
        `
      SELECT revision FROM production_current_snapshots
      WHERE show_id = ? AND target = ?
    `
      )
      .get(showId, target) as { revision?: number } | undefined;
    if (
      (current && current.revision !== expectedPreviousRevision) ||
      (!current && expectedPreviousRevision !== 0)
    ) {
      throw new ProductionStateStoreError(
        'PRODUCTION_REVISION_CONFLICT',
        'Production snapshot changed before command commit'
      );
    }

    const payload = productionSnapshotPayload(snapshot);
    const snapshotHash = sha256(payload);
    const globalSequence = this.globalSequence + 1;
    const document: ProductionHistoryRecordDocument = Object.freeze({
      schemaVersion: PRODUCTION_HISTORY_RECORD_VERSION,
      globalSequence,
      showId,
      target,
      revision: snapshot.revision,
      occurredAt,
      mutationKind,
      operationId,
      previousGlobalHash: this.globalHash,
      previousTargetHash: targetHead?.recordHash ?? null,
      snapshotHash,
      rejectedSnapshotHash: null,
    });
    const recordHash = historyHash(document);
    database
      .prepare(
        `
      INSERT INTO production_history (
        global_sequence, show_id, target, revision, occurred_at, mutation_kind,
        operation_id, previous_global_hash, previous_target_hash, snapshot_hash,
        rejected_snapshot_hash, record_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        globalSequence,
        showId,
        target,
        snapshot.revision,
        occurredAt,
        mutationKind,
        operationId,
        this.globalHash,
        targetHead?.recordHash ?? null,
        snapshotHash,
        null,
        recordHash
      );
    database
      .prepare(
        `
      INSERT INTO production_current_snapshots (
        show_id, target, revision, updated_at, payload, snapshot_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (show_id, target) DO UPDATE SET
        revision = excluded.revision,
        updated_at = excluded.updated_at,
        payload = excluded.payload,
        snapshot_hash = excluded.snapshot_hash
    `
      )
      .run(showId, target, snapshot.revision, snapshot.updatedAt, payload, snapshotHash);
    this.writeMetadata(database, HISTORY_HEAD_SEQUENCE_KEY, String(globalSequence));
    this.writeMetadata(database, HISTORY_HEAD_HASH_KEY, recordHash);
    return Object.freeze({ ...document, recordHash });
  }

  private storedSnapshot(row: SnapshotRow): StoredProductionSnapshot {
    const showId = requiredIdentifier(row.show_id, 'Production Show id');
    const target = requiredTarget(row.target);
    const revision = requiredSafeInteger(row.revision, 'Production revision', 1);
    const updatedAt = requiredSafeInteger(row.updated_at, 'Production update time', 0);
    if (typeof row.payload !== 'string') {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production snapshot payload is invalid'
      );
    }
    const snapshotHash = requiredHash(row.snapshot_hash, 'Production snapshot hash');
    if (
      bytes(row.payload) > MAX_PRODUCTION_SNAPSHOT_BYTES ||
      sha256(row.payload) !== snapshotHash
    ) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production snapshot payload does not match its durable identity'
      );
    }
    const targetHead = this.targetHeads.get(targetKey(showId, target));
    if (
      !targetHead ||
      targetHead.revision !== revision ||
      targetHead.snapshotHash !== snapshotHash
    ) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production snapshot does not match its target head'
      );
    }
    return Object.freeze({
      showId,
      target,
      revision,
      updatedAt,
      payload: row.payload,
      snapshotHash,
    });
  }

  private validDeviceAuthority(
    authority: ProductionDeviceCommandAuthority,
    showId: string,
    target: ProductionBus,
    componentId: string
  ): ProductionDeviceCommandAuthority {
    if (!authority || typeof authority !== 'object') {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command authority is invalid'
      );
    }
    const credentialId = requiredIdentifier(
      authority.credentialId,
      'Production command credential id'
    );
    const generation = requiredSafeInteger(
      authority.generation,
      'Production command credential generation',
      1
    );
    const authorityShowId = requiredIdentifier(
      authority.showId,
      'Production command authority Show id'
    );
    const expiresAt = requiredSafeInteger(
      authority.expiresAt,
      'Production command authority expiration',
      1
    );
    const targetValues = this.validAuthorityIdentifiers(authority.targets, 'targets');
    if (targetValues.some((value) => value !== 'preview' && value !== 'program')) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command authority targets are invalid'
      );
    }
    const targets = targetValues as ProductionBus[];
    const controlIds = this.validAuthorityIdentifiers(authority.controlIds, 'controls');
    const scopes = this.validAuthorityIdentifiers(authority.scopes, 'scopes');
    if (
      authorityShowId !== showId ||
      !targets.includes(target) ||
      !controlIds.includes(`${componentId}.visibility`) ||
      !scopes.includes('component.visibility:write')
    ) {
      throw new ProductionStateStoreError(
        'PRODUCTION_COMMAND_AUTHORITY_STALE',
        'Production command authority does not grant the canonical intent'
      );
    }
    return Object.freeze({
      credentialId,
      generation,
      showId: authorityShowId,
      targets: Object.freeze([...targets]),
      controlIds: Object.freeze([...controlIds]),
      scopes: Object.freeze([...scopes]),
      expiresAt,
    });
  }

  private validAuthorityIdentifiers(values: ReadonlyArray<string>, label: string): string[] {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => !validIdentifier(value)) ||
      new Set(values).size !== values.length
    ) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        `Production command authority ${label} are invalid`
      );
    }
    return [...values].sort(codeUnitCompare);
  }

  private assertCurrentDeviceAuthority(
    database: DatabaseSync,
    authority: ProductionDeviceCommandAuthority,
    committedAt: number,
    componentId: string,
    target: ProductionBus
  ): void {
    const row = database
      .prepare(
        `
      SELECT credential_id, show_id, targets, control_ids, scopes, generation,
             expires_at, revoked_at
      FROM device_credentials
      WHERE credential_id = ?
    `
      )
      .get(authority.credentialId) as unknown as DeviceAuthorityRow | undefined;
    if (!row) {
      throw new ProductionStateStoreError(
        'PRODUCTION_COMMAND_AUTHORITY_STALE',
        'Production command credential is no longer current'
      );
    }
    const targets = stringArray(row.targets, 'Device authority targets').sort(codeUnitCompare);
    const controlIds = stringArray(row.control_ids, 'Device authority controls').sort(
      codeUnitCompare
    );
    const scopes = stringArray(row.scopes, 'Device authority scopes').sort(codeUnitCompare);
    const stale =
      requiredIdentifier(row.credential_id, 'Device authority credential id') !==
        authority.credentialId ||
      requiredIdentifier(row.show_id, 'Device authority Show id') !== authority.showId ||
      requiredSafeInteger(row.generation, 'Device authority generation', 1) !==
        authority.generation ||
      requiredSafeInteger(row.expires_at, 'Device authority expiration', 1) !==
        authority.expiresAt ||
      row.revoked_at !== null ||
      row.expires_at <= committedAt ||
      canonicalProductionJson(targets) !==
        canonicalProductionJson([...authority.targets].sort(codeUnitCompare)) ||
      canonicalProductionJson(controlIds) !==
        canonicalProductionJson([...authority.controlIds].sort(codeUnitCompare)) ||
      canonicalProductionJson(scopes) !==
        canonicalProductionJson([...authority.scopes].sort(codeUnitCompare)) ||
      !targets.includes(target) ||
      !controlIds.includes(`${componentId}.visibility`) ||
      !scopes.includes('component.visibility:write');
    if (stale) {
      throw new ProductionStateStoreError(
        'PRODUCTION_COMMAND_AUTHORITY_STALE',
        'Production command authority changed before admission'
      );
    }
  }

  private assertCommandCapacity(database: DatabaseSync, showId: string): void {
    if (this.commandGlobalSequence >= this.maxCommandsGlobal) {
      throw new ProductionStateStoreError(
        'PRODUCTION_COMMAND_JOURNAL_FULL',
        'Global production command journal is full'
      );
    }
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM production_command_order WHERE show_id = ?')
      .get(showId) as { count?: number } | undefined;
    if (!Number.isSafeInteger(row?.count) || (row?.count ?? 0) >= this.maxCommandsPerShow) {
      throw new ProductionStateStoreError(
        'PRODUCTION_COMMAND_JOURNAL_FULL',
        'Production command journal is full for this Show'
      );
    }
  }

  private verifyHistory(database: DatabaseSync): Map<string, TargetHead> {
    const rows = this.historyRows(database);
    const targetHeads = new Map<string, TargetHead>();
    let globalHash: string | null = null;
    for (const [index, row] of rows.entries()) {
      const record = this.historyRecord(row);
      if (record.globalSequence !== index + 1) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production history sequence is not contiguous'
        );
      }
      if (record.previousGlobalHash !== globalHash) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production history global chain is invalid'
        );
      }
      const key = targetKey(record.showId, record.target);
      const targetHead = targetHeads.get(key);
      if (record.previousTargetHash !== (targetHead?.recordHash ?? null)) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production history target chain is invalid'
        );
      }
      if (record.revision !== (targetHead?.revision ?? 0) + 1) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production history target revision is invalid'
        );
      }
      globalHash = record.recordHash;
      targetHeads.set(
        key,
        Object.freeze({
          revision: record.revision,
          snapshotHash: record.snapshotHash,
          recordHash: record.recordHash,
        })
      );
    }

    const declaredSequence = Number(this.readMetadata(database, HISTORY_HEAD_SEQUENCE_KEY));
    const declaredHash = this.readMetadata(database, HISTORY_HEAD_HASH_KEY);
    if (declaredSequence !== rows.length || declaredHash !== (globalHash ?? '')) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production history does not match its durable head'
      );
    }
    this.globalSequence = rows.length;
    this.globalHash = globalHash;
    return targetHeads;
  }

  private verifyCommandJournal(database: DatabaseSync): void {
    const orderRows = database
      .prepare(
        `
      SELECT global_sequence, show_id, command_record_hash, previous_global_hash, record_hash
      FROM production_command_order
      ORDER BY global_sequence
    `
      )
      .all() as unknown as CommandOrderRow[];
    const commandRows = this.commandRows(database);
    const historyByTargetRevision = new Map<string, ProductionHistoryRecord>();
    for (const row of this.historyRows(database)) {
      const record = this.historyRecord(row);
      historyByTargetRevision.set(
        targetRevisionKey(record.showId, record.target, record.revision),
        record
      );
    }
    const commandsBySequence = new Map<number, CommandRow>();
    for (const row of commandRows) {
      if (
        !Number.isSafeInteger(row.global_sequence) ||
        commandsBySequence.has(row.global_sequence)
      ) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production command journal contains an unbound sequence'
        );
      }
      commandsBySequence.set(row.global_sequence, row);
    }
    const persistedQuarantineRows = database
      .prepare(
        `
      SELECT show_id, reason, detected_at
      FROM production_command_quarantines
      ORDER BY show_id
    `
      )
      .all() as unknown as CommandQuarantineRow[];
    const quarantines = new Set<string>();
    for (const row of persistedQuarantineRows) {
      quarantines.add(requiredIdentifier(row.show_id, 'Command quarantine Show id'));
      requiredReason(row.reason);
      requiredSafeInteger(row.detected_at, 'Command quarantine detection time', 0);
    }

    let globalHash: string | null = null;
    const showHeads = new Map<string, string>();
    const orderedShows = new Set<string>();
    for (const [index, row] of orderRows.entries()) {
      const order = this.commandOrderRecord(row);
      if (order.globalSequence !== index + 1 || order.previousGlobalHash !== globalHash) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production command global order is invalid'
        );
      }
      globalHash = order.recordHash;
      orderedShows.add(order.showId);
      const commandRow = commandsBySequence.get(order.globalSequence);
      commandsBySequence.delete(order.globalSequence);
      let command: ProductionCommandRecord | null = null;
      let issue: string | null = null;
      if (!commandRow) {
        issue = 'Production command order has no command record';
      } else {
        try {
          command = this.commandRecord(commandRow);
          if (
            command.globalSequence !== order.globalSequence ||
            command.showId !== order.showId ||
            command.recordHash !== order.commandRecordHash
          ) {
            issue = 'Production command does not match its global order';
          } else if (command.previousShowHash !== (showHeads.get(order.showId) ?? null)) {
            issue = 'Production command Show chain is invalid';
          } else {
            const history = historyByTargetRevision.get(
              targetRevisionKey(command.showId, command.target, command.resultingRevision)
            );
            if (!history || history.snapshotHash !== command.resultingSnapshotHash) {
              issue = 'Production command result is not bound to target history';
            } else if (
              command.status === 'applied' &&
              (history.mutationKind !== 'component.visibility' ||
                history.operationId !== command.operationHash ||
                history.occurredAt !== command.committedAt)
            ) {
              issue = 'Applied production command is not bound to its mutation history';
            }
          }
        } catch (error) {
          issue = error instanceof Error ? error.message : 'Production command is invalid';
        }
      }
      showHeads.set(order.showId, order.commandRecordHash);
      if (issue && !quarantines.has(order.showId)) {
        this.persistCommandQuarantine(database, order.showId, issue, Date.now());
        quarantines.add(order.showId);
      }
    }
    if (commandsBySequence.size > 0) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command journal contains records outside global order'
      );
    }
    for (const showId of quarantines) {
      if (!orderedShows.has(showId)) {
        throw new ProductionStateStoreError(
          'INVALID_PRODUCTION_STATE_STORE',
          'Production command quarantine has no ordered command evidence'
        );
      }
    }

    const declaredSequence = Number(this.readMetadata(database, COMMAND_HEAD_SEQUENCE_KEY));
    const declaredHash = this.readMetadata(database, COMMAND_HEAD_HASH_KEY);
    if (declaredSequence !== orderRows.length || declaredHash !== (globalHash ?? '')) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command order does not match its durable head'
      );
    }
    this.commandGlobalSequence = orderRows.length;
    this.commandGlobalHash = globalHash;
    this.commandShowHeads = showHeads;
    this.commandQuarantines = quarantines;
  }

  private commandRows(database: DatabaseSync): CommandRow[] {
    return database
      .prepare(
        `
      SELECT global_sequence, principal_kind, principal_id, operation_hash, show_id,
             target, action_kind, intent_hash, authority_generation, authority_hash,
             expected_revision, previous_revision, resulting_revision,
             resulting_snapshot_hash, status, result_code, committed_at,
             previous_show_hash, record_hash
      FROM production_commands
      ORDER BY global_sequence
    `
      )
      .all() as unknown as CommandRow[];
  }

  private commandRecord(row: CommandRow): ProductionCommandRecord {
    const document: ProductionCommandRecordDocument = Object.freeze({
      schemaVersion: PRODUCTION_COMMAND_RECORD_VERSION,
      globalSequence: requiredSafeInteger(row.global_sequence, 'Command global sequence', 1),
      principalKind: requiredDevicePrincipalKind(row.principal_kind),
      principalId: requiredIdentifier(row.principal_id, 'Command principal id'),
      operationHash: requiredHash(row.operation_hash, 'Command operation hash'),
      showId: requiredIdentifier(row.show_id, 'Command Show id'),
      target: requiredTarget(row.target),
      actionKind: requiredVisibilityActionKind(row.action_kind),
      intentHash: requiredHash(row.intent_hash, 'Command intent hash'),
      authorityGeneration: requiredSafeInteger(
        row.authority_generation,
        'Command authority generation',
        1
      ),
      authorityHash: requiredHash(row.authority_hash, 'Command authority hash'),
      expectedRevision: requiredSafeInteger(row.expected_revision, 'Command expected revision', 0),
      previousRevision: requiredSafeInteger(row.previous_revision, 'Command previous revision', 0),
      resultingRevision: requiredSafeInteger(
        row.resulting_revision,
        'Command resulting revision',
        0
      ),
      resultingSnapshotHash: requiredHash(
        row.resulting_snapshot_hash,
        'Command resulting snapshot hash'
      ),
      status: requiredCommandStatus(row.status),
      resultCode: requiredCommandResultCode(row.result_code),
      committedAt: requiredSafeInteger(row.committed_at, 'Command commit time', 0),
      previousShowHash: optionalHash(row.previous_show_hash, 'Previous command Show hash'),
    });
    if (
      (document.status === 'applied' &&
        (document.resultCode !== 'APPLIED' ||
          document.expectedRevision !== document.previousRevision ||
          document.resultingRevision !== document.previousRevision + 1)) ||
      (document.status === 'rejected' &&
        (document.resultCode !== 'TARGET_REVISION_CONFLICT' ||
          document.expectedRevision === document.previousRevision ||
          document.resultingRevision !== document.previousRevision))
    ) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command terminal result is inconsistent'
      );
    }
    const recordHash = requiredHash(row.record_hash, 'Command record hash');
    if (commandHash(document) !== recordHash) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command record hash is invalid'
      );
    }
    return Object.freeze({ ...document, recordHash });
  }

  private commandOrderRecord(row: CommandOrderRow): ProductionCommandOrderRecord {
    const document: ProductionCommandOrderDocument = Object.freeze({
      schemaVersion: PRODUCTION_COMMAND_ORDER_VERSION,
      globalSequence: requiredSafeInteger(row.global_sequence, 'Command order sequence', 1),
      showId: requiredIdentifier(row.show_id, 'Command order Show id'),
      commandRecordHash: requiredHash(row.command_record_hash, 'Ordered command hash'),
      previousGlobalHash: optionalHash(row.previous_global_hash, 'Previous command global hash'),
    });
    const recordHash = requiredHash(row.record_hash, 'Command order record hash');
    if (commandOrderHash(document) !== recordHash) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production command order record hash is invalid'
      );
    }
    return Object.freeze({ ...document, recordHash });
  }

  private persistCommandQuarantine(
    database: DatabaseSync,
    showId: string,
    reason: string,
    detectedAt: number
  ): void {
    database
      .prepare(
        `
      INSERT INTO production_command_quarantines (show_id, reason, detected_at)
      VALUES (?, ?, ?)
      ON CONFLICT (show_id) DO NOTHING
    `
      )
      .run(
        requiredIdentifier(showId, 'Command quarantine Show id'),
        requiredReason(reason.slice(0, MAX_REASON_LENGTH)),
        requiredSafeInteger(detectedAt, 'Command quarantine detection time', 0)
      );
  }

  private historyRows(database: DatabaseSync): HistoryRow[] {
    return database
      .prepare(
        `
      SELECT global_sequence, show_id, target, revision, occurred_at, mutation_kind,
             operation_id, previous_global_hash, previous_target_hash, snapshot_hash,
             rejected_snapshot_hash, record_hash
      FROM production_history
      ORDER BY global_sequence
    `
      )
      .all() as unknown as HistoryRow[];
  }

  private historyRecord(row: HistoryRow): ProductionHistoryRecord {
    const document: ProductionHistoryRecordDocument = Object.freeze({
      schemaVersion: PRODUCTION_HISTORY_RECORD_VERSION,
      globalSequence: requiredSafeInteger(row.global_sequence, 'Production history sequence', 1),
      showId: requiredIdentifier(row.show_id, 'Production Show id'),
      target: requiredTarget(row.target),
      revision: requiredSafeInteger(row.revision, 'Production revision', 1),
      occurredAt: requiredSafeInteger(row.occurred_at, 'Production occurrence time', 0),
      mutationKind: requiredMutationKind(row.mutation_kind),
      operationId: optionalOperationId(row.operation_id),
      previousGlobalHash: optionalHash(row.previous_global_hash, 'Previous production global hash'),
      previousTargetHash: optionalHash(row.previous_target_hash, 'Previous production target hash'),
      snapshotHash: requiredHash(row.snapshot_hash, 'Production snapshot hash'),
      rejectedSnapshotHash: optionalHash(
        row.rejected_snapshot_hash,
        'Rejected production snapshot hash'
      ),
    });
    const recordHash = requiredHash(row.record_hash, 'Production history record hash');
    if (historyHash(document) !== recordHash) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        'Production history record hash is invalid'
      );
    }
    return Object.freeze({ ...document, recordHash });
  }

  private quarantineRow(row: QuarantineRow): ProductionTargetQuarantine {
    return this.validQuarantine({
      showId: row.show_id,
      target: requiredTarget(row.target),
      revision: row.revision,
      rejectedSnapshotHash: row.rejected_snapshot_hash,
      reason: row.reason,
      detectedAt: row.detected_at,
    });
  }

  private validQuarantine(input: ProductionTargetQuarantine): ProductionTargetQuarantine {
    return Object.freeze({
      showId: requiredIdentifier(input.showId, 'Production Show id'),
      target: requiredTarget(input.target),
      revision: requiredSafeInteger(input.revision, 'Production revision', 1),
      rejectedSnapshotHash: requiredHash(
        input.rejectedSnapshotHash,
        'Rejected production snapshot hash'
      ),
      reason: requiredReason(input.reason),
      detectedAt: requiredSafeInteger(input.detectedAt, 'Quarantine detection time', 0),
    });
  }

  private persistQuarantine(database: DatabaseSync, quarantine: ProductionTargetQuarantine): void {
    database
      .prepare(
        `
      INSERT INTO production_quarantines (
        show_id, target, revision, rejected_snapshot_hash, reason, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (show_id, target) DO NOTHING
    `
      )
      .run(
        quarantine.showId,
        quarantine.target,
        quarantine.revision,
        quarantine.rejectedSnapshotHash,
        quarantine.reason,
        quarantine.detectedAt
      );
  }

  private readMetadata(database: DatabaseSync, key: string): string {
    const row = database.prepare('SELECT value FROM authority_metadata WHERE key = ?').get(key) as
      { value?: string } | undefined;
    if (typeof row?.value !== 'string') {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        `Production metadata ${key} is missing`
      );
    }
    return row.value;
  }

  private writeMetadata(database: DatabaseSync, key: string, value: string): void {
    const result = database
      .prepare('UPDATE authority_metadata SET value = ? WHERE key = ?')
      .run(value, key);
    if (Number(result.changes) !== 1) {
      throw new ProductionStateStoreError(
        'INVALID_PRODUCTION_STATE_STORE',
        `Production metadata ${key} is missing`
      );
    }
  }

  private transaction<Result>(
    phase: 'quarantine' | 'snapshot' | 'command',
    input: ProductionAuthorityCommitInput | undefined,
    operation: () => Result
  ): Result {
    const database = this.requiredDatabase();
    database.exec('BEGIN IMMEDIATE');
    let committing = false;
    try {
      const result = operation();
      this.beforeCommit(phase, input);
      committing = true;
      database.exec('COMMIT');
      this.afterCommit(phase, input);
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original production authority failure.
      }
      if (error instanceof ProductionCommandNotAdmitted) throw error.reason;
      if (committing) this.failed = true;
      throw storeFailure('Failed to commit SQLite production authority', error);
    }
  }

  private requiredDatabase(): DatabaseSync {
    try {
      return this.database();
    } catch (error) {
      throw storeFailure('SQLite production authority is unavailable', error);
    }
  }

  private assertLoaded(): void {
    this.assertUsable();
    if (!this.loaded) {
      throw new ProductionStateStoreError(
        'PRODUCTION_STATE_STORE_IO',
        'SQLite production authority has not been loaded'
      );
    }
  }

  private assertUsable(): void {
    if (this.failed) {
      throw new ProductionStateStoreError(
        'PRODUCTION_STATE_STORE_FAILED',
        'SQLite production authority failed permanently'
      );
    }
  }
}
