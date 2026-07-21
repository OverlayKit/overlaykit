import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import catalogGenerationSchema from '../validation/schemas/catalog-generation.schema.json';

export const CATALOG_GENERATION_FILE_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 200;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CatalogGenerationToken {
  readonly audienceCredentialId: string;
  readonly generation: number;
  readonly catalogHash: string;
}

interface CatalogGenerationDocument extends CatalogGenerationToken {
  readonly schemaVersion: typeof CATALOG_GENERATION_FILE_SCHEMA_VERSION;
}

export type CatalogGenerationDurability = 'power_loss_resilient' | 'process_restart_resilient';

export type CatalogGenerationStorePhase =
  'new' | 'initializing' | 'ready' | 'blocked' | 'failed' | 'closing' | 'closed';

export interface CatalogGenerationStoreState {
  readonly phase: CatalogGenerationStorePhase;
  readonly durability: CatalogGenerationDurability | null;
  readonly authorityHeld: boolean;
  readonly currentGeneration: number | null;
  readonly durableGeneration: number | null;
  readonly lastErrorCode: CatalogGenerationStoreErrorCode | null;
}

export interface CatalogGenerationAuthority {
  init(): Promise<void>;
  observe(catalogHash: string): CatalogGenerationToken;
  confirm(token: CatalogGenerationToken): Promise<void>;
  isCurrent(token: CatalogGenerationToken): boolean;
  close(): Promise<void>;
  getState(): CatalogGenerationStoreState;
}

export type CatalogGenerationStoreErrorCode =
  | 'INVALID_CATALOG_GENERATION_REQUEST'
  | 'INVALID_CATALOG_GENERATION_STORE'
  | 'CATALOG_GENERATION_EXHAUSTED'
  | 'CATALOG_GENERATION_AUTHORITY_UNAVAILABLE'
  | 'CATALOG_GENERATION_STORE_CLOSED'
  | 'CATALOG_GENERATION_STORE_BLOCKED'
  | 'STALE_CATALOG_GENERATION'
  | 'CATALOG_GENERATION_STORE_IO';

export class CatalogGenerationStoreError extends Error {
  constructor(
    public readonly code: CatalogGenerationStoreErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CatalogGenerationStoreError';
  }
}

const validateDocument = new Ajv({ allErrors: true, strict: true }).compile(
  catalogGenerationSchema
) as ValidateFunction<CatalogGenerationDocument>;

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim()
  );
}

function requiredAudience(value: unknown): string {
  if (!validIdentifier(value)) {
    throw new CatalogGenerationStoreError(
      'INVALID_CATALOG_GENERATION_REQUEST',
      'Credential audience identifier is invalid'
    );
  }
  return value;
}

function requiredHash(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new CatalogGenerationStoreError(
      'INVALID_CATALOG_GENERATION_REQUEST',
      'Catalog hash must be canonical lowercase SHA-256'
    );
  }
  return value;
}

function sameToken(left: CatalogGenerationToken | null, right: CatalogGenerationToken): boolean {
  return (
    left?.audienceCredentialId === right.audienceCredentialId &&
    left.generation === right.generation &&
    left.catalogHash === right.catalogHash
  );
}

function frozenToken(document: CatalogGenerationToken): CatalogGenerationToken {
  return Object.freeze({
    audienceCredentialId: document.audienceCredentialId,
    generation: document.generation,
    catalogHash: document.catalogHash,
  });
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function parseDocument(raw: string, audienceCredentialId: string): CatalogGenerationToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CatalogGenerationStoreError(
      'INVALID_CATALOG_GENERATION_STORE',
      'Catalog generation store is not valid JSON',
      error
    );
  }
  if (!validateDocument(parsed)) {
    throw new CatalogGenerationStoreError(
      'INVALID_CATALOG_GENERATION_STORE',
      `Catalog generation store does not match schema: ${formatAjvErrors(validateDocument.errors)}`
    );
  }
  if (
    parsed.audienceCredentialId !== audienceCredentialId ||
    !validIdentifier(parsed.audienceCredentialId)
  ) {
    throw new CatalogGenerationStoreError(
      'INVALID_CATALOG_GENERATION_STORE',
      'Catalog generation store belongs to another credential audience'
    );
  }
  return frozenToken(parsed);
}

function documentFor(token: CatalogGenerationToken): CatalogGenerationDocument {
  return {
    schemaVersion: CATALOG_GENERATION_FILE_SCHEMA_VERSION,
    audienceCredentialId: token.audienceCredentialId,
    generation: token.generation,
    catalogHash: token.catalogHash,
  };
}

function defaultCatalogGenerationFile(audienceCredentialId: string): string {
  const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const identity = createHash('sha256').update(audienceCredentialId).digest('hex');
  return path.join(dataDirectory, 'device-catalog-generations', `${identity}.json`);
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS' ||
    (process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR'))
  );
}

function closedError(): CatalogGenerationStoreError {
  return new CatalogGenerationStoreError(
    'CATALOG_GENERATION_STORE_CLOSED',
    'Catalog generation store is closing or closed'
  );
}

export type CatalogGenerationSyncPurpose = 'authority' | 'directory' | 'generation';

export class FileCatalogGenerationStore implements CatalogGenerationAuthority {
  private queue: Promise<void> = Promise.resolve();
  private phase: CatalogGenerationStorePhase = 'new';
  private durability: CatalogGenerationDurability | null = null;
  private current: CatalogGenerationToken | null = null;
  private durable: CatalogGenerationToken | null = null;
  private authorityHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  private authorityPath: string | null = null;
  private authorityDocument: string | null = null;
  private effectiveFilePath: string | null = null;
  private initializationFailure: CatalogGenerationStoreError | null = null;
  private lastError: CatalogGenerationStoreError | null = null;
  private pending = new Map<number, Promise<void>>();
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;
  private readonly audienceCredentialId: string;
  private readonly filePath: string;

  constructor(audienceCredentialId: string, filePath?: string) {
    this.audienceCredentialId = requiredAudience(audienceCredentialId);
    this.filePath = filePath ?? defaultCatalogGenerationFile(this.audienceCredentialId);
  }

  async init(): Promise<void> {
    if (this.closeRequested) throw closedError();
    await this.exclusive(async () => this.initializeOnce());
  }

  observe(catalogHash: string): CatalogGenerationToken {
    const hash = requiredHash(catalogHash);
    this.assertUsable();
    if (this.current?.catalogHash === hash) {
      if (!sameToken(this.durable, this.current) && !this.pending.has(this.current.generation)) {
        this.schedulePersistence(this.current);
      }
      return this.current;
    }

    const generation = (this.current ?? this.durable)?.generation ?? 0;
    if (generation >= Number.MAX_SAFE_INTEGER) {
      throw new CatalogGenerationStoreError(
        'CATALOG_GENERATION_EXHAUSTED',
        'Catalog generation cannot advance without losing integer precision'
      );
    }
    const token = frozenToken({
      audienceCredentialId: this.audienceCredentialId,
      generation: generation + 1,
      catalogHash: hash,
    });
    this.current = token;
    this.phase = 'blocked';
    this.schedulePersistence(token);
    return token;
  }

  async confirm(token: CatalogGenerationToken): Promise<void> {
    this.assertToken(token);
    this.assertUsable();
    if (!sameToken(this.current, token)) {
      throw new CatalogGenerationStoreError(
        'STALE_CATALOG_GENERATION',
        'Catalog generation was replaced before it became durable'
      );
    }
    if (!sameToken(this.durable, token)) {
      const persistence = this.pending.get(token.generation) ?? this.schedulePersistence(token);
      await persistence;
    }
    if (!sameToken(this.current, token) || !sameToken(this.durable, token)) {
      throw new CatalogGenerationStoreError(
        'STALE_CATALOG_GENERATION',
        'Catalog generation is no longer current'
      );
    }
  }

  isCurrent(token: CatalogGenerationToken): boolean {
    try {
      this.assertToken(token);
    } catch {
      return false;
    }
    return (
      this.phase === 'ready' && sameToken(this.current, token) && sameToken(this.durable, token)
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.exclusive(async () => {
      if (this.phase === 'closed') return;
      this.phase = 'closing';
      try {
        await this.releaseAuthority();
        this.phase = 'closed';
      } catch (error) {
        const failure = this.asIoError('Failed to release catalog generation authority', error);
        this.lastError = failure;
        this.phase = 'failed';
        throw failure;
      }
    });
    return this.closePromise;
  }

  getState(): CatalogGenerationStoreState {
    return Object.freeze({
      phase: this.phase,
      durability: this.durability,
      authorityHeld: this.authorityHandle !== null,
      currentGeneration: this.current?.generation ?? null,
      durableGeneration: this.durable?.generation ?? null,
      lastErrorCode: this.lastError?.code ?? null,
    });
  }

  protected async synchronizeFile(
    handle: FileHandle,
    _purpose: CatalogGenerationSyncPurpose
  ): Promise<void> {
    await handle.sync();
  }

  protected async replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
    await fs.rename(temporaryPath, targetPath);
  }

  protected async synchronizeDirectory(
    directory: string,
    _purpose: CatalogGenerationSyncPurpose
  ): Promise<void> {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private assertUsable(): void {
    if (this.closeRequested || this.phase === 'closing' || this.phase === 'closed') {
      throw closedError();
    }
    if (this.initializationFailure) throw this.initializationFailure;
    if (this.phase !== 'ready' && this.phase !== 'blocked') {
      throw new CatalogGenerationStoreError(
        'CATALOG_GENERATION_STORE_BLOCKED',
        'Catalog generation authority must initialize before observation'
      );
    }
  }

  private assertToken(token: CatalogGenerationToken): void {
    if (
      !token ||
      token.audienceCredentialId !== this.audienceCredentialId ||
      !Number.isSafeInteger(token.generation) ||
      token.generation < 1 ||
      !SHA256_PATTERN.test(token.catalogHash)
    ) {
      throw new CatalogGenerationStoreError(
        'INVALID_CATALOG_GENERATION_REQUEST',
        'Catalog generation token is invalid'
      );
    }
  }

  private schedulePersistence(token: CatalogGenerationToken): Promise<void> {
    const existing = this.pending.get(token.generation);
    if (existing) return existing;
    this.phase = 'blocked';
    const persistence = this.exclusive(() => this.persistToken(token));
    this.pending.set(token.generation, persistence);
    void persistence.then(
      () => this.pending.delete(token.generation),
      () => this.pending.delete(token.generation)
    );
    return persistence;
  }

  private async persistToken(token: CatalogGenerationToken): Promise<void> {
    try {
      await this.persist(token);
      this.durable = token;
      this.lastError = null;
      if (sameToken(this.current, token)) this.phase = 'ready';
    } catch (error) {
      const failure = this.asIoError('Failed to persist catalog generation', error);
      this.lastError = failure;
      if (sameToken(this.current, token)) this.phase = 'blocked';
      throw failure;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async initializeOnce(): Promise<void> {
    if (this.phase === 'ready' || this.phase === 'blocked') return;
    if (this.initializationFailure) throw this.initializationFailure;
    if (this.phase === 'closing' || this.phase === 'closed') throw closedError();

    this.phase = 'initializing';
    this.durability = 'power_loss_resilient';
    try {
      const directory = await this.prepareDirectory();
      this.effectiveFilePath = path.join(directory, path.basename(this.filePath));
      await this.acquireAuthority(directory);
      const loaded = await this.loadOnce();
      this.current = loaded;
      this.durable = loaded;
      this.phase = 'ready';
    } catch (error) {
      const failure =
        error instanceof CatalogGenerationStoreError
          ? error
          : this.asIoError('Failed to initialize catalog generation store', error);
      await this.releaseAuthority(true);
      this.initializationFailure = failure;
      this.lastError = failure;
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
      if (error instanceof CatalogGenerationStoreError) throw error;
      throw this.asIoError('Failed to prepare catalog generation directory', error);
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
        throw new CatalogGenerationStoreError(
          'CATALOG_GENERATION_AUTHORITY_UNAVAILABLE',
          'Another catalog generation authority already owns this audience file',
          error
        );
      }
      if (error instanceof CatalogGenerationStoreError) throw error;
      throw this.asIoError('Failed to acquire catalog generation authority', error);
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
        throw new CatalogGenerationStoreError(
          'CATALOG_GENERATION_AUTHORITY_UNAVAILABLE',
          'Catalog generation authority marker changed unexpectedly'
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
    purpose: CatalogGenerationSyncPurpose
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
      throw new CatalogGenerationStoreError(
        'CATALOG_GENERATION_STORE_IO',
        'Catalog generation store path is unavailable'
      );
    }
    return this.effectiveFilePath;
  }

  private async loadOnce(): Promise<CatalogGenerationToken | null> {
    try {
      const raw = await fs.readFile(this.requiredEffectiveFilePath(), 'utf8');
      return parseDocument(raw, this.audienceCredentialId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof CatalogGenerationStoreError) throw error;
      throw this.asIoError('Failed to load catalog generation store', error);
    }
  }

  private async persist(token: CatalogGenerationToken): Promise<void> {
    const filePath = this.requiredEffectiveFilePath();
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(documentFor(token), null, 2)}\n`, 'utf8');
      await this.synchronizeFile(handle, 'generation');
      await handle.close();
      handle = null;
      await this.replaceFile(temporaryPath, filePath);
      await this.confirmDirectorySync(directory, 'generation');
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      if (error instanceof CatalogGenerationStoreError) throw error;
      throw this.asIoError('Failed to persist catalog generation store', error);
    }
  }

  private asIoError(message: string, error: unknown): CatalogGenerationStoreError {
    return error instanceof CatalogGenerationStoreError
      ? error
      : new CatalogGenerationStoreError('CATALOG_GENERATION_STORE_IO', message, error);
  }
}
