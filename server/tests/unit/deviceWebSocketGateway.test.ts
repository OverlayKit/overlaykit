import { randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import { connect as connectSocket, type Socket } from 'net';
import type { AddressInfo } from 'net';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import {
  DEVICE_WEBSOCKET_PATH,
  DeviceWebSocketGateway,
} from '../../src/handlers/DeviceWebSocketGateway';
import type {
  DeviceAuthorityConnection,
  DeviceConnectionAuthority,
  DeviceConnectionLease,
} from '../../src/services/DeviceConnectionAuthorityCoordinator';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface GatewayHarness {
  readonly gateway: DeviceWebSocketGateway;
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

const TOKEN = 'ok_device_device-1.abcdefghijklmnopqrstuvwxyz0123456789';

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authority(): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g2',
    generation: 2,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['lower-third.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: Date.now() + 60_000,
  };
}

function pendingCoordinator() {
  const admission = deferred<DeviceConnectionLease>();
  const connect = vi.fn((
    _authority: DeviceConnectionAuthority,
    _connection: DeviceAuthorityConnection,
  ) => admission.promise);
  return { admission, connect };
}

async function startGateway(
  gateway: DeviceWebSocketGateway,
): Promise<GatewayHarness> {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    if (gateway.handleUpgrade(request, socket, head)) return;
    socket.end(
      'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    gateway,
    server,
    port,
    async close() {
      gateway.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function parseRawResponse(raw: string): RawResponse {
  const [head, ...bodyParts] = raw.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const status = Number(lines[0]?.split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status, headers, body: bodyParts.join('\r\n\r\n') };
}

function rawUpgrade(
  port: number,
  path = DEVICE_WEBSOCKET_PATH,
  headers: ReadonlyArray<readonly [string, string]> = [],
  includeDefaultProtocol = true,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { raw += chunk; });
    socket.once('end', () => resolve(parseRawResponse(raw)));
    socket.once('connect', () => {
      const requestHeaders: Array<readonly [string, string]> = [
        ['Host', `127.0.0.1:${port}`],
        ['Upgrade', 'websocket'],
        ['Connection', 'Upgrade'],
        ['Sec-WebSocket-Version', '13'],
        ['Sec-WebSocket-Key', randomBytes(16).toString('base64')],
        ...(includeDefaultProtocol
          ? [['Sec-WebSocket-Protocol', 'overlaykit.device.v1'] as const]
          : []),
        ...headers,
      ];
      socket.write([
        `GET ${path} HTTP/1.1`,
        ...requestHeaders.map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function openWebSocket(
  port: number,
  protocols: string | string[],
  options: ClientOptions,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${DEVICE_WEBSOCKET_PATH}`,
      protocols,
      options,
    );
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

const harnesses: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe('DeviceWebSocketGateway', () => {
  it('returns one indistinguishable 401 before upgrade for every invalid bearer source', async () => {
    const authenticate = vi.fn(async () => null);
    const coordinator = pendingCoordinator();
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
    }));
    harnesses.push(harness);

    const responses = await Promise.all([
      rawUpgrade(harness.port),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [['Authorization', 'Basic abc']]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [['Authorization', 'Bearer invalid token']]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [[
        'Authorization',
        `Bearer ${TOKEN}`,
      ]]),
      rawUpgrade(harness.port, `${DEVICE_WEBSOCKET_PATH}?token=${TOKEN}`, [
        ['Authorization', `Bearer ${TOKEN}`],
      ]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
        ['Authorization', `Bearer ${TOKEN}`],
        ['Cookie', 'overlaykit_session=studio'],
      ]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
        ['Authorization', `Bearer ${TOKEN}`],
        ['Authorization', `Bearer ${TOKEN}`],
      ]),
    ]);

    const publicShapes = responses.map((response) => ({
      status: response.status,
      cacheControl: response.headers['cache-control'],
      pragma: response.headers.pragma,
      challenge: response.headers['www-authenticate'],
      contentType: response.headers['content-type'],
      body: response.body,
    }));
    expect(new Set(publicShapes.map((shape) => JSON.stringify(shape)))).toHaveLength(1);
    expect(publicShapes[0]).toMatchObject({
      status: 401,
      cacheControl: 'no-store',
      pragma: 'no-cache',
      challenge: 'Bearer realm="overlaykit-device"',
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith(TOKEN);
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('rejects every browser Origin before authentication', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
    }));
    harnesses.push(harness);

    const responses = await Promise.all([
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
        ['Authorization', `Bearer ${TOKEN}`],
        ['Origin', 'https://studio.overlaykit.local'],
      ]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
        ['Authorization', `Bearer ${TOKEN}`],
        ['Origin', ''],
      ]),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(responses.every((response) => response.body.includes('DEVICE_ORIGIN_FORBIDDEN')))
      .toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('requires a compatible protocol and selects the highest mutual version', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
      supportedProtocols: [
        'overlaykit.device.v1',
        'overlaykit.device.v3',
        'overlaykit.device.v2',
      ],
    }));
    harnesses.push(harness);

    const absent = await rawUpgrade(
      harness.port,
      DEVICE_WEBSOCKET_PATH,
      [['Authorization', `Bearer ${TOKEN}`]],
      false,
    );
    const incompatible = await rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
      ['Authorization', `Bearer ${TOKEN}`],
      ['Sec-WebSocket-Protocol', 'overlaykit.device.v9'],
    ], false);

    expect(absent.status).toBe(426);
    expect(incompatible.status).toBe(426);
    expect(incompatible.headers['sec-websocket-protocol'])
      .toBe('overlaykit.device.v3, overlaykit.device.v2, overlaykit.device.v1');

    const ws = await openWebSocket(
      harness.port,
      ['overlaykit.device.v1', 'overlaykit.device.v2'],
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(ws.protocol).toBe('overlaykit.device.v2');
    ws.close();
  });

  it('completes 101 while coordinator admission is pending and rejects every message as not_ready', async () => {
    const mutableAuthority = authority() as DeviceCredentialAuthority & {
      audienceCredentialId: string;
      expiresAt: number;
      showId: string;
    };
    const authenticate = vi.fn(async () => mutableAuthority);
    const coordinator = pendingCoordinator();
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
      generateConnectionId: () => 'connection-1',
    }));
    harnesses.push(harness);

    const ws = await openWebSocket(
      harness.port,
      'overlaykit.device.v1',
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(coordinator.connect).toHaveBeenCalledTimes(1);

    const [capturedAuthority, capturedConnection] = coordinator.connect.mock.calls[0];
    expect(capturedAuthority).toEqual({
      credentialId: 'device-1',
      audienceCredentialId: 'device-1.g2',
      generation: 2,
      showId: 'show-1',
      expiresAt: mutableAuthority.expiresAt,
    });
    expect(Object.isFrozen(capturedAuthority)).toBe(true);
    expect(capturedConnection.id).toBe('connection-1');

    mutableAuthority.audienceCredentialId = 'attacker.g99';
    mutableAuthority.showId = 'attacker-show';
    mutableAuthority.expiresAt += 60_000;
    expect(capturedAuthority).toMatchObject({
      audienceCredentialId: 'device-1.g2',
      showId: 'show-1',
    });

    const first = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'production.take', showId: 'attacker-show' }));
    expect(await first).toEqual({
      type: 'device.error',
      code: 'not_ready',
      message: 'Device connection is not ready',
    });

    coordinator.admission.resolve({
      connectionId: capturedConnection.id,
      authority: capturedAuthority,
    });
    await Promise.resolve();
    const second = nextMessage(ws);
    ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(await second).toMatchObject({ code: 'not_ready' });
    expect(coordinator.connect).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('fails closed when credential authority is unavailable or coordinator admission rejects', async () => {
    const unavailableCoordinator = pendingCoordinator();
    const unavailable = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate: vi.fn(async () => { throw new Error('store unavailable'); }) },
      coordinator: unavailableCoordinator,
    }));
    harnesses.push(unavailable);

    const unavailableResponse = await rawUpgrade(unavailable.port, DEVICE_WEBSOCKET_PATH, [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableCoordinator.connect).not.toHaveBeenCalled();

    const coordinator = {
      connect: vi.fn(async () => { throw new Error('authority rejected'); }),
    };
    const rejected = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate: vi.fn(async () => authority()) },
      coordinator,
    }));
    harnesses.push(rejected);
    const ws = await openWebSocket(
      rejected.port,
      'overlaykit.device.v1',
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    const closeCode = await new Promise<number>((resolve) => ws.once('close', resolve));
    expect(closeCode).toBe(1000);
  });

  it('ignores other WebSocket paths without consulting device authority', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
    }));
    harnesses.push(harness);

    const response = await rawUpgrade(harness.port, '/studio', [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(response.status).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
    expect(coordinator.connect).not.toHaveBeenCalled();
  });
});
