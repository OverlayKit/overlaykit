import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type {
  StoredDeviceCredential,
} from '@overlaykit/protocol/device-credential';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import {
  createDeviceCredentialRuntime,
  type InitializableDeviceCredentialStore,
} from '../../src/auth/DeviceCredentialRuntime';
import type { DeviceActionCatalogRuntime } from '../../src/services/DeviceActionCatalogRuntime';
import { createDeviceActionCatalogRuntime } from '../../src/services/DeviceActionCatalogRuntime';
import type { ManagedFeedbackSequenceStore } from '../../src/services/FileFeedbackSequenceStore';
import { createServerRuntime } from '../../src/index';
import type { Storage } from '../../src/storage';

class RecordingStore implements InitializableDeviceCredentialStore {
  readonly records = new Map<string, StoredDeviceCredential>();
  readonly init = vi.fn(async () => undefined);

  async get(credentialId: string): Promise<StoredDeviceCredential | null> {
    return this.records.get(credentialId) ?? null;
  }

  async create(record: StoredDeviceCredential): Promise<boolean> {
    if (this.records.has(record.credentialId)) return false;
    this.records.set(record.credentialId, record);
    return true;
  }

  async replace(
    record: StoredDeviceCredential,
    expectedGeneration: number,
  ): Promise<boolean> {
    const current = this.records.get(record.credentialId);
    if (!current || current.generation !== expectedGeneration) return false;
    this.records.set(record.credentialId, record);
    return true;
  }
}

describe('device credential server composition', () => {
  it('loads the ESM authority once, initializes one store, and executes it', async () => {
    const protocol = await import('@overlaykit/protocol/device-credential');
    const loadProtocol = vi.fn(async () => protocol);
    const store = new RecordingStore();
    const runtime = await createDeviceCredentialRuntime({ store, loadProtocol });

    const issued = await runtime.lifecycle.issue(
      { principalId: 'owner-1', roles: ['owner'] },
      {
        label: 'Production desk',
        showId: 'show-1',
        targets: ['program'],
        controlIds: ['lower-third.visibility'],
        scopes: ['component.visibility:write'],
        expiresAt: Date.now() + 60_000,
      },
    );

    expect(loadProtocol).toHaveBeenCalledTimes(1);
    expect(store.init).toHaveBeenCalledTimes(1);
    expect(runtime.store).toBe(store);
    expect(runtime.productionState).toBeNull();
    await expect(runtime.lifecycle.authenticate(issued.token)).resolves.toMatchObject({
      showId: 'show-1',
      credentialId: issued.credential.credentialId,
    });
  });

  it('rejects composition when package loading or store initialization fails', async () => {
    const store = new RecordingStore();
    await expect(createDeviceCredentialRuntime({
      store,
      loadProtocol: async () => { throw new Error('module unavailable'); },
    })).rejects.toThrow('module unavailable');
    expect(store.init).not.toHaveBeenCalled();

    const protocol = await import('@overlaykit/protocol/device-credential');
    const failingStore = new RecordingStore();
    failingStore.init.mockRejectedValueOnce(new Error('store unavailable'));
    await expect(createDeviceCredentialRuntime({
      store: failingStore,
      loadProtocol: async () => protocol,
    })).rejects.toThrow('store unavailable');
  });

  it('rejects server bootstrap before returning an app when authority composition fails', async () => {
    const auth = new AuthService(new MemoryAuthStore());
    const init = vi.fn(async () => undefined);
    const dataStorage = { init } as unknown as Storage;
    const createDeviceCredentials = vi.fn(async () => {
      throw new Error('device authority unavailable');
    });

    await expect(createServerRuntime({
      auth,
      dataStorage,
      createDeviceCredentials,
    })).rejects.toThrow('device authority unavailable');
    expect(init).toHaveBeenCalledTimes(1);
    expect(createDeviceCredentials).toHaveBeenCalledTimes(1);
  });

  it('rejects server bootstrap when the action catalog protocol cannot be composed', async () => {
    const auth = new AuthService(new MemoryAuthStore());
    const init = vi.fn(async () => undefined);
    const dataStorage = { init } as unknown as Storage;
    const credentialProtocol = await import('@overlaykit/protocol/device-credential');
    const deviceCredentials = await createDeviceCredentialRuntime({
      store: new RecordingStore(),
      loadProtocol: async () => credentialProtocol,
    });
    const createDeviceActionCatalog = vi.fn(async (): Promise<DeviceActionCatalogRuntime> => {
      throw new Error('catalog projector unavailable');
    });

    await expect(createServerRuntime({
      auth,
      dataStorage,
      deviceCredentials,
      createDeviceActionCatalog,
      allowEphemeralProduction: true,
    })).rejects.toThrow('catalog projector unavailable');
    expect(init).toHaveBeenCalledTimes(1);
    expect(createDeviceActionCatalog).toHaveBeenCalledTimes(1);
  });

  it('refuses an implicit ephemeral production authority in server composition', async () => {
    const protocol = await import('@overlaykit/protocol/device-credential');
    const deviceCredentials = await createDeviceCredentialRuntime({
      store: new RecordingStore(),
      loadProtocol: async () => protocol,
    });
    const auth = new AuthService(new MemoryAuthStore());
    const dataStorage = { init: vi.fn(async () => undefined) } as unknown as Storage;

    await expect(createServerRuntime({
      auth,
      dataStorage,
      deviceCredentials,
      deviceActionCatalog: await createDeviceActionCatalogRuntime(),
    })).rejects.toThrow(
      'Server runtime requires durable production state on the shared SQLite authority',
    );
    await deviceCredentials.close();
  });

  it('mounts audited bootstrap with the SQLite ledger and its signing identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-runtime-bootstrap-'));
    const deviceCredentials = await createDeviceCredentialRuntime({
      databasePath: path.join(directory, 'authority.sqlite'),
    });
    const auth = new AuthService(new MemoryAuthStore());
    const dataStorage = { init: vi.fn(async () => undefined) } as unknown as Storage;
    let sequence = 0;
    const sequences: ManagedFeedbackSequenceStore = {
      init: vi.fn(async () => undefined),
      reserve: vi.fn(async (_issuer, _audience, count) => (
        Array.from({ length: count }, () => {
          sequence += 1;
          return sequence;
        })
      )),
      close: vi.fn(async () => undefined),
      getState: () => ({
        phase: 'ready',
        durability: 'process_restart_resilient',
        authorityHeld: true,
      }),
    };
    const runtime = await createServerRuntime({
      auth,
      dataStorage,
      deviceCredentials,
      deviceActionCatalog: await createDeviceActionCatalogRuntime(),
      deviceBootstrapSequences: sequences,
    });

    expect(deviceCredentials.transitionLedger).not.toBeNull();
    expect(deviceCredentials.productionState).not.toBeNull();
    expect(runtime.production.getSnapshot('show-1', 'preview').revision).toBe(0);
    expect(runtime.deviceBootstrapSessions).not.toBeNull();
    expect(runtime.deviceCommandSessions).not.toBeNull();
    expect(deviceCredentials.signing).not.toBeNull();
    expect(deviceCredentials.signing?.current().issuerKeyId)
      .toBe(deviceCredentials.signing?.trustBundle.issuerKeyId);
    expect(runtime.deviceBootstrapSequences).toBe(sequences);
    expect(sequences.init).toHaveBeenCalledTimes(1);
    await runtime.deviceGateway.shutdown();
    await sequences.close();
    await deviceCredentials.close();
  });

  it('rejects replacement of the SQLite signing identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-runtime-signer-'));
    const deviceCredentials = await createDeviceCredentialRuntime({
      databasePath: path.join(directory, 'authority.sqlite'),
    });
    const auth = new AuthService(new MemoryAuthStore());
    const dataStorage = { init: vi.fn(async () => undefined) } as unknown as Storage;

    await expect(createServerRuntime({
      auth,
      dataStorage,
      deviceCredentials,
      deviceActionCatalog: await createDeviceActionCatalogRuntime(),
      deviceBootstrapSigning: {
        current: () => ({ issuerKeyId: 'replacement', sign: () => 'signature' }),
      },
    })).rejects.toThrow('cannot replace the SQLite device signing authority');
    await deviceCredentials.close();
  });

  it('refuses audited bootstrap when an injected credential store has no shared ledger', async () => {
    const protocol = await import('@overlaykit/protocol/device-credential');
    const deviceCredentials = await createDeviceCredentialRuntime({
      store: new RecordingStore(),
      loadProtocol: async () => protocol,
    });
    const auth = new AuthService(new MemoryAuthStore());
    const dataStorage = { init: vi.fn(async () => undefined) } as unknown as Storage;

    await expect(createServerRuntime({
      auth,
      dataStorage,
      deviceCredentials,
      deviceActionCatalog: await createDeviceActionCatalogRuntime(),
      allowEphemeralProduction: true,
      deviceBootstrapSigning: {
        current: () => ({ issuerKeyId: 'server-key-1', sign: () => 'signature' }),
      },
    })).rejects.toThrow('requires the SQLite transition ledger');
    await deviceCredentials.close();
  });
});
