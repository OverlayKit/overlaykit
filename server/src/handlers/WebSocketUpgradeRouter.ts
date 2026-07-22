import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { WebSocketServer } from 'ws';
import type { DeviceWebSocketGateway } from './DeviceWebSocketGateway';

export const BROWSER_WEBSOCKET_PATH = '/ws';

function reject(socket: Duplex, status: number, reason: string, code: string): void {
  if (socket.destroyed) return;
  const body = `${JSON.stringify({ error: { code, message: reason } })}\n`;
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

function pathname(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? '/', 'http://overlaykit.local').pathname;
  } catch {
    return null;
  }
}

export class WebSocketUpgradeRouter {
  private accepting = true;

  constructor(
    private readonly browser: WebSocketServer,
    private readonly device: Pick<DeviceWebSocketGateway, 'path' | 'handleUpgrade'>,
  ) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.accepting) {
      reject(socket, 503, 'Service Unavailable', 'WEBSOCKET_SHUTTING_DOWN');
      return;
    }
    const path = pathname(request);
    if (path === BROWSER_WEBSOCKET_PATH) {
      this.browser.handleUpgrade(request, socket, head, (webSocket) => {
        this.browser.emit('connection', webSocket, request);
      });
      return;
    }
    if (path === this.device.path && this.device.handleUpgrade(request, socket, head)) return;
    reject(socket, 404, 'Not Found', 'WEBSOCKET_PATH_NOT_FOUND');
  }

  stop(): void {
    this.accepting = false;
  }
}
