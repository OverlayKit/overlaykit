import { describe, expect, it, vi } from 'vitest';
import {
  DeviceConnectionAuthorityCoordinator,
  type DeviceAuthorityConnection,
  type DeviceAuthorityScheduler,
  type DeviceConnectionAuthority,
  type DeviceConnectionCloseReason,
} from '../../src/services/DeviceConnectionAuthorityCoordinator';

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

class ManualAuthorityClock implements DeviceAuthorityScheduler {
  value: number;
  private nextHandle = 1;
  private readonly tasks = new Map<number, { at: number; task: () => Promise<void> }>();

  constructor(initialValue = 1_000) {
    this.value = initialValue;
  }

  schedule(at: number, task: () => Promise<void>): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { at, task });
    return handle;
  }

  cancel(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
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
      if (!due) return;
      this.tasks.delete(due[0]);
      await due[1].task();
    }
  }
}

class TestConnection implements DeviceAuthorityConnection {
  readonly reasons: DeviceConnectionCloseReason[] = [];
  closeImplementation: (reason: DeviceConnectionCloseReason) => void | Promise<void> = () =>
    undefined;

  constructor(readonly id: string) {}

  close = vi.fn((reason: DeviceConnectionCloseReason) => {
    this.reasons.push(reason);
    return this.closeImplementation(reason);
  });
}

function authority(overrides: Partial<DeviceConnectionAuthority> = {}): DeviceConnectionAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g1',
    generation: 1,
    showId: 'show-1',
    expiresAt: 10_000,
    ...overrides,
  };
}

function harness(initialTime = 1_000): {
  clock: ManualAuthorityClock;
  coordinator: DeviceConnectionAuthorityCoordinator;
  backgroundErrors: unknown[];
} {
  const clock = new ManualAuthorityClock(initialTime);
  const backgroundErrors: unknown[] = [];
  const coordinator = new DeviceConnectionAuthorityCoordinator({
    now: () => clock.value,
    scheduler: clock,
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  return { clock, coordinator, backgroundErrors };
}

async function flushTransitions(): Promise<void> {
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
  await flushTransitions();
  expect(settled).toBe(false);
}

describe('DeviceConnectionAuthorityCoordinator', () => {
  it('captures immutable authority and starts admitted work synchronously', async () => {
    const { coordinator } = harness();
    const mutableAuthority = authority() as DeviceConnectionAuthority & {
      audienceCredentialId: string;
      expiresAt: number;
      showId: string;
    };
    const mutableConnection = new TestConnection('connection-1') as TestConnection & {
      id: string;
    };
    const leasePromise = coordinator.connect(mutableAuthority, mutableConnection);
    mutableAuthority.audienceCredentialId = 'attacker.g99';
    mutableAuthority.expiresAt = 99_999;
    mutableAuthority.showId = 'attacker-show';
    mutableConnection.id = 'attacker-connection';

    const lease = await leasePromise;
    expect(lease).toEqual({
      connectionId: 'connection-1',
      authority: authority(),
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.authority)).toBe(true);

    const operationGate = deferred<string>();
    let started = false;
    const operation = coordinator.execute(lease, () => {
      started = true;
      return operationGate.promise;
    });
    expect(started).toBe(true);
    expect(coordinator.isEffective(lease)).toBe(true);
    operationGate.resolve('complete');
    await expect(operation).resolves.toBe('complete');
  });

  it('rejects malformed, expired, conflicting, and forged authority without activation', async () => {
    const { coordinator } = harness();
    const malformed = new TestConnection('malformed');
    await expect(
      coordinator.connect(
        authority({
          audienceCredentialId: 'device-1.g2',
        }),
        malformed
      )
    ).rejects.toMatchObject({
      code: 'INVALID_DEVICE_CONNECTION_AUTHORITY',
    });
    expect(malformed.reasons).toEqual(['authority.rejected']);

    const expired = new TestConnection('expired');
    await expect(
      coordinator.connect(authority({ expiresAt: 1_000 }), expired)
    ).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_EXPIRED',
    });
    expect(expired.reasons).toEqual(['credential.expired']);

    const active = await coordinator.connect(authority(), new TestConnection('active'));
    const conflictingShow = new TestConnection('wrong-show');
    await expect(
      coordinator.connect(authority({ showId: 'show-2' }), conflictingShow)
    ).rejects.toMatchObject({ code: 'DEVICE_AUTHORITY_IDENTITY_CONFLICT' });
    expect(conflictingShow.reasons).toEqual(['authority.rejected']);

    const conflictingExpiry = new TestConnection('wrong-expiry');
    await expect(
      coordinator.connect(authority({ expiresAt: 20_000 }), conflictingExpiry)
    ).rejects.toMatchObject({ code: 'DEVICE_AUTHORITY_IDENTITY_CONFLICT' });
    expect(conflictingExpiry.reasons).toEqual(['authority.rejected']);

    const forged = {
      connectionId: active.connectionId,
      authority: active.authority,
    };
    await expect(coordinator.execute(forged, () => 'forged')).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
    expect(coordinator.isEffective(active)).toBe(true);
  });

  it('replaces only after closing and draining the old connection', async () => {
    const { coordinator } = harness();
    const oldConnection = new TestConnection('old');
    const closeGate = deferred<void>();
    oldConnection.closeImplementation = () => closeGate.promise;
    const oldLease = await coordinator.connect(authority(), oldConnection);
    const operationGate = deferred<void>();
    const running = coordinator.execute(oldLease, () => operationGate.promise);

    const replacementConnection = new TestConnection('replacement');
    const replacement = coordinator.connect(authority(), replacementConnection);
    const queuedOperation = vi.fn(() => 'must-not-start');
    await expect(coordinator.execute(oldLease, queuedOperation)).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
    expect(queuedOperation).not.toHaveBeenCalled();
    await flushTransitions();
    expect(oldConnection.reasons).toEqual(['replaced']);
    await expectPending(replacement);

    closeGate.resolve();
    await expectPending(replacement);
    operationGate.resolve();
    await running;
    const replacementLease = await replacement;

    expect(coordinator.isEffective(oldLease)).toBe(false);
    expect(coordinator.isEffective(replacementLease)).toBe(true);
    await expect(coordinator.execute(oldLease, () => undefined)).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
  });

  it('serializes overlapping replacements without exposing an intermediate lease', async () => {
    const { coordinator } = harness();
    const firstConnection = new TestConnection('first');
    await coordinator.connect(authority(), firstConnection);
    const secondConnection = new TestConnection('second');
    const thirdConnection = new TestConnection('third');

    const secondPromise = coordinator.connect(authority(), secondConnection);
    const thirdPromise = coordinator.connect(authority(), thirdConnection);
    const secondLease = await secondPromise;
    expect(coordinator.isEffective(secondLease)).toBe(false);
    const thirdLease = await thirdPromise;

    expect(firstConnection.reasons).toEqual(['replaced']);
    expect(secondConnection.reasons).toEqual(['replaced']);
    expect(thirdConnection.reasons).toEqual([]);
    expect(coordinator.isEffective(secondLease)).toBe(false);
    expect(coordinator.isEffective(thirdLease)).toBe(true);
  });

  it('makes revocation wait for begun work and transport close while denying queued work', async () => {
    const { coordinator } = harness();
    const connection = new TestConnection('revoked');
    const closeGate = deferred<void>();
    connection.closeImplementation = () => closeGate.promise;
    const lease = await coordinator.connect(authority(), connection);
    const operationGate = deferred<void>();
    const running = coordinator.execute(lease, () => operationGate.promise);

    const revocation = coordinator.revokeCredential('device-1');
    const queuedOperation = vi.fn(() => undefined);
    await expect(coordinator.execute(lease, queuedOperation)).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
    expect(queuedOperation).not.toHaveBeenCalled();
    await flushTransitions();
    expect(connection.reasons).toEqual(['credential.revoked']);
    await expectPending(revocation);

    operationGate.resolve();
    await running;
    await expectPending(revocation);
    closeGate.resolve();
    await revocation;
    expect(coordinator.isEffective(lease)).toBe(false);

    const rejected = new TestConnection('revoked-reconnect');
    await expect(
      coordinator.connect(
        authority({
          audienceCredentialId: 'device-1.g2',
          generation: 2,
        }),
        rejected
      )
    ).rejects.toMatchObject({ code: 'DEVICE_AUTHORITY_BLOCKED' });
    expect(rejected.reasons).toEqual(['credential.revoked']);
    await expect(coordinator.revokeCredential('device-1')).resolves.toBeUndefined();
  });

  it('retires one exact lease immediately as a barrier while admitted work drains', async () => {
    const { coordinator } = harness();
    const connection = new TestConnection('monitored');
    const closeGate = deferred<void>();
    connection.closeImplementation = () => closeGate.promise;
    const lease = await coordinator.connect(authority(), connection);
    const operationGate = deferred<void>();
    const running = coordinator.execute(lease, () => operationGate.promise);

    const retirement = coordinator.retire(lease, 'authority.changed');
    await expect(coordinator.retire(lease, 'authority.unavailable')).resolves.toBeUndefined();
    const queued = vi.fn(() => 'must-not-start');
    await expect(coordinator.execute(lease, queued)).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
    expect(queued).not.toHaveBeenCalled();
    await flushTransitions();
    expect(connection.reasons).toEqual(['authority.changed']);
    await expectPending(retirement);

    operationGate.resolve();
    await running;
    await expectPending(retirement);
    closeGate.resolve();
    await retirement;
    expect(coordinator.isEffective(lease)).toBe(false);

    const replacement = await coordinator.connect(
      authority(),
      new TestConnection('new-connection')
    );
    expect(coordinator.isEffective(replacement)).toBe(true);
    await expect(coordinator.retire(lease, 'authority.changed')).resolves.toBeUndefined();
  });

  it('checks a currency witness at the linearizable slot installation boundary', async () => {
    const { coordinator } = harness();
    const rejected = new TestConnection('stale-immediate');
    await expect(coordinator.connect(authority(), rejected, () => false)).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_BLOCKED',
    });
    expect(rejected.reasons).toEqual(['authority.changed']);

    const currentConnection = new TestConnection('current');
    await coordinator.connect(authority(), currentConnection);
    const closeGate = deferred<void>();
    currentConnection.closeImplementation = () => closeGate.promise;
    let current = true;
    const incoming = new TestConnection('raced');
    const replacement = coordinator.connect(authority(), incoming, () => current);
    await flushTransitions();
    expect(currentConnection.reasons).toEqual(['replaced']);

    current = false;
    closeGate.resolve();
    await expect(replacement).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_BLOCKED',
    });
    expect(incoming.reasons).toEqual(['authority.changed']);

    const isolated = harness().coordinator;
    let raceCurrent = true;
    const stale = isolated.connect(
      authority({ showId: 'stale-show' }),
      new TestConnection('stale-before-slot'),
      () => raceCurrent
    );
    raceCurrent = false;
    await expect(stale).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_BLOCKED',
    });
    const cleanLease = await isolated.connect(
      authority({ showId: 'clean-show' }),
      new TestConnection('clean-after-race')
    );
    expect(cleanLease.authority.showId).toBe('clean-show');
  });

  it('retires a rotated generation before admitting its successor', async () => {
    const { coordinator } = harness();
    const oldConnection = new TestConnection('generation-1');
    const oldLease = await coordinator.connect(authority(), oldConnection);

    const rotation = coordinator.rotateCredential('device-1', 1);
    const successorConnection = new TestConnection('generation-2');
    const successor = coordinator.connect(
      authority({
        audienceCredentialId: 'device-1.g2',
        generation: 2,
      }),
      successorConnection
    );
    const staleConnection = new TestConnection('stale-generation');
    await expect(coordinator.connect(authority(), staleConnection)).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_BLOCKED',
    });

    await rotation;
    const successorLease = await successor;
    expect(oldConnection.reasons).toEqual(['credential.rotated']);
    expect(staleConnection.reasons).toEqual(['credential.rotated']);
    expect(coordinator.isEffective(oldLease)).toBe(false);
    expect(coordinator.isEffective(successorLease)).toBe(true);

    await coordinator.rotateCredential('device-1', 1);
    expect(successorConnection.reasons).toEqual([]);
    expect(coordinator.isEffective(successorLease)).toBe(true);
  });

  it('closes at the exact expiration without requiring traffic', async () => {
    const { clock, coordinator, backgroundErrors } = harness(100);
    const connection = new TestConnection('expiring');
    const lease = await coordinator.connect(authority({ expiresAt: 200 }), connection);

    await clock.advanceTo(199);
    expect(coordinator.isEffective(lease)).toBe(true);
    expect(connection.reasons).toEqual([]);
    await clock.advanceTo(200);

    expect(connection.reasons).toEqual(['credential.expired']);
    expect(coordinator.isEffective(lease)).toBe(false);
    expect(backgroundErrors).toEqual([]);
    await expect(coordinator.execute(lease, () => 'late')).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
  });

  it('starts expiration close at the deadline and waits for begun work to drain', async () => {
    const { clock, coordinator } = harness(100);
    const connection = new TestConnection('expiring-with-work');
    const lease = await coordinator.connect(authority({ expiresAt: 200 }), connection);
    const operationGate = deferred<void>();
    const running = coordinator.execute(lease, () => operationGate.promise);

    const expiration = clock.advanceTo(200);
    await flushTransitions();
    expect(connection.reasons).toEqual(['credential.expired']);
    await expectPending(expiration);
    const queued = vi.fn(() => undefined);
    await expect(coordinator.execute(lease, queued)).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_NOT_ACTIVE',
    });
    expect(queued).not.toHaveBeenCalled();

    operationGate.resolve();
    await running;
    await expiration;
    expect(coordinator.isEffective(lease)).toBe(false);
  });

  it('expires defensively at admission even when a scheduler has not fired', async () => {
    const clock = new ManualAuthorityClock(100);
    const scheduler: DeviceAuthorityScheduler = {
      schedule: () => 1,
      cancel: () => undefined,
    };
    const errors: unknown[] = [];
    const coordinator = new DeviceConnectionAuthorityCoordinator({
      now: () => clock.value,
      scheduler,
      onBackgroundError: (error) => errors.push(error),
    });
    const connection = new TestConnection('late-timer');
    const lease = await coordinator.connect(authority({ expiresAt: 200 }), connection);
    clock.value = 200;

    const operation = vi.fn(() => 'late');
    await expect(coordinator.execute(lease, operation)).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_EXPIRED',
    });
    expect(operation).not.toHaveBeenCalled();
    await flushTransitions();
    expect(connection.reasons).toEqual(['credential.expired']);
    expect(errors).toEqual([]);
  });

  it('archives every known connection for one Show without blocking another Show', async () => {
    const { coordinator } = harness();
    const firstConnection = new TestConnection('show-1-a');
    const secondConnection = new TestConnection('show-1-b');
    const otherConnection = new TestConnection('show-2');
    const firstLease = await coordinator.connect(authority(), firstConnection);
    const secondLease = await coordinator.connect(
      authority({
        credentialId: 'device-2',
        audienceCredentialId: 'device-2.g1',
      }),
      secondConnection
    );
    const otherLease = await coordinator.connect(
      authority({
        credentialId: 'device-3',
        audienceCredentialId: 'device-3.g1',
        showId: 'show-2',
      }),
      otherConnection
    );
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstOperation = coordinator.execute(firstLease, () => firstGate.promise);
    const secondOperation = coordinator.execute(secondLease, () => secondGate.promise);

    const archive = coordinator.archiveShow('show-1');
    await flushTransitions();
    expect(firstConnection.reasons).toEqual(['show.archived']);
    expect(secondConnection.reasons).toEqual(['show.archived']);
    await expectPending(archive);
    await expect(coordinator.execute(otherLease, () => 'other-show')).resolves.toBe('other-show');

    const lateConnection = new TestConnection('late-show-1');
    await expect(
      coordinator.connect(
        authority({
          credentialId: 'device-4',
          audienceCredentialId: 'device-4.g1',
        }),
        lateConnection
      )
    ).rejects.toMatchObject({ code: 'DEVICE_AUTHORITY_BLOCKED' });
    expect(lateConnection.reasons).toEqual(['show.archived']);

    firstGate.resolve();
    await firstOperation;
    await expectPending(archive);
    secondGate.resolve();
    await secondOperation;
    await archive;
    expect(coordinator.isEffective(firstLease)).toBe(false);
    expect(coordinator.isEffective(secondLease)).toBe(false);
    expect(coordinator.isEffective(otherLease)).toBe(true);
    await expect(coordinator.archiveShow('show-1')).resolves.toBeUndefined();
  });

  it('waits for every Show connection even when one archival close fails', async () => {
    const { coordinator } = harness();
    const failedConnection = new TestConnection('archive-failure');
    failedConnection.closeImplementation = () => {
      throw new Error('cannot close');
    };
    const delayedConnection = new TestConnection('archive-delayed');
    const closeGate = deferred<void>();
    delayedConnection.closeImplementation = () => closeGate.promise;
    const failedLease = await coordinator.connect(authority(), failedConnection);
    const delayedLease = await coordinator.connect(
      authority({
        credentialId: 'device-2',
        audienceCredentialId: 'device-2.g1',
      }),
      delayedConnection
    );

    const archive = coordinator.archiveShow('show-1');
    await flushTransitions();
    expect(failedConnection.reasons).toEqual(['show.archived']);
    expect(delayedConnection.reasons).toEqual(['show.archived']);
    await expectPending(archive);
    closeGate.resolve();

    await expect(archive).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_CLOSE_FAILED',
    });
    expect(coordinator.isEffective(failedLease)).toBe(false);
    expect(coordinator.isEffective(delayedLease)).toBe(false);
  });

  it('keeps another credential operational while one replacement drains', async () => {
    const { coordinator } = harness();
    const first = await coordinator.connect(authority(), new TestConnection('first'));
    const second = await coordinator.connect(
      authority({
        credentialId: 'device-2',
        audienceCredentialId: 'device-2.g1',
        showId: 'show-2',
      }),
      new TestConnection('second')
    );
    const operationGate = deferred<void>();
    const running = coordinator.execute(first, () => operationGate.promise);

    const replacement = coordinator.connect(authority(), new TestConnection('first-new'));
    await expectPending(replacement);
    await expect(coordinator.execute(second, () => 'still-live')).resolves.toBe('still-live');
    operationGate.resolve();
    await running;
    await replacement;
  });

  it('does not reactivate a lease or report success when transport close fails', async () => {
    const { coordinator } = harness();
    const oldConnection = new TestConnection('close-failure');
    oldConnection.closeImplementation = () => {
      throw new Error('transport failed');
    };
    const oldLease = await coordinator.connect(authority(), oldConnection);
    const incoming = new TestConnection('incoming');

    await expect(coordinator.connect(authority(), incoming)).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_CLOSE_FAILED',
    });
    expect(oldConnection.reasons).toEqual(['replaced']);
    expect(incoming.reasons).toEqual(['authority.rejected']);
    expect(coordinator.isEffective(oldLease)).toBe(false);

    await expect(coordinator.revokeCredential('device-1')).rejects.toMatchObject({
      code: 'DEVICE_CONNECTION_CLOSE_FAILED',
    });
    oldConnection.closeImplementation = () => undefined;
    await expect(coordinator.revokeCredential('device-1')).resolves.toBeUndefined();
    expect(oldConnection.reasons).toEqual(['replaced', 'credential.revoked', 'credential.revoked']);
    expect(coordinator.isEffective(oldLease)).toBe(false);
  });

  it('fails closed when exact expiration cannot be scheduled', async () => {
    const connection = new TestConnection('unscheduled');
    const coordinator = new DeviceConnectionAuthorityCoordinator({
      now: () => 1_000,
      scheduler: {
        schedule: () => {
          throw new Error('scheduler unavailable');
        },
        cancel: () => undefined,
      },
    });

    await expect(coordinator.connect(authority(), connection)).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_SCHEDULING_FAILED',
    });
    expect(connection.reasons).toEqual(['authority.rejected']);
  });

  it('releases thrown and rejected operations but waits indefinitely for unsettled work', async () => {
    const { coordinator } = harness();
    const connection = new TestConnection('operation-failures');
    const lease = await coordinator.connect(authority(), connection);
    await expect(
      coordinator.execute(lease, () => {
        throw new Error('sync failure');
      })
    ).rejects.toThrow('sync failure');
    await expect(
      coordinator.execute(lease, async () => {
        throw new Error('async failure');
      })
    ).rejects.toThrow('async failure');

    const neverGate = deferred<void>();
    const running = coordinator.execute(lease, () => neverGate.promise);
    const barrier = coordinator.revokeCredential('device-1');
    await expectPending(barrier);
    neverGate.resolve();
    await running;
    await expect(barrier).resolves.toBeUndefined();
  });

  it('closes admission immediately and drains only already-admitted work during shutdown', async () => {
    const { coordinator } = harness();
    const connection = new TestConnection('active');
    const lease = await coordinator.connect(authority(), connection);
    const operationGate = deferred<void>();
    const running = coordinator.execute(lease, () => operationGate.promise);

    const shutdown = coordinator.shutdown();
    expect(coordinator.isEffective(lease)).toBe(false);
    await expectPending(shutdown);
    const rejected = new TestConnection('late');
    await expect(coordinator.connect(authority(), rejected)).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_BLOCKED',
    });
    expect(rejected.reasons).toEqual(['server.shutdown']);

    operationGate.resolve();
    await running;
    await expect(shutdown).resolves.toBeUndefined();
    expect(connection.reasons).toEqual(['server.shutdown']);
  });

  it('rejects invalid construction and bounded identifiers', async () => {
    expect(
      () =>
        new DeviceConnectionAuthorityCoordinator({
          now: () => Number.NaN,
        })
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_DEVICE_CONNECTION_AUTHORITY',
      })
    );

    const { coordinator } = harness();
    const cases: DeviceConnectionAuthority[] = [
      authority({ generation: 0 }),
      authority({ credentialId: ' '.repeat(1) }),
      authority({ showId: 's'.repeat(201) }),
      authority({ expiresAt: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    for (const [index, invalidAuthority] of cases.entries()) {
      const connection = new TestConnection(`invalid-${index}`);
      await expect(coordinator.connect(invalidAuthority, connection)).rejects.toMatchObject({
        code: 'INVALID_DEVICE_CONNECTION_AUTHORITY',
      });
      expect(connection.reasons).toEqual(['authority.rejected']);
    }
  });
});
