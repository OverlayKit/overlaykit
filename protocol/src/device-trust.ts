export const DEVICE_TRUST_BUNDLE_VERSION =
  'overlaykit-device-trust-bundle/v1' as const;
export const DEVICE_TRUST_ALGORITHM = 'Ed25519' as const;
export const DEVICE_TRUST_ISSUER_PREFIX = 'ed25519-sha256-' as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SPKI_BYTES = 256;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_SIGNED_PAYLOAD_BYTES = 1_048_576;

export interface DeviceTrustBundle {
  readonly schemaVersion: typeof DEVICE_TRUST_BUNDLE_VERSION;
  readonly algorithm: typeof DEVICE_TRUST_ALGORITHM;
  readonly issuerKeyId: string;
  readonly publicKeySpkiBase64Url: string;
  readonly fingerprintSha256: string;
}

export interface DeviceTrustIdentity {
  readonly issuerKeyId: string;
  readonly fingerprintSha256: string;
}

export type DeviceTrustSignatureVerifier = (
  payloadBytes: Uint8Array,
  signature: string,
  issuerKeyId: string,
) => Promise<boolean>;

export class DeviceTrustBundleError extends Error {
  readonly code = 'INVALID_DEVICE_TRUST_BUNDLE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceTrustBundleError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codeUnitCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function subtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new DeviceTrustBundleError('Web Crypto is unavailable');
  }
  return globalThis.crypto.subtle;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(
  value: unknown,
  label: string,
  maximumBytes: number,
): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4
    || !BASE64URL_PATTERN.test(value)
  ) {
    throw new DeviceTrustBundleError(`${label} encoding is invalid`);
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(paddingLength);
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new DeviceTrustBundleError(`${label} encoding is invalid`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength === 0
    || bytes.byteLength > maximumBytes
    || encodeBase64Url(bytes) !== value
  ) {
    throw new DeviceTrustBundleError(`${label} bytes are invalid`);
  }
  return bytes;
}

async function digestSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes).buffer;
  try {
    return new Uint8Array(await subtleCrypto().digest('SHA-256', input));
  } catch {
    throw new DeviceTrustBundleError('SHA-256 derivation failed');
  }
}

async function importEd25519PublicKey(publicKeySpki: Uint8Array): Promise<CryptoKey> {
  if (
    !(publicKeySpki instanceof Uint8Array)
    || publicKeySpki.byteLength === 0
    || publicKeySpki.byteLength > MAX_SPKI_BYTES
  ) {
    throw new DeviceTrustBundleError('Ed25519 public key bytes are invalid');
  }
  try {
    const key = await subtleCrypto().importKey(
      'spki',
      new Uint8Array(publicKeySpki).buffer,
      { name: DEVICE_TRUST_ALGORITHM },
      false,
      ['verify'],
    );
    if (key.algorithm.name !== DEVICE_TRUST_ALGORITHM || key.type !== 'public') {
      throw new DeviceTrustBundleError('Public key is not Ed25519');
    }
    return key;
  } catch (error) {
    if (error instanceof DeviceTrustBundleError) throw error;
    throw new DeviceTrustBundleError('Ed25519 public key is invalid');
  }
}

export async function deriveDeviceTrustIdentity(
  publicKeySpki: Uint8Array,
): Promise<DeviceTrustIdentity> {
  await importEd25519PublicKey(publicKeySpki);
  const digest = await digestSha256(publicKeySpki);
  const fingerprintSha256 = [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return Object.freeze({
    issuerKeyId: `${DEVICE_TRUST_ISSUER_PREFIX}${encodeBase64Url(digest)}`,
    fingerprintSha256,
  });
}

export async function buildDeviceTrustBundle(
  publicKeySpki: Uint8Array,
): Promise<DeviceTrustBundle> {
  const keyBytes = publicKeySpki.slice();
  const identity = await deriveDeviceTrustIdentity(keyBytes);
  return Object.freeze({
    schemaVersion: DEVICE_TRUST_BUNDLE_VERSION,
    algorithm: DEVICE_TRUST_ALGORITHM,
    issuerKeyId: identity.issuerKeyId,
    publicKeySpkiBase64Url: encodeBase64Url(keyBytes),
    fingerprintSha256: identity.fingerprintSha256,
  });
}

export async function parseDeviceTrustBundle(
  value: unknown,
): Promise<{
  readonly bundle: DeviceTrustBundle;
  readonly publicKeySpki: Uint8Array;
}> {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'algorithm',
      'issuerKeyId',
      'publicKeySpkiBase64Url',
      'fingerprintSha256',
    ])
    || value.schemaVersion !== DEVICE_TRUST_BUNDLE_VERSION
    || value.algorithm !== DEVICE_TRUST_ALGORITHM
    || typeof value.issuerKeyId !== 'string'
    || !value.issuerKeyId.startsWith(DEVICE_TRUST_ISSUER_PREFIX)
    || typeof value.fingerprintSha256 !== 'string'
    || !SHA256_PATTERN.test(value.fingerprintSha256)
  ) {
    throw new DeviceTrustBundleError('Device Trust Bundle is invalid');
  }
  const publicKeySpki = decodeBase64Url(
    value.publicKeySpkiBase64Url,
    'Ed25519 public key',
    MAX_SPKI_BYTES,
  );
  const identity = await deriveDeviceTrustIdentity(publicKeySpki);
  if (
    identity.issuerKeyId !== value.issuerKeyId
    || identity.fingerprintSha256 !== value.fingerprintSha256
  ) {
    throw new DeviceTrustBundleError('Device Trust Bundle identity does not match its key');
  }
  const bundle = Object.freeze({
    schemaVersion: DEVICE_TRUST_BUNDLE_VERSION,
    algorithm: DEVICE_TRUST_ALGORITHM,
    issuerKeyId: value.issuerKeyId,
    publicKeySpkiBase64Url: value.publicKeySpkiBase64Url as string,
    fingerprintSha256: value.fingerprintSha256,
  });
  return Object.freeze({ bundle, publicKeySpki: publicKeySpki.slice() });
}

export async function createDeviceTrustSignatureVerifier(
  value: unknown,
): Promise<DeviceTrustSignatureVerifier> {
  const parsed = await parseDeviceTrustBundle(value);
  const publicKey = await importEd25519PublicKey(parsed.publicKeySpki);
  const pinnedIssuerKeyId = parsed.bundle.issuerKeyId;
  return async (
    payloadBytes: Uint8Array,
    signature: string,
    issuerKeyId: string,
  ): Promise<boolean> => {
    if (
      issuerKeyId !== pinnedIssuerKeyId
      || !(payloadBytes instanceof Uint8Array)
      || payloadBytes.byteLength === 0
      || payloadBytes.byteLength > MAX_SIGNED_PAYLOAD_BYTES
    ) {
      return false;
    }
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = decodeBase64Url(
        signature,
        'Ed25519 signature',
        ED25519_SIGNATURE_BYTES,
      );
    } catch {
      return false;
    }
    if (signatureBytes.byteLength !== ED25519_SIGNATURE_BYTES) return false;
    try {
      return await subtleCrypto().verify(
        DEVICE_TRUST_ALGORITHM,
        publicKey,
        new Uint8Array(signatureBytes).buffer,
        new Uint8Array(payloadBytes).buffer,
      );
    } catch {
      return false;
    }
  };
}
