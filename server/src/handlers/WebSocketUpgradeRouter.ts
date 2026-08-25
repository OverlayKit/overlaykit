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

export interface WebSocketUpgradeRouterOptions {
  readonly maxUpgradesPerWindow?: number;
  readonly windowMs?: number;
  readonly maxTrackedIps?: number;
  readonly now?: () => number;
}

interface RateWindow {
  count: number;
  resetAt: number;
}

export class WebSocketUpgradeRouter {
  private accepting = true;
  private readonly maxUpgradesPerWindow: number;
  private readonly windowMs: number;
  private readonly maxTrackedIps: number;
  private readonly now: () => number;
  private readonly ipWindows = new Map<string, RateWindow>();

  constructor(
    private readonly browser: WebSocketServer,
    private readonly device: Pick<DeviceWebSocketGateway, 'path' | 'handleUpgrade'>,
    options: WebSocketUpgradeRouterOptions = {},
  ) {
    // express-rate-limit only covers /api, so the raw WebSocket upgrade needs its own per-IP
    // throttle: an unauthenticated peer can otherwise open connections as fast as it can dial.
    this.maxUpgradesPerWindow = options.maxUpgradesPerWindow ?? 60;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxTrackedIps = options.maxTrackedIps ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  // Fixed-window per-IP limit. Returns true when this upgrade exceeds the window's allowance. The
  // tracking map is pruned of expired windows when it grows large, so it cannot itself leak.
  private rateLimited(ip: string): boolean {
    const now = this.now();
    let window = this.ipWindows.get(ip);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.ipWindows.set(ip, window);
      if (this.ipWindows.size > this.maxTrackedIps) {
        for (const [trackedIp, tracked] of this.ipWindows) {
          if (now >= tracked.resetAt) this.ipWindows.delete(trackedIp);
        }
      }
    }
    window.count += 1;
    return window.count > this.maxUpgradesPerWindow;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.accepting) {
      reject(socket, 503, 'Service Unavailable', 'WEBSOCKET_SHUTTING_DOWN');
      return;
    }
    if (this.rateLimited(request.socket?.remoteAddress ?? 'unknown')) {
      reject(socket, 429, 'Too Many Requests', 'WEBSOCKET_RATE_LIMITED');
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
