import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { createDeviceCredentialCryptoOptions } from '../../src/auth/DeviceCredentialCrypto';
import {
  createDeviceCredentialRuntime,
  type DeviceCredentialRuntime,
} from '../../src/auth/DeviceCredentialRuntime';
import { FileDeviceCredentialStore } from '../../src/auth/FileDeviceCredentialStore';
import { createApp } from '../../src/index';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import type {
  ActionRecord,
  CollectionMeta,
  CollectionRecord,
  ShowRecord,
  Storage,
} from '../../src/storage';
import type { Scene } from '../../src/types/scene';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEVICE_OWNER = { principalId: 'owner-1', roles: ['owner'] } as const;

class TestStorage implements Storage {
  readonly shows = new Map<string, ShowRecord>();
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
  async archiveShow(id: string, archivedAt: number): Promise<ShowRecord | null> {
    const current = this.shows.get(id);
    if (!current) return null;
    const archived = { ...current, archivedAt, updatedAt: archivedAt };
    this.shows.set(id, archived);
    return archived;
  }
  async listCollections(_tenantId: string): Promise<CollectionMeta[]> {
    return [];
  }
  async getCollection(_tenantId: string, _id: string): Promise<CollectionRecord | null> {
    return null;
  }
  async saveCollection(record: CollectionRecord): Promise<CollectionRecord> {
    return record;
  }
  async deleteCollection(_tenantId: string, _id: string): Promise<boolean> {
    return false;
  }
  async listActions(_tenantId: string): Promise<ActionRecord[]> {
    return [];
  }
  async getAction(_tenantId: string, _id: string): Promise<ActionRecord | null> {
    return null;
  }
  async saveAction(_record: ActionRecord): Promise<void> {}
  async deleteAction(_tenantId: string, _id: string): Promise<boolean> {
    return false;
  }
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

function scene(): Scene {
  return {
    id: 'production-scene',
    name: 'Production scene',
    elements: [
      { id: 'lower-third', tag: 'section', content: 'Lower third', styles: {} },
      { id: 'scoreboard', tag: 'section', content: 'Scoreboard', styles: {} },
    ],
  };
}

describe('device bearer production control boundary', () => {
  let directory: string;
  let now: number;
  let runtime: DeviceCredentialRuntime;
  let storage: TestStorage;
  let auth: AuthService;
  let production: ProductionService;
  let app: ReturnType<typeof createApp>;
  let credentialCounter: number;
  let entropyByte: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-device-control-'));
    now = 1_000;
    credentialCounter = 0;
    entropyByte = 0;
    runtime = await createDeviceCredentialRuntime({
      store: new FileDeviceCredentialStore(path.join(directory, 'device-credentials.json')),
      lifecycleOptions: createDeviceCredentialCryptoOptions({
        now: () => now,
        primitives: {
          randomUUID: () => `device-${++credentialCounter}`,
          randomBytes: (size) => new Uint8Array(size).fill(++entropyByte),
        },
      }),
    });
    storage = new TestStorage();
    storage.shows.set('show-1', show('show-1'));
    storage.shows.set('show-2', show('show-2'));
    auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    production = new ProductionService(new ChannelManager());
    production.loadPreview('show-1', scene());
    production.take('show-1', 1, 'initial-take');
    app = createApp({ auth, dataStorage: storage, production, deviceCredentials: runtime });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function issue(
    overrides: Partial<{
      showId: string;
      targets: Array<'preview' | 'program'>;
      controlIds: string[];
      scopes: Array<'feedback:read' | 'component.visibility:write'>;
      expiresAt: number;
    }> = {}
  ) {
    return runtime.lifecycle.issue(DEVICE_OWNER, {
      label: 'Production desk',
      showId: overrides.showId ?? 'show-1',
      targets: overrides.targets ?? ['preview'],
      controlIds: overrides.controlIds ?? ['lower-third.visibility'],
      scopes: overrides.scopes ?? ['component.visibility:write'],
      expiresAt: overrides.expiresAt ?? 10_000,
    });
  }

  function endpoint(
    target: 'preview' | 'program' = 'preview',
    showId = 'show-1',
    componentId = 'lower-third'
  ): string {
    return `/api/device/shows/${showId}/production/${target}/components/${componentId}/visibility`;
  }

  function command(operationId: string, expectedRevision = 1, visible = false) {
    return { visible, operationId, expectedRevision };
  }

  it('executes one Preview intent without resolving or changing a Studio session', async () => {
    const issued = await issue();
    const authenticateSession = vi.spyOn(auth, 'authenticateSession');
    const startedAt = Date.now();

    const response = await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send(command('preview-hide'))
      .expect(200);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.data.receipt).toMatchObject({
      kind: 'component.visibility',
      showId: 'show-1',
      target: 'preview',
      componentId: 'lower-third',
      resultingState: 'inactive',
      operationId: 'preview-hide',
      targetRevision: 2,
    });
    expect(response.body.data.state.preview.elements[0].styles.display).toBe('none');
    expect(response.body.data.state.program.elements[0].styles.display).toBeUndefined();
    expect(authenticateSession).not.toHaveBeenCalled();
  });

  it('derives direct Program capability from freshly authorized route authority', async () => {
    const previewOnly = await issue();
    const denied = await request(app)
      .post(endpoint('program'))
      .set('Authorization', `Bearer ${previewOnly.token}`)
      .send(command('program-denied'))
      .expect(403);
    expect(denied.headers['www-authenticate']).toContain('insufficient_scope');
    expect(production.getState('show-1').program.revision).toBe(1);

    const program = await issue({ targets: ['program'] });
    const allowed = await request(app)
      .post(endpoint('program'))
      .set('Authorization', `Bearer ${program.token}`)
      .send(command('program-hide'))
      .expect(200);
    expect(allowed.body.data.receipt).toMatchObject({ target: 'program', targetRevision: 2 });
    expect(production.getState('show-1').program.elements[0].styles.display).toBe('none');
    expect(production.getState('show-1').preview.elements[0].styles.display).toBeUndefined();
  });

  it('denies wrong Show, control, and scope before production mutation', async () => {
    const wrongShow = await issue({ showId: 'show-2' });
    const wrongControl = await issue({ controlIds: ['scoreboard.visibility'] });
    const wrongScope = await issue({ scopes: ['feedback:read'] });

    for (const token of [wrongShow.token, wrongControl.token, wrongScope.token]) {
      await request(app)
        .post(endpoint())
        .set('Authorization', `Bearer ${token}`)
        .send(command(`denied-${token.slice(-4)}`))
        .expect(403);
    }

    expect(production.getState('show-1').preview.revision).toBe(1);
    expect(production.getState('show-1').preview.elements[0].styles.display).toBeUndefined();
  });

  it('re-resolves rotation, revocation, expiration, and token integrity on every request', async () => {
    const issued = await issue();
    const rotated = await runtime.lifecycle.rotate(DEVICE_OWNER, issued.credential.credentialId);

    for (const token of [issued.token, `${rotated.token}tampered`]) {
      const denied = await request(app)
        .post(endpoint())
        .set('Authorization', `Bearer ${token}`)
        .send(command('fresh-auth-denied'))
        .expect(401);
      expect(denied.headers['www-authenticate']).toContain('invalid_token');
    }

    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${rotated.token}`)
      .send(command('fresh-auth-valid'))
      .expect(200);
    await runtime.lifecycle.revoke(DEVICE_OWNER, issued.credential.credentialId);
    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${rotated.token}`)
      .send(command('after-revoke', 2, true))
      .expect(401);

    const expiring = await issue({ expiresAt: 2_000 });
    now = 2_001;
    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${expiring.token}`)
      .send(command('after-expiry', 2, true))
      .expect(401);
    expect(production.getState('show-1').preview.revision).toBe(2);
  });

  it('accepts bearer authority only from one Authorization field', async () => {
    const issued = await issue();
    const body = command('transport-test');
    const authenticateSession = vi.spyOn(auth, 'authenticateSession');

    const missing = await request(app).post(endpoint()).send(body).expect(401);
    expect(missing.headers['www-authenticate']).toContain('Bearer');
    expect(missing.headers['cache-control']).toContain('no-store');
    await request(app)
      .post(endpoint())
      .set('Authorization', `Basic ${issued.token}`)
      .send(body)
      .expect(401);
    await request(app)
      .post(endpoint())
      .set('Authorization', `bearer ${issued.token}`)
      .send(command('lowercase-bearer'))
      .expect(200);
    await request(app)
      .post(`${endpoint()}?access_token=${encodeURIComponent(issued.token)}`)
      .set('Authorization', `Bearer ${issued.token}`)
      .send(body)
      .expect(400);
    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send({ ...body, access_token: issued.token })
      .expect(400);
    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .set('Cookie', 'overlaykit_session=ok_session_example')
      .send(body)
      .expect(400);
    await request(app)
      .post(endpoint())
      .set('Cookie', 'overlaykit_session=ok_session_example')
      .send(body)
      .expect(400);
    await request(app)
      .post(endpoint())
      .set('Authorization', [`Bearer ${issued.token}`, `Bearer ${issued.token}`])
      .send(body)
      .expect(400);
    await request(app)
      .post('/api/device/shows/show-1%20/production/preview/components/lower-third/visibility')
      .set('Authorization', `Bearer ${issued.token}`)
      .send(body)
      .expect(400);

    expect(authenticateSession).not.toHaveBeenCalled();
    expect(production.getState('show-1').preview.revision).toBe(2);
  });

  it('rejects body authority substitution and preserves idempotency and revision failures', async () => {
    const issued = await issue();
    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send({ ...command('body-authority'), showId: 'show-2' })
      .expect(400);
    expect(production.getState('show-1').preview.revision).toBe(1);

    const first = await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send(command('idempotent'))
      .expect(200);
    const replay = await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send(command('idempotent'))
      .expect(200);
    expect(replay.body.data.receipt).toEqual(first.body.data.receipt);
    expect(production.getState('show-1').preview.revision).toBe(2);

    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send(command('idempotent', 1, true))
      .expect(409);
    await request(app)
      .post(endpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .send(command('stale-revision', 1, true))
      .expect(409);

    const missingControl = await issue({ controlIds: ['missing-component.visibility'] });
    await request(app)
      .post(endpoint('preview', 'show-1', 'missing-component'))
      .set('Authorization', `Bearer ${missingControl.token}`)
      .send(command('missing-component', 2, true))
      .expect(404);
    expect(production.getState('show-1').preview.revision).toBe(2);
  });

  it('checks active Show state only after exact device authorization', async () => {
    storage.shows.set('archived-show', show('archived-show', 2_000));
    const archived = await issue({ showId: 'archived-show' });
    const missing = await issue({ showId: 'missing-show' });

    await request(app)
      .post(endpoint('preview', 'archived-show'))
      .set('Authorization', `Bearer ${archived.token}`)
      .send(command('archived-show'))
      .expect(409);
    await request(app)
      .post(endpoint('preview', 'missing-show'))
      .set('Authorization', `Bearer ${missing.token}`)
      .send(command('missing-show'))
      .expect(404);
    expect(production.getState('show-1').preview.revision).toBe(1);
  });
});
