import { createHash } from 'node:crypto';
import {
  DEVICE_BOOTSTRAP_ACK_ERROR_CODES,
  DEVICE_BOOTSTRAP_ACK_TYPE,
  DEVICE_BOOTSTRAP_ACK_VERSION,
  parseDeviceBootstrapAck,
  type DeviceBootstrapAckErrorCode,
} from '@overlaykit/protocol/device-bootstrap';
import type { ProductionBus } from '@overlaykit/protocol/production';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS,
  DEVICE_BOOTSTRAP_DEADLINE_MS,
  DeviceBootstrapReadinessCoordinator,
  createDeviceBootstrapReadinessCoordinator,
  type DeviceBootstrapCloseReason,
  type DeviceBootstrapEmission,
  type DeviceBootstrapScheduler,
  type DeviceBootstrapSnapshot,
  type DeviceBootstrapSnapshotFactory,
  type DeviceBootstrapTransport,
} from '../../src/services/DeviceBootstrapReadinessCoordinator';

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

class ManualBootstrapClock implements DeviceBootstrapScheduler {
  value: number;
  private nextHandle = 1;
  private readonly tasks = new Map<
    number,
    {
      readonly at: number;
      readonly task: () => void | Promise<void>;
    }
  >();

  constructor(initialValue = 1_000) {
    this.value = initialValue;
  }

  schedule(at: number, task: () => void | Promise<void>): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { at, task });
    return handle;
  }

  cancel(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  hasTaskAt(value: number): boolean {
    return [...this.tasks.values()].some(({ at }) => at === value);
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

class TestSnapshotFactory implements DeviceBootstrapSnapshotFactory {
  sequence = 0;
  readonly calls: ProductionBus[] = [];
  readonly sourceBytes: Uint8Array[] = [];
  readonly staleSequences = new Set<number>();

  create(target: ProductionBus): DeviceBootstrapSnapshot {
    this.calls.push(target);
    this.sequence += 1;
    const bytes = new TextEncoder().encode(
      `signed-snapshot:${this.sequence}:${target}:${this.calls.length}`
    );
    this.sourceBytes.push(bytes);
    return {
      issuerKeyId: 'server-key-1',
      sequence: this.sequence,
      bytes,
      signature: `signature-${this.sequence}`,
    };
  }

  isCurrent(snapshot: DeviceBootstrapSnapshot): boolean {
    return !this.staleSequences.has(snapshot.sequence);
  }
}

class TestTransport implements DeviceBootstrapTransport {
  readonly emissions: DeviceBootstrapEmission[] = [];
  readonly closeReasons: DeviceBootstrapCloseReason[] = [];
  sendFailures = 0;
  sendImplementation: (emission: DeviceBootstrapEmission) => void | Promise<void> = () => undefined;
  closeImplementation: (reason: DeviceBootstrapCloseReason) => void | Promise<void> = () =>
    undefined;

  send = vi.fn(async (emission: DeviceBootstrapEmission) => {
    this.emissions.push(
      Object.freeze({
        ...emission,
        bytes: emission.bytes.slice(),
      })
    );
    if (this.sendFailures > 0) {
      this.sendFailures -= 1;
      throw new Error('send failed');
    }
    await this.sendImplementation(emission);
  });

  close = vi.fn((reason: DeviceBootstrapCloseReason) => {
    this.closeReasons.push(reason);
    return this.closeImplementation(reason);
  });
}

function sha256(bytes: Readonly<Uint8Array>): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function acknowledgement(
  emission: DeviceBootstrapEmission,
  status: 'applied' | 'error' = 'applied',
  errorCode: DeviceBootstrapAckErrorCode = 'apply_failed'
): Record<string, unknown> {
  return status === 'applied'
    ? {
        schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
        type: DEVICE_BOOTSTRAP_ACK_TYPE,
        mode: 'bootstrap',
        target: emission.target,
        issuerKeyId: emission.issuerKeyId,
        sequence: emission.sequence,
        sha256: emission.sha256,
        status,
      }
    : {
        schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
        type: DEVICE_BOOTSTRAP_ACK_TYPE,
        mode: 'bootstrap',
        target: emission.target,
        issuerKeyId: emission.issuerKeyId,
        sequence: emission.sequence,
        sha256: emission.sha256,
        status,
        errorCode,
      };
}

function unknownAcknowledgement(
  target: ProductionBus,
  sha = 'f'.repeat(64)
): Record<string, unknown> {
  return {
    schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
    type: DEVICE_BOOTSTRAP_ACK_TYPE,
    mode: 'bootstrap',
    target,
    issuerKeyId: 'server-key-1',
    sequence: 1,
    sha256: sha,
    status: 'applied',
  };
}

function harness(
  targets: ReadonlyArray<ProductionBus> = ['preview'],
  overrides: Partial<{
    snapshotFactory: DeviceBootstrapSnapshotFactory;
    transport: DeviceBootstrapTransport;
    hash: (bytes: Uint8Array) => string | Promise<string>;
    scheduler: DeviceBootstrapScheduler;
    now: () => number;
  }> = {}
): {
  readonly clock: ManualBootstrapClock;
  readonly factory: TestSnapshotFactory;
  readonly transport: TestTransport;
  readonly backgroundErrors: unknown[];
  readonly coordinator: DeviceBootstrapReadinessCoordinator;
} {
  const clock = new ManualBootstrapClock();
  const factory = new TestSnapshotFactory();
  const transport = new TestTransport();
  const backgroundErrors: unknown[] = [];
  const coordinator = new DeviceBootstrapReadinessCoordinator({
    targets,
    snapshotFactory: overrides.snapshotFactory ?? factory,
    transport: overrides.transport ?? transport,
    parseAck: parseDeviceBootstrapAck,
    hash: overrides.hash,
    scheduler: overrides.scheduler ?? clock,
    now: overrides.now ?? (() => clock.value),
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  return { clock, factory, transport, backgroundErrors, coordinator };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

async function startAndWait(
  coordinator: DeviceBootstrapReadinessCoordinator,
  transport: TestTransport,
  emissionCount: number
): Promise<void> {
  await coordinator.start();
  await waitFor(
    () => transport.emissions.length === emissionCount,
    `Expected ${emissionCount} bootstrap emissions`
  );
}

describe('DeviceBootstrapReadinessCoordinator', () => {
  it('serializes exact copied bytes and requires current application for every target', async () => {
    const { clock, coordinator, factory, transport } = harness(['preview', 'program']);
    await startAndWait(coordinator, transport, 2);

    expect(transport.emissions.map(({ target, sequence }) => ({ target, sequence }))).toEqual([
      { target: 'preview', sequence: 1 },
      { target: 'program', sequence: 2 },
    ]);
    for (const emission of transport.emissions) {
      expect(emission.sha256).toBe(sha256(emission.bytes));
    }
    const transmitted = Buffer.from(transport.emissions[0].bytes).toString('utf8');
    factory.sourceBytes[0].fill(0);
    expect(Buffer.from(transport.emissions[0].bytes).toString('utf8')).toBe(transmitted);

    await coordinator.acknowledge(acknowledgement(transport.emissions[0]));
    expect(coordinator.isReady()).toBe(false);
    await coordinator.acknowledge(acknowledgement(transport.emissions[1]));

    expect(coordinator.isReady()).toBe(true);
    expect(Object.isFrozen(coordinator.getState())).toBe(true);
    expect(coordinator.getState().targets.map((target) => target.appliedSha256)).toEqual([
      transport.emissions[0].sha256,
      transport.emissions[1].sha256,
    ]);
    await clock.advanceTo(1_000 + DEVICE_BOOTSTRAP_DEADLINE_MS);
    expect(transport.closeReasons).toEqual([]);
  });

  it('requires transport send confirmation as well as an applied acknowledgement', async () => {
    const sendGate = deferred<void>();
    const transport = new TestTransport();
    transport.sendImplementation = () => sendGate.promise;
    const { coordinator } = harness(['preview'], { transport });
    await coordinator.start();
    await waitFor(() => transport.emissions.length === 1, 'Snapshot was not offered to transport');

    await coordinator.acknowledge(acknowledgement(transport.emissions[0]));
    expect(coordinator.getState().targets[0].appliedSha256).toBe(transport.emissions[0].sha256);
    expect(coordinator.isReady()).toBe(false);

    sendGate.resolve();
    await waitFor(() => coordinator.isReady(), 'Send confirmation did not grant readiness');
    expect(transport.closeReasons).toEqual([]);
  });

  it('never overlaps target capture and rejects a non-increasing global sequence', async () => {
    const gate = deferred<DeviceBootstrapSnapshot>();
    let active = 0;
    let maximumActive = 0;
    const calls: ProductionBus[] = [];
    const snapshotFactory: DeviceBootstrapSnapshotFactory = {
      isCurrent: () => true,
      async create(target) {
        calls.push(target);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (target === 'preview') return await gate.promise;
          return {
            issuerKeyId: 'server-key-1',
            sequence: 1,
            bytes: new TextEncoder().encode('program-sequence-one'),
            signature: 'signature-1',
          };
        } finally {
          active -= 1;
        }
      },
    };
    const { coordinator, transport } = harness(['preview', 'program'], { snapshotFactory });
    await coordinator.start();
    await waitFor(() => calls.length === 1, 'Preview capture did not start');
    expect(calls).toEqual(['preview']);

    gate.resolve({
      issuerKeyId: 'server-key-1',
      sequence: 2,
      bytes: new TextEncoder().encode('preview-sequence-two'),
      signature: 'signature-2',
    });
    await waitFor(() => transport.closeReasons.length === 1, 'Invalid sequence did not close');

    expect(calls).toEqual(['preview', 'program']);
    expect(maximumActive).toBe(1);
    expect(transport.emissions).toHaveLength(1);
    expect(transport.closeReasons).toEqual(['bootstrap.internal_error']);
    expect(coordinator.isReady()).toBe(false);
  });

  it('charges every bounded application error to the same target retry lane', async () => {
    for (const errorCode of DEVICE_BOOTSTRAP_ACK_ERROR_CODES) {
      const { coordinator, transport } = harness();
      await startAndWait(coordinator, transport, 1);
      await coordinator.acknowledge(acknowledgement(transport.emissions[0], 'error', errorCode));
      await waitFor(() => transport.emissions.length === 2, 'Retry emission was not sent');

      expect(coordinator.getState().targets[0].retriesUsed).toBe(1);
      expect(transport.closeReasons).toEqual([]);
    }
  });

  it('shares send, timeout, and application failure under one initial plus three attempts', async () => {
    const { clock, coordinator, transport } = harness();
    await startAndWait(coordinator, transport, 1);

    await coordinator.acknowledge(acknowledgement(transport.emissions[0], 'error'));
    await waitFor(() => transport.emissions.length === 2, 'Application retry was not sent');
    await waitFor(
      () => clock.hasTaskAt(1_000 + DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS),
      'Retry acknowledgement timeout was not scheduled'
    );

    await clock.advanceTo(1_000 + DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS - 1);
    expect(transport.emissions).toHaveLength(2);
    transport.sendFailures = 1;
    await clock.advanceTo(1_000 + DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS);
    await waitFor(() => transport.emissions.length === 4, 'Timeout and send retries were not sent');

    await coordinator.acknowledge(acknowledgement(transport.emissions[3], 'error'));
    expect(transport.emissions.map((emission) => emission.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(transport.emissions.map((emission) => emission.sha256)).size).toBe(4);
    expect(coordinator.getState().targets[0].retriesUsed).toBe(3);
    expect(transport.closeReasons).toEqual(['bootstrap.retries_exhausted']);
    expect(coordinator.isReady()).toBe(false);
  });

  it('processes target acknowledgements and timeouts while another target capture is hung', async () => {
    const programGate = deferred<DeviceBootstrapSnapshot>();
    let sequence = 0;
    let programStarted = false;
    const snapshotFactory: DeviceBootstrapSnapshotFactory = {
      isCurrent: () => true,
      async create(target) {
        sequence += 1;
        if (target === 'program') {
          programStarted = true;
          return programGate.promise;
        }
        return {
          issuerKeyId: 'server-key-1',
          sequence,
          bytes: new TextEncoder().encode(`preview:${sequence}`),
          signature: `signature-${sequence}`,
        };
      },
    };
    const { clock, coordinator, transport } = harness(['preview', 'program'], { snapshotFactory });
    await coordinator.start();
    await waitFor(() => transport.emissions.length === 1, 'Preview was not emitted');
    await waitFor(() => programStarted, 'Program capture did not start');
    await waitFor(
      () => clock.hasTaskAt(1_000 + DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS),
      'Preview timeout was not scheduled'
    );

    await clock.advanceTo(1_000 + DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS);
    expect(coordinator.getState().targets).toMatchObject([
      { target: 'preview', retriesUsed: 1, currentSha256: null },
      { target: 'program', retriesUsed: 0, currentSha256: null },
    ]);
    expect(transport.closeReasons).toEqual([]);
    programGate.resolve({
      issuerKeyId: 'server-key-1',
      sequence: 2,
      bytes: new TextEncoder().encode('program:2'),
      signature: 'signature-2',
    });
  });

  it('linearizes acknowledgement and state invalidation while another capture is hung', async () => {
    const programGate = deferred<DeviceBootstrapSnapshot>();
    let programStarted = false;
    let sequence = 0;
    const snapshotFactory: DeviceBootstrapSnapshotFactory = {
      isCurrent: () => true,
      create(target) {
        sequence += 1;
        if (target === 'program') {
          programStarted = true;
          return programGate.promise;
        }
        return {
          issuerKeyId: 'server-key-1',
          sequence,
          bytes: new TextEncoder().encode(`preview:${sequence}`),
          signature: `signature-${sequence}`,
        };
      },
    };
    const { coordinator, transport } = harness(['preview', 'program'], { snapshotFactory });
    await coordinator.start();
    await waitFor(() => transport.emissions.length === 1, 'Preview was not emitted');
    await waitFor(() => programStarted, 'Program capture did not start');

    await coordinator.acknowledge(acknowledgement(transport.emissions[0]));
    expect(coordinator.getState().targets[0].appliedSha256).toBe(transport.emissions[0].sha256);
    await coordinator.notifyStateChanged('preview');
    expect(coordinator.getState().targets[0]).toMatchObject({
      retriesUsed: 0,
      currentSha256: null,
      appliedSha256: null,
    });
    expect(transport.closeReasons).toEqual([]);
    programGate.resolve({
      issuerKeyId: 'server-key-1',
      sequence: 2,
      bytes: new TextEncoder().encode('program:2'),
      signature: 'signature-2',
    });
  });

  it('keeps target retries independent and coalesces changed state without resetting them', async () => {
    const { coordinator, transport } = harness(['preview', 'program']);
    await startAndWait(coordinator, transport, 2);
    const initialProgram = transport.emissions[1];

    await coordinator.acknowledge(acknowledgement(transport.emissions[0], 'error'));
    await waitFor(() => transport.emissions.length === 3, 'Preview retry was not sent');
    const appliedPreview = transport.emissions[2];
    await coordinator.acknowledge(acknowledgement(appliedPreview));

    const changes = [
      coordinator.notifyStateChanged('preview'),
      coordinator.notifyStateChanged('preview'),
      coordinator.notifyStateChanged('preview'),
    ];
    const staleAck = coordinator.acknowledge(acknowledgement(appliedPreview));
    await Promise.all([...changes, staleAck]);
    await waitFor(() => transport.emissions.length === 4, 'Coalesced Preview was not sent');
    const latestPreview = transport.emissions[3];

    expect(transport.emissions.filter(({ target }) => target === 'preview')).toHaveLength(3);
    expect(coordinator.getState().targets).toMatchObject([
      { target: 'preview', retriesUsed: 1, appliedSha256: null },
      { target: 'program', retriesUsed: 0, currentSha256: initialProgram.sha256 },
    ]);
    expect(transport.closeReasons).toEqual([]);

    await coordinator.acknowledge(acknowledgement(initialProgram));
    expect(coordinator.isReady()).toBe(false);
    await coordinator.acknowledge(acknowledgement(latestPreview));
    expect(coordinator.isReady()).toBe(true);
    await coordinator.acknowledge(acknowledgement(latestPreview));
    expect(transport.closeReasons).toEqual([]);
  });

  it('burns a stale pre-send sequence and rebuilds without charging a retry', async () => {
    const factory = new TestSnapshotFactory();
    factory.staleSequences.add(1);
    const { coordinator, transport } = harness(['preview'], { snapshotFactory: factory });

    await startAndWait(coordinator, transport, 1);

    expect(factory.calls).toEqual(['preview', 'preview']);
    expect(transport.emissions.map((emission) => emission.sequence)).toEqual([2]);
    expect(transport.emissions[0].signature).toBe('signature-2');
    expect(coordinator.getState().targets[0].retriesUsed).toBe(0);
  });

  it('orders sequences independently after an issuer key rotation', async () => {
    const factory = new TestSnapshotFactory();
    const originalCreate = factory.create.bind(factory);
    factory.create = (target) => {
      const snapshot = originalCreate(target);
      if (snapshot.sequence === 2) {
        return { ...snapshot, issuerKeyId: 'server-key-2', sequence: 1 };
      }
      return snapshot;
    };
    const { coordinator, transport } = harness(['preview'], { snapshotFactory: factory });
    transport.sendFailures = 1;

    await coordinator.start();
    await waitFor(() => transport.emissions.length === 2, 'Rotated issuer retry was not emitted');

    expect(transport.emissions.map(({ issuerKeyId, sequence }) => [issuerKeyId, sequence])).toEqual(
      [
        ['server-key-1', 1],
        ['server-key-2', 1],
      ]
    );
    expect(coordinator.getState().targets[0].retriesUsed).toBe(1);
  });

  it('rejects an applied acknowledgement whose server freshness became stale', async () => {
    const factory = new TestSnapshotFactory();
    const { coordinator, transport } = harness(['preview'], { snapshotFactory: factory });
    await startAndWait(coordinator, transport, 1);
    const stale = transport.emissions[0];
    factory.staleSequences.add(stale.sequence);

    await coordinator.acknowledge(acknowledgement(stale));
    await waitFor(() => transport.emissions.length === 2, 'Fresh snapshot was not emitted');

    expect(coordinator.isReady()).toBe(false);
    expect(coordinator.getState().targets[0].retriesUsed).toBe(0);
    expect(transport.emissions[1].sequence).toBe(2);
    await coordinator.acknowledge(acknowledgement(transport.emissions[1]));
    await waitFor(() => coordinator.isReady(), 'Fresh acknowledgement did not grant readiness');
  });

  it('closes malformed, unauthorized, unknown, and cross-target acknowledgements', async () => {
    const malformed = harness();
    await startAndWait(malformed.coordinator, malformed.transport, 1);
    await malformed.coordinator.acknowledge({ type: 'device.bootstrap.ack' });
    expect(malformed.transport.closeReasons).toEqual(['bootstrap.protocol_violation']);

    const unknown = harness();
    await startAndWait(unknown.coordinator, unknown.transport, 1);
    await unknown.coordinator.acknowledge(unknownAcknowledgement('preview'));
    expect(unknown.transport.closeReasons).toEqual(['bootstrap.protocol_violation']);

    const unauthorized = harness();
    await startAndWait(unauthorized.coordinator, unauthorized.transport, 1);
    await unauthorized.coordinator.acknowledge(
      unknownAcknowledgement('program', unauthorized.transport.emissions[0].sha256)
    );
    expect(unauthorized.transport.closeReasons).toEqual(['bootstrap.protocol_violation']);

    const crossed = harness(['preview', 'program']);
    await startAndWait(crossed.coordinator, crossed.transport, 2);
    await crossed.coordinator.acknowledge(
      unknownAcknowledgement('program', crossed.transport.emissions[0].sha256)
    );
    expect(crossed.transport.closeReasons).toEqual(['bootstrap.protocol_violation']);
  });

  it('enforces the authority-relative deadline even while snapshot capture is hung', async () => {
    const gate = deferred<DeviceBootstrapSnapshot>();
    let captureStarted = false;
    const snapshotFactory: DeviceBootstrapSnapshotFactory = {
      isCurrent: () => true,
      async create() {
        captureStarted = true;
        return gate.promise;
      },
    };
    const transport = new TestTransport();
    const clock = new ManualBootstrapClock();
    const backgroundErrors: unknown[] = [];
    transport.closeImplementation = async () => {
      throw new Error('close adapter failed');
    };
    const coordinator = new DeviceBootstrapReadinessCoordinator({
      targets: ['preview'],
      snapshotFactory,
      transport,
      parseAck: parseDeviceBootstrapAck,
      now: () => clock.value,
      scheduler: clock,
      onBackgroundError: (error) => backgroundErrors.push(error),
    });

    await coordinator.start();
    await waitFor(() => captureStarted, 'Hung capture did not start');
    await clock.advanceTo(1_000 + DEVICE_BOOTSTRAP_DEADLINE_MS - 1);
    expect(transport.closeReasons).toEqual([]);
    await clock.advanceTo(1_000 + DEVICE_BOOTSTRAP_DEADLINE_MS);

    expect(transport.closeReasons).toEqual(['bootstrap.deadline_exceeded']);
    expect(coordinator.getState().phase).toBe('closed');
    expect(coordinator.isReady()).toBe(false);
    expect(backgroundErrors).toHaveLength(1);
    gate.resolve({
      issuerKeyId: 'server-key-1',
      sequence: 1,
      bytes: new Uint8Array([1]),
      signature: 'signature-1',
    });
  });

  it('closes internal factory, hash, and scheduler failures without consuming a retry', async () => {
    const factoryFailure = harness(['preview'], {
      snapshotFactory: {
        create: async () => {
          throw new Error('capture failed');
        },
        isCurrent: () => true,
      },
    });
    await factoryFailure.coordinator.start();
    await waitFor(
      () => factoryFailure.transport.closeReasons.length === 1,
      'Factory failure did not close'
    );
    expect(factoryFailure.transport.closeReasons).toEqual(['bootstrap.internal_error']);
    expect(factoryFailure.coordinator.getState().targets[0].retriesUsed).toBe(0);

    const hashFailure = harness(['preview'], {
      hash: async () => {
        throw new Error('hash failed');
      },
    });
    await hashFailure.coordinator.start();
    await waitFor(
      () => hashFailure.transport.closeReasons.length === 1,
      'Hash failure did not close'
    );
    expect(hashFailure.transport.closeReasons).toEqual(['bootstrap.internal_error']);
    expect(hashFailure.coordinator.getState().targets[0].retriesUsed).toBe(0);

    const transport = new TestTransport();
    const schedulingFailure = harness(['preview'], {
      transport,
      scheduler: {
        schedule: () => {
          throw new Error('scheduler failed');
        },
        cancel: () => undefined,
      },
    });
    await schedulingFailure.coordinator.start();
    expect(transport.closeReasons).toEqual(['bootstrap.internal_error']);
    expect(schedulingFailure.coordinator.getState().targets[0].retriesUsed).toBe(0);

    const cancellationClock = new ManualBootstrapClock();
    const cancellationTransport = new TestTransport();
    const cancellationFailure = harness(['preview'], {
      transport: cancellationTransport,
      now: () => cancellationClock.value,
      scheduler: {
        schedule: cancellationClock.schedule.bind(cancellationClock),
        cancel: () => {
          throw new Error('cancellation failed');
        },
      },
    });
    await startAndWait(cancellationFailure.coordinator, cancellationTransport, 1);
    await cancellationFailure.coordinator.acknowledge(
      acknowledgement(cancellationTransport.emissions[0])
    );
    expect(cancellationTransport.closeReasons).toEqual(['bootstrap.internal_error']);
    expect(cancellationFailure.coordinator.isReady()).toBe(false);
  });

  it('composes the CommonJS host through one injected ESM protocol load', async () => {
    const protocol = await import('@overlaykit/protocol/device-bootstrap');
    const loadProtocol = vi.fn(async () => protocol);
    const clock = new ManualBootstrapClock();
    const factory = new TestSnapshotFactory();
    const transport = new TestTransport();
    const coordinator = await createDeviceBootstrapReadinessCoordinator({
      targets: ['preview'],
      snapshotFactory: factory,
      transport,
      now: () => clock.value,
      scheduler: clock,
      loadProtocol,
    });

    await startAndWait(coordinator, transport, 1);
    await coordinator.acknowledge(acknowledgement(transport.emissions[0]));
    expect(loadProtocol).toHaveBeenCalledTimes(1);
    expect(coordinator.isReady()).toBe(true);
  });
});
