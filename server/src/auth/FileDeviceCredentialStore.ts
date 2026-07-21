import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import deviceCredentialStoreSchema from '../validation/schemas/device-credentials.schema.json';

export const DEVICE_CREDENTIAL_FILE_SCHEMA_VERSION = 1 as const;

type DeviceCredentialTarget = 'preview' | 'program';
type DeviceCredentialScope =
  'feedback:read' | 'component.visibility:write' | 'cue:execute' | 'production:take';

export interface StoredDeviceCredentialRecord {
  readonly credentialId: string;
  readonly label: string;
  readonly showId: string;
  readonly targets: ReadonlyArray<DeviceCredentialTarget>;
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

interface DeviceCredentialFileDocument {
  readonly schemaVersion: typeof DEVICE_CREDENTIAL_FILE_SCHEMA_VERSION;
  readonly records: ReadonlyArray<StoredDeviceCredentialRecord>;
}

export type DeviceCredentialStoreErrorCode =
  'INVALID_DEVICE_CREDENTIAL_STORE' | 'DEVICE_CREDENTIAL_STORE_IO';

export class DeviceCredentialStoreError extends Error {
  constructor(
    public readonly code: DeviceCredentialStoreErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DeviceCredentialStoreError';
  }
}

const validateDocument = new Ajv({ allErrors: true, strict: true }).compile(
  deviceCredentialStoreSchema
) as ValidateFunction<DeviceCredentialFileDocument>;

function defaultDeviceCredentialFile(): string {
  const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return process.env.DEVICE_CREDENTIAL_FILE || path.join(dataDirectory, 'device-credentials.json');
}

function cloneRecord(record: StoredDeviceCredentialRecord): StoredDeviceCredentialRecord {
  return {
    ...record,
    targets: [...record.targets],
    controlIds: [...record.controlIds],
    scopes: [...record.scopes],
  };
}

function isTrimmed(value: string): boolean {
  return value === value.trim();
}

function semanticErrors(document: DeviceCredentialFileDocument): string[] {
  const errors: string[] = [];
  const credentialIds = new Set<string>();
  for (const record of document.records) {
    if (credentialIds.has(record.credentialId)) {
      errors.push(`duplicate credentialId ${record.credentialId}`);
    }
    credentialIds.add(record.credentialId);
    if (!isTrimmed(record.label) || !isTrimmed(record.showId) || !isTrimmed(record.issuedBy)) {
      errors.push(`untrimmed metadata for ${record.credentialId}`);
    }
    if (record.controlIds.some((controlId) => !isTrimmed(controlId))) {
      errors.push(`untrimmed controlId for ${record.credentialId}`);
    }
    if (record.updatedAt < record.issuedAt || record.expiresAt <= record.issuedAt) {
      errors.push(`invalid lifecycle timestamps for ${record.credentialId}`);
    }
    if (
      record.revokedAt !== null &&
      (record.revokedAt < record.issuedAt || record.revokedAt > record.updatedAt)
    ) {
      errors.push(`invalid revocation timestamp for ${record.credentialId}`);
    }
  }
  return errors;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function parseDocument(raw: string): DeviceCredentialFileDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new DeviceCredentialStoreError(
      'INVALID_DEVICE_CREDENTIAL_STORE',
      'Device credential store is not valid JSON',
      error
    );
  }
  if (!validateDocument(parsed)) {
    throw new DeviceCredentialStoreError(
      'INVALID_DEVICE_CREDENTIAL_STORE',
      `Device credential store does not match schema: ${formatAjvErrors(validateDocument.errors)}`
    );
  }
  const errors = semanticErrors(parsed);
  if (errors.length > 0) {
    throw new DeviceCredentialStoreError(
      'INVALID_DEVICE_CREDENTIAL_STORE',
      `Device credential store violates lifecycle invariants: ${errors.join('; ')}`
    );
  }
  return {
    schemaVersion: DEVICE_CREDENTIAL_FILE_SCHEMA_VERSION,
    records: parsed.records.map(cloneRecord),
  };
}

function documentFor(
  records: ReadonlyMap<string, StoredDeviceCredentialRecord>
): DeviceCredentialFileDocument {
  return {
    schemaVersion: DEVICE_CREDENTIAL_FILE_SCHEMA_VERSION,
    records: [...records.values()]
      .sort((left, right) => left.credentialId.localeCompare(right.credentialId))
      .map(cloneRecord),
  };
}

export class FileDeviceCredentialStore {
  private records: Map<string, StoredDeviceCredentialRecord> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultDeviceCredentialFile()) {}

  async init(): Promise<void> {
    await this.exclusive(async () => {
      await this.loadOnce();
    });
  }

  async get(credentialId: string): Promise<StoredDeviceCredentialRecord | null> {
    return this.exclusive(async () => {
      const records = await this.loadOnce();
      const record = records.get(credentialId);
      return record ? cloneRecord(record) : null;
    });
  }

  async create(record: StoredDeviceCredentialRecord): Promise<boolean> {
    return this.exclusive(async () => {
      const records = await this.loadOnce();
      this.assertRecord(record);
      if (records.has(record.credentialId)) return false;
      const next = new Map(records);
      next.set(record.credentialId, cloneRecord(record));
      await this.persist(next);
      this.records = next;
      return true;
    });
  }

  async replace(
    record: StoredDeviceCredentialRecord,
    expectedGeneration: number
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const records = await this.loadOnce();
      this.assertRecord(record);
      const current = records.get(record.credentialId);
      if (!current || current.generation !== expectedGeneration) return false;
      const next = new Map(records);
      next.set(record.credentialId, cloneRecord(record));
      await this.persist(next);
      this.records = next;
      return true;
    });
  }

  protected async replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
    await fs.rename(temporaryPath, targetPath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async loadOnce(): Promise<Map<string, StoredDeviceCredentialRecord>> {
    if (this.records) return this.records;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const document = parseDocument(raw);
      this.records = new Map(
        document.records.map((record) => [record.credentialId, cloneRecord(record)])
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = new Map();
      } else if (error instanceof DeviceCredentialStoreError) {
        throw error;
      } else {
        throw new DeviceCredentialStoreError(
          'DEVICE_CREDENTIAL_STORE_IO',
          'Failed to load device credential store',
          error
        );
      }
    }
    return this.records;
  }

  private assertRecord(record: StoredDeviceCredentialRecord): void {
    parseDocument(
      JSON.stringify({
        schemaVersion: DEVICE_CREDENTIAL_FILE_SCHEMA_VERSION,
        records: [record],
      })
    );
  }

  private async persist(records: ReadonlyMap<string, StoredDeviceCredentialRecord>): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(documentFor(records), null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.replaceFile(temporaryPath, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      if (error instanceof DeviceCredentialStoreError) throw error;
      throw new DeviceCredentialStoreError(
        'DEVICE_CREDENTIAL_STORE_IO',
        'Failed to persist device credential store',
        error
      );
    }
  }
}
