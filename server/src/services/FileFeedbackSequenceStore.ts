import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
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

export type FeedbackSequenceStoreErrorCode =
  | 'INVALID_FEEDBACK_SEQUENCE_REQUEST'
  | 'INVALID_FEEDBACK_SEQUENCE_STORE'
  | 'FEEDBACK_SEQUENCE_EXHAUSTED'
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

export class FileFeedbackSequenceStore implements FeedbackSequenceStore {
  private records: Map<string, FeedbackSequenceRecord> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultFeedbackSequenceFile()) {}

  async init(): Promise<void> {
    await this.exclusive(async () => {
      await this.loadOnce();
    });
  }

  async reserve(
    issuerKeyId: string,
    audienceCredentialId: string,
    count: number,
  ): Promise<ReadonlyArray<number>> {
    return this.exclusive(async () => {
      const issuer = requiredIdentifier(issuerKeyId, 'Issuer key identifier');
      const audience = requiredIdentifier(audienceCredentialId, 'Credential audience');
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RESERVATION_SIZE) {
        throw new FeedbackSequenceStoreError(
          'INVALID_FEEDBACK_SEQUENCE_REQUEST',
          'Feedback sequence reservation size is invalid',
        );
      }

      const records = await this.loadOnce();
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
      await this.persist(next);
      this.records = next;
      return Array.from({ length: count }, (_value, index) => firstSequence + index);
    });
  }

  protected async replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
    await fs.rename(temporaryPath, targetPath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadOnce(): Promise<Map<string, FeedbackSequenceRecord>> {
    if (this.records) return this.records;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
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
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(documentFor(records), null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.replaceFile(temporaryPath, this.filePath);
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
