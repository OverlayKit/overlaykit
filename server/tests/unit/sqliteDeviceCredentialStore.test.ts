import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredDeviceCredential } from '@overlaykit/protocol/device-credential';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';

const stores: SqliteDeviceCredentialStore[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function record(generation = 1): StoredDeviceCredential {
  return {
    credentialId: 'device-1',
    label: 'Production desk',
    showId: 'show-1',
    targets: ['preview'],
    controlIds: ['lower-third.visibility'],
    scopes: ['feedback:read'],
    generation,
    sealedSecret: `sealed-${generation}`,
    issuedBy: 'owner-1',
    issuedAt: 1_000,
    updatedAt: 1_000 + generation,
    expiresAt: 60_000,
    revokedAt: null,
  };
}

async function location(): Promise<{
  directory: string;
  databasePath: string;
  legacyFilePath: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-device-sqlite-'));
  return {
    directory,
    databasePath: path.join(directory, 'device-credentials.sqlite'),
    legacyFilePath: path.join(directory, 'device-credentials.json'),
  };
}

function tracked(options: ConstructorParameters<typeof SqliteDeviceCredentialStore>[0]) {
  const store = new SqliteDeviceCredentialStore(options);
  stores.push(store);
  return store;
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
      if (!output.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Child exited ${code}: ${output}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', resolve));
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
});

describe('SqliteDeviceCredentialStore', () => {
  it('holds one exclusive authority and releases it for a successor', async () => {
    const paths = await location();
    const owner = tracked(paths);
    const contender = tracked(paths);
    await owner.init();
    await owner.create(record());

    await expect(contender.init()).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_STORE_IO',
    });
    await expect(owner.get('device-1')).resolves.toMatchObject({ generation: 1 });

    owner.close();
    await expect(contender.init()).resolves.toBeUndefined();
    await expect(contender.get('device-1')).resolves.toMatchObject({ generation: 1 });
  });

  it('recovers the exclusive authority after abrupt process death', async () => {
    const paths = await location();
    const modulePath = path.resolve(
      process.cwd(),
      process.cwd().endsWith(`${path.sep}server`)
        ? 'src/auth/SqliteDeviceCredentialStore.ts'
        : 'server/src/auth/SqliteDeviceCredentialStore.ts'
    );
    const childScript = `
      const loaded = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const { SqliteDeviceCredentialStore } = loaded.default ?? loaded;
      const store = new SqliteDeviceCredentialStore({ databasePath: process.env.DEVICE_DB });
      await store.init();
      process.stdout.write('AUTHORITY_READY\\n');
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', childScript],
      {
        cwd: process.cwd(),
        env: { ...process.env, DEVICE_DB: paths.databasePath },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    children.push(child);
    await waitForOutput(child, 'AUTHORITY_READY');

    const contender = tracked(paths);
    await expect(contender.init()).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_STORE_IO',
    });

    const exited = waitForExit(child);
    child.kill('SIGKILL');
    await exited;
    children.splice(children.indexOf(child), 1);
    await expect(contender.init()).resolves.toBeUndefined();
  });

  it('imports complete legacy JSON atomically and archives it only after commit', async () => {
    const paths = await location();
    const raw = `${JSON.stringify({ schemaVersion: 1, records: [record()] }, null, 2)}\n`;
    await fs.writeFile(paths.legacyFilePath, raw, 'utf8');
    const store = tracked(paths);

    await store.init();

    await expect(store.get('device-1')).resolves.toMatchObject({ generation: 1 });
    await expect(fs.readFile(`${paths.legacyFilePath}.migrated`, 'utf8')).resolves.toBe(raw);
    await expect(fs.stat(paths.legacyFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back a migration commit fault and can retry from the untouched JSON', async () => {
    const paths = await location();
    const raw = JSON.stringify({ schemaVersion: 1, records: [record()] });
    await fs.writeFile(paths.legacyFilePath, raw, 'utf8');
    const failing = tracked({
      ...paths,
      beforeCommit(phase) {
        if (phase === 'initialize') throw new Error('injected commit failure');
      },
    });

    await expect(failing.init()).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_STORE_IO' });
    await expect(fs.readFile(paths.legacyFilePath, 'utf8')).resolves.toBe(raw);
    failing.close();

    const recovered = tracked(paths);
    await recovered.init();
    await expect(recovered.get('device-1')).resolves.toMatchObject({ generation: 1 });
  });

  it('resumes archival after a committed migration without importing twice', async () => {
    const paths = await location();
    const raw = JSON.stringify({ schemaVersion: 1, records: [record()] });
    await fs.writeFile(paths.legacyFilePath, raw, 'utf8');
    const failing = tracked({
      ...paths,
      archiveLegacyFile: async () => {
        throw new Error('injected archive failure');
      },
    });

    await expect(failing.init()).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_STORE_IO' });
    failing.close();
    const recovered = tracked(paths);
    await recovered.init();

    await expect(recovered.get('device-1')).resolves.toMatchObject({ generation: 1 });
    await expect(fs.stat(paths.legacyFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('upgrades a version 2 authority in place without losing credentials', async () => {
    const paths = await location();
    const original = tracked(paths);
    await original.init();
    await original.create(record());
    original.close();

    const versionTwo = new DatabaseSync(paths.databasePath);
    versionTwo.exec(`
      DROP TABLE production_current_snapshots;
      DROP TABLE production_history;
      DROP TABLE production_quarantines;
      DROP TABLE production_commands;
      DROP TABLE production_command_order;
      DROP TABLE production_command_quarantines;
      DELETE FROM authority_metadata
      WHERE key IN (
        'production_history_head_sequence',
        'production_history_head_hash',
        'production_command_head_sequence',
        'production_command_head_hash'
      );
      PRAGMA user_version = 2;
    `);
    versionTwo.close();

    const upgraded = tracked(paths);
    await upgraded.init();
    await expect(upgraded.get('device-1')).resolves.toMatchObject({ generation: 1 });
    expect(upgraded.createProductionStateStore().load()).toEqual({
      snapshots: [],
      quarantines: [],
    });
  });

  it('upgrades version 3 state in place and initializes an empty command journal', async () => {
    const paths = await location();
    const original = tracked(paths);
    await original.init();
    await original.create(record());
    const originalPersistence = original.createProductionStateStore();
    const production = new ProductionService(new ChannelManager());
    production.mountPersistence(originalPersistence);
    production.loadPreview('show-1', {
      id: 'preserved-scene',
      name: 'Preserved scene',
      elements: [{ id: 'lower-third', tag: 'section', content: 'Preserved', styles: {} }],
    });
    original.close();
    stores.splice(stores.indexOf(original), 1);

    const versionThree = new DatabaseSync(paths.databasePath);
    versionThree.exec(`
      DROP TABLE production_commands;
      DROP TABLE production_command_order;
      DROP TABLE production_command_quarantines;
      DELETE FROM authority_metadata
      WHERE key IN ('production_command_head_sequence', 'production_command_head_hash');
      PRAGMA user_version = 3;
    `);
    versionThree.close();

    const upgraded = tracked(paths);
    await upgraded.init();
    await expect(upgraded.get('device-1')).resolves.toMatchObject({ generation: 1 });
    const upgradedPersistence = upgraded.createProductionStateStore();
    expect(upgradedPersistence.load().snapshots).toEqual([
      expect.objectContaining({ showId: 'show-1', target: 'preview', revision: 1 }),
    ]);
    expect(upgradedPersistence.readCommandJournal()).toEqual([]);
  });

  it('rejects malformed migration and later JSON that conflicts with initialized authority', async () => {
    const malformedPaths = await location();
    await fs.writeFile(malformedPaths.legacyFilePath, '{"records":[]}', 'utf8');
    await expect(tracked(malformedPaths).init()).rejects.toMatchObject({
      code: 'INVALID_DEVICE_CREDENTIAL_STORE',
    });

    const paths = await location();
    const initialized = tracked(paths);
    await initialized.init();
    initialized.close();
    await fs.writeFile(
      paths.legacyFilePath,
      JSON.stringify({ schemaVersion: 1, records: [record()] }),
      'utf8'
    );
    await expect(tracked(paths).init()).rejects.toMatchObject({
      code: 'INVALID_DEVICE_CREDENTIAL_STORE',
    });
  });

  it('commits compare-and-swap replacement atomically', async () => {
    const paths = await location();
    const store = tracked(paths);
    await store.init();
    await expect(store.create(record())).resolves.toBe(true);
    await expect(store.create(record())).resolves.toBe(false);
    await expect(store.replace(record(2), 7)).resolves.toBe(false);
    await expect(store.replace(record(2), 1)).resolves.toBe(true);
    await expect(store.get('device-1')).resolves.toMatchObject({
      generation: 2,
      sealedSecret: 'sealed-2',
    });
  });
});
