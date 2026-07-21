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
});
