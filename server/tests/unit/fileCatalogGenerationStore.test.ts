import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CatalogGenerationStoreError,
  FileCatalogGenerationStore,
  type CatalogGenerationSyncPurpose,
} from '../../src/services/FileCatalogGenerationStore';

const temporaryDirectories: string[] = [];
const stores: FileCatalogGenerationStore[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function tracked<T extends FileCatalogGenerationStore>(store: T): T {
  stores.push(store);
  return store;
}

function hash(character: string): string {
  return character.repeat(64);
}

async function temporaryStore(audience = 'device-1.g1'): Promise<{
  readonly directory: string;
  readonly filePath: string;
  readonly store: FileCatalogGenerationStore;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-catalog-generation-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'private', 'catalog.json');
  return {
    directory,
    filePath,
    store: tracked(new FileCatalogGenerationStore(audience, filePath)),
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class TracingStore extends FileCatalogGenerationStore {
  readonly trace: string[] = [];

  protected override async synchronizeFile(
    handle: FileHandle,
    purpose: CatalogGenerationSyncPurpose
  ): Promise<void> {
    if (purpose === 'generation') this.trace.push('file.sync');
    await super.synchronizeFile(handle, purpose);
  }

  protected override async replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
    this.trace.push('file.rename');
    await super.replaceFile(temporaryPath, targetPath);
  }

  protected override async synchronizeDirectory(
    directory: string,
    purpose: CatalogGenerationSyncPurpose
  ): Promise<void> {
    if (purpose === 'generation') this.trace.push('directory.sync');
    await super.synchronizeDirectory(directory, purpose);
  }
}

class UnsupportedDirectorySyncStore extends FileCatalogGenerationStore {
  protected override async synchronizeDirectory(): Promise<void> {
    throw Object.assign(new Error('unsupported directory sync'), { code: 'ENOTSUP' });
  }
}

class RecoveringStore extends FileCatalogGenerationStore {
  private failNextGeneration = true;

  protected override async replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
    if (this.failNextGeneration) {
      this.failNextGeneration = false;
      throw Object.assign(new Error('temporary write failure'), { code: 'EIO' });
    }
    await super.replaceFile(temporaryPath, targetPath);
  }
}

class GatedDirectorySyncStore extends FileCatalogGenerationStore {
  readonly syncStarted = deferred();
  readonly continueSync = deferred();

  protected override async synchronizeDirectory(
    directory: string,
    purpose: CatalogGenerationSyncPurpose
  ): Promise<void> {
    if (purpose === 'generation') {
      this.syncStarted.resolve();
      await this.continueSync.promise;
    }
    await super.synchronizeDirectory(directory, purpose);
  }
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Child output timeout; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(expected)) finish();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null) => {
      finish(new Error(`Child exited before authority was ready (${code}); stderr=${stderr}`));
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', resolve));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('FileCatalogGenerationStore', () => {
  it('invalidates immediately, preserves ABA changes, and continues after restart', async () => {
    const { filePath, store } = await temporaryStore();
    await store.init();

    const first = store.observe(hash('a'));
    expect(first.generation).toBe(1);
    expect(store.isCurrent(first)).toBe(false);
    await store.confirm(first);
    expect(store.isCurrent(first)).toBe(true);

    const changed = store.observe(hash('b'));
    const returned = store.observe(hash('a'));
    expect(changed.generation).toBe(2);
    expect(returned.generation).toBe(3);
    expect(store.isCurrent(first)).toBe(false);
    await expect(store.confirm(changed)).rejects.toMatchObject({
      code: 'STALE_CATALOG_GENERATION',
    });
    await store.confirm(returned);
    await store.close();

    const restarted = tracked(new FileCatalogGenerationStore('device-1.g1', filePath));
    await restarted.init();
    const same = restarted.observe(hash('a'));
    expect(same.generation).toBe(3);
    expect(restarted.isCurrent(same)).toBe(true);
    const next = restarted.observe(hash('b'));
    await restarted.confirm(next);
    expect(next.generation).toBe(4);
  });

  it('persists only after file sync, replacement, and directory sync', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new TracingStore('device-1.g1', filePath));
    await store.init();
    store.trace.splice(0);

    const token = store.observe(hash('a'));
    await store.confirm(token);
    expect(store.trace).toEqual(['file.sync', 'file.rename', 'directory.sync']);
    expect(store.getState()).toMatchObject({
      phase: 'ready',
      durability: 'power_loss_resilient',
      currentGeneration: 1,
      durableGeneration: 1,
    });
  });

  it('does not expose a generation while directory synchronization is pending', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new GatedDirectorySyncStore('device-1.g1', filePath));
    await store.init();
    const token = store.observe(hash('a'));
    let settled = false;
    const confirmation = store.confirm(token).finally(() => {
      settled = true;
    });

    await store.syncStarted.promise;
    expect(settled).toBe(false);
    expect(store.isCurrent(token)).toBe(false);
    store.continueSync.resolve();
    await confirmation;
    expect(store.isCurrent(token)).toBe(true);
  });

  it('degrades observably only when directory synchronization is unsupported', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new UnsupportedDirectorySyncStore('device-1.g1', filePath));
    await store.init();
    const token = store.observe(hash('a'));
    await store.confirm(token);
    expect(store.getState()).toMatchObject({
      phase: 'ready',
      durability: 'process_restart_resilient',
      authorityHeld: true,
    });
  });

  it('blocks only its audience after I/O failure and recovers on a later confirmation', async () => {
    const first = await temporaryStore('device-1.g1');
    const failing = tracked(new RecoveringStore('device-1.g1', first.filePath));
    stores.splice(stores.indexOf(first.store), 1);
    await failing.init();
    const token = failing.observe(hash('a'));
    await expect(failing.confirm(token)).rejects.toMatchObject({
      code: 'CATALOG_GENERATION_STORE_IO',
    });
    expect(failing.getState()).toMatchObject({ phase: 'blocked', durableGeneration: null });

    const other = await temporaryStore('device-2.g1');
    await other.store.init();
    const otherToken = other.store.observe(hash('b'));
    await expect(other.store.confirm(otherToken)).resolves.toBeUndefined();

    const retry = failing.observe(hash('a'));
    expect(retry).toEqual(token);
    await expect(failing.confirm(retry)).resolves.toBeUndefined();
    expect(failing.isCurrent(retry)).toBe(true);
  });

  it('rejects a second live authority across canonical aliases', async () => {
    const { filePath, store } = await temporaryStore();
    await store.init();
    const alias = path.join(path.dirname(filePath), '..', 'private', path.basename(filePath));
    const competing = tracked(new FileCatalogGenerationStore('device-1.g1', alias));

    await expect(competing.init()).rejects.toMatchObject({
      code: 'CATALOG_GENERATION_AUTHORITY_UNAVAILABLE',
    });
    await store.close();
    const successor = tracked(new FileCatalogGenerationStore('device-1.g1', alias));
    await expect(successor.init()).resolves.toBeUndefined();
  });

  it('rejects a second authority held by another server process', async () => {
    const { filePath } = await temporaryStore();
    const moduleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'src/services/FileCatalogGenerationStore.ts')
    ).href;
    const childScript = `
      const loaded = await import(${JSON.stringify(moduleUrl)});
      const { FileCatalogGenerationStore } = loaded.default ?? loaded;
      const store = new FileCatalogGenerationStore('device-1.g1', process.env.CATALOG_FILE);
      await store.init();
      process.stdout.write('AUTHORITY_READY\\n');
      process.stdin.once('data', async () => {
        await store.close();
        process.exit(0);
      });
      process.stdin.resume();
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', childScript],
      {
        cwd: process.cwd(),
        env: { ...process.env, CATALOG_FILE: filePath },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    children.push(child);
    await waitForChildOutput(child, 'AUTHORITY_READY');

    const competing = tracked(new FileCatalogGenerationStore('device-1.g1', filePath));
    await expect(competing.init()).rejects.toMatchObject({
      code: 'CATALOG_GENERATION_AUTHORITY_UNAVAILABLE',
    });

    const exited = waitForChildExit(child);
    child.stdin.write('\n');
    expect(await exited).toBe(0);
    children.splice(children.indexOf(child), 1);
  });

  it('fails closed for malformed, foreign-audience, and exhausted state', async () => {
    const { filePath, store } = await temporaryStore();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const foreign = JSON.stringify({
      schemaVersion: 1,
      audienceCredentialId: 'device-2.g1',
      generation: Number.MAX_SAFE_INTEGER,
      catalogHash: hash('a'),
    });
    await fs.writeFile(filePath, foreign, 'utf8');
    await expect(store.init()).rejects.toMatchObject<CatalogGenerationStoreError>({
      code: 'INVALID_CATALOG_GENERATION_STORE',
    });

    const exhaustedFile = path.join(path.dirname(filePath), 'exhausted.json');
    await fs.writeFile(
      exhaustedFile,
      JSON.stringify({
        schemaVersion: 1,
        audienceCredentialId: 'device-1.g1',
        generation: Number.MAX_SAFE_INTEGER,
        catalogHash: hash('a'),
      }),
      'utf8'
    );
    const exhausted = tracked(new FileCatalogGenerationStore('device-1.g1', exhaustedFile));
    await exhausted.init();
    expect(() => exhausted.observe(hash('b'))).toThrowError(CatalogGenerationStoreError);
    try {
      exhausted.observe(hash('b'));
    } catch (error) {
      expect(error).toMatchObject({ code: 'CATALOG_GENERATION_EXHAUSTED' });
    }
  });
});
