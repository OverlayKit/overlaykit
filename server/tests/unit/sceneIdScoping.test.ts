import type { AddressInfo } from 'net';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { createApp } from '../../src/index';
import { toMeta } from '../../src/storage/Storage';
import { DEFAULT_TENANT_ID } from '../../src/tenancy';
import type {
  ActionRecord,
  CollectionMeta,
  CollectionRecord,
  ShowRecord,
  Storage,
} from '../../src/storage';

const ORIGIN = 'http://localhost:5173';
const OWNER = { email: 'owner@overlaykit.local', displayName: 'Owner', password: 'correct horse battery staple' };

class TwoShowStorage implements Storage {
  private readonly shows = new Map<string, ShowRecord>([
    ['show-a', { id: 'show-a', name: 'A', description: '', createdAt: 1, updatedAt: 1, archivedAt: null }],
    ['show-b', { id: 'show-b', name: 'B', description: '', createdAt: 1, updatedAt: 1, archivedAt: null }],
  ]);
  private readonly cols = new Map<string, CollectionRecord>();

  async init(): Promise<void> {}
  async listShows(): Promise<ShowRecord[]> {
    return [...this.shows.values()];
  }
  async getShow(id: string): Promise<ShowRecord | null> {
    return this.shows.get(id) ?? null;
  }
  async saveShow(show: ShowRecord): Promise<ShowRecord> {
    this.shows.set(show.id, show);
    return show;
  }
  async archiveShow(): Promise<ShowRecord | null> {
    return null;
  }
  async listCollections(): Promise<CollectionMeta[]> {
    return [...this.cols.values()].map(toMeta);
  }
  async getCollection(_tenantId: string, id: string): Promise<CollectionRecord | null> {
    return this.cols.get(id) ?? null;
  }
  async saveCollection(record: CollectionRecord): Promise<CollectionRecord> {
    const revision = (this.cols.get(record.id)?.revision ?? 0) + 1;
    const saved = { ...record, tenantId: DEFAULT_TENANT_ID, revision };
    this.cols.set(saved.id, saved);
    return saved;
  }
  async deleteCollection(_tenantId: string, id: string): Promise<boolean> {
    return this.cols.delete(id);
  }
  async listActions(): Promise<ActionRecord[]> {
    return [];
  }
  async getAction(): Promise<ActionRecord | null> {
    return null;
  }
  async saveAction(): Promise<void> {}
  async deleteAction(): Promise<boolean> {
    return false;
  }
}

describe('same-named Scenes in different Shows do not collide', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    const app = createApp({ auth, dataStorage: new TwoShowStorage() });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    agent = request.agent(`http://127.0.0.1:${port}`);
    await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);
  });

  it('gives a same-named Scene a distinct id per Show and keeps each bound to its Show', async () => {
    const a = await agent.post('/api/shows/show-a/scenes').set('Origin', ORIGIN).send({ name: 'Intro' }).expect(201);
    const b = await agent.post('/api/shows/show-b/scenes').set('Origin', ORIGIN).send({ name: 'Intro' }).expect(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);

    const listA = await agent.get('/api/collections?channelId=show-a').expect(200);
    const listB = await agent.get('/api/collections?channelId=show-b').expect(200);
    const idsA = (listA.body.data.collections as CollectionMeta[]).map((c) => c.id);
    const idsB = (listB.body.data.collections as CollectionMeta[]).map((c) => c.id);
    expect(idsA).toContain(a.body.data.id);
    expect(idsB).toContain(b.body.data.id);
    // Show A still has its own Intro (Show B's create did not rebind it).
    expect(idsA).not.toContain(b.body.data.id);
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
  });
});
