import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceCredentialLifecycle,
  MemoryDeviceCredentialStore,
} from '@overlaykit/protocol/device-credential';
import { createDeviceCredentialCryptoOptions } from '../../src/auth/DeviceCredentialCrypto';
import { ObservableDeviceCredentialLifecycle } from '../../src/auth/ObservableDeviceCredentialLifecycle';
import { DeviceConnectionAuthorityCoordinator } from '../../src/services/DeviceConnectionAuthorityCoordinator';
import { DeviceConnectionAuthorityMonitor } from '../../src/services/DeviceConnectionAuthorityMonitor';

class InitializableMemoryStore extends MemoryDeviceCredentialStore {
  readonly init = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
}

function harness(now: () => number = Date.now) {
  const store = new InitializableMemoryStore();
  const options = createDeviceCredentialCryptoOptions({ now });
  const persisted = new DeviceCredentialLifecycle(store, options);
  const lifecycle = new ObservableDeviceCredentialLifecycle({
    lifecycle: persisted,
    store,
    now,
  });
  return { lifecycle, store };
}

const owner = { principalId: 'owner-1', roles: ['owner'] };

function issueInput(expiresAt = Date.now() + 60_000) {
  return {
    label: 'Production desk',
    showId: 'show-1',
    targets: ['preview'] as const,
    controlIds: ['lower-third.visibility'],
    scopes: ['feedback:read'] as const,
    expiresAt,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ObservableDeviceCredentialLifecycle', () => {
  it('publishes immutable committed authority before resolving the owner mutation', async () => {
    const store = new InitializableMemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committedGeneration: number | null = null;
    let listenerStarted = false;
    const options = createDeviceCredentialCryptoOptions({
      now: Date.now,
      primitives: { randomUUID: () => 'device-1' },
    });
    const persisted = new DeviceCredentialLifecycle(store, options);
    const deterministic = new ObservableDeviceCredentialLifecycle({
      lifecycle: persisted,
      store,
    });
    deterministic.subscribe('device-1', async (authority) => {
      listenerStarted = true;
      committedGeneration = (await store.get('device-1'))?.generation ?? null;
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(authority?.scopes)).toBe(true);
      await gate;
    });
    let resolved = false;
    const issuing = deterministic.issue(owner, issueInput()).then((result) => {
      resolved = true;
      return result;
    });
    await vi.waitFor(() => expect(listenerStarted).toBe(true));
    expect(committedGeneration).toBe(1);
    expect(resolved).toBe(false);
    release();
    await expect(issuing).resolves.toMatchObject({ credential: { generation: 1 } });
    await deterministic.close();
  });

  it('rotates bearer and permissions as one new generation and invalidates the old token', async () => {
    const { lifecycle } = harness();
    const issued = await lifecycle.issue(owner, issueInput());
    const events: Array<number | null> = [];
    lifecycle.subscribe(issued.credential.credentialId, (authority) => {
      events.push(authority?.generation ?? null);
    });

    const rotated = await lifecycle.rotate(owner, issued.credential.credentialId, {
      targets: ['program'],
      controlIds: ['scoreboard.visibility'],
      scopes: ['component.visibility:write'],
      expiresAt: Date.now() + 120_000,
    });

    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.credential).toMatchObject({
      generation: 2,
      targets: ['program'],
      controlIds: ['scoreboard.visibility'],
      scopes: ['component.visibility:write'],
    });
    await expect(lifecycle.authenticate(issued.token)).resolves.toBeNull();
    await expect(lifecycle.authenticate(rotated.token)).resolves.toMatchObject({ generation: 2 });
    expect(events).toEqual([2]);
    await lifecycle.close();
  });

  it('makes revocation irreversible and publishes null before returning', async () => {
    const { lifecycle } = harness();
    const issued = await lifecycle.issue(owner, issueInput());
    const events: Array<number | null> = [];
    lifecycle.subscribe(issued.credential.credentialId, (authority) => {
      events.push(authority?.generation ?? null);
    });

    const revoked = await lifecycle.revoke(owner, issued.credential.credentialId);

    expect(revoked).toMatchObject({ generation: 2, revokedAt: expect.any(Number) });
    expect(events).toEqual([null]);
    await expect(lifecycle.authenticate(issued.token)).resolves.toBeNull();
    await expect(lifecycle.rotate(owner, issued.credential.credentialId)).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_REVOKED',
    });
    await lifecycle.close();
  });

  it('fails only the affected credential closed when one listener throws', async () => {
    const { lifecycle } = harness();
    const options = createDeviceCredentialCryptoOptions({
      now: Date.now,
      primitives: { randomUUID: () => 'device-1' },
    });
    const store = new InitializableMemoryStore();
    const deterministic = new ObservableDeviceCredentialLifecycle({
      lifecycle: new DeviceCredentialLifecycle(store, options),
      store,
    });
    const healthy: Array<number | null> = [];
    deterministic.subscribe('device-1', (authority) => {
      if (authority) throw new Error('listener failed');
    });
    deterministic.subscribe('device-1', (authority) => {
      healthy.push(authority?.generation ?? null);
    });

    await deterministic.issue(owner, issueInput());

    expect(healthy).toEqual([1, null]);
    expect(deterministic.isAvailable()).toBe(true);
    await lifecycle.close();
    await deterministic.close();
  });

  it('publishes expiration at the exact effective deadline', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { lifecycle } = harness(() => now);
    const issued = await lifecycle.issue(owner, issueInput(2_000));
    const events: Array<number | null> = [];
    lifecycle.subscribe(issued.credential.credentialId, (authority) => {
      events.push(authority?.generation ?? null);
    });

    now = 1_999;
    await vi.advanceTimersByTimeAsync(999);
    expect(events).toEqual([]);
    now = 2_000;
    await vi.advanceTimersByTimeAsync(1);

    expect(events).toEqual([null]);
    await expect(lifecycle.resolve(issued.credential.credentialId)).resolves.toBeNull();
    await lifecycle.close();
  });

  it('quiesces an active lease before a rotation response is observable to the Owner', async () => {
    const options = createDeviceCredentialCryptoOptions({
      now: Date.now,
      primitives: { randomUUID: () => 'device-1' },
    });
    const store = new InitializableMemoryStore();
    const lifecycle = new ObservableDeviceCredentialLifecycle({
      lifecycle: new DeviceCredentialLifecycle(store, options),
      store,
    });
    const issued = await lifecycle.issue(owner, issueInput());
    const authority = await lifecycle.authenticate(issued.token);
    expect(authority).not.toBeNull();
    const monitor = new DeviceConnectionAuthorityMonitor({ source: lifecycle });
    const admission = await monitor.prepare(authority!);
    const coordinator = new DeviceConnectionAuthorityCoordinator();
    const close = vi.fn(async () => undefined);
    const connection: { lease?: Awaited<ReturnType<typeof coordinator.connect>> } = {};
    const monitorLease = admission.activate({
      invalidate: (reason) => connection.lease
        ? coordinator.retire(connection.lease, reason)
        : undefined,
    });
    const lease = await coordinator.connect(authority!, { id: 'connection-1', close }, () => (
      monitorLease.isCurrent()
    ));
    connection.lease = lease;

    await lifecycle.rotate(owner, issued.credential.credentialId);

    expect(monitorLease.isCurrent()).toBe(false);
    expect(coordinator.isEffective(lease)).toBe(false);
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('authority.changed'));
    await lifecycle.close();
  });
});
