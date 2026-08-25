import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type ClientOptions } from 'ws';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { setupWebSocketHandler } from '../../src/handlers/websocket';
import { ChannelManager, channelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import { channelKey, DEFAULT_TENANT_ID } from '../../src/tenancy';

const ORIGIN = 'http://localhost:5173';
const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

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

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', resolve));
}

/**
 * CHG-0048 / ADR-0039: an Output-credentialed WebSocket connection derives its authority from the
 * Output credential, never from an ambient Studio session cookie carried on the same-host /ws
 * upgrade. authenticate.output overrides any session-derived authority (a strict de-escalation),
 * so the connection is read-only, exact-Show, and retired by Output-credential rotation.
 */
describe('Output authentication overrides an ambient Studio session', () => {
  let wsServer: WebSocketServer | undefined;

  afterEach(async () => {
    if (wsServer) {
      await new Promise<void>((resolve) => wsServer!.close(() => resolve()));
      wsServer = undefined;
    }
  });

  async function start(): Promise<{ port: number; auth: AuthService }> {
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    wsServer = new WebSocketServer({ port: 0 });
    setupWebSocketHandler(
      wsServer,
      auth,
      [ORIGIN],
      new ProductionService(new ChannelManager(), { allowEphemeral: true }),
      { outputAuthenticationTimeoutMs: 200 }
    );
    await new Promise<void>((resolve) => wsServer!.once('listening', () => resolve()));
    return { port: (wsServer!.address() as AddressInfo).port, auth };
  }

  it('binds a cookie-bearing connection to the Output credential and retires it on rotation', async () => {
    const { port, auth } = await start();
    const owner = await auth.setup(OWNER);
    const output = await auth.rotateOutputToken(owner.session.user, 'show-1');

    // Connection carries a VALID Studio session cookie AND declares Output intent first.
    const ws = await openWebSocket(`ws://127.0.0.1:${port}`, {
      origin: ORIGIN,
      headers: { Cookie: `overlaykit_session=${owner.token}` },
    });

    const confirmed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'authenticate.output', token: output.token }));
    // Authority is Output, not the studio access the cookie would otherwise grant.
    expect(await confirmed).toMatchObject({ type: 'authentication.confirmed', access: 'output' });

    // Read-only, exact-Show: the studio powers the cookie would have granted are denied.
    const previewDenied = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe.production', showId: 'show-1', bus: 'preview' }));
    expect(await previewDenied).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    const mutateDenied = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'scene_activate',
        payload: { channelId: 'show-1', scene: { id: 's', name: 'S', elements: [] } },
      })
    );
    expect(await mutateDenied).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    const subscribed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe.production', showId: 'show-1', bus: 'program' }));
    expect(await subscribed).toMatchObject({
      type: 'production.subscription.confirmed',
      showId: 'show-1',
      bus: 'program',
    });

    // The connection is governed by the Output credential: rotating it retires the socket.
    // A session-authority socket would survive Output rotation, so this is the load-bearing check.
    const retired = closeCode(ws);
    await auth.rotateOutputToken(owner.session.user, 'show-1');
    expect(await retired).toBe(1008);
  });

  it('closes a cookie-bearing connection that declares Output intent with an invalid token', async () => {
    const { port, auth } = await start();
    const owner = await auth.setup(OWNER);
    await auth.rotateOutputToken(owner.session.user, 'show-1');

    const ws = await openWebSocket(`ws://127.0.0.1:${port}`, {
      origin: ORIGIN,
      headers: { Cookie: `overlaykit_session=${owner.token}` },
    });
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ type: 'authenticate.output', token: 'not-a-valid-output-token' }));
    // It declared Output intent and failed; it must NOT silently fall back to studio authority.
    expect(await closed).toBe(1008);
  });

  it('preserves studio authority for a cookie-bearing connection that never claims Output', async () => {
    const { port, auth } = await start();
    const owner = await auth.setup(OWNER);

    const studio = await openWebSocket(`ws://127.0.0.1:${port}`, {
      origin: ORIGIN,
      headers: { Cookie: `overlaykit_session=${owner.token}` },
    });
    const pong = nextMessage(studio);
    studio.send(JSON.stringify({ type: 'ping' }));
    expect((await pong).type).toBe('pong');
    studio.close();
  });

  it('rejects a cookie-bearing upgrade that carries no Origin (CHG-0076)', async () => {
    const { port, auth } = await start();
    const owner = await auth.setup(OWNER);
    // A browser always sends Origin; a cookie with no Origin is a raw client replaying the cookie.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { Cookie: `overlaykit_session=${owner.token}` },
    });
    const code = await new Promise<number>((resolve) => {
      ws.once('error', () => undefined);
      ws.once('close', (value) => resolve(value));
    });
    expect(code).toBe(1008);
  });

  it('allows a no-cookie no-Origin connection to authenticate as output (CHG-0076)', async () => {
    const { port, auth } = await start();
    const owner = await auth.setup(OWNER);
    const output = await auth.rotateOutputToken(owner.session.user, 'show-1');
    // Output/OBS clients carry no cookie and no Origin — they must still reach authenticate.output.
    const ws = await openWebSocket(`ws://127.0.0.1:${port}`);
    const confirmed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'authenticate.output', token: output.token }));
    expect(await confirmed).toMatchObject({ type: 'authentication.confirmed', access: 'output' });
    ws.close();
  });

  it('tears down studio subscriptions when de-escalating to output (CHG-0076)', async () => {
    const { port, auth } = await start();
    const owner = await auth.setup(OWNER);
    const output = await auth.rotateOutputToken(owner.session.user, 'show-1');
    const channelId = `dee-${process.pid}`;
    const key = channelKey(DEFAULT_TENANT_ID, channelId);

    const ws = await openWebSocket(`ws://127.0.0.1:${port}`, {
      origin: ORIGIN,
      headers: { Cookie: `overlaykit_session=${owner.token}` },
    });
    // Subscribe as a studio session.
    const subscribed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', channelId }));
    expect((await subscribed).type).toBe('subscription.confirmed');
    expect(channelManager.getSubscriberCount(key)).toBe(1);

    // De-escalate to output — the studio subscription must be torn down.
    const confirmed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'authenticate.output', token: output.token }));
    expect(await confirmed).toMatchObject({ type: 'authentication.confirmed', access: 'output' });
    expect(channelManager.getSubscriberCount(key)).toBe(0);
    ws.close();
  });
});
