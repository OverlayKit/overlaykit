import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_AUTHORITY_MAX_STALENESS_MS,
  DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS,
  DeviceConnectionAuthorityMonitor,
  canonicalDeviceConnectionAuthority,
  deviceConnectionAuthorityHash,
  type DeviceAuthorityMonitorScheduler,
  type DeviceAuthorityObservationSource,
} from '../../src/services/DeviceConnectionAuthorityMonitor';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualMonitorClock implements DeviceAuthorityMonitorScheduler {
  value: number;
  private nextHandle = 1;
  private readonly tasks = new Map<number, { at: number; task: () => void }>();

  constructor(initialValue = 1_000) {
    this.value = initialValue;
  }

  schedule(at: number, task: () => void): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { at, task });
    return handle;
  }

  cancel(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  get pendingTasks(): number {
    return this.tasks.size;
  }

  async advanceTo(value: number): Promise<void> {
    this.value = value;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, entry]) => entry.at <= value)
        .sort(
          ([leftHandle, left], [rightHandle, right]) =>
            left.at - right.at || leftHandle - rightHandle
        )[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      due[1].task();
      await flush();
    }
    await flush();
  }
}

class MutableAuthoritySource implements DeviceAuthorityObservationSource {
  available = true;
  current: DeviceCredentialAuthority | null;
  readonly events: string[] = [];
  readonly listeners = new Set<(authority: DeviceCredentialAuthority | null) => void>();
  onSubscribe: ((listener: (authority: DeviceCredentialAuthority | null) => void) => void) | null =
    null;
  resolveImplementation: (credentialId: string) => Promise<DeviceCredentialAuthority | null>;

  constructor(initial: DeviceCredentialAuthority | null) {
    this.current = initial;
    this.resolveImplementation = async () => this.current;
  }

  isAvailable(): boolean {
    return this.available;
  }

  subscribe(
    credentialId: string,
    listener: (authority: DeviceCredentialAuthority | null) => void
  ): () => void {
    this.events.push(`subscribe:${credentialId}`);
    this.listeners.add(listener);
    this.onSubscribe?.(listener);
    return () => {
      this.events.push(`unsubscribe:${credentialId}`);
      this.listeners.delete(listener);
    };
  }

  async resolve(credentialId: string): Promise<DeviceCredentialAuthority | null> {
    this.events.push(`resolve:${credentialId}`);
    return this.resolveImplementation(credentialId);
  }

  notify(authority: DeviceCredentialAuthority | null = this.current): void {
    for (const listener of [...this.listeners]) listener(authority);
  }
}

function authority(overrides: Partial<DeviceCredentialAuthority> = {}): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g2',
    generation: 2,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['scoreboard.visibility', 'lower-third.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: 100_000,
    ...overrides,
  };
}

function harness(initial = authority(), initialTime = 1_000) {
  const clock = new ManualMonitorClock(initialTime);
  const source = new MutableAuthoritySource(initial);
  const backgroundErrors: unknown[] = [];
  const monitor = new DeviceConnectionAuthorityMonitor({
    source,
    now: () => clock.value,
    scheduler: clock,
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  return { clock, source, monitor, backgroundErrors };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await flush();
  expect(settled).toBe(false);
}

describe('DeviceConnectionAuthorityMonitor', () => {
  it('hashes the complete normalized effective authority without locale ordering', () => {
    const first = authority({
      targets: ['program', 'preview'],
      controlIds: ['z', 'a', 'A'],
      scopes: ['component.visibility:write', 'feedback:read'],
    });
    const reordered = authority({
      targets: ['preview', 'program'],
      controlIds: ['A', 'z', 'a'],
      scopes: ['feedback:read', 'component.visibility:write'],
    });

    expect(canonicalDeviceConnectionAuthority(first)).toEqual({
      schemaVersion: 'overlaykit-device-connection-authority/v1',
      credentialId: 'device-1',
      audienceCredentialId: 'device-1.g2',
      generation: 2,
      showId: 'show-1',
      targets: ['preview', 'program'],
      controlIds: ['A', 'a', 'z'],
      scopes: ['feedback:read', 'component.visibility:write'],
      expiresAt: 100_000,
    });
    expect(deviceConnectionAuthorityHash(first)).toBe(deviceConnectionAuthorityHash(reordered));
    expect(deviceConnectionAuthorityHash(first)).toMatch(/^[a-f0-9]{64}$/);

    const mutations: DeviceCredentialAuthority[] = [
      authority({ credentialId: 'device-2', audienceCredentialId: 'device-2.g2' }),
      authority({ audienceCredentialId: 'device-1.g3', generation: 3 }),
      authority({ showId: 'show-2' }),
      authority({ targets: ['preview'] }),
      authority({ controlIds: ['scoreboard.visibility'] }),
      authority({ scopes: ['feedback:read'] }),
      authority({ expiresAt: 100_001 }),
    ];
    for (const mutation of mutations) {
      expect(deviceConnectionAuthorityHash(mutation)).not.toBe(
        deviceConnectionAuthorityHash(authority())
      );
    }
    expect(() =>
      deviceConnectionAuthorityHash(
        authority({
          controlIds: ['duplicate', 'duplicate'],
        })
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_DEVICE_AUTHORITY_MONITOR',
      })
    );
  });

  it('subscribes before resolving, retains no bearer, and freezes captured authority', async () => {
    const { clock, source, monitor } = harness();
    const admission = await monitor.prepare(authority());

    expect(source.events.slice(0, 2)).toEqual(['subscribe:device-1', 'resolve:device-1']);
    expect(source.events.join(' ')).not.toContain('ok_device_');
    expect(admission.authority).toEqual(
      authority({
        controlIds: ['lower-third.visibility', 'scoreboard.visibility'],
      })
    );
    expect(Object.isFrozen(admission.authority)).toBe(true);
    expect(Object.isFrozen(admission.authority.controlIds)).toBe(true);
    expect(admission.isCurrent()).toBe(true);

    const invalidate = vi.fn();
    const lease = admission.activate({ invalidate });
    source.notify(
      authority({
        targets: ['program', 'preview'],
        controlIds: ['lower-third.visibility', 'scoreboard.visibility'],
        scopes: ['component.visibility:write', 'feedback:read'],
      })
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(lease.isCurrent()).toBe(true);

    lease.close();
    expect(source.listeners.size).toBe(0);
    expect(clock.pendingTasks).toBe(0);
  });

  it('closes the subscribe-read race and releases a synchronously invalidated subscription', async () => {
    const { source, monitor } = harness();
    source.onSubscribe = (listener) => listener(authority({ scopes: ['feedback:read'] }));

    await expect(monitor.prepare(authority())).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_CHANGED',
    });
    expect(source.events).toEqual(['subscribe:device-1', 'unsubscribe:device-1']);
    expect(source.listeners.size).toBe(0);
  });

  it('invalidates once on a changed notification and never recovers through ABA', async () => {
    const { source, monitor } = harness();
    const admission = await monitor.prepare(authority());
    const invalidate = vi.fn();
    const lease = admission.activate({ invalidate });

    source.notify(authority({ scopes: ['feedback:read'] }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('authority.changed');
    expect(lease.isCurrent()).toBe(false);

    source.notify(authority());
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(source.listeners.size).toBe(0);
  });

  it('detects a lost notification through bounded polling', async () => {
    const { clock, source, monitor } = harness(authority(), 0);
    const admission = await monitor.prepare(authority());
    const invalidate = vi.fn();
    admission.activate({ invalidate });
    source.current = authority({ targets: ['preview'] });

    await clock.advanceTo(DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS - 1);
    expect(invalidate).not.toHaveBeenCalled();
    await clock.advanceTo(DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('authority.changed');
  });

  it('does not renew freshness from a stale same-hash notification', async () => {
    const { clock, source, monitor } = harness(authority(), 0);
    const admission = await monitor.prepare(authority());
    const invalidate = vi.fn();
    admission.activate({ invalidate });
    const hanging = deferred<DeviceCredentialAuthority | null>();
    source.current = authority({ scopes: ['feedback:read'] });
    source.resolveImplementation = () => hanging.promise;

    clock.value = DEVICE_AUTHORITY_MAX_STALENESS_MS - 1;
    source.notify(authority());
    await clock.advanceTo(DEVICE_AUTHORITY_MAX_STALENESS_MS);

    expect(invalidate).toHaveBeenCalledWith('authority.unavailable');
  });

  it('expires current authority at ten seconds when revalidation hangs', async () => {
    const { clock, source, monitor } = harness(authority(), 0);
    const admission = await monitor.prepare(authority());
    const invalidate = vi.fn();
    const lease = admission.activate({ invalidate });
    const hanging = deferred<DeviceCredentialAuthority | null>();
    source.resolveImplementation = () => hanging.promise;

    await clock.advanceTo(DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS);
    await clock.advanceTo(DEVICE_AUTHORITY_MAX_STALENESS_MS - 1);
    expect(lease.isCurrent()).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    await clock.advanceTo(DEVICE_AUTHORITY_MAX_STALENESS_MS);

    expect(lease.isCurrent()).toBe(false);
    expect(invalidate).toHaveBeenCalledWith('authority.unavailable');
  });

  it('bounds initial admission when the first post-subscription read hangs', async () => {
    const { clock, source, monitor } = harness(authority(), 0);
    const hanging = deferred<DeviceCredentialAuthority | null>();
    source.resolveImplementation = () => hanging.promise;
    const preparation = monitor.prepare(authority());

    await clock.advanceTo(DEVICE_AUTHORITY_MAX_STALENESS_MS - 1);
    await expectPending(preparation);
    await clock.advanceTo(DEVICE_AUTHORITY_MAX_STALENESS_MS);

    await expect(preparation).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
    });
    expect(source.listeners.size).toBe(0);
  });

  it('fails closed for unavailable, malformed, expired, and throwing observations', async () => {
    const unavailable = harness();
    unavailable.source.available = false;
    await expect(unavailable.monitor.prepare(authority())).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
    });
    expect(unavailable.source.events).toEqual([]);

    const malformed = harness();
    const malformedAdmission = await malformed.monitor.prepare(authority());
    const malformedInvalidate = vi.fn();
    malformedAdmission.activate({ invalidate: malformedInvalidate });
    malformed.source.notify(
      authority({
        audienceCredentialId: 'wrong.g2',
      })
    );
    expect(malformedInvalidate).toHaveBeenCalledWith('authority.unavailable');

    const expired = harness(authority({ expiresAt: 10_001 }), 10_000);
    const expiredAdmission = await expired.monitor.prepare(authority({ expiresAt: 10_001 }));
    const expiredInvalidate = vi.fn();
    expiredAdmission.activate({ invalidate: expiredInvalidate });
    expired.clock.value = 10_002;
    expired.source.notify(authority({ expiresAt: 10_001 }));
    expect(expiredInvalidate).toHaveBeenCalledWith('credential.expired');

    const throwing = harness(authority(), 0);
    const throwingAdmission = await throwing.monitor.prepare(authority());
    const throwingInvalidate = vi.fn();
    throwingAdmission.activate({ invalidate: throwingInvalidate });
    throwing.source.resolveImplementation = async () => {
      throw new Error('store unavailable');
    };
    await throwing.clock.advanceTo(DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS);
    expect(throwingInvalidate).toHaveBeenCalledWith('authority.unavailable');
  });

  it('fails closed and releases observation when timeout scheduling is unavailable', async () => {
    const source = new MutableAuthoritySource(authority());
    const monitor = new DeviceConnectionAuthorityMonitor({
      source,
      now: () => 1_000,
      scheduler: {
        schedule: () => {
          throw new Error('scheduler unavailable');
        },
        cancel: () => undefined,
      },
    });

    await expect(monitor.prepare(authority())).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
    });
    expect(source.listeners.size).toBe(0);
    expect(source.events).toEqual(['subscribe:device-1', 'unsubscribe:device-1']);
  });

  it('does not extend authority when availability disappears during resolution', async () => {
    const source = new MutableAuthoritySource(authority());
    source.resolveImplementation = async () => {
      source.available = false;
      return authority();
    };
    const monitor = new DeviceConnectionAuthorityMonitor({ source });

    await expect(monitor.prepare(authority())).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
    });
    expect(source.listeners.size).toBe(0);
  });

  it('contains scheduler cancellation faults without preserving a live subscription', async () => {
    const source = new MutableAuthoritySource(authority());
    const errors: unknown[] = [];
    let handle = 0;
    const monitor = new DeviceConnectionAuthorityMonitor({
      source,
      now: () => 1_000,
      scheduler: {
        schedule: () => {
          handle += 1;
          return handle;
        },
        cancel: () => {
          throw new Error('cancel failed');
        },
      },
      onBackgroundError: (error) => errors.push(error),
    });
    const admission = await monitor.prepare(authority());
    admission.abort();

    expect(source.listeners.size).toBe(0);
    expect(errors).not.toHaveLength(0);
  });
});
