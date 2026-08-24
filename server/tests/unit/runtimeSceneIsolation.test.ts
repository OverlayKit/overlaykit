import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { createApp } from '../../src/index';
import { channelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import { DEFAULT_TENANT_ID } from '../../src/tenancy';
import type {
  ActionRecord,
  CollectionMeta,
  CollectionRecord,
  ShowRecord,
  Storage,
} from '../../src/storage';
import { toMeta } from '../../src/storage/Storage';

/**
 * CHG-0060 / AC-013: runtime operations (load Preview, adjust controls, Take) never alter the saved
 * Scene without an explicit save-back. Proven at the persistence tier: the saved CollectionRecord is
 * re-read after the runtime operations and must be byte-identical to its saved form. getCollection
 * returns the stored record by reference, so any aliasing mutation would surface here.
 */

const ORIGIN = 'http://localhost:5173';
const SHOW_ID = 'iso-show';
const SCENE_ID = 'iso-scene';
const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

class IsolationStorage implements Storage {
  private readonly shows = new Map<string, ShowRecord>([
    [
      SHOW_ID,
      { id: SHOW_ID, name: 'Iso', description: '', createdAt: 1, updatedAt: 1, archivedAt: null },
    ],
  ]);
  readonly cols = new Map<string, CollectionRecord>([
    [
      SCENE_ID,
      {
        id: SCENE_ID,
        tenantId: DEFAULT_TENANT_ID,
        name: 'Isolation Scene',
        channelId: SHOW_ID,
        scene: {
          id: SCENE_ID,
          name: 'Isolation Scene',
          elements: [
            {
              id: 'title',
              tag: 'div',
              content: '{{title}}',
              styles: { color: '#fff' },
              controls: [{ id: 'ctl.title', label: 'Title', type: 'text', path: 'title' }],
            },
          ],
        },
        variables: { title: 'Original' },
        updatedAt: 1,
        revision: 1,
      },
    ],
  ]);

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
    this.cols.set(record.id, record);
    return record;
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

describe('runtime operations do not alter the saved Scene (AC-013)', () => {
  it('leaves the saved Scene byte-identical after Preview load, controls and Take', async () => {
    const storage = new IsolationStorage();
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    const production = new ProductionService(channelManager, { allowEphemeral: true });
    const app = createApp({ auth, dataStorage: storage, production });
    const agent = request.agent(app);
    await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);

    const before = JSON.parse(JSON.stringify(storage.cols.get(SCENE_ID)));

    const loaded = await agent
      .post(`/api/shows/${SHOW_ID}/production/preview/scenes/${SCENE_ID}`)
      .set('Origin', ORIGIN)
      .expect(200);
    const controlled = await agent
      .post(`/api/shows/${SHOW_ID}/production/preview/controls`)
      .set('Origin', ORIGIN)
      .send({
        expectedPreviewRevision: loaded.body.data.preview.revision,
        operationId: 'iso-controls',
        values: { 'ctl.title': 'CHANGED IN RUNTIME' },
      })
      .expect(200);
    await agent
      .post(`/api/shows/${SHOW_ID}/production/take`)
      .set('Origin', ORIGIN)
      .send({
        expectedPreviewRevision: controlled.body.data.preview.revision,
        operationId: 'iso-take',
      })
      .expect(200);

    // The runtime advanced Preview and Program, but the saved Scene is untouched.
    expect(controlled.body.data.preview.revision).toBeGreaterThan(before.revision);
    const after = await agent.get(`/api/collections/${SCENE_ID}`).expect(200);
    expect(after.body.data).toEqual(before);
    expect(JSON.parse(JSON.stringify(storage.cols.get(SCENE_ID)))).toEqual(before);
  });
});
