import { createHash } from 'crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DeviceCredentialAuthority,
  IssuedDeviceCredential,
} from '@overlaykit/protocol/device-credential';
import {
  createDeviceCredentialRuntime,
  type DeviceCredentialRuntime,
} from '../../src/auth/DeviceCredentialRuntime';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import {
  canonicalProductionJson,
  MAX_PRODUCTION_SNAPSHOT_BYTES,
  productionCommandOperationHash,
  productionSnapshotPayload,
  PRODUCTION_COMMAND_ORDER_VERSION,
} from '../../src/services/SqliteProductionStateStore';
import type {
  SqliteProductionStateStore,
  SqliteProductionStateStoreOptions,
} from '../../src/services/SqliteProductionStateStore';
import type { ComponentVisibilityIntent, ProductionBus } from '../../src/types/production';
import type { Scene } from '../../src/types/scene';

const OWNER = { principalId: 'owner-1', roles: ['owner'] } as const;
const runtimes: DeviceCredentialRuntime[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

interface OpenAuthority {
  readonly runtime: DeviceCredentialRuntime;
  readonly persistence: SqliteProductionStateStore;
  readonly production: ProductionService;
}

function scene(id: string, content = id): Scene {
  return {
    id,
    name: `Scene ${id}`,
    elements: [
      { id: 'lower-third', tag: 'section', content, styles: {} },
      { id: 'scoreboard', tag: 'section', content: 'Scoreboard', styles: {} },
    ],
  };
}

async function databasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-command-authority-'));
  return path.join(directory, 'authority.sqlite');
}

async function openAuthority(
  file: string,
  options: Omit<SqliteProductionStateStoreOptions, 'database'> = {}
): Promise<OpenAuthority> {
  const credentials = new SqliteDeviceCredentialStore({ databasePath: file });
  await credentials.init();
  const persistence = credentials.createProductionStateStore(options);
  const runtime = await createDeviceCredentialRuntime({
    store: credentials,
    productionState: persistence,
  });
  const production = new ProductionService(new ChannelManager());
  try {
    production.mountPersistence(persistence);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  runtimes.push(runtime);
  return { runtime, persistence, production };
}

async function closeTracked(runtime: DeviceCredentialRuntime): Promise<void> {
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);
}

async function issue(
  runtime: DeviceCredentialRuntime,
  showId = 'show-1',
  controlIds: string[] = ['lower-third.visibility']
): Promise<IssuedDeviceCredential> {
  return runtime.lifecycle.issue(OWNER, {
    label: `Desk ${showId}`,
    showId,
    targets: ['preview', 'program'],
    controlIds,
    scopes: ['component.visibility:write'],
    expiresAt: Date.now() + 60_000,
  });
}

function visibilityIntent(
  operationId: string,
  expectedRevision: number,
  visible: boolean,
  showId = 'show-1',
  target: ProductionBus = 'preview',
  componentId = 'lower-third'
): ComponentVisibilityIntent {
  return {
    kind: 'component.visibility',
    showId,
    target,
    componentId,
    visible,
    operationId,
    expectedRevision,
  };
}

async function authorize(
  runtime: DeviceCredentialRuntime,
  token: string,
  intent: ComponentVisibilityIntent
): Promise<DeviceCredentialAuthority> {
  return runtime.lifecycle.authorize(token, {
    showId: intent.showId,
    target: intent.target,
    controlId: `${intent.componentId}.visibility`,
    scope: 'component.visibility:write',
  });
}

async function execute(authority: OpenAuthority, token: string, intent: ComponentVisibilityIntent) {
  const deviceAuthority = await authorize(authority.runtime, token, intent);
  return authority.production.executeDeviceVisibilityCommand(intent, {
    directProgram: intent.target === 'program',
    deviceAuthority,
  });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`Child did not emit ${expected}: ${output}`)),
      8_000
    );
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
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

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = waitForExit(child);
  child.kill('SIGKILL');
  await exited;
  children.splice(children.indexOf(child), 1);
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
});

describe('durable production command authority', () => {
  it('replays the original result after rotation, later state, and restart', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', scene('initial', 'Initial editorial content'));
    const issued = await issue(first.runtime);
    const intent = visibilityIntent('durable-hide', 1, false);

    const applied = await execute(first, issued.token, intent);
    expect(applied.command).toMatchObject({
      status: 'applied',
      resultCode: 'APPLIED',
      globalSequence: 1,
      authorityGeneration: 1,
      resultingRevision: 2,
      replayed: false,
    });
    first.production.loadPreview('show-1', scene('later', 'Later editorial content'));
    const rotated = await first.runtime.lifecycle.rotate(OWNER, issued.credential.credentialId);
    await closeTracked(first.runtime);

    const successor = await openAuthority(file);
    const replay = await execute(successor, rotated.token, intent);

    expect(replay.receipt).toEqual(applied.receipt);
    expect(replay.command).toEqual({ ...applied.command, replayed: true });
    expect(replay.command?.authorityGeneration).toBe(1);
    expect(replay.state.preview).toMatchObject({ revision: 3, scene: { id: 'later' } });
    expect(successor.persistence.readCommandJournal()).toHaveLength(1);
  });

  it('commits command evidence before exposing memory or observer publication', async () => {
    const file = await databasePath();
    const observedRevisions: number[] = [];
    let authority!: OpenAuthority;
    authority = await openAuthority(file, {
      beforeCommit(phase) {
        if (phase !== 'command') return;
        expect(authority.production.getSnapshot('show-1', 'preview').revision).toBe(1);
        expect(authority.persistence.readCommandJournal()).toHaveLength(1);
        expect(observedRevisions).toEqual([]);
      },
      afterCommit(phase) {
        if (phase !== 'command') return;
        expect(authority.production.getSnapshot('show-1', 'preview').revision).toBe(1);
        expect(authority.persistence.readCommandJournal()).toHaveLength(1);
        expect(observedRevisions).toEqual([]);
      },
    });
    authority.production.loadPreview('show-1', scene('publication-order'));
    authority.production.subscribe('show-1', (observation) => {
      observedRevisions.push(observation.state.preview.revision);
    });
    const issued = await issue(authority.runtime);

    const result = await execute(
      authority,
      issued.token,
      visibilityIntent('publication-order', 1, false)
    );

    expect(result.command).toMatchObject({ status: 'applied', resultingRevision: 2 });
    expect(authority.production.getSnapshot('show-1', 'preview').revision).toBe(2);
    expect(observedRevisions).toEqual([2]);
  });

  it('isolates operation identity by stable principal and rejects conflicting reuse', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', scene('identity'));
    const firstPrincipal = await issue(authority.runtime);
    const secondPrincipal = await issue(authority.runtime);

    const first = await execute(
      authority,
      firstPrincipal.token,
      visibilityIntent('shared-operation', 1, false)
    );
    const second = await execute(
      authority,
      secondPrincipal.token,
      visibilityIntent('shared-operation', 2, true)
    );

    expect(first.command?.globalSequence).toBe(1);
    expect(second.command?.globalSequence).toBe(2);
    await expect(
      execute(authority, firstPrincipal.token, visibilityIntent('shared-operation', 1, true))
    ).rejects.toMatchObject({ code: 'OPERATION_ID_CONFLICT', details: undefined });
    expect(authority.persistence.readCommandJournal().map((record) => record.principalId)).toEqual([
      firstPrincipal.credential.credentialId,
      secondPrincipal.credential.credentialId,
    ]);
  });

  it('converges concurrent duplicates and conflicting submissions on one admission', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', scene('concurrency'));
    const issued = await issue(authority.runtime);
    const duplicate = visibilityIntent('duplicate', 1, false);

    const duplicates = await Promise.all([
      execute(authority, issued.token, duplicate),
      execute(authority, issued.token, duplicate),
    ]);
    expect(duplicates.map((result) => result.command?.replayed).sort()).toEqual([false, true]);
    expect(authority.persistence.readCommandJournal()).toHaveLength(1);
    expect(authority.production.getSnapshot('show-1', 'preview').revision).toBe(2);

    const conflicts = await Promise.allSettled([
      execute(authority, issued.token, visibilityIntent('conflict', 2, true)),
      execute(authority, issued.token, visibilityIntent('conflict', 2, false)),
    ]);
    expect(conflicts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = conflicts.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'OPERATION_ID_CONFLICT' },
    });
    expect(authority.persistence.readCommandJournal()).toHaveLength(2);
    expect(authority.production.getSnapshot('show-1', 'preview').revision).toBe(3);
  });

  it('consumes stale revisions but not malformed, unauthorized, or unresolvable commands', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', scene('admission'));
    const issued = await issue(authority.runtime, 'show-1', [
      'lower-third.visibility',
      'missing.visibility',
    ]);
    const stale = visibilityIntent('stale', 0, false);

    await expect(execute(authority, issued.token, stale)).rejects.toMatchObject({
      code: 'TARGET_REVISION_CONFLICT',
      details: {
        actualRevision: 1,
        command: {
          status: 'rejected',
          resultCode: 'TARGET_REVISION_CONFLICT',
          globalSequence: 1,
          replayed: false,
        },
      },
    });
    await expect(execute(authority, issued.token, stale)).rejects.toMatchObject({
      details: { command: { globalSequence: 1, replayed: true } },
    });
    await expect(
      execute(authority, issued.token, visibilityIntent('stale', 1, false))
    ).rejects.toMatchObject({ code: 'OPERATION_ID_CONFLICT' });

    const validIntent = visibilityIntent('retryable', 1, false);
    const currentAuthority = await authorize(authority.runtime, issued.token, validIntent);
    expect(() =>
      authority.production.executeDeviceVisibilityCommand(
        { ...validIntent, visible: 'invalid' as unknown as boolean },
        { directProgram: false, deviceAuthority: currentAuthority }
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_VISIBILITY' }));
    expect(() =>
      authority.production.executeDeviceVisibilityCommand(
        { ...validIntent, componentId: ' lower-third' },
        { directProgram: false, deviceAuthority: currentAuthority }
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_COMPONENT_ID' }));
    expect(() =>
      authority.production.executeDeviceVisibilityCommand(
        { ...validIntent, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { directProgram: false, deviceAuthority: currentAuthority }
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TARGET_REVISION' }));
    expect(() =>
      authority.production.executeDeviceVisibilityCommand(validIntent, {
        directProgram: false,
        deviceAuthority: { ...currentAuthority, scopes: ['feedback:read'] },
      })
    ).toThrowError(expect.objectContaining({ code: 'DEVICE_AUTHORITY_CHANGED' }));
    await expect(
      execute(
        authority,
        issued.token,
        visibilityIntent('missing-component', 1, false, 'show-1', 'preview', 'missing')
      )
    ).rejects.toMatchObject({ code: 'COMPONENT_NOT_FOUND' });
    expect(authority.persistence.readCommandJournal()).toHaveLength(1);

    const applied = await execute(authority, issued.token, validIntent);
    expect(applied.command).toMatchObject({ globalSequence: 2, status: 'applied' });
    expect(authority.persistence.readCommandJournal()).toHaveLength(2);
  });

  it('replays a durable revision rejection after later state and restart', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', scene('rejected-initial'));
    const issued = await issue(first.runtime);
    const stale = visibilityIntent('durable-rejection', 0, false);

    await expect(execute(first, issued.token, stale)).rejects.toMatchObject({
      code: 'TARGET_REVISION_CONFLICT',
      details: {
        actualRevision: 1,
        command: { globalSequence: 1, status: 'rejected', replayed: false },
      },
    });
    first.production.loadPreview('show-1', scene('rejected-later'));
    await closeTracked(first.runtime);

    const successor = await openAuthority(file);
    await expect(execute(successor, issued.token, stale)).rejects.toMatchObject({
      code: 'TARGET_REVISION_CONFLICT',
      details: {
        actualRevision: 1,
        command: { globalSequence: 1, status: 'rejected', replayed: true },
      },
    });
    expect(successor.production.getSnapshot('show-1', 'preview')).toMatchObject({
      revision: 2,
      scene: { id: 'rejected-later' },
    });
    expect(successor.persistence.readCommandJournal()).toHaveLength(1);
  });

  it('rechecks current authority inside admission and withholds replay after revocation', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', scene('authorization-race'));
    const issued = await issue(authority.runtime);
    const intent = visibilityIntent('authority-race', 1, false);
    const staleAuthority = await authorize(authority.runtime, issued.token, intent);
    const rotated = await authority.runtime.lifecycle.rotate(OWNER, issued.credential.credentialId);

    expect(() =>
      authority.production.executeDeviceVisibilityCommand(intent, {
        directProgram: false,
        deviceAuthority: staleAuthority,
      })
    ).toThrowError(expect.objectContaining({ code: 'DEVICE_AUTHORITY_CHANGED' }));
    expect(authority.persistence.readCommandJournal()).toHaveLength(0);

    const applied = await execute(authority, rotated.token, intent);
    expect(applied.command).toMatchObject({ authorityGeneration: 2, status: 'applied' });
    const generationTwo = await authorize(authority.runtime, rotated.token, intent);
    await authority.runtime.lifecycle.revoke(OWNER, issued.credential.credentialId);
    expect(() =>
      authority.production.executeDeviceVisibilityCommand(intent, {
        directProgram: false,
        deviceAuthority: generationTwo,
      })
    ).toThrowError(expect.objectContaining({ code: 'DEVICE_AUTHORITY_CHANGED' }));
    expect(authority.persistence.readCommandJournal()).toHaveLength(1);
  });

  it('samples credential expiration inside the serialized admission transaction', async () => {
    const file = await databasePath();
    let admissionNow = Date.now();
    const authority = await openAuthority(file, { now: () => admissionNow });
    authority.production.loadPreview('show-1', scene('expiration-boundary'));
    const issued = await issue(authority.runtime);
    const intent = visibilityIntent('expiration-boundary', 1, false);

    admissionNow = issued.credential.expiresAt;
    await expect(execute(authority, issued.token, intent)).rejects.toMatchObject({
      code: 'DEVICE_AUTHORITY_CHANGED',
    });
    expect(authority.persistence.readCommandJournal()).toHaveLength(0);

    admissionNow = issued.credential.expiresAt - 1;
    const admitted = await execute(authority, issued.token, intent);
    expect(admitted.command).toMatchObject({
      committedAt: admissionNow,
      status: 'applied',
      replayed: false,
    });
    expect(authority.persistence.readCommandJournal()).toHaveLength(1);
  });

  it('rejects an oversized command without consuming identity or poisoning authority', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', scene('size-boundary', ''));
    const base = authority.production.getSnapshot('show-1', 'preview');
    const baseBytes = Buffer.byteLength(productionSnapshotPayload(base), 'utf8');
    const filler = 'x'.repeat(Math.floor((MAX_PRODUCTION_SNAPSHOT_BYTES - baseBytes - 5) / 2));
    authority.production.loadPreview('show-1', scene('size-boundary', filler));
    const issued = await issue(authority.runtime);
    const intent = visibilityIntent('size-boundary', 2, false);

    expect(
      Buffer.byteLength(
        productionSnapshotPayload(authority.production.getSnapshot('show-1', 'preview')),
        'utf8'
      )
    ).toBeLessThanOrEqual(MAX_PRODUCTION_SNAPSHOT_BYTES);
    await expect(execute(authority, issued.token, intent)).rejects.toMatchObject({
      code: 'PRODUCTION_SNAPSHOT_TOO_LARGE',
      status: 413,
    });
    expect(authority.persistence.readCommandJournal()).toHaveLength(0);
    expect(authority.production.getSnapshot('show-1', 'preview').revision).toBe(2);

    authority.production.loadPreview('show-1', scene('size-recovered'));
    const recovered = await execute(
      authority,
      issued.token,
      visibilityIntent('size-boundary', 3, false)
    );
    expect(recovered.command).toMatchObject({ globalSequence: 1, status: 'applied' });
  });

  it.each(['before', 'after'] as const)(
    'recovers one authoritative result from an injected %s-commit failure',
    async (barrier) => {
      const file = await databasePath();
      const first = await openAuthority(file, {
        beforeCommit(phase) {
          if (phase === 'command' && barrier === 'before') {
            throw new Error('injected before-commit failure');
          }
        },
        afterCommit(phase) {
          if (phase === 'command' && barrier === 'after') {
            throw new Error('injected after-commit failure');
          }
        },
      });
      first.production.loadPreview('show-1', scene(`fault-${barrier}`));
      const issued = await issue(first.runtime);
      const intent = visibilityIntent(`fault-${barrier}`, 1, false);

      await expect(execute(first, issued.token, intent)).rejects.toMatchObject({
        code: 'PRODUCTION_COMMAND_AUTHORITY_FAILED',
      });
      await closeTracked(first.runtime);

      const successor = await openAuthority(file);
      expect(successor.persistence.readCommandJournal()).toHaveLength(barrier === 'before' ? 0 : 1);
      expect(successor.production.getSnapshot('show-1', 'preview').revision).toBe(
        barrier === 'before' ? 1 : 2
      );
      const recovered = await execute(successor, issued.token, intent);
      expect(recovered.command).toMatchObject({
        globalSequence: 1,
        replayed: barrier === 'after',
        status: 'applied',
      });
      expect(successor.persistence.readCommandJournal()).toHaveLength(1);
    }
  );

  it('enforces explicit per-Show and global quotas without evicting replay evidence', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file, {
      maxCommandsPerShow: 2,
      maxCommandsGlobal: 3,
    });
    authority.production.loadPreview('show-1', scene('quota-one'));
    authority.production.loadPreview('show-2', scene('quota-two'));
    const showOne = await issue(authority.runtime, 'show-1');
    const showTwo = await issue(authority.runtime, 'show-2');
    const firstIntent = visibilityIntent('show-one-1', 1, false);

    const first = await execute(authority, showOne.token, firstIntent);
    await execute(authority, showOne.token, visibilityIntent('show-one-2', 2, true));
    await expect(
      execute(authority, showOne.token, visibilityIntent('show-one-full', 3, false))
    ).rejects.toMatchObject({ code: 'PRODUCTION_COMMAND_JOURNAL_FULL', status: 507 });
    const replay = await execute(authority, showOne.token, firstIntent);
    expect(replay.command).toEqual({ ...first.command, replayed: true });

    await execute(authority, showTwo.token, visibilityIntent('show-two-1', 1, false, 'show-2'));
    await expect(
      execute(authority, showTwo.token, visibilityIntent('global-full', 2, true, 'show-2'))
    ).rejects.toMatchObject({ code: 'PRODUCTION_COMMAND_JOURNAL_FULL', status: 507 });
    expect(
      authority.persistence.readCommandJournal().map((record) => record.globalSequence)
    ).toEqual([1, 2, 3]);
  });

  it('binds applied rows to production history while retaining bounded non-editorial evidence', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    const prohibitedContent = 'PROHIBITED_EDITORIAL_COMMAND_PAYLOAD_8d3187';
    const prohibitedOperationId = 'PROHIBITED_OPERATION_SECRET_65b761';
    authority.production.loadPreview('show-1', scene('privacy', prohibitedContent));
    const issued = await issue(authority.runtime);
    const result = await execute(
      authority,
      issued.token,
      visibilityIntent(prohibitedOperationId, 1, false)
    );
    const command = authority.persistence.readCommandJournal()[0];
    const history = authority.persistence
      .readHistory()
      .find(
        (record) =>
          record.showId === 'show-1' && record.target === 'preview' && record.revision === 2
      );

    expect(history).toMatchObject({
      mutationKind: 'component.visibility',
      operationId: productionCommandOperationHash(prohibitedOperationId),
      occurredAt: command.committedAt,
      snapshotHash: command.resultingSnapshotHash,
    });
    expect(result.command?.resultingSnapshotHash).toBe(history?.snapshotHash);
    await closeTracked(authority.runtime);

    const inspect = new DatabaseSync(file);
    const rows = inspect
      .prepare('SELECT * FROM production_commands ORDER BY global_sequence')
      .all() as unknown as Array<Record<string, unknown>>;
    const historyRows = inspect
      .prepare('SELECT * FROM production_history ORDER BY global_sequence')
      .all() as unknown as Array<Record<string, unknown>>;
    const columns = inspect
      .prepare('PRAGMA table_info(production_commands)')
      .all() as unknown as Array<{ name: string }>;
    inspect.close();
    const serialized = JSON.stringify({ rows, historyRows });
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain(issued.credential.label);
    expect(serialized).not.toContain(prohibitedContent);
    expect(serialized).not.toContain(prohibitedOperationId);
    expect(columns.map(({ name }) => name)).not.toContain('payload');
    expect(columns.map(({ name }) => name)).not.toContain('label');
  });

  it('quarantines one corrupt Show command chain while preserving a sibling Show', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', scene('corrupt-one'));
    first.production.loadPreview('show-2', scene('healthy-two'));
    const showOne = await issue(first.runtime, 'show-1');
    const showTwo = await issue(first.runtime, 'show-2');
    await execute(first, showOne.token, visibilityIntent('show-one', 1, false));
    await execute(first, showTwo.token, visibilityIntent('show-two', 1, false, 'show-2'));
    await closeTracked(first.runtime);

    const tamper = new DatabaseSync(file);
    tamper.exec('DROP TRIGGER production_commands_no_update');
    tamper
      .prepare('UPDATE production_commands SET authority_hash = ? WHERE show_id = ?')
      .run('0'.repeat(64), 'show-1');
    tamper.close();

    const successor = await openAuthority(file);
    await expect(
      execute(successor, showOne.token, visibilityIntent('blocked-show', 2, true))
    ).rejects.toMatchObject({ code: 'PRODUCTION_COMMAND_SHOW_QUARANTINED' });
    const sibling = await execute(
      successor,
      showTwo.token,
      visibilityIntent('healthy-show', 2, true, 'show-2')
    );
    expect(sibling.command).toMatchObject({ globalSequence: 3, status: 'applied' });
    await closeTracked(successor.runtime);

    const inspect = new DatabaseSync(file);
    const quarantines = inspect
      .prepare('SELECT show_id FROM production_command_quarantines ORDER BY show_id')
      .all() as unknown as Array<{ show_id: string }>;
    inspect.close();
    expect(quarantines).toEqual([{ show_id: 'show-1' }]);
  });

  it('does not consume a stale command while its production target is quarantined', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', scene('target-quarantine'));
    const issued = await issue(first.runtime);
    await closeTracked(first.runtime);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare(
        "UPDATE production_current_snapshots SET payload = 'corrupt' WHERE show_id = 'show-1' AND target = 'preview'"
      )
      .run();
    tamper.close();

    const successor = await openAuthority(file);
    await expect(
      execute(successor, issued.token, visibilityIntent('quarantined-stale', 0, false))
    ).rejects.toMatchObject({ code: 'PRODUCTION_TARGET_QUARANTINED' });
    expect(successor.persistence.readCommandJournal()).toHaveLength(0);
  });

  it('quarantines a hash-valid command result that is not bound to production history', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', scene('cross-evidence'));
    const issued = await issue(first.runtime);
    await execute(first, issued.token, visibilityIntent('cross-evidence', 1, false));
    const original = first.persistence.readCommandJournal()[0];
    await closeTracked(first.runtime);

    const { recordHash: _recordHash, ...document } = original;
    const tamperedDocument = {
      ...document,
      resultingSnapshotHash: 'f'.repeat(64),
    };
    const commandRecordHash = createHash('sha256')
      .update(canonicalProductionJson(tamperedDocument))
      .digest('hex');
    const orderDocument = {
      schemaVersion: PRODUCTION_COMMAND_ORDER_VERSION,
      globalSequence: 1,
      showId: 'show-1',
      commandRecordHash,
      previousGlobalHash: null,
    };
    const orderRecordHash = createHash('sha256')
      .update(canonicalProductionJson(orderDocument))
      .digest('hex');
    const tamper = new DatabaseSync(file);
    tamper.exec(`
      DROP TRIGGER production_commands_no_update;
      DROP TRIGGER production_command_order_no_update;
    `);
    tamper
      .prepare(
        'UPDATE production_commands SET resulting_snapshot_hash = ?, record_hash = ? WHERE global_sequence = 1'
      )
      .run(tamperedDocument.resultingSnapshotHash, commandRecordHash);
    tamper
      .prepare(
        'UPDATE production_command_order SET command_record_hash = ?, record_hash = ? WHERE global_sequence = 1'
      )
      .run(commandRecordHash, orderRecordHash);
    tamper
      .prepare("UPDATE authority_metadata SET value = ? WHERE key = 'production_command_head_hash'")
      .run(orderRecordHash);
    tamper.close();

    const successor = await openAuthority(file);
    await expect(
      execute(successor, issued.token, visibilityIntent('blocked-cross-evidence', 2, true))
    ).rejects.toMatchObject({ code: 'PRODUCTION_COMMAND_SHOW_QUARANTINED' });
  });

  it('aborts writable composition when the global command head cannot be verified', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', scene('head'));
    const issued = await issue(first.runtime);
    await execute(first, issued.token, visibilityIntent('head-command', 1, false));
    await closeTracked(first.runtime);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare("UPDATE authority_metadata SET value = ? WHERE key = 'production_command_head_hash'")
      .run('0'.repeat(64));
    tamper.close();

    await expect(openAuthority(file)).rejects.toThrow(
      'Production command order does not match its durable head'
    );
  });

  it.each(['before', 'after'] as const)(
    'recovers exactly one truth after SIGKILL %s command COMMIT',
    async (barrier) => {
      const file = await databasePath();
      const baseline = await openAuthority(file);
      baseline.production.loadPreview('show-1', scene('crash-baseline'));
      const issued = await issue(baseline.runtime);
      const intent = visibilityIntent(`sigkill-${barrier}`, 1, false);
      const deviceAuthority = await authorize(baseline.runtime, issued.token, intent);
      await closeTracked(baseline.runtime);

      const root = process.cwd().endsWith(`${path.sep}server`)
        ? process.cwd()
        : path.join(process.cwd(), 'server');
      const credentialModule = pathToFileURL(
        path.join(root, 'src/auth/SqliteDeviceCredentialStore.ts')
      ).href;
      const productionModule = pathToFileURL(
        path.join(root, 'src/services/ProductionService.ts')
      ).href;
      const channelModule = pathToFileURL(path.join(root, 'src/services/ChannelManager.ts')).href;
      const childScript = `
        const fs = await import('node:fs');
        const credentialLoaded = await import(${JSON.stringify(credentialModule)});
        const productionLoaded = await import(${JSON.stringify(productionModule)});
        const channelLoaded = await import(${JSON.stringify(channelModule)});
        const { SqliteDeviceCredentialStore } = credentialLoaded.default ?? credentialLoaded;
        const { ProductionService } = productionLoaded.default ?? productionLoaded;
        const { ChannelManager } = channelLoaded.default ?? channelLoaded;
        const stop = (label) => {
          fs.writeSync(1, label + '\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        };
        const credentials = new SqliteDeviceCredentialStore({ databasePath: process.env.DEVICE_DB });
        await credentials.init();
        const persistence = credentials.createProductionStateStore({
          beforeCommit(phase) {
            if (phase === 'command' && process.env.BARRIER === 'before') stop('BARRIER_BEFORE');
          },
          afterCommit(phase) {
            if (phase === 'command' && process.env.BARRIER === 'after') stop('BARRIER_AFTER');
          },
        });
        const production = new ProductionService(new ChannelManager());
        production.mountPersistence(persistence);
        const intent = JSON.parse(process.env.INTENT);
        const deviceAuthority = JSON.parse(process.env.AUTHORITY);
        production.executeDeviceVisibilityCommand(intent, {
          directProgram: false,
          deviceAuthority,
        });
      `;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childScript],
        {
          cwd: root,
          env: {
            ...process.env,
            DEVICE_DB: file,
            BARRIER: barrier,
            INTENT: JSON.stringify(intent),
            AUTHORITY: JSON.stringify(deviceAuthority),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      children.push(child);
      await waitForOutput(child, barrier === 'before' ? 'BARRIER_BEFORE' : 'BARRIER_AFTER');
      await killChild(child);

      const successor = await openAuthority(file);
      expect(successor.persistence.readCommandJournal()).toHaveLength(barrier === 'before' ? 0 : 1);
      expect(successor.production.getSnapshot('show-1', 'preview').revision).toBe(
        barrier === 'before' ? 1 : 2
      );
      const recovered = await execute(successor, issued.token, intent);
      expect(recovered.command).toMatchObject({
        globalSequence: 1,
        status: 'applied',
        replayed: barrier === 'after',
      });
      expect(successor.persistence.readCommandJournal()).toHaveLength(1);
    }
  );
});
