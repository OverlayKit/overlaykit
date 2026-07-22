import { createHash } from 'crypto';
import type {
  DeviceControlFrameIdentity,
  DeviceControlFrameState,
} from '@overlaykit/protocol/device-control-frame';
import {
  DEVICE_STATE_ACK_TYPE,
  DEVICE_STATE_ACK_VERSION,
  parseDeviceStateAck,
  type DeviceStateAckErrorCode,
} from '@overlaykit/protocol/device-state-sync';
import type { ProductionBus } from '@overlaykit/protocol/production';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_DELTA_ACK_TIMEOUT_MS,
  DEVICE_DELTA_CONFIRMATION_INTERVAL_MS,
  DEVICE_DELTA_MAX_RETRIES,
  DEVICE_DELTA_SEND_TIMEOUT_MS,
  DevicePostReadySyncCoordinator,
  type DeviceConfirmedTargetBase,
  type DevicePostReadyCheckpointTarget,
  type DevicePostReadyCloseReason,
  type DevicePostReadyEmission,
  type DevicePostReadyScheduler,
  type DevicePostReadySnapshot,
  type DevicePostReadySnapshotFactory,
  type DevicePostReadyTransport,
} from '../../src/services/DevicePostReadySyncCoordinator';

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

class ManualPostReadyClock implements DevicePostReadyScheduler {
  value = 0;
  private nextHandle = 1;
  private readonly tasks = new Map<
    number,
    {
      readonly at: number;
      readonly task: () => void | Promise<void>;
    }
  >();

  schedule(at: number, task: () => void | Promise<void>): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { at, task });
    return handle;
  }

  cancel(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  async advanceTo(value: number): Promise<void> {
    if (value < this.value) throw new Error('Test clock cannot move backwards');
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

function state(
  target: ProductionBus,
  revision: number,
  confirmedAt = 0
): DeviceControlFrameState {
  return Object.freeze({
    schemaVersion: 'overlaykit-device-control-frame-state/v2',
    showId: 'show-1',
    target,
    revision,
    catalogGeneration: 1,
    confirmedAt,
    catalogHash: 'c'.repeat(64),
    controls: Object.freeze([]),
  });
}

function initialBases(
  targets: ReadonlyArray<ProductionBus>
): ReadonlyArray<DeviceConfirmedTargetBase> {
  return targets.map((target, index) => Object.freeze({
    target,
    identity: Object.freeze({
      issuerKeyId: 'server-key-1',
      sequence: index + 1,
      sha256: (index === 0 ? 'a' : 'b').repeat(64),
    }),
    state: state(target, index + 1),
    appliedAt: 0,
  }));
}

class TestSnapshotFactory implements DevicePostReadySnapshotFactory {
  issuerKeyId = 'server-key-1';
  sequence: number;
  readonly creations: Array<{
    readonly base: DeviceConfirmedTargetBase;
    readonly snapshot: DevicePostReadySnapshot;
  }> = [];
  readonly staleSequences = new Set<number>();
  private readonly revisions = new Map<ProductionBus, number>();

  constructor(
    private readonly clock: ManualPostReadyClock,
    bases: ReadonlyArray<DeviceConfirmedTargetBase>
  ) {
    this.sequence = Math.max(...bases.map(({ identity }) => identity.sequence));
    for (const base of bases) this.revisions.set(base.target, base.state.revision);
  }

  setRevision(target: ProductionBus, revision: number): void {
    this.revisions.set(target, revision);
  }

  create(base: DeviceConfirmedTargetBase): DevicePostReadySnapshot {
    this.sequence += 1;
    const nextState = state(
      base.target,
      this.revisions.get(base.target) ?? base.state.revision,
      this.clock.value
    );
    const bytes = new TextEncoder().encode(JSON.stringify({
      target: base.target,
      issuerKeyId: this.issuerKeyId,
      sequence: this.sequence,
      base: base.identity,
      revision: nextState.revision,
      confirmedAt: nextState.confirmedAt,
    }));
    const snapshot: DevicePostReadySnapshot = Object.freeze({
      issuerKeyId: this.issuerKeyId,
      sequence: this.sequence,
      bytes,
      signature: `signature-${this.sequence}`,
      base: Object.freeze({
        identity: Object.freeze({ ...base.identity }),
        state: base.state,
      }),
      state: nextState,
      evidence: Object.freeze({
        targetRevision: nextState.revision,
        catalogGeneration: nextState.catalogGeneration,
        confirmedAt: nextState.confirmedAt,
      }),
    });
    this.creations.push({ base, snapshot });
    return snapshot;
  }

  isCurrent(snapshot: DevicePostReadySnapshot): boolean {
    return snapshot.issuerKeyId === this.issuerKeyId
      && !this.staleSequences.has(snapshot.sequence);
  }

  currentIssuerKeyId(): string {
    return this.issuerKeyId;
  }
}

class TestTransport implements DevicePostReadyTransport {
  readonly emissions: DevicePostReadyEmission[] = [];
  readonly closeReasons: DevicePostReadyCloseReason[] = [];
  activeSends = 0;
  maximumActiveSends = 0;
  sendImplementation: (
    emission: DevicePostReadyEmission
  ) => void | Promise<void> = () => undefined;

  send = vi.fn(async (emission: DevicePostReadyEmission) => {
    this.emissions.push(Object.freeze({
      ...emission,
      bytes: emission.bytes.slice(),
    }));
    this.activeSends += 1;
    this.maximumActiveSends = Math.max(this.maximumActiveSends, this.activeSends);
    try {
      await this.sendImplementation(emission);
    } finally {
      this.activeSends -= 1;
    }
  });

  close = vi.fn((reason: DevicePostReadyCloseReason) => {
    this.closeReasons.push(reason);
  });
}

interface Checkpoint {
  readonly reason: DevicePostReadyCloseReason;
  readonly targets: ReadonlyArray<DevicePostReadyCheckpointTarget>;
  readonly occurredAt: number;
}

function harness(targets: ReadonlyArray<ProductionBus> = ['preview']) {
  const clock = new ManualPostReadyClock();
  const bases = initialBases(targets);
  const factory = new TestSnapshotFactory(clock, bases);
  const transport = new TestTransport();
  const readiness: Array<{ readonly target: ProductionBus; readonly ready: boolean }> = [];
  const checkpoints: Checkpoint[] = [];
  const backgroundErrors: unknown[] = [];
  const coordinator = new DevicePostReadySyncCoordinator({
    initialBases: bases,
    snapshotFactory: factory,
    transport,
    parseAck: parseDeviceStateAck,
    scheduler: clock,
    now: () => clock.value,
    onTargetReadinessChanged: (target, ready) => readiness.push({ target, ready }),
    onCheckpoint: (reason, checkpointTargets, occurredAt) => {
      checkpoints.push({ reason, targets: checkpointTargets, occurredAt });
    },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  return {
    clock,
    bases,
    factory,
    transport,
    readiness,
    checkpoints,
    backgroundErrors,
    coordinator,
  };
}

function acknowledgement(
  emission: DevicePostReadyEmission,
  status: 'applied' | 'error' = 'applied',
  errorCode: DeviceStateAckErrorCode = 'apply_failed'
): Record<string, unknown> {
  const evidence = {
    schemaVersion: DEVICE_STATE_ACK_VERSION,
    type: DEVICE_STATE_ACK_TYPE,
    mode: 'delta',
    target: emission.target,
    issuerKeyId: emission.issuerKeyId,
    sequence: emission.sequence,
    sha256: emission.sha256,
  };
  return status === 'applied'
    ? { ...evidence, status }
    : { ...evidence, status, errorCode };
}

function baseAcknowledgement(
  base: DeviceConfirmedTargetBase,
  status: 'applied' | 'error' = 'applied'
): Record<string, unknown> {
  return {
    schemaVersion: DEVICE_STATE_ACK_VERSION,
    type: DEVICE_STATE_ACK_TYPE,
    mode: 'delta',
    target: base.target,
    issuerKeyId: base.identity.issuerKeyId,
    sequence: base.identity.sequence,
    sha256: base.identity.sha256,
    status,
    ...(status === 'error' ? { errorCode: 'apply_failed' } : {}),
  };
}

function sha256(bytes: Readonly<Uint8Array>): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

async function advanceToFirstConfirmation(
  current: ReturnType<typeof harness>,
  emissionCount = 1
): Promise<void> {
  await current.clock.advanceTo(DEVICE_DELTA_CONFIRMATION_INTERVAL_MS);
  await waitFor(
    () => current.transport.emissions.length === emissionCount,
    `Expected ${emissionCount} confirmation emissions`
  );
}

function emissionIdentity(emission: DevicePostReadyEmission): DeviceControlFrameIdentity {
  return {
    issuerKeyId: emission.issuerKeyId,
    sequence: emission.sequence,
    sha256: emission.sha256,
  };
}

describe('DevicePostReadySyncCoordinator', () => {
  it('confirms every second and advances only from an exact applied acknowledgement', async () => {
    const current = harness();
    expect(current.coordinator.isTargetReady('preview')).toBe(true);

    await current.clock.advanceTo(DEVICE_DELTA_CONFIRMATION_INTERVAL_MS - 1);
    expect(current.transport.emissions).toHaveLength(0);
    await advanceToFirstConfirmation(current);
    const first = current.transport.emissions[0];

    expect(first.sha256).toBe(sha256(first.bytes));
    expect(current.coordinator.isTargetReady('preview')).toBe(false);
    expect(current.factory.creations[0].base.identity).toEqual(current.bases[0].identity);

    await current.coordinator.acknowledge(acknowledgement(first));
    await waitFor(
      () => current.coordinator.isTargetReady('preview'),
      'Applied acknowledgement did not wait for send confirmation'
    );
    expect(current.coordinator.getState().targets[0].base).toEqual(emissionIdentity(first));

    await current.clock.advanceTo(
      (2 * DEVICE_DELTA_CONFIRMATION_INTERVAL_MS) - 1
    );
    expect(current.transport.emissions).toHaveLength(1);
    await current.clock.advanceTo(2 * DEVICE_DELTA_CONFIRMATION_INTERVAL_MS);
    await waitFor(
      () => current.transport.emissions.length === 2,
      'Second confirmation was not emitted'
    );
    const second = current.transport.emissions[1];
    expect(current.factory.creations[1].base.identity).toEqual(emissionIdentity(first));

    await current.coordinator.acknowledge(acknowledgement(first));
    expect(current.coordinator.getState().targets[0].pending).toEqual(emissionIdentity(second));
    expect(current.transport.closeReasons).toEqual([]);

    await current.coordinator.dispose('transport.closed', false);
  });

  it('invalidates in-flight truth without charging a retry and ignores its late acknowledgement', async () => {
    const current = harness();
    await advanceToFirstConfirmation(current);
    const obsolete = current.transport.emissions[0];
    current.factory.setRevision('preview', 2);

    await current.coordinator.notifyStateChanged('preview');
    await waitFor(
      () => current.transport.emissions.length === 2,
      'Replacement delta was not emitted'
    );
    const replacement = current.transport.emissions[1];

    expect(current.factory.creations.map(({ base }) => base.identity)).toEqual([
      current.bases[0].identity,
      current.bases[0].identity,
    ]);
    expect(replacement.sequence).toBeGreaterThan(obsolete.sequence);
    expect(current.coordinator.getState().targets[0]).toMatchObject({
      ready: false,
      retriesUsed: 0,
      pending: emissionIdentity(replacement),
    });

    await current.coordinator.acknowledge(acknowledgement(obsolete));
    expect(current.coordinator.getState().targets[0].pending).toEqual(
      emissionIdentity(replacement)
    );
    expect(current.transport.closeReasons).toEqual([]);

    await current.coordinator.acknowledge(acknowledgement(replacement));
    expect(current.coordinator.isTargetReady('preview')).toBe(true);
    expect(current.coordinator.getState().targets[0].base).toEqual(
      emissionIdentity(replacement)
    );
    await current.coordinator.dispose('transport.closed', false);
  });

  it('uses one initial plus three exact-byte retries across error and timeout', async () => {
    const current = harness();
    current.transport.sendImplementation = (emission) => {
      (emission.bytes as Uint8Array).fill(0);
    };
    await advanceToFirstConfirmation(current);
    const initial = current.transport.emissions[0];

    await current.coordinator.acknowledge(
      acknowledgement(initial, 'error', 'base_mismatch')
    );
    await waitFor(
      () => current.transport.emissions.length === 2,
      'Application error did not trigger retry'
    );
    await waitFor(
      () => current.coordinator.getState().targets[0].retriesUsed === 1,
      'First retry was not charged'
    );

    await current.clock.advanceTo(
      DEVICE_DELTA_CONFIRMATION_INTERVAL_MS + DEVICE_DELTA_ACK_TIMEOUT_MS
    );
    await waitFor(
      () => current.transport.emissions.length === 3,
      'First timeout did not trigger retry'
    );
    await waitFor(
      () => current.coordinator.getState().targets[0].retriesUsed === 2,
      'Second retry was not charged'
    );
    await current.clock.advanceTo(
      DEVICE_DELTA_CONFIRMATION_INTERVAL_MS + (2 * DEVICE_DELTA_ACK_TIMEOUT_MS)
    );
    await waitFor(
      () => current.transport.emissions.length === 4,
      'Second timeout did not trigger final retry'
    );
    await waitFor(
      () => current.coordinator.getState().targets[0].retriesUsed === 3,
      'Final retry was not charged'
    );
    await current.clock.advanceTo(
      DEVICE_DELTA_CONFIRMATION_INTERVAL_MS + (3 * DEVICE_DELTA_ACK_TIMEOUT_MS)
    );
    await waitFor(
      () => current.transport.closeReasons.length === 1,
      'Retry exhaustion did not close transport'
    );

    expect(current.transport.emissions).toHaveLength(1 + DEVICE_DELTA_MAX_RETRIES);
    expect(current.transport.emissions.every((emission) =>
      emission.issuerKeyId === initial.issuerKeyId
      && emission.sequence === initial.sequence
      && emission.sha256 === initial.sha256
      && emission.signature === initial.signature
      && Buffer.from(emission.bytes).equals(Buffer.from(initial.bytes))
    )).toBe(true);
    expect(current.coordinator.getState().targets[0].retriesUsed).toBe(
      DEVICE_DELTA_MAX_RETRIES
    );
    expect(current.transport.closeReasons).toEqual(['delta.retries_exhausted']);
    expect(current.checkpoints).toHaveLength(1);
  });

  it('closes send rejection or deadline without consuming a target retry', async () => {
    const rejected = harness();
    rejected.transport.sendImplementation = async () => {
      throw new Error('transport rejected write');
    };
    await advanceToFirstConfirmation(rejected);
    await waitFor(
      () => rejected.transport.closeReasons.length === 1,
      'Rejected send did not close'
    );
    expect(rejected.transport.closeReasons).toEqual(['delta.transport_failure']);
    expect(rejected.coordinator.getState().targets[0].retriesUsed).toBe(0);
    expect(rejected.checkpoints).toHaveLength(1);

    const hung = harness();
    const gate = deferred<void>();
    hung.transport.sendImplementation = () => gate.promise;
    await advanceToFirstConfirmation(hung);
    await hung.clock.advanceTo(
      DEVICE_DELTA_CONFIRMATION_INTERVAL_MS + DEVICE_DELTA_SEND_TIMEOUT_MS
    );
    await waitFor(
      () => hung.transport.closeReasons.length === 1,
      'Hung send deadline did not close'
    );
    expect(hung.transport.closeReasons).toEqual(['delta.transport_failure']);
    expect(hung.coordinator.getState().targets[0].retriesUsed).toBe(0);
    gate.resolve();
  });

  it('closes when an invalidated in-flight send reaches its transport deadline', async () => {
    const current = harness();
    const gate = deferred<void>();
    current.transport.sendImplementation = () => gate.promise;

    await current.coordinator.notifyStateChanged('preview');
    await waitFor(
      () => current.transport.emissions.length === 1,
      'Initial changed-state send did not start',
    );
    current.factory.setRevision('preview', 2);
    await current.coordinator.notifyStateChanged('preview');
    await current.clock.advanceTo(DEVICE_DELTA_SEND_TIMEOUT_MS);
    await waitFor(
      () => current.transport.closeReasons.length === 1,
      'Obsolete send uncertainty did not close the transport',
    );

    expect(current.transport.emissions).toHaveLength(1);
    expect(current.transport.closeReasons).toEqual(['delta.transport_failure']);
    expect(current.coordinator.getState().targets[0].retriesUsed).toBe(0);
    expect(current.checkpoints).toHaveLength(1);
    gate.resolve();
  });

  it('serializes physical sends while preserving independent target readiness', async () => {
    const current = harness(['preview', 'program']);
    const firstSend = deferred<void>();
    let sendCount = 0;
    current.transport.sendImplementation = () => {
      sendCount += 1;
      return sendCount === 1 ? firstSend.promise : undefined;
    };

    await current.coordinator.notifyStateChanged('preview');
    await waitFor(
      () => current.transport.emissions.length === 1,
      'Preview delta did not enter transport'
    );
    expect(current.coordinator.isTargetReady('preview')).toBe(false);
    expect(current.coordinator.isTargetReady('program')).toBe(true);

    await current.coordinator.notifyStateChanged('program');
    expect(current.coordinator.isTargetReady('program')).toBe(false);
    expect(current.transport.emissions).toHaveLength(1);

    const preview = current.transport.emissions[0];
    await current.coordinator.acknowledge(acknowledgement(preview));
    expect(current.coordinator.isTargetReady('preview')).toBe(false);
    firstSend.resolve();
    await waitFor(
      () => current.transport.emissions.length === 2,
      'Program delta overlapped or never followed Preview'
    );
    await waitFor(
      () => current.coordinator.isTargetReady('preview'),
      'Early Preview acknowledgement was not applied after send confirmation'
    );

    expect(current.transport.maximumActiveSends).toBe(1);
    expect(current.transport.emissions.map(({ target }) => target)).toEqual([
      'preview',
      'program',
    ]);
    expect(current.coordinator.isTargetReady('program')).toBe(false);
    await current.coordinator.acknowledge(acknowledgement(current.transport.emissions[1]));
    await waitFor(
      () => current.coordinator.isTargetReady('program'),
      'Program acknowledgement did not wait for send confirmation'
    );
    await current.coordinator.dispose('transport.closed', false);
  });

  it('closes malformed, cross-mode, cross-target, substituted, and future acknowledgements', async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly value: (
        emission: DevicePostReadyEmission
      ) => Record<string, unknown>;
    }> = [
      {
        name: 'malformed',
        value: () => ({ type: DEVICE_STATE_ACK_TYPE }),
      },
      {
        name: 'cross-mode',
        value: (emission) => ({ ...acknowledgement(emission), mode: 'bootstrap' }),
      },
      {
        name: 'cross-target',
        value: (emission) => ({ ...acknowledgement(emission), target: 'program' }),
      },
      {
        name: 'substituted',
        value: (emission) => ({ ...acknowledgement(emission), sha256: 'f'.repeat(64) }),
      },
      {
        name: 'future',
        value: (emission) => ({
          ...acknowledgement(emission),
          sequence: emission.sequence + 1,
        }),
      },
    ];

    for (const hostile of cases) {
      const current = harness();
      await advanceToFirstConfirmation(current);
      await current.coordinator.acknowledge(
        hostile.value(current.transport.emissions[0])
      );
      expect(
        current.transport.closeReasons,
        `${hostile.name} acknowledgement remained open`
      ).toEqual(['delta.protocol_violation']);
      expect(current.checkpoints).toHaveLength(1);
    }
  });

  it('treats exact applied base as idempotent but closes an error against that base', async () => {
    const duplicate = harness();
    await advanceToFirstConfirmation(duplicate);
    await duplicate.coordinator.acknowledge(baseAcknowledgement(duplicate.bases[0]));
    expect(duplicate.transport.closeReasons).toEqual([]);
    expect(duplicate.coordinator.getState().targets[0].pending).toEqual(
      emissionIdentity(duplicate.transport.emissions[0])
    );
    await duplicate.coordinator.dispose('transport.closed', false);

    const error = harness();
    await advanceToFirstConfirmation(error);
    await error.coordinator.acknowledge(baseAcknowledgement(error.bases[0], 'error'));
    expect(error.transport.closeReasons).toEqual(['delta.protocol_violation']);
  });

  it('closes on issuer rotation before issuing a delta', async () => {
    const current = harness();
    current.factory.issuerKeyId = 'server-key-2';

    await current.coordinator.notifyStateChanged('preview');
    await waitFor(
      () => current.transport.closeReasons.length === 1,
      'Issuer rotation did not close'
    );
    expect(current.transport.emissions).toHaveLength(0);
    expect(current.transport.closeReasons).toEqual(['delta.issuer_rotated']);
    expect(current.checkpoints[0].targets[0]).toMatchObject({
      target: 'preview',
      issuerKeyId: 'server-key-1',
      sequence: 1,
      sha256: 'a'.repeat(64),
    });
  });

  it('writes one bounded checkpoint only for graceful in-process closure', async () => {
    const graceful = harness(['preview', 'program']);
    await graceful.coordinator.dispose('transport.closed', true);
    await graceful.coordinator.dispose('transport.closed', true);

    expect(graceful.checkpoints).toHaveLength(1);
    expect(graceful.checkpoints[0]).toEqual({
      reason: 'transport.closed',
      occurredAt: 0,
      targets: [
        {
          target: 'preview',
          issuerKeyId: 'server-key-1',
          sequence: 1,
          sha256: 'a'.repeat(64),
          targetRevision: 1,
          catalogGeneration: 1,
          appliedAt: 0,
        },
        {
          target: 'program',
          issuerKeyId: 'server-key-1',
          sequence: 2,
          sha256: 'b'.repeat(64),
          targetRevision: 2,
          catalogGeneration: 1,
          appliedAt: 0,
        },
      ],
    });
    expect(graceful.transport.close).not.toHaveBeenCalled();

    const abrupt = harness();
    await abrupt.coordinator.dispose('transport.closed', false);
    expect(abrupt.checkpoints).toEqual([]);
    expect(abrupt.coordinator.getState().closeReason).toBe('transport.closed');
  });
});
