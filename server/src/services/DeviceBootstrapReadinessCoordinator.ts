import { createHash } from 'node:crypto';
import type { DeviceBootstrapAck } from '@overlaykit/protocol/device-bootstrap' with {
  'resolution-mode': 'import',
};
import type { ProductionBus } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};

type DeviceBootstrapProtocolModule = typeof import('@overlaykit/protocol/device-bootstrap', {
  with: { 'resolution-mode': 'import' },
});

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS = 3_000;
export const DEVICE_BOOTSTRAP_DEADLINE_MS = 12_000;
export const DEVICE_BOOTSTRAP_MAX_RETRIES = 3;

export const DEVICE_BOOTSTRAP_CLOSE_REASONS = [
  'bootstrap.deadline_exceeded',
  'bootstrap.retries_exhausted',
  'bootstrap.protocol_violation',
  'bootstrap.internal_error',
] as const;

export type DeviceBootstrapCloseReason = (typeof DEVICE_BOOTSTRAP_CLOSE_REASONS)[number];
export type DeviceBootstrapPhase = 'idle' | 'bootstrapping' | 'ready' | 'closed';

export interface DeviceBootstrapSnapshot {
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly signature: string;
}

export interface DeviceBootstrapSnapshotFactory {
  create(target: ProductionBus): DeviceBootstrapSnapshot | Promise<DeviceBootstrapSnapshot>;
  isCurrent(snapshot: DeviceBootstrapSnapshot): boolean;
}

export interface DeviceBootstrapEmission {
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly bytes: Readonly<Uint8Array>;
  readonly signature: string;
}

export interface DeviceBootstrapTransport {
  send(emission: DeviceBootstrapEmission): void | Promise<void>;
  close(reason: DeviceBootstrapCloseReason): void | Promise<void>;
}

export interface DeviceBootstrapScheduler {
  schedule(at: number, task: () => void | Promise<void>): unknown;
  cancel(handle: unknown): void;
}

export interface DeviceBootstrapTargetStateView {
  readonly target: ProductionBus;
  readonly retriesUsed: number;
  readonly currentSha256: string | null;
  readonly appliedSha256: string | null;
}

export interface DeviceBootstrapReadinessState {
  readonly phase: DeviceBootstrapPhase;
  readonly startedAt: number | null;
  readonly deadlineAt: number | null;
  readonly lastSequence: number;
  readonly closeReason: DeviceBootstrapCloseReason | null;
  readonly targets: ReadonlyArray<DeviceBootstrapTargetStateView>;
}

export type DeviceBootstrapReadinessErrorCode =
  'INVALID_DEVICE_BOOTSTRAP_COORDINATOR' | 'DEVICE_BOOTSTRAP_ALREADY_STARTED';

export class DeviceBootstrapReadinessError extends Error {
  constructor(
    readonly code: DeviceBootstrapReadinessErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DeviceBootstrapReadinessError';
  }
}

interface CurrentAttempt {
  readonly epoch: number;
  readonly sequence: number;
  readonly sha256: string;
  readonly snapshot: DeviceBootstrapSnapshot;
  sendConfirmed: boolean;
  timeoutHandle: unknown | null;
}

interface TargetState {
  readonly target: ProductionBus;
  epoch: number;
  retriesUsed: number;
  current: CurrentAttempt | null;
  appliedSha256: string | null;
}

interface DeviceBootstrapCoordinatorOptions {
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly snapshotFactory: DeviceBootstrapSnapshotFactory;
  readonly transport: DeviceBootstrapTransport;
  readonly parseAck: (value: unknown) => DeviceBootstrapAck;
  readonly hash?: (bytes: Uint8Array) => string | Promise<string>;
  readonly now?: () => number;
  readonly scheduler?: DeviceBootstrapScheduler;
  readonly onBackgroundError?: (error: unknown) => void;
}

export interface DeviceBootstrapCoordinatorRuntimeOptions extends Omit<
  DeviceBootstrapCoordinatorOptions,
  'parseAck'
> {
  readonly loadProtocol?: () => Promise<DeviceBootstrapProtocolModule>;
}

function defaultHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeviceBootstrapReadinessError(
      'INVALID_DEVICE_BOOTSTRAP_COORDINATOR',
      'Device bootstrap clock must return a non-negative safe integer'
    );
  }
  return value;
}

function defaultScheduler(now: () => number): DeviceBootstrapScheduler {
  return {
    schedule(at, task) {
      const delay = Math.min(Math.max(0, at - normalizedNow(now)), MAX_TIMER_DELAY_MS);
      return setTimeout(() => {
        void Promise.resolve(task()).catch(() => undefined);
      }, delay);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function normalizeTargets(targets: ReadonlyArray<ProductionBus>): ReadonlyArray<ProductionBus> {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new DeviceBootstrapReadinessError(
      'INVALID_DEVICE_BOOTSTRAP_COORDINATOR',
      'At least one device bootstrap target is required'
    );
  }
  const normalized: ProductionBus[] = [];
  for (const target of targets) {
    if ((target !== 'preview' && target !== 'program') || normalized.includes(target)) {
      throw new DeviceBootstrapReadinessError(
        'INVALID_DEVICE_BOOTSTRAP_COORDINATOR',
        'Device bootstrap targets must be unique Preview or Program targets'
      );
    }
    normalized.push(target);
  }
  return Object.freeze(normalized);
}

function validSnapshot(value: unknown): value is DeviceBootstrapSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DeviceBootstrapSnapshot>;
  return (
    typeof snapshot.issuerKeyId === 'string' &&
    snapshot.issuerKeyId.length > 0 &&
    Number.isSafeInteger(snapshot.sequence) &&
    (snapshot.sequence as number) > 0 &&
    snapshot.bytes instanceof Uint8Array &&
    snapshot.bytes.byteLength > 0 &&
    typeof snapshot.signature === 'string' &&
    snapshot.signature.length > 0
  );
}

function safeDeadline(startedAt: number, duration: number): number {
  const deadline = startedAt + duration;
  if (!Number.isSafeInteger(deadline)) {
    throw new DeviceBootstrapReadinessError(
      'INVALID_DEVICE_BOOTSTRAP_COORDINATOR',
      'Device bootstrap deadline exceeds safe clock precision'
    );
  }
  return deadline;
}

async function loadDeviceBootstrapProtocol(): Promise<DeviceBootstrapProtocolModule> {
  return import('@overlaykit/protocol/device-bootstrap');
}

export class DeviceBootstrapReadinessCoordinator {
  private readonly targets: ReadonlyArray<ProductionBus>;
  private readonly states = new Map<ProductionBus, TargetState>();
  private readonly snapshotFactory: DeviceBootstrapSnapshotFactory['create'];
  private readonly isSnapshotCurrent: DeviceBootstrapSnapshotFactory['isCurrent'];
  private readonly send: DeviceBootstrapTransport['send'];
  private readonly closeTransport: DeviceBootstrapTransport['close'];
  private readonly parseAck: (value: unknown) => DeviceBootstrapAck;
  private readonly hash: (bytes: Uint8Array) => string | Promise<string>;
  private readonly now: () => number;
  private readonly scheduler: DeviceBootstrapScheduler;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly issuedHashes = new Map<
    string,
    {
      readonly target: ProductionBus;
      readonly sequence: number;
    }
  >();
  private readonly pendingTargets = new Set<ProductionBus>();
  private phase: DeviceBootstrapPhase = 'idle';
  private startedAt: number | null = null;
  private deadlineAt: number | null = null;
  private deadlineHandle: unknown | null = null;
  private readonly lastSequenceByIssuer = new Map<string, number>();
  private lastSequence = 0;
  private closeReason: DeviceBootstrapCloseReason | null = null;
  private closePromise: Promise<void> | null = null;
  private queueTail = Promise.resolve();
  private pumpScheduled = false;

  constructor(options: DeviceBootstrapCoordinatorOptions) {
    if (
      !options ||
      !options.snapshotFactory ||
      typeof options.snapshotFactory.create !== 'function' ||
      typeof options.snapshotFactory.isCurrent !== 'function' ||
      !options.transport ||
      typeof options.transport.send !== 'function' ||
      typeof options.transport.close !== 'function' ||
      typeof options.parseAck !== 'function' ||
      (options.hash !== undefined && typeof options.hash !== 'function') ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.scheduler !== undefined &&
        (typeof options.scheduler.schedule !== 'function' ||
          typeof options.scheduler.cancel !== 'function')) ||
      (options.onBackgroundError !== undefined && typeof options.onBackgroundError !== 'function')
    ) {
      throw new DeviceBootstrapReadinessError(
        'INVALID_DEVICE_BOOTSTRAP_COORDINATOR',
        'Device bootstrap coordinator dependencies are invalid'
      );
    }
    this.targets = normalizeTargets(options.targets);
    this.snapshotFactory = options.snapshotFactory.create.bind(options.snapshotFactory);
    this.isSnapshotCurrent = options.snapshotFactory.isCurrent.bind(options.snapshotFactory);
    this.send = options.transport.send.bind(options.transport);
    this.closeTransport = options.transport.close.bind(options.transport);
    this.parseAck = options.parseAck;
    this.hash = options.hash ?? defaultHash;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler(this.now);
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    normalizedNow(this.now);
    for (const target of this.targets) {
      this.states.set(target, {
        target,
        epoch: 0,
        retriesUsed: 0,
        current: null,
        appliedSha256: null,
      });
    }
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== 'idle') {
        throw new DeviceBootstrapReadinessError(
          'DEVICE_BOOTSTRAP_ALREADY_STARTED',
          'Device bootstrap readiness has already started'
        );
      }
      try {
        this.startedAt = normalizedNow(this.now);
        this.deadlineAt = safeDeadline(this.startedAt, DEVICE_BOOTSTRAP_DEADLINE_MS);
        this.phase = 'bootstrapping';
        const handle = this.scheduler.schedule(this.deadlineAt, () => this.expireDeadline());
        if (this.phase === 'bootstrapping') this.deadlineHandle = handle;
        else this.scheduler.cancel(handle);
      } catch (error) {
        await this.failInternal(error);
        return;
      }
      for (const target of this.targets) this.pendingTargets.add(target);
      this.schedulePump();
    });
  }

  notifyStateChanged(target: ProductionBus): Promise<void> {
    if (!this.states.has(target)) {
      return Promise.reject(
        new DeviceBootstrapReadinessError(
          'INVALID_DEVICE_BOOTSTRAP_COORDINATOR',
          'State changes must name an authorized bootstrap target'
        )
      );
    }
    return this.enqueue(async () => {
      if (this.phase !== 'bootstrapping') return;
      const state = this.states.get(target)!;
      state.epoch += 1;
      try {
        this.cancelAttemptTimeout(state);
      } catch (error) {
        await this.failInternal(error);
        return;
      }
      state.current = null;
      state.appliedSha256 = null;
      this.pendingTargets.add(target);
      this.schedulePump();
    });
  }

  acknowledge(value: unknown): Promise<void> {
    let acknowledgement: DeviceBootstrapAck;
    try {
      acknowledgement = this.parseAck(value);
    } catch {
      return this.enqueue(() => this.closeConnection('bootstrap.protocol_violation'));
    }

    return this.enqueue(async () => {
      if (this.phase === 'closed') return;
      const state = this.states.get(acknowledgement.target);
      const issued = this.issuedHashes.get(acknowledgement.sha256);
      if (!state || !issued || issued.target !== acknowledgement.target) {
        await this.closeConnection('bootstrap.protocol_violation');
        return;
      }

      if (this.phase === 'ready') {
        if (
          acknowledgement.status === 'applied' &&
          state.current?.sha256 === acknowledgement.sha256 &&
          state.appliedSha256 === acknowledgement.sha256
        )
          return;
        if (state.current?.sha256 !== acknowledgement.sha256) return;
        await this.closeConnection('bootstrap.protocol_violation');
        return;
      }
      if (this.phase !== 'bootstrapping') {
        await this.closeConnection('bootstrap.protocol_violation');
        return;
      }
      if (state.current?.sha256 !== acknowledgement.sha256) return;

      try {
        if (!this.isSnapshotCurrent(state.current.snapshot)) {
          await this.invalidateStaleAttempt(state);
          return;
        }
      } catch (error) {
        await this.failInternal(error);
        return;
      }

      if (acknowledgement.status === 'error') {
        await this.consumeRetry(state);
        return;
      }

      try {
        this.cancelAttemptTimeout(state);
      } catch (error) {
        await this.failInternal(error);
        return;
      }
      state.appliedSha256 = acknowledgement.sha256;
      await this.grantReadinessIfComplete();
    });
  }

  isReady(): boolean {
    return this.phase === 'ready';
  }

  getState(): DeviceBootstrapReadinessState {
    return Object.freeze({
      phase: this.phase,
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      lastSequence: this.lastSequence,
      closeReason: this.closeReason,
      targets: Object.freeze(
        this.targets.map((target) => {
          const state = this.states.get(target)!;
          return Object.freeze({
            target,
            retriesUsed: state.retriesUsed,
            currentSha256: state.current?.sha256 ?? null,
            appliedSha256: state.appliedSha256,
          });
        })
      ),
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.pendingTargets.size === 0 || this.phase !== 'bootstrapping')
      return;
    this.pumpScheduled = true;
    void this.runEmissionLane().then(
      () => this.finishPump(),
      (error) => {
        this.reportBackgroundError(error);
        void this.failInternal(error).finally(() => this.finishPump());
      }
    );
  }

  private async runEmissionLane(): Promise<void> {
    while (this.phase === 'bootstrapping') {
      const target = await this.enqueue(() => {
        if (this.phase !== 'bootstrapping') return null;
        const next = this.targets.find((candidate) => this.pendingTargets.has(candidate));
        if (next) this.pendingTargets.delete(next);
        return next ?? null;
      });
      if (!target) return;
      await this.emit(target);
    }
  }

  private finishPump(): void {
    this.pumpScheduled = false;
    this.schedulePump();
  }

  private async emit(target: ProductionBus): Promise<void> {
    if (this.phase !== 'bootstrapping') return;
    const state = this.states.get(target)!;
    const epoch = state.epoch;

    let snapshot: DeviceBootstrapSnapshot;
    try {
      snapshot = await this.snapshotFactory(target);
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    if (this.phase !== 'bootstrapping') return;
    if (
      !validSnapshot(snapshot) ||
      snapshot.sequence <= (this.lastSequenceByIssuer.get(snapshot.issuerKeyId) ?? 0)
    ) {
      await this.failInternal(new Error('Snapshot sequence or bytes are invalid'));
      return;
    }

    const bytes = snapshot.bytes.slice();
    this.lastSequenceByIssuer.set(snapshot.issuerKeyId, snapshot.sequence);
    this.lastSequence = snapshot.sequence;
    let sha256: string;
    try {
      sha256 = await this.hash(bytes);
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    if (this.phase !== 'bootstrapping') return;
    if (!SHA256_PATTERN.test(sha256) || this.issuedHashes.has(sha256)) {
      await this.failInternal(new Error('Snapshot hash is invalid or was already issued'));
      return;
    }
    try {
      if (!this.isSnapshotCurrent(snapshot)) {
        await this.enqueue(() => {
          if (this.phase !== 'bootstrapping') return;
          if (state.epoch === epoch) this.pendingTargets.add(target);
        });
        return;
      }
    } catch (error) {
      await this.failInternal(error);
      return;
    }

    const attempt: CurrentAttempt = {
      epoch,
      sequence: snapshot.sequence,
      sha256,
      snapshot,
      sendConfirmed: false,
      timeoutHandle: null,
    };
    const committed = await this.enqueue(() => {
      if (this.phase !== 'bootstrapping') return false;
      if (state.epoch !== epoch) {
        this.pendingTargets.add(target);
        return false;
      }
      state.current = attempt;
      state.appliedSha256 = null;
      return true;
    });
    if (!committed) return;

    try {
      if (!this.isSnapshotCurrent(snapshot)) {
        await this.enqueue(() => this.invalidateStaleAttempt(state));
        return;
      }
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    this.issuedHashes.set(sha256, { target, sequence: snapshot.sequence });

    let sendFailed = false;
    try {
      await this.send(
        Object.freeze({
          target,
          issuerKeyId: snapshot.issuerKeyId,
          sequence: snapshot.sequence,
          sha256,
          bytes,
          signature: snapshot.signature,
        })
      );
    } catch {
      sendFailed = true;
    }
    await this.enqueue(async () => {
      if (this.phase !== 'bootstrapping' || state.current !== attempt) return;
      if (sendFailed) {
        await this.consumeRetry(state);
        return;
      }
      attempt.sendConfirmed = true;
      if (state.appliedSha256 === sha256) {
        await this.grantReadinessIfComplete();
        return;
      }
      try {
        const timeoutAt = safeDeadline(normalizedNow(this.now), DEVICE_BOOTSTRAP_ACK_TIMEOUT_MS);
        attempt.timeoutHandle = this.scheduler.schedule(timeoutAt, () =>
          this.enqueue(() => this.timeoutAttempt(target, sha256))
        );
      } catch (error) {
        await this.failInternal(error);
      }
    });
  }

  private async timeoutAttempt(target: ProductionBus, sha256: string): Promise<void> {
    if (this.phase !== 'bootstrapping') return;
    const state = this.states.get(target)!;
    if (state.current?.sha256 !== sha256) return;
    await this.consumeRetry(state);
  }

  private async consumeRetry(state: TargetState): Promise<void> {
    try {
      this.cancelAttemptTimeout(state);
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    state.current = null;
    state.appliedSha256 = null;
    if (state.retriesUsed >= DEVICE_BOOTSTRAP_MAX_RETRIES) {
      await this.closeConnection('bootstrap.retries_exhausted');
      return;
    }
    state.retriesUsed += 1;
    this.pendingTargets.add(state.target);
    this.schedulePump();
  }

  private async invalidateStaleAttempt(state: TargetState): Promise<void> {
    if (this.phase !== 'bootstrapping') return;
    try {
      this.cancelAttemptTimeout(state);
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    state.current = null;
    state.appliedSha256 = null;
    this.pendingTargets.add(state.target);
    this.schedulePump();
  }

  private async grantReadinessIfComplete(): Promise<void> {
    const complete = this.targets.every((target) => {
      const current = this.states.get(target)!;
      return (
        current.current !== null &&
        current.current.sendConfirmed &&
        current.appliedSha256 === current.current.sha256
      );
    });
    if (!complete) return;
    try {
      const stale = this.targets
        .map((target) => this.states.get(target)!)
        .filter((state) => !this.isSnapshotCurrent(state.current!.snapshot));
      if (stale.length > 0) {
        for (const state of stale) await this.invalidateStaleAttempt(state);
        return;
      }
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    try {
      this.cancelDeadline();
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    this.phase = 'ready';
  }

  private async expireDeadline(): Promise<void> {
    if (this.phase === 'bootstrapping') {
      await this.closeConnection('bootstrap.deadline_exceeded');
    }
  }

  private async failInternal(error: unknown): Promise<void> {
    this.reportBackgroundError(error);
    await this.closeConnection('bootstrap.internal_error');
  }

  private async closeConnection(reason: DeviceBootstrapCloseReason): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.closeReason = reason;
    this.pendingTargets.clear();
    this.pumpScheduled = false;
    try {
      this.cancelDeadline();
    } catch (error) {
      this.reportBackgroundError(error);
    }
    for (const state of this.states.values()) {
      try {
        this.cancelAttemptTimeout(state);
      } catch (error) {
        this.reportBackgroundError(error);
      }
    }

    try {
      this.closePromise = Promise.resolve(this.closeTransport(reason)).catch((error) => {
        this.reportBackgroundError(error);
      });
    } catch (error) {
      this.closePromise = Promise.resolve();
      this.reportBackgroundError(error);
    }
    await this.closePromise;
  }

  private cancelDeadline(): void {
    if (this.deadlineHandle === null) return;
    this.scheduler.cancel(this.deadlineHandle);
    this.deadlineHandle = null;
  }

  private cancelAttemptTimeout(state: TargetState): void {
    const attempt = state.current;
    const handle = attempt?.timeoutHandle;
    if (!attempt || handle === null || handle === undefined) return;
    this.scheduler.cancel(handle);
    attempt.timeoutHandle = null;
  }

  private reportBackgroundError(error: unknown): void {
    try {
      this.onBackgroundError(error);
    } catch {
      // A diagnostic adapter cannot grant readiness or prevent fail-closed behavior.
    }
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.queueTail.then(task);
    this.queueTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export async function createDeviceBootstrapReadinessCoordinator(
  options: DeviceBootstrapCoordinatorRuntimeOptions
): Promise<DeviceBootstrapReadinessCoordinator> {
  const { loadProtocol = loadDeviceBootstrapProtocol, ...coordinatorOptions } = options;
  const protocol = await loadProtocol();
  return new DeviceBootstrapReadinessCoordinator({
    ...coordinatorOptions,
    parseAck: protocol.parseDeviceBootstrapAck,
  });
}
