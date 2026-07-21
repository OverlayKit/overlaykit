import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeviceCredentialLifecycle,
  type StoredDeviceCredential,
} from '@overlaykit/protocol/device-credential';
import {
  DeviceCredentialStoreError,
  FileDeviceCredentialStore,
} from '../../src/auth/FileDeviceCredentialStore';

const temporaryDirectories: string[] = [];

class FailingCommitDeviceCredentialStore extends FileDeviceCredentialStore {
  protected override async replaceFile(): Promise<void> {
    throw Object.assign(new Error('simulated atomic replacement failure'), { code: 'EIO' });
  }
}

async function temporaryStore(): Promise<{
  directory: string;
  filePath: string;
  store: FileDeviceCredentialStore;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-device-store-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'private', 'device-credentials.json');
  return { directory, filePath, store: new FileDeviceCredentialStore(filePath) };
}

function record(overrides: Partial<StoredDeviceCredential> = {}): StoredDeviceCredential {
  return {
    credentialId: 'device-1',
    label: 'Production desk',
    showId: 'show-1',
    targets: ['preview'],
    controlIds: ['lower-third'],
    scopes: ['feedback:read', 'component.visibility:write'],
    generation: 1,
    sealedSecret: 'sha256:sealed-secret',
    issuedBy: 'owner-1',
    issuedAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 10_000,
    revokedAt: null,
    ...overrides,
  };
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('FileDeviceCredentialStore', () => {
  it('persists only a sealed bearer and authenticates it after restart', async () => {
    const { filePath, store } = await temporaryStore();
    const options = {
      now: () => 1_000,
      generateCredentialId: () => 'device-1',
      generateSecret: () => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      secretCodec: {
        seal: digest,
        matches: (token: string, sealedSecret: string) => digest(token) === sealedSecret,
      },
    };
    const lifecycle = new DeviceCredentialLifecycle(store, options);
    const issued = await lifecycle.issue(
      { principalId: 'owner-1', roles: ['owner'] },
      {
        label: 'Production desk',
        showId: 'show-1',
        targets: ['preview'],
        controlIds: ['lower-third'],
        scopes: ['feedback:read'],
        expiresAt: 10_000,
      }
    );

    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).not.toContain(issued.token);
    expect(raw).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    expect(raw).toContain(digest(issued.token));

    const restarted = new DeviceCredentialLifecycle(
      new FileDeviceCredentialStore(filePath),
      options
    );
    expect(await restarted.authenticate(issued.token)).toMatchObject({
      credentialId: 'device-1',
      generation: 1,
      showId: 'show-1',
    });
  });

  it('preserves rotation and revocation across independent store instances', async () => {
    const { filePath, store } = await temporaryStore();
    expect(await store.create(record())).toBe(true);

    const afterRotation = new FileDeviceCredentialStore(filePath);
    expect(
      await afterRotation.replace(
        record({
          generation: 2,
          sealedSecret: 'sha256:rotated',
          updatedAt: 2_000,
        }),
        1
      )
    ).toBe(true);

    const afterRevocation = new FileDeviceCredentialStore(filePath);
    expect(
      await afterRevocation.replace(
        record({
          generation: 3,
          sealedSecret: 'sha256:rotated',
          updatedAt: 3_000,
          revokedAt: 3_000,
        }),
        2
      )
    ).toBe(true);

    const restarted = new FileDeviceCredentialStore(filePath);
    await expect(restarted.get('device-1')).resolves.toMatchObject({
      generation: 3,
      revokedAt: 3_000,
    });
    await expect(restarted.replace(record({ generation: 2 }), 1)).resolves.toBe(false);
  });

  it('serializes competing creates and generation replacements within one instance', async () => {
    const { store } = await temporaryStore();
    const creates = await Promise.all([
      store.create(record()),
      store.create(record({ sealedSecret: 'sha256:other' })),
    ]);
    expect(creates.sort()).toEqual([false, true]);

    const replacements = await Promise.all([
      store.replace(record({ generation: 2, sealedSecret: 'sha256:first', updatedAt: 2_000 }), 1),
      store.replace(record({ generation: 2, sealedSecret: 'sha256:second', updatedAt: 2_000 }), 1),
    ]);
    expect(replacements.sort()).toEqual([false, true]);
    await expect(store.get('device-1')).resolves.toMatchObject({ generation: 2 });
  });

  it('fails closed on malformed state instead of replacing it', async () => {
    const { filePath, store } = await temporaryStore();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const malformed = '{"schemaVersion":1,"records":[{"credentialId":"device-1"}]}';
    await fs.writeFile(filePath, malformed, 'utf8');

    await expect(store.init()).rejects.toMatchObject<DeviceCredentialStoreError>({
      code: 'INVALID_DEVICE_CREDENTIAL_STORE',
    });
    await expect(store.create(record())).rejects.toMatchObject<DeviceCredentialStoreError>({
      code: 'INVALID_DEVICE_CREDENTIAL_STORE',
    });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(malformed);
  });

  it('keeps the previous generation when atomic replacement cannot commit', async () => {
    const { filePath, store } = await temporaryStore();
    await store.create(record());
    const failingStore = new FailingCommitDeviceCredentialStore(filePath);
    await expect(
      failingStore.replace(
        record({
          generation: 2,
          sealedSecret: 'sha256:uncommitted',
          updatedAt: 2_000,
        }),
        1
      )
    ).rejects.toMatchObject<DeviceCredentialStoreError>({
      code: 'DEVICE_CREDENTIAL_STORE_IO',
    });

    await expect(failingStore.get('device-1')).resolves.toMatchObject({ generation: 1 });
    await expect(new FileDeviceCredentialStore(filePath).get('device-1')).resolves.toMatchObject({
      generation: 1,
    });
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['device-credentials.json']);
  });

  it('rejects plaintext bearer records before creating a store file', async () => {
    const { filePath, store } = await temporaryStore();
    await expect(
      store.create(
        record({
          sealedSecret: 'ok_device_device-1.abcdefghijklmnopqrstuvwxyz0123456789',
        })
      )
    ).rejects.toMatchObject<DeviceCredentialStoreError>({
      code: 'INVALID_DEVICE_CREDENTIAL_STORE',
    });
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes a private complete file and leaves no temporary sibling', async () => {
    const { filePath, store } = await temporaryStore();
    await store.create(record());

    const mode = (await fs.stat(filePath)).mode & 0o777;
    const directoryMode = (await fs.stat(path.dirname(filePath))).mode & 0o777;
    const siblings = await fs.readdir(path.dirname(filePath));
    expect(mode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    expect(siblings).toEqual(['device-credentials.json']);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      records: [{ credentialId: 'device-1', generation: 1 }],
    });
  });
});
