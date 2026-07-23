import { createHash } from 'crypto';
import type {
  DeviceControlFrameIdentity,
  DeviceControlFrameState,
} from '@overlaykit/protocol/device-control-frame' with { 'resolution-mode': 'import' };
import type { DeviceStateAck } from '@overlaykit/protocol/device-state-sync' with {
  'resolution-mode': 'import',
};
import type { ProductionBus } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const DEVICE_DELTA_CONFIRMATION_INTERVAL_MS = 1_000;
export const DEVICE_DELTA_ACK_TIMEOUT_MS = 3_000;
export const DEVICE_DELTA_SEND_TIMEOUT_MS = 3_000;
export const DEVICE_DELTA_MAX_RETRIES = 3;

export const DEVICE_POST_READY_CLOSE_REASONS = [
  'delta.retries_exhausted',
  'delta.protocol_violation',
  'delta.transport_failure',
  'delta.issuer_rotated',
  'delta.internal_error',
  'transport.closed',
  'host.shutdown',
] as const;

export type DevicePostReadyCloseReason = typeof DEVICE_POST_READY_CLOSE_REASONS[number];
export type DevicePostReadyPhase = 'ready' | 'closed';

export interface DeviceConfirmedTargetBase {
  readonly target: ProductionBus;
  readonly identity: DeviceControlFrameIdentity;
  readonly state: DeviceControlFrameState;
  readonly appliedAt: number;
}

export interface DevicePostReadySnapshot {
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly signature: string;
  readonly base: {
    readonly identity: DeviceControlFrameIdentity;
    readonly state: DeviceControlFrameState;
  };
  readonly state: DeviceControlFrameState;
  readonly currency?: unknown;
  readonly evidence: {
    readonly targetRevision: number;
    readonly catalogGeneration: number;
    readonly confirmedAt: number;
  };
}

export interface DevicePostReadySnapshotFactory {
  create(base: DeviceConfirmedTargetBase): DevicePostReadySnapshot | Promise<DevicePostReadySnapshot>;
  isCurrent(snapshot: DevicePostReadySnapshot): boolean;
  currentIssuerKeyId(): string;
}

export interface DevicePostReadyEmission {
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly bytes: Readonly<Uint8Array>;
  readonly signature: string;
}

export interface DevicePostReadyTransport {
  send(emission: DevicePostReadyEmission): void | Promise<void>;
  close(reason: DevicePostReadyCloseReason): void | Promise<void>;
}

export interface DevicePostReadyScheduler {
  schedule(at: number, task: () => void | Promise<void>): unknown;
  cancel(handle: unknown): void;
}

export interface DevicePostReadyCheckpointTarget {
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly targetRevision: number;
  readonly catalogGeneration: number;
  readonly appliedAt: number;
}

export interface DevicePostReadyTargetView {
  readonly target: ProductionBus;
  readonly ready: boolean;
  readonly stale: boolean;
  readonly retriesUsed: number;
  readonly base: DeviceControlFrameIdentity;
  readonly pending: DeviceControlFrameIdentity | null;
}

export interface DevicePostReadyState {
  readonly phase: DevicePostReadyPhase;
  readonly closeReason: DevicePostReadyCloseReason | null;
  readonly latestIssuedSequence: number;
  readonly targets: ReadonlyArray<DevicePostReadyTargetView>;
}

export interface DevicePostReadyCommandEvidence {
  readonly target: ProductionBus;
  readonly ready: boolean;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly productionRevision: number;
  readonly catalogGeneration: number;
}

interface DevicePostReadyCoordinatorOptions {
  readonly initialBases: ReadonlyArray<DeviceConfirmedTargetBase>;
  readonly snapshotFactory: DevicePostReadySnapshotFactory;
  readonly transport: DevicePostReadyTransport;
  readonly parseAck: (value: unknown) => DeviceStateAck;
  readonly hash?: (bytes: Uint8Array) => string | Promise<string>;
  readonly now?: () => number;
  readonly scheduler?: DevicePostReadyScheduler;
  readonly onTargetReadinessChanged?: (target: ProductionBus, ready: boolean) => void;
  readonly onCheckpoint?: (
    reason: DevicePostReadyCloseReason,
    targets: ReadonlyArray<DevicePostReadyCheckpointTarget>,
    occurredAt: number
  ) => void | Promise<void>;
  readonly onBackgroundError?: (error: unknown) => void;
}

interface PendingAttempt {
  readonly epoch: number;
  readonly snapshot: DevicePostReadySnapshot;
  readonly identity: DeviceControlFrameIdentity;
  readonly emission: DevicePostReadyEmission;
  retriesUsed: number;
  sendConfirmed: boolean;
  sendInFlight: boolean;
  earlyAck: DeviceStateAck | null;
  timeoutHandle: unknown | null;
}

interface TargetState {
  readonly target: ProductionBus;
  epoch: number;
  base: DeviceConfirmedTargetBase;
  current: PendingAttempt | null;
  confirmationHandle: unknown | null;
}

type WorkKind = 'create' | 'resend';

function defaultHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Device post-ready clock is invalid');
  }
  return value;
}

function safeDeadline(startedAt: number, duration: number): number {
  const deadline = startedAt + duration;
  if (!Number.isSafeInteger(deadline)) {
    throw new Error('Device post-ready deadline exceeds safe clock precision');
  }
  return deadline;
}

function defaultScheduler(now: () => number): DevicePostReadyScheduler {
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

function validIdentity(value: unknown): value is DeviceControlFrameIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DeviceControlFrameIdentity>;
  return typeof identity.issuerKeyId === 'string'
    && identity.issuerKeyId.length > 0
    && Number.isSafeInteger(identity.sequence)
    && (identity.sequence as number) > 0
    && typeof identity.sha256 === 'string'
    && SHA256_PATTERN.test(identity.sha256);
}

function sameIdentity(
  left: DeviceControlFrameIdentity,
  right: DeviceControlFrameIdentity
): boolean {
  return left.issuerKeyId === right.issuerKeyId
    && left.sequence === right.sequence
    && left.sha256 === right.sha256;
}

function identityFromAck(ack: DeviceStateAck): DeviceControlFrameIdentity {
  return Object.freeze({
    issuerKeyId: ack.issuerKeyId,
    sequence: ack.sequence,
    sha256: ack.sha256,
  });
}

function normalizeInitialBases(
  bases: ReadonlyArray<DeviceConfirmedTargetBase>
): ReadonlyArray<DeviceConfirmedTargetBase> {
  if (
    !Array.isArray(bases)
    || bases.length === 0
    || bases.length > 2
  ) {
    throw new Error('Device post-ready bases are invalid');
  }
  const normalized = bases.map((base): DeviceConfirmedTargetBase => {
    if (
      !base
      || typeof base !== 'object'
      || (base.target !== 'preview' && base.target !== 'program')
      || !validIdentity(base.identity)
      || !base.state
      || base.state.target !== base.target
      || !Number.isSafeInteger(base.appliedAt)
      || base.appliedAt < 0
    ) {
      throw new Error('Device post-ready base is invalid');
    }
    return Object.freeze({
      target: base.target,
      identity: Object.freeze({ ...base.identity }),
      state: base.state,
      appliedAt: base.appliedAt,
    });
  });
  if (new Set(normalized.map(({ target }) => target)).size !== normalized.length) {
    throw new Error('Device post-ready targets must be unique');
  }
  const issuerKeyIds = new Set(normalized.map(({ identity }) => identity.issuerKeyId));
  if (issuerKeyIds.size !== 1) {
    throw new Error('Device post-ready bases must share one issuer');
  }
  return Object.freeze(
    [...normalized].sort((left, right) =>
      left.target === right.target ? 0 : left.target === 'preview' ? -1 : 1
    )
  );
}

function validSnapshot(
  snapshot: DevicePostReadySnapshot,
  base: DeviceConfirmedTargetBase
): boolean {
  return Boolean(
    snapshot
    && typeof snapshot === 'object'
    && snapshot.bytes instanceof Uint8Array
    && snapshot.bytes.byteLength > 0
    && typeof snapshot.signature === 'string'
    && snapshot.signature.length > 0
    && validIdentity({
      issuerKeyId: snapshot.issuerKeyId,
      sequence: snapshot.sequence,
      sha256: '0'.repeat(64),
    })
    && snapshot.sequence > base.identity.sequence
    && snapshot.state?.target === base.target
    && snapshot.base?.state?.target === base.target
    && validIdentity(snapshot.base?.identity)
    && sameIdentity(snapshot.base.identity, base.identity)
    && snapshot.evidence?.targetRevision === snapshot.state.revision
    && snapshot.evidence?.catalogGeneration === snapshot.state.catalogGeneration
    && snapshot.evidence?.confirmedAt === snapshot.state.confirmedAt
    && Number.isSafeInteger(snapshot.evidence?.confirmedAt)
    && snapshot.evidence.confirmedAt >= 0
  );
}

export class DevicePostReadySyncCoordinator {
  private readonly targets: ReadonlyArray<ProductionBus>;
  private readonly states = new Map<ProductionBus, TargetState>();
  private readonly snapshotFactory: DevicePostReadySnapshotFactory;
  private readonly send: DevicePostReadyTransport['send'];
  private readonly closeTransport: DevicePostReadyTransport['close'];
  private readonly parseAck: (value: unknown) => DeviceStateAck;
  private readonly hash: (bytes: Uint8Array) => string | Promise<string>;
  private readonly now: () => number;
  private readonly scheduler: DevicePostReadyScheduler;
  private readonly onTargetReadinessChanged: (target: ProductionBus, ready: boolean) => void;
  private readonly onCheckpoint: NonNullable<DevicePostReadyCoordinatorOptions['onCheckpoint']>;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly requestedChanges = new Set<ProductionBus>();
  private readonly work = new Map<ProductionBus, WorkKind>();
  private phase: DevicePostReadyPhase = 'ready';
  private closeReason: DevicePostReadyCloseReason | null = null;
  private latestIssuedSequence: number;
  private pumpScheduled = false;
  private queueTail = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private checkpointWritten = false;

  constructor(options: DevicePostReadyCoordinatorOptions) {
    if (
      !options
      || !options.snapshotFactory
      || typeof options.snapshotFactory.create !== 'function'
      || typeof options.snapshotFactory.isCurrent !== 'function'
      || typeof options.snapshotFactory.currentIssuerKeyId !== 'function'
      || !options.transport
      || typeof options.transport.send !== 'function'
      || typeof options.transport.close !== 'function'
      || typeof options.parseAck !== 'function'
      || (options.hash !== undefined && typeof options.hash !== 'function')
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.scheduler !== undefined
        && (typeof options.scheduler.schedule !== 'function'
          || typeof options.scheduler.cancel !== 'function'))
    ) {
      throw new Error('Device post-ready coordinator dependencies are invalid');
    }
    const bases = normalizeInitialBases(options.initialBases);
    this.targets = Object.freeze(bases.map(({ target }) => target));
    this.snapshotFactory = options.snapshotFactory;
    this.send = options.transport.send.bind(options.transport);
    this.closeTransport = options.transport.close.bind(options.transport);
    this.parseAck = options.parseAck;
    this.hash = options.hash ?? defaultHash;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler(this.now);
    this.onTargetReadinessChanged = options.onTargetReadinessChanged ?? (() => undefined);
    this.onCheckpoint = options.onCheckpoint ?? (() => undefined);
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    normalizedNow(this.now);
    this.latestIssuedSequence = Math.max(...bases.map(({ identity }) => identity.sequence));
    for (const base of bases) {
      this.states.set(base.target, {
        target: base.target,
        epoch: 0,
        base,
        current: null,
        confirmationHandle: null,
      });
      this.scheduleConfirmation(this.states.get(base.target)!);
      this.reportReadiness(base.target, true);
    }
  }

  notifyStateChanged(target: ProductionBus): Promise<void> {
    if (!this.states.has(target)) {
      return Promise.reject(new Error('State change names an unauthorized post-ready target'));
    }
    this.requestedChanges.add(target);
    this.reportReadiness(target, false);
    return this.enqueue(async () => {
      if (this.phase === 'closed') return;
      const state = this.states.get(target)!;
      state.epoch += 1;
      this.cancelConfirmation(state);
      this.cancelAttemptTimeout(state);
      state.current = null;
      this.work.set(target, 'create');
      this.schedulePump();
    });
  }

  acknowledge(value: unknown): Promise<void> {
    let ack: DeviceStateAck;
    try {
      ack = this.parseAck(value);
    } catch {
      return this.enqueue(() => this.closeConnection('delta.protocol_violation', true));
    }
    return this.enqueue(() => this.processAck(ack));
  }

  abort(error: unknown): Promise<void> {
    return this.enqueue(() => this.failInternal(error));
  }

  isTargetReady(target: ProductionBus): boolean {
    const state = this.states.get(target);
    if (!state || this.phase !== 'ready') return false;
    let now: number;
    try {
      now = normalizedNow(this.now);
    } catch {
      return false;
    }
    return !this.requestedChanges.has(target)
      && state.current === null
      && now - state.base.appliedAt < DEVICE_DELTA_ACK_TIMEOUT_MS;
  }

  getCommandEvidence(target: ProductionBus): DevicePostReadyCommandEvidence | null {
    const state = this.states.get(target);
    if (!state || this.phase !== 'ready') return null;
    return Object.freeze({
      target,
      ready: this.isTargetReady(target),
      issuerKeyId: state.base.identity.issuerKeyId,
      sequence: state.base.identity.sequence,
      sha256: state.base.identity.sha256,
      productionRevision: state.base.state.revision,
      catalogGeneration: state.base.state.catalogGeneration,
    });
  }

  getConfirmedIssuerKeyId(): string | null {
    if (this.phase !== 'ready') return null;
    const first = this.states.values().next().value as TargetState | undefined;
    return first?.base.identity.issuerKeyId ?? null;
  }

  getState(): DevicePostReadyState {
    const now = normalizedNow(this.now);
    return Object.freeze({
      phase: this.phase,
      closeReason: this.closeReason,
      latestIssuedSequence: this.latestIssuedSequence,
      targets: Object.freeze(this.targets.map((target) => {
        const state = this.states.get(target)!;
        return Object.freeze({
          target,
          ready: this.isTargetReady(target),
          stale: now - state.base.appliedAt >= DEVICE_DELTA_ACK_TIMEOUT_MS,
          retriesUsed: state.current?.retriesUsed ?? 0,
          base: Object.freeze({ ...state.base.identity }),
          pending: state.current
            ? Object.freeze({ ...state.current.identity })
            : null,
        });
      })),
    });
  }

  dispose(reason: 'transport.closed' | 'host.shutdown', graceful: boolean): Promise<void> {
    return this.enqueue(() => this.closeConnection(reason, false, graceful));
  }

  private async processAck(ack: DeviceStateAck): Promise<void> {
    if (this.phase === 'closed') return;
    const state = this.states.get(ack.target);
    if (!state || ack.mode !== 'delta') {
      await this.closeConnection('delta.protocol_violation', true);
      return;
    }
    const identity = identityFromAck(ack);
    if (sameIdentity(identity, state.base.identity)) {
      if (ack.status === 'applied') return;
      await this.closeConnection('delta.protocol_violation', true);
      return;
    }
    const current = state.current;
    if (!current) {
      if (ack.issuerKeyId === state.base.identity.issuerKeyId
        && ack.sequence <= this.latestIssuedSequence) return;
      await this.closeConnection('delta.protocol_violation', true);
      return;
    }
    if (ack.sequence === current.identity.sequence && !sameIdentity(identity, current.identity)) {
      await this.closeConnection('delta.protocol_violation', true);
      return;
    }
    if (!sameIdentity(identity, current.identity)) {
      if (ack.issuerKeyId === current.identity.issuerKeyId
        && ack.sequence < current.identity.sequence) return;
      await this.closeConnection('delta.protocol_violation', true);
      return;
    }
    if (current.sendInFlight) {
      if (
        current.earlyAck
        && (current.earlyAck.status !== ack.status
          || (ack.status === 'error'
            && current.earlyAck.status === 'error'
            && current.earlyAck.errorCode !== ack.errorCode))
      ) {
        await this.closeConnection('delta.protocol_violation', true);
        return;
      }
      current.earlyAck = ack;
      return;
    }
    if (!current.sendConfirmed) return;
    if (ack.status === 'error') {
      await this.retryOrClose(state);
      return;
    }
    let currentSnapshot = false;
    try {
      currentSnapshot = this.snapshotFactory.isCurrent(current.snapshot);
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    if (!currentSnapshot) {
      this.invalidateCurrent(state);
      return;
    }
    this.cancelAttemptTimeout(state);
    const appliedAt = normalizedNow(this.now);
    state.base = Object.freeze({
      target: state.target,
      identity: current.identity,
      state: current.snapshot.state,
      appliedAt,
    });
    state.current = null;
    this.requestedChanges.delete(state.target);
    this.reportReadiness(state.target, true);
    this.scheduleConfirmation(state);
  }

  private scheduleConfirmation(state: TargetState): void {
    if (this.phase !== 'ready') return;
    this.cancelConfirmation(state);
    const baseIdentity = state.base.identity;
    const at = safeDeadline(state.base.appliedAt, DEVICE_DELTA_CONFIRMATION_INTERVAL_MS);
    state.confirmationHandle = this.scheduler.schedule(at, () => this.enqueue(() => {
      state.confirmationHandle = null;
      if (
        this.phase !== 'ready'
        || !sameIdentity(state.base.identity, baseIdentity)
        || state.current
      ) return;
      this.requestedChanges.add(state.target);
      this.reportReadiness(state.target, false);
      this.work.set(state.target, 'create');
      this.schedulePump();
    }));
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.work.size === 0 || this.phase !== 'ready') return;
    this.pumpScheduled = true;
    void this.runPump().then(
      () => this.finishPump(),
      (error) => {
        this.reportBackground(error);
        void this.enqueue(() => this.failInternal(error)).finally(() => this.finishPump());
      }
    );
  }

  private async runPump(): Promise<void> {
    while (this.phase === 'ready') {
      const job = await this.enqueue(() => {
        const target = this.targets.find((candidate) => this.work.has(candidate));
        if (!target) return null;
        const kind = this.work.get(target)!;
        this.work.delete(target);
        return { target, kind };
      });
      if (!job) return;
      if (job.kind === 'create') await this.issueNew(job.target);
      else await this.resend(job.target);
    }
  }

  private finishPump(): void {
    this.pumpScheduled = false;
    this.schedulePump();
  }

  private async issueNew(target: ProductionBus): Promise<void> {
    if (this.phase !== 'ready') return;
    const state = this.states.get(target)!;
    const epoch = state.epoch;
    const base = state.base;
    let currentIssuerKeyId: string;
    try {
      currentIssuerKeyId = this.snapshotFactory.currentIssuerKeyId();
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    if (currentIssuerKeyId !== base.identity.issuerKeyId) {
      await this.closeConnection('delta.issuer_rotated', true);
      return;
    }
    let snapshot: DevicePostReadySnapshot;
    try {
      snapshot = await this.snapshotFactory.create(base);
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'DEVICE_CONTROL_ISSUER_ROTATED'
      ) {
        await this.closeConnection('delta.issuer_rotated', true);
      } else {
        await this.failInternal(error);
      }
      return;
    }
    if (this.phase !== 'ready') return;
    if (!validSnapshot(snapshot, base) || snapshot.issuerKeyId !== currentIssuerKeyId) {
      await this.failInternal(new Error('Post-ready snapshot is invalid'));
      return;
    }
    const bytes = snapshot.bytes.slice();
    let sha256: string;
    try {
      sha256 = await this.hash(bytes.slice());
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    if (!SHA256_PATTERN.test(sha256)) {
      await this.failInternal(new Error('Post-ready snapshot hash is invalid'));
      return;
    }
    let snapshotCurrent = false;
    try {
      snapshotCurrent = this.snapshotFactory.isCurrent(snapshot);
    } catch (error) {
      await this.failInternal(error);
      return;
    }
    if (!snapshotCurrent) {
      await this.enqueue(() => {
        if (this.phase !== 'ready') return;
        this.work.set(target, 'create');
        this.schedulePump();
      });
      return;
    }
    const identity = Object.freeze({
      issuerKeyId: snapshot.issuerKeyId,
      sequence: snapshot.sequence,
      sha256,
    });
    const emission = Object.freeze({
      target,
      issuerKeyId: identity.issuerKeyId,
      sequence: identity.sequence,
      sha256: identity.sha256,
      bytes,
      signature: snapshot.signature,
    });
    const attempt: PendingAttempt = {
      epoch,
      snapshot,
      identity,
      emission,
      retriesUsed: 0,
      sendConfirmed: false,
      sendInFlight: false,
      earlyAck: null,
      timeoutHandle: null,
    };
    const committed = await this.enqueue(() => {
      if (
        this.phase !== 'ready'
        || state.epoch !== epoch
        || !sameIdentity(state.base.identity, base.identity)
      ) {
        this.work.set(target, 'create');
        return false;
      }
      if (identity.sequence <= this.latestIssuedSequence) {
        throw new Error('Post-ready sequence did not advance globally');
      }
      state.current = attempt;
      this.latestIssuedSequence = identity.sequence;
      return true;
    });
    if (!committed) return;
    await this.sendAttempt(state, attempt, false);
  }

  private async resend(target: ProductionBus): Promise<void> {
    const state = this.states.get(target)!;
    const current = state.current;
    if (!current || this.phase !== 'ready') return;
    await this.sendAttempt(state, current, true);
  }

  private async sendAttempt(
    state: TargetState,
    attempt: PendingAttempt,
    retry: boolean
  ): Promise<void> {
    const canSend = await this.enqueue(() => {
      if (this.phase !== 'ready' || state.current !== attempt) return false;
      attempt.sendConfirmed = false;
      attempt.sendInFlight = true;
      attempt.earlyAck = null;
      return true;
    });
    if (!canSend) return;
    let sendError: unknown = null;
    try {
      await this.sendWithTimeout(Object.freeze({
        ...attempt.emission,
        bytes: attempt.emission.bytes.slice(),
      }));
    } catch (error) {
      sendError = error;
    }
    await this.enqueue(async () => {
      if (this.phase !== 'ready') return;
      attempt.sendInFlight = false;
      if (sendError) {
        await this.closeConnection('delta.transport_failure', true);
        return;
      }
      if (state.current !== attempt) return;
      if (retry) attempt.retriesUsed += 1;
      attempt.sendConfirmed = true;
      const earlyAck = attempt.earlyAck;
      attempt.earlyAck = null;
      if (earlyAck) {
        await this.processAck(earlyAck);
        return;
      }
      const timeoutAt = safeDeadline(normalizedNow(this.now), DEVICE_DELTA_ACK_TIMEOUT_MS);
      attempt.timeoutHandle = this.scheduler.schedule(timeoutAt, () => this.enqueue(() => {
        if (this.phase !== 'ready' || state.current !== attempt) return;
        return this.retryOrClose(state);
      }));
    });
  }

  private async sendWithTimeout(emission: DevicePostReadyEmission): Promise<void> {
    let timeoutHandle: unknown | null = null;
    let rejectTimeout: ((reason?: unknown) => void) | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    timeoutHandle = this.scheduler.schedule(
      safeDeadline(normalizedNow(this.now), DEVICE_DELTA_SEND_TIMEOUT_MS),
      () => rejectTimeout?.(new Error('Device delta send timed out'))
    );
    try {
      await Promise.race([Promise.resolve(this.send(emission)), timeout]);
    } finally {
      if (timeoutHandle !== null) this.scheduler.cancel(timeoutHandle);
    }
  }

  private async retryOrClose(state: TargetState): Promise<void> {
    const current = state.current;
    if (!current) return;
    this.cancelAttemptTimeout(state);
    if (current.retriesUsed >= DEVICE_DELTA_MAX_RETRIES) {
      await this.closeConnection('delta.retries_exhausted', true);
      return;
    }
    current.sendConfirmed = false;
    this.work.set(state.target, 'resend');
    this.schedulePump();
  }

  private invalidateCurrent(state: TargetState): void {
    state.epoch += 1;
    this.cancelAttemptTimeout(state);
    state.current = null;
    this.requestedChanges.add(state.target);
    this.reportReadiness(state.target, false);
    this.work.set(state.target, 'create');
    this.schedulePump();
  }

  private async failInternal(error: unknown): Promise<void> {
    this.reportBackground(error);
    await this.closeConnection('delta.internal_error', true);
  }

  private async closeConnection(
    reason: DevicePostReadyCloseReason,
    closeTransport: boolean,
    checkpoint = true
  ): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.closeReason = reason;
    this.work.clear();
    for (const state of this.states.values()) {
      this.cancelConfirmation(state);
      this.cancelAttemptTimeout(state);
      this.requestedChanges.add(state.target);
      this.reportReadiness(state.target, false);
    }
    const close = async () => {
      if (checkpoint && !this.checkpointWritten) {
        this.checkpointWritten = true;
        try {
          await this.onCheckpoint(reason, this.checkpointTargets(), normalizedNow(this.now));
        } catch (error) {
          this.reportBackground(error);
        }
      }
      if (closeTransport) {
        try {
          await this.closeTransport(reason);
        } catch (error) {
          this.reportBackground(error);
        }
      }
    };
    this.closePromise = close();
    await this.closePromise;
  }

  private checkpointTargets(): ReadonlyArray<DevicePostReadyCheckpointTarget> {
    return Object.freeze(this.targets.map((target) => {
      const base = this.states.get(target)!.base;
      return Object.freeze({
        target,
        issuerKeyId: base.identity.issuerKeyId,
        sequence: base.identity.sequence,
        sha256: base.identity.sha256,
        targetRevision: base.state.revision,
        catalogGeneration: base.state.catalogGeneration,
        appliedAt: base.appliedAt,
      });
    }));
  }

  private cancelConfirmation(state: TargetState): void {
    if (state.confirmationHandle === null) return;
    this.scheduler.cancel(state.confirmationHandle);
    state.confirmationHandle = null;
  }

  private cancelAttemptTimeout(state: TargetState): void {
    const handle = state.current?.timeoutHandle;
    if (handle === null || handle === undefined) return;
    this.scheduler.cancel(handle);
    state.current!.timeoutHandle = null;
  }

  private reportReadiness(target: ProductionBus, ready: boolean): void {
    try {
      this.onTargetReadinessChanged(target, ready);
    } catch (error) {
      this.reportBackground(error);
    }
  }

  private reportBackground(error: unknown): void {
    try {
      this.onBackgroundError(error);
    } catch {
      // Diagnostic adapters cannot grant readiness or prevent fail-closed behavior.
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
