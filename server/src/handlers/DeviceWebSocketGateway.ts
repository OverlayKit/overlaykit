import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import { WebSocket, WebSocketServer } from 'ws';
import type { DeviceCredentialLifecyclePort } from '../auth/DeviceCredentialRuntime';
import {
  type DeviceAuthorityConnection,
  type DeviceConnectionAuthority,
  type DeviceConnectionCloseReason,
  type DeviceConnectionLease,
} from '../services/DeviceConnectionAuthorityCoordinator';
import {
  DeviceAuthorityMonitorError,
  type DeviceAuthorityInvalidationReason,
  type DeviceAuthorityMonitorAdmission,
  type DeviceAuthorityMonitorLease,
} from '../services/DeviceConnectionAuthorityMonitor';
import { logger } from '../utils/logger';
import {
  DeviceConnectionTransitionSession,
} from '../services/DeviceConnectionTransitionSession';
import type {
  DeviceBootstrapSession,
  DeviceBootstrapSessionFactoryPort,
} from '../services/DeviceBootstrapSessionRuntime';
import type { DeviceTransitionLedgerPort } from '../services/SqliteDeviceTransitionLedger';

export const DEVICE_WEBSOCKET_PATH = '/device';
export const DEVICE_WEBSOCKET_PROTOCOLS = ['overlaykit.device.v1'] as const;

const DEVICE_REALM = 'overlaykit-device';
export const DEVICE_TRANSPORT_CLOSE_TIMEOUT_MS = 12_000;
export const DEVICE_MAX_INBOUND_MESSAGE_BYTES = 16_384;
const BEARER_CREDENTIAL = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;
const DEVICE_PROTOCOL = /^overlaykit\.device\.v([1-9][0-9]*)$/;
const NOT_READY_MESSAGE = JSON.stringify({
  type: 'device.error',
  code: 'not_ready',
  message: 'Device connection is not ready',
});

interface DeviceConnectionCoordinatorPort {
  connect(
    authority: DeviceConnectionAuthority,
    connection: DeviceAuthorityConnection,
    authorityIsCurrent?: () => boolean
  ): Promise<DeviceConnectionLease>;
  retire(lease: DeviceConnectionLease, reason: DeviceConnectionCloseReason): Promise<void>;
  isEffective?(lease: DeviceConnectionLease): boolean;
  shutdown?(): Promise<void>;
}

interface DeviceConnectionAuthorityMonitorPort {
  isAvailable(): boolean;
  prepare(authority: DeviceCredentialAuthority): Promise<DeviceAuthorityMonitorAdmission>;
}

export interface DeviceWebSocketGatewayOptions {
  readonly credentials: Pick<DeviceCredentialLifecyclePort, 'authenticate'>;
  readonly coordinator: DeviceConnectionCoordinatorPort;
  readonly authorityMonitor: DeviceConnectionAuthorityMonitorPort;
  readonly path?: string;
  readonly supportedProtocols?: ReadonlyArray<string>;
  readonly generateConnectionId?: () => string;
  readonly closeTimeoutMs?: number;
  readonly transitionLedger?: DeviceTransitionLedgerPort;
  readonly bootstrapSessions?: DeviceBootstrapSessionFactoryPort;
  readonly onFatal?: (error: unknown) => void;
}

interface HttpRejection {
  readonly status: number;
  readonly reason: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

const AUTHENTICATION_REQUIRED: HttpRejection = {
  status: 401,
  reason: 'Unauthorized',
  headers: { 'WWW-Authenticate': `Bearer realm="${DEVICE_REALM}"` },
  body: JSON.stringify({
    error: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device authentication required' },
  }),
};

const ORIGIN_FORBIDDEN: HttpRejection = {
  status: 403,
  reason: 'Forbidden',
  body: JSON.stringify({
    error: { code: 'DEVICE_ORIGIN_FORBIDDEN', message: 'Browser device connections are forbidden' },
  }),
};

const AUTHORITY_UNAVAILABLE: HttpRejection = {
  status: 503,
  reason: 'Service Unavailable',
  body: JSON.stringify({
    error: { code: 'DEVICE_AUTH_UNAVAILABLE', message: 'Device authentication is unavailable' },
  }),
};

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', 'http://overlaykit.local');
  } catch {
    return null;
  }
}

function bearerToken(request: IncomingMessage, url: URL): string | null {
  if (
    url.search.length > 0 ||
    rawHeaderCount(request, 'cookie') > 0 ||
    rawHeaderCount(request, 'authorization') !== 1
  ) {
    return null;
  }
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string' ? BEARER_CREDENTIAL.exec(authorization) : null;
  return match?.[1] ?? null;
}

function protocolVersion(protocol: string): number {
  const match = DEVICE_PROTOCOL.exec(protocol);
  if (!match) return -1;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : -1;
}

function normalizedProtocols(protocols: ReadonlyArray<string>): ReadonlyArray<string> {
  if (protocols.length === 0 || new Set(protocols).size !== protocols.length) {
    throw new Error('At least one unique device WebSocket protocol is required');
  }
  const normalized = [...protocols];
  if (normalized.some((protocol) => protocolVersion(protocol) < 1)) {
    throw new Error('Device WebSocket protocols must be versioned');
  }
  return Object.freeze(
    normalized.sort((left, right) => protocolVersion(right) - protocolVersion(left))
  );
}

function offeredProtocols(request: IncomingMessage): ReadonlySet<string> | null {
  if (rawHeaderCount(request, 'sec-websocket-protocol') !== 1) return null;
  const header = request.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return null;
  const offered = header.split(',').map((protocol) => protocol.trim());
  if (
    offered.length === 0 ||
    offered.some((protocol) => !protocol) ||
    new Set(offered).size !== offered.length
  ) {
    return null;
  }
  return new Set(offered);
}

function selectProtocol(
  request: IncomingMessage,
  supportedProtocols: ReadonlyArray<string>
): string | null {
  const offered = offeredProtocols(request);
  if (!offered) return null;
  return supportedProtocols.find((protocol) => offered.has(protocol)) ?? null;
}

function captureAuthority(authority: DeviceCredentialAuthority): DeviceConnectionAuthority {
  return Object.freeze({
    credentialId: authority.credentialId,
    audienceCredentialId: authority.audienceCredentialId,
    generation: authority.generation,
    showId: authority.showId,
    expiresAt: authority.expiresAt,
  });
}

function rejectUpgrade(socket: Duplex, rejection: HttpRejection): void {
  if (socket.destroyed) return;
  const body = `${rejection.body}\n`;
  const headers = {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Connection: 'close',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    ...rejection.headers,
  };
  const lines = [
    `HTTP/1.1 ${rejection.status} ${rejection.reason}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    body,
  ];
  socket.end(lines.join('\r\n'));
}

function protocolRequired(supportedProtocols: ReadonlyArray<string>): HttpRejection {
  return {
    status: 426,
    reason: 'Upgrade Required',
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': supportedProtocols.join(', '),
    },
    body: JSON.stringify({
      error: {
        code: 'DEVICE_PROTOCOL_REQUIRED',
        message: 'A compatible device WebSocket protocol is required',
      },
    }),
  };
}

function closeTransport(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      finish();
    }, timeoutMs);
    ws.once('close', finish);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  });
}

function deviceConnection(
  ws: WebSocket,
  id: string,
  closeTimeoutMs: number
): DeviceAuthorityConnection {
  let closing: Promise<void> | null = null;
  return Object.freeze({
    id,
    close(reason: DeviceConnectionCloseReason): Promise<void> {
      logger.debug('Retiring device WebSocket transport', { connectionId: id, reason });
      closing ??= closeTransport(ws, closeTimeoutMs);
      return closing;
    },
  });
}

function sendJson(ws: WebSocket, value: unknown): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Device WebSocket is not open'));
  }
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(value), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class DeviceWebSocketGateway {
  readonly path: string;
  readonly supportedProtocols: ReadonlyArray<string>;
  private readonly credentials: Pick<DeviceCredentialLifecyclePort, 'authenticate'>;
  private readonly coordinator: DeviceConnectionCoordinatorPort;
  private readonly authorityMonitor: DeviceConnectionAuthorityMonitorPort;
  private readonly generateConnectionId: () => string;
  private readonly closeTimeoutMs: number;
  private readonly transitionLedger: DeviceTransitionLedgerPort | null;
  private readonly bootstrapSessions: DeviceBootstrapSessionFactoryPort | null;
  private readonly onFatal: (error: unknown) => void;
  private readonly selectedProtocols = new WeakMap<IncomingMessage, string>();
  private readonly wss: WebSocketServer;
  private readonly pendingDisposals = new Set<Promise<void>>();
  private accepting = true;
  private fatal = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: DeviceWebSocketGatewayOptions) {
    this.path = options.path ?? DEVICE_WEBSOCKET_PATH;
    if (!this.path.startsWith('/') || this.path.includes('?')) {
      throw new Error('Device WebSocket path is invalid');
    }
    this.supportedProtocols = normalizedProtocols(
      options.supportedProtocols ?? DEVICE_WEBSOCKET_PROTOCOLS
    );
    this.credentials = options.credentials;
    this.coordinator = options.coordinator;
    this.authorityMonitor = options.authorityMonitor;
    if (
      !this.authorityMonitor ||
      typeof this.authorityMonitor.isAvailable !== 'function' ||
      typeof this.authorityMonitor.prepare !== 'function'
    ) {
      throw new Error('Device authority monitor is required');
    }
    this.generateConnectionId = options.generateConnectionId ?? randomUUID;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEVICE_TRANSPORT_CLOSE_TIMEOUT_MS;
    this.transitionLedger = options.transitionLedger ?? null;
    this.bootstrapSessions = options.bootstrapSessions ?? null;
    this.onFatal = options.onFatal ?? ((error) => logger.error('Device host failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
    if (
      (this.transitionLedger === null) !== (this.bootstrapSessions === null)
      || typeof this.onFatal !== 'function'
    ) {
      throw new Error('Audited device bootstrap dependencies must be composed together');
    }
    if (
      !Number.isSafeInteger(this.closeTimeoutMs) ||
      this.closeTimeoutMs <= 0 ||
      this.closeTimeoutMs > DEVICE_TRANSPORT_CLOSE_TIMEOUT_MS
    ) {
      throw new Error('Device transport close timeout is invalid');
    }
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: DEVICE_MAX_INBOUND_MESSAGE_BYTES,
      handleProtocols: (_protocols, request) => this.selectedProtocols.get(request) ?? false,
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = requestUrl(request);
    if (!url || url.pathname !== this.path) return false;
    if (!this.accepting) {
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return true;
    }
    void this.admit(request, socket, head, url);
    return true;
  }

  terminate(): void {
    for (const client of this.wss.clients) client.terminate();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const shutdown = Promise.allSettled([
      this.coordinator.shutdown?.() ?? Promise.resolve(),
      ...[...this.wss.clients].map((client) => closeTransport(client, this.closeTimeoutMs)),
    ]);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      shutdown,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.closeTimeoutMs);
      }),
    ]);
    await Promise.allSettled([...this.pendingDisposals]);
    if (timeout) clearTimeout(timeout);
    this.terminate();
  }

  private async admit(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL
  ): Promise<void> {
    if (!this.accepting) {
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return;
    }
    if (rawHeaderCount(request, 'origin') > 0) {
      rejectUpgrade(socket, ORIGIN_FORBIDDEN);
      return;
    }
    let monitorAvailable = false;
    try {
      monitorAvailable = this.authorityMonitor.isAvailable() === true;
    } catch {
      monitorAvailable = false;
    }
    if (!monitorAvailable) {
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return;
    }

    let token = bearerToken(request, url);
    if (!token) {
      rejectUpgrade(socket, AUTHENTICATION_REQUIRED);
      return;
    }

    let credentialAuthority: DeviceCredentialAuthority | null;
    try {
      credentialAuthority = await this.credentials.authenticate(token);
    } catch (error) {
      logger.error('Device WebSocket authentication failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return;
    } finally {
      token = null;
    }
    if (!credentialAuthority) {
      rejectUpgrade(socket, AUTHENTICATION_REQUIRED);
      return;
    }
    if (!this.accepting) {
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return;
    }

    const selectedProtocol = selectProtocol(request, this.supportedProtocols);
    if (!selectedProtocol) {
      rejectUpgrade(socket, protocolRequired(this.supportedProtocols));
      return;
    }
    let monitorAdmission: DeviceAuthorityMonitorAdmission;
    try {
      monitorAdmission = await this.authorityMonitor.prepare(credentialAuthority);
    } catch (error) {
      if (
        error instanceof DeviceAuthorityMonitorError &&
        (error.code === 'DEVICE_AUTHORITY_CHANGED' || error.code === 'DEVICE_AUTHORITY_EXPIRED')
      ) {
        rejectUpgrade(socket, AUTHENTICATION_REQUIRED);
      } else {
        logger.error('Device authority monitor preparation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      }
      return;
    }
    let monitorCurrent = false;
    try {
      monitorCurrent = monitorAdmission.isCurrent() === true;
    } catch (error) {
      logger.error('Device authority monitor currency check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        monitorAdmission.abort();
      } catch {
        // The admission is already rejected; transport must still fail closed.
      }
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return;
    }
    if (!monitorCurrent) {
      try {
        monitorAdmission.abort();
      } catch {
        // The admission is already rejected; transport must still fail closed.
      }
      rejectUpgrade(socket, AUTHENTICATION_REQUIRED);
      return;
    }
    if (!this.accepting) {
      try {
        monitorAdmission.abort();
      } catch {
        // Shutdown already rejects this pending authority.
      }
      rejectUpgrade(socket, AUTHORITY_UNAVAILABLE);
      return;
    }
    if (socket.destroyed) {
      try {
        monitorAdmission.abort();
      } catch {
        // Socket closure is already the fail-closed boundary.
      }
      return;
    }

    this.selectedProtocols.set(request, selectedProtocol);
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.selectedProtocols.delete(request);
        this.accept(ws, monitorAdmission.authority, monitorAdmission);
      });
    } catch (error) {
      try {
        monitorAdmission.abort();
      } catch {
        // The upgrade failure already prevents authority.
      }
      this.selectedProtocols.delete(request);
      logger.warn('Device WebSocket upgrade failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!socket.destroyed) socket.destroy();
    }
  }

  private accept(
    ws: WebSocket,
    credentialAuthority: DeviceCredentialAuthority,
    monitorAdmission: DeviceAuthorityMonitorAdmission
  ): void {
    const authority = captureAuthority(credentialAuthority);
    const connectionId = this.generateConnectionId();
    const connection = deviceConnection(ws, connectionId, this.closeTimeoutMs);
    let coordinatorLease: DeviceConnectionLease | null = null;
    let monitorLease: DeviceAuthorityMonitorLease | null = null;
    let invalidatedReason: DeviceConnectionCloseReason | null = null;
    let transitionSession: DeviceConnectionTransitionSession | null = null;
    let bootstrapSession: DeviceBootstrapSession | null = null;

    const invalidate = (reason: DeviceAuthorityInvalidationReason): void => {
      invalidatedReason = reason;
      if (coordinatorLease) {
        try {
          void Promise.resolve(this.coordinator.retire(coordinatorLease, reason)).catch((error) => {
            logger.warn('Device authority retirement failed', {
              connectionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } catch (error) {
          logger.warn('Device authority retirement failed', {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      transitionSession?.quiesce(reason);
      void Promise.resolve(connection.close(reason)).catch(() => undefined);
    };

    try {
      monitorLease = monitorAdmission.activate({ invalidate });
    } catch (error) {
      logger.warn('Device authority changed during WebSocket upgrade', {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
      void Promise.resolve(connection.close('authority.changed')).catch(() => undefined);
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (!bootstrapSession) {
        if (ws.readyState === WebSocket.OPEN) ws.send(NOT_READY_MESSAGE);
        return;
      }
      let value: unknown = null;
      if (!isBinary) {
        try {
          value = JSON.parse(data.toString()) as unknown;
        } catch {
          value = null;
        }
      }
      void bootstrapSession.receive(value).catch((error) => {
        logger.warn('Device bootstrap message failed', {
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    ws.on('error', (error) => {
      logger.warn('Device WebSocket transport error', {
        connectionId,
        error: error.message,
      });
    });
    ws.once('close', () => {
      try {
        monitorLease?.close();
      } catch {
        // Transport closure remains authoritative even if monitor cleanup fails.
      }
      transitionSession?.close(invalidatedReason ?? 'transport.closed');
      if (bootstrapSession) {
        const disposal = bootstrapSession.dispose().catch((error) => {
          logger.warn('Device bootstrap disposal failed', {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.pendingDisposals.add(disposal);
        void disposal.finally(() => this.pendingDisposals.delete(disposal));
      }
      if (coordinatorLease) {
        try {
          void Promise.resolve(
            this.coordinator.retire(coordinatorLease, invalidatedReason ?? 'authority.rejected')
          ).catch(() => undefined);
        } catch {
          // The transport is already closed and cannot admit more work.
        }
      }
    });

    let connectionAdmission: Promise<DeviceConnectionLease>;
    try {
      connectionAdmission = Promise.resolve(
        this.coordinator.connect(authority, connection, () => monitorLease?.isCurrent() === true)
      );
    } catch (error) {
      try {
        monitorLease.close();
      } catch {
        // Connection closure below remains the fail-closed boundary.
      }
      logger.warn('Device WebSocket authority rejected', {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
      void Promise.resolve(connection.close('authority.rejected')).catch(() => undefined);
      return;
    }
    void connectionAdmission.then(
      async (lease) => {
        coordinatorLease = lease;
        if (invalidatedReason || !monitorLease?.isCurrent()) {
          const reason = invalidatedReason ?? 'authority.changed';
          try {
            void Promise.resolve(this.coordinator.retire(lease, reason)).catch(() => undefined);
          } catch {
            // Closing the connection below still removes transport authority.
          }
          void Promise.resolve(connection.close(reason)).catch(() => undefined);
          return;
        }
        if (!this.transitionLedger || !this.bootstrapSessions) {
          logger.debug('Device WebSocket authority granted without readiness', { connectionId });
          return;
        }
        try {
          transitionSession = new DeviceConnectionTransitionSession({
            ledger: this.transitionLedger,
            connectionId,
            authority: {
              ...authority,
              authorityHash: monitorAdmission.authorityHash,
            },
            targets: credentialAuthority.targets,
            authorityIsCurrent: () => (
              monitorLease?.isCurrent() === true
              && (this.coordinator.isEffective?.(lease) ?? true)
            ),
            onFatal: (error) => this.failHost(error),
          });
          transitionSession.startNotReady();
          bootstrapSession = await this.bootstrapSessions.create({
            authority: credentialAuthority,
            transitions: transitionSession,
            transport: {
              sendSnapshot: (message) => sendJson(ws, message),
              sendReady: (message) => sendJson(ws, message),
              close: (reason) => {
                transitionSession?.close(reason);
                return connection.close('authority.rejected');
              },
            },
          });
          if (invalidatedReason || !monitorLease?.isCurrent() || ws.readyState !== WebSocket.OPEN) {
            const reason = invalidatedReason ?? 'authority.changed';
            transitionSession.quiesce(reason);
            await Promise.resolve(this.coordinator.retire(lease, reason)).catch(() => undefined);
            await Promise.resolve(connection.close(reason)).catch(() => undefined);
            return;
          }
          await bootstrapSession.start();
          logger.debug('Device WebSocket bootstrap started', { connectionId });
        } catch (error) {
          if (transitionSession?.getPhase() === 'new') this.failHost(error);
          transitionSession?.close('bootstrap.internal_error');
          logger.warn('Device WebSocket bootstrap composition failed', {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
          await Promise.resolve(connection.close('authority.rejected')).catch(() => undefined);
        }
      },
      async (error: unknown) => {
        try {
          monitorLease?.close();
        } catch {
          // Connection closure below remains the fail-closed boundary.
        }
        logger.warn('Device WebSocket authority rejected', {
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
        await Promise.resolve(connection.close('authority.rejected')).catch(() => undefined);
      }
    );
  }

  private failHost(error: unknown): void {
    if (this.fatal) return;
    this.fatal = true;
    this.accepting = false;
    for (const client of this.wss.clients) client.terminate();
    try {
      this.onFatal(error);
    } catch {
      // Admission and transports are already closed independently of diagnostics.
    }
  }
}
