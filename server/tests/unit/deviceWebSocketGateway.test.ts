import { randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import { connect as connectSocket, type Socket } from 'net';
import type { AddressInfo } from 'net';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import {
  DEVICE_BOOTSTRAP_ACK_TYPE,
  DEVICE_BOOTSTRAP_ACK_VERSION,
} from '@overlaykit/protocol/device-bootstrap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import {
  DEVICE_MAX_OUTBOUND_BUFFER_BYTES,
  DEVICE_WEBSOCKET_PATH,
  DeviceWebSocketGateway,
} from '../../src/handlers/DeviceWebSocketGateway';
import type {
  DeviceAuthorityConnection,
  DeviceConnectionAuthority,
  DeviceConnectionCloseReason,
  DeviceConnectionLease,
} from '../../src/services/DeviceConnectionAuthorityCoordinator';
import type {
  DeviceAuthorityInvalidationReason,
  DeviceAuthorityInvalidationTarget,
  DeviceAuthorityMonitorAdmission,
} from '../../src/services/DeviceConnectionAuthorityMonitor';
import { DeviceAuthorityMonitorError } from '../../src/services/DeviceConnectionAuthorityMonitor';
import type {
  DeviceBootstrapSessionFactoryPort,
} from '../../src/services/DeviceBootstrapSessionRuntime';
import type {
  DeviceConnectionTransitionInput,
  DeviceTransitionLedgerPort,
  DeviceTransitionRecord,
} from '../../src/services/SqliteDeviceTransitionLedger';

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
  const connect = vi.fn(
    (
      _authority: DeviceConnectionAuthority,
      _connection: DeviceAuthorityConnection,
      _authorityIsCurrent?: () => boolean
    ) => admission.promise
  );
  const retire = vi.fn(
    async (_lease: DeviceConnectionLease, _reason: DeviceConnectionCloseReason) => undefined
  );
  return { admission, connect, retire };
}

function authorityMonitorHarness() {
  let current = true;
  let target: DeviceAuthorityInvalidationTarget | null = null;
  let available = true;
  const close = vi.fn(() => {
    current = false;
  });
  const prepare = vi.fn(
    async (
      capturedAuthority: DeviceCredentialAuthority
    ): Promise<DeviceAuthorityMonitorAdmission> => {
      const immutableAuthority = Object.freeze({
        ...capturedAuthority,
        targets: Object.freeze([...capturedAuthority.targets]),
        controlIds: Object.freeze([...capturedAuthority.controlIds]),
        scopes: Object.freeze([...capturedAuthority.scopes]),
      });
      return {
        authority: immutableAuthority,
        authorityHash: 'a'.repeat(64),
        isCurrent: () => current,
        activate(nextTarget) {
          target = nextTarget;
          return Object.freeze({
            authorityHash: 'a'.repeat(64),
            isCurrent: () => current,
            close,
          });
        },
        abort: () => {
          current = false;
        },
      };
    }
  );
  return {
    monitor: {
      isAvailable: () => available,
      prepare,
    },
    close,
    prepare,
    setAvailable(value: boolean) {
      available = value;
    },
    invalidate(reason: DeviceAuthorityInvalidationReason) {
      current = false;
      return target?.invalidate(reason);
    },
  };
}

async function startGateway(gateway: DeviceWebSocketGateway): Promise<GatewayHarness> {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    if (gateway.handleUpgrade(request, socket, head)) return;
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
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
  includeDefaultProtocol = true
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      raw += chunk;
    });
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
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          ...requestHeaders.map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\r\n')
      );
    });
  });
}

function openUncooperativeWebSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1');
    let raw = '';
    socket.setEncoding('binary');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      raw += chunk;
      if (!raw.startsWith('HTTP/1.1 101') || !raw.includes('\r\n\r\n')) return;
      socket.removeAllListeners('data');
      resolve(socket);
    });
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${DEVICE_WEBSOCKET_PATH} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Protocol: overlaykit.device.v1',
          `Authorization: Bearer ${TOKEN}`,
          '',
          '',
        ].join('\r\n')
      );
    });
  });
}

function openWebSocket(
  port: number,
  protocols: string | string[],
  options: ClientOptions
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${DEVICE_WEBSOCKET_PATH}`, protocols, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

function memoryTransitionLedger(inputs: DeviceConnectionTransitionInput[]): DeviceTransitionLedgerPort {
  let sequence = 0;
  let previousGlobalHash: string | null = null;
  const connectionHashes = new Map<string, string>();
  const records: DeviceTransitionRecord[] = [];
  return {
    startHostEpoch: () => [],
    append(input) {
      inputs.push(input);
      sequence += 1;
      const recordHash = String(sequence).padStart(64, 'a');
      const evidence = input.kind === 'device.connection.not_ready'
        ? { authority: input.authority, targets: input.targets }
        : input.kind === 'device.connection.ready'
          ? { targets: input.targets }
          : input.kind === 'device.connection.checkpoint'
            ? {
                audienceCredentialId: input.audienceCredentialId,
                reason: input.reason,
                targets: input.targets,
              }
          : { reason: input.reason };
      const record: DeviceTransitionRecord = {
        schemaVersion: 'overlaykit-device-transition/v1',
        globalSequence: sequence,
        hostEpochId: 'host-1',
        connectionId: input.connectionId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        previousGlobalHash,
        previousConnectionHash: connectionHashes.get(input.connectionId) ?? null,
        evidence,
        signature: null,
        recordHash,
      };
      records.push(record);
      previousGlobalHash = recordHash;
      connectionHashes.set(input.connectionId, recordHash);
      return record;
    },
    stopHostEpoch: () => { throw new Error('not used'); },
    getState: () => ({
      activeHostEpochId: 'host-1',
      globalSequence: sequence,
      globalHash: previousGlobalHash,
      failed: false,
      connectionPhases: {},
    }),
    readRecords: () => records,
  };
}

const harnesses: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe('DeviceWebSocketGateway', () => {
  it('returns one indistinguishable 401 before upgrade for every invalid bearer source', async () => {
    const authenticate = vi.fn(async () => null);
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
      })
    );
    harnesses.push(harness);

    const responses = await Promise.all([
      rawUpgrade(harness.port),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [['Authorization', 'Basic abc']]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [['Authorization', 'Bearer invalid token']]),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [['Authorization', `Bearer ${TOKEN}`]]),
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
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
      })
    );
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
    expect(responses.every((response) => response.body.includes('DEVICE_ORIGIN_FORBIDDEN'))).toBe(
      true
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('requires a compatible protocol and selects the highest mutual version', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
        supportedProtocols: [
          'overlaykit.device.v1',
          'overlaykit.device.v3',
          'overlaykit.device.v2',
        ],
      })
    );
    harnesses.push(harness);

    const absent = await rawUpgrade(
      harness.port,
      DEVICE_WEBSOCKET_PATH,
      [['Authorization', `Bearer ${TOKEN}`]],
      false
    );
    const incompatible = await rawUpgrade(
      harness.port,
      DEVICE_WEBSOCKET_PATH,
      [
        ['Authorization', `Bearer ${TOKEN}`],
        ['Sec-WebSocket-Protocol', 'overlaykit.device.v9'],
      ],
      false
    );

    expect(absent.status).toBe(426);
    expect(incompatible.status).toBe(426);
    expect(incompatible.headers['sec-websocket-protocol']).toBe(
      'overlaykit.device.v3, overlaykit.device.v2, overlaykit.device.v1'
    );

    const ws = await openWebSocket(harness.port, ['overlaykit.device.v1', 'overlaykit.device.v2'], {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
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
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
        generateConnectionId: () => 'connection-1',
      })
    );
    harnesses.push(harness);

    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(coordinator.connect).toHaveBeenCalledTimes(1);

    const [capturedAuthority, capturedConnection, authorityIsCurrent] =
      coordinator.connect.mock.calls[0];
    expect(authorityIsCurrent?.()).toBe(true);
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

  it('checkpoints before audited closure when active authority is invalidated', async () => {
    const auditedAuthority: DeviceCredentialAuthority = {
      ...authority(),
      targets: ['preview'],
    };
    const authenticate = vi.fn(async () => auditedAuthority);
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const transitions: DeviceConnectionTransitionInput[] = [];
    const disposalEvents: string[] = [];
    const transitionLedger = memoryTransitionLedger(transitions);
    const bootstrapSessions: DeviceBootstrapSessionFactoryPort = {
      create: vi.fn(async ({ transitions: sessionTransitions, transport }) => {
        let ready = false;
        const sha256 = 'b'.repeat(64);
        return {
          async start() {
            await transport.sendSnapshot({
              schemaVersion: 'overlaykit-device-bootstrap-snapshot/v1',
              type: 'device.bootstrap.snapshot',
              target: 'preview',
              issuerKeyId: 'server-key-1',
              sequence: 1,
              sha256,
              payloadBase64: btoa('snapshot'),
              signature: 'signature',
            });
          },
          async receive(value) {
            const acknowledgement = value as Record<string, unknown>;
            if (
              acknowledgement.type !== DEVICE_BOOTSTRAP_ACK_TYPE
              || acknowledgement.mode !== 'bootstrap'
              || acknowledgement.issuerKeyId !== 'server-key-1'
              || acknowledgement.sequence !== 1
              || acknowledgement.sha256 !== sha256
            ) throw new Error('unexpected acknowledgement');
            sessionTransitions.commitReady(Date.now(), [{
              target: 'preview',
              targetRevision: 1,
              catalogGeneration: 1,
              issuerKeyId: 'server-key-1',
              sequence: 1,
              sha256,
              confirmedAt: 1,
              sentAt: 2,
              sendConfirmedAt: 3,
              appliedAt: 4,
            }]);
            ready = true;
            await transport.sendReady({
              schemaVersion: 'overlaykit-device-ready/v1',
              type: 'device.ready',
            });
          },
          async dispose(reason = 'transport.closed', graceful = false) {
            disposalEvents.push(`dispose:${reason}:${graceful}`);
            if (graceful) {
              sessionTransitions.checkpoint(Date.now(), reason, [{
                target: 'preview',
                targetRevision: 1,
                catalogGeneration: 1,
                issuerKeyId: 'server-key-1',
                sequence: 1,
                sha256,
                appliedAt: 4,
              }]);
            }
          },
          isReady: () => ready,
          isTargetReady: () => ready,
        };
      }),
    };
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
      authorityMonitor: authorityMonitor.monitor,
      transitionLedger,
      bootstrapSessions,
      generateConnectionId: () => 'connection-audited',
    }));
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const [, capturedConnection, capturedAuthority] = coordinator.connect.mock.calls[0];
    coordinator.admission.resolve({
      connectionId: capturedConnection.id,
      authority: coordinator.connect.mock.calls[0][0],
    });
    expect(capturedAuthority?.()).toBe(true);

    const snapshot = await nextMessage(ws);
    expect(snapshot).toMatchObject({
      type: 'device.bootstrap.snapshot',
      target: 'preview',
      sha256: 'b'.repeat(64),
    });
    const ready = nextMessage(ws);
    ws.send(JSON.stringify({
      schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
      type: DEVICE_BOOTSTRAP_ACK_TYPE,
      mode: 'bootstrap',
      target: 'preview',
      issuerKeyId: snapshot.issuerKeyId,
      sequence: snapshot.sequence,
      sha256: snapshot.sha256,
      status: 'applied',
    }));
    expect(await ready).toEqual({
      schemaVersion: 'overlaykit-device-ready/v1',
      type: 'device.ready',
    });
    expect(transitions.map(({ kind }) => kind)).toEqual([
      'device.connection.not_ready',
      'device.connection.ready',
    ]);

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    authorityMonitor.invalidate('authority.changed');
    await closed;
    await waitFor(
      () => transitions.some(({ kind }) => kind === 'device.connection.closed'),
      'Audited close transition was not recorded',
    );
    expect(transitions.map(({ kind }) => kind)).toEqual([
      'device.connection.not_ready',
      'device.connection.ready',
      'device.connection.checkpoint',
      'device.connection.quiescing',
      'device.connection.closed',
    ]);
    expect(disposalEvents).toEqual(['dispose:transport.closed:true']);
    expect(transitions.slice(-2)).toMatchObject([
      { kind: 'device.connection.quiescing', reason: 'authority.changed' },
      { kind: 'device.connection.closed', reason: 'authority.changed' },
    ]);
  });

  it('retires authority and closes audit even when session disposal fails', async () => {
    const coordinator = pendingCoordinator();
    const transitions: DeviceConnectionTransitionInput[] = [];
    const onFatal = vi.fn();
    const bootstrapSessions: DeviceBootstrapSessionFactoryPort = {
      create: vi.fn(async () => ({
        async start() {},
        async receive() {},
        async dispose() { throw new Error('catalog close failed'); },
        isReady: () => false,
        isTargetReady: () => false,
      })),
    };
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate: vi.fn(async () => authority()) },
      coordinator,
      authorityMonitor: authorityMonitorHarness().monitor,
      transitionLedger: memoryTransitionLedger(transitions),
      bootstrapSessions,
      onFatal,
      generateConnectionId: () => 'connection-disposal-failure',
    }));
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const [, connection] = coordinator.connect.mock.calls[0];
    coordinator.admission.resolve({
      connectionId: connection.id,
      authority: coordinator.connect.mock.calls[0][0],
    });
    await waitFor(
      () => vi.mocked(bootstrapSessions.create).mock.calls.length === 1,
      'Bootstrap session was not mounted',
    );

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close(1000);
    await closed;
    await waitFor(
      () => transitions.some(({ kind }) => kind === 'device.connection.closed')
        && coordinator.retire.mock.calls.length === 1,
      'Disposal failure skipped authority cleanup',
    );

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(transitions.map(({ kind }) => kind)).toEqual([
      'device.connection.not_ready',
      'device.connection.closed',
    ]);
    expect(coordinator.retire).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: connection.id }),
      'authority.rejected',
    );
  });

  it('disposes a bootstrap session that resolves after its socket already closed', async () => {
    const coordinator = pendingCoordinator();
    const session = deferred<Awaited<ReturnType<DeviceBootstrapSessionFactoryPort['create']>>>();
    const disposed = deferred<void>();
    const dispose = vi.fn(async () => { disposed.resolve(); });
    const bootstrapSessions: DeviceBootstrapSessionFactoryPort = {
      create: vi.fn(() => session.promise),
    };
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate: vi.fn(async () => authority()) },
      coordinator,
      authorityMonitor: authorityMonitorHarness().monitor,
      transitionLedger: memoryTransitionLedger([]),
      bootstrapSessions,
    }));
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const [, connection] = coordinator.connect.mock.calls[0];
    coordinator.admission.resolve({
      connectionId: connection.id,
      authority: coordinator.connect.mock.calls[0][0],
    });
    await waitFor(
      () => vi.mocked(bootstrapSessions.create).mock.calls.length === 1,
      'Deferred bootstrap creation did not start',
    );

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close(1000);
    await closed;
    session.resolve({
      async start() {},
      async receive() {},
      dispose,
      isReady: () => false,
      isTargetReady: () => false,
    });
    await disposed.promise;

    expect(dispose).toHaveBeenCalledWith('transport.closed', false);
  });

  it('rejects outbound overflow before writing and closes as a transport failure', async () => {
    const auditedAuthority: DeviceCredentialAuthority = {
      ...authority(),
      targets: ['preview'],
    };
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const transitions: DeviceConnectionTransitionInput[] = [];
    const bootstrapSessions: DeviceBootstrapSessionFactoryPort = {
      async create({ transport }) {
        return {
          async start() {
            try {
              await transport.sendDelta({
                schemaVersion: 'overlaykit-device-state-delta/v1',
                type: 'device.state.delta',
                target: 'preview',
                issuerKeyId: 'server-key-1',
                sequence: 2,
                sha256: 'd'.repeat(64),
                payloadBase64: 'a'.repeat(DEVICE_MAX_OUTBOUND_BUFFER_BYTES),
                signature: 'signature',
              });
            } catch {
              await transport.close('delta.transport_failure');
            }
          },
          async receive() {},
          async dispose() {},
          isReady: () => false,
          isTargetReady: () => false,
        };
      },
    };
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate: vi.fn(async () => auditedAuthority) },
      coordinator,
      authorityMonitor: authorityMonitor.monitor,
      transitionLedger: memoryTransitionLedger(transitions),
      bootstrapSessions,
      generateConnectionId: () => 'connection-overflow',
    }));
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const messages: unknown[] = [];
    ws.on('message', (message) => messages.push(message));
    const [, connection] = coordinator.connect.mock.calls[0];
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    coordinator.admission.resolve({
      connectionId: connection.id,
      authority: coordinator.connect.mock.calls[0][0],
    });

    expect(await closed).toBe(1000);
    await waitFor(
      () => transitions.some(({ kind }) => kind === 'device.connection.closed'),
      'Outbound overflow did not close its transition',
    );
    expect(messages).toEqual([]);
    expect(transitions.map(({ kind }) => kind)).toEqual([
      'device.connection.not_ready',
      'device.connection.closed',
    ]);
    expect(transitions.at(-1)).toMatchObject({
      kind: 'device.connection.closed',
      reason: 'delta.transport_failure',
    });
  });

  it('closes device admission and reports host fatal when readiness audit becomes uncertain', async () => {
    const auditedAuthority: DeviceCredentialAuthority = {
      ...authority(),
      targets: ['preview'],
    };
    const authenticate = vi.fn(async () => auditedAuthority);
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    let appends = 0;
    const baseLedger = memoryTransitionLedger([]);
    const transitionLedger: DeviceTransitionLedgerPort = {
      ...baseLedger,
      append(input) {
        appends += 1;
        if (input.kind !== 'device.connection.not_ready') throw new Error('audit unavailable');
        return baseLedger.append(input);
      },
    };
    const onFatal = vi.fn();
    const bootstrapSessions: DeviceBootstrapSessionFactoryPort = {
      async create({ transitions: sessionTransitions, transport }) {
        return {
          async start() {
            await transport.sendSnapshot({
              schemaVersion: 'overlaykit-device-bootstrap-snapshot/v1',
              type: 'device.bootstrap.snapshot',
              target: 'preview',
              issuerKeyId: 'server-key-1',
              sequence: 1,
              sha256: 'c'.repeat(64),
              payloadBase64: btoa('snapshot'),
              signature: 'signature',
            });
          },
          async receive() {
            try {
              sessionTransitions.commitReady(Date.now(), [{
                target: 'preview',
                targetRevision: 1,
                catalogGeneration: 1,
                issuerKeyId: 'server-key-1',
                sequence: 1,
                sha256: 'c'.repeat(64),
                confirmedAt: 1,
                sentAt: 2,
                sendConfirmedAt: 3,
                appliedAt: 4,
              }]);
            } catch {
              await transport.close('bootstrap.internal_error');
            }
          },
          async dispose() {},
          isReady: () => false,
          isTargetReady: () => false,
        };
      },
    };
    const harness = await startGateway(new DeviceWebSocketGateway({
      credentials: { authenticate },
      coordinator,
      authorityMonitor: authorityMonitor.monitor,
      transitionLedger,
      bootstrapSessions,
      onFatal,
      generateConnectionId: () => 'connection-fatal',
    }));
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const [capturedAuthority, capturedConnection] = coordinator.connect.mock.calls[0];
    coordinator.admission.resolve({
      connectionId: capturedConnection.id,
      authority: capturedAuthority,
    });
    await nextMessage(ws);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send(JSON.stringify({ type: 'device.bootstrap.ack' }));
    await closed;

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(appends).toBeGreaterThanOrEqual(2);
    const rejected = await rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(rejected.status).toBe(503);
  });

  it('fails closed when credential authority is unavailable or coordinator admission rejects', async () => {
    const unavailableCoordinator = pendingCoordinator();
    const unavailableMonitor = authorityMonitorHarness();
    const unavailable = await startGateway(
      new DeviceWebSocketGateway({
        credentials: {
          authenticate: vi.fn(async () => {
            throw new Error('store unavailable');
          }),
        },
        coordinator: unavailableCoordinator,
        authorityMonitor: unavailableMonitor.monitor,
      })
    );
    harnesses.push(unavailable);

    const unavailableResponse = await rawUpgrade(unavailable.port, DEVICE_WEBSOCKET_PATH, [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableCoordinator.connect).not.toHaveBeenCalled();

    const coordinator = {
      connect: vi.fn((): Promise<DeviceConnectionLease> => {
        throw new Error('authority rejected');
      }),
      retire: vi.fn(async () => undefined),
    };
    const rejectedMonitor = authorityMonitorHarness();
    const rejected = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate: vi.fn(async () => authority()) },
        coordinator,
        authorityMonitor: rejectedMonitor.monitor,
      })
    );
    harnesses.push(rejected);
    const ws = await openWebSocket(rejected.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const closeCode = await new Promise<number>((resolve) => ws.once('close', resolve));
    expect(closeCode).toBe(1000);
  });

  it('returns 503 when monitor availability or currency adapters throw', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const unavailable = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: {
          isAvailable: () => {
            throw new Error('health failed');
          },
          prepare: vi.fn(),
        },
      })
    );
    harnesses.push(unavailable);
    const unavailableResponse = await rawUpgrade(unavailable.port);
    expect(unavailableResponse.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();

    const brokenCurrency = authorityMonitorHarness();
    brokenCurrency.monitor.prepare.mockResolvedValueOnce({
      authority: authority(),
      authorityHash: 'a'.repeat(64),
      isCurrent: () => {
        throw new Error('currency failed');
      },
      activate: vi.fn(),
      abort: vi.fn(),
    });
    const currency = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: brokenCurrency.monitor,
      })
    );
    harnesses.push(currency);
    const currencyResponse = await rawUpgrade(currency.port, DEVICE_WEBSOCKET_PATH, [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(currencyResponse.status).toBe(503);
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('returns the same 503 before bearer evaluation when the monitor is unavailable', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    authorityMonitor.setAvailable(false);
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
      })
    );
    harnesses.push(harness);

    const responses = await Promise.all([
      rawUpgrade(harness.port),
      rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [['Authorization', `Bearer ${TOKEN}`]]),
    ]);
    expect(
      responses.map((response) => ({
        status: response.status,
        body: response.body,
        cacheControl: response.headers['cache-control'],
      }))
    ).toEqual([
      {
        status: 503,
        body: expect.stringContaining('DEVICE_AUTH_UNAVAILABLE'),
        cacheControl: 'no-store',
      },
      {
        status: 503,
        body: expect.stringContaining('DEVICE_AUTH_UNAVAILABLE'),
        cacheControl: 'no-store',
      },
    ]);
    expect(authenticate).not.toHaveBeenCalled();
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('does not complete 101 until monitor subscription and revalidation are prepared', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const preparedMonitor = authorityMonitorHarness();
    const preparedAdmission = await preparedMonitor.monitor.prepare(authority());
    const preparation = deferred<DeviceAuthorityMonitorAdmission>();
    const authorityMonitor = {
      isAvailable: () => true,
      prepare: vi.fn(() => preparation.promise),
    };
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor,
      })
    );
    harnesses.push(harness);

    let opened = false;
    const opening = openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    void opening.then(
      () => {
        opened = true;
      },
      () => undefined
    );
    while (authorityMonitor.prepare.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(opened).toBe(false);
    expect(coordinator.connect).not.toHaveBeenCalled();

    preparation.resolve(preparedAdmission);
    const ws = await opening;
    expect(opened).toBe(true);
    expect(coordinator.connect).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('rejects an authority that changes during monitor preparation without upgrading', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const authorityMonitor = {
      isAvailable: () => true,
      prepare: vi.fn(async () => {
        throw new DeviceAuthorityMonitorError(
          'DEVICE_AUTHORITY_CHANGED',
          'changed during subscription'
        );
      }),
    };
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor,
      })
    );
    harnesses.push(harness);

    const response = await rawUpgrade(harness.port, DEVICE_WEBSOCKET_PATH, [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(response.status).toBe(401);
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('retires an admitted lease and closes transport when the active monitor invalidates', async () => {
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate: vi.fn(async () => authority()) },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
        generateConnectionId: () => 'connection-monitored',
      })
    );
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const [capturedAuthority, capturedConnection, monitoredAuthorityIsCurrent] =
      coordinator.connect.mock.calls[0];
    const lease = Object.freeze({
      connectionId: capturedConnection.id,
      authority: capturedAuthority,
    });
    coordinator.admission.resolve(lease);
    await Promise.resolve();
    await Promise.resolve();
    expect(monitoredAuthorityIsCurrent?.()).toBe(true);
    coordinator.retire.mockImplementationOnce(() => {
      throw new Error('retirement adapter failed');
    });

    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    authorityMonitor.invalidate('authority.changed');

    expect(monitoredAuthorityIsCurrent?.()).toBe(false);
    expect(coordinator.retire).toHaveBeenCalledWith(lease, 'authority.changed');
    expect(await closed).toBe(1000);
  });

  it('retires the exact lease and releases its monitor after a natural transport close', async () => {
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate: vi.fn(async () => authority()) },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
        generateConnectionId: () => 'connection-disconnected',
      })
    );
    harnesses.push(harness);
    const ws = await openWebSocket(harness.port, 'overlaykit.device.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const [capturedAuthority, capturedConnection] = coordinator.connect.mock.calls[0];
    const lease = Object.freeze({
      connectionId: capturedConnection.id,
      authority: capturedAuthority,
    });
    coordinator.admission.resolve(lease);
    await Promise.resolve();
    await Promise.resolve();

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close();
    await closed;

    await vi.waitFor(() => {
      expect(authorityMonitor.close).toHaveBeenCalledTimes(1);
      expect(coordinator.retire).toHaveBeenCalledWith(lease, 'authority.rejected');
    });
  });

  it('force-closes an uncooperative transport within the bounded close timeout', async () => {
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const closeTimeoutMs = 20;
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate: vi.fn(async () => authority()) },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
        closeTimeoutMs,
      })
    );
    harnesses.push(harness);
    const socket = await openUncooperativeWebSocket(harness.port);
    const [capturedAuthority, capturedConnection] = coordinator.connect.mock.calls[0];
    coordinator.admission.resolve(
      Object.freeze({
        connectionId: capturedConnection.id,
        authority: capturedAuthority,
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const startedAt = Date.now();
    authorityMonitor.invalidate('authority.changed');
    await closed;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(closeTimeoutMs - 5);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(
      () =>
        new DeviceWebSocketGateway({
          credentials: { authenticate: vi.fn(async () => authority()) },
          coordinator: pendingCoordinator(),
          authorityMonitor: authorityMonitorHarness().monitor,
          closeTimeoutMs: 12_001,
        })
    ).toThrow('Device transport close timeout is invalid');
  });

  it('ignores other WebSocket paths without consulting device authority', async () => {
    const authenticate = vi.fn(async () => authority());
    const coordinator = pendingCoordinator();
    const authorityMonitor = authorityMonitorHarness();
    const harness = await startGateway(
      new DeviceWebSocketGateway({
        credentials: { authenticate },
        coordinator,
        authorityMonitor: authorityMonitor.monitor,
      })
    );
    harnesses.push(harness);

    const response = await rawUpgrade(harness.port, '/studio', [
      ['Authorization', `Bearer ${TOKEN}`],
    ]);
    expect(response.status).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it('closes admission and delegates authority retirement during shutdown', async () => {
    const coordinator = Object.assign(pendingCoordinator(), {
      shutdown: vi.fn(async () => undefined),
    });
    const gateway = new DeviceWebSocketGateway({
      credentials: { authenticate: vi.fn(async () => authority()) },
      coordinator,
      authorityMonitor: authorityMonitorHarness().monitor,
    });

    await gateway.shutdown();
    await gateway.shutdown();

    expect(coordinator.shutdown).toHaveBeenCalledTimes(1);
  });
});
