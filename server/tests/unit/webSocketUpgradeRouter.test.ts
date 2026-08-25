import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocketServer } from 'ws';
import { WebSocketUpgradeRouter } from '../../src/handlers/WebSocketUpgradeRouter';

function request(url: string) {
  return { url } as Parameters<WebSocketUpgradeRouter['handleUpgrade']>[0];
}

function socketHarness() {
  const socket = new PassThrough();
  let output = '';
  socket.on('data', (chunk) => { output += chunk.toString(); });
  return { socket, output: () => output };
}

describe('WebSocketUpgradeRouter', () => {
  it('routes browser and hardware paths to one explicit owner each', () => {
    const emit = vi.fn();
    const handleUpgrade = vi.fn((_request, _socket, _head, accepted) => accepted({ id: 'browser' }));
    const browser = { emit, handleUpgrade } as unknown as WebSocketServer;
    const device = { path: '/device', handleUpgrade: vi.fn(() => true) };
    const router = new WebSocketUpgradeRouter(browser, device);

    router.handleUpgrade(request('/ws?channel=main'), socketHarness().socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('connection', { id: 'browser' }, expect.objectContaining({
      url: '/ws?channel=main',
    }));
    expect(device.handleUpgrade).not.toHaveBeenCalled();

    router.handleUpgrade(request('/device'), socketHarness().socket, Buffer.alloc(0));
    expect(device.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown paths without browser or device fallback', async () => {
    const browser = { emit: vi.fn(), handleUpgrade: vi.fn() } as unknown as WebSocketServer;
    const device = { path: '/device', handleUpgrade: vi.fn(() => false) };
    const router = new WebSocketUpgradeRouter(browser, device);
    const transport = socketHarness();

    router.handleUpgrade(request('/'), transport.socket, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.output()).toContain('HTTP/1.1 404 Not Found');
    expect(browser.handleUpgrade).not.toHaveBeenCalled();
    expect(device.handleUpgrade).not.toHaveBeenCalled();
  });

  it('stops all new upgrades synchronously during shutdown', async () => {
    const browser = { emit: vi.fn(), handleUpgrade: vi.fn() } as unknown as WebSocketServer;
    const device = { path: '/device', handleUpgrade: vi.fn(() => true) };
    const router = new WebSocketUpgradeRouter(browser, device);
    router.stop();
    const transport = socketHarness();

    router.handleUpgrade(request('/device'), transport.socket, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.output()).toContain('HTTP/1.1 503 Service Unavailable');
    expect(device.handleUpgrade).not.toHaveBeenCalled();
  });

  it('throttles WebSocket upgrades per IP and resets after the window (CHG-0073)', async () => {
    const emit = vi.fn();
    const handleUpgrade = vi.fn((_request, _socket, _head, accepted) => accepted({ id: 'browser' }));
    const browser = { emit, handleUpgrade } as unknown as WebSocketServer;
    const device = { path: '/device', handleUpgrade: vi.fn(() => true) };
    let clock = 1_000;
    const router = new WebSocketUpgradeRouter(browser, device, {
      maxUpgradesPerWindow: 3,
      windowMs: 1_000,
      now: () => clock,
    });
    const requestFrom = (ip: string) =>
      ({ url: '/ws', socket: { remoteAddress: ip } }) as Parameters<
        WebSocketUpgradeRouter['handleUpgrade']
      >[0];

    // The first three upgrades from one IP are accepted.
    for (let i = 0; i < 3; i += 1) {
      router.handleUpgrade(requestFrom('1.2.3.4'), socketHarness().socket, Buffer.alloc(0));
    }
    expect(handleUpgrade).toHaveBeenCalledTimes(3);

    // The fourth is throttled with 429 and never reaches the browser server.
    const throttled = socketHarness();
    router.handleUpgrade(requestFrom('1.2.3.4'), throttled.socket, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));
    expect(throttled.output()).toContain('HTTP/1.1 429 Too Many Requests');
    expect(handleUpgrade).toHaveBeenCalledTimes(3);

    // A different IP has its own allowance.
    router.handleUpgrade(requestFrom('5.6.7.8'), socketHarness().socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(4);

    // After the window elapses, the first IP is allowed again.
    clock += 1_000;
    router.handleUpgrade(requestFrom('1.2.3.4'), socketHarness().socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(5);
  });
});
