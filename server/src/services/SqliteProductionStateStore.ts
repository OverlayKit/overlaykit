import { createHash } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProductionBus, ProductionSnapshot } from '../types/production';

export const PRODUCTION_SNAPSHOT_DOCUMENT_VERSION = 'overlaykit-production-snapshot/v1' as const;
export const PRODUCTION_HISTORY_RECORD_VERSION = 'overlaykit-production-history/v1' as const;

const HISTORY_HEAD_SEQUENCE_KEY = 'production_history_head_sequence';
const HISTORY_HEAD_HASH_KEY = 'production_history_head_hash';
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_REASON_LENGTH = 400;
export const MAX_PRODUCTION_SNAPSHOT_BYTES = 10 * 1024 * 1024;
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

export interface ProductionStatePersistencePort {
  load(): ProductionStateLoadResult;
  quarantine(input: ProductionTargetQuarantine): void;
  commit(input: ProductionSnapshotCommitInput): ProductionSnapshotCommit;
  readHistory(): ReadonlyArray<ProductionHistoryRecord>;
}

export type ProductionStateStoreErrorCode =
  | 'INVALID_PRODUCTION_STATE_STORE'
  | 'PRODUCTION_STATE_STORE_IO'
  | 'PRODUCTION_STATE_STORE_FAILED'
  | 'PRODUCTION_REVISION_CONFLICT'
  | 'PRODUCTION_TARGET_QUARANTINED';

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

interface TargetHead {
  readonly revision: number;
  readonly snapshotHash: string;
  readonly recordHash: string;
}

export interface SqliteProductionStateStoreOptions {
  readonly database: () => DatabaseSync;
  readonly beforeCommit?: (
    phase: 'quarantine' | 'snapshot',
    input?: ProductionSnapshotCommitInput
  ) => void;
  readonly afterCommit?: (
    phase: 'quarantine' | 'snapshot',
    input?: ProductionSnapshotCommitInput
  ) => void;
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

function targetKey(showId: string, target: ProductionBus): string {
  return JSON.stringify([showId, target]);
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
  `);
  database
    .prepare('INSERT OR IGNORE INTO authority_metadata (key, value) VALUES (?, ?)')
    .run(HISTORY_HEAD_SEQUENCE_KEY, '0');
  database
    .prepare('INSERT OR IGNORE INTO authority_metadata (key, value) VALUES (?, ?)')
    .run(HISTORY_HEAD_HASH_KEY, '');
}

export class SqliteProductionStateStore implements ProductionStatePersistencePort {
  private readonly database: () => DatabaseSync;
  private readonly beforeCommit: NonNullable<SqliteProductionStateStoreOptions['beforeCommit']>;
  private readonly afterCommit: NonNullable<SqliteProductionStateStoreOptions['afterCommit']>;
  private loaded = false;
  private failed = false;
  private globalSequence = 0;
  private globalHash: string | null = null;
  private targetHeads = new Map<string, TargetHead>();

  constructor(options: SqliteProductionStateStoreOptions) {
    this.database = options.database;
    this.beforeCommit = options.beforeCommit ?? (() => undefined);
    this.afterCommit = options.afterCommit ?? (() => undefined);
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

  readHistory(): ReadonlyArray<ProductionHistoryRecord> {
    this.assertLoaded();
    return Object.freeze(
      this.historyRows(this.requiredDatabase()).map((row) => cloneHistory(this.historyRecord(row)))
    );
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
    phase: 'quarantine' | 'snapshot',
    input: ProductionSnapshotCommitInput | undefined,
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
