import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type ClientOptions } from 'ws';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { setupWebSocketHandler } from '../../src/handlers/websocket';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';

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
 * CHG-0069 hardening: a Studio /ws connection captures its authority at upgrade time, so a logout or
 * session expiry must revoke an already-open socket — the authority may not outlive the session.
 */
describe('Studio WebSocket session revocation', () => {
  let wsServer: WebSocketServer | undefined;

  afterEach(async () => {
    if (wsServer) {
      await new Promise<void>((resolve) => wsServer!.close(() => resolve()));
      wsServer = undefined;
    }
  });

  async function start(auth: AuthService): Promise<number> {
    await auth.init();
    wsServer = new WebSocketServer({ port: 0 });
    setupWebSocketHandler(
      wsServer,
      auth,
      [ORIGIN],
      new ProductionService(new ChannelManager(), { allowEphemeral: true }),
      { outputAuthenticationTimeoutMs: 200 },
    );
    await new Promise<void>((resolve) => wsServer!.once('listening', () => resolve()));
    return (wsServer!.address() as AddressInfo).port;
  }

  async function connect(port: number, token: string): Promise<WebSocket> {
    return openWebSocket(`ws://127.0.0.1:${port}`, {
      origin: ORIGIN,
      headers: { Cookie: `overlaykit_session=${token}` },
    });
  }

  it('revokes an open studio socket on logout', async () => {
    const auth = new AuthService(new MemoryAuthStore());
    const port = await start(auth);
    const owner = await auth.setup(OWNER);
    const ws = await connect(port, owner.token);

    // A frame is processed while the session is valid.
    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await pong).toMatchObject({ type: 'pong' });

    // Logout invalidates the session; the next frame — here a mutating one — revokes the already-open
    // socket before it is dispatched, so no authority survives the logout.
    auth.logout(owner.token);
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ type: 'scene_activate', channelId: 'show-1', collectionId: 'scene-1' }));
    expect(await closed).toBe(1008);
  });

  it('revokes an open studio socket when the session expires', async () => {
    let clock = 1_000;
    const auth = new AuthService(new MemoryAuthStore(), { sessionTtlMs: 50, now: () => clock });
    const port = await start(auth);
    const owner = await auth.setup(OWNER);
    const ws = await connect(port, owner.token);

    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await pong).toMatchObject({ type: 'pong' });

    // Advance the clock past the session TTL; the next frame revokes the socket.
    clock += 1_000;
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await closed).toBe(1008);
  });
});
