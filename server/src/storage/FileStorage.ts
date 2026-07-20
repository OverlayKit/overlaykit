import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { DEFAULT_TENANT_ID } from '../tenancy';
import { Storage, CollectionRecord, CollectionMeta, ActionRecord, ShowRecord, toMeta } from './Storage';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

export class FileStorage implements Storage {
  private collectionsCache: Map<string, CollectionRecord> | null = null;
  private actionsCache: Map<string, ActionRecord> | null = null;
  private showsCache: Map<string, ShowRecord> | null = null;
  private ready = false;

  async init(): Promise<void> {
    if (this.ready) return;
    this.ready = true;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await this.migrateTenantFiles();
  }

  private collectionsFile(): string {
    return path.join(DATA_DIR, 'collections.json');
  }

  private actionsFile(): string {
    return path.join(DATA_DIR, 'actions.json');
  }

  private showsFile(): string {
    return path.join(DATA_DIR, 'shows.json');
  }

  private async migrateTenantFiles(): Promise<void> {
    const legacyCollections = path.join(DATA_DIR, 'tenants', DEFAULT_TENANT_ID, 'collections.json');
    const legacyActions = path.join(DATA_DIR, 'tenants', DEFAULT_TENANT_ID, 'actions.json');
    try {
      if (fsSync.existsSync(legacyCollections) && !fsSync.existsSync(this.collectionsFile())) {
        await fs.copyFile(legacyCollections, this.collectionsFile());
      }
      if (fsSync.existsSync(legacyActions) && !fsSync.existsSync(this.actionsFile())) {
        await fs.copyFile(legacyActions, this.actionsFile());
      }
    } catch (e) {
      logger.warn('Legacy data migration failed', { error: String(e) });
    }
  }

  private collections(): Map<string, CollectionRecord> {
    if (this.collectionsCache) return this.collectionsCache;
    const m = new Map<string, CollectionRecord>();
    try {
      if (fsSync.existsSync(this.collectionsFile())) {
        const arr: CollectionRecord[] = JSON.parse(fsSync.readFileSync(this.collectionsFile(), 'utf8'));
        for (const c of arr) m.set(c.id, { ...c, tenantId: DEFAULT_TENANT_ID });
      }
    } catch (e) {
      logger.warn('Failed to load collections', { error: String(e) });
    }
    this.collectionsCache = m;
    return m;
  }

  private actions(): Map<string, ActionRecord> {
    if (this.actionsCache) return this.actionsCache;
    const m = new Map<string, ActionRecord>();
    try {
      if (fsSync.existsSync(this.actionsFile())) {
        const arr: ActionRecord[] = JSON.parse(fsSync.readFileSync(this.actionsFile(), 'utf8'));
        for (const a of arr) m.set(a.id, { ...a, tenantId: DEFAULT_TENANT_ID });
      }
    } catch (e) {
      logger.warn('Failed to load actions', { error: String(e) });
    }
    this.actionsCache = m;
    return m;
  }

  private shows(): Map<string, ShowRecord> {
    if (this.showsCache) return this.showsCache;
    const shows = new Map<string, ShowRecord>();
    try {
      if (fsSync.existsSync(this.showsFile())) {
        const records: ShowRecord[] = JSON.parse(fsSync.readFileSync(this.showsFile(), 'utf8'));
        for (const record of records) shows.set(record.id, record);
      }
    } catch (error) {
      logger.warn('Failed to load shows', { error: String(error) });
    }
    this.showsCache = shows;
    return shows;
  }

  private async persistCollections(): Promise<void> {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(this.collectionsFile(), JSON.stringify([...this.collections().values()], null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to persist collections', { error: String(e) });
    }
  }

  private async persistActions(): Promise<void> {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(this.actionsFile(), JSON.stringify([...this.actions().values()], null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to persist actions', { error: String(e) });
    }
  }

  private async persistShows(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(this.showsFile(), JSON.stringify([...this.shows().values()], null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async listShows(includeArchived = false): Promise<ShowRecord[]> {
    return [...this.shows().values()]
      .filter((show) => includeArchived || show.archivedAt === null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getShow(id: string): Promise<ShowRecord | null> {
    return this.shows().get(id) ?? null;
  }

  async saveShow(record: ShowRecord): Promise<ShowRecord> {
    const saved = { ...record };
    this.shows().set(saved.id, saved);
    await this.persistShows();
    return saved;
  }

  async archiveShow(id: string, archivedAt: number): Promise<ShowRecord | null> {
    const show = this.shows().get(id);
    if (!show) return null;
    const archived = { ...show, archivedAt, updatedAt: archivedAt };
    this.shows().set(id, archived);
    await this.persistShows();
    return archived;
  }

  async listCollections(_tenantId: string): Promise<CollectionMeta[]> {
    return [...this.collections().values()].sort((a, b) => b.updatedAt - a.updatedAt).map(toMeta);
  }

  async getCollection(_tenantId: string, id: string): Promise<CollectionRecord | null> {
    return this.collections().get(id) ?? null;
  }

  async saveCollection(record: CollectionRecord): Promise<CollectionRecord> {
    const saved = { ...record, tenantId: DEFAULT_TENANT_ID };
    this.collections().set(saved.id, saved);
    await this.persistCollections();
    return saved;
  }

  async deleteCollection(_tenantId: string, id: string): Promise<boolean> {
    const had = this.collections().delete(id);
    if (had) await this.persistCollections();
    return had;
  }

  async listActions(_tenantId: string): Promise<ActionRecord[]> {
    return [...this.actions().values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getAction(_tenantId: string, id: string): Promise<ActionRecord | null> {
    return this.actions().get(id) ?? null;
  }

  async saveAction(record: ActionRecord): Promise<void> {
    this.actions().set(record.id, { ...record, tenantId: DEFAULT_TENANT_ID });
    await this.persistActions();
  }

  async deleteAction(_tenantId: string, id: string): Promise<boolean> {
    const had = this.actions().delete(id);
    if (had) await this.persistActions();
    return had;
  }
}
