import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeedbackSequenceStoreError,
  FileFeedbackSequenceStore,
} from '../../src/services/FileFeedbackSequenceStore';

const temporaryDirectories: string[] = [];

class FailingCommitFeedbackSequenceStore extends FileFeedbackSequenceStore {
  protected override async replaceFile(): Promise<void> {
    throw Object.assign(new Error('simulated atomic replacement failure'), { code: 'EIO' });
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
  return { directory, filePath, store: new FileFeedbackSequenceStore(filePath) };
}

afterEach(async () => {
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

    const restarted = new FileFeedbackSequenceStore(filePath);
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

    const failing = new FailingCommitFeedbackSequenceStore(filePath);
    await expect(failing.reserve('issuer-1', 'device-1.g1', 1)).rejects.toMatchObject({
      code: 'FEEDBACK_SEQUENCE_STORE_IO',
    });

    const restarted = new FileFeedbackSequenceStore(filePath);
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
    const nearLimit = new FileFeedbackSequenceStore(filePath);
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
});
