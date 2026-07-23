import {
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceTrustSignatureVerifier,
  parseDeviceTrustBundle,
} from '@overlaykit/protocol/device-trust';
import {
  DEVICE_SIGNING_SCHEMA_VERSION,
  type GeneratedDeviceSigningKeyPair,
} from '../../src/auth/SqliteDeviceSigningAuthority';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';

const stores: SqliteDeviceCredentialStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-signing-authority-'));
  return path.join(directory, 'authority.sqlite');
}

function tracked(
  options: ConstructorParameters<typeof SqliteDeviceCredentialStore>[0],
): SqliteDeviceCredentialStore {
  const store = new SqliteDeviceCredentialStore(options);
  stores.push(store);
  return store;
}

function exported(pair: { publicKey: KeyObject; privateKey: KeyObject }): GeneratedDeviceSigningKeyPair {
  return {
    publicKeySpki: new Uint8Array(
      pair.publicKey.export({ format: 'der', type: 'spki' }),
    ),
    privateKeyPkcs8: new Uint8Array(
      pair.privateKey.export({ format: 'der', type: 'pkcs8' }),
    ),
  };
}

async function initialized(): Promise<{
  readonly databasePath: string;
  readonly store: SqliteDeviceCredentialStore;
}> {
  const location = await databasePath();
  const store = tracked({ databasePath: location });
  await store.init();
  return { databasePath: location, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('SQLite device signing authority', () => {
  it('persists one externally verifiable identity across restart', async () => {
    const location = await databasePath();
    const first = tracked({ databasePath: location, signing: { now: () => 1_000 } });
    await first.init();
    const firstAuthority = first.getSigningAuthority();
    const firstBundle = firstAuthority.trustBundle;
    const message = new TextEncoder().encode('signed state');
    const firstSignature = await firstAuthority.current().sign(message);
    const verifyFirst = await createDeviceTrustSignatureVerifier(firstBundle);

    await expect(
      verifyFirst(message, firstSignature, firstBundle.issuerKeyId),
    ).resolves.toBe(true);
    await expect(parseDeviceTrustBundle(firstBundle)).resolves.toMatchObject({
      bundle: firstBundle,
    });
    expect(Object.isFrozen(firstBundle)).toBe(true);
    expect(firstSignature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(firstAuthority.current()).toBe(firstAuthority.current());

    first.close();
    stores.splice(stores.indexOf(first), 1);
    const second = tracked({ databasePath: location });
    await second.init();
    const secondAuthority = second.getSigningAuthority();
    expect(secondAuthority.trustBundle).toEqual(firstBundle);
    await expect(
      verifyFirst(
        message,
        await secondAuthority.current().sign(message),
        firstBundle.issuerKeyId,
      ),
    ).resolves.toBe(true);
    second.close();
    stores.splice(stores.indexOf(second), 1);

    const database = new DatabaseSync(location, { readOnly: true });
    const row = database.prepare(`
      SELECT identity_id, algorithm, issuer_key_id, public_key_spki, private_key_pkcs8,
             fingerprint_sha256, created_at
      FROM device_signing_identity
    `).get() as Record<string, unknown>;
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    database.close();
    expect(version.user_version).toBe(DEVICE_SIGNING_SCHEMA_VERSION);
    expect(row).toMatchObject({
      identity_id: 1,
      algorithm: 'Ed25519',
      issuer_key_id: firstBundle.issuerKeyId,
      fingerprint_sha256: firstBundle.fingerprintSha256,
      created_at: 1_000,
    });
    expect(row.public_key_spki).toBeInstanceOf(Uint8Array);
    expect(row.private_key_pkcs8).toBeInstanceOf(Uint8Array);
    expect(row).not.toHaveProperty('bearer');
    expect(row).not.toHaveProperty('token');
    expect(() => secondAuthority.current()).toThrow('Device signing authority is closed');
  });

  it('rolls back unexposed generated material when initialization does not commit', async () => {
    const location = await databasePath();
    const firstPair = exported(generateKeyPairSync('ed25519'));
    const secondPair = exported(generateKeyPairSync('ed25519'));
    const generateFirst = vi.fn(() => firstPair);
    const failing = tracked({
      databasePath: location,
      signing: { generateKeyPair: generateFirst, now: () => 1_000 },
      beforeCommit(phase) {
        if (phase === 'initialize') throw new Error('injected pre-commit failure');
      },
    });

    await expect(failing.init()).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_STORE_IO',
    });
    expect(generateFirst).toHaveBeenCalledTimes(1);
    expect(() => failing.getSigningAuthority()).toThrow(
      'SQLite device signing authority is not initialized',
    );
    failing.close();
    stores.splice(stores.indexOf(failing), 1);

    const generateSecond = vi.fn(() => secondPair);
    const recovered = tracked({
      databasePath: location,
      signing: { generateKeyPair: generateSecond, now: () => 2_000 },
    });
    await recovered.init();
    expect(generateSecond).toHaveBeenCalledTimes(1);
    const expectedPublic = Buffer.from(secondPair.publicKeySpki).toString('base64url');
    expect(recovered.getSigningAuthority().trustBundle.publicKeySpkiBase64Url)
      .toBe(expectedPublic);
    expect(recovered.getSigningAuthority().trustBundle.publicKeySpkiBase64Url)
      .not.toBe(Buffer.from(firstPair.publicKeySpki).toString('base64url'));
  });

  it('migrates a version 4 authority exactly once', async () => {
    const location = await databasePath();
    const original = tracked({ databasePath: location });
    await original.init();
    original.close();
    stores.splice(stores.indexOf(original), 1);

    const oldDatabase = new DatabaseSync(location);
    oldDatabase.exec(`
      DROP TRIGGER device_signing_identity_no_update;
      DROP TRIGGER device_signing_identity_no_delete;
      DROP TABLE device_signing_identity;
      PRAGMA user_version = 4;
    `);
    oldDatabase.close();

    const generate = vi.fn(() => exported(generateKeyPairSync('ed25519')));
    const migrated = tracked({
      databasePath: location,
      signing: { generateKeyPair: generate, now: () => 3_000 },
    });
    await migrated.init();
    const bundle = migrated.getSigningAuthority().trustBundle;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(bundle.issuerKeyId).toMatch(/^ed25519-sha256-[A-Za-z0-9_-]{43}$/);

    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);
    const reopened = tracked({
      databasePath: location,
      signing: { generateKeyPair: generate, now: () => 4_000 },
    });
    await reopened.init();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(reopened.getSigningAuthority().trustBundle).toEqual(bundle);
  });

  it('never regenerates an initialized authority whose identity is missing', async () => {
    const context = await initialized();
    context.store.close();
    stores.splice(stores.indexOf(context.store), 1);
    const database = new DatabaseSync(context.databasePath);
    database.exec(`
      DROP TRIGGER device_signing_identity_no_delete;
      DELETE FROM device_signing_identity;
    `);
    database.close();
    const generate = vi.fn(() => exported(generateKeyPairSync('ed25519')));
    const reopened = tracked({
      databasePath: context.databasePath,
      signing: { generateKeyPair: generate },
    });

    await expect(reopened.init()).rejects.toMatchObject({
      code: 'INVALID_DEVICE_CREDENTIAL_STORE',
      message: expect.stringContaining('missing its device signing identity'),
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects key substitution and derived identity aliases on restart', async () => {
    for (const mutation of ['private', 'issuer', 'fingerprint'] as const) {
      const context = await initialized();
      context.store.close();
      stores.splice(stores.indexOf(context.store), 1);
      const database = new DatabaseSync(context.databasePath);
      database.exec('DROP TRIGGER device_signing_identity_no_update');
      if (mutation === 'private') {
        const replacement = exported(generateKeyPairSync('ed25519'));
        database.prepare(`
          UPDATE device_signing_identity SET private_key_pkcs8 = ?
          WHERE identity_id = 1
        `).run(replacement.privateKeyPkcs8);
      } else if (mutation === 'issuer') {
        database.exec(`
          UPDATE device_signing_identity SET issuer_key_id = 'operator-alias'
          WHERE identity_id = 1
        `);
      } else {
        database.exec(`
          UPDATE device_signing_identity SET fingerprint_sha256 =
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
          WHERE identity_id = 1
        `);
      }
      database.close();

      await expect(tracked({ databasePath: context.databasePath }).init())
        .rejects.toMatchObject({
          code: 'INVALID_DEVICE_CREDENTIAL_STORE',
        });
    }
  });

  it('makes the committed identity immutable to cooperating writers', async () => {
    const context = await initialized();
    context.store.close();
    stores.splice(stores.indexOf(context.store), 1);
    const database = new DatabaseSync(context.databasePath);
    expect(() => database.exec(`
      UPDATE device_signing_identity SET issuer_key_id = 'replacement'
      WHERE identity_id = 1
    `)).toThrow('device signing identity is immutable');
    expect(() => database.exec(`
      DELETE FROM device_signing_identity WHERE identity_id = 1
    `)).toThrow('device signing identity is immutable');
    database.close();

    const reopened = tracked({ databasePath: context.databasePath });
    await reopened.init();
    const signer = reopened.getSigningAuthority().current();
    expect(() => signer.sign(new Uint8Array())).toThrow(
      'Device signing payload is invalid',
    );
    expect(() => signer.sign(new Uint8Array(1_048_577))).toThrow(
      'Device signing payload is invalid',
    );
  });
});
