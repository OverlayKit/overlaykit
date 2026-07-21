import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with { 'resolution-mode': 'import' };
import { WebSocket, WebSocketServer } from 'ws';
import type { DeviceCredentialLifecyclePort } from '../auth/DeviceCredentialRuntime';
import {
  type DeviceAuthorityConnection,
  type DeviceConnectionAuthority,
  type DeviceConnectionCloseReason,
  type DeviceConnectionLease,
} from '../services/DeviceConnectionAuthorityCoordinator';
import { logger } from '../utils/logger';

export const DEVICE_WEBSOCKET_PATH = '/device';
export const DEVICE_WEBSOCKET_PROTOCOLS = ['overlaykit.device.v1'] as const;

const DEVICE_REALM = 'overlaykit-device';
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
  ): Promise<DeviceConnectionLease>;
}

export interface DeviceWebSocketGatewayOptions {
  readonly credentials: Pick<DeviceCredentialLifecyclePort, 'authenticate'>;
  readonly coordinator: DeviceConnectionCoordinatorPort;
  readonly path?: string;
  readonly supportedProtocols?: ReadonlyArray<string>;
  readonly generateConnectionId?: () => string;
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
    url.search.length > 0
    || rawHeaderCount(request, 'cookie') > 0
    || rawHeaderCount(request, 'authorization') !== 1
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
  return Object.freeze(normalized.sort((left, right) => protocolVersion(right) - protocolVersion(left)));
}

function offeredProtocols(request: IncomingMessage): ReadonlySet<string> | null {
  if (rawHeaderCount(request, 'sec-websocket-protocol') !== 1) return null;
  const header = request.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return null;
  const offered = header.split(',').map((protocol) => protocol.trim());
  if (
    offered.length === 0
    || offered.some((protocol) => !protocol)
    || new Set(offered).size !== offered.length
  ) {
    return null;
  }
  return new Set(offered);
}

function selectProtocol(
  request: IncomingMessage,
  supportedProtocols: ReadonlyArray<string>,
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

function closeTransport(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  });
}

function deviceConnection(ws: WebSocket, id: string): DeviceAuthorityConnection {
  let closing: Promise<void> | null = null;
  return Object.freeze({
    id,
    close(reason: DeviceConnectionCloseReason): Promise<void> {
      logger.debug('Retiring device WebSocket transport', { connectionId: id, reason });
      closing ??= closeTransport(ws);
      return closing;
    },
  });
}

export class DeviceWebSocketGateway {
  readonly path: string;
  readonly supportedProtocols: ReadonlyArray<string>;
  private readonly credentials: Pick<DeviceCredentialLifecyclePort, 'authenticate'>;
  private readonly coordinator: DeviceConnectionCoordinatorPort;
  private readonly generateConnectionId: () => string;
  private readonly selectedProtocols = new WeakMap<IncomingMessage, string>();
  private readonly wss: WebSocketServer;

  constructor(options: DeviceWebSocketGatewayOptions) {
    this.path = options.path ?? DEVICE_WEBSOCKET_PATH;
    if (!this.path.startsWith('/') || this.path.includes('?')) {
      throw new Error('Device WebSocket path is invalid');
    }
    this.supportedProtocols = normalizedProtocols(
      options.supportedProtocols ?? DEVICE_WEBSOCKET_PROTOCOLS,
    );
    this.credentials = options.credentials;
    this.coordinator = options.coordinator;
    this.generateConnectionId = options.generateConnectionId ?? randomUUID;
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (_protocols, request) => this.selectedProtocols.get(request) ?? false,
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = requestUrl(request);
    if (!url || url.pathname !== this.path) return false;
    void this.admit(request, socket, head, url);
    return true;
  }

  terminate(): void {
    for (const client of this.wss.clients) client.terminate();
  }

  private async admit(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    if (rawHeaderCount(request, 'origin') > 0) {
      rejectUpgrade(socket, ORIGIN_FORBIDDEN);
      return;
    }

    const token = bearerToken(request, url);
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
    }
    if (!credentialAuthority) {
      rejectUpgrade(socket, AUTHENTICATION_REQUIRED);
      return;
    }

    const selectedProtocol = selectProtocol(request, this.supportedProtocols);
    if (!selectedProtocol) {
      rejectUpgrade(socket, protocolRequired(this.supportedProtocols));
      return;
    }
    if (socket.destroyed) return;

    const authority = captureAuthority(credentialAuthority);
    this.selectedProtocols.set(request, selectedProtocol);
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.selectedProtocols.delete(request);
        this.accept(ws, authority);
      });
    } catch (error) {
      this.selectedProtocols.delete(request);
      logger.warn('Device WebSocket upgrade failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!socket.destroyed) socket.destroy();
    }
  }

  private accept(ws: WebSocket, authority: DeviceConnectionAuthority): void {
    const connectionId = this.generateConnectionId();
    const connection = deviceConnection(ws, connectionId);

    ws.on('message', () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(NOT_READY_MESSAGE);
    });
    ws.on('error', (error) => {
      logger.warn('Device WebSocket transport error', {
        connectionId,
        error: error.message,
      });
    });

    void this.coordinator.connect(authority, connection).then(
      () => {
        logger.debug('Device WebSocket authority granted without readiness', { connectionId });
      },
      async (error: unknown) => {
        logger.warn('Device WebSocket authority rejected', {
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
        await Promise.resolve(connection.close('authority.rejected')).catch(() => undefined);
      },
    );
  }
}
