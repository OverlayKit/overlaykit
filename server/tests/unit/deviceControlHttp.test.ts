import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { createDeviceCredentialCryptoOptions } from '../../src/auth/DeviceCredentialCrypto';
import {
  createDeviceCredentialRuntime,
  type DeviceCredentialRuntime,
} from '../../src/auth/DeviceCredentialRuntime';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { createApp } from '../../src/index';
import { ChannelManager } from '../../src/services/ChannelManager';
import {
  createDeviceActionCatalogRuntime,
  type DeviceActionCatalogRuntime,
} from '../../src/services/DeviceActionCatalogRuntime';
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
  let actionCatalog: DeviceActionCatalogRuntime;
  let storage: TestStorage;
  let auth: AuthService;
  let production: ProductionService;
  let app: ReturnType<typeof createApp>;
  let credentialCounter: number;
  let entropyByte: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-device-control-'));
    now = Date.now();
    credentialCounter = 0;
    entropyByte = 0;
    runtime = await createDeviceCredentialRuntime({
      store: new SqliteDeviceCredentialStore({
        databasePath: path.join(directory, 'device-credentials.sqlite'),
      }),
      lifecycleOptions: createDeviceCredentialCryptoOptions({
        now: () => now,
        primitives: {
          randomUUID: () => `device-${++credentialCounter}`,
          randomBytes: (size) => new Uint8Array(size).fill(++entropyByte),
        },
      }),
    });
    actionCatalog = await createDeviceActionCatalogRuntime();
    storage = new TestStorage();
    storage.shows.set('show-1', show('show-1'));
    storage.shows.set('show-2', show('show-2'));
    auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    production = new ProductionService(new ChannelManager());
    if (!runtime.productionState) {
      throw new Error('SQLite device runtime did not expose production authority');
    }
    production.mountPersistence(runtime.productionState);
    production.loadPreview('show-1', scene());
    production.take('show-1', 1, 'initial-take');
    app = createApp({
      auth,
      dataStorage: storage,
      production,
      deviceCredentials: runtime,
      deviceActionCatalog: actionCatalog,
    });
  });

  afterEach(async () => {
    await runtime.close();
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
      expiresAt: overrides.expiresAt ?? now + 9_000,
    });
  }

  function endpoint(
    target: 'preview' | 'program' = 'preview',
    showId = 'show-1',
    componentId = 'lower-third'
  ): string {
    return `/api/device/shows/${showId}/production/${target}/components/${componentId}/visibility`;
  }

  function catalogEndpoint(showId = 'show-1'): string {
    return `/api/device/shows/${showId}/actions`;
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
    expect(response.body.data.command).toMatchObject({
      status: 'applied',
      resultCode: 'APPLIED',
      globalSequence: 1,
      operationId: 'preview-hide',
      expectedRevision: 1,
      previousRevision: 1,
      resultingRevision: 2,
      replayed: false,
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

    const expiring = await issue({ expiresAt: now + 1_000 });
    now += 1_001;
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

  it('publishes only the exact current inventory and device authority intersection', async () => {
    const issued = await issue({
      targets: ['preview', 'program'],
      controlIds: ['lower-third.visibility', 'scoreboard.visibility'],
    });

    const response = await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .expect(200);

    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body.data).toEqual({
      schemaVersion: 'overlaykit-control-action-catalog/v1',
      showId: 'show-1',
      actions: [
        {
          actionId: 'component.visibility/preview/lower-third',
          kind: 'component.visibility',
          subject: {
            showId: 'show-1',
            target: 'preview',
            controlId: 'lower-third.visibility',
          },
          componentId: 'lower-third',
          label: 'Lower third',
          input: { visible: { type: 'boolean', required: true } },
        },
        {
          actionId: 'component.visibility/preview/scoreboard',
          kind: 'component.visibility',
          subject: {
            showId: 'show-1',
            target: 'preview',
            controlId: 'scoreboard.visibility',
          },
          componentId: 'scoreboard',
          label: 'Scoreboard',
          input: { visible: { type: 'boolean', required: true } },
        },
        {
          actionId: 'component.visibility/program/lower-third',
          kind: 'component.visibility',
          subject: {
            showId: 'show-1',
            target: 'program',
            controlId: 'lower-third.visibility',
          },
          componentId: 'lower-third',
          label: 'Lower third',
          input: { visible: { type: 'boolean', required: true } },
        },
        {
          actionId: 'component.visibility/program/scoreboard',
          kind: 'component.visibility',
          subject: {
            showId: 'show-1',
            target: 'program',
            controlId: 'scoreboard.visibility',
          },
          componentId: 'scoreboard',
          label: 'Scoreboard',
          input: { visible: { type: 'boolean', required: true } },
        },
      ],
    });

    const serialized = JSON.stringify(response.body.data);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain(issued.credential.credentialId);
    for (const forbidden of ['generation', 'scopes', 'expiresAt', 'revision', 'currentState']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('derives nested capabilities independently from current Preview and Program snapshots', async () => {
    const issued = await issue({
      targets: ['preview', 'program'],
      controlIds: ['alert.visibility', 'lower-third.visibility'],
    });
    production.loadPreview('show-1', {
      id: 'alert-scene',
      name: 'Alert scene',
      elements: [
        {
          id: 'container',
          tag: 'section',
          content: '{{dynamicLabel}}',
          styles: {},
          children: [
            {
              id: 'alert',
              tag: 'div',
              content: 'Ignored content',
              attributes: { 'aria-label': `  ${'Live alert '.repeat(20)}  ` },
              styles: {},
            },
          ],
        },
      ],
    });
    const previewBefore = production.getSnapshot('show-1', 'preview');
    const programBefore = production.getSnapshot('show-1', 'program');

    const response = await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .expect(200);

    expect(response.body.data.actions).toHaveLength(2);
    expect(response.body.data.actions[0]).toMatchObject({
      componentId: 'alert',
      subject: { target: 'preview', controlId: 'alert.visibility' },
    });
    expect(response.body.data.actions[0].label).toHaveLength(160);
    expect(response.body.data.actions[1]).toMatchObject({
      componentId: 'lower-third',
      subject: { target: 'program', controlId: 'lower-third.visibility' },
    });
    expect(production.getSnapshot('show-1', 'preview')).toEqual(previewBefore);
    expect(production.getSnapshot('show-1', 'program')).toEqual(programBefore);
  });

  it('re-resolves catalog authority and never falls back to a Studio session', async () => {
    const issued = await issue();
    const authenticateSession = vi.spyOn(auth, 'authenticateSession');

    await request(app).get(catalogEndpoint()).expect(401);
    await request(app)
      .get(`${catalogEndpoint()}?access_token=${encodeURIComponent(issued.token)}`)
      .set('Authorization', `Bearer ${issued.token}`)
      .expect(400);
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .set('Cookie', 'overlaykit_session=ok_session_example')
      .expect(400);
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', [`Bearer ${issued.token}`, `Bearer ${issued.token}`])
      .expect(400);

    const rotated = await runtime.lifecycle.rotate(DEVICE_OWNER, issued.credential.credentialId);
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .expect(401);
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${rotated.token}`)
      .expect(200);
    await runtime.lifecycle.revoke(DEVICE_OWNER, issued.credential.credentialId);
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${rotated.token}`)
      .expect(401);

    expect(authenticateSession).not.toHaveBeenCalled();
  });

  it('binds discovery to the credential Show and active Show lifecycle', async () => {
    const wrongShow = await issue({ showId: 'show-2' });
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${wrongShow.token}`)
      .expect(403);

    const empty = await request(app)
      .get(catalogEndpoint('show-2'))
      .set('Authorization', `Bearer ${wrongShow.token}`)
      .expect(200);
    expect(empty.body.data.actions).toEqual([]);

    storage.shows.set('archived-show', show('archived-show', 2_000));
    const archived = await issue({ showId: 'archived-show' });
    await request(app)
      .get(catalogEndpoint('archived-show'))
      .set('Authorization', `Bearer ${archived.token}`)
      .expect(409);

    const missing = await issue({ showId: 'missing-show' });
    await request(app)
      .get(catalogEndpoint('missing-show'))
      .set('Authorization', `Bearer ${missing.token}`)
      .expect(404);
  });

  it('returns an empty catalog for unavailable authority and fails closed on ambiguous inventory', async () => {
    const readOnly = await issue({ scopes: ['feedback:read'] });
    const empty = await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${readOnly.token}`)
      .expect(200);
    expect(empty.body.data.actions).toEqual([]);

    production.loadPreview('show-1', {
      id: 'ambiguous-scene',
      name: 'Ambiguous scene',
      elements: [
        { id: 'duplicate', tag: 'div', content: 'First', styles: {} },
        { id: 'duplicate', tag: 'div', content: 'Second', styles: {} },
      ],
    });
    const ambiguous = await issue({ controlIds: ['duplicate.visibility'] });
    const snapshotBefore = production.getSnapshot('show-1', 'preview');
    const denied = await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${ambiguous.token}`)
      .expect(409);
    expect(denied.body).toEqual({
      error: {
        code: 'ACTION_CATALOG_UNAVAILABLE',
        message: 'Current device actions cannot be projected',
      },
    });
    expect(production.getSnapshot('show-1', 'preview')).toEqual(snapshotBefore);

    production.loadPreview('show-1', {
      id: 'oversized-scene',
      name: 'Oversized scene',
      elements: Array.from({ length: 1_001 }, (_, index) => ({
        id: `component-${index}`,
        tag: 'div',
        content: `Component ${index}`,
        styles: {},
      })),
    });
    const oversized = await issue({ controlIds: ['component-0.visibility'] });
    await request(app)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${oversized.token}`)
      .expect(409, {
        error: {
          code: 'ACTION_CATALOG_UNAVAILABLE',
          message: 'Current device actions cannot be projected',
        },
      });
  });

  it('contains projector failures without disclosing internal details', async () => {
    const issued = await issue();
    const failingApp = createApp({
      auth,
      dataStorage: storage,
      production,
      deviceCredentials: runtime,
      deviceActionCatalog: {
        projectAuthorizedControlActionCatalog: () => {
          throw new Error('private projector detail');
        },
      },
    });

    const response = await request(failingApp)
      .get(catalogEndpoint())
      .set('Authorization', `Bearer ${issued.token}`)
      .expect(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Device action catalog failed' },
    });
    expect(JSON.stringify(response.body)).not.toContain('private projector detail');
  });
});
