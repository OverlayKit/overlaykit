import { createHash } from 'crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import {
  SqliteDeviceTransitionLedger,
  type DeviceTransitionReadyTargetEvidence,
} from '../../src/services/SqliteDeviceTransitionLedger';

const stores: SqliteDeviceCredentialStore[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function databasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-transition-ledger-'));
  return path.join(directory, 'device-authority.sqlite');
}

function tracked(store: SqliteDeviceCredentialStore): SqliteDeviceCredentialStore {
  stores.push(store);
  return store;
}

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

function readyTarget(overrides: Partial<DeviceTransitionReadyTargetEvidence> = {}) {
  return {
    target: 'preview' as const,
    targetRevision: 7,
    catalogGeneration: 3,
    issuerKeyId: 'server-key-1',
    sequence: 11,
    sha256: 'a'.repeat(64),
    confirmedAt: 1_010,
    sentAt: 1_020,
    sendConfirmedAt: 1_025,
    appliedAt: 1_030,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Child did not emit ${expected}: ${output}`)), 8_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => {
      if (output.includes(expected)) return;
      clearTimeout(timeout);
      reject(new Error(`Child exited ${code}: ${output}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', resolve));
}

describe('SqliteDeviceTransitionLedger', () => {
  it('uses the credential authority connection and commits a canonical dual hash chain', async () => {
    const file = await databasePath();
    const openDatabase = vi.fn((database: string) => new DatabaseSync(database, { timeout: 0 }));
    const store = tracked(new SqliteDeviceCredentialStore({ databasePath: file, openDatabase }));
    await store.init();
    let now = 1_000;
    const ledger = store.createTransitionLedger({
      hostEpochId: 'host-1',
      now: () => now++,
    });

    ledger.startHostEpoch();
    ledger.append({
      kind: 'device.connection.not_ready',
      connectionId: 'connection-1',
      occurredAt: 1_005,
      authority: authority(),
      targets: ['preview'],
    });
    ledger.append({
      kind: 'device.connection.ready',
      connectionId: 'connection-1',
      occurredAt: 1_031,
      targets: [readyTarget()],
    });
    ledger.append({
      kind: 'device.connection.quiescing',
      connectionId: 'connection-1',
      occurredAt: 1_040,
      reason: 'credential.revoked',
    });
    ledger.append({
      kind: 'device.connection.closed',
      connectionId: 'connection-1',
      occurredAt: 1_041,
      reason: 'credential.revoked',
    });
    ledger.stopHostEpoch(1_050);

    expect(openDatabase).toHaveBeenCalledTimes(1);
    const records = ledger.readRecords();
    expect(records.map(({ globalSequence }) => globalSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [index, record] of records.entries()) {
      expect(record.previousGlobalHash).toBe(index === 0 ? null : records[index - 1].recordHash);
      expect(record.recordHash).toBe(
        createHash('sha256').update(JSON.stringify({
          schemaVersion: record.schemaVersion,
          globalSequence: record.globalSequence,
          hostEpochId: record.hostEpochId,
          connectionId: record.connectionId,
          kind: record.kind,
          occurredAt: record.occurredAt,
          previousGlobalHash: record.previousGlobalHash,
          previousConnectionHash: record.previousConnectionHash,
          evidence: record.evidence,
          signature: null,
        })).digest('hex'),
      );
    }
    expect(records[1].previousConnectionHash).toBeNull();
    expect(records[2].previousConnectionHash).toBe(records[1].recordHash);
    expect(records[3].previousConnectionHash).toBe(records[2].recordHash);
    expect(records[4].previousConnectionHash).toBe(records[3].recordHash);
    expect(ledger.getState()).toMatchObject({
      activeHostEpochId: null,
      globalSequence: 6,
      failed: false,
      connectionPhases: { 'connection-1': 'closed' },
    });
  });

  it('rejects unjustified state transitions before persistence', async () => {
    const store = tracked(new SqliteDeviceCredentialStore({ databasePath: await databasePath() }));
    await store.init();
    const ledger = store.createTransitionLedger({ hostEpochId: 'host-1', now: () => 1_000 });
    ledger.startHostEpoch();

    expect(() => ledger.append({
      kind: 'device.connection.ready',
      connectionId: 'connection-1',
      occurredAt: 1_040,
      targets: [readyTarget()],
    })).toThrow('invalid from absent');
    ledger.append({
      kind: 'device.connection.not_ready',
      connectionId: 'connection-1',
      occurredAt: 1_002,
      authority: authority(),
      targets: ['preview'],
    });
    expect(() => ledger.append({
      kind: 'device.connection.quiescing',
      connectionId: 'connection-1',
      occurredAt: 1_003,
      reason: 'authority.changed',
    })).toThrow('invalid from not_ready');
    expect(ledger.readRecords()).toHaveLength(2);
  });

  it('fails permanently on readiness commit uncertainty and detects the unsealed run', async () => {
    const file = await databasePath();
    const failingStore = tracked(new SqliteDeviceCredentialStore({ databasePath: file }));
    await failingStore.init();
    const failing = failingStore.createTransitionLedger({
      hostEpochId: 'host-failed',
      now: () => 1_000,
      beforeCommit(kind) {
        if (kind === 'device.connection.ready') throw new Error('injected ledger fault');
      },
    });
    failing.startHostEpoch();
    failing.append({
      kind: 'device.connection.not_ready',
      connectionId: 'connection-1',
      occurredAt: 1_001,
      authority: authority(),
      targets: ['preview'],
    });
    expect(() => failing.append({
      kind: 'device.connection.ready',
      connectionId: 'connection-1',
      occurredAt: 1_040,
      targets: [readyTarget()],
    })).toThrow('Failed to commit device transition evidence');
    expect(failing.getState().failed).toBe(true);
    expect(() => failing.append({
      kind: 'device.connection.closed',
      connectionId: 'connection-1',
      occurredAt: 1_003,
      reason: 'bootstrap.internal_error',
    })).toThrow('ledger is failed');

    failingStore.close();
    const recoveredStore = tracked(new SqliteDeviceCredentialStore({ databasePath: file }));
    await recoveredStore.init();
    const recovered = recoveredStore.createTransitionLedger({
      hostEpochId: 'host-recovered',
      now: () => 2_000,
    });
    const recovery = recovered.startHostEpoch();
    expect(recovery.map(({ kind }) => kind)).toEqual([
      'host.started',
      'host.discontinuity.detected',
      'device.connection.closed',
    ]);
    expect(recovered.getState().connectionPhases).toEqual({ 'connection-1': 'closed' });
    recovered.stopHostEpoch(2_010);
  });

  it('rejects tail truncation against the separately committed durable head', async () => {
    const file = await databasePath();
    const store = tracked(new SqliteDeviceCredentialStore({ databasePath: file }));
    await store.init();
    const ledger = store.createTransitionLedger({ hostEpochId: 'host-1', now: () => 1_000 });
    ledger.startHostEpoch();
    ledger.stopHostEpoch(1_001);
    store.close();

    const tamper = new DatabaseSync(file);
    tamper.exec('DROP TRIGGER device_transition_ledger_no_delete');
    tamper.exec('DELETE FROM device_transition_ledger WHERE global_sequence = 2');
    tamper.close();

    const reopened = tracked(new SqliteDeviceCredentialStore({ databasePath: file }));
    await reopened.init();
    expect(() => reopened.createTransitionLedger({ hostEpochId: 'host-2' })).toThrow(
      'durable head does not match history',
    );
  });

  it('persists bounded evidence without secrets, labels, or snapshot bytes', async () => {
    const store = tracked(new SqliteDeviceCredentialStore({ databasePath: await databasePath() }));
    await store.init();
    const ledger = store.createTransitionLedger({ hostEpochId: 'host-1', now: () => 1_000 });
    ledger.startHostEpoch();
    ledger.append({
      kind: 'device.connection.not_ready',
      connectionId: 'connection-1',
      occurredAt: 1_001,
      authority: authority(),
      targets: ['preview'],
    });
    ledger.append({
      kind: 'device.connection.closed',
      connectionId: 'connection-1',
      occurredAt: 1_002,
      reason: 'authority.rejected',
    });
    ledger.stopHostEpoch(1_003);

    const persisted = JSON.stringify(ledger.readRecords());
    expect(persisted).not.toContain('Bearer');
    expect(persisted).not.toContain('sealed-');
    expect(persisted).not.toContain('Production desk');
    expect(persisted).not.toContain('lower-third');
    expect(persisted).not.toContain('snapshotBytes');
    expect(persisted).toContain('device-1.g1');
    expect(persisted).toContain('authority.rejected');
  });

  it('recovers a SIGKILL host as an explicit discontinuity without restoring authority', async () => {
    const file = await databasePath();
    const storeModule = path.resolve(
      process.cwd(),
      process.cwd().endsWith(`${path.sep}server`)
        ? 'src/auth/SqliteDeviceCredentialStore.ts'
        : 'server/src/auth/SqliteDeviceCredentialStore.ts',
    );
    const childScript = `
      const loaded = await import(${JSON.stringify(pathToFileURL(storeModule).href)});
      const { SqliteDeviceCredentialStore } = loaded.default ?? loaded;
      const store = new SqliteDeviceCredentialStore({ databasePath: process.env.DEVICE_DB });
      await store.init();
      const ledger = store.createTransitionLedger({ hostEpochId: 'host-killed', now: () => 1000 });
      ledger.startHostEpoch();
      ledger.append({
        kind: 'device.connection.not_ready',
        connectionId: 'connection-killed',
        occurredAt: 1001,
        authority: ${JSON.stringify(authority())},
        targets: ['preview'],
      });
      process.stdout.write('LEDGER_READY\\n');
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      childScript,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DEVICE_DB: file },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    await waitForOutput(child, 'LEDGER_READY');

    const exited = waitForExit(child);
    child.kill('SIGKILL');
    await exited;
    children.splice(children.indexOf(child), 1);

    const successor = tracked(new SqliteDeviceCredentialStore({ databasePath: file }));
    await successor.init();
    const recovered = successor.createTransitionLedger({
      hostEpochId: 'host-successor',
      now: () => 2_000,
    });
    const recovery = recovered.startHostEpoch();
    expect(recovery.map(({ kind }) => kind)).toEqual([
      'host.started',
      'host.discontinuity.detected',
      'device.connection.closed',
    ]);
    expect(recovered.getState().connectionPhases).toEqual({
      'connection-killed': 'closed',
    });
    expect(recovered.readRecords().some((record) => (
      record.kind === 'device.connection.ready'
      && record.connectionId === 'connection-killed'
    ))).toBe(false);
    recovered.stopHostEpoch(2_010);
  });

  it('serializes multiple connection chains through one global order', async () => {
    const store = tracked(new SqliteDeviceCredentialStore({ databasePath: await databasePath() }));
    await store.init();
    const ledger = store.createTransitionLedger({ hostEpochId: 'host-1', now: () => 1_000 });
    ledger.startHostEpoch();
    for (const connectionId of ['connection-a', 'connection-b']) {
      ledger.append({
        kind: 'device.connection.not_ready',
        connectionId,
        occurredAt: 1_001,
        authority: {
          ...authority(),
          credentialId: `device-${connectionId}`,
          audienceCredentialId: `device-${connectionId}.g1`,
        },
        targets: ['preview'],
      });
    }
    ledger.append({
      kind: 'device.connection.closed',
      connectionId: 'connection-b',
      occurredAt: 1_002,
      reason: 'authority.rejected',
    });
    ledger.append({
      kind: 'device.connection.ready',
      connectionId: 'connection-a',
      occurredAt: 1_040,
      targets: [readyTarget()],
    });
    ledger.append({
      kind: 'device.connection.quiescing',
      connectionId: 'connection-a',
      occurredAt: 1_041,
      reason: 'server.shutdown',
    });
    ledger.append({
      kind: 'device.connection.closed',
      connectionId: 'connection-a',
      occurredAt: 1_042,
      reason: 'server.shutdown',
    });
    ledger.stopHostEpoch(1_043);

    const records = ledger.readRecords();
    expect(records.map(({ globalSequence }) => globalSequence)).toEqual(
      Array.from({ length: records.length }, (_, index) => index + 1),
    );
    const connectionA = records.filter(({ connectionId }) => connectionId === 'connection-a');
    const connectionB = records.filter(({ connectionId }) => connectionId === 'connection-b');
    for (const chain of [connectionA, connectionB]) {
      chain.forEach((record, index) => {
        expect(record.previousConnectionHash).toBe(index === 0 ? null : chain[index - 1].recordHash);
      });
    }
  });
});
