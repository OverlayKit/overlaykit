import { createHash } from 'crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import {
  canonicalProductionJson,
  productionSnapshotPayload,
  type ProductionStatePersistencePort,
} from '../../src/services/SqliteProductionStateStore';
import type { Scene } from '../../src/types/scene';

const stores: SqliteDeviceCredentialStore[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function productionScene(content: string): Scene {
  return {
    id: 'live-scene',
    name: 'Live Scene',
    elements: [
      {
        id: 'lower-third',
        tag: 'section',
        content,
        styles: {},
        controls: [
          {
            id: 'headline',
            label: 'Headline',
            type: 'text',
            path: 'headline',
          },
        ],
      },
      {
        id: 'scoreboard',
        tag: 'section',
        content: 'Scoreboard',
        styles: { display: 'none' },
      },
    ],
  };
}

async function databasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-production-sqlite-'));
  return path.join(directory, 'authority.sqlite');
}

async function openAuthority(
  file: string,
  options: Parameters<SqliteDeviceCredentialStore['createProductionStateStore']>[0] = {},
  openDatabase?: (databasePath: string) => DatabaseSync
): Promise<{
  credentials: SqliteDeviceCredentialStore;
  persistence: ProductionStatePersistencePort;
  production: ProductionService;
}> {
  const credentials = new SqliteDeviceCredentialStore({
    databasePath: file,
    ...(openDatabase ? { openDatabase } : {}),
  });
  stores.push(credentials);
  await credentials.init();
  const persistence = credentials.createProductionStateStore(options);
  const production = new ProductionService(new ChannelManager());
  production.mountPersistence(persistence);
  return { credentials, persistence, production };
}

function closeTracked(store: SqliteDeviceCredentialStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
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
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
});

describe('SqliteProductionStateStore', () => {
  it('canonicalizes every own JSON key without prototype semantics', () => {
    const value = JSON.parse(
      '{"constructor":"metadata","alpha":1,"__proto__":{"polluted":true}}'
    ) as Record<string, unknown>;

    expect(canonicalProductionJson(value)).toBe(
      '{"__proto__":{"polluted":true},"alpha":1,"constructor":"metadata"}'
    );
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('uses code-unit object-key order even for integer-shaped keys', () => {
    const value = JSON.parse('{"2":"two","10":"ten"}') as Record<string, unknown>;

    expect(canonicalProductionJson(value)).toBe('{"10":"ten","2":"two"}');
    expect(() => canonicalProductionJson({ invalid: undefined })).toThrow(
      'Production state contains a non-JSON value'
    );
  });

  it('serializes every live mutation on one connection with canonical hash evidence', async () => {
    const file = await databasePath();
    const openDatabase = vi.fn((database: string) => new DatabaseSync(database, { timeout: 0 }));
    const authority = await openAuthority(file, {}, openDatabase);
    expect(() => authority.credentials.createProductionStateStore()).toThrow(
      'SQLite production authority has already been created'
    );

    authority.production.loadPreview('show-1', productionScene('Lower third'), {
      headline: 'Initial',
    });
    authority.production.applyPreviewControls('show-1', 1, 'controls-1', {
      headline: 'Updated',
    });
    authority.production.take('show-1', 2, 'take-1');
    authority.production.executeVisibilityIntent(
      {
        kind: 'component.visibility',
        showId: 'show-1',
        target: 'preview',
        componentId: 'lower-third',
        visible: false,
        operationId: 'hide-preview',
        expectedRevision: 2,
      },
      { directProgram: false }
    );
    authority.production.executeVisibilityIntent(
      {
        kind: 'component.visibility',
        showId: 'show-1',
        target: 'program',
        componentId: 'lower-third',
        visible: false,
        operationId: 'hide-program',
        expectedRevision: 1,
      },
      { directProgram: true }
    );
    authority.production.executeCue(
      {
        cue: {
          id: 'show-score',
          showId: 'show-1',
          target: 'preview',
          steps: [
            {
              id: 'show',
              kind: 'component.visibility',
              componentId: 'scoreboard',
              visible: true,
            },
          ],
        },
        operationId: 'cue-1',
        expectedRevision: 3,
      },
      { directProgram: false }
    );

    expect(openDatabase).toHaveBeenCalledTimes(1);
    const history = authority.persistence.readHistory();
    expect(history.map((record) => record.mutationKind)).toEqual([
      'preview.load',
      'preview.controls',
      'program.take',
      'component.visibility',
      'component.visibility',
      'cue.step',
    ]);
    expect(history.map((record) => record.globalSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [index, record] of history.entries()) {
      expect(record.previousGlobalHash).toBe(index === 0 ? null : history[index - 1].recordHash);
      const { recordHash, ...document } = record;
      expect(recordHash).toBe(
        createHash('sha256').update(canonicalProductionJson(document)).digest('hex')
      );
    }
    for (const target of ['preview', 'program'] as const) {
      const targetRecords = history.filter((record) => record.target === target);
      for (const [index, record] of targetRecords.entries()) {
        expect(record.previousTargetHash).toBe(
          index === 0 ? null : targetRecords[index - 1].recordHash
        );
      }
    }
    const preview = authority.production.getSnapshot('show-1', 'preview');
    expect(preview.revision).toBe(4);
    expect(authority.production.getSnapshot('show-1', 'program').revision).toBe(2);
    expect(history.at(-1)?.snapshotHash).toBe(
      createHash('sha256').update(productionSnapshotPayload(preview)).digest('hex')
    );
  });

  it('rolls back a pre-commit fault without changing durable or in-memory truth', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file, {
      beforeCommit(phase) {
        if (phase === 'snapshot') throw new Error('injected pre-commit fault');
      },
    });

    expect(() =>
      authority.production.loadPreview('show-1', productionScene('Rejected'), {
        headline: 'Rejected',
      })
    ).toThrowError(expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_FAILED' }));
    closeTracked(authority.credentials);

    const successor = await openAuthority(file);
    expect(successor.persistence.readHistory()).toHaveLength(0);
    expect(successor.production.getSnapshot('show-1', 'preview')).toMatchObject({
      revision: 0,
      scene: null,
    });
  });

  it('rejects recovery history that is not bound to rejected-state evidence', async () => {
    const file = await databasePath();
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', productionScene('Committed'), {
      headline: 'Committed',
    });
    const current = authority.production.getSnapshot('show-1', 'preview');
    const occurredAt = Date.now();

    expect(() =>
      authority.persistence.commit({
        snapshot: { ...current, revision: 2, updatedAt: occurredAt },
        expectedPreviousRevision: 1,
        mutationKind: 'quarantine.restore',
        operationId: 'unbound-recovery',
        occurredAt,
      })
    ).toThrow('Production recovery history must bind an operation and the rejected snapshot hash');
    expect(authority.persistence.readHistory()).toHaveLength(1);
  });

  it('retains only one complete current editorial payload and bounded history metadata', async () => {
    const file = await databasePath();
    const oldSecret = 'PROHIBITED_OLD_EDITORIAL_PAYLOAD_7d203ff5';
    const authority = await openAuthority(file);
    authority.production.loadPreview('show-1', productionScene(oldSecret), {
      headline: oldSecret,
    });
    authority.production.loadPreview('show-1', productionScene('Current content'), {
      headline: 'Current content',
    });
    closeTracked(authority.credentials);

    const inspect = new DatabaseSync(file);
    const current = inspect
      .prepare(
        `
      SELECT payload FROM production_current_snapshots
      WHERE show_id = ? AND target = ?
    `
      )
      .all('show-1', 'preview') as unknown as Array<{ payload: string }>;
    const history = inspect
      .prepare('SELECT * FROM production_history ORDER BY global_sequence')
      .all() as unknown as Array<Record<string, unknown>>;
    const columns = inspect
      .prepare('PRAGMA table_info(production_history)')
      .all() as unknown as Array<{ name: string }>;
    inspect.close();

    expect(current).toHaveLength(1);
    expect(current[0].payload).toContain('Current content');
    expect(current[0].payload).not.toContain(oldSecret);
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain(oldSecret);
    expect(columns.map(({ name }) => name)).not.toContain('payload');
    expect((await fs.readFile(file)).includes(Buffer.from(oldSecret))).toBe(false);
  });

  it('aborts startup when global history and its separately durable head diverge', async () => {
    const file = await databasePath();
    const first = await openAuthority(file);
    first.production.loadPreview('show-1', productionScene('Committed'), {
      headline: 'Committed',
    });
    closeTracked(first.credentials);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare(
        `
      UPDATE authority_metadata SET value = ?
      WHERE key = 'production_history_head_hash'
    `
      )
      .run('0'.repeat(64));
    tamper.close();

    const credentials = new SqliteDeviceCredentialStore({ databasePath: file });
    stores.push(credentials);
    await credentials.init();
    const production = new ProductionService(new ChannelManager());
    expect(() => production.mountPersistence(credentials.createProductionStateStore())).toThrow(
      'Production history does not match its durable head'
    );
  });

  it.each(['before', 'after'] as const)(
    'recovers old/new truth after SIGKILL %s durable commit',
    async (barrier) => {
      const file = await databasePath();
      const baseline = await openAuthority(file);
      baseline.production.loadPreview('show-1', {
        id: 'baseline-scene',
        name: 'Baseline Scene',
        elements: [{ id: 'title', tag: 'div', content: 'old-truth', styles: {} }],
      });
      closeTracked(baseline.credentials);
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
        const credentials = new SqliteDeviceCredentialStore({
          databasePath: process.env.DEVICE_DB,
        });
        await credentials.init();
        const persistence = credentials.createProductionStateStore({
          beforeCommit(phase) {
            if (phase === 'snapshot' && process.env.BARRIER === 'before') stop('BARRIER_BEFORE');
          },
          afterCommit(phase) {
            if (phase === 'snapshot' && process.env.BARRIER === 'after') stop('BARRIER_AFTER');
          },
        });
        const production = new ProductionService(new ChannelManager());
        production.mountPersistence(persistence);
        production.loadPreview('show-1', {
          id: 'crash-scene',
          name: 'Crash Scene',
          elements: [{ id: 'title', tag: 'div', content: 'committed-after-crash', styles: {} }],
        });
      `;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childScript],
        {
          cwd: root,
          env: { ...process.env, DEVICE_DB: file, BARRIER: barrier },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      children.push(child);
      await waitForOutput(child, barrier === 'before' ? 'BARRIER_BEFORE' : 'BARRIER_AFTER');
      await killChild(child);

      const successor = await openAuthority(file);
      const snapshot = successor.production.getSnapshot('show-1', 'preview');
      if (barrier === 'before') {
        expect(snapshot).toMatchObject({
          revision: 1,
          scene: { id: 'baseline-scene' },
          elements: [{ content: 'old-truth' }],
        });
        expect(successor.persistence.readHistory()).toHaveLength(1);
      } else {
        expect(snapshot).toMatchObject({
          revision: 2,
          scene: { id: 'crash-scene' },
          elements: [{ content: 'committed-after-crash' }],
        });
        expect(successor.persistence.readHistory()).toHaveLength(2);
      }
    }
  );
});
