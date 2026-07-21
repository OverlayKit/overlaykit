import type { AddressInfo } from 'net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type ClientOptions } from 'ws';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { setupWebSocketHandler } from '../../src/handlers/websocket';
import { createApp } from '../../src/index';
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
  private readonly shows = new Map<string, ShowRecord>();
  async init(): Promise<void> {}
  async listShows(includeArchived = false): Promise<ShowRecord[]> {
    return [...this.shows.values()].filter((show) => includeArchived || show.archivedAt === null);
  }
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

function openWebSocket(url: string, options: ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [], options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

describe('local security boundary', () => {
  let auth: AuthService;
  let wsServer: WebSocketServer | undefined;

  beforeEach(async () => {
    auth = new AuthService(new MemoryAuthStore());
    await auth.init();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    wsServer = undefined;
  });

  it('protects product APIs, enforces origin, and supports the owner lifecycle', async () => {
    const agent = request.agent(createApp({ auth, dataStorage: new TestStorage() }));

    const health = await agent.get('/health').expect(200);
    expect(health.body).toMatchObject({ status: 'ok' });
    expect(health.body).not.toHaveProperty('channels');
    await agent.get('/api/shows').expect(401);
    await agent.get('/api/collections').expect(401);
    await agent.post('/api/auth/setup').send(OWNER).expect(403);

    const setup = await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);
    expect(setup.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(setup.headers['set-cookie']?.[0]).toContain('SameSite=Strict');
    await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(409);

    const created = await agent
      .post('/api/shows')
      .set('Origin', ORIGIN)
      .send({ name: 'Friday Broadcast', description: 'Weekly production' })
      .expect(201);
    expect(created.body.data.name).toBe('Friday Broadcast');
    const showId = created.body.data.id as string;
    const sourceScene = {
      id: 'opening',
      name: 'Opening',
      elements: [{
        id: 'title',
        tag: 'div',
        content: '{{title}}',
        styles: {},
        controls: [{ id: 'opening.title', label: 'Title', type: 'text', path: 'title' }],
      }],
    };
    const preview = await agent
      .post(`/api/shows/${showId}/production/preview`)
      .set('Origin', ORIGIN)
      .send({ scene: sourceScene, variables: { title: 'Hello' } })
      .expect(200);
    expect(preview.body.data).toMatchObject({
      preview: {
        revision: 1,
        scene: { id: 'opening' },
        controls: [{ id: 'opening.title', value: 'Hello' }],
      },
      program: { revision: 0, scene: null },
    });
    const controlled = await agent
      .post(`/api/shows/${showId}/production/preview/controls`)
      .set('Origin', ORIGIN)
      .send({ expectedPreviewRevision: 1, operationId: 'control-1', values: { 'opening.title': 'Ready' } })
      .expect(200);
    expect(controlled.body.data).toMatchObject({
      preview: { revision: 2, variables: { title: 'Ready' } },
      program: { revision: 0, scene: null },
    });
    await agent
      .post(`/api/shows/${showId}/production/take`)
      .set('Origin', ORIGIN)
      .send({ expectedPreviewRevision: 0, operationId: 'stale-take' })
      .expect(409);
    const taken = await agent
      .post(`/api/shows/${showId}/production/take`)
      .set('Origin', ORIGIN)
      .send({ expectedPreviewRevision: 2, operationId: 'take-1' })
      .expect(200);
    expect(taken.body.data.program).toMatchObject({
      revision: 1,
      scene: { id: 'opening' },
      variables: { title: 'Ready' },
    });
    await agent.get('/api/shows').expect(200);
    await agent.delete(`/api/shows/${created.body.data.id}`).set('Origin', ORIGIN).expect(200);
    expect((await agent.get('/api/shows').expect(200)).body.data).toEqual([]);

    await agent.post('/api/auth/logout').set('Origin', ORIGIN).expect(204);
    await agent.get('/api/shows').expect(401);
    await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ ...OWNER, password: 'wrong password' }).expect(401);
    await agent.post('/api/auth/login').set('Origin', ORIGIN).send(OWNER).expect(200);
  });

  it('accepts a rotating output token over WebSocket and keeps it read-only', async () => {
    const owner = await auth.setup(OWNER);
    const output = await auth.rotateOutputToken(owner.session.user);
    wsServer = new WebSocketServer({ port: 0 });
    setupWebSocketHandler(wsServer, auth, [ORIGIN]);
    await new Promise<void>((resolve) => wsServer!.once('listening', () => resolve()));
    const port = (wsServer.address() as AddressInfo).port;

    const anonymous = new WebSocket(`ws://127.0.0.1:${port}`, [], { origin: ORIGIN });
    const anonymousClose = new Promise<number>((resolve) => anonymous.once('close', resolve));
    expect(await anonymousClose).toBe(1008);

    const studio = await openWebSocket(`ws://127.0.0.1:${port}`, {
      origin: ORIGIN,
      headers: { Cookie: `overlaykit_session=${owner.token}` },
    });
    const pong = nextMessage(studio);
    studio.send(JSON.stringify({ type: 'ping' }));
    expect((await pong).type).toBe('pong');
    studio.close();

    const ws = await openWebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(output.token)}`, {
      origin: ORIGIN,
    });
    const legacyDenied = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', channelId: 'show-1' }));
    expect(await legacyDenied).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    const previewDenied = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe.production', showId: 'show-1', bus: 'preview' }));
    expect(await previewDenied).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    const subscribed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe.production', showId: 'show-1', bus: 'program' }));
    expect(await subscribed).toMatchObject({
      type: 'production.subscription.confirmed',
      showId: 'show-1',
      bus: 'program',
    });

    const denied = nextMessage(ws);
    ws.send(JSON.stringify({
      type: 'scene_activate',
      payload: { channelId: 'show-1', scene: { id: 'scene-1', name: 'Scene', elements: [] } },
    }));
    expect(await denied).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    ws.close();
  });
});
