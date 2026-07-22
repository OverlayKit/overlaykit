import { createHash, timingSafeEqual } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceCredentialLifecycle,
  MemoryDeviceCredentialStore,
  type DeviceCredentialIssueInput,
} from '@overlaykit/protocol/device-credential';
import {
  createDeviceCredentialCryptoOptions,
  type DeviceCredentialCryptoPrimitives,
} from '../../src/auth/DeviceCredentialCrypto';

const OWNER = { principalId: 'owner-1', roles: ['owner'] };
const INPUT: DeviceCredentialIssueInput = {
  label: 'Production desk',
  showId: 'show-1',
  targets: ['program'],
  controlIds: ['lower-third.visibility'],
  scopes: ['feedback:read', 'component.visibility:write'],
  expiresAt: 10_000,
};
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000001';
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);

function testPrimitives(
  overrides: Partial<DeviceCredentialCryptoPrimitives> = {},
): DeviceCredentialCryptoPrimitives {
  return {
    randomBytes: () => SECRET_BYTES,
    randomUUID: () => CREDENTIAL_ID,
    sha256: (value) => createHash('sha256').update(value).digest(),
    timingSafeEqual: (left, right) => timingSafeEqual(Buffer.from(left), Buffer.from(right)),
    ...overrides,
  };
}

function token(secret = Buffer.from(SECRET_BYTES).toString('base64url')): string {
  return `ok_device_${CREDENTIAL_ID}.${secret}`;
}

describe('device credential production crypto', () => {
  it('requests 32 random bytes and hashes the complete token in a device-specific domain', () => {
    const requestedSizes: number[] = [];
    let hashedValue: Uint8Array | null = null;
    const options = createDeviceCredentialCryptoOptions({
      now: () => 1_000,
      primitives: testPrimitives({
        randomBytes: (size) => {
          requestedSizes.push(size);
          return SECRET_BYTES;
        },
        sha256: (value) => {
          hashedValue = value;
          return createHash('sha256').update(value).digest();
        },
      }),
    });

    const secret = options.generateSecret();
    const bearer = token(secret);
    const verifier = options.secretCodec.seal(bearer);

    expect(requestedSizes).toEqual([32]);
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.generateCredentialId()).toBe(CREDENTIAL_ID);
    expect(verifier).toMatch(/^okdv1\$sha256\$[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(hashedValue!).toString('utf8')).toBe(
      `overlaykit:device-credential:v1\0${bearer}`,
    );
    expect(verifier).not.toContain(bearer);
    expect(verifier).not.toContain(secret);
  });

  it('verifies the exact bearer with the production Node.js primitives', () => {
    const options = createDeviceCredentialCryptoOptions({ now: () => 1_000 });
    const secret = options.generateSecret();
    const bearer = `ok_device_${options.generateCredentialId()}.${secret}`;
    const verifier = options.secretCodec.seal(bearer);

    expect(options.secretCodec.matches(bearer, verifier)).toBe(true);
    expect(options.secretCodec.matches(`${bearer.slice(0, -1)}x`, verifier)).toBe(false);
  });

  it('rejects token, digest, version, algorithm, and verifier-format substitutions', () => {
    const compare = vi.fn((left: Uint8Array, right: Uint8Array) => (
      timingSafeEqual(Buffer.from(left), Buffer.from(right))
    ));
    const options = createDeviceCredentialCryptoOptions({
      primitives: testPrimitives({ timingSafeEqual: compare }),
    });
    const bearer = token();
    const verifier = options.secretCodec.seal(bearer);
    const digest = verifier.slice(verifier.lastIndexOf('$') + 1);
    const otherDigest = `${digest.slice(0, -1)}${digest.endsWith('A') ? 'B' : 'A'}`;

    expect(options.secretCodec.matches(bearer, verifier)).toBe(true);
    expect(options.secretCodec.matches(`${bearer.slice(0, -1)}x`, verifier)).toBe(false);
    expect(options.secretCodec.matches(bearer, `okdv1$sha256$${otherDigest}`)).toBe(false);
    expect(options.secretCodec.matches(bearer, `okdv2$sha256$${digest}`)).toBe(false);
    expect(options.secretCodec.matches(bearer, `okdv1$sha512$${digest}`)).toBe(false);
    expect(options.secretCodec.matches(bearer, `okdv1$sha256$${digest}A`)).toBe(false);
    expect(options.secretCodec.matches('not-a-device-token', verifier)).toBe(false);
    expect(() => options.secretCodec.seal('not-a-device-token')).toThrowError(
      expect.objectContaining({ code: 'INVALID_DEVICE_CREDENTIAL_TOKEN' }),
    );
    expect(() => options.secretCodec.seal(token('s'.repeat(42)))).toThrowError(
      expect.objectContaining({ code: 'INVALID_DEVICE_CREDENTIAL_TOKEN' }),
    );
    expect(compare).toHaveBeenCalledTimes(3);
  });

  it('compares only equal 32-byte digests after strict parsing', () => {
    const comparedLengths: Array<[number, number]> = [];
    const options = createDeviceCredentialCryptoOptions({
      primitives: testPrimitives({
        timingSafeEqual: (left, right) => {
          comparedLengths.push([left.byteLength, right.byteLength]);
          return timingSafeEqual(Buffer.from(left), Buffer.from(right));
        },
      }),
    });
    const bearer = token();
    const verifier = options.secretCodec.seal(bearer);

    expect(options.secretCodec.matches(bearer, verifier)).toBe(true);
    expect(options.secretCodec.matches(bearer, `${verifier}A`)).toBe(false);
    expect(comparedLengths).toEqual([[32, 32]]);
  });

  it('fails verification closed when digest or comparison primitives fail', () => {
    const bearer = token();
    const verifier = createDeviceCredentialCryptoOptions({
      primitives: testPrimitives(),
    }).secretCodec.seal(bearer);
    const digestFailure = createDeviceCredentialCryptoOptions({
      primitives: testPrimitives({
        sha256: () => { throw new Error('digest unavailable'); },
      }),
    });
    const comparisonFailure = createDeviceCredentialCryptoOptions({
      primitives: testPrimitives({
        timingSafeEqual: () => { throw new Error('comparison unavailable'); },
      }),
    });

    expect(digestFailure.secretCodec.matches(bearer, verifier)).toBe(false);
    expect(comparisonFailure.secretCodec.matches(bearer, verifier)).toBe(false);
  });

  it('composes with issue, authentication, and generation-bound rotation', async () => {
    let secretSeed = 0;
    const store = new MemoryDeviceCredentialStore();
    const options = createDeviceCredentialCryptoOptions({
      now: () => 1_000,
      primitives: testPrimitives({
        randomBytes: () => Uint8Array.from(
          { length: 32 },
          (_, index) => (index + secretSeed++) % 256,
        ),
      }),
    });
    const lifecycle = new DeviceCredentialLifecycle(store, options);

    const issued = await lifecycle.issue(OWNER, INPUT);
    const stored = await store.get(issued.credential.credentialId);
    expect(stored?.sealedSecret).toMatch(/^okdv1\$sha256\$[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    await expect(lifecycle.authenticate(issued.token)).resolves.toMatchObject({ generation: 1 });

    const rotated = await lifecycle.rotate(OWNER, issued.credential.credentialId, {
      targets: ['preview'],
      controlIds: ['scoreboard.visibility'],
      scopes: ['feedback:read', 'component.visibility:write'],
      expiresAt: 20_000,
    });
    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.credential).toMatchObject({
      generation: 2,
      targets: ['preview'],
      controlIds: ['scoreboard.visibility'],
      scopes: ['feedback:read', 'component.visibility:write'],
      expiresAt: 20_000,
    });
    await expect(lifecycle.authenticate(issued.token)).resolves.toBeNull();
    await expect(lifecycle.authenticate(rotated.token)).resolves.toMatchObject({ generation: 2 });
  });

  it('aborts issuance before storage when entropy fails or has the wrong length', async () => {
    for (const randomSource of [
      () => { throw new Error('entropy unavailable'); },
      () => new Uint8Array(31),
    ]) {
      const store = new MemoryDeviceCredentialStore();
      const options = createDeviceCredentialCryptoOptions({
        now: () => 1_000,
        primitives: testPrimitives({ randomBytes: randomSource }),
      });
      const lifecycle = new DeviceCredentialLifecycle(store, options);

      await expect(lifecycle.issue(OWNER, INPUT)).rejects.toMatchObject({
        code: 'DEVICE_CREDENTIAL_ENTROPY_FAILURE',
      });
      await expect(store.get(CREDENTIAL_ID)).resolves.toBeNull();
    }
  });

  it('aborts issuance before storage when hashing fails or returns the wrong length', async () => {
    for (const digest of [
      () => { throw new Error('digest unavailable'); },
      () => new Uint8Array(31),
    ]) {
      const store = new MemoryDeviceCredentialStore();
      const options = createDeviceCredentialCryptoOptions({
        now: () => 1_000,
        primitives: testPrimitives({ sha256: digest }),
      });
      const lifecycle = new DeviceCredentialLifecycle(store, options);

      await expect(lifecycle.issue(OWNER, INPUT)).rejects.toMatchObject({
        code: 'DEVICE_CREDENTIAL_DIGEST_FAILURE',
      });
      await expect(store.get(CREDENTIAL_ID)).resolves.toBeNull();
    }
  });
});
