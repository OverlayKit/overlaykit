import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import feedbackSequenceSchema from '../validation/schemas/feedback-sequences.schema.json';

export const FEEDBACK_SEQUENCE_FILE_SCHEMA_VERSION = 1 as const;

const MAX_RECORDS = 10_000;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_RESERVATION_SIZE = 1_000;

export interface FeedbackSequenceRecord {
  readonly issuerKeyId: string;
  readonly audienceCredentialId: string;
  readonly lastSequence: number;
}

interface FeedbackSequenceDocument {
  readonly schemaVersion: typeof FEEDBACK_SEQUENCE_FILE_SCHEMA_VERSION;
  readonly records: ReadonlyArray<FeedbackSequenceRecord>;
}

export interface FeedbackSequenceStore {
  init(): Promise<void>;
  reserve(
    issuerKeyId: string,
    audienceCredentialId: string,
    count: number,
  ): Promise<ReadonlyArray<number>>;
}

export type FeedbackSequenceDurability =
  | 'power_loss_resilient'
  | 'process_restart_resilient';

export type FeedbackSequenceStorePhase =
  | 'new'
  | 'initializing'
  | 'ready'
  | 'failed'
  | 'closing'
  | 'closed';

export interface FeedbackSequenceStoreState {
  readonly phase: FeedbackSequenceStorePhase;
  readonly durability: FeedbackSequenceDurability | null;
  readonly authorityHeld: boolean;
}

export interface ManagedFeedbackSequenceStore extends FeedbackSequenceStore {
  close(): Promise<void>;
  getState(): FeedbackSequenceStoreState;
}

export type FeedbackSequenceStoreErrorCode =
  | 'INVALID_FEEDBACK_SEQUENCE_REQUEST'
  | 'INVALID_FEEDBACK_SEQUENCE_STORE'
  | 'FEEDBACK_SEQUENCE_EXHAUSTED'
  | 'FEEDBACK_SEQUENCE_AUTHORITY_UNAVAILABLE'
  | 'FEEDBACK_SEQUENCE_STORE_CLOSED'
  | 'FEEDBACK_SEQUENCE_STORE_IO';

export class FeedbackSequenceStoreError extends Error {
  constructor(
    public readonly code: FeedbackSequenceStoreErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FeedbackSequenceStoreError';
  }
}

const validateDocument = new Ajv({ allErrors: true, strict: true }).compile(
  feedbackSequenceSchema,
) as ValidateFunction<FeedbackSequenceDocument>;

function defaultFeedbackSequenceFile(): string {
  const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return process.env.FEEDBACK_SEQUENCE_FILE
    || path.join(dataDirectory, 'feedback-sequences.json');
}

function recordKey(issuerKeyId: string, audienceCredentialId: string): string {
  return JSON.stringify([issuerKeyId, audienceCredentialId]);
}

function codeUnitCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneRecord(record: FeedbackSequenceRecord): FeedbackSequenceRecord {
  return { ...record };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim();
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function parseDocument(raw: string): FeedbackSequenceDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new FeedbackSequenceStoreError(
      'INVALID_FEEDBACK_SEQUENCE_STORE',
      'Feedback sequence store is not valid JSON',
      error,
    );
  }
  if (!validateDocument(parsed)) {
    throw new FeedbackSequenceStoreError(
      'INVALID_FEEDBACK_SEQUENCE_STORE',
      `Feedback sequence store does not match schema: ${formatAjvErrors(validateDocument.errors)}`,
    );
  }

  const identities = new Set<string>();
  for (const record of parsed.records) {
    if (!validIdentifier(record.issuerKeyId) || !validIdentifier(record.audienceCredentialId)) {
      throw new FeedbackSequenceStoreError(
        'INVALID_FEEDBACK_SEQUENCE_STORE',
        'Feedback sequence identifiers must be trimmed',
      );
    }
    const identity = recordKey(record.issuerKeyId, record.audienceCredentialId);
    if (identities.has(identity)) {
      throw new FeedbackSequenceStoreError(
        'INVALID_FEEDBACK_SEQUENCE_STORE',
        'Feedback sequence identities must be unique',
      );
    }
    identities.add(identity);
  }

  return {
    schemaVersion: FEEDBACK_SEQUENCE_FILE_SCHEMA_VERSION,
    records: parsed.records.map(cloneRecord),
  };
}

function documentFor(
  records: ReadonlyMap<string, FeedbackSequenceRecord>,
): FeedbackSequenceDocument {
  return {
    schemaVersion: FEEDBACK_SEQUENCE_FILE_SCHEMA_VERSION,
    records: [...records.values()]
      .map(cloneRecord)
      .sort((left, right) => (
        codeUnitCompare(left.issuerKeyId, right.issuerKeyId)
        || codeUnitCompare(left.audienceCredentialId, right.audienceCredentialId)
      )),
  };
}

function requiredIdentifier(value: unknown, field: string): string {
  if (!validIdentifier(value)) {
    throw new FeedbackSequenceStoreError(
      'INVALID_FEEDBACK_SEQUENCE_REQUEST',
      `${field} is invalid`,
    );
  }
  return value;
}

export type FeedbackSequenceSyncPurpose = 'authority' | 'directory' | 'sequence';

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EINVAL'
    || code === 'ENOTSUP'
    || code === 'EOPNOTSUPP'
    || code === 'ENOSYS'
    || (process.platform === 'win32' && (
      code === 'EACCES'
      || code === 'EPERM'
      || code === 'EISDIR'
    ));
}

function storeClosedError(): FeedbackSequenceStoreError {
  return new FeedbackSequenceStoreError(
    'FEEDBACK_SEQUENCE_STORE_CLOSED',
    'Feedback sequence store is closing or closed',
  );
}

export class FileFeedbackSequenceStore implements ManagedFeedbackSequenceStore {
  private records: Map<string, FeedbackSequenceRecord> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private phase: FeedbackSequenceStorePhase = 'new';
  private durability: FeedbackSequenceDurability | null = null;
  private authorityHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  private authorityPath: string | null = null;
  private authorityDocument: string | null = null;
  private effectiveFilePath: string | null = null;
  private failure: FeedbackSequenceStoreError | null = null;
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly filePath = defaultFeedbackSequenceFile()) {}

  async init(): Promise<void> {
    if (this.closeRequested) throw storeClosedError();
    await this.exclusive(async () => {
      await this.initializeOnce();
    });
  }

  async reserve(
    issuerKeyId: string,
    audienceCredentialId: string,
    count: number,
  ): Promise<ReadonlyArray<number>> {
    const issuer = requiredIdentifier(issuerKeyId, 'Issuer key identifier');
    const audience = requiredIdentifier(audienceCredentialId, 'Credential audience');
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RESERVATION_SIZE) {
      throw new FeedbackSequenceStoreError(
        'INVALID_FEEDBACK_SEQUENCE_REQUEST',
        'Feedback sequence reservation size is invalid',
      );
    }
    if (this.closeRequested) throw storeClosedError();

    return this.exclusive(async () => {
      const records = await this.initializeOnce();
      const identity = recordKey(issuer, audience);
      const current = records.get(identity);
      if (!current && records.size >= MAX_RECORDS) {
        throw new FeedbackSequenceStoreError(
          'FEEDBACK_SEQUENCE_EXHAUSTED',
          'Feedback sequence store reached its audience limit',
        );
      }
      const currentSequence = current?.lastSequence ?? 0;
      if (currentSequence > Number.MAX_SAFE_INTEGER - count) {
        throw new FeedbackSequenceStoreError(
          'FEEDBACK_SEQUENCE_EXHAUSTED',
          'Feedback sequence cannot advance without losing integer precision',
        );
      }
      const firstSequence = currentSequence + 1;
      const lastSequence = currentSequence + count;

      const next = new Map(records);
      next.set(identity, {
        issuerKeyId: issuer,
        audienceCredentialId: audience,
        lastSequence,
      });
      try {
        await this.persist(next);
      } catch (error) {
        const failure = error instanceof FeedbackSequenceStoreError
          ? error
          : new FeedbackSequenceStoreError(
            'FEEDBACK_SEQUENCE_STORE_IO',
            'Failed to persist feedback sequence store',
            error,
          );
        this.failure = failure;
        this.phase = 'failed';
        throw failure;
      }
      this.records = next;
      return Array.from({ length: count }, (_value, index) => firstSequence + index);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.exclusive(async () => {
      if (this.phase === 'closed') return;
      this.phase = 'closing';
      try {
        await this.releaseAuthority();
        this.records = null;
        this.phase = 'closed';
      } catch (error) {
        const failure = error instanceof FeedbackSequenceStoreError
          ? error
          : new FeedbackSequenceStoreError(
            'FEEDBACK_SEQUENCE_STORE_IO',
            'Failed to release feedback sequence authority',
            error,
          );
        this.failure = failure;
        this.phase = 'failed';
        throw failure;
      }
    });
    return this.closePromise;
  }

  getState(): FeedbackSequenceStoreState {
    return Object.freeze({
      phase: this.phase,
      durability: this.durability,
      authorityHeld: this.authorityHandle !== null,
    });
  }

  protected async synchronizeFile(
    handle: FileHandle,
    _purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    await handle.sync();
  }

  protected async replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
    await fs.rename(temporaryPath, targetPath);
  }

  protected async synchronizeDirectory(
    directory: string,
    _purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initializeOnce(): Promise<Map<string, FeedbackSequenceRecord>> {
    if (this.phase === 'ready' && this.records) return this.records;
    if (this.failure) throw this.failure;
    if (this.phase === 'closing' || this.phase === 'closed') throw storeClosedError();

    this.phase = 'initializing';
    this.durability = 'power_loss_resilient';
    try {
      const directory = await this.prepareDirectory();
      this.effectiveFilePath = path.join(directory, path.basename(this.filePath));
      await this.acquireAuthority(directory);
      const records = await this.loadOnce();
      this.phase = 'ready';
      return records;
    } catch (error) {
      const failure = error instanceof FeedbackSequenceStoreError
        ? error
        : new FeedbackSequenceStoreError(
          'FEEDBACK_SEQUENCE_STORE_IO',
          'Failed to initialize feedback sequence store',
          error,
        );
      await this.releaseAuthority(true);
      this.failure = failure;
      this.phase = 'failed';
      throw failure;
    }
  }

  private async prepareDirectory(): Promise<string> {
    const requestedDirectory = path.resolve(path.dirname(this.filePath));
    try {
      await fs.mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
      await fs.chmod(requestedDirectory, 0o700);
      const directory = await fs.realpath(requestedDirectory);
      let current = directory;
      let reachedRoot = false;
      while (!reachedRoot && this.durability === 'power_loss_resilient') {
        await this.confirmDirectorySync(current, 'directory');
        const parent = path.dirname(current);
        reachedRoot = parent === current;
        current = parent;
      }
      return directory;
    } catch (error) {
      if (error instanceof FeedbackSequenceStoreError) throw error;
      throw new FeedbackSequenceStoreError(
        'FEEDBACK_SEQUENCE_STORE_IO',
        'Failed to prepare feedback sequence directory',
        error,
      );
    }
  }

  private async acquireAuthority(directory: string): Promise<void> {
    const targetPath = this.requiredEffectiveFilePath();
    const authorityPath = `${targetPath}.authority.lock`;
    const authorityDocument = `${JSON.stringify({
      schemaVersion: 1,
      owner: randomUUID(),
      pid: process.pid,
    })}\n`;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(authorityPath, 'wx', 0o600);
      await handle.writeFile(authorityDocument, 'utf8');
      await this.synchronizeFile(handle, 'authority');
      this.authorityHandle = handle;
      this.authorityPath = authorityPath;
      this.authorityDocument = authorityDocument;
      await this.confirmDirectorySync(directory, 'authority');
    } catch (error) {
      if (handle && this.authorityHandle !== handle) {
        await handle.close().catch(() => undefined);
        await fs.unlink(authorityPath).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new FeedbackSequenceStoreError(
          'FEEDBACK_SEQUENCE_AUTHORITY_UNAVAILABLE',
          'Another feedback sequence authority already owns this store',
          error,
        );
      }
      if (error instanceof FeedbackSequenceStoreError) throw error;
      throw new FeedbackSequenceStoreError(
        'FEEDBACK_SEQUENCE_STORE_IO',
        'Failed to acquire feedback sequence authority',
        error,
      );
    }
  }

  private async releaseAuthority(suppressErrors = false): Promise<void> {
    const handle = this.authorityHandle;
    const authorityPath = this.authorityPath;
    const authorityDocument = this.authorityDocument;
    this.authorityHandle = null;
    this.authorityPath = null;
    this.authorityDocument = null;
    if (!handle || !authorityPath || !authorityDocument) return;

    try {
      const currentDocument = await fs.readFile(authorityPath, 'utf8');
      if (currentDocument !== authorityDocument) {
        throw new FeedbackSequenceStoreError(
          'FEEDBACK_SEQUENCE_AUTHORITY_UNAVAILABLE',
          'Feedback sequence authority marker changed unexpectedly',
        );
      }
      await fs.unlink(authorityPath);
      await this.confirmDirectorySync(path.dirname(authorityPath), 'authority');
    } catch (error) {
      if (!suppressErrors) throw error;
    } finally {
      await handle.close().catch((error: unknown) => {
        if (!suppressErrors) throw error;
      });
    }
  }

  private async confirmDirectorySync(
    directory: string,
    purpose: FeedbackSequenceSyncPurpose,
  ): Promise<void> {
    if (this.durability === 'process_restart_resilient') return;
    try {
      await this.synchronizeDirectory(directory, purpose);
    } catch (error) {
      if (isUnsupportedDirectorySync(error)) {
        this.durability = 'process_restart_resilient';
        return;
      }
      throw error;
    }
  }

  private requiredEffectiveFilePath(): string {
    if (!this.effectiveFilePath) {
      throw new FeedbackSequenceStoreError(
        'FEEDBACK_SEQUENCE_STORE_IO',
        'Feedback sequence store path is unavailable',
      );
    }
    return this.effectiveFilePath;
  }

  private async loadOnce(): Promise<Map<string, FeedbackSequenceRecord>> {
    if (this.records) return this.records;
    const filePath = this.requiredEffectiveFilePath();
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const document = parseDocument(raw);
      this.records = new Map(document.records.map((record) => [
        recordKey(record.issuerKeyId, record.audienceCredentialId),
        cloneRecord(record),
      ]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = new Map();
      } else if (error instanceof FeedbackSequenceStoreError) {
        throw error;
      } else {
        throw new FeedbackSequenceStoreError(
          'FEEDBACK_SEQUENCE_STORE_IO',
          'Failed to load feedback sequence store',
          error,
        );
      }
    }
    return this.records;
  }

  private async persist(records: ReadonlyMap<string, FeedbackSequenceRecord>): Promise<void> {
    const filePath = this.requiredEffectiveFilePath();
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(documentFor(records), null, 2)}\n`, 'utf8');
      await this.synchronizeFile(handle, 'sequence');
      await handle.close();
      handle = null;
      await this.replaceFile(temporaryPath, filePath);
      await this.confirmDirectorySync(directory, 'sequence');
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      if (error instanceof FeedbackSequenceStoreError) throw error;
      throw new FeedbackSequenceStoreError(
        'FEEDBACK_SEQUENCE_STORE_IO',
        'Failed to persist feedback sequence store',
        error,
      );
    }
  }
}
