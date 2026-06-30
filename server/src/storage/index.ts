import { Storage } from './Storage';
import { FileStorage } from './FileStorage';
import { logger } from '../utils/logger';

// Pick the storage adapter. Self-hosted: 'file'. Cloud: a 'postgres' adapter
// implementing the same Storage interface plugs in here with no route changes.
function createStorage(): Storage {
  const driver = process.env.STORAGE_DRIVER || 'file';
  switch (driver) {
    case 'file':
      return new FileStorage();
    // case 'postgres': return new PostgresStorage(process.env.DATABASE_URL!);
    default:
      logger.warn('Unknown STORAGE_DRIVER; falling back to file', { driver });
      return new FileStorage();
  }
}

export const storage: Storage = createStorage();
export * from './Storage';
