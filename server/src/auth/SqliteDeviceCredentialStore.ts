import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { StoredDeviceCredential } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import {
  DeviceCredentialStoreError,
  parseDeviceCredentialFileDocument,
} from './LegacyDeviceCredentialFile';
import {
  initializeDeviceTransitionLedgerSchema,
  SqliteDeviceTransitionLedger,
  type SqliteDeviceTransitionLedgerOptions,
} from '../services/SqliteDeviceTransitionLedger';
import {
  initializeProductionStateSchema,
  SqliteProductionStateStore,
  type SqliteProductionStateStoreOptions,
} from '../services/SqliteProductionStateStore';

const SQLITE_SCHEMA_VERSION = 4;
const MIGRATION_STATE_KEY = 'legacy_json_migration';
const MIGRATION_NONE = 'none';
const MIGRATION_IMPORTED_PREFIX = 'imported:';

type SqliteValue = string | number | bigint | null;

interface CredentialRow {
  credential_id: string;
  label: string;
  show_id: string;
  targets: string;
  control_ids: string;
  scopes: string;
  generation: number;
  sealed_secret: string;
  issued_by: string;
  issued_at: number;
  updated_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function dataDirectory(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function defaultDatabasePath(): string {
  return (
    process.env.DEVICE_CREDENTIAL_DB || path.join(dataDirectory(), 'device-credentials.sqlite')
  );
}

function defaultLegacyFilePath(databasePath: string): string {
  return (
    process.env.DEVICE_CREDENTIAL_FILE ||
    path.join(path.dirname(databasePath), 'device-credentials.json')
  );
}

function cloneRecord(record: StoredDeviceCredential): StoredDeviceCredential {
  return {
    ...record,
    targets: [...record.targets],
    controlIds: [...record.controlIds],
    scopes: [...record.scopes],
  };
}

function assertRecord(record: StoredDeviceCredential): StoredDeviceCredential {
  const document = parseDeviceCredentialFileDocument(
    JSON.stringify({
      schemaVersion: 1,
      records: [record],
    })
  );
  return document.records[0];
}

function rowRecord(row: CredentialRow): StoredDeviceCredential {
  let record: StoredDeviceCredential;
  try {
    record = {
      credentialId: row.credential_id,
      label: row.label,
      showId: row.show_id,
      targets: JSON.parse(row.targets) as StoredDeviceCredential['targets'],
      controlIds: JSON.parse(row.control_ids) as StoredDeviceCredential['controlIds'],
      scopes: JSON.parse(row.scopes) as StoredDeviceCredential['scopes'],
      generation: row.generation,
      sealedSecret: row.sealed_secret,
      issuedBy: row.issued_by,
      issuedAt: row.issued_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  } catch (error) {
    throw new DeviceCredentialStoreError(
      'INVALID_DEVICE_CREDENTIAL_STORE',
      'SQLite device credential authority contains malformed structured data',
      error
    );
  }
  return assertRecord(record);
}

function recordValues(record: StoredDeviceCredential): SqliteValue[] {
  return [
    record.credentialId,
    record.label,
    record.showId,
    JSON.stringify(record.targets),
    JSON.stringify(record.controlIds),
    JSON.stringify(record.scopes),
    record.generation,
    record.sealedSecret,
    record.issuedBy,
    record.issuedAt,
    record.updatedAt,
    record.expiresAt,
    record.revokedAt,
  ];
}

function migrationHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sqliteCauseCode(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

function storeFailure(message: string, error: unknown): DeviceCredentialStoreError {
  if (error instanceof DeviceCredentialStoreError) return error;
  const code = sqliteCauseCode(error);
  const errorCode = (error as { errcode?: unknown })?.errcode;
  const suffix =
    code === 'SQLITE_BUSY' || errorCode === 5 ? ' (exclusive authority is unavailable)' : '';
  return new DeviceCredentialStoreError('DEVICE_CREDENTIAL_STORE_IO', `${message}${suffix}`, error);
}

export interface SqliteDeviceCredentialStoreOptions {
  readonly databasePath?: string;
  readonly legacyFilePath?: string;
  readonly openDatabase?: (databasePath: string) => DatabaseSync;
  readonly archiveLegacyFile?: (source: string, target: string) => Promise<void>;
  readonly beforeCommit?: (phase: 'initialize' | 'create' | 'replace') => void;
}

export class SqliteDeviceCredentialStore {
  readonly databasePath: string;
  readonly legacyFilePath: string;
  readonly legacyArchivePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private readonly archiveLegacyFile: (source: string, target: string) => Promise<void>;
  private readonly beforeCommit: (phase: 'initialize' | 'create' | 'replace') => void;
  private database: DatabaseSync | null = null;
  private selectStatement: StatementSync | null = null;
  private insertStatement: StatementSync | null = null;
  private replaceStatement: StatementSync | null = null;
  private productionStateStore: SqliteProductionStateStore | null = null;

  constructor(options: SqliteDeviceCredentialStoreOptions = {}) {
    this.databasePath = path.resolve(options.databasePath ?? defaultDatabasePath());
    this.legacyFilePath = path.resolve(
      options.legacyFilePath ?? defaultLegacyFilePath(this.databasePath)
    );
    this.legacyArchivePath = `${this.legacyFilePath}.migrated`;
    this.openDatabase =
      options.openDatabase ?? ((databasePath) => new DatabaseSync(databasePath, { timeout: 0 }));
    this.archiveLegacyFile = options.archiveLegacyFile ?? fs.rename;
    this.beforeCommit = options.beforeCommit ?? (() => undefined);
  }

  async init(): Promise<void> {
    if (this.database) return;
    let database: DatabaseSync | null = null;
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      const legacyRaw = await readOptional(this.legacyFilePath);
      database = this.openDatabase(this.databasePath);
      this.configure(database);
      this.initializeSchema(database, legacyRaw);
      this.assertIntegrity(database);
      this.database = database;
      this.prepareStatements(database);
      if (legacyRaw !== null) await this.archiveCommittedLegacy(database, legacyRaw);
      await fs.chmod(this.databasePath, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (process.platform !== 'win32') throw error;
      });
    } catch (error) {
      this.selectStatement = null;
      this.insertStatement = null;
      this.replaceStatement = null;
      this.database = null;
      try {
        database?.close();
      } catch {
        // The initialization error remains authoritative.
      }
      throw storeFailure('Failed to initialize SQLite device credential authority', error);
    }
  }

  async get(credentialId: string): Promise<StoredDeviceCredential | null> {
    const row = this.requiredStatement(this.selectStatement).get(credentialId) as
      CredentialRow | undefined;
    return row ? cloneRecord(rowRecord(row)) : null;
  }

  async create(recordInput: StoredDeviceCredential): Promise<boolean> {
    const record = assertRecord(recordInput);
    return this.writeTransaction('create', () => {
      const result = this.requiredStatement(this.insertStatement).run(...recordValues(record));
      return Number(result.changes) === 1;
    });
  }

  async replace(recordInput: StoredDeviceCredential, expectedGeneration: number): Promise<boolean> {
    const record = assertRecord(recordInput);
    return this.writeTransaction('replace', () => {
      const values = recordValues(record);
      const result = this.requiredStatement(this.replaceStatement).run(
        ...values.slice(1),
        record.credentialId,
        expectedGeneration
      );
      return Number(result.changes) === 1;
    });
  }

  createTransitionLedger(
    options: Omit<SqliteDeviceTransitionLedgerOptions, 'database'> = {}
  ): SqliteDeviceTransitionLedger {
    return new SqliteDeviceTransitionLedger({
      ...options,
      database: () => this.requiredDatabase(),
    });
  }

  createProductionStateStore(
    options: Omit<SqliteProductionStateStoreOptions, 'database'> = {}
  ): SqliteProductionStateStore {
    if (this.productionStateStore) {
      throw new DeviceCredentialStoreError(
        'INVALID_DEVICE_CREDENTIAL_STORE',
        'SQLite production authority has already been created for this connection'
      );
    }
    this.productionStateStore = new SqliteProductionStateStore({
      ...options,
      database: () => this.requiredDatabase(),
    });
    return this.productionStateStore;
  }

  close(): void {
    const database = this.database;
    this.database = null;
    this.selectStatement = null;
    this.insertStatement = null;
    this.replaceStatement = null;
    this.productionStateStore = null;
    database?.close();
  }

  private configure(database: DatabaseSync): void {
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA secure_delete = ON');
    database.exec('PRAGMA locking_mode = EXCLUSIVE');
    database.exec('BEGIN EXCLUSIVE; COMMIT');
  }

  private assertIntegrity(database: DatabaseSync): void {
    const rows = database.prepare('PRAGMA quick_check').all() as unknown as Array<{
      quick_check?: string;
    }>;
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
      throw new DeviceCredentialStoreError(
        'INVALID_DEVICE_CREDENTIAL_STORE',
        'SQLite authority failed its integrity check'
      );
    }
  }

  private initializeSchema(database: DatabaseSync, legacyRaw: string | null): void {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS authority_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS device_credentials (
          credential_id TEXT PRIMARY KEY NOT NULL,
          label TEXT NOT NULL,
          show_id TEXT NOT NULL,
          targets TEXT NOT NULL,
          control_ids TEXT NOT NULL,
          scopes TEXT NOT NULL,
          generation INTEGER NOT NULL,
          sealed_secret TEXT NOT NULL,
          issued_by TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        ) STRICT;
      `);
      initializeDeviceTransitionLedgerSchema(database);
      initializeProductionStateSchema(database);
      const userVersion = database.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      if ((userVersion?.user_version ?? 0) > SQLITE_SCHEMA_VERSION) {
        throw new DeviceCredentialStoreError(
          'INVALID_DEVICE_CREDENTIAL_STORE',
          'SQLite device credential schema is newer than this host'
        );
      }
      database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);

      const current = database
        .prepare('SELECT value FROM authority_metadata WHERE key = ?')
        .get(MIGRATION_STATE_KEY) as { value?: string } | undefined;
      if (!current) {
        const count = database.prepare('SELECT COUNT(*) AS count FROM device_credentials').get() as
          { count?: number } | undefined;
        if ((count?.count ?? 0) !== 0) {
          throw new DeviceCredentialStoreError(
            'INVALID_DEVICE_CREDENTIAL_STORE',
            'SQLite authority has records without initialization evidence'
          );
        }
        if (legacyRaw === null) {
          database
            .prepare('INSERT INTO authority_metadata (key, value) VALUES (?, ?)')
            .run(MIGRATION_STATE_KEY, MIGRATION_NONE);
        } else {
          const document = parseDeviceCredentialFileDocument(legacyRaw);
          const insert = this.insertStatementFor(database);
          for (const record of document.records) insert.run(...recordValues(record));
          database
            .prepare('INSERT INTO authority_metadata (key, value) VALUES (?, ?)')
            .run(MIGRATION_STATE_KEY, `${MIGRATION_IMPORTED_PREFIX}${migrationHash(legacyRaw)}`);
        }
      } else {
        this.assertLegacyState(current.value ?? '', legacyRaw);
      }
      this.beforeCommit('initialize');
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original initialization failure.
      }
      throw error;
    }
  }

  private assertLegacyState(state: string, legacyRaw: string | null): void {
    if (legacyRaw === null) {
      if (state === MIGRATION_NONE || state.startsWith(MIGRATION_IMPORTED_PREFIX)) return;
    } else if (state === `${MIGRATION_IMPORTED_PREFIX}${migrationHash(legacyRaw)}`) {
      return;
    }
    throw new DeviceCredentialStoreError(
      'INVALID_DEVICE_CREDENTIAL_STORE',
      'Legacy credential JSON conflicts with initialized SQLite authority'
    );
  }

  private async archiveCommittedLegacy(database: DatabaseSync, legacyRaw: string): Promise<void> {
    const state = database
      .prepare('SELECT value FROM authority_metadata WHERE key = ?')
      .get(MIGRATION_STATE_KEY) as { value?: string } | undefined;
    if (state?.value !== `${MIGRATION_IMPORTED_PREFIX}${migrationHash(legacyRaw)}`) {
      throw new DeviceCredentialStoreError(
        'INVALID_DEVICE_CREDENTIAL_STORE',
        'Legacy credential JSON was not committed into SQLite authority'
      );
    }
    await this.archiveLegacyFile(this.legacyFilePath, this.legacyArchivePath);
  }

  private prepareStatements(database: DatabaseSync): void {
    this.selectStatement = database.prepare(`
      SELECT credential_id, label, show_id, targets, control_ids, scopes, generation,
             sealed_secret, issued_by, issued_at, updated_at, expires_at, revoked_at
      FROM device_credentials
      WHERE credential_id = ?
    `);
    this.insertStatement = this.insertStatementFor(database);
    this.replaceStatement = database.prepare(`
      UPDATE device_credentials
      SET label = ?, show_id = ?, targets = ?, control_ids = ?, scopes = ?, generation = ?,
          sealed_secret = ?, issued_by = ?, issued_at = ?, updated_at = ?, expires_at = ?,
          revoked_at = ?
      WHERE credential_id = ? AND generation = ?
    `);
  }

  private insertStatementFor(database: DatabaseSync): StatementSync {
    return database.prepare(`
      INSERT OR IGNORE INTO device_credentials (
        credential_id, label, show_id, targets, control_ids, scopes, generation,
        sealed_secret, issued_by, issued_at, updated_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private requiredStatement(statement: StatementSync | null): StatementSync {
    if (!this.database || !statement) {
      throw new DeviceCredentialStoreError(
        'DEVICE_CREDENTIAL_STORE_IO',
        'SQLite device credential authority is not initialized'
      );
    }
    return statement;
  }

  private requiredDatabase(): DatabaseSync {
    if (!this.database) {
      throw new DeviceCredentialStoreError(
        'DEVICE_CREDENTIAL_STORE_IO',
        'SQLite device credential authority is not initialized'
      );
    }
    return this.database;
  }

  private writeTransaction<T>(phase: 'create' | 'replace', operation: () => T): T {
    const database = this.database;
    if (!database) {
      throw new DeviceCredentialStoreError(
        'DEVICE_CREDENTIAL_STORE_IO',
        'SQLite device credential authority is not initialized'
      );
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.beforeCommit(phase);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original write failure.
      }
      throw storeFailure('Failed to commit SQLite device credential mutation', error);
    }
  }
}
