import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeedbackSequenceStoreError,
  FileFeedbackSequenceStore,
  type FeedbackSequenceSyncPurpose,
} from '../../src/services/FileFeedbackSequenceStore';

const temporaryDirectories: string[] = [];
const stores: FileFeedbackSequenceStore[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function tracked<T extends FileFeedbackSequenceStore>(store: T): T {
  stores.push(store);
  return store;
}

class FailingCommitFeedbackSequenceStore extends FileFeedbackSequenceStore {
  protected override async replaceFile(): Promise<void> {
    throw Object.assign(new Error('simulated atomic replacement failure'), { code: 'EIO' });
  }
}

class TracingFeedbackSequenceStore extends FileFeedbackSequenceStore {
  readonly trace: string[] = [];

  protected override async synchronizeFile(
    handle: FileHandle,
    purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    if (purpose === 'sequence') this.trace.push('file.sync');
    await super.synchronizeFile(handle, purpose);
  }

  protected override async replaceFile(
    temporaryPath: string,
    targetPath: string,
  ): Promise<void> {
    this.trace.push('file.rename');
    await super.replaceFile(temporaryPath, targetPath);
  }

  protected override async synchronizeDirectory(
    directory: string,
    purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    if (purpose === 'sequence') this.trace.push('directory.sync');
    await super.synchronizeDirectory(directory, purpose);
  }
}

class UnsupportedDirectorySyncStore extends FileFeedbackSequenceStore {
  protected override async synchronizeDirectory(): Promise<void> {
    throw Object.assign(new Error('directory sync is unsupported'), { code: 'ENOTSUP' });
  }
}

class FailingSequenceDirectorySyncStore extends FileFeedbackSequenceStore {
  protected override async synchronizeDirectory(
    directory: string,
    purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    if (purpose === 'sequence') {
      throw Object.assign(new Error('directory sync failed'), { code: 'EIO' });
    }
    await super.synchronizeDirectory(directory, purpose);
  }
}

class FailingSequenceFileSyncStore extends FileFeedbackSequenceStore {
  protected override async synchronizeFile(
    handle: FileHandle,
    purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    if (purpose === 'sequence') {
      throw Object.assign(new Error('file sync failed'), { code: 'EIO' });
    }
    await super.synchronizeFile(handle, purpose);
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
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

class GatedCommitFeedbackSequenceStore extends FileFeedbackSequenceStore {
  readonly commitStarted = deferred();
  readonly continueCommit = deferred();

  protected override async replaceFile(
    temporaryPath: string,
    targetPath: string,
  ): Promise<void> {
    this.commitStarted.resolve();
    await this.continueCommit.promise;
    await super.replaceFile(temporaryPath, targetPath);
  }
}

class GatedDirectorySyncFeedbackSequenceStore extends FileFeedbackSequenceStore {
  readonly sequenceSyncStarted = deferred();
  readonly continueSequenceSync = deferred();

  protected override async synchronizeDirectory(
    directory: string,
    purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    if (purpose === 'sequence') {
      this.sequenceSyncStarted.resolve();
      await this.continueSequenceSync.promise;
    }
    await super.synchronizeDirectory(directory, purpose);
  }
}

async function temporaryStore(): Promise<{
  directory: string;
  filePath: string;
  store: FileFeedbackSequenceStore;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-feedback-sequences-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'private', 'feedback-sequences.json');
  return { directory, filePath, store: tracked(new FileFeedbackSequenceStore(filePath)) };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('FileFeedbackSequenceStore', () => {
  it('reserves independent audience sequences and continues them after restart', async () => {
    const { filePath, store } = await temporaryStore();

    await expect(store.reserve('issuer-b', 'device-2.g1', 2)).resolves.toEqual([1, 2]);
    await expect(store.reserve('issuer-a', 'device-1.g1', 1)).resolves.toEqual([1]);
    await expect(store.reserve('issuer-b', 'device-2.g2', 1)).resolves.toEqual([1]);
    await store.close();

    const restarted = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(restarted.reserve('issuer-b', 'device-2.g1', 2)).resolves.toEqual([3, 4]);

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      records: Array<{ issuerKeyId: string; audienceCredentialId: string }>;
    };
    expect(document.records.map((record) => [
      record.issuerKeyId,
      record.audienceCredentialId,
    ])).toEqual([
      ['issuer-a', 'device-1.g1'],
      ['issuer-b', 'device-2.g1'],
      ['issuer-b', 'device-2.g2'],
    ]);
  });

  it('serializes concurrent reservations within one store instance', async () => {
    const { store } = await temporaryStore();
    const reservations = await Promise.all(
      Array.from({ length: 20 }, () => store.reserve('issuer-1', 'device-1.g1', 3)),
    );
    const sequences = reservations.flat().sort((left, right) => left - right);
    expect(sequences).toEqual(Array.from({ length: 60 }, (_value, index) => index + 1));
    expect(reservations.every((reservation) => (
      reservation[1] === reservation[0] + 1
      && reservation[2] === reservation[1] + 1
    ))).toBe(true);
  });

  it('does not advance memory or disk when atomic replacement fails', async () => {
    const { filePath, store } = await temporaryStore();
    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([1]);
    await store.close();

    const failing = tracked(new FailingCommitFeedbackSequenceStore(filePath));
    await expect(failing.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_STORE_IO',
    });
    await failing.close();

    const restarted = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(restarted.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([2]);
  });

  it('fails closed on malformed or duplicate persisted identities', async () => {
    const { filePath, store } = await temporaryStore();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const malformed = JSON.stringify({
      schemaVersion: 1,
      records: [
        { issuerKeyId: 'issuer-1', audienceCredentialId: 'device-1.g1', lastSequence: 1 },
        { issuerKeyId: 'issuer-1', audienceCredentialId: 'device-1.g1', lastSequence: 2 },
      ],
    });
    await fs.writeFile(filePath, malformed, 'utf8');

    await expect(store.init()).rejects.toMatchObject<FeedbackSequenceStoreError>({
      code: 'INVALID_FEEDBACK_SEQUENCE_STORE',
    });
    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'INVALID_FEEDBACK_SEQUENCE_STORE',
    });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(malformed);
  });

  it('rejects invalid requests and fails before safe-integer exhaustion', async () => {
    const { filePath, store } = await temporaryStore();
    await expect(store.reserve(' issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'INVALID_FEEDBACK_SEQUENCE_REQUEST',
    });
    await expect(store.reserve('issuer-1', 'device-1.g1', 0)).rejects.toMatchObject({
      code: 'INVALID_FEEDBACK_SEQUENCE_REQUEST',
    });
    await expect(store.reserve('issuer-1', 'device-1.g1', 1_001)).rejects.toMatchObject({
      code: 'INVALID_FEEDBACK_SEQUENCE_REQUEST',
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      records: [{
        issuerKeyId: 'issuer-1',
        audienceCredentialId: 'device-1.g1',
        lastSequence: Number.MAX_SAFE_INTEGER - 1,
      }],
    }), 'utf8');
    const nearLimit = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(nearLimit.reserve('issuer-1', 'device-1.g1', 1))
      .resolves.toEqual([Number.MAX_SAFE_INTEGER]);
    await expect(nearLimit.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_EXHAUSTED',
    });
  });

  it('writes private directory and file permissions', async () => {
    const { directory, filePath, store } = await temporaryStore();
    await store.reserve('issuer-1', 'device-1.g1', 1);

    const directoryMode = (await fs.stat(path.join(directory, 'private'))).mode & 0o777;
    const fileMode = (await fs.stat(filePath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('rejects a second live authority across canonical path aliases', async () => {
    const { filePath, store } = await temporaryStore();
    await store.init();

    const alias = path.join(path.dirname(filePath), '..', 'private', path.basename(filePath));
    const competing = tracked(new FileFeedbackSequenceStore(alias));
    await expect(competing.init()).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_AUTHORITY_UNAVAILABLE',
    });
    expect(store.getState()).toMatchObject({ phase: 'ready', authorityHeld: true });

    await store.close();
    const successor = tracked(new FileFeedbackSequenceStore(alias));
    await expect(successor.init()).resolves.toBeUndefined();
    expect(successor.getState()).toMatchObject({ phase: 'ready', authorityHeld: true });
  });

  it('rejects a second authority held by another server process', async () => {
    const { filePath } = await temporaryStore();
    const moduleUrl = pathToFileURL(path.resolve(
      process.cwd(),
      'src/services/FileFeedbackSequenceStore.ts',
    )).href;
    const childScript = `
      const loaded = await import(${JSON.stringify(moduleUrl)});
      const { FileFeedbackSequenceStore } = loaded.default ?? loaded;
      const store = new FileFeedbackSequenceStore(process.env.SEQUENCE_FILE);
      await store.init();
      process.stdout.write('AUTHORITY_READY\\n');
      process.stdin.once('data', async () => {
        await store.close();
        process.exit(0);
      });
      process.stdin.resume();
    `;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      childScript,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SEQUENCE_FILE: filePath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    await waitForChildOutput(child, 'AUTHORITY_READY');

    const competing = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(competing.init()).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_AUTHORITY_UNAVAILABLE',
    });

    const exited = waitForChildExit(child);
    child.stdin.write('\n');
    expect(await exited).toBe(0);
    children.splice(children.indexOf(child), 1);

    const successor = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(successor.init()).resolves.toBeUndefined();
  });

  it('returns a reservation only after file sync, replacement, and directory sync', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new TracingFeedbackSequenceStore(filePath));
    await store.init();
    store.trace.splice(0);

    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([1]);
    expect(store.trace).toEqual(['file.sync', 'file.rename', 'directory.sync']);
    expect(store.getState()).toEqual({
      phase: 'ready',
      durability: 'power_loss_resilient',
      authorityHeld: true,
    });
  });

  it('degrades observably when directory synchronization is unsupported', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new UnsupportedDirectorySyncStore(filePath));

    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([1]);
    expect(store.getState()).toEqual({
      phase: 'ready',
      durability: 'process_restart_resilient',
      authorityHeld: true,
    });
  });

  it('does not expose a reservation while directory synchronization is pending', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new GatedDirectorySyncFeedbackSequenceStore(filePath));
    let settled = false;
    const reservation = store.reserve('issuer-1', 'device-1.g1', 1).finally(() => {
      settled = true;
    });

    await store.sequenceSyncStarted.promise;
    expect(settled).toBe(false);
    store.continueSequenceSync.resolve();

    await expect(reservation).resolves.toEqual([1]);
    expect(settled).toBe(true);
  });

  it('fails closed after an unexpected directory sync failure and never returns its sequence', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new FailingSequenceDirectorySyncStore(filePath));

    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_STORE_IO',
    });
    expect(store.getState()).toMatchObject({ phase: 'failed', authorityHeld: true });
    await store.close();

    const restarted = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(restarted.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([2]);
  });

  it('does not replace state when sequence file synchronization fails', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new FailingSequenceFileSyncStore(filePath));

    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_STORE_IO',
    });
    await store.close();

    const restarted = tracked(new FileFeedbackSequenceStore(filePath));
    await expect(restarted.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([1]);
  });

  it('drains accepted reservations before close and rejects later work immediately', async () => {
    const { filePath } = await temporaryStore();
    const store = tracked(new GatedCommitFeedbackSequenceStore(filePath));
    const reservation = store.reserve('issuer-1', 'device-1.g1', 1);
    await store.commitStarted.promise;

    const closing = store.close();
    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_STORE_CLOSED',
    });
    store.continueCommit.resolve();

    await expect(reservation).resolves.toEqual([1]);
    await expect(closing).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ phase: 'closed', authorityHeld: false });
  });

  it('refuses to remove an authority marker whose ownership document changed', async () => {
    const { filePath, store } = await temporaryStore();
    await store.init();
    await fs.writeFile(`${filePath}.authority.lock`, '{"owner":"substituted"}\n', 'utf8');

    await expect(store.close()).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_AUTHORITY_UNAVAILABLE',
    });
    await expect(fs.readFile(`${filePath}.authority.lock`, 'utf8'))
      .resolves.toBe('{"owner":"substituted"}\n');
    expect(store.getState()).toMatchObject({ phase: 'failed', authorityHeld: false });
  });

  it('shares one issuer-audience lane across independent callers', async () => {
    const { store } = await temporaryStore();

    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([1]);
    await expect(store.reserve('issuer-1', 'device-1.g1', 2)).resolves.toEqual([2, 3]);
    await expect(store.reserve('issuer-1', 'device-1.g1', 1)).resolves.toEqual([4]);
  });
});
