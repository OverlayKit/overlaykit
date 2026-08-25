import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_WS_MAX_PAYLOAD_BYTES,
  createBrowserWebSocketServer,
} from '../../src/handlers/websocket';

/**
 * CHG-0067 hardening: the browser /ws server must bound inbound frames so an unauthenticated peer
 * cannot force the ws default (~100 MiB) buffering + JSON.parse per frame.
 */
describe('Browser WebSocket frame bound', () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('wires a finite bound well below the ws 100 MiB default', () => {
    const wss = createBrowserWebSocketServer();
    servers.push(wss);
    // The ws library default maxPayload is 104_857_600 (100 MiB); the browser server must cap it.
    expect(wss.options.maxPayload).toBe(BROWSER_WS_MAX_PAYLOAD_BYTES);
    expect(BROWSER_WS_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(BROWSER_WS_MAX_PAYLOAD_BYTES).toBeLessThan(104_857_600);
  });

  it('rejects an oversized inbound frame without delivering it', async () => {
    const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
    servers.push(wss);
    let delivered = false;
    wss.on('connection', (socket) => {
      // ws raises WS_ERR_UNSUPPORTED_MESSAGE_LENGTH on the server socket for an over-limit frame;
      // handle it so it does not become an unhandled error.
      socket.on('error', () => undefined);
      socket.on('message', () => {
        delivered = true;
      });
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connection never closed')), 5_000);
      client.on('open', () => client.send(Buffer.alloc(4096)));
      client.on('error', () => undefined); // an oversized frame may also surface as a socket error
      client.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    // The over-limit frame is never handed to the application, and the peer is closed (1009 = too big).
    expect(delivered).toBe(false);
    expect(closeCode).toBe(1009);
  });
});
