import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceTrustBundle } from '@overlaykit/protocol/device-trust' with {
  'resolution-mode': 'import',
};
import type {
  DeviceBootstrapSigner,
  DeviceBootstrapSigningAuthority,
} from '../services/DeviceBootstrapSnapshotIssuer';

export const DEVICE_SIGNING_SCHEMA_VERSION = 5;
export const DEVICE_SIGNING_ALGORITHM = 'Ed25519';
export const DEVICE_SIGNING_ISSUER_PREFIX = 'ed25519-sha256-';

const SIGNING_IDENTITY_ID = 1;
const MAX_SIGNED_PAYLOAD_BYTES = 1_048_576;
const SELF_TEST_BYTES = new TextEncoder().encode('overlaykit-device-signing-self-test/v1');

interface DeviceSigningIdentityRow {
  identity_id: number;
  algorithm: string;
  issuer_key_id: string;
  public_key_spki: Uint8Array;
  private_key_pkcs8: Uint8Array;
  fingerprint_sha256: string;
  created_at: number;
}

export interface GeneratedDeviceSigningKeyPair {
  readonly publicKeySpki: Uint8Array;
  readonly privateKeyPkcs8: Uint8Array;
}

export interface DeviceSigningSchemaOptions {
  readonly previousSchemaVersion: number;
  readonly generateKeyPair?: () => GeneratedDeviceSigningKeyPair;
  readonly now?: () => number;
}

export interface DeviceSigningAuthority extends DeviceBootstrapSigningAuthority {
  readonly trustBundle: DeviceTrustBundle;
  close(): void;
}

export class DeviceSigningIdentityError extends Error {
  readonly code = 'INVALID_DEVICE_SIGNING_IDENTITY' as const;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DeviceSigningIdentityError';
  }
}

function bytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new DeviceSigningIdentityError(`${label} is invalid`);
  }
  return value.slice();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function fingerprint(publicKeySpki: Uint8Array): {
  readonly issuerKeyId: string;
  readonly fingerprintSha256: string;
} {
  const digest = createHash('sha256').update(publicKeySpki).digest();
  return {
    issuerKeyId: `${DEVICE_SIGNING_ISSUER_PREFIX}${digest.toString('base64url')}`,
    fingerprintSha256: digest.toString('hex'),
  };
}

function keyPair(): GeneratedDeviceSigningKeyPair {
  const generated = generateKeyPairSync('ed25519');
  return {
    publicKeySpki: new Uint8Array(
      generated.publicKey.export({ format: 'der', type: 'spki' }),
    ),
    privateKeyPkcs8: new Uint8Array(
      generated.privateKey.export({ format: 'der', type: 'pkcs8' }),
    ),
  };
}

function keyMaterial(input: GeneratedDeviceSigningKeyPair): {
  readonly publicKeySpki: Uint8Array;
  readonly privateKeyPkcs8: Uint8Array;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly issuerKeyId: string;
  readonly fingerprintSha256: string;
} {
  const publicKeySpki = bytes(input.publicKeySpki, 'Device signing public key');
  const privateKeyPkcs8 = bytes(input.privateKeyPkcs8, 'Device signing private key');
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpki),
      format: 'der',
      type: 'spki',
    });
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8),
      format: 'der',
      type: 'pkcs8',
    });
    if (
      publicKey.asymmetricKeyType !== 'ed25519'
      || privateKey.asymmetricKeyType !== 'ed25519'
    ) {
      throw new DeviceSigningIdentityError('Device signing keys are not Ed25519');
    }
    const canonicalPublic = new Uint8Array(
      publicKey.export({ format: 'der', type: 'spki' }),
    );
    const canonicalPrivate = new Uint8Array(
      privateKey.export({ format: 'der', type: 'pkcs8' }),
    );
    const derivedPublic = new Uint8Array(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }),
    );
    if (
      !equalBytes(canonicalPublic, publicKeySpki)
      || !equalBytes(canonicalPrivate, privateKeyPkcs8)
      || !equalBytes(derivedPublic, publicKeySpki)
    ) {
      throw new DeviceSigningIdentityError(
        'Device signing key encodings or public-private binding are invalid',
      );
    }
    const selfTestSignature = sign(null, SELF_TEST_BYTES, privateKey);
    if (!verify(null, SELF_TEST_BYTES, publicKey, selfTestSignature)) {
      throw new DeviceSigningIdentityError('Device signing key self-test failed');
    }
    return {
      publicKeySpki,
      privateKeyPkcs8,
      publicKey,
      privateKey,
      ...fingerprint(publicKeySpki),
    };
  } catch (error) {
    if (error instanceof DeviceSigningIdentityError) throw error;
    throw new DeviceSigningIdentityError('Device signing key material is invalid', error);
  }
}

function createdAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DeviceSigningIdentityError('Device signing creation time is invalid');
  }
  return value as number;
}

function readIdentity(database: DatabaseSync): DeviceSigningIdentityRow | null {
  return database.prepare(`
    SELECT identity_id, algorithm, issuer_key_id, public_key_spki, private_key_pkcs8,
           fingerprint_sha256, created_at
    FROM device_signing_identity
    WHERE identity_id = ?
  `).get(SIGNING_IDENTITY_ID) as DeviceSigningIdentityRow | undefined ?? null;
}

function requireSingleIdentity(database: DatabaseSync): DeviceSigningIdentityRow {
  const rows = database.prepare('SELECT COUNT(*) AS count FROM device_signing_identity').get() as
    { count?: number } | undefined;
  if (rows?.count !== 1) {
    throw new DeviceSigningIdentityError(
      'SQLite authority must contain exactly one device signing identity',
    );
  }
  const row = readIdentity(database);
  if (!row) {
    throw new DeviceSigningIdentityError('SQLite device signing identity is missing');
  }
  return row;
}

function validateRow(row: DeviceSigningIdentityRow): ReturnType<typeof keyMaterial> & {
  readonly createdAt: number;
} {
  if (
    row.identity_id !== SIGNING_IDENTITY_ID
    || row.algorithm !== DEVICE_SIGNING_ALGORITHM
    || typeof row.issuer_key_id !== 'string'
    || typeof row.fingerprint_sha256 !== 'string'
  ) {
    throw new DeviceSigningIdentityError('SQLite device signing identity fields are invalid');
  }
  const material = keyMaterial({
    publicKeySpki: row.public_key_spki,
    privateKeyPkcs8: row.private_key_pkcs8,
  });
  if (
    row.issuer_key_id !== material.issuerKeyId
    || row.fingerprint_sha256 !== material.fingerprintSha256
  ) {
    throw new DeviceSigningIdentityError(
      'SQLite device signing identity does not match its key material',
    );
  }
  return { ...material, createdAt: createdAt(row.created_at) };
}

export function initializeDeviceSigningIdentitySchema(
  database: DatabaseSync,
  options: DeviceSigningSchemaOptions,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS device_signing_identity (
      identity_id INTEGER PRIMARY KEY NOT NULL CHECK (identity_id = 1),
      algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
      issuer_key_id TEXT NOT NULL UNIQUE,
      public_key_spki BLOB NOT NULL,
      private_key_pkcs8 BLOB NOT NULL,
      fingerprint_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS device_signing_identity_no_update
    BEFORE UPDATE ON device_signing_identity
    BEGIN
      SELECT RAISE(ABORT, 'device signing identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS device_signing_identity_no_delete
    BEFORE DELETE ON device_signing_identity
    BEGIN
      SELECT RAISE(ABORT, 'device signing identity is immutable');
    END;
  `);
  const current = readIdentity(database);
  if (!current) {
    if (options.previousSchemaVersion >= DEVICE_SIGNING_SCHEMA_VERSION) {
      throw new DeviceSigningIdentityError(
        'Initialized SQLite authority is missing its device signing identity',
      );
    }
    const generated = keyMaterial((options.generateKeyPair ?? keyPair)());
    const now = (options.now ?? Date.now)();
    createdAt(now);
    database.prepare(`
      INSERT INTO device_signing_identity (
        identity_id, algorithm, issuer_key_id, public_key_spki, private_key_pkcs8,
        fingerprint_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      SIGNING_IDENTITY_ID,
      DEVICE_SIGNING_ALGORITHM,
      generated.issuerKeyId,
      generated.publicKeySpki,
      generated.privateKeyPkcs8,
      generated.fingerprintSha256,
      now,
    );
  }
  validateRow(requireSingleIdentity(database));
}

export class SqliteDeviceSigningAuthority implements DeviceSigningAuthority {
  readonly trustBundle: DeviceTrustBundle;
  private readonly signer: DeviceBootstrapSigner;
  private closed = false;

  constructor(database: DatabaseSync) {
    const {
      issuerKeyId,
      publicKeySpki,
      fingerprintSha256,
      privateKey,
    } = validateRow(requireSingleIdentity(database));
    this.trustBundle = Object.freeze({
      schemaVersion: 'overlaykit-device-trust-bundle/v1',
      algorithm: DEVICE_SIGNING_ALGORITHM,
      issuerKeyId,
      publicKeySpkiBase64Url: Buffer.from(publicKeySpki).toString('base64url'),
      fingerprintSha256,
    });
    this.signer = Object.freeze({
      issuerKeyId,
      sign: (payloadBytes: Uint8Array): string => {
        if (this.closed) {
          throw new DeviceSigningIdentityError('Device signing authority is closed');
        }
        if (
          !(payloadBytes instanceof Uint8Array)
          || payloadBytes.byteLength === 0
          || payloadBytes.byteLength > MAX_SIGNED_PAYLOAD_BYTES
        ) {
          throw new DeviceSigningIdentityError('Device signing payload is invalid');
        }
        return sign(null, payloadBytes.slice(), privateKey).toString('base64url');
      },
    });
  }

  current(): DeviceBootstrapSigner {
    if (this.closed) {
      throw new DeviceSigningIdentityError('Device signing authority is closed');
    }
    return this.signer;
  }

  close(): void {
    this.closed = true;
  }
}
