import type { AddressInfo } from 'net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const SHOW_ID = 'unify-show';
const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

// A distinct, storage-owning double: if the collections router reads the injected dataStorage
// (rather than the module singleton), its collections appear and creation lands here.
class MutableStorage implements Storage {
  private readonly shows = new Map<string, ShowRecord>([
    [SHOW_ID, { id: SHOW_ID, name: 'Unify Show', description: '', createdAt: 1, updatedAt: 1, archivedAt: null }],
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

describe('collections resolve through the injected storage; Scenes are Show-scoped', () => {
  let storage: MutableStorage;
  let agent: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    storage = new MutableStorage();
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    const app = createApp({ auth, dataStorage: storage });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    agent = request.agent(`http://127.0.0.1:${port}`);
    await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);
  });

  afterEach(() => {
    /* app servers are ephemeral (listen 0) and closed by process teardown */
  });

  it('serves collections from the injected storage, not the module singleton', async () => {
    await storage.saveCollection({
      id: 'seeded-scene',
      tenantId: DEFAULT_TENANT_ID,
      name: 'Seeded',
      channelId: SHOW_ID,
      scene: { id: 'seeded-scene', name: 'Seeded', elements: [] },
      variables: {},
      updatedAt: 1,
    });
    const res = await agent.get(`/api/collections?channelId=${SHOW_ID}`).expect(200);
    const ids = (res.body.data.collections as CollectionMeta[]).map((c) => c.id);
    expect(ids).toContain('seeded-scene');
  });

  it('creates a Show-scoped Scene that lands in the Show and starts at revision 1 (AC-006)', async () => {
    const created = await agent
      .post(`/api/shows/${SHOW_ID}/scenes`)
      .set('Origin', ORIGIN)
      .send({ name: 'Intro' })
      .expect(201);
    expect(created.body.data).toMatchObject({ channelId: SHOW_ID, revision: 1 });

    const list = await agent.get(`/api/collections?channelId=${SHOW_ID}`).expect(200);
    const names = (list.body.data.collections as CollectionMeta[]).map((c) => c.name);
    expect(names).toContain('Intro');
  });

  it('rejects creating a Scene in an unknown Show', async () => {
    await agent
      .post('/api/shows/no-such-show/scenes')
      .set('Origin', ORIGIN)
      .send({ name: 'Ghost' })
      .expect(404);
  });
});
