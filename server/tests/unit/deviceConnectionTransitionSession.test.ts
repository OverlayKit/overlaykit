import { describe, expect, it, vi } from 'vitest';
import {
  DeviceConnectionTransitionSession,
} from '../../src/services/DeviceConnectionTransitionSession';
import type {
  DeviceConnectionTransitionInput,
  DeviceTransitionLedgerPort,
  DeviceTransitionRecord,
  DeviceTransitionReadyTargetEvidence,
} from '../../src/services/SqliteDeviceTransitionLedger';

function authority() {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g1',
    generation: 1,
    showId: 'show-1',
    expiresAt: 60_000,
    authorityHash: 'd'.repeat(64),
  };
}

function readyTarget(
  overrides: Partial<DeviceTransitionReadyTargetEvidence> = {},
): DeviceTransitionReadyTargetEvidence {
  return {
    target: 'preview',
    targetRevision: 2,
    catalogGeneration: 3,
    issuerKeyId: 'server-key-1',
    sequence: 4,
    sha256: 'a'.repeat(64),
    confirmedAt: 1_000,
    sentAt: 1_001,
    sendConfirmedAt: 1_002,
    appliedAt: 1_003,
    ...overrides,
  };
}

function fakeRecord(input: DeviceConnectionTransitionInput, sequence: number): DeviceTransitionRecord {
  return {
    schemaVersion: 'overlaykit-device-transition/v1',
    globalSequence: sequence,
    hostEpochId: 'host-1',
    connectionId: input.connectionId,
    kind: input.kind,
    occurredAt: input.occurredAt,
    previousGlobalHash: null,
    previousConnectionHash: null,
    evidence: input.kind === 'device.connection.not_ready'
      ? { authority: input.authority, targets: input.targets }
      : input.kind === 'device.connection.ready'
        ? { targets: input.targets }
        : { reason: input.reason },
    signature: null,
    recordHash: String(sequence).padStart(64, 'a'),
  };
}

function ledger(
  append: (input: DeviceConnectionTransitionInput) => DeviceTransitionRecord,
): DeviceTransitionLedgerPort {
  return {
    startHostEpoch: () => [],
    append,
    stopHostEpoch: () => { throw new Error('not used'); },
    getState: () => ({
      activeHostEpochId: 'host-1',
      globalSequence: 0,
      globalHash: null,
      failed: false,
      connectionPhases: {},
    }),
    readRecords: () => [],
  };
}

describe('DeviceConnectionTransitionSession', () => {
  it('commits positive transitions before projecting them in memory', () => {
    let session!: DeviceConnectionTransitionSession;
    const observedPhases: string[] = [];
    let sequence = 0;
    const sessionLedger = ledger((input) => {
      observedPhases.push(session.getPhase());
      sequence += 1;
      return fakeRecord(input, sequence);
    });
    session = new DeviceConnectionTransitionSession({
      ledger: sessionLedger,
      connectionId: 'connection-1',
      authority: authority(),
      targets: ['preview'],
      now: () => 1_000,
      onFatal: vi.fn(),
    });

    session.startNotReady();
    expect(session.getPhase()).toBe('not_ready');
    const witness = session.commitReady(1_004, [readyTarget()]);

    expect(observedPhases).toEqual(['new', 'not_ready']);
    expect(session.getPhase()).toBe('ready');
    expect(witness).toEqual({
      connectionId: 'connection-1',
      globalSequence: 2,
      recordHash: String(2).padStart(64, 'a'),
    });
    expect(Object.isFrozen(witness)).toBe(true);
  });

  it('removes authority before auditing negative transitions', () => {
    let session!: DeviceConnectionTransitionSession;
    const observedPhases: string[] = [];
    let sequence = 0;
    session = new DeviceConnectionTransitionSession({
      ledger: ledger((input) => {
        observedPhases.push(`${input.kind}:${session.getPhase()}`);
        sequence += 1;
        return fakeRecord(input, sequence);
      }),
      connectionId: 'connection-1',
      authority: authority(),
      targets: ['preview'],
      now: () => 1_000,
      onFatal: vi.fn(),
    });
    session.startNotReady();
    session.commitReady(1_004, [readyTarget()]);
    session.quiesce('credential.revoked');
    session.close('credential.revoked');

    expect(observedPhases.slice(-2)).toEqual([
      'device.connection.quiescing:quiescing',
      'device.connection.closed:closed',
    ]);
    expect(session.getPhase()).toBe('closed');
  });

  it('closes safety state and reports host fatal once when negative audit fails', () => {
    let sequence = 0;
    const onFatal = vi.fn();
    const session = new DeviceConnectionTransitionSession({
      ledger: ledger((input) => {
        if (input.kind === 'device.connection.quiescing'
          || input.kind === 'device.connection.closed') {
          throw new Error('audit unavailable');
        }
        sequence += 1;
        return fakeRecord(input, sequence);
      }),
      connectionId: 'connection-1',
      authority: authority(),
      targets: ['preview'],
      now: () => 1_000,
      onFatal,
    });
    session.startNotReady();
    session.commitReady(1_004, [readyTarget()]);

    expect(() => session.close('authority.changed')).not.toThrow();
    expect(session.getPhase()).toBe('closed');
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toEqual(expect.objectContaining({
      message: 'audit unavailable',
    }));
  });

  it('rejects readiness when connection authority changed or target evidence is incomplete', () => {
    let current = true;
    let sequence = 0;
    const append = vi.fn((input: DeviceConnectionTransitionInput) => {
      sequence += 1;
      return fakeRecord(input, sequence);
    });
    const session = new DeviceConnectionTransitionSession({
      ledger: ledger(append),
      connectionId: 'connection-1',
      authority: authority(),
      targets: ['preview', 'program'],
      authorityIsCurrent: () => current,
      now: () => 1_000,
      onFatal: vi.fn(),
    });
    session.startNotReady();

    expect(() => session.commitReady(1_004, [readyTarget()])).toThrow(
      'does not cover exact authorized targets',
    );
    current = false;
    expect(() => session.commitReady(1_004, [
      readyTarget(),
      readyTarget({ target: 'program', sequence: 5, sha256: 'b'.repeat(64) }),
    ])).toThrow('authority is not current');
    expect(session.getPhase()).toBe('not_ready');
    expect(append).toHaveBeenCalledTimes(1);
  });
});
