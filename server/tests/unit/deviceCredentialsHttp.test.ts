import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { createDeviceCredentialCryptoOptions } from '../../src/auth/DeviceCredentialCrypto';
import { createDeviceCredentialRuntime } from '../../src/auth/DeviceCredentialRuntime';
import { FileDeviceCredentialStore } from '../../src/auth/FileDeviceCredentialStore';
import { requireRole } from '../../src/auth/http';
import { createApp } from '../../src/index';
import { createDeviceCredentialsRouter } from '../../src/routes/deviceCredentials';
import type {
  ActionRecord,
  CollectionMeta,
  CollectionRecord,
  ShowRecord,
  Storage,
} from '../../src/storage';

const ORIGIN = 'http://localhost:5173';
const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Local Owner',
  password: 'correct horse battery staple',
};

class TestStorage implements Storage {
  readonly shows = new Map<string, ShowRecord>();
  async init(): Promise<void> {}
  async listShows(): Promise<ShowRecord[]> { return [...this.shows.values()]; }
  async getShow(id: string): Promise<ShowRecord | null> { return this.shows.get(id) ?? null; }
  async saveShow(show: ShowRecord): Promise<ShowRecord> { this.shows.set(show.id, show); return show; }
  async archiveShow(id: string, archivedAt: number): Promise<ShowRecord | null> {
    const show = this.shows.get(id);
    if (!show) return null;
    const archived = { ...show, archivedAt, updatedAt: archivedAt };
    this.shows.set(id, archived);
    return archived;
  }
  async listCollections(_tenantId: string): Promise<CollectionMeta[]> { return []; }
  async getCollection(_tenantId: string, _id: string): Promise<CollectionRecord | null> { return null; }
  async saveCollection(record: CollectionRecord): Promise<CollectionRecord> { return record; }
  async deleteCollection(_tenantId: string, _id: string): Promise<boolean> { return false; }
  async listActions(_tenantId: string): Promise<ActionRecord[]> { return []; }
  async getAction(_tenantId: string, _id: string): Promise<ActionRecord | null> { return null; }
  async saveAction(_record: ActionRecord): Promise<void> {}
  async deleteAction(_tenantId: string, _id: string): Promise<boolean> { return false; }
}

function show(id: string, archivedAt: number | null = null): ShowRecord {
  return {
    id,
    name: id,
    description: '',
    createdAt: 1_000,
    updatedAt: archivedAt ?? 1_000,
    archivedAt,
  };
}

describe('Owner device credential HTTP lifecycle', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-device-http-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('discloses each bearer once and preserves Show, generation, and revocation boundaries', async () => {
    let entropyByte = 0;
    const filePath = path.join(directory, 'device-credentials.json');
    const runtime = await createDeviceCredentialRuntime({
      store: new FileDeviceCredentialStore(filePath),
      lifecycleOptions: createDeviceCredentialCryptoOptions({
        now: () => 1_000,
        primitives: {
          randomUUID: () => 'device-1',
          randomBytes: (size) => new Uint8Array(size).fill(++entropyByte),
        },
      }),
    });
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    const storage = new TestStorage();
    storage.shows.set('show-1', show('show-1'));
    storage.shows.set('other-show', show('other-show'));
    storage.shows.set('archived-show', show('archived-show', 2_000));
    const app = createApp({ auth, dataStorage: storage, deviceCredentials: runtime });
    const agent = request.agent(app);

    await request(app)
      .post('/api/shows/show-1/integrations/device-credentials')
      .set('Origin', ORIGIN)
      .send({})
      .expect(401);
    await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);
    await agent
      .post('/api/shows/show-1/integrations/device-credentials')
      .send({})
      .expect(403);
    await agent
      .post('/api/shows/missing/integrations/device-credentials')
      .set('Origin', ORIGIN)
      .send({})
      .expect(404);
    await agent
      .post('/api/shows/archived-show/integrations/device-credentials')
      .set('Origin', ORIGIN)
      .send({})
      .expect(409);

    const issued = await agent
      .post('/api/shows/show-1/integrations/device-credentials')
      .set('Origin', ORIGIN)
      .send({
        label: 'Production desk',
        showId: 'other-show',
        targets: ['program'],
        controlIds: ['lower-third.visibility'],
        scopes: ['component.visibility:write'],
        expiresAt: 10_000,
      })
      .expect(201);
    expect(issued.headers['cache-control']).toContain('no-store');
    expect(issued.headers.pragma).toBe('no-cache');
    expect(issued.body.data.credential).toMatchObject({
      credentialId: 'device-1',
      showId: 'show-1',
      generation: 1,
    });
    expect(issued.body.data.credential).not.toHaveProperty('sealedSecret');
    const firstToken = issued.body.data.token as string;
    expect(firstToken).toMatch(/^ok_device_device-1\./);
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).not.toContain(firstToken);
    expect(persisted).toContain('okdv1$sha256$');

    await agent
      .post('/api/shows/other-show/integrations/device-credentials/device-1/rotate')
      .set('Origin', ORIGIN)
      .expect(404);
    await expect(runtime.lifecycle.authenticate(firstToken)).resolves.toMatchObject({ generation: 1 });

    const rotated = await agent
      .post('/api/shows/show-1/integrations/device-credentials/device-1/rotate')
      .set('Origin', ORIGIN)
      .expect(201);
    const secondToken = rotated.body.data.token as string;
    expect(secondToken).not.toBe(firstToken);
    expect(rotated.body.data.credential).toMatchObject({ generation: 2, showId: 'show-1' });
    expect(rotated.body.data.credential).not.toHaveProperty('sealedSecret');
    await expect(runtime.lifecycle.authenticate(firstToken)).resolves.toBeNull();
    await expect(runtime.lifecycle.authenticate(secondToken)).resolves.toMatchObject({ generation: 2 });

    const revoked = await agent
      .delete('/api/shows/show-1/integrations/device-credentials/device-1')
      .set('Origin', ORIGIN)
      .expect(200);
    expect(revoked.body.data.credential).toMatchObject({
      credentialId: 'device-1',
      generation: 3,
      revokedAt: 1_000,
    });
    expect(JSON.stringify(revoked.body)).not.toContain('ok_device_');
    expect(JSON.stringify(revoked.body)).not.toContain('sealedSecret');
    await expect(runtime.lifecycle.authenticate(secondToken)).resolves.toBeNull();
  });

  it('denies an authenticated non-Owner before touching the credential store', async () => {
    const runtime = await createDeviceCredentialRuntime({
      store: new FileDeviceCredentialStore(path.join(directory, 'device-credentials.json')),
    });
    const storage = new TestStorage();
    storage.shows.set('show-1', show('show-1'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authSession = {
        user: {
          id: 'producer-1',
          email: 'producer@overlaykit.local',
          displayName: 'Producer',
          roles: ['producer'],
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      next();
    });
    app.use(requireRole('owner'), createDeviceCredentialsRouter(storage, runtime));

    await request(app)
      .post('/shows/show-1/integrations/device-credentials')
      .send({})
      .expect(403);
    await expect(runtime.store.get('device-1')).resolves.toBeNull();
  });
});
