import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';

/**
 * CHG-0068 hardening: the SQLite authority file holds the Ed25519 device-signing private key and
 * every sealed verifier, so it must be owner-only from the moment it exists — including inside a
 * pre-existing world-readable data directory, and even when init fails after the file is created.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('SqliteDeviceCredentialStore key-file permissions', () => {
  let dir = '';
  const stores: SqliteDeviceCredentialStore[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-perms-'));
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // a store that failed to init has nothing to close
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function mode(target: string): Promise<number> {
    return (await fs.stat(target)).mode & 0o777;
  }

  it('tightens a pre-existing world-readable directory and the file to owner-only', async () => {
    const databasePath = path.join(dir, 'nested', 'device-credentials.sqlite');
    // Simulate a data directory an earlier deploy created at 0o755, where mkdir's mode is ignored.
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.chmod(path.dirname(databasePath), 0o755);

    const store = new SqliteDeviceCredentialStore({ databasePath });
    stores.push(store);
    await store.init();

    expect(await mode(path.dirname(databasePath))).toBe(0o700);
    expect(await mode(databasePath)).toBe(0o600);
  });

  it('leaves the authority file owner-only even when init fails after the file is created', async () => {
    const databasePath = path.join(dir, 'device-credentials.sqlite');
    const store = new SqliteDeviceCredentialStore({
      databasePath,
      beforeCommit: (phase) => {
        if (phase === 'initialize') throw new Error('injected init failure');
      },
    });
    stores.push(store);

    await expect(store.init()).rejects.toThrow();
    // The file was created by open(); the early chmod must have run before the failure.
    expect(await mode(databasePath)).toBe(0o600);
  });
});
