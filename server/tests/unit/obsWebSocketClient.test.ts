import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ObsRequestError,
  ObsUnavailableError,
  ObsWebSocketClient,
  obsAuthenticationString,
} from '../e2e/support/obsWebSocket';

const PASSWORD = 'proof-password';
const SALT = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAHo3ixNM=';
const CHALLENGE = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';

interface FakeObsOptions {
  requireAuthentication?: boolean;
  rpcVersion?: number;
}

function startFakeObs(options: FakeObsOptions = {}): Promise<{
  url: string;
  received: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const received: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket: WebSocket) => {
    const hello: Record<string, unknown> = {
      obsWebSocketVersion: '5.7.4',
      rpcVersion: options.rpcVersion ?? 1,
    };
    if (options.requireAuthentication !== false) {
      hello.authentication = { challenge: CHALLENGE, salt: SALT };
    }
    socket.send(JSON.stringify({ op: 0, d: hello }));
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString()) as { op: number; d: Record<string, unknown> };
      received.push(envelope);
      if (envelope.op === 1) {
        const expected = obsAuthenticationString(PASSWORD, SALT, CHALLENGE);
        if (options.requireAuthentication !== false && envelope.d.authentication !== expected) {
          socket.close(4009, 'Authentication failed.');
          return;
        }
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (envelope.op === 6) {
        const { requestType, requestId } = envelope.d as {
          requestType: string;
          requestId: string;
        };
        if (requestType === 'GetVersion') {
          socket.send(
            JSON.stringify({
              op: 7,
              d: {
                requestType,
                requestId,
                requestStatus: { result: true, code: 100 },
                responseData: { obsVersion: '32.2.2', platform: 'linux' },
              },
            })
          );
          return;
        }
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType,
              requestId,
              requestStatus: { result: false, code: 600, comment: 'No source was found' },
            },
          })
        );
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake obs has no port'));
        return;
      }
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        received,
        close: () =>
          new Promise<void>((done) => {
            for (const client of server.clients) client.terminate();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('obs-websocket proof client', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('identifies with zero event subscriptions and correlates request responses', async () => {
    const fake = await startFakeObs();
    cleanups.push(fake.close);
    const client = await ObsWebSocketClient.connect({ url: fake.url, password: PASSWORD });
    cleanups.push(() => client.close());
    expect(client.hello.obsWebSocketVersion).toBe('5.7.4');
    expect(client.negotiatedRpcVersion).toBe(1);
    expect(fake.received[0]).toMatchObject({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } });
    expect(JSON.stringify(fake.received[0])).not.toContain(PASSWORD);

    const version = await client.request<{ obsVersion: string }>('GetVersion');
    expect(version).toEqual({ obsVersion: '32.2.2', platform: 'linux' });
  });

  it('rejects failed requests with the obs-websocket status code', async () => {
    const fake = await startFakeObs();
    cleanups.push(fake.close);
    const client = await ObsWebSocketClient.connect({ url: fake.url, password: PASSWORD });
    cleanups.push(() => client.close());
    await expect(client.request('GetSourceScreenshot', { sourceName: 'missing' })).rejects.toEqual(
      expect.objectContaining({
        name: 'ObsRequestError',
        requestType: 'GetSourceScreenshot',
        status: { result: false, code: 600, comment: 'No source was found' },
      })
    );
    await expect(client.request('Boom')).rejects.toBeInstanceOf(ObsRequestError);
  });

  it('reports a wrong password as an authentication unavailability', async () => {
    const fake = await startFakeObs();
    cleanups.push(fake.close);
    await expect(
      ObsWebSocketClient.connect({ url: fake.url, password: 'wrong' })
    ).rejects.toMatchObject({ name: 'ObsUnavailableError', reason: 'authentication' });
  });

  it('refuses to identify without a password when OBS requires one', async () => {
    const fake = await startFakeObs();
    cleanups.push(fake.close);
    await expect(ObsWebSocketClient.connect({ url: fake.url })).rejects.toMatchObject({
      name: 'ObsUnavailableError',
      reason: 'authentication',
    });
    expect(fake.received.some((message) => message.op === 1)).toBe(false);
  });

  it('reports a closed port as a connect unavailability', async () => {
    const fake = await startFakeObs();
    const url = fake.url;
    await fake.close();
    const error = await ObsWebSocketClient.connect({ url, connectTimeoutMs: 2_000 }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ObsUnavailableError);
    expect((error as ObsUnavailableError).reason).toBe('connect');
  });
});
