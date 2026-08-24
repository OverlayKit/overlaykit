import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketAdapter } from '../../src/modules/ws/WebSocketAdapter';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {}

  open(): void {
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  serverClose(): void {
    this.onclose?.();
  }
}

const OriginalWebSocket = globalThis.WebSocket;

describe('WebSocketAdapter authentication ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.useRealTimers();
  });

  it('sends the bootstrap frame before initial and restored subscriptions', async () => {
    const adapter = new WebSocketAdapter('wss://output.example.test/ws', {
      type: 'authenticate.output',
      token: 'ok_output_secret',
    });

    const initialConnection = adapter.connect();
    const initialSocket = FakeWebSocket.instances[0];
    initialSocket.open();
    await initialConnection;
    adapter.send({ type: 'subscribe.production', showId: 'show-1', bus: 'program' });

    expect(initialSocket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'authenticate.output', token: 'ok_output_secret' },
      { type: 'subscribe.production', showId: 'show-1', bus: 'program' },
    ]);

    initialSocket.serverClose();
    await vi.advanceTimersByTimeAsync(2_000);
    const replacementSocket = FakeWebSocket.instances[1];
    replacementSocket.open();

    expect(replacementSocket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'authenticate.output', token: 'ok_output_secret' },
      { type: 'subscribe.production', showId: 'show-1', bus: 'program' },
    ]);
    adapter.disconnect();
  });
});
