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

export interface DeviceCredentialFileDocument {
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

export function parseDeviceCredentialFileDocument(raw: string): DeviceCredentialFileDocument {
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
