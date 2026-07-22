import type { ProductionBus } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};
import type {
  DeviceTransitionAuthorityEvidence,
  DeviceTransitionCheckpointTargetEvidence,
  DeviceTransitionLedgerPort,
  DeviceTransitionReadyTargetEvidence,
} from './SqliteDeviceTransitionLedger';

export type DeviceConnectionTransitionSessionPhase =
  | 'new'
  | 'not_ready'
  | 'ready'
  | 'quiescing'
  | 'closed';

export interface DeviceReadinessCommitWitness {
  readonly connectionId: string;
  readonly globalSequence: number;
  readonly recordHash: string;
}

export interface DeviceConnectionTransitionSessionOptions {
  readonly ledger: DeviceTransitionLedgerPort;
  readonly connectionId: string;
  readonly authority: DeviceTransitionAuthorityEvidence;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly now?: () => number;
  readonly onFatal: (error: unknown) => void;
  readonly authorityIsCurrent?: () => boolean;
}

export interface DeviceReadinessTransitionPort {
  commitReady(
    occurredAt: number,
    targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence>,
  ): DeviceReadinessCommitWitness;
  checkpoint(
    occurredAt: number,
    reason: string,
    targets: ReadonlyArray<DeviceTransitionCheckpointTargetEvidence>,
  ): void;
  close(reason: string): void;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim();
}

function normalizedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Device transition clock is invalid');
  }
  return value;
}

export class DeviceConnectionTransitionSession implements DeviceReadinessTransitionPort {
  private readonly ledger: DeviceTransitionLedgerPort;
  private readonly connectionId: string;
  private readonly authority: DeviceTransitionAuthorityEvidence;
  private readonly targets: ReadonlyArray<ProductionBus>;
  private readonly now: () => number;
  private readonly onFatal: (error: unknown) => void;
  private readonly authorityIsCurrent: () => boolean;
  private phase: DeviceConnectionTransitionSessionPhase = 'new';
  private fatalReported = false;
  private checkpointed = false;

  constructor(options: DeviceConnectionTransitionSessionOptions) {
    if (
      !options
      || !options.ledger
      || typeof options.ledger.append !== 'function'
      || !validIdentifier(options.connectionId)
      || !options.authority
      || !Array.isArray(options.targets)
      || typeof options.onFatal !== 'function'
      || (options.authorityIsCurrent !== undefined
        && typeof options.authorityIsCurrent !== 'function')
    ) {
      throw new Error('Device connection transition session dependencies are invalid');
    }
    this.ledger = options.ledger;
    this.connectionId = options.connectionId;
    this.authority = Object.freeze({ ...options.authority });
    this.targets = Object.freeze([...options.targets]);
    this.now = options.now ?? Date.now;
    this.onFatal = options.onFatal;
    this.authorityIsCurrent = options.authorityIsCurrent ?? (() => true);
    normalizedNow(this.now);
  }

  startNotReady(): void {
    if (this.phase !== 'new') throw new Error('Device transition session already started');
    this.ledger.append({
      kind: 'device.connection.not_ready',
      connectionId: this.connectionId,
      occurredAt: normalizedNow(this.now),
      authority: this.authority,
      targets: this.targets,
    });
    this.phase = 'not_ready';
  }

  commitReady(
    occurredAt: number,
    targets: ReadonlyArray<DeviceTransitionReadyTargetEvidence>,
  ): DeviceReadinessCommitWitness {
    if (this.phase !== 'not_ready') throw new Error('Device connection is not awaiting readiness');
    let authorityCurrent = false;
    try {
      authorityCurrent = this.authorityIsCurrent() === true;
    } catch {
      authorityCurrent = false;
    }
    if (!authorityCurrent) throw new Error('Device connection authority is not current');
    const expectedTargets = [...this.targets].sort();
    const actualTargets = targets.map(({ target }) => target).sort();
    if (
      actualTargets.length !== expectedTargets.length
      || actualTargets.some((target, index) => target !== expectedTargets[index])
    ) {
      throw new Error('Readiness witness does not cover exact authorized targets');
    }
    const record = this.ledger.append({
      kind: 'device.connection.ready',
      connectionId: this.connectionId,
      occurredAt,
      targets,
    });
    this.phase = 'ready';
    return Object.freeze({
      connectionId: this.connectionId,
      globalSequence: record.globalSequence,
      recordHash: record.recordHash,
    });
  }

  quiesce(reason: string): void {
    if (this.phase !== 'ready') return;
    this.phase = 'quiescing';
    this.appendSafetyTransition('device.connection.quiescing', reason);
  }

  checkpoint(
    occurredAt: number,
    reason: string,
    targets: ReadonlyArray<DeviceTransitionCheckpointTargetEvidence>,
  ): void {
    if (this.phase !== 'ready') {
      throw new Error('Device connection is not ready for checkpoint');
    }
    if (this.checkpointed) {
      throw new Error('Device connection checkpoint already exists');
    }
    try {
      this.ledger.append({
        kind: 'device.connection.checkpoint',
        connectionId: this.connectionId,
        occurredAt,
        audienceCredentialId: this.authority.audienceCredentialId,
        reason,
        targets,
      });
    } catch (error) {
      this.reportFatal(error);
      throw error;
    }
    this.checkpointed = true;
  }

  close(reason: string): void {
    if (this.phase === 'closed' || this.phase === 'new') return;
    if (this.phase === 'ready') this.quiesce(reason);
    this.phase = 'closed';
    this.appendSafetyTransition('device.connection.closed', reason);
  }

  getPhase(): DeviceConnectionTransitionSessionPhase {
    return this.phase;
  }

  private appendSafetyTransition(
    kind: 'device.connection.quiescing' | 'device.connection.closed',
    reason: string,
  ): void {
    try {
      this.ledger.append({
        kind,
        connectionId: this.connectionId,
        occurredAt: normalizedNow(this.now),
        reason,
      });
    } catch (error) {
      this.reportFatal(error);
    }
  }

  private reportFatal(error: unknown): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    try {
      this.onFatal(error);
    } catch {
      // Safety state remains removed even if the host-fatal observer fails.
    }
  }
}
