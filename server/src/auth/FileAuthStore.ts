import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { emptyAuthState, type AuthStore } from './AuthStore';
import {
  LEGACY_LOCAL_AUTH_SCHEMA_VERSION,
  LOCAL_AUTH_SCHEMA_VERSION,
  type LocalAuthState,
  type StoredLocalUser,
} from './types';

interface LegacyLocalAuthState {
  schemaVersion: typeof LEGACY_LOCAL_AUTH_SCHEMA_VERSION;
  owner: StoredLocalUser | null;
  outputTokenDigest: string | null;
  outputTokenUpdatedAt: string | null;
}

function defaultAuthFile(): string {
  const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return process.env.AUTH_FILE || path.join(dataDirectory, 'auth.json');
}

function isAuthState(value: unknown): value is LocalAuthState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LocalAuthState>;
  const output = candidate.outputCredential;
  return (
    candidate.schemaVersion === LOCAL_AUTH_SCHEMA_VERSION &&
    (candidate.owner === null || typeof candidate.owner === 'object') &&
    (output === null ||
      (typeof output === 'object' &&
        typeof output.digest === 'string' &&
        typeof output.showId === 'string' &&
        output.showId.length > 0 &&
        typeof output.updatedAt === 'string'))
  );
}

function isLegacyAuthState(value: unknown): value is LegacyLocalAuthState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LegacyLocalAuthState>;
  return (
    candidate.schemaVersion === LEGACY_LOCAL_AUTH_SCHEMA_VERSION &&
    (candidate.owner === null || typeof candidate.owner === 'object') &&
    (candidate.outputTokenDigest === null || typeof candidate.outputTokenDigest === 'string') &&
    (candidate.outputTokenUpdatedAt === null || typeof candidate.outputTokenUpdatedAt === 'string')
  );
}

export class FileAuthStore implements AuthStore {
  constructor(private readonly filePath = defaultAuthFile()) {}

  async load(): Promise<LocalAuthState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (isLegacyAuthState(parsed)) {
        const migrated: LocalAuthState = {
          schemaVersion: LOCAL_AUTH_SCHEMA_VERSION,
          owner: parsed.owner,
          outputCredential: null,
        };
        await this.save(migrated);
        return migrated;
      }
      if (!isAuthState(parsed)) {
        throw new Error('Unsupported or malformed auth state');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyAuthState();
      }
      logger.error('Failed to load local authentication state', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async save(state: LocalAuthState): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}
