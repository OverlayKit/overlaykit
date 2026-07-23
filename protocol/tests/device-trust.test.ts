import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_TRUST_ALGORITHM,
  DEVICE_TRUST_BUNDLE_VERSION,
  DEVICE_TRUST_ISSUER_PREFIX,
  DeviceTrustBundleError,
  buildDeviceTrustBundle,
  createDeviceTrustSignatureVerifier,
  deriveDeviceTrustIdentity,
  parseDeviceTrustBundle,
} from '../src/device-trust.js';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  const publicKeySpki = new Uint8Array(
    pair.publicKey.export({ format: 'der', type: 'spki' }),
  );
  return { ...pair, publicKeySpki };
}

describe('device trust bundle', () => {
  it('derives one canonical issuer from Ed25519 SPKI bytes', async () => {
    const pair = keys();
    const expectedDigest = createHash('sha256').update(pair.publicKeySpki).digest();
    const expectedFingerprint = expectedDigest.toString('hex');
    const expectedIssuer = `${DEVICE_TRUST_ISSUER_PREFIX}${expectedDigest.toString('base64url')}`;

    const identity = await deriveDeviceTrustIdentity(pair.publicKeySpki);
    const bundle = await buildDeviceTrustBundle(pair.publicKeySpki);
    const parsed = await parseDeviceTrustBundle(bundle);

    expect(identity).toEqual({
      issuerKeyId: expectedIssuer,
      fingerprintSha256: expectedFingerprint,
    });
    expect(bundle).toEqual({
      schemaVersion: DEVICE_TRUST_BUNDLE_VERSION,
      algorithm: DEVICE_TRUST_ALGORITHM,
      issuerKeyId: expectedIssuer,
      publicKeySpkiBase64Url: Buffer.from(pair.publicKeySpki).toString('base64url'),
      fingerprintSha256: expectedFingerprint,
    });
    expect(parsed.bundle).toEqual(bundle);
    expect(parsed.publicKeySpki).toEqual(pair.publicKeySpki);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('verifies detached signatures only for the pinned issuer and exact bytes', async () => {
    const pair = keys();
    const other = keys();
    const bundle = await buildDeviceTrustBundle(pair.publicKeySpki);
    const verify = await createDeviceTrustSignatureVerifier(bundle);
    const payload = new TextEncoder().encode('authoritative state');
    const signature = sign(null, payload, pair.privateKey).toString('base64url');

    await expect(verify(payload, signature, bundle.issuerKeyId)).resolves.toBe(true);
    await expect(verify(
      new TextEncoder().encode('substituted state'),
      signature,
      bundle.issuerKeyId,
    )).resolves.toBe(false);
    await expect(verify(payload, signature, 'untrusted-issuer')).resolves.toBe(false);
    await expect(verify(
      payload,
      sign(null, payload, other.privateKey).toString('base64url'),
      bundle.issuerKeyId,
    )).resolves.toBe(false);
    await expect(verify(payload, `${signature}=`, bundle.issuerKeyId)).resolves.toBe(false);
    await expect(verify(payload, '*'.repeat(86), bundle.issuerKeyId)).resolves.toBe(false);
    await expect(verify(new Uint8Array(), signature, bundle.issuerKeyId)).resolves.toBe(false);
    await expect(verify(
      new Uint8Array(1_048_577),
      signature,
      bundle.issuerKeyId,
    )).resolves.toBe(false);
  });

  it('rejects aliases, substitutions, unsupported keys, and ambiguous objects', async () => {
    const pair = keys();
    const bundle = await buildDeviceTrustBundle(pair.publicKeySpki);
    const otherBundle = await buildDeviceTrustBundle(keys().publicKeySpki);
    const mutations: unknown[] = [
      null,
      [],
      { ...bundle, extra: true },
      { ...bundle, schemaVersion: 'overlaykit-device-trust-bundle/v2' },
      { ...bundle, algorithm: 'ECDSA' },
      { ...bundle, issuerKeyId: ` ${bundle.issuerKeyId}` },
      { ...bundle, issuerKeyId: otherBundle.issuerKeyId },
      { ...bundle, fingerprintSha256: bundle.fingerprintSha256.toUpperCase() },
      { ...bundle, fingerprintSha256: otherBundle.fingerprintSha256 },
      { ...bundle, publicKeySpkiBase64Url: `${bundle.publicKeySpkiBase64Url}=` },
      { ...bundle, publicKeySpkiBase64Url: otherBundle.publicKeySpkiBase64Url },
      { ...bundle, publicKeySpkiBase64Url: '*' },
      { ...bundle, publicKeySpkiBase64Url: 'a'.repeat(345) },
    ];

    for (const mutation of mutations) {
      await expect(parseDeviceTrustBundle(mutation)).rejects.toThrowError(
        DeviceTrustBundleError,
      );
    }
    await expect(buildDeviceTrustBundle(new Uint8Array([1, 2, 3])))
      .rejects.toThrowError(DeviceTrustBundleError);
  });

  it('copies caller-owned key bytes before asynchronous derivation', async () => {
    const pair = keys();
    const original = pair.publicKeySpki.slice();
    const building = buildDeviceTrustBundle(pair.publicKeySpki);
    pair.publicKeySpki.fill(0);

    const bundle = await building;
    const expected = await buildDeviceTrustBundle(original);
    expect(bundle).toEqual(expected);

    const parsed = await parseDeviceTrustBundle(bundle);
    parsed.publicKeySpki.fill(0);
    await expect(parseDeviceTrustBundle(bundle)).resolves.toMatchObject({ bundle });
  });
});
