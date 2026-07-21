import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';

const DEVICE_SECRET_BYTES = 32;
const DEVICE_SECRET_LENGTH = 43;
const DEVICE_TOKEN_PATTERN = /^ok_device_[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{43}$/;
const VERIFIER_PREFIX = 'okdv1$sha256$';
const VERIFIER_PATTERN = /^okdv1\$sha256\$([A-Za-z0-9_-]{43})$/;
const VERIFIER_DOMAIN = Buffer.from('overlaykit:device-credential:v1\0', 'utf8');

export type DeviceCredentialCryptoErrorCode =
  | 'DEVICE_CREDENTIAL_ENTROPY_FAILURE'
  | 'DEVICE_CREDENTIAL_DIGEST_FAILURE'
  | 'INVALID_DEVICE_CREDENTIAL_TOKEN';

export class DeviceCredentialCryptoError extends Error {
  constructor(
    public readonly code: DeviceCredentialCryptoErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DeviceCredentialCryptoError';
  }
}

export interface DeviceCredentialCryptoPrimitives {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly randomUUID: () => string;
  readonly sha256: (value: Uint8Array) => Uint8Array;
  readonly timingSafeEqual: (left: Uint8Array, right: Uint8Array) => boolean;
}

export interface DeviceCredentialCryptoOptions {
  readonly now?: () => number;
  readonly primitives?: Partial<DeviceCredentialCryptoPrimitives>;
}

export interface DeviceCredentialLifecycleCryptoOptions {
  readonly now: () => number;
  readonly generateCredentialId: () => string;
  readonly generateSecret: () => string;
  readonly secretCodec: {
    seal(token: string): string;
    matches(token: string, sealedSecret: string): boolean;
  };
}

const DEFAULT_PRIMITIVES: DeviceCredentialCryptoPrimitives = {
  randomBytes: (size) => randomBytes(size),
  randomUUID: () => randomUUID(),
  sha256: (value) => createHash('sha256').update(value).digest(),
  timingSafeEqual: (left, right) => timingSafeEqual(Buffer.from(left), Buffer.from(right)),
};

function digestToken(
  token: string,
  primitives: DeviceCredentialCryptoPrimitives,
): Buffer {
  if (!DEVICE_TOKEN_PATTERN.test(token)) {
    throw new DeviceCredentialCryptoError(
      'INVALID_DEVICE_CREDENTIAL_TOKEN',
      'Device credential token is invalid',
    );
  }

  let digest: Uint8Array;
  try {
    digest = primitives.sha256(Buffer.concat([VERIFIER_DOMAIN, Buffer.from(token, 'utf8')]));
  } catch (error) {
    throw new DeviceCredentialCryptoError(
      'DEVICE_CREDENTIAL_DIGEST_FAILURE',
      'Device credential digest failed',
      error,
    );
  }
  if (!(digest instanceof Uint8Array) || digest.byteLength !== DEVICE_SECRET_BYTES) {
    throw new DeviceCredentialCryptoError(
      'DEVICE_CREDENTIAL_DIGEST_FAILURE',
      'Device credential digest has an invalid length',
    );
  }
  return Buffer.from(digest);
}

function parseVerifier(sealedSecret: string): Buffer | null {
  const match = VERIFIER_PATTERN.exec(sealedSecret);
  if (!match) return null;

  const digest = Buffer.from(match[1], 'base64url');
  if (
    digest.byteLength !== DEVICE_SECRET_BYTES
    || digest.toString('base64url') !== match[1]
  ) {
    return null;
  }
  return digest;
}

export function createDeviceCredentialCryptoOptions(
  options: DeviceCredentialCryptoOptions = {},
): DeviceCredentialLifecycleCryptoOptions {
  const primitives: DeviceCredentialCryptoPrimitives = {
    ...DEFAULT_PRIMITIVES,
    ...options.primitives,
  };

  return {
    now: options.now ?? Date.now,
    generateCredentialId: () => {
      try {
        return primitives.randomUUID();
      } catch (error) {
        throw new DeviceCredentialCryptoError(
          'DEVICE_CREDENTIAL_ENTROPY_FAILURE',
          'Device credential identifier generation failed',
          error,
        );
      }
    },
    generateSecret: () => {
      let secret: Uint8Array;
      try {
        secret = primitives.randomBytes(DEVICE_SECRET_BYTES);
      } catch (error) {
        throw new DeviceCredentialCryptoError(
          'DEVICE_CREDENTIAL_ENTROPY_FAILURE',
          'Device credential secret generation failed',
          error,
        );
      }
      if (!(secret instanceof Uint8Array) || secret.byteLength !== DEVICE_SECRET_BYTES) {
        throw new DeviceCredentialCryptoError(
          'DEVICE_CREDENTIAL_ENTROPY_FAILURE',
          'Device credential entropy has an invalid length',
        );
      }
      const encoded = Buffer.from(secret).toString('base64url');
      if (encoded.length !== DEVICE_SECRET_LENGTH) {
        throw new DeviceCredentialCryptoError(
          'DEVICE_CREDENTIAL_ENTROPY_FAILURE',
          'Device credential entropy has an invalid encoding',
        );
      }
      return encoded;
    },
    secretCodec: {
      seal: (token) => `${VERIFIER_PREFIX}${digestToken(token, primitives).toString('base64url')}`,
      matches: (token, sealedSecret) => {
        if (typeof token !== 'string' || typeof sealedSecret !== 'string') return false;
        const stored = parseVerifier(sealedSecret);
        if (!stored) return false;

        let candidate: Buffer;
        try {
          candidate = digestToken(token, primitives);
        } catch {
          return false;
        }
        try {
          return primitives.timingSafeEqual(candidate, stored);
        } catch {
          return false;
        }
      },
    },
  };
}
